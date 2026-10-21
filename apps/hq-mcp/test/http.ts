#!/usr/bin/env bun
/**
 * HTTP gate smoke: boots the real fetch handler on a random local port with an
 * in-memory token table — no database, no writes — and checks every
 * refusal a connector depends on: protected-resource metadata, the 401
 * challenge, revocation, scope-filtered tool lists, step-up 403 and the Origin
 * allowlist.
 *
 *   bun run --cwd apps/hq-mcp test:http
 */
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import {
  type AccessCheck,
  ALL_SCOPES,
  looksLikeBearer,
  type Scope,
} from '@theiceji/hq-db/access'
import { catalog } from '@theiceji/mcp-kernel/catalog'
import { createLogger } from '@theiceji/mcp-kernel/log'
import {
  BUDGETS,
  clientAddress,
  createFetchHandler,
} from '@theiceji/mcp-kernel/server'
import { IDENTITY } from '../src/identity'
import { fromGrantCheck, type HqCaller, type ToolContext } from '../src/kernel'
import { MODULE_WORKSPACES } from '../src/modules'

const FULL = `hq_at_${'a'.repeat(43)}`
const READ_ONLY = `hq_pat_${'b'.repeat(43)}`
const REVOKED = `hq_at_${'c'.repeat(43)}`
const HQ_READER = `hq_pat_${'d'.repeat(43)}`
const AUTHORIZATION_SERVER = 'https://hq.example.test'

let failures = 0
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

const granted = (
  label: string,
  kind: 'oauth' | 'personal',
  scopes: readonly Scope[],
): AccessCheck => ({
  ok: true,
  grant: {
    grantId: label,
    userId: 'user-1',
    userRole: 'admin',
    kind,
    actorType: 'agent',
    clientId: kind === 'oauth' ? 'hqc_test' : null,
    label,
    scopes: [...scopes],
    resource: 'ignored-by-the-fake',
    expiresAt: null,
  },
})

const table = new Map<string, AccessCheck>([
  [FULL, granted('full', 'oauth', ALL_SCOPES)],
  [READ_ONLY, granted('reader', 'personal', ['market:read'])],
  [REVOKED, { ok: false, reason: 'revoked' }],
  [HQ_READER, granted('hq-reader', 'personal', ['hq:read'])],
])
/** The fake token table, answered the way src/index.ts answers the real one. */
const lookUp = async (token: string) =>
  fromGrantCheck(table.get(token) ?? { ok: false, reason: 'unknown' })

/**
 * HQ's side of every gate below — its vocabulary, its token shape, its
 * workspaces and the context its tools receive — with no database behind it.
 */
const hq = (scope: string) => {
  const log = createLogger(scope, { stdio: true })
  return {
    identity: IDENTITY,
    scopes: ALL_SCOPES,
    looksLikeBearer,
    context: (caller: HqCaller): ToolContext => ({ caller, db: null, log }),
    workspaces: MODULE_WORKSPACES,
    log,
  }
}

let service: ReturnType<typeof createFetchHandler> | undefined
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (request) =>
    service?.fetch(request) ?? new Response('booting', { status: 503 }),
})
const base = `http://127.0.0.1:${server.port}`
const publicUrl = `${base}/mcp`

service = createFetchHandler({
  ...hq('http-smoke'),
  config: {
    MCP_PUBLIC_URL: publicUrl,
    MCP_AUTHORIZATION_SERVER: AUTHORIZATION_SERVER,
    MCP_ALLOWED_ORIGIN_HOSTS: [],
  },
  verify: lookUp,
})

const rpc = (
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(publicUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })

// ── open surfaces ──────────────────────────────────────────────────────────
const health = await fetch(`${base}/healthz`)
check('GET /healthz → 200', health.status === 200)

/** The scopes this server's own tools name — never the whole HQ vocabulary. */
const OWN_SCOPES = new Set<string>(
  catalog(MODULE_WORKSPACES).map((entry) => entry.tool.scope),
)

for (const path of [
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-protected-resource',
]) {
  const response = await fetch(`${base}${path}`)
  const doc = (await response.json()) as Record<string, unknown>
  const scopes = (doc.scopes_supported as string[]) ?? []
  check(
    `metadata at ${path}`,
    response.status === 200 &&
      doc.resource === publicUrl &&
      (doc.authorization_servers as string[])?.[0] === AUTHORIZATION_SERVER &&
      scopes.length === OWN_SCOPES.size &&
      scopes.every((scope) => OWN_SCOPES.has(scope)),
    JSON.stringify(doc.scopes_supported),
  )
}

// ── refusals ───────────────────────────────────────────────────────────────
const ping = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

