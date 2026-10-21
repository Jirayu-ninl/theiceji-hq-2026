import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  getJob,
  recordJobResult,
  settleOrphanJobs,
} from '@theiceji/hq-assets/jobs'
import { createTarget } from '@theiceji/hq-core/targets'
import {
  assetAssets,
  opsTasks,
  promptPrompts,
  promptVariants,
  refs,
} from '@theiceji/hq-db/schema'
import { withTransaction } from '@theiceji/hq-ops/store'
import { claimTask, finishRun } from '@theiceji/hq-ops/tasks'
import {
  allowAgent,
  closeTestDb,
  dbTestsEnabled,
  failure,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import { and, eq, sql } from 'drizzle-orm'
import {
  attachShotResult,
  deleteShot,
  generateShot,
  openStory,
  removeCharacter,
  saveCharacter,
  saveScene,
  saveShot,
  saveShots,
  saveStory,
  setShotStatus,
  storySummaries,
  zipScene,
} from '../src/story'
import '../src/register'

/**
 * Story against Postgres, with hq-assets jobs and the ops task a worker
 * claims. Destructive (truncates), so it runs only with STORY_DB_TESTS=1 and
 * a localhost DATABASE_URL.
 */

const suite = dbTestsEnabled('STORY_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'story_shots',
  'story_scenes',
  'story_characters',
  'story_stories',
  'asset_generation_jobs',
  'prompt_examples',
  'prompt_variants',
  'prompt_prompts',
  'asset_assets',
]

suite('hq-story against Postgres', () => {
  let w: World

  beforeEach(async () => {
    w = await resetWorld(TABLES, { kind: 'film' })
  })
  afterAll(() => closeTestDb(TABLES))

  async function file(name: string, kind: 'image' | 'video' = 'image') {
    const [row] = await w.db
      .insert(assetAssets)
      .values({
        ownerId: w.owner.userId,
        createdBy: w.owner.userId,
        projectId: w.project.id,
        storageProvider: 'r2',
        storageKey: `k/${crypto.randomUUID()}`,
        path: `pilot/${name}`,
        name,
        kind,
        mime: kind === 'image' ? 'image/png' : 'video/mp4',
        bytes: 1000,
        sha256: 'd'.repeat(64),
        status: 'ready',
        readyAt: sql`now()`,
        actorType: 'user',
        actorId: w.owner.userId,
      })
      .returning()
    if (!row) throw new Error('no asset')
    return row
  }

  async function variant(label: string, medium: 'image' | 'video' = 'image') {
    const [prompt] = await w.db
      .insert(promptPrompts)
      .values({
        ownerId: w.owner.userId,
        createdBy: w.owner.userId,
        projectId: w.project.id,
        title: `fog-river ${label}`,
        medium,
      })
      .returning()
    const [row] = await w.db
      .insert(promptVariants)
      .values({
        ownerId: w.owner.userId,
        createdBy: w.owner.userId,
        promptId: prompt?.id as string,
        label,
        text: 'A raft on a river swallowed by fog, lantern glow, 35mm.',
      })
      .returning()
    if (!row) throw new Error('no variant')
    return row
  }

  test('the story is made on first open; scenes and shots keep gapless numbers', async () => {
    const board = await openStory(w.owner, w.project.id)
    expect(board.story?.title).toBe(w.project.name)
    expect((await openStory(w.owner, w.project.id)).story?.id).toBe(
      board.story?.id,
    )
    const story = board.story
    if (!story) throw new Error('no story')
    const saved = await saveStory(w.owner, {
      storyId: story.id,
      expectedRevision: story.revision,
      title: 'Fog Line',
      script: '# Scene 1\nMara wakes.',
    })
    expect(saved.title).toBe('Fog Line')
    const one = await saveScene(w.owner, {
      storyId: story.id,
      heading: 'The ferry house',
    })
    const two = await saveScene(w.owner, {
      storyId: story.id,
      heading: 'Lantern call',
    })
    // Put the second first.
    await saveScene(w.owner, {
      storyId: story.id,
      sceneId: two.id,
      heading: two.heading,
      number: 1,
    })
    const reread = await openStory(w.owner, w.project.id)
    expect(reread.scenes.map((scene) => [scene.number, scene.heading])).toEqual(
      [
        [1, 'Lantern call'],
        [2, 'The ferry house'],
      ],
    )
    const [a, b, c] = await saveShots(w.owner, {
      sceneId: one.id,
      shots: [
        { action: 'Mara wakes.', durationS: 3 },
        { action: 'Hand on the pane.', durationS: '2.5' },
        { action: 'Boots by the door.' },
      ],
    })
    expect([a?.number, b?.number, c?.number]).toEqual([1, 2, 3])
    await saveShot(w.owner, {
      sceneId: one.id,
      shotId: c?.id,
      action: 'Boots by the door.',
      number: 1,
    })
    const board2 = await openStory(w.owner, w.project.id)
    const ferry = board2.scenes.find((scene) => scene.id === one.id)
    expect(
      ferry?.shots.map((shot) => [shot.code, shot.action, shot.startS]),
    ).toEqual([
      ['2.1', 'Boots by the door.', '0.00'],
      ['2.2', 'Mara wakes.', '0.00'],
      ['2.3', 'Hand on the pane.', '3.00'],
    ])
    expect(board2.runtimeS).toBe('5.50')
    const refused = await failure(
      deleteShot(w.agent, { shotId: a?.id as string, expectedRevision: 1 }),
    )
    expect(refused.code).toBe('forbidden')
  })

  test('characters with a board image; the cast leaves shots with them', async () => {
    const { story } = await openStory(w.owner, w.project.id)
    if (!story) throw new Error('no story')
    const board = await file('mara.png')
    const mara = await saveCharacter(w.owner, {
      storyId: story.id,
      name: 'Mara',
      boardAssetId: board.id,
    })
    const scene = await saveScene(w.owner, {
      storyId: story.id,
      heading: 'Jetty',
    })
    const shot = await saveShot(w.owner, {
      sceneId: scene.id,
      action: 'Mara on the jetty.',
      characterIds: [mara.id],
    })
    expect(shot.characterIds).toEqual([mara.id])
    const stranger = await failure(
      saveShot(w.owner, {
        sceneId: scene.id,
        action: 'Someone else.',
        characterIds: [crypto.randomUUID()],
      }),
    )
    expect(stranger.message).toContain('isn’t a character')
    const view = await openStory(w.owner, w.project.id)
    expect(view.characters[0]?.board?.name).toBe('mara.png')
    await removeCharacter(w.owner, { characterId: mara.id })
    const after = await openStory(w.owner, w.project.id)
    expect(after.scenes[0]?.shots[0]?.characterIds).toEqual([])
  })

  test('generate by hand: a manual job waits, the file answers it and links to the shot', async () => {
    const { story } = await openStory(w.owner, w.project.id)
    if (!story) throw new Error('no story')
    const still = await variant('A')
    const scene = await saveScene(w.owner, {
      storyId: story.id,
      heading: 'River',
    })
    const shot = await saveShot(w.owner, {
      sceneId: scene.id,
      action: 'The raft leaves.',
      imageVariantId: still.id,
    })
    const noMotion = await failure(
      generateShot(w.owner, { shotId: shot.id, medium: 'video' }),
    )
    expect(noMotion.message).toContain('motion variant')
    const job = await generateShot(w.owner, {
      shotId: shot.id,
      medium: 'image',
    })
    expect([job.provider, job.status, job.variantId]).toEqual([
      'manual',
      'awaiting_upload',
      still.id,
    ])
    const again = await generateShot(w.owner, {
      shotId: shot.id,
      medium: 'image',
    })
    expect(again.id).toBe(job.id)
    const result = await file('shot-1-1.png')
    const done = await attachShotResult(w.owner, {
      shotId: shot.id,
      assetId: result.id,
      jobId: job.id,
    })
    expect(done.status).toBe('generated')
    expect((await getJob(w.owner, job.id)).status).toBe('succeeded')
    const edges = await w.db
      .select()
      .from(refs)
      .where(and(eq(refs.toType, 'shot'), eq(refs.toId, shot.id)))
    expect(edges.map((edge) => [edge.fromId, edge.role])).toEqual([
      [result.id, 'result_of'],
    ])
    const view = await openStory(w.owner, w.project.id)
    const row = view.scenes[0]?.shots[0]
    expect(row?.results.map((asset) => asset.name)).toEqual(['shot-1-1.png'])
    expect(row?.image?.label).toBe('A')
    expect(row?.job?.status).toBe('succeeded')
    const edited = await setShotStatus(w.owner, {
      shotId: shot.id,
      expectedRevision: done.revision,
      status: 'edited',
    })
    expect(edited.status).toBe('edited')
    const [summary] = await storySummaries(w.owner)
    expect([summary?.shots, summary?.generated]).toEqual([1, 1])
  })

  test('a scene as a ZIP: a worker job, claimed with a lease; a lost lease can’t record', async () => {
    const { story } = await openStory(w.owner, w.project.id)
    if (!story) throw new Error('no story')
    const scene = await saveScene(w.owner, {
      storyId: story.id,
      heading: 'Dawn',
    })
    const empty = await failure(zipScene(w.owner, { sceneId: scene.id }))
    expect(empty.message).toContain('no shots')
    const shot = await saveShot(w.owner, { sceneId: scene.id, action: 'Dawn.' })
    const none = await failure(zipScene(w.owner, { sceneId: scene.id }))
    expect(none.message).toContain('nothing to zip')
    const clip = await file('dawn.mp4', 'video')
    await attachShotResult(w.owner, { shotId: shot.id, assetId: clip.id })
    const job = await zipScene(w.owner, { sceneId: scene.id })
    expect([job.provider, job.operation, job.status]).toEqual([
      'local_worker',
      'zip',
      'queued',
    ])
    expect(job.input).toMatchObject({ assetIds: [clip.id], forId: scene.id })
    const [task] = await w.db
      .select()
      .from(opsTasks)
      .where(eq(opsTasks.id, job.taskId as string))
    expect([task?.kind, task?.module]).toEqual(['generation', 'assets'])

    // The worker: policy allows generating and uploading here. The job is
    // the worker's (`claimant: worker`): an agent claiming as itself sees none.
    await allowAgent(w, ['generate', 'draft'])
    expect(
      await claimTask(w.agent, w.project.id, { kinds: ['generation'] }),
    ).toBeNull()
    const claim = await claimTask(w.agent, w.project.id, {
      kinds: ['generation'],
      claimant: 'worker',
    })
    expect(claim?.task.id).toBe(job.taskId as string)
    expect((await getJob(w.owner, job.id)).state).toBe('running')
    const zip = await file('Fog - scene 1.zip')
    const lost = await failure(
      recordJobResult(w.agent, {
        jobId: job.id,
        fencingToken: (claim?.task.fencingToken ?? 0) + 1,
        assetIds: [zip.id],
      }),
    )
    expect(lost.code).toBe('lease_lost')
    const recorded = await recordJobResult(w.agent, {
      jobId: job.id,
      fencingToken: claim?.task.fencingToken as number,
      assetIds: [zip.id],
    })
    expect(recorded.status).toBe('succeeded')
    await finishRun(w.agent, claim?.run.id as string, {
      fencingToken: claim?.task.fencingToken,
      outcome: 'done',
      summary: 'Zipped 1 file.',
    })
    const view = await openStory(w.owner, w.project.id)
    expect(view.scenes[0]?.zip?.results.map((asset) => asset.name)).toEqual([
      'Fog - scene 1.zip',
    ])
  })

  test('a worker job whose task gives up fails with its reason', async () => {
    const { story } = await openStory(w.owner, w.project.id)
    if (!story) throw new Error('no story')
    const scene = await saveScene(w.owner, {
      storyId: story.id,
      heading: 'Night',
    })
    const shot = await saveShot(w.owner, {
      sceneId: scene.id,
      action: 'Night.',
    })
    await attachShotResult(w.owner, {
      shotId: shot.id,
      assetId: (await file('night.mp4', 'video')).id,
    })
    const job = await zipScene(w.owner, { sceneId: scene.id })
    await withTransaction(async (tx) => {
      await tx
        .update(opsTasks)
        .set({ status: 'failed', lastError: 'ffmpeg missing on the worker' })
        .where(eq(opsTasks.id, job.taskId as string))
    })
    expect(await settleOrphanJobs()).toBe(1)
    const failed = await getJob(w.owner, job.id)
    expect([failed.status, failed.error]).toEqual([
      'failed',
      'ffmpeg missing on the worker',
    ])
  })

  test('a note promoted to a shot lands in the last scene (or a first one)', async () => {
    const made = await withTransaction((tx) =>
      createTarget(
        'shot',
        { action: 'The dog finds the shoe.', durationS: 4 },
        { tx, actor: w.owner, project: w.project },
      ),
    )
    expect(made.type).toBe('shot')
    expect(made.href).toContain('/story?view=shots&shot=')
    const view = await openStory(w.owner, w.project.id)
    expect(view.scenes.map((scene) => scene.heading)).toEqual(['Scene 1'])
    expect(view.scenes[0]?.shots[0]?.durationS).toBe('4.00')
  })
})
