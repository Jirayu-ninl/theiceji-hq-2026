import { link } from '@theiceji/hq-core/refs'
import {
  ASSET_JOB_OPERATIONS,
  type AssetJobOperation,
  REF_ROLES,
  REF_TYPES,
} from '@theiceji/hq-db/enums'
import {
  type AssetJobRow,
  type AssetRow,
  assetAssets,
  assetGenerationJobs,
  type OpsTaskRow,
  opsTasks,
  type ProjectRow,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan } from '@theiceji/hq-ops/access'
import { schedulerActor } from '@theiceji/hq-ops/actors'
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
  text,
} from '@theiceji/hq-ops/schemas'
import {
  assertModuleOn,
  audit,
  authorize,
  ownedProject,
  ownedRow,
  returned,
  runOperation,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { assertTaskFencing, openTask } from '@theiceji/hq-ops/tasks'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'

/**
 * Generation and production jobs — what makes files.
 *
 * · **`manual`**: the owner makes the file elsewhere and attaches it; the
 *   job waits in `awaiting_upload`. It only ever generates.
 * · **`local_worker`**: HQ's worker on the owner's machine (apps/worker)
 *   claims the job's ops task with a lease and a fencing token, downloads
 *   its inputs through signed links, makes the file, uploads it against this
 *   job (`prepareUpload` with `jobId`) and records it here — only while it
 *   still holds the lease. A worker that dies loses the lease; the task is
 *   claimed again; a task that runs out of attempts fails its job.
 * · **A result links to what it is for** — `asset —result_of→ shot` — in the
 *   same commit that marks the job done.
 * · **`agent:<service>`**: an agent generates with its own
 *   tools. The job's ops task is claimable by agents only; the agent uploads
 *   against the job and records its files under the task's fencing token,
 *   exactly like the worker — evidence `agent_attested`.
 * · **`external:openai_compatible`**: HQ calls the owner's generator itself
 *   (./generate.ts) — budget held first, the file stored, the cost recorded.
 */

/** Who makes a job's file. */
export const JOB_PROVIDER =
  /^(manual|local_worker|agent:[a-z0-9_.-]{1,60}|external:openai_compatible)$/

export const isAgentProvider = (provider: string) =>
  provider.startsWith('agent:')
export const isExternalProvider = (provider: string) =>
  provider.startsWith('external:')

type JobHook = (
  tx: Tx,
  actor: Actor,
  job: AssetJobRow,
  results: AssetRow[],
) => Promise<void>

const succeededHooks = new Map<string, JobHook>()

/**
 * What a module does when a job made files for one of its records — Story
 * marks the shot generated. Runs in the transaction that marks the job done,
 * whoever finished it (the owner's upload, the worker, an agent, a generator).
 */
export function onJobSucceeded(targetType: string, hook: JobHook): void {
  succeededHooks.set(targetType, hook)
}

registerConstraintMessages({
  asset_generation_jobs_done_check: 'A finished job names the files it made.',
  asset_generation_jobs_manual_check: 'Only a manual job waits for an upload.',
})

/** What each worker operation needs in `input` (IDs and small parameters only). */
const WORKER_INPUTS: Partial<
  Record<AssetJobOperation, z.ZodType<Record<string, unknown>>>
> = {
  zip: z.object({
    assetIds: z.array(z.uuid()).min(1).max(200),
    /** The record the bundle is of (a scene), so its page can find the ZIP. */
    forId: z.uuid().optional(),
    /** The ZIP's file name, without `.zip`. */
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\\/:*?"<>|]+$/, 'A file name, without slashes.'),
  }),
  thumbnail: z.object({ assetId: z.uuid() }),
  probe: z.object({ assetId: z.uuid() }),
}

export type JobView = AssetJobRow & {
  /** `running` when a worker holds its task now; otherwise the job's own status. */
  state: AssetJobRow['status']
  results: Pick<
    AssetRow,
    'id' | 'name' | 'title' | 'kind' | 'mime' | 'status' | 'bytes'
  >[]
  task: Pick<
    OpsTaskRow,
    'id' | 'status' | 'attempts' | 'maxAttempts' | 'leaseExpiresAt'
  > | null
}

async function views(
  reader: Reader,
  ownerId: string,
  jobs: AssetJobRow[],
): Promise<JobView[]> {
  if (jobs.length === 0) return []
  const taskIds = jobs.map((job) => job.taskId).filter(Boolean) as string[]
  const resultIds = [...new Set(jobs.flatMap((job) => job.resultAssetIds))]
  const [tasks, results] = await Promise.all([
    taskIds.length
      ? reader
          .select({
            id: opsTasks.id,
            status: opsTasks.status,
            attempts: opsTasks.attempts,
            maxAttempts: opsTasks.maxAttempts,
            leaseExpiresAt: opsTasks.leaseExpiresAt,
          })
          .from(opsTasks)
          .where(inArray(opsTasks.id, taskIds))
      : Promise.resolve([]),
    resultIds.length
      ? reader
          .select({
            id: assetAssets.id,
            name: assetAssets.name,
            title: assetAssets.title,
            kind: assetAssets.kind,
            mime: assetAssets.mime,
            status: assetAssets.status,
            bytes: assetAssets.bytes,
          })
          .from(assetAssets)
          .where(
            and(
              eq(assetAssets.ownerId, ownerId),
              inArray(assetAssets.id, resultIds),
            ),
          )
      : Promise.resolve([]),
  ])
  return jobs.map((job) => {
    const task = tasks.find((entry) => entry.id === job.taskId) ?? null
    return {
      ...job,
      state:
        job.status === 'queued' && task?.status === 'claimed'
          ? 'running'
          : job.status,
      task,
      results: job.resultAssetIds
        .map((id) => results.find((entry) => entry.id === id))
        .filter(Boolean) as JobView['results'],
    }
  })
}

const targetSchema = z
  .object({
    type: choice(REF_TYPES, 'That can’t be a job’s target.'),
    id: recordId('Target'),
    role: choice(REF_ROLES, 'That isn’t a link role.'),
  })
  .optional()

const queueSchema = z.object({
  projectId: optionalRecordId('Project'),
  provider: z
    .string()
    .trim()
    .regex(
      JOB_PROVIDER,
      'Choose manual, the local worker, an agent (agent:<service>) or a generator (external:openai_compatible).',
    ),
  /** The generator connection, for `external:*`. */
  connectionId: optionalRecordId('Generator'),
  operation: choice(ASSET_JOB_OPERATIONS, 'That isn’t a job HQ knows.'),
  title: text.required('Title', 200),
  input: z.record(z.string(), z.unknown()).optional(),
  target: targetSchema,
  variantId: optionalRecordId('Variant'),
  idempotencyKey: idempotencyKey.optional(),
})

export type QueueJobInput = z.input<typeof queueSchema>

/**
 * A job inside the caller's transaction — for a module queueing work for its
 * own record (Story's "Generate" and "Download scene"). The caller has
 * checked its target; this checks the provider, the operation and the
 * inputs, and opens the worker's task.
 */
export async function insertJob(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  input: z.output<typeof queueSchema>,
): Promise<AssetJobRow> {
  if (project) assertModuleOn(project, 'assets')
  const generates = input.provider !== 'local_worker'
  if (generates && input.operation !== 'generate')
    throw invalid(
      'Only the local worker does production steps; others generate.',
    )
  if (input.provider === 'local_worker' && input.operation === 'generate')
    throw invalid(
      'The local worker doesn’t generate media yet; generate by hand (manual), with an agent or with a generator.',
    )
  let recipe: Record<string, unknown> = input.input ?? {}
  if (isAgentProvider(input.provider) || isExternalProvider(input.provider)) {
    const parsed = GENERATE_INPUT.safeParse(recipe)
    if (!parsed.success)
      throw invalid(parsed.error.issues[0]?.message ?? 'Say what to generate.')
    recipe = parsed.data
  }
  if (isExternalProvider(input.provider)) {
    if (!input.connectionId)
      throw invalid('Choose which generator to use.', {
        connectionId: 'Required for a generator.',
      })
    recipe = { ...recipe, connectionId: input.connectionId }
  }
  const schema = WORKER_INPUTS[input.operation]
  if (input.provider === 'local_worker' && schema) {
    const parsed = schema.safeParse(recipe)
    if (!parsed.success)
      throw invalid(
        parsed.error.issues[0]?.message ?? 'The job’s inputs don’t fit.',
      )
    recipe = parsed.data
    const ids = [
      ...((recipe.assetIds as string[] | undefined) ?? []),
      ...(recipe.assetId ? [recipe.assetId as string] : []),
    ]
    if (ids.length) {
      const found = await tx
        .select({
          id: assetAssets.id,
          status: assetAssets.status,
          projectId: assetAssets.projectId,
        })
        .from(assetAssets)
        .where(
          and(
            eq(assetAssets.ownerId, actor.userId),
            inArray(assetAssets.id, ids),
          ),
        )
      if (found.length !== new Set(ids).size) throw notFound('Asset')
      if (found.some((row) => row.status !== 'ready'))
        throw invalid('Every input file must be ready.')
    }
  }
  const [row] = await tx
    .insert(assetGenerationJobs)
    .values({
      ownerId: actor.userId,
      createdBy: actor.userId,
      projectId: project?.id ?? null,
      provider: input.provider,
      operation: input.operation,
      title: input.title as string,
      input: recipe,
      targetType: input.target?.type ?? null,
      targetId: input.target?.id ?? null,
      targetRole: input.target?.role ?? null,
      variantId: input.variantId ?? null,
      status: input.provider === 'manual' ? 'awaiting_upload' : 'queued',
      actorType: actor.type,
      actorId: actor.id,
    })
    .returning()
  let job = returned(row)
  if (input.provider === 'local_worker' || isAgentProvider(input.provider)) {
    const { task } = await openTask(tx, actor, project, {
      kind: 'generation',
      module: 'assets',
      title: input.title as string,
      payload: {
        job_id: job.id,
        operation: job.operation,
        provider: job.provider,
      },
      targetType: 'asset_job',
      targetId: job.id,
      claimant: input.provider === 'local_worker' ? 'worker' : 'agent',
      maxAttempts: 3,
    })
    job = returned(
      (
        await tx
          .update(assetGenerationJobs)
          .set({ taskId: task.id })
          .where(eq(assetGenerationJobs.id, job.id))
          .returning()
      )[0],
    )
  }
  await audit(tx, actor, {
    projectId: job.projectId,
    action: 'asset.job.queue',
    targetType: 'asset_job',
    targetId: job.id,
    changes: {
      provider: job.provider,
      operation: job.operation,
      target: job.targetId ? { type: job.targetType, id: job.targetId } : null,
    },
  })
  return job
}

/** What a generation job needs: the prompt itself (IDs are provenance). */
const GENERATE_INPUT = z
  .object({
    medium: z.enum(['image', 'video'], { error: 'Still or motion?' }),
    prompt: z
      .string({ error: 'Say what to generate (the prompt).' })
      .trim()
      .min(1, 'Say what to generate (the prompt).')
      .max(20000),
    negativePrompt: z.string().trim().max(4000).optional(),
    size: z
      .string()
      .trim()
      .regex(/^\d{2,5}x\d{2,5}$/, 'A size like 1024x1024.')
      .optional(),
    count: z.number().int().min(1).max(4).optional(),
    seconds: z.number().int().min(1).max(60).optional(),
  })
  .loose()

/**
 * Queue a job. A manual job is drafting; a worker, agent or generator job
 * spends, so an agent needs its policy to allow generating.
 */
export async function queueJob(
  actor: Actor,
  raw: QueueJobInput,
): Promise<JobView> {
  const input = parseInput(queueSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'assets_queue_job',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const requirement =
          input.provider === 'manual'
            ? ('draft' as const)
            : ('generate' as const)
        const project = input.projectId
          ? await ownedProject(
              tx,
              actor,
              input.projectId,
              'assets',
              'write',
              requirement,
            )
          : null
        if (!project)
          await authorize(tx, actor, null, 'assets', 'write', requirement)
        return insertJob(tx, actor, project, input)
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.job_id
    if (typeof id !== 'string') throw conflict()
    return getJob(actor, id)
  }
  await outcome.complete({ job_id: outcome.value.id })
  return getJob(actor, outcome.value.id)
}

export async function getJob(actor: Actor, jobId: string): Promise<JobView> {
  return withReader(async (db) => {
    assertCan(actor, 'assets', 'read')
    const { row, project } = await ownedRow<AssetJobRow>(
      db,
      actor,
      assetGenerationJobs,
      jobId,
      'Job',
    )
    await authorize(db, actor, project, 'assets', 'read')
    return returned((await views(db, actor.userId, [row]))[0])
  })
}

/** Jobs for some records (a scene's shots), or a project's newest. */
export async function listJobs(
  actor: Actor,
  raw: {
    projectId?: string
    targetType?: string
    targetIds?: string[]
    limit?: number
  },
): Promise<JobView[]> {
  const input = parseInput(
    z.object({
      projectId: optionalRecordId('Project'),
      targetType: z.enum(REF_TYPES).optional(),
      targetIds: z.array(z.uuid()).max(500).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    raw,
  )
  return withReader(async (db) => {
    if (input.projectId)
      await ownedProject(db, actor, input.projectId, 'assets', 'read')
    else await authorize(db, actor, null, 'assets', 'read')
    const rows = await db
      .select()
      .from(assetGenerationJobs)
      .where(
        and(
          eq(assetGenerationJobs.ownerId, actor.userId),
          input.projectId
            ? eq(assetGenerationJobs.projectId, input.projectId)
            : undefined,
          input.targetType
            ? eq(assetGenerationJobs.targetType, input.targetType)
            : undefined,
          input.targetIds?.length
            ? inArray(assetGenerationJobs.targetId, input.targetIds)
            : undefined,
        ),
      )
      .orderBy(desc(assetGenerationJobs.createdAt))
      .limit(input.limit ?? 100)
    return views(db, actor.userId, rows)
  })
}

async function readyResults(
  tx: Tx,
  actor: Actor,
  job: AssetJobRow,
  assetIds: string[],
): Promise<AssetRow[]> {
  const unique = [...new Set(assetIds)]
  const rows = await tx
    .select()
    .from(assetAssets)
    .where(
      and(
        eq(assetAssets.ownerId, actor.userId),
        inArray(assetAssets.id, unique),
      ),
    )
  if (rows.length !== unique.length) throw notFound('Asset')
  for (const asset of rows) {
    if (asset.status !== 'ready')
      throw invalid(
        `${asset.title ?? asset.name} isn’t ready — finalize its upload first.`,
      )
    if (asset.projectId !== job.projectId)
      throw invalid(`${asset.title ?? asset.name} belongs to another project.`)
  }
  return rows
}

/** Marks a job done with its files — for ./generate.ts and the paths here. */
export async function finishJob(
  tx: Tx,
  actor: Actor,
  job: AssetJobRow,
  results: AssetRow[],
): Promise<AssetJobRow> {
  const [row] = await tx
    .update(assetGenerationJobs)
    .set({
      status: 'succeeded',
      resultAssetIds: results.map((asset) => asset.id),
      error: null,
      finishedAt: sql`now()`,
      revision: sql`${assetGenerationJobs.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(assetGenerationJobs.id, job.id),
        eq(assetGenerationJobs.revision, job.revision),
      ),
    )
    .returning()
  const done = returned(row)
  if (done.targetType && done.targetId && done.targetRole) {
    for (const asset of results)
      await link(
        tx,
        actor,
        { type: 'asset', id: asset.id },
        { type: done.targetType, id: done.targetId },
        done.targetRole,
      )
    await succeededHooks.get(done.targetType)?.(tx, actor, done, results)
  }
  await audit(tx, actor, {
    projectId: done.projectId,
    action: 'asset.job.succeed',
    targetType: 'asset_job',
    targetId: done.id,
    beforeRevision: job.revision,
    afterRevision: done.revision,
    changes: { results: results.map((asset) => asset.name) },
  })
  return done
}

/**
 * A manual job's result inside the caller's transaction — for a module that
 * changes its own record in the same commit (a shot becomes `generated`).
 */
export async function completeManualJob(
  tx: Tx,
  actor: Actor,
  jobId: string,
  assetId: string,
): Promise<AssetJobRow> {
  assertCan(actor, 'assets', 'write')
  const { row: job, project } = await ownedRow<AssetJobRow>(
    tx,
    actor,
    assetGenerationJobs,
    jobId,
    'Job',
    { lock: true },
  )
  await authorize(tx, actor, project, 'assets', 'write')
  if (job.provider !== 'manual' || job.status !== 'awaiting_upload')
    throw invalid(
      job.status === 'succeeded'
        ? 'This job already has its result.'
        : 'Only a manual job waiting for its upload takes a file.',
    )
  const results = await readyResults(tx, actor, job, [assetId])
  return finishJob(tx, actor, job, results)
}

/**
 * A manual job's result: a ready file the owner (or an agent drafting)
 * uploaded. The job is done and the file links to what it is for.
 */
export async function attachResult(
  actor: Actor,
  raw: { jobId: string; assetId: string },
): Promise<JobView> {
  const input = parseInput(
    z.object({ jobId: recordId('Job'), assetId: recordId('Asset') }),
    raw,
  )
  await withTransaction((tx) =>
    completeManualJob(tx, actor, input.jobId, input.assetId),
  )
  return getJob(actor, input.jobId)
}

const recordSchema = z.object({
  jobId: recordId('Job'),
  fencingToken: z.coerce.number().int().min(1),
  /** The files it made, already finalized. Empty with `error` is a failure. */
  assetIds: z.array(z.uuid()).max(50).optional(),
  error: text.optional('Error', 2000),
})

/**
 * A worker's (or agent's) result for a job it holds: the files it made, or
 * why it couldn't. Refused with `lease_lost` unless the caller holds the
 * job's task with this fencing token right now. It doesn't end the task —
 * the caller finishes its run with `agents_finish`.
 */
export async function recordJobResult(
  actor: Actor,
  raw: z.input<typeof recordSchema>,
): Promise<JobView> {
  const input = parseInput(recordSchema, raw)
  if (!input.assetIds?.length && !input.error)
    throw invalid('Name the files it made, or say why it couldn’t.')
  await withTransaction(async (tx) => {
    assertCan(actor, 'assets', 'write')
    const { row: job, project } = await ownedRow<AssetJobRow>(
      tx,
      actor,
      assetGenerationJobs,
      input.jobId,
      'Job',
      { lock: true },
    )
    await authorize(tx, actor, project, 'assets', 'write')
    if (!job.taskId)
      throw invalid('This job isn’t a worker’s; attach its file instead.')
    await assertTaskFencing(tx, actor, {
      taskId: job.taskId,
      fencingToken: input.fencingToken,
    })
    if (job.status !== 'queued' && job.status !== 'running')
      throw invalid(`This job is already ${job.status}.`)
    if (input.assetIds?.length) {
      const results = await readyResults(tx, actor, job, input.assetIds)
      await finishJob(tx, actor, job, results)
      return
    }
    const [row] = await tx
      .update(assetGenerationJobs)
      .set({
        status: 'failed',
        error: input.error ?? 'failed',
        finishedAt: sql`now()`,
        revision: sql`${assetGenerationJobs.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(assetGenerationJobs.id, job.id))
      .returning()
    await audit(tx, actor, {
      projectId: job.projectId,
      action: 'asset.job.fail',
      targetType: 'asset_job',
      targetId: job.id,
      beforeRevision: job.revision,
      afterRevision: returned(row).revision,
      reason: input.error ?? null,
    })
  })
  return getJob(actor, input.jobId)
}

/** Stop a job that hasn't finished. Its worker task is cancelled with it. The owner's. */
export async function cancelJob(
  actor: Actor,
  raw: { jobId: string },
): Promise<JobView> {
  const input = parseInput(z.object({ jobId: recordId('Job') }), raw)
  await withTransaction(async (tx) => {
    assertCan(actor, 'assets', 'write')
    const { row: job, project } = await ownedRow<AssetJobRow>(
      tx,
      actor,
      assetGenerationJobs,
      input.jobId,
      'Job',
      { lock: true },
    )
    await authorize(tx, actor, project, 'assets', 'write', 'owner_only')
    if (!['queued', 'running', 'awaiting_upload'].includes(job.status))
      throw invalid(`This job is already ${job.status}.`)
    await tx
      .update(assetGenerationJobs)
      .set({
        status: 'cancelled',
        finishedAt: sql`now()`,
        revision: sql`${assetGenerationJobs.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(assetGenerationJobs.id, job.id))
    if (job.taskId)
      await tx
        .update(opsTasks)
        .set({
          status: 'cancelled',
          lastError: 'Its job was cancelled.',
          leaseActorType: null,
          leaseActorId: null,
          leaseExpiresAt: null,
          revision: sql`${opsTasks.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(opsTasks.id, job.taskId),
            inArray(opsTasks.status, ['open', 'claimed', 'blocked']),
          ),
        )
    await audit(tx, actor, {
      projectId: job.projectId,
      action: 'asset.job.cancel',
      targetType: 'asset_job',
      targetId: job.id,
      beforeRevision: job.revision,
    })
  })
  return getJob(actor, input.jobId)
}

/**
 * The ops tick: a worker job whose task failed or was cancelled (attempts
 * spent, a lease lost for good) fails with the task's reason, so nothing
 * waits forever on a worker that won't come.
 */
export async function settleOrphanJobs(limit = 50): Promise<number> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .select({ job: assetGenerationJobs, task: opsTasks })
      .from(assetGenerationJobs)
      .innerJoin(opsTasks, eq(opsTasks.id, assetGenerationJobs.taskId))
      .where(
        and(
          inArray(assetGenerationJobs.status, ['queued', 'running']),
          inArray(opsTasks.status, ['failed', 'cancelled']),
        ),
      )
      .limit(limit)
      .for('update', { of: assetGenerationJobs, skipLocked: true })
    for (const { job, task } of rows) {
      await tx
        .update(assetGenerationJobs)
        .set({
          status: task.status === 'cancelled' ? 'cancelled' : 'failed',
          error: task.lastError ?? 'The worker task gave up.',
          finishedAt: sql`now()`,
          revision: sql`${assetGenerationJobs.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(assetGenerationJobs.id, job.id))
      await audit(tx, schedulerActor(job.ownerId), {
        projectId: job.projectId,
        action: 'asset.job.orphan',
        targetType: 'asset_job',
        targetId: job.id,
        reason: task.lastError,
      })
    }
    return rows.length
  })
}

/** For a module's page: the newest job per target. */
export function newestByTarget(jobs: JobView[]): Map<string, JobView> {
  const out = new Map<string, JobView>()
  for (const job of jobs)
    if (job.targetId && !out.has(job.targetId)) out.set(job.targetId, job)
  return out
}
