import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  CLIENT_AUTH_METHODS,
  type ClientAuthMethod,
  GRANT_ACTOR_TYPES,
  GRANT_KINDS,
  type GrantActorType,
  type GrantKind,
  OAUTH_CLIENT_KINDS,
  type OAuthClientKind,
  TOKEN_KINDS,
  type TokenKind,
  USER_ROLES,
  type UserRole,
} from '../enums'
import { oneOf, tz } from './_shared'

/**
 * The HQ database — plain Postgres, owned by apps/hq (it writes the
 * migrations) and read by apps/hq-mcp (it verifies bearer tokens) and
 * apps/agent-runner.
 *
 * `users` + `sessions` back HQ's auth gate, `push_subscriptions` is the Web
 * Push fan-out, `notes` is the owner's scratchpad, and the four
 * `oauth_*` tables are HQ's OAuth 2.1 authorization server for connected apps. There is no
 * row-level security: each app connects as a single role, so the gates live in
 * code (`requireUser()` in HQ, the bearer check in MCP), not in the database.
 *
 * Change a column here, then `bun run db:generate` → `bun run db:migrate`
 * from apps/hq.
 */

/** HQ operators. Created from the CLI (`bun run user:create`), never self-serve. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    email: text('email').notNull(),
    name: text('name'),
    /** Avatar URL, set by hand; the UI falls back to initials when absent or broken. */
    image: text('image'),
    /** scrypt digest — see apps/hq/src/lib/auth/password.ts for the encoding. */
    passwordHash: text('password_hash').notNull(),
    role: text('role').$type<UserRole>().notNull().default('admin'),
    lastLoginAt: timestamp('last_login_at', tz),
  },
  (t) => [
    // Case-insensitive identity: the app lower-cases on write, the index makes
    // it impossible to sneak a second "Admin@…" past that.
    uniqueIndex('users_email_lower_key').on(sql`lower(${t.email})`),
    check('users_role_check', oneOf(t.role, USER_ROLES)),
  ],
)

/**
 * Server-side sessions. `id` is the SHA-256 of the token handed to the browser,
 * so a database leak alone never yields a usable cookie. Deleting a row logs
 * that device out on its next request.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    // Sweeping expired rows scans this.
    index('sessions_expires_idx').on(t.expiresAt),
  ],
)

/**
 * Web Push subscriptions for HQ's alerts — one row per device/browser the
 * admin enabled notifications on. Endpoints expire, so the sender prunes
 * 404/410s on the fly.
 */
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
})

/* ── Connected apps: HQ's OAuth 2.1 authorization server ──────────────────
 *
 * Every credential HQ issues is an opaque random string, and every one it
 * stores is a SHA-256 of that string — the same rule as `sessions`. A token is
 * valid because its row exists and its grant is not revoked, so revoking a
 * connection in HQ ends it on the MCP server's very next request.
 */

/**
 * Apps that have introduced themselves — Claude, ChatGPT, Hermes Agent, an IDE.
 *
 * `id` IS the `client_id`: a minted `hqc_…` for Dynamic Client Registration, or
 * the HTTPS URL of a Client ID Metadata Document, in which case this row is the
 * durable cache of what that document served.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: text('id').primaryKey(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    kind: text('kind').$type<OAuthClientKind>().notNull(),
    /** Self-reported. Shown on the consent screen beside the client's host. */
    name: text('name').notNull(),
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
    clientUri: text('client_uri'),
    logoUri: text('logo_uri'),
    authMethod: text('auth_method')
      .$type<ClientAuthMethod>()
      .notNull()
      .default('none'),
    /** SHA-256 of the client secret — only for DCR clients that asked for one. */
    secretHash: text('secret_hash'),
  },
  (t) => [
    check('oauth_clients_kind_check', oneOf(t.kind, OAUTH_CLIENT_KINDS)),
    check(
      'oauth_clients_auth_method_check',
      oneOf(t.authMethod, CLIENT_AUTH_METHODS),
    ),
  ],
)

/**
 * One connection. An `oauth` grant is an app the owner consented to; a
 * `personal` grant is an access token they minted by hand for an agent that
 * only sends headers. Revoking sets `revoked_at` and kills every token under it.
 *
 * `resource` is the RFC 8707 audience — the MCP endpoint URL this grant is
 * valid at. The MCP server refuses a token whose grant names another.
 */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<GrantKind>().notNull(),
    clientId: text('client_id').references(() => oauthClients.id, {
      onDelete: 'cascade',
    }),
    /** The client's name at consent, or the name given to a personal token. */
    label: text('label').notNull(),
    /** Space-separated scopes, e.g. `board:read board:write`. */
    scope: text('scope').notNull(),
    resource: text('resource').notNull(),
    /**
     * Who this connection acts as in HQ's tools: an `agent` (OAuth apps,
     * and personal tokens by default) or a `worker` process. Set by the owner
     * when the token is minted; a caller can never claim another type.
     */
    actorType: text('actor_type')
      .$type<GrantActorType>()
      .notNull()
      .default('agent'),
    lastUsedAt: timestamp('last_used_at', tz),
    revokedAt: timestamp('revoked_at', tz),
  },
  (t) => [
    index('oauth_grants_user_idx').on(t.userId),
    check('oauth_grants_kind_check', oneOf(t.kind, GRANT_KINDS)),
    check(
      'oauth_grants_actor_type_check',
      oneOf(t.actorType, GRANT_ACTOR_TYPES),
    ),
    // An OAuth connection always belongs to a client; a personal token never does.
    check(
      'oauth_grants_client_check',
      sql`(${t.kind} = 'oauth') = (${t.clientId} is not null)`,
    ),
  ],
)

/**
 * Single-use authorization codes, alive for minutes. `grant_id` records which
 * connection a redeemed code produced, so a replayed code revokes exactly that
 * connection (OAuth 2.1 §4.1.3).
 */
export const oauthCodes = pgTable(
  'oauth_codes',
  {
    /** SHA-256 of the code. */
    id: text('id').primaryKey(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    /** PKCE S256 challenge. */
    codeChallenge: text('code_challenge').notNull(),
    scope: text('scope').notNull(),
    resource: text('resource').notNull(),
    usedAt: timestamp('used_at', tz),
    grantId: uuid('grant_id').references(() => oauthGrants.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [index('oauth_codes_expires_idx').on(t.expiresAt)],
)

/**
 * Access, refresh and personal tokens. `id` is the SHA-256 of the token.
 *
 * Refresh tokens rotate: using one stamps `superseded_at` and issues a
 * successor. The superseded row is kept on purpose — presenting it again is
 * how a stolen copy is detected (and the whole grant revoked).
 */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: text('id').primaryKey(),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<TokenKind>().notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    /** Null only for a personal token created without an expiry. */
    expiresAt: timestamp('expires_at', tz),
    supersededAt: timestamp('superseded_at', tz),
    /** Last four characters — how a personal token is recognised in the UI. */
    hint: text('hint'),
  },
  (t) => [
    index('oauth_tokens_grant_idx').on(t.grantId),
    index('oauth_tokens_expires_idx').on(t.expiresAt),
    check('oauth_tokens_kind_check', oneOf(t.kind, TOKEN_KINDS)),
  ],
)

export type UserRow = typeof users.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect
export type OAuthClientRow = typeof oauthClients.$inferSelect
export type OAuthGrantRow = typeof oauthGrants.$inferSelect
export type OAuthCodeRow = typeof oauthCodes.$inferSelect
export type OAuthTokenRow = typeof oauthTokens.$inferSelect
