import 'server-only'
import {
  GLOBAL_MODULES,
  type ModuleId,
  PROJECT_MODULES,
  type ProjectKind,
} from '@theiceji/hq-core/modules'
import { formatMoney } from '@theiceji/hq-core/money'
import type { Actor } from '@theiceji/hq-ops/access'
import { costSince, type MoneyBook } from '@theiceji/hq-readings/readings'
import type { InboxEntry } from '@/components/Inbox'
import type { ModuleCell } from '@/modules'
import {
  activeNotes,
  loadModuleReads,
  loadProjects,
  type Money,
  money,
  safe,
} from './cells'
import { type HomeData, loadHome } from './home'
import { fallbackTitle } from './notes/types'
import { requestNow } from './per-request'

/**
 * What Home · State reads: every project × module as
 * one number and one state — the same cells Space draws (`lib/cells.ts`) —
 * plus what the matrix adds around them: a master column that totals each
 * module row, a mixer under each column (money over 7 days, generation
 * cost, routines, the project's status), the notes the browser lists, and
 * the records the device pane shows behind a cell.
 *
 * Money is per currency and never converted; a meter's level compares a
 * project only with other projects in the same currency. Cost that nobody
 * knows is counted, never guessed (`unknown`). Anything that couldn't be
 * read is `null` and reads "not read back", never a zero.
 *
 * Every read goes through the owner-scoped services the rest of HQ uses;
 * ages are measured against the database's clock.
 */

export type StateProject = {
  id: string
  slug: string
  name: string
  kind: ProjectKind
  kindLabel: string
  status: 'active' | 'paused' | 'archived'
  /** A swatch name (`violet`), never a hex. */
  color: string
  /** Nothing recorded in any module yet: every cell reads "nothing yet". */
  fresh: boolean
  /** For the optimistic writes (pause, enable). */
  revision: number
  /** The project modules it has on. */
  enabled: ModuleId[]
  /** One cell per enabled module. */
  cells: Partial<Record<ModuleId, ModuleCell>>
  waiting: number
  /** Awaiting payment plus sent quotes, per currency — not money yet. */
  pending: Money[]
  /** Net money over the last 7 days, per currency; null when not read back. */
  earned: Money[] | null
  /** The mixer meter, 0–100, against the busiest project in the same currency. */
  level: number
  /** Generation cost over 7 days; null when it couldn't be read. */
  cost: { known: Money[]; unknown: number } | null
  /** Routines not archived, and how many are on; null when not read back. */
  routines: { total: number; on: number } | null
}

export type DetailRow = {
  key: string
  text: string
  value: string
  projectId: string | null
  href: string | null
  tone: '' | 'wait' | 'soon' | 'live'
}

/** What the device pane lists behind one cell (or one module row, for `all`). */
export type Detail = { label: string; rows: DetailRow[] }

export type StateNote = {
  id: string
  text: string
  projectId: string | null
  /** How long ago it was captured, by the database's clock. */
  age: string
  /** Where it went, once promoted. */
  promoted: { label: string; href: string | null } | null
}

export type StateData = {
  projects: StateProject[]
  /** The master column: each module row across every project. */
  master: Record<ModuleId, ModuleCell & { projects: number }>
  entries: InboxEntry[]
  notes: StateNote[] | null
  /** Master mixer: this week's net against last week's, per currency. */
  money: {
    total: Money[]
    previous: Money[]
    /** The currency the meter reads in (THB first). */
    currency: string | null
    level: number
    week: string
  } | null
  /** The master Readings pane's spark: net per week, oldest first. */
  spark: { values: number[]; currency: string | null; weeks: number } | null
  /** Rows behind each cell: `detail[projectId | 'all'][module]`. */
  detail: Record<string, Partial<Record<ModuleId, Detail>>>
  /** Modules with a page across every project, and where it is. */
  routes: Partial<Record<ModuleId, string>>
  modules: readonly ModuleId[]
}

const ZERO = /^-?0(\.0+)?$/

const nets = (books: MoneyBook[]): Money[] =>
  money(books.map((book) => ({ currency: book.currency, amount: book.net })))

/** Each module's unit, as its cells say it (lib/cells.ts) — for a row no project has on. */
const UNIT: Record<ModuleId, string> = {
  board: 'cards',
  prompts: 'prompts',
  assets: 'assets',
  story: 'shots',
  calendar: 'today',
  quotes: 'sent',
  publish: 'out 7d',
  market: 'live',
  experiments: 'running',
  readings: '7d',
  agents: 'running',
  notes: '',
}

