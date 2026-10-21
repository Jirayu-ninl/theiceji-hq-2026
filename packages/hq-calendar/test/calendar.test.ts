import { describe, expect, test } from 'bun:test'
import {
  allDayDates,
  allDayLength,
  allDaySpan,
  eventDays,
  formValues,
  monthGrid,
  resolveWhen,
  weekRange,
} from '../src/dates'
import {
  CalendarRefusal,
  calendarClient,
  fromGoogle,
  googleEventIdFor,
  scrub,
  toGoogle,
  UNTITLED,
} from '../src/google-calendar'
import { TOKEN } from './fake-calendar'

/**
 * The pure parts of Calendar — date math, reading times from people and
 * tools, the Google JSON ↔ row mapping and the client's error vocabulary.
 * They need no database and always run.
 */

type Failure = {
  code?: string
  message: string
  fields?: Record<string, string>
}

function thrown(work: () => unknown): Failure {
  try {
    work()
  } catch (error) {
    return error as Failure
  }
  throw new Error('Expected this call to fail.')
}

async function rejected(
  work: Promise<unknown>,
): Promise<Failure & { status?: number }> {
  try {
    await work
  } catch (error) {
    return error as Failure & { status?: number }
  }
  throw new Error('Expected this call to fail.')
}

const iso = (date: Date) => date.toISOString()

describe('all-day dates', () => {
  test('the last day is inclusive in, exclusive when stored', () => {
    const span = allDaySpan('2026-10-05', '2026-10-07')
    expect(iso(span.startsAt)).toBe('2026-10-05T00:00:00.000Z')
    expect(iso(span.endsAt)).toBe('2026-10-08T00:00:00.000Z')
    expect(allDayDates(span)).toEqual({
      first: '2026-10-05',
      last: '2026-10-07',
    })
    expect(allDayLength(span)).toBe(3)
  })

  test('month, year and leap-day edges', () => {
    expect(iso(allDaySpan('2026-01-31', '2026-01-31').endsAt)).toBe(
      '2026-02-01T00:00:00.000Z',
    )
    expect(iso(allDaySpan('2026-12-31', '2026-12-31').endsAt)).toBe(
      '2027-01-01T00:00:00.000Z',
    )
    expect(iso(allDaySpan('2028-02-28', '2028-02-29').endsAt)).toBe(
      '2028-03-01T00:00:00.000Z',
    )
    expect(
      allDayDates({
        startsAt: new Date('2026-12-30T00:00:00Z'),
        endsAt: new Date('2027-01-02T00:00:00Z'),
      }),
    ).toEqual({ first: '2026-12-30', last: '2027-01-01' })
    expect(
      thrown(() => allDaySpan('2027-02-29', '2027-02-29')).message,
    ).toContain('Not a day')
  })

  test('an all-day event never moves with a zone', () => {
    const event = { allDay: true, ...allDaySpan('2026-10-05', '2026-10-05') }
    expect(eventDays(event, 'America/Los_Angeles')).toEqual({
      first: '2026-10-05',
      last: '2026-10-05',
    })
    expect(eventDays(event, 'Pacific/Kiritimati')).toEqual({
      first: '2026-10-05',
      last: '2026-10-05',
    })
  })

  test('a timed event covers the days of its zone, and midnight doesn’t spill', () => {
    const late = {
      allDay: false,
      startsAt: new Date('2026-10-05T16:00:00Z'), // 23:00 in Bangkok
      endsAt: new Date('2026-10-05T18:00:00Z'), // 01:00 the next day
    }
    expect(eventDays(late, 'Asia/Bangkok')).toEqual({
      first: '2026-10-05',
      last: '2026-10-06',
    })
    const toMidnight = { ...late, endsAt: new Date('2026-10-05T17:00:00Z') }
    expect(eventDays(toMidnight, 'Asia/Bangkok')).toEqual({
      first: '2026-10-05',
      last: '2026-10-05',
    })
  })
})

