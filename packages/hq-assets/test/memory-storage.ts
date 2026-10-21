import { createHash } from 'node:crypto'
import type {
  ProviderObjectInfo,
  StorageProvider,
  StorageProviderId,
} from '@theiceji/hq-storage'

/**
 * An in-memory storage standing in for R2 and Drive in the DB suites (the
 * real providers have their own suites in hq-storage).
 */

/** A bucket per provider; "uploading" is writing into it. */
export const buckets = new Map<
  StorageProviderId,
  Map<string, { bytes: Uint8Array; mime: string }>
>()
let serial = 0

export function memory(id: StorageProviderId): StorageProvider {
  let bucket = buckets.get(id)
  if (!bucket) {
    bucket = new Map()
    buckets.set(id, bucket)
  }
  const store = bucket
  const info = (key: string): ProviderObjectInfo | null => {
    const entry = store.get(key)
    if (!entry) return null
    return {
      key,
      size: entry.bytes.byteLength,
      etag: null,
      lastModified: new Date(),
      contentType: entry.mime,
      metadata: {},
    }
  }
  return {
    id,
    async put(key, body, options) {
      const bytes =
        body instanceof Uint8Array
          ? body
          : new TextEncoder().encode(String(body))
      const target = key ?? `${options.path}#${++serial}`
      store.set(target, {
        bytes,
        mime: options.contentType ?? 'application/octet-stream',
      })
      return {
        ...(info(target) as ProviderObjectInfo),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    },
    async get(key) {
      const entry = store.get(key)
      return entry ? new Response(entry.bytes) : null
    },
    head: async (key) => info(key),
    delete: async (key) => {
      store.delete(key)
    },
    list: async () =>
      ({ objects: [], prefixes: [], cursor: null, truncated: false }) as never,
    async prepareUpload(spec) {
      const key = `${spec.path}#${++serial}`
      return {
        mode: 'presigned_put',
        url: `memory://${key}`,
        headers: {},
        key,
        expiresAt: new Date(),
      }
    },
    async finalize(key) {
      const found = info(key)
      if (!found)
        throw Object.assign(new Error('The upload never arrived.'), {
          status: 404,
        })
      return found
    },
    accessUrl: async (key, ttl) => `memory://${key}?ttl=${ttl}`,
  }
}

/** The browser's part: send bytes to where prepareUpload said. */
export function send(
  provider: StorageProviderId,
  key: string,
  bytes: Uint8Array,
  mime: string,
) {
  buckets.get(provider)?.set(key, { bytes, mime })
}