const anonymous = await rpc(ping)
const anonymousChallenge = anonymous.headers.get('www-authenticate') ?? ''
const askedFor = (/scope="([^"]*)"/.exec(anonymousChallenge)?.[1] ?? '').split(
  ' ',
)
check(
  'no token → 401 with resource_metadata + scope',
  anonymous.status === 401 &&
    anonymousChallenge.includes(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    ) &&
    anonymousChallenge.includes('market:operate') &&
    anonymousChallenge.includes('agents:operate') &&
    // Exactly the scopes this server's tools name, nothing else.
    askedFor.length === OWN_SCOPES.size &&
    askedFor.every((scope) => OWN_SCOPES.has(scope)) &&
    !anonymousChallenge.includes('error='),
  anonymousChallenge,
)

const junk = await rpc(ping, { authorization: 'Bearer not-an-hq-token' })
const junkChallenge = junk.headers.get('www-authenticate') ?? ''
check(
  'junk token → 401 invalid_token, naming this server',
  junk.status === 401 &&
    junkChallenge.includes('error="invalid_token"') &&
    junkChallenge.includes('That is not a TheIceJi HQ access token.'),
  junkChallenge,
)

const revoked = await rpc(ping, { authorization: `Bearer ${REVOKED}` })
check(
  'revoked token → 401 invalid_token',
  revoked.status === 401 &&
    (revoked.headers.get('www-authenticate') ?? '').includes(
      'This TheIceJi HQ connection was revoked.',
    ),
  revoked.headers.get('www-authenticate') ?? '',
)

const foreignOrigin = await rpc(ping, {
  authorization: `Bearer ${FULL}`,
  origin: 'https://evil.example',
})
check('foreign Origin → 403', foreignOrigin.status === 403)

const wrongMethod = await fetch(publicUrl, { method: 'GET' })
check('GET on the endpoint → 405', wrongMethod.status === 405)

const stepUp = await rpc(
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'market_dispatch',
      arguments: { listing_id: 'x', idempotency_key: 'x' },
    },
  },
  { authorization: `Bearer ${READ_ONLY}` },
)
const stepUpChallenge = stepUp.headers.get('www-authenticate') ?? ''
check(
  'read-only token calling market_dispatch → 403 insufficient_scope',
  stepUp.status === 403 &&
    stepUpChallenge.includes('error="insufficient_scope"') &&
    stepUpChallenge.includes('scope="market:read market:operate"'),
  stepUpChallenge,
)

// ── the real client, through the gate ──────────────────────────────────────
async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'http-smoke', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(publicUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  return client
}

const full = await connect(FULL)
const fullTools = (await full.listTools()).tools.map((tool) => tool.name)
const everyTool = catalog(MODULE_WORKSPACES)
check(
  `full grant lists all ${everyTool.length} tools`,
  fullTools.length === everyTool.length &&
    // Only this server's own catalog — nothing registered from elsewhere.
    fullTools.every((name) =>
      everyTool.some((entry) => entry.wireName === name),
    ),
  `${fullTools.length} listed`,
)
const moduleIds = MODULE_WORKSPACES.map((workspace) => workspace.id)
check(
  'every tool is `<module>_<action>` for a module workspace, under the cap of 60',
  fullTools.length <= 60 &&
    fullTools.every((name) =>
      moduleIds.some((id) => name.startsWith(`${id}_`)),
    ),
  moduleIds.join(', '),
)

const reader = await connect(READ_ONLY)
const readerTools = (await reader.listTools()).tools.map((tool) => tool.name)
const marketReadNames = everyTool
  .filter((entry) => entry.tool.scope === 'market:read')
  .map((entry) => entry.wireName)
check(
  `market:read grant lists only its ${marketReadNames.length} tool(s)`,
  readerTools.length === marketReadNames.length &&
    readerTools.every((name) => marketReadNames.includes(name)) &&
    !readerTools.includes('market_dispatch'),
  readerTools.join(', '),
)

const hqReader = await connect(HQ_READER)
const hqReaderTools = (await hqReader.listTools()).tools.map(
  (tool) => tool.name,
)
const hqReadNames = everyTool
  .filter((entry) => entry.tool.scope === 'hq:read')
  .map((entry) => entry.wireName)
check(
  `hq:read grant lists only the ${hqReadNames.length} hq tools`,
  hqReaderTools.length === hqReadNames.length &&
    hqReaderTools.every((name) => hqReadNames.includes(name)) &&
    hqReaderTools.includes('hq_get_brief') &&
    !hqReaderTools.includes('board_list_cards'),
  hqReaderTools.join(', '),
)

/*
 * A write can be retried safely — an idempotency key, an
 * expected revision, the lease's fencing token or a dedupe key. The three
 * without one are safe by design: claiming acquires a lease (a retry just
 * claims), acknowledging twice changes nothing, and finalizing a ready asset
 * returns it unchanged.
 */
