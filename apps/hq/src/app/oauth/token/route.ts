import {
  authenticateClient,
  basicCredentials,
  resolveClient,
} from '@/lib/oauth/clients'
import { oauthReadiness } from '@/lib/oauth/config'
import { exchangeCode, refreshGrant } from '@/lib/oauth/grants'
import {
  CORS_HEADERS,
  NO_STORE,
  oauthError,
  preflight,
  rateLimited,
  readParams,
} from '@/lib/oauth/http'

/**
 * POST /oauth/token — authorization-code exchange and refresh.
 *
 * Form-encoded (RFC 6749 §4.1.3), JSON tolerated. Every credential failure
 * answers `invalid_grant` — Claude treats anything else on a refresh as
 * retryable and keeps hammering a dead connection instead of asking the owner
 * to reconnect.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const limited = rateLimited('token', request, 120, 60_000)
  if (limited) return limited

  if (!oauthReadiness().ok) {
    return oauthError(
      'temporarily_unavailable',
      'HQ connections are not configured.',
      { status: 503 },
    )
  }

  const params = await readParams(request)
  if (!params) {
    return oauthError(
      'invalid_request',
      'The token request body could not be read.',
    )
  }

  const authorization = request.headers.get('authorization')
  const clientId =
    params.get('client_id') ?? basicCredentials(authorization)?.id ?? null
  if (!clientId) {
    return oauthError('invalid_client', 'client_id is required.', {
      status: 401,
    })
  }

  try {
    const lookup = await resolveClient(clientId)
    if (
      !lookup.ok ||
      !authenticateClient(lookup.client, params, authorization)
    ) {
      return oauthError('invalid_client', 'Client authentication failed.', {
        status: 401,
      })
    }

    const grantType = params.get('grant_type')
    const outcome =
      grantType === 'authorization_code'
        ? await exchangeCode({
            client: lookup.client,
            code: params.get('code') ?? '',
            redirectUri: params.get('redirect_uri'),
            verifier: params.get('code_verifier') ?? '',
            resource: params.get('resource'),
          })
        : grantType === 'refresh_token'
          ? await refreshGrant({
              client: lookup.client,
              refreshToken: params.get('refresh_token') ?? '',
              resource: params.get('resource'),
            })
          : null

    if (!outcome) {
      return oauthError(
        'unsupported_grant_type',
        'grant_type must be authorization_code or refresh_token.',
      )
    }
    if (!outcome.ok) return oauthError(outcome.error, outcome.description)
    return Response.json(outcome.body, {
      headers: { ...CORS_HEADERS, ...NO_STORE },
    })
  } catch (error) {
    console.error('[oauth] token', (error as Error).message)
    return oauthError(
      'temporarily_unavailable',
      'HQ could not complete the token request. Try again.',
      { status: 503 },
    )
  }
}

export function OPTIONS(): Response {
  return preflight()
}
