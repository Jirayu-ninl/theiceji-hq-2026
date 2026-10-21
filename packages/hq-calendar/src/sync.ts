import { randomUUID } from 'node:crypto'
import {
  forgetGoogleTokens,
  GOOGLE_SCOPES,
  googleAccessToken,
  type Http,
} from '@theiceji/hq-core/google'
import {
  type CalendarEventRow,
  calendarEvents,
  calendarSyncState,
  googleConnections,
  opsSchedulerLeases,
  projects,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { schedulerActor } from '@theiceji/hq-ops/actors'
import { dbNow, nowPlus } from '@theiceji/hq-ops/db'
import { OpsError, reauthRequired } from '@theiceji/hq-ops/errors'
import type { TickContext } from '@theiceji/hq-ops/runtime'
import {
  audit,
  authorize,
  type Tx,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import type { PgInsertValue } from 'drizzle-orm/pg-core'
import { hasCalendarScopes } from './events'
import {
  type CalendarClient,
  CalendarRefusal,
  calendarClient,
  type EventContent,
  type EventPage,
  fromGoogle,
  type GoogleEvent,
  googleEventIdFor,
  type PulledEvent,
  toGoogle,
} from './google-calendar'

/**
 * The two-way sync with the owner's Google calendar,
 * one pass per owner: read Google's changes, then write HQ's.
 *
 * · **Read.** The first pass reads a window (60 days back, a year ahead);
 *   after that Google's `nextSyncToken` makes each pass incremental. When
 *   Google forgets the token (410) the pass reads the window again; when it
 *   never hands one out, every pass stays windowed. Events are matched by
 *   `(calendar, Google ID)`, so reading the same page twice changes nothing.
 * · **Write.** Events `pending` go to Google: inserted under an ID HQ chooses
 *   (google-calendar.ts, so a retried insert can't make a second copy),
 *   patched with `If-Match`, deleted, or — sync turned off — taken off.
 * · **Google wins a conflict.** When both sides changed an event, Google's
 *   version replaces HQ's (a 412 on write, or a changed event read while
 *   HQ's change waited). Only HQ's own removal — delete, sync off — goes
 *   ahead of a Google edit.
 * · **One pass per owner at a time**, across processes: a lease row in
 *   `ops_scheduler_leases`, taken and judged by the database's clock (HQ
 *   runs on pooled connections, where a session lock can't be trusted).
 *   A second pass meanwhile returns `ran: false`.
 * · **It stops in time.** A pass starts no Google call once its budget is
 *   nearly spent; what's left waits for the next tick, and nothing it did is
 *   lost — every page and every event commits on its own.
 *
 * The tick has no scopes and passes no policy: this works directly on rows
 * of one owner, and names the scheduler (or whoever pressed "Sync now") as
 * the audit identity.
 */

const DAY_MS = 86_400_000
/** How far back and ahead a full read looks. */
const WINDOW_PAST_DAYS = 60
const WINDOW_AHEAD_DAYS = 365
/** Events one pass writes to Google; the rest go on the next. */
const PUSH_BATCH = 100
/** A pass's own budget when the caller gives none. */
const DEFAULT_BUDGET_MS = 40_000
/** No Google call starts with less than this left. */
const RESERVE_MS = 3_000
/** Longer than any pass; a crashed holder blocks the next pass this long. */
const LEASE_SECONDS = 120
const INSERT_CHUNK = 500

export type SyncReport = {
  /** False when another pass for this owner was running: nothing ran. */
  ran: boolean
  /** The calendar read — the account's address for `primary`. */
  calendarId: string | null
  mode: 'full' | 'incremental' | null
  /** False when the budget ran out first; the next pass carries on. */
  complete: boolean
  pulled: {
    created: number
    updated: number
    deleted: number
    unchanged: number
    skipped: number
  }
  pushed: {
    inserted: number
    patched: number
    deleted: number
    removed: number
    failed: number
  }
  /** HQ changes Google's own change replaced. */
  googleWon: number
}

export type SyncOptions = {
  http?: Http
  /** The read window's "now" — the database's clock unless a test fixes it. */
  now?: Date
  /** The audit identity; the scheduler by default. */
  actor?: Actor
  /** Milliseconds the pass may still use; 40 seconds by default. */
  remainingMs?: () => number
}

function emptyReport(): SyncReport {
  return {
    ran: false,
    calendarId: null,
    mode: null,
    complete: false,
    pulled: { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 },
    pushed: { inserted: 0, patched: 0, deleted: 0, removed: 0, failed: 0 },
    googleWon: 0,
  }
}

type Pass = {
  ownerId: string
  actor: Actor
  client: CalendarClient
  calendarId: string
  calendarZone: string | null
  remainingMs: () => number
  report: SyncReport
}

type LiveEvent = Extract<PulledEvent, { kind: 'event' }>

/* ── The lease and the state row ───────────────────────────────────── */

const leaseName = (ownerId: string) => `calendar-sync:${ownerId}`

async function takeLease(ownerId: string): Promise<string | null> {
  const holder = randomUUID()
  const rows = await withReader((db) =>
    db
      .insert(opsSchedulerLeases)
      .values({
        name: leaseName(ownerId),
        holder,
        acquiredAt: sql`now()`,
        expiresAt: nowPlus(LEASE_SECONDS),
      })
      .onConflictDoUpdate({
        target: opsSchedulerLeases.name,
        set: {
          holder,
          acquiredAt: sql`now()`,
          expiresAt: nowPlus(LEASE_SECONDS),
        },
        setWhere: sql`${opsSchedulerLeases.expiresAt} < now()`,
      })
      .returning({ holder: opsSchedulerLeases.holder }),
  )
  return rows[0]?.holder === holder ? holder : null
}

async function dropLease(ownerId: string, holder: string): Promise<void> {
  await withReader((db) =>
    db
      .delete(opsSchedulerLeases)
      .where(
        and(
          eq(opsSchedulerLeases.name, leaseName(ownerId)),
          eq(opsSchedulerLeases.holder, holder),
        ),
      ),
  )
}

async function saveState(
  ownerId: string,
  calendarId: string,
  values: {
    syncToken?: string | null
    lastSyncedAt?: SQL
    lastFullSyncAt?: SQL
    problem?: string | null
  },
): Promise<void> {
  await withReader((db) =>
    db
      .insert(calendarSyncState)
      .values({ ownerId, calendarId, ...values, updatedAt: sql`now()` })
      .onConflictDoUpdate({
        target: [calendarSyncState.ownerId, calendarSyncState.calendarId],
        set: { ...values, updatedAt: sql`now()` },
      }),
  )
}

/* ── Rows ──────────────────────────────────────────────────────────── */

function contentOf(event: CalendarEventRow): EventContent {
  return {
    title: event.title,
    description: event.description,
    location: event.location,
    allDay: event.allDay,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
  }
}

function sameContent(
  row: CalendarEventRow,
  next: EventContent & { projectId: string | null },
): boolean {
  return (
    row.title === next.title &&
    row.description === next.description &&
    (row.location ?? null) === next.location &&
    row.allDay === next.allDay &&
    row.startsAt.getTime() === next.startsAt.getTime() &&
    row.endsAt.getTime() === next.endsAt.getTime() &&
    (row.timezone ?? null) === next.timezone &&
    row.projectId === next.projectId
  )
}

const googleMarks = (entry: LiveEvent, calendarId: string): GoogleMarks => ({
  googleCalendarId: calendarId,
  googleEventId: entry.googleEventId,
  googleEtag: entry.etag,
  googleUpdatedAt: entry.googleUpdatedAt,
  googleHtmlLink: entry.htmlLink,
})

type GoogleMarks = {
  googleCalendarId: string | null
  googleEventId: string | null
  googleEtag: string | null
  googleUpdatedAt: Date | null
  googleHtmlLink: string | null
}

const noGoogle: GoogleMarks = {
  googleCalendarId: null,
  googleEventId: null,
  googleEtag: null,
  googleUpdatedAt: null,
  googleHtmlLink: null,
}

/** Projects an HQ tag read back from Google may name: the owner's, with Calendar on. */
async function projectsBySlug(
  tx: Tx,
  ownerId: string,
  slugs: string[],
): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map()
  const rows = await tx
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(
      and(
        eq(projects.ownerId, ownerId),
        inArray(projects.slug, slugs),
        sql`${projects.status} <> 'archived' and ${projects.modules} -> 'enabled' ? 'calendar'`,
      ),
    )
  return new Map(rows.map((row) => [row.slug, row.id]))
}

/** Google's word on the project, or the row's own when Google has none. */
function projectFor(
  entry: LiveEvent,
  current: string | null,
  slugs: Map<string, string>,
): string | null {
  if (entry.hqProject === undefined) return current
  if (entry.hqProject === null) return null
  return slugs.get(entry.hqProject) ?? current
}

/**
 * Google's version over HQ's row: its content, its marks, synced. The
 * revision moves only when what HQ shows changed, so a form open on the old
 * version is refused rather than overwriting Google's.
 */
async function takeGoogle(
  tx: Tx,
  pass: Pass,
  row: CalendarEventRow,
  entry: LiveEvent,
  projectId: string | null,
): Promise<boolean> {
  const content = {
    title: entry.title,
    description: entry.description,
    location: entry.location,
    allDay: entry.allDay,
    startsAt: entry.startsAt,
    endsAt: entry.endsAt,
    timezone: entry.timezone,
    projectId,
  }
  const changed = !sameContent(row, content) || row.deletedAt !== null
  await tx
    .update(calendarEvents)
    .set({
      ...(changed
        ? {
            ...content,
            deletedAt: null,
            revision: sql`${calendarEvents.revision} + 1`,
            updatedAt: sql`now()`,
          }
        : {}),
      ...googleMarks(entry, pass.calendarId),
      syncState: 'synced',
      syncProblem: null,
      syncedAt: sql`now()`,
    })
    .where(eq(calendarEvents.id, row.id))
  return changed
}

/** Google cancelled the event. Returns whether HQ's copy changed. */
async function cancelRow(tx: Tx, row: CalendarEventRow): Promise<boolean> {
  const done = { syncProblem: null, syncedAt: sql`now()` }
  if (row.deletedAt) {
    if (row.syncState === 'synced') return false
    await tx
      .update(calendarEvents)
      .set({ ...done, syncState: 'synced' })
      .where(eq(calendarEvents.id, row.id))
    return false
  }
  if (!row.sync && row.source === 'hq') {
    // It was on its way off Google anyway.
    await tx
      .update(calendarEvents)
      .set({ ...done, ...noGoogle, syncState: 'local' })
      .where(eq(calendarEvents.id, row.id))
    return false
  }
  await tx
    .update(calendarEvents)
    .set({
      ...done,
      deletedAt: sql`now()`,
      syncState: 'synced',
      revision: sql`${calendarEvents.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(calendarEvents.id, row.id))
  return true
}

/* ── Read: Google → HQ ─────────────────────────────────────────────── */

/**
 * One page of Google's events in one transaction: new ones inserted, known
 * ones brought up to date, cancelled ones marked deleted, and one audit
 * event saying what changed. An event HQ pushed but never heard back about
 * is recognised by the HQ ID it carries and adopted, not copied.
 */
async function applyPage(pass: Pass, items: GoogleEvent[]): Promise<void> {
  const pulled = items.map((entry) => fromGoogle(entry, pass.calendarZone))
  const live = pulled.filter(
    (entry): entry is LiveEvent => entry.kind === 'event',
  )
  const cancelled = pulled.filter((entry) => entry.kind === 'cancelled')
  const counts = {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    skipped: pulled.length - live.length - cancelled.length,
  }
  let googleWon = 0
  if (live.length + cancelled.length > 0)
    await withTransaction(async (tx) => {
      const googleIds = [...live, ...cancelled].map(
        (entry) => entry.googleEventId,
      )
      const hqIds = live.flatMap((entry) => (entry.hqId ? [entry.hqId] : []))
      const rows = await tx
        .select()
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.ownerId, pass.ownerId),
            or(
              and(
                eq(calendarEvents.googleCalendarId, pass.calendarId),
                inArray(calendarEvents.googleEventId, googleIds),
              ),
              and(
                inArray(calendarEvents.id, hqIds),
                isNull(calendarEvents.googleEventId),
              ),
            ),
          ),
        )
        .for('update')
      const byGoogle = new Map(
        rows.flatMap((row) =>
          row.googleEventId ? [[row.googleEventId, row] as const] : [],
        ),
      )
      const unlinked = new Map(
        rows.flatMap((row) =>
          row.googleEventId ? [] : [[row.id, row] as const],
        ),
      )
      const slugs = await projectsBySlug(tx, pass.ownerId, [
        ...new Set(
          live.flatMap((entry) => (entry.hqProject ? [entry.hqProject] : [])),
        ),
      ])
      const touched: string[] = []

      for (const entry of cancelled) {
        const row = byGoogle.get(entry.googleEventId)
        if (row && (await cancelRow(tx, row))) {
          counts.deleted++
          touched.push(row.id)
        } else counts.unchanged++
      }

      const fresh: PgInsertValue<typeof calendarEvents>[] = []
      for (const entry of live) {
        const row =
          byGoogle.get(entry.googleEventId) ??
          (entry.hqId ? unlinked.get(entry.hqId) : undefined)
        if (!row) {
          fresh.push({
            ownerId: pass.ownerId,
            createdBy: pass.ownerId,
            projectId: projectFor(entry, null, slugs),
            title: entry.title,
            description: entry.description,
            location: entry.location,
            allDay: entry.allDay,
            startsAt: entry.startsAt,
            endsAt: entry.endsAt,
            timezone: entry.timezone,
            source: 'google',
            sync: true,
            syncState: 'synced',
            syncedAt: sql`now()`,
            ...googleMarks(entry, pass.calendarId),
          })
          continue
        }
        if (!row.googleEventId) {
          // HQ inserted it and lost Google's answer: link it, and let the
          // write step settle whatever HQ changed since.
          await tx
            .update(calendarEvents)
            .set({
              ...googleMarks(entry, pass.calendarId),
              syncState: 'pending',
            })
            .where(eq(calendarEvents.id, row.id))
          counts.updated++
          touched.push(row.id)
          continue
        }
        if (row.googleEtag && row.googleEtag === entry.etag) {
          counts.unchanged++
          continue
        }
        if (row.syncState === 'pending' && (row.deletedAt || !row.sync)) {
          // HQ is taking it off Google; that goes ahead of Google's edit.
          counts.unchanged++
          continue
        }
        if (row.syncState === 'pending') googleWon++
        if (
          await takeGoogle(
            tx,
            pass,
            row,
            entry,
            projectFor(entry, row.projectId, slugs),
          )
        ) {
          counts.updated++
          touched.push(row.id)
        } else counts.unchanged++
      }

      for (let at = 0; at < fresh.length; at += INSERT_CHUNK) {
        const made = await tx
          .insert(calendarEvents)
          .values(fresh.slice(at, at + INSERT_CHUNK))
          .onConflictDoNothing()
          .returning({ id: calendarEvents.id })
        counts.created += made.length
        counts.unchanged +=
          Math.min(INSERT_CHUNK, fresh.length - at) - made.length
        touched.push(...made.map((row) => row.id))
      }

      if (touched.length > 0)
        await audit(tx, pass.actor, {
          projectId: null,
          action: 'calendar.sync.pull',
          targetType: 'calendar',
          targetId: null,
          changes: {
            calendar: pass.calendarId,
            created: counts.created,
            updated: counts.updated,
            deleted: counts.deleted,
            googleWon,
            events: touched.slice(0, 50),
          },
        })
    })
  const total = pass.report.pulled
  total.created += counts.created
  total.updated += counts.updated
  total.deleted += counts.deleted
  total.unchanged += counts.unchanged
  total.skipped += counts.skipped
  pass.report.googleWon += googleWon
}

/** Reads Google's changes page by page. False when the budget ran out first. */
async function pull(pass: Pass, now: Date): Promise<boolean> {
  const [state] = await withReader((db) =>
    db
      .select()
      .from(calendarSyncState)
      .where(
        and(
          eq(calendarSyncState.ownerId, pass.ownerId),
          eq(calendarSyncState.calendarId, pass.calendarId),
        ),
      )
      .limit(1),
  )
  let syncToken = state?.syncToken ?? null
  pass.report.mode = syncToken ? 'incremental' : 'full'
  const timeMin = new Date(now.getTime() - WINDOW_PAST_DAYS * DAY_MS)
  const timeMax = new Date(now.getTime() + WINDOW_AHEAD_DAYS * DAY_MS)
  let pageToken: string | null = null
  let restarted = false
  for (;;) {
    if (pass.remainingMs() < RESERVE_MS) return false
    let page: EventPage
    try {
      page = await pass.client.list(
        pass.calendarId,
        syncToken ? { syncToken, pageToken } : { timeMin, timeMax, pageToken },
      )
    } catch (error) {
      if (
        error instanceof CalendarRefusal &&
        error.status === 410 &&
        syncToken &&
        !restarted
      ) {
        // Google forgot where HQ was: read the whole window again.
        restarted = true
        syncToken = null
        pageToken = null
        pass.report.mode = 'full'
        await saveState(pass.ownerId, pass.calendarId, { syncToken: null })
        continue
      }
      throw error
    }
    await applyPage(pass, page.items)
    if (page.nextPageToken) {
      pageToken = page.nextPageToken
      continue
    }
    await saveState(pass.ownerId, pass.calendarId, {
      syncToken: page.nextSyncToken,
      problem: null,
      ...(pass.report.mode === 'full' ? { lastFullSyncAt: sql`now()` } : {}),
    })
    return true
  }
}

/* ── Write: HQ → Google ────────────────────────────────────────────── */

type Written =
  | { kind: 'insert' | 'patch'; remote: GoogleEvent }
  | { kind: 'delete' | 'remove' | 'drop' }

/**
 * Records what Google did with a pushed event. If the event changed in HQ
 * while it was on its way, it stays `pending` for the next pass — with
 * Google's ID, so that pass patches instead of inserting again.
 */
async function settle(
  pass: Pass,
  pushed: CalendarEventRow,
  written: Written,
): Promise<void> {
  await withTransaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, pushed.id))
      .for('update')
    if (!row) return
    let marks: Partial<GoogleMarks> = {}
    if ('remote' in written)
      marks = {
        googleCalendarId: pass.calendarId,
        googleEventId: written.remote.id,
        googleEtag: written.remote.etag ?? null,
        googleUpdatedAt: written.remote.updated
          ? new Date(written.remote.updated)
          : null,
        googleHtmlLink: written.remote.htmlLink ?? null,
      }
    else if (written.kind === 'remove') marks = noGoogle
    const googleEventId =
      marks.googleEventId === undefined
        ? row.googleEventId
        : marks.googleEventId
    const syncState =
      row.revision === pushed.revision
        ? written.kind === 'remove' || written.kind === 'drop'
          ? 'local'
          : 'synced'
        : row.deletedAt
          ? googleEventId
            ? 'pending'
            : 'local'
          : row.sync || googleEventId
            ? 'pending'
            : 'local'
    await tx
      .update(calendarEvents)
      .set({ ...marks, syncState, syncProblem: null, syncedAt: sql`now()` })
      .where(eq(calendarEvents.id, row.id))
    if (written.kind !== 'drop')
      await audit(tx, pass.actor, {
        projectId: row.projectId,
        action: 'calendar.event.push',
        targetType: 'event',
        targetId: row.id,
        afterRevision: row.revision,
        changes: { op: written.kind, googleEventId },
      })
  })
}

/** Google deleted the event HQ was changing: Google wins, HQ's copy is deleted too. */
async function googleDeleted(pass: Pass, pushed: CalendarEventRow) {
  await withTransaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, pushed.id))
      .for('update')
    if (!row) return
    const changed = await cancelRow(tx, row)
    await audit(tx, pass.actor, {
      projectId: row.projectId,
      action: 'calendar.event.pull',
      targetType: 'event',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: changed ? row.revision + 1 : row.revision,
      reason: 'Deleted in Google before HQ’s change reached it.',
    })
  })
  pass.report.pulled.deleted++
  pass.report.googleWon++
}

/** Google changed the event first (412): its version replaces HQ's. */
async function googleKept(
  pass: Pass,
  pushed: CalendarEventRow,
  current: GoogleEvent,
) {
  const entry = fromGoogle(current, pass.calendarZone)
  if (entry.kind !== 'event')
    throw new CalendarRefusal(
      422,
      null,
      'Google changed this event and its new version can’t be read.',
    )
  await withTransaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, pushed.id))
      .for('update')
    if (!row) return
    const slugs = await projectsBySlug(
      tx,
      pass.ownerId,
      entry.hqProject ? [entry.hqProject] : [],
    )
    const changed = await takeGoogle(
      tx,
      pass,
      row,
      entry,
      projectFor(entry, row.projectId, slugs),
    )
    await audit(tx, pass.actor, {
      projectId: row.projectId,
      action: 'calendar.event.pull',
      targetType: 'event',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: changed ? row.revision + 1 : row.revision,
      reason:
        'Changed in Google before HQ’s change reached it; Google’s version kept.',
    })
  })
  pass.report.pulled.updated++
  pass.report.googleWon++
}

/** Google refused this one event; the reason is kept for the owner, and the rest go on. */
async function refused(pass: Pass, pushed: CalendarEventRow, message: string) {
  await withTransaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, pushed.id))
      .for('update')
    if (row?.revision !== pushed.revision) return
    const problem = `Google refused this change: ${message}`
    await tx
      .update(calendarEvents)
      .set({ syncState: 'error', syncProblem: problem })
      .where(eq(calendarEvents.id, row.id))
    await audit(tx, pass.actor, {
      projectId: row.projectId,
      action: 'calendar.event.push_failed',
      targetType: 'event',
      targetId: row.id,
      afterRevision: row.revision,
      reason: problem,
    })
  })
  pass.report.pushed.failed++
}

async function pushOne(
  pass: Pass,
  event: CalendarEventRow,
  slug: string | null,
): Promise<void> {
  const { client, calendarId, report } = pass
  try {
    if (event.deletedAt || !event.sync) {
      if (!event.googleEventId) return settle(pass, event, { kind: 'drop' })
      await client.remove(calendarId, event.googleEventId)
      await settle(pass, event, { kind: event.deletedAt ? 'delete' : 'remove' })
      if (event.deletedAt) report.pushed.deleted++
      else report.pushed.removed++
      return
    }
    const content = { ...contentOf(event), id: event.id }
    if (!event.googleEventId) {
      const id = googleEventIdFor(event)
      let remote: GoogleEvent
      try {
        remote = await client.insert(calendarId, {
          id,
          ...toGoogle(content, slug, 'insert'),
        })
      } catch (error) {
        if (!(error instanceof CalendarRefusal && error.status === 409))
          throw error
        // An earlier try went through and its answer was lost.
        const existing = await client.get(calendarId, id)
        if (!existing) throw error
        if (existing.status === 'cancelled') return googleDeleted(pass, event)
        remote = existing
      }
      await settle(pass, event, { kind: 'insert', remote })
      report.pushed.inserted++
      return
    }
    try {
      const remote = await client.patch(
        calendarId,
        event.googleEventId,
        toGoogle(content, slug, 'patch'),
        event.googleEtag,
      )
      await settle(pass, event, { kind: 'patch', remote })
      report.pushed.patched++
    } catch (error) {
      if (!(error instanceof CalendarRefusal)) throw error
      if (error.status === 404 || error.status === 410)
        return googleDeleted(pass, event)
      if (error.status !== 412) throw error
      const current = await client.get(calendarId, event.googleEventId)
      if (!current || current.status === 'cancelled')
        return googleDeleted(pass, event)
      await googleKept(pass, event, current)
    }
  } catch (error) {
    if (!(error instanceof CalendarRefusal)) throw error
    await refused(pass, event, error.message)
  }
}

/** Writes pending events to Google, oldest change first. False when some wait for the next pass. */
async function push(pass: Pass): Promise<boolean> {
  // An event linked to another calendar than the connected one (the owner
  // switched Google accounts) has nowhere to go.
  await withReader((db) =>
    db
      .update(calendarEvents)
      .set({
        syncState: 'error',
        syncProblem: sql`'This event is in another Google calendar (' || ${calendarEvents.googleCalendarId} || ') than the one connected now. Reconnect that account to change it there.'`,
      })
      .where(
        and(
          eq(calendarEvents.ownerId, pass.ownerId),
          eq(calendarEvents.syncState, 'pending'),
          isNotNull(calendarEvents.googleCalendarId),
          ne(calendarEvents.googleCalendarId, pass.calendarId),
        ),
      ),
  )
  const rows = await withReader((db) =>
    db
      .select({ event: calendarEvents, slug: projects.slug })
      .from(calendarEvents)
      .leftJoin(projects, eq(projects.id, calendarEvents.projectId))
      .where(
        and(
          eq(calendarEvents.ownerId, pass.ownerId),
          eq(calendarEvents.syncState, 'pending'),
          or(
            isNull(calendarEvents.googleCalendarId),
            eq(calendarEvents.googleCalendarId, pass.calendarId),
          ),
        ),
      )
      .orderBy(asc(calendarEvents.updatedAt))
      .limit(PUSH_BATCH),
  )
  for (const { event, slug } of rows) {
    if (pass.remainingMs() < RESERVE_MS) return false
    await pushOne(pass, event, slug)
  }
  return rows.length < PUSH_BATCH
}

/* ── One pass ──────────────────────────────────────────────────────── */

/**
 * One sync pass for one owner: read Google's changes, then write HQ's.
 * Throws `reauth_required` when Google isn't connected for Calendar or
 * refuses HQ (nothing is written then), `provider_unavailable` when Google
 * is busy — after recording the reason for the page's readout. Returns
 * `ran: false` when a pass for this owner is already running.
 */
export async function syncOwnerCalendar(
  ownerId: string,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const http = options.http ?? fetch
  const started = performance.now()
  const remainingMs =
    options.remainingMs ??
    (() => DEFAULT_BUDGET_MS - (performance.now() - started))
  const report = emptyReport()
  const [connection] = await withReader((db) =>
    db
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.ownerId, ownerId))
      .limit(1),
  )
  if (connection?.status !== 'connected')
    throw reauthRequired(
      connection?.status === 'needs_reauth'
        ? 'Google needs you to sign in again. Reconnect in Settings › Google.'
        : 'Google isn’t connected. Connect it in Settings › Google to sync the calendar.',
    )
  if (!hasCalendarScopes(connection.scopes))
    throw reauthRequired(
      'Google didn’t give HQ access to Calendar. Reconnect Google in Settings › Google and allow Calendar.',
    )
  const holder = await takeLease(ownerId)
  if (!holder) return report
  report.ran = true
  let calendarId = connection.calendarId ?? 'primary'
  try {
    const client = calendarClient(async (fresh) => {
      if (fresh) forgetGoogleTokens(ownerId)
      return googleAccessToken(ownerId, http)
    }, http)
    const calendar = await client.calendar(calendarId)
    calendarId = calendar.id
    report.calendarId = calendarId
    const pass: Pass = {
      ownerId,
      actor: options.actor ?? schedulerActor(ownerId),
      client,
      calendarId,
      calendarZone: calendar.timeZone,
      remainingMs,
      report,
    }
    const now = options.now ?? (await withReader(dbNow))
    if (!(await pull(pass, now))) return report
    report.complete = await push(pass)
    if (report.complete)
      await saveState(ownerId, calendarId, {
        lastSyncedAt: sql`now()`,
        problem: null,
      })
    return report
  } catch (error) {
    const problem =
      error instanceof OpsError
        ? error
        : error instanceof CalendarRefusal
          ? new OpsError(
              'capability_unavailable',
              `Google Calendar refused the sync: ${error.message}`,
            )
          : null
    if (!problem) throw error
    // Before Google named the calendar, the problem belongs to the one the
    // owner's last pass read, not to a row for `primary`.
    const [last] = report.calendarId
      ? []
      : await withReader((db) =>
          db
            .select({ calendarId: calendarSyncState.calendarId })
            .from(calendarSyncState)
            .where(eq(calendarSyncState.ownerId, ownerId))
            .orderBy(desc(calendarSyncState.updatedAt))
            .limit(1),
        )
    await saveState(ownerId, last?.calendarId ?? calendarId, {
      problem: problem.message,
    })
    throw problem
  } finally {
    await dropLease(ownerId, holder)
  }
}

/** "Sync now" from the calendar page: the same pass, in the caller's name. */
export async function syncNow(
  actor: Actor,
  options: Omit<SyncOptions, 'actor'> = {},
): Promise<SyncReport> {
  await withReader((db) => authorize(db, actor, null, 'calendar', 'write'))
  return syncOwnerCalendar(actor.userId, { ...options, actor })
}

/* ── The tick step ─────────────────────────────────────────────────── */

/** Minutes between passes for one owner — and the wait after one failed. */
export const SYNC_EVERY_MINUTES = 10
/** Owners one tick looks at; the rest wait for the next. */
const OWNERS_PER_TICK = 10
/** Left for the tick's own steps after this one (event delivery). */
const TICK_RESERVE_MS = 8_000

/**
 * Owners whose Google is connected with Calendar and who haven't had a
 * pass in the last ten minutes — nor a failed one, which waits as long —
 * longest-waiting first. Judged by the database's clock.
 */
export async function dueCalendarOwners(limit = OWNERS_PER_TICK) {
  const every = sql.raw(`interval '${SYNC_EVERY_MINUTES} minutes'`)
  const rows = await withReader((db) =>
    db
      .select({ ownerId: googleConnections.ownerId })
      .from(googleConnections)
      .where(
        and(
          eq(googleConnections.status, 'connected'),
          sql`${googleConnections.scopes} @> array[${GOOGLE_SCOPES[1]}, ${GOOGLE_SCOPES[2]}]::text[]`,
          sql`not exists (select 1 from ${calendarSyncState} where ${calendarSyncState.ownerId} = ${googleConnections.ownerId} and (${calendarSyncState.lastSyncedAt} > now() - ${every} or (${calendarSyncState.problem} is not null and ${calendarSyncState.updatedAt} > now() - ${every})))`,
        ),
      )
      .orderBy(
        sql`(select max(${calendarSyncState.lastSyncedAt}) from ${calendarSyncState} where ${calendarSyncState.ownerId} = ${googleConnections.ownerId}) asc nulls first`,
      )
      .limit(limit),
  )
  return rows.map((row) => row.ownerId)
}

export type CalendarTickReport = {
  due: number
  synced: number
  /** Owners whose pass was already running elsewhere. */
  busy: number
  /** Owners left for the next tick because time ran out. */
  deferred: number
  failed: { ownerId: string; code: string }[]
}

/**
 * The `calendar.sync` step of the ops tick: a pass for each due owner while
 * the tick's budget lasts. One owner's failure is reported by its code and
 * never stops the others; messages stay out of the report.
 */
export async function calendarTick(
  context: TickContext,
  options: { http?: Http } = {},
): Promise<CalendarTickReport> {
  const due = await dueCalendarOwners()
  const report: CalendarTickReport = {
    due: due.length,
    synced: 0,
    busy: 0,
    deferred: 0,
    failed: [],
  }
  for (const [index, ownerId] of due.entries()) {
    if (context.remainingMs() < TICK_RESERVE_MS + RESERVE_MS * 3) {
      report.deferred = due.length - index
      break
    }
    try {
      const result = await syncOwnerCalendar(ownerId, {
        ...options,
        remainingMs: () => context.remainingMs() - TICK_RESERVE_MS,
      })
      if (result.ran) report.synced++
      else report.busy++
    } catch (error) {
      report.failed.push({
        ownerId,
        code: error instanceof OpsError ? error.code : 'error',
      })
    }
  }
  return report
}
