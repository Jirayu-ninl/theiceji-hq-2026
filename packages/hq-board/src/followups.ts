import { parseAmount } from '@theiceji/hq-core/money'
import {
  type BoardCardRow,
  type BoardFollowupRow,
  boardFollowups,
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
import { auditSnapshot, diffFields } from '@theiceji/hq-ops/values'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { cardForWrite, getCard, moneyOf, saveCard, writeEvent } from './board'

/**
 * Follow-ups: work that came after a card's own task was done —
 * a revision round, an add-on, the client's words. Not sub-tasks: a follow-up
 * has no done state, only details, a price in the card's currency, a due day,
 * and (through \`refs\`) a prompt and files.
 *
 * · **The card is the record that changes.** Every follow-up write takes the
 *   card's revision, recomputes its \`total\`, bumps it, and writes one card
 *   history row and one audit event — all in one transaction — and answers
 *   the card as it now is, for the next write.
 * · **Open while the card is.** A follow-up can be added, edited or removed
 *   while the card is on the board, the awaiting-payment lane included (what
 *   is owed grows with it); once the card is marked paid or archived,
 *   everything on it is frozen.
 * · **Removing archives it**, so Undo can bring it back; the card's total
 *   counts only the live ones. Agents may add and edit (\`draft\`); removing
 *   is the owner's.
 */

registerConstraintMessages({
  board_followups_title_check: 'A follow-up needs a title of 1–200 characters.',
  board_followups_price_check: 'A price can’t be negative.',
  board_followups_card_fk: 'That card isn’t one of yours.',
})

export type FollowupResult = { card: BoardCardRow; followup: BoardFollowupRow }

const fields = {
  body: text.optional('Details', 20000),
  /** An amount in the card's currency; null or `""` clears it. */
  price: z.union([z.string(), z.number()]).nullable().optional(),
  dueOn: day('Due date'),
}

function priceIn(
  raw: string | number | null | undefined,
  currency: string,
): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  const parsed = parseAmount(raw, currency)
  if ('error' in parsed) throw invalid(parsed.error, { price: parsed.error })
  return parsed.ok
}

function assertOpen(card: BoardCardRow): void {
  if (card.archivedAt)
    throw invalid(
      card.paidAt
        ? 'This card was marked paid, so its follow-ups are frozen. Undo the payment to change them.'
        : 'This card is archived. Restore it to change its follow-ups.',
    )
}

/** The card after its follow-ups changed: new total (and currency, if it had none), next revision. */
async function recount(
  tx: Tx,
  card: BoardCardRow,
  project: ProjectRow | null,
): Promise<BoardCardRow> {
  const currency = card.currency ?? project?.currency ?? 'THB'
  const counted = await moneyOf(tx, card, card.price, currency)
  return saveCard(tx, card, {
    total: counted.total,
    currency:
      counted.total === null && card.paidTotal === '0.00'
        ? card.currency
        : currency,
  })
}

async function followupOf(
  tx: Tx,
  card: BoardCardRow,
  followupId: string,
): Promise<BoardFollowupRow> {
  const [row] = await tx
    .select()
    .from(boardFollowups)
    .where(
      and(
        eq(boardFollowups.id, followupId),
        eq(boardFollowups.cardId, card.id),
        eq(boardFollowups.ownerId, card.ownerId),
      ),
    )
    .limit(1)
    .for('update')
  if (!row) throw notFound('Follow-up')
  return row
}

async function replayOf(
  actor: Actor,
  cardId: string,
  followupId: unknown,
): Promise<FollowupResult> {
  const detail = await getCard(actor, cardId)
  const followup = detail.followups.find((entry) => entry.id === followupId)
  if (!followup) throw conflict()
  return { card: detail.card, followup }
}

const addSchema = z.object({
  cardId: recordId('Card'),
  expectedRevision: revision,
  title: text.required('Title', 200),
  ...fields,
  idempotencyKey: idempotencyKey.optional(),
})

export type AddFollowupInput = z.input<typeof addSchema>

/** A new follow-up at the end of the card's list; its price adds to the card's total. */
export async function addFollowup(
  actor: Actor,
  raw: AddFollowupInput,
): Promise<FollowupResult> {
  const input = parseInput(addSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'board_add_followup',
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
        )
        assertOpen(card)
        const currency = card.currency ?? project?.currency ?? 'THB'
        const [end] = await tx
          .select({
            next: sql<number>`coalesce(max(${boardFollowups.position}), -1)::int + 1`,
          })
          .from(boardFollowups)
          .where(
            and(
              eq(boardFollowups.cardId, card.id),
              isNull(boardFollowups.archivedAt),
            ),
          )
        const [row] = await tx
          .insert(boardFollowups)
          .values({
            ownerId: actor.userId,
            createdBy: actor.userId,
            cardId: card.id,
            projectId: card.projectId,
            title: input.title as string,
            body: input.body ?? '',
            price: priceIn(input.price, currency) ?? null,
            dueOn: input.dueOn ?? null,
            position: end?.next ?? 0,
          })
          .returning()
        const followup = returned(row)
        const saved = await recount(tx, card, project)
        await writeEvent(tx, actor, saved, 'followup_added', {
          amount: followup.price,
          currency: followup.price ? saved.currency : null,
          data: {
            followupId: followup.id,
            title: followup.title,
            total: saved.total,
          },
        })
        await audit(tx, actor, {
          projectId: saved.projectId,
          action: 'board.followup.create',
          targetType: 'card',
          targetId: saved.id,
          beforeRevision: card.revision,
          afterRevision: saved.revision,
          changes: auditSnapshot({
            followup: followup.id,
            title: followup.title,
            price: followup.price,
            dueOn: followup.dueOn,
            total: saved.total,
          }),
        })
        return { card: saved, followup }
      }),
  )
  if (outcome.kind === 'replay')
    return replayOf(actor, input.cardId, outcome.response?.followup_id)
  await outcome.complete({
    card_id: outcome.value.card.id,
    followup_id: outcome.value.followup.id,
    revision: outcome.value.card.revision,
  })
  return outcome.value
}

