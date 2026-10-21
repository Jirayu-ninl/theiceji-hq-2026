import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  canonicalResource,
  formatScopes,
  hashToken,
  mintToken,
  parseScopes,
  REFRESH_TOKEN_TTL_MS,
  type Scope,
  tokenHint,
} from '@theiceji/hq-db/access'
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import { type Db, requireDb } from '@/db'
import type { GrantActorType, OAuthClientKind } from '@/db/enums'
import { oauthClients, oauthCodes, oauthGrants, oauthTokens } from '@/db/schema'
import { clientHost, type OAuthClient } from './clients'
import { defaultResource } from './config'
import { verifyPkce } from './pkce'
import { redirectMatches } from './redirect'

/**
 * Grants, codes and tokens — everything the token endpoint and the
 * Connections page do to the `oauth_*` tables.
 *
 * Two failures are not ordinary errors, and both end a connection: a replayed
 * authorization code and a reused refresh token. Each is evidence a credential
 * reached a second party, and OAuth 2.1's answer is to revoke the grant.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * A superseded refresh token presented again inside this window is a client
 * racing its own refresh, not theft: it's refused without killing the grant.
 */
const REFRESH_REUSE_GRACE_MS = 30_000

export type TokenBody = {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

export type TokenOutcome =
  | { ok: true; body: TokenBody }
  | {
      ok: false
      error: 'invalid_grant' | 'invalid_target' | 'invalid_request'
      description: string
    }

const invalidGrant = (description: string): TokenOutcome => ({
  ok: false,
  error: 'invalid_grant',
  description,
})

async function issueTokenPair(
  tx: Tx,
  grantId: string,
  scope: string,
  now: Date,
): Promise<TokenBody> {
  const accessToken = mintToken('accessToken')
  const refreshToken = mintToken('refreshToken')
  await tx.insert(oauthTokens).values([
    {
      id: hashToken(accessToken),
      grantId,
      kind: 'access',
      createdAt: now,
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
    },
    {
      id: hashToken(refreshToken),
      grantId,
      kind: 'refresh',
      createdAt: now,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    },
  ])
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope,
  }
}

async function revokeGrantRow(db: Db | Tx, grantId: string, now: Date) {
  return db
    .update(oauthGrants)
    .set({ revokedAt: now })
    .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)))
    .returning({ id: oauthGrants.id })
}

/* ── Authorization code ─────────────────────────────────────────────────── */

export async function createAuthorizationCode(input: {
  client: OAuthClient
  userId: string
  redirectUri: string
  codeChallenge: string
  scopes: Scope[]
  resource: string
}): Promise<string> {
  const code = mintToken('authorizationCode')
  const now = new Date()
  await requireDb()
    .insert(oauthCodes)
    .values({
      id: hashToken(code),
      createdAt: now,
      expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS),
      clientId: input.client.id,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scope: formatScopes(input.scopes),
      resource: input.resource,
    })
  return code
}

export async function exchangeCode(input: {
  client: OAuthClient
  code: string
  redirectUri: string | null
  verifier: string
  resource: string | null
}): Promise<TokenOutcome> {
  if (!input.code || !input.verifier) {
    return {
      ok: false,
      error: 'invalid_request',
      description: 'code and code_verifier are required.',
    }
  }
  const db = requireDb()
  const now = new Date()

  const [row] = await db
    .select()
    .from(oauthCodes)
    .where(eq(oauthCodes.id, hashToken(input.code)))
    .limit(1)
  if (!row) return invalidGrant('That authorization code is not valid.')

  if (row.usedAt) {
    // Presented twice by the app it was issued to, with the right verifier →
    // the code and its verifier reached a second party, so kill what the code
    // created. Anyone else — another client, a wrong or missing verifier —
    // proves nothing and must not be able to end the owner's connection by
    // replaying a code they merely saw.
    if (
      row.clientId !== input.client.id ||
      !verifyPkce(input.verifier, row.codeChallenge)
    ) {
      return invalidGrant('That authorization code is not valid.')
    }
    if (row.grantId) await revokeGrantRow(db, row.grantId, now)
    return invalidGrant(
      'That authorization code was already used. The connection it created has been revoked — connect again.',
    )
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return invalidGrant('That authorization code expired. Connect again.')
  }
  if (row.clientId !== input.client.id) {
    return invalidGrant('That authorization code was issued to another app.')
  }
  if (
    input.redirectUri &&
    input.redirectUri !== row.redirectUri &&
    !redirectMatches(input.redirectUri, [row.redirectUri])
  ) {
    return invalidGrant(
      'redirect_uri does not match the authorization request.',
    )
  }
  // PKCE BEFORE the code is burned: someone holding the code without the
  // verifier must not be able to spend — and so kill — the owner's code.
  if (!verifyPkce(input.verifier, row.codeChallenge)) {
    return invalidGrant('code_verifier does not match the code challenge.')
  }
  // Some clients omit `resource` here; when present it must name the audience
  // the owner consented to.
  if (input.resource && canonicalResource(input.resource) !== row.resource) {
    return {
      ok: false,
      error: 'invalid_target',
      description: 'resource does not match the authorization request.',
    }
  }

  return db.transaction(async (tx): Promise<TokenOutcome> => {
    // Conditional burn: two concurrent redemptions can't both win.
    const burned = await tx
      .update(oauthCodes)
      .set({ usedAt: now })
      .where(and(eq(oauthCodes.id, row.id), isNull(oauthCodes.usedAt)))
      .returning({ id: oauthCodes.id })
    if (burned.length === 0) {
      return invalidGrant('That authorization code was already used.')
    }
    const [grant] = await tx
      .insert(oauthGrants)
      .values({
        userId: row.userId,
        kind: 'oauth',
        clientId: row.clientId,
        label: input.client.name,
        scope: row.scope,
        resource: row.resource,
        createdAt: now,
      })
      .returning({ id: oauthGrants.id })
    if (!grant) throw new Error('grant insert returned no row')
    await tx
      .update(oauthCodes)
      .set({ grantId: grant.id })
      .where(eq(oauthCodes.id, row.id))
    return {
      ok: true,
      body: await issueTokenPair(tx, grant.id, row.scope, now),
    }
  })
}

