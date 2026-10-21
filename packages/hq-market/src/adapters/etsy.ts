import { toMinor } from '@theiceji/hq-core/money'
import type {
  AdapterContext,
  AdapterFile,
  Capability,
  ListingDispatch,
  ListingPayload,
  ListingReadBack,
  ListingSubmitted,
  MarketplaceAdapter,
  SyncedLedgerEntry,
  SyncedOrder,
} from './types'
import { ProviderUnavailable, ReauthRequired, RemoteTimeout } from './types'

/**
 * Etsy Open API v3, as a Seller App on the owner's own shop — ported from
 * the Merchant workspace onto Market's payload.
 *
 * The credential the owner stores in HQ → Settings › Connections (sealed) is
 * JSON: `{ apiKey, clientId, accessToken, refreshToken, expiresAt, shopId? }`.
 * `apiKey` is sent verbatim as `x-api-key`. Access tokens are short-lived;
 * one within a minute of expiry is refreshed first and the new pair is saved
 * back (sealed) before the call. A refresh Etsy refuses means the owner has
 * to consent again: `ReauthRequired`, never a retry loop.
 *
 * A listing goes out the way Etsy's docs describe a digital download: create
 * a draft → upload each file → upload each image → set it active. Nothing is
 * public until the last step, so a failure part-way leaves a draft, which the
 * read-back reports rather than hides.
 *
 * What Etsy has no API for is not pretended: conversations, the stats
 * dashboard, the Offsite Ads report. No sandbox exists; tests drive this
 * adapter with a fake `fetch` that implements the same endpoints.
 */

export const ETSY_API = 'https://openapi.etsy.com/v3/application'
export const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token'
const REQUEST_TIMEOUT_MS = 30_000

export const ETSY_CAPABILITIES: Capability[] = [
  {
    capability: 'create_draft_listing',
    declared: true,
    note: 'POST /shops/{shop_id}/listings with type=download.',
  },
  {
    capability: 'upload_listing_file',
    declared: true,
    note: 'POST /shops/{shop_id}/listings/{listing_id}/files — up to 5 files, 20 MB each.',
  },
  {
    capability: 'upload_listing_image',
    declared: true,
    note: 'POST /shops/{shop_id}/listings/{listing_id}/images.',
  },
  {
    capability: 'activate_listing',
    declared: true,
    note: 'PATCH /shops/{shop_id}/listings/{listing_id} state=active.',
  },
  {
    capability: 'read_listing',
    declared: true,
    note: 'GET /listings/{listing_id} — state, url, views, num_favorers.',
  },
  {
    capability: 'sync_receipts',
    declared: true,
    note: 'GET /shops/{shop_id}/receipts — each transaction carries its listing_id.',
  },
  {
    capability: 'sync_ledger',
    declared: true,
    note: 'GET /shops/{shop_id}/payment-account/ledger-entries.',
  },
  {
    capability: 'conversations',
    declared: false,
    note: 'Etsy has no API for buyer messages. Replies are owner steps.',
  },
]

type EtsyMoney = { amount: number; divisor: number; currency_code: string }

type EtsyListing = {
  listing_id: number
  state: string
  url?: string | null
  title?: string
  price?: EtsyMoney
  views?: number
  num_favorers?: number
  ending_timestamp?: number | null
  original_creation_timestamp?: number
  created_timestamp?: number
}

const minorOf = (money: EtsyMoney | undefined | null): number | null =>
  money ? Math.round((money.amount / (money.divisor || 1)) * 100) : null

const withTimeout = (): AbortSignal => AbortSignal.timeout(REQUEST_TIMEOUT_MS)

/** The shop the credential works on. */
function shopId(context: AdapterContext): string {
  const id =
    context.marketplace.externalShopId ?? context.credentials.shopId ?? null
  if (!id)
    throw new ReauthRequired(
      'The marketplace has no Etsy shop ID. Set it on the marketplace in Market.',
    )
  return id
}

async function accessToken(context: AdapterContext): Promise<string> {
  const { credentials } = context
  const expiresAt = credentials.expiresAt
    ? Date.parse(credentials.expiresAt)
    : 0
  if (
    credentials.accessToken &&
    Number.isFinite(expiresAt) &&
    expiresAt - context.now.getTime() > 60_000
  )
    return credentials.accessToken
  if (!credentials.refreshToken || !credentials.clientId)
    throw new ReauthRequired(
      'The Etsy token has expired and there is no refresh token. The owner has to connect the shop again.',
    )
  let response: Response
  try {
    response = await context.fetch(ETSY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: credentials.clientId,
        refresh_token: credentials.refreshToken,
      }),
      signal: withTimeout(),
    })
  } catch {
    throw new ProviderUnavailable('Etsy’s token endpoint did not answer.')
  }
  if (response.status === 400 || response.status === 401)
    throw new ReauthRequired(
      'Etsy refused the refresh token (revoked or expired). The owner has to consent again.',
    )
  if (!response.ok)
    throw new ProviderUnavailable(
      `Etsy’s token endpoint answered ${response.status}.`,
    )
  const body = (await response.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }
  const expires = new Date(context.now.getTime() + body.expires_in * 1000)
  const next = {
    ...credentials,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: expires.toISOString(),
  }
  await context.saveCredentials(next, expires)
  Object.assign(credentials, next)
  return body.access_token
}

