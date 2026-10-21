import 'server-only'
import { routineSummaries } from '@theiceji/hq-agents/routines'
import { assetSummaries } from '@theiceji/hq-assets/assets'
import { boardSummaries } from '@theiceji/hq-board/board'
import { listEvents } from '@theiceji/hq-calendar/events'
import { formatMoney, sumAmounts } from '@theiceji/hq-core/money'
import { listProjects } from '@theiceji/hq-core/projects'
import { getDb } from '@theiceji/hq-db'
import type { UserRole } from '@theiceji/hq-db/enums'
import {
  boardCards,
  boardLanes,
  marketMarketplaces,
  publishAccounts,
  refs,
} from '@theiceji/hq-db/schema'
import { experimentSummaries } from '@theiceji/hq-experiments/experiments'
import { marketSummaries } from '@theiceji/hq-market/sales'
import { type Actor, userActor } from '@theiceji/hq-ops/access'
import { DEFAULT_TIME_ZONE, zonedDay } from '@theiceji/hq-ops/time'
import { promptSummaries } from '@theiceji/hq-prompts/prompts'
import { publishSummaries } from '@theiceji/hq-publish/publish'
import { quoteSummaries } from '@theiceji/hq-quotes/quotes'
import { moneyReadings } from '@theiceji/hq-readings/readings'
import { storySummaries } from '@theiceji/hq-story/story'
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { cache } from 'react'
import type { InboxEntry } from '@/components/Inbox'
import type { ModuleCell, ModuleId } from '@/modules'
import { loadInboxEntries } from './inbox'
import { listNotes } from './notes/store'

/**
 * One number and one state per project × module — the
 * Space moons, the State matrix, the rail counts and the project map's node
 * numbers all read these, so they agree.
 *
 * Every module's summary is read once per request, in one batch
 * (`loadModuleReads`, React `cache`): a `cell(project)` call per module per
 * project would be N × M round trips on every page. The layout and the page
 * of one request share the batch.
 *
 * A module whose data can't be read shows `—` and "not read back", never a
 * guess; one failing module never blanks the others. Something waiting for
 * you on a module lights its cell `wait`, whatever the module's own number
 * says.
 */

export type Money = { currency: string; amount: string; label: string }

/** Sums amounts per currency, never converting; zero lines drop out. */
export function money(
  amounts: { currency: string; amount: string }[],
): Money[] {
  const byCurrency = new Map<string, string[]>()
  for (const entry of amounts)
    byCurrency.set(entry.currency, [
      ...(byCurrency.get(entry.currency) ?? []),
      entry.amount,
    ])
  return [...byCurrency.entries()]
    .map(([currency, list]) => {
      const amount = sumAmounts(list, currency)
      return { currency, amount, label: formatMoney(amount, currency) }
    })
    .filter((entry) => entry.amount !== '0' && !/^0(\.0+)?$/.test(entry.amount))
}

export const safe = async <T>(work: Promise<T>): Promise<T | null> => {
  try {
    return await work
  } catch (error) {
    console.error('[cells]', error)
    return null
  }
}

async function readAll(actor: Actor) {
  const timezone = DEFAULT_TIME_ZONE
  const today = zonedDay(new Date(), timezone)
  const [
    entries,
    boards,
    quotes,
    prompts,
    assets,
    events,
    posts,
    market,
    experiments,
    stories,
    money,
    routines,
  ] = await Promise.all([
    safe(loadInboxEntries(actor)),
    safe(boardSummaries(actor)),
    safe(quoteSummaries(actor)),
    safe(promptSummaries(actor)),
    safe(assetSummaries(actor)),
    safe(listEvents(actor, { from: today, to: today, timezone, limit: 200 })),
    safe(publishSummaries(actor)),
    safe(marketSummaries(actor)),
    safe(experimentSummaries(actor)),
    safe(storySummaries(actor)),
    // Home's 8-week spark rides the same pass over the money sources.
    safe(moneyReadings(actor, { days: 7, weeks: 8 })),
    safe(routineSummaries(actor)),
  ])
  // Connection problems (the Inbox's HQ-wide `problem` entries) land on the
  // cells that depend on them (the `offline` state).
  const problems = (entries ?? []).filter((entry) => entry.kind === 'problem')
  const broken = problems
    .filter((entry) => entry.id.startsWith('provider-'))
    .map((entry) => entry.id.slice('provider-'.length))
  const brokenUses = broken.length
    ? await safe(connectionUses(actor.userId, broken))
    : []
  return {
    timezone,
    today,
    entries,
    /** Google needs signing in again: every Calendar cell says so. */
    googleProblem: problems.some((entry) => entry.id.startsWith('google-')),
    /** `projectId:module` pairs whose account or shop uses a broken connection. */
    brokenConnections: new Set(
      (brokenUses ?? []).map((use) => `${use.projectId}:${use.module}`),
    ),
    boards,
    quotes,
    prompts,
    assets,
    events,
    posts,
    market,
    experiments,
    stories,
    sevenDays: money?.since ?? null,
    /** Net per week for the last eight weeks, oldest first (Home's spark). */
    weekly: money?.weekly ?? null,
    routines,
  }
}

