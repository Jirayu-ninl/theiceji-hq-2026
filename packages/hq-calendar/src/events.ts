import { GOOGLE_SCOPES } from '@theiceji/hq-core/google'
import type { GoogleConnectionStatus } from '@theiceji/hq-db/enums'
import {
  type CalendarEventRow,
  calendarEvents,
  calendarSyncState,
  googleConnections,
  type ProjectRow,
  projects,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan } from '@theiceji/hq-ops/access'
import { dbNow } from '@theiceji/hq-ops/db'
import {
  conflict,
  invalid,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  day,
  idempotencyKey,
  optionalRecordId,
  parseInput,
  recordId,
  revision,
  text,
} from '@theiceji/hq-ops/schemas'
import {
  assertModuleOn,
  audit,
  authorize,
  ownedProject,
  ownedRecord,
  ownedRow,
  type Reader,
  returned,
  runOperation,
  type Tx,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import {
  addDays,
  DEFAULT_TIME_ZONE,
  dayRange,
  isValidTimeZone,
  zonedDay,
} from '@theiceji/hq-ops/time'
import { auditSnapshot, diffFields } from '@theiceji/hq-ops/values'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import {
  allDayDates,
  allDayLength,
  allDaySpan,
  resolveWhen,
  type When,
} from './dates'

/**
 * Calendar: the owner's events, one table for what HQ
 * made and what Google sent.
 *
 * · **Every change is one transaction** with its audit event, at the
 *   revision the caller read (`expectedRevision`), and replays under an
 *   `idempotencyKey` like every HQ write.
 * · **Sync is a state, not a call.** A write never talks to Google: it marks
 *   the event `pending` and the sync step (sync.ts, on the ops tick or "Sync
 *   now") carries it over. With sync off and nothing in Google an event is
 *   `local`. An event is new with sync on when the owner's Google is
 *   connected with Calendar, unless the caller says otherwise.
 * · **An event from Google stays in sync.** Changing it in HQ writes back;
 *   only an event HQ made can be taken off Google (sync off), which queues
 *   its removal there and keeps it here.
 * · **Deleting is soft and the owner's** (`owner_only`): `deleted_at` is set,
 *   and an event Google has is deleted there by the next sync. Undo
 *   (`restoreEvent`) brings it back until that sync has gone.
 * · **Card dues, quote expiries and scheduled posts are never rows here** —
 *   the page draws them as an overlay from their own modules.
 */

registerConstraintMessages({
  calendar_events_range_check: 'The event ends before it starts.',
  calendar_events_all_day_check:
    'An all-day event runs from one date to a later one.',
  calendar_events_title_check: 'Title is required, 200 characters or fewer.',
  calendar_events_google_key: 'That Google event is already in HQ.',
})

/* ── Shapes ─────────────────────────────────────────────────────────── */

export type EventProject = Pick<
  ProjectRow,
  'id' | 'slug' | 'name' | 'color' | 'status' | 'kind' | 'timezone'
>

export type EventItem = CalendarEventRow & {
  project: EventProject | null
  /** An all-day event's first and last day, inclusive; null for a timed one. */
  dates: { first: string; last: string } | null
}

const projectColumns = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  color: projects.color,
  status: projects.status,
  kind: projects.kind,
  timezone: projects.timezone,
}

function item(row: CalendarEventRow, project: EventProject | null): EventItem {
  return {
    ...row,
    project: project?.id ? project : null,
    dates: row.allDay ? allDayDates(row) : null,
  }
}

/** Both calendar scopes, as Google granted them. */
export function hasCalendarScopes(scopes: readonly string[]): boolean {
  return scopes.includes(GOOGLE_SCOPES[1]) && scopes.includes(GOOGLE_SCOPES[2])
}

/** Whether the owner's Google is connected with Calendar — a new event's default for sync. */
export async function googleCalendarReady(
  reader: Reader,
  ownerId: string,
): Promise<boolean> {
  const [row] = await reader
    .select({
      status: googleConnections.status,
      scopes: googleConnections.scopes,
    })
    .from(googleConnections)
    .where(eq(googleConnections.ownerId, ownerId))
    .limit(1)
  return row?.status === 'connected' && hasCalendarScopes(row.scopes)
}

