/**
 * Cloudflare R2 — HQ's object storage, reached through R2's S3-compatible API.
 *
 * No `server-only` here: `scripts/check-r2.ts` reuses this outside Next. The
 * app imports through `@/lib/storage`, which is server-only, so the secret key
 * never reaches a client bundle.
 *
 * env:
 *   R2_ACCOUNT_ID         Cloudflare account id — builds the S3 endpoint.
 *   R2_ACCESS_KEY_ID      Access Key ID of an R2 API token.
 *   R2_SECRET_ACCESS_KEY  Secret Access Key of the same token.
 *   R2_BUCKET             Bucket name.
 *   R2_PUBLIC_URL         Optional. Public origin serving the bucket (a custom
 *                         domain or the r2.dev URL). Unset → the bucket is
 *                         private and objects are read through presigned URLs.
 *   R2_ENDPOINT           Optional. Replaces the endpoint built from the account
 *                         id — a jurisdiction bucket
 *                         (https://<account>.eu.r2.cloudflarestorage.com) or a
 *                         local S3-compatible server for testing.
 */

export type StorageConfig = {
  /** S3 API origin, no trailing slash. Requests are path-style. */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Public base URL without a trailing slash, or null for a private bucket. */
  publicUrl: string | null
}

export type StorageReadiness = { ok: true } | { ok: false; missing: string[] }

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined
}

function parseUrl(raw: string | undefined): URL | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

function endpoint(): string | null {
  const override = env('R2_ENDPOINT')
  if (override) return parseUrl(override)?.origin ?? null
  const account = env('R2_ACCOUNT_ID')
  return account && /^[a-f0-9]{32}$/i.test(account)
    ? `https://${account}.r2.cloudflarestorage.com`
    : null
}

function publicBase(): string | null {
  const url = parseUrl(env('R2_PUBLIC_URL'))
  return url ? `${url.origin}${url.pathname}`.replace(/\/+$/, '') : null
}

/**
 * What's unset or malformed. A present-but-unparseable R2_PUBLIC_URL counts:
 * silently treating it as "private bucket" would hand out broken links later.
 */
export function storageReadiness(): StorageReadiness {
  const bucket = env('R2_BUCKET')
  const missing = [
    ...(endpoint()
      ? []
      : [env('R2_ENDPOINT') ? 'R2_ENDPOINT' : 'R2_ACCOUNT_ID']),
    ...(env('R2_ACCESS_KEY_ID') ? [] : ['R2_ACCESS_KEY_ID']),
    ...(env('R2_SECRET_ACCESS_KEY') ? [] : ['R2_SECRET_ACCESS_KEY']),
    ...(bucket && BUCKET_NAME.test(bucket) ? [] : ['R2_BUCKET']),
    ...(env('R2_PUBLIC_URL') && !publicBase() ? ['R2_PUBLIC_URL'] : []),
  ]
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

export function isStorageConfigured(): boolean {
  return storageReadiness().ok
}

/** The resolved config, or null until every required variable is valid. */
export function storageConfig(): StorageConfig | null {
  if (!storageReadiness().ok) return null
  return {
    endpoint: endpoint() as string,
    bucket: env('R2_BUCKET') as string,
    accessKeyId: env('R2_ACCESS_KEY_ID') as string,
    secretAccessKey: env('R2_SECRET_ACCESS_KEY') as string,
    publicUrl: publicBase(),
  }
}
