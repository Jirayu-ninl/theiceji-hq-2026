import 'server-only'
import { listRoutines, runSummaries } from '@theiceji/hq-agents/routines'
import { cardsDueBetween, followupsDueBetween } from '@theiceji/hq-board/board'
import { listEvents } from '@theiceji/hq-calendar/events'
import {
  KIND_LABEL,
  MODULES,
  type ModuleId,
  PROJECT_MODULES,
} from '@theiceji/hq-core/modules'
import {
  digitsOf,
  formatMoney,
  fromMinor,
  sumAmounts,
} from '@theiceji/hq-core/money'
import { getDb } from '@theiceji/hq-db'
import {
  expItems,
  marketMarketplaces,
  marketPayouts,
  opsAgentRuns,
} from '@theiceji/hq-db/schema'
import { listExperiments } from '@theiceji/hq-experiments/experiments'
import { listListings } from '@theiceji/hq-market/market'
import { saleLinesBetween } from '@theiceji/hq-market/sales'
import type { Actor } from '@theiceji/hq-ops/access'
import {
  DEFAULT_TIME_ZONE,
  localToInstant,
  zonedDay,
} from '@theiceji/hq-ops/time'
import { listPosts } from '@theiceji/hq-publish/publish'
import { listQuotes } from '@theiceji/hq-quotes/quotes'
import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  type SQL,
} from 'drizzle-orm'
import {
  type ItemState,
  type MoneyColumn,
  type MoneyRack,
  mondayOf,
  onWeek,
  parseWeek,
  placeOn,
  plusDays,
  type TimeData,
  type TimeGroup,
  type TimelineItem,
  type TimeProject,
  weekOf,
} from '@/components/home/time/model'
import '@/modules/register'
import {
  coveredQuotes,
  loadModuleReads,
  loadProjects,
  type ModuleReads,
  safe,
} from './cells'
import { openProposals, openRequests, requestNow } from './per-request'

export type {
  TimeData,
  TimeGroup,
  TimelineItem,
  TimeProject,
} from '@/components/home/time/model'

/**
 * What Home · Time reads: one week of
 * dated records per project × module, the queue for the rack, and money over
 * the last 7 days.
 *
 * Like the cells, it is one batched read per module for every project —
 * never a `timeline(project, week)` call per project × module, which would
 * be N × M round trips on every load. Each module's read fails on its own:
 * its lane then reads `— not read back`, and the rest of the week draws.
 *
 * The ruler is one clock, the owner's zone: a timed record sits where it
 * happens in that zone, and a record that only has a date (a card's due day,
 * a quote's last valid day, a payout's day) sits on its day. "Now" is the
 * database's clock.
 *
 * What feeds the tracks:
 * · Board — cards due this week (● due, ✓ in a done or awaiting-payment lane).
 * · Calendar — events as blocks; one under way carries its progress.
 * · Quotes — sent, accepted or declined, and a sent quote's last valid day.
 * · Publish — posts at their time: out, cleared, not cleared, late, failed.
 * · Market — listings that went live or inactive, each sale, payouts due.
 * · Experiments — each experiment's run, the moment each item reaches its
 *   read age, and the decision once every item is readable.
 * · Agents — runs (▶ running, a tick for each finished one), each routine's
 *   next run, and the proposals that wait for you.
 * · Waiting for you — an open request sits on the record it is about when
 *   that record is on the week; otherwise it is a hatched block from when it
 *   was asked until now.
 */

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

type Project = Awaited<ReturnType<typeof loadProjects>>[number]
type Fact = [string, string]

/* ── Words, in the ruler's zone ─────────────────────────────────────── */

function words(timeZone: string) {
  const dayFmt = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    timeZone,
  })
  const hmFmt = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  })
  const dateFmt = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  const day = (date: Date) => dayFmt.format(date).replace(',', '')
  const hm = (date: Date) => hmFmt.format(date)
  return {
    hm,
    /** A `YYYY-MM-DD` day: `Fri 25`. */
    onDay: (value: string) =>
      dateFmt.format(new Date(`${value}T00:00:00Z`)).replace(',', ''),
    point: (date: Date) => `${day(date)} · ${hm(date)}`,
    span: (a: Date, b: Date) =>
      zonedDay(a, timeZone) === zonedDay(b, timeZone)
        ? `${day(a)} · ${hm(a)} – ${hm(b)}`
        : `${day(a)} ${hm(a)} → ${day(b)} ${hm(b)}`,
    since: (a: Date) => `since ${day(a)} ${hm(a)}`,
  }
}

function took(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = minutes / 60
  return hours < 48 ? `${+hours.toFixed(1)}h` : `${Math.round(hours / 24)}d`
}