const across = (n: number) => `${n} project${n === 1 ? '' : 's'}`

/** "4m", "2h", "5d" between two instants of the database's clock. */
function ageBetween(from: Date, now: Date): string {
  const minutes = Math.max(
    0,
    Math.round((now.getTime() - from.getTime()) / 60_000),
  )
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** `a / b` shots → `[a, b]`. */
function fraction(value: number | string): [number, number] | null {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(value))
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** Where a module row goes across every project — `/board`, `/dashboard`. */
function globalRoute(id: ModuleId): string | null {
  if (GLOBAL_MODULES.includes(id)) return `/${id}`
  if (id === 'readings') return '/dashboard'
  if (id === 'agents') return '/agents'
  return null
}

/** The master cell of one module row: a total, and ◆ ▶ ● counts. */
function masterCell(
  id: ModuleId,
  projects: StateProject[],
  home: HomeData,
): ModuleCell & { projects: number } {
  const on = projects.filter((project) => project.enabled.includes(id))
  const cells = on
    .map((project) => project.cells[id])
    .filter((cell): cell is ModuleCell => Boolean(cell))
  const count = (state: string) =>
    cells.filter((cell) => cell.state === state).length
  const wait = count('wait')
  const live = count('live')
  const due = count('due')
  const counts = [
    wait ? `◆ ${wait}` : '',
    live ? `▶ ${live}` : '',
    due ? `● ${due}` : '',
  ].filter(Boolean)
  let sub = counts.length
    ? `${counts.join(' · ')} · ${across(on.length)}`
    : across(on.length)
  const state = wait ? 'wait' : live ? 'live' : due ? 'due' : ''
  const unit = cells.find((cell) => cell.unit)?.unit ?? UNIT[id]
  if (!on.length)
    return {
      value: 0,
      unit,
      sub: 'no project has this on',
      state: '',
      projects: 0,
    }
  if (cells.some((cell) => cell.state === 'unknown' || cell.value === '—'))
    return {
      value: '—',
      unit: '',
      sub: counts.length
        ? `${counts.join(' · ')} · not read back`
        : 'not read back',
      state: wait ? 'wait' : 'unknown',
      projects: on.length,
    }
  if (id === 'readings') {
    // The projects with Readings on, added per currency — never converted.
    const earned = on.some((project) => project.earned === null)
      ? null
      : money(
          on.flatMap((project) =>
            (project.earned ?? []).map((entry) => ({
              currency: entry.currency,
              amount: entry.amount,
            })),
          ),
        )
    if (!earned)
      return {
        value: '—',
        unit: '',
        sub: 'not read back',
        state: 'unknown',
        projects: on.length,
      }
    return {
      value: earned.length ? earned.map((entry) => entry.label).join(' + ') : 0,
      unit: '7d',
      sub,
      state,
      projects: on.length,
    }
  }
  if (id === 'story') {
    const parts = cells
      .map((cell) => fraction(cell.value))
      .filter((part): part is [number, number] => Boolean(part))
    return {
      value: `${parts.reduce((n, part) => n + part[0], 0)} / ${parts.reduce((n, part) => n + part[1], 0)}`,
      unit: 'shots',
      sub,
      state,
      projects: on.length,
    }
  }
  if (id === 'board' && home.money.awaiting.length)
    sub = `${home.money.awaiting.map((entry) => entry.label).join(' + ')} awaiting payment · ${across(on.length)}`
  const sum = cells.reduce(
    (n, cell) => n + (typeof cell.value === 'number' ? cell.value : 0),
    0,
  )
  return { value: sum, unit, sub, state, projects: on.length }
}

const clock = (timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  })

