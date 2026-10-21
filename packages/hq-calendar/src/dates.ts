import { invalid } from '@theiceji/hq-ops/errors'
import {
  addDays,
  addMonths,
  dayRange,
  isDay,
  isValidTimeZone,
  monthStart,
  parseInstant,
  toLocalInput,
  zonedDay,
} from '@theiceji/hq-ops/time'

/**
 * Calendar dates and times (the header of hq-db's
 * `schema/calendar.ts`). Pure: no database and no clock of its own — "today"
 * is always handed in, read from the database's `now()`.
 *
 * · **An all-day event is dates.** It is stored the way Google writes it:
 *   midnight UTC of the first day, and midnight UTC of the day *after* the
 *   last. People, forms and tools speak in the inclusive last day; only the
 *   stored `ends_at` is exclusive, and the conversion lives here alone.
 * · **A timed event is two instants** and the zone it was written in. Input
 *   is an ISO instant with an offset (what an API or agent sends) or local
 *   `YYYY-MM-DDTHH:mm` read in the event's zone (a `datetime-local` field).
 * · **Weeks start on Monday**, the way the owner's calendar reads.
 */

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** An all-day event's longest run — ten years; anything longer is a typo. */
const MAX_ALL_DAY_DAYS = 3660

/** Midnight UTC of a day: how an all-day event's dates are stored. */
export function utcMidnight(day: string): Date {
  if (!isDay(day)) throw new Error(`Not a day: ${day}`)
  return new Date(`${day}T00:00:00.000Z`)
}

/** The UTC date of an instant — the stored day of an all-day bound. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** An all-day run from its first and last day (inclusive) to the stored `[start, end)`. */
export function allDaySpan(
  first: string,
  last: string,
): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: utcMidnight(first),
    endsAt: utcMidnight(addDays(last, 1)),
  }
}

/** A stored all-day event back to its first and last day, inclusive. */
export function allDayDates(event: { startsAt: Date; endsAt: Date }): {
  first: string
  last: string
} {
  const first = utcDay(event.startsAt)
  const last = addDays(utcDay(event.endsAt), -1)
  return { first, last: last < first ? first : last }
}

/** How many days an all-day event covers — at least one. */
export function allDayLength(event: { startsAt: Date; endsAt: Date }): number {
  return Math.max(
    1,
    Math.round((event.endsAt.getTime() - event.startsAt.getTime()) / DAY_MS),
  )
}

/**
 * The days an event covers as the calendar draws it: an all-day event by its
 * own dates, a timed one in `timeZone`. A timed event ending exactly at
 * midnight doesn't spill into the next day.
 */
export function eventDays(
  event: { allDay: boolean; startsAt: Date; endsAt: Date },
  timeZone: string,
): { first: string; last: string } {
  if (event.allDay) return allDayDates(event)
  const lastInstant =
    event.endsAt > event.startsAt
      ? new Date(event.endsAt.getTime() - 1)
      : event.startsAt
  return {
    first: zonedDay(event.startsAt, timeZone),
    last: zonedDay(lastInstant, timeZone),
  }
}

/** 0 for Sunday … 6 for Saturday. */
export function weekday(day: string): number {
  return utcMidnight(day).getUTCDay()
}

/** A run of whole days, and the instants that bound them in a zone: `[start, end)`. */
export type DaySpan = { from: string; to: string; start: Date; end: Date }

/** The Monday-to-Sunday week `day` falls in, bounded in `timeZone`. */
export function weekRange(day: string, timeZone: string): DaySpan {
  const from = addDays(day, -((weekday(day) + 6) % 7))
  const to = addDays(from, 6)
  return { from, to, ...dayRange(from, to, timeZone) }
}

/**
 * What a month view shows: whole weeks from the Monday on or before the 1st
 * to the Sunday on or after the last day, plus the month itself.
 */
export function monthGrid(
  day: string,
  timeZone: string,
): DaySpan & { month: { first: string; last: string } } {
  const first = monthStart(day)
  const last = addDays(monthStart(addMonths(first, 1)), -1)
  const from = weekRange(first, timeZone).from
  const to = weekRange(last, timeZone).to
  return { from, to, ...dayRange(from, to, timeZone), month: { first, last } }
}

