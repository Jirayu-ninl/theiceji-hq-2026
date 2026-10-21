import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { finalizeUpload, prepareUpload } from '@theiceji/hq-assets/assets'
import { getJob } from '@theiceji/hq-assets/jobs'
import '@theiceji/hq-assets/register'
import {
  ALL_SCOPES,
  hashToken,
  looksLikeBearer,
  mintToken,
  tokenHint,
  verifyAccessToken,
} from '@theiceji/hq-db/access'
import { assetAssets, oauthGrants, oauthTokens } from '@theiceji/hq-db/schema'
import { savePolicy } from '@theiceji/hq-ops/policy'
import {
  closeTestDb,
  dbTestsEnabled,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import {
  attachShotResult,
  openStory,
  saveScene,
  saveShot,
  zipScene,
} from '@theiceji/hq-story/story'
import '@theiceji/hq-story/register'
import { createLogger } from '@theiceji/mcp-kernel/log'
import { createFetchHandler } from '@theiceji/mcp-kernel/server'
import { eq } from 'drizzle-orm'
import {
  type FakeS3,
  startFakeS3,
} from '../../../packages/hq-storage/test/fake-s3'
import { IDENTITY } from '../../hq-mcp/src/identity'
import { fromGrantCheck } from '../../hq-mcp/src/kernel'
import { MODULE_WORKSPACES } from '../../hq-mcp/src/modules'
import { connectHq, type Hq, httpTransfer } from '../src/hq'
import { runPlan13Once } from '../src/plan13'
import { readZip } from '../src/zip'

/**
 * The local worker on the new queue, end to end — a
 * Story scene's ZIP. The worker token talks to HQ's real MCP server over
 * HTTP (the real gate, scopes and tools), claims the job's ops task with a
 * lease, downloads each shot's file through signed links (hash-checked),
 * zips them, uploads against the job and records it under its fencing
 * token. Storage is a local S3 stand-in; Postgres is real.
 *
 * Destructive (truncates). Runs only with WORKER_DB_TESTS=1 and a localhost
 * DATABASE_URL.
 */

const suite = dbTestsEnabled('WORKER_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'story_shots',
  'story_scenes',
  'story_characters',
  'story_stories',
  'asset_generation_jobs',
  'asset_collection_items',
  'asset_collections',
  'asset_assets',
]

suite('plan13 worker (Postgres + MCP over HTTP + S3 stand-in)', () => {
  let w: World
  let s3: FakeS3
  let server: ReturnType<typeof Bun.serve>
  let hq: Hq
  const clips: { name: string; bytes: Uint8Array }[] = [
    { name: 'shot 1.1 · wake.mp4', bytes: new TextEncoder().encode('frame-a') },
    { name: 'shot 1.2 · pane.mp4', bytes: new TextEncoder().encode('frame-b') },
  ]

  async function upload(name: string, bytes: Uint8Array) {
    const prepared = await prepareUpload(w.owner, {
      projectId: w.project.id,
      name,
      mime: 'video/mp4',
      bytes: bytes.byteLength,
    })
    if (prepared.upload.mode !== 'presigned_put') throw new Error('no PUT')
    const put = await fetch(prepared.upload.url, {
      method: 'PUT',
      headers: prepared.upload.headers,
      body: new Blob([bytes as BlobPart]),
    })
    expect(put.ok).toBe(true)
    return finalizeUpload(w.owner, { assetId: prepared.asset.id })
  }

  beforeAll(async () => {
    s3 = startFakeS3()
    process.env.R2_ENDPOINT = s3.origin
    process.env.R2_BUCKET = 'hq-test'
    process.env.R2_ACCESS_KEY_ID = 'local'
    process.env.R2_SECRET_ACCESS_KEY = 'local'
    w = await resetWorld(TABLES, { kind: 'film' })
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => service.fetch(request),
    })
    const publicUrl = `http://127.0.0.1:${server.port}/mcp`
    const log = createLogger('plan13-worker-test', { stdio: true })
    const service = createFetchHandler({
      identity: IDENTITY,
      config: {
        MCP_PUBLIC_URL: publicUrl,
        MCP_AUTHORIZATION_SERVER: 'http://127.0.0.1:8990',
        MCP_ALLOWED_ORIGIN_HOSTS: [],
      },
      scopes: ALL_SCOPES,
      looksLikeBearer,
      verify: async (token) =>
        fromGrantCheck(await verifyAccessToken(w.db, token, publicUrl)),
      context: (caller) => ({ caller, db: w.db, log }),
      workspaces: MODULE_WORKSPACES,
      log,
    })
    // A worker token: agents:operate + assets (operate claims generation work),
    // covered by the film's policy.
    const token = mintToken('personalToken')
    const [grant] = await w.db
      .insert(oauthGrants)
      .values({
        userId: w.owner.userId,
        kind: 'personal',
        label: 'Local worker (test)',
        scope: 'agents:operate assets:read assets:write assets:operate',
        resource: publicUrl,
        actorType: 'worker',
      })
      .returning()
    if (!grant) throw new Error('no grant')
    await w.db.insert(oauthTokens).values({
      id: hashToken(token),
      grantId: grant.id,
      kind: 'personal',
      hint: tokenHint(token),
    })
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [grant.id],
      allowedActions: ['generate', 'draft'],
    })
    hq = await connectHq({ url: publicUrl, token })
  })

  afterAll(async () => {
    await hq?.close()
    server?.stop(true)
    s3?.stop()
    await closeTestDb(TABLES)
  })

  test('a scene’s shots become one ZIP, made and recorded by the worker', async () => {
    const { story } = await openStory(w.owner, w.project.id)
    if (!story) throw new Error('no story')
    const scene = await saveScene(w.owner, {
      storyId: story.id,
      heading: 'INT. FERRY HOUSE — MORNING',
    })
    for (const clip of clips) {
      const shot = await saveShot(w.owner, {
        sceneId: scene.id,
        action: clip.name,
      })
      const asset = await upload(clip.name, clip.bytes)
      expect(asset.sha256).toBe(
        createHash('sha256').update(clip.bytes).digest('hex'),
      )
      await attachShotResult(w.owner, { shotId: shot.id, assetId: asset.id })
    }
    const job = await zipScene(w.owner, { sceneId: scene.id })
    expect(job.state).toBe('queued')

    const lines: string[] = []
    const outcome = await runPlan13Once({
      hq,
      transfer: httpTransfer,
      leaseSeconds: 60,
      log: (line) => lines.push(line),
    })
    expect(outcome?.status, lines.join('\n')).toBe('succeeded')
    expect(outcome?.jobId).toBe(job.id)

    const done = await getJob(w.owner, job.id)
    expect(done.status).toBe('succeeded')
    expect(done.task?.status).toBe('done')
    const zipAsset = done.results[0]
    expect(zipAsset?.name).toMatch(/scene 1\.zip$/)
    const [row] = await w.db
      .select()
      .from(assetAssets)
      .where(eq(assetAssets.id, zipAsset?.id as string))
    expect([row?.origin, row?.status, row?.mime]).toEqual([
      'generated',
      'ready',
      'application/zip',
    ])
    const stored = [...s3.objects.entries()].find(([path]) =>
      path.endsWith(row?.storageKey as string),
    )?.[1]
    const entries = readZip(stored?.bytes as Uint8Array)
    expect(entries.map((entry) => entry.name)).toEqual([
      '01-shot 1.1 · wake.mp4',
      '02-shot 1.2 · pane.mp4',
    ])
    expect(new TextDecoder().decode(entries[1]?.bytes)).toBe('frame-b')

    // The queue is empty now: the next pass claims nothing.
    expect(
      await runPlan13Once({ hq, transfer: httpTransfer, leaseSeconds: 60 }),
    ).toBeNull()
    const view = await openStory(w.owner, w.project.id)
    expect(view.scenes[0]?.zip?.state).toBe('succeeded')
  })
})
