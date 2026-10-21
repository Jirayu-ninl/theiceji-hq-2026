import type { GoogleEvent } from '../src/google-calendar'

/**
 * An in-memory stand-in for the slice of Google Calendar API v3 (and the
 * OAuth token endpoint) the sync uses. It records every request and answers
 * the way Google does: windowed and incremental lists with sync tokens and
 * paging, 410 for a forgotten token, inserts under a caller's ID (409 when
 * taken), patches with `If-Match` (412 when stale), deletes that leave a
 * cancelled event behind, and 401 for any other token. Anything it doesn't
 * know is a 501, so a test fails loudly instead of passing by luck.
 * `override` answers first — for errors and races.
 */

export const TOKEN = 'ya29.calendar-test-token-never-in-messages'
export const EMAIL = 'owner@module.test'

export type Recorded = {
  method: string
  url: URL
  headers: Headers
  body: Record<string, unknown> | null
}

export type SimEvent = GoogleEvent & {
  id: string
  status: string
  etag: string
  updated: string
  /** The change counter when it last changed. */
  seq: number
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function googleError(status: number, reason: string, message = 'x') {
  return json(
    { error: { code: status, message, errors: [{ reason }] } },
    status,
  )
}

const ID = /^[a-v0-9]{5,1024}$/

function span(event: SimEvent): { start: number; end: number } {
  const at = (time: GoogleEvent['start']) =>
    new Date(
      time?.dateTime ?? (time?.date ? `${time.date}T00:00:00Z` : 0),
    ).getTime()
  return { start: at(event.start), end: at(event.end) }
}

function withoutNulls<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null),
  ) as T
}