const firstLine = (text: string, max = 60) => {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const factIf = (key: string, value: string | null | undefined): Fact[] =>
  value ? [[key, value]] : []

/* ── The week every builder places records on ───────────────────────── */

type Week = ReturnType<typeof weekContext>
type Span = ReturnType<typeof weekSpan>

/** The shown week as days, and as instants in a zone: `[start, end)`. */
function weekSpan(monday: string, timeZone: string) {
  // The eight local midnights, so a 23- or 25-hour day is still one column.
  const bounds = Array.from({ length: 8 }, (_, i) => {
    const day = plusDays(monday, i)
    return (
      localToInstant(`${day}T00:00`, timeZone) ?? new Date(`${day}T00:00:00Z`)
    ).getTime()
  })
  return {
    monday,
    sunday: plusDays(monday, 6),
    bounds,
    start: new Date(bounds[0] as number),
    end: new Date(bounds[7] as number),
  }
}

function weekContext(now: Date, span: Span, timeZone: string, live: Project[]) {
  const { monday, sunday, start, end, bounds } = span
  const today = zonedDay(now, timeZone)
  const place = (date: Date) => placeOn(date.getTime(), bounds)
  const byId = new Map(live.map((project) => [project.id, project]))
  const items = new Map<string, TimelineItem[]>()
  /** `card:<id>` → the items drawn for that record, so a request about it can sit on one. */
  const records = new Map<string, TimelineItem[]>()
  return {
    now,
    today,
    monday,
    sunday,
    start,
    end,
    place,
    nowAt: place(now),
    /** A day that only has a date sits at its middle. */
    dayAt: (day: string) =>
      Math.round(
        (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) /
          DAY_MS,
      ) + 0.5,
    say: words(timeZone),
    past: (date: Date) => date.getTime() <= now.getTime(),
    inWeek: (date: Date | null | undefined): date is Date =>
      Boolean(date && date >= start && date < end),
    dayInWeek: (day: string | null | undefined): day is string =>
      Boolean(day && day >= monday && day <= sunday),
    slugOf: (projectId: string) => byId.get(projectId)?.slug ?? '',
    items,
    records,
    /** Draw an item on its project's lane, if the project is live and the item is on the week. */
    put(
      projectId: string | null | undefined,
      item: TimelineItem,
      ref?: string,
    ) {
      if (!projectId || !byId.has(projectId) || !onWeek(item)) return
      const key = `${projectId}:${item.module}`
      items.set(key, [...(items.get(key) ?? []), item])
      if (ref) records.set(ref, [...(records.get(ref) ?? []), item])
    },
  }
}

/* ── Reads that have no cross-project service ───────────────────────── */

/** Payouts expected or paid on a day of the week, every project at once. */
async function payoutsBetween(actor: Actor, from: string, to: string) {
  const db = getDb()
  if (!db) return []
  return db
    .select({ payout: marketPayouts, shop: marketMarketplaces.shop })
    .from(marketPayouts)
    .innerJoin(
      marketMarketplaces,
      eq(marketMarketplaces.id, marketPayouts.marketplaceId),
    )
    .where(
      and(
        eq(marketPayouts.ownerId, actor.userId),
        or(
          and(
            gte(marketPayouts.expectedOn, from),
            lte(marketPayouts.expectedOn, to),
          ),
          and(gte(marketPayouts.paidOn, from), lte(marketPayouts.paidOn, to)),
        ),
      ),
    )
}

/** The items of the experiments still collecting or reading. */
async function experimentItems(actor: Actor, experimentIds: string[]) {
  const db = getDb()
  if (!db || experimentIds.length === 0) return []
  return db
    .select({
      experimentId: expItems.experimentId,
      variantId: expItems.variantId,
      subjectType: expItems.subjectType,
      subjectId: expItems.subjectId,
    })
    .from(expItems)
    .where(
      and(
        eq(expItems.ownerId, actor.userId),
        inArray(expItems.experimentId, experimentIds),
      ),
    )
}

/** Agent runs that touch the week, with cost and proposals (hq-agents). */
async function runsBetween(actor: Actor, start: Date, end: Date) {
  const db = getDb()
  if (!db) return null
  return runSummaries(
    db,
    actor.userId,
    and(
      lt(opsAgentRuns.startedAt, end),
      or(isNull(opsAgentRuns.endedAt), gt(opsAgentRuns.endedAt, start)),
    ) as SQL,
    400,
  )
}

/** Every read, one per module, all at once. A failed read is null. */
async function readWeek(actor: Actor, w: Span) {
  const db = getDb()
  const [
    cards,
    followups,
    events,
    quotes,
    posts,
    listings,
    sales,
    payouts,
    experiments,
    runs,
    routines,
    requests,
    proposals,
    covered,
  ] = await Promise.all([
    safe(cardsDueBetween(actor, { from: w.monday, to: w.sunday })),
    safe(followupsDueBetween(actor, { from: w.monday, to: w.sunday })),
    safe(
      listEvents(actor, {
        from: w.monday,
        to: w.sunday,
        timezone: DEFAULT_TIME_ZONE,
        limit: 2000,
      }),
    ),
    safe(listQuotes(actor, { limit: 500 })),
    safe(listPosts(actor, { limit: 500 })),
    safe(listListings(actor, { limit: 500 })),
    db
      ? safe(
          saleLinesBetween(db, actor.userId, {
            from: w.start,
            to: w.end,
            projectId: null,
          }),
        )
      : Promise.resolve(null),
    safe(payoutsBetween(actor, w.monday, w.sunday)),
    safe(listExperiments(actor, { status: ['running', 'reading', 'decided'] })),
    safe(runsBetween(actor, w.start, w.end)),
    safe(listRoutines(actor)),
    safe(openRequests(actor)),
    safe(openProposals(actor)),
    safe(coveredQuotes(actor)),
  ])
  const items = experiments
    ? await safe(
        experimentItems(
          actor,
          experiments
            .filter((entry) => entry.status !== 'decided')
            .map((entry) => entry.id),
        ),
      )
    : null
  return {
    cards,
    followups,
    events,
    quotes,
    posts,
    listings,
    sales,
    payouts,
    experiments,
    experimentItems: items,
    runs,
    routines,
    requests,
    proposals,
    covered,
  }
}

type Reads = Awaited<ReturnType<typeof readWeek>>

/* ── The loader ─────────────────────────────────────────────────────── */

export async function loadTime(
  actor: Actor,
  options: { week?: string } = {},
): Promise<TimeData> {
  // Neither waits on the week: start them while the clock is read.
  const moduleReads = loadModuleReads(actor)
  const projectRows = safe(loadProjects(actor))
  const now = await requestNow()
  const timezone = DEFAULT_TIME_ZONE
  const today = zonedDay(now, timezone)
  const monday = parseWeek(options.week) ?? mondayOf(today)
  const span = weekSpan(monday, timezone)
  const [modules, projects, reads] = await Promise.all([
    moduleReads,
    projectRows,
    readWeek(actor, span),
  ])
  const live = (projects ?? []).filter(
    (project) => project.status !== 'archived',
  )
  const w = weekContext(now, span, timezone, live)

  boardItems(w, reads)
  calendarItems(w, reads)
  quoteItems(w, reads)
  publishItems(w, reads)
  marketItems(w, reads)
  experimentTracks(w, reads)
  agentItems(w, reads)
  waitingItems(w, reads)

  const unread: Partial<Record<ModuleId, boolean>> = {
    board: reads.cards === null,
    calendar: reads.events === null,
    quotes: reads.quotes === null,
    publish: reads.posts === null,
    market: reads.listings === null || reads.sales === null,
    experiments: reads.experiments === null,
    agents: reads.runs === null || reads.routines === null,
  }
  const groups: TimeGroup[] = live.map((project) => ({
    project: projectOf(project),
    lanes: PROJECT_MODULES.flatMap((module) => {
      const mine = w.items.get(`${project.id}:${module}`) ?? []
      const unknown =
        !mine.length &&
        project.modules.enabled.includes(module) &&
        Boolean(unread[module])
      if (!mine.length && !unknown) return []
      return [
        {
          module,
          label: MODULES[module].label,
          glyph: MODULES[module].glyph,
          href: `/p/${project.slug}/${module}`,
          items: mine.sort((a, b) => a.from - b.from),
          ...(unknown ? { unknown: true } : {}),
        },
      ]
    }),
  }))

  return {
    week: weekOf(monday, today),
    timezone,
    now: {
      iso: now.toISOString(),
      today,
      at: w.nowAt >= 0 && w.nowAt < 7 ? w.nowAt : null,
    },
    groups,
    entries: modules.entries ?? [],
    money: moneyOf(live, reads, modules),
  }
}

/* ── Board: cards due this week ─────────────────────────────────────── */

function boardItems(w: Week, { cards, followups }: Reads) {
  for (const card of cards ?? []) {
    const due = card.dueOn
    if (!card.projectId || !w.dayInWeek(due)) continue
    const awaiting = card.laneRole === 'awaiting_payment'
    const done = awaiting || card.laneRole === 'done'
    w.put(
      card.projectId,
      {
        id: `card:${card.id}`,
        module: 'board',
        kind: 'mark',
        start: due,
        from: w.dayAt(due),
        state: done ? 'done' : 'due',
        word: awaiting
          ? 'done · awaiting payment'
          : done
            ? 'done'
            : due < w.today
              ? 'overdue'
              : due === w.today
                ? 'due today'
                : 'due',
        label: card.title,
        when: `${w.say.onDay(due)} · due`,
        href: `/p/${w.slugOf(card.projectId)}/board?card=${card.id}`,
        facts: [
          ['lane', card.laneName],
          ...factIf(
            'price',
            card.total && card.currency
              ? formatMoney(card.total, card.currency)
              : null,
          ),
        ],
      },
      `card:${card.id}`,
    )
  }
  // A follow-up's due is its own mark: the job goes on after
  // the card's task, and each round has its day.
  for (const followup of followups ?? []) {
    const due = followup.dueOn
    const projectId = followup.cardProjectId
    if (!projectId || !due || !w.dayInWeek(due)) continue
    w.put(
      projectId,
      {
        id: `followup:${followup.id}`,
        module: 'board',
        kind: 'mark',
        start: due,
        from: w.dayAt(due),
        state: 'due',
        word: due < w.today ? 'overdue' : due === w.today ? 'due today' : 'due',
        label: `↳ ${followup.title}`,
        when: `${w.say.onDay(due)} · due`,
        href: `/p/${w.slugOf(projectId)}/board?card=${followup.cardId}`,
        facts: [['card', followup.cardTitle]],
      },
      `followup:${followup.id}`,
    )
  }
}

/* ── Calendar: events as blocks ─────────────────────────────────────── */

function calendarItems(w: Week, { events }: Reads) {
  for (const event of events?.events ?? []) {
    if (!event.projectId) continue
    const base = {
      id: `event:${event.id}`,
      module: 'calendar' as const,
      kind: 'block' as const,
      label: event.title,
      href: `/p/${w.slugOf(event.projectId)}/calendar?event=${event.id}`,
      facts: factIf('where', event.location),
    }
    if (event.allDay && event.dates) {
      const { first, last } = event.dates
      const from = w.dayAt(first) - 0.5
      const to = w.dayAt(last) + 0.5
      const state: ItemState =
        last < w.today ? 'done' : first <= w.today ? 'doing' : 'plan'
      w.put(
        event.projectId,
        {
          ...base,
          start: first,
          end: last,
          from,
          to,
          state,
          progress:
            state === 'doing'
              ? Math.round(
                  Math.min(1, Math.max(0, (w.nowAt - from) / (to - from))) *
                    100,
                )
              : undefined,
          when:
            first === last
              ? `${w.say.onDay(first)} · all day`
              : `${w.say.onDay(first)} – ${w.say.onDay(last)} · all day`,
        },
        `event:${event.id}`,
      )
      continue
    }
    const a = event.startsAt
    const b = event.endsAt > a ? event.endsAt : a
    const state: ItemState = w.past(b) ? 'done' : w.past(a) ? 'doing' : 'plan'
    w.put(
      event.projectId,
      {
        ...base,
        label: `${event.title} · ${w.say.hm(a)}`,
        start: a.toISOString(),
        end: b.toISOString(),
        from: w.place(a),
        to: w.place(b),
        state,
        progress:
          state === 'doing'
            ? Math.round(
                ((w.now.getTime() - a.getTime()) /
                  Math.max(1, b.getTime() - a.getTime())) *
                  100,
              )
            : undefined,
        when: w.say.span(a, b),
      },
      `event:${event.id}`,
    )
  }
}

/* ── Quotes: sent, decided, the last valid day ──────────────────────── */

function quoteItems(w: Week, { quotes }: Reads) {
  for (const quote of quotes ?? []) {
    if (!quote.projectId) continue
    const total = formatMoney(quote.totals.total, quote.currency)
    const base = {
      module: 'quotes' as const,
      kind: 'mark' as const,
      href: `/p/${w.slugOf(quote.projectId)}/quotes?quote=${quote.id}`,
      facts: [
        ['client', quote.client?.name ?? '—'],
        ['total', total],
        ['status', quote.status],
      ] as Fact[],
    }
    const ref = `quote:${quote.id}`
    if (w.inWeek(quote.sentAt))
      w.put(
        quote.projectId,
        {
          ...base,
          id: `quote:${quote.id}:sent`,
          start: quote.sentAt.toISOString(),
          from: w.place(quote.sentAt),
          state: 'done',
          word: 'sent',
          label: `${quote.number} · sent · ${total}`,
          when: w.say.point(quote.sentAt),
        },
        ref,
      )
    if (
      w.inWeek(quote.decidedAt) &&
      (quote.status === 'accepted' || quote.status === 'declined')
    )
      w.put(
        quote.projectId,
        {
          ...base,
          id: `quote:${quote.id}:decided`,
          start: quote.decidedAt.toISOString(),
          from: w.place(quote.decidedAt),
          state: 'done',
          word: quote.status,
          label: `${quote.number} · ${quote.status}`,
          when: w.say.point(quote.decidedAt),
        },
        ref,
      )
    const last = quote.validUntil
    if (
      w.dayInWeek(last) &&
      (quote.status === 'sent' || quote.status === 'expired')
    )
      w.put(
        quote.projectId,
        {
          ...base,
          id: `quote:${quote.id}:expires`,
          start: last,
          from: w.dayAt(last),
          state: quote.status === 'expired' ? 'done' : 'due',
          word:
            quote.status === 'expired'
              ? 'expired'
              : last < w.today
                ? 'past its last valid day'
                : last === w.today
                  ? 'last valid day today'
                  : 'last valid day',
          label: `${quote.number} · ${total} · expires`,
          when: `${w.say.onDay(last)} · last valid day`,
        },
        ref,
      )
  }
}

/* ── Publish: posts at their time ───────────────────────────────────── */

const postTitle = (post: { title: string | null; caption: string }) =>
  post.title?.trim() || firstLine(post.caption) || 'Untitled post'

function publishItems(w: Week, { posts }: Reads) {
  for (const post of posts ?? []) {
    const at = post.postedAt ?? post.scheduledFor
    if (!w.inWeek(at) || post.status === 'removed') continue
    const late = w.past(at)
    const [state, word]: [ItemState, string] =
      post.status === 'posted'
        ? ['done', 'posted']
        : post.status === 'verified'
          ? ['done', 'posted · read back']
          : post.status === 'dispatched'
            ? ['doing', 'sent · not read back yet']
            : post.status === 'failed'
              ? [
                  'due',
                  `failed${post.statusReason ? ` · ${post.statusReason}` : ''}`,
                ]
              : post.status === 'scheduled'
                ? late
                  ? ['due', 'cleared · its time passed, not out']
                  : ['plan', 'cleared']
                : late
                  ? ['due', 'not cleared · its time passed']
                  : ['plan', 'planned · not cleared yet']
    w.put(
      post.projectId,
      {
        id: `post:${post.id}`,
        module: 'publish',
        kind: 'mark',
        start: at.toISOString(),
        from: w.place(at),
        state,
        word,
        label: `${postTitle(post)} · ${post.account.platform}`,
        when: w.say.point(at),
        href: `/p/${post.project.slug}/publish?post=${post.id}`,
        facts: [
          ['account', `${post.account.platform} · ${post.account.handle}`],
          ['status', post.status],
        ],
      },
      `post:${post.id}`,
    )
  }
}

/* ── Market: listings, sales, payouts ───────────────────────────────── */

function marketItems(w: Week, { listings, sales, payouts }: Reads) {
  const listingsById = new Map(
    (listings ?? []).map((listing) => [listing.id, listing]),
  )
  for (const listing of listings ?? []) {
    const base = {
      module: 'market' as const,
      kind: 'mark' as const,
      state: 'done' as const,
      href: `/p/${listing.project.slug}/market?listing=${listing.id}`,
      facts: [
        ['shop', `${listing.marketplace.kind} · ${listing.marketplace.shop}`],
        ['price', formatMoney(listing.price, listing.currency)],
        ['status', listing.status],
      ] as Fact[],
    }
    const ref = `listing:${listing.id}`
    if (w.inWeek(listing.listedAt))
      w.put(
        listing.projectId,
        {
          ...base,
          id: `listing:${listing.id}:listed`,
          start: listing.listedAt.toISOString(),
          from: w.place(listing.listedAt),
          word: 'listed',
          label: `${listing.title} · ${listing.marketplace.shop}`,
          when: w.say.point(listing.listedAt),
        },
        ref,
      )
    if (w.inWeek(listing.inactiveAt))
      w.put(
        listing.projectId,
        {
          ...base,
          id: `listing:${listing.id}:inactive`,
          start: listing.inactiveAt.toISOString(),
          from: w.place(listing.inactiveAt),
          word: 'made inactive',
          label: `${listing.title} · inactive`,
          when: w.say.point(listing.inactiveAt),
        },
        ref,
      )
  }
  for (const line of sales ?? []) {
    if (line.kind !== 'sale' && line.kind !== 'refund') continue
    const listing = line.listingId ? listingsById.get(line.listingId) : null
    const net = formatMoney(line.net, line.currency)
    w.put(line.projectId, {
      id: `sale:${line.id}`,
      module: 'market',
      kind: 'tick',
      start: line.occurredAt.toISOString(),
      from: w.place(line.occurredAt),
      state: 'done',
      word:
        line.kind === 'sale'
          ? `sold ${line.quantity} · ${net} net`
          : `refunded · ${net}`,
      label: `${line.kind === 'sale' ? 'order' : 'refund'} · ${listing?.title ?? 'no listing'}`,
      when: w.say.point(line.occurredAt),
      href: `/p/${w.slugOf(line.projectId)}/market?view=money`,
      facts: [
        ['gross', formatMoney(line.gross, line.currency)],
        ['fees', formatMoney(line.fees, line.currency)],
        ['net', net],
        ...factIf('order', line.orderRef),
      ],
    })
  }
  for (const { payout, shop } of payouts ?? []) {
    const confirmed = payout.status === 'confirmed' && Boolean(payout.paidOn)
    const day = confirmed ? payout.paidOn : payout.expectedOn
    if (!w.dayInWeek(day)) continue
    const amount = formatMoney(payout.amount, payout.currency)
    w.put(payout.projectId, {
      id: `payout:${payout.id}`,
      module: 'market',
      kind: 'mark',
      start: day,
      from: w.dayAt(day),
      state: confirmed ? 'done' : day < w.today ? 'due' : 'plan',
      word: confirmed
        ? 'paid out · confirmed'
        : day < w.today
          ? 'expected · not confirmed yet'
          : 'expected',
      label: `payout · ${shop} · ${amount}`,
      when: `${w.say.onDay(day)} · ${confirmed ? 'paid' : 'expected'}`,
      href: `/p/${w.slugOf(payout.projectId)}/market?view=money`,
      facts: [
        ['amount', amount],
        ['status', payout.status],
        ...factIf('reference', payout.reference),
      ],
    })
  }
}

/* ── Experiments: the run, each item's read age, the decision ───────── */

function experimentTracks(
  w: Week,
  { experiments, experimentItems: rows, posts, listings }: Reads,
) {
  const postsById = new Map((posts ?? []).map((post) => [post.id, post]))
  const listingsById = new Map(
    (listings ?? []).map((listing) => [listing.id, listing]),
  )
  for (const experiment of experiments ?? []) {
    if (!experiment.startedAt) continue
    const href = `/p/${experiment.project.slug}/experiments?experiment=${experiment.id}`
    const label = firstLine(experiment.question, 80)
    const variants = new Map(
      experiment.variants.map((variant) => [variant.id, variant.label]),
    )
    // When each item can be read: the moment it went out, plus the read age.
    const ready = (rows ?? [])
      .filter((row) => row.experimentId === experiment.id)
      .map((row) => {
        const post =
          row.subjectType === 'post' ? postsById.get(row.subjectId) : null
        const listing =
          row.subjectType === 'listing' ? listingsById.get(row.subjectId) : null
        const out = post?.postedAt ?? listing?.listedAt ?? null
        return {
          row,
          title: post ? postTitle(post) : (listing?.title ?? row.subjectType),
          at: out
            ? new Date(out.getTime() + experiment.readAtHours * HOUR_MS)
            : null,
        }
      })
    const lastReady = ready.reduce<Date | null>(
      (max, entry) => (entry.at && (!max || entry.at > max) ? entry.at : max),
      null,
    )
    const decided = experiment.status === 'decided'
    const until =
      experiment.decidedAt ??
      (lastReady && lastReady > w.now ? lastReady : w.now)
    const facts: Fact[] = [
      ['metric', experiment.metric],
      ['read at', `${experiment.readAtHours}h`],
      ['items', String(experiment.items)],
      ['status', experiment.status],
    ]
    w.put(
      experiment.projectId,
      {
        id: `experiment:${experiment.id}`,
        module: 'experiments',
        kind: 'block',
        start: experiment.startedAt.toISOString(),
        end: until.toISOString(),
        from: w.place(experiment.startedAt),
        to: w.place(until),
        state: decided ? 'done' : 'doing',
        word: decided
          ? `decided${experiment.lastDecision ? ` · ${experiment.lastDecision.verdict.replace('_', ' ')}` : ''}`
          : experiment.status === 'reading'
            ? 'reading · waits for the read age'
            : 'running · collecting items',
        label,
        when: w.say.span(experiment.startedAt, until),
        href,
        facts,
      },
      `experiment:${experiment.id}`,
    )
    if (decided) continue
    for (const entry of ready) {
      if (!w.inWeek(entry.at)) continue
      const reached = w.past(entry.at)
      w.put(experiment.projectId, {
        id: `exp-item:${entry.row.experimentId}:${entry.row.subjectId}`,
        module: 'experiments',
        kind: 'mark',
        start: entry.at.toISOString(),
        from: w.place(entry.at),
        state: reached ? 'done' : 'plan',
        word: reached
          ? `read age reached · ${experiment.readAtHours}h`
          : `reads at ${experiment.readAtHours}h`,
        label: `${variants.get(entry.row.variantId) ?? 'variant'} · ${entry.title}`,
        when: w.say.point(entry.at),
        href,
        facts: [
          ['experiment', label],
          ['read at', `${experiment.readAtHours}h after it went out`],
        ],
      })
    }
    if (
      experiment.status === 'reading' &&
      w.inWeek(lastReady) &&
      w.past(lastReady)
    )
      w.put(experiment.projectId, {
        id: `experiment:${experiment.id}:decide`,
        module: 'experiments',
        kind: 'mark',
        start: lastReady.toISOString(),
        from: w.place(lastReady),
        state: 'due',
        word: 'every item readable · decide',
        label: `${label} · decide`,
        when: w.say.point(lastReady),
        href,
        facts,
      })
  }
}

/* ── Agents: runs, next runs, proposals ─────────────────────────────── */

function agentItems(w: Week, { runs, routines, proposals }: Reads) {
  const routineById = new Map(
    (routines ?? []).map((routine) => [routine.id, routine]),
  )
  for (const run of runs ?? []) {
    if (!run.projectId) continue
    const routine = run.routineId ? routineById.get(run.routineId) : null
    const slug = w.slugOf(run.projectId)
    const href = routine
      ? `/p/${slug}/agents?routine=${routine.id}`
      : `/p/${slug}/agents?view=runs`
    const cost = run.cost.map((line) =>
      formatMoney(
        fromMinor(BigInt(line.minor), digitsOf(line.currency)),
        line.currency,
      ),
    )
    const facts: Fact[] = [
      ['routine', routine?.name ?? 'an agent, on its own'],
      [
        'took',
        run.endedAt
          ? took(run.endedAt.getTime() - run.startedAt.getTime())
          : `${took(w.now.getTime() - run.startedAt.getTime())} so far`,
      ],
      [
        'cost',
        cost.length
          ? `${cost.join(' + ')}${run.unknownCosts ? ` + ${run.unknownCosts} not known` : ''}`
          : run.unknownCosts
            ? 'not known'
            : '—',
      ],
      ['proposals', String(run.proposals)],
      ...factIf('summary', run.summary ? firstLine(run.summary, 120) : null),
    ]
    const label = routine?.name ?? 'agent run'
    if (run.status === 'running') {
      const from = w.place(run.startedAt)
      w.put(run.projectId, {
        id: `run:${run.id}`,
        module: 'agents',
        kind: 'block',
        start: run.startedAt.toISOString(),
        end: w.now.toISOString(),
        from,
        to: Math.max(w.nowAt, from + 0.02),
        state: 'doing',
        word: 'running · progress not known',
        label,
        when: w.say.since(run.startedAt),
        href,
        facts,
      })
      continue
    }
    const [state, word]: [ItemState, string] =
      run.status === 'succeeded'
        ? ['done', 'done']
        : run.status === 'failed'
          ? [
              'due',
              `failed${run.error ? ` · ${firstLine(run.error, 80)}` : ''}`,
            ]
          : run.status === 'abandoned'
            ? ['due', 'abandoned · lease lapsed']
            : ['done', 'stopped']
    w.put(run.projectId, {
      id: `run:${run.id}`,
      module: 'agents',
      kind: 'tick',
      start: run.startedAt.toISOString(),
      end: run.endedAt?.toISOString(),
      from: w.place(run.startedAt),
      state,
      word,
      label,
      when: run.endedAt
        ? w.say.span(run.startedAt, run.endedAt)
        : w.say.point(run.startedAt),
      href,
      facts,
    })
  }
  for (const routine of routines ?? []) {
    if (!routine.enabled || !routine.projectId || !w.inWeek(routine.nextDueAt))
      continue
    w.put(routine.projectId, {
      id: `routine:${routine.id}:next`,
      module: 'agents',
      kind: 'tick',
      start: routine.nextDueAt.toISOString(),
      from: w.place(routine.nextDueAt),
      state: 'plan',
      word: 'next run',
      label: routine.name,
      when: w.say.point(routine.nextDueAt),
      href: `/p/${w.slugOf(routine.projectId)}/agents?routine=${routine.id}`,
      facts: [['schedule', routine.schedule]],
    })
  }
  for (const { proposal, label } of proposals ?? []) {
    if (!proposal.projectId) continue
    // One asked before the week and still open sits at the week's start.
    const at = proposal.createdAt < w.start ? w.start : proposal.createdAt
    if (!w.inWeek(at) || at > w.now) continue
    w.put(proposal.projectId, {
      id: `proposal:${proposal.id}`,
      module: 'agents',
      kind: 'mark',
      start: proposal.createdAt.toISOString(),
      from: w.place(at),
      state: 'wait',
      word: proposal.heldAt ? 'held · still waits for you' : 'waiting for you',
      label: `${proposal.title} · proposal`,
      when: w.say.point(proposal.createdAt),
      href: `/inbox?item=${proposal.id}`,
      waitingId: proposal.id,
      facts: [['proposes', label]],
    })
  }
}

/* ── Waiting for you: requests on their record, or asked → now ──────── */

function waitingItems(w: Week, { requests }: Reads) {
  for (const { request } of requests ?? []) {
    if (!request.projectId) continue
    const onRecord =
      request.targetType && request.targetId
        ? w.records.get(`${request.targetType}:${request.targetId}`)
        : undefined
    if (onRecord?.length) {
      // The record's item nearest to now carries the request.
      const item = onRecord.reduce((best, entry) =>
        Math.abs(entry.from - w.nowAt) < Math.abs(best.from - w.nowAt)
          ? entry
          : best,
      )
      item.state = 'wait'
      item.word = `waiting for you · ${request.title}`
      item.waitingId = request.id
      continue
    }
    const module = request.module as ModuleId | null
    if (!module || !(PROJECT_MODULES as readonly string[]).includes(module))
      continue
    const asked = request.createdAt
    if (asked >= w.end || w.now <= w.start) continue
    const from = w.place(asked)
    w.put(request.projectId, {
      id: `request:${request.id}`,
      module,
      kind: 'block',
      start: asked.toISOString(),
      end: w.now.toISOString(),
      from,
      to: Math.max(w.nowAt, from + 0.02),
      state: 'wait',
      word: `waiting for you · ${took(w.now.getTime() - asked.getTime())}`,
      label: request.title,
      when: w.say.since(asked),
      href: `/inbox?item=${request.id}`,
      waitingId: request.id,
      facts: [['asked', w.say.point(asked)]],
    })
  }
}

/* ── Money · 7 days: one VU per project per currency, never converted ─ */

function moneyOf(
  live: Project[],
  { quotes, covered }: Reads,
  modules: ModuleReads,
): TimeData['money'] {
  // The same 7-day books every cell reads (`lib/cells.ts`), this week and the one before.
  const money = modules.sevenDays
  // Pending: what sits in awaiting-payment lanes, plus sent quotes no card covers.
  const pending = new Map<string, { currency: string; amount: string }[]>()
  const owe = (projectId: string | null, currency: string, amount: string) => {
    if (!projectId) return
    pending.set(projectId, [
      ...(pending.get(projectId) ?? []),
      { currency, amount },
    ])
  }
  for (const row of modules.boards ?? [])
    for (const entry of row.awaiting)
      owe(row.projectId, entry.currency, entry.sum)
  if (quotes && covered)
    for (const quote of quotes)
      if (quote.status === 'sent' && !covered.has(quote.id))
        owe(quote.projectId, quote.currency, quote.totals.total)

  const currencies = new Set<string>(live.map((project) => project.currency))
  for (const project of live)
    for (const book of [
      ...(money?.byProject.get(project.id) ?? []),
      ...(money?.previousByProject.get(project.id) ?? []),
    ])
      currencies.add(book.currency)
  for (const list of pending.values())
    for (const entry of list) currencies.add(entry.currency)

  const owed = (projectId: string, currency: string) => {
    const mine = (pending.get(projectId) ?? []).filter(
      (entry) => entry.currency === currency,
    )
    if (!mine.length) return null
    const total = sumAmounts(
      mine.map((entry) => entry.amount),
      currency,
    )
    return Number(total) > 0 ? total : null
  }
  const racks: MoneyRack[] = [...currencies]
    .sort((a, b) => (a === 'THB' ? -1 : b === 'THB' ? 1 : a.localeCompare(b)))
    .map((currency) => ({
      currency,
      columns: live.flatMap((project): MoneyColumn[] => {
        const net =
          money?.byProject
            .get(project.id)
            ?.find((entry) => entry.currency === currency)?.net ?? null
        const prev =
          money?.previousByProject
            .get(project.id)
            ?.find((entry) => entry.currency === currency)?.net ?? null
        const due = owed(project.id, currency)
        if (project.currency !== currency && !net && !prev && !due) return []
        return [
          {
            project: {
              id: project.id,
              slug: project.slug,
              name: project.name,
              color: project.color,
              status: project.status,
            },
            net,
            prev,
            pending: due,
          },
        ]
      }),
    }))
    .filter((rack) => rack.columns.length > 0)
  return { racks, known: money !== null }
}

function projectOf(project: Project): TimeProject {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    color: project.color,
    kind: project.kind,
    kindLabel: KIND_LABEL[project.kind],
    status: project.status,
    currency: project.currency,
  }
}