type Call = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string
  query?: Record<string, string | number>
  form?: Record<string, string | string[]>
  multipart?: FormData
  /** A write whose outcome is unknown when it times out. */
  sideEffect?: boolean
}

/** Etsy said no, with a reason — a definitive answer, not an unknown one. */
export class EtsyRejected extends Error {
  readonly status: number
  constructor(status: number, body: string) {
    super(`Etsy refused the request (${status}): ${body.slice(0, 300)}`)
    this.name = 'EtsyRejected'
    this.status = status
  }
}

async function call<T>(context: AdapterContext, request: Call): Promise<T> {
  const token = await accessToken(context)
  const url = new URL(`${ETSY_API}${request.path}`)
  for (const [key, value] of Object.entries(request.query ?? {}))
    url.searchParams.set(key, String(value))
  const headers: Record<string, string> = {
    'x-api-key': context.credentials.apiKey ?? '',
    Authorization: `Bearer ${token}`,
  }
  let body: BodyInit | undefined
  if (request.form) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(request.form))
      if (Array.isArray(value))
        for (const entry of value) params.append(key, entry)
      else params.set(key, value)
    body = params
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  } else if (request.multipart) body = request.multipart
  let response: Response
  try {
    response = await context.fetch(url, {
      method: request.method,
      headers,
      body,
      signal: withTimeout(),
    })
  } catch (error) {
    if (request.sideEffect)
      throw new RemoteTimeout(
        `Etsy did not answer ${request.method} ${request.path}; it may have acted.`,
      )
    throw new ProviderUnavailable(
      `Etsy did not answer: ${error instanceof Error ? error.message : 'network error'}.`,
    )
  }
  if (response.status === 401 || response.status === 403) {
    const text = await response.text()
    if (response.status === 401 || /invalid_token|expired/i.test(text))
      throw new ReauthRequired(`Etsy refused the token: ${text.slice(0, 200)}`)
    throw new EtsyRejected(response.status, text)
  }
  if (response.status === 429 || response.status >= 500) {
    const retry = Number(response.headers.get('retry-after') ?? '60')
    if (request.sideEffect && response.status >= 500)
      throw new RemoteTimeout(
        `Etsy answered ${response.status} to ${request.method} ${request.path}; it may have acted.`,
      )
    throw new ProviderUnavailable(
      `Etsy answered ${response.status}.`,
      Number.isFinite(retry) ? retry : 60,
    )
  }
  if (!response.ok)
    throw new EtsyRejected(response.status, await response.text())
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function listingForm(
  payload: ListingPayload,
): Record<string, string | string[]> {
  const { settings } = payload
  return {
    quantity: String(settings.quantity ?? 999),
    title: payload.title,
    description: payload.description,
    price: payload.price,
    who_made: settings.whoMade ?? 'i_did',
    when_made: settings.whenMade ?? 'made_to_order',
    is_supply: 'false',
    type: 'download',
    ...(settings.taxonomyId ? { taxonomy_id: settings.taxonomyId } : {}),
    ...(payload.tags.length ? { tags: payload.tags } : {}),
  }
}

async function uploadAll(
  context: AdapterContext,
  listingId: string,
  files: AdapterFile[],
  images: AdapterFile[],
): Promise<{ files: number; images: number }> {
  const shop = shopId(context)
  let rank = 1
  for (const file of files) {
    const form = new FormData()
    form.set(
      'file',
      new Blob([new Uint8Array(await file.read())], { type: file.mime }),
      file.name,
    )
    form.set('name', file.name)
    form.set('rank', String(rank++))
    await call(context, {
      method: 'POST',
      path: `/shops/${shop}/listings/${listingId}/files`,
      multipart: form,
      sideEffect: true,
    })
  }
  rank = 1
  for (const image of images) {
    const form = new FormData()
    form.set(
      'image',
      new Blob([new Uint8Array(await image.read())], { type: image.mime }),
      image.name,
    )
    form.set('rank', String(rank++))
    await call(context, {
      method: 'POST',
      path: `/shops/${shop}/listings/${listingId}/images`,
      multipart: form,
      sideEffect: true,
    })
  }
  return { files: files.length, images: images.length }
}

