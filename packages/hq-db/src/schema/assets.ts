import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  ASSET_COLLECTION_KINDS,
  ASSET_JOB_OPERATIONS,
  ASSET_JOB_STATUSES,
  ASSET_KINDS,
  ASSET_ORIGINS,
  ASSET_STATUSES,
  type AssetCollectionKind,
  type AssetJobOperation,
  type AssetJobStatus,
  type AssetKind,
  type AssetOrigin,
  type AssetStatus,
  OPS_ACTOR_TYPES,
  type OpsActorType,
  REF_ROLES,
  REF_TYPES,
  type RefRole,
  type RefType,
  STORAGE_PROVIDERS,
  type StorageProviderId,
} from '../enums'
import {
  inOwnProject,
  ownerColumn,
  projectOrNone,
  trimmedLength,
} from './_module'
import { nullableOneOf, oneOf, tz } from './_shared'
import { tracked } from './_user'
import { opsTasks } from './ops'

/* ── assets — every file HQ keeps ──────────────────
 *
 * An asset is one file in one storage provider: HQ's R2 bucket or the
 * owner's Google Drive. It remembers its own `storage_provider` +
 * `storage_key` forever, so changing a project's storage never moves a file.
 *
 * · **pending → ready → (rejected).** A row is written `pending` before the
 *   bytes are sent; `finalize` confirms them in storage and makes it `ready`.
 *   From then on the file's identity (provider, key, bytes, hash, type,
 *   project) is frozen by a trigger — what a prompt example, a quote PDF or a
 *   post points at never changes under it. A ready file that disappears from
 *   its storage becomes `rejected`; only the owner deletes a ready asset.
 * · **Every module may point at an asset** (assets is the one
 *   module others may depend on), so `unique (id, owner_id)` lets their
 *   composite keys keep a reference inside one owner.
 * · **Collections** group assets inside a project (characters, scenes, refs,
 *   generated, or the owner's own); an asset can sit in several.
 */

export const assetAssets = pgTable(
  'asset_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id'),
    storageProvider: text('storage_provider')
      .$type<StorageProviderId>()
      .notNull(),
    /** R2 object key, or a Drive file id (a pending Drive upload key until finalize). */
    storageKey: text('storage_key').notNull(),
    /** `<project-slug>/<collection>/<filename>` — where it sits, for people. */
    path: text('path').notNull(),
    /** The file name as uploaded — what a download saves as; never changes. */
    name: text('name').notNull(),
    /**
     * What HQ calls the file, when the owner renamed it; null shows `name`.
     * Not part of the frozen identity, so a ready file can be renamed.
     */
    title: text('title'),
    kind: text('kind').$type<AssetKind>().notNull(),
    mime: text('mime').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    /** Hex SHA-256; null until known, or when the file was too big to hash (`sha256_note`). */
    sha256: text('sha256'),
    sha256Note: text('sha256_note'),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    /** A small still in the same provider, for videos (images are their own). */
    thumbKey: text('thumb_key'),
    origin: text('origin').$type<AssetOrigin>().notNull().default('upload'),
    status: text('status').$type<AssetStatus>().notNull().default('pending'),
    /** Why it was rejected, in words. */
    problem: text('problem'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    actorType: text('actor_type').$type<OpsActorType>().notNull(),
    actorId: text('actor_id').notNull(),
    readyAt: timestamp('ready_at', tz),
    /** Last time the ops tick found the bytes still in storage. */
    checkedAt: timestamp('checked_at', tz),
  },
  (t) => [
    unique('asset_assets_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('asset_assets_project_fk', t),
    uniqueIndex('asset_assets_storage_key').on(t.storageProvider, t.storageKey),
    index('asset_assets_owner_idx').on(
      t.ownerId,
      t.projectId,
      t.status,
      t.createdAt.desc(),
    ),
    index('asset_assets_tags_idx').using('gin', t.tags),
    check(
      'asset_assets_provider_check',
      oneOf(t.storageProvider, STORAGE_PROVIDERS),
    ),
    check('asset_assets_kind_check', oneOf(t.kind, ASSET_KINDS)),
    check('asset_assets_origin_check', oneOf(t.origin, ASSET_ORIGINS)),
    check('asset_assets_status_check', oneOf(t.status, ASSET_STATUSES)),
    check('asset_assets_actor_check', oneOf(t.actorType, OPS_ACTOR_TYPES)),
    check('asset_assets_name_check', trimmedLength(t.name, 240)),
    check(
      'asset_assets_title_check',
      sql`${t.title} is null or ${trimmedLength(t.title, 200)}`,
    ),
    check('asset_assets_path_check', sql`length(${t.path}) between 1 and 600`),
    check('asset_assets_bytes_check', sql`${t.bytes} >= 0`),
    check(
      'asset_assets_sha_check',
      sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'asset_assets_ready_check',
      sql`(${t.status} = 'ready') = (${t.readyAt} is not null) or ${t.status} = 'rejected'`,
    ),
    check('asset_assets_tags_check', sql`cardinality(${t.tags}) <= 24`),
  ],
)

export const assetCollections = pgTable(
  'asset_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id'),
    name: text('name').notNull(),
    kind: text('kind').$type<AssetCollectionKind>().notNull().default('custom'),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    unique('asset_collections_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('asset_collections_project_fk', t),
    uniqueIndex('asset_collections_name_key').on(
      t.ownerId,
      projectOrNone(t.projectId),
      sql`lower(${t.name})`,
    ),
    check(
      'asset_collections_kind_check',
      oneOf(t.kind, ASSET_COLLECTION_KINDS),
    ),
    check('asset_collections_name_check', trimmedLength(t.name, 80)),
  ],
)

