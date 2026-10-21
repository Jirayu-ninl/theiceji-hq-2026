import { ALL_SCOPES, parseScopes, type Scope } from '@theiceji/hq-db/access'
import { type OAuthClient, resolveClient } from './clients'
import { issuer, oauthReadiness, resolveResource } from './config'
import { isPkceValue } from './pkce'
import { redirectMatches } from './redirect'

/**
 * The authorization request, validated the same way on both legs: when the
 * consent screen renders (GET /oauth/authorize) and again when its form posts
 * back (POST /api/oauth/authorize) — the hidden fields are client input too.
 *
 * RFC 6749 §4.1.2.1 splits failures in two. If the client or its redirect URI
 * can't be trusted, the error is SHOWN and nothing is sent anywhere. Anything
 * else is REDIRECTED back to the (now verified) client as `error=…`.
 */

export type AuthorizationRequest = {
  client: OAuthClient
  redirectUri: string
  state: string | null
  codeChallenge: string
  /** What the client asked for; the owner may grant less. */
  requestedScopes: Scope[]
  resource: string
}

export type AuthorizationParse =
  | { ok: true; request: AuthorizationRequest }
  | { ok: false; kind: 'show'; title: string; message: string }
  | { ok: false; kind: 'redirect'; location: string }

/**
 * An authorization response URL. Carries `iss` (RFC 9207) on success and on
 * error alike — HQ advertises `authorization_response_iss_parameter_supported`,
 * and a client that sees it must reject a response without one.
 */
export function authorizationResponse(
  redirectUri: string,
  params: Record<string, string | null>,
): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value)
  }
  const iss = issuer()
  if (iss) url.searchParams.set('iss', iss)
  return url.href
}

const show = (title: string, message: string): AuthorizationParse => ({
  ok: false,
  kind: 'show',
  title,
  message,
})

export async function parseAuthorizationRequest(
  params: URLSearchParams,
): Promise<AuthorizationParse> {
  const readiness = oauthReadiness()
  if (!readiness.ok) {
    return show(
      'HQ is not ready for connections',
      `Set ${readiness.missing.join(', ')} on HQ, then try connecting again.`,
    )
  }

  const clientId = params.get('client_id')
  if (!clientId) {
    return show('Unknown app', 'The app did not say who it is (no client_id).')
  }
  const lookup = await resolveClient(clientId, { fresh: true })
  if (!lookup.ok) return show('This app can’t connect', lookup.description)
  const { client } = lookup

  const presented = params.get('redirect_uri')
  let redirectUri: string
  if (presented) {
    if (!redirectMatches(presented, client.redirectUris)) {
      return show(
        'Unrecognised return address',
        `${client.name} asked to send you back to an address it never registered. Nothing was shared.`,
      )
    }
    redirectUri = presented
  } else if (client.redirectUris.length === 1 && client.redirectUris[0]) {
    redirectUri = client.redirectUris[0]
  } else {
    return show(
      'Missing return address',
      `${client.name} registered several return addresses but did not say which one to use.`,
    )
  }

  const state = params.get('state')
  const refuse = (error: string, description: string): AuthorizationParse => ({
    ok: false,
    kind: 'redirect',
    location: authorizationResponse(redirectUri, {
      error,
      error_description: description,
      state,
    }),
  })

  if (params.get('response_type') !== 'code') {
    return refuse(
      'unsupported_response_type',
      'Only response_type=code is supported.',
    )
  }
  const codeChallenge = params.get('code_challenge')
  if (!codeChallenge || !isPkceValue(codeChallenge)) {
    return refuse('invalid_request', 'PKCE is required: send a code_challenge.')
  }
  if (params.get('code_challenge_method') !== 'S256') {
    return refuse('invalid_request', 'code_challenge_method must be S256.')
  }
  const resource = resolveResource(params.get('resource'))
  if (!resource) {
    return refuse(
      'invalid_target',
      'HQ does not issue tokens for that resource.',
    )
  }

  // Nothing recognisable asked for (or no scope at all) → offer everything;
  // the owner unticks what this app shouldn't have.
  const asked = parseScopes(params.get('scope'))
  const requestedScopes = asked.length > 0 ? asked : [...ALL_SCOPES]

  return {
    ok: true,
    request: {
      client,
      redirectUri,
      state,
      codeChallenge,
      requestedScopes,
      resource,
    },
  }
}
