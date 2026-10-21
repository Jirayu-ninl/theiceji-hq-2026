import { createHash } from 'node:crypto'
import {
  type AuthInfo,
  createMcpHandler,
  isJsonContentType,
  McpServer,
  originValidationResponse,
} from '@modelcontextprotocol/server'
import {
  bearerChallenge,
  type MetadataConfig,
  metadataPaths,
  metadataUrl,
  protectedResourceMetadata,
} from './auth/metadata'
import { createRateLimiter, type RateDecision } from './auth/rateLimit'
import type { BaseConfig } from './config'
import { buildServer, catalog, type ServerIdentity } from './core/catalog'
import { errorMessage } from './core/results'
import type { Caller, ScopeOf, ToolContext, Workspace } from './core/workspace'
import type { Logger } from './log'

/**
 * The HTTP surface: Streamable HTTP on one endpoint, stateless.
 *
 * The SDK's `createMcpHandler` answers the JSON-RPC protocol for both eras
 * (2026-07-28 and the 2025 stateless idiom). This file is everything that must
 * happen BEFORE a body reaches it, in this order:
 *
 * ```
 *  ·  /healthz, protected-resource metadata ................ open
 *  0. Origin allowlist (a Streamable HTTP MUST) ............ 403
 *  1. POST only ............................................ 405
 *  2. JSON body ............................................ 415
 *  3. Bearer present and shaped like this server's ......... 401 challenge
 *  4. Rate budgets, all spent before the lookup ............ 429
 *     · credential-less traffic, per client address
 *     · failed lookups, per address and process-wide
 *     · every lookup, per address and per token
 *  5. Token → caller via `verify` (never cached) ........... 401 challenge
 *  6. tools/call for a tool the caller lacks ............... 403 insufficient_scope
 *  7. Dispatch with only the caller's tools registered
 * ```
 *
 * Authentication has to be decided here and not inside a tool: a tool's
 * answer is always wrapped in a 200, and a 200 never starts an OAuth flow.
 *
 * The gate knows no database and no scope vocabulary. The server hands it
 * both halves of its own token scheme — `looksLikeBearer` (the shape, checked
 * for free) and `verify` (the lookup, which IS the revocation check) — its
 * scopes in canonical order, and `context`, which turns a verified caller into
 * whatever its tools are typed to receive.
 */

export type HttpConfig = MetadataConfig &
  Pick<BaseConfig, 'MCP_ALLOWED_ORIGIN_HOSTS'> &
  Partial<Pick<BaseConfig, 'MCP_TRUSTED_PROXY_HOPS'>>

/** What the listener knows about the connection that the request doesn't say. */
export type ConnectionInfo = { remoteAddress?: string | null }

/**
 * The client address the budgets key on. With no trusted proxy it is the
 * socket's address and `X-Forwarded-For` is ignored — a client can write any
 * header it likes. Behind `hops` proxies that each append the address they
 * saw, the entry `hops` from the right is the one the outermost trusted proxy
 * wrote; everything left of it is client-supplied.
 */
