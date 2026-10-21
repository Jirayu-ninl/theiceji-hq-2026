import { requireUser } from '@theiceji/hq-auth'
import {
  authorizationUrl,
  googleBlocker,
  newPkce,
} from '@theiceji/hq-core/google'
import { NextResponse } from 'next/server'
import {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_FLOW_COOKIE,
  GOOGLE_FLOW_MAX_AGE,
  googleRedirectUri,
} from '@/lib/google'

export const dynamic = 'force-dynamic'

/**
 * GET /api/google/connect — start the one Google consent. The
 * owner must be signed in; `state` and the PKCE verifier ride in an httpOnly
 * cookie scoped to the callback, and the browser goes to Google. Nothing is
 * stored until the callback trades the code.
 */
export async function GET(request: Request): Promise<Response> {
  await requireUser('/settings/google')
  if (googleBlocker()) return seeOther('/settings/google?error=setup')
  const origin = new URL(request.url).origin
  const pkce = newPkce()
  const response = NextResponse.redirect(
    authorizationUrl({
      redirectUri: googleRedirectUri(origin),
      state: pkce.state,
      challenge: pkce.challenge,
    }),
    { status: 303, headers: { 'Cache-Control': 'no-store' } },
  )
  response.cookies.set(GOOGLE_FLOW_COOKIE, `${pkce.state}.${pkce.verifier}`, {
    httpOnly: true,
    secure: origin.startsWith('https:'),
    sameSite: 'lax',
    path: GOOGLE_CALLBACK_PATH,
    maxAge: GOOGLE_FLOW_MAX_AGE,
  })
  return response
}

/** A relative 303, so the browser resolves it against the host it used. */
function seeOther(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: path, 'Cache-Control': 'no-store' },
  })
}
