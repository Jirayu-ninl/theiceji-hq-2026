import 'server-only'
import { link } from '@theiceji/hq-core/refs'
import {
  type CreatedTarget,
  createTarget,
  listTargets,
} from '@theiceji/hq-core/targets'
import { notes, type ProjectRow, refs } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { invalid, notFound } from '@theiceji/hq-ops/errors'
import {
  audit,
  isUuid,
  ownedProject,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { zonedDay } from '@theiceji/hq-ops/time'
import { and, eq, sql } from 'drizzle-orm'
import '@/modules/register'
import { fallbackTitle } from './types'

/**
 * Promote: a note becomes a card, a
 * prompt, a shot (film projects) or an event through the target registry —
 * the same adapters an agent's accepted proposal uses. One transaction makes
 * the new record, links `note —promoted_to→ record` in `refs` and records on
 * the note where it went. The note stays, linked to its new home; Unlink
 * forgets the link and keeps both.
 *
 * Only the signed-in owner's notes can be promoted or unlinked (`owner_id`,
 * migration 0009) — someone else's note id reads as not found.
 */

export type PromoteTarget = { type: string; label: string }

/** What a project can take right now — or, with no project, what may float. */
export function promoteTargets(project: ProjectRow | null): PromoteTarget[] {
  // The designed order, not the registry's — that one is
  // whichever module happened to register first in this process.
  return listTargets(project)
    .filter((adapter) => PROMOTE_ORDER.includes(adapter.type))
    .filter((adapter) => adapter.type !== 'shot' || project?.kind === 'film')
    .sort(
      (a, b) => PROMOTE_ORDER.indexOf(a.type) - PROMOTE_ORDER.indexOf(b.type),
    )
    .map((adapter) => ({ type: adapter.type, label: adapter.label }))
}

const PROMOTE_ORDER = ['card', 'prompt', 'shot', 'event']

function payloadFor(
  type: string,
  note: { title: string | null; body: string; labels: string[] },
  project: ProjectRow | null,
): Record<string, unknown> {
  const title = (
    note.title?.trim() ||
    fallbackTitle(note.body) ||
    'Untitled note'
  ).slice(0, 160)
  switch (type) {
    case 'card':
      return { title, body: note.body || undefined, labels: note.labels }
    case 'prompt':
      return {
        title,
        text: note.body.trim() || title,
        medium: 'image',
        tags: note.labels.slice(0, 16),
      }
    case 'event':
      return {
        title,
        date: zonedDay(new Date(), project?.timezone ?? 'Asia/Bangkok'),
        description: note.body || undefined,
      }
    case 'shot':
      // A shot is "who does what" — the note's words, in the last scene.
      return {
        action: [note.title?.trim(), note.body.trim()]
          .filter(Boolean)
          .join(' — ')
          .slice(0, 2000),
      }
    default:
      return { title, body: note.body }
  }
}

export async function promoteNote(
  actor: Actor,
  input: { noteId: string; projectId: string | null; target: string },
): Promise<CreatedTarget> {
  if (!isUuid(input.noteId)) throw notFound('Note')
  return withTransaction(async (tx) => {
    const [note] = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, input.noteId), eq(notes.ownerId, actor.userId)))
      .for('update')
      .limit(1)
    if (!note || note.deletedAt) throw notFound('Note')
    if (note.promotedTo)
      throw invalid(
        'This note is already promoted — unlink it first to promote it again.',
      )
    const project = input.projectId
      ? await ownedProject(tx, actor, input.projectId, 'hq', 'read')
      : null
    const created = await createTarget(
      input.target,
      payloadFor(input.target, note, project),
      { tx, actor, project },
    )
    await link(
      tx,
      actor,
      { type: 'note', id: note.id },
      { type: created.type, id: created.id },
      'promoted_to',
    )
    const label = (
      note.title?.trim() ||
      fallbackTitle(note.body) ||
      'note'
    ).slice(0, 60)
    await tx
      .update(notes)
      .set({
        promotedTo: {
          type: created.type,
          id: created.id,
          href: created.href,
          projectId: project?.id ?? null,
          label,
        },
        projectId: note.projectId ?? project?.id ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(notes.id, note.id))
    await audit(tx, actor, {
      projectId: project?.id ?? null,
      action: 'note.promote',
      targetType: 'note',
      targetId: note.id,
      changes: { to: { type: created.type, id: created.id }, label },
    })
    return created
  })
}

/** Forget where a note went; the note and the record it became both stay. */
export async function unlinkNote(actor: Actor, noteId: string): Promise<void> {
  if (!isUuid(noteId)) throw notFound('Note')
  await withTransaction(async (tx) => {
    const [note] = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.ownerId, actor.userId)))
      .for('update')
      .limit(1)
    if (!note) throw notFound('Note')
    const to = note.promotedTo as { type?: string; id?: string } | null
    if (!to?.id) return
    await tx
      .delete(refs)
      .where(
        and(
          eq(refs.ownerId, actor.userId),
          eq(refs.fromType, 'note'),
          eq(refs.fromId, note.id),
          eq(refs.role, 'promoted_to'),
        ),
      )
    await tx
      .update(notes)
      .set({ promotedTo: null, updatedAt: sql`now()` })
      .where(eq(notes.id, note.id))
    await audit(tx, actor, {
      projectId: note.projectId,
      action: 'note.unlink',
      targetType: 'note',
      targetId: note.id,
      changes: { was: to },
    })
  })
}