export function clientAddress(
  request: Request,
  hops: number,
  connection: ConnectionInfo = {},
): string {
  if (hops > 0) {
    const chain = (request.headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    const entry = chain[chain.length - hops]
    if (entry) return entry
  }
  return connection.remoteAddress || 'unknown'
}

/** Budgets, per replica. Exported so the regression test can reason about them. */
export const BUDGETS = {
  /** Requests with no usable bearer at all. */
  anonymousPerAddress: { limit: 60, windowMs: 60_000 },
  /**
   * Lookups of tokens that haven't verified recently — what every fabricated
   * token looks like. Charged before the query.
   */
  failedLookupsPerAddress: { limit: 20, windowMs: 60_000 },
  failedLookupsGlobal: { limit: 200, windowMs: 60_000 },
  /** Every token lookup — each one is a database query. */
  lookupsPerAddress: { limit: 900, windowMs: 60_000 },
  lookupsPerToken: { limit: 600, windowMs: 60_000 },
} as const

/**
 * How long a token that verified stays exempt from the failed-lookup
 * lockouts. It is still looked up on every request — this only decides whose
 * lookups a flood of fabricated tokens may crowd out, never who is allowed in.
 */
const RECENTLY_VALID_MS = 15 * 60_000

/** Why a well-shaped token was turned away. */
export type AccessRefusal =
  /** No such token, or not a shape this server's authorization server issues. */
  | 'unknown'
  | 'expired'
  | 'revoked'
  /** Issued for a different MCP endpoint (RFC 8707 audience). */
  | 'wrong-resource'

/**
 * What `verify` answers: the caller a token stands for, or why it doesn't
 * stand for one. `clientId` and `expiresAt` are handed on to the SDK's
 * `AuthInfo`; everything the tools need rides on `caller`.
 */
export type AccessCheck<Cl extends Caller = Caller> =
  | {
      ok: true
      caller: Cl
      /** The OAuth client; null for a personal token. */
      clientId: string | null
      /** When the presented token expires; null when it doesn't. */
      expiresAt: Date | null
    }
  | { ok: false; reason: AccessRefusal }

/**
 * One line of `/readyz`. The same shape a server's own database inspection
 * returns, so its report is handed over as is.
 */
export type ReadinessCheck = {
  name: string
  ok: boolean
  /** One line for a status page. */
  summary: string
  /** What exactly is wrong — logged, never served. */
  problems: string[]
  /** Not wrong enough to refuse traffic, but worth saying. */
  warnings?: string[]
}

export type ReadinessReport = {
  ok: boolean
  checkedAt: string
  checks: ReadinessCheck[]
}

export type ServerDeps<C extends ToolContext = ToolContext> = {
  config: HttpConfig
  /**
   * Who this server says it is: handshake name and version, the session
   * preamble, the name the owner consents to, and what a caller with no
   * usable credentials is told to do.
   */
  identity: ServerIdentity
  /**
   * The server's whole scope vocabulary, in canonical order. Every `scope=`
   * the gate writes, and `scopes_supported`, is formatted against it: known
   * scopes only, in this order, space-separated.
   */
  scopes: readonly ScopeOf<C>[]
  /**
   * Could this be a token this server's authorization server issued? Checked
   * before any budget is spent on a lookup, so it must be cheap and must not
   * touch the database — a prefix and a length.
   */
  looksLikeBearer: (token: string) => boolean
  /**
   * Token → caller. Never cached by the gate: this lookup is the revocation
   * check. Injected so the transport is testable without a database.
   */
  verify: (token: string) => Promise<AccessCheck<C['caller']>>
  /** The context the server's tools receive, built once per request. */
  context: (caller: C['caller']) => C
  /**
   * Readiness: whatever the server can't serve without — database, schema,
   * configuration. Absent in tests without one, where `/readyz` answers 503.
   */
  ready?: () => Promise<ReadinessReport>
  /** Best-effort "last used" bookkeeping; never awaited on the request path. */
  touch?: (grantId: string) => void
  workspaces: readonly Workspace<C>[]
  log: Logger
}

const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
} as const

/** Response headers a browser client must be able to read. */
const CORS_EXPOSE =
  'www-authenticate, retry-after, mcp-session-id, mcp-protocol-version'
/** Request headers a browser client may send. */
const CORS_ALLOW_HEADERS =
  'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id'

/** The metadata document is public by design — Claude fetches it from its cloud. */
const METADATA_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'public, max-age=300',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, mcp-protocol-version',
} as const

function jsonRpcError(
  code: number,
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }),
    { status, headers: { ...JSON_HEADERS, ...headers } },
  )
}

/** The tool a `tools/call` body names, or null for anything else. */
function calledTool(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const message = body as { method?: unknown; params?: { name?: unknown } }
  if (message.method !== 'tools/call') return null
  return typeof message.params?.name === 'string' ? message.params.name : null
}

function refusalText(reason: AccessRefusal, identity: ServerIdentity): string {
  switch (reason) {
    case 'unknown':
      return identity.connectPrompt
    case 'expired':
      return 'This access token expired.'
    case 'revoked':
      return `This ${identity.resourceName} connection was revoked.`
    case 'wrong-resource':
      return 'This token was issued for a different MCP endpoint.'
  }
}

/**
 * The budgets key on a digest, never on the token itself: a map of live
 * tokens in process memory is one heap dump away from a leak.
 */
