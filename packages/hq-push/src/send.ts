import webpush from 'web-push'
import { listSubscriptions, removeSubscription } from './store'

/**
 * Web Push fan-out: loads every subscription, sends each a notification, and
 * prunes endpoints the push service reports as gone (404/410 — the browser
 * unsubscribed or the sub expired).
 *
 * Never throws to the caller — a push failure must not break whatever it was
 * announcing. A serverless caller should await it anyway, so it runs before
 * the function freezes, and swallow the result.
 *
 * env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 */

let configured: boolean | null = null

function ensureVapid(): boolean {
  if (configured !== null) return configured
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT
  if (!publicKey || !privateKey || !subject) {
    configured = false
    return false
  }
  webpush.setVapidDetails(subject, publicKey, privateKey)
  configured = true
  return true
}

/** Whether pushes can be sent at all — check before claiming anything to notify. */
export function isPushConfigured(): boolean {
  return ensureVapid()
}

export type PushBody = {
  title: string
  body: string
  url: string
  tag: string
}

/**
 * One notification to every subscribed device. Returns how many devices it
 * reached, so a caller that marks something "notified" can tell a delivery
 * from a no-op.
 */
export async function sendPush(body: PushBody): Promise<number> {
  if (!ensureVapid()) return 0

  let subs: Awaited<ReturnType<typeof listSubscriptions>>
  try {
    subs = await listSubscriptions()
  } catch (e) {
    console.error('[push] list', (e as Error).message)
    return 0
  }
  if (subs.length === 0) return 0

  const payload = JSON.stringify(body)
  let reached = 0

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload)
        reached++
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          await removeSubscription(sub.endpoint).catch(() => {})
        } else {
          console.error('[push] send', status, (e as Error).message)
        }
      }
    }),
  )
  return reached
}
