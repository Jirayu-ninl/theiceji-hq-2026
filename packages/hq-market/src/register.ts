import { digitsOf, fromMinor, toMinor } from '@theiceji/hq-core/money'
import {
  type AgeReading,
  type MoneyLine,
  registerMoneySource,
  registerSubject,
  type SubjectSummary,
} from '@theiceji/hq-core/readings'
import { everyWord, registerSearch } from '@theiceji/hq-core/search'
import {
  marketListings,
  marketMarketplaces,
  marketProducts,
  marketSalesEvents,
  projects,
} from '@theiceji/hq-db/schema'
import type { Reader } from '@theiceji/hq-ops/db'
import { registerTickStep } from '@theiceji/hq-ops/runtime'
import { and, desc, eq, inArray, max, sql } from 'drizzle-orm'
import { etsyAdapter } from './adapters/etsy'
import { registerMarketplaceAdapter } from './adapters/types'
import { reconcileMarket } from './market'
import { MARKET_RULES } from './payload'
import { saleLinesBetween, saleLinesOf, syncDueMarketplaces } from './sales'

/**
 * What Market adds to HQ's shared registries when it loads — import this
 * once in every process that runs module services (apps/hq, apps/hq-mcp):
 *
 * · the Etsy adapter (dispatch, read-back, orders and ledger);
 * · products and listings in `hq_search` and the ⌘K palette;
 * · listings as experiment subjects — sales and money at an age;
 * · sales, refunds and fees as money lines for the dashboard and Home;
 * · the `market.reconcile` and `market.sync` tick steps.
 */

registerMarketplaceAdapter(etsyAdapter)

export const listingHref = (slug: string, listingId: string) =>
  `/p/${slug}/market?listing=${listingId}`
export const productHref = (slug: string, productId: string) =>
  `/p/${slug}/market?view=products&product=${productId}`

registerSearch({
  type: 'listing',
  label: 'Listings',
  async search(reader, { ownerId, words, projectId, limit }) {
    const rows = await reader
      .select({
        id: marketListings.id,
        title: marketListings.title,
        status: marketListings.status,
        projectId: marketListings.projectId,
        slug: projects.slug,
        shop: marketMarketplaces.shop,
      })
      .from(marketListings)
      .innerJoin(projects, eq(projects.id, marketListings.projectId))
      .innerJoin(
        marketMarketplaces,
        eq(marketMarketplaces.id, marketListings.marketplaceId),
      )
      .where(
        and(
          eq(marketListings.ownerId, ownerId),
          projectId ? eq(marketListings.projectId, projectId) : undefined,
          everyWord([marketListings.title, marketListings.description], words),
        ),
      )
      .orderBy(desc(marketListings.updatedAt))
      .limit(limit)
    return rows.map((row) => ({
      type: 'listing',
      id: row.id,
      title: row.title,
      projectId: row.projectId,
      href: listingHref(row.slug, row.id),
      detail: `${row.status} · ${row.shop}`,
    }))
  },
})

registerSearch({
  type: 'product',
  label: 'Products',
  async search(reader, { ownerId, words, projectId, limit }) {
    const rows = await reader
      .select({
        id: marketProducts.id,
        title: marketProducts.title,
        status: marketProducts.status,
        projectId: marketProducts.projectId,
        slug: projects.slug,
      })
      .from(marketProducts)
      .innerJoin(projects, eq(projects.id, marketProducts.projectId))
      .where(
        and(
          eq(marketProducts.ownerId, ownerId),
          projectId ? eq(marketProducts.projectId, projectId) : undefined,
          everyWord([marketProducts.title, marketProducts.description], words),
        ),
      )
      .orderBy(desc(marketProducts.updatedAt))
      .limit(limit)
    return rows.map((row) => ({
      type: 'product',
      id: row.id,
      title: row.title,
      projectId: row.projectId,
      href: productHref(row.slug, row.id),
      detail: row.status,
    }))
  },
})

async function describeListings(
  reader: Reader,
  ownerId: string,
  where: ReturnType<typeof and>,
  limit: number,
): Promise<(SubjectSummary & { marketplaceId: string })[]> {
  const rows = await reader
    .select({
      id: marketListings.id,
      projectId: marketListings.projectId,
      title: marketListings.title,
      status: marketListings.status,
      listedAt: marketListings.listedAt,
      marketplaceId: marketListings.marketplaceId,
      kind: marketMarketplaces.kind,
      shop: marketMarketplaces.shop,
      slug: projects.slug,
    })
    .from(marketListings)
    .innerJoin(
      marketMarketplaces,
      eq(marketMarketplaces.id, marketListings.marketplaceId),
    )
    .innerJoin(projects, eq(projects.id, marketListings.projectId))
    .where(and(eq(marketListings.ownerId, ownerId), where))
    .orderBy(
      sql`coalesce(${marketListings.listedAt}, ${marketListings.createdAt}) desc`,
    )
    .limit(limit)
  return rows.map((row) => ({
    type: 'listing',
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    where: `${MARKET_RULES[row.kind].label} · ${row.shop}`,
    status: row.status,
    wentOutAt: ['listed', 'verified', 'inactive'].includes(row.status)
      ? row.listedAt
      : null,
    href: listingHref(row.slug, row.id),
    marketplaceId: row.marketplaceId,
  }))
}

