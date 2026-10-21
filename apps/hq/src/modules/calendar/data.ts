import type { CalendarStatus, EventItem } from '@theiceji/hq-calendar/events'

/** Calendar records as they cross to the page: plain JSON, instants as ISO strings. */

export type EventData = {
  id: string
  title: string
  description: string
  location: string | null
  startsAt: string
  endsAt: string
  allDay: boolean
  /** An all-day event's first and last day, inclusive. */
  dates: { first: string; last: string } | null
  timezone: string | null
  projectId: string | null
  project: { id: string; slug: string; name: string; color: string } | null
  source: 'hq' | 'google'
  sync: boolean
  syncState: 'local' | 'pending' | 'synced' | 'error'
  syncProblem: string | null
  googleLink: string | null
  revision: number
}

/** Something dated from another module, drawn over the calendar and never synced. */
export type OverlayData = {
  id: string
  kind: 'card' | 'quote'
  day: string
  label: string
  projectId: string | null
  color: string | null
  href: string
}

export type StatusData = {
  ready: boolean
  status: string | null
  email: string | null
  calendar: boolean
  problem: string | null
  lastSyncedAt: string | null
  pending: number
  errors: number
}

export function eventData(event: EventItem): EventData {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    location: event.location,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    allDay: event.allDay,
    dates: event.dates,
    timezone: event.timezone,
    projectId: event.projectId,
    project: event.project
      ? {
          id: event.project.id,
          slug: event.project.slug,
          name: event.project.name,
          color: event.project.color,
        }
      : null,
    source: event.source,
    sync: event.sync,
    syncState: event.syncState,
    syncProblem: event.syncProblem,
    googleLink: event.googleHtmlLink,
    revision: event.revision,
  }
}

export function statusData(status: CalendarStatus): StatusData {
  return {
    ready: status.google.ready,
    status: status.google.status,
    email: status.google.email,
    calendar: status.google.calendar,
    problem: status.problem ?? status.google.problem,
    lastSyncedAt: status.lastSyncedAt?.toISOString() ?? null,
    pending: status.pending,
    errors: status.errors,
  }
}
