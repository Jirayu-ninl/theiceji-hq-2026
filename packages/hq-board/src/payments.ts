import { parseAmount, sumAmounts } from '@theiceji/hq-core/money'
import {
  type BoardCardPaymentRow,
  type BoardCardRow,
  boardCardPayments,
  type ProjectRow,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import {
  conflict,
  invalid,
  notFound,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  choice,
  day,
  idempotencyKey,
  parseInput,
  recordId,
  revision,
  text,
} from '@theiceji/hq-ops/schemas'
import {
  audit,
  returned,
  runOperation,
  type Tx,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { DEFAULT_TIME_ZONE } from '@theiceji/hq-ops/time'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  cardForWrite,
  countingPayments,
  getCard,
  moneyOf,
  saveCard,
  writeEvent,
} from './board'

/**
 * Payments: what came in for a card — a deposit of any size
 * (or none at all), part payments while follow-ups keep coming, and the rest
 * when the card is marked paid (./board `markPaid`).
 *
 * · **Money is the owner's.** Recording and voiding are \`owner_only\`: a
 *   payment counts once the owner saw it in the account, never from a
 *   promise — so it can't be dated in the future.
 * · **The ledger is append-only.** A mistake is struck by a \`void\` line that
 *   names it (a trigger refuses updates and deletes); the struck line stays
 *   in the history. The card's \`paid_total\` is the sum of the lines that
 *   count, recomputed in the same transaction.
 * · **Any lane, any time before it's paid.** A deposit usually lands while
 *   the card is still in Quoted or Doing; every line counts as money in on its
 *   own \`received_on\` (Readings, Home). Once the card is marked paid or
 *   archived its ledger is closed — undo the payment to reopen it.
 * · **Paying more than the total is allowed** (a client may pay ahead of a
 *   follow-up that isn't priced yet); the card reads "overpaid" until the
 *   numbers meet.
 */

registerConstraintMessages({
  board_card_payments_amount_check: 'A payment is more than zero.',
  board_card_payments_note_check: 'A note is at most 200 characters.',
  board_card_payments_voids_key: 'That payment is already voided.',
})

export type PaymentResult = { card: BoardCardRow; payment: BoardCardPaymentRow }

const zoneOf = (project: ProjectRow | null) =>
  project?.timezone ?? DEFAULT_TIME_ZONE

function assertOpen(card: BoardCardRow): void {
  if (card.archivedAt)
    throw invalid(
      card.paidAt
        ? 'This card was marked paid, so its payments are closed. Undo the payment to change them.'
        : 'This card is archived. Restore it to record money on it.',
    )
}

/** The card after its ledger changed: new paid total (and currency, if it had none), next revision. */
async function recount(
  tx: Tx,
  card: BoardCardRow,
  currency: string,
): Promise<BoardCardRow> {
  const counted = await moneyOf(tx, card, card.price, currency)
  return saveCard(tx, card, { paidTotal: counted.paidTotal, currency })
}

async function replayOf(
  actor: Actor,
  cardId: string,
  paymentId: unknown,
): Promise<PaymentResult> {
  const detail = await getCard(actor, cardId)
  const payment = detail.payments.find((entry) => entry.id === paymentId)
  if (!payment) throw conflict()
  return { card: detail.card, payment }
}

const recordSchema = z.object({
  cardId: recordId('Card'),
  expectedRevision: revision,
  /** `4000`, `"4,000.50"` — in the card's currency. */
  amount: z.union([z.string(), z.number()]),
  kind: choice(
    ['deposit', 'part'],
    'A payment is a deposit or a part payment.',
  ),
  /** The day it came in; the project's today when left out. */
  receivedOn: day('Received on'),
  note: text.optional('Note', 200),
  idempotencyKey: idempotencyKey.optional(),
})

export type RecordPaymentInput = z.input<typeof recordSchema>

/** Money that came in for a card: a deposit or a part payment. The owner's. */
export async function recordPayment(
  actor: Actor,
  raw: RecordPaymentInput,
): Promise<PaymentResult> {
  const input = parseInput(recordSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'board_record_payment',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { card, project } = await cardForWrite(
          tx,
          actor,
          input.cardId,
          input.expectedRevision,
          'owner_only',
        )
        assertOpen(card)
        const currency = card.currency ?? project?.currency ?? 'THB'
        const parsed = parseAmount(input.amount, currency)
        if ('error' in parsed)
          throw invalid(parsed.error, { amount: parsed.error })
        if (Number(parsed.ok) <= 0)
          throw invalid('A payment is more than zero.', {
            amount: 'Enter the amount that came in.',
          })
        const [today] = await tx.execute<{ day: string }>(
          sql`select ((now() at time zone ${zoneOf(project)})::date)::text as day`,
        )
        const receivedOn = input.receivedOn ?? today?.day
        if (!receivedOn) throw new Error('The database returned no date.')
        if (today && receivedOn > today.day)
          throw invalid(
            'A payment counts once it came in — record it on that day, not ahead.',
            { receivedOn: 'Choose today or a day before.' },
          )
        const [row] = await tx
          .insert(boardCardPayments)
          .values({
            ownerId: actor.userId,
            cardId: card.id,
            projectId: card.projectId,
            kind: input.kind,
            amount: parsed.ok,
            currency,
            receivedOn,
            note: input.note ?? '',
            createdBy: actor.userId,
          })
          .returning()
        const payment = returned(row)
        const saved = await recount(tx, card, currency)
        await writeEvent(tx, actor, saved, 'payment_recorded', {
          amount: payment.amount,
          currency,
          data: {
            paymentId: payment.id,
            kind: payment.kind,
            receivedOn: payment.receivedOn,
            paidTotal: saved.paidTotal,
          },
        })
        await audit(tx, actor, {
          projectId: saved.projectId,
          action: 'board.payment.record',
          targetType: 'card',
          targetId: saved.id,
          beforeRevision: card.revision,
          afterRevision: saved.revision,
          changes: {
            payment: payment.id,
            kind: payment.kind,
            amount: payment.amount,
            currency,
            receivedOn: payment.receivedOn,
          },
        })
        return { card: saved, payment }
      }),
  )
  if (outcome.kind === 'replay')
    return replayOf(actor, input.cardId, outcome.response?.payment_id)
  await outcome.complete({
    card_id: outcome.value.card.id,
    payment_id: outcome.value.payment.id,
    revision: outcome.value.card.revision,
  })
  return outcome.value
}

