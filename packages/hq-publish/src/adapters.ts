import type { PublishPlatform } from '@theiceji/hq-db/enums'
import type { PostDisclosure } from '@theiceji/hq-db/schema'

/**
 * The seam between a post and a platform's API. An
 * adapter lives inside HQ and posts through the owner's provider connection;
 * the connection's secret is opened only for the call and never leaves the
 * server.
 *
 * HQ ships no adapter yet: Facebook, YouTube and TikTok need the owner's app
 * credentials, and until one is registered a post goes out
 * by hand and is recorded with `recordManualPost`. Tests register a fake
 * one. What an adapter must never do: post anything the dispatch didn't hand
 * it, retry a submit on its own, or report a post it didn't read back as
 * verified.
 */

/** Exactly what leaves HQ — the authorization's payload hash covers all of it. */
export type PublishPayload = {
  platform: PublishPlatform
  account: {
    id: string
    handle: string
    externalAccountId: string | null
  }
  title: string | null
  caption: string
  disclosure: PostDisclosure
  asset: {
    id: string
    /** The SHA-256, or `size:<bytes>` for a file too big to hash (its identity is frozen anyway). */
    sha256: string
    mime: string
    name: string
  } | null
}

export type AdapterContext = {
  connection: {
    id: string
    config: Record<string, unknown>
    /** The unsealed secret, for this call only. */
    secret: string
  }
  fetch: typeof fetch
  /** A short-lived URL to the asset's bytes, when the post carries one. */
  assetUrl: () => Promise<string | null>
  /** The dispatch's idempotency key — send it where the platform takes one. */
  idempotencyKey: string
}

export type Submitted = {
  remotePostId: string | null
  remoteUrl: string | null
  publishedAt: Date | null
  /** True only when the platform's own answer shows the post live. */
  verified: boolean
  fields?: Record<string, unknown>
}

export type ReadBack =
  | {
      state: 'found'
      remotePostId: string
      remoteUrl: string | null
      publishedAt: Date | null
      fields: Record<string, unknown>
    }
  | { state: 'pending' }
  | { state: 'missing'; reason: string }

/** The request may or may not have reached the platform — reconcile, never resend. */
export class RemoteUnknown extends Error {}
/** The platform refused it; nothing was posted. */
export class RemoteRejected extends Error {}
/** The connection's grant is gone or expired; the owner has to reconnect. */
export class RemoteReauth extends Error {}

export interface PublishAdapter {
  platform: PublishPlatform
  label: string
  submit(payload: PublishPayload, context: AdapterContext): Promise<Submitted>
  lookup(
    ref: { remotePostId: string | null; idempotencyKey: string },
    payload: PublishPayload,
    context: AdapterContext,
  ): Promise<ReadBack>
}

const adapters = new Map<PublishPlatform, PublishAdapter>()

export function registerPublishAdapter(adapter: PublishAdapter): void {
  adapters.set(adapter.platform, adapter)
}

export function publishAdapter(platform: string): PublishAdapter | null {
  return adapters.get(platform as PublishPlatform) ?? null
}

/** For tests. */
export function resetPublishAdapters(): void {
  adapters.clear()
}
