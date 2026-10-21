#!/usr/bin/env bun
/**
 * OAuth end-to-end: a real MCP client's whole journey against a RUNNING HQ
 * (authorization server) and a RUNNING apps/hq-mcp (resource server), sharing a
 * LOCAL Postgres. Nothing is mocked; the only shortcut is minting the owner's
 * HQ session row directly instead of typing a password.
 *
 *   # HQ with OAUTH_ISSUER + MCP_RESOURCE_URLS, MCP with MCP_PUBLIC_URL, same DB
 *   E2E_HQ_URL=http://localhost:18990 E2E_MCP_URL=http://localhost:18991/mcp \
 *   E2E_USER_EMAIL=e2e@hq.local DATABASE_URL=postgres://…@127.0.0.1:…/hq \
 *     bun --env-file=/dev/null run apps/hq-mcp/test/oauth-e2e.ts
 *
 * Refuses to run against a non-local database: it writes sessions and grants.
 * Set E2E_SKIP_NETWORK=1 to skip the Client ID Metadata Document leg (which
 * makes HQ fetch Claude Code's public metadata document from claude.ai).
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { createDbHandle } from '@theiceji/hq-db'
import { ALL_SCOPES } from '@theiceji/hq-db/access'
import { catalog } from '@theiceji/mcp-kernel/catalog'
import { MODULE_WORKSPACES } from '../src/modules'

const HQ = process.env.E2E_HQ_URL ?? 'http://localhost:8990'
const MCP = process.env.E2E_MCP_URL ?? 'http://localhost:8991/mcp'
const EMAIL = process.env.E2E_USER_EMAIL
const DATABASE_URL = process.env.DATABASE_URL ?? ''

if (!EMAIL) throw new Error('Set E2E_USER_EMAIL to an existing HQ user.')
if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(DATABASE_URL)) {
  console.error('refusing: DATABASE_URL must point at a local database')
  process.exit(1)
}

let failures = 0
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

/*
 * The consent the owner is asked for, and what they give: two of the Market
 * module's three scopes, withholding `market:operate` — so the step-up check
 * has a real tool to be refused (`market_dispatch`) and a union to name.
 * Written in canonical order, which is how HQ echoes scopes back.
 */
const REQUESTED = 'market:read market:write market:operate'
const GRANTED = ['market:read', 'market:write']
const WITHHELD_TOOL = 'market_dispatch'

/** The wire names a grant of exactly `scopes` should list. */
const toolsFor = (scopes: readonly string[]): string[] =>
  catalog(MODULE_WORKSPACES)
    .filter((entry) => scopes.includes(entry.tool.scope))
    .map((entry) => entry.wireName)
const grantedTools = toolsFor(GRANTED)
const everyTool = catalog(MODULE_WORKSPACES).length

const database = createDbHandle(DATABASE_URL, { max: 2 })
const base64url = (bytes: Buffer) => bytes.toString('base64url')
const pkce = () => {
  const verifier = base64url(randomBytes(48))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}
const form = (entries: [string, string][]) => new URLSearchParams(entries)

