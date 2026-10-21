import 'server-only'
import { listCards } from '@theiceji/hq-board/board'
import { owedOf } from '@theiceji/hq-board/payments'
import { weekRange } from '@theiceji/hq-calendar/dates'
import { KIND_LABEL, MODULES, PROJECT_MODULES } from '@theiceji/hq-core/modules'
import { formatMoney } from '@theiceji/hq-core/money'
import { getDb } from '@theiceji/hq-db'
import {
  opsAgentRuns,
  opsTasks,
  projects as projectsTable,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { listPosts } from '@theiceji/hq-publish/publish'
import { listQuotes } from '@theiceji/hq-quotes/quotes'
import type { MoneyBook } from '@theiceji/hq-readings/readings'
import { and, desc, eq } from 'drizzle-orm'
import type { InboxEntry } from '@/components/Inbox'
import type { ModuleCell, ModuleId } from '@/modules'
import {
  activeNotes,
  cellOf,
  coveredQuotes,
  loadModuleReads,
  loadProjects,
  type Money,
  money,
  safe,
} from './cells'
import { fallbackTitle, STALE_DAYS } from './notes/types'

/**
 * What Home reads: every project with one cell per module it has on — the
 * moons and the ring it sits on — the queue for the dock, and the widgets'
 * data: pending money (the awaiting-payment lanes plus sent quotes), today
 * (events and cards due) and the parked notes.
 *
 * A module whose data can't be read shows `—` and "not read back" rather than
 * a guess; one failing module never blanks the page.
 *
 * Money is counted once. A sent quote whose card already sits in Awaiting
 * payment (or is done, or paid) is the same money as that card, so the card
 * counts and the quote doesn't.
 */

export type HomeModule = {
  id: ModuleId
  label: string
  /** Fixed slot on the reticle: the module's place in drawing order. */
  slot: number
  href: string
  /** Null when the module's pages aren't built yet (it draws as a tick). */
  cell: ModuleCell | null
}

export type { Money }

export type HomeProject = {
  id: string
  slug: string
  name: string
  kind: string
  kindLabel: string
  status: 'active' | 'paused' | 'archived'
  color: string
  /** Nothing recorded in any module yet. */
  fresh: boolean
  modules: HomeModule[]
  waiting: number
  /** Awaiting payment plus sent quotes, per currency. */
  pending: Money[]
}

export type TodayItem = {
  id: string
  kind: 'event' | 'card'
  label: string
  /** `09:30`, `all day`, `due`, `overdue`. */
  at: string
  sortKey: string
  projectId: string | null
  href: string
}

export type HomeData = {
  projects: HomeProject[]
  entries: InboxEntry[]
  timezone: string
  today: string
  /** `W39` and `Mon 21 – Sun 27 Sep`, for the orbit's clock. */
  week: { label: string; range: string }
  slots: number
  money: {
    total: Money[]
    awaiting: Money[]
    quoted: Money[]
    awaitingCards: number
    sentQuotes: number
    known: boolean
  }
  todayItems: TodayItem[] | null
  awaitingCards:
    | {
        id: string
        title: string
        price: string
        projectId: string | null
        href: string
      }[]
    | null
  sentQuotes:
    | {
        id: string
        covered: boolean
        number: string
        total: string
        validUntil: string | null
        projectId: string | null
        href: string
      }[]
    | null
  /** Every sent quote's total, covered or not — the Quotes widget's own figure. */
  sentTotal: Money[]
  notes: {
    parked: number
    stale: number
    top: { id: string; title: string; updatedAt: string }[]
  } | null
  /**
   * Money that happened in the last 7 days (Readings): per currency, the
   * week before for comparison, a spark of net per week, and payouts the
   * owner hasn't confirmed. Null when it couldn't be read.
   */
  earned: {
    books: MoneyBook[]
    previous: MoneyBook[]
    /** Net per week, oldest first, in `sparkCurrency`. */
    spark: number[]
    sparkCurrency: string | null
    expected: Money[]
    expectedCount: number
  } | null
  /** Runs working right now (a worker's job, an agent's task). */
  agents:
    | {
        id: string
        title: string
        projectId: string | null
        startedAt: string
        leaseExpiresAt: string | null
      }[]
    | null
  /** Cleared posts, next first. */
  nextPosts:
    | {
        id: string
        title: string
        projectId: string
        at: string | null
        platform: string
        href: string
      }[]
    | null
  /** Marketplace sales this week, per project and currency. */
  marketWeek:
    | {
        projectId: string
        units: number
        net: Money
      }[]
    | null
  /** Widget ids whose module some project has on (Notes always). */
  catalog: string[]
}

/** ISO week of a `YYYY-MM-DD` day, and its Monday–Sunday range in words. */
function weekOf(
  day: string,
  timeZone: string,
): { label: string; range: string } {
  const date = new Date(`${day}T00:00:00Z`)
  const thursday = new Date(date)
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7))
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1))
  const week = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  )
  const span = weekRange(day, timeZone)
  const words = (d: string, month: boolean) =>
    new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      ...(month ? { month: 'short' } : {}),
      timeZone: 'UTC',
    })
      .format(new Date(`${d}T00:00:00Z`))
      .replace(',', '')
  return {
    label: `W${week}`,
    range: `${words(span.from, false)} – ${words(span.to, true)}`,
  }
}

