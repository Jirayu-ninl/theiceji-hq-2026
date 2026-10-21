import type { BaseConfig } from '../config'

/**
 * RFC 9728 Protected Resource Metadata — how a client with no credentials
 * learns which authorization server to send the owner to.
 *
 * Served at both places clients probe, in order:
 *   1. `/.well-known/oauth-protected-resource/mcp` — path-suffixed, because the
 *      resource URL has a path;
 *   2. `/.well-known/oauth-protected-resource` — the root form.
 *
 * Rules that break a connector silently when missed:
 *   · `resource` is `MCP_PUBLIC_URL` — the URL the owner pasted, byte for byte.
 *   · `authorization_servers` has exactly one entry: Claude uses the first and
 *     never falls back.
 *   · `scopes_supported` is what THIS server's tools actually name, not every
 *     scope the authorization server knows — a connection should never ask
 *     the owner to consent to something the endpoint can't use.
 *   · no `offline_access` here — refresh tokens are the authorization server's
 *     business, and it advertises that in its own metadata.
 */

export type MetadataConfig = Pick<
  BaseConfig,
  'MCP_PUBLIC_URL' | 'MCP_AUTHORIZATION_SERVER' | 'MCP_DOCUMENTATION_URL'
>

/**
 * `resourceName` is what a client shows the owner while consenting — the
 * resource server's own name, not the authorization server's. `scopes` are
 * the ones this server's own tools and resources name.
 */
export function protectedResourceMetadata(
  config: MetadataConfig,
  resourceName: string,
  scopes: readonly string[],
) {
  return {
    resource: config.MCP_PUBLIC_URL,
    authorization_servers: [config.MCP_AUTHORIZATION_SERVER],
    scopes_supported: [...scopes],
    bearer_methods_supported: ['header'],
    resource_name: resourceName,
    ...(config.MCP_DOCUMENTATION_URL
      ? { resource_documentation: config.MCP_DOCUMENTATION_URL }
      : {}),
  }
}

/** RFC 9728 inserts the well-known segment AHEAD of the resource's path. */
export function metadataPaths(publicUrl: string): {
  suffixed: string
  root: string
} {
  const path = new URL(publicUrl).pathname.replace(/\/+$/, '')
  return {
    suffixed: `/.well-known/oauth-protected-resource${path}`,
    root: '/.well-known/oauth-protected-resource',
  }
}

/** The absolute URL advertised in every `WWW-Authenticate` challenge. */
export function metadataUrl(publicUrl: string): string {
  return `${new URL(publicUrl).origin}${metadataPaths(publicUrl).suffixed}`
}

/**
 * A `WWW-Authenticate: Bearer …` value.
 *
 * · 401 with no `error` — no credentials yet (RFC 6750 §3.1). Starts OAuth.
 * · 401 `invalid_token` — expired, revoked or foreign. Starts OAuth again, so a
 *   revoked connection is reconnectable rather than dead.
 * · 403 `insufficient_scope` — step-up: the client re-authorizes asking for the
 *   union of what it holds and what `scope` names.
 *
 * Every input is a constant of this server, never caller text.
 */
export function bearerChallenge(input: {
  error?: 'invalid_token' | 'insufficient_scope'
  description?: string
  scope: string
  resourceMetadataUrl: string
}): string {
  const parts = [
    ...(input.error ? [`error="${input.error}"`] : []),
    ...(input.description
      ? [`error_description="${input.description.replaceAll('"', "'")}"`]
      : []),
    `resource_metadata="${input.resourceMetadataUrl}"`,
    `scope="${input.scope}"`,
  ]
  return `Bearer ${parts.join(', ')}`
}
