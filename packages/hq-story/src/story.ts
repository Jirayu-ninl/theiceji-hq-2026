import { runGeneratorJob } from '@theiceji/hq-assets/generate'
import {
  completeManualJob,
  insertJob,
  isExternalProvider,
  JOB_PROVIDER,
  type JobView,
  listJobs,
  newestByTarget,
} from '@theiceji/hq-assets/jobs'
import { fromMinor, toMinor } from '@theiceji/hq-core/money'
import { link } from '@theiceji/hq-core/refs'
import {
  STORY_SHOT_STATUSES,
  type StoryShotStatus,
} from '@theiceji/hq-db/enums'
import {
  type AssetRow,
  assetAssets,
  assetGenerationJobs,
  type ProjectRow,
  projects,
  promptPrompts,
  promptVariants,
  refs,
  type StoryCharacterRow,
  type StoryRow,
  type StorySceneRow,
  type StoryShotRow,
  storyCharacters,
  storyScenes,
  storyShots,
  storyStories,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan, can } from '@theiceji/hq-ops/access'
import type { Reader, Tx } from '@theiceji/hq-ops/db'
import {
  conflict,
  invalid,
  notFound,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  choice,
  idempotencyKey,
  optionalRecordId,
  parseInput,
  recordId,
  revision,
  text,
} from '@theiceji/hq-ops/schemas'
import {
  assertModuleOn,
  audit,
  authorize,
  ownedProject,
  ownedRecord,
  ownedRow,
  returned,
  runOperation,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { auditSnapshot, diffFields } from '@theiceji/hq-ops/values'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { z } from 'zod'

/**
 * Story: a film project's script, characters,
 * scenes and shots.
 *
 * · **One story per film project, made on first open** by whoever may write
 *   to it (like a board). Scenes and shots keep gapless numbers — a shot is
 *   `scene.shot` (2.3) everywhere.
 * · **A shot is drawn with prompt variants** (Story requires Prompts): one
 *   for the still, one for the motion — the owner's own variants of this
 *   project, or floating ones.
 * · **Generating is by hand in v1** (`manual`): "Generate" opens
 *   a manual job for the shot and the variant; the owner makes the file
 *   elsewhere and attaches it — the job is done, the file links
 *   `asset —result_of→ shot`, and the shot becomes `generated`. Agents and
 *   external generators arrive later on the same job rows.
 * · **A scene's files as one ZIP** come from the local worker (a job on an
 *   ops task), for the owner to edit on their own machine. HQ never edits.
 * · **Deleting a scene or a shot is the owner's**; everything else is
 *   drafting, which an agent may do where its policy allows.
 */

registerConstraintMessages({
  story_characters_board_fk: 'That image isn’t yours to use.',
})

/* ── Shapes ─────────────────────────────────────────────────────────── */

export type AssetLite = Pick<
  AssetRow,
  | 'id'
  | 'name'
  | 'title'
  | 'kind'
  | 'mime'
  | 'status'
  | 'bytes'
  | 'width'
  | 'height'
  | 'durationMs'
>

export type VariantLite = {
  id: string
  label: string
  promptId: string
  promptTitle: string
  medium: string
  providerHint: string | null
  /** The text a generator runs — the first 600 characters. */
  text: string
}

export type ShotView = StoryShotRow & {
  /** `2.3` — scene number . shot number. */
  code: string
  image: VariantLite | null
  video: VariantLite | null
  /** Its results, newest first. */
  results: AssetLite[]
  /** The newest generate job for it, if any. */
  job: JobView | null
  /** Where it starts in the film, in seconds, from the durations before it. */
  startS: string
}

export type SceneView = StorySceneRow & {
  shots: ShotView[]
  /** The newest ZIP of the scene's files, if one was asked for. */
  zip: JobView | null
}

export type CharacterView = StoryCharacterRow & { board: AssetLite | null }

export type StoryBoard = {
  project: ProjectRow
  /** Null until someone who may write opens it. */
  story: StoryRow | null
  characters: CharacterView[]
  scenes: SceneView[]
  /** Seconds, summed from the shots that have a duration. */
  runtimeS: string
  counts: { shots: number; generated: number; done: number }
}

const assetLite = {
  id: assetAssets.id,
  name: assetAssets.name,
  title: assetAssets.title,
  kind: assetAssets.kind,
  mime: assetAssets.mime,
  status: assetAssets.status,
  bytes: assetAssets.bytes,
  width: assetAssets.width,
  height: assetAssets.height,
  durationMs: assetAssets.durationMs,
}

const GENERATED: readonly StoryShotStatus[] = ['generated', 'edited', 'done']

/* ── Reading ────────────────────────────────────────────────────────── */

async function firstStory(
  reader: Reader,
  ownerId: string,
  projectId: string,
): Promise<StoryRow | null> {
  const [row] = await reader
    .select()
    .from(storyStories)
    .where(
      and(
        eq(storyStories.ownerId, ownerId),
        eq(storyStories.projectId, projectId),
        isNull(storyStories.archivedAt),
      ),
    )
    .orderBy(asc(storyStories.position), asc(storyStories.createdAt))
    .limit(1)
  return row ?? null
}

/** The project's story, made on first open, inside the caller's transaction. */
export async function ensureStory(
  tx: Tx,
  actor: Actor,
  project: ProjectRow,
): Promise<StoryRow> {
  assertModuleOn(project, 'story')
  const existing = await firstStory(tx, actor.userId, project.id)
  if (existing) return existing
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`story:${project.id}`}, 0))`,
  )
  const again = await firstStory(tx, actor.userId, project.id)
  if (again) return again
  const [row] = await tx
    .insert(storyStories)
    .values({
      ownerId: actor.userId,
      createdBy: actor.userId,
      projectId: project.id,
      title: project.name,
    })
    .returning()
  const story = returned(row)
  await audit(tx, actor, {
    projectId: project.id,
    action: 'story.create',
    targetType: 'story',
    targetId: story.id,
    afterRevision: story.revision,
    changes: { title: story.title },
  })
  return story
}

async function variantsOf(
  reader: Reader,
  ownerId: string,
  ids: string[],
): Promise<Map<string, VariantLite>> {
  if (ids.length === 0) return new Map()
  const rows = await reader
    .select({
      id: promptVariants.id,
      label: promptVariants.label,
      promptId: promptVariants.promptId,
      promptTitle: promptPrompts.title,
      medium: promptPrompts.medium,
      providerHint: promptVariants.providerHint,
      text: sql<string>`left(${promptVariants.text}, 600)`,
    })
    .from(promptVariants)
    .innerJoin(promptPrompts, eq(promptPrompts.id, promptVariants.promptId))
    .where(
      and(eq(promptVariants.ownerId, ownerId), inArray(promptVariants.id, ids)),
    )
  return new Map(rows.map((row) => [row.id, row]))
}

async function readBoard(
  reader: Reader,
  actor: Actor,
  project: ProjectRow,
  story: StoryRow,
): Promise<Omit<StoryBoard, 'project'>> {
  const [characters, scenes, shots] = await Promise.all([
    reader
      .select({ character: storyCharacters, board: assetLite })
      .from(storyCharacters)
      .leftJoin(assetAssets, eq(assetAssets.id, storyCharacters.boardAssetId))
      .where(eq(storyCharacters.storyId, story.id))
      .orderBy(asc(storyCharacters.position), asc(storyCharacters.createdAt)),
    reader
      .select()
      .from(storyScenes)
      .where(eq(storyScenes.storyId, story.id))
      .orderBy(asc(storyScenes.number)),
    reader
      .select()
      .from(storyShots)
      .where(eq(storyShots.storyId, story.id))
      .orderBy(asc(storyShots.number)),
  ])
  const shotIds = shots.map((shot) => shot.id)
  const variantIds = [
    ...new Set(
      shots.flatMap((shot) =>
        [shot.imageVariantId, shot.videoVariantId].filter(Boolean),
      ),
    ),
  ] as string[]
  const [variants, results, jobs] = await Promise.all([
    variantsOf(reader, actor.userId, variantIds),
    shotIds.length
      ? reader
          .select({
            shotId: refs.toId,
            asset: assetLite,
            linkedAt: refs.createdAt,
          })
          .from(refs)
          .innerJoin(assetAssets, eq(assetAssets.id, refs.fromId))
          .where(
            and(
              eq(refs.ownerId, actor.userId),
              eq(refs.fromType, 'asset'),
              eq(refs.toType, 'shot'),
              eq(refs.role, 'result_of'),
              inArray(refs.toId, shotIds),
            ),
          )
          .orderBy(desc(refs.createdAt))
      : Promise.resolve([]),
    can(actor, 'assets', 'read')
      ? listJobs(actor, { projectId: project.id, limit: 500 })
      : Promise.resolve([] as JobView[]),
  ])
  const generate = newestByTarget(
    jobs.filter(
      (job) => job.operation === 'generate' && job.targetType === 'shot',
    ),
  )
  const zips = new Map<string, JobView>()
  for (const job of jobs)
    if (job.operation === 'zip') {
      const forId = (job.input as { forId?: string }).forId
      if (forId && !zips.has(forId)) zips.set(forId, job)
    }
  let clock = 0n
  const sceneViews: SceneView[] = scenes.map((scene) => ({
    ...scene,
    zip: zips.get(scene.id) ?? null,
    shots: shots
      .filter((shot) => shot.sceneId === scene.id)
      .map((shot) => {
        const start = fromMinor(clock, 2)
        if (shot.durationS) clock += toMinor(shot.durationS, 2)
        return {
          ...shot,
          code: `${scene.number}.${shot.number}`,
          image: shot.imageVariantId
            ? (variants.get(shot.imageVariantId) ?? null)
            : null,
          video: shot.videoVariantId
            ? (variants.get(shot.videoVariantId) ?? null)
            : null,
          results: results
            .filter((row) => row.shotId === shot.id)
            .map((row) => row.asset),
          job: generate.get(shot.id) ?? null,
          startS: start,
        }
      }),
  }))
  return {
    story,
    characters: characters.map((row) => ({
      ...row.character,
      board: row.board?.id ? row.board : null,
    })),
    scenes: sceneViews,
    runtimeS: fromMinor(clock, 2),
    counts: {
      shots: shots.length,
      generated: shots.filter((shot) => GENERATED.includes(shot.status)).length,
      done: shots.filter((shot) => shot.status === 'done').length,
    },
  }
}

/**
 * The project's story board — script, characters, scenes with their shots,
 * each shot's variants, results and newest job. The owner (or a connection
 * that may write to Story) makes the story on first open; a reader gets
 * `story: null` until it exists.
 */
export async function openStory(
  actor: Actor,
  projectId: string,
): Promise<StoryBoard> {
  const found = await withReader(async (db) => {
    const project = await ownedProject(db, actor, projectId, 'story', 'read')
    assertModuleOn(project, 'story')
    return { project, story: await firstStory(db, actor.userId, project.id) }
  })
  let story = found.story
  if (
    !story &&
    can(actor, 'story', 'write') &&
    found.project.status !== 'archived'
  )
    story = await withTransaction(async (tx) => {
      const project = await ownedProject(tx, actor, projectId, 'story', 'write')
      return ensureStory(tx, actor, project)
    })
  if (!story)
    return {
      project: found.project,
      story: null,
      characters: [],
      scenes: [],
      runtimeS: '0.00',
      counts: { shots: 0, generated: 0, done: 0 },
    }
  const board = await withReader((db) =>
    readBoard(db, actor, found.project, story as StoryRow),
  )
  return { project: found.project, ...board }
}

/* ── Writing: story, characters ─────────────────────────────────────── */

async function storyForWrite(
  tx: Tx,
  actor: Actor,
  storyId: string,
  requirement?: 'owner_only',
): Promise<{ story: StoryRow; project: ProjectRow }> {
  assertCan(actor, 'story', 'write')
  const { row: story, project } = await ownedRow<StoryRow>(
    tx,
    actor,
    storyStories,
    storyId,
    'Story',
    { lock: true },
  )
  if (!project) throw notFound('Story')
  await authorize(tx, actor, project, 'story', 'write', requirement)
  assertModuleOn(project, 'story')
  return { story, project }
}

async function touch(tx: Tx, story: StoryRow): Promise<void> {
  await tx
    .update(storyStories)
    .set({ updatedAt: sql`now()` })
    .where(eq(storyStories.id, story.id))
}

const storySchema = z.object({
  storyId: recordId('Story'),
  expectedRevision: revision,
  title: text.required('Title', 200).optional(),
  logline: text.optional('Logline', 1000),
  script: z.string().max(200_000, 'The script is too long.').optional(),
  idempotencyKey: idempotencyKey.optional(),
})

/** Title, logline and the script (markdown). Absent fields stay. */
export async function saveStory(
  actor: Actor,
  raw: z.input<typeof storySchema>,
): Promise<StoryRow> {
  const input = parseInput(storySchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'story_save_script',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { story, project } = await storyForWrite(tx, actor, input.storyId)
        if (story.revision !== input.expectedRevision) throw conflict()
        const patch: Partial<typeof storyStories.$inferInsert> = {}
        if (input.title !== undefined) patch.title = input.title as string
        if (input.logline !== undefined) patch.logline = input.logline ?? ''
        if (input.script !== undefined) patch.script = input.script
        const changes = diffFields(
          story as unknown as Record<string, unknown>,
          patch,
        )
        if (Object.keys(changes).length === 0) return story
        const [row] = await tx
          .update(storyStories)
          .set({
            ...patch,
            revision: sql`${storyStories.revision} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(storyStories.id, story.id),
              eq(storyStories.revision, story.revision),
            ),
          )
          .returning()
        const saved = returned(row)
        await audit(tx, actor, {
          projectId: project.id,
          action: 'story.update',
          targetType: 'story',
          targetId: saved.id,
          beforeRevision: story.revision,
          afterRevision: saved.revision,
          // The script can be long: say it changed and how long it is now.
          changes: {
            ...changes,
            ...('script' in changes
              ? { script: { length: saved.script.length } }
              : {}),
          },
        })
        return saved
      }),
  )
  if (outcome.kind === 'replay')
    return (
      await withReader((db) =>
        ownedRecord<StoryRow>(
          db,
          actor,
          storyStories,
          input.storyId,
          'story',
          'read',
          'Story',
        ),
      )
    ).row
  await outcome.complete({ story_id: outcome.value.id })
  return outcome.value
}

