import { describe, expect, test } from 'bun:test'
import type { MarketMarketplaceRow } from '@theiceji/hq-db/schema'
import { ETSY_API, ETSY_TOKEN_URL, etsyAdapter } from '../src/adapters/etsy'
import {
  type AdapterContext,
  type AdapterFile,
  type ListingPayload,
  ReauthRequired,
  RemoteTimeout,
} from '../src/adapters/types'

/**
 * The Etsy adapter against a fake Etsy: the same endpoints, answered from a
 * script. No network, no credentials — what it proves is the order of calls,
 * what is sent, and how answers become results.
 */

type Call = { method: string; url: string; body: unknown }

function fakeEtsy(answer: (call: Call) => Response | Promise<Response>): {
  fetch: AdapterContext['fetch']
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (input, init) => {
      const call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: init?.body,
      }
      calls.push(call)
      return answer(call)
    },
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const marketplace = {
  id: 'm1',
  kind: 'etsy',
  shop: 'PaperFog',
  externalShopId: '999',
  currency: 'USD',
  settings: {},
} as unknown as MarketMarketplaceRow

function context(
  fetch: AdapterContext['fetch'],
  credentials: Record<string, string> = {
    apiKey: 'key',
    clientId: 'client',
    accessToken: 'live-token',
    refreshToken: 'refresh',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  },
  saved: Record<string, string>[] = [],
): AdapterContext {
  return {
    marketplace,
    credentials,
    fetch,
    now: new Date(),
    saveCredentials: async (next) => {
      saved.push(next)
    },
  }
}

const payload: ListingPayload = {
  kind: 'etsy',
  marketplace: { id: 'm1', shop: 'PaperFog', externalShopId: '999' },
  title: 'Wabi-sabi wall art set',
  description: 'Six printable posters.',
  price: '12.00',
  currency: 'USD',
  tags: ['wall art', 'printable'],
  settings: { taxonomyId: '2078' },
  files: [],
  images: [],
}

const file = (name: string, mime: string): AdapterFile => ({
  assetId: name,
  sha256: 'c'.repeat(64),
  name,
  mime,
  bytes: 3,
  read: async () => new Uint8Array([1, 2, 3]),
})

