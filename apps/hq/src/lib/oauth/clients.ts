import { constantTimeEqual, hashToken, mintToken } from '@theiceji/hq-db/access'
import { eq } from 'drizzle-orm'
import { requireDb } from '@/db'
import { CLIENT_AUTH_METHODS, type ClientAuthMethod } from '@/db/enums'
import { type OAuthClientRow, oauthClients } from '@/db/schema'
import { CIMD_FAILURE_TEXT, fetchClientMetadata, isCimdClientId } from './cimd'
import { isValidRedirectUri, redirectLabel } from './redirect'

/**
 * OAuth clients: who is asking to connect.
 *
 * Two doors, in the order MCP clients try them:
 *   · Client ID Metadata Document — `client_id` is an HTTPS URL; HQ fetches and
 *     caches it (see cimd.ts). Claude Code, ChatGPT, Hermes Agent, VS Code.
 *   · Dynamic Client Registration (RFC 7591) — `POST /oauth/register` mints an
 *     `hqc_…` id. Deprecated by MCP but still the fallback for claude.ai and
 *     many other clients.
 */

export type OAuthClient = Pick<
  OAuthClientRow,
  | 'id'
  | 'kind'
  | 'name'
  | 'redirectUris'
  | 'clientUri'
  | 'logoUri'
  | 'authMethod'
  | 'secretHash'
>

const COLUMNS = {
  id: oauthClients.id,
  kind: oauthClients.kind,
  name: oauthClients.name,
  redirectUris: oauthClients.redirectUris,
  clientUri: oauthClients.clientUri,
  logoUri: oauthClients.logoUri,
  authMethod: oauthClients.authMethod,
  secretHash: oauthClients.secretHash,
}

export type ClientLookup =
  | { ok: true; client: OAuthClient }
  | { ok: false; description: string }

/**
 * Find a client by `client_id`. For a metadata-document client, `fresh`
 * re-reads the document (the authorization request — the owner is about to be
 * shown its name); the token endpoint reuses the stored row so a refresh never
 * waits on someone else's web server.
 */
export async function resolveClient(
  clientId: string,
  options: { fresh?: boolean } = {},
): Promise<ClientLookup> {
  const db = requireDb()

  if (isCimdClientId(clientId)) {
    if (!options.fresh) {
      const [stored] = await db
        .select(COLUMNS)
        .from(oauthClients)
        .where(eq(oauthClients.id, clientId))
        .limit(1)
      if (stored) return { ok: true, client: stored }
    }
    const fetched = await fetchClientMetadata(clientId)
    if (!fetched.ok) {
      return { ok: false, description: CIMD_FAILURE_TEXT[fetched.reason] }
    }
    const { document } = fetched
    const values = {
      name: document.name,
      redirectUris: document.redirectUris,
      clientUri: document.clientUri,
      logoUri: document.logoUri,
      updatedAt: new Date(),
    }
    const [row] = await db
      .insert(oauthClients)
      .values({ id: clientId, kind: 'cimd', authMethod: 'none', ...values })
      .onConflictDoUpdate({ target: oauthClients.id, set: values })
      .returning(COLUMNS)
    return row
      ? { ok: true, client: row }
      : { ok: false, description: 'The app could not be recorded.' }
  }

  const [row] = await db
    .select(COLUMNS)
    .from(oauthClients)
    .where(eq(oauthClients.id, clientId))
    .limit(1)
  return row && row.kind === 'dcr'
    ? { ok: true, client: row }
    : {
        ok: false,
        description:
          'This app is not registered with HQ. Remove the connector and add it again so it can register.',
      }
}

/** What the consent screen and Connections page show as the app's origin. */
export function clientHost(
  client: Pick<OAuthClient, 'id' | 'kind' | 'redirectUris'>,
): string {
  if (client.kind === 'cimd') return new URL(client.id).host
  const first = client.redirectUris[0]
  return first ? redirectLabel(first) : 'unknown'
}