async function readyImage(
  tx: Tx,
  actor: Actor,
  project: ProjectRow,
  assetId: string,
): Promise<AssetRow> {
  const { row: asset } = await ownedRecord<AssetRow>(
    tx,
    actor,
    assetAssets,
    assetId,
    'assets',
    'read',
    'Asset',
  )
  if (asset.status !== 'ready')
    throw invalid('Use a ready file — finish its upload first.')
  if (asset.projectId && asset.projectId !== project.id)
    throw invalid('That file belongs to another project.')
  return asset
}

const characterSchema = z.object({
  storyId: recordId('Story'),
  characterId: optionalRecordId('Character'),
  expectedRevision: revision.optional(),
  name: text.required('Name', 120),
  description: text.optional('Description', 4000),
  boardAssetId: optionalRecordId('Board image'),
})

/** A new character, or changes to one — name, description, board image. */
export async function saveCharacter(
  actor: Actor,
  raw: z.input<typeof characterSchema>,
): Promise<StoryCharacterRow> {
  const input = parseInput(characterSchema, raw)
  return withTransaction(async (tx) => {
    const { story, project } = await storyForWrite(tx, actor, input.storyId)
    const board =
      input.boardAssetId === undefined
        ? undefined
        : input.boardAssetId
          ? (await readyImage(tx, actor, project, input.boardAssetId)).id
          : null
    if (!input.characterId) {
      const [last] = await tx
        .select({
          n: sql<number>`coalesce(max(${storyCharacters.position}), -1)::int`,
        })
        .from(storyCharacters)
        .where(eq(storyCharacters.storyId, story.id))
      const [row] = await tx
        .insert(storyCharacters)
        .values({
          ownerId: actor.userId,
          createdBy: actor.userId,
          storyId: story.id,
          name: input.name as string,
          description: input.description ?? '',
          boardAssetId: board ?? null,
          position: (last?.n ?? -1) + 1,
        })
        .returning()
      const character = returned(row)
      await touch(tx, story)
      await audit(tx, actor, {
        projectId: project.id,
        action: 'story.character.create',
        targetType: 'story',
        targetId: story.id,
        changes: { character: character.name },
      })
      return character
    }
    const [current] = await tx
      .select()
      .from(storyCharacters)
      .where(
        and(
          eq(storyCharacters.id, input.characterId),
          eq(storyCharacters.storyId, story.id),
        ),
      )
      .for('update')
    if (!current) throw notFound('Character')
    if (input.expectedRevision && current.revision !== input.expectedRevision)
      throw conflict()
    const patch: Partial<typeof storyCharacters.$inferInsert> = {
      name: input.name as string,
    }
    if (input.description !== undefined)
      patch.description = input.description ?? ''
    if (board !== undefined) patch.boardAssetId = board
    const changes = diffFields(
      current as unknown as Record<string, unknown>,
      patch,
    )
    if (Object.keys(changes).length === 0) return current
    const [row] = await tx
      .update(storyCharacters)
      .set({
        ...patch,
        revision: sql`${storyCharacters.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(storyCharacters.id, current.id))
      .returning()
    await touch(tx, story)
    await audit(tx, actor, {
      projectId: project.id,
      action: 'story.character.update',
      targetType: 'story',
      targetId: story.id,
      changes: { character: current.name, ...changes },
    })
    return returned(row)
  })
}

/** Remove a character; it leaves every shot's cast too. */
export async function removeCharacter(
  actor: Actor,
  raw: { characterId: string },
): Promise<void> {
  const input = parseInput(
    z.object({ characterId: recordId('Character') }),
    raw,
  )
  await withTransaction(async (tx) => {
    const [character] = await tx
      .select()
      .from(storyCharacters)
      .where(
        and(
          eq(storyCharacters.id, input.characterId),
          eq(storyCharacters.ownerId, actor.userId),
        ),
      )
      .limit(1)
    if (!character) throw notFound('Character')
    const { story, project } = await storyForWrite(tx, actor, character.storyId)
    await tx
      .update(storyShots)
      .set({
        characterIds: sql`array_remove(${storyShots.characterIds}, ${character.id}::uuid)`,
      })
      .where(eq(storyShots.storyId, story.id))
    await tx.delete(storyCharacters).where(eq(storyCharacters.id, character.id))
    await touch(tx, story)
    await audit(tx, actor, {
      projectId: project.id,
      action: 'story.character.remove',
      targetType: 'story',
      targetId: story.id,
      changes: { character: character.name },
    })
  })
}

/* ── Writing: scenes ────────────────────────────────────────────────── */

/** Renumber a story's scenes 1…n in their current order, `moved` at `at`. */
async function renumberScenes(
  tx: Tx,
  storyId: string,
  moved?: { id: string; at: number },
): Promise<void> {
  const rows = await tx
    .select({ id: storyScenes.id, number: storyScenes.number })
    .from(storyScenes)
    .where(eq(storyScenes.storyId, storyId))
    .orderBy(asc(storyScenes.number), asc(storyScenes.createdAt))
  const order = rows.map((row) => row.id).filter((id) => id !== moved?.id)
  if (moved)
    order.splice(Math.max(0, Math.min(moved.at - 1, order.length)), 0, moved.id)
  // Two passes so no two rows share a number mid-way (numbers aren't unique,
  // but the order must never be ambiguous to a reader in between).
  for (const [i, id] of order.entries())
    await tx
      .update(storyScenes)
      .set({ number: i + 1 })
      .where(eq(storyScenes.id, id))
}

async function renumberShots(
  tx: Tx,
  sceneId: string,
  moved?: { id: string; at: number },
): Promise<void> {
  const rows = await tx
    .select({ id: storyShots.id })
    .from(storyShots)
    .where(eq(storyShots.sceneId, sceneId))
    .orderBy(asc(storyShots.number), asc(storyShots.createdAt))
  const order = rows.map((row) => row.id).filter((id) => id !== moved?.id)
  if (moved)
    order.splice(Math.max(0, Math.min(moved.at - 1, order.length)), 0, moved.id)
  for (const [i, id] of order.entries())
    await tx
      .update(storyShots)
      .set({ number: i + 1 })
      .where(eq(storyShots.id, id))
}

const sceneSchema = z.object({
  storyId: recordId('Story'),
  sceneId: optionalRecordId('Scene'),
  expectedRevision: revision.optional(),
  heading: text.required('Heading', 200),
  synopsis: text.optional('Synopsis', 4000),
  /** Where it goes: scene number (1 is first). The end when absent. */
  number: z.number().int().min(1).max(10000).optional(),
})

export async function saveScene(
  actor: Actor,
  raw: z.input<typeof sceneSchema>,
): Promise<StorySceneRow> {
  const input = parseInput(sceneSchema, raw)
  return withTransaction(async (tx) => {
    const { story, project } = await storyForWrite(tx, actor, input.storyId)
    let scene: StorySceneRow
    if (!input.sceneId) {
      const [last] = await tx
        .select({
          n: sql<number>`coalesce(max(${storyScenes.number}), 0)::int`,
        })
        .from(storyScenes)
        .where(eq(storyScenes.storyId, story.id))
      const [row] = await tx
        .insert(storyScenes)
        .values({
          ownerId: actor.userId,
          createdBy: actor.userId,
          storyId: story.id,
          number: (last?.n ?? 0) + 1,
          heading: input.heading as string,
          synopsis: input.synopsis ?? '',
        })
        .returning()
      scene = returned(row)
    } else {
      const [current] = await tx
        .select()
        .from(storyScenes)
        .where(
          and(
            eq(storyScenes.id, input.sceneId),
            eq(storyScenes.storyId, story.id),
          ),
        )
        .for('update')
      if (!current) throw notFound('Scene')
      if (input.expectedRevision && current.revision !== input.expectedRevision)
        throw conflict()
      const [row] = await tx
        .update(storyScenes)
        .set({
          heading: input.heading as string,
          ...(input.synopsis !== undefined
            ? { synopsis: input.synopsis ?? '' }
            : {}),
          revision: sql`${storyScenes.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(storyScenes.id, current.id))
        .returning()
      scene = returned(row)
    }
    if (input.number !== undefined) {
      await renumberScenes(tx, story.id, { id: scene.id, at: input.number })
      const [again] = await tx
        .select()
        .from(storyScenes)
        .where(eq(storyScenes.id, scene.id))
      scene = returned(again)
    }
    await touch(tx, story)
    await audit(tx, actor, {
      projectId: project.id,
      action: input.sceneId ? 'story.scene.update' : 'story.scene.create',
      targetType: 'story',
      targetId: story.id,
      changes: { scene: scene.number, heading: scene.heading },
    })
    return scene
  })
}

/** Delete a scene and its shots. The owner's; the result files stay in Assets. */
export async function deleteScene(
  actor: Actor,
  raw: { sceneId: string },
): Promise<void> {
  const input = parseInput(z.object({ sceneId: recordId('Scene') }), raw)
  await withTransaction(async (tx) => {
    const [scene] = await tx
      .select()
      .from(storyScenes)
      .where(
        and(
          eq(storyScenes.id, input.sceneId),
          eq(storyScenes.ownerId, actor.userId),
        ),
      )
      .limit(1)
    if (!scene) throw notFound('Scene')
    const { story, project } = await storyForWrite(
      tx,
      actor,
      scene.storyId,
      'owner_only',
    )
    const shots = await tx
      .select({ id: storyShots.id })
      .from(storyShots)
      .where(eq(storyShots.sceneId, scene.id))
    if (shots.length)
      await tx.delete(refs).where(
        and(
          eq(refs.ownerId, actor.userId),
          eq(refs.toType, 'shot'),
          inArray(
            refs.toId,
            shots.map((shot) => shot.id),
          ),
        ),
      )
    await tx.delete(storyScenes).where(eq(storyScenes.id, scene.id))
    await renumberScenes(tx, story.id)
    await touch(tx, story)
    await audit(tx, actor, {
      projectId: project.id,
      action: 'story.scene.delete',
      targetType: 'story',
      targetId: story.id,
      changes: {
        scene: scene.number,
        heading: scene.heading,
        shots: shots.length,
      },
    })
  })
}

/* ── Writing: shots ─────────────────────────────────────────────────── */

async function checkVariant(
  tx: Tx,
  actor: Actor,
  project: ProjectRow,
  variantId: string,
): Promise<void> {
  const [row] = await tx
    .select({ projectId: promptPrompts.projectId })
    .from(promptVariants)
    .innerJoin(promptPrompts, eq(promptPrompts.id, promptVariants.promptId))
    .where(
      and(
        eq(promptVariants.id, variantId),
        eq(promptVariants.ownerId, actor.userId),
      ),
    )
    .limit(1)
  if (!row) throw notFound('Variant')
  if (row.projectId && row.projectId !== project.id)
    throw invalid('That variant belongs to another project’s prompt.')
}

async function checkCast(
  tx: Tx,
  storyId: string,
  ids: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  const found = await tx
    .select({ id: storyCharacters.id })
    .from(storyCharacters)
    .where(
      and(
        eq(storyCharacters.storyId, storyId),
        inArray(storyCharacters.id, unique),
      ),
    )
  if (found.length !== unique.length)
    throw invalid('Someone in the cast isn’t a character of this story.')
  return unique
}

const shotFields = {
  action: text.required('Action', 2000),
  durationS: z
    .union([z.string().max(10), z.number().positive().max(9999)])
    .nullable()
    .optional(),
  imageVariantId: optionalRecordId('Image variant'),
  videoVariantId: optionalRecordId('Video variant'),
  characterIds: z.array(z.uuid()).max(20).optional(),
  notes: text.optional('Notes', 4000),
}

const shotSchema = z.object({
  sceneId: recordId('Scene'),
  shotId: optionalRecordId('Shot'),
  expectedRevision: revision.optional(),
  ...shotFields,
  /** Where it goes in the scene (1 is first). The end when absent. */
  number: z.number().int().min(1).max(10000).optional(),
})

export type SaveShotInput = z.input<typeof shotSchema>

function seconds(
  raw: string | number | null | undefined,
): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  const text = String(raw).trim()
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text) || Number(text) <= 0)
    throw invalid('A duration is seconds, like 3 or 2.5.', {
      durationS: 'Seconds, more than 0.',
    })
  return fromMinor(toMinor(text, 2), 2)
}

