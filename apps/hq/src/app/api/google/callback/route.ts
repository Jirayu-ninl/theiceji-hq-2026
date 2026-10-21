import { timingSafeEqual } from 'node:crypto'
import { requireUser } from '@theiceji/hq-auth'
import { connectGoogle } from '@theiceji/hq-core/google'
import { userActor } from '@theiceji/hq-ops/access'
import { OpsError } from '@theiceji/hq-ops/errors'
import { cookies } from 'next/headers'
import {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_FLOW_COOKIE,
  type GoogleErrorCode,
  googleRedirectUri,
} from '@/lib/google'

export const dynamic = 'force-dynamic'

const same = (a: string, b: string) => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * GET /api/google/callback — Google sends the owner back here. The `state`
 * must match the one this browser was given; then the code is traded, HQ's
 * Drive folder found or made, and the refresh token stored sealed. Every
 * outcome lands on Settings › Google, which says what happened; nothing
 * about the tokens ever goes into a URL.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await requireUser('/settings/google')
  const url = new URL(request.url)
  const jar = await cookies()
  const flow = jar.get(GOOGLE_FLOW_COOKIE)?.value ?? ''
  jar.delete({ name: GOOGLE_FLOW_COOKIE, path: GOOGLE_CALLBACK_PATH })
  const [state = '', verifier = ''] = flow.split('.')

  if (url.searchParams.get('error')) return back('denied')
  const returned = url.searchParams.get('state') ?? ''
  if (!state || !verifier || !same(state, returned)) return back('state')

  try {
    await connectGoogle(userActor({ id: user.id, role: user.role }), {
      code: url.searchParams.get('code') ?? '',
      redirectUri: googleRedirectUri(url.origin),
      verifier,
    })
  } catch (error) {
    if (error instanceof OpsError)
      return back(
        error.code === 'capability_unavailable' ? 'setup' : 'exchange',
      )
    console.error('google: connect failed', error)
    return back('exchange')
  }
  return seeOther('/settings/google?connected=1')
}

function back(code: GoogleErrorCode): Response {
  return seeOther(`/settings/google?error=${code}`)
}

/** A relative 303, so the browser resolves it against the host it used. */
function seeOther(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: path, 'Cache-Control': 'no-store' },
  })
}
