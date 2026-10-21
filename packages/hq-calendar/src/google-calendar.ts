import type { Http } from '@theiceji/hq-core/google'
import { OpsError, reauthRequired } from '@theiceji/hq-ops/errors'
import { addDays, isDay, isValidTimeZone } from '@theiceji/hq-ops/time'
import { utcDay, utcMidnight } from './dates'

/**
 * The slice of Google Calendar API v3 the sync uses, over an injectable
 * `fetch` — never an SDK, and never a real Google in tests.
 *
 * · **Errors mean one thing each.** A 401 is retried once with a fresh token,
 *   then is `reauth_required`; 429, 5xx and Google's rate-limit 403s are
 *   `provider_unavailable` (try on the next tick); a 403 for missing scopes
 *   is `reauth_required`. Anything about one event — 404, 409, 410, 412, a
 *   refused change — is a `CalendarRefusal` the sync decides about.
 * · **No token ever reaches a message.** Google's own error text is clipped
 *   and scrubbed before it is kept.
 * · **Nobody is emailed.** Every write says `sendUpdates=none`: HQ never
 *   sends invitations or updates on the owner's behalf.
 *
 * The mapping between Google's JSON and HQ's row lives here too, pure, so
 * the round trip is tested without a database.
 */

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

/** Events per page — Google's maximum. */
export const PAGE_SIZE = 2500

/** Private extended properties HQ writes on the events it pushes. */
export const HQ_ID = 'hqId'
export const HQ_PROJECT = 'hqProject'

export type GoogleEventTime = {
  date?: string | null
  dateTime?: string | null
  timeZone?: string | null
}

export type GoogleEvent = {
  id: string
  status?: string
  etag?: string
  summary?: string
  description?: string
  location?: string
  start?: GoogleEventTime
  end?: GoogleEventTime
  updated?: string
  htmlLink?: string
  extendedProperties?: {
    private?: Record<string, string>
    shared?: Record<string, string>
  }
}

export type GoogleEventBody = {
  id?: string
  summary: string
  description: string
  location: string
  start: GoogleEventTime
  end: GoogleEventTime
  extendedProperties: { private: Record<string, string> }
}

export type EventPage = {
  items: GoogleEvent[]
  nextPageToken: string | null
  nextSyncToken: string | null
}

/** Google refused something about one event; `status` says what. */
export class CalendarRefusal extends Error {
  readonly status: number
  readonly reason: string | null

  constructor(status: number, reason: string | null, message: string) {
    super(message)
    this.name = 'CalendarRefusal'
    this.status = status
    this.reason = reason
  }
}

/** `fresh` asks for a newly minted token after Google refused the last one. */
export type TokenSource = (fresh: boolean) => Promise<string>

const RATE_LIMITS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
])

