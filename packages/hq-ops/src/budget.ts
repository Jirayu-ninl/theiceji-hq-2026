import type { OpsBudgetKind, OpsUsageCostStatus } from '@theiceji/hq-db/enums'
import {
  type OpsBudgetReservationRow,
  type OpsPolicyRow,
  type OpsUsageEventRow,
  opsBudgetReservations,
  opsUsageEvents,
  type ProjectRow,
} from '@theiceji/hq-db/schema'
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { type Actor, assertKernelRead } from './access'
import { schedulerActor } from './actors'
import { dbNow, nowPlus, type Reader, type Tx } from './db'
import { budgetExceeded, conflict, invalid } from './errors'
import { currentPolicy, sameProject } from './policy-gate'
import {
  audit,
  ownProject,
  returned,
  withReader,
  withTransaction,
} from './store'
import { DEFAULT_TIME_ZONE, dayRange, monthRange, zonedDay } from './time'
import { formatMinorUnits } from './values'

/**
 * Money and quota an agent may commit.
 *
 * Before work that may cost anything, the service reserves the estimate
 * against the owner's policy under a lock per owner and project (or per
 * owner, for work in no project), so two workers can't both spend the last
 * baht. The reservation is settled against what the provider actually
 * charged, or released. What a period has used is every live reservation
 * plus every settled amount — failed attempts included.
 *
 * A price nobody knows is not free: it stops the work (`budget_exceeded`)
 * until the owner decides. Usage is its own append-only history, LLM tokens
 * included. (Creator also wrote a reconciled cash cost into its cost ledger,
 * `creator_costs`; the ops kernel has no ledger and `ops_usage_events` has no
 * `cost_id` — money reporting reads usage directly.)
 *
 * Days and months are the project's own, in its timezone — or the owner's
 * default timezone for work in no project — and "now" is the database's.
 */

export type Spend = {
  kind: OpsBudgetKind
  /** The currency for cash; `<provider>:<unit>` for credits and quota. */
  unit: string
  /** Minor units for cash, whole units otherwise. Null when nobody knows. */
  amount: number | null
}

/** How long a reservation holds before the tick expires it. */
export const DEFAULT_RESERVATION_TTL_SECONDS = 6 * 3600

