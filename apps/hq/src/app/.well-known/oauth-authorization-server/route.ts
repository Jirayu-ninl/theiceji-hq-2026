import { ALL_SCOPES, OFFLINE_ACCESS } from '@theiceji/hq-db/access'
import {
  AUTHORIZE_PATH,
  issuer,
  REGISTER_PATH,
  REVOKE_PATH,
  TOKEN_PATH,
} from '@/lib/oauth/config'
import { CORS_HEADERS, preflight } from '@/lib/oauth/http'

/**
 * GET /.well-known/oauth-authorization-server — RFC 8414 metadata, read by an
 * MCP client after an MCP server's protected-resource metadata pointed it here.
 *
 * Fields that decide whether a client connects at all:
 *   · `issuer` must equal every MCP server's MCP_AUTHORIZATION_SERVER byte for
 *     byte.
 *   · `code_challenge_methods_supported: ["S256"]` — Claude and ChatGPT refuse
 *     an authorization server that doesn't advertise it.
 *   · `client_id_metadata_document_supported: true` AND `none` among the token
 *     auth methods — Claude only picks metadata documents when it sees both,
 *     otherwise it falls back to `registration_endpoint`.
 *   · `offline_access` in `scopes_supported` — Claude asks for a refresh token
 *     only when it sees it (HQ issues one either way).
 *   · `authorization_response_iss_parameter_supported` (RFC 9207) — honoured
 *     on every redirect; it's what lets ChatGPT use its shared callback URL.
 */
export const dynamic = 'force-dynamic'

export function GET(): Response {
  const iss = issuer()
  if (!iss) {
    return Response.json(
      {
        error: 'not_configured',
        error_description: 'Set OAUTH_ISSUER on HQ.',
      },
      { status: 404, headers: CORS_HEADERS },
    )
  }
  return Response.json(
    {
      issuer: iss,
      authorization_endpoint: `${iss}${AUTHORIZE_PATH}`,
      token_endpoint: `${iss}${TOKEN_PATH}`,
      registration_endpoint: `${iss}${REGISTER_PATH}`,
      revocation_endpoint: `${iss}${REVOKE_PATH}`,
      scopes_supported: [...ALL_SCOPES, OFFLINE_ACCESS],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: [
        'none',
        'client_secret_post',
        'client_secret_basic',
      ],
      revocation_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${iss}/settings/connections`,
    },
    { headers: { ...CORS_HEADERS, 'cache-control': 'public, max-age=300' } },
  )
}

export function OPTIONS(): Response {
  return preflight()
}