const cardHref = (card: { id: string; project: { slug: string } | null }) =>
  card.project
    ? `/p/${card.project.slug}/board?card=${card.id}`
    : `/board?card=${card.id}`

export async function loadHome(actor: Actor): Promise<HomeData> {
  const [reads, projects, cards, sent, notes, covered, running, cleared] =
    await Promise.all([
      loadModuleReads(actor),
      loadProjects(actor),
      safe(listCards(actor, {})),
      safe(listQuotes(actor, { status: 'sent', limit: 200 })),
      safe(activeNotes(actor)),
      safe(coveredQuotes(actor)),
      safe(runningRuns(actor)),
      safe(listPosts(actor, { status: ['scheduled'], limit: 20 })),
    ])
  const {
    timezone,
    today,
    entries,
    boards,
    events,
    market,
    sevenDays,
    weekly: weeks,
  } = reads
  // What sent quotes still add to the money, once their cards are counted.
  const openQuotes =
    sent && covered ? sent.filter((quote) => !covered.has(quote.id)) : null
  const quotedOf = (projectId: string | null | undefined) =>
    (openQuotes ?? [])
      .filter(
        (quote) => projectId === undefined || quote.projectId === projectId,
      )
      .map((quote) => ({
        currency: quote.currency,
        amount: quote.totals.total,
      }))
  const live = projects.filter((project) => project.status !== 'archived')

  const waitingBy = new Map<string, number>()
  for (const entry of entries ?? [])
    if (entry.project)
      waitingBy.set(
        entry.project.slug,
        (waitingBy.get(entry.project.slug) ?? 0) + 1,
      )

  const pendingOf = (projectId: string) =>
    money([
      ...(boards
        ?.find((entry) => entry.projectId === projectId)
        ?.awaiting.map((entry) => ({
          currency: entry.currency,
          amount: entry.sum,
        })) ?? []),
      ...quotedOf(projectId),
    ])

  const homeProjects: HomeProject[] = live.map((project) => {
    const modules = PROJECT_MODULES.flatMap((id, slot) =>
      project.modules.enabled.includes(id)
        ? [
            {
              id,
              label: MODULES[id].label,
              slot,
              href: `/p/${project.slug}/${id}`,
              cell: cellOf(reads, project, id),
            },
          ]
        : [],
    )
    const recorded = modules.some(
      (entry) =>
        entry.cell &&
        typeof entry.cell.value === 'number' &&
        entry.cell.value > 0,
    )
    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      kind: project.kind,
      kindLabel: KIND_LABEL[project.kind],
      status: project.status,
      color: project.color,
      fresh:
        !recorded &&
        modules.every((entry) => entry.cell?.state !== 'unknown') &&
        !waitingBy.get(project.slug),
      modules,
      waiting: waitingBy.get(project.slug) ?? 0,
      pending: pendingOf(project.id),
    }
  })

  const awaitingAll = (boards ?? []).flatMap((entry) =>
    entry.awaiting.map((row) => ({ currency: row.currency, amount: row.sum })),
  )
  const quotedAll = quotedOf(undefined)

  const todayItems: TodayItem[] | null =
    events || cards
      ? [
          ...(events?.events ?? []).map((event) => {
            const at = event.allDay
              ? 'all day'
              : new Intl.DateTimeFormat('en-GB', {
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: timezone,
                }).format(event.startsAt)
            return {
              id: `event-${event.id}`,
              kind: 'event' as const,
              label: event.title,
              at,
              sortKey: event.allDay ? '00:00' : at,
              projectId: event.projectId,
              href: event.project
                ? `/p/${event.project.slug}/calendar?event=${event.id}`
                : `/calendar?event=${event.id}`,
            }
          }),
          ...(cards ?? [])
            .filter(
              (card) =>
                card.dueOn && card.dueOn <= today && card.laneRole !== 'done',
            )
            .map((card) => ({
              id: `card-${card.id}`,
              kind: 'card' as const,
              label: card.title,
              at: card.dueOn === today ? 'due' : 'overdue',
              sortKey: card.dueOn === today ? '99:98' : '99:99',
              projectId: card.projectId,
              href: cardHref(card),
            })),
        ].sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      : null

  const staleBefore = Date.now() - STALE_DAYS * 86_400_000
  const parked = notes?.filter((note) => !note.promotedTo) ?? null

  const catalog = [
    'money.7d',
    'money.pending',
    'today',
    'agents.running',
    'board.awaiting',
    'publish.next',
    'market.week',
    'quotes.sent',
    'notes.parked',
  ].filter((id) => {
    const module =
      id === 'money.pending' || id === 'money.7d'
        ? null
        : id === 'today'
          ? 'calendar'
          : id.split('.')[0]
    if (!module || module === 'notes') return true
    // Today also lists cards that are due, so Board alone is enough for it.
    return live.some(
      (project) =>
        project.modules.enabled.includes(module) ||
        (id === 'today' && project.modules.enabled.includes('board')),
    )
  })

  return {
    projects: homeProjects,
    entries: entries ?? [],
    timezone,
    today,
    week: weekOf(today, timezone),
    slots: PROJECT_MODULES.length,
    money: {
      total: money([...awaitingAll, ...quotedAll]),
      awaiting: money(awaitingAll),
      quoted: money(quotedAll),
      awaitingCards: (boards ?? []).reduce(
        (n, entry) => n + entry.awaiting.reduce((m, row) => m + row.cards, 0),
        0,
      ),
      sentQuotes: openQuotes?.length ?? 0,
      known: Boolean(boards && openQuotes),
    },
    todayItems,
    awaitingCards: cards
      ? cards
          .filter((card) => card.laneRole === 'awaiting_payment')
          .map((card) => ({
            id: card.id,
            title: card.title,
            // What the card still owes (total less what came in), not its price.
            price: (() => {
              const owed = owedOf(card)
              return owed && card.currency
                ? formatMoney(owed.startsWith('-') ? '0' : owed, card.currency)
                : '—'
            })(),
            projectId: card.projectId,
            href: cardHref(card),
          }))
      : null,
    sentQuotes: sent
      ? sent.map((quote) => ({
          id: quote.id,
          covered: covered?.has(quote.id) ?? false,
          number: quote.number,
          total: formatMoney(quote.totals.total, quote.currency),
          validUntil: quote.validUntil,
          projectId: quote.projectId,
          href: quote.project
            ? `/p/${quote.project.slug}/quotes?quote=${quote.id}`
            : `/quotes?quote=${quote.id}`,
        }))
      : null,
    sentTotal: money(
      (sent ?? []).map((quote) => ({
        currency: quote.currency,
        amount: quote.totals.total,
      })),
    ),
    notes: parked
      ? {
          parked: parked.length,
          stale: parked.filter(
            (note) => Date.parse(note.updatedAt) < staleBefore,
          ).length,
          top: parked.slice(0, 3).map((note) => ({
            id: note.id,
            title:
              note.title?.trim() || fallbackTitle(note.body) || 'Untitled note',
            updatedAt: note.updatedAt,
          })),
        }
      : null,
    earned: sevenDays
      ? (() => {
          const main =
            sevenDays.total.find((book) => book.currency === 'THB')?.currency ??
            sevenDays.total[0]?.currency ??
            null
          const expected = (market ?? []).flatMap((row) => row.expected)
          return {
            books: sevenDays.total,
            previous: sevenDays.previousTotal,
            spark: main
              ? (weeks ?? []).map((bucket) =>
                  Number(
                    bucket.book.find((book) => book.currency === main)?.net ??
                      0,
                  ),
                )
              : [],
            sparkCurrency: main,
            expected: money(
              expected.map((entry) => ({
                currency: entry.currency,
                amount: entry.amount,
              })),
            ),
            expectedCount: expected.reduce((n, entry) => n + entry.count, 0),
          }
        })()
      : null,
    agents: running,
    nextPosts: cleared
      ? cleared
          .sort(
            (a, b) =>
              (a.scheduledFor?.getTime() ?? Number.MAX_SAFE_INTEGER) -
              (b.scheduledFor?.getTime() ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(0, 6)
          .map((post) => ({
            id: post.id,
            title:
              post.title ??
              post.caption.split('\n')[0]?.slice(0, 80) ??
              'Untitled post',
            projectId: post.projectId,
            at: post.scheduledFor?.toISOString() ?? null,
            platform: post.account.platform,
            href: `/p/${post.project.slug}/publish?post=${post.id}`,
          }))
      : null,
    marketWeek: market
      ? market.flatMap((row) =>
          row.week.map((entry) => ({
            projectId: row.projectId,
            units: entry.units,
            net: {
              currency: entry.currency,
              amount: entry.net,
              label: formatMoney(entry.net, entry.currency),
            },
          })),
        )
      : null,
    catalog,
  }
}

/** Runs working right now, newest first (the ▶ in the footer, Home's widget). */
async function runningRuns(actor: Actor): Promise<HomeData['agents']> {
  const db = getDb()
  if (!db) return null
  const rows = await db
    .select({
      id: opsAgentRuns.id,
      title: opsTasks.title,
      projectId: opsAgentRuns.projectId,
      startedAt: opsAgentRuns.startedAt,
      leaseExpiresAt: opsAgentRuns.leaseExpiresAt,
    })
    .from(opsAgentRuns)
    .innerJoin(opsTasks, eq(opsTasks.id, opsAgentRuns.taskId))
    .leftJoin(projectsTable, eq(projectsTable.id, opsAgentRuns.projectId))
    .where(
      and(
        eq(opsAgentRuns.ownerId, actor.userId),
        eq(opsAgentRuns.status, 'running'),
      ),
    )
    .orderBy(desc(opsAgentRuns.startedAt))
    .limit(8)
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    projectId: row.projectId,
    startedAt: row.startedAt.toISOString(),
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
  }))
}