/** Which projects' publish accounts and shops use these provider connections. */
async function connectionUses(ownerId: string, connectionIds: string[]) {
  const db = getDb()
  if (!db) return []
  const [accounts, shops] = await Promise.all([
    db
      .selectDistinct({ projectId: publishAccounts.projectId })
      .from(publishAccounts)
      .where(
        and(
          eq(publishAccounts.ownerId, ownerId),
          inArray(publishAccounts.connectionId, connectionIds),
          isNull(publishAccounts.archivedAt),
        ),
      ),
    db
      .selectDistinct({ projectId: marketMarketplaces.projectId })
      .from(marketMarketplaces)
      .where(
        and(
          eq(marketMarketplaces.ownerId, ownerId),
          inArray(marketMarketplaces.connectionId, connectionIds),
          isNull(marketMarketplaces.archivedAt),
        ),
      ),
  ])
  return [
    ...accounts.map((row) => ({ ...row, module: 'publish' as const })),
    ...shops.map((row) => ({ ...row, module: 'market' as const })),
  ]
}

export type ModuleReads = Awaited<ReturnType<typeof readAll>>

// Keyed by primitives, so the layout and the page of one request share it.
const readsFor = cache((userId: string, role: UserRole) =>
  readAll(userActor({ id: userId, role })),
)

/** Every module's summary for the signed-in owner, once per request. */
export function loadModuleReads(actor: Actor): Promise<ModuleReads> {
  return readsFor(actor.userId, actor.role)
}

const coveredFor = cache(async (userId: string): Promise<Set<string>> => {
  const db = getDb()
  if (!db) return new Set()
  const rows = await db
    .select({ quoteId: refs.toId })
    .from(refs)
    .innerJoin(boardCards, eq(boardCards.id, refs.fromId))
    .innerJoin(boardLanes, eq(boardLanes.id, boardCards.laneId))
    .where(
      and(
        eq(refs.ownerId, userId),
        eq(refs.role, 'quoted_by'),
        eq(refs.fromType, 'card'),
        eq(refs.toType, 'quote'),
        eq(boardCards.ownerId, userId),
        // A card in the Trash covers nothing: its quote's money counts again.
        isNull(boardCards.deletedAt),
        or(
          inArray(boardLanes.role, ['awaiting_payment', 'done']),
          isNotNull(boardCards.paidAt),
          // Money already came in on the card (a deposit, a part): the card
          // holds the job's money now.
          sql`${boardCards.paidTotal} > 0`,
        ),
      ),
    )
  return new Set(rows.map((row) => row.quoteId))
})

/**
 * Sent quotes already covered by their card (`card —quoted_by→ quote`): the
 * card is awaiting payment, done or paid — or money already came in on it —
 * so the card is what is owed and the quote adds nothing. Home, State and Time count
 * pending money with this one rule, read once per request.
 */
export function coveredQuotes(actor: Actor): Promise<Set<string>> {
  return coveredFor(actor.userId)
}

const projectsFor = cache((userId: string, role: UserRole) =>
  listProjects(userActor({ id: userId, role })),
)

/**
 * The owner's live projects, once per request: the layout's rail and the
 * page under it, and Home with State inside it, ask for the same rows.
 */
export function loadProjects(actor: Actor) {
  return projectsFor(actor.userId, actor.role)
}

const activeNotesFor = cache((userId: string) =>
  listNotes(userId, { view: 'active' }),
)

