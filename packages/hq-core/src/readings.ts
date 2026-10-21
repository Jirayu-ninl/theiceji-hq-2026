import type { ModuleId } from '@theiceji/hq-db/enums'
import type { Reader } from '@theiceji/hq-ops/db'

/**
 * What Readings and Experiments read through. Neither
 * owns the numbers: posts and their readings are Publish's, listings and
 * sales are Market's, paid cards are Board's. A module that has something to
 * compare or to count registers it here when its package loads, so an
 * experiment reads a post "at 72 hours" and the dashboard sums a week of
 * money without importing another module's tables — the same seam as the
 * target and search registries.
 *
 * Two rules every provider keeps:
 *
 * · **Comparable or not counted.** A reading at an age is the latest one
 *   taken no later than that age and no earlier than three quarters of it —
 *   views at one hour are not views at three days. A subject younger than
 *   the age is `too_young`, never a low number; one old enough with nothing
 *   near that age is `not_read`.
 * · **Money is a record, not a promise.** A money line is a sale, a fee, a
 *   refund, an earnings reading or a paid card that already happened; pending
 *   money is Home's, from awaiting-payment lanes and sent quotes.
 */

/** What an experiment compares and the dashboard lists. */
export type SubjectType = 'post' | 'listing'

export type SubjectSummary = {
  type: SubjectType
  id: string
  projectId: string
  title: string
  /** Where it went — an account or a marketplace — in words. */
  where: string
  status: string
  /** When it went out; null while it hasn't. */
  wentOutAt: Date | null
  href: string
}

export type AgeReading =
  | {
      state: 'known'
      value: string
      /** When the counter was true (or the end of the span it sums). */
      asOf: Date
      currency: string | null
    }
  /** Not old enough yet — `readyAt` is when it will be. */
  | { state: 'too_young'; readyAt: Date }
  /** Hasn't gone out. */
  | { state: 'not_out' }
  /** Old enough, but nothing was read near that age. */
  | { state: 'not_read' }

export type SubjectProvider = {
  type: SubjectType
  module: ModuleId
  /** The metrics this kind of subject is read on, most useful first. */
  metrics: readonly string[]
  /** The owner's subjects by ID; someone else's are simply absent. */
  describe(
    reader: Reader,
    ownerId: string,
    ids: readonly string[],
  ): Promise<SubjectSummary[]>
  /** Each subject's `metric` at `ageHours` after it went out, judged at `now`. */
  atAge(
    reader: Reader,
    ownerId: string,
    ids: readonly string[],
    metric: string,
    ageHours: number,
    now: Date,
  ): Promise<Map<string, AgeReading>>
  /** Each subject's `metric` to date — the newest reading, or the sum so far. */
  latest(
    reader: Reader,
    ownerId: string,
    ids: readonly string[],
    metric: string,
    now: Date,
  ): Promise<Map<string, AgeReading>>
  /** A project's subjects, newest first — pickers and the dashboard. */
  list(
    reader: Reader,
    ownerId: string,
    query: { projectId: string | null; limit: number },
  ): Promise<SubjectSummary[]>
}

/** What a money line is. Signs are the owner's: a refund or a fee is negative. */
export type MoneyKind = 'sales' | 'refunds' | 'fees' | 'earnings' | 'paid'

export type MoneyLine = {
  module: ModuleId
  projectId: string | null
  kind: MoneyKind
  currency: string
  /** A signed decimal string. */
  amount: string
  at: Date
}

export type MoneySource = {
  module: ModuleId
  /** Every line in `[from, to)`, one project's or all of the owner's. */
  lines(
    reader: Reader,
    ownerId: string,
    query: { from: Date; to: Date; projectId: string | null },
  ): Promise<MoneyLine[]>
}

const subjects = new Map<SubjectType, SubjectProvider>()
const money = new Map<ModuleId, MoneySource>()

export function registerSubject(provider: SubjectProvider): void {
  subjects.set(provider.type, provider)
}

export function subjectProvider(type: string): SubjectProvider | null {
  return subjects.get(type as SubjectType) ?? null
}

export function subjectProviders(): SubjectProvider[] {
  return [...subjects.values()]
}

export function registerMoneySource(source: MoneySource): void {
  money.set(source.module, source)
}

export function moneySources(): MoneySource[] {
  return [...money.values()]
}

const HOUR = 3_600_000

/**
 * The comparable reading at an age from a subject's lifetime readings
 * (`asOf`, value), current ones only. Shared by every provider so they judge
 * age the same way.
 */
export function pickAtAge(
  readings: readonly { asOf: Date; value: string; currency?: string | null }[],
  wentOutAt: Date | null,
  ageHours: number,
  now: Date,
): AgeReading {
  if (!wentOutAt) return { state: 'not_out' }
  const target = wentOutAt.getTime() + ageHours * HOUR
  if (target > now.getTime())
    return { state: 'too_young', readyAt: new Date(target) }
  const earliest = wentOutAt.getTime() + ageHours * HOUR * 0.75
  const near = readings
    .filter(
      (reading) =>
        reading.asOf.getTime() <= target && reading.asOf.getTime() >= earliest,
    )
    .sort((a, b) => b.asOf.getTime() - a.asOf.getTime())[0]
  if (!near) return { state: 'not_read' }
  return {
    state: 'known',
    value: near.value,
    asOf: near.asOf,
    currency: near.currency ?? null,
  }
}

/** For tests: forget every registered provider. */
export function resetReadingProviders(): void {
  subjects.clear()
  money.clear()
}
