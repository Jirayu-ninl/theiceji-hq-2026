import { sql } from 'drizzle-orm'
import {
  check,
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
  OPS_ACTOR_TYPES,
  type OpsActorType,
  PUBLISH_EVIDENCE_LEVELS,
  PUBLISH_INTENT_STATUSES,
  PUBLISH_PLATFORMS,
  PUBLISH_POST_STATUSES,
  type PublishEvidenceLevel,
  type PublishIntentStatus,
  type PublishPlatform,
  type PublishPostStatus,
  READING_SOURCES,
  READING_WINDOWS,
  type ReadingSource,
  type ReadingWindow,
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

/* ── publish — a channel's accounts, posts and readings ──
 *
 * · **An account is where a project posts** — a Facebook page, a YouTube
 *   channel, a TikTok handle, or anywhere else (`manual`). It may name the
 *   owner's provider connection HQ posts through; without one, posts are
 *   recorded by hand.
 * · **A post is one piece on one account.** `planned` is a draft; the owner's
 *   release authorization (hq-ops) makes it `scheduled`; it is `posted` only
 *   with a time, an evidence level and a URL or external ID, and `verified`
 *   only when the platform read it back. Planned is never posted.
 * · **An intent is one API dispatch of a post** — the idempotency key, the
 *   authorization it consumed, the remote ID and the read-back. A submit
 *   whose answer never came back is `unknown` and is reconciled by reading
 *   the platform, never sent twice. Posts made by hand have no intent.
 * · **Readings are append-only.** A reading is a number about a post or an
 *   account, as of a moment (`lifetime`) or over a span (`interval`, always
 *   the case for money). A correction is a new row that `supersedes` the old
 *   one; the current reading is the one nothing supersedes. Comparing posts
 *   "at the same age" reads the reading nearest the post's age.
 * · **The asset a post carries is an Assets row** — Assets is the one module
 *   every other may point at. A card becomes a post through `refs`
 *   (`card —published_as→ post`).
 */

export type PostDisclosure = {
  /** Made with generative AI, as the platform asks to be told. */
  aiGenerated: boolean
  /** Paid, sponsored or affiliate. */
  affiliate: boolean
  /** Extra words the post carries, if any. */
  text?: string
}

export const publishAccounts = pgTable(
  'publish_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id').notNull(),
    platform: text('platform').$type<PublishPlatform>().notNull(),
    /** `@handle`, a page name, a channel name — how the owner knows it. */
    handle: text('handle').notNull(),
    profileUrl: text('profile_url'),
    /** As the platform spells it — never parsed into a number. */
    externalAccountId: text('external_account_id'),
    /** The owner's connection HQ posts through; null means by hand. */
    connectionId: uuid('connection_id'),
    notes: text('notes').notNull().default(''),
    archivedAt: timestamp('archived_at', tz),
  },
  (t) => [
    unique('publish_accounts_owner_scope_key').on(t.id, t.ownerId),
    unique('publish_accounts_project_scope_key').on(t.id, t.projectId),
    inOwnProject('publish_accounts_project_fk', t),
    foreignKey({
      name: 'publish_accounts_connection_fk',
      columns: [t.connectionId, t.ownerId],
      foreignColumns: [providerConnections.id, providerConnections.ownerId],
    }).onDelete('restrict'),
    uniqueIndex('publish_accounts_handle_key')
      .on(t.projectId, t.platform, sql`lower(${t.handle})`)
      .where(sql`${t.archivedAt} is null`),
    index('publish_accounts_owner_idx').on(t.ownerId, t.projectId),
    check(
      'publish_accounts_platform_check',
      oneOf(t.platform, PUBLISH_PLATFORMS),
    ),
    check('publish_accounts_handle_check', trimmedLength(t.handle, 120)),
    check(
      'publish_accounts_url_check',
      sql`${t.profileUrl} is null or ${t.profileUrl} ~ '^https?://' and length(${t.profileUrl}) <= 600`,
    ),
    check('publish_accounts_notes_check', sql`length(${t.notes}) <= 4000`),
  ],
)

