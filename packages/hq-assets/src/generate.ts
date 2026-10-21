import {
  type GeneratorConfig,
  generatorConfig,
  openConnection,
  providerFetch,
  reportConnection,
} from '@theiceji/hq-core/connections'
import { digitsOf, toMinor } from '@theiceji/hq-core/money'
import {
  type AssetJobRow,
  assetGenerationJobs,
  type ProjectRow,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { actorFromRecord } from '@theiceji/hq-ops/actors'
import {
  recordUsage,
  releaseReservation,
  reserveBudget,
  settleReservation,
} from '@theiceji/hq-ops/budget'
import type { Tx } from '@theiceji/hq-ops/db'
import { budgetExceeded, invalid, OpsError } from '@theiceji/hq-ops/errors'
import { currentPolicy } from '@theiceji/hq-ops/policy-gate'
import {
  audit,
  ownedRow,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { and, eq, inArray, isNotNull, like, sql } from 'drizzle-orm'
import { insertStoredAsset, storeGenerated } from './assets'
import {
  finishJob,
  getJob,
  isExternalProvider,
  type JobView,
  queueJob,
} from './jobs'

/**
 * Generators: `external:openai_compatible` — HQ calls the
 * owner's OpenAI-compatible endpoint itself.
 *
 * · **Images are synchronous** — `POST {base}/v1/images/generations`, a
 *   minute at most, the files stored in the project's storage and linked to
 *   what they are for in the same commit that marks the job done.
 * · **Video is submitted, then polled** by the ops tick —
 *   `POST {base}/v1/videos`, `GET /v1/videos/{id}` until done, then the
 *   content. Only when the owner named a video model on the connection;
 *   without one the generator is images-only and video stays by hand.
 * · **Budget first.** For an agent, the price on the connection is held
 *   against the operating policy before the call and settled after; a
 *   generator with no price can't be spent on by an agent (an unknown price
 *   isn't free). The owner's own clicks are recorded, not held.
 * · **A call that never answered is not retried** — the job fails with the
 *   outcome unknown and the estimate stays charged, because the provider may
 *   have billed.
 */

const IMAGE_TIMEOUT_MS = 60_000
const MAX_IMAGE_BYTES = 64 * 1024 ** 2
const MAX_VIDEO_BYTES = 512 * 1024 ** 2

type Medium = 'image' | 'video'

export type GeneratorMedia = { image: boolean; video: boolean }

/** What a generator connection can make, from its config. */
export function generatorMedia(config: unknown): GeneratorMedia {
  const parsed = generatorConfig.safeParse(config)
  if (!parsed.success) return { image: false, video: false }
  return {
    image: Boolean(parsed.data.image),
    video: Boolean(parsed.data.video),
  }
}

function price(
  config: GeneratorConfig,
  medium: Medium,
  input: Record<string, unknown>,
): { currency: string; minor: number } | null {
  const currency = config.currency ?? 'USD'
  const unit =
    medium === 'image'
      ? config.image?.pricePerImage
      : config.video?.pricePerSecond
  if (!unit) return null
  const count =
    medium === 'image'
      ? Number(input.count ?? 1)
      : Number(input.seconds ?? config.video?.seconds ?? 4)
  const each = toMinor(unit, digitsOf(currency) + 4)
  const minor = (each * BigInt(count) + 9_999n) / 10_000n
  return { currency, minor: Number(minor) }
}

type Prepared = {
  job: AssetJobRow
  project: ProjectRow | null
  config: GeneratorConfig
  secret: string
  connectionId: string
  medium: Medium
  reservationId: string | null
  estimate: { currency: string; minor: number } | null
}

async function prepare(tx: Tx, actor: Actor, jobId: string): Promise<Prepared> {
  const { row: job, project } = await ownedRow<AssetJobRow>(
    tx,
    actor,
    assetGenerationJobs,
    jobId,
    'Job',
    { lock: true },
  )
  if (!isExternalProvider(job.provider))
    throw invalid('Only a generator job is run by HQ.')
  if (job.status !== 'queued')
    throw invalid(`This job is already ${job.status}.`)
  const connectionId = String(job.input.connectionId ?? '')
  const { row, secret } = await openConnection(tx, actor.userId, connectionId, [
    'openai_compatible',
  ])
  const parsed = generatorConfig.safeParse(row.config)
  if (!parsed.success)
    throw invalid(
      `${row.label} needs its base URL and models (Settings › Connections).`,
    )
  const config = parsed.data
  const medium = (job.input.medium === 'video' ? 'video' : 'image') as Medium
  if (medium === 'image' && !config.image)
    throw invalid(`${row.label} has no image model set.`)
  if (medium === 'video' && !config.video)
    throw invalid(
      `${row.label} makes images only — name a video model on it, or make the clip by hand.`,
    )
  const estimate = price(config, medium, job.input)
  let reservationId: string | null = null
  if (actor.type !== 'user') {
    if (!estimate)
      throw budgetExceeded(
        `${row.label} has no price, and an unknown price isn’t free. Ask the owner to set one (Settings › Connections).`,
        { reason: 'unknown_price', provider: job.provider },
      )
    const policy = await currentPolicy(tx, actor.userId, project?.id ?? null)
    if (!policy)
      throw budgetExceeded('No operating policy covers this project.')
    reservationId = (
      await reserveBudget(tx, actor, project, policy, {
        spend: {
          kind: 'cash',
          unit: estimate.currency,
          amount: estimate.minor,
        },
        provider: job.provider,
        purpose: `${medium} generation`,
        subjectType: 'asset_job',
        subjectId: job.id,
      })
    ).id
  }
  await tx
    .update(assetGenerationJobs)
    .set({
      status: 'running',
      startedAt: sql`now()`,
      input: { ...job.input, reservationId },
      revision: sql`${assetGenerationJobs.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(assetGenerationJobs.id, job.id))
  await audit(tx, actor, {
    projectId: job.projectId,
    action: 'asset.job.start',
    targetType: 'asset_job',
    targetId: job.id,
    changes: {
      provider: job.provider,
      connection: row.label,
      medium,
      estimate,
    },
  })
  return {
    job,
    project,
    config,
    secret,
    connectionId,
    medium,
    reservationId,
    estimate,
  }
}

const authHeaders = (secret: string) => ({
  authorization: `Bearer ${secret}`,
  'content-type': 'application/json',
  accept: 'application/json',
})

type ImagePayload = { body: Uint8Array<ArrayBuffer>; mime: string }

async function callImages(p: Prepared): Promise<ImagePayload[]> {
  const image = p.config.image as NonNullable<GeneratorConfig['image']>
  const response = await providerFetch(
    `${p.config.baseUrl}/v1/images/generations`,
    {
      method: 'POST',
      headers: authHeaders(p.secret),
      body: JSON.stringify({
        model: image.model,
        prompt: p.job.input.prompt,
        n: Number(p.job.input.count ?? 1),
        size: p.job.input.size ?? image.size ?? '1024x1024',
        response_format: 'b64_json',
      }),
      timeoutMs: IMAGE_TIMEOUT_MS,
      maxBytes: MAX_IMAGE_BYTES,
    },
  )
  if (response.status === 401 || response.status === 403)
    throw new ProviderRefused('The generator refused the key.', 'needs_reauth')
  if (response.status >= 400)
    throw new ProviderRefused(
      `The generator answered ${response.status}: ${response.text().slice(0, 300)}`,
    )
  const data = response.json<{
    data?: { b64_json?: string; url?: string }[]
  }>().data
  if (!data?.length) throw new ProviderRefused('The generator sent no image.')
  const out: ImagePayload[] = []
  for (const entry of data) {
    if (entry.b64_json) {
      const bytes = Buffer.from(entry.b64_json, 'base64')
      out.push({ body: new Uint8Array(bytes), mime: sniff(bytes) })
    } else if (entry.url) {
      const file = await providerFetch(entry.url, {
        timeoutMs: IMAGE_TIMEOUT_MS,
        maxBytes: MAX_IMAGE_BYTES,
      })
      if (file.status >= 400)
        throw new ProviderRefused(`The image link answered ${file.status}.`)
      out.push({
        body: new Uint8Array(file.body),
        mime: file.headers['content-type']?.split(';')[0] ?? sniff(file.body),
      })
    }
  }
  if (out.length === 0)
    throw new ProviderRefused('The generator sent no image.')
  return out
}

function sniff(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp'
  return 'image/png'
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
}

class ProviderRefused extends Error {
  constructor(
    message: string,
    readonly status: 'error' | 'needs_reauth' = 'error',
  ) {
    super(message)
  }
}

function fileBase(job: AssetJobRow): string {
  return (
    job.title
      .toLowerCase()
      .replace(/[^a-z0-9ก-๙]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'generated'
  )
}

async function store(
  actor: Actor,
  p: Pick<Prepared, 'job' | 'project'>,
  files: ImagePayload[],
): Promise<Awaited<ReturnType<typeof storeGenerated>>[]> {
  const base = fileBase(p.job)
  const stored = []
  for (const [index, file] of files.entries())
    stored.push(
      await storeGenerated(actor, p.project, {
        name: `${base}${files.length > 1 ? `-${index + 1}` : ''}.${EXT[file.mime] ?? 'bin'}`,
        mime: file.mime,
        body: file.body as Uint8Array<ArrayBuffer>,
        collection: 'generated',
      }),
    )
  return stored
}

async function complete(
  actor: Actor,
  p: Pick<
    Prepared,
    'job' | 'project' | 'reservationId' | 'estimate' | 'medium'
  >,
  stored: Awaited<ReturnType<typeof storeGenerated>>[],
): Promise<void> {
  await withTransaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(assetGenerationJobs)
      .where(eq(assetGenerationJobs.id, p.job.id))
      .for('update')
    if (job?.status !== 'running') return
    const results = []
    for (const file of stored)
      results.push(
        await insertStoredAsset(tx, actor, p.project, file, {
          origin: 'generated',
          collection: 'generated',
        }),
      )
    await finishJob(tx, actor, job, results)
    if (p.reservationId && p.estimate)
      await settleReservation(
        tx,
        actor,
        p.reservationId,
        p.estimate.minor,
        'generated',
      )
    await recordUsage(tx, actor, p.project, {
      reservationId: p.estimate ? p.reservationId : null,
      subjectType: 'asset_job',
      subjectId: job.id,
      provider: job.provider,
      kind: 'cash',
      unit: p.medium === 'image' ? 'images' : 'seconds',
      quantity:
        p.medium === 'image'
          ? results.length
          : Number(job.input.seconds ?? 0) || null,
      costMinor: p.estimate?.minor ?? null,
      currency: p.estimate?.currency ?? null,
      costStatus: p.estimate ? 'estimated' : 'unknown',
    })
  })
}

async function fail(
  actor: Actor,
  p: Pick<Prepared, 'job' | 'project' | 'reservationId' | 'estimate'>,
  message: string,
  charged: boolean,
): Promise<void> {
  await withTransaction(async (tx) => {
    await tx
      .update(assetGenerationJobs)
      .set({
        status: 'failed',
        error: message,
        finishedAt: sql`now()`,
        revision: sql`${assetGenerationJobs.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(assetGenerationJobs.id, p.job.id),
          inArray(assetGenerationJobs.status, ['queued', 'running']),
        ),
      )
    if (p.reservationId) {
      if (charged && p.estimate)
        await settleReservation(
          tx,
          actor,
          p.reservationId,
          p.estimate.minor,
          'outcome unknown — the provider may have billed',
        )
      else
        await releaseReservation(tx, actor, p.reservationId, 'the call failed')
    }
    await recordUsage(tx, actor, p.project, {
      reservationId: charged && p.estimate ? p.reservationId : null,
      subjectType: 'asset_job',
      subjectId: p.job.id,
      provider: p.job.provider,
      kind: 'cash',
      unit: 'calls',
      costMinor: charged ? (p.estimate?.minor ?? null) : null,
      currency: charged ? (p.estimate?.currency ?? null) : null,
      costStatus: charged && p.estimate ? 'estimated' : 'unknown',
      failed: true,
      note: message.slice(0, 500),
    })
    await audit(tx, actor, {
      projectId: p.job.projectId,
      action: 'asset.job.fail',
      targetType: 'asset_job',
      targetId: p.job.id,
      reason: message.slice(0, 1000),
    })
  })
}

/**
 * Run a generator job HQ calls itself: an image now, or a video submitted
 * for the tick to collect. Returns the job as it stands afterwards; a
 * refusal before the call (budget, config) throws and leaves it queued.
 */
export async function runGeneratorJob(
  actor: Actor,
  jobId: string,
): Promise<JobView> {
  const p = await withTransaction((tx) => prepare(tx, actor, jobId))
  try {
    if (p.medium === 'image') {
      const files = await callImages(p)
      const stored = await store(actor, p, files)
      await complete(actor, p, stored)
    } else {
      const video = p.config.video as NonNullable<GeneratorConfig['video']>
      const response = await providerFetch(`${p.config.baseUrl}/v1/videos`, {
        method: 'POST',
        headers: authHeaders(p.secret),
        body: JSON.stringify({
          model: video.model,
          prompt: p.job.input.prompt,
          seconds: String(p.job.input.seconds ?? video.seconds ?? 4),
          size: p.job.input.size ?? video.size ?? '1280x720',
        }),
        timeoutMs: 30_000,
        maxBytes: 1024 ** 2,
      })
      if (response.status >= 400)
        throw new ProviderRefused(
          `The generator answered ${response.status}: ${response.text().slice(0, 300)}`,
          response.status === 401 ? 'needs_reauth' : 'error',
        )
      const remote = response.json<{ id?: string }>()
      if (!remote.id) throw new ProviderRefused('The generator sent no job id.')
      await withTransaction((tx) =>
        tx
          .update(assetGenerationJobs)
          .set({ remoteId: remote.id, updatedAt: sql`now()` })
          .where(eq(assetGenerationJobs.id, p.job.id)),
      )
    }
    await reportConnection(p.connectionId, null)
  } catch (error) {
    const refused = error instanceof ProviderRefused
    const timedOut =
      !refused &&
      error instanceof Error &&
      /timeout|timed out|network/i.test(error.message)
    const message = refused
      ? error.message
      : timedOut
        ? 'The generator never answered — the outcome is unknown; it may still bill.'
        : error instanceof OpsError
          ? error.message
          : `The call failed: ${error instanceof Error ? error.message : String(error)}`
    await fail(actor, p, message, timedOut)
    if (refused)
      await reportConnection(p.connectionId, error.message, error.status)
  }
  return getJob(actor, jobId)
}

/**
 * The ops tick: video jobs a generator is still making — ask each once, and
 * collect what's done. A handful per tick; the rest wait for the next.
 */
export async function collectGeneratorVideos(limit = 5): Promise<number> {
  const running = await withReader((db) =>
    db
      .select()
      .from(assetGenerationJobs)
      .where(
        and(
          eq(assetGenerationJobs.status, 'running'),
          like(assetGenerationJobs.provider, 'external:%'),
          isNotNull(assetGenerationJobs.remoteId),
        ),
      )
      .orderBy(assetGenerationJobs.updatedAt)
      .limit(limit),
  )
  let collected = 0
  for (const job of running) {
    const lookup = await withReader((db) =>
      actorFromRecord(db, job.ownerId, {
        actorType: job.actorType,
        actorId: job.actorId,
      }),
    )
    const p = {
      job,
      project: null as ProjectRow | null,
      reservationId: (job.input.reservationId as string | null) ?? null,
      estimate: null as { currency: string; minor: number } | null,
      medium: 'video' as const,
    }
    if (!lookup.ok) {
      continue
    }
    const actor = lookup.actor
    try {
      const opened = await withReader(async (db) => {
        const { project } = await ownedRow<AssetJobRow>(
          db,
          actor,
          assetGenerationJobs,
          job.id,
          'Job',
        )
        const connection = await openConnection(
          db,
          job.ownerId,
          String(job.input.connectionId ?? ''),
          ['openai_compatible'],
        )
        return { project, connection }
      })
      p.project = opened.project
      const config = generatorConfig.parse(opened.connection.row.config)
      p.estimate = price(config, 'video', job.input)
      const base = `${config.baseUrl}/v1/videos/${encodeURIComponent(job.remoteId as string)}`
      const headers = authHeaders(opened.connection.secret)
      const status = await providerFetch(base, {
        headers,
        timeoutMs: 15_000,
        maxBytes: 1024 ** 2,
      })
      const state = status.json<{
        status?: string
        error?: { message?: string }
      }>()
      if (state.status === 'failed') {
        await fail(
          actor,
          p,
          `The generator failed: ${state.error?.message ?? 'no reason given'}`,
          false,
        )
        continue
      }
      if (state.status !== 'completed') continue
      const content = await providerFetch(`${base}/content`, {
        headers: { authorization: headers.authorization },
        timeoutMs: 45_000,
        maxBytes: MAX_VIDEO_BYTES,
      })
      if (content.status >= 400) continue
      const stored = await store(actor, p, [
        { body: new Uint8Array(content.body), mime: 'video/mp4' },
      ])
      await complete(actor, p, stored)
      collected += 1
    } catch (error) {
      if (error instanceof OpsError) await fail(actor, p, error.message, false)
    }
  }
  return collected
}

/**
 * Queue a generation and, for a generator HQ calls itself, run it: the
 * image comes back with the job; a video comes back submitted. An agent's
 * job (`agent:<service>`) waits for an agent to claim it.
 */
export async function queueGeneration(
  actor: Actor,
  raw: Parameters<typeof queueJob>[1],
): Promise<JobView> {
  const job = await queueJob(actor, raw)
  if (isExternalProvider(job.provider) && job.status === 'queued')
    return runGeneratorJob(actor, job.id)
  return job
}