async function sceneOf(
  tx: Tx,
  actor: Actor,
  sceneId: string,
): Promise<{ scene: StorySceneRow; story: StoryRow; project: ProjectRow }> {
  const [scene] = await tx
    .select()
    .from(storyScenes)
    .where(
      and(eq(storyScenes.id, sceneId), eq(storyScenes.ownerId, actor.userId)),
    )
    .limit(1)
  if (!scene) throw notFound('Scene')
  const { story, project } = await storyForWrite(tx, actor, scene.storyId)
  return { scene, story, project }
}

/** One shot inside the caller's transaction — the shot target and `saveShots` use it. */
export async function upsertShot(
  tx: Tx,
  actor: Actor,
  scope: { scene: StorySceneRow; story: StoryRow; project: ProjectRow },
  input: z.output<typeof shotSchema>,
): Promise<StoryShotRow> {
  const { scene, story, project } = scope
  if (input.imageVariantId)
    await checkVariant(tx, actor, project, input.imageVariantId)
  if (input.videoVariantId)
    await checkVariant(tx, actor, project, input.videoVariantId)
  const cast =
    input.characterIds === undefined
      ? undefined
      : await checkCast(tx, story.id, input.characterIds)
  const duration = seconds(input.durationS)
  let shot: StoryShotRow
  if (!input.shotId) {
    const [last] = await tx
      .select({ n: sql<number>`coalesce(max(${storyShots.number}), 0)::int` })
      .from(storyShots)
      .where(eq(storyShots.sceneId, scene.id))
    const [row] = await tx
      .insert(storyShots)
      .values({
        ownerId: actor.userId,
        createdBy: actor.userId,
        projectId: project.id,
        storyId: story.id,
        sceneId: scene.id,
        number: (last?.n ?? 0) + 1,
        action: input.action as string,
        durationS: duration ?? null,
        imageVariantId: input.imageVariantId ?? null,
        videoVariantId: input.videoVariantId ?? null,
        characterIds: cast ?? [],
        notes: input.notes ?? '',
      })
      .returning()
    shot = returned(row)
  } else {
    const [current] = await tx
      .select()
      .from(storyShots)
      .where(
        and(eq(storyShots.id, input.shotId), eq(storyShots.storyId, story.id)),
      )
      .for('update')
    if (!current) throw notFound('Shot')
    if (input.expectedRevision && current.revision !== input.expectedRevision)
      throw conflict()
    const patch: PgUpdateSetSource<typeof storyShots> = {
      action: input.action as string,
    }
    if (duration !== undefined) patch.durationS = duration
    if (input.imageVariantId !== undefined)
      patch.imageVariantId = input.imageVariantId ?? null
    if (input.videoVariantId !== undefined)
      patch.videoVariantId = input.videoVariantId ?? null
    if (cast !== undefined) patch.characterIds = cast
    if (input.notes !== undefined) patch.notes = input.notes ?? ''
    if (current.sceneId !== scene.id) {
      patch.sceneId = scene.id
      const [last] = await tx
        .select({ n: sql<number>`coalesce(max(${storyShots.number}), 0)::int` })
        .from(storyShots)
        .where(eq(storyShots.sceneId, scene.id))
      patch.number = (last?.n ?? 0) + 1
    }
    const [row] = await tx
      .update(storyShots)
      .set({
        ...patch,
        revision: sql`${storyShots.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(storyShots.id, current.id))
      .returning()
    shot = returned(row)
    if (current.sceneId !== scene.id) await renumberShots(tx, current.sceneId)
  }
  if (input.number !== undefined) {
    await renumberShots(tx, scene.id, { id: shot.id, at: input.number })
    const [again] = await tx
      .select()
      .from(storyShots)
      .where(eq(storyShots.id, shot.id))
    shot = returned(again)
  }
  await touch(tx, story)
  await audit(tx, actor, {
    projectId: project.id,
    action: input.shotId ? 'story.shot.update' : 'story.shot.create',
    targetType: 'shot',
    targetId: shot.id,
    afterRevision: shot.revision,
    changes: auditSnapshot({
      code: `${scene.number}.${shot.number}`,
      action: shot.action,
      durationS: shot.durationS,
    }),
  })
  return shot
}

/** A new shot at the end of a scene (or at `number`), or changes to one. */
export async function saveShot(
  actor: Actor,
  raw: SaveShotInput,
): Promise<StoryShotRow> {
  const input = parseInput(shotSchema, raw)
  return withTransaction(async (tx) =>
    upsertShot(tx, actor, await sceneOf(tx, actor, input.sceneId), input),
  )
}

const shotsSchema = z.object({
  sceneId: recordId('Scene'),
  shots: z
    .array(
      z.object({
        shotId: optionalRecordId('Shot'),
        ...shotFields,
      }),
    )
    .min(1)
    .max(100),
  idempotencyKey: idempotencyKey.optional(),
})

/**
 * Save a scene's shots in one go (`story_save_shots`): each one with an ID
 * is updated, each one without is added, and the scene is renumbered in the
 * order given — shots not named keep their order after them.
 */
export async function saveShots(
  actor: Actor,
  raw: z.input<typeof shotsSchema>,
): Promise<StoryShotRow[]> {
  const input = parseInput(shotsSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'story_save_shots',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const scope = await sceneOf(tx, actor, input.sceneId)
        const saved: StoryShotRow[] = []
        for (const shot of input.shots)
          saved.push(
            await upsertShot(tx, actor, scope, {
              ...shot,
              sceneId: input.sceneId,
            }),
          )
        for (const [i, shot] of saved.entries())
          await renumberShots(tx, scope.scene.id, { id: shot.id, at: i + 1 })
        return tx
          .select()
          .from(storyShots)
          .where(
            inArray(
              storyShots.id,
              saved.map((shot) => shot.id),
            ),
          )
          .orderBy(asc(storyShots.number))
      }),
  )
  if (outcome.kind === 'replay') {
    const board = await withReader(async (db) => {
      const [scene] = await db
        .select()
        .from(storyScenes)
        .where(
          and(
            eq(storyScenes.id, input.sceneId),
            eq(storyScenes.ownerId, actor.userId),
          ),
        )
      return scene
        ? db
            .select()
            .from(storyShots)
            .where(eq(storyShots.sceneId, scene.id))
            .orderBy(asc(storyShots.number))
        : []
    })
    return board
  }
  await outcome.complete({ scene_id: input.sceneId })
  return outcome.value
}

async function shotForWrite(
  tx: Tx,
  actor: Actor,
  shotId: string,
  requirement?: 'owner_only',
): Promise<{ shot: StoryShotRow; project: ProjectRow; story: StoryRow }> {
  assertCan(actor, 'story', 'write')
  const { row: shot, project } = await ownedRow<StoryShotRow>(
    tx,
    actor,
    storyShots,
    shotId,
    'Shot',
    { lock: true },
  )
  if (!project) throw notFound('Shot')
  await authorize(tx, actor, project, 'story', 'write', requirement)
  assertModuleOn(project, 'story')
  const [story] = await tx
    .select()
    .from(storyStories)
    .where(eq(storyStories.id, shot.storyId))
  return { shot, project, story: returned(story) }
}

/** Move a shot along: boarded · generated · edited · done. */
export async function setShotStatus(
  actor: Actor,
  raw: { shotId: string; expectedRevision: number; status: StoryShotStatus },
): Promise<StoryShotRow> {
  const input = parseInput(
    z.object({
      shotId: recordId('Shot'),
      expectedRevision: revision,
      status: choice(STORY_SHOT_STATUSES, 'Choose a status.'),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { shot, project, story } = await shotForWrite(tx, actor, input.shotId)
    if (shot.revision !== input.expectedRevision) throw conflict()
    if (shot.status === input.status) return shot
    const [row] = await tx
      .update(storyShots)
      .set({
        status: input.status,
        revision: sql`${storyShots.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(storyShots.id, shot.id))
      .returning()
    await touch(tx, story)
    await audit(tx, actor, {
      projectId: project.id,
      action: 'story.shot.status',
      targetType: 'shot',
      targetId: shot.id,
      beforeRevision: shot.revision,
      afterRevision: returned(row).revision,
      changes: { from: shot.status, to: input.status },
    })
    return returned(row)
  })
}

/** Delete a shot. The owner's; its result files stay in Assets. */
export async function deleteShot(
  actor: Actor,
  raw: { shotId: string; expectedRevision: number },
): Promise<void> {
  const input = parseInput(
    z.object({ shotId: recordId('Shot'), expectedRevision: revision }),
    raw,
  )
  await withTransaction(async (tx) => {
    const { shot, project, story } = await shotForWrite(
      tx,
      actor,
      input.shotId,
      'owner_only',
    )
    if (shot.revision !== input.expectedRevision) throw conflict()
    await tx
      .delete(refs)
      .where(
        and(
          eq(refs.ownerId, actor.userId),
          eq(refs.toType, 'shot'),
          eq(refs.toId, shot.id),
        ),
      )
    await tx.delete(storyShots).where(eq(storyShots.id, shot.id))
    await renumberShots(tx, shot.sceneId)
    await touch(tx, story)
    await audit(tx, actor, {
      projectId: project.id,
      action: 'story.shot.delete',
      targetType: 'shot',
      targetId: shot.id,
      beforeRevision: shot.revision,
      changes: { action: shot.action },
    })
  })
}

/* ── Generating and collecting ──────────────────────────────────────── */

/**
 * Generate a shot's still or motion: by hand (`manual`, the
 * default — a job that waits for the owner's upload; opening one while
 * another waits for the same shot returns the waiting one), with one of the
 * owner's generators (`external:openai_compatible` + its connection — HQ
 * calls it now, the file lands on the shot), or with an agent
 * (`agent:<service>` — it claims the job over MCP). Every result links
 * `asset —result_of→ shot` and turns a boarded shot generated.
 */
export async function generateShot(
  actor: Actor,
  raw: {
    shotId: string
    medium: 'image' | 'video'
    provider?: string
    connectionId?: string
  },
): Promise<JobView> {
  const input = parseInput(
    z.object({
      shotId: recordId('Shot'),
      medium: z.enum(['image', 'video'], { error: 'Still or motion?' }),
      provider: z.string().trim().regex(JOB_PROVIDER).optional(),
      connectionId: optionalRecordId('Generator'),
    }),
    raw,
  )
  const provider = input.provider ?? 'manual'
  const jobId = await withTransaction(async (tx) => {
    const { shot, project, story } = await shotForWrite(tx, actor, input.shotId)
    const variantId =
      input.medium === 'image' ? shot.imageVariantId : shot.videoVariantId
    if (!variantId)
      throw invalid(
        `Choose the shot’s ${input.medium === 'image' ? 'still' : 'motion'} variant first.`,
      )
    if (provider === 'local_worker')
      throw invalid('The local worker doesn’t generate; choose another way.')
    const [scene] = await tx
      .select({ number: storyScenes.number })
      .from(storyScenes)
      .where(eq(storyScenes.id, shot.sceneId))
    const code = `${scene?.number ?? '?'}.${shot.number}`
    if (provider !== 'manual') {
      // Story requires Prompts: the variant's own text is what's generated.
      const [variant] = await tx
        .select({
          text: promptVariants.text,
          negativeText: promptVariants.negativeText,
        })
        .from(promptVariants)
        .where(
          and(
            eq(promptVariants.id, variantId),
            eq(promptVariants.ownerId, actor.userId),
          ),
        )
        .limit(1)
      if (!variant) throw notFound('Variant')
      // A prompt's text may be a template (hq-prompts `template.ts`): a
      // generator can't run `<HAIR_COLOR>`, and a shot doesn't pick options.
      const open = `${variant.text}\n${variant.negativeText}`.match(
        /<[A-Z][A-Z0-9_]{0,39}>/g,
      )
      if (open)
        throw invalid(
          `This prompt has variants to pick (${[...new Set(open)].join(' ')}). Make it by hand — Generate manually and copy it from Prompts with the options picked.`,
        )
      const job = await insertJob(tx, actor, project, {
        projectId: project.id,
        provider,
        connectionId: input.connectionId ?? null,
        operation: 'generate',
        title: `${story.title} · shot ${code} · ${input.medium === 'image' ? 'still' : 'motion'}`,
        input: {
          medium: input.medium,
          variantId,
          shotId: shot.id,
          prompt: variant.text,
          ...(variant.negativeText
            ? { negativePrompt: variant.negativeText }
            : {}),
        },
        target: { type: 'shot', id: shot.id, role: 'result_of' },
        variantId,
      })
      return job.id
    }
    const [waiting] = await tx
      .select({ id: assetGenerationJobs.id })
      .from(assetGenerationJobs)
      .where(
        and(
          eq(assetGenerationJobs.ownerId, actor.userId),
          eq(assetGenerationJobs.targetType, 'shot'),
          eq(assetGenerationJobs.targetId, shot.id),
          eq(assetGenerationJobs.variantId, variantId),
          eq(assetGenerationJobs.status, 'awaiting_upload'),
        ),
      )
      .limit(1)
    if (waiting) return waiting.id
    const job = await insertJob(tx, actor, project, {
      projectId: project.id,
      provider: 'manual',
      operation: 'generate',
      title: `${story.title} · shot ${code} · ${input.medium === 'image' ? 'still' : 'motion'}`,
      input: { medium: input.medium, variantId, shotId: shot.id },
      target: { type: 'shot', id: shot.id, role: 'result_of' },
      variantId,
    })
    return job.id
  })
  if (isExternalProvider(provider)) return runGeneratorJob(actor, jobId)
  const [job] = await listJobs(actor, {
    targetType: 'shot',
    targetIds: [input.shotId],
    limit: 20,
  }).then((jobs) => jobs.filter((entry) => entry.id === jobId))
  return returned(job)
}

/**
 * A shot's result: a ready file. With the manual job it answers, the job is
 * done; without one, the file is linked straight to the shot. Either way the
 * file links `asset —result_of→ shot` and a boarded shot becomes generated.
 */
export async function attachShotResult(
  actor: Actor,
  raw: { shotId: string; assetId: string; jobId?: string },
): Promise<StoryShotRow> {
  const input = parseInput(
    z.object({
      shotId: recordId('Shot'),
      assetId: recordId('Asset'),
      jobId: optionalRecordId('Job'),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { shot, project, story } = await shotForWrite(tx, actor, input.shotId)
    if (input.jobId) {
      const job = await completeManualJob(tx, actor, input.jobId, input.assetId)
      if (job.targetId !== shot.id)
        throw invalid('That job is for another shot.')
    } else {
      const { row: asset } = await ownedRecord<AssetRow>(
        tx,
        actor,
        assetAssets,
        input.assetId,
        'assets',
        'read',
        'Asset',
      )
      if (asset.status !== 'ready')
        throw invalid('Use a ready file — finish its upload first.')
      if (asset.projectId && asset.projectId !== project.id)
        throw invalid('That file belongs to another project.')
      await link(
        tx,
        actor,
        { type: 'asset', id: asset.id },
        { type: 'shot', id: shot.id },
        'result_of',
      )
    }
    let saved = shot
    if (shot.status === 'boarded') {
      const [row] = await tx
        .update(storyShots)
        .set({
          status: 'generated',
          revision: sql`${storyShots.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(storyShots.id, shot.id))
        .returning()
      saved = returned(row)
    }
    await touch(tx, story)
    await audit(tx, actor, {
      projectId: project.id,
      action: 'story.shot.result',
      targetType: 'shot',
      targetId: shot.id,
      beforeRevision: shot.revision,
      afterRevision: saved.revision,
      changes: { asset: input.assetId, job: input.jobId ?? null },
    })
    return saved
  })
}

/**
 * Ask the local worker for a scene's files as one ZIP — each shot's newest
 * ready result, named by shot code — to edit on the owner's own machine.
 */
export async function zipScene(
  actor: Actor,
  raw: { sceneId: string },
): Promise<JobView> {
  const input = parseInput(z.object({ sceneId: recordId('Scene') }), raw)
  const jobId = await withTransaction(async (tx) => {
    const { scene, story, project } = await sceneOf(tx, actor, input.sceneId)
    await authorize(tx, actor, project, 'assets', 'write', 'generate')
    const shots = await tx
      .select({ id: storyShots.id, number: storyShots.number })
      .from(storyShots)
      .where(eq(storyShots.sceneId, scene.id))
      .orderBy(asc(storyShots.number))
    if (shots.length === 0) throw invalid('This scene has no shots yet.')
    const results = await tx
      .selectDistinctOn([refs.toId], {
        shotId: refs.toId,
        assetId: refs.fromId,
      })
      .from(refs)
      .innerJoin(assetAssets, eq(assetAssets.id, refs.fromId))
      .where(
        and(
          eq(refs.ownerId, actor.userId),
          eq(refs.fromType, 'asset'),
          eq(refs.toType, 'shot'),
          eq(refs.role, 'result_of'),
          inArray(
            refs.toId,
            shots.map((shot) => shot.id),
          ),
          eq(assetAssets.status, 'ready'),
        ),
      )
      .orderBy(refs.toId, desc(refs.createdAt))
    if (results.length === 0)
      throw invalid('No shot in this scene has a result yet — nothing to zip.')
    const ordered = shots
      .map((shot) => results.find((row) => row.shotId === shot.id)?.assetId)
      .filter(Boolean) as string[]
    const job = await insertJob(tx, actor, project, {
      projectId: project.id,
      provider: 'local_worker',
      operation: 'zip',
      title: `${story.title} · scene ${scene.number} · ZIP`,
      input: {
        assetIds: ordered,
        forId: scene.id,
        name: `${story.title} - scene ${scene.number}`
          .replace(/[\\/:*?"<>|]/g, '-')
          .slice(0, 120),
      },
    })
    return job.id
  })
  const [job] = (await listJobs(actor, { limit: 20 })).filter(
    (entry) => entry.id === jobId,
  )
  return returned(job)
}

/* ── Pickers ────────────────────────────────────────────────────────── */

export type VariantOption = VariantLite & { isDefault: boolean }

/**
 * The prompt variants a shot may use — this project's image and video
 * prompts and the floating ones — for the shot board's pickers.
 */
export async function variantOptions(
  actor: Actor,
  projectId: string,
): Promise<VariantOption[]> {
  return withReader(async (db) => {
    const project = await ownedProject(db, actor, projectId, 'story', 'read')
    const rows = await db
      .select({
        id: promptVariants.id,
        label: promptVariants.label,
        promptId: promptVariants.promptId,
        promptTitle: promptPrompts.title,
        medium: promptPrompts.medium,
        providerHint: promptVariants.providerHint,
        text: sql<string>`left(${promptVariants.text}, 600)`,
        isDefault: promptVariants.isDefault,
      })
      .from(promptVariants)
      .innerJoin(promptPrompts, eq(promptPrompts.id, promptVariants.promptId))
      .where(
        and(
          eq(promptVariants.ownerId, actor.userId),
          inArray(promptPrompts.medium, ['image', 'video']),
          isNull(promptPrompts.archivedAt),
          sql`(${promptPrompts.projectId} = ${project.id} or ${promptPrompts.projectId} is null)`,
        ),
      )
      .orderBy(asc(promptPrompts.title), asc(promptVariants.position))
      .limit(500)
    return rows
  })
}

/* ── Home ───────────────────────────────────────────────────────────── */

export type StorySummary = {
  projectId: string
  shots: number
  generated: number
  /** Shots with a manual job waiting for its upload. */
  waiting: number
}

export async function storySummaries(actor: Actor): Promise<StorySummary[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'story', 'read')
    return db
      .select({
        projectId: storyShots.projectId,
        shots: sql<number>`count(*)::int`,
        generated: sql<number>`count(*) filter (where ${storyShots.status} in ('generated', 'edited', 'done'))::int`,
        waiting: sql<number>`count(*) filter (where exists (select 1 from asset_generation_jobs j where j.target_id = ${storyShots.id} and j.status = 'awaiting_upload'))::int`,
      })
      .from(storyShots)
      .innerJoin(projects, eq(projects.id, storyShots.projectId))
      .where(eq(storyShots.ownerId, actor.userId))
      .groupBy(storyShots.projectId)
  })
}