/* ── Reading events ─────────────────────────────────────────────────── */

/** The longest range one read covers — a year and a month. */
const MAX_RANGE_DAYS = 400

/** An empty form field means "none", like everywhere in HQ. */
const blank = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? null : value

const timeZone = z
  .string()
  .trim()
  .refine(isValidTimeZone, 'That isn’t a timezone HQ knows.')

const listSchema = z.object({
  /** The first day, inclusive; today in the zone when absent. */
  from: day('From'),
  /** The last day, inclusive; 30 days after `from` when absent. */
  to: day('To'),
  projectId: z.uuid({ error: 'Project not found.' }).optional(),
  /** The zone days are read in without a project; the project's own wins. */
  timezone: timeZone.optional(),
  includeDeleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(2000).optional(),
})

export type ListEventsInput = z.input<typeof listSchema>

export type EventRange = {
  from: string
  to: string
  timezone: string
  events: EventItem[]
}

/**
 * Events that touch the days `from`–`to` — one project's, or every event of
 * the owner's (untagged ones and every project with Calendar on that isn't
 * archived). Timed events are placed in the project's zone (or `timezone`);
 * all-day ones by their own dates. Deleted events only when asked.
 */
export async function listEvents(
  actor: Actor,
  raw: ListEventsInput = {},
): Promise<EventRange> {
  const input = parseInput(listSchema, raw)
  return withReader(async (db) => {
    let zone = input.timezone ?? DEFAULT_TIME_ZONE
    if (input.projectId) {
      const project = await ownedProject(
        db,
        actor,
        input.projectId,
        'calendar',
        'read',
      )
      assertModuleOn(project, 'calendar')
      zone = project.timezone
    } else {
      await authorize(db, actor, null, 'calendar', 'read')
    }
    const from = input.from ?? zonedDay(await dbNow(db), zone)
    const to = input.to ?? addDays(from, 30)
    if (to < from)
      throw invalid('The range ends before it starts.', {
        to: 'Choose a last day on or after the first.',
      })
    if (addDays(from, MAX_RANGE_DAYS) < to)
      throw invalid(`Read at most ${MAX_RANGE_DAYS} days at a time.`, {
        to: 'Choose a shorter range.',
      })
    const timed = dayRange(from, to, zone)
    const dates = allDaySpan(from, to)
    const rows = await db
      .select({ event: calendarEvents, project: projectColumns })
      .from(calendarEvents)
      .leftJoin(projects, eq(projects.id, calendarEvents.projectId))
      .where(
        and(
          eq(calendarEvents.ownerId, actor.userId),
          input.includeDeleted ? undefined : isNull(calendarEvents.deletedAt),
          input.projectId
            ? eq(calendarEvents.projectId, input.projectId)
            : sql`(${calendarEvents.projectId} is null or (${projects.status} <> 'archived' and ${projects.modules} -> 'enabled' ? 'calendar'))`,
          or(
            // All-day events by their own dates…
            and(
              eq(calendarEvents.allDay, true),
              lt(calendarEvents.startsAt, dates.endsAt),
              gt(calendarEvents.endsAt, dates.startsAt),
            ),
            // …timed ones by the zone's midnights; a zero-length one at the
            // first midnight still counts.
            and(
              eq(calendarEvents.allDay, false),
              lt(calendarEvents.startsAt, timed.end),
              or(
                gt(calendarEvents.endsAt, timed.start),
                gte(calendarEvents.startsAt, timed.start),
              ),
            ),
          ),
        ),
      )
      .orderBy(
        asc(calendarEvents.startsAt),
        desc(calendarEvents.allDay),
        asc(calendarEvents.title),
      )
      .limit(input.limit ?? 1000)
    return {
      from,
      to,
      timezone: zone,
      events: rows.map((row) => item(row.event, row.project)),
    }
  })
}

/** One event with its project — a deleted one too, so a link to it still explains itself. */
export async function getEvent(
  actor: Actor,
  eventId: string,
): Promise<EventItem> {
  return withReader(async (db) => {
    const { row, project } = await ownedRecord<CalendarEventRow>(
      db,
      actor,
      calendarEvents,
      eventId,
      'calendar',
      'read',
      'Event',
    )
    return item(row, project)
  })
}

