import { requireApiUser } from '@theiceji/hq-auth'
import { userActor } from '@theiceji/hq-ops/access'
import { NextResponse } from 'next/server'
import { searchPalette } from '@/lib/palette'

/**
 * POST /api/palette `{ q }` — the footer prompt's search (lib/palette.ts).
 * A POST keeps what you typed out of URLs and logs; it only reads. It checks
 * the session itself rather than trusting the proxy's cookie sniff, and
 * answers only the signed-in owner's notes and records.
 */
export async function POST(req: Request) {
  const user = await requireApiUser()
  if (!user)
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 },
    )
  let query = ''
  try {
    const body: unknown = await req.json()
    if (body && typeof body === 'object' && 'q' in body)
      query = typeof body.q === 'string' ? body.q : ''
  } catch {
    return NextResponse.json(
      { ok: false, error: 'bad_request' },
      { status: 400 },
    )
  }
  const result = await searchPalette(userActor(user), query)
  return NextResponse.json(result, {
    headers: { 'cache-control': 'private, no-store' },
  })
}
