import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { moneySources, subjectProvider } from '@theiceji/hq-core/readings'
import {
  assetAssets,
  marketSalesEvents,
  opsReleaseAuthorizations,
  providerConnections,
} from '@theiceji/hq-db/schema'
import { savePolicy } from '@theiceji/hq-ops/policy'
import { seal } from '@theiceji/hq-ops/secrets'
import {
  closeTestDb,
  dbTestsEnabled,
  failure,
  pgError,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import { eq, sql } from 'drizzle-orm'
import {
  type MarketplaceAdapter,
  RemoteTimeout,
  registerMarketplaceAdapter,
  resetMarketplaceAdapters,
} from '../src/adapters/types'
import {
  approveListing,
  dispatchListing,
  getListing,
  listListings,
  listMarketplaces,
  listProducts,
  planListing,
  reconcileMarket,
  recordManualListing,
  saveMarketplace,
  saveProduct,
  setProductFiles,
  updateListing,
} from '../src/market'
import {
  confirmPayout,
  listSales,
  marketSummaries,
  recordPayout,
  recordSale,
  syncMarketplace,
} from '../src/sales'
import '../src/register'

/**
 * Market against Postgres. Destructive (truncates), so it runs only with
 * MARKET_DB_TESTS=1 and a localhost DATABASE_URL — a throwaway database.
 */

const suite = dbTestsEnabled('MARKET_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'market_sales_events',
  'market_payouts',
  'market_intents',
  'market_listings',
  'market_product_files',
  'market_products',
  'market_marketplaces',
  'asset_assets',
]

process.env.HQ_SEALING_KEY ??= Buffer.alloc(32, 7).toString('base64')

const HOUR = 3_600_000

suite('hq-market against Postgres', () => {
  let w: World

  beforeEach(async () => {
    w = await resetWorld(TABLES, { kind: 'digital_assets' })
  })
  afterEach(() => resetMarketplaceAdapters())
  afterAll(() => closeTestDb(TABLES))

  async function file(name: string, kind: 'image' | 'doc') {
    const [row] = await w.db
      .insert(assetAssets)
      .values({
        ownerId: w.owner.userId,
        createdBy: w.owner.userId,
        projectId: w.project.id,
        storageProvider: 'r2',
        storageKey: `k/${crypto.randomUUID()}`,
        path: `pilot/${name}`,
        name,
        kind,
        mime: kind === 'image' ? 'image/png' : 'application/pdf',
        bytes: 4096,
        sha256: 'b'.repeat(64),
        status: 'ready',
        readyAt: sql`now()`,
        actorType: 'user',
        actorId: w.owner.userId,
      })
      .returning()
    if (!row) throw new Error('no asset')
    return row
  }

  async function shop(kind: 'etsy' | 'manual' = 'manual') {
    return saveMarketplace(w.owner, {
      projectId: w.project.id,
      kind,
      shop: kind === 'etsy' ? 'PaperFog' : 'Own store',
      currency: 'USD',
      feeSheet: { transactionPct: '6.5', listingFee: '0.20' },
    })
  }

  async function product(actor = w.owner) {
    const row = await saveProduct(actor, {
      projectId: w.project.id,
      title: 'Wabi-sabi wall art set',
      description: 'Six printable posters.',
      price: '12.00',
      currency: 'USD',
      tags: ['Wall Art', 'printable', 'wall art'],
      idempotencyKey: 'product-0001',
    })
    const pdf = await file('set.pdf', 'doc')
    const png = await file('cover.png', 'image')
    return setProductFiles(actor, {
      productId: row.id,
      expectedRevision: row.revision,
      files: [
        { assetId: pdf.id, role: 'deliverable' },
        { assetId: png.id, role: 'preview' },
      ],
    })
  }

  test('marketplaces are the owner’s; products and files are drafting', async () => {
    const refused = await failure(
      saveMarketplace(w.agent, {
        projectId: w.project.id,
        kind: 'manual',
        shop: 'Nope',
      }),
    )
    expect(refused.code).toBe('forbidden')
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['draft'],
    })
    const own = await shop()
    expect(own.currency).toBe('USD')
    const made = await product(w.agent)
    expect(made.tags).toEqual(['wall art', 'printable'])
    expect(made.files.map((entry) => entry.role)).toEqual([
      'deliverable',
      'preview',
    ])
    const [view] = await listMarketplaces(w.owner, { projectId: w.project.id })
    expect(view?.readiness.mode).toBe('manual')
    expect(
      (await listProducts(w.owner, { projectId: w.project.id }))[0]?.files,
    ).toHaveLength(2)
  })

  test('plan → approve → list by hand; the rules of the shop block in words', async () => {
    const etsy = await shop('etsy')
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['draft', 'list'],
      allowedAccountIds: [etsy.id],
    })
    const made = await product(w.agent)
    const listing = await planListing(w.agent, {
      productId: made.id,
      marketplaceId: etsy.id,
      idempotencyKey: 'listing-0001',
    })
    expect(listing.status).toBe('planned')
    expect(listing.price).toBe('12.00')
    expect(listing.title).toBe(made.title)
    const again = await failure(
      planListing(w.owner, { productId: made.id, marketplaceId: etsy.id }),
    )
    expect(again.message).toContain('already listed')

    // A tag longer than Etsy allows blocks the approval.
    const long = await updateListing(w.owner, {
      listingId: listing.id,
      expectedRevision: listing.revision,
      tags: ['a tag that is far too long for etsy'],
    })
    const blocked = await approveListing(w.owner, { listingId: long.id })
    expect(blocked.blockers.map((entry) => entry.key)).toEqual(['tag_long'])
    const fixed = await updateListing(w.owner, {
      listingId: listing.id,
      expectedRevision: long.revision,
      tags: ['wall art'],
    })
    const noClearance = await failure(
      recordManualListing(w.agent, {
        listingId: listing.id,
        url: 'https://www.etsy.com/listing/1',
      }),
    )
    expect(noClearance.code).toBe('policy_blocked')
    const approved = await approveListing(w.owner, {
      listingId: listing.id,
      expectedRevision: fixed.revision,
    })
    expect(approved.listing.status).toBe('approved')
    const live = await recordManualListing(w.agent, {
      listingId: listing.id,
      url: 'https://www.etsy.com/listing/1',
      idempotencyKey: 'listed-0001',
    })
    expect(live.status).toBe('listed')
    expect(live.evidenceLevel).toBe('agent_attested')
    const auths = await w.db
      .select()
      .from(opsReleaseAuthorizations)
      .where(eq(opsReleaseAuthorizations.subjectId, listing.id))
    expect(auths.map((row) => row.status)).toEqual(['consumed'])
    const [summary] = await marketSummaries(w.owner)
    expect(summary?.live).toBe(1)
  })

  test('changing the files un-approves a listing', async () => {
    const own = await shop()
    const made = await product()
    const listing = await planListing(w.owner, {
      productId: made.id,
      marketplaceId: own.id,
    })
    const approved = await approveListing(w.owner, { listingId: listing.id })
    expect(approved.listing.status).toBe('approved')
    const extra = await file('extra.pdf', 'doc')
    await setProductFiles(w.owner, {
      productId: made.id,
      expectedRevision: made.revision,
      files: [
        ...made.files.map((entry) => ({ assetId: entry.id, role: entry.role })),
        { assetId: extra.id, role: 'deliverable' as const },
      ],
    })
    const detail = await getListing(w.owner, listing.id)
    expect(detail.listing.status).toBe('planned')
    expect(detail.listing.statusReason).toContain('files changed')
    expect(detail.clearance).toBeNull()
  })

  test('money lines: sale, refund, fee — exact, append-only, corrections supersede', async () => {
    const own = await shop()
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['import'],
    })
    const sale = await recordSale(w.agent, {
      marketplaceId: own.id,
      kind: 'sale',
      amount: '12.00',
      fees: '1.08',
      orderRef: 'R1:1',
    })
    expect([sale.gross, sale.fees, sale.net]).toEqual([
      '12.00',
      '1.08',
      '10.92',
    ])
    const dup = await failure(
      recordSale(w.owner, {
        marketplaceId: own.id,
        kind: 'sale',
        amount: '12.00',
        orderRef: 'R1:1',
      }),
    )
    expect(pgError(dup).code === '23505' || dup.code === 'conflict').toBe(true)
    const refund = await recordSale(w.owner, {
      marketplaceId: own.id,
      kind: 'refund',
      amount: '12.00',
    })
    expect(refund.net).toBe('-12.00')
    const fee = await recordSale(w.owner, {
      marketplaceId: own.id,
      kind: 'fee',
      amount: '0.20',
    })
    expect([fee.gross, fee.fees, fee.net]).toEqual(['0.00', '0.20', '-0.20'])
    const fixed = await recordSale(w.owner, {
      marketplaceId: own.id,
      kind: 'sale',
      amount: '13.00',
      fees: '1.17',
      orderRef: 'R1:1',
      supersedesId: sale.id,
      correctionReason: 'The price included a coupon I missed.',
    })
    const lines = await listSales(w.owner, { projectId: w.project.id })
    expect(lines.find((line) => line.id === sale.id)?.supersededBy).toBe(
      fixed.id,
    )
    const locked = await failure(
      w.db
        .update(marketSalesEvents)
        .set({ note: 'x' })
        .where(eq(marketSalesEvents.id, sale.id)),
    )
    expect(pgError(locked).code).toBe('23001')
    const source = moneySources().find((entry) => entry.module === 'market')
    const money = await source?.lines(w.db, w.owner.userId, {
      from: new Date(Date.now() - HOUR),
      to: new Date(Date.now() + HOUR),
      projectId: null,
    })
    const kinds = (money ?? [])
      .map((line) => `${line.kind}:${line.amount}`)
      .sort()
    expect(kinds).toEqual([
      'fees:-0.20',
      'fees:-1.17',
      'refunds:-12.00',
      'sales:13.00',
    ])
  })

  test('payouts: expected until the owner confirms', async () => {
    const own = await shop()
    const payout = await recordPayout(w.owner, {
      marketplaceId: own.id,
      amount: '120.50',
      expectedOn: '2026-10-05',
      reference: 'P-1',
    })
    expect(payout.status).toBe('expected')
    const agent = await failure(
      confirmPayout(w.agent, {
        payoutId: payout.id,
        expectedRevision: payout.revision,
        paidOn: '2026-10-06',
      }),
    )
    expect(agent.code).toBe('forbidden')
    const paid = await confirmPayout(w.owner, {
      payoutId: payout.id,
      expectedRevision: payout.revision,
      paidOn: '2026-10-06',
      amount: '119.90',
    })
    expect([paid.status, paid.amount, paid.paidOn]).toEqual([
      'confirmed',
      '119.90',
      '2026-10-06',
    ])
  })

  test('a listing at an age: sales since it went out, zero only when the shop was read past it', async () => {
    const own = await shop()
    const made = await product()
    const listing = await planListing(w.owner, {
      productId: made.id,
      marketplaceId: own.id,
    })
    const live = await recordManualListing(w.owner, {
      listingId: listing.id,
      url: 'https://shop.example/p/1',
      listedAt: new Date(Date.now() - 100 * HOUR),
    })
    const provider = subjectProvider('listing')
    if (!provider) throw new Error('no listing provider')
    let read = await provider.atAge(
      w.db,
      w.owner.userId,
      [live.id],
      'sales',
      72,
      new Date(),
    )
    // Nothing was recorded for the shop yet: not read, never 0.
    expect(read.get(live.id)?.state).toBe('not_read')
    await recordSale(w.owner, {
      marketplaceId: own.id,
      listingId: live.id,
      kind: 'sale',
      amount: '12.00',
      quantity: 2,
      occurredAt: new Date(Date.now() - 90 * HOUR),
    })
    await recordSale(w.owner, {
      marketplaceId: own.id,
      listingId: live.id,
      kind: 'sale',
      amount: '12.00',
      occurredAt: new Date(Date.now() - 1 * HOUR),
    })
    read = await provider.atAge(
      w.db,
      w.owner.userId,
      [live.id],
      'sales',
      72,
      new Date(),
    )
    expect(read.get(live.id)).toMatchObject({ state: 'known', value: '2' })
    read = await provider.latest(
      w.db,
      w.owner.userId,
      [live.id],
      'gross',
      new Date(),
    )
    expect(read.get(live.id)).toMatchObject({ state: 'known', value: '24.00' })
    read = await provider.atAge(
      w.db,
      w.owner.userId,
      [live.id],
      'sales',
      500,
      new Date(),
    )
    expect(read.get(live.id)?.state).toBe('too_young')
  })

  test('API dispatch through an adapter: unknown, then read back as verified', async () => {
    const etsy = await shop('etsy')
    const made = await product()
    const listing = await planListing(w.owner, {
      productId: made.id,
      marketplaceId: etsy.id,
    })
    await approveListing(w.owner, { listingId: listing.id })
    const [connection] = await w.db
      .insert(providerConnections)
      .values({
        ownerId: w.owner.userId,
        createdBy: w.owner.userId,
        provider: 'etsy',
        label: 'Etsy (test)',
        secretSealed: seal(JSON.stringify({ apiKey: 'k', accessToken: 't' })),
        status: 'connected',
      })
      .returning()
    await saveMarketplace(w.owner, {
      projectId: w.project.id,
      marketplaceId: etsy.id,
      kind: 'etsy',
      shop: etsy.shop,
      currency: 'USD',
      externalShopId: '999',
      connectionId: connection?.id,
    })
    // The shop's ID is part of what goes out: the approval no longer fits.
    const stale = await getListing(w.owner, listing.id)
    expect(stale.listing.status).toBe('planned')
    expect(stale.listing.statusReason).toContain('marketplace changed')
    await approveListing(w.owner, { listingId: listing.id })
    const fake: MarketplaceAdapter = {
      key: 'fake',
      label: 'Fake Etsy',
      kinds: ['etsy'],
      capabilities: [],
      async submit(context, dispatch) {
        expect(context.credentials.apiKey).toBe('k')
        expect(dispatch.payload.files).toHaveLength(1)
        expect(dispatch.payload.images).toHaveLength(1)
        throw new RemoteTimeout()
      },
      async lookup(_context, query) {
        expect(query.remoteListingId).toBeNull()
        return {
          found: true,
          remoteListingId: '4242',
          url: 'https://www.etsy.com/listing/4242',
          state: 'active',
          title: query.payload.title,
          priceMinor: 1200,
          currency: 'USD',
          fileCount: 1,
          imageCount: 1,
          views: 0,
          favorites: 0,
          endsAt: null,
        }
      },
      async syncOrders() {
        return [
          {
            externalOrderId: '555',
            orderedAt: new Date(),
            currency: 'USD',
            status: 'paid',
            lines: [
              {
                externalLineId: '1',
                externalListingId: '4242',
                title: 'Wabi-sabi',
                quantity: 1,
                unitPriceMinor: 1200,
              },
            ],
          },
        ]
      },
      async syncLedger() {
        return [
          {
            externalEventId: 'etsy-ledger:9',
            kind: { type: 'fee', feeKind: 'transaction' },
            amountMinor: -78,
            currency: 'USD',
            effectiveAt: new Date(),
            externalOrderId: '555',
            externalListingId: null,
            description: 'Transaction fee',
            sourceType: 'transaction_fee',
          },
        ]
      },
    }
    registerMarketplaceAdapter(fake)
    const sent = await dispatchListing(w.owner, {
      listingId: listing.id,
      idempotencyKey: 'dispatch-listing-01',
    })
    expect(sent.result).toBe('unknown')
    await w.db.execute(
      sql`update market_intents set next_attempt_at = now() - interval '1 second'`,
    )
    const tally = await reconcileMarket({ ownerId: w.owner.userId })
    expect(tally.verified).toBe(1)
    const detail = await getListing(w.owner, listing.id)
    expect(detail.listing.status).toBe('verified')
    expect(detail.listing.externalId).toBe('4242')

    const first = await syncMarketplace(w.owner, etsy.id)
    expect(first).toMatchObject({ sales: 1, fees: 1, unmatched: 0 })
    const second = await syncMarketplace(w.owner, etsy.id)
    expect(second).toMatchObject({ sales: 0, fees: 0 })
    const lines = await listSales(w.owner, { projectId: w.project.id })
    expect(lines.map((line) => `${line.kind}:${line.net}`).sort()).toEqual([
      'fee:-0.78',
      'sale:12.00',
    ])
    const [row] = await listListings(w.owner, { projectId: w.project.id })
    expect(row?.status).toBe('verified')
  })
})
