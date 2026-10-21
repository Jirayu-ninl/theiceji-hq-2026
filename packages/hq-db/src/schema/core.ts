import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  GOOGLE_CONNECTION_STATUSES,
  type GoogleConnectionStatus,
  PROJECT_COLOR_NAMES,
  PROJECT_KINDS,
  PROJECT_STATUSES,
  PROVIDER_CONNECTION_KINDS,
  PROVIDER_CONNECTION_STATUSES,
  type ProjectColor,
  type ProjectKind,
  type ProjectStatus,
  type ProviderConnectionKind,
  type ProviderConnectionStatus,
  REF_ROLES,
  REF_TYPES,
  type RefRole,
  type RefType,
  STORAGE_PROVIDERS,
  type StorageProviderId,
} from '../enums'
import { nullableOneOf, oneOf, tz } from './_shared'
import { tracked, userRef } from './_user'

/* ── core — projects, connections, refs ─────────────────
 *
 * The rows every module stands on. Three rules hold for every table from
 * here on:
 *
 * · **Every row has an owner.** `owner_id` is NOT NULL and every query filters
 *   on it — the seam where a tenant key goes when HQ becomes a SaaS.
 *   `unique (id, owner_id)` on a parent lets a child's composite key make a
 *   cross-owner reference impossible.
 * · **Modules don't hold foreign keys into each other.** A foreign key stays
 *   inside its module; anything that crosses is one `refs` row, so a module
 *   can move out with its own tables and nothing to cut.
 * · **Timestamps are the database's.** Anything compared or sorted is stamped
 *   with `now()` in SQL, never a JavaScript clock.
 */

/** What `projects.modules` holds: the modules turned on, and each one's settings. */
export type ProjectModules = {
  enabled: string[]
  settings: Record<string, Record<string, unknown>>
}

/**
 * The unit HQ is organised by. `kind` chooses the modules a
 * project starts with; `modules.enabled` is what it has now. `slug` is the
 * URL (`/p/<slug>/…`), unique per owner. `position` is the owner's order —
 * it fixes each project's angle on Home, so it never changes by itself.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<ProjectKind>().notNull(),
    status: text('status').$type<ProjectStatus>().notNull().default('active'),
    /** A swatch name, never a hex. */
    color: text('color').$type<ProjectColor>().notNull().default('grey'),
    /** Reporting timezone. Storage is always UTC. */
    timezone: text('timezone').notNull().default('Asia/Bangkok'),
    currency: text('currency').notNull().default('THB'),
    modules: jsonb('modules')
      .$type<ProjectModules>()
      .notNull()
      .default(sql`'{"enabled":[],"settings":{}}'::jsonb`),
    /** Null means the owner's default provider (r2 until one is chosen). */
    storageProvider: text('storage_provider').$type<StorageProviderId>(),
    /** A folder: an R2 key prefix, or a Drive folder ID. */
    storageRoot: text('storage_root'),
    position: integer('position').notNull().default(0),
    archivedAt: timestamp('archived_at', tz),
    /**
     * In the Trash: an archived project the owner deleted. Its records stay
     * (history is append-only, and money is never dropped); it is listed only
     * in Projects › Trash, and Restore brings it back archived.
     */
    deletedAt: timestamp('deleted_at', tz),
  },
  (t) => [
    unique('projects_owner_scope_key').on(t.id, t.ownerId),
    uniqueIndex('projects_slug_key').on(t.ownerId, t.slug),
    index('projects_owner_idx').on(t.ownerId, t.status, t.position),
    check('projects_kind_check', oneOf(t.kind, PROJECT_KINDS)),
    check('projects_status_check', oneOf(t.status, PROJECT_STATUSES)),
    check('projects_color_check', oneOf(t.color, PROJECT_COLOR_NAMES)),
    check(
      'projects_storage_check',
      nullableOneOf(t.storageProvider, STORAGE_PROVIDERS),
    ),
    check(
      'projects_slug_check',
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.slug}) <= 64`,
    ),
    check(
      'projects_name_check',
      sql`length(btrim(${t.name})) between 1 and 120`,
    ),
    check('projects_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'projects_modules_check',
      sql`jsonb_typeof(${t.modules} -> 'enabled') = 'array' and jsonb_typeof(${t.modules} -> 'settings') = 'object'`,
    ),
    check(
      'projects_archived_check',
      sql`(${t.status} = 'archived') = (${t.archivedAt} is not null)`,
    ),
    check(
      'projects_deleted_check',
      sql`${t.deletedAt} is null or ${t.status} = 'archived'`,
    ),
  ],
)

/**
 * The owner's one Google connection: Drive (`drive.file`) and
 * Calendar (`calendar.events`, `calendar.readonly`) on a single consent. The
 * refresh token is sealed with the server's key and never leaves the server;
 * an access token is minted from it in memory and never stored.
 */
export const googleConnections = pgTable(
  'google_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
    email: text('email').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    refreshTokenSealed: text('refresh_token_sealed'),
    /** HQ's own folder in the owner's Drive; projects nest under it. */
    driveRootId: text('drive_root_id'),
    /** The calendar HQ reads and writes; `primary` until the owner picks one. */
    calendarId: text('calendar_id'),
    status: text('status')
      .$type<GoogleConnectionStatus>()
      .notNull()
      .default('connected'),
    /** What went wrong, in words, when status isn't `connected`. */
    problem: text('problem'),
    connectedAt: timestamp('connected_at', tz).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('google_connections_owner_key').on(t.ownerId),
    check(
      'google_connections_status_check',
      oneOf(t.status, GOOGLE_CONNECTION_STATUSES),
    ),
    check(
      'google_connections_token_check',
      sql`${t.status} <> 'connected' or ${t.refreshTokenSealed} is not null`,
    ),
    check(
      'google_connections_revoked_check',
      sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`,
    ),
  ],
)