const RETRY_SAFE_BY_DESIGN = [
  'agents_claim_task',
  'agents_ack_events',
  'assets_finalize',
]
const unguardedWrites = (await full.listTools()).tools
  .filter(
    (tool) =>
      tool.annotations?.readOnlyHint !== true &&
      !RETRY_SAFE_BY_DESIGN.includes(tool.name),
  )
  .filter((tool) => {
    const properties = Object.keys(tool.inputSchema.properties ?? {})
    return ![
      'idempotency_key',
      'expected_revision',
      'fencing_token',
      'dedupe_key',
    ].some((key) => properties.includes(key))
  })
  .map((tool) => tool.name)
check(
  'every write tool takes an idempotency key, a revision, a fencing token or a dedupe key',
  unguardedWrites.length === 0,
  unguardedWrites.join(', '),
)

const noDatabase = (await hqReader.callTool({
  name: 'hq_get_brief',
  arguments: {},
})) as { isError?: boolean }
check(
  'an hq tool without a database refuses instead of throwing',
  noDatabase.isError === true,
)

const readerListings = (await reader.callTool({
  name: 'market_list_listings',
  arguments: {},
})) as { isError?: boolean }
check(
  'a market:read grant reaches its own tool (and refuses without a database)',
  readerListings.isError === true,
)

const invalidWrite = (await full.callTool({
  name: 'market_dispatch',
  arguments: { listing_id: '', idempotency_key: '' },
})) as { isError?: boolean }
check(
  'full grant reaches write validation (no write)',
  invalidWrite.isError === true,
)

await full.close()
await reader.close()
await hqReader.close()
await service.close()
server.stop(true)

// ── Liveness and readiness are different questions ───────────────────
{
  const readyzConfig = {
    MCP_PUBLIC_URL: 'https://mcp.example.test/mcp',
    MCP_AUTHORIZATION_SERVER: AUTHORIZATION_SERVER,
    MCP_ALLOWED_ORIGIN_HOSTS: [],
  }
  const noDatabase = createFetchHandler({
    ...hq('s07'),
    config: readyzConfig,
    verify: async () => ({ ok: false, reason: 'unknown' }),
  })
  const live = await noDatabase.fetch(
    new Request('https://mcp.example.test/healthz'),
  )
  const notReady = await noDatabase.fetch(
    new Request('https://mcp.example.test/readyz'),
  )
  check('/healthz stays 200 without a database', live.status === 200)
  check('/readyz is 503 without a database', notReady.status === 503)

  const withReport = (ok: boolean) =>
    createFetchHandler({
      ...hq('s07'),
      config: readyzConfig,
      verify: async () => ({ ok: false, reason: 'unknown' }),
      ready: async () => ({
        ok,
        checkedAt: new Date().toISOString(),
        checks: [
          {
            name: 'guards',
            ok,
            summary: ok
              ? '14/14 history guards active'
              : '13/14 history guards active',
            problems: ok
              ? []
              : [
                  'Missing triggers: ops_audit_events.ops_audit_events_append_only.',
                ],
          },
        ],
      }),
    })
  const ready = await withReport(true).fetch(
    new Request('https://mcp.example.test/readyz'),
  )
  const broken = await withReport(false).fetch(
    new Request('https://mcp.example.test/readyz'),
  )
  const brokenBody = await broken.text()
  check('/readyz is 200 when the inspection passes', ready.status === 200)
  check(
    'a failed check is 503 with its name, without the specifics',
    broken.status === 503 &&
      brokenBody.includes('"guards"') &&
      !brokenBody.includes('ops_audit_events'),
  )
  await noDatabase.close()
}

