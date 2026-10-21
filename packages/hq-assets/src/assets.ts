import { createHash } from 'node:crypto'
import { storageTarget } from '@theiceji/hq-core/settings'
import {
  ASSET_COLLECTION_KINDS,
  ASSET_KINDS,
  ASSET_ORIGINS,
  ASSET_STATUSES,
  type AssetKind,
  type AssetOrigin,
  type StorageProviderId,
} from '@theiceji/hq-db/enums'
import {
  type AssetCollectionRow,
  type AssetRow,
  assetAssets,
  assetCollectionItems,
  assetCollections,
  assetGenerationJobs,
  type ProjectRow,
  projects,
  refs,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan } from '@theiceji/hq-ops/access'
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
  optionalChoice,
  parseInput,
  recordId,
  revision,
  stringList,
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
import {
  isSafeKey,
  ownerPrefix,
  type PreparedUpload,
  type StorageProvider,
} from '@theiceji/hq-storage'
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { providerFor, storageFailure } from './storage'

/**
 * Assets: every file HQ keeps, wherever its bytes are.
 *
 * **Upload is three steps**, so bytes never pass through HQ's server:
 * `prepareUpload` writes a `pending` row and asks the project's storage for
 * a place to put the bytes (an R2 presigned PUT, or a Drive resumable
 * session); the browser — or an agent — sends them there; `finalizeUpload`
 * confirms they arrived, records size, type and hash, and makes the asset
 * `ready`. From then on its identity is frozen by a trigger.
 *
 * **Server-made files** (a quote's PDF) go through `storeGenerated` (the
 * upload, outside any transaction) and `insertStoredAsset` (the row, inside
 * the caller's), so a failed transaction leaves at most an orphan object,
 * never a row pointing at nothing.
 *
 * **Who does what.** Reading and links: `assets:read`. Uploading, tagging,
 * collections, rejecting a pending upload: `assets:write` (an agent also
 * needs the owner's policy to allow drafting). Deleting — a ready asset
 * above all — is the owner's alone.
 */

registerConstraintMessages({
  asset_assets_storage_key: 'That file is already in HQ.',
  asset_collections_name_key:
    'A collection with that name already exists here.',
  quote_quotes_pdf_fk: 'This file is a sent quote’s PDF, so it stays.',
  prompt_examples_asset_key:
    'That asset is already an example of this variant.',
})

/** Uploads bigger than this are refused before any bytes move. */
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3
/** Files bigger than this are stored without a hash, and say so. */
export const MAX_HASH_BYTES = 200 * 1024 ** 2

const DOC_MIMES = [
  'application/pdf',
  'application/msword',
  'application/rtf',
  'application/vnd.openxmlformats-officedocument',
  'application/vnd.ms-',
  'application/vnd.oasis.opendocument',
  'text/',
  'application/json',
]

/** What kind of file a MIME type (or, failing that, a name) is. */
export function kindOf(mime: string, name = ''): AssetKind {
  const type = mime.toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (DOC_MIMES.some((prefix) => type.startsWith(prefix))) return 'doc'
  if (/\.(pdf|docx?|txt|md|rtf|odt|pages|key|pptx?|xlsx?|csv)$/i.test(name))
    return 'doc'
  return 'other'
}

/** A file name safe for every provider: no path, no control characters, at most 200 characters. */
export function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const clean = base
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  const safe = clean === '.' || clean === '..' ? '' : clean
  return (safe || 'file').slice(0, 200)
}

/** A folder segment from a collection name. */
const segment = (value: string) =>
  value
    .replace(/[\\/]/g, '-')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, 80) || 'uploads'

export function assetPath(
  project: Pick<ProjectRow, 'slug'> | null,
  collection: string | null,
  name: string,
  root: string | null = null,
): string {
  return [
    root?.replace(/^\/+|\/+$/g, ''),
    project?.slug ?? '_hq',
    segment(collection ?? 'uploads'),
    name,
  ]
    .filter(Boolean)
    .join('/')
}

/** Where an R2 video's still goes, named for its asset. */
export const thumbnailPath = (assetId: string) => `thumbs/${assetId}.jpg`

/**
 * A still's key comes back from the browser, so it is taken only when R2
 * minted it for this owner and this asset:
 * `<ownerId>/thumbs/yyyy/mm/<16 hex>-<assetId>.jpg`.
 */
export function isThumbnailKey(
  ownerId: string,
  assetId: string,
  key: string,
): boolean {
  return (
    isSafeKey(key) &&
    key.startsWith(`${ownerPrefix(ownerId)}thumbs/`) &&
    key.endsWith(`-${assetId}.jpg`)
  )
}

const normalizeTags = (raw: readonly string[]) => {
  const out: string[] = []
  for (const entry of raw) {
    const tag = entry.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 32)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out.slice(0, 24)
}

async function withStorage<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw storageFailure(error)
  }
}

/** A provider for this asset's own storage (never the project's current default). */
export async function providerOf(
  reader: Reader,
  asset: Pick<AssetRow, 'ownerId' | 'storageProvider'>,
  project?: Pick<ProjectRow, 'storageProvider' | 'storageRoot'> | null,
): Promise<StorageProvider> {
  return providerFor(reader, asset.ownerId, asset.storageProvider, {
    driveFolderId:
      asset.storageProvider === 'gdrive' &&
      project?.storageProvider === 'gdrive'
        ? project.storageRoot
        : null,
  })
}

/* ── Reading ────────────────────────────────────────────────────────── */

export type AssetListItem = AssetRow & {
  collectionIds: string[]
  project: Pick<ProjectRow, 'id' | 'slug' | 'name' | 'color' | 'status'> | null
}