/** The active notes, once per request — Space parks them, State lists them. */
export function activeNotes(actor: Actor) {
  return activeNotesFor(actor.userId)
}

/** Modules that draw a cell: all of them. */
export const CELLED: readonly ModuleId[] = [
  'board',
  'prompts',
  'assets',
  'story',
  'calendar',
  'quotes',
  'publish',
  'market',
  'experiments',
  'readings',
  'agents',
]

type CellProject = { id: string; slug: string; timezone?: string }

const UNKNOWN: ModuleCell = {
  value: '—',
  state: 'unknown',
  sub: 'not read back',
}

/** A module's own reading for one project, before anything waiting is laid over it. */
function ownCell(
  reads: ModuleReads,
  project: CellProject,
  id: ModuleId,
): ModuleCell | null {
  switch (id) {
    case 'board': {
      if (!reads.boards) return UNKNOWN
      const row = reads.boards.find((entry) => entry.projectId === project.id)
      const due = (row?.dueToday ?? 0) + (row?.overdue ?? 0)
      const awaiting = money(
        row?.awaiting.map((entry) => ({
          currency: entry.currency,
          amount: entry.sum,
        })) ?? [],
      )
      return {
        value: row?.cards ?? 0,
        unit: row?.cards === 1 ? 'card' : 'cards',
        sub: due
          ? `${due} due`
          : awaiting.length
            ? `${awaiting.map((entry) => entry.label).join(' + ')} awaiting`
            : undefined,
        state: due ? 'due' : '',
      }
    }
    case 'quotes': {
      if (!reads.quotes) return UNKNOWN
      const rows = reads.quotes.filter(
        (entry) => entry.projectId === project.id,
      )
      const open = rows.reduce((n, entry) => n + entry.open, 0)
      const drafts = rows.reduce((n, entry) => n + entry.drafts, 0)
      const expiring = rows.reduce((n, entry) => n + entry.expiringSoon, 0)
      return {
        value: open,
        unit: 'sent',
        sub: expiring
          ? `${expiring} expiring`
          : drafts
            ? `${drafts} draft${drafts === 1 ? '' : 's'}`
            : undefined,
        state: expiring ? 'due' : '',
      }
    }
    case 'calendar': {
      if (!reads.events) return UNKNOWN
      const n = reads.events.events.filter(
        (event) => event.projectId === project.id,
      ).length
      return {
        value: n,
        unit: 'today',
        sub: n ? `${n} event${n === 1 ? '' : 's'}` : undefined,
        state: n ? 'due' : '',
      }
    }
    case 'prompts': {
      if (!reads.prompts) return UNKNOWN
      const row = reads.prompts.find((entry) => entry.projectId === project.id)
      return {
        value: row?.prompts ?? 0,
        unit: row?.prompts === 1 ? 'prompt' : 'prompts',
        sub: row?.newThisWeek ? `${row.newThisWeek} new` : undefined,
        state: '',
      }
    }
    case 'assets': {
      if (!reads.assets) return UNKNOWN
      const row = reads.assets.find((entry) => entry.projectId === project.id)
      return {
        value: row?.ready ?? 0,
        unit: row?.ready === 1 ? 'asset' : 'assets',
        sub: row?.pending ? `${row.pending} uploading` : undefined,
        state: '',
      }
    }
    case 'story': {
      if (!reads.stories) return UNKNOWN
      const row = reads.stories.find((entry) => entry.projectId === project.id)
      return {
        value: `${row?.generated ?? 0} / ${row?.shots ?? 0}`,
        unit: 'shots',
        sub: row?.waiting
          ? `${row.waiting} waiting for a file`
          : row?.shots
            ? undefined
            : 'no shots yet',
        state: row?.waiting ? 'due' : '',
      }
    }
    case 'publish': {
      if (!reads.posts) return UNKNOWN
      const row = reads.posts.find((entry) => entry.projectId === project.id)
      return {
        value: row?.posted7d ?? 0,
        unit: 'out 7d',
        sub: row?.inFlight
          ? `${row.inFlight} being read back`
          : row?.scheduled
            ? `${row.scheduled} cleared`
            : row?.planned
              ? `${row.planned} planned`
              : undefined,
        state: row?.inFlight ? 'live' : row?.dueToday ? 'due' : '',
      }
    }
    case 'market': {
      if (!reads.market) return UNKNOWN
      const row = reads.market.find((entry) => entry.projectId === project.id)
      const sold = row?.week.reduce((n, entry) => n + entry.units, 0) ?? 0
      return {
        value: row?.live ?? 0,
        unit: 'live',
        sub: sold
          ? `${sold} sold · ${row?.week.map((entry) => formatMoney(entry.net, entry.currency)).join(' + ')} 7d`
          : row?.approved
            ? `${row.approved} approved`
            : undefined,
        state: '',
      }
    }
    case 'experiments': {
      if (!reads.experiments) return UNKNOWN
      const row = reads.experiments.find(
        (entry) => entry.projectId === project.id,
      )
      return {
        value: (row?.running ?? 0) + (row?.reading ?? 0),
        unit: 'running',
        sub: row?.reading
          ? `${row.reading} to decide`
          : row?.drafts
            ? `${row.drafts} draft${row.drafts === 1 ? '' : 's'}`
            : undefined,
        state: row?.reading ? 'due' : '',
      }
    }
    case 'readings': {
      if (!reads.sevenDays) return UNKNOWN
      const books = reads.sevenDays.byProject.get(project.id) ?? []
      const nets = books.filter((book) => !/^-?0(\.0+)?$/.test(book.net))
      return {
        value: nets.length
          ? nets.map((book) => formatMoney(book.net, book.currency)).join(' + ')
          : 0,
        unit: '7d',
        sub: nets.length ? 'net, recorded' : 'nothing recorded',
        state: '',
      }
    }
    case 'agents': {
      if (!reads.routines) return UNKNOWN
      const row = reads.routines.find((entry) => entry.projectId === project.id)
      const next = row?.nextDueAt
        ? new Intl.DateTimeFormat('en-GB', {
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: project.timezone ?? reads.timezone,
          })
            .format(row.nextDueAt)
            .replace(',', '')
        : null
      return {
        value: row?.running ?? 0,
        unit: 'running',
        sub: row?.running
          ? (row.runningName ?? undefined)
          : row?.failed7d
            ? `${row.failed7d} failed in 7 days`
            : next
              ? `next ${next}`
              : row?.routines
                ? 'routines off'
                : 'no routines',
        state: row?.running ? 'live' : '',
      }
    }
    default:
      return null
  }
}