const updateSchema = z.object({
  cardId: recordId('Card'),
  expectedRevision: revision,
  followupId: recordId('Follow-up'),
  title: text.required('Title', 200).optional(),
  ...fields,
  idempotencyKey: idempotencyKey.optional(),
})

export type UpdateFollowupInput = z.input<typeof updateSchema>

/** Title, details, price and due day. Absent fields stay as they are. */
export async function updateFollowup(
  actor: Actor,
  raw: UpdateFollowupInput,
): Promise<FollowupResult> {
  const input = parseInput(updateSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'board_update_followup',
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
        )
        assertOpen(card)
        const followup = await followupOf(tx, card, input.followupId)
        if (followup.archivedAt)
          throw invalid(
            'This follow-up was removed. Bring it back to change it.',
          )
        const currency = card.currency ?? project?.currency ?? 'THB'
        const patch: Partial<typeof boardFollowups.$inferInsert> = {}
        if (input.title !== undefined) patch.title = input.title as string
        if (input.body !== undefined) patch.body = input.body ?? ''
        if (input.dueOn !== undefined) patch.dueOn = input.dueOn ?? null
        const price = priceIn(input.price, currency)
        if (price !== undefined) patch.price = price
        const changes = diffFields(
          followup as unknown as Record<string, unknown>,
          patch,
        )
        if (Object.keys(changes).length === 0) return { card, followup }
        const [row] = await tx
          .update(boardFollowups)
          .set({
            ...patch,
            revision: sql`${boardFollowups.revision} + 1`,
            updatedAt: sql`now()`,
          })
          .where(eq(boardFollowups.id, followup.id))
          .returning()
        const updated = returned(row)
        const saved = await recount(tx, card, project)
        await writeEvent(tx, actor, saved, 'followup_edited', {
          amount: 'price' in changes ? updated.price : null,
          currency: 'price' in changes && updated.price ? saved.currency : null,
          data: {
            followupId: updated.id,
            fields: Object.keys(changes),
            total: saved.total,
          },
        })
        await audit(tx, actor, {
          projectId: saved.projectId,
          action: 'board.followup.update',
          targetType: 'card',
          targetId: saved.id,
          beforeRevision: card.revision,
          afterRevision: saved.revision,
          changes: { followup: updated.id, ...changes },
        })
        return { card: saved, followup: updated }
      }),
  )
  if (outcome.kind === 'replay')
    return replayOf(actor, input.cardId, input.followupId)
  await outcome.complete({
    card_id: outcome.value.card.id,
    followup_id: outcome.value.followup.id,
    revision: outcome.value.card.revision,
  })
  return outcome.value
}

const archiveSchema = z.object({
  cardId: recordId('Card'),
  expectedRevision: revision,
  followupId: recordId('Follow-up'),
  archived: z.boolean(),
})

/**
 * Remove a follow-up (it is archived, and leaves the card's total), or bring
 * one back — the Undo of a remove. The owner's.
 */
export async function setFollowupArchived(
  actor: Actor,
  raw: z.input<typeof archiveSchema>,
): Promise<FollowupResult> {
  const input = parseInput(archiveSchema, raw)
  return withTransaction(async (tx) => {
    const { card, project } = await cardForWrite(
      tx,
      actor,
      input.cardId,
      input.expectedRevision,
      'owner_only',
    )
    assertOpen(card)
    const followup = await followupOf(tx, card, input.followupId)
    if (Boolean(followup.archivedAt) === input.archived)
      return { card, followup }
    const [row] = await tx
      .update(boardFollowups)
      .set({
        archivedAt: input.archived ? sql`now()` : null,
        revision: sql`${boardFollowups.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(boardFollowups.id, followup.id))
      .returning()
    const updated = returned(row)
    const saved = await recount(tx, card, project)
    await writeEvent(
      tx,
      actor,
      saved,
      input.archived ? 'followup_removed' : 'followup_added',
      {
        amount: updated.price,
        currency: updated.price ? saved.currency : null,
        data: {
          followupId: updated.id,
          title: updated.title,
          total: saved.total,
          ...(input.archived ? {} : { restored: true }),
        },
      },
    )
    await audit(tx, actor, {
      projectId: saved.projectId,
      action: input.archived
        ? 'board.followup.remove'
        : 'board.followup.restore',
      targetType: 'card',
      targetId: saved.id,
      beforeRevision: card.revision,
      afterRevision: saved.revision,
      changes: {
        followup: updated.id,
        price: updated.price,
        total: saved.total,
      },
    })
    return { card: saved, followup: updated }
  })
}
