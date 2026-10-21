import { everyWord, registerSearch } from '@theiceji/hq-core/search'
import { registerTarget } from '@theiceji/hq-core/targets'
import { calendarEvents, projects } from '@theiceji/hq-db/schema'
import { registerTickStep } from '@theiceji/hq-ops/runtime'
import { day, text } from '@theiceji/hq-ops/schemas'
import { authorize } from '@theiceji/hq-ops/store'
import { DEFAULT_TIME_ZONE, toLocalInput } from '@theiceji/hq-ops/time'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { allDayDates } from './dates'
import { insertEvent } from './events'
import { calendarTick } from './sync'

/**
 * What Calendar adds to HQ's shared registries when it loads — import this
 * once in every process that runs module services (apps/hq, apps/hq-mcp):
 *
 * · the `calendar.sync` step of the ops tick: each
 *   owner whose Google is connected with Calendar gets a pass every ten
 *   minutes, within the tick's budget (sync.ts);
 * · the `event` target — a note promoted to an event, an agent's accepted
 *   proposal. A bare `date` makes an all-day event; an event
 *   may belong to no project;
 * · events in `hq_search` and the ⌘K palette.
 */

export const eventHref = (slug: string | null, eventId: string) =>
  slug ? `/p/${slug}/calendar?event=${eventId}` : `/calendar?event=${eventId}`

registerTickStep('calendar.sync', (context) => calendarTick(context))

registerTarget({
  type: 'event',
  module: 'calendar',
  label: 'Calendar · event',
  projectOptional: true,
  schema: z
    .object({
      title: text.required('Title', 200),
      /** One whole day, `YYYY-MM-DD`: an all-day event. */
      date: day('Date'),
      startsAt: z.string().trim().max(40).optional(),
      endsAt: z.string().trim().max(40).nullable().optional(),
      allDay: z.boolean().optional(),
      description: text.optional('Description', 8000),
      location: text.optional('Location', 500),
    })
    .refine((payload) => Boolean(payload.date || payload.startsAt), {
      message: 'Give the event a date or a start time.',
      path: ['date'],
    }),
  async create(payload, { tx, actor, project }) {
    await authorize(tx, actor, project, 'calendar', 'write')
    const event = await insertEvent(tx, actor, project, {
      title: payload.title as string,
      description: payload.description ?? null,
      location: payload.location ?? null,
      allDay: payload.startsAt ? payload.allDay : true,
      startsAt: (payload.startsAt ?? payload.date) as string,
      endsAt: payload.endsAt ?? null,
    })
    return {
      type: 'event',
      id: event.id,
      href: eventHref(project?.slug ?? null, event.id),
    }
  },
})

registerSearch({
  type: 'event',
  label: 'Events',
  async search(reader, { ownerId, words, projectId, limit }) {
    const rows = await reader
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        projectId: calendarEvents.projectId,
        allDay: calendarEvents.allDay,
        startsAt: calendarEvents.startsAt,
        endsAt: calendarEvents.endsAt,
        timezone: calendarEvents.timezone,
        slug: projects.slug,
        projectZone: projects.timezone,
      })
      .from(calendarEvents)
      .leftJoin(projects, eq(projects.id, calendarEvents.projectId))
      .where(
        and(
          eq(calendarEvents.ownerId, ownerId),
          isNull(calendarEvents.deletedAt),
          projectId ? eq(calendarEvents.projectId, projectId) : undefined,
          everyWord(
            [
              calendarEvents.title,
              calendarEvents.description,
              calendarEvents.location,
            ],
            words,
          ),
        ),
      )
      .orderBy(desc(calendarEvents.startsAt))
      .limit(limit)
    return rows.map((row) => {
      let detail: string
      if (row.allDay) {
        const { first, last } = allDayDates(row)
        detail = first === last ? first : `${first} – ${last}`
      } else
        detail = toLocalInput(
          row.startsAt,
          row.timezone ?? row.projectZone ?? DEFAULT_TIME_ZONE,
        ).replace('T', ' ')
      return {
        type: 'event',
        id: row.id,
        title: row.title,
        projectId: row.projectId,
        href: eventHref(row.slug, row.id),
        detail,
      }
    })
  },
})
