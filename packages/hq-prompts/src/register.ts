import { onJobSucceeded } from '@theiceji/hq-assets/jobs'
import { everyWord, registerSearch } from '@theiceji/hq-core/search'
import { registerTarget } from '@theiceji/hq-core/targets'
import { PROMPT_MEDIA } from '@theiceji/hq-db/enums'
import {
  projects,
  promptExamplePicks,
  promptExamples,
  promptPrompts,
  promptSlotOptions,
} from '@theiceji/hq-db/schema'
import { isUuid } from '@theiceji/hq-ops/db'
import { invalid } from '@theiceji/hq-ops/errors'
import { choice, recordId, stringList, text } from '@theiceji/hq-ops/schemas'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { insertAlternative, insertPrompt } from './prompts'

/**
 * What Prompts adds to HQ's registries when it loads (import once per
 * process that runs module services):
 *
 * · the `prompt` target — a note promoted to a prompt with its text as the
 *   prompt's text; it may float (no project);
 * · the `prompt_variant` target — an agent's accepted proposal of another
 *   text for an existing prompt. A prompt has one text since
 *   2026-09-30, so it lands as a prompt of its own beside that one;
 * · prompts in `hq_search` and the ⌘K palette.
 */

export const promptHref = (slug: string | null, promptId: string) =>
  slug ? `/p/${slug}/prompts?prompt=${promptId}` : `/prompts?prompt=${promptId}`

registerTarget({
  type: 'prompt',
  module: 'prompts',
  label: 'Prompts · prompt',
  projectOptional: true,
  schema: z.object({
    title: text.required('Title', 160),
    intent: z.string().trim().max(2000).optional(),
    medium: choice(PROMPT_MEDIA, 'Choose image, video, text or audio.').default(
      'image',
    ),
    text: text.required('Prompt text', 20000),
    collection: text.optional('Collection', 80),
    tags: stringList('tags', 16, 32).optional(),
  }),
  async create(payload, { tx, actor, project }) {
    const prompt = await insertPrompt(tx, actor, project, {
      title: payload.title as string,
      intent: payload.intent,
      medium: payload.medium,
      collection: payload.collection,
      tags: payload.tags,
      text: payload.text as string,
    })
    return {
      type: 'prompt',
      id: prompt.id,
      href: promptHref(project?.slug ?? null, prompt.id),
    }
  },
})

registerTarget({
  type: 'prompt_variant',
  module: 'prompts',
  label: 'Prompts · variant',
  projectOptional: true,
  schema: z.object({
    promptId: recordId('Prompt'),
    text: text.required('Prompt text', 20000),
    style: z.string().trim().max(200).optional(),
    providerHint: text.optional('Provider hint', 80),
    model: text.optional('Model', 120),
    negativeText: z.string().max(4000).optional(),
  }),
  async create(payload, { tx, actor, project }) {
    const [prompt] = await tx
      .select()
      .from(promptPrompts)
      .where(
        and(
          eq(promptPrompts.id, payload.promptId),
          eq(promptPrompts.ownerId, actor.userId),
        ),
      )
      .for('update')
      .limit(1)
    if (!prompt || (prompt.projectId ?? null) !== (project?.id ?? null))
      throw invalid('That prompt isn’t in this project.')
    if (prompt.deletedAt)
      throw invalid('That prompt is in the Trash. Restore it first.')
    const variant = await insertAlternative(tx, actor, project, prompt, {
      text: payload.text as string,
      style: payload.style,
      providerHint: payload.providerHint,
      model: payload.model,
      negativeText: payload.negativeText,
    })
    return {
      type: 'prompt_variant',
      id: variant.id,
      href: promptHref(project?.slug ?? null, variant.promptId),
    }
  },
})

registerSearch({
  type: 'prompt',
  label: 'Prompts',
  async search(reader, { ownerId, words, projectId, limit }) {
    const rows = await reader
      .select({
        id: promptPrompts.id,
        title: promptPrompts.title,
        medium: promptPrompts.medium,
        projectId: promptPrompts.projectId,
        slug: projects.slug,
      })
      .from(promptPrompts)
      .leftJoin(projects, eq(projects.id, promptPrompts.projectId))
      .where(
        and(
          eq(promptPrompts.ownerId, ownerId),
          isNull(promptPrompts.archivedAt),
          projectId ? eq(promptPrompts.projectId, projectId) : undefined,
          everyWord([promptPrompts.title, promptPrompts.intent], words),
        ),
      )
      .orderBy(desc(promptPrompts.updatedAt))
      .limit(limit)
    return rows.map((row) => ({
      type: 'prompt',
      id: row.id,
      title: row.title,
      projectId: row.projectId,
      href: promptHref(row.slug, row.id),
      detail: row.medium,
    }))
  },
})

/**
 * A generator made files for a prompt's text ("Generate with…"): each lands
 * as an example of it, after the ones it has, with the options the text was
 * filled with (those still there). The `example_of` link is the job's.
 */
onJobSucceeded('prompt_variant', async (tx, _actor, job, results) => {
  if (!job.targetId) return
  const [last] = await tx
    .select({
      n: sql<number>`coalesce(max(${promptExamples.position}), -1)::int`,
    })
    .from(promptExamples)
    .where(eq(promptExamples.variantId, job.targetId))
  const picked = Array.isArray(job.input.picks)
    ? job.input.picks.filter((id): id is string => isUuid(id))
    : []
  const options = picked.length
    ? await tx
        .select({ id: promptSlotOptions.id })
        .from(promptSlotOptions)
        .where(
          and(
            eq(promptSlotOptions.ownerId, job.ownerId),
            inArray(promptSlotOptions.id, picked),
          ),
        )
    : []
  let position = (last?.n ?? -1) + 1
  for (const asset of results) {
    const [example] = await tx
      .insert(promptExamples)
      .values({
        ownerId: job.ownerId,
        variantId: job.targetId,
        assetId: asset.id,
        caption: `generated · ${job.provider.replace('external:', '')}`,
        position: position++,
      })
      .onConflictDoNothing()
      .returning({ id: promptExamples.id })
    if (example && options.length)
      await tx
        .insert(promptExamplePicks)
        .values(
          options.map((option) => ({
            ownerId: job.ownerId,
            exampleId: example.id,
            optionId: option.id,
          })),
        )
        .onConflictDoNothing()
  }
})
