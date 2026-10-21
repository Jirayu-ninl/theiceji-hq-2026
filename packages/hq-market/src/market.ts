import { createHash } from 'node:crypto'
import { assetAccess, assetTitle } from '@theiceji/hq-assets/assets'
import { parseAmount } from '@theiceji/hq-core/money'
import { link, refsOf } from '@theiceji/hq-core/refs'
import {
  MARKET_FILE_ROLES,
  MARKET_KINDS,
  MARKET_LISTING_STATUSES,
  MARKET_PRODUCT_STATUSES,
  PUBLISH_EVIDENCE_LEVELS,
  type PublishEvidenceLevel,
} from '@theiceji/hq-db/enums'
import {
  type AssetRow,
  assetAssets,
  type MarketIntentRow,
  type MarketListingRow,
  type MarketMarketplaceRow,
  type MarketProductRow,
  marketIntents,
  marketListings,
  marketMarketplaces,
  marketProductFiles,
  marketProducts,
  type OpsPolicyRow,
  type OpsReleaseAuthorizationRow,
  opsReleaseAuthorizations,
  type ProjectRow,
  type ProviderConnectionRow,
  projects,
  providerConnections,
  type RefRow,
  refs,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan } from '@theiceji/hq-ops/access'
import { schedulerActor } from '@theiceji/hq-ops/actors'
import { dbNow, type Reader, type Tx } from '@theiceji/hq-ops/db'
import {
  capabilityUnavailable,
  conflict,
  invalid,
  notFound,
  policyBlocked,
  reauthRequired,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  type Blocker,
  consumeAuthorization,
  issueAuthorization,
} from '@theiceji/hq-ops/release'
import {
  choice,
  idempotencyKey,
  optionalChoice,
  optionalRecordId,
  parseInput,
  recordId,
  revision,
  stringList,
  text,
} from '@theiceji/hq-ops/schemas'
import { seal, secretHint, unseal } from '@theiceji/hq-ops/secrets'
import {
  assertModuleOn,
  audit,
  auditTrail,
  authorize,
  ownedProject,
  ownedRecord,
  ownedRow,
  returned,
  runOperation,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { parseInstant } from '@theiceji/hq-ops/time'
import { auditSnapshot, diffFields } from '@theiceji/hq-ops/values'
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import {
  type AdapterContext,
  type AdapterFile,
  type ListingSubmitted,
  marketplaceAdapter,
  ReauthRequired,
  RemoteTimeout,
} from './adapters/types'
import {
  fileBinding,
  hashPayload,
  listingBlockers,
  listingParts,
  MARKET_RULES,
  type ProductFile,
  payloadOf,
} from './payload'

/**
 * Market: digital assets for sale.
 *
 * · **Marketplaces are the owner's to add** (where a project sells, through
 *   which connection). Products, their files and listing plans are drafting —
 *   an agent may do them where the owner's policy allows.
 * · **A listing leaves HQ like a post**: under a release authorization bound
 *   to the hash of exactly what it sends — the owner's approval, or a policy
 *   that releases by itself. Changing an approved listing makes the approval
 *   stop fitting; it goes back to planned and says why.
 * · **Two ways out.** By hand: someone lists it and records the URL — an
 *   agent only under a live approval, which it uses up. Through an API: the
 *   Etsy adapter sends it and the ops tick reads it back; an unknown outcome
 *   is looked up, never sent twice.
 * · **Out means evidence**, like a post: a time, how we know, a URL or ID.
 */

registerConstraintMessages({
  market_marketplaces_shop_key:
    'That shop is already in this project. Restore it instead.',
  market_listings_live_key:
    'This product is already listed (or planned) on that marketplace.',
  market_listings_external_key: 'That listing is already on the record.',
  market_listings_evidence_check:
    'A listing that is out needs a time, evidence and a URL or listing ID.',
  market_product_files_asset_fk: 'That file isn’t yours to sell.',
  market_intents_live_key: 'This listing is already being sent.',
})

/* ── Shapes ─────────────────────────────────────────────────────────── */

export type ProjectLite = Pick<
  ProjectRow,
  'id' | 'slug' | 'name' | 'color' | 'status' | 'kind' | 'timezone' | 'currency'
>

const projectLite = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  color: projects.color,
  status: projects.status,
  kind: projects.kind,
  timezone: projects.timezone,
  currency: projects.currency,
}

export type MarketplaceReadiness = {
  mode: 'api' | 'manual' | 'reconnect'
  note: string
}

export type MarketplaceView = MarketMarketplaceRow & {
  readiness: MarketplaceReadiness
  connection: Pick<ProviderConnectionRow, 'id' | 'label' | 'status'> | null
  listings: number
}

export type ProductView = MarketProductRow & {
  /** With the owner's title for each (HQ shows it); `name` stays the file's. */
  files: (ProductFile & Pick<AssetRow, 'title'>)[]
  listings: number
}

export type ListingListItem = MarketListingRow & {
  product: Pick<MarketProductRow, 'id' | 'title' | 'status'>
  marketplace: Pick<MarketMarketplaceRow, 'id' | 'kind' | 'shop' | 'currency'>
  project: ProjectLite
  clearance: Pick<
    OpsReleaseAuthorizationRow,
    'id' | 'mode' | 'expiresAt' | 'approvedBy'
  > | null
}

export type ListingDetail = {
  listing: MarketListingRow
  product: MarketProductRow
  marketplace: MarketplaceView
  project: ProjectRow
  /** What goes out, with the owner's title for each (HQ shows it). */
  files: (ProductFile & Pick<AssetRow, 'title'>)[]
  clearance: OpsReleaseAuthorizationRow | null
  blockers: Blocker[]
  payloadHash: string
  intents: MarketIntentRow[]
  refs: RefRow[]
  history: Awaited<ReturnType<typeof auditTrail>>
}

/* ── Inputs ─────────────────────────────────────────────────────────── */

const url = (label: string) =>
  z.preprocess(
    (value) =>
      typeof value === 'string' ? value.trim() || null : (value ?? undefined),
    z
      .string()
      .max(600, `${label} must be 600 characters or fewer.`)
      .regex(
        /^https?:\/\/\S+$/i,
        `${label} must start with http:// or https://.`,
      )
      .nullable()
      .optional(),
  )

const currencyField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, like USD.')

const priceField = z.union([z.string().max(20), z.number().min(0)])

function priceOf(raw: string | number, currency: string): string {
  const parsed = parseAmount(raw, currency)
  if ('error' in parsed) throw invalid(parsed.error, { price: parsed.error })
  return parsed.ok
}

/** Tags: trimmed, lowercase, no repeats, at most 13. */
export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of raw) {
    const tag = entry.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out.slice(0, 13)
}

/* ── Marketplaces ───────────────────────────────────────────────────── */

function readinessOf(
  marketplace: MarketMarketplaceRow,
  connection: Pick<ProviderConnectionRow, 'id' | 'label' | 'status'> | null,
): MarketplaceReadiness {
  const label = MARKET_RULES[marketplace.kind].label
  if (marketplace.kind === 'manual')
    return { mode: 'manual', note: 'Listed by hand, recorded here.' }
  if (!marketplaceAdapter(marketplace.kind))
    return {
      mode: 'manual',
      note: `HQ can’t list on ${label} by itself — list by hand and record it.`,
    }
  if (!connection)
    return {
      mode: 'manual',
      note: `No ${label} connection — list by hand, or connect it in Settings › Connections.`,
    }
  if (connection.status !== 'connected')
    return {
      mode: 'reconnect',
      note: `The ${label} connection needs you in Settings › Connections.`,
    }
  return { mode: 'api', note: `HQ lists through ${connection.label}.` }
}

