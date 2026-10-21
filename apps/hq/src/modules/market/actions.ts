'use server'

import {
  approveListing,
  deleteListing,
  dispatchListing,
  getListing,
  planListing,
  recordManualListing,
  saveMarketplace,
  saveProduct,
  setListingInactive,
  setMarketplaceArchived,
  setProductFiles,
  unapproveListing,
  updateListing,
} from '@theiceji/hq-market/market'
import '@theiceji/hq-market/register'
import {
  confirmPayout,
  recordPayout,
  recordSale,
  syncMarketplace,
} from '@theiceji/hq-market/sales'
import { type ActionResult, runAction } from '@/lib/actions'
import { type ListingDetailData, listingDetailData } from './data'

/**
 * Market's server actions — the hq-market services the MCP tools run too.
 * Approving a listing is the owner's release of exactly that payload;
 * confirming a payout is the owner's word that the bank showed it.
 */

type Actor = Parameters<Parameters<typeof runAction>[0]>[0]
const detail = async (actor: Actor, id: string) =>
  listingDetailData(await getListing(actor, id))

export async function listingAction(
  listingId: string,
): Promise<ActionResult<ListingDetailData>> {
  return runAction((actor) => detail(actor, listingId), { read: true })
}

export async function saveMarketplaceAction(input: {
  projectId: string
  marketplaceId?: string
  expectedRevision?: number
  kind: 'etsy' | 'pod' | 'gumroad' | 'manual'
  shop: string
  url?: string
  externalShopId?: string
  connectionId?: string | null
  currency?: string
  feeSheet?: {
    listingFee?: string
    transactionPct?: string
    processingPct?: string
    processingFixed?: string
  }
}): Promise<ActionResult<{ id: string }>> {
  return runAction(async (actor) => {
    const row = await saveMarketplace(actor, {
      ...input,
      url: input.url || undefined,
      externalShopId: input.externalShopId || undefined,
      connectionId: input.connectionId || undefined,
      currency: input.currency || undefined,
    })
    return { id: row.id }
  })
}

export async function archiveMarketplaceAction(input: {
  marketplaceId: string
  expectedRevision: number
  archived: boolean
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await setMarketplaceArchived(actor, input)
    return null
  })
}

export async function syncMarketplaceAction(input: {
  marketplaceId: string
}): Promise<
  ActionResult<{
    sales: number
    fees: number
    refunds: number
    payouts: number
    unmatched: number
  }>
> {
  return runAction((actor) => syncMarketplace(actor, input.marketplaceId))
}

export async function saveProductAction(input: {
  projectId: string
  productId?: string
  expectedRevision?: number
  title: string
  description?: string
  status?: 'draft' | 'ready' | 'retired'
  price?: string | null
  currency?: string
  tags?: string[]
  files?: { assetId: string; role: 'deliverable' | 'preview' }[]
}): Promise<ActionResult<{ id: string }>> {
  return runAction(async (actor) => {
    const product = await saveProduct(actor, {
      projectId: input.projectId,
      productId: input.productId,
      expectedRevision: input.expectedRevision,
      title: input.title,
      description: input.description,
      status: input.status,
      price: input.price,
      currency: input.currency || undefined,
      tags: input.tags,
    })
    if (input.files)
      await setProductFiles(actor, {
        productId: product.id,
        expectedRevision: product.revision,
        files: input.files,
      })
    return { id: product.id }
  })
}

export async function planListingAction(input: {
  productId: string
  marketplaceId: string
  price?: string
}): Promise<ActionResult<ListingDetailData>> {
  return runAction(async (actor) => {
    const listing = await planListing(actor, {
      productId: input.productId,
      marketplaceId: input.marketplaceId,
      price: input.price || undefined,
    })
    return detail(actor, listing.id)
  })
}

export async function updateListingAction(input: {
  listingId: string
  expectedRevision: number
  title?: string
  description?: string
  price?: string
  tags?: string[]
}): Promise<ActionResult<ListingDetailData>> {
  return runAction(async (actor) => {
    await updateListing(actor, input)
    return detail(actor, input.listingId)
  })
}

export async function approveListingAction(input: {
  listingId: string
  expectedRevision: number
}): Promise<
  ActionResult<{ detail: ListingDetailData; blockers: { message: string }[] }>
> {
  return runAction(async (actor) => {
    const outcome = await approveListing(actor, input)
    return {
      detail: await detail(actor, input.listingId),
      blockers: outcome.blockers,
    }
  })
}

export async function unapproveListingAction(input: {
  listingId: string
  expectedRevision: number
}): Promise<ActionResult<ListingDetailData>> {
  return runAction(async (actor) => {
    await unapproveListing(actor, input)
    return detail(actor, input.listingId)
  })
}

export async function deleteListingAction(input: {
  listingId: string
  expectedRevision: number
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await deleteListing(actor, input)
    return null
  })
}

export async function recordListedAction(input: {
  listingId: string
  expectedRevision: number
  url?: string
  externalId?: string
  listedAt?: string
  evidenceLevel?: 'owner_attested' | 'screenshot' | 'platform_export'
}): Promise<ActionResult<ListingDetailData>> {
  return runAction(async (actor) => {
    await recordManualListing(actor, {
      ...input,
      url: input.url || undefined,
      externalId: input.externalId || undefined,
      listedAt: input.listedAt || undefined,
    })
    return detail(actor, input.listingId)
  })
}

export async function dispatchListingAction(input: {
  listingId: string
}): Promise<ActionResult<{ detail: ListingDetailData; message: string }>> {
  return runAction(async (actor) => {
    const outcome = await dispatchListing(actor, {
      listingId: input.listingId,
      idempotencyKey: `ui:${input.listingId}:${crypto.randomUUID()}`,
    })
    return {
      detail: await detail(actor, input.listingId),
      message: outcome.message,
    }
  })
}

export async function inactiveListingAction(input: {
  listingId: string
  expectedRevision: number
  reason: string
}): Promise<ActionResult<ListingDetailData>> {
  return runAction(async (actor) => {
    await setListingInactive(actor, input)
    return detail(actor, input.listingId)
  })
}

export async function recordSaleAction(input: {
  marketplaceId: string
  listingId?: string
  kind: 'sale' | 'refund' | 'fee' | 'adjustment'
  amount: string
  fees?: string
  quantity?: number
  occurredAt?: string
  orderRef?: string
  note?: string
  supersedesId?: string
  correctionReason?: string
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await recordSale(actor, {
      ...input,
      listingId: input.listingId || undefined,
      fees: input.fees || undefined,
      occurredAt: input.occurredAt || undefined,
      orderRef: input.orderRef || undefined,
      note: input.note || undefined,
      supersedesId: input.supersedesId || undefined,
      correctionReason: input.correctionReason || undefined,
    })
    return null
  })
}

export async function recordPayoutAction(input: {
  marketplaceId: string
  amount: string
  expectedOn?: string
  reference?: string
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await recordPayout(actor, {
      ...input,
      expectedOn: input.expectedOn || undefined,
      reference: input.reference || undefined,
    })
    return null
  })
}

export async function confirmPayoutAction(input: {
  payoutId: string
  expectedRevision: number
  paidOn: string
  amount?: string
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await confirmPayout(actor, {
      ...input,
      amount: input.amount || undefined,
    })
    return null
  })
}
