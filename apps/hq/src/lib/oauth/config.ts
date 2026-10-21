import { canonicalResource } from '@theiceji/hq-db/access'
import { isDbConfigured } from '@/db'

/**
 * HQ as an OAuth 2.1 authorization server for connected apps.
 *
 * Claude, ChatGPT, Hermes Agent, IDEs and other MCP clients reach HQ's tools
 * through an MCP server. That server answers an unauthenticated call with a pointer
 * to HQ; the client discovers the endpoints below, registers itself (Client ID
 * Metadata Document or Dynamic Client Registration), sends the owner here to
 * sign in and consent, and gets back tokens the MCP server verifies against
 * the same Postgres.
 *
 * env:
 *   OAUTH_ISSUER       HQ's public origin, e.g. https://hq.example.com — must
 *                      equal every MCP server's MCP_AUTHORIZATION_SERVER.
 *   MCP_RESOURCE_URLS  MCP endpoints tokens may be issued for, comma-separated;
 *                      the first is the default (clients that omit `resource`,
 *                      and personal access tokens).
 */

export const AUTHORIZE_PATH = '/oauth/authorize'
/**
 * Where the consent form posts. A Next segment holds a page OR a route, never
 * both, so the decision lives under /api. Only the advertised authorization
 * endpoint is a protocol contract; the form target is HQ's own business.
 */
export const CONSENT_PATH = '/api/oauth/authorize'
export const TOKEN_PATH = '/oauth/token'
export const REGISTER_PATH = '/oauth/register'
export const REVOKE_PATH = '/oauth/revoke'

/**
 * The issuer: an origin with no path and no trailing slash. RFC 8414 requires
 * it byte-identical to the identifier clients built the metadata URL from.
 */
export function issuer(): string | null {
  const raw = process.env.OAUTH_ISSUER?.trim()
  if (!raw) return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

export function issuerUrl(path: string): string {
  return `${issuer() ?? ''}${path}`
}

/** The resource servers HQ issues tokens for, canonicalised, in order. */
export function resources(): string[] {
  return (process.env.MCP_RESOURCE_URLS ?? '')
    .split(',')
    .map((entry) => canonicalResource(entry))
    .filter((entry): entry is string => entry !== null)
}

export function defaultResource(): string | null {
  return resources()[0] ?? null
}

/**
 * The audience for a request: the named `resource` if HQ serves it, the
 * default when the client named none (some agents don't send one), or null
 * when it names a server HQ doesn't know.
 */
export function resolveResource(
  requested: string | null | undefined,
): string | null {
  if (!requested) return defaultResource()
  const wanted = canonicalResource(requested)
  return wanted && resources().includes(wanted) ? wanted : null
}

export type OAuthReadiness = { ok: true } | { ok: false; missing: string[] }

export function oauthReadiness(): OAuthReadiness {
  const missing = [
    ...(issuer() ? [] : ['OAUTH_ISSUER']),
    ...(resources().length > 0 ? [] : ['MCP_RESOURCE_URLS']),
    ...(isDbConfigured() ? [] : ['DATABASE_URL']),
  ]
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}