async function marketplaceViews(
  reader: Reader,
  ownerId: string,
  where: ReturnType<typeof and>,
): Promise<MarketplaceView[]> {
  const counts = reader
    .select({
      marketplaceId: marketListings.marketplaceId,
      n: sql<number>`count(*)::int`.as('n'),
    })
    .from(marketListings)
    .where(eq(marketListings.ownerId, ownerId))
    .groupBy(marketListings.marketplaceId)
    .as('listing_counts')
  const rows = await reader
    .select({
      marketplace: marketMarketplaces,
      connection: {
        id: providerConnections.id,
        label: providerConnections.label,
        status: providerConnections.status,
      },
      listings: counts.n,
    })
    .from(marketMarketplaces)
    .leftJoin(
      providerConnections,
      eq(providerConnections.id, marketMarketplaces.connectionId),
    )
    .leftJoin(counts, eq(counts.marketplaceId, marketMarketplaces.id))
    .where(and(eq(marketMarketplaces.ownerId, ownerId), where))
    .orderBy(asc(marketMarketplaces.kind), asc(marketMarketplaces.shop))
  return rows.map((row) => {
    const connection = row.connection?.id ? row.connection : null
    return {
      ...row.marketplace,
      connection,
      readiness: readinessOf(row.marketplace, connection),
      listings: row.listings ?? 0,
    }
  })
}

export async function listMarketplaces(
  actor: Actor,
  raw: { projectId: string; includeArchived?: boolean },
): Promise<MarketplaceView[]> {
  const input = parseInput(
    z.object({
      projectId: recordId('Project'),
      includeArchived: z.boolean().optional(),
    }),
    raw,
  )
  return withReader(async (db) => {
    const project = await ownedProject(
      db,
      actor,
      input.projectId,
      'market',
      'read',
    )
    assertModuleOn(project, 'market')
    return marketplaceViews(
      db,
      actor.userId,
      and(
        eq(marketMarketplaces.projectId, project.id),
        input.includeArchived
          ? undefined
          : isNull(marketMarketplaces.archivedAt),
      ),
    )
  })
}

const feeField = z
  .string()
  .trim()
  .regex(/^\d{1,6}(\.\d{1,4})?$/, 'A fee is a number, like 6.5 or 0.20.')
  .optional()

const marketplaceSchema = z.object({
  projectId: recordId('Project'),
  marketplaceId: optionalRecordId('Marketplace'),
  expectedRevision: revision.optional(),
  kind: choice(MARKET_KINDS, 'Choose Etsy, print on demand, Gumroad or Other.'),
  shop: text.required('Shop', 120),
  url: url('Shop URL'),
  externalShopId: text.optional('Shop ID', 120),
  connectionId: optionalRecordId('Connection'),
  currency: currencyField.optional(),
  feeSheet: z
    .object({
      listingFee: feeField,
      transactionPct: feeField,
      processingPct: feeField,
      processingFixed: feeField,
    })
    .optional(),
  settings: z
    .object({
      whoMade: z.enum(['i_did', 'someone_else', 'collective']).optional(),
      whenMade: z.string().trim().max(40).optional(),
      taxonomyId: z.string().trim().max(20).optional(),
      quantity: z.number().int().min(1).max(999).optional(),
    })
    .optional(),
})

export type SaveMarketplaceInput = z.input<typeof marketplaceSchema>

