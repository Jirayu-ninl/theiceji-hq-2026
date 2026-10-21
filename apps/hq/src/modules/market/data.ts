import type {
  ListingDetail,
  ListingListItem,
  MarketplaceView,
  ProductView,
} from '@theiceji/hq-market/market'
import type { SaleLine } from '@theiceji/hq-market/sales'
import type { Blocker } from '@theiceji/hq-ops/release'

/** Market as it crosses to the page: plain JSON, dates as ISO strings, money as decimal strings. */

export type MarketProject = {
  id: string
  slug: string
  name: string
  color: string
  status: string
  currency: string
  timezone: string
}

export type MarketplaceData = {
  id: string
  kind: 'etsy' | 'pod' | 'gumroad' | 'manual'
  shop: string
  url: string | null
  externalShopId: string | null
  connectionId: string | null
  connection: { id: string; label: string; status: string } | null
  currency: string
  feeSheet: {
    listingFee?: string
    transactionPct?: string
    processingPct?: string
    processingFixed?: string
  }
  readiness: { mode: 'api' | 'manual' | 'reconnect'; note: string }
  syncedAt: string | null
  syncProblem: string | null
  listings: number
  archived: boolean
  revision: number
}

export type FileData = {
  id: string
  /** The file name as uploaded — what goes out to the marketplace. */
  name: string
  /** What HQ calls it: the owner's title, else the file name. */
  title: string
  kind: string
  mime: string
  status: string
  role: 'deliverable' | 'preview'
}

export type ProductData = {
  id: string
  title: string
  description: string
  status: 'draft' | 'ready' | 'retired'
  price: string | null
  currency: string | null
  tags: string[]
  files: FileData[]
  listings: number
  revision: number
}

export type ListingRowData = {
  id: string
  productId: string
  productTitle: string
  marketplaceId: string
  marketplace: string
  kind: MarketplaceData['kind']
  title: string
  price: string
  currency: string
  tags: string[]
  status:
    | 'planned'
    | 'approved'
    | 'dispatched'
    | 'listed'
    | 'verified'
    | 'inactive'
    | 'failed'
  statusReason: string | null
  listedAt: string | null
  url: string | null
  externalId: string | null
  evidenceLevel: string | null
  clearance: { expiresAt: string } | null
  revision: number
}

export type ListingDetailData = ListingRowData & {
  description: string
  files: FileData[]
  blockers: Blocker[]
  intents: { id: string; status: string; error: string | null }[]
}

export type SaleData = {
  id: string
  kind: 'sale' | 'refund' | 'fee' | 'adjustment'
  occurredAt: string
  listingId: string | null
  listingTitle: string | null
  marketplaceShop: string
  quantity: number
  gross: string
  fees: string
  net: string
  currency: string
  orderRef: string | null
  source: string
  note: string | null
  supersedesId: string | null
  supersededBy: string | null
}

export type PayoutData = {
  id: string
  marketplaceShop: string
  amount: string
  currency: string
  status: 'expected' | 'confirmed'
  expectedOn: string | null
  paidOn: string | null
  reference: string | null
  revision: number
}

const fileData = (file: ProductView['files'][number]): FileData => ({
  id: file.id,
  name: file.name,
  title: file.title ?? file.name,
  kind: file.kind,
  mime: file.mime,
  status: file.status,
  role: file.role,
})

export function marketplaceData(view: MarketplaceView): MarketplaceData {
  return {
    id: view.id,
    kind: view.kind,
    shop: view.shop,
    url: view.url,
    externalShopId: view.externalShopId,
    connectionId: view.connectionId,
    connection: view.connection,
    currency: view.currency,
    feeSheet: view.feeSheet,
    readiness: view.readiness,
    syncedAt: view.syncedAt?.toISOString() ?? null,
    syncProblem: view.syncProblem,
    listings: view.listings,
    archived: Boolean(view.archivedAt),
    revision: view.revision,
  }
}

export function productData(product: ProductView): ProductData {
  return {
    id: product.id,
    title: product.title,
    description: product.description,
    status: product.status,
    price: product.price,
    currency: product.currency,
    tags: product.tags,
    files: product.files.map(fileData),
    listings: product.listings,
    revision: product.revision,
  }
}

export function listingRowData(row: ListingListItem): ListingRowData {
  return {
    id: row.id,
    productId: row.productId,
    productTitle: row.product.title,
    marketplaceId: row.marketplaceId,
    marketplace: row.marketplace.shop,
    kind: row.marketplace.kind,
    title: row.title,
    price: row.price,
    currency: row.currency,
    tags: row.tags,
    status: row.status,
    statusReason: row.statusReason,
    listedAt: row.listedAt?.toISOString() ?? null,
    url: row.url,
    externalId: row.externalId,
    evidenceLevel: row.evidenceLevel,
    clearance: row.clearance
      ? { expiresAt: row.clearance.expiresAt.toISOString() }
      : null,
    revision: row.revision,
  }
}

export function listingDetailData(detail: ListingDetail): ListingDetailData {
  const { listing } = detail
  return {
    id: listing.id,
    productId: listing.productId,
    productTitle: detail.product.title,
    marketplaceId: listing.marketplaceId,
    marketplace: detail.marketplace.shop,
    kind: detail.marketplace.kind,
    title: listing.title,
    price: listing.price,
    currency: listing.currency,
    tags: listing.tags,
    status: listing.status,
    statusReason: listing.statusReason,
    listedAt: listing.listedAt?.toISOString() ?? null,
    url: listing.url,
    externalId: listing.externalId,
    evidenceLevel: listing.evidenceLevel,
    clearance: detail.clearance
      ? { expiresAt: detail.clearance.expiresAt.toISOString() }
      : null,
    revision: listing.revision,
    description: listing.description,
    files: detail.files.map(fileData),
    blockers: detail.blockers,
    intents: detail.intents.map((intent) => ({
      id: intent.id,
      status: intent.status,
      error: intent.error,
    })),
  }
}

export function saleData(line: SaleLine): SaleData {
  return {
    id: line.id,
    kind: line.kind,
    occurredAt: line.occurredAt.toISOString(),
    listingId: line.listingId,
    listingTitle: line.listingTitle,
    marketplaceShop: line.marketplaceShop,
    quantity: line.quantity,
    gross: line.gross,
    fees: line.fees,
    net: line.net,
    currency: line.currency,
    orderRef: line.orderRef,
    source: line.source,
    note: line.note,
    supersedesId: line.supersedesId,
    supersededBy: line.supersededBy,
  }
}