const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
const mcpPost = (body: unknown, token?: string) =>
  fetch(MCP, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

async function mcpTools(token: string): Promise<string[]> {
  const client = new Client({ name: 'oauth-e2e', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  const { tools } = await client.listTools()
  await client.close()
  return tools.map((tool) => tool.name)
}

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  scope?: string
  error?: string
}

// ── 1 · discovery, exactly as a client does it ───────────────────────────
const unauthenticated = await mcpPost(toolsList)
const challenge = unauthenticated.headers.get('www-authenticate') ?? ''
const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1]
check(
  'MCP answers 401 with resource_metadata',
  unauthenticated.status === 401 && !!metadataUrl,
  challenge,
)

const prm = (await (await fetch(metadataUrl as string)).json()) as {
  resource: string
  authorization_servers: string[]
}
check(
  'protected-resource metadata names this resource',
  prm.resource === MCP,
  prm.resource,
)
const issuer = prm.authorization_servers[0] as string
check(
  '…and HQ as its authorization server',
  issuer === new URL(HQ).origin,
  issuer,
)

const as = (await (
  await fetch(`${issuer}/.well-known/oauth-authorization-server`)
).json()) as Record<string, unknown>
check(
  'AS metadata: issuer, S256, CIMD + none, offline_access, iss param',
  as.issuer === issuer &&
    (as.code_challenge_methods_supported as string[]).includes('S256') &&
    as.client_id_metadata_document_supported === true &&
    (as.token_endpoint_auth_methods_supported as string[]).includes('none') &&
    (as.scopes_supported as string[]).includes('offline_access') &&
    as.authorization_response_iss_parameter_supported === true,
)
const endpoints = {
  authorize: as.authorization_endpoint as string,
  token: as.token_endpoint as string,
  register: as.registration_endpoint as string,
  revoke: as.revocation_endpoint as string,
  consent: `${issuer}/api/oauth/authorize`,
}

// ── 2 · dynamic client registration ──────────────────────────────────────
const registration = await fetch(endpoints.register, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'E2E Agent',
    redirect_uris: ['http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }),
})
const registered = (await registration.json()) as { client_id?: string }
const clientId = registered.client_id ?? ''
check(
  'DCR → 201 with an hqc_ client id',
  registration.status === 201 && clientId.startsWith('hqc_'),
  clientId,
)

const badRegistration = await fetch(endpoints.register, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ redirect_uris: ['http://evil.example/callback'] }),
})
check(
  'DCR refuses a plain-http non-loopback redirect',
  badRegistration.status === 400,
)

// ── 3 · the owner, signed in ─────────────────────────────────────────────
const [owner] = await database.sql<{ id: string }[]>`
  select id from users where lower(email) = ${EMAIL.toLowerCase()} limit 1`
if (!owner) throw new Error(`no HQ user ${EMAIL}`)
const sessionToken = base64url(randomBytes(32))
const sessionId = createHash('sha256').update(sessionToken).digest('hex')
await database.sql`
  insert into sessions (id, user_id, expires_at)
  values (${sessionId}, ${owner.id}, ${new Date(Date.now() + 60 * 60 * 1000).toISOString()})`
const cookie = `horizon_session=${sessionToken}`

// ── 4 · authorization request → consent ──────────────────────────────────
const { verifier, challenge: codeChallenge } = pkce()
const redirectUri = 'http://127.0.0.1:43123/callback' // port ≠ registered: loopback rule
const authorizeUrl = (overrides: Record<string, string> = {}) => {
  const url = new URL(endpoints.authorize)
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: 'e2e-state',
    scope: `${REQUESTED} offline_access`,
    resource: MCP,
    ...overrides,
  }
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value)
  return url
}

const signedOut = await fetch(authorizeUrl(), { redirect: 'manual' })
check(
  'signed out → bounced to /login with the request preserved',
  [302, 303, 307].includes(signedOut.status) &&
    (signedOut.headers.get('location') ?? '').includes(
      '/login?next=%2Foauth%2Fauthorize',
    ),
  signedOut.headers.get('location') ?? '',
)

const consent = await fetch(authorizeUrl(), {
  headers: { cookie },
  redirect: 'manual',
})
const consentHtml = await consent.text()
check(
  'consent screen renders for the signed-in owner',
  consent.status === 200 &&
    consentHtml.includes('E2E Agent') &&
    consentHtml.includes('CONNECTION REQUEST'),
  String(consent.status),
)
check(
  'consent screen cannot be framed',
  consent.headers.get('x-frame-options') === 'DENY',
)

const wrongResource = await fetch(
  authorizeUrl({ resource: 'https://evil.example/mcp' }),
  {
    headers: { cookie },
    redirect: 'manual',
  },
)
const wrongResourceLocation = wrongResource.headers.get('location') ?? ''
check(
  'unknown resource → redirected back with invalid_target',
  wrongResourceLocation.startsWith(redirectUri) &&
    wrongResourceLocation.includes('error=invalid_target'),
  wrongResourceLocation,
)

