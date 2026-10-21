import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, gt, lt, ne } from 'drizzle-orm'
import { getDb } from '@theiceji/hq-db'
import type { UserRole } from '@theiceji/hq-db/enums'
import { sessions, users } from '@theiceji/hq-db/schema'
import { SESSION_REFRESH_MS, SESSION_TTL_MS } from './constants'

/**
 * Server-side sessions, the boring kind.
 *
 * The browser holds a 256-bit random token; the database stores only its
 * SHA-256. A leaked dump therefore yields nothing an attacker can present as a
 * cookie, and deleting a row ends that device's access on its very next
 * request — the property a stateless JWT can't give you.
 *
 * Pure data access: no `next/headers` here, so the CLI scripts can import it.
 */

export type SessionUser = {
  id: string
  email: string
  name: string | null
  image: string | null
  role: UserRole
}

export type SessionCheck = {
  user: SessionUser
  expiresAt: Date
  /** True when the sliding window moved the expiry — the cookie wants re-setting. */
  refreshed: boolean
}

/** 32 random bytes, base64url — never stored as-is. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** The row id for a token. Knowing it can't sign anyone in — only the token can. */
export function sessionId(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const db = getDb()
  if (!db) throw new Error('DATABASE_URL is not configured.')

  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await db.insert(sessions).values({
    id: sessionId(token),
    userId,
    expiresAt,
    userAgent: meta.userAgent?.slice(0, 500) ?? null,
    ip: meta.ip ?? null,
  })
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, userId))

  return { token, expiresAt }
}

export async function validateSessionToken(
  token: string,
): Promise<SessionCheck | null> {
  const db = getDb()
  if (!db) return null

  const id = sessionId(token)
  const [row] = await db
    .select({
      expiresAt: sessions.expiresAt,
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .limit(1)

  if (!row) return null

  const now = Date.now()
  if (row.expiresAt.getTime() <= now) {
    await db.delete(sessions).where(eq(sessions.id, id))
    return null
  }

  const user: SessionUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    role: row.role,
  }

  if (row.expiresAt.getTime() - now < SESSION_REFRESH_MS) {
    const expiresAt = new Date(now + SESSION_TTL_MS)
    await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id))
    return { user, expiresAt, refreshed: true }
  }

  return { user, expiresAt: row.expiresAt, refreshed: false }
}

export async function invalidateSession(token: string): Promise<void> {
  const db = getDb()
  if (!db) return
  await db.delete(sessions).where(eq(sessions.id, sessionId(token)))
}

/** Sign a user out everywhere — use after a password change. */
export async function invalidateUserSessions(userId: string): Promise<void> {
  const db = getDb()
  if (!db) return
  await db.delete(sessions).where(eq(sessions.userId, userId))
}

export type UserSession = {
  id: string
  createdAt: Date
  expiresAt: Date
  userAgent: string | null
  ip: string | null
}

/** A user's live sessions, newest first — one per signed-in browser. */
export async function listUserSessions(userId: string): Promise<UserSession[]> {
  const db = getDb()
  if (!db) return []
  return db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      userAgent: sessions.userAgent,
      ip: sessions.ip,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.createdAt))
}

/** End one of the user's own sessions; false when it was already gone. */
export async function invalidateUserSession(
  userId: string,
  id: string,
): Promise<boolean> {
  const db = getDb()
  if (!db) return false
  const gone = await db
    .delete(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
    .returning({ id: sessions.id })
  return gone.length > 0
}

/** Sign out every other device, keeping the one presenting `keepToken`. */
export async function invalidateOtherSessions(
  userId: string,
  keepToken: string,
): Promise<number> {
  const db = getDb()
  if (!db) return 0
  const gone = await db
    .delete(sessions)
    .where(
      and(eq(sessions.userId, userId), ne(sessions.id, sessionId(keepToken))),
    )
    .returning({ id: sessions.id })
  return gone.length
}

/** Housekeeping for the CLI; expired rows are also dropped lazily on use. */
export async function sweepExpiredSessions(): Promise<number> {
  const db = getDb()
  if (!db) return 0
  const gone = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id })
  return gone.length
}
