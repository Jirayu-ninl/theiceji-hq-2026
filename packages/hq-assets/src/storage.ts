import { googleAccessToken } from '@theiceji/hq-core/google'
import type { StorageProviderId } from '@theiceji/hq-db/enums'
import { googleConnections } from '@theiceji/hq-db/schema'
import type { Reader } from '@theiceji/hq-ops/db'
import {
  capabilityUnavailable,
  OpsError,
  reauthRequired,
} from '@theiceji/hq-ops/errors'
import { isSealingConfigured, seal, unseal } from '@theiceji/hq-ops/secrets'
import {
  StorageError,
  type StorageProvider,
  storageFor,
  storageReadiness,
} from '@theiceji/hq-storage'
import { eq } from 'drizzle-orm'

/**
 * Where an asset's bytes live, as a working `StorageProvider`.
 *
 * R2 needs only HQ's env. Google Drive needs the owner's connection: an
 * access token minted from the sealed refresh token (hq-core/google), HQ's
 * root folder in their Drive, and — because HQ never changes Drive sharing —
 * a URL of HQ's own that streams the file: `/api/assets/content?t=<token>`.
 * The token is sealed (AES-GCM under HQ's sealing key), so it can't be forged
 * or read, and it says whose file, which provider, which key and until when.
 *
 * `configureAssetStorage` gives a long-running process (the MCP server) HQ's
 * public origin so its URLs are absolute; HQ's own pages use relative ones.
 */

let origin: string | null = null
let override:
  | ((ownerId: string, provider: StorageProviderId) => StorageProvider)
  | null = null

export function configureAssetStorage(options: {
  origin?: string | null
  /** Tests only: every provider request answers with this. */
  providerOverride?:
    | ((ownerId: string, provider: StorageProviderId) => StorageProvider)
    | null
}): void {
  if ('origin' in options) origin = options.origin?.replace(/\/+$/, '') || null
  if ('providerOverride' in options) override = options.providerOverride ?? null
}

/** The path the app serves Drive content from. */
export const CONTENT_PATH = '/api/assets/content'

export type ContentClaim = {
  /** The owner whose connection reads it. */
  o: string
  p: StorageProviderId
  k: string
  /** Expiry, seconds since the epoch. */
  e: number
  /** `attachment` filename. */
  f?: string
}

export function contentUrl(
  claim: Omit<ContentClaim, 'e'>,
  ttlSeconds: number,
): string {
  if (!isSealingConfigured())
    throw capabilityUnavailable(
      'HQ can’t sign file links: set HQ_SEALING_KEY on the server.',
    )
  const token = seal(
    JSON.stringify({ ...claim, e: Math.floor(Date.now() / 1000) + ttlSeconds }),
  )
  return `${origin ?? ''}${CONTENT_PATH}?t=${encodeURIComponent(token)}`
}

/**
 * The claim inside a content token, or null when it is forged, garbled or
 * expired. The link's own clock is the server's: it is compared with nothing
 * stored.
 */
export function readContentToken(token: string): ContentClaim | null {
  try {
    const claim = JSON.parse(unseal(token)) as ContentClaim
    if (
      typeof claim.o !== 'string' ||
      typeof claim.k !== 'string' ||
      (claim.p !== 'r2' && claim.p !== 'gdrive') ||
      typeof claim.e !== 'number'
    )
      return null
    if (claim.e < Math.floor(Date.now() / 1000)) return null
    return claim
  } catch {
    return null
  }
}

/**
 * A provider for one owner. Throws `capability_unavailable` when R2 isn't
 * configured, and `reauth_required` when Drive is asked for but Google isn't
 * connected — each in words that say what to do.
 */
export async function providerFor(
  reader: Reader,
  ownerId: string,
  provider: StorageProviderId,
  options: { http?: typeof fetch; driveFolderId?: string | null } = {},
): Promise<StorageProvider> {
  if (override) return override(ownerId, provider)
  if (provider === 'r2') {
    const ready = storageReadiness()
    if (!ready.ok)
      throw capabilityUnavailable(
        `R2 storage isn’t set up on this server (missing ${ready.missing.join(', ')}). Choose Google Drive for this project, or ask for R2 to be configured.`,
      )
    return storageFor('r2', { ownerId })
  }
  const [connection] = await reader
    .select()
    .from(googleConnections)
    .where(eq(googleConnections.ownerId, ownerId))
    .limit(1)
  if (connection?.status !== 'connected' || !connection.driveRootId)
    throw reauthRequired(
      connection?.status === 'needs_reauth'
        ? 'Google needs you to sign in again before HQ can use your Drive. Reconnect in Settings › Google.'
        : 'Google Drive isn’t connected. Connect Google in Settings › Google, or choose R2 for this project.',
    )
  return storageFor('gdrive', {
    ownerId,
    gdrive: {
      accessToken: () => googleAccessToken(ownerId, options.http),
      // A project may keep its files in a folder of its own in the owner's Drive.
      rootFolderId: options.driveFolderId || connection.driveRootId,
      accessUrl: async (key, ttlSeconds, { filename }) =>
        contentUrl(
          {
            o: ownerId,
            p: 'gdrive',
            k: key,
            ...(filename ? { f: filename } : {}),
          },
          ttlSeconds,
        ),
      origin: origin ?? undefined,
      fetch: options.http,
    },
  })
}

/** A StorageError as the kernel's error vocabulary, so every caller answers the same way. */
export function storageFailure(error: unknown): unknown {
  if (!(error instanceof StorageError)) return error
  if (error.status === 401)
    return reauthRequired(
      'Google no longer lets HQ into your Drive. Reconnect in Settings › Google.',
    )
  if (error.status === 404)
    return new OpsError('not_found', 'That file isn’t in storage.')
  if (error.status === 429)
    return new OpsError(
      'rate_limited',
      'Storage is rate-limiting HQ. Try again in a minute.',
      { retryAfterSeconds: 60 },
    )
  if (error.status === 503 || error.status === 502)
    return new OpsError('provider_unavailable', error.message)
  if (error.status === 507)
    return capabilityUnavailable(
      'Your Google Drive is full. Free space, or choose R2 for this project.',
    )
  return new OpsError('invalid', error.message)
}
