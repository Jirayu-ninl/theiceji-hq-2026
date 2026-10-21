import { registerClient } from '@/lib/oauth/clients'
import { oauthReadiness } from '@/lib/oauth/config'
import {
  CORS_HEADERS,
  NO_STORE,
  oauthError,
  preflight,
  rateLimited,
} from '@/lib/oauth/http'

/**
 * POST /oauth/register — RFC 7591 Dynamic Client Registration.
 *
 * Deprecated by MCP in favour of Client ID Metadata Documents, and still the
 * door claude.ai and many other clients walk through. Unauthenticated by
 * protocol design and it creates rows, so it has the tightest budget here and
 * `registerClient` bounds every field. JSON body (RFC 7591 §3.1) — unlike the
 * token endpoint, which is form-encoded.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const limited = rateLimited('register', request, 30, 60 * 60 * 1000)
  if (limited) return limited

  if (!oauthReadiness().ok) {
    return oauthError(
      'temporarily_unavailable',
      'HQ connections are not configured.',
      { status: 503 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return oauthError(
      'invalid_client_metadata',
      'The registration body is not valid JSON.',
    )
  }

  try {
    const result = await registerClient(body)
    if (!result.ok) return oauthError(result.error, result.description)
    return Response.json(result.body, {
      status: 201,
      headers: { ...CORS_HEADERS, ...NO_STORE },
    })
  } catch (error) {
    console.error('[oauth] register', (error as Error).message)
    return oauthError(
      'temporarily_unavailable',
      'Registration failed. Try again.',
      { status: 503 },
    )
  }
}

export function OPTIONS(): Response {
  return preflight()
}
