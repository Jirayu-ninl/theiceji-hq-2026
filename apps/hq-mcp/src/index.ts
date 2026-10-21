#!/usr/bin/env bun
import { configureAssetStorage } from '@theiceji/hq-assets/storage'
import { createDbHandle } from '@theiceji/hq-db'
import {
  ALL_SCOPES,
  looksLikeBearer,
  touchGrant,
  verifyAccessToken,
} from '@theiceji/hq-db/access'
import {
  inspectDatabase,
  type ReadinessReport,
} from '@theiceji/hq-db/readiness'
import { configureOpsDatabase } from '@theiceji/hq-ops/db'
import { runOpsTick } from '@theiceji/hq-ops/runtime'
import { isSealingConfigured } from '@theiceji/hq-ops/secrets'
import { isStorageConfigured } from '@theiceji/hq-storage/config'
import {
  catalog,
  createFetchHandler,
  createLogger,
  errorMessage,
} from '@theiceji/mcp-kernel'
import { describeConfig, loadConfig } from './config'
import { IDENTITY } from './identity'
import { fromGrantCheck } from './kernel'
// Importing the module workspaces also imports each module's `register`, so
// its targets, readings and tick steps exist before the first tick runs.
import { MODULE_WORKSPACES } from './modules'

/**
 * TheIceJi HQ's MCP server over HTTP — config → database → handler → drain.
 *
 * The resource server half of HQ's connected apps: HQ (apps/hq) is the OAuth
 * authorization server and writes the grants; this process verifies every
 * bearer against the same Postgres and serves the tools the grant allows.
 * `Bun.serve` rather than a framework for a surface this small, and a SIGTERM
 * that drains rather than drops.
 */
const log = createLogger('hq-mcp')
const config = loadConfig()
log.info(describeConfig(config))

const database = createDbHandle(config.DATABASE_URL, {
  max: config.DATABASE_POOL_MAX,
})
// Non-fatal: an unreachable database shows up here at boot instead of on the
// first connector call, but the healthcheck still passes so logs stay reachable.
database.sql`select 1`.then(
  () => log.info('database reachable'),
  (error: unknown) =>
    log.error(`database unreachable at boot: ${errorMessage(error)}`),
)

// Module tools run HQ's own services (the ops kernel) against this same pool.
configureOpsDatabase(database.db)
// Asset URLs this process hands out (a Drive file streams through HQ's own
// /api/assets/content) must be absolute: HQ is the authorization server, so
// its origin is the one this server already trusts.
configureAssetStorage({ origin: config.MCP_AUTHORIZATION_SERVER })

/**
 * Readiness for `/readyz`, cached briefly so a monitor polling it doesn't turn
 * into a stream of catalog queries. Optional integrations that aren't set up
 * are reported as blocked capabilities, not as "not ready".
 */
const READY_CACHE_MS = 10_000
let readyCache: { at: number; report: Promise<ReadinessReport> } | null = null
function readiness(): Promise<ReadinessReport> {
  const now = Date.now()
  if (readyCache && now - readyCache.at < READY_CACHE_MS)
    return readyCache.report
  const report = inspectDatabase(database.sql).then((inspected) => {
    const blocked = [
      ...(isSealingConfigured()
        ? []
        : ['runtime delivery and provider connections (HQ_SEALING_KEY)']),
      ...(isStorageConfigured() ? [] : ['asset uploads (R2_*)']),
      ...(config.HQ_SCHEDULER_SECONDS > 0
        ? []
        : ['ops tick on this process (HQ_SCHEDULER_SECONDS=0)']),
    ]
    return {
      ...inspected,
      checks: [
        ...inspected.checks,
        {
          name: 'capabilities',
          ok: true,
          summary:
            blocked.length === 0
              ? 'all configured'
              : `${blocked.length} blocked`,
          problems: [],
          warnings: blocked.map((line) => `Blocked: ${line}.`),
        },
      ],
    }
  })
  readyCache = { at: now, report }
  return report
}

const service = createFetchHandler({
  config,
  identity: IDENTITY,
  scopes: ALL_SCOPES,
  looksLikeBearer,
  verify: async (token) =>
    fromGrantCheck(
      await verifyAccessToken(database.db, token, config.MCP_PUBLIC_URL),
    ),
  context: (caller) => ({ caller, db: database.db, log }),
  touch: (grantId) => {
    touchGrant(database.db, grantId).catch((error: unknown) =>
      log.warn(`last-used write failed: ${errorMessage(error)}`),
    )
  },
  ready: readiness,
  workspaces: MODULE_WORKSPACES,
  log,
})

const server = Bun.serve({
  port: config.PORT,
  ...(config.HOST ? { hostname: config.HOST } : {}),
  idleTimeout: 120,
  // Bun's default is 128 MiB; nothing legitimate here is close to that, and the
  // bound on the transport refuses an oversized body before it is buffered.
  maxRequestBodySize: config.MCP_MAX_REQUEST_BYTES,
  fetch: (request, bun) =>
    service
      .fetch(request, { remoteAddress: bun.requestIP(request)?.address })
      .catch((error: unknown) => {
        // A throw escaping the gate is a defect. Answer in JSON-RPC so the client
        // sees an MCP error; the detail stays in these logs.
        const incident = crypto.randomUUID()
        log.error(`unhandled (incident ${incident}): ${errorMessage(error)}`)
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32603,
              message: `Internal error. Incident ${incident}.`,
            },
          }),
          {
            status: 500,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            },
          },
        )
      }),
})

log.info(
  `listening on :${server.port} — ${catalog(MODULE_WORKSPACES).length} tools across ${MODULE_WORKSPACES.map((w) => w.id).join(', ')} at ${config.MCP_PUBLIC_URL}`,
)

/**
 * The ops tick (`@theiceji/hq-ops/runtime`), on this long-running process —
 * HQ's cron route runs the same tick. Overlap is harmless: the tick takes a
 * lease row, so HQ's cron and other replicas skip, and a tick in flight is
 * never started twice here.
 */
let ticking = false
const scheduler =
  config.HQ_SCHEDULER_SECONDS > 0
    ? setInterval(() => {
        if (ticking || draining) return
        ticking = true
        runOpsTick()
          .then((report) => {
            if (report.errors.length > 0)
              log.warn(`ops tick: ${report.errors.join(' · ')}`)
          })
          .catch((error: unknown) =>
            log.error(`ops tick failed: ${errorMessage(error)}`),
          )
          .finally(() => {
            ticking = false
          })
      }, config.HQ_SCHEDULER_SECONDS * 1000)
    : null
scheduler?.unref()

/**
 * How long the drain may take before the process stops being polite — inside
 * the platform's draining window (Railway `drainingSeconds = 15`, see
 * .railway/railway.ts) so our own exit happens before SIGKILL does.
 */
const DRAIN_HARD_EXIT_MS = 10_000

let draining = false
function drain(signal: string): void {
  if (draining) return
  draining = true
  if (scheduler) clearInterval(scheduler)
  log.info(`${signal} — draining`)
  setTimeout(() => process.exit(1), DRAIN_HARD_EXIT_MS).unref()
  void Promise.allSettled([server.stop(), service.close()])
    .then(() => database.sql.end({ timeout: 5 }))
    .finally(() => {
      log.info('closed, bye')
      process.exit(0)
    })
}

process.on('SIGTERM', () => drain('SIGTERM'))
process.on('SIGINT', () => drain('SIGINT'))