export const publishPosts = pgTable(
  'publish_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id').notNull(),
    accountId: uuid('account_id').notNull(),
    /** The file it carries, if any (a video, a still). */
    assetId: uuid('asset_id'),
    /** A title where the platform has one (YouTube). */
    title: text('title'),
    caption: text('caption').notNull().default(''),
    disclosure: jsonb('disclosure')
      .$type<PostDisclosure>()
      .notNull()
      .default(sql`'{"aiGenerated":false,"affiliate":false}'::jsonb`),
    status: text('status')
      .$type<PublishPostStatus>()
      .notNull()
      .default('planned'),
    /** When it should go out. Null is "when it's posted". */
    scheduledFor: timestamp('scheduled_for', tz),
    postedAt: timestamp('posted_at', tz),
    externalId: text('external_id'),
    url: text('url'),
    evidenceLevel: text('evidence_level').$type<PublishEvidenceLevel>(),
    evidenceNote: text('evidence_note'),
    removedAt: timestamp('removed_at', tz),
    /** Why it failed, was removed or went back to planned, in words. */
    statusReason: text('status_reason'),
  },
  (t) => [
    unique('publish_posts_owner_scope_key').on(t.id, t.ownerId),
    unique('publish_posts_project_scope_key').on(t.id, t.projectId),
    inOwnProject('publish_posts_project_fk', t),
    foreignKey({
      name: 'publish_posts_account_fk',
      columns: [t.accountId, t.projectId],
      foreignColumns: [publishAccounts.id, publishAccounts.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'publish_posts_asset_fk',
      columns: [t.assetId, t.ownerId],
      foreignColumns: [assetAssets.id, assetAssets.ownerId],
    }).onDelete('restrict'),
    uniqueIndex('publish_posts_external_key')
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    uniqueIndex('publish_posts_url_key')
      .on(t.accountId, t.url)
      .where(sql`${t.url} is not null`),
    index('publish_posts_owner_idx').on(
      t.ownerId,
      t.projectId,
      t.status,
      t.postedAt,
    ),
    index('publish_posts_account_idx').on(t.accountId, t.postedAt),
    check('publish_posts_status_check', oneOf(t.status, PUBLISH_POST_STATUSES)),
    check(
      'publish_posts_evidence_level_check',
      nullableOneOf(t.evidenceLevel, PUBLISH_EVIDENCE_LEVELS),
    ),
    check(
      'publish_posts_title_check',
      sql`${t.title} is null or length(btrim(${t.title})) between 1 and 200`,
    ),
    check('publish_posts_caption_check', sql`length(${t.caption}) <= 5000`),
    check(
      'publish_posts_url_check',
      sql`${t.url} is null or ${t.url} ~ '^https?://' and length(${t.url}) <= 600`,
    ),
    check(
      'publish_posts_disclosure_check',
      sql`jsonb_typeof(${t.disclosure} -> 'aiGenerated') = 'boolean' and jsonb_typeof(${t.disclosure} -> 'affiliate') = 'boolean'`,
    ),
    // Out means a time, how we know, and where it is.
    check(
      'publish_posts_evidence_check',
      sql`${t.status} not in ('posted', 'verified', 'removed') or (${t.postedAt} is not null and ${t.evidenceLevel} is not null and (${t.url} is not null or ${t.externalId} is not null))`,
    ),
    check(
      'publish_posts_verified_check',
      sql`${t.status} <> 'verified' or ${t.evidenceLevel} = 'provider_verified'`,
    ),
    check(
      'publish_posts_removed_check',
      sql`(${t.status} = 'removed') = (${t.removedAt} is not null)`,
    ),
  ],
)

