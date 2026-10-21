import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { forgetGoogleTokens, GOOGLE_SCOPES } from '@theiceji/hq-core/google'
import { searchHq } from '@theiceji/hq-core/search'
import { createTarget } from '@theiceji/hq-core/targets'
import {
  type CalendarEventRow,
  calendarEvents,
  calendarSyncState,
  googleConnections,
  opsAuditEvents,
  opsSchedulerLeases,
} from '@theiceji/hq-db/schema'
import { seal } from '@theiceji/hq-ops/secrets'
import { withTransaction } from '@theiceji/hq-ops/store'
import {
  allowAgent,
  closeTestDb,
  dbTestsEnabled,
  failure,
  makeProject,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import { eq, sql } from 'drizzle-orm'
import { allDayDates } from '../src/dates'
import {
  calendarStatus,
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  restoreEvent,
  retryEventSync,
  updateEvent,
} from '../src/events'
import { googleEventIdFor } from '../src/google-calendar'
import {
  calendarTick,
  dueCalendarOwners,
  type SyncOptions,
  syncNow,
  syncOwnerCalendar,
} from '../src/sync'
import '../src/register'
import {
  EMAIL,
  fakeCalendar,
  googleError,
  type Recorded,
  TOKEN,
} from './fake-calendar'

/**
 * Calendar against Postgres and an in-memory Google Calendar
 * (fake-calendar.ts). Destructive (truncates), so it runs only with
 * CALENDAR_DB_TESTS=1 and a localhost DATABASE_URL — a throwaway database.
 * Nothing here reaches Google.
 */

const suite = dbTestsEnabled('CALENDAR_DB_TESTS') ? describe : describe.skip
const TABLES = ['calendar_events', 'calendar_sync_state']
/** The read window's "now": 60 days back is 2026-07-28, a year ahead 2027-09-26. */
const NOW = new Date('2026-09-26T03:00:00Z')

suite('hq-calendar against Postgres', () => {
  let w: World
  let fake: ReturnType<typeof fakeCalendar>
  let hook: ((req: Recorded) => Response | undefined) | undefined

  beforeAll(() => {
    process.env.HQ_SEALING_KEY = randomBytes(32).toString('base64')
    process.env.GOOGLE_OAUTH_CLIENT_ID =
      'test-client.apps.googleusercontent.com'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret'
  })

  beforeEach(async () => {
    w = await resetWorld(TABLES)
    forgetGoogleTokens()
    hook = undefined
    fake = fakeCalendar({ override: (req) => hook?.(req) })
  })

  afterAll(() => closeTestDb(TABLES))

  async function connect(scopes: readonly string[] = GOOGLE_SCOPES) {
    await w.db.insert(googleConnections).values({
      ownerId: w.owner.userId,
      email: EMAIL,
      scopes: [...scopes],
      refreshTokenSealed: seal('refresh-token-test'),
      calendarId: 'primary',
      status: 'connected',
    })
  }
  const sync = (options: SyncOptions = {}) =>
    syncOwnerCalendar(w.owner.userId, {
      http: fake.fetch,
      now: NOW,
      ...options,
    })
  const rows = () => w.db.select().from(calendarEvents)
  async function row(id: string): Promise<CalendarEventRow> {
    const [found] = await w.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, id))
    if (!found) throw new Error(`no event ${id}`)
    return found
  }
  const lists = () =>
    fake.calls('GET').filter((req) => req.url.pathname.endsWith('/events'))
  const timed = (local: string, hours = 1) => {
    const start = new Date(`${local}:00+07:00`)
    return {
      start: { dateTime: start.toISOString(), timeZone: 'Asia/Bangkok' },
      end: {
        dateTime: new Date(start.getTime() + hours * 3_600_000).toISOString(),
        timeZone: 'Asia/Bangkok',
      },
    }
  }

  /* ── The service ─────────────────────────────────────────────────── */

  test('create, move, rename and delete: revisions, replays and a soft delete', async () => {
    const event = await createEvent(w.owner, {
      projectId: w.project.id,
      title: 'Shoot day',
      startsAt: '2026-10-05',
    })
    expect(event).toMatchObject({
      allDay: true,
      sync: false,
      syncState: 'local',
      source: 'hq',
      timezone: null,
    })
    expect(event.endsAt.toISOString()).toBe('2026-10-06T00:00:00.000Z')
    const moved = await updateEvent(w.owner, {
      eventId: event.id,
      expectedRevision: event.revision,
      startsAt: '2026-10-07',
    })
    expect(moved.revision).toBe(event.revision + 1)
    expect(allDayDates(moved)).toEqual({
      first: '2026-10-07',
      last: '2026-10-07',
    })
    const stale = await failure(
      updateEvent(w.owner, {
        eventId: event.id,
        expectedRevision: event.revision,
        title: 'x',
      }),
    )
    expect(stale.code).toBe('conflict')

    const key = 'event-key-0001'
    const a = await createEvent(w.owner, {
      title: 'Once',
      startsAt: '2026-10-08T09:00',
      idempotencyKey: key,
    })
    expect(a.startsAt.toISOString()).toBe('2026-10-08T02:00:00.000Z')
    expect(a.timezone).toBe('Asia/Bangkok')
    const b = await createEvent(w.owner, {
      title: 'Once',
      startsAt: '2026-10-08T09:00',
      idempotencyKey: key,
    })
    expect(b.id).toBe(a.id)
    const reused = await failure(
      createEvent(w.owner, {
        title: 'Twice',
        startsAt: '2026-10-08T09:00',
        idempotencyKey: key,
      }),
    )
    expect(reused.code).toBe('idempotency_conflict')
    const renameKey = 'event-key-0002'
    const renamed = await updateEvent(w.owner, {
      eventId: a.id,
      expectedRevision: a.revision,
      title: 'Renamed',
      endsAt: '2026-10-08T11:00',
      idempotencyKey: renameKey,
    })
    const replayed = await updateEvent(w.owner, {
      eventId: a.id,
      expectedRevision: a.revision,
      title: 'Renamed',
      endsAt: '2026-10-08T11:00',
      idempotencyKey: renameKey,
    })
    expect(replayed.revision).toBe(renamed.revision)
    expect(renamed.endsAt.toISOString()).toBe('2026-10-08T04:00:00.000Z')

    const gone = await deleteEvent(w.owner, {
      eventId: moved.id,
      expectedRevision: moved.revision,
    })
    expect(gone.deletedAt).not.toBeNull()
    expect(gone.syncState).toBe('local')
    const october = await listEvents(w.owner, {
      from: '2026-10-01',
      to: '2026-10-31',
    })
    expect(october.events.map((entry) => entry.id)).toEqual([a.id])
    const withDeleted = await listEvents(w.owner, {
      from: '2026-10-01',
      to: '2026-10-31',
      includeDeleted: true,
    })
    expect(withDeleted.events).toHaveLength(2)
    const again = await failure(
      updateEvent(w.owner, {
        eventId: gone.id,
        expectedRevision: gone.revision,
        title: 'y',
      }),
    )
    expect(again.message).toContain('deleted')
    const actions = (await w.db.select().from(opsAuditEvents)).map(
      (entry) => entry.action,
    )
    expect(actions).toContain('calendar.event.create')
    expect(actions).toContain('calendar.event.update')
    expect(actions).toContain('calendar.event.delete')
  })

  test('switching all-day and timed needs the new start; a move keeps the length', async () => {
    const event = await createEvent(w.owner, {
      title: 'Workshop',
      startsAt: '2026-10-05T09:00',
      endsAt: '2026-10-05T12:00',
    })
    const later = await updateEvent(w.owner, {
      eventId: event.id,
      expectedRevision: event.revision,
      startsAt: '2026-10-06T13:00',
    })
    expect(later.endsAt.getTime() - later.startsAt.getTime()).toBe(
      3 * 3_600_000,
    )
    const noStart = await failure(
      updateEvent(w.owner, {
        eventId: event.id,
        expectedRevision: later.revision,
        allDay: true,
      }),
    )
    expect(noStart.fields).toHaveProperty('startsAt')
    const allDay = await updateEvent(w.owner, {
      eventId: event.id,
      expectedRevision: later.revision,
      allDay: true,
      startsAt: '2026-10-06',
      endsAt: '2026-10-07',
    })
    expect(allDay).toMatchObject({ allDay: true, timezone: null })
    expect(allDayDates(allDay)).toEqual({
      first: '2026-10-06',
      last: '2026-10-07',
    })
    const backwards = await failure(
      updateEvent(w.owner, {
        eventId: event.id,
        expectedRevision: allDay.revision,
        endsAt: '2026-10-01',
      }),
    )
    expect(backwards.code).toBe('invalid')
  })

  test('someone else’s event reads as not found', async () => {
    const event = await createEvent(w.owner, {
      projectId: w.project.id,
      title: 'Mine',
      startsAt: '2026-10-05',
    })
    expect((await failure(getEvent(w.stranger, event.id))).code).toBe(
      'not_found',
    )
    expect(
      (
        await failure(
          updateEvent(w.stranger, {
            eventId: event.id,
            expectedRevision: 1,
            title: 'x',
          }),
        )
      ).code,
    ).toBe('not_found')
    expect(
      (
        await failure(
          deleteEvent(w.stranger, { eventId: event.id, expectedRevision: 1 }),
        )
      ).code,
    ).toBe('not_found')
    expect(
      (await failure(listEvents(w.stranger, { projectId: w.project.id }))).code,
    ).toBe('not_found')
    expect(
      (await listEvents(w.stranger, { from: '2026-10-01', to: '2026-10-31' }))
        .events,
    ).toEqual([])
    const into = await failure(
      createEvent(w.owner, {
        projectId: w.strangerProject.id,
        title: 'x',
        startsAt: '2026-10-05',
      }),
    )
    expect(into.code).toBe('not_found')
    const retag = await failure(
      updateEvent(w.owner, {
        eventId: event.id,
        expectedRevision: event.revision,
        projectId: w.strangerProject.id,
      }),
    )
    expect(retag.code).toBe('not_found')
  })

  test('an agent writes only under the owner’s policy, and never deletes', async () => {
    const blocked = await failure(
      createEvent(w.agent, {
        projectId: w.project.id,
        title: 'x',
        startsAt: '2026-10-05',
      }),
    )
    expect(blocked.code).toBe('policy_blocked')
    await allowAgent(w, ['draft'])
    const made = await createEvent(w.agent, {
      projectId: w.project.id,
      title: 'Agent’s',
      startsAt: '2026-10-05',
    })
    expect(made.createdBy).toBe(w.owner.userId)
    const floating = await failure(
      createEvent(w.agent, { title: 'x', startsAt: '2026-10-05' }),
    )
    expect(floating.code).toBe('policy_blocked')
    await allowAgent(w, ['draft'], null)
    await createEvent(w.agent, { title: 'Floating', startsAt: '2026-10-05' })
    const deleting = await failure(
      deleteEvent(w.agent, {
        eventId: made.id,
        expectedRevision: made.revision,
      }),
    )
    expect(deleting.code).toBe('forbidden')
  })

  test('a reader reads but can’t write or sync', async () => {
    await createEvent(w.owner, {
      projectId: w.project.id,
      title: 'Read me',
      startsAt: '2026-10-05',
    })
    const read = await listEvents(w.reader, {
      projectId: w.project.id,
      from: '2026-10-01',
      to: '2026-10-31',
    })
    expect(read.events).toHaveLength(1)
    expect(
      (
        await failure(
          createEvent(w.reader, {
            projectId: w.project.id,
            title: 'x',
            startsAt: '2026-10-05',
          }),
        )
      ).code,
    ).toBe('forbidden')
    expect((await failure(syncNow(w.reader, { http: fake.fetch }))).code).toBe(
      'forbidden',
    )
  })

  test('a range holds what touches its days, in the project’s zone', async () => {
    const p = w.project.id
    await createEvent(w.owner, {
      projectId: p,
      title: 'late on the 4th',
      startsAt: '2026-10-04T23:00',
      endsAt: '2026-10-05T00:00',
    })
    await createEvent(w.owner, {
      projectId: p,
      title: 'across midnight',
      startsAt: '2026-10-04T23:30',
      endsAt: '2026-10-05T00:30',
    })
    const day = await createEvent(w.owner, {
      projectId: p,
      title: 'all day 5th',
      startsAt: '2026-10-05',
    })
    const week = await createEvent(w.owner, {
      projectId: p,
      title: 'all week',
      startsAt: '2026-10-01',
      endsAt: '2026-10-07',
    })
    await createEvent(w.owner, {
      projectId: p,
      title: 'the 6th',
      startsAt: '2026-10-06',
    })
    await createEvent(w.owner, {
      projectId: p,
      title: 'reminder',
      startsAt: '2026-10-05T00:00',
      endsAt: '2026-10-05T00:00',
    })
    const range = await listEvents(w.owner, {
      projectId: p,
      from: '2026-10-05',
      to: '2026-10-05',
    })
    expect(range.timezone).toBe('Asia/Bangkok')
    expect(range.events.map((entry) => entry.title).sort()).toEqual([
      'across midnight',
      'all day 5th',
      'all week',
      'reminder',
    ])
    expect(range.events.find((entry) => entry.id === week.id)?.dates).toEqual({
      first: '2026-10-01',
      last: '2026-10-07',
    })
    expect(
      range.events.find((entry) => entry.id === day.id)?.project?.slug,
    ).toBe('pilot')

    const other = await makeProject(w.db, w.owner.userId, 'second')
    await createEvent(w.owner, {
      projectId: other.id,
      title: 'archived away',
      startsAt: '2026-10-05',
    })
    await w.db.execute(
      sql`update projects set status = 'archived', archived_at = now() where id = ${other.id}`,
    )
    const everywhere = await listEvents(w.owner, {
      from: '2026-10-05',
      to: '2026-10-05',
    })
    expect(everywhere.events.map((entry) => entry.title)).not.toContain(
      'archived away',
    )
    expect(everywhere.events).toHaveLength(4)
    const tooLong = await failure(
      listEvents(w.owner, { from: '2026-01-01', to: '2027-12-31' }),
    )
    expect(tooLong.code).toBe('invalid')
    const off = await makeProject(
      w.db,
      w.owner.userId,
      'no-calendar',
      'personal',
      ['board'],
    )
    expect(
      (await failure(listEvents(w.owner, { projectId: off.id }))).message,
    ).toContain('Calendar is off')
  })

  test('a new event syncs by default only when Google has Calendar', async () => {
    expect(
      (
        await createEvent(w.owner, {
          title: 'No Google',
          startsAt: '2026-10-05',
        })
      ).syncState,
    ).toBe('local')
    await connect([GOOGLE_SCOPES[0]])
    expect(
      (
        await createEvent(w.owner, {
          title: 'Drive only',
          startsAt: '2026-10-05',
        })
      ).syncState,
    ).toBe('local')
    await w.db.update(googleConnections).set({ scopes: [...GOOGLE_SCOPES] })
    const synced = await createEvent(w.owner, {
      title: 'With Google',
      startsAt: '2026-10-05',
    })
    expect(synced).toMatchObject({ sync: true, syncState: 'pending' })
    const kept = await createEvent(w.owner, {
      title: 'Kept here',
      startsAt: '2026-10-05',
      sync: false,
    })
    expect(kept.syncState).toBe('local')
    const status = await calendarStatus(w.owner)
    expect(status.google).toMatchObject({
      ready: true,
      calendar: true,
      email: EMAIL,
    })
    expect(status.pending).toBe(1)
    expect(status.lastSyncedAt).toBeNull()
  })

  /* ── Reading Google ──────────────────────────────────────────────── */

  test('a full read, then incremental reads by sync token', async () => {
    await connect()
    const call = fake.add({
      summary: 'Client call',
      ...timed('2026-10-05T09:30'),
    })
    const trip = fake.add({
      summary: 'Trip',
      start: { date: '2026-10-10' },
      end: { date: '2026-10-13' },
      extendedProperties: { private: { hqProject: 'pilot' } },
    })
    fake.add({
      summary: 'Long ago',
      start: { date: '2025-01-01' },
      end: { date: '2025-01-02' },
    })
    const first = await sync()
    expect(first).toMatchObject({
      ran: true,
      complete: true,
      mode: 'full',
      calendarId: EMAIL,
    })
    expect(first.pulled.created).toBe(2)
    const window = lists()[0]?.url.searchParams
    expect(window?.get('timeMin')).toBe('2026-07-28T03:00:00.000Z')
    expect(window?.get('timeMax')).toBe('2027-09-26T03:00:00.000Z')
    expect(window?.get('singleEvents')).toBe('true')
    expect(window?.get('maxResults')).toBe('2500')
    const stored = await rows()
    expect(stored).toHaveLength(2)
    const callRow = stored.find((entry) => entry.googleEventId === call.id)
    if (!callRow) throw new Error('no call')
    expect(callRow).toMatchObject({
      source: 'google',
      sync: true,
      syncState: 'synced',
      googleCalendarId: EMAIL,
      timezone: 'Asia/Bangkok',
      projectId: null,
      title: 'Client call',
    })
    expect(callRow.startsAt.toISOString()).toBe('2026-10-05T02:30:00.000Z')
    const tripRow = stored.find((entry) => entry.googleEventId === trip.id)
    if (!tripRow) throw new Error('no trip')
    expect(tripRow.projectId).toBe(w.project.id)
    expect(allDayDates(tripRow)).toEqual({
      first: '2026-10-10',
      last: '2026-10-12',
    })
    const [state] = await w.db.select().from(calendarSyncState)
    expect(state?.calendarId).toBe(EMAIL)
    expect(state?.syncToken).toBeTruthy()
    expect(state?.lastFullSyncAt).not.toBeNull()
    const status = await calendarStatus(w.owner)
    expect(status).toMatchObject({
      calendarId: EMAIL,
      problem: null,
      pending: 0,
      errors: 0,
    })
    expect(status.lastSyncedAt).not.toBeNull()
    const audited = await w.db
      .select()
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.action, 'calendar.sync.pull'))
    expect(audited[0]?.actorId).toBe('ops-scheduler')

    fake.edit(call.id, {
      summary: 'Client call (moved)',
      ...timed('2026-10-05T10:30'),
    })
    fake.add({
      summary: 'Dentist',
      start: { date: '2026-10-20' },
      end: { date: '2026-10-21' },
    })
    const second = await sync()
    expect(second.mode).toBe('incremental')
    expect(second.pulled).toMatchObject({ created: 1, updated: 1, deleted: 0 })
    const incremental = lists().at(-1)?.url.searchParams
    expect(incremental?.get('syncToken')).toBe(state?.syncToken as string)
    expect(incremental?.get('timeMin')).toBeNull()
    const moved = await row(callRow.id)
    expect(moved.title).toBe('Client call (moved)')
    expect(moved.startsAt.toISOString()).toBe('2026-10-05T03:30:00.000Z')
    expect(moved.revision).toBe(callRow.revision + 1)
    expect(await rows()).toHaveLength(3)

    const third = await sync()
    expect(third.pulled).toMatchObject({ created: 0, updated: 0, deleted: 0 })
    expect((await row(callRow.id)).revision).toBe(moved.revision)
  })

  test('pages are followed to the end', async () => {
    fake = fakeCalendar({ pageSize: 2 })
    await connect()
    for (const n of [1, 2, 3, 4, 5])
      fake.add({
        summary: `Day ${n}`,
        start: { date: `2026-10-0${n}` },
        end: { date: `2026-10-0${n + 1}` },
      })
    const report = await sync()
    expect(report.pulled.created).toBe(5)
    const pages = lists()
    expect(pages).toHaveLength(3)
    expect(pages[1]?.url.searchParams.get('pageToken')).toBeTruthy()
    expect(pages[2]?.url.searchParams.get('timeMin')).toBe(
      '2026-07-28T03:00:00.000Z',
    )
    expect(await rows()).toHaveLength(5)
  })

  test('a forgotten sync token (410) reads the whole window again', async () => {
    await connect()
    const event = fake.add({ summary: 'Weekly', ...timed('2026-10-07T08:00') })
    await sync()
    const [before] = await w.db.select().from(calendarSyncState)
    fake.expireTokens()
    fake.edit(event.id, { summary: 'Weekly (renamed)' })
    const report = await sync()
    expect(report.mode).toBe('full')
    const tail = lists().slice(-2)
    expect(tail[0]?.url.searchParams.get('syncToken')).toBe(
      before?.syncToken as string,
    )
    expect(tail[1]?.url.searchParams.get('syncToken')).toBeNull()
    expect(tail[1]?.url.searchParams.get('timeMin')).toBeTruthy()
    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0]?.title).toBe('Weekly (renamed)')
    const [after] = await w.db.select().from(calendarSyncState)
    expect(after?.syncToken).toBeTruthy()
    expect(after?.syncToken).not.toBe(before?.syncToken as string)
  })

  test('without sync tokens every read stays windowed', async () => {
    fake = fakeCalendar({ noSyncToken: true })
    await connect()
    fake.add({
      summary: 'Only once',
      start: { date: '2026-10-05' },
      end: { date: '2026-10-06' },
    })
    await sync()
    const again = await sync()
    expect(again.mode).toBe('full')
    expect(again.pulled.created).toBe(0)
    expect(await rows()).toHaveLength(1)
    const [state] = await w.db.select().from(calendarSyncState)
    expect(state?.syncToken).toBeNull()
  })

  test('an event cancelled in Google is deleted here', async () => {
    await connect()
    const event = fake.add({
      summary: 'Called off',
      ...timed('2026-10-08T15:00'),
    })
    await sync()
    fake.cancel(event.id)
    const report = await sync()
    expect(report.pulled.deleted).toBe(1)
    const [stored] = await rows()
    expect(stored?.deletedAt).not.toBeNull()
    expect(stored?.syncState).toBe('synced')
    expect(
      (await listEvents(w.owner, { from: '2026-10-01', to: '2026-10-31' }))
        .events,
    ).toHaveLength(0)
    expect(fake.calls('DELETE')).toHaveLength(0)
  })

  /* ── Writing to Google ───────────────────────────────────────────── */

  test('an HQ event is inserted once, then patched with If-Match', async () => {
    await connect()
    const event = await createEvent(w.owner, {
      projectId: w.project.id,
      title: 'Pitch',
      startsAt: '2026-10-06T14:00',
      endsAt: '2026-10-06T15:00',
    })
    const first = await sync()
    expect(first.pushed.inserted).toBe(1)
    const [insert] = fake.calls('POST')
    expect(insert?.url.searchParams.get('sendUpdates')).toBe('none')
    expect(insert?.body?.id).toBe(googleEventIdFor(event))
    const google = fake.events.get(googleEventIdFor(event))
    if (!google) throw new Error('not in Google')
    expect(google.summary).toBe('Pitch')
    expect(google.start).toEqual({
      dateTime: '2026-10-06T07:00:00.000Z',
      timeZone: 'Asia/Bangkok',
    })
    expect(google.extendedProperties?.private).toEqual({
      hqId: event.id,
      hqProject: 'pilot',
    })
    const synced = await row(event.id)
    expect(synced).toMatchObject({
      syncState: 'synced',
      googleEventId: google.id,
      googleEtag: google.etag,
      googleCalendarId: EMAIL,
      revision: event.revision,
    })
    expect(synced.googleHtmlLink).toContain(google.id)

    const echo = await sync()
    expect(echo.pulled).toMatchObject({ created: 0, updated: 0 })
    expect(await rows()).toHaveLength(1)

    const renamed = await updateEvent(w.owner, {
      eventId: event.id,
      expectedRevision: synced.revision,
      title: 'Pitch v2',
      projectId: null,
    })
    expect(renamed.syncState).toBe('pending')
    const patched = await sync()
    expect(patched.pushed.patched).toBe(1)
    const [patch] = fake.calls('PATCH')
    expect(patch?.headers.get('if-match')).toBe(synced.googleEtag as string)
    expect(patch?.url.searchParams.get('sendUpdates')).toBe('none')
    const after = fake.events.get(google.id)
    expect(after?.summary).toBe('Pitch v2')
    expect(after?.extendedProperties?.private?.hqProject).toBe('')
    const stored = await row(event.id)
    expect(stored).toMatchObject({
      syncState: 'synced',
      googleEtag: after?.etag,
      projectId: null,
    })
    expect(fake.calls('POST')).toHaveLength(1)
    const pushes = await w.db
      .select()
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.action, 'calendar.event.push'))
    expect(pushes.map((entry) => (entry.changes as { op: string }).op)).toEqual(
      ['insert', 'patch'],
    )
  })

  test('a Google event changed in HQ writes back; it can’t be taken out of sync', async () => {
    await connect()
    const google = fake.add({
      summary: 'From my phone',
      ...timed('2026-10-09T10:00'),
    })
    await sync()
    const [stored] = await rows()
    if (!stored) throw new Error('not read')
    const tagged = await updateEvent(w.owner, {
      eventId: stored.id,
      expectedRevision: stored.revision,
      projectId: w.project.id,
      location: 'Studio',
    })
    await sync()
    expect(fake.events.get(google.id)).toMatchObject({
      location: 'Studio',
      summary: 'From my phone',
    })
    expect(
      fake.events.get(google.id)?.extendedProperties?.private?.hqProject,
    ).toBe('pilot')
    expect((await row(stored.id)).source).toBe('google')
    const off = await failure(
      updateEvent(w.owner, {
        eventId: stored.id,
        expectedRevision: tagged.revision,
        sync: false,
      }),
    )
    expect(off.message).toContain('stays in sync')
  })

  test('Google wins when both sides changed the same event', async () => {
    await connect()
    const google = fake.add({
      summary: 'Standup',
      ...timed('2026-10-12T09:00'),
    })
    await sync()
    const [stored] = await rows()
    if (!stored) throw new Error('not read')
    await updateEvent(w.owner, {
      eventId: stored.id,
      expectedRevision: stored.revision,
      title: 'HQ title',
    })
    fake.edit(google.id, { summary: 'Google title' })
    const report = await sync()
    expect(report.googleWon).toBe(1)
    expect(await row(stored.id)).toMatchObject({
      title: 'Google title',
      syncState: 'synced',
    })
    expect(fake.calls('PATCH')).toHaveLength(0)
  })

  test('a 412 on write re-reads the event and keeps Google’s version', async () => {
    await connect()
    const event = await createEvent(w.owner, {
      title: 'Race',
      startsAt: '2026-10-09',
    })
    await sync()
    const synced = await row(event.id)
    const googleId = synced.googleEventId as string
    await updateEvent(w.owner, {
      eventId: event.id,
      expectedRevision: synced.revision,
      title: 'HQ edit',
    })
    let raced = false
    hook = (req) => {
      // Google's own edit lands between HQ's read and HQ's write.
      if (req.method === 'PATCH' && !raced) {
        raced = true
        fake.edit(googleId, { summary: 'Google edit' })
      }
      return undefined
    }
    const report = await sync()
    expect(report.googleWon).toBe(1)
    expect(fake.calls('PATCH')).toHaveLength(1)
    const stored = await row(event.id)
    expect(stored).toMatchObject({
      title: 'Google edit',
      syncState: 'synced',
      googleEtag: fake.events.get(googleId)?.etag,
    })
    expect(stored.revision).toBeGreaterThan(synced.revision + 1)
    expect(fake.events.get(googleId)?.summary).toBe('Google edit')
  })

  test('deleting in HQ deletes in Google, once', async () => {
    await connect()
    const event = await createEvent(w.owner, {
      title: 'Drop me',
      startsAt: '2026-10-09',
    })
    await sync()
    const synced = await row(event.id)
    const deleted = await deleteEvent(w.owner, {
      eventId: event.id,
      expectedRevision: synced.revision,
    })
    expect(deleted.syncState).toBe('pending')
    const report = await sync()
    expect(report.pushed.deleted).toBe(1)
    const [remove] = fake.calls('DELETE')
    expect(remove?.url.pathname).toEndWith(`/events/${synced.googleEventId}`)
    expect(fake.events.get(synced.googleEventId as string)?.status).toBe(
      'cancelled',
    )
    expect((await row(event.id)).syncState).toBe('synced')
    const echo = await sync()
    expect(echo.pulled.deleted).toBe(0)
    expect(fake.calls('DELETE')).toHaveLength(1)
  })

  test('Undo before the sync brings an event back, and Google never loses it', async () => {
    await connect()
    const event = await createEvent(w.owner, {
      title: 'Keep me',
      startsAt: '2026-10-09',
    })
    await sync()
    const synced = await row(event.id)
    const deleted = await deleteEvent(w.owner, {
      eventId: event.id,
      expectedRevision: synced.revision,
    })
    const back = await restoreEvent(w.owner, {
      eventId: event.id,
      expectedRevision: deleted.revision,
    })
    expect(back).toMatchObject({ deletedAt: null, syncState: 'pending' })
    expect(
      (
        await restoreEvent(w.owner, {
          eventId: event.id,
          expectedRevision: back.revision,
        })
      ).revision,
    ).toBe(back.revision)
    const report = await sync()
    expect(report.pushed.deleted).toBe(0)
    expect(fake.calls('DELETE')).toHaveLength(0)
    expect((await row(event.id)).syncState).toBe('synced')
    expect(fake.live()).toHaveLength(1)
    expect(
      (await listEvents(w.owner, { from: '2026-10-01', to: '2026-10-31' }))
        .events,
    ).toHaveLength(1)
  })

  test('once Google has deleted it, Undo says so and changes nothing', async () => {
    await connect()
    const event = await createEvent(w.owner, {
      title: 'Gone',
      startsAt: '2026-10-09',
    })
    await sync()
    const deleted = await deleteEvent(w.owner, {
      eventId: event.id,
      expectedRevision: (await row(event.id)).revision,
    })
    await sync()
    const refused = await failure(
      restoreEvent(w.owner, {
        eventId: event.id,
        expectedRevision: deleted.revision,
      }),
    )
    expect(refused.code).toBe('invalid')
    expect(refused.message).toContain('Google already deleted')
    expect((await row(event.id)).deletedAt).not.toBeNull()
    expect(fake.live()).toHaveLength(0)
  })

  test('an event only in HQ comes back local; an agent can’t restore', async () => {
    const event = await createEvent(w.owner, {
      projectId: w.project.id,
      title: 'Local',
      startsAt: '2026-10-05',
      sync: false,
    })
    const deleted = await deleteEvent(w.owner, {
      eventId: event.id,
      expectedRevision: event.revision,
    })
    expect(
      (
        await failure(
          restoreEvent(w.agent, {
            eventId: event.id,
            expectedRevision: deleted.revision,
          }),
        )
      ).code,
    ).toBe('forbidden')
    expect(
      (
        await failure(
          restoreEvent(w.owner, {
            eventId: event.id,
            expectedRevision: event.revision,
          }),
        )
      ).code,
    ).toBe('conflict')
    const back = await restoreEvent(w.owner, {
      eventId: event.id,
      expectedRevision: deleted.revision,
    })
    expect(back).toMatchObject({ deletedAt: null, syncState: 'local' })
    const [audited] = await w.db
      .select()
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.action, 'calendar.event.restore'))
    expect(audited?.targetId).toBe(event.id)
  })

  test('sync off takes an HQ event off Google and keeps it; on again is a new Google event', async () => {
    await connect()
    const event = await createEvent(w.owner, {
      title: 'Private',
      startsAt: '2026-10-09',
    })
    await sync()
    const onGoogle = await row(event.id)
    const off = await updateEvent(w.owner, {
      eventId: event.id,
      expectedRevision: onGoogle.revision,
      sync: false,
    })
    expect(off.syncState).toBe('pending')
    const report = await sync()
    expect(report.pushed.removed).toBe(1)
    const local = await row(event.id)
    expect(local).toMatchObject({
      sync: false,
      syncState: 'local',
      googleEventId: null,
      deletedAt: null,
    })
    expect(fake.events.get(onGoogle.googleEventId as string)?.status).toBe(
      'cancelled',
    )
    await updateEvent(w.owner, {
      eventId: event.id,
      expectedRevision: local.revision,
      sync: true,
    })
    await sync()
    const back = await row(event.id)
    expect(back.syncState).toBe('synced')
    expect(back.googleEventId).not.toBe(onGoogle.googleEventId)
    expect(fake.live()).toHaveLength(1)
    expect(await rows()).toHaveLength(1)
  })

  test('a refused change is kept in words, and can be sent again', async () => {
    await connect()
    const google = fake.add({
      summary: 'Someone else’s',
      ...timed('2026-10-14T09:00'),
    })
    await sync()
    const [stored] = await rows()
    if (!stored) throw new Error('not read')
    await updateEvent(w.owner, {
      eventId: stored.id,
      expectedRevision: stored.revision,
      title: 'Mine now',
    })
    hook = (req) =>
      req.method === 'PATCH'
        ? googleError(
            403,
            'forbiddenForNonOrganizer',
            'Shared properties can only be changed by the organizer of the event.',
          )
        : undefined
    const report = await sync()
    expect(report).toMatchObject({ complete: true, pushed: { failed: 1 } })
    const failed = await row(stored.id)
    expect(failed.syncState).toBe('error')
    expect(failed.syncProblem).toContain('organizer')
    expect((await calendarStatus(w.owner)).errors).toBe(1)
    hook = undefined
    const retried = await retryEventSync(w.owner, {
      eventId: stored.id,
      expectedRevision: failed.revision,
    })
    expect(retried.syncState).toBe('pending')
    await sync()
    expect((await row(stored.id)).syncState).toBe('synced')
    expect(fake.events.get(google.id)?.summary).toBe('Mine now')
  })

  test('an insert whose answer was lost is adopted on the next read, not copied', async () => {
    await connect()
    const event = await createEvent(w.owner, {
      title: 'Once only',
      startsAt: '2026-10-09',
    })
    hook = (req) => {
      if (req.method !== 'POST' || req.url.hostname !== 'www.googleapis.com')
        return undefined
      hook = undefined
      // Google takes the insert; the answer never arrives.
      fake.add(req.body as never)
      return new Response('', { status: 503 })
    }
    const lost = await failure(sync())
    expect(lost.code).toBe('provider_unavailable')
    expect((await calendarStatus(w.owner)).problem).toContain('busy')
    expect((await row(event.id)).syncState).toBe('pending')
    await sync()
    const stored = await row(event.id)
    expect(stored).toMatchObject({
      syncState: 'synced',
      googleEventId: googleEventIdFor(event),
    })
    expect(fake.live()).toHaveLength(1)
    expect(await rows()).toHaveLength(1)
    expect((await calendarStatus(w.owner)).problem).toBeNull()
  })

  test('an insert whose answer was lost outside the read window is adopted on 409', async () => {
    fake = fakeCalendar({ noSyncToken: true, override: (req) => hook?.(req) })
    await connect()
    const event = await createEvent(w.owner, {
      title: 'Far ahead',
      startsAt: '2028-01-10',
    })
    hook = (req) => {
      if (req.method !== 'POST' || req.url.hostname !== 'www.googleapis.com')
        return undefined
      hook = undefined
      fake.add(req.body as never)
      return new Response('', { status: 502 })
    }
    expect((await failure(sync())).code).toBe('provider_unavailable')
    await sync()
    const posts = fake.calls('POST')
    expect(posts).toHaveLength(2)
    expect(
      fake
        .calls('GET')
        .some((req) => req.url.pathname.endsWith(googleEventIdFor(event))),
    ).toBe(true)
    expect(await row(event.id)).toMatchObject({
      syncState: 'synced',
      googleEventId: googleEventIdFor(event),
    })
    expect(fake.live()).toHaveLength(1)
  })

  /* ── Refusals, concurrency, the tick ─────────────────────────────── */

  test('a 401 is reauth_required and nothing is written', async () => {
    await connect()
    fake.add({ summary: 'Unseen', ...timed('2026-10-09T10:00') })
    hook = (req) =>
      req.url.hostname === 'www.googleapis.com'
        ? googleError(401, 'authError', `Invalid Credentials ${TOKEN}`)
        : undefined
    const error = await failure(sync())
    expect(error.code).toBe('reauth_required')
    expect(error.message).not.toContain(TOKEN)
    expect(await rows()).toHaveLength(0)
    expect(
      fake.requests.filter(
        (req) => req.url.hostname === 'oauth2.googleapis.com',
      ),
    ).toHaveLength(2)
    const status = await calendarStatus(w.owner)
    expect(status.problem).toContain('Reconnect')
    expect(status.problem).not.toContain(TOKEN)
    expect(await w.db.select().from(opsSchedulerLeases)).toHaveLength(0)
  })

  test('a refused refresh marks the connection for reconnecting', async () => {
    await connect()
    hook = (req) =>
      req.url.hostname === 'oauth2.googleapis.com'
        ? new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
          })
        : undefined
    const error = await failure(sync())
    expect(error.code).toBe('reauth_required')
    const [connection] = await w.db.select().from(googleConnections)
    expect(connection?.status).toBe('needs_reauth')
    expect(await dueCalendarOwners()).toEqual([])
    expect((await failure(sync())).code).toBe('reauth_required')
    expect(await rows()).toHaveLength(0)
  })

  test('passes at the same time don’t duplicate anything', async () => {
    await connect()
    for (const n of [1, 2, 3])
      fake.add({
        summary: `Google ${n}`,
        start: { date: `2026-10-1${n}` },
        end: { date: `2026-10-2${n}` },
      })
    await createEvent(w.owner, { title: 'Pushed once', startsAt: '2026-10-09' })
    const results = await Promise.all([sync(), sync(), sync()])
    expect(results.some((result) => result.ran)).toBe(true)
    await sync()
    expect(await rows()).toHaveLength(4)
    expect(fake.calls('POST')).toHaveLength(1)
    expect(fake.live()).toHaveLength(4)
    await w.db.insert(opsSchedulerLeases).values({
      name: `calendar-sync:${w.owner.userId}`,
      holder: randomUUID(),
      acquiredAt: sql`now()`,
      expiresAt: sql`now() + interval '1 minute'`,
    })
    const held = await sync()
    expect(held.ran).toBe(false)
  })

  test('a pass out of time stops before Google and the next one carries on', async () => {
    await connect()
    fake.add({
      summary: 'Later',
      start: { date: '2026-10-05' },
      end: { date: '2026-10-06' },
    })
    const starved = await sync({ remainingMs: () => 0 })
    expect(starved).toMatchObject({ ran: true, complete: false })
    expect(lists()).toHaveLength(0)
    expect(await rows()).toHaveLength(0)
    expect(await dueCalendarOwners()).toEqual([w.owner.userId])
    expect((await sync()).complete).toBe(true)
    expect(await rows()).toHaveLength(1)
  })

  test('the tick syncs each due owner every ten minutes, within its budget', async () => {
    await connect()
    fake.add({
      summary: 'Ticked',
      start: { date: '2026-10-05' },
      end: { date: '2026-10-06' },
    })
    const tick = (remaining = 30_000) =>
      calendarTick({ remainingMs: () => remaining }, { http: fake.fetch })
    expect(await tick(5_000)).toMatchObject({ due: 1, synced: 0, deferred: 1 })
    expect(await tick()).toMatchObject({ due: 1, synced: 1, failed: [] })
    expect(await rows()).toHaveLength(1)
    expect((await tick()).due).toBe(0)
    await w.db.execute(
      sql`update calendar_sync_state set last_synced_at = now() - interval '11 minutes'`,
    )
    hook = (req) =>
      req.url.hostname === 'www.googleapis.com'
        ? new Response('', { status: 500 })
        : undefined
    expect((await tick()).failed).toEqual([
      { ownerId: w.owner.userId, code: 'provider_unavailable' },
    ])
    expect((await tick()).due).toBe(0)
    await w.db.execute(
      sql`update calendar_sync_state set updated_at = now() - interval '11 minutes'`,
    )
    hook = undefined
    expect(await tick()).toMatchObject({ due: 1, synced: 1 })
    await w.db.update(googleConnections).set({ scopes: [GOOGLE_SCOPES[0]] })
    await w.db.execute(
      sql`update calendar_sync_state set last_synced_at = null`,
    )
    expect(await dueCalendarOwners()).toEqual([])
  })

  /* ── Registries ──────────────────────────────────────────────────── */

  test('a note promoted to an event lands as an all-day event', async () => {
    const created = await withTransaction((tx) =>
      createTarget(
        'event',
        {
          title: 'From a note',
          date: '2026-10-05',
          description: 'Bring the lens',
        },
        { tx, actor: w.owner, project: w.project },
      ),
    )
    expect(created.type).toBe('event')
    expect(created.href).toBe(`/p/pilot/calendar?event=${created.id}`)
    const event = await getEvent(w.owner, created.id)
    expect(event).toMatchObject({
      allDay: true,
      title: 'From a note',
      description: 'Bring the lens',
      projectId: w.project.id,
    })
    expect(event.dates).toEqual({ first: '2026-10-05', last: '2026-10-05' })
    expect(event.startsAt.toISOString()).toBe('2026-10-05T00:00:00.000Z')
    expect(event.endsAt.toISOString()).toBe('2026-10-06T00:00:00.000Z')
    const floating = await withTransaction((tx) =>
      createTarget(
        'event',
        { title: 'Timed', startsAt: '2026-10-06T10:00' },
        { tx, actor: w.owner, project: null },
      ),
    )
    expect(floating.href).toBe(`/calendar?event=${floating.id}`)
    expect((await getEvent(w.owner, floating.id)).startsAt.toISOString()).toBe(
      '2026-10-06T03:00:00.000Z',
    )
    const vague = await failure(
      withTransaction((tx) =>
        createTarget(
          'event',
          { title: 'No time' },
          { tx, actor: w.owner, project: w.project },
        ),
      ),
    )
    expect(vague.code).toBe('invalid')
  })

  test('events are found by search', async () => {
    const event = await createEvent(w.owner, {
      projectId: w.project.id,
      title: 'Dentist',
      location: 'Sukhumvit',
      startsAt: '2026-10-05T09:30',
    })
    const trip = await createEvent(w.owner, {
      title: 'Sukhumvit walk',
      startsAt: '2026-10-10',
      endsAt: '2026-10-11',
    })
    const hits = await searchHq(w.owner, {
      query: 'sukhumvit',
      types: ['event'],
    })
    expect(hits).toEqual([
      {
        type: 'event',
        id: trip.id,
        title: 'Sukhumvit walk',
        projectId: null,
        href: `/calendar?event=${trip.id}`,
        detail: '2026-10-10 – 2026-10-11',
      },
      {
        type: 'event',
        id: event.id,
        title: 'Dentist',
        projectId: w.project.id,
        href: `/p/pilot/calendar?event=${event.id}`,
        detail: '2026-10-05 09:30',
      },
    ])
    expect(
      await searchHq(w.stranger, { query: 'sukhumvit', types: ['event'] }),
    ).toEqual([])
  })
})
