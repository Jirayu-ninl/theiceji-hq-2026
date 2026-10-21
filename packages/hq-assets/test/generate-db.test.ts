import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { randomBytes } from 'node:crypto'
import { saveProviderConnection } from '@theiceji/hq-core/connections'
import {
  assetAssets,
  opsBudgetReservations,
  opsUsageEvents,
  providerConnections,
} from '@theiceji/hq-db/schema'
import { savePolicy } from '@theiceji/hq-ops/policy'
import { claimTask } from '@theiceji/hq-ops/tasks'
import {
  closeTestDb,
  dbTestsEnabled,
  failure,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import { eq } from 'drizzle-orm'
import {
  collectGeneratorVideos,
  generatorMedia,
  queueGeneration,
} from '../src/generate'
import { getJob, queueJob } from '../src/jobs'
import { configureAssetStorage } from '../src/storage'
import { memory } from './memory-storage'

/**
 * Generators against Postgres and a fake OpenAI-compatible endpoint on
 * localhost: images now, video submitted then collected by the tick, budget
 * held for agents, and agent jobs claimable by agents only. Runs only with
 * ASSETS_DB_TESTS=1 and a localhost DATABASE_URL.
 */

const suite = dbTestsEnabled('ASSETS_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'asset_generation_jobs',
  'asset_collection_items',
  'asset_collections',
  'asset_assets',
]

// 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

type Call = { path: string; auth: string | null; body: unknown }

suite('generators against Postgres', () => {
  let w: World
  let server: ReturnType<typeof Bun.serve>
  let calls: Call[] = []
  let mode: 'ok' | 'fail' = 'ok'
  let videoPolls = 0

  beforeAll(() => {
    process.env.HQ_SEALING_KEY = randomBytes(32).toString('base64')
    process.env.HQ_RUNTIME_ALLOW_PRIVATE = '1'
    configureAssetStorage({ providerOverride: (_owner, id) => memory(id) })
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const body =
          request.method === 'POST' ? await request.json() : undefined
        calls.push({
          path: url.pathname,
          auth: request.headers.get('authorization'),
          body,
        })
        if (mode === 'fail')
          return Response.json({ error: 'overloaded' }, { status: 500 })
        if (url.pathname === '/v1/images/generations') {
          const n = Number((body as { n?: number }).n ?? 1)
          return Response.json({
            data: Array.from({ length: n }, () => ({
              b64_json: PNG.toString('base64'),
            })),
          })
        }
        if (url.pathname === '/v1/videos')
          return Response.json({ id: 'vid_123', status: 'queued' })
        if (url.pathname === '/v1/videos/vid_123') {
          videoPolls += 1
          return Response.json({
            id: 'vid_123',
            status: videoPolls > 1 ? 'completed' : 'in_progress',
          })
        }
        if (url.pathname === '/v1/videos/vid_123/content')
          return new Response(
            new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
            {
              headers: { 'content-type': 'video/mp4' },
            },
          )
        return new Response('not found', { status: 404 })
      },
    })
  })

  beforeEach(async () => {
    calls = []
    mode = 'ok'
    videoPolls = 0
    w = await resetWorld(TABLES)
  })

  afterAll(async () => {
    server.stop(true)
    configureAssetStorage({ providerOverride: null })
    await closeTestDb(TABLES)
  })

  let made = 0
  async function generator(extra: Record<string, unknown> = {}) {
    made += 1
    return saveProviderConnection(w.owner, {
      provider: 'openai_compatible',
      label: `Studio ${made}`,
      secret: 'sk-test-9f2a',
      config: {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        currency: 'THB',
        image: { model: 'img-1', pricePerImage: '1.50' },
        video: { model: 'vid-1', pricePerSecond: '2.00', seconds: 4 },
        ...extra,
      },
    })
  }

  const image = (connectionId: string, count = 1) => ({
    projectId: w.project.id,
    provider: 'external:openai_compatible',
    connectionId,
    operation: 'generate' as const,
    title: 'Desk tour cover',
    input: { medium: 'image', prompt: 'A desk at dusk, warm lamp.', count },
  })

  test('the owner generates: files land, the cost is on record', async () => {
    const connection = await generator()
    expect(connection.config).toMatchObject({
      baseUrl: `http://127.0.0.1:${server.port}`,
    })
    expect(generatorMedia(connection.config)).toEqual({
      image: true,
      video: true,
    })
    const job = await queueGeneration(w.owner, image(connection.id, 2))
    expect(job.status).toBe('succeeded')
    expect(job.results).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      path: '/v1/images/generations',
      auth: 'Bearer sk-test-9f2a',
      body: { model: 'img-1', prompt: 'A desk at dusk, warm lamp.', n: 2 },
    })
    const files = await w.db
      .select()
      .from(assetAssets)
      .where(eq(assetAssets.projectId, w.project.id))
    expect(files.map((file) => [file.origin, file.mime, file.status])).toEqual([
      ['generated', 'image/png', 'ready'],
      ['generated', 'image/png', 'ready'],
    ])
    const usage = await w.db
      .select()
      .from(opsUsageEvents)
      .where(eq(opsUsageEvents.subjectId, job.id))
    expect(usage[0]).toMatchObject({
      costMinor: 300,
      currency: 'THB',
      costStatus: 'estimated',
      unit: 'images',
    })
  })

  test('an agent’s generation is held against the budget first', async () => {
    const connection = await generator()
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['generate'],
      cashLimitPerJob: '2.00',
      cashLimitPerDay: '10.00',
      cashLimitPerMonth: '100.00',
    })
    const over = await failure(
      queueGeneration(w.agent, image(connection.id, 2)),
    )
    expect(over.code).toBe('budget_exceeded')
    expect(calls).toHaveLength(0)
    const ok = await queueGeneration(w.agent, image(connection.id, 1))
    expect(ok.status).toBe('succeeded')
    const [held] = await w.db
      .select()
      .from(opsBudgetReservations)
      .where(eq(opsBudgetReservations.subjectId, ok.id))
    expect(held).toMatchObject({ status: 'settled', settledAmount: 150 })
    // No price, no spending by an agent.
    const free = await generator({ image: { model: 'img-1' } })
    const unknown = await failure(queueGeneration(w.agent, image(free.id)))
    expect(unknown.message).toContain('unknown price')
  })

  test('a refused call fails the job and gives the budget back', async () => {
    const connection = await generator()
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['generate'],
      cashLimitPerJob: '5.00',
      cashLimitPerDay: '10.00',
      cashLimitPerMonth: '100.00',
    })
    mode = 'fail'
    const job = await queueGeneration(w.agent, image(connection.id))
    expect(job.status).toBe('failed')
    expect(job.error).toContain('500')
    const [held] = await w.db
      .select()
      .from(opsBudgetReservations)
      .where(eq(opsBudgetReservations.subjectId, job.id))
    expect(held?.status).toBe('released')
    const [row] = await w.db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, connection.id))
    expect(row?.status).toBe('error')
  })

  test('video is submitted, then collected by the tick', async () => {
    const connection = await generator()
    const job = await queueGeneration(w.owner, {
      ...image(connection.id),
      title: 'Lamp tour motion',
      input: { medium: 'video', prompt: 'Slow push-in on the lamp.' },
    })
    expect(job.status).toBe('running')
    expect(job.remoteId).toBe('vid_123')
    expect(await collectGeneratorVideos()).toBe(0)
    expect(await collectGeneratorVideos()).toBe(1)
    const done = await getJob(w.owner, job.id)
    expect(done.status).toBe('succeeded')
    expect(done.results[0]).toMatchObject({ kind: 'video', mime: 'video/mp4' })
    // Images-only generators refuse video.
    const still = await generator({ video: undefined, image: { model: 'x' } })
    const refused = await failure(
      queueGeneration(w.owner, {
        ...image(still.id),
        input: { medium: 'video', prompt: 'x' },
      }),
    )
    expect(refused.message).toContain('images only')
  })

  test('an agent’s job is for agents: the worker never claims it', async () => {
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['generate', 'draft'],
    })
    const job = await queueJob(w.owner, {
      projectId: w.project.id,
      provider: 'agent:midjourney',
      operation: 'generate',
      title: 'Cover still',
      input: { medium: 'image', prompt: 'A desk at dusk.' },
    })
    expect(job.task?.status).toBe('open')
    expect(
      await claimTask(w.agent, w.project.id, {
        kinds: ['generation'],
        claimant: 'worker',
      }),
    ).toBeNull()
    const claim = await claimTask(w.agent, w.project.id, {
      kinds: ['generation'],
    })
    expect(claim?.task.payload).toMatchObject({
      job_id: job.id,
      provider: 'agent:midjourney',
    })
    const missing = await failure(
      queueJob(w.owner, {
        projectId: w.project.id,
        provider: 'agent:midjourney',
        operation: 'generate',
        title: 'x',
        input: { medium: 'image' },
      }),
    )
    expect(missing.message).toContain('prompt')
  })
})