/**
 * A service the owner connected once — a generator, a platform, a marketplace
 * or an LLM key. It belongs to the owner, not a project, so
 * one key serves every project. `config` is base URLs and model maps only;
 * the secret is sealed, and tools see its hint and status, never the value.
 */
export const providerConnections = pgTable(
  'provider_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
    provider: text('provider').$type<ProviderConnectionKind>().notNull(),
    label: text('label').notNull(),
    config: jsonb('config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    secretSealed: text('secret_sealed'),
    /** The last four characters — enough to recognise a key, useless to replay. */
    secretHint: text('secret_hint'),
    status: text('status')
      .$type<ProviderConnectionStatus>()
      .notNull()
      .default('not_connected'),
    problem: text('problem'),
    lastCheckedAt: timestamp('last_checked_at', tz),
    revokedAt: timestamp('revoked_at', tz),
  },
  (t) => [
    unique('provider_connections_owner_scope_key').on(t.id, t.ownerId),
    uniqueIndex('provider_connections_label_key')
      .on(t.ownerId, t.provider, t.label)
      .where(sql`${t.revokedAt} is null`),
    check(
      'provider_connections_provider_check',
      oneOf(t.provider, PROVIDER_CONNECTION_KINDS),
    ),
    check(
      'provider_connections_status_check',
      oneOf(t.status, PROVIDER_CONNECTION_STATUSES),
    ),
    check(
      'provider_connections_connected_check',
      sql`${t.status} <> 'connected' or ${t.secretSealed} is not null`,
    ),
    check(
      'provider_connections_revoked_check',
      sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`,
    ),
    check(
      'provider_connections_label_check',
      sql`length(btrim(${t.label})) between 1 and 80`,
    ),
  ],
)

/**
 * Who the owner works for — one record for all of HQ. A Board
 * card's Client points here (or keeps a name used once, on the card only),
 * and a quote bills it. Names are unique among the owner's active clients.
 * Was `quote_clients` until it moved out of Quotes.
 */
export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** เลขประจำตัวผู้เสียภาษี — 13 digits for a Thai taxpayer; free text for anyone else. */
    taxId: text('tax_id'),
    address: text('address').notNull().default(''),
    email: text('email'),
    phone: text('phone'),
    archivedAt: timestamp('archived_at', tz),
  },
  (t) => [
    unique('clients_owner_scope_key').on(t.id, t.ownerId),
    uniqueIndex('clients_name_key')
      .on(t.ownerId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    check('clients_name_check', sql`length(btrim(${t.name})) between 1 and 160`),
    check('clients_address_check', sql`length(${t.address}) <= 600`),
    check(
      'clients_tax_check',
      sql`${t.taxId} is null or length(btrim(${t.taxId})) between 1 and 40`,
    ),
  ],
)

/**
 * The one edge between modules: a note promoted to a card, an
 * asset that is the result of a shot, a card quoted by a quote. Polymorphic,
 * but only over the types in `REF_TYPES`, so a module leaving HQ takes its
 * types with it and nothing else holds a key into its tables. An edge is
 * deleted when it is unlinked; the records it joined are not.
 */
export const refs = pgTable(
  'refs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
    fromType: text('from_type').$type<RefType>().notNull(),
    fromId: uuid('from_id').notNull(),
    toType: text('to_type').$type<RefType>().notNull(),
    toId: uuid('to_id').notNull(),
    role: text('role').$type<RefRole>().notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refs_edge_key').on(
      t.fromType,
      t.fromId,
      t.toType,
      t.toId,
      t.role,
    ),
    index('refs_from_idx').on(t.ownerId, t.fromType, t.fromId),
    index('refs_to_idx').on(t.ownerId, t.toType, t.toId),
    check('refs_from_type_check', oneOf(t.fromType, REF_TYPES)),
    check('refs_to_type_check', oneOf(t.toType, REF_TYPES)),
    check('refs_role_check', oneOf(t.role, REF_ROLES)),
    check(
      'refs_self_check',
      sql`not (${t.fromType} = ${t.toType} and ${t.fromId} = ${t.toId})`,
    ),
  ],
)

/** Who issues the owner's quotes — printed at the top of every PDF. */
export type QuoteIssuer = {
  name: string
  taxId?: string
  address?: string
  email?: string
  phone?: string
  /** Where the client pays: bank · account name · number. */
  bank?: string
}

/**
 * What the owner set once for all of HQ: where new files go
 * when a project doesn't say (Settings › Storage), and who issues their
 * quotes. One row per owner, made on first write; no row means the defaults
 * — R2, and a quote header that says the issuer isn't set yet.
 */
export const ownerSettings = pgTable(
  'owner_settings',
  {
    ownerId: uuid('owner_id')
      .primaryKey()
      .references(userRef, { onDelete: 'restrict' }),
    storageProvider: text('storage_provider')
      .$type<StorageProviderId>()
      .notNull()
      .default('r2'),
    /** A folder under HQ's root: an R2 key prefix, or a Drive folder ID. */
    storageRoot: text('storage_root'),
    quoteIssuer: jsonb('quote_issuer').$type<QuoteIssuer>(),
    revision: integer('revision').notNull().default(1),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    check(
      'owner_settings_storage_check',
      oneOf(t.storageProvider, STORAGE_PROVIDERS),
    ),
    check(
      'owner_settings_issuer_check',
      sql`${t.quoteIssuer} is null or jsonb_typeof(${t.quoteIssuer}) = 'object'`,
    ),
  ],
)

export type OwnerSettingsRow = typeof ownerSettings.$inferSelect
export type ProjectRow = typeof projects.$inferSelect
export type GoogleConnectionRow = typeof googleConnections.$inferSelect
export type ProviderConnectionRow = typeof providerConnections.$inferSelect
export type ClientRow = typeof clients.$inferSelect
export type RefRow = typeof refs.$inferSelect
