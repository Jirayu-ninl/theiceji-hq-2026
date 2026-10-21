import {
  type AssetListItem,
  assetAccess,
  finalizeUpload,
  listAssets,
  prepareUpload,
} from '@theiceji/hq-assets/assets'
import { queueGeneration } from '@theiceji/hq-assets/generate'
import { getJob, type JobView, recordJobResult } from '@theiceji/hq-assets/jobs'
import '@theiceji/hq-assets/register'
import {
  ASSET_KINDS,
  ASSET_ORIGINS,
  ASSET_STATUSES,
} from '@theiceji/hq-db/enums'
import type { AssetRow } from '@theiceji/hq-db/schema'
import { z } from 'zod'
import { defineTool, defineWorkspace } from '../../kernel'
import {
  idArg,
  idempotencyKeyArg,
  projectIdArg,
  READ,
  readTool,
  WRITE,
  writeTool,
} from '../support'

/**
 * `assets` — every file HQ keeps, in R2 or the owner's Google Drive.
 * Upload is three steps: `assets_prepare_upload` answers where to
 * PUT the bytes; you send them there yourself; `assets_finalize` confirms
 * them and makes the asset ready (frozen from then on). Deleting a file is
 * the owner's, in HQ. Jobs: the local worker reads one (`assets_get_job`),
 * uploads against it (`job_id` on prepare) and records its files
 * (`assets_record_generated`) under its task's fencing token. Queueing a
 * generation (`assets_queue_generation`): by hand, for an agent to make
 * (`agent:<service>`), or with one of the owner's generators — HQ calls it
 * and the image comes back with the job.
 */

function assetOut(asset: AssetRow | AssetListItem) {
  return {
    id: asset.id,
    project_id: asset.projectId,
    name: asset.name,
    /** The owner's name for it in HQ, or null (then `name`, the file name, is what HQ shows). */
    title: asset.title,
    path: asset.path,
    kind: asset.kind,
    mime: asset.mime,
    bytes: asset.bytes,
    sha256: asset.sha256,
    width: asset.width,
    height: asset.height,
    duration_ms: asset.durationMs,
    origin: asset.origin,
    status: asset.status,
    problem: asset.problem,
    tags: asset.tags,
    storage: asset.storageProvider,
    ...('collectionIds' in asset
      ? { collection_ids: asset.collectionIds }
      : {}),
    revision: asset.revision,
    created_at: asset.createdAt,
    ready_at: asset.readyAt,
  }
}