export const assetCollectionItems = pgTable(
  'asset_collection_items',
  {
    ownerId: ownerColumn(),
    collectionId: uuid('collection_id').notNull(),
    assetId: uuid('asset_id').notNull(),
    position: integer('position').notNull().default(0),
    addedAt: timestamp('added_at', tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'asset_collection_items_pkey',
      columns: [t.collectionId, t.assetId],
    }),
    foreignKey({
      name: 'asset_collection_items_collection_fk',
      columns: [t.collectionId, t.ownerId],
      foreignColumns: [assetCollections.id, assetCollections.ownerId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'asset_collection_items_asset_fk',
      columns: [t.assetId, t.ownerId],
      foreignColumns: [assetAssets.id, assetAssets.ownerId],
    }).onDelete('cascade'),
    index('asset_collection_items_asset_idx').on(t.assetId),
  ],
)

/**
 * A generation or production job: something that makes files.
 *
 * · **`manual`** — the owner makes it elsewhere (a generator's own site) and
 *   attaches the result; the job waits in `awaiting_upload`.
 * · **`local_worker`** — HQ's worker on the owner's machine (ffmpeg, ZIP,
 *   stills); the job sits on an ops task, so it is claimed with a lease and
 *   a fencing token, heartbeats, and is recovered when the worker dies.
 * · **`agent:<service>` · `external:<kind>`** arrive with Agents,
 *   on the same row.
 *
 * `target` is the record a result is for — a shot, a prompt variant — and
 * each result links to it in `refs` (`asset —result_of→ shot`) when the job
 * succeeds. `input` holds IDs and parameters only (a recipe), never a copy
 * of anyone's instructions.
 */
export const assetGenerationJobs = pgTable(
  'asset_generation_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id'),
    /** `manual`, `local_worker`, `agent:<service>`, `external:<kind>`. */
    provider: text('provider').notNull(),
    operation: text('operation').$type<AssetJobOperation>().notNull(),
    /** What a person reads in a list: "Shot 1.2 · still". */
    title: text('title').notNull(),
    input: jsonb('input')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    targetType: text('target_type').$type<RefType>(),
    targetId: uuid('target_id'),
    targetRole: text('target_role').$type<RefRole>(),
    /** The prompt variant it runs, when it generates from one. */
    variantId: uuid('variant_id'),
    /** The ops task a worker or agent claims it through. */
    taskId: uuid('task_id'),
    status: text('status').$type<AssetJobStatus>().notNull().default('queued'),
    resultAssetIds: uuid('result_asset_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    remoteId: text('remote_id'),
    error: text('error'),
    startedAt: timestamp('started_at', tz),
    finishedAt: timestamp('finished_at', tz),
    actorType: text('actor_type').$type<OpsActorType>().notNull(),
    actorId: text('actor_id').notNull(),
  },
  (t) => [
    unique('asset_generation_jobs_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('asset_generation_jobs_project_fk', t),
    foreignKey({
      name: 'asset_generation_jobs_task_fk',
      columns: [t.taskId, t.ownerId],
      foreignColumns: [opsTasks.id, opsTasks.ownerId],
    }).onDelete('restrict'),
    index('asset_generation_jobs_owner_idx').on(
      t.ownerId,
      t.projectId,
      t.status,
      t.createdAt.desc(),
    ),
    index('asset_generation_jobs_target_idx').on(t.targetType, t.targetId),
    uniqueIndex('asset_generation_jobs_task_key')
      .on(t.taskId)
      .where(sql`${t.taskId} is not null`),
    check(
      'asset_generation_jobs_provider_check',
      sql`${t.provider} ~ '^(manual|local_worker|agent:[a-z0-9_.-]{1,60}|external:[a-z0-9_.-]{1,60})$'`,
    ),
    check(
      'asset_generation_jobs_operation_check',
      oneOf(t.operation, ASSET_JOB_OPERATIONS),
    ),
    check(
      'asset_generation_jobs_status_check',
      oneOf(t.status, ASSET_JOB_STATUSES),
    ),
    check(
      'asset_generation_jobs_target_type_check',
      nullableOneOf(t.targetType, REF_TYPES),
    ),
    check(
      'asset_generation_jobs_target_role_check',
      nullableOneOf(t.targetRole, REF_ROLES),
    ),
    check(
      'asset_generation_jobs_target_check',
      sql`(${t.targetType} is null) = (${t.targetId} is null) and (${t.targetType} is null) = (${t.targetRole} is null)`,
    ),
    check('asset_generation_jobs_title_check', trimmedLength(t.title, 200)),
    check(
      'asset_generation_jobs_input_check',
      sql`jsonb_typeof(${t.input}) = 'object'`,
    ),
    check(
      'asset_generation_jobs_done_check',
      sql`${t.status} <> 'succeeded' or cardinality(${t.resultAssetIds}) > 0`,
    ),
    check(
      'asset_generation_jobs_manual_check',
      sql`(${t.status} = 'awaiting_upload') <= (${t.provider} = 'manual')`,
    ),
    check(
      'asset_generation_jobs_actor_check',
      oneOf(t.actorType, OPS_ACTOR_TYPES),
    ),
  ],
)

export type AssetRow = typeof assetAssets.$inferSelect
export type AssetCollectionRow = typeof assetCollections.$inferSelect
export type AssetCollectionItemRow = typeof assetCollectionItems.$inferSelect
export type AssetJobRow = typeof assetGenerationJobs.$inferSelect
