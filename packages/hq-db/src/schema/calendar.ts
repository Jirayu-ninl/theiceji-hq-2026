import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  CALENDAR_EVENT_SOURCES,
  CALENDAR_SYNC_STATES,
  type CalendarEventSource,
  type CalendarSyncState,
} from '../enums'
import { inOwnProject, ownerColumn, trimmedLength } from './_module'
import { oneOf, tz } from './_shared'
import { tracked } from './_user'

/* ── calendar — the owner's events, two-way with Google ─
 *
 * One table for every event, wherever it was made:
 *
 * · `source = 'hq'` — made in HQ. With `sync` on it goes to the owner's
 *   Google calendar on the next sync step (`sync_state` pending → synced);
 *   with it off it stays in HQ (`local`).
 * · `source = 'google'` — read from Google by the incremental sync in the ops
 *   tick. Changing it in HQ writes back to Google; cancelling it in Google
 *   marks it deleted here.
 *
 * **Times.** A timed event is two instants (`starts_at`, `ends_at`) plus the
 * zone it was written in. An all-day event keeps its dates as midnight UTC —
 * `starts_at` the first day, `ends_at` the day after the last, the way Google
 * writes them — and is always read as dates, never shifted by a zone.
 *
 * `project_id` is HQ's own tag: Google never sees it. A card's due date,
 * a sent quote's expiry and a scheduled post are an overlay the calendar page
 * draws from their own modules, never rows here, and never synced.
 */

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    location: text('location'),
    startsAt: timestamp('starts_at', tz).notNull(),
    endsAt: timestamp('ends_at', tz).notNull(),
    allDay: boolean('all_day').notNull().default(false),
    /** The IANA zone a timed event was written in. */
    timezone: text('timezone'),
    source: text('source').$type<CalendarEventSource>().notNull().default('hq'),
    /** HQ writes this event to Google. */
    sync: boolean('sync').notNull().default(false),
    syncState: text('sync_state')
      .$type<CalendarSyncState>()
      .notNull()
      .default('local'),
    /** Why the last write to Google failed, in words. */
    syncProblem: text('sync_problem'),
    googleCalendarId: text('google_calendar_id'),
    googleEventId: text('google_event_id'),
    googleEtag: text('google_etag'),
    /** Google's own `updated`, to tell our write from theirs. */
    googleUpdatedAt: timestamp('google_updated_at', tz),
    /** A link to the event in Google Calendar. */
    googleHtmlLink: text('google_html_link'),
    syncedAt: timestamp('synced_at', tz),
    deletedAt: timestamp('deleted_at', tz),
  },
  (t) => [
    unique('calendar_events_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('calendar_events_project_fk', t),
    uniqueIndex('calendar_events_google_key')
      .on(t.ownerId, t.googleCalendarId, t.googleEventId)
      .where(sql`${t.googleEventId} is not null`),
    index('calendar_events_range_idx').on(t.ownerId, t.startsAt, t.endsAt),
    index('calendar_events_pending_idx')
      .on(t.ownerId, t.syncState)
      .where(sql`${t.syncState} = 'pending'`),
    check('calendar_events_title_check', trimmedLength(t.title, 200)),
    check(
      'calendar_events_description_check',
      sql`length(${t.description}) <= 8000`,
    ),
    check(
      'calendar_events_source_check',
      oneOf(t.source, CALENDAR_EVENT_SOURCES),
    ),
    check(
      'calendar_events_sync_state_check',
      oneOf(t.syncState, CALENDAR_SYNC_STATES),
    ),
    check('calendar_events_range_check', sql`${t.endsAt} >= ${t.startsAt}`),
    check(
      'calendar_events_all_day_check',
      sql`not ${t.allDay} or (${t.startsAt} = date_trunc('day', ${t.startsAt} at time zone 'UTC') at time zone 'UTC' and ${t.endsAt} > ${t.startsAt})`,
    ),
    check(
      'calendar_events_google_check',
      sql`${t.source} <> 'google' or ${t.googleEventId} is not null`,
    ),
    check(
      'calendar_events_local_check',
      sql`${t.sync} or ${t.syncState} = 'local' or ${t.googleEventId} is not null`,
    ),
  ],
)

/** Where the incremental sync of one Google calendar stands. */
export const calendarSyncState = pgTable(
  'calendar_sync_state',
  {
    ownerId: ownerColumn(),
    calendarId: text('calendar_id').notNull(),
    /** Google's `nextSyncToken`; null means the next pass is a full read. */
    syncToken: text('sync_token'),
    lastSyncedAt: timestamp('last_synced_at', tz),
    lastFullSyncAt: timestamp('last_full_sync_at', tz),
    /** Why the last pass stopped, in words; null when it finished. */
    problem: text('problem'),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'calendar_sync_state_pkey',
      columns: [t.ownerId, t.calendarId],
    }),
  ],
)

export type CalendarEventRow = typeof calendarEvents.$inferSelect
export type CalendarSyncStateRow = typeof calendarSyncState.$inferSelect
