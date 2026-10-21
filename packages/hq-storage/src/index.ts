// @theiceji/hq-storage — HQ's object storage (Cloudflare R2), framework-free.
// Server-only by nature (it holds the signing key); apps/hq re-exports it from
// `@/lib/storage` behind `server-only`, and apps/hq-mcp imports it directly.
export {
  isStorageConfigured,
  type StorageConfig,
  type StorageReadiness,
  storageConfig,
  storageReadiness,
} from './config'
export {
  assertKey,
  isSafeKey,
  normalizePrefix,
  objectKey,
  ownerPrefix,
} from './keys'
// The provider interface over R2 and the owner's Google Drive.
export {
  createDriveProvider,
  createR2Provider,
  type GoogleDriveContext,
  isStorageProvider,
  type PreparedUpload,
  type ProviderListedObject,
  type ProviderListResult,
  type ProviderObjectInfo,
  STORAGE_PROVIDERS,
  type StorageContext,
  type StorageProvider,
  type StorageProviderId,
  type StorageRef,
  storageFor,
  type UploadSpec,
} from './provider'
export {
  deleteObject,
  getObject,
  headObject,
  type ListedObject,
  type ListResult,
  listObjects,
  type ObjectInfo,
  type PresignedUpload,
  type PutBody,
  type PutOptions,
  presignDownload,
  presignUpload,
  publicUrl,
  putObject,
  StorageError,
} from './r2'
