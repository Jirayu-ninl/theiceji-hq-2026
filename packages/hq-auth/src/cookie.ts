import { cookies } from 'next/headers'
import { SESSION_COOKIE } from './constants'

/**
 * The session cookie. httpOnly so script can't read it, sameSite=lax so it
 * survives a normal top-level navigation but not a cross-site form post,
 * secure once deployed.
 */

const options = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
} as const

export async function readSessionCookie(): Promise<string | null> {
  const store = await cookies()
  return store.get(SESSION_COOKIE)?.value ?? null
}

export async function setSessionCookie(
  token: string,
  expiresAt: Date,
): Promise<void> {
  const store = await cookies()
  store.set(SESSION_COOKIE, token, { ...options, expires: expiresAt })
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies()
  store.set(SESSION_COOKIE, '', { ...options, maxAge: 0 })
}

/**
 * Re-set the cookie after a sliding refresh. Server Components render after
 * headers are sent, so writing there throws — swallow it and let the next
 * action or route handler carry the new expiry. The database row is already
 * extended either way.
 */
export async function trySetSessionCookie(
  token: string,
  expiresAt: Date,
): Promise<void> {
  try {
    await setSessionCookie(token, expiresAt)
  } catch {
    // read-only cookie store (render phase) — nothing to do
  }
}
