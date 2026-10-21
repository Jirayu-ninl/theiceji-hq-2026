import type { ModuleId } from '@theiceji/hq-core/modules'
import type { InboxEntry } from '@/components/Inbox'

/**
 * Home · Time — the shapes the
 * server hands the page, and the pure helpers both sides share: week keys,
 * placing an instant on the ruler, and packing a lane's items into rows.
 * No clock and no database here; "now" always comes in from Postgres.
 */

export type ItemState = 'done' | 'doing' | 'wait' | 'plan' | 'due'
export type ItemKind = 'block' | 'mark' | 'tick'

/** One dated record on a track (with where it sits on the ruler). */
export type TimelineItem = {
  id: string
  module: ModuleId
  kind: ItemKind
  /** An ISO instant, or a `YYYY-MM-DD` day for a record that only has a date. */
  start: string
  end?: string
  /** Days from the shown Monday 00:00 in the ruler's zone; may run past 0 or 7. */
  from: number
  to?: number
  state: ItemState
  /** The state in words when it says more than the state does: `overdue`, `failed`. */
  word?: string
  label: string
  /** When, in words, in the ruler's zone: `Wed 23 · 14:00 – 15:30`. */
  when: string
  href: string
  /** 0–100 where the record knows it; a running agent doesn't. */
  progress?: number
  /** Ties the item to its Inbox entry, so its keys act on it. */
  waitingId?: string
  facts: [string, string][]
}

export type TimeLane = {
  module: ModuleId
  label: string
  glyph: string
  href: string
  items: TimelineItem[]
  /** The module's records couldn't be read — the lane says `— not read back`. */
  unknown?: boolean
}

export type TimeProject = {
  id: string
  slug: string
  name: string
  color: string
  kind: string
  kindLabel: string
  status: 'active' | 'paused' | 'archived'
  currency: string
}

export type TimeGroup = { project: TimeProject; lanes: TimeLane[] }

export type TimeDay = { day: string; dow: string; num: number }

export type TimeWeek = {
  /** `2026-W39` — what `?week=` carries. */
  key: string
  label: string
  /** `Mon 21 – Sun 27 Sep`. */
  range: string
  monday: string
  days: TimeDay[]
  prev: string
  next: string
  /** The week today falls in. */
  current: boolean
}

export type MoneyColumn = {
  project: Pick<TimeProject, 'id' | 'slug' | 'name' | 'color' | 'status'>
  /** Net in the last 7 days; null when nothing was recorded in this currency. */
  net: string | null
  /** Net in the 7 days before — the tick. */
  prev: string | null
  /** Awaiting payment plus sent quotes, counted once — not money yet. */
  pending: string | null
}

export type MoneyRack = { currency: string; columns: MoneyColumn[] }

export type TimeData = {
  week: TimeWeek
  timezone: string
  now: {
    iso: string
    today: string
    /** Where now sits on this week's ruler; null when the week isn't this one. */
    at: number | null
  }
  groups: TimeGroup[]
  entries: InboxEntry[]
  money: {
    racks: MoneyRack[]
    /** Readings could be read (else every meter reads `— not read back`). */
    known: boolean
  }
}

/* ── Weeks ──────────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const WEEK = /^(\d{4})-W(\d{1,2})$/i
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MON = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

const utc = (day: string) => new Date(`${day}T00:00:00Z`)
const dayOf = (date: Date) => date.toISOString().slice(0, 10)

export function isDayString(value: string): boolean {
  const m = DAY.exec(value)
  if (!m) return false
  const date = utc(value)
  return !Number.isNaN(date.getTime()) && dayOf(date) === value
}

export function plusDays(day: string, n: number): string {
  return dayOf(new Date(utc(day).getTime() + n * DAY_MS))
}

/** The Monday of the week a day falls in (weeks start on Monday). */
export function mondayOf(day: string): string {
  return plusDays(day, -((utc(day).getUTCDay() + 6) % 7))
}