/** Rows the device pane lists behind each cell, from what Home already read. */
function details(
  home: HomeData,
  projects: StateProject[],
  books: Map<string, MoneyBook[]>,
  total: MoneyBook[] | null,
  now: Date | null,
): StateData['detail'] {
  const when = clock(home.timezone)
  const moneyRows = (list: MoneyBook[], projectId: string | null) =>
    list.flatMap((book) =>
      (
        [
          ['sales', book.sales],
          ['refunds', book.refunds],
          ['fees', book.fees],
          ['earnings', book.earnings],
          ['paid', book.paid],
          ['net', book.net],
        ] as const
      )
        .filter(([key, amount]) => key === 'net' || !ZERO.test(amount))
        .map(([key, amount]) => ({
          key: `${book.currency}-${key}`,
          text: `${key} · ${book.currency}`,
          value: formatMoney(amount, book.currency),
          projectId,
          href: null,
          tone: '' as const,
        })),
    )

  const build = (projectId: string | null) => {
    const mine = <T extends { projectId: string | null }>(rows: T[] | null) =>
      (rows ?? []).filter(
        (row) => projectId === null || row.projectId === projectId,
      )
    const out: Partial<Record<ModuleId, Detail>> = {}
    const due = mine(home.todayItems).filter((item) => item.kind === 'card')
    const awaiting = mine(home.awaitingCards)
    if (due.length || awaiting.length)
      out.board = {
        label: 'Due · awaiting payment',
        rows: [
          ...due.map((item) => ({
            key: item.id,
            text: item.label,
            value: item.at === 'overdue' ? '● overdue' : '● due today',
            projectId: item.projectId,
            href: item.href,
            tone: 'soon' as const,
          })),
          ...awaiting.map((card) => ({
            key: `awaiting-${card.id}`,
            text: card.title,
            value: `${card.price} · awaiting`,
            projectId: card.projectId,
            href: card.href,
            tone: '' as const,
          })),
        ],
      }
    const events = mine(home.todayItems).filter((item) => item.kind === 'event')
    if (events.length)
      out.calendar = {
        label: 'Today',
        rows: events.map((item) => ({
          key: item.id,
          text: item.label,
          value: item.at,
          projectId: item.projectId,
          href: item.href,
          tone: '' as const,
        })),
      }
    const quotes = mine(home.sentQuotes)
    if (quotes.length)
      out.quotes = {
        label: 'Sent',
        rows: quotes.map((quote) => ({
          key: quote.id,
          text: quote.number,
          value: `${quote.total}${quote.covered ? ' · on its card' : ''}${quote.validUntil ? ` · valid to ${quote.validUntil}` : ''}`,
          projectId: quote.projectId,
          href: quote.href,
          tone: '' as const,
        })),
      }
    const posts = mine(home.nextPosts)
    if (posts.length)
      out.publish = {
        label: 'Cleared to post',
        rows: posts.map((post) => ({
          key: post.id,
          text: post.title,
          value: `${post.platform}${post.at ? ` · ${when.format(new Date(post.at)).replace(',', '')}` : ''}`,
          projectId: post.projectId,
          href: post.href,
          tone: '' as const,
        })),
      }
    const sold = mine(home.marketWeek)
    if (sold.length)
      out.market = {
        label: 'Sold · 7 days',
        rows: sold.map((row, i) => ({
          key: `${row.projectId}-${row.net.currency}-${i}`,
          text: `${row.units} sold`,
          value: row.net.label,
          projectId: row.projectId,
          href: null,
          tone: '' as const,
        })),
      }
    const running = mine(home.agents)
    if (running.length)
      out.agents = {
        label: 'Running',
        rows: running.map((run) => ({
          key: run.id,
          text: run.title,
          value: now
            ? `▶ for ${ageBetween(new Date(run.startedAt), now)}`
            : '▶ running',
          projectId: run.projectId,
          href: '/agents',
          tone: 'live' as const,
        })),
      }
    const book =
      projectId === null ? total : (books.get(projectId) ?? (total ? [] : null))
    if (book?.length)
      out.readings = {
        label: 'Money · 7 days',
        rows: moneyRows(book, projectId),
      }
    return out
  }

  const detail: StateData['detail'] = { all: build(null) }
  for (const project of projects) detail[project.id] = build(project.id)
  return detail
}