export function basicCredentials(
  authorization: string | null,
): { id: string; secret: string } | null {
  if (!authorization?.toLowerCase().startsWith('basic ')) return null
  try {
    const decoded = Buffer.from(
      authorization.slice(6).trim(),
      'base64',
    ).toString('utf8')
    const colon = decoded.indexOf(':')
    if (colon < 0) return null
    return {
      id: decodeURIComponent(decoded.slice(0, colon)),
      secret: decodeURIComponent(decoded.slice(colon + 1)),
    }
  } catch {
    return null
  }
}

/**
 * Client authentication at the token endpoint. Public clients (`none`) are
 * authenticated by PKCE and the redirect-URI binding instead; a client
 * assertion they send anyway (ChatGPT's metadata document advertises
 * `private_key_jwt`) is ignored rather than refused.
 */
export function authenticateClient(
  client: OAuthClient,
  params: URLSearchParams,
  authorization: string | null,
): boolean {
  if (client.authMethod === 'none' || !client.secretHash) return true
  const basic = basicCredentials(authorization)
  const secret =
    params.get('client_secret') ??
    (basic?.id === client.id ? basic.secret : null)
  return !!secret && constantTimeEqual(hashToken(secret), client.secretHash)
}

export type RegistrationResult =
  | { ok: true; body: Record<string, unknown> }
  | {
      ok: false
      error: 'invalid_redirect_uri' | 'invalid_client_metadata'
      description: string
    }

const GRANT_TYPES = ['authorization_code', 'refresh_token']

const httpsOrNull = (value: unknown): string | null =>
  typeof value === 'string' &&
  value.startsWith('https://') &&
  value.length <= 2000
    ? value
    : null

/**
 * RFC 7591 registration. Unauthenticated by protocol design and it creates
 * rows, so every field is bounded, redirect URIs are validated here and again
 * at authorization, and the id is minted by HQ — never taken from the body.
 */
export async function registerClient(
  input: unknown,
): Promise<RegistrationResult> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: 'The registration body must be a JSON object.',
    }
  }
  const body = input as Record<string, unknown>

  const redirectUris = body.redirect_uris
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > 10 ||
    new Set(redirectUris).size !== redirectUris.length ||
    !redirectUris.every(isValidRedirectUri)
  ) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description:
        'redirect_uris must list 1–10 https, loopback (http://localhost / 127.0.0.1) or native-app URIs without fragments.',
    }
  }

  const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token']
  if (
    !Array.isArray(grantTypes) ||
    !grantTypes.includes('authorization_code') ||
    !grantTypes.every((type) => GRANT_TYPES.includes(type as string))
  ) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description:
        'grant_types must include authorization_code and may add refresh_token.',
    }
  }

  const responseTypes = body.response_types ?? ['code']
  if (
    !Array.isArray(responseTypes) ||
    responseTypes.length === 0 ||
    !responseTypes.every((type) => type === 'code')
  ) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: 'response_types must be ["code"].',
    }
  }

  const authMethod = (body.token_endpoint_auth_method ?? 'none') as string
  if (!(CLIENT_AUTH_METHODS as readonly string[]).includes(authMethod)) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: `token_endpoint_auth_method must be one of ${CLIENT_AUTH_METHODS.join(', ')}.`,
    }
  }

  const name =
    typeof body.client_name === 'string' && body.client_name.trim()
      ? body.client_name.trim().slice(0, 120)
      : redirectLabel(redirectUris[0] as string)

  const id = mintToken('clientId')
  const secret = authMethod === 'none' ? null : mintToken('clientSecret')
  const now = new Date()

  await requireDb()
    .insert(oauthClients)
    .values({
      id,
      kind: 'dcr',
      name,
      redirectUris: redirectUris as string[],
      clientUri: httpsOrNull(body.client_uri),
      logoUri: httpsOrNull(body.logo_uri),
      authMethod: authMethod as ClientAuthMethod,
      secretHash: secret ? hashToken(secret) : null,
      createdAt: now,
      updatedAt: now,
    })

  return {
    ok: true,
    body: {
      client_id: id,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: authMethod,
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    },
  }
}
