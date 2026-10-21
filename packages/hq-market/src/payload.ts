import type { AssetRow } from '@theiceji/hq-db/schema'
import {
  assetAssets,
  type MarketListingRow,
  type MarketMarketplaceRow,
  type MarketProductRow,
  marketListings,
  marketMarketplaces,
  marketProductFiles,
  marketProducts,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import type { Reader } from '@theiceji/hq-ops/db'
import { notFound } from '@theiceji/hq-ops/errors'
import {
  type Blocker,
  registerReleaseEvaluator,
} from '@theiceji/hq-ops/release'
import { hashRequest } from '@theiceji/hq-ops/store'
import { and, asc, eq } from 'drizzle-orm'
import type { ListingFileRef, ListingPayload } from './adapters/types'

/**
 * What a listing would send, and every reason it can't go yet. The release
 * authorization binds the hash of this payload — title, description, price,
 * tags, the shop and the exact file bytes — so changing any of it after the
 * owner approved makes the approval stop fitting.
 */

export type ProductFile = Pick<
  AssetRow,
  'id' | 'name' | 'kind' | 'mime' | 'status' | 'sha256' | 'bytes'
> & { role: 'deliverable' | 'preview'; position: number }

/** What each marketplace asks of a listing (checked, never guessed). */
export const MARKET_RULES: Record<
  MarketMarketplaceRow['kind'],
  {
    label: string
    titleMax: number
    tagMax: number
    tagLength: number
    filesMax: number
    needsDescription: boolean
    needsPreview: boolean
  }
> = {
  etsy: {
    label: 'Etsy',
    titleMax: 140,
    tagMax: 13,
    tagLength: 20,
    filesMax: 5,
    needsDescription: true,
    needsPreview: true,
  },
  pod: {
    label: 'Print on demand',
    titleMax: 200,
    tagMax: 13,
    tagLength: 40,
    filesMax: 20,
    needsDescription: false,
    needsPreview: false,
  },
  gumroad: {
    label: 'Gumroad',
    titleMax: 200,
    tagMax: 13,
    tagLength: 40,
    filesMax: 20,
    needsDescription: false,
    needsPreview: false,
  },
  manual: {
    label: 'Other shop',
    titleMax: 200,
    tagMax: 13,
    tagLength: 40,
    filesMax: 20,
    needsDescription: false,
    needsPreview: false,
  },
}

/** An asset's binding: its SHA-256, or its frozen size when too big to hash. */
export const fileBinding = (file: Pick<AssetRow, 'sha256' | 'bytes'>) =>
  file.sha256 ?? `size:${file.bytes}`

const ref = (file: ProductFile): ListingFileRef => ({
  assetId: file.id,
  sha256: fileBinding(file),
  name: file.name,
  mime: file.mime,
})

export function payloadOf(
  listing: MarketListingRow,
  marketplace: MarketMarketplaceRow,
  files: readonly ProductFile[],
): ListingPayload {
  return {
    kind: marketplace.kind,
    marketplace: {
      id: marketplace.id,
      shop: marketplace.shop,
      externalShopId: marketplace.externalShopId,
    },
    title: listing.title,
    description: listing.description,
    price: listing.price,
    currency: listing.currency,
    tags: listing.tags,
    settings: marketplace.settings,
    files: files.filter((file) => file.role === 'deliverable').map(ref),
    images: files.filter((file) => file.role === 'preview').map(ref),
  }
}

export const hashPayload = (payload: ListingPayload): string =>
  hashRequest('market.listing', payload)

/** Every reason the listing can't be approved or sent as it stands. */
export function listingBlockers(
  listing: MarketListingRow,
  product: MarketProductRow,
  marketplace: MarketMarketplaceRow,
  files: readonly ProductFile[],
): Blocker[] {
  const blockers: Blocker[] = []
  const rules = MARKET_RULES[marketplace.kind]
  if (listing.status !== 'planned' && listing.status !== 'approved')
    blockers.push({
      key: 'listing_state',
      message: `This listing is ${listing.status}; only a planned or approved one can be released.`,
    })
  if (marketplace.archivedAt)
    blockers.push({
      key: 'marketplace_archived',
      message: `${marketplace.shop} is archived.`,
    })
  if (product.status === 'retired')
    blockers.push({
      key: 'product_retired',
      message: 'The product is retired.',
      remediation: 'Bring the product back before listing it.',
    })
  if (listing.currency !== marketplace.currency)
    blockers.push({
      key: 'currency',
      message: `${marketplace.shop} sells in ${marketplace.currency}; this listing is priced in ${listing.currency}.`,
    })
  if (Number(listing.price) <= 0)
    blockers.push({ key: 'price', message: 'A listing needs a price above 0.' })
  if (listing.title.length > rules.titleMax)
    blockers.push({
      key: 'title_long',
      message: `${rules.label} titles are at most ${rules.titleMax} characters.`,
    })
  if (listing.tags.length > rules.tagMax)
    blockers.push({
      key: 'tags_many',
      message: `${rules.label} takes at most ${rules.tagMax} tags.`,
    })
  const long = listing.tags.find((tag) => tag.length > rules.tagLength)
  if (long)
    blockers.push({
      key: 'tag_long',
      message: `“${long}” is longer than ${rules.label}’s ${rules.tagLength} characters.`,
    })
  if (rules.needsDescription && !listing.description.trim())
    blockers.push({
      key: 'description_missing',
      message: `${rules.label} needs a description.`,
    })
  const deliverables = files.filter((file) => file.role === 'deliverable')
  const previews = files.filter((file) => file.role === 'preview')
  if (deliverables.length === 0)
    blockers.push({
      key: 'files_missing',
      message: 'The product has no file for the buyer to download.',
      remediation: 'Add a deliverable file to the product.',
    })
  if (deliverables.length > rules.filesMax)
    blockers.push({
      key: 'files_many',
      message: `${rules.label} takes at most ${rules.filesMax} download files.`,
    })
  if (rules.needsPreview && previews.length === 0)
    blockers.push({
      key: 'preview_missing',
      message: `${rules.label} needs at least one image.`,
    })
  for (const file of files)
    if (file.status !== 'ready')
      blockers.push({
        key: 'file_not_ready',
        message: `${file.name} is ${file.status}, not ready.`,
      })
  return blockers
}

/** A listing with its product, marketplace and files, read in the caller's transaction. */
export async function listingParts(
  reader: Reader,
  ownerId: string,
  listingId: string,
): Promise<{
  listing: MarketListingRow
  product: MarketProductRow
  marketplace: MarketMarketplaceRow
  files: ProductFile[]
}> {
  const [found] = await reader
    .select({
      listing: marketListings,
      product: marketProducts,
      marketplace: marketMarketplaces,
    })
    .from(marketListings)
    .innerJoin(marketProducts, eq(marketProducts.id, marketListings.productId))
    .innerJoin(
      marketMarketplaces,
      eq(marketMarketplaces.id, marketListings.marketplaceId),
    )
    .where(
      and(
        eq(marketListings.id, listingId),
        eq(marketListings.ownerId, ownerId),
      ),
    )
    .limit(1)
  if (!found) throw notFound('Listing')
  const files = await productFiles(reader, ownerId, found.product.id)
  return { ...found, files }
}

export async function productFiles(
  reader: Reader,
  ownerId: string,
  productId: string,
): Promise<ProductFile[]> {
  return reader
    .select({
      id: assetAssets.id,
      name: assetAssets.name,
      kind: assetAssets.kind,
      mime: assetAssets.mime,
      status: assetAssets.status,
      sha256: assetAssets.sha256,
      bytes: assetAssets.bytes,
      role: marketProductFiles.role,
      position: marketProductFiles.position,
    })
    .from(marketProductFiles)
    .innerJoin(assetAssets, eq(assetAssets.id, marketProductFiles.assetId))
    .where(
      and(
        eq(marketProductFiles.productId, productId),
        eq(marketProductFiles.ownerId, ownerId),
      ),
    )
    .orderBy(asc(marketProductFiles.role), asc(marketProductFiles.position))
}

/**
 * The kernel asks this whenever a listing is approved or its approval is
 * used: the hash of what would go now, where it would go, and every reason
 * it can't. A listing may carry several files, so the authorization binds
 * them through the payload hash, not one asset column.
 */
registerReleaseEvaluator(
  'market',
  'listing',
  async (reader, actor: Actor, subject) => {
    const { listing, product, marketplace, files } = await listingParts(
      reader,
      actor.userId,
      subject.id,
    )
    if (subject.project && listing.projectId !== subject.project.id)
      throw notFound('Listing')
    return {
      payloadHash: hashPayload(payloadOf(listing, marketplace, files)),
      asset: null,
      targetRef: marketplace.id,
      blockers: listingBlockers(listing, product, marketplace, files),
    }
  },
)