/* ── Refresh ────────────────────────────────────────────────────────────── */

/** One refusal text for unknown, expired and reused alike — telling them apart would help a thief time a theft. */
const REFRESH_REFUSED =
  'That refresh token is no longer valid. Reconnect TheIceJi HQ.'

export async function refreshGrant(input: {
  client: OAuthClient
  refreshToken: string
  resource: string | null
}): Promise<TokenOutcome> {
  if (!input.refreshToken) {
    return {
      ok: false,
      error: 'invalid_request',
      description: 'refresh_token is required.',
    }
  }
  const db = requireDb()
  const now = new Date()

  const [row] = await db
    .select({
      id: oauthTokens.id,
      kind: oauthTokens.kind,
      expiresAt: oauthTokens.expiresAt,
      supersededAt: oauthTokens.supersededAt,
      grantId: oauthGrants.id,
      clientId: oauthGrants.clientId,
      scope: oauthGrants.scope,
      resource: oauthGrants.resource,
      revokedAt: oauthGrants.revokedAt,
    })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .where(eq(oauthTokens.id, hashToken(input.refreshToken)))
    .limit(1)

  if (row?.kind !== 'refresh' || row.clientId !== input.client.id) {
    return invalidGrant(REFRESH_REFUSED)
  }
  if (row.revokedAt) return invalidGrant(REFRESH_REFUSED)
  if (row.supersededAt) {
    if (now.getTime() - row.supersededAt.getTime() > REFRESH_REUSE_GRACE_MS) {
      await revokeGrantRow(db, row.grantId, now)
    }
    return invalidGrant(REFRESH_REFUSED)
  }
  if (!row.expiresAt || row.expiresAt.getTime() <= now.getTime()) {
    return invalidGrant(REFRESH_REFUSED)
  }
  if (
    input.resource &&
    canonicalResource(input.resource) !== canonicalResource(row.resource)
  ) {
    return {
      ok: false,
      error: 'invalid_target',
      description: 'resource does not match this connection.',
    }
  }

  return db.transaction(async (tx): Promise<TokenOutcome> => {
    // Rotate: claim this row first, conditionally, so two concurrent refreshes
    // can't both mint successors.
    const claimed = await tx
      .update(oauthTokens)
      .set({ supersededAt: now })
      .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.supersededAt)))
      .returning({ id: oauthTokens.id })
    if (claimed.length === 0) return invalidGrant(REFRESH_REFUSED)
    return {
      ok: true,
      body: await issueTokenPair(tx, row.grantId, row.scope, now),
    }
  })
}

/* ── Revocation ─────────────────────────────────────────────────────────── */

/** RFC 7009: revoking any token of a connection ends the whole connection. */
export async function revokeToken(token: string): Promise<void> {
  const db = requireDb()
  const [row] = await db
    .select({ grantId: oauthTokens.grantId })
    .from(oauthTokens)
    .where(eq(oauthTokens.id, hashToken(token)))
    .limit(1)
  if (row) await revokeGrantRow(db, row.grantId, new Date())
}

/** From the Connections page. Scoped to the signed-in owner. */
export async function revokeGrant(
  grantId: string,
  userId: string,
): Promise<boolean> {
  const revoked = await requireDb()
    .update(oauthGrants)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oauthGrants.id, grantId),
        eq(oauthGrants.userId, userId),
        isNull(oauthGrants.revokedAt),
      ),
    )
    .returning({ id: oauthGrants.id })
  return revoked.length > 0
}

/* ── Connections page ───────────────────────────────────────────────────── */

