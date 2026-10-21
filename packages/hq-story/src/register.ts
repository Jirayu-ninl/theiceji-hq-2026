import { onJobSucceeded } from '@theiceji/hq-assets/jobs'
import { everyWord, registerSearch } from '@theiceji/hq-core/search'
import { registerTarget } from '@theiceji/hq-core/targets'
import {
  projects,
  storyScenes,
  storyShots,
  storyStories,
} from '@theiceji/hq-db/schema'
import { text } from '@theiceji/hq-ops/schemas'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ensureStory, upsertShot } from './story'

/**
 * What Story adds to HQ's shared registries when it loads — import this once
 * in every process that runs module services (apps/hq, apps/hq-mcp):
 *
 * · the `shot` target — a note promoted to a shot, an agent's accepted
 *   proposal: into the named scene, or the last one (a first
 *   scene is made when the story has none);
 * · shots in `hq_search` and the ⌘K palette.
 */

export const shotHref = (slug: string, shotId: string) =>
  `/p/${slug}/story?view=shots&shot=${shotId}`

registerTarget({
  type: 'shot',
  module: 'story',
  label: 'Story · shot',
  schema: z.object({
    action: text.required('Action', 2000),
    /** Which scene (its number); the last one when absent. */
    scene: z.number().int().min(1).max(10000).optional(),
    durationS: z.union([z.string().max(10), z.number()]).optional(),
  }),
  async create(payload, { tx, actor, project }) {
    if (!project) throw new Error('A shot belongs to a film project.')
    const story = await ensureStory(tx, actor, project)
    const scenes = await tx
      .select()
      .from(storyScenes)
      .where(eq(storyScenes.storyId, story.id))
      .orderBy(storyScenes.number)
    let scene =
      (payload.scene
        ? scenes.find((entry) => entry.number === payload.scene)
        : scenes.at(-1)) ?? null
    if (!scene && payload.scene && scenes.length)
      throw new Error(`There is no scene ${payload.scene}.`)
    if (!scene) {
      // A story without scenes gets its first one here, in the same commit.
      const [row] = await tx
        .insert(storyScenes)
        .values({
          ownerId: actor.userId,
          createdBy: actor.userId,
          storyId: story.id,
          number: 1,
          heading: 'Scene 1',
        })
        .returning()
      if (!row) throw new Error('No scene.')
      scene = row
    }
    const shot = await upsertShot(
      tx,
      actor,
      { scene, story, project },
      {
        sceneId: scene.id,
        action: payload.action as string,
        durationS: payload.durationS,
      },
    )
    return { type: 'shot', id: shot.id, href: shotHref(project.slug, shot.id) }
  },
})

registerSearch({
  type: 'shot',
  label: 'Shots',
  async search(reader, { ownerId, words, projectId, limit }) {
    const rows = await reader
      .select({
        id: storyShots.id,
        action: storyShots.action,
        number: storyShots.number,
        scene: storyScenes.number,
        story: storyStories.title,
        projectId: storyShots.projectId,
        slug: projects.slug,
      })
      .from(storyShots)
      .innerJoin(storyScenes, eq(storyScenes.id, storyShots.sceneId))
      .innerJoin(storyStories, eq(storyStories.id, storyShots.storyId))
      .innerJoin(projects, eq(projects.id, storyShots.projectId))
      .where(
        and(
          eq(storyShots.ownerId, ownerId),
          projectId ? eq(storyShots.projectId, projectId) : undefined,
          everyWord([storyShots.action, storyShots.notes], words),
        ),
      )
      .orderBy(desc(storyShots.updatedAt))
      .limit(limit)
    return rows.map((row) => ({
      type: 'shot',
      id: row.id,
      title: `${row.scene}.${row.number} · ${row.action.slice(0, 80)}`,
      projectId: row.projectId,
      href: shotHref(row.slug, row.id),
      detail: row.story,
    }))
  },
})

/**
 * A job made files for a shot — a generator, an agent or the owner's upload:
 * a boarded shot is generated from then on (edited and done stay put).
 */
onJobSucceeded('shot', async (tx, _actor, job) => {
  if (!job.targetId) return
  await tx
    .update(storyShots)
    .set({
      status: 'generated',
      revision: sql`${storyShots.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(storyShots.id, job.targetId),
        eq(storyShots.ownerId, job.ownerId),
        eq(storyShots.status, 'boarded'),
      ),
    )
})
