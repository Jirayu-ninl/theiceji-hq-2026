import {
  MARKET_LISTING_STATUSES,
  MARKET_PRODUCT_STATUSES,
  MARKET_SALE_KINDS,
  PUBLISH_EVIDENCE_LEVELS,
} from '@theiceji/hq-db/enums'
import type { MarketListingRow, MarketProductRow } from '@theiceji/hq-db/schema'
import {
  approveListing,
  dispatchListing,
  getListing,
  type ListingListItem,
  listListings,
  listMarketplaces,
  listProducts,
  type ProductView,
  planListing,
  recordManualListing,
  saveProduct,
  setProductFiles,
  updateListing,
} from '@theiceji/hq-market/market'
import { invalid, policyBlocked } from '@theiceji/hq-ops/errors'
import '@theiceji/hq-market/register'
import { recordPayout, recordSale } from '@theiceji/hq-market/sales'
import { z } from 'zod'
import { defineTool, defineWorkspace } from '../../kernel'
import {
  defined,
  expectedRevisionArg,
  idArg,
  idempotencyKeyArg,
  projectIdArg,
  READ,
  readTool,
  WRITE,
  writeTool,
} from '../support'

/**
 * `market` — digital assets for sale: products and their files,
 * listings from planned to verified, and the money the marketplaces report.
 * Approving a listing is the owner's (or a policy that releases by itself —
 * `release_by_policy`); confirming a payout is the owner's, in HQ.
 */

function listingOut(listing: MarketListingRow | ListingListItem) {
  return {
    id: listing.id,
    project_id: listing.projectId,
    product_id: listing.productId,
    marketplace_id: listing.marketplaceId,
    ...('marketplace' in listing
      ? {
          marketplace: listing.marketplace.shop,
          kind: listing.marketplace.kind,
          approved: Boolean(listing.clearance),
        }
      : {}),
    title: listing.title,
    price: listing.price,
    currency: listing.currency,
    tags: listing.tags,
    status: listing.status,
    status_reason: listing.statusReason,
    listed_at: listing.listedAt,
    url: listing.url,
    external_id: listing.externalId,
    evidence_level: listing.evidenceLevel,
    revision: listing.revision,
  }
}

function productOut(product: MarketProductRow | ProductView) {
  return {
    id: product.id,
    project_id: product.projectId,
    title: product.title,
    description: product.description,
    status: product.status,
    price: product.price,
    currency: product.currency,
    tags: product.tags,
    ...('files' in product
      ? {
          files: product.files.map((file) => ({
            asset_id: file.id,
            name: file.name,
            /** The owner's name for it in HQ, or null (then `name`, the file name, is what HQ shows). */
            title: file.title,
            role: file.role,
            status: file.status,
          })),
          listings: product.listings,
        }
      : {}),
    revision: product.revision,
  }
}