const wrongRedirect = await fetch(
  authorizeUrl({ redirect_uri: 'https://evil.example/callback' }),
  {
    headers: { cookie },
    redirect: 'manual',
  },
)
const wrongRedirectHtml = await wrongRedirect.text()
check(
  'unregistered redirect_uri → shown, never redirected',
  wrongRedirect.status === 200 &&
    wrongRedirectHtml.includes('Unrecognised return address'),
)

const decision = (entries: [string, string][]) =>
  form([
    ['client_id', clientId],
    ['redirect_uri', redirectUri],
    ['state', 'e2e-state'],
    ['response_type', 'code'],
    ['code_challenge', codeChallenge],
    ['code_challenge_method', 'S256'],
    ['resource', MCP],
    ['requested_scope', REQUESTED],
    ...entries,
  ])

const forged = await fetch(endpoints.consent, {
  method: 'POST',
  headers: { cookie, origin: 'https://evil.example' },
  body: decision([
    ['decision', 'allow'],
    ['scope', 'market:read'],
  ]),
  redirect: 'manual',
})
check('consent POST from another origin → 403', forged.status === 403)

const denied = await fetch(endpoints.consent, {
  method: 'POST',
  headers: { cookie, origin: issuer },
  body: decision([['decision', 'deny']]),
  redirect: 'manual',
})
check(
  'deny → access_denied back to the client, with iss',
  (denied.headers.get('location') ?? '').includes('error=access_denied') &&
    (denied.headers.get('location') ?? '').includes('iss='),
)

// Grant less than asked: read + write, no operate.
const approved = await fetch(endpoints.consent, {
  method: 'POST',
  headers: { cookie, origin: issuer },
  body: decision([
    ['decision', 'allow'],
    ...GRANTED.map((scope): [string, string] => ['scope', scope]),
  ]),
  redirect: 'manual',
})
const callback = new URL(approved.headers.get('location') ?? 'about:blank')
const code = callback.searchParams.get('code') ?? ''
check(
  'allow → 303 to the callback with code, state and iss',
  approved.status === 303 &&
    `${callback.origin}${callback.pathname}` === redirectUri &&
    callback.searchParams.get('state') === 'e2e-state' &&
    callback.searchParams.get('iss') === issuer &&
    code.startsWith('hq_ac_'),
  callback.href.replace(/code=[^&]+/, 'code=…'),
)

// ── 5 · token exchange ───────────────────────────────────────────────────
const token = async (entries: [string, string][]) => {
  const response = await fetch(endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(entries),
  })
  return {
    status: response.status,
    body: (await response.json()) as TokenResponse,
  }
}
const exchange = (codeVerifier: string) =>
  token([
    ['grant_type', 'authorization_code'],
    ['code', code],
    ['client_id', clientId],
    ['redirect_uri', redirectUri],
    ['code_verifier', codeVerifier],
    ['resource', MCP],
  ])

const wrongVerifier = await exchange(base64url(randomBytes(48)))
check(
  'wrong code_verifier → invalid_grant',
  wrongVerifier.body.error === 'invalid_grant',
)

const issued = await exchange(verifier)
check(
  'code + verifier → tokens scoped to what was granted',
  issued.status === 200 &&
    !!issued.body.access_token?.startsWith('hq_at_') &&
    !!issued.body.refresh_token?.startsWith('hq_rt_') &&
    issued.body.scope === GRANTED.join(' '),
  issued.body.scope ?? JSON.stringify(issued.body),
)
const access = issued.body.access_token ?? ''
const refresh = issued.body.refresh_token ?? ''

// ── 6 · the MCP server honours exactly that grant ───────────────────────
const tools = await mcpTools(access)
check(
  `MCP lists exactly the ${grantedTools.length} read + write tools, no operate tools`,
  tools.length === grantedTools.length &&
    tools.every((name) => grantedTools.includes(name)) &&
    !tools.includes(WITHHELD_TOOL),
  tools.join(', '),
)
const stepUp = await mcpPost(
  {
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: {
      name: WITHHELD_TOOL,
      arguments: { listing_id: 'x', idempotency_key: 'x' },
    },
  },
  access,
)
check(
  `calling ${WITHHELD_TOOL} → 403 insufficient_scope naming the union`,
  stepUp.status === 403 &&
    (stepUp.headers.get('www-authenticate') ?? '').includes(
      `scope="${REQUESTED}"`,
    ),
)