/* ── Writing events ─────────────────────────────────────────────────── */

const eventFields = {
  description: text.optional('Description', 8000),
  location: text.optional('Location', 500),
  allDay: z.boolean().optional(),
  timezone: z.preprocess(blank, timeZone.nullable().optional()),
  /** Write it to the owner's Google calendar. */
  sync: z.boolean().optional(),
}

const when = z
  .string({ error: 'Give a date or a time.' })
  .trim()
  .min(1, 'Give a date or a time.')
  .max(40, 'That isn’t a date or a time.')

/** An end: absent or empty means the default length. */
const until = z.preprocess(blank, when.nullable().optional())

export type NewEvent = {
  title: string
  description?: string | null
  location?: string | null
  allDay?: boolean
  /** All-day: the first day. Timed: an ISO instant, or local time in `timezone`. */
  startsAt: string
  /** All-day: the last day, inclusive. Timed: the end. Absent: a day, or an hour. */
  endsAt?: string | null
  /** For local times; the project's zone, else Asia/Bangkok, when absent. */
  timezone?: string | null
  /** Absent: on when the owner's Google is connected with Calendar. */
  sync?: boolean
}

/**
 * A new HQ event inside the caller's transaction — for `createEvent` and for
 * the target registry (a note promoted to an event). The caller has already
 * authorized the write; this checks the module is on and the times make sense.
 */
export async function insertEvent(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  input: NewEvent,
): Promise<CalendarEventRow> {
  if (project) assertModuleOn(project, 'calendar')
  const time = resolveWhen(input, project?.timezone ?? DEFAULT_TIME_ZONE)
  const sync = input.sync ?? (await googleCalendarReady(tx, actor.userId))
  const [row] = await tx
    .insert(calendarEvents)
    .values({
      ownerId: actor.userId,
      createdBy: actor.userId,
      projectId: project?.id ?? null,
      title: input.title,
      description: input.description ?? '',
      location: input.location ?? null,
      ...time,
      source: 'hq',
      sync,
      syncState: sync ? 'pending' : 'local',
    })
    .returning()
  const event = returned(row)
  await audit(tx, actor, {
    projectId: event.projectId,
    action: 'calendar.event.create',
    targetType: 'event',
    targetId: event.id,
    afterRevision: event.revision,
    changes: auditSnapshot({
      title: event.title,
      allDay: event.allDay,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timezone: event.timezone,
      sync: event.sync,
    }),
  })
  return event
}

const createSchema = z.object({
  /** Absent or null: an event of no project, on the everywhere calendar. */
  projectId: optionalRecordId('Project'),
  title: text.required('Title', 200),
  startsAt: when,
  endsAt: until,
  ...eventFields,
  idempotencyKey: idempotencyKey.optional(),
})

export type CreateEventInput = z.input<typeof createSchema>

async function readRow(actor: Actor, eventId: string) {
  return (await getEvent(actor, eventId)) as CalendarEventRow
}

export async function createEvent(
  actor: Actor,
  raw: CreateEventInput,
): Promise<CalendarEventRow> {
  const input = parseInput(createSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'calendar_create_event',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        let project: ProjectRow | null = null
        if (input.projectId)
          project = await ownedProject(
            tx,
            actor,
            input.projectId,
            'calendar',
            'write',
          )
        else await authorize(tx, actor, null, 'calendar', 'write')
        return insertEvent(tx, actor, project, {
          ...input,
          title: input.title as string,
        })
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.event_id ?? outcome.target?.id
    if (typeof id !== 'string') throw conflict()
    return readRow(actor, id)
  }
  await outcome.complete({ event_id: outcome.value.id })
  return outcome.value
}

/** Load an event for a write, locked, with its project; checks the revision. */
async function eventForWrite(
  tx: Tx,
  actor: Actor,
  eventId: string,
  expectedRevision: number,
  requirement?: 'owner_only',
): Promise<{ event: CalendarEventRow; project: ProjectRow | null }> {
  assertCan(actor, 'calendar', 'write')
  const { row: event, project } = await ownedRow<CalendarEventRow>(
    tx,
    actor,
    calendarEvents,
    eventId,
    'Event',
    { lock: true },
  )
  await authorize(tx, actor, project, 'calendar', 'write', requirement)
  if (project) assertModuleOn(project, 'calendar')
  if (event.deletedAt) throw invalid('This event was deleted.')
  if (event.revision !== expectedRevision) throw conflict()
  return { event, project }
}