const listSchema = z.object({
  projectId: z.uuid().nullable().optional(),
  kind: optionalChoice(ASSET_KINDS, 'Choose a kind.'),
  origin: optionalChoice(ASSET_ORIGINS, 'Choose an origin.'),
  status: optionalChoice(ASSET_STATUSES, 'Choose a status.'),
  collectionId: z.uuid().optional(),
  tag: z.string().trim().toLowerCase().max(32).optional(),
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

export type ListAssetsInput = z.input<typeof listSchema>

/**
 * Assets newest first — one project's (`projectId`), the owner's floating
 * ones (`projectId: null`), or everything the owner has in projects with
 * Assets on. Rejected files show only when asked for by status.
 */
export async function listAssets(
  actor: Actor,
  raw: ListAssetsInput = {},
): Promise<{ assets: AssetListItem[]; total: number }> {
  const input = parseInput(listSchema, raw)
  return withReader(async (db) => {
    if (input.projectId) {
      const project = await ownedProject(
        db,
        actor,
        input.projectId,
        'assets',
        'read',
      )
      assertModuleOn(project, 'assets')
    } else {
      await authorize(db, actor, null, 'assets', 'read')
    }
    const words = (input.query ?? '').split(/\s+/).filter(Boolean)
    const where = and(
      eq(assetAssets.ownerId, actor.userId),
      input.projectId === null
        ? isNull(assetAssets.projectId)
        : input.projectId
          ? eq(assetAssets.projectId, input.projectId)
          : sql`(${assetAssets.projectId} is null or (${projects.status} <> 'archived' and ${projects.modules} -> 'enabled' ? 'assets'))`,
      input.kind ? eq(assetAssets.kind, input.kind) : undefined,
      input.origin ? eq(assetAssets.origin, input.origin) : undefined,
      input.status
        ? eq(assetAssets.status, input.status)
        : sql`${assetAssets.status} <> 'rejected'`,
      input.tag ? sql`${input.tag} = any(${assetAssets.tags})` : undefined,
      input.collectionId
        ? sql`exists (select 1 from ${assetCollectionItems} where ${assetCollectionItems.assetId} = ${assetAssets.id} and ${assetCollectionItems.collectionId} = ${input.collectionId})`
        : undefined,
      ...words.map((word) => {
        const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        return or(
          ilike(assetAssets.name, like),
          ilike(assetAssets.title, like),
          ilike(assetAssets.path, like),
          sql`array_to_string(${assetAssets.tags}, ' ') ilike ${like}`,
        )
      }),
    )
    const [rows, [total]] = await Promise.all([
      db
        .select({
          asset: assetAssets,
          project: {
            id: projects.id,
            slug: projects.slug,
            name: projects.name,
            color: projects.color,
            status: projects.status,
          },
        })
        .from(assetAssets)
        .leftJoin(projects, eq(projects.id, assetAssets.projectId))
        .where(where)
        .orderBy(desc(assetAssets.createdAt))
        .limit(input.limit ?? 200),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(assetAssets)
        .leftJoin(projects, eq(projects.id, assetAssets.projectId))
        .where(where),
    ])
    const ids = rows.map((row) => row.asset.id)
    const items = ids.length
      ? await db
          .select({
            assetId: assetCollectionItems.assetId,
            collectionId: assetCollectionItems.collectionId,
          })
          .from(assetCollectionItems)
          .where(inArray(assetCollectionItems.assetId, ids))
      : []
    return {
      assets: rows.map((row) => ({
        ...row.asset,
        collectionIds: items
          .filter((item) => item.assetId === row.asset.id)
          .map((item) => item.collectionId),
        project: row.project?.id ? row.project : null,
      })),
      total: total?.n ?? 0,
    }
  })
}

export type AssetDetail = {
  asset: AssetRow
  project: ProjectRow | null
  collections: AssetCollectionRow[]
  /** Links to and from other modules' records (a prompt example, a quote, a shot). */
  links: { type: string; id: string; role: string; direction: 'from' | 'to' }[]
}

export async function getAsset(
  actor: Actor,
  assetId: string,
): Promise<AssetDetail> {
  return withReader(async (db) => {
    const { row: asset, project } = await ownedRecord<AssetRow>(
      db,
      actor,
      assetAssets,
      assetId,
      'assets',
      'read',
      'Asset',
    )
    const [collections, edges] = await Promise.all([
      db
        .select({ collection: assetCollections })
        .from(assetCollectionItems)
        .innerJoin(
          assetCollections,
          eq(assetCollections.id, assetCollectionItems.collectionId),
        )
        .where(eq(assetCollectionItems.assetId, asset.id))
        .orderBy(asc(assetCollections.position), asc(assetCollections.name)),
      db
        .select()
        .from(refs)
        .where(
          and(
            eq(refs.ownerId, actor.userId),
            or(
              and(eq(refs.fromType, 'asset'), eq(refs.fromId, asset.id)),
              and(eq(refs.toType, 'asset'), eq(refs.toId, asset.id)),
            ),
          ),
        ),
    ])
    return {
      asset,
      project,
      collections: collections.map((row) => row.collection),
      links: edges.map((edge) =>
        edge.fromType === 'asset' && edge.fromId === asset.id
          ? {
              type: edge.toType,
              id: edge.toId,
              role: edge.role,
              direction: 'to' as const,
            }
          : {
              type: edge.fromType,
              id: edge.fromId,
              role: edge.role,
              direction: 'from' as const,
            },
      ),
    }
  })
}

/* ── Upload ─────────────────────────────────────────────────────────── */

const prepareSchema = z.object({
  projectId: z.uuid().nullable().optional(),
  name: text.required('File name', 240),
  mime: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\w.+-]+\/[\w.+-]+$/, 'That isn’t a file type HQ knows.'),
  bytes: z
    .number()
    .int()
    .min(0)
    .max(
      MAX_UPLOAD_BYTES,
      'Files up to 2 GB go through HQ; split or compress anything bigger.',
    ),
  collectionId: z.uuid().optional(),
  tags: stringList('tags', 24, 32).optional(),
  /** The browser origin that will send the bytes (Drive only answers that origin). */
  origin: z.string().url().max(200).optional(),
  /** A job this file is the result of: it is stored as `generated`. */
  jobId: z.uuid({ error: 'Job not found.' }).optional(),
  idempotencyKey: idempotencyKey.optional(),
})