export type Connection = {
  id: string
  kind: 'oauth' | 'personal'
  label: string
  /** The app's host for OAuth connections; null for personal tokens. */
  host: string | null
  clientKind: OAuthClientKind | null
  scopes: Scope[]
  resource: string
  createdAt: string
  lastUsedAt: string | null
  /** Last four characters of a personal token. */
  tokenHint: string | null
  expiresAt: string | null
  /** No live refresh token (OAuth) or an expired token (personal). */
  expired: boolean
  /** Who it acts as in HQ's tools: an `agent`, or a `worker` that runs jobs. */
  actorType: GrantActorType
}

export async function listConnections(userId: string): Promise<Connection[]> {
  const db = requireDb()
  const now = new Date()

  const grants = await db
    .select({
      id: oauthGrants.id,
      kind: oauthGrants.kind,
      label: oauthGrants.label,
      actorType: oauthGrants.actorType,
      scope: oauthGrants.scope,
      resource: oauthGrants.resource,
      createdAt: oauthGrants.createdAt,
      lastUsedAt: oauthGrants.lastUsedAt,
      clientId: oauthClients.id,
      clientKind: oauthClients.kind,
      clientRedirects: oauthClients.redirectUris,
    })
    .from(oauthGrants)
    .leftJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
    .orderBy(desc(oauthGrants.createdAt))

  const ids = grants.map((grant) => grant.id)
  const tokens =
    ids.length === 0
      ? []
      : await db
          .select({
            grantId: oauthTokens.grantId,
            kind: oauthTokens.kind,
            hint: oauthTokens.hint,
            expiresAt: oauthTokens.expiresAt,
          })
          .from(oauthTokens)
          .where(
            and(
              inArray(oauthTokens.grantId, ids),
              inArray(oauthTokens.kind, ['personal', 'refresh']),
              isNull(oauthTokens.supersededAt),
            ),
          )

  return grants.map((grant) => {
    const own = tokens.filter((token) => token.grantId === grant.id)
    const personal = own.find((token) => token.kind === 'personal')
    const live =
      grant.kind === 'personal'
        ? !!personal &&
          (!personal.expiresAt || personal.expiresAt.getTime() > now.getTime())
        : own.some(
            (token) =>
              token.kind === 'refresh' &&
              !!token.expiresAt &&
              token.expiresAt.getTime() > now.getTime(),
          )
    return {
      id: grant.id,
      kind: grant.kind,
      label: grant.label,
      host:
        grant.clientId && grant.clientKind
          ? clientHost({
              id: grant.clientId,
              kind: grant.clientKind,
              redirectUris: grant.clientRedirects ?? [],
            })
          : null,
      clientKind: grant.clientKind,
      scopes: parseScopes(grant.scope),
      resource: grant.resource,
      createdAt: grant.createdAt.toISOString(),
      lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
      tokenHint: personal?.hint ?? null,
      expiresAt: personal?.expiresAt?.toISOString() ?? null,
      expired: !live,
      actorType: grant.actorType,
    }
  })
}

/**
 * A personal access token: a grant with no client, for agents that can only
 * send `Authorization: Bearer …`. The plaintext is returned once and never
 * stored.
 */
export async function createPersonalToken(input: {
  userId: string
  label: string
  scopes: Scope[]
  expiresInDays: number | null
  /** An agent (plans and operates) or a worker (claims production jobs). */
  actorType?: GrantActorType
}): Promise<{ token: string; grantId: string }> {
  const resource = defaultResource()
  if (!resource) throw new Error('Set MCP_RESOURCE_URLS on HQ first.')
  const token = mintToken('personalToken')
  const now = new Date()
  return requireDb().transaction(async (tx) => {
    const [grant] = await tx
      .insert(oauthGrants)
      .values({
        userId: input.userId,
        kind: 'personal',
        clientId: null,
        actorType: input.actorType ?? 'agent',
        label: input.label,
        scope: formatScopes(input.scopes),
        resource,
        createdAt: now,
      })
      .returning({ id: oauthGrants.id })
    if (!grant) throw new Error('grant insert returned no row')
    await tx.insert(oauthTokens).values({
      id: hashToken(token),
      grantId: grant.id,
      kind: 'personal',
      createdAt: now,
      expiresAt: input.expiresInDays
        ? new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : null,
      hint: tokenHint(token),
    })
    return { token, grantId: grant.id }
  })
}

/* ── Housekeeping (daily cron) ──────────────────────────────────────────── */

/**
 * Drop codes a day past expiry and tokens a week past expiry. Superseded
 * refresh rows are kept until then on purpose: they are what detects reuse.
 */
export async function sweepOAuth(
  now: Date = new Date(),
): Promise<{ codes: number; tokens: number }> {
  const db = requireDb()
  const day = 24 * 60 * 60 * 1000
  const codes = await db
    .delete(oauthCodes)
    .where(lt(oauthCodes.expiresAt, new Date(now.getTime() - day)))
    .returning({ id: oauthCodes.id })
  const tokens = await db
    .delete(oauthTokens)
    .where(lt(oauthTokens.expiresAt, new Date(now.getTime() - 7 * day)))
    .returning({ id: oauthTokens.id })
  return { codes: codes.length, tokens: tokens.length }
}