async function saveEvent(
  tx: Tx,
  event: CalendarEventRow,
  patch: PgUpdateSetSource<typeof calendarEvents>,
): Promise<CalendarEventRow> {
  const [row] = await tx
    .update(calendarEvents)
    .set({
      ...patch,
      revision: sql`${calendarEvents.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(calendarEvents.id, event.id),
        eq(calendarEvents.revision, event.revision),
      ),
    )
    .returning()
  if (!row) throw conflict()
  return row
}

/**
 * Where an event stands with Google after an HQ change: on its way there
 * (`pending`) when it syncs, or when it must still be taken off Google;
 * otherwise it stays in HQ (`local`).
 */
function stateAfterChange(
  event: Pick<CalendarEventRow, 'googleEventId'>,
  sync: boolean,
): 'pending' | 'local' {
  return sync || event.googleEventId ? 'pending' : 'local'
}

const updateSchema = z.object({
  eventId: recordId('Event'),
  expectedRevision: revision,
  title: text.required('Title', 200).optional(),
  startsAt: when.optional(),
  endsAt: until,
  /** Null takes the event out of its project. */
  projectId: optionalRecordId('Project'),
  ...eventFields,
  idempotencyKey: idempotencyKey.optional(),
})

export type UpdateEventInput = z.input<typeof updateSchema>

/**
 * The event's new times from a partial change. Moving the start keeps the
 * length unless a new end comes with it; switching between all-day and timed
 * needs the new start.
 */
function nextWhen(
  event: CalendarEventRow,
  input: {
    allDay?: boolean
    startsAt?: string
    endsAt?: string | null
    timezone?: string | null
  },
  fallbackZone: string,
): When {
  const allDay = input.allDay ?? event.allDay
  const switching = allDay !== event.allDay
  if (switching && input.startsAt === undefined)
    throw invalid('Give the start when switching between all-day and timed.', {
      startsAt: 'Give the new start.',
    })
  const current = event.allDay
    ? allDayDates(event)
    : { first: event.startsAt.toISOString(), last: event.endsAt.toISOString() }
  const moved = input.startsAt !== undefined
  return resolveWhen(
    {
      allDay,
      startsAt: input.startsAt ?? current.first,
      endsAt:
        input.endsAt !== undefined ? input.endsAt : moved ? null : current.last,
      timezone: input.timezone ?? event.timezone,
    },
    fallbackZone,
    switching
      ? {}
      : event.allDay
        ? { days: allDayLength(event) }
        : { ms: event.endsAt.getTime() - event.startsAt.getTime() },
  )
}

/**
 * Title, description, location, times, project tag and sync. Absent fields
 * stay as they are. A change to an event that syncs goes to Google on the
 * next sync; turning sync off takes an HQ-made event off Google there and
 * keeps it here. An event from Google can't be taken out of sync.
 */
export async function updateEvent(
  actor: Actor,
  raw: UpdateEventInput,
): Promise<CalendarEventRow> {
  const input = parseInput(updateSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'calendar_update_event',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { event, project } = await eventForWrite(
          tx,
          actor,
          input.eventId,
          input.expectedRevision,
        )
        const patch: Partial<typeof calendarEvents.$inferInsert> = {}
        if (input.title !== undefined) patch.title = input.title as string
        if (input.description !== undefined)
          patch.description = input.description ?? ''
        if (input.location !== undefined)
          patch.location = input.location ?? null
        let zoneFrom = project
        if (
          input.projectId !== undefined &&
          (input.projectId ?? null) !== event.projectId
        ) {
          if (input.projectId) {
            const target = await ownedProject(
              tx,
              actor,
              input.projectId,
              'calendar',
              'write',
            )
            assertModuleOn(target, 'calendar')
            patch.projectId = target.id
            zoneFrom = target
          } else patch.projectId = null
        }
        if (
          input.allDay !== undefined ||
          input.startsAt !== undefined ||
          input.endsAt !== undefined ||
          input.timezone !== undefined
        )
          Object.assign(
            patch,
            nextWhen(event, input, zoneFrom?.timezone ?? DEFAULT_TIME_ZONE),
          )
        if (input.sync !== undefined && input.sync !== event.sync) {
          if (!input.sync && event.source === 'google')
            throw invalid(
              'An event from Google stays in sync. Delete it to remove it from Google.',
              { sync: 'Events from Google always sync.' },
            )
          patch.sync = input.sync
        }
        const changes = diffFields(
          event as unknown as Record<string, unknown>,
          patch,
        )
        if (Object.keys(changes).length === 0) return event
        const saved = await saveEvent(tx, event, {
          ...patch,
          syncState: stateAfterChange(event, patch.sync ?? event.sync),
          syncProblem: null,
        })
        await audit(tx, actor, {
          projectId: saved.projectId,
          action: 'calendar.event.update',
          targetType: 'event',
          targetId: saved.id,
          beforeRevision: event.revision,
          afterRevision: saved.revision,
          changes,
        })
        return saved
      }),
  )
  if (outcome.kind === 'replay') return readRow(actor, input.eventId)
  await outcome.complete({
    event_id: outcome.value.id,
    revision: outcome.value.revision,
  })
  return outcome.value
}

const decideSchema = z.object({
  eventId: recordId('Event'),
  expectedRevision: revision,
  idempotencyKey: idempotencyKey.optional(),
})

export type DeleteEventInput = z.input<typeof decideSchema>

/**
 * Delete an event (soft: `deleted_at`). One Google has is deleted there by
 * the next sync — so, like archiving a card, it is the owner's, never an
 * agent's.
 */
export async function deleteEvent(
  actor: Actor,
  raw: DeleteEventInput,
): Promise<CalendarEventRow> {
  const input = parseInput(decideSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'calendar_delete_event',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { event } = await eventForWrite(
          tx,
          actor,
          input.eventId,
          input.expectedRevision,
          'owner_only',
        )
        const saved = await saveEvent(tx, event, {
          deletedAt: sql`now()`,
          syncState: event.googleEventId ? 'pending' : 'local',
          syncProblem: null,
        })
        await audit(tx, actor, {
          projectId: saved.projectId,
          action: 'calendar.event.delete',
          targetType: 'event',
          targetId: saved.id,
          beforeRevision: event.revision,
          afterRevision: saved.revision,
          changes: {
            title: event.title,
            inGoogle: Boolean(event.googleEventId),
          },
        })
        return saved
      }),
  )
  if (outcome.kind === 'replay') return readRow(actor, input.eventId)
  await outcome.complete({
    event_id: outcome.value.id,
    revision: outcome.value.revision,
  })
  return outcome.value
}

/**
 * Delete's Undo: the event comes back, and Google never falls out of step.
 *
 * · **Not in Google, or its deletion hasn't gone yet** (`pending`, or
 *   `error` — Google refused it): the event is back as it was, and the next
 *   sync writes HQ's copy over Google's (an insert for one Google never
 *   had, a patch with `If-Match` for one it has — so Google's own later
 *   edit still wins). Should the deletion reach Google in the moment
 *   between, the patch finds it gone and HQ follows Google.
 * · **The deletion already reached Google** (`synced` with a Google ID —
 *   or Google cancelled it itself): refused in words. Putting it back would
 *   be a new Google event without its guests or reminders, which is adding
 *   it again, not undoing.
 *
 * The owner's, like Delete.
 */
export async function restoreEvent(
  actor: Actor,
  raw: DeleteEventInput,
): Promise<CalendarEventRow> {
  const input = parseInput(decideSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'calendar_restore_event',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        assertCan(actor, 'calendar', 'write')
        const { row: event, project } = await ownedRow<CalendarEventRow>(
          tx,
          actor,
          calendarEvents,
          input.eventId,
          'Event',
          { lock: true },
        )
        await authorize(tx, actor, project, 'calendar', 'write', 'owner_only')
        if (project) assertModuleOn(project, 'calendar')
        if (event.revision !== input.expectedRevision) throw conflict()
        if (!event.deletedAt) return event
        if (event.googleEventId && event.syncState === 'synced')
          throw invalid(
            'Google already deleted this event on the last sync, so it can’t come back from here. Add it again if you need it.',
          )
        const saved = await saveEvent(tx, event, {
          deletedAt: null,
          syncState: stateAfterChange(event, event.sync),
          syncProblem: null,
        })
        await audit(tx, actor, {
          projectId: saved.projectId,
          action: 'calendar.event.restore',
          targetType: 'event',
          targetId: saved.id,
          beforeRevision: event.revision,
          afterRevision: saved.revision,
          changes: {
            title: event.title,
            inGoogle: Boolean(event.googleEventId),
          },
        })
        return saved
      }),
  )
  if (outcome.kind === 'replay') return readRow(actor, input.eventId)
  await outcome.complete({
    event_id: outcome.value.id,
    revision: outcome.value.revision,
  })
  return outcome.value
}

/** Send an event whose last write to Google failed on the next sync again. */
export async function retryEventSync(
  actor: Actor,
  raw: z.input<typeof decideSchema>,
): Promise<CalendarEventRow> {
  const input = parseInput(decideSchema, raw)
  return withTransaction(async (tx) => {
    assertCan(actor, 'calendar', 'write')
    const { row: event, project } = await ownedRow<CalendarEventRow>(
      tx,
      actor,
      calendarEvents,
      input.eventId,
      'Event',
      { lock: true },
    )
    await authorize(tx, actor, project, 'calendar', 'write')
    if (event.revision !== input.expectedRevision) throw conflict()
    if (event.syncState !== 'error') return event
    const saved = await saveEvent(tx, event, {
      syncState: 'pending',
      syncProblem: null,
    })
    await audit(tx, actor, {
      projectId: saved.projectId,
      action: 'calendar.event.retry_sync',
      targetType: 'event',
      targetId: saved.id,
      beforeRevision: event.revision,
      afterRevision: saved.revision,
      reason: event.syncProblem,
    })
    return saved
  })
}

/* ── The sync readout ──────────────────────────────────────────────── */

export type CalendarStatus = {
  google: {
    /** Connected, with both calendar scopes: the tick syncs this owner. */
    ready: boolean
    status: GoogleConnectionStatus | null
    email: string | null
    /** Calendar scopes were granted. */
    calendar: boolean
    /** What the connection itself says is wrong. */
    problem: string | null
  }
  /** The calendar the last pass read (the account's address for `primary`). */
  calendarId: string | null
  lastSyncedAt: Date | null
  lastFullSyncAt: Date | null
  /** Why the last pass stopped, in words; null when it finished. */
  problem: string | null
  /** Events waiting to go to Google, and events whose last write failed. */
  pending: number
  errors: number
}

/**
 * What the calendar page's sync readout says: whether Google is connected
 * for Calendar, when the last pass finished, what stopped it, and how many
 * events wait or failed.
 */
export async function calendarStatus(actor: Actor): Promise<CalendarStatus> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'calendar', 'read')
    const [connection] = await db
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.ownerId, actor.userId))
      .limit(1)
    const [state] = await db
      .select()
      .from(calendarSyncState)
      .where(eq(calendarSyncState.ownerId, actor.userId))
      .orderBy(desc(calendarSyncState.updatedAt))
      .limit(1)
    const counts = await db
      .select({
        state: calendarEvents.syncState,
        n: sql<number>`count(*)::int`,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.ownerId, actor.userId),
          inArray(calendarEvents.syncState, ['pending', 'error']),
        ),
      )
      .groupBy(calendarEvents.syncState)
    const calendar = connection ? hasCalendarScopes(connection.scopes) : false
    return {
      google: {
        ready: connection?.status === 'connected' && calendar,
        status: connection?.status ?? null,
        email: connection?.email ?? null,
        calendar,
        problem: connection?.problem ?? null,
      },
      calendarId: state?.calendarId ?? null,
      lastSyncedAt: state?.lastSyncedAt ?? null,
      lastFullSyncAt: state?.lastFullSyncAt ?? null,
      problem: state?.problem ?? null,
      pending: counts.find((row) => row.state === 'pending')?.n ?? 0,
      errors: counts.find((row) => row.state === 'error')?.n ?? 0,
    }
  })
}
