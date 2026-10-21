import { allDayDates } from '@theiceji/hq-calendar/dates'
import {
  calendarStatus,
  createEvent,
  type EventItem,
  listEvents,
} from '@theiceji/hq-calendar/events'
import '@theiceji/hq-calendar/register'
import type { CalendarEventRow } from '@theiceji/hq-db/schema'
import { z } from 'zod'
import { defineTool, defineWorkspace } from '../../kernel'
import {
  defined,
  idempotencyKeyArg,
  projectIdArg,
  READ,
  readTool,
  WRITE,
  writeTool,
} from '../support'

/**
 * `calendar` — the owner's events: read a run of days, add an
 * event. Changing, deleting and syncing are the owner's, in HQ. A new event
 * goes to the owner's Google calendar on the next sync when Google is
 * connected (unless `sync` is false); nobody is ever invited or emailed.
 */

function eventOut(event: CalendarEventRow | EventItem) {
  const dates = event.allDay ? allDayDates(event) : null
  return {
    id: event.id,
    project_id: event.projectId,
    ...('project' in event && event.project
      ? { project: { slug: event.project.slug, name: event.project.name } }
      : {}),
    title: event.title,
    description: event.description,
    location: event.location,
    all_day: event.allDay,
    first_day: dates?.first ?? null,
    last_day: dates?.last ?? null,
    starts_at: event.startsAt,
    ends_at: event.endsAt,
    timezone: event.timezone,
    source: event.source,
    sync: event.sync,
    sync_state: event.syncState,
    sync_problem: event.syncProblem,
    google_link: event.googleHtmlLink,
    deleted_at: event.deletedAt,
    revision: event.revision,
    updated_at: event.updatedAt,
  }
}

const dayArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date: YYYY-MM-DD.')

const timeZoneArg = z
  .string()
  .max(64)
  .describe('An IANA timezone, e.g. Asia/Bangkok.')

export const listEventsTool = defineTool({
  name: 'list_events',
  title: 'List calendar events',
  description:
    'Events that touch the days from–to, inclusive (today and the next 30 days when left out): one project’s, or all of the owner’s. Timed events are placed in the project’s timezone (or timezone); all-day events by their own dates, with first_day and last_day inclusive. Also says whether Google Calendar is connected and when it last synced. Card due dates aren’t events — read them with board_list_cards.',
  scope: 'calendar:read',
  input: z.object({
    project_id: projectIdArg.optional(),
    from: dayArg.optional().describe('The first day, YYYY-MM-DD.'),
    to: dayArg
      .optional()
      .describe('The last day, YYYY-MM-DD — at most 400 days after from.'),
    timezone: timeZoneArg
      .optional()
      .describe(
        'The zone days are read in without a project; a project’s own wins.',
      ),
    include_deleted: z.boolean().optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      async (actor) => {
        const [range, status] = await Promise.all([
          listEvents(
            actor,
            defined({
              projectId: args.project_id,
              from: args.from,
              to: args.to,
              timezone: args.timezone,
              includeDeleted: args.include_deleted,
            }),
          ),
          calendarStatus(actor),
        ])
        return { range, status }
      },
      ({ range, status }) => ({
        text:
          `${range.events.length} event(s) from ${range.from} to ${range.to} (${range.timezone}). ` +
          (status.google.ready
            ? `Google Calendar is connected${status.lastSyncedAt ? `; last synced ${status.lastSyncedAt.toISOString()}` : '; not synced yet'}${status.problem ? `; last problem: ${status.problem}` : ''}.`
            : 'Google Calendar isn’t connected; events stay in HQ.'),
        data: {
          from: range.from,
          to: range.to,
          timezone: range.timezone,
          events: range.events.map(eventOut),
          google: {
            connected: status.google.ready,
            last_synced_at: status.lastSyncedAt,
            problem: status.problem ?? status.google.problem,
            pending: status.pending,
            errors: status.errors,
          },
        },
      }),
    ),
})

export const createEventTool = defineTool({
  name: 'create_event',
  title: 'Create a calendar event',
  description:
    'Add an event, in a project or in none. All-day: starts_at is a date ("2026-10-05") and ends_at the last day, inclusive. Timed: an ISO time with its offset, or local "2026-10-05T09:30" read in timezone (the project’s by default); without ends_at it lasts an hour. It goes to the owner’s Google calendar on the next sync when Google is connected, unless sync is false. Nobody is invited or emailed. Needs your operating policy to allow drafting.',
  scope: 'calendar:write',
  input: z.object({
    project_id: projectIdArg.optional(),
    title: z.string().min(1).max(200),
    starts_at: z
      .string()
      .min(1)
      .max(40)
      .describe(
        'A date (YYYY-MM-DD) for an all-day event, or a time (YYYY-MM-DDTHH:mm, or ISO with an offset).',
      ),
    ends_at: z
      .string()
      .max(40)
      .optional()
      .describe(
        'All-day: the last day, inclusive. Timed: the end. Left out: one day, or an hour.',
      ),
    all_day: z
      .boolean()
      .optional()
      .describe('Left out: a bare date means all-day.'),
    timezone: timeZoneArg.optional(),
    description: z.string().max(8000).optional(),
    location: z.string().max(500).optional(),
    sync: z
      .boolean()
      .optional()
      .describe(
        'Write it to the owner’s Google calendar. Left out: yes when Google is connected.',
      ),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        createEvent(
          actor,
          defined({
            projectId: args.project_id,
            title: args.title,
            startsAt: args.starts_at,
            endsAt: args.ends_at,
            allDay: args.all_day,
            timezone: args.timezone,
            description: args.description,
            location: args.location,
            sync: args.sync,
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof createEvent>[1],
        ),
      (event) => ({
        text: `Created “${event.title}” (revision ${event.revision})${event.sync ? ' — it goes to Google Calendar on the next sync' : ', in HQ only'}.`,
        data: {
          target: { type: 'event', id: event.id, revision: event.revision },
          event: eventOut(event),
        },
      }),
    ),
})

export const calendar = defineWorkspace({
  id: 'calendar',
  label: 'Calendar',
  description:
    'The owner’s events — made in HQ or read from Google Calendar — by project or across all of them.',
  instructions:
    'Read the days you care about with calendar_list_events before adding to them. calendar_create_event never invites or emails anyone. Changing, deleting and syncing events are the owner’s, in HQ.',
  tools: [listEventsTool, createEventTool],
})