export type PrepareUploadInput = z.input<typeof prepareSchema>

export type PreparedAssetUpload = {
  asset: AssetRow
  upload: PreparedUpload
}

/**
 * Step 1: a `pending` asset and a place to send its bytes — in the project's
 * storage (or the owner's default). The row exists before the bytes, so an
 * upload that never finishes is visible and can be rejected.
 */
export async function prepareUpload(
  actor: Actor,
  raw: PrepareUploadInput,
): Promise<PreparedAssetUpload> {
  const input = parseInput(prepareSchema, raw)
  const name = cleanName(input.name as string)
  const outcome = await runOperation(
    actor,
    {
      operation: 'assets_prepare_upload',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    async () => {
      // Checks and the storage session first; the row after, in one transaction.
      const scope = await withReader(async (db) => {
        const project = input.projectId
          ? await ownedProject(db, actor, input.projectId, 'assets', 'write')
          : null
        if (project) assertModuleOn(project, 'assets')
        else await authorize(db, actor, null, 'assets', 'write')
        const collection = input.collectionId
          ? (
              await ownedRecord<AssetCollectionRow>(
                db,
                actor,
                assetCollections,
                input.collectionId,
                'assets',
                'write',
                'Collection',
              )
            ).row
          : null
        if (collection && collection.projectId !== (project?.id ?? null))
          throw invalid('That collection belongs to another project.', {
            collectionId: 'Choose a collection of this project.',
          })
        if (input.jobId) {
          const [job] = await db
            .select({
              projectId: assetGenerationJobs.projectId,
              status: assetGenerationJobs.status,
            })
            .from(assetGenerationJobs)
            .where(
              and(
                eq(assetGenerationJobs.id, input.jobId),
                eq(assetGenerationJobs.ownerId, actor.userId),
              ),
            )
            .limit(1)
          if (!job) throw notFound('Job')
          if (job.projectId !== (project?.id ?? null))
            throw invalid('A job’s files go to the job’s project.')
          if (!['queued', 'running', 'awaiting_upload'].includes(job.status))
            throw invalid(`That job is already ${job.status}.`)
        }
        const target = await storageTarget(db, actor.userId, project)
        const provider = await providerFor(db, actor.userId, target.provider, {
          driveFolderId: target.provider === 'gdrive' ? target.root : null,
        })
        return { project, collection, target, provider }
      })
      const path = assetPath(
        scope.project,
        scope.collection?.name ?? null,
        name,
        scope.target.provider === 'r2' ? scope.target.root : null,
      )
      const upload = await withStorage(() =>
        scope.provider.prepareUpload({
          path,
          mime: input.mime,
          bytes: input.bytes,
          origin: input.origin,
        }),
      )
      if (upload.mode === 'proxy')
        throw invalid(
          'This storage needs an upload through HQ, which isn’t built yet.',
        )
      return withTransaction(async (tx) => {
        const [row] = await tx
          .insert(assetAssets)
          .values({
            ownerId: actor.userId,
            createdBy: actor.userId,
            projectId: scope.project?.id ?? null,
            storageProvider: scope.target.provider,
            storageKey: upload.key,
            path,
            name,
            kind: kindOf(input.mime, name),
            mime: input.mime,
            bytes: input.bytes,
            origin: input.jobId ? 'generated' : 'upload',
            status: 'pending',
            tags: normalizeTags(input.tags ?? []),
            actorType: actor.type,
            actorId: actor.id,
          })
          .returning()
        const asset = returned(row)
        if (scope.collection)
          await tx.insert(assetCollectionItems).values({
            ownerId: actor.userId,
            collectionId: scope.collection.id,
            assetId: asset.id,
          })
        await audit(tx, actor, {
          projectId: asset.projectId,
          action: 'asset.prepare_upload',
          targetType: 'asset',
          targetId: asset.id,
          afterRevision: asset.revision,
          changes: {
            name,
            mime: input.mime,
            bytes: input.bytes,
            provider: scope.target.provider,
          },
        })
        return { asset, upload }
      })
    },
  )
  if (outcome.kind === 'replay')
    throw conflict(
      'That upload was already prepared under this key, and its link can’t be issued twice. Read the asset with assets_list, or prepare a new upload with a new key.',
    )
  await outcome.complete({ asset_id: outcome.value.asset.id })
  return outcome.value
}

/** SHA-256 of an object by streaming it — never holding it all in memory. */
async function hashObject(
  provider: StorageProvider,
  key: string,
): Promise<string | null> {
  const response = await provider.get(key)
  if (!response?.body) return null
  const hash = createHash('sha256')
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    hash.update(value)
  }
  return hash.digest('hex')
}

const finalizeSchema = z.object({
  assetId: recordId('Asset'),
  /** What the browser measured, when the storage can't say. */
  width: z.number().int().min(1).max(100000).optional(),
  height: z.number().int().min(1).max(100000).optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
  idempotencyKey: idempotencyKey.optional(),
})

export type FinalizeUploadInput = z.input<typeof finalizeSchema>

/**
 * Step 3: the bytes are in storage — confirm it, record what they are, and
 * make the asset `ready`. Finalizing a ready asset again returns it as it is.
 */