export async function loadState(actor: Actor): Promise<StateData> {
  const [home, reads, rows, costs, notes, now] = await Promise.all([
    loadHome(actor),
    loadModuleReads(actor),
    safe(loadProjects(actor)),
    safe(costSince(actor, 7)),
    safe(activeNotes(actor)),
    safe(requestNow()),
  ])
  const revisions = new Map((rows ?? []).map((row) => [row.id, row]))
  const sevenDays = reads.sevenDays
  const routines = reads.routines

  const projects: StateProject[] = home.projects.map((project) => {
    const row = revisions.get(project.id)
    const books = sevenDays ? (sevenDays.byProject.get(project.id) ?? []) : null
    // A project that spent nothing has no row: zero known, none unknown.
    const mine = costs
      ? (costs.get(project.id) ?? { cost: [], unknown: 0 })
      : null
    const summary = routines?.find((entry) => entry.projectId === project.id)
    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      kind: project.kind as ProjectKind,
      kindLabel: project.kindLabel,
      status: project.status,
      color: project.color,
      fresh: project.fresh,
      revision: row?.revision ?? 0,
      enabled: project.modules.map((entry) => entry.id),
      cells: Object.fromEntries(
        project.modules.flatMap((entry) =>
          entry.cell ? [[entry.id, entry.cell]] : [],
        ),
      ),
      waiting: project.waiting,
      pending: project.pending,
      earned: books ? nets(books) : null,
      level: 0,
      cost: mine
        ? {
            known: money(
              mine.cost.map((entry) => ({
                currency: entry.currency,
                amount: entry.amount,
              })),
            ),
            unknown: mine.unknown,
          }
        : null,
      routines: routines
        ? { total: summary?.routines ?? 0, on: summary?.enabled ?? 0 }
        : null,
    }
  })

  // One scale per currency: a project's meter is its best currency against
  // the busiest project in that same currency. Display only — the figures
  // themselves are the formatted amounts.
  const peak = new Map<string, number>()
  for (const project of projects)
    for (const entry of project.earned ?? [])
      peak.set(
        entry.currency,
        Math.max(peak.get(entry.currency) ?? 0, Number(entry.amount)),
      )
  for (const project of projects)
    project.level = Math.round(
      Math.max(
        0,
        ...(project.earned ?? []).map((entry) => {
          const top = peak.get(entry.currency) ?? 0
          return top > 0 ? (Math.max(0, Number(entry.amount)) / top) * 100 : 0
        }),
      ),
    )

  const total = sevenDays ? nets(sevenDays.total) : null
  const previous = sevenDays ? nets(sevenDays.previousTotal) : []
  const currency =
    [...(total ?? []), ...previous].find((entry) => entry.currency === 'THB')
      ?.currency ??
    total?.[0]?.currency ??
    previous[0]?.currency ??
    null
  const amountIn = (list: Money[]) =>
    Number(list.find((entry) => entry.currency === currency)?.amount ?? 0)
  const thisWeek = total ? amountIn(total) : 0
  const lastWeek = amountIn(previous)
  const scale = Math.max(thisWeek, lastWeek)

  const master = Object.fromEntries(
    PROJECT_MODULES.map((id) => [id, masterCell(id, projects, home)]),
  ) as StateData['master']

  return {
    projects,
    master,
    entries: home.entries,
    notes: notes
      ? notes.map((note) => {
          const to = note.promotedTo as {
            type?: unknown
            href?: unknown
            projectId?: unknown
          } | null
          // Where it went, in words: `Home & Health · card`.
          const into = projects.find((entry) => entry.id === to?.projectId)
          return {
            id: note.id,
            text:
              note.title?.trim() || fallbackTitle(note.body) || 'Untitled note',
            projectId: note.projectId,
            age: now ? ageBetween(new Date(note.createdAt), now) : '—',
            promoted: to
              ? {
                  label: `${into?.name ?? 'HQ'} · ${typeof to.type === 'string' ? to.type : 'record'}`,
                  href: typeof to.href === 'string' ? to.href : null,
                }
              : null,
          }
        })
      : null,
    money: total
      ? {
          total,
          previous,
          currency,
          level:
            scale > 0 ? Math.round((Math.max(0, thisWeek) / scale) * 100) : 0,
          week: home.week.label,
        }
      : null,
    spark: home.earned
      ? {
          values: home.earned.spark,
          currency: home.earned.sparkCurrency,
          weeks: home.earned.spark.length,
        }
      : null,
    detail: details(
      home,
      projects,
      sevenDays?.byProject ?? new Map(),
      sevenDays ? sevenDays.total : null,
      now,
    ),
    routes: Object.fromEntries(
      PROJECT_MODULES.flatMap((id) => {
        const href = globalRoute(id)
        return href ? [[id, href]] : []
      }),
    ),
    modules: PROJECT_MODULES,
  }
}