async function lockBudget(
  tx: Tx,
  ownerId: string,
  projectId: string | null,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`ops-budget:${ownerId}:${projectId ?? 'none'}`}, 0))`,
  )
}

type Window = { start: Date; end: Date }

function windows(
  timeZone: string,
  now: Date,
): {
  day: Window
  month: Window
} {
  const today = zonedDay(now, timeZone)
  return {
    day: dayRange(today, today, timeZone),
    month: monthRange(today, timeZone),
  }
}

/** Committed spend in a window: live reservations plus settled amounts. */
async function committed(
  reader: Reader,
  ownerId: string,
  projectId: string | null,
  kind: OpsBudgetKind | 'units',
  unit: string,
  window: Window,
): Promise<number> {
  const [row] = await reader
    .select({
      total: sql<string>`coalesce(sum(case
        when ${opsBudgetReservations.status} = 'settled' then ${opsBudgetReservations.settledAmount}
        when ${opsBudgetReservations.status} = 'reserved' and ${opsBudgetReservations.expiresAt} > now() then ${opsBudgetReservations.amount}
        else 0 end), 0)`,
    })
    .from(opsBudgetReservations)
    .where(
      and(
        eq(opsBudgetReservations.ownerId, ownerId),
        sameProject(opsBudgetReservations.projectId, projectId),
        kind === 'units'
          ? inArray(opsBudgetReservations.kind, ['credits', 'quota'])
          : eq(opsBudgetReservations.kind, kind),
        eq(opsBudgetReservations.unit, unit),
        gte(opsBudgetReservations.createdAt, window.start),
        lt(opsBudgetReservations.createdAt, window.end),
      ),
    )
  return Number(row?.total ?? 0)
}

export type LimitSet = {
  perJob: number | null
  perDay: number | null
  perMonth: number | null
}

/** What the policy allows for a spend unit. Null limits mean none allowed. */
export function limitsFor(
  policy: OpsPolicyRow,
  kind: OpsBudgetKind,
  unit: string,
): LimitSet | null {
  if (kind === 'cash') {
    if (unit !== policy.currency) return null
    return {
      perJob: policy.cashLimitPerJobMinor,
      perDay: policy.cashLimitPerDayMinor,
      perMonth: policy.cashLimitPerMonthMinor,
    }
  }
  const entry = policy.unitLimits[unit]
  if (!entry) return null
  return {
    perJob: entry.perJob ?? null,
    perDay: entry.perDay ?? null,
    perMonth: entry.perMonth ?? null,
  }
}

function describe(kind: OpsBudgetKind, unit: string, amount: number): string {
  return kind === 'cash'
    ? `${formatMinorUnits(amount, unit)} ${unit}`
    : `${amount} ${unit}`
}

export type ReserveInput = {
  spend: Spend
  provider: string
  purpose: string
  subjectType?: string | null
  subjectId?: string | null
  ttlSeconds?: number
}

/**
 * Holds budget for one piece of work, or refuses before anything external
 * happens. Must run inside the transaction that records the work. `project`
 * null reserves against the owner's no-project policy.
 */
export async function reserveBudget(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  policy: OpsPolicyRow,
  input: ReserveInput,
): Promise<OpsBudgetReservationRow> {
  const { spend } = input
  const projectId = project?.id ?? null
  if (policy.ownerId !== actor.userId || policy.projectId !== projectId)
    throw invalid('That policy isn’t the one for this work.')
  if (spend.amount === null)
    throw budgetExceeded(
      `The ${spend.kind === 'cash' ? 'price' : 'quota use'} of this ${input.purpose} isn’t known, and an unknown price isn’t free. Ask the owner (agents_request_human, kind spend_scope) or use a provider whose cost is known.`,
      { reason: 'unknown_price', provider: input.provider, unit: spend.unit },
    )
  if (!Number.isSafeInteger(spend.amount) || spend.amount < 0)
    throw invalid('A spend estimate must be a whole, non-negative amount.')

  await lockBudget(tx, actor.userId, projectId)

  if (spend.amount > 0) {
    const limits = limitsFor(policy, spend.kind, spend.unit)
    if (!limits)
      throw budgetExceeded(
        spend.kind === 'cash'
          ? `The operating policy has no cash budget in ${spend.unit}, so agents can’t commit money in it.`
          : `The operating policy sets no limit for ${spend.unit}, so its quota is unknown and agents can’t use it.`,
        { reason: 'no_limit', unit: spend.unit, kind: spend.kind },
      )
    const amount = spend.amount
    const refuse = (scope: string, limit: number | null, used: number) =>
      budgetExceeded(
        `This ${input.purpose} needs ${describe(spend.kind, spend.unit, amount)}, which is over the ${scope} limit (${limit === null ? 'none allowed' : `${describe(spend.kind, spend.unit, limit)}, ${describe(spend.kind, spend.unit, used)} already committed`}). Only the owner can raise it.`,
        {
          reason: `${scope}_limit`,
          unit: spend.unit,
          limit,
          committed: used,
          requested: amount,
          policyRevision: policy.revisionNo,
        },
      )
    if (limits.perJob === null || amount > limits.perJob)
      throw refuse('per-job', limits.perJob, 0)
    const { day, month } = windows(
      project?.timezone ?? DEFAULT_TIME_ZONE,
      await dbNow(tx),
    )
    const kind = spend.kind === 'cash' ? 'cash' : 'units'
    const usedDay = await committed(
      tx,
      actor.userId,
      projectId,
      kind,
      spend.unit,
      day,
    )
    if (limits.perDay === null || usedDay + amount > limits.perDay)
      throw refuse('daily', limits.perDay, usedDay)
    const usedMonth = await committed(
      tx,
      actor.userId,
      projectId,
      kind,
      spend.unit,
      month,
    )
    if (limits.perMonth === null || usedMonth + amount > limits.perMonth)
      throw refuse('monthly', limits.perMonth, usedMonth)
  }

  const reservation = returned(
    (
      await tx
        .insert(opsBudgetReservations)
        .values({
          ownerId: actor.userId,
          projectId,
          policyId: policy.id,
          kind: spend.kind,
          unit: spend.unit,
          amount: spend.amount,
          provider: input.provider,
          purpose: input.purpose,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          actorType: actor.type,
          actorId: actor.id,
          expiresAt: nowPlus(
            input.ttlSeconds ?? DEFAULT_RESERVATION_TTL_SECONDS,
          ),
          createdBy: actor.userId,
        })
        .returning()
    )[0],
  )
  await audit(tx, actor, {
    projectId,
    action: 'budget.reserve',
    targetType: 'budget_reservation',
    targetId: reservation.id,
    changes: {
      kind: spend.kind,
      unit: spend.unit,
      amount: spend.amount,
      provider: input.provider,
      purpose: input.purpose,
      policyRevision: policy.revisionNo,
    },
  })
  return reservation
}

/** Points the reservation at the work it was held for, once that row exists. */
export async function attachReservation(
  tx: Tx,
  actor: Actor,
  reservationId: string,
  subject: { type: string; id: string },
): Promise<void> {
  const [row] = await tx
    .update(opsBudgetReservations)
    .set({ subjectType: subject.type, subjectId: subject.id })
    .where(
      and(
        eq(opsBudgetReservations.id, reservationId),
        eq(opsBudgetReservations.ownerId, actor.userId),
      ),
    )
    .returning({ id: opsBudgetReservations.id })
  if (!row) throw invalid('That budget reservation isn’t yours.')
}

/**
 * Settles a reservation at what the work actually cost. An expired one can
 * still be settled: the provider charged whether or not the hold lapsed.
 */
export async function settleReservation(
  tx: Tx,
  actor: Actor,
  reservationId: string,
  settledAmount: number,
  reason: string,
): Promise<OpsBudgetReservationRow> {
  if (!Number.isSafeInteger(settledAmount) || settledAmount < 0)
    throw invalid('A settled amount must be a whole, non-negative amount.')
  const [row] = await tx
    .update(opsBudgetReservations)
    .set({
      status: 'settled',
      settledAmount,
      settledAt: sql`now()`,
      statusReason: reason,
    })
    .where(
      and(
        eq(opsBudgetReservations.id, reservationId),
        eq(opsBudgetReservations.ownerId, actor.userId),
        inArray(opsBudgetReservations.status, ['reserved', 'expired']),
      ),
    )
    .returning()
  if (!row)
    throw conflict('That budget reservation was already settled or released.')
  await audit(tx, actor, {
    projectId: row.projectId,
    action: 'budget.settle',
    targetType: 'budget_reservation',
    targetId: row.id,
    reason,
    changes: { reserved: row.amount, settled: settledAmount, unit: row.unit },
  })
  return row
}

/** Gives a hold back unused. Null when it was no longer reserved. */
export async function releaseReservation(
  tx: Tx,
  actor: Actor,
  reservationId: string,
  reason: string,
): Promise<OpsBudgetReservationRow | null> {
  const [row] = await tx
    .update(opsBudgetReservations)
    .set({
      status: 'released',
      releasedAt: sql`now()`,
      statusReason: reason,
    })
    .where(
      and(
        eq(opsBudgetReservations.id, reservationId),
        eq(opsBudgetReservations.ownerId, actor.userId),
        eq(opsBudgetReservations.status, 'reserved'),
      ),
    )
    .returning()
  if (!row) return null
  await audit(tx, actor, {
    projectId: row.projectId,
    action: 'budget.release',
    targetType: 'budget_reservation',
    targetId: row.id,
    reason,
    changes: { amount: row.amount, unit: row.unit },
  })
  return row
}

/**
 * The tick: holds past their expiry stop counting against the limit. A batch
 * at a time; the row stays, so a late charge can still settle it.
 */
export async function expireReservations(
  options: { ownerId?: string; limit?: number } = {},
): Promise<string[]> {
  return withTransaction(async (tx) => {
    const due = await tx
      .select({ id: opsBudgetReservations.id })
      .from(opsBudgetReservations)
      .where(
        and(
          options.ownerId
            ? eq(opsBudgetReservations.ownerId, options.ownerId)
            : undefined,
          eq(opsBudgetReservations.status, 'reserved'),
          sql`${opsBudgetReservations.expiresAt} < now()`,
        ),
      )
      .orderBy(asc(opsBudgetReservations.expiresAt))
      .limit(options.limit ?? 200)
      .for('update', { skipLocked: true })
    if (due.length === 0) return []
    const expired = await tx
      .update(opsBudgetReservations)
      .set({
        status: 'expired',
        statusReason: 'Held past its expiry without being settled.',
      })
      .where(
        and(
          inArray(
            opsBudgetReservations.id,
            due.map((row) => row.id),
          ),
          eq(opsBudgetReservations.status, 'reserved'),
        ),
      )
      .returning()
    for (const row of expired)
      await audit(tx, schedulerActor(row.ownerId), {
        projectId: row.projectId,
        action: 'budget.expire',
        targetType: 'budget_reservation',
        targetId: row.id,
        changes: { amount: row.amount, unit: row.unit },
      })
    return expired.map((row) => row.id)
  })
}

export type UsageInput = {
  reservationId?: string | null
  subjectType: string
  subjectId: string
  provider: string
  kind: OpsBudgetKind
  unit: string
  quantity?: number | null
  costMinor?: number | null
  currency?: string | null
  costStatus: OpsUsageCostStatus
  attemptNo?: number
  failed?: boolean
  /** LLM tokens a run used, when the provider reports them. */
  tokens?: number | null
  /** When the provider says the call happened; the database's `now()` otherwise. */
  occurredAt?: Date
  note?: string | null
}

/**
 * Records what a call used — append-only, failed attempts included. An
 * unknown cost has no amount; a known one needs its currency.
 */
export async function recordUsage(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  input: UsageInput,
): Promise<OpsUsageEventRow> {
  if (input.costStatus === 'unknown' && input.costMinor != null)
    throw invalid('An unknown cost has no amount.')
  if (input.costStatus !== 'unknown' && input.costMinor == null)
    throw invalid('A cost that is estimated or reconciled needs an amount.')
  if (input.costMinor != null && !/^[A-Z]{3}$/.test(input.currency ?? ''))
    throw invalid('A cost needs a three-letter currency.')
  const projectId = project?.id ?? null
  const usage = returned(
    (
      await tx
        .insert(opsUsageEvents)
        .values({
          ownerId: actor.userId,
          projectId,
          reservationId: input.reservationId ?? null,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          provider: input.provider,
          kind: input.kind,
          unit: input.unit,
          quantity: input.quantity ?? null,
          costMinor: input.costMinor ?? null,
          currency: input.costMinor != null ? (input.currency ?? null) : null,
          costStatus: input.costStatus,
          attemptNo: input.attemptNo ?? 1,
          failed: input.failed ?? false,
          tokens: input.tokens ?? null,
          occurredAt: input.occurredAt ?? sql`now()`,
          note: input.note ?? null,
          actorType: actor.type,
          actorId: actor.id,
          createdBy: actor.userId,
        })
        .returning()
    )[0],
  )
  await audit(tx, actor, {
    projectId,
    action: 'usage.record',
    targetType: input.subjectType,
    targetId: input.subjectId,
    changes: {
      usageId: usage.id,
      provider: input.provider,
      kind: input.kind,
      unit: input.unit,
      quantity: input.quantity ?? null,
      costMinor: input.costMinor ?? null,
      costStatus: input.costStatus,
      tokens: input.tokens ?? null,
      failed: input.failed ?? false,
    },
  })
  return usage
}

export type BudgetLine = {
  kind: 'cash' | 'units'
  unit: string
  limits: LimitSet
  day: { committed: number; available: number | null }
  month: { committed: number; available: number | null }
}

export type BudgetStatus = {
  lines: BudgetLine[]
  openReservations: number
  unknownCostEvents: number
}

/** What each policy limit has left today and this month — for the brief. */
export async function budgetStatus(
  reader: Reader,
  ownerId: string,
  project: ProjectRow | null,
  policy: OpsPolicyRow | null,
): Promise<BudgetStatus> {
  const projectId = project?.id ?? null
  const units: { kind: 'cash' | 'units'; unit: string }[] = []
  if (policy) {
    units.push({ kind: 'cash', unit: policy.currency })
    for (const unit of Object.keys(policy.unitLimits))
      units.push({ kind: 'units', unit })
  }
  const { day, month } = windows(
    project?.timezone ?? DEFAULT_TIME_ZONE,
    await dbNow(reader),
  )
  const lines: BudgetLine[] = []
  for (const entry of units) {
    const limits = policy
      ? limitsFor(
          policy,
          entry.kind === 'cash' ? 'cash' : 'credits',
          entry.unit,
        )
      : null
    if (!limits) continue
    const usedDay = await committed(
      reader,
      ownerId,
      projectId,
      entry.kind,
      entry.unit,
      day,
    )
    const usedMonth = await committed(
      reader,
      ownerId,
      projectId,
      entry.kind,
      entry.unit,
      month,
    )
    lines.push({
      ...entry,
      limits,
      day: {
        committed: usedDay,
        available:
          limits.perDay === null ? 0 : Math.max(0, limits.perDay - usedDay),
      },
      month: {
        committed: usedMonth,
        available:
          limits.perMonth === null
            ? 0
            : Math.max(0, limits.perMonth - usedMonth),
      },
    })
  }
  const [open] = await reader
    .select({ n: sql<number>`count(*)::int` })
    .from(opsBudgetReservations)
    .where(
      and(
        eq(opsBudgetReservations.ownerId, ownerId),
        sameProject(opsBudgetReservations.projectId, projectId),
        eq(opsBudgetReservations.status, 'reserved'),
      ),
    )
  const [unknown] = await reader
    .select({ n: sql<number>`count(*)::int` })
    .from(opsUsageEvents)
    .where(
      and(
        eq(opsUsageEvents.ownerId, ownerId),
        sameProject(opsUsageEvents.projectId, projectId),
        eq(opsUsageEvents.costStatus, 'unknown'),
        gte(opsUsageEvents.occurredAt, month.start),
      ),
    )
  return {
    lines,
    openReservations: open?.n ?? 0,
    unknownCostEvents: unknown?.n ?? 0,
  }
}

/** The budget of a project (or of work in no project), for HQ and the brief. */
export async function getBudgetStatus(
  actor: Actor,
  projectId: string | null,
): Promise<BudgetStatus & { policyRevision: number | null }> {
  assertKernelRead(actor)
  return withReader(async (db) => {
    const project = projectId ? await ownProject(db, actor, projectId) : null
    const policy = await currentPolicy(db, actor.userId, project?.id ?? null)
    const status = await budgetStatus(db, actor.userId, project, policy)
    return { ...status, policyRevision: policy?.revisionNo ?? null }
  })
}
