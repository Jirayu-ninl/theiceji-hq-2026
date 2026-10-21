import 'server-only'
import { previewsFor } from '@theiceji/hq-assets/assets'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import {
  getListing,
  listListings,
  listMarketplaces,
  listProducts,
} from '@theiceji/hq-market/market'
import '@theiceji/hq-market/register'
import { listPayouts, listSales } from '@theiceji/hq-market/sales'
import type { Actor } from '@theiceji/hq-ops/access'
import { connectionOptions, fileOptions } from '@/lib/module-page'
import type { MarketPageProps } from './components/MarketPage'
import {
  type ListingDetailData,
  listingDetailData,
  listingRowData,
  marketplaceData,
  productData,
  saleData,
} from './data'

/**
 * What the Market page reads on the server: marketplaces, products, listings
 * (the selected one whole), money lines and payouts, the project's ready
 * files for product pickers, and the owner's shop connections.
 */
export async function loadMarket(
  actor: Actor,
  project: ProjectRow,
  params: { view?: string; listing?: string; product?: string },
): Promise<MarketPageProps> {
  const [marketplaces, products, listings, sales, payouts, files, connections] =
    await Promise.all([
      listMarketplaces(actor, {
        projectId: project.id,
        includeArchived: true,
      }),
      listProducts(actor, { projectId: project.id, includeRetired: true }),
      listListings(actor, { projectId: project.id, limit: 300 }),
      listSales(actor, { projectId: project.id, limit: 300 }),
      listPayouts(actor, { projectId: project.id }),
      fileOptions(actor, project.id),
      connectionOptions(actor, ['etsy']),
    ])
  const previews = await previewsFor(
    actor,
    products.flatMap((product) =>
      product.files
        .filter((file) => file.role === 'preview')
        .map((file) => file.id),
    ),
  ).catch(() => ({}))
  let detail: ListingDetailData | null = null
  if (params.listing) {
    try {
      detail = listingDetailData(await getListing(actor, params.listing))
    } catch {
      detail = null
    }
  }
  const view =
    params.view === 'products' || params.view === 'money'
      ? params.view
      : 'listings'
  return {
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      color: project.color,
      status: project.status,
      currency: project.currency,
      timezone: project.timezone,
    },
    marketplaces: marketplaces.map(marketplaceData),
    products: products.map(productData),
    listings: listings.map(listingRowData),
    sales: sales.map(saleData),
    payouts: payouts.map((payout) => ({
      id: payout.id,
      marketplaceShop: payout.marketplaceShop,
      amount: payout.amount,
      currency: payout.currency,
      status: payout.status,
      expectedOn: payout.expectedOn,
      paidOn: payout.paidOn,
      reference: payout.reference,
      revision: payout.revision,
    })),
    detail,
    files,
    connections,
    previews,
    readAt: new Date().toISOString(),
    view,
    selectedListingId: params.listing ?? null,
    selectedProductId: params.product ?? null,
  }
}