// ── 7 · refresh rotation ─────────────────────────────────────────────────
const refreshWith = (value: string) =>
  token([
    ['grant_type', 'refresh_token'],
    ['refresh_token', value],
    ['client_id', clientId],
    ['resource', MCP],
  ])
const rotated = await refreshWith(refresh)
check(
  'refresh → a new token pair',
  rotated.status === 200 &&
    !!rotated.body.access_token &&
    rotated.body.refresh_token !== refresh,
)
const raced = await refreshWith(refresh)
check(
  'the superseded refresh token is refused',
  raced.body.error === 'invalid_grant',
)
check(
  '…inside the grace window the connection survives',
  (await mcpTools(rotated.body.access_token ?? '')).length ===
    grantedTools.length,
)

// ── 8 · a replayed code revokes what it created ─────────────────────────
const replay = await exchange(verifier)
check(
  'replayed authorization code → invalid_grant',
  replay.body.error === 'invalid_grant',
)
const afterReplay = await mcpPost(toolsList, rotated.body.access_token)
check(
  '…and the connection it created is revoked at the MCP server',
  afterReplay.status === 401 &&
    (afterReplay.headers.get('www-authenticate') ?? '').includes('revoked'),
)

// ── 9 · Client ID Metadata Document (Claude Code's real document) ───────
if (!process.env.E2E_SKIP_NETWORK) {
  const cimdClient = 'https://claude.ai/oauth/claude-code-client-metadata'
  const cimdRedirect = 'http://localhost:51234/callback'
  const cimd = pkce()
  const url = authorizeUrl({
    client_id: cimdClient,
    redirect_uri: cimdRedirect,
    code_challenge: cimd.challenge,
    scope: ALL_SCOPES.join(' '),
  })
  url.searchParams.delete('resource') // some clients omit it → HQ's default
  const cimdConsent = await fetch(url, {
    headers: { cookie },
    redirect: 'manual',
  })
  const cimdHtml = await cimdConsent.text()
  check(
    'CIMD client (Claude Code) → consent names claude.ai',
    cimdConsent.status === 200 && cimdHtml.includes('claude.ai'),
    String(cimdConsent.status),
  )
  const cimdApproved = await fetch(endpoints.consent, {
    method: 'POST',
    headers: { cookie, origin: issuer },
    body: form([
      ['client_id', cimdClient],
      ['redirect_uri', cimdRedirect],
      ['state', 'e2e-state'],
      ['response_type', 'code'],
      ['code_challenge', cimd.challenge],
      ['code_challenge_method', 'S256'],
      ['requested_scope', ALL_SCOPES.join(' ')],
      ['decision', 'allow'],
      ...ALL_SCOPES.map((scope): [string, string] => ['scope', scope]),
    ]),
    redirect: 'manual',
  })
  const cimdCode =
    new URL(
      cimdApproved.headers.get('location') ?? 'about:blank',
    ).searchParams.get('code') ?? ''
  const cimdTokens = await token([
    ['grant_type', 'authorization_code'],
    ['code', cimdCode],
    ['client_id', cimdClient],
    ['redirect_uri', cimdRedirect],
    ['code_verifier', cimd.verifier],
  ])
  check(
    'CIMD client exchanges its code',
    cimdTokens.status === 200,
    cimdTokens.body.scope ?? cimdTokens.body.error,
  )
  check(
    `…and, granted every scope, sees all ${everyTool} tools`,
    (await mcpTools(cimdTokens.body.access_token ?? '')).length === everyTool,
  )

  const revoked = await fetch(endpoints.revoke, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form([['token', cimdTokens.body.refresh_token ?? '']]),
  })
  const afterRevoke = await mcpPost(toolsList, cimdTokens.body.access_token)
  check(
    'RFC 7009 revocation → 200, then the MCP server refuses the connection',
    revoked.status === 200 && afterRevoke.status === 401,
  )
}

// ── cleanup ──────────────────────────────────────────────────────────────
await database.sql`delete from sessions where id = ${sessionId}`
await database.sql.end({ timeout: 5 })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