describe('Etsy adapter', () => {
  test('a listing goes out as draft → files → images → active', async () => {
    const etsy = fakeEtsy((call) => {
      if (
        call.method === 'POST' &&
        call.url === `${ETSY_API}/shops/999/listings`
      )
        return json({ listing_id: 4242, state: 'draft' })
      if (call.method === 'PATCH')
        return json({
          listing_id: 4242,
          state: 'active',
          url: 'https://www.etsy.com/listing/4242',
        })
      return json({})
    })
    const result = await etsyAdapter.submit(context(etsy.fetch), {
      payload,
      idempotencyKey: 'k1',
      files: [file('set.pdf', 'application/pdf')],
      images: [file('cover.png', 'image/png')],
    })
    expect(result).toEqual({
      state: 'accepted',
      remoteListingId: '4242',
      remoteUrl: 'https://www.etsy.com/listing/4242',
      detail: { draftState: 'draft', files: 1, images: 1 },
    })
    expect(
      etsy.calls.map(
        (call) => `${call.method} ${call.url.replace(ETSY_API, '')}`,
      ),
    ).toEqual([
      'POST /shops/999/listings',
      'POST /shops/999/listings/4242/files',
      'POST /shops/999/listings/4242/images',
      'PATCH /shops/999/listings/4242',
    ])
    const form = new URLSearchParams(etsy.calls[0]?.body as URLSearchParams)
    expect(form.get('price')).toBe('12.00')
    expect(form.get('type')).toBe('download')
    expect(form.get('who_made')).toBe('i_did')
    expect(form.get('taxonomy_id')).toBe('2078')
    expect(form.getAll('tags')).toEqual(['wall art', 'printable'])
  })

  test('a write that gets no answer is unknown, never retried', async () => {
    const etsy = fakeEtsy(() => {
      throw new Error('socket hang up')
    })
    const error = await etsyAdapter
      .submit(context(etsy.fetch), {
        payload,
        idempotencyKey: 'k2',
        files: [],
        images: [],
      })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RemoteTimeout)
    expect(etsy.calls).toHaveLength(1)
  })

  test('a refusal is a result with its reason', async () => {
    const etsy = fakeEtsy(() => json({ error: 'Invalid taxonomy_id' }, 400))
    const result = await etsyAdapter.submit(context(etsy.fetch), {
      payload,
      idempotencyKey: 'k3',
      files: [],
      images: [],
    })
    expect(result.state).toBe('rejected')
    if (result.state === 'rejected') expect(result.error).toContain('taxonomy')
  })

  test('an expired token is refreshed and saved before the call; a refused refresh asks the owner', async () => {
    const saved: Record<string, string>[] = []
    const etsy = fakeEtsy((call) => {
      if (call.url === ETSY_TOKEN_URL)
        return json({
          access_token: 'fresh',
          refresh_token: 'refresh-2',
          expires_in: 3600,
        })
      return json({ listing_id: 1, state: 'active', url: null })
    })
    const stale = () => ({
      apiKey: 'key',
      clientId: 'client',
      accessToken: 'old',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    await etsyAdapter.lookup(context(etsy.fetch, stale(), saved), {
      remoteListingId: '1',
      payload,
      submittedAfter: null,
    })
    expect(saved[0]?.accessToken).toBe('fresh')
    expect(saved[0]?.refreshToken).toBe('refresh-2')

    const refused = fakeEtsy(() => json({ error: 'invalid_grant' }, 400))
    const error = await etsyAdapter
      .lookup(context(refused.fetch, stale()), {
        remoteListingId: '1',
        payload,
        submittedAfter: null,
      })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ReauthRequired)
  })

  test('a create that timed out is found by title and price — only a single match counts', async () => {
    const listing = (id: number) => ({
      listing_id: id,
      state: 'active',
      title: payload.title,
      price: { amount: 1200, divisor: 100, currency_code: 'USD' },
      created_timestamp: Math.floor(Date.now() / 1000),
    })
    let results = [listing(7)]
    const etsy = fakeEtsy((call) => {
      if (call.url.includes('/shops/999/listings?'))
        return json({
          results: call.url.includes('state=active') ? results : [],
        })
      if (call.url.endsWith('/files')) return json({ count: 1 })
      if (call.url.endsWith('/images')) return json({ count: 2 })
      return json({})
    })
    const found = await etsyAdapter.lookup(context(etsy.fetch), {
      remoteListingId: null,
      payload,
      submittedAfter: new Date(Date.now() - 60_000),
    })
    expect(found).toMatchObject({
      found: true,
      remoteListingId: '7',
      state: 'active',
      priceMinor: 1200,
      fileCount: 1,
      imageCount: 2,
    })
    results = [listing(7), listing(8)]
    const two = await etsyAdapter.lookup(context(etsy.fetch), {
      remoteListingId: null,
      payload,
      submittedAfter: null,
    })
    expect(two).toEqual({ found: false, definitive: false })
  })

  test('receipts become order lines; the ledger keeps unknown types by name', async () => {
    const etsy = fakeEtsy((call) => {
      if (call.url.includes('/receipts'))
        return json({
          count: 1,
          results: [
            {
              receipt_id: 555,
              created_timestamp: 1_790_000_000,
              status: 'Paid',
              grandtotal: { amount: 2400, divisor: 100, currency_code: 'USD' },
              transactions: [
                {
                  transaction_id: 1,
                  listing_id: 4242,
                  title: 'Set',
                  quantity: 2,
                  price: { amount: 1200, divisor: 100, currency_code: 'USD' },
                },
              ],
            },
          ],
        })
      return json({
        results: [
          {
            entry_id: 9,
            amount: -78,
            currency: 'USD',
            create_date: 1_790_000_000,
            ledger_type: 'transaction_fee',
            reference_type: 'receipt',
            reference_id: 555,
          },
          {
            entry_id: 10,
            amount: -5,
            currency: 'USD',
            create_date: 1_790_000_000,
            ledger_type: 'shipping_label_insurance',
          },
        ],
      })
    })
    const since = new Date(1_789_000_000_000)
    const orders = await etsyAdapter.syncOrders?.(context(etsy.fetch), since)
    expect(orders?.[0]).toMatchObject({
      externalOrderId: '555',
      currency: 'USD',
      status: 'paid',
      lines: [{ externalListingId: '4242', quantity: 2, unitPriceMinor: 1200 }],
    })
    const ledger = await etsyAdapter.syncLedger?.(context(etsy.fetch), since)
    expect(ledger?.map((entry) => entry.kind)).toEqual([
      { type: 'fee', feeKind: 'transaction' },
      { type: 'adjustment' },
    ])
    expect(ledger?.[1]?.description).toContain('unmapped Etsy type')
  })
})