const voidSchema = z.object({
  cardId: recordId('Card'),
  expectedRevision: revision,
  paymentId: recordId('Payment'),
  reason: text.optional('Reason', 200),
})

/**
 * Strike a payment line: a \`void\` line names it, the card's paid total drops,
 * and the struck line stays in the history. The owner's.
 */
export async function voidPayment(
  actor: Actor,
  raw: z.input<typeof voidSchema>,
): Promise<PaymentResult> {
  const input = parseInput(voidSchema, raw)
  return withTransaction(async (tx) => {
    const { card } = await cardForWrite(
      tx,
      actor,
      input.cardId,
      input.expectedRevision,
      'owner_only',
    )
    assertOpen(card)
    const [line] = await tx
      .select()
      .from(boardCardPayments)
      .where(
        and(
          eq(boardCardPayments.id, input.paymentId),
          countingPayments(card.id),
        ),
      )
      .limit(1)
    if (!line) {
      const [any] = await tx
        .select({ id: boardCardPayments.id })
        .from(boardCardPayments)
        .where(
          and(
            eq(boardCardPayments.id, input.paymentId),
            eq(boardCardPayments.cardId, card.id),
          ),
        )
      if (!any) throw notFound('Payment')
      throw invalid('That line is already voided, or is itself a void.')
    }
    const [row] = await tx
      .insert(boardCardPayments)
      .values({
        ownerId: actor.userId,
        cardId: card.id,
        projectId: card.projectId,
        kind: 'void',
        amount: line.amount,
        currency: line.currency,
        receivedOn: line.receivedOn,
        note: input.reason ?? '',
        voidsId: line.id,
        createdBy: actor.userId,
      })
      .returning()
    const struck = returned(row)
    const saved = await recount(tx, card, line.currency)
    await writeEvent(tx, actor, saved, 'payment_voided', {
      amount: line.amount,
      currency: line.currency,
      data: {
        paymentId: line.id,
        voidId: struck.id,
        paidTotal: saved.paidTotal,
      },
    })
    await audit(tx, actor, {
      projectId: saved.projectId,
      action: 'board.payment.void',
      targetType: 'card',
      targetId: saved.id,
      beforeRevision: card.revision,
      afterRevision: saved.revision,
      changes: {
        payment: line.id,
        amount: line.amount,
        currency: line.currency,
        reason: input.reason ?? null,
      },
    })
    return { card: saved, payment: struck }
  })
}

/** What a card still owes (total − paid), or null while it has no price. Negative is overpaid. */
export function owedOf(
  card: Pick<BoardCardRow, 'total' | 'paidTotal' | 'currency'>,
): string | null {
  if (card.total === null || !card.currency) return null
  return sumAmounts([card.total, `-${card.paidTotal}`], card.currency)
}
