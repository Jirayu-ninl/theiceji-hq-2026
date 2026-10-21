import { normalizePrefix, objectKey, ownerPrefix } from '../keys'
import type {
  ProviderObjectInfo,
  StorageProvider,
  UploadSpec,
} from '../provider'
import {
  deleteObject,
  getObject,
  headObject,
  listObjects,
  presignDownload,
  presignUpload,
  putObject,
  StorageError,
} from '../r2'
import {
  assertBytes,
  assertMime,
  pathSegments,
  sha256Hex,
  splitPath,
  toBytes,
} from './shared'

/**
 * The `r2` StorageProvider: a thin wrapper over `../r2.ts`, whose functions
 * and behaviour are unchanged (env `R2_*`, lazily — a call throws
 * StorageError 503 `NotConfigured` while env is incomplete).
 *
 * A path becomes an `objectKey()` under the owner's prefix:
 * `Acme Film/Boards/Hero Shot.png` →
 * `<ownerId>/acme-film/boards/2026/09/<16 hex>-hero-shot.png`, so listing a
 * path walks `yyyy/mm/` levels before the files, and `list` never leaves the
 * owner's prefix. Keys already stored are read as they are: files written
 * before the prefix keep their old keys.
 *
 * S3 HEAD carries no SHA-256, so `head`/`finalize` leave `sha256` undefined;
 * whoever needs it hashes `get()`. `put` hashes the body it
 * already holds in memory.
 */

function keyForPath(owner: string, path: string | undefined): string {
  const { folders, name } = splitPath(path)
  if (folders.length === 0) {
    throw new StorageError(
      'An R2 path needs at least one folder before the file name.',
      400,
      'InvalidPath',
    )
  }
  try {
    return objectKey(`${owner}${folders.join('/')}`, name)
  } catch {
    throw new StorageError(
      `Storage path ${JSON.stringify(path)} has no usable folder name.`,
      400,
      'InvalidPath',
    )
  }
}

/** `Acme Film/Boards` → `<ownerId>/acme-film/boards/`, slugged like the keys; empty → the owner's top. */
function listPrefix(owner: string, prefix: string): string {
  const segments = pathSegments(prefix)
  if (segments.length === 0) return owner
  try {
    return `${owner}${normalizePrefix(segments.join('/'))}/`
  } catch {
    throw new StorageError(
      `Storage path ${JSON.stringify(prefix)} has no usable folder name.`,
      400,
      'InvalidPath',
    )
  }
}

export function createR2Provider({
  ownerId,
}: {
  ownerId: string
}): StorageProvider {
  let owner: string
  try {
    owner = ownerPrefix(ownerId)
  } catch (error) {
    throw new StorageError((error as Error).message, 400, 'InvalidOwner')
  }
  return {
    id: 'r2',

    async put(key, body, options) {
      const { path: _path, ...putOptions } = options
      const target = key ?? keyForPath(owner, options.path)
      // The original body goes to R2 untouched; the bytes are for size + hash.
      const bytes = await toBytes(body)
      const { etag } = await putObject(target, body, putOptions)
      const metadata: Record<string, string> = {}
      for (const [name, value] of Object.entries(putOptions.metadata ?? {})) {
        metadata[name.toLowerCase()] = value
      }
      return {
        key: target,
        size: bytes.byteLength,
        etag,
        lastModified: new Date(),
        contentType: putOptions.contentType ?? null,
        metadata,
        sha256: await sha256Hex(bytes),
      } satisfies ProviderObjectInfo
    },

    get: (key) => getObject(key),

    head: (key) => headObject(key),

    delete: (key) => deleteObject(key),

    list: (prefix, cursor) =>
      listObjects({
        prefix: listPrefix(owner, prefix),
        delimiter: '/',
        cursor,
      }),

    async prepareUpload(spec: UploadSpec) {
      const contentType = assertMime(spec.mime)
      const size = assertBytes(spec.bytes)
      const grant = await presignUpload(keyForPath(owner, spec.path), {
        contentType,
        size,
      })
      return {
        mode: 'presigned_put',
        url: grant.url,
        headers: grant.headers,
        key: grant.key,
        expiresAt: grant.expiresAt,
      }
    },

    async finalize(key) {
      const info = await headObject(key)
      if (!info) {
        throw new StorageError('The upload never reached R2.', 404, 'NotFound')
      }
      return info
    },

    accessUrl: (key, ttlSeconds, options = {}) =>
      presignDownload(key, {
        expiresIn: ttlSeconds,
        filename: options.filename,
      }),
  }
}