/** Add a marketplace to a project, or change one. The owner's. */
export async function saveMarketplace(
  actor: Actor,
  raw: SaveMarketplaceInput,
): Promise<MarketMarketplaceRow> {
  const input = parseInput(marketplaceSchema, raw)
  return withTransaction(async (tx) => {
    const project = await ownedProject(
      tx,
      actor,
      input.projectId,
      'market',
      'write',
      'owner_only',
    )
    assertModuleOn(project, 'market')
    if (input.connectionId) {
      const [connection] = await tx
        .select()
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, input.connectionId),
            eq(providerConnections.ownerId, actor.userId),
          ),
        )
        .limit(1)
      if (!connection || connection.revokedAt) throw notFound('Connection')
      if (connection.provider !== input.kind)
        throw invalid(
          `That connection is for ${connection.provider}, not ${MARKET_RULES[input.kind].label}.`,
          { connectionId: 'Choose a connection for this marketplace.' },
        )
    }
    const fields = {
      kind: input.kind,
      shop: input.shop as string,
      url: input.url ?? null,
      externalShopId: input.externalShopId ?? null,
      connectionId: input.connectionId ?? null,
      currency: input.currency ?? project.currency,
      feeSheet: Object.fromEntries(
        Object.entries(input.feeSheet ?? {}).filter(([, value]) => value),
      ),
      settings: input.settings ?? {},
    }
    if (!input.marketplaceId) {
      const [row] = await tx
        .insert(marketMarketplaces)
        .values({
          ownerId: actor.userId,
          createdBy: actor.userId,
          projectId: project.id,
          ...fields,
        })
        .returning()
      const marketplace = returned(row)
      await audit(tx, actor, {
        projectId: project.id,
        action: 'market.marketplace.create',
        targetType: 'marketplace',
        targetId: marketplace.id,
        afterRevision: marketplace.revision,
        changes: auditSnapshot({
          kind: marketplace.kind,
          shop: marketplace.shop,
          currency: marketplace.currency,
        }),
      })
      return marketplace
    }
    const [current] = await tx
      .select()
      .from(marketMarketplaces)
      .where(
        and(
          eq(marketMarketplaces.id, input.marketplaceId),
          eq(marketMarketplaces.ownerId, actor.userId),
          eq(marketMarketplaces.projectId, project.id),
        ),
      )
      .for('update')
    if (!current) throw notFound('Marketplace')
    if (input.expectedRevision && current.revision !== input.expectedRevision)
      throw conflict()
    const changes = diffFields(
      current as unknown as Record<string, unknown>,
      fields,
    )
    if (Object.keys(changes).length === 0) return current
    const [row] = await tx
      .update(marketMarketplaces)
      .set({
        ...fields,
        revision: sql`${marketMarketplaces.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(marketMarketplaces.id, current.id))
      .returning()
    const marketplace = returned(row)
    // What a listing sends names the shop: approvals made before this no
    // longer fit, so those listings go back to planned and say why.
    if (
      ['kind', 'shop', 'externalShopId', 'settings'].some(
        (field) => field in changes,
      )
    ) {
      const approved = await tx
        .select()
        .from(marketListings)
        .where(
          and(
            eq(marketListings.marketplaceId, marketplace.id),
            eq(marketListings.status, 'approved'),
          ),
        )
        .for('update')
      for (const listing of approved) {
        await revokeClearances(
          tx,
          actor,
          listing,
          'The marketplace changed after it was approved.',
        )
        await saveListing(tx, listing, {
          status: 'planned',
          statusReason:
            'Its marketplace changed after it was approved — approve it again.',
        })
      }
    }
    await audit(tx, actor, {
      projectId: project.id,
      action: 'market.marketplace.update',
      targetType: 'marketplace',
      targetId: marketplace.id,
      beforeRevision: current.revision,
      afterRevision: marketplace.revision,
      changes,
    })
    return marketplace
  })
}

export async function setMarketplaceArchived(
  actor: Actor,
  raw: { marketplaceId: string; expectedRevision: number; archived: boolean },
): Promise<MarketMarketplaceRow> {
  const input = parseInput(
    z.object({
      marketplaceId: recordId('Marketplace'),
      expectedRevision: revision,
      archived: z.boolean(),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { row, project } = await ownedRecord<MarketMarketplaceRow>(
      tx,
      actor,
      marketMarketplaces,
      input.marketplaceId,
      'market',
      'write',
      'Marketplace',
      'owner_only',
    )
    if (row.revision !== input.expectedRevision) throw conflict()
    if (Boolean(row.archivedAt) === input.archived) return row
    const saved = returned(
      (
        await tx
          .update(marketMarketplaces)
          .set({
            archivedAt: input.archived ? sql`now()` : null,
            revision: sql`${marketMarketplaces.revision} + 1`,
            updatedAt: sql`now()`,
          })
          .where(eq(marketMarketplaces.id, row.id))
          .returning()
      )[0],
    )
    await audit(tx, actor, {
      projectId: project?.id ?? null,
      action: input.archived
        ? 'market.marketplace.archive'
        : 'market.marketplace.restore',
      targetType: 'marketplace',
      targetId: saved.id,
      beforeRevision: row.revision,
      afterRevision: saved.revision,
    })
    return saved
  })
}

/* ── Products ───────────────────────────────────────────────────────── */

export async function listProducts(
  actor: Actor,
  raw: { projectId: string; includeRetired?: boolean },
): Promise<ProductView[]> {
  const input = parseInput(
    z.object({
      projectId: recordId('Project'),
      includeRetired: z.boolean().optional(),
    }),
    raw,
  )
  return withReader(async (db) => {
    const project = await ownedProject(
      db,
      actor,
      input.projectId,
      'market',
      'read',
    )
    assertModuleOn(project, 'market')
    const counts = db
      .select({
        productId: marketListings.productId,
        n: sql<number>`count(*)::int`.as('n'),
      })
      .from(marketListings)
      .where(eq(marketListings.ownerId, actor.userId))
      .groupBy(marketListings.productId)
      .as('product_listing_counts')
    const rows = await db
      .select({ product: marketProducts, listings: counts.n })
      .from(marketProducts)
      .leftJoin(counts, eq(counts.productId, marketProducts.id))
      .where(
        and(
          eq(marketProducts.ownerId, actor.userId),
          eq(marketProducts.projectId, project.id),
          input.includeRetired
            ? undefined
            : sql`${marketProducts.status} <> 'retired'`,
        ),
      )
      .orderBy(desc(marketProducts.updatedAt))
    const files = rows.length
      ? await db
          .select({
            productId: marketProductFiles.productId,
            id: assetAssets.id,
            name: assetAssets.name,
            title: assetAssets.title,
            kind: assetAssets.kind,
            mime: assetAssets.mime,
            status: assetAssets.status,
            sha256: assetAssets.sha256,
            bytes: assetAssets.bytes,
            role: marketProductFiles.role,
            position: marketProductFiles.position,
          })
          .from(marketProductFiles)
          .innerJoin(
            assetAssets,
            eq(assetAssets.id, marketProductFiles.assetId),
          )
          .where(
            inArray(
              marketProductFiles.productId,
              rows.map((row) => row.product.id),
            ),
          )
          .orderBy(
            asc(marketProductFiles.role),
            asc(marketProductFiles.position),
          )
      : []
    return rows.map((row) => ({
      ...row.product,
      listings: row.listings ?? 0,
      files: files
        .filter((file) => file.productId === row.product.id)
        .map(({ productId: _, ...file }) => file),
    }))
  })
}

const productSchema = z.object({
  projectId: recordId('Project'),
  productId: optionalRecordId('Product'),
  expectedRevision: revision.optional(),
  title: text.required('Title', 200),
  description: text.optional('Description', 20000),
  status: optionalChoice(MARKET_PRODUCT_STATUSES, 'Choose a status.'),
  price: priceField.nullable().optional(),
  currency: currencyField.optional(),
  tags: stringList('tags', 13, 40).optional(),
  idempotencyKey: idempotencyKey.optional(),
})

export type SaveProductInput = z.input<typeof productSchema>

/** A new product, or changes to one. Drafting. */
export async function saveProduct(
  actor: Actor,
  raw: SaveProductInput,
): Promise<MarketProductRow> {
  const input = parseInput(productSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'market_save_product',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const project = await ownedProject(
          tx,
          actor,
          input.projectId,
          'market',
          'write',
        )
        assertModuleOn(project, 'market')
        const currency = input.currency ?? project.currency
        const price =
          input.price === undefined
            ? undefined
            : input.price === null || input.price === ''
              ? null
              : priceOf(input.price, currency)
        if (!input.productId) {
          const [row] = await tx
            .insert(marketProducts)
            .values({
              ownerId: actor.userId,
              createdBy: actor.userId,
              projectId: project.id,
              title: input.title as string,
              description: input.description ?? '',
              status: input.status ?? 'draft',
              price: price ?? null,
              currency: price ? currency : null,
              tags: normalizeTags(input.tags ?? []),
            })
            .returning()
          const product = returned(row)
          await audit(tx, actor, {
            projectId: project.id,
            action: 'market.product.create',
            targetType: 'product',
            targetId: product.id,
            afterRevision: product.revision,
            changes: auditSnapshot({
              title: product.title,
              price: product.price,
              currency: product.currency,
            }),
          })
          return product
        }
        const [current] = await tx
          .select()
          .from(marketProducts)
          .where(
            and(
              eq(marketProducts.id, input.productId),
              eq(marketProducts.ownerId, actor.userId),
              eq(marketProducts.projectId, project.id),
            ),
          )
          .for('update')
        if (!current) throw notFound('Product')
        if (
          input.expectedRevision &&
          current.revision !== input.expectedRevision
        )
          throw conflict()
        const patch: Partial<typeof marketProducts.$inferInsert> = {
          title: input.title as string,
        }
        if (input.description !== undefined)
          patch.description = input.description ?? ''
        if (input.status) patch.status = input.status
        if (price !== undefined) {
          patch.price = price
          patch.currency = price ? currency : null
        }
        if (input.tags !== undefined) patch.tags = normalizeTags(input.tags)
        const changes = diffFields(
          current as unknown as Record<string, unknown>,
          patch,
        )
        if (Object.keys(changes).length === 0) return current
        const product = returned(
          (
            await tx
              .update(marketProducts)
              .set({
                ...patch,
                revision: sql`${marketProducts.revision} + 1`,
                updatedAt: sql`now()`,
              })
              .where(eq(marketProducts.id, current.id))
              .returning()
          )[0],
        )
        await audit(tx, actor, {
          projectId: project.id,
          action: 'market.product.update',
          targetType: 'product',
          targetId: product.id,
          beforeRevision: current.revision,
          afterRevision: product.revision,
          changes,
        })
        return product
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.product_id
    if (typeof id !== 'string') throw conflict()
    const row = await withReader(async (db) => {
      const found = await ownedRecord<MarketProductRow>(
        db,
        actor,
        marketProducts,
        id,
        'market',
        'read',
        'Product',
      )
      return found.row
    })
    return row
  }
  await outcome.complete({ product_id: outcome.value.id })
  return outcome.value
}

const filesSchema = z.object({
  productId: recordId('Product'),
  expectedRevision: revision,
  files: z
    .array(
      z.object({
        assetId: recordId('Asset'),
        role: choice(
          MARKET_FILE_ROLES,
          'Say whether it is a download or an image.',
        ),
      }),
    )
    .max(40, 'List at most 40 files.'),
})

/**
 * Replace a product's files — the downloads and the images, in order. Every
 * listing still planned or approved is re-judged against them when it next
 * goes out; an approved one no longer fits and goes back to planned.
 */
export async function setProductFiles(
  actor: Actor,
  raw: z.input<typeof filesSchema>,
): Promise<ProductView> {
  const input = parseInput(filesSchema, raw)
  await withTransaction(async (tx) => {
    const { row: product, project } = await ownedRow<MarketProductRow>(
      tx,
      actor,
      marketProducts,
      input.productId,
      'Product',
      { lock: true },
    )
    if (!project) throw notFound('Product')
    await authorize(tx, actor, project, 'market', 'write')
    assertModuleOn(project, 'market')
    if (product.revision !== input.expectedRevision) throw conflict()
    const seen = new Set<string>()
    for (const file of input.files) {
      const key = `${file.assetId}:${file.role}`
      if (seen.has(key)) throw invalid('A file is listed twice.')
      seen.add(key)
      const { row: asset } = await ownedRecord<AssetRow>(
        tx,
        actor,
        assetAssets,
        file.assetId,
        'assets',
        'read',
        'Asset',
      )
      if (asset.status === 'rejected')
        throw invalid(`${assetTitle(asset)} was rejected; choose another file.`)
      if (asset.projectId && asset.projectId !== project.id)
        throw invalid(`${assetTitle(asset)} belongs to another project.`)
      if (file.role === 'preview' && asset.kind !== 'image')
        throw invalid(
          `${assetTitle(asset)} isn’t an image, so it can’t be a preview.`,
        )
    }
    await tx
      .delete(marketProductFiles)
      .where(eq(marketProductFiles.productId, product.id))
    if (input.files.length)
      await tx.insert(marketProductFiles).values(
        input.files.map((file, position) => ({
          ownerId: actor.userId,
          productId: product.id,
          assetId: file.assetId,
          role: file.role,
          position,
        })),
      )
    await tx
      .update(marketProducts)
      .set({
        revision: sql`${marketProducts.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(marketProducts.id, product.id))
    // Approved listings of this product no longer carry what was approved.
    const approved = await tx
      .select()
      .from(marketListings)
      .where(
        and(
          eq(marketListings.productId, product.id),
          eq(marketListings.status, 'approved'),
        ),
      )
      .for('update')
    for (const listing of approved) {
      await revokeClearances(tx, actor, listing, 'The product’s files changed.')
      await saveListing(tx, listing, {
        status: 'planned',
        statusReason:
          'Its files changed after it was approved — approve it again.',
      })
    }
    await audit(tx, actor, {
      projectId: project.id,
      action: 'market.product.files',
      targetType: 'product',
      targetId: product.id,
      beforeRevision: product.revision,
      afterRevision: product.revision + 1,
      changes: {
        files: input.files.map((file) => `${file.role}:${file.assetId}`),
      },
    })
  })
  const views = await listProducts(actor, {
    projectId: (
      await withReader((db) =>
        ownedRecord<MarketProductRow>(
          db,
          actor,
          marketProducts,
          input.productId,
          'market',
          'read',
          'Product',
        ),
      )
    ).row.projectId,
    includeRetired: true,
  })
  const view = views.find((entry) => entry.id === input.productId)
  if (!view) throw notFound('Product')
  return view
}