registerSubject({
  type: 'listing',
  module: 'market',
  /** Units sold · what buyers paid · what reached the owner. */
  metrics: ['sales', 'gross', 'net'],
  describe: async (reader, ownerId, ids) =>
    ids.length
      ? describeListings(
          reader,
          ownerId,
          inArray(marketListings.id, [...ids]),
          ids.length,
        )
      : [],
  list: (reader, ownerId, { projectId, limit }) =>
    describeListings(
      reader,
      ownerId,
      projectId ? eq(marketListings.projectId, projectId) : undefined,
      limit,
    ),
  /**
   * Sales up to an age are a sum, and zero is a real answer only when the
   * shop is known to have been read past that age — synced by HQ, or with a
   * line recorded after it. Otherwise it is `not_read`, never 0.
   */
  atAge: (reader, ownerId, ids, metric, ageHours, now) =>
    salesUpTo(
      reader,
      ownerId,
      ids,
      metric,
      now,
      (wentOut) => wentOut.getTime() + ageHours * 3_600_000,
    ),
  /** To date: the sum up to the last moment the shop is known to have been read. */
  latest: (reader, ownerId, ids, metric, now) =>
    salesUpTo(reader, ownerId, ids, metric, now, null),
})

/**
 * Each listing's sales (units, gross or net) up to a moment: `until(wentOut)`
 * for an age, or — with `until` null — as far as the shop has been read.
 */
async function salesUpTo(
  reader: Reader,
  ownerId: string,
  ids: readonly string[],
  metric: string,
  now: Date,
  until: ((wentOut: Date) => number) | null,
): Promise<Map<string, AgeReading>> {
  const out = new Map<string, AgeReading>()
  if (ids.length === 0) return out
  const listings = await describeListings(
    reader,
    ownerId,
    inArray(marketListings.id, [...ids]),
    ids.length,
  )
  const shops = [...new Set(listings.map((row) => row.marketplaceId))]
  const [lines, readThrough] = await Promise.all([
    saleLinesOf(reader, ownerId, ids),
    shops.length
      ? reader
          .select({
            id: marketMarketplaces.id,
            currency: marketMarketplaces.currency,
            syncedAt: marketMarketplaces.syncedAt,
            lastLine: max(marketSalesEvents.createdAt),
          })
          .from(marketMarketplaces)
          .leftJoin(
            marketSalesEvents,
            eq(marketSalesEvents.marketplaceId, marketMarketplaces.id),
          )
          .where(inArray(marketMarketplaces.id, shops))
          .groupBy(marketMarketplaces.id)
      : Promise.resolve([]),
  ])
  for (const listing of listings) {
    if (!listing.wentOutAt) {
      out.set(listing.id, { state: 'not_out' })
      continue
    }
    const shop = readThrough.find((row) => row.id === listing.marketplaceId)
    const seen = Math.min(
      now.getTime(),
      Math.max(
        shop?.syncedAt?.getTime() ?? 0,
        shop?.lastLine ? new Date(shop.lastLine).getTime() : 0,
      ),
    )
    const target = until ? until(listing.wentOutAt) : seen
    if (until && target > now.getTime()) {
      out.set(listing.id, { state: 'too_young', readyAt: new Date(target) })
      continue
    }
    if (seen < target || seen < listing.wentOutAt.getTime()) {
      out.set(listing.id, { state: 'not_read' })
      continue
    }
    const mine = lines.filter(
      (line) =>
        line.listingId === listing.id && line.occurredAt.getTime() <= target,
    )
    const currency = shop?.currency ?? mine[0]?.currency ?? 'USD'
    const digits = digitsOf(currency)
    const value =
      metric === 'sales'
        ? String(
            mine
              .filter((line) => line.kind === 'sale')
              .reduce((n, line) => n + line.quantity, 0),
          )
        : fromMinor(
            mine
              .filter((line) => line.currency === currency)
              .reduce(
                (sum, line) =>
                  sum +
                  toMinor(metric === 'gross' ? line.gross : line.net, digits),
                0n,
              ),
            digits,
          )
    out.set(listing.id, {
      state: 'known',
      value,
      asOf: new Date(target),
      currency: metric === 'sales' ? null : currency,
    })
  }
  return out
}

registerMoneySource({
  module: 'market',
  async lines(reader, ownerId, range) {
    const rows = await saleLinesBetween(reader, ownerId, range)
    const out: MoneyLine[] = []
    for (const row of rows) {
      const base = {
        module: 'market' as const,
        projectId: row.projectId,
        currency: row.currency,
        at: row.occurredAt,
      }
      if (row.kind === 'sale')
        out.push({ ...base, kind: 'sales', amount: row.gross })
      else if (row.kind === 'refund')
        out.push({ ...base, kind: 'refunds', amount: row.gross })
      else if (row.kind === 'adjustment')
        out.push({ ...base, kind: 'sales', amount: row.net })
      if (!/^0(\.0+)?$/.test(row.fees))
        out.push({ ...base, kind: 'fees', amount: `-${row.fees}` })
    }
    return out
  },
})

registerTickStep('market.reconcile', () => reconcileMarket({ limit: 10 }))
registerTickStep('market.sync', () => syncDueMarketplaces({ limit: 2 }))
