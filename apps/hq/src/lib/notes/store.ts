import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm'
import { getDb, isDbConfigured, requireDb } from '@/db'
import { type NoteRow, notes } from '@/db/schema'
import {
  BODY_MAX,
  type Note,
  type NotePatch,
  type NoteView,
  normalizeLabels,
  STALE_DAYS,
  TITLE_MAX,
  TRASH_DAYS,
} from './types'

/**
 * Data access for the `notes` table. Server-only, and every function returns a
 * plain serialisable shape (dates as ISO strings) so results can cross the
 * server→client boundary into the board — the same contract the Inbox store
 * keeps.
 *
 * `isConfigured()` lets the page degrade to the not-configured banner instead
 * of throwing when DATABASE_URL is absent.
 *
 * Every function takes the owner's user id first and reads or writes only
 * that owner's notes (migration `0009_notes_owner`): a note id
 * from someone else reads as not found. Filing a note under another owner's
 * project is refused by the database (`notes_project_owner_fk`).
 */

const mine = (ownerId: string) => eq(notes.ownerId, ownerId)
const one = (ownerId: string, id: string) =>
  and(mine(ownerId), sql`${notes.id} = ${id}`)

function toNote(r: NoteRow): Note {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    title: r.title,
    body: r.body,
    color: r.color,
    pinned: r.pinned,
    labels: r.labels ?? [],
    position: r.position,
    promotedTo: r.promotedTo ?? null,
    projectId: r.projectId ?? null,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    deletedAt: r.deletedAt?.toISOString() ?? null,
  }
}

export function isConfigured(): boolean {
  return isDbConfigured()
}

/** A note is in exactly one bucket: trashed wins over archived over active. */
function bucket(view: NoteView) {
  if (view === 'trash') return isNotNull(notes.deletedAt)
  if (view === 'archive')
    return and(isNull(notes.deletedAt), isNotNull(notes.archivedAt))
  return and(isNull(notes.deletedAt), isNull(notes.archivedAt))
}

/**
 * Only the active board is hand-ordered. Archive and trash are a history, so
 * they read newest-first by the timestamp that put the note there.
 */
function ordering(view: NoteView) {
  if (view === 'trash') return [desc(notes.deletedAt)]
  if (view === 'archive') return [desc(notes.archivedAt)]
  return [desc(notes.pinned), asc(notes.position), desc(notes.updatedAt)]
}

