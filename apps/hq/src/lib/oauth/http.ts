/**
 * Response helpers shared by the OAuth endpoints.
 *
 * The metadata, registration, token and revocation endpoints are called by
 * other people's software — some of it in a browser (the MCP Inspector, web
 * IDEs) — so they answer CORS preflights. None of them reads a cookie, so
 * permissive CORS gives a cross-site page nothing it couldn't do with curl.
 * The consent decision (/api/oauth/authorize) is the opposite: cookie-bound,
 * same-origin only, and it gets none of this.
 */

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
} as const

export const NO_STORE = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
} as const

/** An RFC 6749 §5.2 error body. */
export function oauthError(
  error: string,
  description: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return Response.json(
    { error, error_description: description },
    {
      status: init.status ?? 400,
      headers: { ...CORS_HEADERS, ...NO_STORE, ...init.headers },
    },
  )
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

export function clientAddress(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  )
}

/**
 * Token and revocation requests are form-encoded (RFC 6749 §4.1.3); a few
 * clients send JSON anyway, and refusing them helps nobody.
 */
export async function readParams(
  request: Request,
): Promise<URLSearchParams | null> {
  const type = request.headers.get('content-type')?.toLowerCase() ?? ''
  try {
    if (type.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(body ?? {})) {
        if (typeof value === 'string') params.set(key, value)
      }
      return params
    }
    return new URLSearchParams(await request.text())
  } catch {
    return null
  }
}

/**
 * Fixed-window counter per endpoint + address, in memory. Per serverless
 * instance, like the login throttle: it raises the cost of hammering the
 * unauthenticated endpoints rather than capping it absolutely.
 */
const windows = new Map<string, { start: number; count: number }>()

export function rateLimited(
  bucket: string,
  request: Request,
  limit: number,
  windowMs: number,
): Response | null {
  const now = Date.now()
  if (windows.size > 2_000) {
    for (const [key, entry] of windows) {
      if (now - entry.start >= windowMs) windows.delete(key)
    }
  }
  const key = `${bucket}|${clientAddress(request)}`
  const entry = windows.get(key)
  if (!entry || now - entry.start >= windowMs) {
    windows.set(key, { start: now, count: 1 })
    return null
  }
  entry.count += 1
  if (entry.count <= limit) return null
  const retryAfter = Math.max(
    1,
    Math.ceil((entry.start + windowMs - now) / 1000),
  )
  return oauthError('slow_down', 'Too many requests. Try again shortly.', {
    status: 429,
    headers: { 'retry-after': String(retryAfter) },
  })
}
