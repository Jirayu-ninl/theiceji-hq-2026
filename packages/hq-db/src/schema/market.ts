import { sql } from 'drizzle-orm'
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  MARKET_FILE_ROLES,
  MARKET_INTENT_STATUSES,
  MARKET_KINDS,
  MARKET_LISTING_STATUSES,
  MARKET_PAYOUT_STATUSES,
  MARKET_PRODUCT_STATUSES,
  MARKET_SALE_KINDS,
  type MarketFileRole,
  type MarketIntentStatus,
  type MarketKind,
  type MarketListingStatus,
  type MarketPayoutStatus,
  type MarketProductStatus,
  type MarketSaleKind,
  OPS_ACTOR_TYPES,
  type OpsActorType,
  PUBLISH_EVIDENCE_LEVELS,
  type PublishEvidenceLevel,
  READING_SOURCES,
  type ReadingSource,
} from '../enums'
import {
  currencyCode,
  inOwnProject,
  ownerColumn,
  trimmedLength,
} from './_module'
import { nullableOneOf, oneOf, tz } from './_shared'
import { tracked } from './_user'
import { assetAssets } from './assets'
import { providerConnections } from './core'
import { opsReleaseAuthorizations } from './ops'

/* ── market — digital assets for sale ───────────────────
 *
 * · **A marketplace is where a project sells** — an Etsy shop, a
 *   print-on-demand store, Gumroad, or anywhere recorded by hand. Its fee
 *   sheet is what the owner expects to pay, for the dashboard's net; the
 *   money that counts is what the marketplace reports.
 * · **A product is the thing sold**; its files are Assets rows (what the
 *   buyer downloads, and previews). A product can be listed on several
 *   marketplaces, once each at a time.
 * · **A listing leaves HQ like a post does**: the owner's release
 *   authorization (hq-ops) makes it `approved`; it is `listed` only with a
 *   time, evidence and a URL or external ID. An intent is one API dispatch.
 * · **Money is append-only.** Every sale, refund, fee and adjustment is a
 *   `market_sales_events` row that is never changed; a correction supersedes
 *   it. A payout is `expected` until the bank shows it (`confirmed`).
 * · Listing versions, licences, reply templates and a
 *   support inbox are out of v1; an order is the `order_ref` on its lines.
 */

/** What the owner expects a marketplace to take — decimal strings, never floats. */
export type FeeSheet = {
  /** Per listing, in the marketplace's currency. */
  listingFee?: string
  /** Of the item price, in percent. */
  transactionPct?: string
  /** Payment processing, in percent… */
  processingPct?: string
  /** …plus a fixed amount per order. */
  processingFixed?: string
}

/**
 * What a marketplace's API asks of every listing that the product doesn't
 * say — Etsy's "who made it", "when", its category. Never a secret.
 */
export type MarketplaceSettings = {
  whoMade?: 'i_did' | 'someone_else' | 'collective'
  whenMade?: string
  taxonomyId?: string
  /** How many a digital listing offers (Etsy counts even downloads). */
  quantity?: number
}

