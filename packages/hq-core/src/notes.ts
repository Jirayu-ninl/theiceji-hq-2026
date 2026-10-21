import { notes } from '@theiceji/hq-db/schema'
import { eq, min } from 'drizzle-orm'
import { z } from 'zod'
import { registerTarget } from './targets'

/**
 * The `note` target — an agent's accepted proposal of a note,
 * the one kind a routine may land without the owner (with `prompt_variant`).
 * Notes are HQ-wide: never a project's module row, so a note target is
 * always "on"; a project only files it. It lands first on the board, like a
 * note the owner types.
 *
 * The note is the acting owner's (`owner_id`) — an agent's
 * connection acts for its owner — and lands first on that owner's board.
 *
 * Lives in hq-core because Notes has no package of its own (it predates
 * the module packages and sits in the keep-list); import it once in every process that
 * accepts proposals.
 */

export const noteHref = (noteId: string) => `/notes?note=${noteId}`

registerTarget({
  type: 'note',
  module: 'notes',
  label: 'Notes · note',
  projectOptional: true,
  schema: z.object({
    title: z.string().trim().max(200).optional(),
    body: z
      .string({ error: 'A note needs a body.' })
      .trim()
      .min(1, 'A note needs a body.')
      .max(20000),
    labels: z.array(z.string().trim().min(1).max(40)).max(16).optional(),
  }),
  async create(payload, { tx, actor, project }) {
    const [low] = await tx
      .select({ lowest: min(notes.position) })
      .from(notes)
      .where(eq(notes.ownerId, actor.userId))
    const [row] = await tx
      .insert(notes)
      .values({
        ownerId: actor.userId,
        title: payload.title || null,
        body: payload.body,
        labels: payload.labels ?? [],
        projectId: project?.id ?? null,
        position: (low?.lowest ?? 0) - 1,
      })
      .returning({ id: notes.id })
    if (!row) throw new Error('The note was not created.')
    return { type: 'note', id: row.id, href: noteHref(row.id) }
  },
})
