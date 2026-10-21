import {
  digitsOf,
  fromMinor,
  parseAmount,
  toMinor,
} from '@theiceji/hq-core/money'
import { MARKET_SALE_KINDS, READING_SOURCES } from '@theiceji/hq-db/enums'
import {
  type MarketListingRow,
  type MarketMarketplaceRow,
  type MarketPayoutRow,
  type MarketSalesEventRow,
  marketListings,
  marketMarketplaces,
  marketPayouts,
  marketSalesEvents,
  projects,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { schedulerActor } from '@theiceji/hq-ops/actors'
import { dbNow, type Reader } from '@theiceji/hq-ops/db'
import { conflict, invalid, notFound } from '@theiceji/hq-ops/errors'
import {
  choice,
  day,
  idempotencyKey,
  optionalChoice,
  optionalRecordId,
  parseInput,
  recordId,
  revision,
  text,
} from '@theiceji/hq-ops/schemas'
import {
  assertModuleOn,
  audit,
  authorize,
  ownedProject,
  ownedRecord,
  returned,
  runOperation,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { parseInstant } from '@theiceji/hq-ops/time'
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { marketplaceAdapter } from './adapters/types'
import { adapterContext } from './market'

/**
 * Market's money: every sale, refund, fee and adjustment a
 * marketplace reports, one append-only line at a time, and the payouts that
 * follow.
 *
 * · **What counts is what the marketplace said**, or what the owner copied
 *   from it. A line records `gross` (what the buyer paid — negative for a
 *   refund), `fees` (what the marketplace kept) and `net` (what reaches the
 *   owner); the database checks `net = gross − fees`.
 * · **A correction is a new line** that supersedes the old one and says why.
 *   The same order line is recorded once — a sync that sees it again changes
 *   nothing.
 * · **A payout is expected until the bank shows it.** Confirming one is the
 *   owner's act.
 * · **Etsy is read, not trusted blind**: receipts become sales, ledger fees
 *   and refunds become their own lines, disbursements become expected
 *   payouts. An Etsy type HQ doesn't know is kept as an adjustment with its
 *   own name, never dropped.
 */

export type SaleLine = MarketSalesEventRow & {
  listingTitle: string | null
  marketplaceShop: string
  supersededBy: string | null
}

const DECIMAL = /^-?\d{1,13}(\.\d{1,4})?$/

/** A signed amount in a currency's own places, as a decimal string. */
function signed(raw: string | number, currency: string, label: string): string {
  const text = String(raw).replace(/[,\s]/g, '')
  if (!DECIMAL.test(text))
    throw invalid(`${label} must be a number, like 12.50.`, {
      [label.toLowerCase()]: 'Enter a number.',
    })
  const negative = text.startsWith('-')
  const parsed = parseAmount(negative ? text.slice(1) : text, currency)
  if ('error' in parsed) throw invalid(parsed.error)
  return negative && !/^0(\.0+)?$/.test(parsed.ok) ? `-${parsed.ok}` : parsed.ok
}

const negate = (amount: string) =>
  amount.startsWith('-')
    ? amount.slice(1)
    : /^0(\.0+)?$/.test(amount)
      ? amount
      : `-${amount}`

function minus(a: string, b: string, currency: string): string {
  const digits = digitsOf(currency)
  return fromMinor(toMinor(a, digits) - toMinor(b, digits), digits)
}

/** A line nothing corrected. */
export function isCurrentSale() {
  return sql`not exists (select 1 from market_sales_events successor where successor.supersedes_id = ${marketSalesEvents.id})`
}

const saleSchema = z.object({
  marketplaceId: recordId('Marketplace'),
  listingId: optionalRecordId('Listing'),
  kind: choice(
    MARKET_SALE_KINDS,
    'Say if it is a sale, refund, fee or adjustment.',
  ),
  occurredAt: z.union([z.string().max(40), z.date()]).optional(),
  quantity: z.number().int().min(0).max(100000).optional(),
  /**
   * What happened, as a positive amount: the price of a sale, the money back
   * of a refund, the fee taken. An adjustment is signed.
   */
  amount: z.union([z.string().max(24), z.number()]),
  /** The marketplace's fees on a sale. */
  fees: z.union([z.string().max(24), z.number()]).optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, like USD.')
    .optional(),
  orderRef: text.optional('Order', 120),
  source: optionalChoice(READING_SOURCES, 'Say where it came from.'),
  note: text.optional('Note', 1000),
  supersedesId: optionalRecordId('Line'),
  correctionReason: text.optional('Correction reason', 1000),
  idempotencyKey: idempotencyKey.optional(),
})

export type RecordSaleInput = z.input<typeof saleSchema>

/**
 * One money line on the record. An agent needs the owner's policy to allow
 * importing; a correction names the line it replaces and why.
 */
export async function recordSale(
  actor: Actor,
  raw: RecordSaleInput,
): Promise<MarketSalesEventRow> {
  const input = parseInput(saleSchema, raw)
  if (input.supersedesId && !input.correctionReason)
    throw invalid('Say why the line is corrected.', {
      correctionReason: 'Why is the old line wrong?',
    })
  const outcome = await runOperation(
    actor,
    {
      operation: 'market_record_sale',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { row: marketplace, project } =
          await ownedRecord<MarketMarketplaceRow>(
            tx,
            actor,
            marketMarketplaces,
            input.marketplaceId,
            'market',
            'write',
            'Marketplace',
            'import',
          )
        if (!project) throw notFound('Marketplace')
        assertModuleOn(project, 'market')
        let listing: MarketListingRow | null = null
        if (input.listingId) {
          const [row] = await tx
            .select()
            .from(marketListings)
            .where(
              and(
                eq(marketListings.id, input.listingId),
                eq(marketListings.ownerId, actor.userId),
                eq(marketListings.marketplaceId, marketplace.id),
              ),
            )
            .limit(1)
          if (!row)
            throw invalid('That listing isn’t on this marketplace.', {
              listingId: 'Choose a listing of this shop.',
            })
          listing = row
        }
        const currency = input.currency ?? marketplace.currency
        const amount = signed(input.amount, currency, 'Amount')
        if (input.kind !== 'adjustment' && amount.startsWith('-'))
          throw invalid(
            'Enter the amount as a positive number; the kind says which way it goes.',
          )
        const fees =
          input.kind === 'sale' && input.fees !== undefined
            ? signed(input.fees, currency, 'Fees')
            : null
        if (fees?.startsWith('-')) throw invalid('Fees can’t be negative.')
        const zero = fromMinor(0n, digitsOf(currency))
        const line =
          input.kind === 'sale'
            ? { gross: amount, fees: fees ?? zero }
            : input.kind === 'refund'
              ? { gross: negate(amount), fees: zero }
              : input.kind === 'fee'
                ? { gross: zero, fees: amount }
                : { gross: amount, fees: zero }
        const now = await dbNow(tx)
        const occurredAt =
          input.occurredAt instanceof Date
            ? input.occurredAt
            : input.occurredAt
              ? parseInstant(input.occurredAt, project.timezone)
              : now
        if (!occurredAt) throw invalid('When must be a date and time.')
        if (occurredAt.getTime() > now.getTime() + 60_000)
          throw invalid('A sale can’t be in the future.')
        let supersedes: MarketSalesEventRow | null = null
        if (input.supersedesId) {
          const [old] = await tx
            .select()
            .from(marketSalesEvents)
            .where(
              and(
                eq(marketSalesEvents.id, input.supersedesId),
                eq(marketSalesEvents.ownerId, actor.userId),
              ),
            )
            .limit(1)
          if (!old) throw notFound('Line')
          if (old.marketplaceId !== marketplace.id)
            throw invalid('A correction stays on the same marketplace.')
          supersedes = old
        }
        const [row] = await tx
          .insert(marketSalesEvents)
          .values({
            ownerId: actor.userId,
            projectId: project.id,
            marketplaceId: marketplace.id,
            listingId: listing?.id ?? null,
            kind: input.kind,
            occurredAt,
            quantity: input.quantity ?? (input.kind === 'sale' ? 1 : 0),
            gross: line.gross,
            fees: line.fees,
            net: minus(line.gross, line.fees, currency),
            currency,
            orderRef: input.orderRef ?? null,
            source:
              input.source ?? (actor.type === 'user' ? 'manual' : 'agent'),
            note: input.note ?? null,
            supersedesId: supersedes?.id ?? null,
            correctionReason: input.correctionReason ?? null,
            actorType: actor.type,
            actorId: actor.id,
          })
          .returning()
        const sale = returned(row)
        await audit(tx, actor, {
          projectId: project.id,
          action: supersedes ? 'market.sale.correct' : 'market.sale.record',
          targetType: listing ? 'listing' : 'marketplace',
          targetId: listing?.id ?? marketplace.id,
          reason: input.correctionReason ?? null,
          changes: {
            line: sale.id,
            kind: sale.kind,
            gross: sale.gross,
            fees: sale.fees,
            net: sale.net,
            currency,
            orderRef: sale.orderRef,
          },
        })
        return sale
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.line_id
    if (typeof id !== 'string') throw conflict()
    const row = await withReader(async (db) => {
      const [found] = await db
        .select()
        .from(marketSalesEvents)
        .where(
          and(
            eq(marketSalesEvents.id, id),
            eq(marketSalesEvents.ownerId, actor.userId),
          ),
        )
      return found
    })
    if (!row) throw conflict()
    return row
  }
  await outcome.complete({ line_id: outcome.value.id })
  return outcome.value
}

/** A project's money lines, newest first — corrections marked by `supersededBy`. */
export async function listSales(
  actor: Actor,
  raw: {
    projectId: string
    marketplaceId?: string
    listingId?: string
    limit?: number
  },
): Promise<SaleLine[]> {
  const input = parseInput(
    z.object({
      projectId: recordId('Project'),
      marketplaceId: optionalRecordId('Marketplace'),
      listingId: optionalRecordId('Listing'),
      limit: z.number().int().min(1).max(1000).optional(),
    }),
    raw,
  )
  return withReader(async (db) => {
    const project = await ownedProject(
      db,
      actor,
      input.projectId,
      'market',
      'read',
    )
    assertModuleOn(project, 'market')
    const next = alias(marketSalesEvents, 'successor')
    const rows = await db
      .select({
        line: marketSalesEvents,
        listingTitle: marketListings.title,
        marketplaceShop: marketMarketplaces.shop,
        supersededBy: next.id,
      })
      .from(marketSalesEvents)
      .innerJoin(
        marketMarketplaces,
        eq(marketMarketplaces.id, marketSalesEvents.marketplaceId),
      )
      .leftJoin(
        marketListings,
        eq(marketListings.id, marketSalesEvents.listingId),
      )
      .leftJoin(next, eq(next.supersedesId, marketSalesEvents.id))
      .where(
        and(
          eq(marketSalesEvents.ownerId, actor.userId),
          eq(marketSalesEvents.projectId, project.id),
          input.marketplaceId
            ? eq(marketSalesEvents.marketplaceId, input.marketplaceId)
            : undefined,
          input.listingId
            ? eq(marketSalesEvents.listingId, input.listingId)
            : undefined,
        ),
      )
      .orderBy(
        desc(marketSalesEvents.occurredAt),
        desc(marketSalesEvents.createdAt),
      )
      .limit(input.limit ?? 300)
    return rows.map((row) => ({
      ...row.line,
      listingTitle: row.listingTitle,
      marketplaceShop: row.marketplaceShop,
      supersededBy: row.supersededBy,
    }))
  })
}

/* ── Payouts ────────────────────────────────────────────────────────── */

const payoutSchema = z.object({
  marketplaceId: recordId('Marketplace'),
  amount: z.union([z.string().max(24), z.number().min(0)]),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  expectedOn: day('Expected on'),
  reference: text.optional('Reference', 120),
  note: text.optional('Note', 1000),
  idempotencyKey: idempotencyKey.optional(),
})

/** A payout the marketplace says is coming. Confirming it is the owner's. */
export async function recordPayout(
  actor: Actor,
  raw: z.input<typeof payoutSchema>,
): Promise<MarketPayoutRow> {
  const input = parseInput(payoutSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'market_record_payout',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { row: marketplace, project } =
          await ownedRecord<MarketMarketplaceRow>(
            tx,
            actor,
            marketMarketplaces,
            input.marketplaceId,
            'market',
            'write',
            'Marketplace',
            'import',
          )
        if (!project) throw notFound('Marketplace')
        assertModuleOn(project, 'market')
        const currency = input.currency ?? marketplace.currency
        const parsed = parseAmount(input.amount, currency)
        if ('error' in parsed) throw invalid(parsed.error)
        const [row] = await tx
          .insert(marketPayouts)
          .values({
            ownerId: actor.userId,
            createdBy: actor.userId,
            projectId: project.id,
            marketplaceId: marketplace.id,
            amount: parsed.ok,
            currency,
            expectedOn: input.expectedOn ?? null,
            reference: input.reference ?? null,
            note: input.note ?? null,
          })
          .returning()
        const payout = returned(row)
        await audit(tx, actor, {
          projectId: project.id,
          action: 'market.payout.expect',
          targetType: 'payout',
          targetId: payout.id,
          afterRevision: payout.revision,
          changes: {
            amount: payout.amount,
            currency,
            expectedOn: payout.expectedOn,
            reference: payout.reference,
          },
        })
        return payout
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.payout_id
    if (typeof id !== 'string') throw conflict()
    return (
      await withReader((db) =>
        ownedRecord<MarketPayoutRow>(
          db,
          actor,
          marketPayouts,
          id,
          'market',
          'read',
          'Payout',
        ),
      )
    ).row
  }
  await outcome.complete({ payout_id: outcome.value.id })
  return outcome.value
}

/** The bank showed it: the owner confirms a payout (with the amount that arrived). */
export async function confirmPayout(
  actor: Actor,
  raw: {
    payoutId: string
    expectedRevision: number
    paidOn: string
    amount?: string | number
  },
): Promise<MarketPayoutRow> {
  const input = parseInput(
    z.object({
      payoutId: recordId('Payout'),
      expectedRevision: revision,
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
      amount: z.union([z.string().max(24), z.number().min(0)]).optional(),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { row, project } = await ownedRecord<MarketPayoutRow>(
      tx,
      actor,
      marketPayouts,
      input.payoutId,
      'market',
      'write',
      'Payout',
      'owner_only',
    )
    if (row.revision !== input.expectedRevision) throw conflict()
    if (row.status === 'confirmed') return row
    let amount = row.amount
    if (input.amount !== undefined) {
      const parsed = parseAmount(input.amount, row.currency)
      if ('error' in parsed) throw invalid(parsed.error)
      amount = parsed.ok
    }
    const saved = returned(
      (
        await tx
          .update(marketPayouts)
          .set({
            status: 'confirmed',
            paidOn: input.paidOn,
            amount,
            revision: sql`${marketPayouts.revision} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(marketPayouts.id, row.id),
              eq(marketPayouts.revision, row.revision),
            ),
          )
          .returning()
      )[0],
    )
    await audit(tx, actor, {
      projectId: project?.id ?? null,
      action: 'market.payout.confirm',
      targetType: 'payout',
      targetId: saved.id,
      beforeRevision: row.revision,
      afterRevision: saved.revision,
      changes: { amount: saved.amount, paidOn: saved.paidOn },
    })
    return saved
  })
}

export async function listPayouts(
  actor: Actor,
  raw: { projectId: string },
): Promise<(MarketPayoutRow & { marketplaceShop: string })[]> {
  const input = parseInput(z.object({ projectId: recordId('Project') }), raw)
  return withReader(async (db) => {
    const project = await ownedProject(
      db,
      actor,
      input.projectId,
      'market',
      'read',
    )
    assertModuleOn(project, 'market')
    const rows = await db
      .select({ payout: marketPayouts, shop: marketMarketplaces.shop })
      .from(marketPayouts)
      .innerJoin(
        marketMarketplaces,
        eq(marketMarketplaces.id, marketPayouts.marketplaceId),
      )
      .where(
        and(
          eq(marketPayouts.ownerId, actor.userId),
          eq(marketPayouts.projectId, project.id),
        ),
      )
      .orderBy(
        sql`${marketPayouts.status} = 'confirmed'`,
        desc(
          sql`coalesce(${marketPayouts.paidOn}, ${marketPayouts.expectedOn})`,
        ),
      )
      .limit(200)
    return rows.map((row) => ({ ...row.payout, marketplaceShop: row.shop }))
  })
}

/* ── Sync from a marketplace's API ──────────────────────────────────── */

export type SyncOutcome = {
  sales: number
  fees: number
  refunds: number
  payouts: number
  unmatched: number
}

/**
 * Read orders and the ledger since the last sync (the last 30 days the first
 * time) and put what's new on the record. Lines already recorded are
 * skipped by their order reference, so a sync can run any number of times.
 */
export async function syncMarketplace(
  actor: Actor,
  marketplaceId: string,
): Promise<SyncOutcome> {
  const marketplace = await withReader(async (db) => {
    const { row, project } = await ownedRecord<MarketMarketplaceRow>(
      db,
      actor,
      marketMarketplaces,
      marketplaceId,
      'market',
      'write',
      'Marketplace',
      'import',
    )
    if (!project) throw notFound('Marketplace')
    assertModuleOn(project, 'market')
    return row
  })
  return syncRow(actor, marketplace)
}

/**
 * The sync itself, for a marketplace already checked — by `syncMarketplace`
 * for a caller, or by the tick for the owner, audited as the scheduler.
 */
async function syncRow(
  actor: Actor,
  marketplace: MarketMarketplaceRow,
): Promise<SyncOutcome> {
  const adapter = marketplaceAdapter(marketplace.kind)
  if (!adapter?.syncOrders)
    throw invalid(
      `HQ can’t read ${marketplace.shop}’s orders by itself — record sales by hand.`,
    )
  const context = await adapterContext(marketplace, actor.userId)
  const started = await withReader((db) => dbNow(db))
  const since =
    marketplace.syncedAt ?? new Date(started.getTime() - 30 * 86_400_000)
  const tally: SyncOutcome = {
    sales: 0,
    fees: 0,
    refunds: 0,
    payouts: 0,
    unmatched: 0,
  }
  try {
    const orders = await adapter.syncOrders(context, since)
    const ledger = adapter.syncLedger
      ? await adapter.syncLedger(context, since)
      : []
    await withTransaction(async (tx) => {
      const listings = await tx
        .select({
          id: marketListings.id,
          externalId: marketListings.externalId,
        })
        .from(marketListings)
        .where(
          and(
            eq(marketListings.marketplaceId, marketplace.id),
            isNotNull(marketListings.externalId),
          ),
        )
      const byExternal = new Map(
        listings.map((row) => [row.externalId as string, row.id]),
      )
      const insert = async (values: {
        kind: MarketSalesEventRow['kind']
        listingId: string | null
        occurredAt: Date
        quantity: number
        gross: string
        fees: string
        currency: string
        orderRef: string
        note: string | null
      }) => {
        const [row] = await tx
          .insert(marketSalesEvents)
          .values({
            ownerId: actor.userId,
            projectId: marketplace.projectId,
            marketplaceId: marketplace.id,
            ...values,
            net: minus(values.gross, values.fees, values.currency),
            source: 'provider',
            actorType: actor.type,
            actorId: actor.id,
          })
          .onConflictDoNothing()
          .returning({ id: marketSalesEvents.id })
        return Boolean(row)
      }
      for (const order of orders) {
        if (order.status === 'cancelled') continue
        const digits = digitsOf(order.currency)
        for (const line of order.lines) {
          const listingId = line.externalListingId
            ? (byExternal.get(line.externalListingId) ?? null)
            : null
          if (!listingId) tally.unmatched++
          const gross = fromMinor(
            BigInt(line.unitPriceMinor) * BigInt(line.quantity),
            2,
          )
          const added = await insert({
            kind: 'sale',
            listingId,
            occurredAt: order.orderedAt,
            quantity: line.quantity,
            gross: fromMinor(toMinor(gross, digits), digits),
            fees: fromMinor(0n, digits),
            currency: order.currency,
            orderRef: `${order.externalOrderId}:${line.externalLineId}`,
            note: line.title,
          })
          if (added) tally.sales++
        }
      }
      for (const entry of ledger) {
        const digits = digitsOf(entry.currency)
        const amount = fromMinor(BigInt(Math.abs(entry.amountMinor)), 2)
        const exact = fromMinor(toMinor(amount, digits), digits)
        const zero = fromMinor(0n, digits)
        const listingId = entry.externalListingId
          ? (byExternal.get(entry.externalListingId) ?? null)
          : null
        const type = entry.kind.type
        if (type === 'sale' || type === 'tax') continue
        if (type === 'payout') {
          const [row] = await tx
            .insert(marketPayouts)
            .values({
              ownerId: actor.userId,
              createdBy: actor.userId,
              projectId: marketplace.projectId,
              marketplaceId: marketplace.id,
              amount: exact,
              currency: entry.currency,
              expectedOn: entry.effectiveAt.toISOString().slice(0, 10),
              reference: entry.externalEventId,
              note: entry.description,
            })
            .onConflictDoNothing()
            .returning({ id: marketPayouts.id })
          if (row) tally.payouts++
          continue
        }
        const added = await insert({
          kind:
            type === 'fee'
              ? 'fee'
              : type === 'refund' || type === 'chargeback'
                ? 'refund'
                : 'adjustment',
          listingId,
          occurredAt: entry.effectiveAt,
          quantity: 0,
          gross:
            type === 'fee'
              ? zero
              : type === 'adjustment'
                ? entry.amountMinor < 0
                  ? negate(exact)
                  : exact
                : negate(exact),
          fees: type === 'fee' ? exact : zero,
          currency: entry.currency,
          orderRef: entry.externalEventId,
          note: entry.description,
        })
        if (added) {
          if (type === 'fee') tally.fees++
          else if (type === 'refund' || type === 'chargeback') tally.refunds++
        }
      }
      await tx
        .update(marketMarketplaces)
        .set({ syncedAt: started, syncProblem: null })
        .where(eq(marketMarketplaces.id, marketplace.id))
      await audit(tx, actor, {
        projectId: marketplace.projectId,
        action: 'market.sync',
        targetType: 'marketplace',
        targetId: marketplace.id,
        changes: { since: since.toISOString(), ...tally },
      })
    })
  } catch (error) {
    const problem =
      error instanceof Error ? error.message.slice(0, 500) : 'The sync failed.'
    await withTransaction(async (tx) => {
      await tx
        .update(marketMarketplaces)
        .set({ syncProblem: problem })
        .where(eq(marketMarketplaces.id, marketplace.id))
    })
    throw error
  }
  return tally
}

/** The ops tick: sync each connected marketplace at most once an hour. */
export async function syncDueMarketplaces(
  options: { limit?: number } = {},
): Promise<{ synced: number; failed: number }> {
  const due = await withReader((db) =>
    db
      .select({ marketplace: marketMarketplaces })
      .from(marketMarketplaces)
      .innerJoin(projects, eq(projects.id, marketMarketplaces.projectId))
      .where(
        and(
          isNotNull(marketMarketplaces.connectionId),
          sql`${marketMarketplaces.archivedAt} is null`,
          sql`${projects.status} = 'active'`,
          or(
            sql`${marketMarketplaces.syncedAt} is null`,
            sql`${marketMarketplaces.syncedAt} < now() - interval '1 hour'`,
          ),
        ),
      )
      .limit(options.limit ?? 3),
  )
  let synced = 0
  let failed = 0
  for (const { marketplace } of due) {
    if (!marketplaceAdapter(marketplace.kind)?.syncOrders) continue
    try {
      await syncRow(schedulerActor(marketplace.ownerId), marketplace)
      synced++
    } catch (error) {
      console.error('[market] sync', marketplace.id, error)
      failed++
    }
  }
  return { synced, failed }
}

/* ── Home ───────────────────────────────────────────────────────────── */

export type MarketSummary = {
  projectId: string
  live: number
  planned: number
  approved: number
  /** Sales in the last 7 days, per currency: units and net. */
  week: { currency: string; units: number; net: string }[]
  /** Payouts the marketplace announced that the owner hasn't confirmed. */
  expected: { currency: string; amount: string; count: number }[]
}

export async function marketSummaries(actor: Actor): Promise<MarketSummary[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'market', 'read')
    const [listings, sales] = await Promise.all([
      db
        .select({
          projectId: marketListings.projectId,
          live: sql<number>`count(*) filter (where ${marketListings.status} in ('listed', 'verified'))::int`,
          planned: sql<number>`count(*) filter (where ${marketListings.status} = 'planned')::int`,
          approved: sql<number>`count(*) filter (where ${marketListings.status} = 'approved')::int`,
        })
        .from(marketListings)
        .where(eq(marketListings.ownerId, actor.userId))
        .groupBy(marketListings.projectId),
      db
        .select({
          projectId: marketSalesEvents.projectId,
          currency: marketSalesEvents.currency,
          units: sql<number>`coalesce(sum(${marketSalesEvents.quantity}) filter (where ${marketSalesEvents.kind} = 'sale'), 0)::int`,
          net: sql<string>`sum(${marketSalesEvents.net})::text`,
        })
        .from(marketSalesEvents)
        .where(
          and(
            eq(marketSalesEvents.ownerId, actor.userId),
            sql`${marketSalesEvents.occurredAt} >= now() - interval '7 days'`,
            isCurrentSale(),
          ),
        )
        .groupBy(marketSalesEvents.projectId, marketSalesEvents.currency),
    ])
    const payouts = await db
      .select({
        projectId: marketPayouts.projectId,
        currency: marketPayouts.currency,
        amount: sql<string>`sum(${marketPayouts.amount})::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(marketPayouts)
      .where(
        and(
          eq(marketPayouts.ownerId, actor.userId),
          eq(marketPayouts.status, 'expected'),
        ),
      )
      .groupBy(marketPayouts.projectId, marketPayouts.currency)
    const ids = new Set([
      ...listings.map((row) => row.projectId),
      ...sales.map((row) => row.projectId),
      ...payouts.map((row) => row.projectId),
    ])
    return [...ids].map((projectId) => {
      const row = listings.find((entry) => entry.projectId === projectId)
      return {
        projectId,
        live: row?.live ?? 0,
        planned: row?.planned ?? 0,
        approved: row?.approved ?? 0,
        week: sales
          .filter((entry) => entry.projectId === projectId)
          .map((entry) => ({
            currency: entry.currency,
            units: entry.units,
            net: entry.net,
          })),
        expected: payouts
          .filter((entry) => entry.projectId === projectId)
          .map((entry) => ({
            currency: entry.currency,
            amount: entry.amount,
            count: entry.count,
          })),
      }
    })
  })
}

/* ── Readers for the registries ─────────────────────────────────────── */

/** Current money lines in `[from, to)` — for the dashboard and Home. */
export async function saleLinesBetween(
  reader: Reader,
  ownerId: string,
  range: { from: Date; to: Date; projectId: string | null },
): Promise<MarketSalesEventRow[]> {
  return reader
    .select()
    .from(marketSalesEvents)
    .where(
      and(
        eq(marketSalesEvents.ownerId, ownerId),
        range.projectId
          ? eq(marketSalesEvents.projectId, range.projectId)
          : undefined,
        gte(marketSalesEvents.occurredAt, range.from),
        lt(marketSalesEvents.occurredAt, range.to),
        isCurrentSale(),
      ),
    )
}

/** Listings' sale lines, for reading them at an age. */
export async function saleLinesOf(
  reader: Reader,
  ownerId: string,
  listingIds: readonly string[],
): Promise<MarketSalesEventRow[]> {
  if (listingIds.length === 0) return []
  return reader
    .select()
    .from(marketSalesEvents)
    .where(
      and(
        eq(marketSalesEvents.ownerId, ownerId),
        inArray(marketSalesEvents.listingId, [...listingIds]),
        isCurrentSale(),
      ),
    )
}
