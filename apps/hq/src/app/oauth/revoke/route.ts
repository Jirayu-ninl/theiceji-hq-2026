import { preflight } from '@/lib/oauth/http'
import { handleRevocation } from '@/lib/oauth/revoke'

/**
 * POST /oauth/revoke — RFC 7009. Presenting any token of a connection ends
 * the whole connection. Holding a token is the authority to kill it, so no
 * client authentication is asked for. An unknown token is still a 200; a
 * revocation that couldn't be recorded is a retryable 503 (see
 * src/lib/oauth/revoke.ts).
 */
export const dynamic = 'force-dynamic'

export function POST(request: Request): Promise<Response> {
  return handleRevocation(request)
}

export function OPTIONS(): Response {
  return preflight()
}