function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function createFetchHandler<C extends ToolContext>(
  deps: ServerDeps<C>,
): {
  fetch: (request: Request, connection?: ConnectionInfo) => Promise<Response>
  close: () => Promise<void>
} {
  const {
    config,
    identity,
    scopes: vocabulary,
    looksLikeBearer,
    verify,
    context: contextFor,
    touch,
    workspaces,
    log,
    ready,
  } = deps
  const { connectPrompt } = identity
  /** The canonical wire form: known scopes only, vocabulary order, space-separated. */
  const formatScopes = (scopes: Iterable<string>): string => {
    const held = new Set(scopes)
    return vocabulary.filter((scope) => held.has(scope)).join(' ')
  }
  const resource = new URL(config.MCP_PUBLIC_URL)
  const endpointPath = resource.pathname.replace(/\/+$/, '') || '/'
  const paths = metadataPaths(config.MCP_PUBLIC_URL)
  const challengeUrl = metadataUrl(config.MCP_PUBLIC_URL)
  const entries = catalog(workspaces)
  /* Every scope THIS server can actually serve — its tools' and its resources'.
     Asked for on first contact, so the authorization server's consent screen
     preselects them and the owner unticks what an app shouldn't have. Never
     the whole vocabulary: a connection to one resource server must not ask
     for scopes nothing here uses — a grant is bound to one resource URL. */
  const everyScope = formatScopes([
    ...entries.map((entry) => entry.tool.scope),
    ...workspaces.flatMap((workspace) =>
      (workspace.resources ?? []).map((resource) => resource.scope),
    ),
  ])
  const metadataBody = JSON.stringify(
    protectedResourceMetadata(
      config,
      identity.resourceName,
      everyScope.split(' ').filter(Boolean),
    ),
  )
  const byWireName = new Map(entries.map((entry) => [entry.wireName, entry]))
  const hops = config.MCP_TRUSTED_PROXY_HOPS ?? 0
  const anonymousPerAddress = createRateLimiter(BUDGETS.anonymousPerAddress)
  const failedPerAddress = createRateLimiter(BUDGETS.failedLookupsPerAddress)
  const failedGlobal = createRateLimiter(BUDGETS.failedLookupsGlobal)
  const lookupsPerAddress = createRateLimiter(BUDGETS.lookupsPerAddress)
  const lookupsPerToken = createRateLimiter(BUDGETS.lookupsPerToken)
  /** Token hash → until when it counts as recently valid (budgets only). */
  const recentlyValid = new Map<string, number>()
  const isRecentlyValid = (hash: string, now: number): boolean => {
    const until = recentlyValid.get(hash)
    if (until === undefined) return false
    if (until > now) return true
    recentlyValid.delete(hash)
    return false
  }
  const rememberValid = (hash: string, now: number): void => {
    if (recentlyValid.size >= 1_000) {
      for (const [key, until] of recentlyValid)
        if (until <= now) recentlyValid.delete(key)
      if (recentlyValid.size >= 1_000) recentlyValid.clear()
    }
    recentlyValid.set(hash, now + RECENTLY_VALID_MS)
  }

  const challenge = (
    status: 401 | 403,
    scope: string,
    error?: 'invalid_token' | 'insufficient_scope',
    description?: string,
  ): Response =>
    new Response(
      JSON.stringify({
        error: error ?? 'unauthorized',
        error_description: description ?? connectPrompt,
      }),
      {
        status,
        headers: {
          ...JSON_HEADERS,
          'www-authenticate': bearerChallenge({
            error,
            description,
            scope,
            resourceMetadataUrl: challengeUrl,
          }),
        },
      },
    )

  const tooMany = (retryAfterSeconds: number): Response =>
    jsonRpcError(-32000, 'Too many requests. Slow down.', 429, {
      'retry-after': String(retryAfterSeconds),
    })

  /* One handler for the process; it builds a fresh McpServer per request via
     the factory. The caller rides in on `authInfo.extra`, and the server's own
     `context` turns it into what its tools receive. */
  const handler = createMcpHandler(
    (request) => {
      const caller = request.authInfo?.extra?.caller as C['caller'] | undefined
      if (!caller) {
        // Unreachable: nothing dispatches without a verified caller.
        log.error('mcp handler reached with no caller')
        return new McpServer(
          { name: identity.name, version: identity.version },
          { capabilities: { tools: { listChanged: false } } },
        )
      }
      return buildServer({
        context: contextFor(caller),
        workspaces,
        identity,
      })
    },
    { onerror: (error) => log.error(`mcp handler: ${error.message}`) },
  )

  const serve = async (
    request: Request,
    connection: ConnectionInfo,
  ): Promise<Response> => {
    const url = new URL(request.url)

    // Liveness. Open and unthrottled: the platform healthcheck must never be
    // limited, and it must not fail because the database is having a moment —
    // restarting the process wouldn't fix that.
    if (url.pathname === '/healthz') {
      return new Response('ok', { headers: { 'cache-control': 'no-store' } })
    }

    // Readiness: can this process actually serve tools? Check names and
    // summaries only; the specifics go to the log.
    if (url.pathname === '/readyz') {
      const budget = anonymousPerAddress.take(
        clientAddress(request, hops, connection),
      )
      if (!budget.ok) return tooMany(budget.retryAfterSeconds)
      const report: ReadinessReport = ready
        ? await ready().catch((error: unknown) => ({
            ok: false,
            checkedAt: new Date().toISOString(),
            checks: [
              {
                name: 'database',
                ok: false,
                summary: 'inspection failed',
                problems: [errorMessage(error)],
              },
            ],
          }))
        : {
            ok: false,
            checkedAt: new Date().toISOString(),
            checks: [
              {
                name: 'database',
                ok: false,
                summary: 'not configured',
                problems: [],
              },
            ],
          }
      for (const check of report.checks)
        if (!check.ok)
          log.warn(`not ready · ${check.name}: ${check.problems.join(' ')}`)
      return new Response(
        JSON.stringify({
          ok: report.ok,
          checkedAt: report.checkedAt,
          checks: report.checks.map(({ name, ok, summary, warnings }) => ({
            name,
            ok,
            summary,
            ...(warnings?.length ? { warnings } : {}),
          })),
        }),
        { status: report.ok ? 200 : 503, headers: JSON_HEADERS },
      )
    }

    if (url.pathname === paths.suffixed || url.pathname === paths.root) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: METADATA_HEADERS })
      }
      if (request.method !== 'GET') {
        return new Response(null, {
          status: 405,
          headers: { allow: 'GET, OPTIONS' },
        })
      }
      return new Response(metadataBody, { headers: METADATA_HEADERS })
    }

    if (url.pathname === '/' && endpointPath !== '/') {
      return Response.json(
        {
          name: identity.name,
          mcp: config.MCP_PUBLIC_URL,
          authorization_server: config.MCP_AUTHORIZATION_SERVER,
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    if (url.pathname.replace(/\/+$/, '') !== endpointPath.replace(/\/+$/, '')) {
      return new Response('not found', { status: 404 })
    }

    // ── 0 · Origin ────────────────────────────────────────────────────────
    const badOrigin = originValidationResponse(request, [
      ...config.MCP_ALLOWED_ORIGIN_HOSTS,
    ])
    if (badOrigin) return badOrigin

    // ── 1 · Method ────────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { allow: 'POST, OPTIONS' },
      })
    }
    if (request.method !== 'POST') {
      return jsonRpcError(-32601, 'Method not allowed.', 405, {
        allow: 'POST, OPTIONS',
      })
    }

    // ── 2 · Content type ──────────────────────────────────────────────────
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return jsonRpcError(-32700, 'Expected application/json.', 415)
    }

    // ── 3 · Bearer ────────────────────────────────────────────────────────
    const address = clientAddress(request, hops, connection)
    const token =
      /^Bearer\s+(.+)$/i
        .exec(request.headers.get('authorization') ?? '')?.[1]
        ?.trim() ?? ''

    if (!token || !looksLikeBearer(token)) {
      // ── 4a · Budget for credential-less traffic, per address ──────────
      const budget = anonymousPerAddress.take(address)
      if (!budget.ok) return tooMany(budget.retryAfterSeconds)
      return token
        ? challenge(
            401,
            everyScope,
            'invalid_token',
            `That is not a ${identity.resourceName} access token.`,
          )
        : challenge(401, everyScope)
    }

    // ── 4b · Budgets for the lookup, all spent before it ──────────────────
    // A well-formed token proves nothing until the database says so, so a
    // stream of fabricated ones must not buy a query each. A token that hasn't
    // verified recently is charged to the failed-lookup budgets up front —
    // before the query, so concurrent requests can't all slip past one check.
    // Once an address or the process runs out, only recently valid tokens are
    // still looked up (and they are still looked up: this decides whose
    // queries a flood can crowd out, never who gets in).
    const now = Date.now()
    const tokenHash = digest(token)
    // One at a time, narrowest first: a request refused by its own address's
    // budget must not also spend the process-wide one, or a single address
    // could lock everyone else's new tokens out.
    const budgets: (() => RateDecision)[] = [
      ...(isRecentlyValid(tokenHash, now)
        ? []
        : [
            () => failedPerAddress.take(address, now),
            () => failedGlobal.take('*', now),
          ]),
      () => lookupsPerAddress.take(address, now),
      () => lookupsPerToken.take(tokenHash, now),
    ]
    for (const spend of budgets) {
      const decision = spend()
      if (!decision.ok) return tooMany(decision.retryAfterSeconds)
    }

    // ── 5 · The caller. Never cached: this lookup IS the revocation check. ─
    let check: AccessCheck<C['caller']>
    try {
      check = await verify(token)
    } catch (error) {
      /* 503, not 401: a database hiccup must not send the owner through
         OAuth again for a connection that is perfectly valid. */
      log.error(`token check failed: ${errorMessage(error)}`)
      return jsonRpcError(
        -32603,
        `${identity.resourceName} could not check this connection right now. Try again shortly.`,
        503,
        { 'retry-after': '5' },
      )
    }
    if (!check.ok) {
      recentlyValid.delete(tokenHash)
      if (check.reason === 'wrong-resource') {
        log.warn('a token issued for a different resource was presented')
      }
      return challenge(
        401,
        everyScope,
        'invalid_token',
        refusalText(check.reason, identity),
      )
    }
    const { caller } = check
    const held: ReadonlySet<string> = caller.scopes
    rememberValid(tokenHash, now)

    /* Read here because step 6 needs it, then handed to the SDK as
       `parsedBody` so the stream isn't read twice. */
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(await request.text())
    } catch {
      return jsonRpcError(-32700, 'Parse error.', 400)
    }

    // ── 6 · Step-up ───────────────────────────────────────────────────────
    const wireName = calledTool(parsedBody)
    const entry = wireName ? byWireName.get(wireName) : undefined
    if (entry && !held.has(entry.tool.scope)) {
      log.info(
        `step-up · ${caller.label} lacks ${entry.tool.scope} for ${wireName}`,
      )
      return challenge(
        403,
        formatScopes([...held, entry.tool.scope]),
        'insufficient_scope',
        `${entry.tool.title} needs the ${entry.tool.scope} permission.`,
      )
    }

    // ── 7 · Dispatch ──────────────────────────────────────────────────────
    if (caller.grantId) touch?.(caller.grantId)
    const authInfo: AuthInfo = {
      token,
      clientId: check.clientId ?? caller.grantId ?? caller.label,
      scopes: [...held],
      ...(check.expiresAt
        ? { expiresAt: Math.floor(check.expiresAt.getTime() / 1000) }
        : {}),
      resource,
      extra: { caller },
    }
    return handler.fetch(request, { authInfo, parsedBody })
  }

  /* Browser clients (S06). Only for the endpoint, only for an Origin the
     allowlist accepted: every answer — preflight, 401 challenge, 403 step-up,
     429, tool results — carries the headers a browser needs to read it,
     `WWW-Authenticate` included, or the OAuth flow can't start. Clients that
     send no Origin (Claude, ChatGPT, agents) get none of this. */
  const allowedOrigin = (request: Request): string | null => {
    const origin = request.headers.get('origin')
    if (!origin || config.MCP_ALLOWED_ORIGIN_HOSTS.length === 0) return null
    const path = new URL(request.url).pathname.replace(/\/+$/, '')
    if (path !== endpointPath.replace(/\/+$/, '')) return null
    return originValidationResponse(request, [
      ...config.MCP_ALLOWED_ORIGIN_HOSTS,
    ])
      ? null
      : origin
  }

  const fetch = async (
    request: Request,
    connection: ConnectionInfo = {},
  ): Promise<Response> => {
    const origin = allowedOrigin(request)
    const response = await serve(request, connection)
    if (!origin) return response
    const withCors = new Response(response.body, response)
    withCors.headers.set('access-control-allow-origin', origin)
    withCors.headers.append('vary', 'Origin')
    withCors.headers.set('access-control-expose-headers', CORS_EXPOSE)
    if (request.method === 'OPTIONS') {
      withCors.headers.set('access-control-allow-methods', 'POST, OPTIONS')
      withCors.headers.set('access-control-allow-headers', CORS_ALLOW_HEADERS)
      withCors.headers.set('access-control-max-age', '600')
    }
    return withCors
  }

  return { fetch, close: () => handler.close() }
}
