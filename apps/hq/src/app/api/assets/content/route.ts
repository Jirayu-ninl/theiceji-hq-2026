import { providerFor, readContentToken } from '@theiceji/hq-assets/storage'
import { database } from '@theiceji/hq-ops/db'

/**
 * GET /api/assets/content?t=<sealed token>[&size=<px>] — the bytes of a file
 * in the owner's Google Drive: HQ never changes Drive sharing,
 * so Drive files are read through here. The token is the grant — sealed by
 * HQ, bound to one owner, one file and a few minutes — so the route needs no
 * session and reveals nothing without one. `size` asks for Drive's
 * thumbnail instead of the file.
 *
 * Public in proxy.ts: the token, not a cookie, is what lets a request in.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const claim = readContentToken(url.searchParams.get('t') ?? '')
  if (!claim)
    return new Response('This link has expired or isn’t valid.', {
      status: 403,
    })
  try {
    const provider = await providerFor(database(), claim.o, claim.p)
    const size = Number(url.searchParams.get('size') ?? '')
    const upstream =
      Number.isInteger(size) && size > 0 && size <= 1600 && provider.thumbnail
        ? await provider.thumbnail(claim.k, size)
        : await provider.get(claim.k)
    if (!upstream?.body)
      return new Response('That file isn’t there any more.', { status: 404 })
    const headers = new Headers({
      'Content-Type':
        upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    })
    const length = upstream.headers.get('content-length')
    if (length) headers.set('Content-Length', length)
    if (claim.f)
      headers.set(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(claim.f)}`,
      )
    return new Response(upstream.body, { status: 200, headers })
  } catch {
    return new Response('Storage couldn’t be reached. Try again in a moment.', {
      status: 502,
    })
  }
}