export async function finalizeUpload(
  actor: Actor,
  raw: FinalizeUploadInput,
): Promise<AssetRow> {
  const input = parseInput(finalizeSchema, raw)
  const { asset, project } = await withReader(async (db) => {
    const found = await ownedRecord<AssetRow>(
      db,
      actor,
      assetAssets,
      input.assetId,
      'assets',
      'write',
      'Asset',
    )
    return { asset: found.row, project: found.project }
  })
  if (asset.status === 'ready') return asset
  if (asset.status === 'rejected')
    throw invalid('This upload was rejected. Upload the file again.')
  const provider = await withReader((db) => providerOf(db, asset, project))
  const info = await withStorage(() => provider.finalize(asset.storageKey))
  const bytes = info.size
  const key = info.key || asset.storageKey
  let sha256 = info.sha256 ?? null
  let sha256Note: string | null = null
  if (!sha256) {
    if (bytes <= MAX_HASH_BYTES)
      sha256 = await withStorage(() => hashObject(provider, key))
    else
      sha256Note = `Not hashed: larger than ${Math.round(MAX_HASH_BYTES / 1024 ** 2)} MB.`
  }
  return withTransaction(async (tx) => {
    const { row: current } = await ownedRow<AssetRow>(
      tx,
      actor,
      assetAssets,
      asset.id,
      'Asset',
      { lock: true },
    )
    if (current.status === 'ready') return current
    if (current.revision !== asset.revision) throw conflict()
    const patch: PgUpdateSetSource<typeof assetAssets> = {
      storageKey: key,
      bytes,
      mime: info.contentType || current.mime,
      sha256,
      sha256Note,
      width: info.width ?? input.width ?? null,
      height: info.height ?? input.height ?? null,
      durationMs: info.durationMs ?? input.durationMs ?? null,
      status: 'ready',
      readyAt: sql`now()`,
      checkedAt: sql`now()`,
      revision: sql`${assetAssets.revision} + 1`,
      updatedAt: sql`now()`,
    }
    const [row] = await tx
      .update(assetAssets)
      .set(patch)
      .where(
        and(
          eq(assetAssets.id, current.id),
          eq(assetAssets.revision, current.revision),
        ),
      )
      .returning()
    const ready = returned(row)
    await audit(tx, actor, {
      projectId: ready.projectId,
      action: 'asset.finalize',
      targetType: 'asset',
      targetId: ready.id,
      beforeRevision: current.revision,
      afterRevision: ready.revision,
      changes: { bytes, sha256, declaredBytes: current.bytes },
    })
    return ready
  })
}

/* ── Server-made files ──────────────────────────────────────────────── */

export type StoredObject = {
  provider: StorageProviderId
  key: string
  path: string
  name: string
  mime: string
  bytes: number
  sha256: string | null
}

/**
 * Put bytes HQ made itself (a quote PDF) into the project's storage. Call it
 * before the transaction that records them with `insertStoredAsset`.
 */
export async function storeGenerated(
  actor: Actor,
  project: ProjectRow | null,
  input: {
    name: string
    mime: string
    body: Uint8Array<ArrayBuffer>
    collection?: string | null
  },
): Promise<StoredObject> {
  assertCan(actor, 'assets', 'write')
  const name = cleanName(input.name)
  const { target, provider } = await withReader(async (db) => {
    const target = await storageTarget(db, actor.userId, project)
    const provider = await providerFor(db, actor.userId, target.provider, {
      driveFolderId: target.provider === 'gdrive' ? target.root : null,
    })
    return { target, provider }
  })
  const path = assetPath(
    project,
    input.collection ?? 'generated',
    name,
    target.provider === 'r2' ? target.root : null,
  )
  const info = await withStorage(() =>
    provider.put(null, input.body, { path, contentType: input.mime }),
  )
  return {
    provider: target.provider,
    key: info.key,
    path,
    name,
    mime: input.mime,
    bytes: info.size,
    sha256: info.sha256 ?? null,
  }
}

/**
 * The row for a stored object, `ready` at once, inside the caller's
 * transaction — filed in the project's collection called `collection`
 * (made on first use).
 */
export async function insertStoredAsset(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  stored: StoredObject,
  options: {
    origin?: AssetOrigin
    tags?: string[]
    collection?: string | null
  } = {},
): Promise<AssetRow> {
  const [row] = await tx
    .insert(assetAssets)
    .values({
      ownerId: actor.userId,
      createdBy: actor.userId,
      projectId: project?.id ?? null,
      storageProvider: stored.provider,
      storageKey: stored.key,
      path: stored.path,
      name: stored.name,
      kind: kindOf(stored.mime, stored.name),
      mime: stored.mime,
      bytes: stored.bytes,
      sha256: stored.sha256,
      origin: options.origin ?? 'generated',
      status: 'ready',
      readyAt: sql`now()`,
      checkedAt: sql`now()`,
      tags: normalizeTags(options.tags ?? []),
      actorType: actor.type,
      actorId: actor.id,
    })
    .returning()
  const asset = returned(row)
  if (options.collection) {
    const collection = await ensureCollection(
      tx,
      actor,
      project,
      options.collection,
      'generated',
    )
    await tx.insert(assetCollectionItems).values({
      ownerId: actor.userId,
      collectionId: collection.id,
      assetId: asset.id,
    })
  }
  await audit(tx, actor, {
    projectId: asset.projectId,
    action: 'asset.store',
    targetType: 'asset',
    targetId: asset.id,
    afterRevision: asset.revision,
    changes: {
      name: asset.name,
      mime: asset.mime,
      bytes: asset.bytes,
      origin: asset.origin,
    },
  })
  return asset
}

/* ── Changing an asset ──────────────────────────────────────────────── */

const tagsSchema = z.object({
  assetId: recordId('Asset'),
  expectedRevision: revision,
  tags: stringList('tags', 24, 32),
})

