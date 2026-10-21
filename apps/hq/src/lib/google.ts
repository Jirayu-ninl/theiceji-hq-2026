import 'server-only'
import { issuer } from './oauth/config'

/**
 * HQ's side of the Google consent round-trip. The services live
 * in @theiceji/hq-core/google; this file only knows HQ's URLs and the cookie
 * that carries `state` and the PKCE verifier between the two routes.
 */

export const GOOGLE_CALLBACK_PATH = '/api/google/callback'

/** Short-lived, httpOnly, sent only to the callback. */
export const GOOGLE_FLOW_COOKIE = 'hq_google_flow'
export const GOOGLE_FLOW_MAX_AGE = 10 * 60

/**
 * The redirect URI Google must have registered: HQ's public origin
 * (`OAUTH_ISSUER`, the same origin the OAuth server announces) when it is
 * set, else the origin the request came in on — which is what a local run
 * uses (`http://localhost:<port>`).
 */
export function googleRedirectUri(requestOrigin: string): string {
  return `${issuer() ?? requestOrigin}${GOOGLE_CALLBACK_PATH}`
}

/** Why a round-trip ended without a connection — as a code the page turns into words. */
export const GOOGLE_ERRORS = {
  denied: 'You didn’t allow HQ on Google’s screen, so nothing changed.',
  state:
    'That sign-in came back without the check HQ sent with it — it may be an old tab. Connect again.',
  setup:
    'Google isn’t set up on this server yet: the OAuth client or the sealing key is missing.',
  exchange: 'Google turned the sign-in down. Connect again.',
} as const

export type GoogleErrorCode = keyof typeof GOOGLE_ERRORS
