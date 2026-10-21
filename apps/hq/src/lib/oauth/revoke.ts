import { oauthReadiness } from './config'
import { revokeToken } from './grants'
import {
  CORS_HEADERS,
  NO_STORE,
  oauthError,
  rateLimited,
  readParams,
} from './http'

/**
 * RFC 7009 token revocation, apart from the route so a test can inject the
 * failure the route has to survive.
 *
 * "200 whether or not the token existed" (§2.2) is about the token, not about
 * us: an unknown token is a success because there is nothing left to revoke,
 * but a database that couldn't record the revocation is not. That answer is a
 * retryable 503 — a client told "revoked" would stop trying while the
 * connection still works.
 */

export type RevocationDeps = {
  ready: () => { ok: boolean }
  revoke: (token: string) => Promise<void>
  log: (message: string) => void
}

const DEFAULTS: RevocationDeps = {
  ready: oauthReadiness,
  revoke: revokeToken,
  log: (message) => console.error(`[oauth] revoke ${message}`),
}

const unavailable = (): Response =>
  oauthError(
    'temporarily_unavailable',
    'The revocation could not be recorded right now. Try again shortly.',
    { status: 503, headers: { 'retry-after': '5' } },
  )

export async function handleRevocation(
  request: Request,
  deps: RevocationDeps = DEFAULTS,
): Promise<Response> {
  const limited = rateLimited('revoke', request, 60, 60_000)
  if (limited) return limited

  const token = (await readParams(request))?.get('token')?.trim()
  if (!token) return oauthError('invalid_request', 'token is required.')
  if (!deps.ready().ok) {
    deps.log('refused: OAuth is not configured on this HQ')
    return unavailable()
  }
  try {
    await deps.revoke(token)
  } catch (error) {
    deps.log(`failed: ${(error as Error).message}`)
    return unavailable()
  }
  return new Response(null, {
    status: 200,
    headers: { ...CORS_HEADERS, ...NO_STORE },
  })
}
