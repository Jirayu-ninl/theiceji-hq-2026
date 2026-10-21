'use server'

import {
  calendarStatus,
  createEvent,
  deleteEvent,
  getEvent,
  restoreEvent,
  retryEventSync,
  updateEvent,
} from '@theiceji/hq-calendar/events'
import '@theiceji/hq-calendar/register'
import { syncNow } from '@theiceji/hq-calendar/sync'
import { type ActionResult, runAction } from '@/lib/actions'
import { type EventData, eventData, type StatusData, statusData } from './data'

/**
 * Calendar's server actions — the hq-calendar services. An event with sync
 * on goes to the owner's Google calendar on the next sync step (or now,
 * with Sync now); deleting one deletes it in Google too, so it is the
 * owner's own act — and Undo brings it back until that sync has gone.
 */

export type EventForm = {
  title: string
  allDay: boolean
  /** `YYYY-MM-DD` for all-day, `YYYY-MM-DDTHH:mm` (local) for timed. */
  startsAt: string
  endsAt: string
  timezone: string
  projectId: string | null
  description: string
  location: string
  sync: boolean
}

export async function createEventAction(
  input: EventForm,
): Promise<ActionResult<EventData>> {
  return runAction(async (actor) => {
    const row = await createEvent(actor, {
      ...input,
      projectId: input.projectId ?? undefined,
      location: input.location || undefined,
    })
    return eventData(await getEvent(actor, row.id))
  })
}

export async function updateEventAction(
  input: EventForm & { eventId: string; expectedRevision: number },
): Promise<ActionResult<EventData>> {
  return runAction(async (actor) => {
    const row = await updateEvent(actor, {
      ...input,
      location: input.location || null,
    })
    return eventData(await getEvent(actor, row.id))
  })
}

/** Delete; answers the revision Undo restores at. */
export async function deleteEventAction(input: {
  eventId: string
  expectedRevision: number
}): Promise<ActionResult<{ revision: number }>> {
  return runAction(async (actor) => {
    const row = await deleteEvent(actor, input)
    return { revision: row.revision }
  })
}

/**
 * Delete's Undo. Refused, in words, once the next sync has taken the event
 * off Google — putting it back then would be adding it again.
 */
export async function restoreEventAction(input: {
  eventId: string
  expectedRevision: number
}): Promise<ActionResult<EventData>> {
  return runAction(async (actor) => {
    const row = await restoreEvent(actor, input)
    return eventData(await getEvent(actor, row.id))
  })
}

export async function retryEventSyncAction(input: {
  eventId: string
  expectedRevision: number
}): Promise<ActionResult<EventData>> {
  return runAction(async (actor) => {
    const row = await retryEventSync(actor, input)
    return eventData(await getEvent(actor, row.id))
  })
}

/** Sync with Google now instead of waiting for the next ten-minute step. */
export async function syncNowAction(): Promise<ActionResult<StatusData>> {
  return runAction(async (actor) => {
    await syncNow(actor)
    return statusData(await calendarStatus(actor))
  })
}
