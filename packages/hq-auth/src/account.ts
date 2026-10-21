import { and, eq, ne, sql } from 'drizzle-orm'
import { getDb } from '@theiceji/hq-db'
import type { UserRole } from '@theiceji/hq-db/enums'
import { users } from '@theiceji/hq-db/schema'
import { hashPassword, verifyPassword } from './password'

/**
 * The signed-in user's own account, as Settings reads and edits it. Pure data
 * access like `session.ts` — the gate and validation live in the actions.
 */

export type Account = {
  id: string
  email: string
  name: string | null
  image: string | null
  role: UserRole
  createdAt: Date
  lastLoginAt: Date | null
}

function db() {
  const handle = getDb()
  if (!handle) throw new Error('DATABASE_URL is not configured.')
  return handle
}

export async function getAccount(userId: string): Promise<Account | null> {
  const [row] = await db()
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
      role: users.role,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row ?? null
}

export async function verifyUserPassword(
  userId: string,
  password: string,
): Promise<boolean> {
  const [row] = await db()
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row ? verifyPassword(password, row.passwordHash) : false
}

export async function updateProfile(
  userId: string,
  profile: { name: string | null; image: string | null },
): Promise<void> {
  await db().update(users).set(profile).where(eq(users.id, userId))
}

/** Case-insensitive, like the unique index that backs it. */
export async function emailInUse(
  email: string,
  exceptUserId: string,
): Promise<boolean> {
  const [row] = await db()
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        sql`lower(${users.email}) = ${email.toLowerCase()}`,
        ne(users.id, exceptUserId),
      ),
    )
    .limit(1)
  return Boolean(row)
}

export async function updateEmail(userId: string, email: string) {
  await db()
    .update(users)
    .set({ email: email.toLowerCase() })
    .where(eq(users.id, userId))
}

export async function updatePassword(userId: string, password: string) {
  const passwordHash = await hashPassword(password)
  await db().update(users).set({ passwordHash }).where(eq(users.id, userId))
}
