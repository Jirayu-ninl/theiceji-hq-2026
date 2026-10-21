import {
  createDriveProvider,
  type GoogleDriveContext,
} from './providers/gdrive'
import { createR2Provider } from './providers/r2'
import {
  type ListedObject,
  type ListResult,
  type ObjectInfo,
  type PutBody,
  type PutOptions,
  StorageError,
} from './r2'

/**
 * One storage interface, two homes for an asset's bytes:
 *
 *   r2      HQ's Cloudflare R2 bucket (env `R2_*`, `./config`). Key = the
 *           object key, minted under the owner's prefix `<ownerId>/`.
 *   gdrive  The owner's Google Drive, scope `drive.file` (HQ only sees files
 *           it created). Key = the Drive file id.
 *
 * An asset stores `{ provider, key }` (a `StorageRef`) and always goes back
 * through `storageFor(ref.provider, ctx)`, so changing a project's default
 * provider never moves old files.
 *
 * Framework- and database-free on purpose: the Google side is injected. HQ
 * builds `ctx.gdrive` from the owner's `google_connections` row (token
 * minting and refresh, the HQ root folder, its own signed content URLs).
 *
 * Upload flow — `prepareUpload` → the client sends the bytes → `finalize`:
 *   r2      `presigned_put`: the browser PUTs straight to R2; `finalize(key)`
 *           HEADs it.
 *   gdrive  `resumable`: the browser PUTs to Google's session URL; the key is
 *           a pending `upload:<bytes>:<upload_id>` that `finalize` resolves to
 *           the new file id (see `providers/gdrive.ts`). Store the key that
 *           `finalize` returns.
 */

export const STORAGE_PROVIDERS = ['r2', 'gdrive'] as const

export type StorageProviderId = (typeof STORAGE_PROVIDERS)[number]

export type StorageRef = { provider: StorageProviderId; key: string }

export function isStorageProvider(value: unknown): value is StorageProviderId {
  return STORAGE_PROVIDERS.includes(value as StorageProviderId)
}

/** `ObjectInfo` plus what a provider can say beyond S3 headers. */
export type ProviderObjectInfo = ObjectInfo & {
  /** Hex SHA-256 of the bytes: Drive reports it; `put` hashes its body. */
  sha256?: string
  /** Hex MD5, when the provider reports it (Drive). */
  md5?: string
  /** Display name — a Drive key is an opaque id, so the name lives here. */
  name?: string
  width?: number
  height?: number
  durationMs?: number
}

export type ProviderListedObject = ListedObject & {
  name?: string
  contentType?: string | null
}

/**
 * One level, like a folder: `objects` sit directly under the prefix, child
 * folders are in `prefixes` as full paths ending in `/`.
 */
export type ProviderListResult = Omit<ListResult, 'objects'> & {
  objects: ProviderListedObject[]
}

export type UploadSpec = {
  /** `<project-slug>/<collection>/<filename>`. */
  path: string
  mime: string
  bytes: number
  /**
   * gdrive: the browser origin that will PUT the bytes. Google only answers a
   * cross-origin PUT to the session when the session was opened with that
   * Origin. Overrides `ctx.gdrive.origin`; leave both unset when a server
   * uploads.
   */
  origin?: string
}

export type PreparedUpload =
  | {
      mode: 'presigned_put'
      url: string
      /** Send exactly these with the PUT — they are signed. */
      headers: Record<string, string>
      key: string
      expiresAt: Date
    }
  | {
      mode: 'resumable'
      /** PUT the bytes here; no auth header needed, the URL is the grant. */
      sessionUrl: string
      /** Pending until `finalize` swaps it for the Drive file id. */
      key: string
      expiresAt: Date
    }
  | { mode: 'proxy'; endpoint: string; key: string }

export type StorageProvider = {
  readonly id: StorageProviderId
  /**
   * Server-side write of a buffered body (a generated image, a PDF). `key`
   * null makes a new object named from `options.path`; a key overwrites that
   * object. Returns what was stored, including the body's SHA-256.
   */
  put(
    key: string | null,
    body: PutBody,
    options: PutOptions & { path?: string },
  ): Promise<ProviderObjectInfo>
  /** The bytes as a fetch Response to stream onward; null when absent. */
  get(key: string): Promise<Response | null>
  head(key: string): Promise<ProviderObjectInfo | null>
  /** Idempotent. Drive moves the file to the owner's trash, never erases it. */
  delete(key: string): Promise<void>
  list(prefix: string, cursor?: string | null): Promise<ProviderListResult>
  prepareUpload(spec: UploadSpec): Promise<PreparedUpload>
  /**
   * Confirms the upload landed and describes it; throws StorageError 404 when
   * it didn't. The returned `key` is the one to store — for Drive it replaces
   * the pending upload key.
   */
  finalize(key: string): Promise<ProviderObjectInfo>
  /**
   * A short-lived URL a browser can GET. r2: a presigned URL. gdrive: HQ's
   * own proxy URL — HQ never changes Drive sharing.
   */
  accessUrl(
    key: string,
    ttlSeconds: number,
    options?: { filename?: string },
  ): Promise<string>
  /** Only where the provider renders thumbnails itself (Drive). */
  thumbnail?(key: string, size: number): Promise<Response | null>
}

export type StorageContext = {
  ownerId: string
  /** Required for `gdrive`; absent means Google isn't connected. */
  gdrive?: GoogleDriveContext | null
}

export function storageFor(
  provider: StorageProviderId,
  ctx: StorageContext,
): StorageProvider {
  if (!ctx.ownerId) {
    throw new StorageError('Storage needs an owner id.', 400, 'MissingOwner')
  }
  if (provider === 'r2') return createR2Provider({ ownerId: ctx.ownerId })
  if (provider === 'gdrive') {
    if (!ctx.gdrive?.rootFolderId) {
      throw new StorageError(
        'Google Drive is not connected; connect Google in HQ Settings first.',
        503,
        'NotConnected',
      )
    }
    return createDriveProvider(ctx.gdrive)
  }
  throw new StorageError(
    `Unknown storage provider: ${JSON.stringify(provider)}.`,
    400,
    'UnknownProvider',
  )
}

export { createDriveProvider, createR2Provider, type GoogleDriveContext }
