import 'server-only'

/**
 * HQ object storage — Cloudflare R2. Import from `@/lib/storage` in the app;
 * `server-only` keeps the signing credentials out of client bundles. The
 * implementation lives in `@theiceji/hq-storage` so apps/hq-mcp signs the same
 * way; `scripts/check-r2.ts` imports that package directly, since
 * `server-only` throws outside Next.
 */

export {
  assertKey,
  deleteObject,
  getObject,
  headObject,
  isSafeKey,
  isStorageConfigured,
  type ListedObject,
  type ListResult,
  listObjects,
  normalizePrefix,
  type ObjectInfo,
  objectKey,
  type PresignedUpload,
  type PutBody,
  type PutOptions,
  presignDownload,
  presignUpload,
  publicUrl,
  putObject,
  StorageError,
  type StorageReadiness,
  storageReadiness,
} from '@theiceji/hq-storage'