describe('weeks and months', () => {
  test('weeks run Monday to Sunday, across a year’s end, bounded in the zone', () => {
    const week = weekRange('2026-12-31', 'Asia/Bangkok')
    expect(week.from).toBe('2026-12-28')
    expect(week.to).toBe('2027-01-03')
    expect(iso(week.start)).toBe('2026-12-27T17:00:00.000Z')
    expect(iso(week.end)).toBe('2027-01-03T17:00:00.000Z')
    expect(weekRange('2026-10-05', 'Asia/Bangkok').from).toBe('2026-10-05')
    expect(weekRange('2026-10-04', 'Asia/Bangkok').from).toBe('2026-09-28')
  })

  test('a month view is whole weeks around the month', () => {
    const grid = monthGrid('2026-02-14', 'Asia/Bangkok')
    expect(grid.month).toEqual({ first: '2026-02-01', last: '2026-02-28' })
    expect(grid.from).toBe('2026-01-26')
    expect(grid.to).toBe('2026-03-01')
    expect(monthGrid('2028-02-10', 'UTC').month.last).toBe('2028-02-29')
  })
})

describe('reading an event’s time', () => {
  test('a bare date is all-day; the last day defaults to the first', () => {
    const when = resolveWhen({ startsAt: '2026-10-05' }, 'Asia/Bangkok')
    expect(when.allDay).toBe(true)
    expect(when.timezone).toBeNull()
    expect(iso(when.endsAt)).toBe('2026-10-06T00:00:00.000Z')
    const three = resolveWhen(
      { startsAt: '2026-10-05', endsAt: '2026-10-07' },
      'Asia/Bangkok',
    )
    expect(iso(three.endsAt)).toBe('2026-10-08T00:00:00.000Z')
  })

  test('local time is read in the zone; an offset is taken as written', () => {
    const local = resolveWhen({ startsAt: '2026-10-05T09:30' }, 'Asia/Bangkok')
    expect(local.allDay).toBe(false)
    expect(iso(local.startsAt)).toBe('2026-10-05T02:30:00.000Z')
    expect(iso(local.endsAt)).toBe('2026-10-05T03:30:00.000Z')
    expect(local.timezone).toBe('Asia/Bangkok')
    const offset = resolveWhen(
      {
        startsAt: '2026-10-05T09:30:00+09:00',
        endsAt: '2026-10-05T10:00:00+09:00',
        timezone: 'Asia/Tokyo',
      },
      'Asia/Bangkok',
    )
    expect(iso(offset.startsAt)).toBe('2026-10-05T00:30:00.000Z')
    expect(offset.timezone).toBe('Asia/Tokyo')
  })

  test('mistakes name the field to fix', () => {
    expect(
      thrown(() =>
        resolveWhen(
          { startsAt: '2026-10-05T10:00', endsAt: '2026-10-05T09:00' },
          'Asia/Bangkok',
        ),
      ).fields,
    ).toEqual({ endsAt: 'Choose an end after the start.' })
    expect(
      thrown(() =>
        resolveWhen({ startsAt: '2026-10-07', endsAt: '2026-10-05' }, 'UTC'),
      ).message,
    ).toBe('The last day is before the first.')
    expect(
      thrown(() =>
        resolveWhen({ allDay: true, startsAt: '2026-10-05T09:00' }, 'UTC'),
      ).code,
    ).toBe('invalid')
    expect(
      thrown(() =>
        resolveWhen(
          { startsAt: '2026-10-05T09:00', timezone: 'Mars/Base' },
          'UTC',
        ),
      ).fields,
    ).toHaveProperty('timezone')
    // 02:30 doesn't exist in New York on the morning clocks go forward.
    expect(
      thrown(() =>
        resolveWhen({ startsAt: '2026-03-08T02:30' }, 'America/New_York'),
      ).fields,
    ).toHaveProperty('startsAt')
    expect(
      thrown(() => resolveWhen({ startsAt: '2027-02-29' }, 'UTC')).fields,
    ).toHaveProperty('startsAt')
  })

  test('a stored event goes back to what a form shows', () => {
    expect(
      formValues(
        {
          allDay: true,
          timezone: null,
          ...allDaySpan('2026-10-05', '2026-10-06'),
        },
        'Asia/Bangkok',
      ),
    ).toEqual({
      allDay: true,
      startsAt: '2026-10-05',
      endsAt: '2026-10-06',
      timezone: 'Asia/Bangkok',
    })
    expect(
      formValues(
        {
          allDay: false,
          timezone: 'Asia/Bangkok',
          startsAt: new Date('2026-10-05T02:30:00Z'),
          endsAt: new Date('2026-10-05T03:30:00Z'),
        },
        'UTC',
      ),
    ).toEqual({
      allDay: false,
      startsAt: '2026-10-05T09:30',
      endsAt: '2026-10-05T10:30',
      timezone: 'Asia/Bangkok',
    })
  })
})