export const listAssetsTool = defineTool({
  name: 'list',
  title: 'List assets',
  description:
    'Files newest first: one project’s, the floating ones (project_id null), or all. Filter by kind, origin, status (rejected ones only when asked), collection, tag or words in the name.',
  scope: 'assets:read',
  input: z.object({
    project_id: projectIdArg.nullable().optional(),
    kind: z.enum(ASSET_KINDS).optional(),
    origin: z.enum(ASSET_ORIGINS).optional(),
    status: z.enum(ASSET_STATUSES).optional(),
    collection_id: idArg('Collection').optional(),
    tag: z.string().max(32).optional(),
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      (actor) =>
        listAssets(actor, {
          projectId: args.project_id,
          kind: args.kind,
          origin: args.origin,
          status: args.status,
          collectionId: args.collection_id,
          tag: args.tag,
          query: args.query,
          limit: args.limit,
        }),
      ({ assets, total }) => ({
        text: `${assets.length} of ${total} asset(s).`,
        data: { total, assets: assets.map(assetOut) },
      }),
    ),
})

export const getAccessTool = defineTool({
  name: 'get_access',
  title: 'Get a link to an asset',
  description:
    'A short-lived URL to read a ready asset’s bytes (60 s – 24 h, default 15 min). With download, the browser saves it under its name.',
  scope: 'assets:read',
  input: z.object({
    asset_id: idArg('Asset'),
    ttl_seconds: z.number().int().min(60).max(86400).optional(),
    download: z.boolean().optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      (actor) =>
        assetAccess(actor, {
          assetId: args.asset_id,
          ttlSeconds: args.ttl_seconds,
          download: args.download,
        }),
      ({ url, expiresAt, asset }) => ({
        text: `Link to “${asset.name}” until ${expiresAt.toISOString()}.`,
        data: { url, expires_at: expiresAt, asset: assetOut(asset) },
      }),
    ),
})

export const prepareUploadTool = defineTool({
  name: 'prepare_upload',
  title: 'Prepare an upload',
  description:
    'Step 1 of 3: a pending asset in the project’s storage, and where to send its bytes. mode presigned_put → PUT the bytes to url with exactly the given headers; mode resumable → PUT them to session_url. Then call assets_finalize. Needs your operating policy to allow drafting.',
  scope: 'assets:write',
  input: z.object({
    project_id: projectIdArg.nullable().optional(),
    name: z.string().min(1).max(240),
    mime: z
      .string()
      .min(3)
      .max(200)
      .describe('e.g. image/png, video/mp4, application/pdf'),
    bytes: z.number().int().min(0),
    collection_id: idArg('Collection').optional(),
    tags: z.array(z.string().max(32)).max(24).optional(),
    job_id: idArg('Job')
      .optional()
      .describe('The job this file is the result of — stored as generated.'),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: { ...WRITE, openWorldHint: true },
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        prepareUpload(actor, {
          projectId: args.project_id,
          name: args.name,
          mime: args.mime,
          bytes: args.bytes,
          collectionId: args.collection_id,
          tags: args.tags,
          jobId: args.job_id,
          idempotencyKey: args.idempotency_key,
        }),
      ({ asset, upload }) => ({
        text: `Send the ${asset.bytes} bytes of “${asset.name}”, then call assets_finalize with asset_id ${asset.id}.`,
        data: {
          target: { type: 'asset', id: asset.id, revision: asset.revision },
          asset: assetOut(asset),
          upload:
            upload.mode === 'presigned_put'
              ? {
                  mode: upload.mode,
                  url: upload.url,
                  headers: upload.headers,
                  expires_at: upload.expiresAt,
                }
              : upload.mode === 'resumable'
                ? {
                    mode: upload.mode,
                    session_url: upload.sessionUrl,
                    expires_at: upload.expiresAt,
                  }
                : { mode: upload.mode },
        },
      }),
    ),
})

export const finalizeTool = defineTool({
  name: 'finalize',
  title: 'Finalize an upload',
  description:
    'Step 3 of 3: confirm the bytes arrived, record size, type and SHA-256, and make the asset ready. Width, height and duration are what you measured, used when storage can’t say. Finalizing a ready asset returns it unchanged.',
  scope: 'assets:write',
  input: z.object({
    asset_id: idArg('Asset'),
    width: z.number().int().min(1).optional(),
    height: z.number().int().min(1).optional(),
    duration_ms: z.number().int().min(0).optional(),
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        finalizeUpload(actor, {
          assetId: args.asset_id,
          width: args.width,
          height: args.height,
          durationMs: args.duration_ms,
        }),
      (asset) => ({
        text: `“${asset.name}” is ${asset.status} (${asset.bytes} bytes${asset.sha256 ? `, sha256 ${asset.sha256.slice(0, 12)}…` : ''}).`,
        data: {
          target: { type: 'asset', id: asset.id, revision: asset.revision },
          asset: assetOut(asset),
        },
      }),
    ),
})

function jobOut(job: JobView) {
  return {
    id: job.id,
    project_id: job.projectId,
    provider: job.provider,
    operation: job.operation,
    title: job.title,
    input: job.input,
    target: job.targetId
      ? { type: job.targetType, id: job.targetId, role: job.targetRole }
      : null,
    variant_id: job.variantId,
    task_id: job.taskId,
    state: job.state,
    results: job.results.map((asset) => ({
      id: asset.id,
      name: asset.name,
      title: asset.title,
      kind: asset.kind,
      status: asset.status,
    })),
    error: job.error,
    revision: job.revision,
  }
}

export const getJobTool = defineTool({
  name: 'get_job',
  title: 'Get a job',
  description:
    'One generation or production job: its provider, operation, inputs (IDs and parameters — a zip lists asset_ids and a name), what its result is for, its state and the files it made.',
  scope: 'assets:read',
  input: z.object({ job_id: idArg('Job') }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      (actor) => getJob(actor, args.job_id),
      (job) => ({
        text: `“${job.title}” is ${job.state}.`,
        data: { job: jobOut(job) },
      }),
    ),
})

export const recordGeneratedTool = defineTool({
  name: 'record_generated',
  title: 'Record a job’s files',
  description:
    'The files a job you hold made (each prepared with job_id and finalized), or why it couldn’t — under the fencing token of its task’s claim. lease_lost means another worker has it now: stop. Then finish your run with agents_finish.',
  scope: 'assets:write',
  input: z.object({
    job_id: idArg('Job'),
    fencing_token: z.number().int().min(1),
    asset_ids: z.array(idArg('Asset')).max(50).optional(),
    error: z.string().max(2000).optional(),
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        recordJobResult(actor, {
          jobId: args.job_id,
          fencingToken: args.fencing_token,
          assetIds: args.asset_ids,
          error: args.error,
        }),
      (job) => ({
        text: `“${job.title}” is ${job.state}${job.results.length ? ` with ${job.results.length} file(s)` : ''}.`,
        data: { job: jobOut(job) },
      }),
    ),
})

export const queueGenerationTool = defineTool({
  name: 'queue_generation',
  title: 'Queue a generation',
  description:
    'Make an image or a video from a prompt. provider: `manual` (the owner makes it and attaches it), `agent:<service>` (an agent — maybe you — claims the job with agents_claim_task kinds ["generation"], generates with its own tools, uploads with job_id and records with assets_record_generated), or `external:openai_compatible` with connection_id (one of the owner’s generators — HQ calls it now; an image comes back with the job, a video is collected later). A generator’s price is held against the owner’s budget first (budget_exceeded if not). target links the result to what it is for, e.g. { type: "shot", id, role: "result_of" }.',
  scope: 'assets:operate',
  input: z.object({
    project_id: projectIdArg.optional(),
    provider: z
      .string()
      .regex(
        /^(manual|agent:[a-z0-9_.-]{1,60}|external:openai_compatible)$/,
        'manual, agent:<service> or external:openai_compatible',
      ),
    connection_id: idArg('Generator').optional(),
    title: z.string().min(1).max(200),
    medium: z.enum(['image', 'video']),
    prompt: z.string().min(1).max(20000),
    negative_prompt: z.string().max(4000).optional(),
    size: z.string().max(20).optional(),
    count: z.number().int().min(1).max(4).optional(),
    seconds: z.number().int().min(1).max(60).optional(),
    variant_id: idArg('Prompt variant').optional(),
    target: z
      .object({
        type: z.string().min(1).max(40),
        id: idArg('Target'),
        role: z.string().min(1).max(40),
      })
      .optional(),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: { ...WRITE, idempotentHint: true, openWorldHint: true },
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        queueGeneration(actor, {
          projectId: args.project_id ?? null,
          provider: args.provider,
          connectionId: args.connection_id ?? null,
          operation: 'generate',
          title: args.title,
          input: {
            medium: args.medium,
            prompt: args.prompt,
            ...(args.negative_prompt
              ? { negativePrompt: args.negative_prompt }
              : {}),
            ...(args.size ? { size: args.size } : {}),
            ...(args.count ? { count: args.count } : {}),
            ...(args.seconds ? { seconds: args.seconds } : {}),
            ...(args.variant_id ? { variantId: args.variant_id } : {}),
          },
          target: args.target as never,
          variantId: args.variant_id ?? null,
          idempotencyKey: args.idempotency_key,
        }),
      (job) => ({
        text: `“${job.title}” is ${job.state}${job.results.length ? ` with ${job.results.length} file(s)` : ''}.`,
        data: { job: jobOut(job) },
      }),
    ),
})

export const assets = defineWorkspace({
  id: 'assets',
  label: 'Assets',
  description:
    'Every file HQ keeps — in R2 or the owner’s Google Drive — with collections and tags.',
  instructions:
    'Upload in three steps: assets_prepare_upload, send the bytes yourself, assets_finalize. A ready asset is frozen; only the owner deletes one.',
  tools: [
    listAssetsTool,
    getAccessTool,
    prepareUploadTool,
    finalizeTool,
    getJobTool,
    queueGenerationTool,
    recordGeneratedTool,
  ],
})