/** Google's words without anything that looks like a credential. */
export function scrub(message: string): string {
  return message
    .replace(/ya29\.[\w.-]+/g, '[token]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

async function problemOf(
  response: Response,
): Promise<{ reason: string | null; message: string }> {
  const body = (await response.json().catch(() => null)) as {
    error?: {
      message?: unknown
      status?: unknown
      errors?: { reason?: unknown }[]
    }
  } | null
  const reason = body?.error?.errors?.[0]?.reason
  const message = body?.error?.message
  return {
    reason:
      typeof reason === 'string'
        ? reason
        : typeof body?.error?.status === 'string'
          ? body.error.status
          : null,
    message:
      typeof message === 'string' && message.trim()
        ? scrub(message)
        : `Google answered ${response.status}.`,
  }
}

export type CalendarClient = {
  /** The calendar's real ID (the account's address for `primary`) and zone. */
  calendar(calendarId: string): Promise<{ id: string; timeZone: string | null }>
  /** One page: incremental with `syncToken`, else the `timeMin`–`timeMax` window. */
  list(
    calendarId: string,
    options: {
      syncToken?: string | null
      timeMin?: Date
      timeMax?: Date
      pageToken?: string | null
    },
  ): Promise<EventPage>
  /** One event, or null when Google has none by that ID. */
  get(calendarId: string, eventId: string): Promise<GoogleEvent | null>
  insert(calendarId: string, body: GoogleEventBody): Promise<GoogleEvent>
  /** Changes only what `body` names; `etag` makes it conditional (412 when stale). */
  patch(
    calendarId: string,
    eventId: string,
    body: GoogleEventBody,
    etag: string | null,
  ): Promise<GoogleEvent>
  /** False when the event was already gone. */
  remove(calendarId: string, eventId: string): Promise<boolean>
}

export function calendarClient(
  token: TokenSource,
  http: Http = fetch,
): CalendarClient {
  async function call(
    method: string,
    path: string,
    options: {
      query?: Record<string, string>
      body?: unknown
      headers?: Record<string, string>
    } = {},
  ): Promise<Response> {
    const query = options.query
      ? `?${new URLSearchParams(options.query).toString()}`
      : ''
    for (let attempt = 0; ; attempt++) {
      const access = await token(attempt > 0)
      let response: Response
      try {
        response = await http(`${CALENDAR_API}${path}${query}`, {
          method,
          headers: {
            authorization: `Bearer ${access}`,
            accept: 'application/json',
            ...(options.body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
            ...options.headers,
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        })
      } catch {
        throw new OpsError(
          'provider_unavailable',
          'Google Calendar couldn’t be reached. HQ tries again on the next sync.',
        )
      }
      if (response.ok) return response
      if (response.status === 401 && attempt === 0) continue
      if (response.status === 401)
        throw reauthRequired(
          'Google refused HQ’s calendar access. Reconnect Google in Settings › Google.',
        )
      const problem = await problemOf(response)
      if (
        response.status === 429 ||
        response.status >= 500 ||
        (response.status === 403 && RATE_LIMITS.has(problem.reason ?? ''))
      ) {
        const after = Number(response.headers.get('retry-after'))
        throw new OpsError(
          'provider_unavailable',
          `Google Calendar is busy (${response.status}). HQ tries again on the next sync.`,
          Number.isFinite(after) && after > 0
            ? { retryAfterSeconds: after }
            : {},
        )
      }
      if (
        response.status === 403 &&
        (problem.reason === 'insufficientPermissions' ||
          problem.reason === 'PERMISSION_DENIED' ||
          /insufficient authentication scopes/i.test(problem.message))
      )
        throw reauthRequired(
          'Google didn’t give HQ access to Calendar. Reconnect Google in Settings › Google and allow Calendar.',
        )
      throw new CalendarRefusal(
        response.status,
        problem.reason,
        problem.message,
      )
    }
  }

  const events = (calendarId: string) =>
    `/calendars/${encodeURIComponent(calendarId)}/events`
  const one = (calendarId: string, eventId: string) =>
    `${events(calendarId)}/${encodeURIComponent(eventId)}`
  const quiet = { sendUpdates: 'none' }

  return {
    async calendar(calendarId) {
      const response = await call(
        'GET',
        `/calendars/${encodeURIComponent(calendarId)}`,
      )
      const body = (await response.json()) as {
        id?: string
        timeZone?: string
      }
      return {
        id: body.id || calendarId,
        timeZone:
          body.timeZone && isValidTimeZone(body.timeZone)
            ? body.timeZone
            : null,
      }
    },

    async list(calendarId, options) {
      const query: Record<string, string> = {
        maxResults: String(PAGE_SIZE),
        singleEvents: 'true',
        showDeleted: 'true',
      }
      if (options.syncToken) query.syncToken = options.syncToken
      else {
        if (options.timeMin) query.timeMin = options.timeMin.toISOString()
        if (options.timeMax) query.timeMax = options.timeMax.toISOString()
      }
      if (options.pageToken) query.pageToken = options.pageToken
      const response = await call('GET', events(calendarId), { query })
      const body = (await response.json()) as {
        items?: GoogleEvent[]
        nextPageToken?: string
        nextSyncToken?: string
      }
      return {
        items: Array.isArray(body.items) ? body.items : [],
        nextPageToken: body.nextPageToken || null,
        nextSyncToken: body.nextSyncToken || null,
      }
    },

    async get(calendarId, eventId) {
      try {
        const response = await call('GET', one(calendarId, eventId))
        return (await response.json()) as GoogleEvent
      } catch (error) {
        if (
          error instanceof CalendarRefusal &&
          (error.status === 404 || error.status === 410)
        )
          return null
        throw error
      }
    },

    async insert(calendarId, body) {
      const response = await call('POST', events(calendarId), {
        query: quiet,
        body,
      })
      return (await response.json()) as GoogleEvent
    },

    async patch(calendarId, eventId, body, etag) {
      const response = await call('PATCH', one(calendarId, eventId), {
        query: quiet,
        body,
        headers: etag ? { 'if-match': etag } : {},
      })
      return (await response.json()) as GoogleEvent
    },

    async remove(calendarId, eventId) {
      try {
        await call('DELETE', one(calendarId, eventId), { query: quiet })
        return true
      } catch (error) {
        if (
          error instanceof CalendarRefusal &&
          (error.status === 404 || error.status === 410)
        )
          return false
        throw error
      }
    },
  }
}

/* ── Google's JSON ↔ HQ's row ──────────────────────────────────────── */

/** What an event is, whichever side wrote it. */
export type EventContent = {
  title: string
  description: string
  location: string | null
  allDay: boolean
  startsAt: Date
  endsAt: Date
  timezone: string | null
}

export type PulledEvent =
  | { kind: 'cancelled'; googleEventId: string }
  | { kind: 'skip'; googleEventId: string; reason: string }
  | ({
      kind: 'event'
      googleEventId: string
      /** The HQ row this event was pushed from, when HQ made it. */
      hqId: string | null
      /** HQ's project tag: a slug, `null` for "none", `undefined` when Google has no word. */
      hqProject: string | null | undefined
      etag: string | null
      googleUpdatedAt: Date | null
      htmlLink: string | null
    } & EventContent)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The title HQ shows for an event Google has none for. */
export const UNTITLED = '(No title)'

function titleOf(summary: string | undefined): string {
  return (summary ?? '').trim().slice(0, 200).trim() || UNTITLED
}

function instant(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * One item of an events list as HQ reads it. A cancelled item may carry
 * nothing but its ID; an item whose times can't be read is skipped, never
 * guessed. A timed event without a zone of its own takes the calendar's.
 */
export function fromGoogle(
  item: GoogleEvent,
  calendarZone: string | null,
): PulledEvent {
  if (item.status === 'cancelled')
    return { kind: 'cancelled', googleEventId: item.id }
  const extra = item.extendedProperties?.private ?? {}
  const hqId = typeof extra[HQ_ID] === 'string' && UUID.test(extra[HQ_ID])
  const project = extra[HQ_PROJECT]
  const common = {
    kind: 'event' as const,
    googleEventId: item.id,
    hqId: hqId ? (extra[HQ_ID] as string).toLowerCase() : null,
    hqProject: typeof project === 'string' ? project.trim() || null : undefined,
    etag: item.etag ?? null,
    googleUpdatedAt: instant(item.updated),
    htmlLink: item.htmlLink ?? null,
    title: titleOf(item.summary),
    description: (item.description ?? '').slice(0, 8000),
    location: item.location?.trim() || null,
  }
  const startDay = item.start?.date
  if (startDay) {
    if (!isDay(startDay))
      return {
        kind: 'skip',
        googleEventId: item.id,
        reason: 'unreadable date',
      }
    const endDay = item.end?.date
    const last =
      endDay && isDay(endDay) && endDay > startDay
        ? endDay
        : addDays(startDay, 1)
    return {
      ...common,
      allDay: true,
      startsAt: utcMidnight(startDay),
      endsAt: utcMidnight(last),
      timezone: null,
    }
  }
  const startsAt = instant(item.start?.dateTime)
  if (!startsAt)
    return { kind: 'skip', googleEventId: item.id, reason: 'unreadable time' }
  const end = instant(item.end?.dateTime)
  const zone = item.start?.timeZone ?? calendarZone
  return {
    ...common,
    allDay: false,
    startsAt,
    endsAt: end && end >= startsAt ? end : startsAt,
    timezone: zone && isValidTimeZone(zone) ? zone : null,
  }
}

/**
 * What HQ sends for an event. A patch names every field it owns, with
 * nulls clearing what the other kind of time left behind — so a timed event
 * turned all-day loses its `dateTime`; an insert leaves the nulls out.
 * Attendees, reminders and colours are never sent, so a patch keeps them.
 */
export function toGoogle(
  event: EventContent & { id: string },
  projectSlug: string | null,
  mode: 'insert' | 'patch',
): GoogleEventBody {
  const clear = mode === 'patch'
  const time = (at: Date): GoogleEventTime =>
    event.allDay
      ? {
          date: utcDay(at),
          ...(clear ? { dateTime: null, timeZone: null } : {}),
        }
      : {
          dateTime: at.toISOString(),
          ...(event.timezone
            ? { timeZone: event.timezone }
            : clear
              ? { timeZone: null }
              : {}),
          ...(clear ? { date: null } : {}),
        }
  return {
    summary: event.title,
    description: event.description,
    location: event.location ?? '',
    start: time(event.startsAt),
    end: time(event.endsAt),
    extendedProperties: {
      private: { [HQ_ID]: event.id, [HQ_PROJECT]: projectSlug ?? '' },
    },
  }
}

/**
 * The ID HQ gives Google for an event it inserts: the row and its revision in
 * Google's alphabet (base32hex: `0-9a-v`). Retrying an insert whose answer
 * was lost gets 409 instead of a second copy; an event taken off Google and
 * put back later is a new revision, so a new ID.
 */
export function googleEventIdFor(event: {
  id: string
  revision: number
}): string {
  return `hq${event.id.replace(/-/g, '').toLowerCase()}v${event.revision}`
}