describe('Google’s JSON and HQ’s row', () => {
  test('a timed event keeps its instants and its zone', () => {
    const read = fromGoogle(
      {
        id: 'abc123',
        etag: '"e1"',
        summary: '  Client call  ',
        location: 'Zoom',
        start: {
          dateTime: '2026-10-05T09:30:00+07:00',
          timeZone: 'Asia/Bangkok',
        },
        end: {
          dateTime: '2026-10-05T10:30:00+07:00',
          timeZone: 'Asia/Bangkok',
        },
        updated: '2026-09-26T00:00:01.000Z',
        htmlLink: 'https://www.google.com/calendar/event?eid=abc123',
      },
      'UTC',
    )
    if (read.kind !== 'event') throw new Error(read.kind)
    expect(read.title).toBe('Client call')
    expect(read.allDay).toBe(false)
    expect(iso(read.startsAt)).toBe('2026-10-05T02:30:00.000Z')
    expect(read.timezone).toBe('Asia/Bangkok')
    expect(read.hqId).toBeNull()
    expect(read.hqProject).toBeUndefined()
    expect(read.etag).toBe('"e1"')
  })

  test('an all-day event keeps its dates; a missing end is one day', () => {
    const read = fromGoogle(
      {
        id: 'd1',
        summary: 'Retreat',
        start: { date: '2026-12-31' },
        end: { date: '2027-01-02' },
      },
      'Asia/Bangkok',
    )
    if (read.kind !== 'event') throw new Error(read.kind)
    expect(read.allDay).toBe(true)
    expect(allDayDates(read)).toEqual({
      first: '2026-12-31',
      last: '2027-01-01',
    })
    expect(read.timezone).toBeNull()
    const open = fromGoogle(
      { id: 'd2', summary: 'x', start: { date: '2026-10-05' } },
      null,
    )
    if (open.kind !== 'event') throw new Error(open.kind)
    expect(iso(open.endsAt)).toBe('2026-10-06T00:00:00.000Z')
  })

  test('HQ’s own marks, untitled events, long titles, cancelled and unreadable items', () => {
    const hqId = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const read = fromGoogle(
      {
        id: 'hq1',
        summary: '',
        start: { dateTime: '2026-10-05T09:00:00Z' },
        end: { dateTime: '2026-10-05T08:00:00Z' },
        extendedProperties: { private: { hqId, hqProject: 'pilot' } },
      },
      'Asia/Bangkok',
    )
    if (read.kind !== 'event') throw new Error(read.kind)
    expect(read.title).toBe(UNTITLED)
    expect(read.hqId).toBe(hqId)
    expect(read.hqProject).toBe('pilot')
    expect(read.timezone).toBe('Asia/Bangkok')
    expect(read.endsAt.getTime()).toBe(read.startsAt.getTime())
    const cleared = fromGoogle(
      {
        id: 'hq2',
        summary: 'x'.repeat(300),
        start: { date: '2026-10-05' },
        extendedProperties: { private: { hqId: 'not-a-uuid', hqProject: '' } },
      },
      null,
    )
    if (cleared.kind !== 'event') throw new Error(cleared.kind)
    expect(cleared.title).toHaveLength(200)
    expect(cleared.hqId).toBeNull()
    expect(cleared.hqProject).toBeNull()
    expect(fromGoogle({ id: 'c1', status: 'cancelled' }, null)).toEqual({
      kind: 'cancelled',
      googleEventId: 'c1',
    })
    expect(
      fromGoogle({ id: 'bad', start: { dateTime: 'soon' } }, null).kind,
    ).toBe('skip')
  })

  test('what HQ sends: dates for all-day, instants with a zone, nulls only in a patch', () => {
    const allDay = {
      id: '0f8fad5b-d9cb-469f-a165-70867728950e',
      title: 'Shoot',
      description: '',
      location: null,
      allDay: true,
      timezone: null,
      ...allDaySpan('2026-10-05', '2026-10-06'),
    }
    const inserted = toGoogle(allDay, 'pilot', 'insert')
    expect(inserted.start).toEqual({ date: '2026-10-05' })
    expect(inserted.end).toEqual({ date: '2026-10-07' })
    expect(inserted.location).toBe('')
    expect(inserted.extendedProperties.private).toEqual({
      hqId: allDay.id,
      hqProject: 'pilot',
    })
    const patched = toGoogle(allDay, null, 'patch')
    expect(patched.start).toEqual({
      date: '2026-10-05',
      dateTime: null,
      timeZone: null,
    })
    expect(patched.extendedProperties.private.hqProject).toBe('')
    const timed = toGoogle(
      {
        ...allDay,
        allDay: false,
        timezone: 'Asia/Bangkok',
        startsAt: new Date('2026-10-05T02:30:00Z'),
        endsAt: new Date('2026-10-05T03:30:00Z'),
      },
      null,
      'patch',
    )
    expect(timed.start).toEqual({
      dateTime: '2026-10-05T02:30:00.000Z',
      timeZone: 'Asia/Bangkok',
      date: null,
    })
    // What HQ sends reads back as the same event.
    const back = fromGoogle(
      { id: 'x1', ...toGoogle(allDay, 'pilot', 'insert') },
      'Asia/Bangkok',
    )
    if (back.kind !== 'event') throw new Error(back.kind)
    expect(allDayDates(back)).toEqual({
      first: '2026-10-05',
      last: '2026-10-06',
    })
    expect(back.hqId).toBe(allDay.id)
  })

  test('HQ’s Google IDs are in Google’s alphabet and change with the revision', () => {
    const id = googleEventIdFor({
      id: '0F8FAD5B-D9CB-469F-A165-70867728950E',
      revision: 3,
    })
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/)
    expect(id).toBe('hq0f8fad5bd9cb469fa16570867728950ev3')
    expect(
      googleEventIdFor({
        id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        revision: 4,
      }),
    ).not.toBe(id)
  })
})

