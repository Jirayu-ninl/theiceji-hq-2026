'use server'

import { invalid, notFound } from '@theiceji/hq-ops/errors'
import { type ActionResult, runAction } from '@/lib/actions'
import { promoteNote, unlinkNote } from '@/lib/notes/promote'
import {
  createNote,
  emptyTrash,
  getNote,
  purge,
  setArchived,
  setDeleted,
  updateNote,
} from '@/lib/notes/store'
import type { Note } from '@/lib/notes/types'

/**
 * Notes' Bridge actions: capture, edit, file under a
 * project, promote through the target registry, unlink, delete (to the
 * 30-day trash), restore, and — from the trash only — delete for good.
 * Every one checks the session through `runAction` and answers the note as
 * it now is.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const found = (note: Note | null): Note => {
  if (!note) throw notFound('Note')
  return note
}

/** A one-line capture, or the New note modal's title + body. */
export async function captureNoteAction(input: {
  body: string
  title?: string | null
  projectId: string | null
}): Promise<ActionResult<Note>> {
  return runAction(async (actor) => {
    const body = input.body.trim()
    const title = input.title?.trim() || null
    if (!body && !title) throw invalid('Write something first.')
    if (input.projectId && !UUID.test(input.projectId))
      throw notFound('Project')
    return createNote(actor.userId, {
      title,
      body,
      projectId: input.projectId,
    })
  })
}

export async function editNoteAction(input: {
  noteId: string
  title?: string | null
  body?: string
  projectId?: string | null
}): Promise<ActionResult<Note>> {
  return runAction(async (actor) => {
    if (!UUID.test(input.noteId)) throw notFound('Note')
    if (input.projectId && !UUID.test(input.projectId))
      throw notFound('Project')
    return found(
      await updateNote(actor.userId, input.noteId, {
        title: input.title,
        body: input.body,
        projectId: input.projectId,
      }),
    )
  })
}

/** To the trash (30 days) or back out of it — Delete's Undo. */
export async function trashNoteAction(input: {
  noteId: string
  deleted: boolean
}): Promise<ActionResult<Note>> {
  return runAction(async (actor) => {
    if (!UUID.test(input.noteId)) throw notFound('Note')
    return found(await setDeleted(actor.userId, input.noteId, input.deleted))
  })
}

/** Into the archive or back out of it — Archive's Undo, and Restore. */
export async function archiveNoteAction(input: {
  noteId: string
  archived: boolean
}): Promise<ActionResult<Note>> {
  return runAction(async (actor) => {
    if (!UUID.test(input.noteId)) throw notFound('Note')
    return found(await setArchived(actor.userId, input.noteId, input.archived))
  })
}

export async function promoteNoteAction(input: {
  noteId: string
  projectId: string | null
  target: string
}): Promise<ActionResult<{ note: Note; href: string; type: string }>> {
  return runAction(async (actor) => {
    const created = await promoteNote(actor, input)
    return {
      note: found(await getNote(actor.userId, input.noteId)),
      href: created.href,
      type: created.type,
    }
  })
}

export async function unlinkNoteAction(
  noteId: string,
): Promise<ActionResult<Note>> {
  return runAction(async (actor) => {
    await unlinkNote(actor, noteId)
    return found(await getNote(actor.userId, noteId))
  })
}

/** Gone for good — a note in the trash only; the page asks first. */
export async function purgeNoteAction(
  noteId: string,
): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    if (!UUID.test(noteId)) throw notFound('Note')
    const note = found(await getNote(actor.userId, noteId))
    if (!note.deletedAt)
      throw invalid('Only a note in the trash can be deleted for good.')
    await purge(actor.userId, noteId)
    return null
  })
}

/** Every note in the trash, gone for good — the page asks first. */
export async function emptyTrashAction(): Promise<
  ActionResult<{ removed: number }>
> {
  return runAction(async (actor) => ({
    removed: await emptyTrash(actor.userId),
  }))
}