/** Tags change on any asset — they describe it, they aren't it. */
export async function setAssetTags(
  actor: Actor,
  raw: z.input<typeof tagsSchema>,
): Promise<AssetRow> {
  const input = parseInput(tagsSchema, raw)
  return withTransaction(async (tx) => {
    assertCan(actor, 'assets', 'write')
    const { row: asset, project } = await ownedRow<AssetRow>(
      tx,
      actor,
      assetAssets,
      input.assetId,
      'Asset',
      { lock: true },
    )
    await authorize(tx, actor, project, 'assets', 'write')
    if (asset.revision !== input.expectedRevision) throw conflict()
    const tags = normalizeTags(input.tags)
    const [row] = await tx
      .update(assetAssets)
      .set({
        tags,
        revision: sql`${assetAssets.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(assetAssets.id, asset.id))
      .returning()
    await audit(tx, actor, {
      projectId: asset.projectId,
      action: 'asset.tags',
      targetType: 'asset',
      targetId: asset.id,
      beforeRevision: asset.revision,
      afterRevision: row?.revision ?? null,
      changes: { tags: { from: asset.tags, to: tags } },
    })
    return returned(row)
  })
}

const titleSchema = z.object({
  assetId: recordId('Asset'),
  expectedRevision: revision,
  title: text.optional('Title', 200),
})

/**
 * Rename an asset: what HQ calls it. The file keeps its name as uploaded —
 * what a download saves as — and its place in storage, so a ready file's
 * frozen identity is untouched. An empty title, or the file name itself,
 * puts the file name back.
 */
export async function setAssetTitle(
  actor: Actor,
  raw: z.input<typeof titleSchema>,
): Promise<AssetRow> {
  const input = parseInput(titleSchema, raw)
  return withTransaction(async (tx) => {
    assertCan(actor, 'assets', 'write')
    const { row: asset, project } = await ownedRow<AssetRow>(
      tx,
      actor,
      assetAssets,
      input.assetId,
      'Asset',
      { lock: true },
    )
    await authorize(tx, actor, project, 'assets', 'write')
    if (asset.revision !== input.expectedRevision) throw conflict()
    const typed = (input.title ?? '')
      .replace(/\p{Cc}/gu, '')
      .replace(/\s+/g, ' ')
    const title = typed && typed !== asset.name ? typed : null
    if (title === asset.title) return asset
    const [row] = await tx
      .update(assetAssets)
      .set({
        title,
        revision: sql`${assetAssets.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(assetAssets.id, asset.id))
      .returning()
    await audit(tx, actor, {
      projectId: asset.projectId,
      action: 'asset.title',
      targetType: 'asset',
      targetId: asset.id,
      beforeRevision: asset.revision,
      afterRevision: row?.revision ?? null,
      changes: { title: { from: asset.title, to: title } },
    })
    return returned(row)
  })
}

/** What HQ calls an asset: the owner's title, else the file name. */
export const assetTitle = (asset: Pick<AssetRow, 'name' | 'title'>) =>
  asset.title ?? asset.name

const rejectSchema = z.object({
  assetId: recordId('Asset'),
  reason: text.optional('Reason', 300),
})

/** Turn down a pending upload; its bytes, if any arrived, are deleted. */
export async function rejectAsset(
  actor: Actor,
  raw: z.input<typeof rejectSchema>,
): Promise<AssetRow> {
  const input = parseInput(rejectSchema, raw)
  const rejected = await withTransaction(async (tx) => {
    assertCan(actor, 'assets', 'write')
    const { row: asset, project } = await ownedRow<AssetRow>(
      tx,
      actor,
      assetAssets,
      input.assetId,
      'Asset',
      { lock: true },
    )
    await authorize(tx, actor, project, 'assets', 'write')
    if (asset.status !== 'pending')
      throw invalid(
        asset.status === 'ready'
          ? 'A ready asset can’t be rejected — it is frozen. Only the owner can delete it.'
          : 'This upload is already rejected.',
      )
    const [row] = await tx
      .update(assetAssets)
      .set({
        status: 'rejected',
        problem: input.reason ?? 'Rejected before it was ready.',
        revision: sql`${assetAssets.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(assetAssets.id, asset.id))
      .returning()
    await audit(tx, actor, {
      projectId: asset.projectId,
      action: 'asset.reject',
      targetType: 'asset',
      targetId: asset.id,
      beforeRevision: asset.revision,
      afterRevision: row?.revision ?? null,
      reason: input.reason ?? null,
    })
    return { asset: returned(row), project }
  })
  // Best effort: a half-sent upload may have left bytes behind.
  try {
    const provider = await withReader((db) =>
      providerOf(db, rejected.asset, rejected.project),
    )
    await provider.delete(rejected.asset.storageKey)
  } catch {
    // Nothing arrived, or storage is unreachable; the row already says rejected.
  }
  return rejected.asset
}

/**
 * Delete an asset and its bytes (Drive keeps them in the owner's trash). The
 * owner's alone. Links to it go with it; a file a sent quote points at can't
 * be deleted.
 */
export async function deleteAsset(
  actor: Actor,
  assetId: string,
): Promise<void> {
  const removed = await withTransaction(async (tx) => {
    const { row: asset, project } = await ownedRow<AssetRow>(
      tx,
      actor,
      assetAssets,
      assetId,
      'Asset',
      { lock: true },
    )
    await authorize(tx, actor, project, 'assets', 'write', 'owner_only')
    await tx
      .delete(refs)
      .where(
        and(
          eq(refs.ownerId, actor.userId),
          or(
            and(eq(refs.fromType, 'asset'), eq(refs.fromId, asset.id)),
            and(eq(refs.toType, 'asset'), eq(refs.toId, asset.id)),
          ),
        ),
      )
    await tx.delete(assetAssets).where(eq(assetAssets.id, asset.id))
    await audit(tx, actor, {
      projectId: asset.projectId,
      action: 'asset.delete',
      targetType: 'asset',
      targetId: asset.id,
      beforeRevision: asset.revision,
      changes: {
        name: asset.name,
        status: asset.status,
        provider: asset.storageProvider,
        bytes: asset.bytes,
      },
    })
    return { asset, project }
  })
  try {
    const provider = await withReader((db) =>
      providerOf(db, removed.asset, removed.project),
    )
    await provider.delete(removed.asset.storageKey)
    if (removed.asset.thumbKey) await provider.delete(removed.asset.thumbKey)
  } catch {
    // The row is gone; bytes a provider refuses to delete now are orphans,
    // not data loss.
  }
}

/* ── Links to the bytes ─────────────────────────────────────────────── */

const accessSchema = z.object({
  assetId: recordId('Asset'),
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(24 * 3600)
    .optional(),
  download: z.boolean().optional(),
})

/**
 * A short-lived URL for an asset's bytes (`accessUrl`): a
 * presigned R2 link, or HQ's own link that streams from Drive.
 */
export async function assetAccess(
  actor: Actor,
  raw: z.input<typeof accessSchema>,
): Promise<{ url: string; expiresAt: Date; asset: AssetRow }> {
  const input = parseInput(accessSchema, raw)
  const ttl = input.ttlSeconds ?? 900
  const { asset, provider } = await withReader(async (db) => {
    const { row: asset, project } = await ownedRecord<AssetRow>(
      db,
      actor,
      assetAssets,
      input.assetId,
      'assets',
      'read',
      'Asset',
    )
    if (asset.status !== 'ready')
      throw invalid(
        asset.status === 'pending'
          ? 'This file hasn’t finished uploading.'
          : 'This file was rejected.',
      )
    return { asset, provider: await providerOf(db, asset, project) }
  })
  const url = await withStorage(() =>
    provider.accessUrl(
      asset.storageKey,
      ttl,
      input.download ? { filename: asset.name } : {},
    ),
  )
  // The link's own lifetime, on the server's clock — it is compared with nothing stored.
  return { url, expiresAt: new Date(Date.now() + ttl * 1000), asset }
}

/**
 * Preview links for a page of assets, one call: images show themselves, a
 * video its stored thumbnail, Drive files Drive's own thumbnail (through
 * HQ). Anything else — or a provider that can't be reached — gets no link and
 * the page draws a plain tile.
 */
export async function previewUrls(
  actor: Actor,
  assets: readonly Pick<
    AssetRow,
    | 'id'
    | 'ownerId'
    | 'projectId'
    | 'storageProvider'
    | 'storageKey'
    | 'kind'
    | 'status'
    | 'thumbKey'
  >[],
  ttlSeconds = 1800,
): Promise<Record<string, string>> {
  assertCan(actor, 'assets', 'read')
  const out: Record<string, string> = {}
  const providers = new Map<StorageProviderId, StorageProvider | null>()
  const mine = assets.filter(
    (asset) => asset.ownerId === actor.userId && asset.status === 'ready',
  )
  await withReader(async (db) => {
    for (const asset of mine) {
      if (!providers.has(asset.storageProvider)) {
        try {
          providers.set(
            asset.storageProvider,
            await providerFor(db, actor.userId, asset.storageProvider),
          )
        } catch {
          providers.set(asset.storageProvider, null)
        }
      }
    }
  })
  await Promise.all(
    mine.map(async (asset) => {
      const provider = providers.get(asset.storageProvider)
      if (!provider) return
      try {
        if (asset.storageProvider === 'gdrive') {
          if (
            asset.kind === 'image' ||
            asset.kind === 'video' ||
            asset.kind === 'doc'
          )
            out[asset.id] =
              `${await provider.accessUrl(asset.storageKey, ttlSeconds, {})}&size=480`
          return
        }
        if (asset.kind === 'image')
          out[asset.id] = await provider.accessUrl(asset.storageKey, ttlSeconds)
        else if (asset.thumbKey)
          out[asset.id] = await provider.accessUrl(asset.thumbKey, ttlSeconds)
      } catch {
        // No preview; the tile says what the file is instead.
      }
    }),
  )
  return out
}

/** Previews for files named by ID — the owner's ready ones; the rest have none. */
export async function previewsFor(
  actor: Actor,
  ids: readonly string[],
  ttlSeconds = 1800,
): Promise<Record<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean)
  if (unique.length === 0) return {}
  assertCan(actor, 'assets', 'read')
  const rows = await withReader((db) =>
    db
      .select()
      .from(assetAssets)
      .where(
        and(
          eq(assetAssets.ownerId, actor.userId),
          inArray(assetAssets.id, unique.slice(0, 500)),
        ),
      ),
  )
  return previewUrls(actor, rows, ttlSeconds)
}

/* ── Thumbnails (R2 videos) ─────────────────────────────────────────── */

const thumbSchema = z.object({
  assetId: recordId('Asset'),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(5 * 1024 ** 2),
})

/**
 * A place for a still of a ready R2 video, which the browser grabs from the
 * first second while it uploads. Drive makes its own thumbnails.
 */
export async function prepareThumbnail(
  actor: Actor,
  raw: z.input<typeof thumbSchema>,
): Promise<{ url: string; headers: Record<string, string>; key: string }> {
  const input = parseInput(thumbSchema, raw)
  const { asset, provider } = await withReader(async (db) => {
    const { row: asset, project } = await ownedRecord<AssetRow>(
      db,
      actor,
      assetAssets,
      input.assetId,
      'assets',
      'write',
      'Asset',
    )
    if (asset.kind !== 'video' || asset.storageProvider !== 'r2')
      throw invalid('Only an R2 video takes a thumbnail from HQ.')
    return { asset, provider: await providerOf(db, asset, project) }
  })
  const upload = await withStorage(() =>
    provider.prepareUpload({
      path: thumbnailPath(asset.id),
      mime: 'image/jpeg',
      bytes: input.bytes,
    }),
  )
  if (upload.mode !== 'presigned_put')
    throw invalid('This storage can’t take a thumbnail.')
  return { url: upload.url, headers: upload.headers, key: upload.key }
}

/** Record the still once its bytes are in: `thumb_key` is not part of the frozen identity. */
export async function setThumbnail(
  actor: Actor,
  raw: { assetId: string; key: string },
): Promise<AssetRow> {
  const input = parseInput(
    z.object({ assetId: recordId('Asset'), key: z.string().min(1).max(600) }),
    raw,
  )
  const { asset, provider } = await withReader(async (db) => {
    const { row: asset, project } = await ownedRecord<AssetRow>(
      db,
      actor,
      assetAssets,
      input.assetId,
      'assets',
      'write',
      'Asset',
    )
    if (
      asset.storageProvider !== 'r2' ||
      !isThumbnailKey(asset.ownerId, asset.id, input.key)
    )
      throw invalid('That isn’t a thumbnail HQ issued.')
    return { asset, provider: await providerOf(db, asset, project) }
  })
  const head = await withStorage(() => provider.head(input.key))
  if (!head) throw invalid('The thumbnail never arrived.')
  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(assetAssets)
      .set({ thumbKey: input.key, updatedAt: sql`now()` })
      .where(
        and(
          eq(assetAssets.id, asset.id),
          eq(assetAssets.ownerId, actor.userId),
        ),
      )
      .returning()
    return returned(row)
  })
}

/* ── Collections ────────────────────────────────────────────────────── */

async function ensureCollection(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  name: string,
  kind: (typeof ASSET_COLLECTION_KINDS)[number],
): Promise<AssetCollectionRow> {
  const [found] = await tx
    .select()
    .from(assetCollections)
    .where(
      and(
        eq(assetCollections.ownerId, actor.userId),
        project
          ? eq(assetCollections.projectId, project.id)
          : isNull(assetCollections.projectId),
        sql`lower(${assetCollections.name}) = lower(${name})`,
      ),
    )
    .limit(1)
  if (found) return found
  const [row] = await tx
    .insert(assetCollections)
    .values({
      ownerId: actor.userId,
      createdBy: actor.userId,
      projectId: project?.id ?? null,
      name,
      kind,
    })
    .onConflictDoNothing()
    .returning()
  if (row) return row
  const [again] = await tx
    .select()
    .from(assetCollections)
    .where(
      and(
        eq(assetCollections.ownerId, actor.userId),
        project
          ? eq(assetCollections.projectId, project.id)
          : isNull(assetCollections.projectId),
        sql`lower(${assetCollections.name}) = lower(${name})`,
      ),
    )
    .limit(1)
  return returned(again)
}

export type CollectionView = AssetCollectionRow & { count: number }

/** A project's collections (or the floating ones) with how many ready assets each holds. */
export async function listCollections(
  actor: Actor,
  projectId: string | null,
): Promise<CollectionView[]> {
  return withReader(async (db) => {
    if (projectId) {
      const project = await ownedProject(db, actor, projectId, 'assets', 'read')
      assertModuleOn(project, 'assets')
    } else await authorize(db, actor, null, 'assets', 'read')
    const rows = await db
      .select({
        collection: assetCollections,
        count: sql<number>`count(${assetAssets.id}) filter (where ${assetAssets.status} = 'ready')::int`,
      })
      .from(assetCollections)
      .leftJoin(
        assetCollectionItems,
        eq(assetCollectionItems.collectionId, assetCollections.id),
      )
      .leftJoin(assetAssets, eq(assetAssets.id, assetCollectionItems.assetId))
      .where(
        and(
          eq(assetCollections.ownerId, actor.userId),
          projectId
            ? eq(assetCollections.projectId, projectId)
            : isNull(assetCollections.projectId),
        ),
      )
      .groupBy(assetCollections.id)
      .orderBy(asc(assetCollections.position), asc(assetCollections.name))
    return rows.map((row) => ({ ...row.collection, count: row.count }))
  })
}

const collectionSchema = z.object({
  projectId: z.uuid().nullable().optional(),
  name: text.required('Name', 80),
  kind: choice(
    ASSET_COLLECTION_KINDS,
    'Choose a kind of collection.',
  ).optional(),
})

export async function createCollection(
  actor: Actor,
  raw: z.input<typeof collectionSchema>,
): Promise<AssetCollectionRow> {
  const input = parseInput(collectionSchema, raw)
  return withTransaction(async (tx) => {
    const project = input.projectId
      ? await ownedProject(tx, actor, input.projectId, 'assets', 'write')
      : null
    if (project) assertModuleOn(project, 'assets')
    else await authorize(tx, actor, null, 'assets', 'write')
    const [row] = await tx
      .insert(assetCollections)
      .values({
        ownerId: actor.userId,
        createdBy: actor.userId,
        projectId: project?.id ?? null,
        name: input.name as string,
        kind: input.kind ?? 'custom',
      })
      .returning()
    const collection = returned(row)
    await audit(tx, actor, {
      projectId: collection.projectId,
      action: 'asset.collection.create',
      targetType: 'asset_collection',
      targetId: collection.id,
      afterRevision: collection.revision,
      changes: { name: collection.name, kind: collection.kind },
    })
    return collection
  })
}

const membershipSchema = z.object({
  collectionId: recordId('Collection'),
  assetId: recordId('Asset'),
  member: z.boolean(),
})

/** Put an asset in a collection of its own project, or take it out. */
export async function setCollectionMember(
  actor: Actor,
  raw: z.input<typeof membershipSchema>,
): Promise<void> {
  const input = parseInput(membershipSchema, raw)
  await withTransaction(async (tx) => {
    const { row: collection } = await ownedRecord<AssetCollectionRow>(
      tx,
      actor,
      assetCollections,
      input.collectionId,
      'assets',
      'write',
      'Collection',
    )
    const { row: asset } = await ownedRecord<AssetRow>(
      tx,
      actor,
      assetAssets,
      input.assetId,
      'assets',
      'write',
      'Asset',
    )
    if (collection.projectId !== asset.projectId)
      throw invalid('That collection belongs to another project.')
    if (input.member)
      await tx
        .insert(assetCollectionItems)
        .values({
          ownerId: actor.userId,
          collectionId: collection.id,
          assetId: asset.id,
        })
        .onConflictDoNothing()
    else
      await tx
        .delete(assetCollectionItems)
        .where(
          and(
            eq(assetCollectionItems.collectionId, collection.id),
            eq(assetCollectionItems.assetId, asset.id),
          ),
        )
    await audit(tx, actor, {
      projectId: asset.projectId,
      action: input.member ? 'asset.collection.add' : 'asset.collection.remove',
      targetType: 'asset',
      targetId: asset.id,
      changes: { collection: collection.name },
    })
  })
}

/**
 * Why a collection keeps its name and stays, or null when the owner may
 * rename or delete it. HQ files what it makes (a generation's images, a sent
 * quote's PDF) into a collection it finds by name, so renaming one would
 * split the files and deleting one would only bring it back empty.
 */
export function collectionHeld(
  collection: Pick<AssetCollectionRow, 'kind'>,
): string | null {
  return collection.kind === 'generated'
    ? 'HQ files what it makes here — generated images, sent quotes’ PDFs — so this collection keeps its name and stays.'
    : null
}

/** The collection, locked, for the owner to change or remove. */
async function collectionForOwner(
  tx: Tx,
  actor: Actor,
  collectionId: string,
): Promise<{ collection: AssetCollectionRow; project: ProjectRow | null }> {
  assertCan(actor, 'assets', 'write')
  const { row: collection, project } = await ownedRow<AssetCollectionRow>(
    tx,
    actor,
    assetCollections,
    collectionId,
    'Collection',
    { lock: true },
  )
  await authorize(tx, actor, project, 'assets', 'write', 'owner_only')
  const held = collectionHeld(collection)
  if (held) throw invalid(held)
  return { collection, project }
}

const renameSchema = z.object({
  collectionId: recordId('Collection'),
  expectedRevision: revision,
  name: text.required('Name', 80),
})

/**
 * Rename a collection. The owner's. Files already in it keep the path they
 * were stored under (a ready file is frozen); new uploads go under the new
 * name.
 */
export async function renameCollection(
  actor: Actor,
  raw: z.input<typeof renameSchema>,
): Promise<AssetCollectionRow> {
  const input = parseInput(renameSchema, raw)
  return withTransaction(async (tx) => {
    const { collection } = await collectionForOwner(
      tx,
      actor,
      input.collectionId,
    )
    if (collection.revision !== input.expectedRevision) throw conflict()
    const name = input.name as string
    if (name === collection.name) return collection
    const [row] = await tx
      .update(assetCollections)
      .set({
        name,
        revision: sql`${assetCollections.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(assetCollections.id, collection.id))
      .returning()
    const renamed = returned(row)
    await audit(tx, actor, {
      projectId: collection.projectId,
      action: 'asset.collection.rename',
      targetType: 'asset_collection',
      targetId: collection.id,
      beforeRevision: collection.revision,
      afterRevision: renamed.revision,
      changes: { name: { from: collection.name, to: renamed.name } },
    })
    return renamed
  })
}

/**
 * Delete a collection — the grouping, never the files: its items go with it
 * (they cascade), every asset stays where it is. The owner's. It can't come
 * back, so the page asks first.
 */
export async function deleteCollection(
  actor: Actor,
  collectionId: string,
): Promise<{ files: number }> {
  return withTransaction(async (tx) => {
    const { collection } = await collectionForOwner(tx, actor, collectionId)
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(assetCollectionItems)
      .where(eq(assetCollectionItems.collectionId, collection.id))
    await tx
      .delete(assetCollections)
      .where(eq(assetCollections.id, collection.id))
    await audit(tx, actor, {
      projectId: collection.projectId,
      action: 'asset.collection.delete',
      targetType: 'asset_collection',
      targetId: collection.id,
      beforeRevision: collection.revision,
      changes: {
        name: collection.name,
        kind: collection.kind,
        files: count?.n ?? 0,
      },
    })
    return { files: count?.n ?? 0 }
  })
}

/* ── Summaries ──────────────────────────────────────────────────────── */

export type AssetSummary = {
  projectId: string | null
  ready: number
  pending: number
  bytes: number
  /** Newest ready asset. */
  lastReadyAt: Date | null
}

/** Per project: ready and pending counts and bytes — the Assets cell on Home. */
export async function assetSummaries(actor: Actor): Promise<AssetSummary[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'assets', 'read')
    const rows = await db
      .select({
        projectId: assetAssets.projectId,
        ready: sql<number>`count(*) filter (where ${assetAssets.status} = 'ready')::int`,
        pending: sql<number>`count(*) filter (where ${assetAssets.status} = 'pending')::int`,
        bytes: sql<number>`coalesce(sum(${assetAssets.bytes}) filter (where ${assetAssets.status} = 'ready'), 0)::float8`,
        lastReadyAt: sql<Date | null>`max(${assetAssets.readyAt})`,
      })
      .from(assetAssets)
      .where(eq(assetAssets.ownerId, actor.userId))
      .groupBy(assetAssets.projectId)
    return rows.map((row) => ({
      ...row,
      lastReadyAt: row.lastReadyAt ? new Date(row.lastReadyAt) : null,
    }))
  })
}
