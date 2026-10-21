'use server'

import { sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { getDb } from '@theiceji/hq-db'
import { users } from '@theiceji/hq-db/schema'
import { internalPath } from './paths'
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from './cookie'
import { dummyDigest, verifyPassword } from './password'
import { createSession, invalidateSession } from './session'
import {
  clearFailures,
  cooldownMinutes,
  isThrottled,
  recordFailure,
} from './throttle'

/**
 * Sign in / sign out. Both run as server actions, so the password never
 * reaches a client bundle and the session cookie is written on a response the
 * browser is already waiting for.
 */

export type LoginState = { error: string | null }

const credentials = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(400),
})

/** One generic message for every failure — never confirm which half was wrong. */
const BAD_CREDENTIALS = 'Email or password is incorrect.'

/** Only same-origin paths may be used as a post-login destination. */
function safeNext(value: FormDataEntryValue | null): string {
  return internalPath(value, '/')
}

async function clientIp(): Promise<string | null> {
  const h = await headers()
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    h.get('x-real-ip') ??
    null
  )
}

type Attempt = { ok: true; next: string } | { ok: false; error: string }

async function attempt(formData: FormData): Promise<Attempt> {
  const parsed = credentials.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })
  if (!parsed.success) return { ok: false, error: BAD_CREDENTIALS }

  const email = parsed.data.email.toLowerCase()
  const db = getDb()
  if (!db) {
    return {
      ok: false,
      error: 'The database is not configured yet (set DATABASE_URL).',
    }
  }

  const ip = await clientIp()
  const key = `${email}|${ip ?? 'unknown'}`
  if (isThrottled(key)) {
    return {
      ok: false,
      error: `Too many attempts. Try again in ${cooldownMinutes(key)} minutes.`,
    }
  }

  try {
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1)

    // Unknown address still burns one scrypt round, so timing gives nothing away.
    const digest = user?.passwordHash ?? (await dummyDigest())
    const valid = await verifyPassword(parsed.data.password, digest)

    if (!user || !valid) {
      recordFailure(key)
      return { ok: false, error: BAD_CREDENTIALS }
    }

    const h = await headers()
    const { token, expiresAt } = await createSession(user.id, {
      userAgent: h.get('user-agent'),
      ip,
    })
    await setSessionCookie(token, expiresAt)
    clearFailures(key)
  } catch (e) {
    console.error('[auth] sign-in', (e as Error).message)
    return { ok: false, error: 'Could not sign in right now. Try again.' }
  }

  return { ok: true, next: safeNext(formData.get('next')) }
}

export async function signIn(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const result = await attempt(formData)
  if (!result.ok) return { error: result.error }
  // Outside the try above on purpose — redirect() works by throwing.
  redirect(result.next)
}

export async function signOut(): Promise<void> {
  const token = await readSessionCookie()
  if (token) await invalidateSession(token).catch(() => {})
  await clearSessionCookie()
  redirect('/login')
}