/** How many things wait for you on a project's module. */
export function waitingOn(
  entries: InboxEntry[] | null,
  slug: string,
  id: ModuleId,
): number {
  return (entries ?? []).filter(
    (entry) => entry.project?.slug === slug && entry.module === id,
  ).length
}

/**
 * A project's cell for one module: its own reading, lit `wait` when
 * something waits for you there. A broken connection the module depends on
 * reads `◆ connection` with where to fix it (the `offline` state) —
 * Google for Calendar, a provider for the accounts and shops that use it.
 * Null when the module draws no cell.
 */
export function cellOf(
  reads: ModuleReads,
  project: CellProject,
  id: ModuleId,
): ModuleCell | null {
  const cell = CELLED.includes(id) ? ownCell(reads, project, id) : null
  const n = waitingOn(reads.entries, project.slug, id)
  if (n)
    return {
      ...(cell ?? { value: n, unit: 'waiting' }),
      state: 'wait',
      sub: `${n} waiting`,
    }
  if (id === 'calendar' && reads.googleProblem)
    return {
      value: '◆',
      unit: 'connection',
      sub: 'Google · reconnect at Settings › Google',
      state: 'wait',
    }
  if (
    (id === 'publish' || id === 'market') &&
    reads.brokenConnections.has(`${project.id}:${id}`)
  )
    return {
      value: '◆',
      unit: 'connection',
      sub: 'reconnect at Settings › Connections',
      state: 'wait',
    }
  return cell
}

/** Every enabled module's cell for a project. */
export function cellsOf(
  reads: ModuleReads,
  project: CellProject & { modules: { enabled: readonly string[] } },
): Partial<Record<ModuleId, ModuleCell | null>> {
  const out: Partial<Record<ModuleId, ModuleCell | null>> = {}
  for (const id of CELLED)
    if (project.modules.enabled.includes(id))
      out[id] = cellOf(reads, project, id)
  return out
}
