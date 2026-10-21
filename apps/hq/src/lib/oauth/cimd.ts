import {
  GuardedFetchError,
  type GuardOptions,
  guardedFetch,
} from '@theiceji/net-guard'
import {
  isLoopbackRedirect,
  isValidRedirectUri,
  redirectLabel,
} from './redirect'

/**
 * Client ID Metadata Documents — the registration path MCP prefers.
 *
 * The `client_id` IS an HTTPS URL that serves the client's own metadata:
 * Claude Code (`https://claude.ai/oauth/claude-code-client-metadata`), ChatGPT
 * (`https://chatgpt.com/oauth/client.json`), Hermes Agent, VS Code. No
 * `/register` call and no secret; the whole security of it is one check — the
 * document's own `client_id` must equal the URL it was fetched from.
 *
 * The response is hostile input from an address a stranger chose, so:
 *   · the host must resolve to public addresses only (no metadata endpoint,
 *     private range or loopback probing from HQ's network), and the
 *     connection is pinned to the address that was checked — a second DNS
 *     answer can't redirect it (`@theiceji/net-guard`);
 *   · redirects aren't followed, the body is capped while it streams (not
 *     after it is buffered), the fetch times out;
 *   · redirect URIs must be same-origin with the `client_id`, loopback, or a
 *     native app scheme — hosting one JSON file must not let anyone name an
 *     arbitrary web redirect target;
 *   · the consent screen names the client_id's HOST, not just `client_name`.
 */

const FETCH_TIMEOUT_MS = 5_000
const MAX_BYTES = 64 * 1024
const SUCCESS_TTL_MS = 10 * 60 * 1000
const FAILURE_TTL_MS = 60 * 1000

export type ClientMetadataDocument = {
  clientId: string
  name: string
  redirectUris: string[]
  clientUri: string | null
  logoUri: string | null
}

export type CimdFailure =
  | 'not-a-cimd-url'
  | 'not-public'
  | 'unreachable'
  | 'too-large'
  | 'not-json'
  | 'client-id-mismatch'
  | 'redirect-uris-invalid'

export type CimdResult =
  | { ok: true; document: ClientMetadataDocument }
  | { ok: false; reason: CimdFailure }

/** An `https://` URL with a path, no query, fragment or credentials. */
export function isCimdClientId(clientId: string): boolean {
  if (!clientId.startsWith('https://')) return false
  try {
    const url = new URL(clientId)
    return (
      url.pathname.length > 1 &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

/* ── Fetch + validate ─────────────────────────────────────────────────── */

function redirectAllowed(uri: string, clientId: string): boolean {
  if (!isValidRedirectUri(uri)) return false
  if (isLoopbackRedirect(uri)) return true
  const url = new URL(uri)
  if (url.protocol === 'https:') return url.origin === new URL(clientId).origin
  return url.protocol !== 'http:' // a native app scheme
}

function validate(clientId: string, body: unknown): CimdResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'not-json' }
  }
  const doc = body as Record<string, unknown>
  if (doc.client_id !== clientId) {
    return { ok: false, reason: 'client-id-mismatch' }
  }
  const uris = doc.redirect_uris
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > 10 ||
    !uris.every(
      (uri) => typeof uri === 'string' && redirectAllowed(uri, clientId),
    )
  ) {
    return { ok: false, reason: 'redirect-uris-invalid' }
  }
  const name =
    typeof doc.client_name === 'string' && doc.client_name.trim()
      ? doc.client_name.trim().slice(0, 120)
      : redirectLabel(clientId)
  const httpsOrNull = (value: unknown) =>
    typeof value === 'string' &&
    value.startsWith('https://') &&
    value.length <= 2000
      ? value
      : null
  return {
    ok: true,
    document: {
      clientId,
      name,
      redirectUris: uris as string[],
      clientUri: httpsOrNull(doc.client_uri),
      logoUri: httpsOrNull(doc.logo_uri),
    },
  }
}

const cache = new Map<string, { result: CimdResult; expiresAt: number }>()

/**
 * Fetches and validates a client metadata document. `guard` exists for the
 * regression tests (a stand-in resolver and loopback server); production
 * callers never pass it.
 */
export async function fetchClientMetadata(
  clientId: string,
  guard: GuardOptions & { skipCache?: boolean } = {},
): Promise<CimdResult> {
  if (!isCimdClientId(clientId)) return { ok: false, reason: 'not-a-cimd-url' }

  const now = Date.now()
  const cached = guard.skipCache ? undefined : cache.get(clientId)
  if (cached && cached.expiresAt > now) return cached.result

  let result: CimdResult
  try {
    const response = await guardedFetch(clientId, {
      ...guard,
      headers: { accept: 'application/json' },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_BYTES,
    })
    if (response.status < 200 || response.status >= 300) {
      result = { ok: false, reason: 'unreachable' }
    } else {
      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder().decode(response.body))
      } catch {
        parsed = undefined
      }
      result =
        parsed === undefined
          ? { ok: false, reason: 'not-json' }
          : validate(clientId, parsed)
    }
  } catch (error) {
    result = {
      ok: false,
      reason:
        error instanceof GuardedFetchError
          ? error.reason === 'not-public' ||
            error.reason === 'credentials' ||
            error.reason === 'port' ||
            error.reason === 'not-http'
            ? 'not-public'
            : error.reason === 'too-large'
              ? 'too-large'
              : 'unreachable'
          : 'unreachable',
    }
  }

  // Failures are cached too, briefly — otherwise a dead client_id turns every
  // authorization attempt into an outbound fetch aimed at whoever owns it.
  cache.set(clientId, {
    result,
    expiresAt: now + (result.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
  })
  return result
}

export const CIMD_FAILURE_TEXT: Record<CimdFailure, string> = {
  'not-a-cimd-url': 'The client id is not a metadata document URL.',
  'not-public': 'The client metadata document is not on a public address.',
  unreachable: 'The client metadata document could not be fetched.',
  'too-large': 'The client metadata document is too large.',
  'not-json': 'The client metadata document is not valid JSON.',
  'client-id-mismatch':
    'The client metadata document names a different client_id than its URL.',
  'redirect-uris-invalid':
    'The client metadata document lists redirect URIs HQ will not send codes to.',
}