async function submit(
  context: AdapterContext,
  dispatch: ListingDispatch,
): Promise<ListingSubmitted> {
  const shop = shopId(context)
  try {
    const draft = await call<EtsyListing>(context, {
      method: 'POST',
      path: `/shops/${shop}/listings`,
      form: listingForm(dispatch.payload),
      sideEffect: true,
    })
    const listingId = String(draft.listing_id)
    const uploaded = await uploadAll(
      context,
      listingId,
      dispatch.files,
      dispatch.images,
    )
    const active = await call<EtsyListing>(context, {
      method: 'PATCH',
      path: `/shops/${shop}/listings/${listingId}`,
      form: { state: 'active' },
      sideEffect: true,
    })
    return {
      state: 'accepted',
      remoteListingId: listingId,
      remoteUrl: active.url ?? draft.url ?? null,
      detail: { draftState: draft.state, ...uploaded },
    }
  } catch (error) {
    if (error instanceof EtsyRejected)
      return {
        state: 'rejected',
        error: error.message,
        retryable: error.status === 409,
      }
    throw error
  }
}

async function lookup(
  context: AdapterContext,
  query: {
    remoteListingId: string | null
    payload: ListingPayload
    submittedAfter: Date | null
  },
): Promise<ListingReadBack> {
  const shop = shopId(context)
  const priceMinor = Number(toMinor(query.payload.price, 2))
  let listing: EtsyListing | null = null
  if (query.remoteListingId) {
    try {
      listing = await call<EtsyListing>(context, {
        method: 'GET',
        path: `/listings/${query.remoteListingId}`,
      })
    } catch (error) {
      if (error instanceof EtsyRejected && error.status === 404)
        return { found: false, definitive: true }
      throw error
    }
  } else {
    // A create that timed out never told us its ID. Look for a listing made
    // since then with exactly our title and price — and only accept a single
    // match; two candidates is still unknown.
    const candidates: EtsyListing[] = []
    for (const state of ['draft', 'active', 'inactive']) {
      const page = await call<{ results: EtsyListing[] }>(context, {
        method: 'GET',
        path: `/shops/${shop}/listings`,
        query: { state, limit: 100, sort_on: 'created', sort_order: 'desc' },
      })
      candidates.push(
        ...page.results.filter(
          (entry) =>
            entry.title === query.payload.title &&
            minorOf(entry.price) === priceMinor &&
            (!query.submittedAfter ||
              (entry.created_timestamp ??
                entry.original_creation_timestamp ??
                0) *
                1000 >=
                query.submittedAfter.getTime() - 5 * 60_000),
        ),
      )
    }
    if (candidates.length !== 1)
      return { found: false, definitive: candidates.length === 0 }
    listing = candidates[0] ?? null
  }
  if (!listing) return { found: false, definitive: false }
  const id = String(listing.listing_id)
  const files = await call<{ count: number }>(context, {
    method: 'GET',
    path: `/shops/${shop}/listings/${id}/files`,
  }).catch(() => null)
  const images = await call<{ count: number }>(context, {
    method: 'GET',
    path: `/listings/${id}/images`,
  }).catch(() => null)
  return {
    found: true,
    remoteListingId: id,
    url: listing.url ?? null,
    state: listing.state,
    title: listing.title ?? null,
    priceMinor: minorOf(listing.price),
    currency: listing.price?.currency_code ?? null,
    fileCount: files?.count ?? null,
    imageCount: images?.count ?? null,
    views: typeof listing.views === 'number' ? listing.views : null,
    favorites:
      typeof listing.num_favorers === 'number' ? listing.num_favorers : null,
    endsAt: listing.ending_timestamp
      ? new Date(listing.ending_timestamp * 1000)
      : null,
  }
}

type EtsyReceipt = {
  receipt_id: number
  created_timestamp: number
  status?: string
  grandtotal?: EtsyMoney
  transactions?: {
    transaction_id: number
    listing_id: number | null
    title?: string
    quantity: number
    price: EtsyMoney
  }[]
}

const RECEIPT_STATUS: Record<string, SyncedOrder['status']> = {
  paid: 'paid',
  completed: 'completed',
  open: 'paid',
  'payment processing': 'paid',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  'fully refunded': 'refunded',
  'partially refunded': 'partially_refunded',
}

