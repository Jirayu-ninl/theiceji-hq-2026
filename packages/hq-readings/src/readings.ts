import { digitsOf, fromMinor, toMinor } from '@theiceji/hq-core/money'
import {
  type AgeReading,
  type MoneyKind,
  type MoneyLine,
  moneySources,
  type SubjectSummary,
  type SubjectType,
  subjectProvider,
} from '@theiceji/hq-core/readings'
import {
  opsUsageEvents,
  type ProjectRow,
  projects,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { dbNow, type Reader } from '@theiceji/hq-ops/db'
import { invalid } from '@theiceji/hq-ops/errors'
import { optionalRecordId, parseInput } from '@theiceji/hq-ops/schemas'
import {
  assertModuleOn,
  authorize,
  ownedProject,
  withReader,
} from '@theiceji/hq-ops/store'
import { and, asc, eq, gte, lt, ne, sql } from 'drizzle-orm'
import { z } from 'zod'

/**
 * Readings: the dashboard — per project and across all
 * of them — and `readings_query`. It owns no table: posts and listings are
 * read at an age through the hq-core subject registry, money through the
 * money sources each module registered, and generation cost from the ops
 * kernel's usage events.
 *
 * · **Money that happened**: sales, refunds and fees from marketplaces,
 *   earnings the platforms reported, cards the owner marked paid. Pending
 *   money (awaiting payment, sent quotes) is Home's, never here.
 * · **Per currency, never converted.** Two currencies are two lines.
 * · **The week before** is the same query one window back, so a VU meter's
 *   tick means something.
 * · **Comparable or not counted** — each post and listing is read at the
 *   same age (`too young` and `not read` are words, not zeros).
 */

export type MoneyBook = {
  currency: string
  sales: string
  refunds: string
  fees: string
  earnings: string
  paid: string
  /** Everything above, added: what reached the owner. */
  net: string
}

export type SubjectRow = SubjectSummary & {
  metric: string
  atAge: AgeReading
  toDate: AgeReading
}

export type SubjectPanel = {
  type: SubjectType
  metric: string
  ageHours: number
  rows: SubjectRow[]
}

export type ProjectLite = Pick<
  ProjectRow,
  | 'id'
  | 'slug'
  | 'name'
  | 'color'
  | 'status'
  | 'kind'
  | 'currency'
  | 'timezone'
  | 'modules'
>

export type ProjectBoard = {
  project: ProjectLite
  money: MoneyBook[]
  previous: MoneyBook[]
  cost: { currency: string; amount: string }[]
  /** Usage whose cost nobody knows — counted, never guessed. */
  costUnknown: number
  subjects: SubjectPanel[]
}

export type Dashboard = {
  from: Date
  to: Date
  days: number
  ageHours: number
  projects: ProjectBoard[]
  total: MoneyBook[]
  previousTotal: MoneyBook[]
  cost: { currency: string; amount: string }[]
  costUnknown: number
  readAt: Date
}

/** The first metric each kind of subject is compared on. */
export const PRIMARY_METRIC: Record<SubjectType, string> = {
  post: 'views',
  listing: 'sales',
}

/** The money a subject made, to date. */
const MONEY_METRIC: Record<SubjectType, string> = {
  post: 'earnings',
  listing: 'net',
}

const KINDS: readonly MoneyKind[] = [
  'sales',
  'refunds',
  'fees',
  'earnings',
  'paid',
]

function book(
  lines: { currency: string; kind: MoneyKind; amount: string }[],
): MoneyBook[] {
  const byCurrency = new Map<string, Record<MoneyKind, bigint>>()
  for (const line of lines) {
    const digits = digitsOf(line.currency)
    const entry =
      byCurrency.get(line.currency) ??
      (Object.fromEntries(KINDS.map((kind) => [kind, 0n])) as Record<
        MoneyKind,
        bigint
      >)
    entry[line.kind] += toMinor(line.amount, digits)
    byCurrency.set(line.currency, entry)
  }
  return [...byCurrency.entries()]
    .map(([currency, sums]) => {
      const digits = digitsOf(currency)
      const net = KINDS.reduce((total, kind) => total + sums[kind], 0n)
      return {
        currency,
        sales: fromMinor(sums.sales, digits),
        refunds: fromMinor(sums.refunds, digits),
        fees: fromMinor(sums.fees, digits),
        earnings: fromMinor(sums.earnings, digits),
        paid: fromMinor(sums.paid, digits),
        net: fromMinor(net, digits),
      }
    })
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

async function moneyLines(
  reader: Reader,
  ownerId: string,
  range: { from: Date; to: Date; projectId: string | null },
) {
  const all = await Promise.all(
    moneySources().map((source) =>
      source.lines(reader, ownerId, range).catch((error: unknown) => {
        console.error('[readings] money source', source.module, error)
        return []
      }),
    ),
  )
  return all.flat()
}

async function costOf(
  reader: Reader,
  ownerId: string,
  range: { from: Date; to: Date; projectId: string | null },
) {
  const rows = await reader
    .select({
      projectId: opsUsageEvents.projectId,
      currency: opsUsageEvents.currency,
      minor: sql<string>`coalesce(sum(${opsUsageEvents.costMinor}), 0)::text`,
      unknown: sql<number>`count(*) filter (where ${opsUsageEvents.costStatus} = 'unknown')::int`,
    })
    .from(opsUsageEvents)
    .where(
      and(
        eq(opsUsageEvents.ownerId, ownerId),
        range.projectId
          ? eq(opsUsageEvents.projectId, range.projectId)
          : undefined,
        eq(opsUsageEvents.kind, 'cash'),
        gte(opsUsageEvents.occurredAt, range.from),
        lt(opsUsageEvents.occurredAt, range.to),
      ),
    )
    .groupBy(opsUsageEvents.projectId, opsUsageEvents.currency)
  return rows
}

function costBook(
  rows: { currency: string | null; minor: string; unknown: number }[],
): { cost: { currency: string; amount: string }[]; unknown: number } {
  const byCurrency = new Map<string, bigint>()
  let unknown = 0
  for (const row of rows) {
    unknown += row.unknown
    if (!row.currency) continue
    byCurrency.set(
      row.currency,
      (byCurrency.get(row.currency) ?? 0n) + BigInt(row.minor),
    )
  }
  return {
    cost: [...byCurrency.entries()].map(([currency, minor]) => ({
      currency,
      amount: fromMinor(minor, digitsOf(currency)),
    })),
    unknown,
  }
}

async function panelsFor(
  reader: Reader,
  ownerId: string,
  project: ProjectLite,
  ageHours: number,
  now: Date,
  limit: number,
): Promise<SubjectPanel[]> {
  const panels: SubjectPanel[] = []
  const wanted: [SubjectType, string][] = [
    ['post', 'publish'],
    ['listing', 'market'],
  ]
  for (const [type, module] of wanted) {
    if (!project.modules.enabled.includes(module)) continue
    const provider = subjectProvider(type)
    if (!provider) continue
    const subjects = await provider.list(reader, ownerId, {
      projectId: project.id,
      limit,
    })
    const ids = subjects.map((subject) => subject.id)
    const metric = PRIMARY_METRIC[type]
    const [atAge, toDate] = await Promise.all([
      provider.atAge(reader, ownerId, ids, metric, ageHours, now),
      provider.latest(reader, ownerId, ids, MONEY_METRIC[type], now),
    ])
    panels.push({
      type,
      metric,
      ageHours,
      rows: subjects.map((subject) => ({
        ...subject,
        metric,
        atAge: atAge.get(subject.id) ?? { state: 'not_read' },
        toDate: toDate.get(subject.id) ?? { state: 'not_read' },
      })),
    })
  }
  return panels
}

const dashboardSchema = z.object({
  projectId: optionalRecordId('Project'),
  days: z.number().int().min(1).max(365).optional(),
  ageHours: z.number().int().min(1).max(8760).optional(),
  subjectsPerProject: z.number().int().min(0).max(100).optional(),
})

export type DashboardInput = z.input<typeof dashboardSchema>

/**
 * The dashboard: one project's (with Readings on) or every live project's
 * money over the last `days`, the window before it, generation cost, and
 * posts and listings read at `ageHours`.
 */
export async function dashboard(
  actor: Actor,
  raw: DashboardInput = {},
): Promise<Dashboard> {
  const input = parseInput(dashboardSchema, raw)
  const days = input.days ?? 7
  const ageHours = input.ageHours ?? 72
  return withReader(async (db) => {
    let scope: ProjectLite[]
    if (input.projectId) {
      const project = await ownedProject(
        db,
        actor,
        input.projectId,
        'readings',
        'read',
      )
      assertModuleOn(project, 'readings')
      scope = [project]
    } else {
      await authorize(db, actor, null, 'readings', 'read')
      scope = await db
        .select({
          id: projects.id,
          slug: projects.slug,
          name: projects.name,
          color: projects.color,
          status: projects.status,
          kind: projects.kind,
          currency: projects.currency,
          timezone: projects.timezone,
          modules: projects.modules,
        })
        .from(projects)
        .where(
          and(
            eq(projects.ownerId, actor.userId),
            ne(projects.status, 'archived'),
          ),
        )
        .orderBy(asc(projects.position))
    }
    const now = await dbNow(db)
    const to = now
    const from = new Date(now.getTime() - days * 86_400_000)
    const before = new Date(from.getTime() - days * 86_400_000)
    const projectId = input.projectId ?? null
    const [lines, previousLines, costs] = await Promise.all([
      moneyLines(db, actor.userId, { from, to, projectId }),
      moneyLines(db, actor.userId, { from: before, to: from, projectId }),
      costOf(db, actor.userId, { from, to, projectId }),
    ])
    const ids = new Set(scope.map((project) => project.id))
    const boards: ProjectBoard[] = []
    for (const project of scope) {
      const mine = costBook(costs.filter((row) => row.projectId === project.id))
      boards.push({
        project,
        money: book(lines.filter((line) => line.projectId === project.id)),
        previous: book(
          previousLines.filter((line) => line.projectId === project.id),
        ),
        cost: mine.cost,
        costUnknown: mine.unknown,
        subjects:
          input.subjectsPerProject === 0
            ? []
            : await panelsFor(
                db,
                actor.userId,
                project,
                ageHours,
                now,
                input.subjectsPerProject ?? (input.projectId ? 40 : 8),
              ),
      })
    }
    const inScope = <T extends { projectId: string | null }>(rows: T[]) =>
      rows.filter((row) => row.projectId === null || ids.has(row.projectId))
    const all = costBook(inScope(costs))
    return {
      from,
      to,
      days,
      ageHours,
      projects: boards,
      total: book(inScope(lines)),
      previousTotal: book(inScope(previousLines)),
      cost: all.cost,
      costUnknown: all.unknown,
      readAt: now,
    }
  })
}

const querySchema = z.object({
  subjectType: z.enum(['post', 'listing'], {
    error: 'Ask about posts or listings.',
  }),
  ids: z.array(z.uuid()).max(100).optional(),
  projectId: optionalRecordId('Project'),
  metrics: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z][a-z0-9_]{0,39}$/),
    )
    .min(1, 'Name at least one metric.')
    .max(8),
  /** Read each subject this many hours after it went out; to date when absent. */
  ageHours: z.number().int().min(1).max(8760).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export type ReadingsQueryInput = z.input<typeof querySchema>

export type QueryRow = SubjectSummary & {
  readings: Record<string, AgeReading>
}

/**
 * `readings_query`: posts or listings — named, or a project's newest — with
 * each metric at an age (or to date), in words where there is no number.
 */
export async function readingsQuery(
  actor: Actor,
  raw: ReadingsQueryInput,
): Promise<{ ageHours: number | null; readAt: Date; rows: QueryRow[] }> {
  const input = parseInput(querySchema, raw)
  if (!input.ids?.length && !input.projectId)
    throw invalid('Name the items (ids) or a project to read.')
  return withReader(async (db) => {
    if (input.projectId) {
      const project = await ownedProject(
        db,
        actor,
        input.projectId,
        'readings',
        'read',
      )
      assertModuleOn(project, 'readings')
    } else await authorize(db, actor, null, 'readings', 'read')
    const provider = subjectProvider(input.subjectType)
    if (!provider)
      throw invalid(
        `${input.subjectType === 'post' ? 'Publish' : 'Market'} isn’t running here.`,
      )
    const now = await dbNow(db)
    const subjects = input.ids?.length
      ? await provider.describe(db, actor.userId, input.ids)
      : await provider.list(db, actor.userId, {
          projectId: input.projectId ?? null,
          limit: input.limit ?? 20,
        })
    const ids = subjects.map((subject) => subject.id)
    const byMetric = await Promise.all(
      input.metrics.map((metric) =>
        input.ageHours
          ? provider.atAge(db, actor.userId, ids, metric, input.ageHours, now)
          : provider.latest(db, actor.userId, ids, metric, now),
      ),
    )
    return {
      ageHours: input.ageHours ?? null,
      readAt: now,
      rows: subjects.map((subject) => ({
        ...subject,
        readings: Object.fromEntries(
          input.metrics.map((metric, i) => [
            metric,
            byMetric[i]?.get(subject.id) ?? { state: 'not_read' as const },
          ]),
        ),
      })),
    }
  })
}

/** Books per project, for the lines that name one. */
function booksByProject(lines: MoneyLine[]): Map<string, MoneyBook[]> {
  const byProject = new Map<string, MoneyBook[]>()
  for (const id of new Set(
    lines.map((line) => line.projectId).filter(Boolean) as string[],
  ))
    byProject.set(id, book(lines.filter((line) => line.projectId === id)))
  return byProject
}

const DAY_MS = 86_400_000

/** Lines in `[from, to)`: every source filters by instant alone, so a window is a slice of a wider read. */
const within = (lines: MoneyLine[], from: Date, to: Date) =>
  lines.filter(
    (line) =>
      line.at.getTime() >= from.getTime() && line.at.getTime() < to.getTime(),
  )

export type MoneySince = {
  byProject: Map<string, MoneyBook[]>
  previousByProject: Map<string, MoneyBook[]>
  total: MoneyBook[]
  previousTotal: MoneyBook[]
}

export type WeeklyNet = { from: Date; to: Date; book: MoneyBook[] }[]

function sinceOf(lines: MoneyLine[], now: Date, days: number): MoneySince {
  const from = new Date(now.getTime() - days * DAY_MS)
  const before = new Date(from.getTime() - days * DAY_MS)
  const current = within(lines, from, now)
  const previous = within(lines, before, from)
  return {
    byProject: booksByProject(current),
    previousByProject: booksByProject(previous),
    total: book(current),
    previousTotal: book(previous),
  }
}

function weeklyOf(lines: MoneyLine[], now: Date, weeks: number): WeeklyNet {
  return Array.from({ length: weeks }, (_, i) => {
    const to = new Date(now.getTime() - (weeks - 1 - i) * 7 * DAY_MS)
    const from = new Date(to.getTime() - 7 * DAY_MS)
    return { from, to, book: book(within(lines, from, to)) }
  })
}

/** Every money line of the last `days`, read once, with the clock it was read by. */
async function recentLines(db: Reader, actor: Actor, days: number) {
  await authorize(db, actor, null, 'readings', 'read')
  const now = await dbNow(db)
  const lines = await moneyLines(db, actor.userId, {
    from: new Date(now.getTime() - days * DAY_MS),
    to: now,
    projectId: null,
  })
  return { now, lines }
}

/**
 * Money over the last `days` per project, and the window before it — Home's
 * money strip and cells, State's mixer and Time's rack. Both windows come
 * from one read of each source.
 */
export async function moneySince(
  actor: Actor,
  days: number,
): Promise<MoneySince> {
  return withReader(async (db) => {
    const { now, lines } = await recentLines(db, actor, days * 2)
    return sinceOf(lines, now, days)
  })
}

/**
 * `moneySince(days)` and `weeklyNet(weeks)` from one read of each money
 * source, for a page that shows both (Home reads them in the same render).
 */
export async function moneyReadings(
  actor: Actor,
  options: { days: number; weeks: number },
): Promise<{ since: MoneySince; weekly: WeeklyNet }> {
  return withReader(async (db) => {
    const { now, lines } = await recentLines(
      db,
      actor,
      Math.max(options.days * 2, options.weeks * 7),
    )
    return {
      since: sinceOf(lines, now, options.days),
      weekly: weeklyOf(lines, now, options.weeks),
    }
  })
}

/**
 * Generation cost over the last `days` per project — State's mixer. The
 * dashboard's cost column without the money and subjects around it.
 */
export async function costSince(
  actor: Actor,
  days: number,
): Promise<
  Map<string, { cost: { currency: string; amount: string }[]; unknown: number }>
> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'readings', 'read')
    const now = await dbNow(db)
    const from = new Date(now.getTime() - days * 86_400_000)
    const rows = await costOf(db, actor.userId, {
      from,
      to: now,
      projectId: null,
    })
    const byProject = new Map<
      string,
      { cost: { currency: string; amount: string }[]; unknown: number }
    >()
    for (const id of new Set(
      rows.map((row) => row.projectId).filter(Boolean) as string[],
    ))
      byProject.set(id, costBook(rows.filter((row) => row.projectId === id)))
    return byProject
  })
}

/**
 * Net money per week for the last `weeks` weeks, oldest first — Home's
 * spark. One read of every money source over the whole span, bucketed by
 * the week each line happened in (7-day windows ending now).
 */
export async function weeklyNet(actor: Actor, weeks = 8): Promise<WeeklyNet> {
  return withReader(async (db) => {
    const { now, lines } = await recentLines(db, actor, weeks * 7)
    return weeklyOf(lines, now, weeks)
  })
}