// ── Browser clients from an allowed Origin can read every answer ─────
{
  const gate = createFetchHandler({
    ...hq('s06'),
    config: {
      MCP_PUBLIC_URL: 'https://mcp.example.test/mcp',
      MCP_AUTHORIZATION_SERVER: AUTHORIZATION_SERVER,
      MCP_ALLOWED_ORIGIN_HOSTS: ['inspector.example.test'],
    },
    verify: lookUp,
  })
  const at = (
    method: string,
    origin: string,
    headers: Record<string, string> = {},
  ) =>
    gate.fetch(
      new Request('https://mcp.example.test/mcp', {
        method,
        headers: { origin, ...headers },
        ...(method === 'POST'
          ? {
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
              }),
            }
          : {}),
      }),
    )
  const allowed = 'https://inspector.example.test'
  const preflight = await at('OPTIONS', allowed, {
    'access-control-request-method': 'POST',
    'access-control-request-headers':
      'authorization, content-type, mcp-protocol-version',
  })
  check(
    'preflight from an allowed origin names the origin, methods and headers',
    preflight.status === 204 &&
      preflight.headers.get('access-control-allow-origin') === allowed &&
      (preflight.headers.get('access-control-allow-methods') ?? '').includes(
        'POST',
      ) &&
      (preflight.headers.get('access-control-allow-headers') ?? '').includes(
        'authorization',
      ) &&
      (preflight.headers.get('access-control-allow-headers') ?? '').includes(
        'mcp-protocol-version',
      ),
  )
  const unauthenticated = await at('POST', allowed, {
    'content-type': 'application/json',
  })
  check(
    'the 401 challenge is readable: origin allowed, WWW-Authenticate exposed',
    unauthenticated.status === 401 &&
      unauthenticated.headers.get('access-control-allow-origin') === allowed &&
      (
        unauthenticated.headers.get('access-control-expose-headers') ?? ''
      ).includes('www-authenticate'),
  )
  const success = await at('POST', allowed, {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${FULL}`,
  })
  check(
    'a successful call carries the CORS headers too',
    success.status === 200 &&
      success.headers.get('access-control-allow-origin') === allowed,
    String(success.status),
  )
  const foreign = await at('OPTIONS', 'https://evil.example.test')
  check(
    'a foreign origin is refused with no CORS grant',
    foreign.status === 403 &&
      foreign.headers.get('access-control-allow-origin') === null,
  )
  const native = await at('POST', '', { 'content-type': 'application/json' })
  check(
    'no Origin → no CORS headers',
    native.headers.get('access-control-allow-origin') === null,
  )
  await gate.close()
}

// ── Fabricated tokens can't buy a database lookup each ────────────────
{
  let lookups = 0
  const gate = createFetchHandler({
    ...hq('s01'),
    config: {
      MCP_PUBLIC_URL: 'https://mcp.example.test/mcp',
      MCP_AUTHORIZATION_SERVER: AUTHORIZATION_SERVER,
      MCP_ALLOWED_ORIGIN_HOSTS: [],
      MCP_TRUSTED_PROXY_HOPS: 0,
    },
    verify: (token) => {
      lookups++
      return lookUp(token)
    },
  })
  const post = (token: string, remoteAddress: string, forwardedFor?: string) =>
    gate.fetch(
      new Request('https://mcp.example.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      { remoteAddress },
    )
  const synthetic = (n: number) =>
    `hq_at_${n.toString(36).padStart(43, 'x').slice(-43)}`

  // The owner's real connection is in use before the flood starts.
  const before = await post(FULL, '203.0.113.7')
  check(
    'a valid token passes the gate',
    before.status !== 401 && before.status !== 429,
    String(before.status),
  )

  lookups = 0
  let limited = 0
  for (let n = 0; n < 600; n++) {
    // Rotating tokens, and a rotating X-Forwarded-For the gate must ignore.
    const response = await post(
      synthetic(n),
      '203.0.113.7',
      `10.0.${n % 250}.1`,
    )
    if (response.status === 429) limited++
  }
  check(
    `600 rotating tokens from one address → ≤ ${BUDGETS.failedLookupsPerAddress.limit} lookups, the rest 429`,
    lookups <= BUDGETS.failedLookupsPerAddress.limit &&
      limited >= 600 - BUDGETS.failedLookupsPerAddress.limit,
    `${lookups} lookups, ${limited} × 429`,
  )

  const during = await post(FULL, '203.0.113.7')
  check(
    'the recently valid token still gets through during the flood',
    during.status !== 429 && during.status !== 401,
    String(during.status),
  )

  lookups = 0
  for (let host = 1; host <= 30; host++)
    for (let n = 0; n < 20; n++)
      await post(synthetic(host * 1000 + n), `198.51.100.${host}`)
  check(
    `a flood spread over 30 addresses is capped process-wide (≤ ${BUDGETS.failedLookupsGlobal.limit} lookups)`,
    lookups > 0 && lookups <= BUDGETS.failedLookupsGlobal.limit,
    `${lookups} lookups`,
  )

  const proxied = (xff: string) =>
    clientAddress(
      new Request('https://x.test', { headers: { 'x-forwarded-for': xff } }),
      1,
      { remoteAddress: '10.0.0.2' },
    )
  check(
    'behind one trusted proxy, only the proxy-written address counts',
    proxied('1.1.1.1, 203.0.113.9') === '203.0.113.9' &&
      proxied('9.9.9.9, 203.0.113.9') === '203.0.113.9',
  )
  check(
    'with no trusted proxy, X-Forwarded-For is ignored',
    clientAddress(
      new Request('https://x.test', {
        headers: { 'x-forwarded-for': '1.1.1.1' },
      }),
      0,
      { remoteAddress: '203.0.113.5' },
    ) === '203.0.113.5',
  )
  await gate.close()
}
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