/* ── Reading listings ───────────────────────────────────────────────── */

async function liveClearances(
  reader: Reader,
  ownerId: string,
  listingIds: readonly string[],
): Promise<Map<string, OpsReleaseAuthorizationRow>> {
  if (listingIds.length === 0) return new Map()
  const rows = await reader
    .select()
    .from(opsReleaseAuthorizations)
    .where(
      and(
        eq(opsReleaseAuthorizations.ownerId, ownerId),
        eq(opsReleaseAuthorizations.module, 'market'),
        eq(opsReleaseAuthorizations.subjectType, 'listing'),
        inArray(opsReleaseAuthorizations.subjectId, [...listingIds]),
        eq(opsReleaseAuthorizations.status, 'active'),
        sql`${opsReleaseAuthorizations.expiresAt} > now()`,
      ),
    )
    .orderBy(desc(opsReleaseAuthorizations.createdAt))
  const out = new Map<string, OpsReleaseAuthorizationRow>()
  for (const row of rows)
    if (!out.has(row.subjectId)) out.set(row.subjectId, row)
  return out
}

const listSchema = z.object({
  projectId: optionalRecordId('Project'),
  marketplaceId: optionalRecordId('Marketplace'),
  productId: optionalRecordId('Product'),
  status: z.array(z.enum(MARKET_LISTING_STATUSES)).optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

export type ListListingsInput = z.input<typeof listSchema>

export async function listListings(
  actor: Actor,
  raw: ListListingsInput = {},
): Promise<ListingListItem[]> {
  const input = parseInput(listSchema, raw)
  return withReader(async (db) => {
    if (input.projectId) {
      const project = await ownedProject(
        db,
        actor,
        input.projectId,
        'market',
        'read',
      )
      assertModuleOn(project, 'market')
    } else await authorize(db, actor, null, 'market', 'read')
    const rows = await db
      .select({
        listing: marketListings,
        product: {
          id: marketProducts.id,
          title: marketProducts.title,
          status: marketProducts.status,
        },
        marketplace: {
          id: marketMarketplaces.id,
          kind: marketMarketplaces.kind,
          shop: marketMarketplaces.shop,
          currency: marketMarketplaces.currency,
        },
        project: projectLite,
      })
      .from(marketListings)
      .innerJoin(
        marketProducts,
        eq(marketProducts.id, marketListings.productId),
      )
      .innerJoin(
        marketMarketplaces,
        eq(marketMarketplaces.id, marketListings.marketplaceId),
      )
      .innerJoin(projects, eq(projects.id, marketListings.projectId))
      .where(
        and(
          eq(marketListings.ownerId, actor.userId),
          input.projectId
            ? eq(marketListings.projectId, input.projectId)
            : sql`(${projects.status} <> 'archived' and ${projects.modules} -> 'enabled' ? 'market')`,
          input.marketplaceId
            ? eq(marketListings.marketplaceId, input.marketplaceId)
            : undefined,
          input.productId
            ? eq(marketListings.productId, input.productId)
            : undefined,
          input.status?.length
            ? inArray(marketListings.status, input.status)
            : undefined,
        ),
      )
      .orderBy(
        sql`coalesce(${marketListings.listedAt}, ${marketListings.createdAt}) desc`,
      )
      .limit(input.limit ?? 200)
    const clearances = await liveClearances(
      db,
      actor.userId,
      rows.map((row) => row.listing.id),
    )
    return rows.map((row) => {
      const clearance = clearances.get(row.listing.id)
      return {
        ...row.listing,
        product: row.product,
        marketplace: row.marketplace,
        project: row.project,
        clearance: clearance
          ? {
              id: clearance.id,
              mode: clearance.mode,
              expiresAt: clearance.expiresAt,
              approvedBy: clearance.approvedBy,
            }
          : null,
      }
    })
  })
}

export async function getListing(
  actor: Actor,
  listingId: string,
): Promise<ListingDetail> {
  return withReader(async (db) => {
    const { project } = await ownedRecord<MarketListingRow>(
      db,
      actor,
      marketListings,
      listingId,
      'market',
      'read',
      'Listing',
    )
    if (!project) throw notFound('Listing')
    const parts = await listingParts(db, actor.userId, listingId)
    const [views, clearances, intents, links, history, titles] =
      await Promise.all([
        marketplaceViews(
          db,
          actor.userId,
          eq(marketMarketplaces.id, parts.marketplace.id),
        ),
        liveClearances(db, actor.userId, [listingId]),
        db
          .select()
          .from(marketIntents)
          .where(eq(marketIntents.listingId, listingId))
          .orderBy(desc(marketIntents.createdAt)),
        refsOf(db, actor.userId, { type: 'listing', id: listingId }),
        auditTrail(db, actor.userId, [listingId], 30),
        // The owner's titles, for HQ to show; the files go out under their names.
        parts.files.length
          ? db
              .select({ id: assetAssets.id, title: assetAssets.title })
              .from(assetAssets)
              .where(
                and(
                  eq(assetAssets.ownerId, actor.userId),
                  inArray(
                    assetAssets.id,
                    parts.files.map((file) => file.id),
                  ),
                ),
              )
          : Promise.resolve([]),
      ])
    return {
      listing: parts.listing,
      product: parts.product,
      marketplace: returned(views[0]),
      project,
      files: parts.files.map((file) => ({
        ...file,
        title: titles.find((entry) => entry.id === file.id)?.title ?? null,
      })),
      clearance: clearances.get(listingId) ?? null,
      blockers: listingBlockers(
        parts.listing,
        parts.product,
        parts.marketplace,
        parts.files,
      ),
      payloadHash: hashPayload(
        payloadOf(parts.listing, parts.marketplace, parts.files),
      ),
      intents,
      refs: links,
      history,
    }
  })
}

/* ── Writing listings ───────────────────────────────────────────────── */

async function listingForWrite(
  tx: Tx,
  actor: Actor,
  listingId: string,
  capability: 'write' | 'operate',
  requirement?: 'owner_only' | 'list' | 'draft',
): Promise<{
  listing: MarketListingRow
  project: ProjectRow
  /** The owner's policy an agent is acting under; null for the owner. */
  policy: OpsPolicyRow | null
}> {
  assertCan(actor, 'market', capability)
  const { row: listing, project } = await ownedRow<MarketListingRow>(
    tx,
    actor,
    marketListings,
    listingId,
    'Listing',
    { lock: true },
  )
  if (!project) throw notFound('Listing')
  const policy = await authorize(
    tx,
    actor,
    project,
    'market',
    capability,
    requirement,
  )
  assertModuleOn(project, 'market')
  return { listing, project, policy }
}

/** An agent lists only on marketplaces the owner's policy names. */
function assertMarketplaceAllowed(
  policy: OpsPolicyRow | null,
  marketplace: MarketMarketplaceRow,
): void {
  if (policy && !policy.allowedAccountIds.includes(marketplace.id))
    throw policyBlocked(
      `The operating policy doesn’t allow listing on ${marketplace.shop}. Only the owner can add it.`,
      {
        blockers: [
          {
            key: 'target_not_allowed',
            message: `${marketplace.shop} isn’t in the policy’s marketplaces.`,
          },
        ],
      },
    )
}

async function saveListing(
  tx: Tx,
  listing: MarketListingRow,
  patch: PgUpdateSetSource<typeof marketListings>,
): Promise<MarketListingRow> {
  const [row] = await tx
    .update(marketListings)
    .set({
      ...patch,
      revision: sql`${marketListings.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(marketListings.id, listing.id),
        eq(marketListings.revision, listing.revision),
      ),
    )
    .returning()
  if (!row) throw conflict()
  return row
}

async function revokeClearances(
  tx: Tx,
  actor: Actor,
  listing: MarketListingRow,
  reason: string,
): Promise<void> {
  const revoked = await tx
    .update(opsReleaseAuthorizations)
    .set({ status: 'revoked', revokedAt: sql`now()`, statusReason: reason })
    .where(
      and(
        eq(opsReleaseAuthorizations.ownerId, actor.userId),
        eq(opsReleaseAuthorizations.module, 'market'),
        eq(opsReleaseAuthorizations.subjectType, 'listing'),
        eq(opsReleaseAuthorizations.subjectId, listing.id),
        eq(opsReleaseAuthorizations.status, 'active'),
      ),
    )
    .returning({ id: opsReleaseAuthorizations.id })
  for (const row of revoked)
    await audit(tx, actor, {
      projectId: listing.projectId,
      action: 'release.revoke',
      targetType: 'release_authorization',
      targetId: row.id,
      reason,
    })
}

const planSchema = z.object({
  productId: recordId('Product'),
  marketplaceId: recordId('Marketplace'),
  title: text.optional('Title', 200),
  description: text.optional('Description', 20000),
  price: priceField.optional(),
  tags: stringList('tags', 13, 40).optional(),
  fromCardId: optionalRecordId('Card'),
  idempotencyKey: idempotencyKey.optional(),
})

export type PlanListingInput = z.input<typeof planSchema>

/**
 * A planned listing of a product on one marketplace, starting from the
 * product's title, description, price and tags. Nothing is listed until the
 * owner approves it.
 */
export async function planListing(
  actor: Actor,
  raw: PlanListingInput,
): Promise<MarketListingRow> {
  const input = parseInput(planSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'market_prepare',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { row: product, project } = await ownedRecord<MarketProductRow>(
          tx,
          actor,
          marketProducts,
          input.productId,
          'market',
          'write',
          'Product',
        )
        if (!project) throw notFound('Product')
        assertModuleOn(project, 'market')
        if (product.status === 'retired')
          throw invalid('This product is retired.')
        const [marketplace] = await tx
          .select()
          .from(marketMarketplaces)
          .where(
            and(
              eq(marketMarketplaces.id, input.marketplaceId),
              eq(marketMarketplaces.ownerId, actor.userId),
              eq(marketMarketplaces.projectId, project.id),
            ),
          )
          .limit(1)
        if (!marketplace) throw notFound('Marketplace')
        if (marketplace.archivedAt)
          throw invalid(`${marketplace.shop} is archived.`)
        const currency = marketplace.currency
        const rawPrice =
          input.price ?? (product.currency === currency ? product.price : null)
        if (rawPrice === null || rawPrice === undefined)
          throw invalid(
            `Give the price in ${currency} — the product has none in that currency.`,
            { price: `Price in ${currency}` },
          )
        const [row] = await tx
          .insert(marketListings)
          .values({
            ownerId: actor.userId,
            createdBy: actor.userId,
            projectId: project.id,
            productId: product.id,
            marketplaceId: marketplace.id,
            title: input.title ?? product.title,
            description: input.description ?? product.description,
            price: priceOf(rawPrice, currency),
            currency,
            tags: normalizeTags(input.tags ?? product.tags),
          })
          .returning()
        const listing = returned(row)
        if (input.fromCardId)
          await link(
            tx,
            actor,
            { type: 'card', id: input.fromCardId },
            { type: 'listing', id: listing.id },
            'listed_as',
          )
        await audit(tx, actor, {
          projectId: project.id,
          action: 'market.listing.plan',
          targetType: 'listing',
          targetId: listing.id,
          afterRevision: listing.revision,
          changes: auditSnapshot({
            product: product.title,
            marketplace: marketplace.shop,
            price: listing.price,
            currency,
          }),
        })
        return listing
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.listing_id
    if (typeof id !== 'string') throw conflict()
    return (await getListing(actor, id)).listing
  }
  await outcome.complete({ listing_id: outcome.value.id })
  return outcome.value
}

const updateSchema = z.object({
  listingId: recordId('Listing'),
  expectedRevision: revision,
  title: text.optional('Title', 200),
  description: text.optional('Description', 20000),
  price: priceField.optional(),
  tags: stringList('tags', 13, 40).optional(),
  idempotencyKey: idempotencyKey.optional(),
})

/** Change a listing that isn't out. An approved one goes back to planned. */
export async function updateListing(
  actor: Actor,
  raw: z.input<typeof updateSchema>,
): Promise<MarketListingRow> {
  const input = parseInput(updateSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'market_update',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { listing, project } = await listingForWrite(
          tx,
          actor,
          input.listingId,
          'write',
        )
        if (listing.revision !== input.expectedRevision) throw conflict()
        if (!['planned', 'approved', 'failed'].includes(listing.status))
          throw invalid(
            `This listing is ${listing.status}. Change it on the marketplace, then record it.`,
          )
        const patch: Partial<typeof marketListings.$inferInsert> = {}
        if (input.title !== undefined && input.title) patch.title = input.title
        if (input.description !== undefined)
          patch.description = input.description ?? ''
        if (input.price !== undefined)
          patch.price = priceOf(input.price, listing.currency)
        if (input.tags !== undefined) patch.tags = normalizeTags(input.tags)
        const changes = diffFields(
          listing as unknown as Record<string, unknown>,
          patch,
        )
        if (Object.keys(changes).length === 0) return listing
        let saved = await saveListing(tx, listing, patch)
        if (listing.status !== 'planned') {
          await revokeClearances(
            tx,
            actor,
            saved,
            'The listing changed after it was approved.',
          )
          saved = await saveListing(tx, saved, {
            status: 'planned',
            statusReason: 'Changed after it was approved — approve it again.',
          })
        }
        await audit(tx, actor, {
          projectId: project.id,
          action: 'market.listing.update',
          targetType: 'listing',
          targetId: saved.id,
          beforeRevision: listing.revision,
          afterRevision: saved.revision,
          changes,
        })
        return saved
      }),
  )
  if (outcome.kind === 'replay')
    return (await getListing(actor, input.listingId)).listing
  await outcome.complete({ listing_id: outcome.value.id })
  return outcome.value
}

export type ApproveOutcome = {
  listing: MarketListingRow
  authorization: OpsReleaseAuthorizationRow | null
  blockers: Blocker[]
}

/**
 * Approve a listing to go out — the owner approving exactly this payload, or
 * a policy that releases by itself. Returns the reasons when it can't.
 */
export async function approveListing(
  actor: Actor,
  raw: {
    listingId: string
    expectedRevision?: number
    mode?: 'human_approval' | 'policy_gated'
  },
): Promise<ApproveOutcome> {
  const input = parseInput(
    z.object({
      listingId: recordId('Listing'),
      expectedRevision: revision.optional(),
      mode: z.enum(['human_approval', 'policy_gated']).optional(),
    }),
    raw,
  )
  const mode =
    input.mode ?? (actor.type === 'user' ? 'human_approval' : 'policy_gated')
  return withTransaction(async (tx) => {
    const { row: listing, project } = await ownedRow<MarketListingRow>(
      tx,
      actor,
      marketListings,
      input.listingId,
      'Listing',
      { lock: true },
    )
    if (!project) throw notFound('Listing')
    assertModuleOn(project, 'market')
    if (input.expectedRevision && listing.revision !== input.expectedRevision)
      throw conflict()
    const parts = await listingParts(tx, actor.userId, listing.id)
    const outcome = await issueAuthorization(tx, actor, project, {
      module: 'market',
      subjectType: 'listing',
      subjectId: listing.id,
      payloadHash: hashPayload(
        payloadOf(parts.listing, parts.marketplace, parts.files),
      ),
      mode,
    })
    if (!outcome.ok)
      return { listing, authorization: null, blockers: outcome.blockers }
    const saved =
      listing.status === 'approved' && !listing.statusReason
        ? listing
        : await saveListing(tx, listing, {
            status: 'approved',
            statusReason: null,
          })
    await audit(tx, actor, {
      projectId: project.id,
      action: 'market.listing.approve',
      targetType: 'listing',
      targetId: saved.id,
      beforeRevision: listing.revision,
      afterRevision: saved.revision,
      changes: { mode, authorization: outcome.authorization.id },
    })
    return {
      listing: saved,
      authorization: outcome.authorization,
      blockers: [],
    }
  })
}

/** Take an approval back; the listing returns to planned. */
export async function unapproveListing(
  actor: Actor,
  raw: { listingId: string; expectedRevision: number; reason?: string },
): Promise<MarketListingRow> {
  const input = parseInput(
    z.object({
      listingId: recordId('Listing'),
      expectedRevision: revision,
      reason: text.optional('Reason', 500),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { listing, project } = await listingForWrite(
      tx,
      actor,
      input.listingId,
      'write',
    )
    if (listing.revision !== input.expectedRevision) throw conflict()
    if (listing.status !== 'approved')
      throw invalid(
        `Only an approved listing can be taken back; this one is ${listing.status}.`,
      )
    const reason = input.reason ?? 'Taken back before it went out.'
    await revokeClearances(tx, actor, listing, reason)
    const saved = await saveListing(tx, listing, {
      status: 'planned',
      statusReason: reason,
    })
    await audit(tx, actor, {
      projectId: project.id,
      action: 'market.listing.unapprove',
      targetType: 'listing',
      targetId: saved.id,
      beforeRevision: listing.revision,
      afterRevision: saved.revision,
      reason,
    })
    return saved
  })
}

/** Delete a plan that never went anywhere. The owner's. */
export async function deleteListing(
  actor: Actor,
  raw: { listingId: string; expectedRevision: number },
): Promise<void> {
  const input = parseInput(
    z.object({ listingId: recordId('Listing'), expectedRevision: revision }),
    raw,
  )
  await withTransaction(async (tx) => {
    const { listing, project } = await listingForWrite(
      tx,
      actor,
      input.listingId,
      'write',
      'owner_only',
    )
    if (listing.revision !== input.expectedRevision) throw conflict()
    if (listing.status !== 'planned' && listing.status !== 'failed')
      throw invalid(
        'Only a planned listing can be deleted. Take it back first.',
      )
    const [intent] = await tx
      .select({ id: marketIntents.id })
      .from(marketIntents)
      .where(eq(marketIntents.listingId, listing.id))
      .limit(1)
    if (intent)
      throw invalid('This listing was sent once; it stays on the record.')
    await revokeClearances(tx, actor, listing, 'The listing was deleted.')
    await tx
      .delete(refs)
      .where(
        and(
          eq(refs.ownerId, actor.userId),
          or(
            and(eq(refs.fromType, 'listing'), eq(refs.fromId, listing.id)),
            and(eq(refs.toType, 'listing'), eq(refs.toId, listing.id)),
          ),
        ),
      )
    await tx.delete(marketListings).where(eq(marketListings.id, listing.id))
    await audit(tx, actor, {
      projectId: project.id,
      action: 'market.listing.delete',
      targetType: 'listing',
      targetId: listing.id,
      beforeRevision: listing.revision,
      changes: auditSnapshot({ title: listing.title }),
    })
  })
}

const manualSchema = z.object({
  listingId: recordId('Listing'),
  expectedRevision: revision.optional(),
  url: url('Listing URL'),
  externalId: text.optional('Listing ID', 200),
  listedAt: z.union([z.string().max(40), z.date()]).optional(),
  evidenceLevel: optionalChoice(
    PUBLISH_EVIDENCE_LEVELS,
    'Say how you know it is live.',
  ),
  evidenceNote: text.optional('Evidence note', 1000),
  idempotencyKey: idempotencyKey.optional(),
})

/**
 * A listing made by hand, on the record. An agent needs a live approval of
 * exactly this payload, which it uses up; the owner's word is enough.
 */
export async function recordManualListing(
  actor: Actor,
  raw: z.input<typeof manualSchema>,
): Promise<MarketListingRow> {
  const input = parseInput(manualSchema, raw)
  if (!input.url && !input.externalId)
    throw invalid('Give the listing’s URL or its ID on the marketplace.', {
      url: 'Paste the link to the listing.',
    })
  const outcome = await runOperation(
    actor,
    {
      operation: 'market_record_manual',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { listing, project, policy } = await listingForWrite(
          tx,
          actor,
          input.listingId,
          'operate',
          'list',
        )
        if (
          input.expectedRevision &&
          listing.revision !== input.expectedRevision
        )
          throw conflict()
        if (listing.status !== 'planned' && listing.status !== 'approved')
          throw invalid(`This listing is already ${listing.status}.`)
        const parts = await listingParts(tx, actor.userId, listing.id)
        assertMarketplaceAllowed(policy, parts.marketplace)
        const clearance = (
          await liveClearances(tx, actor.userId, [listing.id])
        ).get(listing.id)
        const person = actor.type === 'user'
        if (!person && !clearance)
          throw policyBlocked(
            'The owner hasn’t approved this listing. Ask them in HQ, or with agents_request_human.',
            {
              blockers: [{ key: 'not_approved', message: 'No live approval.' }],
            },
          )
        if (clearance)
          await consumeAuthorization(tx, actor, {
            authorizationId: clearance.id,
            payloadHash: hashPayload(
              payloadOf(parts.listing, parts.marketplace, parts.files),
            ),
            targetRef: parts.marketplace.id,
          })
        const now = await dbNow(tx)
        const listedAt =
          input.listedAt instanceof Date
            ? input.listedAt
            : input.listedAt
              ? (parseInstant(input.listedAt, project.timezone) ??
                (() => {
                  throw invalid('Listed at must be a date and time.')
                })())
              : now
        if (listedAt.getTime() > now.getTime() + 60_000)
          throw invalid('A listing can’t have gone live in the future.')
        const evidence: PublishEvidenceLevel = person
          ? input.evidenceLevel && input.evidenceLevel !== 'provider_verified'
            ? input.evidenceLevel
            : 'owner_attested'
          : input.evidenceLevel === 'platform_export' ||
              input.evidenceLevel === 'screenshot'
            ? input.evidenceLevel
            : 'agent_attested'
        const saved = await saveListing(tx, listing, {
          status: 'listed',
          listedAt,
          url: input.url ?? null,
          externalId: input.externalId ?? null,
          evidenceLevel: evidence,
          evidenceNote: input.evidenceNote ?? null,
          statusReason: null,
        })
        await audit(tx, actor, {
          projectId: project.id,
          action: 'market.listing.record_manual',
          targetType: 'listing',
          targetId: saved.id,
          beforeRevision: listing.revision,
          afterRevision: saved.revision,
          changes: {
            url: saved.url,
            externalId: saved.externalId,
            listedAt: listedAt.toISOString(),
            evidence,
            clearance: clearance?.id ?? null,
          },
        })
        return saved
      }),
  )
  if (outcome.kind === 'replay')
    return (await getListing(actor, input.listingId)).listing
  await outcome.complete({ listing_id: outcome.value.id })
  return outcome.value
}

/** A listing that is no longer for sale — taken down, expired or sold out. */
export async function setListingInactive(
  actor: Actor,
  raw: { listingId: string; expectedRevision: number; reason: string },
): Promise<MarketListingRow> {
  const input = parseInput(
    z.object({
      listingId: recordId('Listing'),
      expectedRevision: revision,
      reason: text.required('Reason', 500),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { listing, project } = await listingForWrite(
      tx,
      actor,
      input.listingId,
      'write',
    )
    if (listing.revision !== input.expectedRevision) throw conflict()
    if (listing.status !== 'listed' && listing.status !== 'verified')
      throw invalid('Only a live listing can be marked inactive.')
    const saved = await saveListing(tx, listing, {
      status: 'inactive',
      inactiveAt: sql`now()`,
      statusReason: input.reason as string,
    })
    await audit(tx, actor, {
      projectId: project.id,
      action: 'market.listing.inactive',
      targetType: 'listing',
      targetId: saved.id,
      beforeRevision: listing.revision,
      afterRevision: saved.revision,
      reason: input.reason as string,
    })
    return saved
  })
}

/* ── Dispatch through a marketplace's API ───────────────────────────── */

/** A connection's secret, parsed, and how to save a refreshed one. */
export async function adapterContext(
  marketplace: MarketMarketplaceRow,
  ownerId: string,
): Promise<AdapterContext> {
  const label = MARKET_RULES[marketplace.kind].label
  if (!marketplace.connectionId)
    throw capabilityUnavailable(
      `${marketplace.shop} has no ${label} connection. List it by hand and record it (market_record_manual).`,
    )
  const connection = await withReader(async (db) => {
    const [row] = await db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, marketplace.connectionId as string),
          eq(providerConnections.ownerId, ownerId),
        ),
      )
      .limit(1)
    return row
  })
  if (!connection || connection.revokedAt || !connection.secretSealed)
    throw capabilityUnavailable(
      `The ${label} connection is gone. The owner reconnects it in Settings › Connections.`,
    )
  if (connection.status !== 'connected')
    throw reauthRequired(
      `The ${label} connection needs the owner (${connection.status}). Settings › Connections.`,
    )
  let credentials: Record<string, string>
  try {
    credentials = JSON.parse(unseal(connection.secretSealed)) as Record<
      string,
      string
    >
  } catch {
    throw capabilityUnavailable(
      `The ${label} connection’s secret isn’t the JSON HQ expects. The owner replaces it in Settings › Connections.`,
    )
  }
  return {
    marketplace,
    credentials,
    fetch: globalThis.fetch,
    now: new Date(),
    saveCredentials: async (next) => {
      const text = JSON.stringify(next)
      await withTransaction(async (tx) => {
        await tx
          .update(providerConnections)
          .set({
            secretSealed: seal(text),
            secretHint: secretHint(next.apiKey ?? text),
            revision: sql`${providerConnections.revision} + 1`,
            updatedAt: sql`now()`,
          })
          .where(eq(providerConnections.id, connection.id))
      })
    },
  }
}

/** A file as an adapter reads it: the bytes, checked against the approved hash. */
function adapterFile(actor: Actor, file: ProductFile): AdapterFile {
  return {
    assetId: file.id,
    sha256: fileBinding(file),
    name: file.name,
    mime: file.mime,
    bytes: file.bytes,
    read: async () => {
      const { url: link } = await assetAccess(actor, {
        assetId: file.id,
        ttlSeconds: 900,
      })
      const response = await fetch(link)
      if (!response.ok)
        throw new Error(`${file.name} couldn’t be read (${response.status}).`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (file.sha256) {
        const hash = createHash('sha256').update(bytes).digest('hex')
        if (hash !== file.sha256)
          throw new Error(
            `${file.name} isn’t the file that was approved (its bytes changed).`,
          )
      }
      return bytes
    },
  }
}

export type ListingDispatchOutcome = {
  listing: MarketListingRow
  intent: MarketIntentRow
  result: 'submitted' | 'verified' | 'unknown' | 'failed'
  message: string
}

async function settleListing(
  actor: Actor,
  intentId: string,
  result:
    | {
        kind: 'accepted'
        remoteListingId: string
        remoteUrl: string | null
        detail?: Record<string, unknown>
      }
    | {
        kind: 'verified'
        remoteListingId: string
        remoteUrl: string | null
        fields: Record<string, unknown>
      }
    | { kind: 'unknown'; error: string }
    | { kind: 'failed'; error: string },
): Promise<{ listing: MarketListingRow; intent: MarketIntentRow }> {
  return withTransaction(async (tx) => {
    const [intent] = await tx
      .select()
      .from(marketIntents)
      .where(
        and(
          eq(marketIntents.id, intentId),
          eq(marketIntents.ownerId, actor.userId),
        ),
      )
      .for('update')
    if (!intent) throw notFound('Dispatch')
    const [listing] = await tx
      .select()
      .from(marketListings)
      .where(eq(marketListings.id, intent.listingId))
      .for('update')
    if (!listing) throw notFound('Listing')
    const set = (patch: PgUpdateSetSource<typeof marketIntents>) =>
      tx
        .update(marketIntents)
        .set({
          ...patch,
          revision: sql`${marketIntents.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(marketIntents.id, intent.id))
        .returning()
    let savedListing = listing
    let saved: MarketIntentRow
    if (result.kind === 'accepted') {
      saved = returned(
        (
          await set({
            status: 'submitted',
            remoteListingId: result.remoteListingId,
            remoteUrl: result.remoteUrl,
            verification: result.detail ?? {},
            nextAttemptAt: sql`now() + interval '1 minute'`,
            error: null,
          })
        )[0],
      )
      savedListing = await saveListing(tx, listing, {
        externalId: result.remoteListingId,
        url: result.remoteUrl,
      })
    } else if (result.kind === 'verified') {
      saved = returned(
        (
          await set({
            status: 'verified',
            remoteListingId: result.remoteListingId,
            remoteUrl: result.remoteUrl,
            verification: result.fields,
            verifiedAt: sql`now()`,
            nextAttemptAt: null,
            error: null,
          })
        )[0],
      )
      savedListing = await saveListing(tx, listing, {
        status: 'verified',
        listedAt: listing.listedAt ?? sql`now()`,
        externalId: result.remoteListingId,
        url: result.remoteUrl ?? listing.url,
        evidenceLevel: 'provider_verified',
        statusReason: null,
      })
    } else if (result.kind === 'unknown') {
      saved = returned(
        (
          await set({
            status: 'unknown',
            error: result.error,
            nextAttemptAt: sql`now() + interval '1 minute'`,
          })
        )[0],
      )
    } else {
      saved = returned(
        (
          await set({
            status: 'failed',
            error: result.error,
            nextAttemptAt: null,
          })
        )[0],
      )
      savedListing = await saveListing(tx, listing, {
        status: 'failed',
        statusReason: result.error,
      })
    }
    await audit(tx, actor, {
      projectId: listing.projectId,
      action: `market.dispatch.${saved.status}`,
      targetType: 'listing',
      targetId: listing.id,
      beforeRevision: listing.revision,
      afterRevision: savedListing.revision,
      changes: {
        intent: saved.id,
        remoteListingId: saved.remoteListingId,
        error: saved.error,
      },
    })
    return { listing: savedListing, intent: saved }
  })
}

/**
 * Send an approved listing through its marketplace's API, now. The approval
 * is used up with the dispatch record; the adapter runs outside any
 * transaction; an answer that never comes back is `unknown` and is looked up
 * by the ops tick, never sent again.
 */
export async function dispatchListing(
  actor: Actor,
  raw: { listingId: string; idempotencyKey: string },
): Promise<ListingDispatchOutcome> {
  const input = parseInput(
    z.object({ listingId: recordId('Listing'), idempotencyKey }),
    raw,
  )
  const parts = await withReader(async (db) => {
    await ownedRecord<MarketListingRow>(
      db,
      actor,
      marketListings,
      input.listingId,
      'market',
      'read',
      'Listing',
    )
    return listingParts(db, actor.userId, input.listingId)
  })
  const adapter = marketplaceAdapter(parts.marketplace.kind)
  if (!adapter)
    throw capabilityUnavailable(
      `HQ can’t list on ${MARKET_RULES[parts.marketplace.kind].label} by itself. List it by hand and record it (market_record_manual).`,
    )
  const context = await adapterContext(parts.marketplace, actor.userId)
  const outcome = await runOperation(
    actor,
    {
      operation: 'market_dispatch',
      key: input.idempotencyKey,
      request: { listingId: input.listingId },
    },
    async () => {
      const started = await withTransaction(async (tx) => {
        const { listing, project, policy } = await listingForWrite(
          tx,
          actor,
          input.listingId,
          'operate',
          'list',
        )
        if (listing.status !== 'approved')
          throw invalid(
            listing.status === 'planned'
              ? 'The owner hasn’t approved this listing yet.'
              : `This listing is ${listing.status}.`,
          )
        const now = await listingParts(tx, actor.userId, listing.id)
        assertMarketplaceAllowed(policy, now.marketplace)
        const clearance = (
          await liveClearances(tx, actor.userId, [listing.id])
        ).get(listing.id)
        if (!clearance)
          throw policyBlocked(
            'This listing’s approval expired or was taken back. Approve it again.',
            {
              blockers: [{ key: 'not_approved', message: 'No live approval.' }],
            },
          )
        const payload = payloadOf(now.listing, now.marketplace, now.files)
        const payloadHash = hashPayload(payload)
        await consumeAuthorization(tx, actor, {
          authorizationId: clearance.id,
          payloadHash,
          targetRef: now.marketplace.id,
        })
        const [row] = await tx
          .insert(marketIntents)
          .values({
            ownerId: actor.userId,
            createdBy: actor.userId,
            projectId: project.id,
            listingId: listing.id,
            marketplaceId: now.marketplace.id,
            authorizationId: clearance.id,
            payloadHash,
            idempotencyKey: input.idempotencyKey,
            kind: now.marketplace.kind,
            attempts: 1,
            submittedAt: sql`now()`,
            actorType: actor.type,
            actorId: actor.id,
          })
          .returning()
        const intent = returned(row)
        await saveListing(tx, listing, {
          status: 'dispatched',
          statusReason: null,
        })
        await audit(tx, actor, {
          projectId: project.id,
          action: 'market.dispatch.submit',
          targetType: 'listing',
          targetId: listing.id,
          changes: { intent: intent.id, kind: intent.kind },
        })
        return { intent, payload, files: now.files }
      })
      let submitted: ListingSubmitted | null = null
      let settled: Parameters<typeof settleListing>[2]
      try {
        submitted = await adapter.submit(context, {
          payload: started.payload,
          idempotencyKey: input.idempotencyKey,
          files: started.files
            .filter((file) => file.role === 'deliverable')
            .map((file) => adapterFile(actor, file)),
          images: started.files
            .filter((file) => file.role === 'preview')
            .map((file) => adapterFile(actor, file)),
        })
        settled =
          submitted.state === 'accepted'
            ? {
                kind: 'accepted',
                remoteListingId: submitted.remoteListingId,
                remoteUrl: submitted.remoteUrl,
                detail: submitted.detail,
              }
            : { kind: 'failed', error: submitted.error }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'The marketplace didn’t answer.'
        settled =
          error instanceof ReauthRequired
            ? { kind: 'failed', error: message }
            : error instanceof RemoteTimeout
              ? { kind: 'unknown', error: message }
              : { kind: 'unknown', error: message }
      }
      const result = await settleListing(actor, started.intent.id, settled)
      return result
    },
  )
  if (outcome.kind === 'replay') {
    const detail = await getListing(actor, input.listingId)
    const intent = detail.intents.find(
      (row) => row.idempotencyKey === input.idempotencyKey,
    )
    if (!intent) throw conflict()
    return {
      listing: detail.listing,
      intent,
      result: intent.status as ListingDispatchOutcome['result'],
      message: 'Already sent with this key.',
    }
  }
  const value = outcome.value
  await outcome.complete({
    listing_id: value.listing.id,
    intent_id: value.intent.id,
  })
  const result = value.intent.status as ListingDispatchOutcome['result']
  const messages: Record<ListingDispatchOutcome['result'], string> = {
    verified: 'It is live, and the marketplace read it back.',
    submitted:
      'The marketplace accepted it; HQ reads it back before calling it verified.',
    unknown:
      'The marketplace didn’t answer in time. HQ looks it up — it won’t send it again.',
    failed: `It didn’t go out: ${value.intent.error ?? 'refused'}.`,
  }
  return { ...value, result, message: messages[result] }
}

/**
 * The ops tick's share of Market: read back listings that were submitted or
 * whose outcome is unknown, and return approved listings whose approval
 * lapsed to planned.
 */
export async function reconcileMarket(
  options: { ownerId?: string; limit?: number } = {},
): Promise<{
  checked: number
  verified: number
  failed: number
  lapsed: number
}> {
  const limit = options.limit ?? 20
  const tally = { checked: 0, verified: 0, failed: 0, lapsed: 0 }
  const lapsed = await withReader((db) =>
    db
      .select({ id: marketListings.id, ownerId: marketListings.ownerId })
      .from(marketListings)
      .where(
        and(
          options.ownerId
            ? eq(marketListings.ownerId, options.ownerId)
            : undefined,
          eq(marketListings.status, 'approved'),
          sql`not exists (select 1 from ${opsReleaseAuthorizations} a where a.subject_id = ${marketListings.id} and a.module = 'market' and a.status = 'active' and a.expires_at > now())`,
        ),
      )
      .limit(limit),
  )
  for (const row of lapsed) {
    const actor = schedulerActor(row.ownerId)
    await withTransaction(async (tx) => {
      const [listing] = await tx
        .select()
        .from(marketListings)
        .where(
          and(
            eq(marketListings.id, row.id),
            eq(marketListings.status, 'approved'),
          ),
        )
        .for('update')
      if (!listing) return
      const saved = await saveListing(tx, listing, {
        status: 'planned',
        statusReason:
          'Its approval expired before it went out — approve it again.',
      })
      await audit(tx, actor, {
        projectId: listing.projectId,
        action: 'market.listing.lapse',
        targetType: 'listing',
        targetId: listing.id,
        beforeRevision: listing.revision,
        afterRevision: saved.revision,
      })
    })
    tally.lapsed++
  }
  const due = await withReader((db) =>
    db
      .select()
      .from(marketIntents)
      .where(
        and(
          options.ownerId
            ? eq(marketIntents.ownerId, options.ownerId)
            : undefined,
          inArray(marketIntents.status, ['submitted', 'unknown']),
          sql`coalesce(${marketIntents.nextAttemptAt}, now()) <= now()`,
        ),
      )
      .orderBy(asc(marketIntents.nextAttemptAt))
      .limit(limit),
  )
  for (const intent of due) {
    const adapter = marketplaceAdapter(intent.kind)
    if (!adapter) continue
    const actor = schedulerActor(intent.ownerId)
    tally.checked++
    try {
      const parts = await withReader((db) =>
        listingParts(db, intent.ownerId, intent.listingId),
      )
      const context = await adapterContext(parts.marketplace, intent.ownerId)
      const found = await adapter.lookup(context, {
        remoteListingId: intent.remoteListingId,
        payload: payloadOf(parts.listing, parts.marketplace, parts.files),
        submittedAfter: intent.submittedAt,
      })
      if (found.found && found.state === 'active') {
        await settleListing(actor, intent.id, {
          kind: 'verified',
          remoteListingId: found.remoteListingId,
          remoteUrl: found.url,
          fields: {
            state: found.state,
            title: found.title,
            priceMinor: found.priceMinor,
            currency: found.currency,
            fileCount: found.fileCount,
            imageCount: found.imageCount,
          },
        })
        tally.verified++
      } else if (found.found) {
        await settleListing(actor, intent.id, {
          kind: 'failed',
          error: `It is ${found.state} on the marketplace, not active. Activate it there and record it, or send it again.`,
        })
        tally.failed++
      } else if (found.definitive) {
        await settleListing(actor, intent.id, {
          kind: 'failed',
          error:
            'The marketplace has no such listing; the dispatch didn’t land.',
        })
        tally.failed++
      } else {
        await withTransaction(async (tx) => {
          await tx
            .update(marketIntents)
            .set({
              attempts: sql`${marketIntents.attempts} + 1`,
              nextAttemptAt: sql`now() + least(interval '1 hour', interval '1 minute' * power(2, ${marketIntents.attempts}))`,
              updatedAt: sql`now()`,
            })
            .where(eq(marketIntents.id, intent.id))
        })
      }
    } catch (error) {
      console.error('[market] reconcile', intent.id, error)
      await withTransaction(async (tx) => {
        await tx
          .update(marketIntents)
          .set({
            attempts: sql`${marketIntents.attempts} + 1`,
            nextAttemptAt: sql`now() + interval '15 minutes'`,
            error:
              error instanceof Error ? error.message.slice(0, 500) : 'failed',
            updatedAt: sql`now()`,
          })
          .where(eq(marketIntents.id, intent.id))
      })
    }
  }
  return tally
}