async function syncOrders(
  context: AdapterContext,
  since: Date,
): Promise<SyncedOrder[]> {
  const shop = shopId(context)
  const orders: SyncedOrder[] = []
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = await call<{ count: number; results: EtsyReceipt[] }>(
      context,
      {
        method: 'GET',
        path: `/shops/${shop}/receipts`,
        query: {
          min_created: Math.floor(since.getTime() / 1000),
          limit: 100,
          offset,
        },
      },
    )
    for (const receipt of page.results) {
      const currency =
        receipt.grandtotal?.currency_code ??
        receipt.transactions?.[0]?.price.currency_code ??
        context.marketplace.currency
      orders.push({
        externalOrderId: String(receipt.receipt_id),
        orderedAt: new Date(receipt.created_timestamp * 1000),
        currency,
        status:
          RECEIPT_STATUS[(receipt.status ?? '').toLowerCase()] ?? 'unknown',
        lines: (receipt.transactions ?? []).map((line) => ({
          externalLineId: String(line.transaction_id),
          externalListingId:
            line.listing_id === null ? null : String(line.listing_id),
          title: line.title ?? null,
          quantity: line.quantity,
          unitPriceMinor: minorOf(line.price) ?? 0,
        })),
      })
    }
    if (page.results.length < 100) break
  }
  return orders
}

type EtsyLedgerEntry = {
  entry_id: number
  amount: number
  currency: string
  description?: string
  create_date: number
  ledger_type?: string
  reference_type?: string
  reference_id?: string | number | null
}

/**
 * Etsy's ledger types, mapped to Market's vocabulary. A type not listed here
 * is kept as an `adjustment` with its own name in the description, so
 * nothing is dropped or guessed.
 */
export const ETSY_LEDGER_MAP: Record<
  string,
  SyncedLedgerEntry['kind'] | undefined
> = {
  transaction: { type: 'sale' },
  payment_gross: { type: 'sale' },
  sales_tax: { type: 'tax' },
  listing: { type: 'fee', feeKind: 'listing' },
  renew_sold: { type: 'fee', feeKind: 'renewal' },
  renew_sold_auto: { type: 'fee', feeKind: 'renewal' },
  renew_expired: { type: 'fee', feeKind: 'renewal' },
  transaction_fee: { type: 'fee', feeKind: 'transaction' },
  payment_processing_fee: { type: 'fee', feeKind: 'processing' },
  processing_fee: { type: 'fee', feeKind: 'processing' },
  offsite_ads_fee: { type: 'fee', feeKind: 'offsite_ads' },
  currency_conversion: { type: 'fee', feeKind: 'currency_conversion' },
  regulatory_operating_fee: { type: 'fee', feeKind: 'regulatory' },
  subscription: { type: 'fee', feeKind: 'subscription' },
  refund: { type: 'refund' },
  payment_refund: { type: 'refund' },
  case_refund: { type: 'chargeback' },
  chargeback: { type: 'chargeback' },
  disbursement: { type: 'payout' },
  disburse: { type: 'payout' },
  disburse2: { type: 'payout' },
}

async function syncLedger(
  context: AdapterContext,
  since: Date,
): Promise<SyncedLedgerEntry[]> {
  const shop = shopId(context)
  const entries: SyncedLedgerEntry[] = []
  const minCreated = Math.floor(since.getTime() / 1000)
  const maxCreated = Math.floor(context.now.getTime() / 1000)
  for (let offset = 0; offset < 10_000; offset += 100) {
    const page = await call<{ results: EtsyLedgerEntry[] }>(context, {
      method: 'GET',
      path: `/shops/${shop}/payment-account/ledger-entries`,
      query: {
        min_created: minCreated,
        max_created: maxCreated,
        limit: 100,
        offset,
      },
    })
    for (const entry of page.results) {
      const sourceType = (entry.ledger_type ?? 'unknown').toLowerCase()
      const mapped = ETSY_LEDGER_MAP[sourceType] ?? {
        type: 'adjustment' as const,
      }
      const isOrder = entry.reference_type === 'receipt'
      const isListing = entry.reference_type === 'listing'
      entries.push({
        externalEventId: `etsy-ledger:${entry.entry_id}`,
        kind: mapped,
        // Etsy states ledger amounts in the currency's minor unit.
        amountMinor: entry.amount,
        currency: entry.currency,
        effectiveAt: new Date(entry.create_date * 1000),
        externalOrderId:
          isOrder && entry.reference_id != null
            ? String(entry.reference_id)
            : null,
        externalListingId:
          isListing && entry.reference_id != null
            ? String(entry.reference_id)
            : null,
        description: `${entry.description ?? sourceType}${ETSY_LEDGER_MAP[sourceType] ? '' : ` (unmapped Etsy type “${sourceType}”)`}`,
        sourceType,
      })
    }
    if (page.results.length < 100) break
  }
  return entries
}

export const etsyAdapter: MarketplaceAdapter = {
  key: 'etsy_v3',
  label: 'Etsy Open API v3 (Seller App)',
  kinds: ['etsy'],
  capabilities: ETSY_CAPABILITIES,
  submit,
  lookup,
  syncOrders,
  syncLedger,
}