export const listListingsTool = defineTool({
  name: 'list_listings',
  title: 'List listings',
  description:
    'Listings newest first — one project’s (with its marketplaces and products), or every project with Market on — with status and approval. With listing_id: that listing in full (its files, what blocks it, its dispatches).',
  scope: 'market:read',
  input: z.object({
    project_id: projectIdArg.optional(),
    listing_id: idArg('Listing').optional(),
    marketplace_id: idArg('Marketplace').optional(),
    status: z.array(z.enum(MARKET_LISTING_STATUSES)).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      async (actor) => {
        if (args.listing_id)
          return {
            kind: 'detail' as const,
            detail: await getListing(actor, args.listing_id),
          }
        const [marketplaces, products, listings] = await Promise.all([
          args.project_id
            ? listMarketplaces(actor, { projectId: args.project_id })
            : Promise.resolve(null),
          args.project_id
            ? listProducts(actor, { projectId: args.project_id })
            : Promise.resolve(null),
          listListings(actor, {
            projectId: args.project_id,
            marketplaceId: args.marketplace_id,
            status: args.status,
            limit: args.limit,
          }),
        ])
        return { kind: 'list' as const, marketplaces, products, listings }
      },
      (value) => {
        if (value.kind === 'detail') {
          const { detail } = value
          return {
            text: `“${detail.listing.title}” on ${detail.marketplace.shop} is ${detail.listing.status}${detail.clearance ? ', approved' : ''}${detail.blockers.length ? `; blocked by: ${detail.blockers.map((entry) => entry.message).join(' ')}` : ''}.`,
            data: {
              listing: listingOut(detail.listing),
              product: productOut(detail.product),
              marketplace: {
                id: detail.marketplace.id,
                kind: detail.marketplace.kind,
                shop: detail.marketplace.shop,
                currency: detail.marketplace.currency,
                readiness: detail.marketplace.readiness,
              },
              files: detail.files.map((file) => ({
                asset_id: file.id,
                name: file.name,
                title: file.title,
                role: file.role,
                status: file.status,
              })),
              approved: Boolean(detail.clearance),
              blockers: detail.blockers,
              dispatches: detail.intents.map((intent) => ({
                id: intent.id,
                status: intent.status,
                remote_listing_id: intent.remoteListingId,
                error: intent.error,
              })),
            },
          }
        }
        return {
          text: `${value.listings.length} listing(s)${value.products ? `, ${value.products.length} product(s)` : ''}.`,
          data: {
            marketplaces:
              value.marketplaces?.map((marketplace) => ({
                id: marketplace.id,
                kind: marketplace.kind,
                shop: marketplace.shop,
                currency: marketplace.currency,
                readiness: marketplace.readiness,
                synced_at: marketplace.syncedAt,
              })) ?? null,
            products: value.products?.map(productOut) ?? null,
            listings: value.listings.map(listingOut),
          },
        }
      },
    ),
})

const productArg = z
  .object({
    product_id: idArg('Product').optional(),
    expected_revision: expectedRevisionArg.optional(),
    title: z.string().min(1).max(200),
    description: z.string().max(20000).optional(),
    status: z.enum(MARKET_PRODUCT_STATUSES).optional(),
    price: z
      .union([z.string().max(20), z.number().min(0)])
      .nullable()
      .optional(),
    currency: z.string().length(3).optional(),
    tags: z.array(z.string().max(40)).max(13).optional(),
    files: z
      .array(
        z.object({
          asset_id: idArg('Asset'),
          role: z.enum(['deliverable', 'preview']),
        }),
      )
      .max(40)
      .optional()
      .describe(
        'Replaces the files: what the buyer downloads, and the images.',
      ),
  })
  .optional()

const listingArg = z
  .object({
    listing_id: idArg('Listing').optional(),
    expected_revision: expectedRevisionArg.optional(),
    product_id: idArg('Product').optional(),
    marketplace_id: idArg('Marketplace').optional(),
    title: z.string().max(200).optional(),
    description: z.string().max(20000).optional(),
    price: z.union([z.string().max(20), z.number().min(0)]).optional(),
    tags: z.array(z.string().max(40)).max(13).optional(),
    from_card_id: idArg('Card').optional(),
  })
  .optional()

export const prepareListingTool = defineTool({
  name: 'prepare',
  title: 'Draft a product or a listing',
  description:
    'product: create or change a product and its files (Assets). listing: plan a product on a marketplace (it starts from the product’s title, price and tags) or change one that isn’t live — a change takes its approval back. Both in one call makes the product first. Drafting only: nothing is listed.',
  scope: 'market:write',
  input: z.object({
    project_id: projectIdArg.optional(),
    product: productArg,
    listing: listingArg,
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      async (actor) => {
        if (!args.product && !args.listing)
          throw invalid('Send a product, a listing, or both.')
        let product: ProductView | MarketProductRow | null = null
        if (args.product) {
          if (!args.project_id) throw invalid('A product needs its project_id.')
          const saved = await saveProduct(
            actor,
            defined({
              projectId: args.project_id,
              productId: args.product.product_id,
              expectedRevision: args.product.expected_revision,
              title: args.product.title,
              description: args.product.description,
              status: args.product.status,
              price: args.product.price,
              currency: args.product.currency,
              tags: args.product.tags,
              idempotencyKey: `${args.idempotency_key}:product`,
            }) as Parameters<typeof saveProduct>[1],
          )
          product = args.product.files
            ? await setProductFiles(actor, {
                productId: saved.id,
                expectedRevision: saved.revision,
                files: args.product.files.map((file) => ({
                  assetId: file.asset_id,
                  role: file.role,
                })),
              })
            : saved
        }
        let listing: MarketListingRow | null = null
        if (args.listing) {
          if (args.listing.listing_id) {
            if (!args.listing.expected_revision)
              throw invalid('Pass expected_revision to change a listing.')
            listing = await updateListing(
              actor,
              defined({
                listingId: args.listing.listing_id,
                expectedRevision: args.listing.expected_revision,
                title: args.listing.title,
                description: args.listing.description,
                price: args.listing.price,
                tags: args.listing.tags,
                idempotencyKey: `${args.idempotency_key}:listing`,
              }) as Parameters<typeof updateListing>[1],
            )
          } else {
            const productId = args.listing.product_id ?? product?.id
            if (!productId || !args.listing.marketplace_id)
              throw invalid(
                'A new listing needs product_id and marketplace_id.',
              )
            listing = await planListing(
              actor,
              defined({
                productId,
                marketplaceId: args.listing.marketplace_id,
                title: args.listing.title,
                description: args.listing.description,
                price: args.listing.price,
                tags: args.listing.tags,
                fromCardId: args.listing.from_card_id,
                idempotencyKey: `${args.idempotency_key}:listing`,
              }) as Parameters<typeof planListing>[1],
            )
          }
        }
        return { product, listing }
      },
      ({ product, listing }) => ({
        text: [
          product
            ? `Product “${product.title}” (revision ${product.revision}).`
            : '',
          listing
            ? `Listing “${listing.title}” is ${listing.status} (revision ${listing.revision}).`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        data: {
          product: product ? productOut(product) : null,
          listing: listing ? listingOut(listing) : null,
        },
      }),
    ),
})

async function approveByPolicy(
  actor: Parameters<typeof approveListing>[0],
  listingId: string,
): Promise<void> {
  const detail = await getListing(actor, listingId)
  if (detail.clearance) return
  const outcome = await approveListing(actor, {
    listingId,
    mode: 'policy_gated',
  })
  if (!outcome.authorization)
    throw policyBlocked(
      `The policy can’t approve this listing: ${outcome.blockers.map((entry) => entry.message).join(' ')}`,
      { blockers: outcome.blockers },
    )
}

const releaseArg = z
  .boolean()
  .optional()
  .describe(
    'If the listing isn’t approved yet, ask the owner’s policy to approve it (it must release by itself and allow authorize_release; needs ops:decide). Otherwise the owner approves it in HQ.',
  )

export const dispatchListingTool = defineTool({
  name: 'dispatch',
  title: 'Send an approved listing',
  description:
    'Send an approved listing through its marketplace’s API now (Etsy), using the approval up. Where HQ can’t list by itself — capability_unavailable: list it by hand and use market_record_manual. A send whose answer never came back is unknown and is read back later — never send twice.',
  scope: 'market:operate',
  input: z.object({
    listing_id: idArg('Listing'),
    release_by_policy: releaseArg,
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: { ...WRITE, openWorldHint: true },
  run: (args, context) =>
    writeTool(
      context,
      async (actor) => {
        if (args.release_by_policy)
          await approveByPolicy(actor, args.listing_id)
        return dispatchListing(actor, {
          listingId: args.listing_id,
          idempotencyKey: args.idempotency_key,
        })
      },
      (outcome) => ({
        text: outcome.message,
        data: {
          result: outcome.result,
          listing: listingOut(outcome.listing),
          dispatch: {
            id: outcome.intent.id,
            status: outcome.intent.status,
            remote_listing_id: outcome.intent.remoteListingId,
            error: outcome.intent.error,
          },
        },
      }),
    ),
})

export const recordManualListingTool = defineTool({
  name: 'record_manual',
  title: 'Record a listing made by hand',
  description:
    'A listing made by hand, on the record: its URL or listing ID, when, and how you know. Only under a live approval of exactly this payload, which you use up.',
  scope: 'market:operate',
  input: z.object({
    listing_id: idArg('Listing'),
    expected_revision: expectedRevisionArg.optional(),
    url: z.string().url().max(600).optional(),
    external_id: z.string().max(200).optional(),
    listed_at: z.string().max(40).optional(),
    evidence_level: z.enum(PUBLISH_EVIDENCE_LEVELS).optional(),
    evidence_note: z.string().max(1000).optional(),
    release_by_policy: releaseArg,
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      async (actor) => {
        if (args.release_by_policy)
          await approveByPolicy(actor, args.listing_id)
        return recordManualListing(
          actor,
          defined({
            listingId: args.listing_id,
            expectedRevision: args.expected_revision,
            url: args.url,
            externalId: args.external_id,
            listedAt: args.listed_at,
            evidenceLevel: args.evidence_level,
            evidenceNote: args.evidence_note,
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof recordManualListing>[1],
        )
      },
      (listing) => ({
        text: `On the record: listed ${listing.listedAt?.toISOString()} (${listing.evidenceLevel}).`,
        data: { listing: listingOut(listing) },
      }),
    ),
})

export const recordSaleTool = defineTool({
  name: 'record_sale',
  title: 'Record a sale, refund, fee or adjustment',
  description:
    'One money line from a marketplace, append-only. amount is positive for a sale, refund or fee — the kind says which way it goes; an adjustment is signed. fees are what the marketplace kept on a sale. order_ref (order:line) is recorded once. To fix a line, pass supersedes_id and correction_reason. Needs your policy to allow importing.',
  scope: 'market:write',
  input: z.object({
    marketplace_id: idArg('Marketplace'),
    listing_id: idArg('Listing').optional(),
    kind: z.enum(MARKET_SALE_KINDS),
    amount: z.union([z.string().max(24), z.number()]),
    fees: z.union([z.string().max(24), z.number().min(0)]).optional(),
    currency: z.string().length(3).optional(),
    quantity: z.number().int().min(0).max(100000).optional(),
    occurred_at: z.string().max(40).optional(),
    order_ref: z.string().max(120).optional(),
    note: z.string().max(1000).optional(),
    supersedes_id: idArg('Line').optional(),
    correction_reason: z.string().max(1000).optional(),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        recordSale(
          actor,
          defined({
            marketplaceId: args.marketplace_id,
            listingId: args.listing_id,
            kind: args.kind,
            amount: args.amount,
            fees: args.fees,
            currency: args.currency,
            quantity: args.quantity,
            occurredAt: args.occurred_at,
            orderRef: args.order_ref,
            note: args.note,
            supersedesId: args.supersedes_id,
            correctionReason: args.correction_reason,
            source: 'agent',
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof recordSale>[1],
        ),
      (line) => ({
        text: `Recorded ${line.kind}: gross ${line.gross}, fees ${line.fees}, net ${line.net} ${line.currency}.`,
        data: {
          line: {
            id: line.id,
            kind: line.kind,
            gross: line.gross,
            fees: line.fees,
            net: line.net,
            currency: line.currency,
            order_ref: line.orderRef,
            occurred_at: line.occurredAt,
            supersedes_id: line.supersedesId,
          },
        },
      }),
    ),
})

export const recordPayoutTool = defineTool({
  name: 'record_payout',
  title: 'Record an expected payout',
  description:
    'A payout the marketplace says is coming. It stays expected until the owner confirms the bank showed it, in HQ.',
  scope: 'market:write',
  input: z.object({
    marketplace_id: idArg('Marketplace'),
    amount: z.union([z.string().max(24), z.number().min(0)]),
    currency: z.string().length(3).optional(),
    expected_on: z.string().max(10).optional(),
    reference: z.string().max(120).optional(),
    note: z.string().max(1000).optional(),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        recordPayout(
          actor,
          defined({
            marketplaceId: args.marketplace_id,
            amount: args.amount,
            currency: args.currency,
            expectedOn: args.expected_on,
            reference: args.reference,
            note: args.note,
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof recordPayout>[1],
        ),
      (payout) => ({
        text: `Expected: ${payout.amount} ${payout.currency}${payout.expectedOn ? ` on ${payout.expectedOn}` : ''}.`,
        data: {
          payout: {
            id: payout.id,
            amount: payout.amount,
            currency: payout.currency,
            status: payout.status,
            expected_on: payout.expectedOn,
            reference: payout.reference,
          },
        },
      }),
    ),
})

export const market = defineWorkspace({
  id: 'market',
  label: 'Market',
  description:
    'Digital assets for sale: products and files, listings with evidence, and the money marketplaces report.',
  instructions:
    'Read with market_list_listings. Draft products and listings with market_prepare; the owner approves a listing in HQ (or their policy does, with release_by_policy). An approved listing goes out through market_dispatch (Etsy) or by hand and then market_record_manual. Record money with market_record_sale and market_record_payout; the owner confirms payouts.',
  tools: [
    listListingsTool,
    prepareListingTool,
    dispatchListingTool,
    recordManualListingTool,
    recordSaleTool,
    recordPayoutTool,
  ],
})
