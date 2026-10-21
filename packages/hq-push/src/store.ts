import { desc, eq } from 'drizzle-orm'
import { getDb, isDbConfigured } from '@theiceji/hq-db'
import { pushSubscriptions } from '@theiceji/hq-db/schema'
import type { PushSubscriptionPayload, StoredSubscription } from './types'

/**
 * Data access for the `push_subscriptions` table — the devices that turned on
 * alerts in HQ → Settings → Notifications. Returns empty when DATABASE_URL
 * isn't wired, so HQ degrades instead of crashing.
 */

export function isConfigured(): boolean {
  return isDbConfigured()
}

/** Upsert by endpoint — re-subscribing the same browser refreshes its keys. */
export async function saveSubscription(
  sub: PushSubscriptionPayload,
  userAgent: string | null,
): Promise<void> {
  const db = getDb()
  if (!db) throw new Error('DATABASE_URL is not configured.')
  await db
    .insert(pushSubscriptions)
    .values({
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent,
      },
    })
}

export async function removeSubscription(endpoint: string): Promise<void> {
  const db = getDb()
  if (!db) throw new Error('DATABASE_URL is not configured.')
  await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
}

export type PushDevice = {
  id: string
  createdAt: Date
  userAgent: string | null
}

/** Subscribed devices for Settings — never the endpoint or its keys. */
export async function listDevices(): Promise<PushDevice[]> {
  const db = getDb()
  if (!db) return []
  return db
    .select({
      id: pushSubscriptions.id,
      createdAt: pushSubscriptions.createdAt,
      userAgent: pushSubscriptions.userAgent,
    })
    .from(pushSubscriptions)
    .orderBy(desc(pushSubscriptions.createdAt))
}

export async function removeDevice(id: string): Promise<boolean> {
  const db = getDb()
  if (!db) throw new Error('DATABASE_URL is not configured.')
  const gone = await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.id, id))
    .returning({ id: pushSubscriptions.id })
  return gone.length > 0
}

export async function listSubscriptions(): Promise<StoredSubscription[]> {
  const db = getDb()
  if (!db) return []
  const rows = await db
    .select({
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
  return rows.map((r) => ({
    endpoint: r.endpoint,
    keys: { p256dh: r.p256dh, auth: r.auth },
  }))
}