export function fakeCalendar(
  options: {
    email?: string
    timeZone?: string
    pageSize?: number
    /** Google hands out no `nextSyncToken` — the sync must stay windowed. */
    noSyncToken?: boolean
    override?: (req: Recorded) => Response | undefined
  } = {},
) {
  const email = options.email ?? EMAIL
  const events = new Map<string, SimEvent>()
  const tokens = new Map<string, number>()
  const requests: Recorded[] = []
  let seq = 0
  let issued = 0
  let made = 0

  function touch(event: SimEvent): SimEvent {
    seq++
    event.seq = seq
    event.etag = `"e${seq}"`
    event.updated = new Date(Date.UTC(2026, 8, 26, 0, 0, seq)).toISOString()
    event.htmlLink = `https://www.google.com/calendar/event?eid=${event.id}`
    return event
  }

  /** An event made in Google itself (the owner's phone, an invitation). */
  function add(
    event: Omit<GoogleEvent, 'id'> & { id?: string; summary: string },
  ): SimEvent {
    const id = event.id ?? `g${String(++made).padStart(6, '0')}`
    const sim = touch({
      ...event,
      id,
      status: 'confirmed',
      etag: '',
      updated: '',
      seq: 0,
    })
    events.set(id, sim)
    return sim
  }

  /** A change made in Google. */
  function edit(id: string, patch: Partial<GoogleEvent>): SimEvent {
    const event = events.get(id)
    if (!event) throw new Error(`no event ${id}`)
    Object.assign(event, patch)
    return touch(event)
  }

  /** Deleted in Google: a cancelled event stays behind for sync tokens. */
  function cancel(id: string): void {
    const event = events.get(id)
    if (!event) throw new Error(`no event ${id}`)
    event.status = 'cancelled'
    touch(event)
  }

  /** Google forgets every sync token it handed out. */
  function expireTokens(): void {
    tokens.clear()
  }

  function list(url: URL): Response {
    const params = url.searchParams
    const syncToken = params.get('syncToken')
    const pageToken = params.get('pageToken')
    const size = Math.min(
      options.pageSize ?? 2500,
      Number(params.get('maxResults') ?? 250),
    )
    let since = 0
    if (syncToken) {
      const at = tokens.get(syncToken)
      if (at === undefined)
        return googleError(
          410,
          'fullSyncRequired',
          'Sync token is no longer valid, a full sync is required.',
        )
      since = at
    }
    const [offset, until] = pageToken
      ? pageToken.split(':').slice(1).map(Number)
      : [0, seq]
    const min = params.get('timeMin')
    const max = params.get('timeMax')
    const matching = [...events.values()]
      .filter((event) => event.seq <= (until as number))
      .filter((event) => (syncToken ? event.seq > since : true))
      .filter(
        (event) =>
          syncToken ||
          params.get('showDeleted') === 'true' ||
          event.status !== 'cancelled',
      )
      .filter((event) => {
        if (syncToken || !min || !max) return true
        const { start, end } = span(event)
        return start < new Date(max).getTime() && end > new Date(min).getTime()
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    const from = offset as number
    const page = matching.slice(from, from + size)
    const more = from + size < matching.length
    let nextSyncToken: string | undefined
    if (!more && !options.noSyncToken) {
      nextSyncToken = `sync-${++issued}`
      tokens.set(nextSyncToken, until as number)
    }
    return json({
      kind: 'calendar#events',
      items: page.map((event) => {
        const { seq: _seq, ...rest } = event
        return event.status === 'cancelled'
          ? { id: event.id, status: 'cancelled', etag: event.etag }
          : rest
      }),
      ...(more ? { nextPageToken: `p:${from + size}:${until}` } : {}),
      ...(nextSyncToken ? { nextSyncToken } : {}),
    })
  }

  function plain(event: SimEvent) {
    const { seq: _seq, ...rest } = event
    return rest
  }

  function route(req: Recorded): Response {
    const { method, url } = req
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token')
      return json({
        access_token: TOKEN,
        expires_in: 3600,
        token_type: 'Bearer',
      })
    if (url.hostname !== 'www.googleapis.com')
      return json({ error: 'unknown host' }, 501)
    if (req.headers.get('authorization') !== `Bearer ${TOKEN}`)
      return googleError(401, 'authError', 'Invalid Credentials')
    const parts = url.pathname
      .replace(/^\/calendar\/v3\/calendars\//, '')
      .split('/')
      .map(decodeURIComponent)
    const [calendar, collection, eventId] = parts
    if (calendar !== 'primary' && calendar !== email)
      return googleError(404, 'notFound', 'Not Found')
    if (parts.length === 1 && method === 'GET')
      return json({
        kind: 'calendar#calendar',
        id: email,
        timeZone: options.timeZone ?? 'Asia/Bangkok',
      })
    if (collection !== 'events') return json({ error: 'unknown path' }, 501)
    if (!eventId && method === 'GET') return list(url)
    if (!eventId && method === 'POST') {
      const body = req.body ?? {}
      const id = typeof body.id === 'string' ? body.id : `g${++made}x`
      if (!ID.test(id))
        return googleError(400, 'invalid', 'Invalid resource id value.')
      if (events.has(id))
        return googleError(
          409,
          'duplicate',
          'The requested identifier already exists.',
        )
      const sim = touch({
        ...(withoutNulls(body) as unknown as GoogleEvent),
        start: withoutNulls((body.start ?? {}) as Record<string, unknown>),
        end: withoutNulls((body.end ?? {}) as Record<string, unknown>),
        id,
        status: 'confirmed',
        etag: '',
        updated: '',
        seq: 0,
      })
      events.set(id, sim)
      return json(plain(sim))
    }
    const event = eventId ? events.get(eventId) : undefined
    if (!event) return googleError(404, 'notFound', 'Not Found')
    if (method === 'GET') return json(plain(event))
    if (method === 'DELETE') {
      if (event.status === 'cancelled')
        return googleError(410, 'deleted', 'Resource has been deleted')
      event.status = 'cancelled'
      touch(event)
      return new Response(null, { status: 204 })
    }
    if (method === 'PATCH') {
      if (event.status === 'cancelled')
        return googleError(410, 'deleted', 'Resource has been deleted')
      const match = req.headers.get('if-match')
      if (match && match !== event.etag)
        return googleError(412, 'conditionNotMet', 'Precondition Failed')
      for (const [key, value] of Object.entries(req.body ?? {})) {
        const target = event as unknown as Record<string, unknown>
        if (value === null) delete target[key]
        else if (key === 'start' || key === 'end')
          target[key] = withoutNulls(value as Record<string, unknown>)
        else if (key === 'extendedProperties') {
          const incoming = (value as { private?: Record<string, string> })
            .private
          event.extendedProperties = {
            ...event.extendedProperties,
            private: { ...event.extendedProperties?.private, ...incoming },
          }
        } else target[key] = value
      }
      touch(event)
      return json(plain(event))
    }
    return json({ error: 'unknown method' }, 501)
  }

  const fetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const text = typeof init.body === 'string' ? init.body : ''
    let body: Record<string, unknown> | null = null
    if (text && url.hostname === 'www.googleapis.com')
      body = JSON.parse(text) as Record<string, unknown>
    const req: Recorded = {
      method: init.method ?? 'GET',
      url,
      headers: new Headers(init.headers),
      body,
    }
    requests.push(req)
    return options.override?.(req) ?? route(req)
  }

  /** Requests to the Calendar API only (no token calls), optionally one method. */
  function calls(method?: string): Recorded[] {
    return requests.filter(
      (req) =>
        req.url.hostname === 'www.googleapis.com' &&
        (!method || req.method === method),
    )
  }

  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    events,
    requests,
    calls,
    add,
    edit,
    cancel,
    expireTokens,
    /** Events Google shows (not cancelled). */
    live: () =>
      [...events.values()].filter((event) => event.status !== 'cancelled'),
  }
}
