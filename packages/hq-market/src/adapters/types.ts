import type { MarketKind } from '@theiceji/hq-db/enums'
import type {
  MarketMarketplaceRow,
  MarketplaceSettings,
} from '@theiceji/hq-db/schema'

/**
 * What a marketplace adapter is (ported from the Merchant
 * adapters).
 *
 * An adapter runs inside HQ: the dispatch hands it one listing with the exact
 * authorized payload and the file bytes (checked against the authorized
 * hashes first), and it reports what the marketplace said. Accepted is not
 * verified — only `lookup`, a read-back, makes a listing verified. A request
 * that left without an answer is thrown as `RemoteTimeout` and reconciled by
 * looking, never by sending again.
 *
 * Every capability is declared by the adapter and stays declared until a
 * live test records it; nothing counts it as working because the code exists.
 */

/** Exactly what leaves HQ — the authorization's payload hash covers all of it. */
export type ListingPayload = {
  kind: MarketKind
  marketplace: {
    id: string
    shop: string
    externalShopId: string | null
  }
  title: string
  description: string
  /** A decimal string in `currency`. */
  price: string
  currency: string
  tags: string[]
  settings: MarketplaceSettings
  /** What the buyer downloads, then what the listing shows — in order. */
  files: ListingFileRef[]
  images: ListingFileRef[]
}

export type ListingFileRef = {
  assetId: string
  /** The SHA-256, or `size:<bytes>` for a file too big to hash. */
  sha256: string
  name: string
  mime: string
}

export type AdapterFile = ListingFileRef & {
  bytes: number
  /** The bytes, checked against `sha256` before they are returned. */
  read: () => Promise<Uint8Array>
}

export type ListingDispatch = {
  payload: ListingPayload
  idempotencyKey: string
  files: AdapterFile[]
  images: AdapterFile[]
}

export type ListingSubmitted =
  | {
      state: 'accepted'
      remoteListingId: string
      remoteUrl: string | null
      detail?: Record<string, unknown>
    }
  | { state: 'rejected'; error: string; retryable: boolean }

export type ListingReadBack =
  | {
      found: true
      remoteListingId: string
      url: string | null
      /** The marketplace's own word: active, draft, inactive, expired, removed… */
      state: string
      title: string | null
      priceMinor: number | null
      currency: string | null
      fileCount: number | null
      imageCount: number | null
      views: number | null
      favorites: number | null
      endsAt: Date | null
    }
  | { found: false; definitive: boolean }

export type SyncedOrder = {
  externalOrderId: string
  orderedAt: Date
  currency: string
  status:
    | 'paid'
    | 'completed'
    | 'partially_refunded'
    | 'refunded'
    | 'cancelled'
    | 'unknown'
  lines: {
    externalLineId: string
    externalListingId: string | null
    title: string | null
    quantity: number
    unitPriceMinor: number
  }[]
}

export type SyncedLedgerEntry = {
  externalEventId: string
  kind:
    | { type: 'sale' | 'tax' | 'refund' | 'chargeback' | 'adjustment' }
    | {
        type: 'fee'
        feeKind:
          | 'listing'
          | 'renewal'
          | 'transaction'
          | 'processing'
          | 'offsite_ads'
          | 'currency_conversion'
          | 'regulatory'
          | 'subscription'
          | 'other'
      }
    | { type: 'payout' }
  amountMinor: number
  currency: string
  effectiveAt: Date
  externalOrderId: string | null
  externalListingId: string | null
  description: string
  /** The marketplace's own type name, kept for the mapping review. */
  sourceType: string
}

/** The HTTP transport an adapter uses — `fetch`, or a fake one in tests. */
export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type AdapterContext = {
  marketplace: MarketMarketplaceRow
  /** Unsealed for this call only. Never logged, never returned. */
  credentials: Record<string, string>
  /** Persist refreshed tokens (sealed again by the caller). */
  saveCredentials: (
    next: Record<string, string>,
    expiresAt: Date | null,
  ) => Promise<void>
  fetch: Fetcher
  now: Date
}

export type Capability = {
  capability: string
  /** Declared by the provider's documentation; a live test makes it tested. */
  declared: boolean
  note: string
}

export interface MarketplaceAdapter {
  key: string
  label: string
  kinds: MarketKind[]
  capabilities: Capability[]
  submit(
    context: AdapterContext,
    dispatch: ListingDispatch,
  ): Promise<ListingSubmitted>
  lookup(
    context: AdapterContext,
    query: {
      remoteListingId: string | null
      payload: ListingPayload
      submittedAfter: Date | null
    },
  ): Promise<ListingReadBack>
  syncOrders?(context: AdapterContext, since: Date): Promise<SyncedOrder[]>
  syncLedger?(
    context: AdapterContext,
    since: Date,
  ): Promise<SyncedLedgerEntry[]>
}

/** Thrown when a request left and no answer came back — the outcome is unknown. */
export class RemoteTimeout extends Error {
  constructor(message = 'The marketplace did not answer in time.') {
    super(message)
    this.name = 'RemoteTimeout'
  }
}

/** Thrown when the marketplace refuses the credential: the owner must sign in again. */
export class ReauthRequired extends Error {
  constructor(
    message = 'The marketplace refused the token. The owner has to connect it again.',
  ) {
    super(message)
    this.name = 'ReauthRequired'
  }
}

/** A marketplace error worth waiting out (429, 5xx). */
export class ProviderUnavailable extends Error {
  readonly retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds = 60) {
    super(message)
    this.name = 'ProviderUnavailable'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const adapters = new Map<MarketKind, MarketplaceAdapter>()

export function registerMarketplaceAdapter(adapter: MarketplaceAdapter): void {
  for (const kind of adapter.kinds) adapters.set(kind, adapter)
}

export function marketplaceAdapter(kind: string): MarketplaceAdapter | null {
  return adapters.get(kind as MarketKind) ?? null
}

/** For tests. */
export function resetMarketplaceAdapters(): void {
  adapters.clear()
}