/** `%`, `_` and the escape character itself are literals in a search box. */
function likeFragment(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/**
 * Every timestamp this table holds comes from the database, never from Node.
 * `createdAt` already defaults to `now()`, so a write that stamped its own
 * `new Date()` would be comparing two clocks — and any skew between them
 * reorders a board that sorts on exactly these columns.
 */
const now = () => sql`now()`

export async function listNotes(
  ownerId: string,
  options?: {
    view?: NoteView
    label?: string
    query?: string
    /** One project's notes; `null` for the unfiled ones; absent for all. */
    projectId?: string | null
  },
): Promise<Note[]> {
  const db = requireDb()
  const view = options?.view ?? 'active'
  const where = [mine(ownerId), bucket(view)]
  if (options?.projectId === null) where.push(isNull(notes.projectId))
  else if (options?.projectId)
    where.push(sql`${notes.projectId} = ${options.projectId}`)
  if (options?.label) {
    where.push(sql`${notes.labels} @> ARRAY[${options.label}]::text[]`)
  }
  const query = options?.query?.trim()
  if (query) {
    const like = likeFragment(query)
    where.push(or(ilike(notes.title, like), ilike(notes.body, like)))
  }
  const rows = await db
    .select()
    .from(notes)
    .where(and(...where))
    .orderBy(...ordering(view))
  return rows.map(toNote)
}

/**
 * The command menu's lookup: the few most recently touched notes matching a
 * query, across the board and the archive but never the trash — a deleted
 * note is not a destination.
 */
export async function searchNotes(
  ownerId: string,
  query: string,
  limit = 6,
): Promise<Note[]> {
  const text = query.trim()
  if (!text) return []
  const db = requireDb()
  const like = likeFragment(text)
  const rows = await db
    .select()
    .from(notes)
    .where(
      and(
        mine(ownerId),
        isNull(notes.deletedAt),
        or(ilike(notes.title, like), ilike(notes.body, like)),
      ),
    )
    .orderBy(desc(notes.updatedAt))
    .limit(limit)
  return rows.map(toNote)
}

export async function getNote(
  ownerId: string,
  id: string,
): Promise<Note | null> {
  const db = requireDb()
  const [row] = await db.select().from(notes).where(one(ownerId, id))
  return row ? toNote(row) : null
}

/**
 * Every label in use, case-insensitively de-duplicated. Read from the rows
 * rather than a set-returning function: at this scale the flattening is free
 * and the query stays a plain select.
 */
export async function listLabels(ownerId: string): Promise<string[]> {
  const db = requireDb()
  const rows = await db
    .select({ labels: notes.labels })
    .from(notes)
    .where(and(mine(ownerId), isNull(notes.deletedAt)))
    // Oldest first, so the casing a label was first written in is the one kept.
    .orderBy(asc(notes.createdAt), desc(notes.position))
  const seen = new Map<string, string>()
  for (const row of rows) {
    for (const label of row.labels ?? []) {
      const key = label.toLowerCase()
      if (!seen.has(key)) seen.set(key, label)
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

export type NoteCounts = { active: number; pinned: number; stale: number }

/**
 * The Overview's one line about the board, in a single pass over the active
 * notes. It answers with nulls instead of throwing, because the Overview has
 * to render on a box with no database configured — the contract `countNew()`
 * already keeps for the Inbox.
 */
export async function countNotes(ownerId: string): Promise<NoteCounts | null> {
  const db = getDb()
  if (!db) return null
  try {
    const [row] = await db
      .select({
        active: count(),
        pinned: sql<number>`count(*) filter (where ${notes.pinned})`,
        stale: sql<number>`count(*) filter (where ${notes.updatedAt} < now() - make_interval(days => ${STALE_DAYS}))`,
      })
      .from(notes)
      .where(
        and(mine(ownerId), isNull(notes.deletedAt), isNull(notes.archivedAt)),
      )
    if (!row) return null
    return {
      active: Number(row.active),
      pinned: Number(row.pinned),
      stale: Number(row.stale),
    }
  } catch {
    return null
  }
}

/** Shared by create and update — the column values a patch actually sets. */
function columns(patch: NotePatch) {
  const set: Partial<typeof notes.$inferInsert> = {}
  if (patch.title !== undefined) {
    const title = patch.title?.trim().slice(0, TITLE_MAX) ?? ''
    set.title = title || null
  }
  if (patch.body !== undefined) set.body = patch.body.slice(0, BODY_MAX)
  if (patch.color !== undefined) set.color = patch.color
  if (patch.pinned !== undefined) set.pinned = patch.pinned
  if (patch.labels !== undefined) set.labels = normalizeLabels(patch.labels)
  if (patch.projectId !== undefined) set.projectId = patch.projectId
  return set
}

/**
 * A new note lands at the top of the board: it takes the lowest position on
 * the owner's board, minus one. Two notes created at the same instant can tie, which
 * the `updatedAt` tie-break settles.
 */
export async function createNote(
  ownerId: string,
  patch: NotePatch,
): Promise<Note> {
  const db = requireDb()
  const [low] = await db
    .select({ lowest: sql<number | null>`min(${notes.position})` })
    .from(notes)
    .where(mine(ownerId))
  const [row] = await db
    .insert(notes)
    .values({ ...columns(patch), ownerId, position: (low?.lowest ?? 0) - 1 })
    .returning()
  if (!row) throw new Error('Insert returned no row.')
  return toNote(row)
}

export async function updateNote(
  ownerId: string,
  id: string,
  patch: NotePatch,
): Promise<Note | null> {
  const db = requireDb()
  const set = columns(patch)
  if (Object.keys(set).length === 0) return getNote(ownerId, id)
  const [row] = await db
    .update(notes)
    .set({ ...set, updatedAt: now() })
    .where(one(ownerId, id))
    .returning()
  return row ? toNote(row) : null
}

/** Archiving unpins: a pinned note in the archive would have nowhere to sit. */
export async function setArchived(
  ownerId: string,
  id: string,
  archived: boolean,
): Promise<Note | null> {
  const db = requireDb()
  const [row] = await db
    .update(notes)
    .set({
      archivedAt: archived ? now() : null,
      ...(archived ? { pinned: false } : {}),
      updatedAt: now(),
    })
    .where(one(ownerId, id))
    .returning()
  return row ? toNote(row) : null
}

/**
 * The trash is reversible — restoring puts a note back in the bucket it came
 * from, because `archivedAt` is left exactly as it was.
 */
export async function setDeleted(
  ownerId: string,
  id: string,
  deleted: boolean,
): Promise<Note | null> {
  const db = requireDb()
  const [row] = await db
    .update(notes)
    .set({
      deletedAt: deleted ? now() : null,
      ...(deleted ? { pinned: false } : {}),
      updatedAt: now(),
    })
    .where(one(ownerId, id))
    .returning()
  return row ? toNote(row) : null
}

/** Gone for good, from the trash only — the board never hard-deletes a note. */
export async function purge(ownerId: string, id: string): Promise<void> {
  const db = requireDb()
  await db
    .delete(notes)
    .where(and(one(ownerId, id), isNotNull(notes.deletedAt)))
}

export async function emptyTrash(ownerId: string): Promise<number> {
  const db = requireDb()
  const rows = await db
    .delete(notes)
    .where(and(mine(ownerId), isNotNull(notes.deletedAt)))
    .returning({ id: notes.id })
  return rows.length
}

/**
 * The 30-day sweep. Called when the board loads rather than from a cron: the
 * only way a note expires is with someone there to see the trash empty out.
 */
export async function purgeExpired(ownerId: string): Promise<number> {
  const db = requireDb()
  const rows = await db
    .delete(notes)
    .where(
      and(
        mine(ownerId),
        sql`${notes.deletedAt} < now() - make_interval(days => ${TRASH_DAYS})`,
      ),
    )
    .returning({ id: notes.id })
  return rows.length
}

/**
 * Rewrite the hand-order outright: `ids` is the board's active bucket in the
 * order it should read. One transaction, so a failure halfway leaves the old
 * order intact rather than an interleaving of both.
 */
export async function reorder(
  ownerId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return
  const db = requireDb()
  await db.transaction(async (tx) => {
    for (const [index, id] of ids.entries()) {
      await tx.update(notes).set({ position: index }).where(one(ownerId, id))
    }
  })
}
