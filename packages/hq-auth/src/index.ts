import { redirect } from 'next/navigation'
import { cache } from 'react'
import { readSessionCookie, trySetSessionCookie } from './cookie'
import { type SessionUser, validateSessionToken } from './session'

/**
 * The auth gate, as used by HQ's pages, server actions and route handlers.
 *
 * `proxy.ts` bounces cookie-less traffic for speed, but it is **not** the
 * gate — every protected surface calls `requireUser()` (or `requireApiUser()`)
 * itself, so a request that slips past the proxy still hits a real check
 * against the database.
 *
 * `cache()` dedupes the lookup: a layout, its page, and any nested component
 * share one query per request.
 */

export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = await readSessionCookie()
  if (!token) return null

  const check = await validateSessionToken(token).catch(() => null)
  if (!check) return null

  if (check.refreshed) await trySetSessionCookie(token, check.expiresAt)
  return check.user
})

/** For pages and server actions — sends the visitor to the app's own /login. */
export async function requireUser(nextPath?: string): Promise<SessionUser> {
  const user = await getCurrentUser()
  if (user) return user
  const target = nextPath
    ? `/login?next=${encodeURIComponent(nextPath)}`
    : '/login'
  redirect(target)
}

/** For route handlers — a 401 is more use to fetch() than a redirect. */
export async function requireApiUser(): Promise<SessionUser | null> {
  return getCurrentUser()
}

export type { SessionUser } from './session'