describe('the Calendar client', () => {
  function stub(answers: (Response | (() => Response))[]) {
    const seen: { url: string; init: RequestInit }[] = []
    const http = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push({ url: String(input), init })
      const next = answers.shift()
      if (!next) throw new Error('no more answers')
      return typeof next === 'function' ? next() : next
    }) as unknown as typeof fetch
    return { http, seen }
  }
  const error = (status: number, reason: string, message = 'x') =>
    new Response(
      JSON.stringify({
        error: { code: status, message, errors: [{ reason }] },
      }),
      { status },
    )
  const tokens: boolean[] = []
  const token = async (fresh: boolean) => {
    tokens.push(fresh)
    return TOKEN
  }

  test('a 401 is retried once with a fresh token, then is reauth_required without the token', async () => {
    tokens.length = 0
    const { http } = stub([
      error(401, 'authError'),
      error(401, 'authError', `Bearer ${TOKEN} refused`),
    ])
    const failure = await rejected(
      calendarClient(token, http).calendar('primary'),
    )
    expect(failure.code).toBe('reauth_required')
    expect(failure.message).not.toContain(TOKEN)
    expect(tokens).toEqual([false, true])
  })

  test('busy is provider_unavailable; missing scopes are reauth_required; the rest is a refusal', async () => {
    const busy = await rejected(
      calendarClient(
        token,
        stub([error(429, 'rateLimitExceeded')]).http,
      ).calendar('primary'),
    )
    expect(busy.code).toBe('provider_unavailable')
    const limited = await rejected(
      calendarClient(
        token,
        stub([error(403, 'userRateLimitExceeded')]).http,
      ).calendar('primary'),
    )
    expect(limited.code).toBe('provider_unavailable')
    const down = await rejected(
      calendarClient(
        token,
        stub([new Response('', { status: 503 })]).http,
      ).calendar('primary'),
    )
    expect(down.code).toBe('provider_unavailable')
    const scopes = await rejected(
      calendarClient(
        token,
        stub([error(403, 'insufficientPermissions')]).http,
      ).calendar('primary'),
    )
    expect(scopes.code).toBe('reauth_required')
    const stale = await rejected(
      calendarClient(token, stub([error(412, 'conditionNotMet')]).http).patch(
        'primary',
        'e1',
        toGoogle(
          {
            id: 'x',
            title: 't',
            description: '',
            location: null,
            allDay: true,
            timezone: null,
            ...allDaySpan('2026-10-05', '2026-10-05'),
          },
          null,
          'patch',
        ),
        '"e0"',
      ),
    )
    expect(stale).toBeInstanceOf(CalendarRefusal)
    expect(stale.status).toBe(412)
    const unreachable = await rejected(
      calendarClient(token, (async () => {
        throw new Error(`connect ECONNREFUSED ${TOKEN}`)
      }) as unknown as typeof fetch).calendar('primary'),
    )
    expect(unreachable.code).toBe('provider_unavailable')
    expect(unreachable.message).not.toContain(TOKEN)
  })

  test('a list is single events with deletions; a sync token replaces the window', async () => {
    const page = () =>
      new Response(JSON.stringify({ items: [], nextSyncToken: 's1' }), {
        status: 200,
      })
    const { http, seen } = stub([page, page])
    const client = calendarClient(token, http)
    const first = await client.list('owner@module.test', {
      timeMin: new Date('2026-08-01T00:00:00Z'),
      timeMax: new Date('2027-09-01T00:00:00Z'),
    })
    expect(first.nextSyncToken).toBe('s1')
    const windowed = new URL(seen[0]?.url as string)
    expect(windowed.pathname).toBe(
      '/calendar/v3/calendars/owner%40module.test/events',
    )
    expect(windowed.searchParams.get('singleEvents')).toBe('true')
    expect(windowed.searchParams.get('showDeleted')).toBe('true')
    expect(windowed.searchParams.get('maxResults')).toBe('2500')
    expect(windowed.searchParams.get('timeMin')).toBe(
      '2026-08-01T00:00:00.000Z',
    )
    await client.list('primary', { syncToken: 's1', timeMin: new Date() })
    const incremental = new URL(seen[1]?.url as string)
    expect(incremental.searchParams.get('syncToken')).toBe('s1')
    expect(incremental.searchParams.get('timeMin')).toBeNull()
  })

  test('writes never email anyone, and a patch is conditional', async () => {
    const ok = () =>
      new Response(JSON.stringify({ id: 'e1', etag: '"e2"' }), { status: 200 })
    const { http, seen } = stub([
      ok,
      ok,
      () => new Response(null, { status: 204 }),
      error(410, 'deleted'),
    ])
    const client = calendarClient(token, http)
    const body = toGoogle(
      {
        id: 'x',
        title: 't',
        description: '',
        location: null,
        allDay: true,
        timezone: null,
        ...allDaySpan('2026-10-05', '2026-10-05'),
      },
      null,
      'insert',
    )
    await client.insert('primary', body)
    await client.patch('primary', 'e1', body, '"e1"')
    expect(await client.remove('primary', 'e1')).toBe(true)
    expect(await client.remove('primary', 'e1')).toBe(false)
    for (const call of seen)
      expect(new URL(call.url).searchParams.get('sendUpdates')).toBe('none')
    expect(new Headers(seen[1]?.init.headers).get('if-match')).toBe('"e1"')
  })

  test('Google’s words are kept without anything like a credential', () => {
    expect(scrub(`Bad token ya29.a0AfH6SMB-xyz and Bearer abc.def`)).toBe(
      'Bad token [token] and Bearer [token]',
    )
  })
})