/** ISO-8601 week of a day: the year that owns its Thursday, and the week number. */
export function isoWeek(day: string): { year: number; week: number } {
  const thursday = utc(plusDays(mondayOf(day), 3))
  const year = thursday.getUTCFullYear()
  const week =
    Math.floor(
      (thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7 + 1e-9,
    ) + 1
  return { year, week }
}

/** `2026-W39` for the week a day falls in. */
export function weekKey(day: string): string {
  const { year, week } = isoWeek(day)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/**
 * `?week=` → the Monday it names. Takes an ISO week (`2026-W39`) or any day
 * of the week (`2026-09-23`); anything else is null (this week).
 */
export function parseWeek(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? ''
  const week = WEEK.exec(value)
  if (week) {
    const year = Number(week[1])
    const n = Number(week[2])
    if (year < 2000 || year > 2100 || n < 1 || n > 53) return null
    const jan4 = `${year}-01-04`
    const monday = plusDays(mondayOf(jan4), (n - 1) * 7)
    const back = isoWeek(monday)
    return back.year === year && back.week === n ? monday : null
  }
  if (isDayString(value)) {
    const year = Number(value.slice(0, 4))
    if (year < 2000 || year > 2100) return null
    return mondayOf(value)
  }
  return null
}

export function weekDays(monday: string): TimeDay[] {
  return Array.from({ length: 7 }, (_, i) => {
    const day = plusDays(monday, i)
    const date = utc(day)
    return {
      day,
      dow: DOW[date.getUTCDay()] as string,
      num: date.getUTCDate(),
    }
  })
}

/** `Mon 21 – Sun 27 Sep`, or `Mon 28 Sep – Sun 4 Oct` across a month. */
export function weekRangeWords(monday: string): string {
  const days = weekDays(monday)
  const first = days[0] as TimeDay
  const last = days[6] as TimeDay
  const m0 = MON[utc(first.day).getUTCMonth()]
  const m1 = MON[utc(last.day).getUTCMonth()]
  return m0 === m1
    ? `${first.dow} ${first.num} – ${last.dow} ${last.num} ${m1}`
    : `${first.dow} ${first.num} ${m0} – ${last.dow} ${last.num} ${m1}`
}

export function weekOf(monday: string, today: string): TimeWeek {
  const { week } = isoWeek(monday)
  return {
    key: weekKey(monday),
    label: `W${week}`,
    range: weekRangeWords(monday),
    monday,
    days: weekDays(monday),
    prev: weekKey(plusDays(monday, -7)),
    next: weekKey(plusDays(monday, 7)),
    current: mondayOf(today) === monday,
  }
}

/* ── The ruler ──────────────────────────────────────────────────────── */

/**
 * Where an instant sits on the ruler, in days from Monday 00:00. `bounds`
 * are the eight local midnights of the week (Monday … the next Monday) as
 * epoch ms, so a day that is 23 or 25 hours long still spans one column.
 * Outside the week it runs on at the nearest day's length.
 */
export function placeOn(ms: number, bounds: readonly number[]): number {
  const first = bounds[0] as number
  const last = bounds[bounds.length - 1] as number
  const days = bounds.length - 1
  if (ms < first) {
    const span = (bounds[1] as number) - first
    return (ms - first) / span
  }
  if (ms >= last) {
    const span = last - (bounds[days - 1] as number)
    return days + (ms - last) / span
  }
  for (let i = 0; i < days; i++) {
    const a = bounds[i] as number
    const b = bounds[i + 1] as number
    if (ms < b) return i + (ms - a) / (b - a)
  }
  return days
}

/** An item's span as drawn: clamped to the week, never narrower than nothing. */
export function drawnSpan(item: Pick<TimelineItem, 'from' | 'to' | 'kind'>): {
  from: number
  to: number
} {
  const from = Math.min(7, Math.max(0, item.from))
  const to =
    item.kind === 'block'
      ? Math.min(7, Math.max(from, item.to ?? item.from))
      : from
  return { from, to }
}

/** Does the item show on the week at all? */
export function onWeek(item: Pick<TimelineItem, 'from' | 'to' | 'kind'>) {
  const end = item.kind === 'block' ? (item.to ?? item.from) : item.from
  return item.kind === 'block'
    ? item.from < 7 && end > 0
    : item.from >= 0 && item.from < 7
}

/* ── Packing a lane ─────────────────────────────────────────────────── */

export const ROW_H = 24
export const ROW_GAP = 4
export const LANE_PAD = 10
export const MIN_LANE = 44
/** Blocks shorter than this (days) wear their label outside. */
export const NARROW = 0.3

/** How much of a row a point takes, in days, when rows are packed. */
const SPAN: Record<ItemKind, number> = { block: 0.035, mark: 0.05, tick: 0.02 }

/**
 * Overlapping items split into rows: greedy first fit by
 * start. Marks and ticks count as tiny spans, so they only drop a row when a
 * block covers them. Returns each item's row and the lane's height.
 */
export function packLane(items: readonly TimelineItem[]): {
  rows: Map<string, number>
  count: number
  height: number
} {
  const ends: number[] = []
  const rows = new Map<string, number>()
  const sorted = [...items].sort((a, b) => {
    const sa = drawnSpan(a)
    const sb = drawnSpan(b)
    return sa.from - sb.from || sb.to - sa.to || a.id.localeCompare(b.id)
  })
  for (const item of sorted) {
    const span = drawnSpan(item)
    const end = Math.max(span.to, span.from + SPAN[item.kind])
    let row = ends.findIndex((e) => e <= span.from + 1e-6)
    if (row < 0) row = ends.length
    ends[row] = end
    rows.set(item.id, row)
  }
  const count = items.length ? Math.max(1, ends.length) : 0
  return { rows, count, height: laneHeight(count) }
}

export function laneHeight(rows: number): number {
  return Math.max(
    MIN_LANE,
    LANE_PAD * 2 + rows * ROW_H + Math.max(0, rows - 1) * ROW_GAP,
  )
}

/* ── Words ──────────────────────────────────────────────────────────── */

export function stateWord(
  item: Pick<TimelineItem, 'state' | 'word' | 'progress' | 'kind'>,
): string {
  if (item.word) return item.word
  switch (item.state) {
    case 'done':
      return item.kind === 'tick' ? 'ran' : 'done'
    case 'doing':
      return item.progress != null
        ? `in progress · ${item.progress}%`
        : 'in progress'
    case 'wait':
      return 'waiting for you'
    case 'plan':
      return 'planned'
    case 'due':
      return 'due'
  }
}

export const glyphFor = (state: ItemState) =>
  state === 'wait'
    ? '◆'
    : state === 'doing'
      ? '▶'
      : state === 'due'
        ? '●'
        : state === 'done'
          ? '✓'
          : '○'

export const glyphClass = (state: ItemState) =>
  state === 'wait'
    ? 'wait'
    : state === 'doing'
      ? 'live'
      : state === 'due'
        ? 'due'
        : 'off'

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

/** The smallest round figure above the loudest meter, with a little headroom (Readings' scale). */
export function niceMax(value: number): number {
  if (!(value > 0)) return 0
  const target = value * 1.05
  const e = 10 ** Math.floor(Math.log10(target))
  const m = [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].find(
    (step) => step * e >= target,
  )
  return (m ?? 10) * e
}