export const publishIntents = pgTable(
  'publish_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id').notNull(),
    postId: uuid('post_id').notNull(),
    accountId: uuid('account_id').notNull(),
    /** The release authorization this dispatch consumed. */
    authorizationId: uuid('authorization_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    platform: text('platform').$type<PublishPlatform>().notNull(),
    status: text('status')
      .$type<PublishIntentStatus>()
      .notNull()
      .default('submitting'),
    attempts: integer('attempts').notNull().default(0),
    remotePostId: text('remote_post_id'),
    remoteUrl: text('remote_url'),
    remotePublishedAt: timestamp('remote_published_at', tz),
    /** What the platform read back, field by field, and what it couldn't. */
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
    unique('publish_intents_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('publish_intents_project_fk', t),
    foreignKey({
      name: 'publish_intents_post_fk',
      columns: [t.postId, t.projectId],
      foreignColumns: [publishPosts.id, publishPosts.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'publish_intents_account_fk',
      columns: [t.accountId, t.projectId],
      foreignColumns: [publishAccounts.id, publishAccounts.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'publish_intents_authorization_fk',
      columns: [t.authorizationId, t.ownerId],
      foreignColumns: [
        opsReleaseAuthorizations.id,
        opsReleaseAuthorizations.ownerId,
      ],
    }).onDelete('restrict'),
    uniqueIndex('publish_intents_idempotency_key').on(
      t.ownerId,
      t.idempotencyKey,
    ),
    // One dispatch in flight per post.
    uniqueIndex('publish_intents_live_key')
      .on(t.postId)
      .where(sql`${t.status} in ('submitting', 'submitted', 'unknown')`),
    uniqueIndex('publish_intents_remote_key')
      .on(t.accountId, t.remotePostId)
      .where(sql`${t.remotePostId} is not null`),
    index('publish_intents_queue_idx').on(t.status, t.nextAttemptAt),
    check(
      'publish_intents_status_check',
      oneOf(t.status, PUBLISH_INTENT_STATUSES),
    ),
    check(
      'publish_intents_platform_check',
      oneOf(t.platform, PUBLISH_PLATFORMS),
    ),
    check('publish_intents_actor_check', oneOf(t.actorType, OPS_ACTOR_TYPES)),
    check(
      'publish_intents_verified_check',
      sql`${t.status} <> 'verified' or (${t.verifiedAt} is not null and (${t.remotePostId} is not null or ${t.remoteUrl} is not null))`,
    ),
  ],
)

export const publishReadings = pgTable(
  'publish_readings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id').notNull(),
    /** Exactly one of post and account. */
    postId: uuid('post_id'),
    accountId: uuid('account_id'),
    /** `views`, `likes`, `watch_seconds`, `followers`, `earnings` … lowercase snake. */
    metric: text('metric').notNull(),
    /** An exact decimal. */
    value: numeric('value', {
      precision: 20,
      scale: 4,
      mode: 'string',
    }).notNull(),
    /** Set for money, null for counts. */
    currency: text('currency'),
    window: text('window').$type<ReadingWindow>().notNull(),
    /** When a lifetime counter was true. */
    asOf: timestamp('as_of', tz),
    windowStart: timestamp('window_start', tz),
    windowEnd: timestamp('window_end', tz),
    source: text('source').$type<ReadingSource>().notNull(),
    note: text('note'),
    /** The reading this one corrects. */
    supersedesId: uuid('supersedes_id'),
    correctionReason: text('correction_reason'),
    actorType: text('actor_type').$type<OpsActorType>().notNull(),
    actorId: text('actor_id').notNull(),
    /** When HQ was told. */
    observedAt: timestamp('observed_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('publish_readings_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('publish_readings_project_fk', t),
    foreignKey({
      name: 'publish_readings_post_fk',
      columns: [t.postId, t.projectId],
      foreignColumns: [publishPosts.id, publishPosts.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'publish_readings_account_fk',
      columns: [t.accountId, t.projectId],
      foreignColumns: [publishAccounts.id, publishAccounts.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'publish_readings_supersedes_fk',
      columns: [t.supersedesId, t.ownerId],
      foreignColumns: [t.id, t.ownerId],
    }).onDelete('restrict'),
    uniqueIndex('publish_readings_supersedes_key')
      .on(t.supersedesId)
      .where(sql`${t.supersedesId} is not null`),
    index('publish_readings_post_idx').on(t.postId, t.metric, t.asOf),
    index('publish_readings_account_idx').on(t.accountId, t.metric, t.asOf),
    index('publish_readings_owner_idx').on(
      t.ownerId,
      t.projectId,
      t.metric,
      t.observedAt,
    ),
    check(
      'publish_readings_subject_check',
      sql`num_nonnulls(${t.postId}, ${t.accountId}) = 1`,
    ),
    check(
      'publish_readings_metric_check',
      sql`${t.metric} ~ '^[a-z][a-z0-9_]{0,39}$'`,
    ),
    check(
      'publish_readings_window_type_check',
      oneOf(t.window, READING_WINDOWS),
    ),
    check(
      'publish_readings_window_check',
      sql`(${t.window} = 'lifetime' and ${t.asOf} is not null and ${t.windowStart} is null and ${t.windowEnd} is null) or (${t.window} = 'interval' and ${t.asOf} is null and ${t.windowStart} is not null and ${t.windowEnd} is not null and ${t.windowEnd} > ${t.windowStart})`,
    ),
    check(
      'publish_readings_money_check',
      sql`${t.currency} is null or ${t.window} = 'interval'`,
    ),
    check('publish_readings_currency_check', currencyCode(t.currency)),
    check('publish_readings_source_check', oneOf(t.source, READING_SOURCES)),
    check('publish_readings_actor_check', oneOf(t.actorType, OPS_ACTOR_TYPES)),
    check(
      'publish_readings_correction_check',
      sql`${t.supersedesId} is null or ${t.correctionReason} is not null`,
    ),
  ],
)

export type PublishAccountRow = typeof publishAccounts.$inferSelect
export type PublishPostRow = typeof publishPosts.$inferSelect
export type PublishIntentRow = typeof publishIntents.$inferSelect
export type PublishReadingRow = typeof publishReadings.$inferSelect
