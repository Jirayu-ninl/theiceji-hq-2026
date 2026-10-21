/**
 * Time for a project that reports in one timezone and stores UTC.
 *
 * Browser `datetime-local` inputs carry no zone, so a value like
 * `2026-09-20T19:30` is read as wall-clock time in the project's timezone.
 * A value that names its own offset (`…Z`, `…+07:00`) is taken as-is — that
 * is what an API or agent sends.
 */

/**
 * The reporting timezone for work that belongs to no project (HQ keeps
 * one owner for now). A project's own `timezone` wins wherever
 * there is a project.
 */
export const DEFAULT_TIME_ZONE = 'Asia/Bangkok'

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, f)
  }
  return f
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

type Wall = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallClock(epochMs: number, timeZone: string): Wall {
  const parts = formatter(timeZone).formatToParts(new Date(epochMs))
  const n = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)
  return {
    year: n('year'),
    month: n('month'),
    day: n('day'),
    hour: n('hour') % 24,
    minute: n('minute'),
    second: n('second'),
  }
}

/** Milliseconds the zone is ahead of UTC at that instant. */
function offsetMs(epochMs: number, timeZone: string): number {
  const w = wallClock(epochMs, timeZone)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asUtc - Math.floor(epochMs / 1000) * 1000
}

/** Wall-clock time in a zone → instant. Null for malformed or non-existent times. */
export function localToInstant(local: string, timeZone: string): Date | null {
  const m = LOCAL.exec(local)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = Number(m[6] ?? '0')
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59)
    return null
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  let epoch = wall - offsetMs(wall, timeZone)
  const refined = wall - offsetMs(epoch, timeZone)
  if (refined !== epoch) epoch = refined
  const back = wallClock(epoch, timeZone)
  if (
    back.year !== year ||
    back.month !== month ||
    back.day !== day ||
    back.hour !== hour ||
    back.minute !== minute
  )
    return null
  return new Date(epoch)
}

/** Accepts an offset-qualified ISO string, or wall-clock time in `timeZone`. */
export function parseInstant(raw: string, timeZone: string): Date | null {
  const value = raw.trim()
  if (WITH_ZONE.test(value)) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return localToInstant(value, timeZone)
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** Instant → `YYYY-MM-DDTHH:mm` for a `datetime-local` input. */
export function toLocalInput(date: Date, timeZone: string): string {
  const w = wallClock(date.getTime(), timeZone)
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`
}

/** The calendar day an instant falls on in a zone. */
export function zonedDay(date: Date, timeZone: string): string {
  const w = wallClock(date.getTime(), timeZone)
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`
}

export function isDay(value: string): boolean {
  const m = DAY.exec(value)
  if (!m) return false
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return (
    date.getUTCFullYear() === Number(m[1]) &&
    date.getUTCMonth() === Number(m[2]) - 1 &&
    date.getUTCDate() === Number(m[3])
  )
}

export function addDays(day: string, days: number): string {
  const m = DAY.exec(day)
  if (!m) throw new Error(`Not a day: ${day}`)
  const date = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days),
  )
  return date.toISOString().slice(0, 10)
}

/** The first day of the calendar month a day belongs to. */
export function monthStart(day: string): string {
  const m = DAY.exec(day)
  if (!m) throw new Error(`Not a day: ${day}`)
  return `${m[1]}-${m[2]}-01`
}

export function addMonths(day: string, months: number): string {
  const m = DAY.exec(day)
  if (!m) throw new Error(`Not a day: ${day}`)
  const date = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1 + months, Number(m[3])),
  )
  return date.toISOString().slice(0, 10)
}

/**
 * A calendar month as an instant range, in the project's own timezone —
 * so a month boundary is midnight in Bangkok, not in UTC.
 */
export function monthRange(
  day: string,
  timeZone: string,
): { start: Date; end: Date } {
  const first = monthStart(day)
  const next = monthStart(addMonths(first, 1))
  const start = localToInstant(`${first}T00:00`, timeZone)
  const end = localToInstant(`${next}T00:00`, timeZone)
  if (!start || !end)
    throw new Error(`Cannot place ${day} in timezone ${timeZone}`)
  return { start, end }
}

/** An inclusive day range as instants in a timezone: `[start, end)`. */
export function dayRange(
  from: string,
  to: string,
  timeZone: string,
): { start: Date; end: Date } {
  const start = localToInstant(`${from}T00:00`, timeZone)
  const end = localToInstant(`${addDays(to, 1)}T00:00`, timeZone)
  if (!start || !end)
    throw new Error(`Cannot place ${from}–${to} in timezone ${timeZone}`)
  return { start, end }
}
