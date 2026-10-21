import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import type { Db } from '../client'
import type { GrantActorType, GrantKind, UserRole } from '../enums'
import { oauthGrants, oauthTokens, users } from '../schema'
import { canonicalResource } from './resource'
import { parseScopes, type Scope } from './scopes'
import { hashToken, looksLikeBearer, TOKEN_PREFIX } from './tokens'

/**
 * Bearer → connection: the check the MCP server runs on every request.
 *
 * Never cached. This lookup *is* the revocation check — a connection revoked in
 * HQ → Settings → Connections must stop working on its next call, not a minute later.
 */

export type AccessGrant = {
  grantId: string
  userId: string
  /** The owning user's role — a connection never exceeds it. */
  userRole: UserRole
  kind: GrantKind
  /** Who the connection acts as in HQ's tools. From the grant, never the caller. */
  actorType: GrantActorType
  clientId: string | null
  label: string
  scopes: Scope[]
  resource: string
  /** When the presented token expires; null for a personal token without one. */
  expiresAt: Date | null
}

export type AccessRefusal =
  /** No such token, or not a shape HQ issues. */
  | 'unknown'
  | 'expired'
  | 'revoked'
  /** Issued for a different MCP endpoint (RFC 8707 audience). */
  | 'wrong-resource'

export type AccessCheck =
  | { ok: true; grant: AccessGrant }
  | { ok: false; reason: AccessRefusal }

export async function verifyAccessToken(
  db: Db,
  token: string,
  resource: string,
  now: Date = new Date(),
): Promise<AccessCheck> {
  if (!looksLikeBearer(token)) return { ok: false, reason: 'unknown' }

  const [row] = await db
    .select({
      tokenKind: oauthTokens.kind,
      expiresAt: oauthTokens.expiresAt,
      grantId: oauthGrants.id,
      userId: oauthGrants.userId,
      userRole: users.role,
      grantKind: oauthGrants.kind,
      actorType: oauthGrants.actorType,
      clientId: oauthGrants.clientId,
      label: oauthGrants.label,
      scope: oauthGrants.scope,
      resource: oauthGrants.resource,
      revokedAt: oauthGrants.revokedAt,
    })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(
      and(
        eq(oauthTokens.id, hashToken(token)),
        inArray(oauthTokens.kind, ['access', 'personal']),
      ),
    )
    .limit(1)

  if (!row) return { ok: false, reason: 'unknown' }

  // The prefix must agree with the row: an `hq_at_` string is never a
  // personal token and vice versa.
  const expectedKind = token.startsWith(TOKEN_PREFIX.personalToken)
    ? 'personal'
    : 'access'
  if (row.tokenKind !== expectedKind) return { ok: false, reason: 'unknown' }

  if (row.revokedAt) return { ok: false, reason: 'revoked' }
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' }
  }
  if (canonicalResource(row.resource) !== canonicalResource(resource)) {
    return { ok: false, reason: 'wrong-resource' }
  }

  return {
    ok: true,
    grant: {
      grantId: row.grantId,
      userId: row.userId,
      userRole: row.userRole,
      kind: row.grantKind,
      actorType: row.actorType,
      clientId: row.clientId,
      label: row.label,
      scopes: parseScopes(row.scope),
      resource: row.resource,
      expiresAt: row.expiresAt,
    },
  }
}

/**
 * "Last used" for the Connections page — the one signal a human recognises as
 * wrong when a token leaks. Written at most once a minute per grant so a busy
 * agent doesn't turn every tool call into a write. Best effort: callers don't
 * await it on the request path.
 */
export async function touchGrant(
  db: Db,
  grantId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(oauthGrants)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(oauthGrants.id, grantId),
        or(
          isNull(oauthGrants.lastUsedAt),
          lt(oauthGrants.lastUsedAt, new Date(now.getTime() - 60_000)),
        ),
      ),
    )
}
