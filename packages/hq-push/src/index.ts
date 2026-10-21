// @theiceji/hq-push — Web Push over the `push_subscriptions` table.
//
// A device subscribes in HQ → Settings › Account, and HQ's ops tick reaches
// it when an urgent request is waiting for the owner.
export {
  isPushConfigured,
  type PushBody,
  sendPush,
} from './send'
export {
  isConfigured,
  listDevices,
  listSubscriptions,
  type PushDevice,
  removeDevice,
  removeSubscription,
  saveSubscription,
} from './store'
export {
  type PushSubscriptionPayload,
  pushSubscriptionSchema,
  type StoredSubscription,
} from './types'
