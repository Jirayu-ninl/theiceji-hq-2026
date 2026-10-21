import { z } from 'zod'

/**
 * Web Push domain — the subscription shape the browser hands us
 * (`PushSubscription.toJSON()`) and the validation contract the subscribe
 * route enforces. Kept dependency-light so it imports cleanly into both the
 * route handler and the store.
 */

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
})

export type PushSubscriptionPayload = z.infer<typeof pushSubscriptionSchema>

/** Row stored in `push_subscriptions`, mapped to the web-push wire shape. */
export type StoredSubscription = {
  endpoint: string
  keys: { p256dh: string; auth: string }
}