/* ── Reading an event's time from a form or a tool ─────────────────── */

export type WhenInput = {
  /** Absent: all-day when `startsAt` is a bare date. */
  allDay?: boolean
  /** All-day: the first day. Timed: an ISO instant or local `YYYY-MM-DDTHH:mm`. */
  startsAt: string
  /** All-day: the last day, inclusive. Timed: the end. Absent or null: the default length. */
  endsAt?: string | null
  /** The zone local times are read in; the fallback's when absent. */
  timezone?: string | null
}

/** An event's time as stored. */
export type When = {
  allDay: boolean
  startsAt: Date
  endsAt: Date
  /** Null for an all-day event: dates have no zone. */
  timezone: string | null
}

/**
 * Turns what a person or a tool wrote into stored times, or throws `invalid`
 * with the field to fix. Without an end, an all-day event is one day (or
 * `length.days`) and a timed one an hour (or `length.ms`).
 */
export function resolveWhen(
  input: WhenInput,
  fallbackZone: string,
  length: { days?: number; ms?: number } = {},
): When {
  const start = input.startsAt.trim()
  const end = input.endsAt?.trim() || null
  const allDay = input.allDay ?? isDay(start)
  if (allDay) {
    if (!isDay(start))
      throw invalid('An all-day event starts on a date, like 2026-10-01.', {
        startsAt: 'Use a date: YYYY-MM-DD.',
      })
    const last = end ?? addDays(start, Math.max(1, length.days ?? 1) - 1)
    if (!isDay(last))
      throw invalid('An all-day event ends on a date, like 2026-10-03.', {
        endsAt: 'Use a date: YYYY-MM-DD.',
      })
    if (last < start)
      throw invalid('The last day is before the first.', {
        endsAt: 'Choose a last day on or after the first.',
      })
    const span = allDaySpan(start, last)
    if (allDayLength(span) > MAX_ALL_DAY_DAYS)
      throw invalid('An all-day event can run ten years at most.', {
        endsAt: 'Choose an earlier last day.',
      })
    return { allDay: true, ...span, timezone: null }
  }
  const zone = input.timezone?.trim() || fallbackZone
  if (!isValidTimeZone(zone))
    throw invalid('That isn’t a timezone HQ knows.', {
      timezone: 'Use an IANA name, like Asia/Bangkok.',
    })
  const startsAt = parseInstant(start, zone)
  if (!startsAt)
    throw invalid(
      'Give the start as a time, like 2026-10-01T09:30 — or a full ISO time with its offset.',
      { startsAt: 'Use YYYY-MM-DDTHH:mm.' },
    )
  const endsAt = end
    ? parseInstant(end, zone)
    : new Date(startsAt.getTime() + Math.max(0, length.ms ?? HOUR_MS))
  if (!endsAt)
    throw invalid(
      'Give the end as a time, like 2026-10-01T10:30 — or a full ISO time with its offset.',
      { endsAt: 'Use YYYY-MM-DDTHH:mm.' },
    )
  if (endsAt < startsAt)
    throw invalid('The event ends before it starts.', {
      endsAt: 'Choose an end after the start.',
    })
  return { allDay: false, startsAt, endsAt, timezone: zone }
}

/**
 * A stored event as a form shows it: all-day as its first and last day
 * (inclusive), timed as local `YYYY-MM-DDTHH:mm` in its own zone (or
 * `fallbackZone` when it has none).
 */
export function formValues(
  event: {
    allDay: boolean
    startsAt: Date
    endsAt: Date
    timezone: string | null
  },
  fallbackZone: string,
): { allDay: boolean; startsAt: string; endsAt: string; timezone: string } {
  const zone = event.timezone ?? fallbackZone
  if (event.allDay) {
    const { first, last } = allDayDates(event)
    return { allDay: true, startsAt: first, endsAt: last, timezone: zone }
  }
  return {
    allDay: false,
    startsAt: toLocalInput(event.startsAt, zone),
    endsAt: toLocalInput(event.endsAt, zone),
    timezone: zone,
  }
}