export const marketMarketplaces = pgTable(
  'market_marketplaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id').notNull(),
    kind: text('kind').$type<MarketKind>().notNull(),
    /** The shop's name as the marketplace shows it. */
    shop: text('shop').notNull(),
    url: text('url'),
    /** The owner's connection HQ lists through; null means by hand. */
    connectionId: uuid('connection_id'),
    /** The shop's ID in the marketplace, as it spells it. */
    externalShopId: text('external_shop_id'),
    /** What prices and payouts are in there. */
    currency: text('currency').notNull(),
    feeSheet: jsonb('fee_sheet')
      .$type<FeeSheet>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    settings: jsonb('settings')
      .$type<MarketplaceSettings>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The last time orders and fees were read from the marketplace, and what went wrong. */
    syncedAt: timestamp('synced_at', tz),
    syncProblem: text('sync_problem'),
    archivedAt: timestamp('archived_at', tz),
  },
  (t) => [
    unique('market_marketplaces_owner_scope_key').on(t.id, t.ownerId),
    unique('market_marketplaces_project_scope_key').on(t.id, t.projectId),
    inOwnProject('market_marketplaces_project_fk', t),
    foreignKey({
      name: 'market_marketplaces_connection_fk',
      columns: [t.connectionId, t.ownerId],
      foreignColumns: [providerConnections.id, providerConnections.ownerId],
    }).onDelete('restrict'),
    uniqueIndex('market_marketplaces_shop_key')
      .on(t.projectId, t.kind, sql`lower(${t.shop})`)
      .where(sql`${t.archivedAt} is null`),
    check('market_marketplaces_kind_check', oneOf(t.kind, MARKET_KINDS)),
    check('market_marketplaces_shop_check', trimmedLength(t.shop, 120)),
    check(
      'market_marketplaces_currency_check',
      sql`${t.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      'market_marketplaces_url_check',
      sql`${t.url} is null or ${t.url} ~ '^https?://' and length(${t.url}) <= 600`,
    ),
    check(
      'market_marketplaces_fee_check',
      sql`jsonb_typeof(${t.feeSheet}) = 'object'`,
    ),
    check(
      'market_marketplaces_settings_check',
      sql`jsonb_typeof(${t.settings}) = 'object'`,
    ),
  ],
)

export const marketProducts = pgTable(
  'market_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id').notNull(),
    title: text('title').notNull(),
    /** Markdown. */
    description: text('description').notNull().default(''),
    status: text('status')
      .$type<MarketProductStatus>()
      .notNull()
      .default('draft'),
    /** The price listings start from; a listing may set its own. */
    price: numeric('price', { precision: 12, scale: 2, mode: 'string' }),
    currency: text('currency'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    unique('market_products_owner_scope_key').on(t.id, t.ownerId),
    unique('market_products_project_scope_key').on(t.id, t.projectId),
    inOwnProject('market_products_project_fk', t),
    index('market_products_owner_idx').on(t.ownerId, t.projectId, t.status),
    check(
      'market_products_status_check',
      oneOf(t.status, MARKET_PRODUCT_STATUSES),
    ),
    check('market_products_title_check', trimmedLength(t.title, 200)),
    check(
      'market_products_description_check',
      sql`length(${t.description}) <= 20000`,
    ),
    check(
      'market_products_price_check',
      sql`${t.price} is null or (${t.price} >= 0 and ${t.currency} is not null)`,
    ),
    check('market_products_currency_check', currencyCode(t.currency)),
    check('market_products_tags_check', sql`cardinality(${t.tags}) <= 13`),
  ],
)

/** A product's files: what the buyer downloads, and what the listing shows. */
export const marketProductFiles = pgTable(
  'market_product_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    productId: uuid('product_id').notNull(),
    assetId: uuid('asset_id').notNull(),
    role: text('role').$type<MarketFileRole>().notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'market_product_files_product_fk',
      columns: [t.productId, t.ownerId],
      foreignColumns: [marketProducts.id, marketProducts.ownerId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'market_product_files_asset_fk',
      columns: [t.assetId, t.ownerId],
      foreignColumns: [assetAssets.id, assetAssets.ownerId],
    }).onDelete('restrict'),
    uniqueIndex('market_product_files_key').on(t.productId, t.assetId, t.role),
    index('market_product_files_asset_idx').on(t.assetId),
    check('market_product_files_role_check', oneOf(t.role, MARKET_FILE_ROLES)),
  ],
)

export const marketListings = pgTable(
  'market_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id').notNull(),
    productId: uuid('product_id').notNull(),
    marketplaceId: uuid('marketplace_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    price: numeric('price', {
      precision: 12,
      scale: 2,
      mode: 'string',
    }).notNull(),
    currency: text('currency').notNull(),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    status: text('status')
      .$type<MarketListingStatus>()
      .notNull()
      .default('planned'),
    listedAt: timestamp('listed_at', tz),
    externalId: text('external_id'),
    url: text('url'),
    evidenceLevel: text('evidence_level').$type<PublishEvidenceLevel>(),
    evidenceNote: text('evidence_note'),
    inactiveAt: timestamp('inactive_at', tz),
    statusReason: text('status_reason'),
  },
  (t) => [
    unique('market_listings_owner_scope_key').on(t.id, t.ownerId),
    unique('market_listings_project_scope_key').on(t.id, t.projectId),
    inOwnProject('market_listings_project_fk', t),
    foreignKey({
      name: 'market_listings_product_fk',
      columns: [t.productId, t.projectId],
      foreignColumns: [marketProducts.id, marketProducts.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'market_listings_marketplace_fk',
      columns: [t.marketplaceId, t.projectId],
      foreignColumns: [marketMarketplaces.id, marketMarketplaces.projectId],
    }).onDelete('restrict'),
    // A product sells once per marketplace at a time.
    uniqueIndex('market_listings_live_key')
      .on(t.productId, t.marketplaceId)
      .where(sql`${t.status} not in ('inactive', 'failed')`),
    uniqueIndex('market_listings_external_key')
      .on(t.marketplaceId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    index('market_listings_owner_idx').on(
      t.ownerId,
      t.projectId,
      t.status,
      t.listedAt,
    ),
    check(
      'market_listings_status_check',
      oneOf(t.status, MARKET_LISTING_STATUSES),
    ),
    check(
      'market_listings_evidence_level_check',
      nullableOneOf(t.evidenceLevel, PUBLISH_EVIDENCE_LEVELS),
    ),
    check('market_listings_title_check', trimmedLength(t.title, 200)),
    check(
      'market_listings_description_check',
      sql`length(${t.description}) <= 20000`,
    ),
    check('market_listings_price_check', sql`${t.price} >= 0`),
    check('market_listings_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('market_listings_tags_check', sql`cardinality(${t.tags}) <= 13`),
    check(
      'market_listings_url_check',
      sql`${t.url} is null or ${t.url} ~ '^https?://' and length(${t.url}) <= 600`,
    ),
    check(
      'market_listings_evidence_check',
      sql`${t.status} not in ('listed', 'verified') or (${t.listedAt} is not null and ${t.evidenceLevel} is not null and (${t.url} is not null or ${t.externalId} is not null))`,
    ),
    check(
      'market_listings_verified_check',
      sql`${t.status} <> 'verified' or ${t.evidenceLevel} = 'provider_verified'`,
    ),
    check(
      'market_listings_inactive_check',
      sql`(${t.status} = 'inactive') = (${t.inactiveAt} is not null)`,
    ),
  ],
)

export const marketIntents = pgTable(
  'market_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id').notNull(),
    listingId: uuid('listing_id').notNull(),
    marketplaceId: uuid('marketplace_id').notNull(),
    authorizationId: uuid('authorization_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    kind: text('kind').$type<MarketKind>().notNull(),
    status: text('status')
      .$type<MarketIntentStatus>()
      .notNull()
      .default('submitting'),
    attempts: integer('attempts').notNull().default(0),
    remoteListingId: text('remote_listing_id'),
    remoteUrl: text('remote_url'),
    verification: jsonb('verification')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    verifiedAt: timestamp('verified_at', tz),
    submittedAt: timestamp('submitted_at', tz),
    nextAttemptAt: timestamp('next_attempt_at', tz),
    error: text('error'),
    actorType: text('actor_type').$type<OpsActorType>().notNull(),
    actorId: text('actor_id').notNull(),
  },
  (t) => [
    unique('market_intents_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('market_intents_project_fk', t),
    foreignKey({
      name: 'market_intents_listing_fk',
      columns: [t.listingId, t.projectId],
      foreignColumns: [marketListings.id, marketListings.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'market_intents_marketplace_fk',
      columns: [t.marketplaceId, t.projectId],
      foreignColumns: [marketMarketplaces.id, marketMarketplaces.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'market_intents_authorization_fk',
      columns: [t.authorizationId, t.ownerId],
      foreignColumns: [
        opsReleaseAuthorizations.id,
        opsReleaseAuthorizations.ownerId,
      ],
    }).onDelete('restrict'),
    uniqueIndex('market_intents_idempotency_key').on(
      t.ownerId,
      t.idempotencyKey,
    ),
    uniqueIndex('market_intents_live_key')
      .on(t.listingId)
      .where(sql`${t.status} in ('submitting', 'submitted', 'unknown')`),
    uniqueIndex('market_intents_remote_key')
      .on(t.marketplaceId, t.remoteListingId)
      .where(sql`${t.remoteListingId} is not null`),
    index('market_intents_queue_idx').on(t.status, t.nextAttemptAt),
    check(
      'market_intents_status_check',
      oneOf(t.status, MARKET_INTENT_STATUSES),
    ),
    check('market_intents_kind_check', oneOf(t.kind, MARKET_KINDS)),
    check('market_intents_actor_check', oneOf(t.actorType, OPS_ACTOR_TYPES)),
    check(
      'market_intents_verified_check',
      sql`${t.status} <> 'verified' or (${t.verifiedAt} is not null and (${t.remoteListingId} is not null or ${t.remoteUrl} is not null))`,
    ),
  ],
)

/**
 * Money from a marketplace, one line at a time, append-only. `gross` is what
 * the buyer paid for a sale (negative for a refund), `fees` what the
 * marketplace kept, `net` what reaches the owner. A correction is a new row
 * that supersedes the old one; the current line is the one nothing
 * supersedes.
 */
export const marketSalesEvents = pgTable(
  'market_sales_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id').notNull(),
    marketplaceId: uuid('marketplace_id').notNull(),
    listingId: uuid('listing_id'),
    kind: text('kind').$type<MarketSaleKind>().notNull(),
    occurredAt: timestamp('occurred_at', tz).notNull(),
    quantity: integer('quantity').notNull().default(1),
    gross: numeric('gross', {
      precision: 12,
      scale: 2,
      mode: 'string',
    }).notNull(),
    fees: numeric('fees', {
      precision: 12,
      scale: 2,
      mode: 'string',
    }).notNull(),
    net: numeric('net', { precision: 12, scale: 2, mode: 'string' }).notNull(),
    currency: text('currency').notNull(),
    /** The order, receipt or transaction it came from, as the marketplace spells it. */
    orderRef: text('order_ref'),
    source: text('source').$type<ReadingSource>().notNull(),
    note: text('note'),
    supersedesId: uuid('supersedes_id'),
    correctionReason: text('correction_reason'),
    actorType: text('actor_type').$type<OpsActorType>().notNull(),
    actorId: text('actor_id').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('market_sales_events_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('market_sales_events_project_fk', t),
    foreignKey({
      name: 'market_sales_events_marketplace_fk',
      columns: [t.marketplaceId, t.projectId],
      foreignColumns: [marketMarketplaces.id, marketMarketplaces.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'market_sales_events_listing_fk',
      columns: [t.listingId, t.projectId],
      foreignColumns: [marketListings.id, marketListings.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'market_sales_events_supersedes_fk',
      columns: [t.supersedesId, t.ownerId],
      foreignColumns: [t.id, t.ownerId],
    }).onDelete('restrict'),
    uniqueIndex('market_sales_events_supersedes_key')
      .on(t.supersedesId)
      .where(sql`${t.supersedesId} is not null`),
    // The same order line (`<order>:<line>`) is recorded once; its
    // corrections chain from it.
    uniqueIndex('market_sales_events_order_key')
      .on(t.marketplaceId, t.kind, t.orderRef)
      .where(sql`${t.orderRef} is not null and ${t.supersedesId} is null`),
    index('market_sales_events_owner_idx').on(
      t.ownerId,
      t.projectId,
      t.occurredAt,
    ),
    index('market_sales_events_listing_idx').on(t.listingId, t.occurredAt),
    check('market_sales_events_kind_check', oneOf(t.kind, MARKET_SALE_KINDS)),
    check(
      'market_sales_events_currency_check',
      sql`${t.currency} ~ '^[A-Z]{3}$'`,
    ),
    check('market_sales_events_quantity_check', sql`${t.quantity} >= 0`),
    check('market_sales_events_fees_check', sql`${t.fees} >= 0`),
    check(
      'market_sales_events_net_check',
      sql`${t.net} = ${t.gross} - ${t.fees}`,
    ),
    check('market_sales_events_source_check', oneOf(t.source, READING_SOURCES)),
    check(
      'market_sales_events_actor_check',
      oneOf(t.actorType, OPS_ACTOR_TYPES),
    ),
    check(
      'market_sales_events_correction_check',
      sql`${t.supersedesId} is null or ${t.correctionReason} is not null`,
    ),
  ],
)

export const marketPayouts = pgTable(
  'market_payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id').notNull(),
    marketplaceId: uuid('marketplace_id').notNull(),
    amount: numeric('amount', {
      precision: 12,
      scale: 2,
      mode: 'string',
    }).notNull(),
    currency: text('currency').notNull(),
    status: text('status')
      .$type<MarketPayoutStatus>()
      .notNull()
      .default('expected'),
    /** When the marketplace says it pays. */
    expectedOn: date('expected_on', { mode: 'string' }),
    /** When the bank showed it — set only by the owner. */
    paidOn: date('paid_on', { mode: 'string' }),
    reference: text('reference'),
    note: text('note'),
  },
  (t) => [
    unique('market_payouts_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('market_payouts_project_fk', t),
    foreignKey({
      name: 'market_payouts_marketplace_fk',
      columns: [t.marketplaceId, t.projectId],
      foreignColumns: [marketMarketplaces.id, marketMarketplaces.projectId],
    }).onDelete('restrict'),
    uniqueIndex('market_payouts_reference_key')
      .on(t.marketplaceId, t.reference)
      .where(sql`${t.reference} is not null`),
    index('market_payouts_owner_idx').on(t.ownerId, t.projectId, t.status),
    check(
      'market_payouts_status_check',
      oneOf(t.status, MARKET_PAYOUT_STATUSES),
    ),
    check('market_payouts_amount_check', sql`${t.amount} >= 0`),
    check('market_payouts_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'market_payouts_paid_check',
      sql`(${t.status} = 'confirmed') = (${t.paidOn} is not null)`,
    ),
  ],
)

export type MarketMarketplaceRow = typeof marketMarketplaces.$inferSelect
export type MarketProductRow = typeof marketProducts.$inferSelect
export type MarketProductFileRow = typeof marketProductFiles.$inferSelect
export type MarketListingRow = typeof marketListings.$inferSelect
export type MarketIntentRow = typeof marketIntents.$inferSelect
export type MarketSalesEventRow = typeof marketSalesEvents.$inferSelect
export type MarketPayoutRow = typeof marketPayouts.$inferSelect
