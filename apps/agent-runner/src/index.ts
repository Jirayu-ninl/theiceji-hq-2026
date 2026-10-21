#!/usr/bin/env bun
import { createDbHandle } from '@theiceji/hq-db'
import { verifyAccessToken } from '@theiceji/hq-db/access'
import { configureOpsDatabase } from '@theiceji/hq-ops/db'
import { isSealingConfigured } from '@theiceji/hq-ops/secrets'
import { createLogger, loadLocalEnv } from '@theiceji/mcp-kernel'
import { callerFromGrant, type ToolContext } from 'hq-mcp/src/kernel'
import { opsActorFor } from 'hq-mcp/src/modules/support'
import { runOnce } from './run'

/**
 * HQ's builtin agent runner (runner = `builtin`).
 *
 *   bun run apps/agent-runner/src/index.ts          # keep polling
 *   bun run apps/agent-runner/src/index.ts --once   # one run, then exit
 *
 * Runs on the owner's machine, beside the worker — a run can take minutes,
 * longer than a Vercel function lives. It works as one of the owner's agent
 * connections: the personal token in HQ_RUNNER_TOKEN (minted in HQ →
 * Settings → Connections, acting as an agent, with `agents:operate` and the
 * module scopes its routines need), checked like any MCP call and held to
 * the same operating policy. It reads the owner's LLM key from HQ, so it
 * needs HQ's database and sealing key — the same env as apps/hq-mcp.
 *
 * Env: DATABASE_URL · HQ_SEALING_KEY (or CREATOR_SEALING_KEY) ·
 * HQ_RUNNER_TOKEN · HQ_MCP_URL (the MCP endpoint the token was issued for) ·
 * RUNNER_POLL_SECONDS (60) · RUNNER_LEASE_SECONDS (900).
 */

loadLocalEnv(new URL('../.env', import.meta.url))
const logger = createLogger('agent-runner')
const log = (message: string) => logger.info(message)

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    logger.error(`${name} is not set.`)
    process.exit(1)
  }
  return value
}

const databaseUrl = required('DATABASE_URL')
const token = required('HQ_RUNNER_TOKEN')
const resource = required('HQ_MCP_URL')
if (!isSealingConfigured()) {
  logger.error('HQ_SEALING_KEY is not set — the runner can’t read LLM keys.')
  process.exit(1)
}
const once = process.argv.includes('--once')
const pollSeconds = Number(process.env.RUNNER_POLL_SECONDS ?? '60')
const leaseSeconds = Number(process.env.RUNNER_LEASE_SECONDS ?? '900')

const handle = createDbHandle(databaseUrl, { max: 4 })
configureOpsDatabase(handle.db)

async function connect(): Promise<{
  context: ToolContext
  actor: NonNullable<ReturnType<typeof opsActorFor>>
}> {
  const check = await verifyAccessToken(handle.db, token, resource)
  if (!check.ok) {
    logger.error(`HQ_RUNNER_TOKEN was refused (${check.reason}).`)
    process.exit(1)
  }
  if (check.grant.actorType !== 'agent') {
    logger.error('HQ_RUNNER_TOKEN must act as an agent, not a worker.')
    process.exit(1)
  }
  const context: ToolContext = {
    caller: callerFromGrant(check.grant),
    db: handle.db,
    log: logger,
  }
  const actor = opsActorFor(context)
  if (!actor) {
    logger.error('The token has no HQ user behind it.')
    process.exit(1)
  }
  return { context, actor }
}

let stopping = false
process.on('SIGINT', () => {
  stopping = true
})
process.on('SIGTERM', () => {
  stopping = true
})

do {
  // Checked every round: a revoked token stops the runner on its next poll.
  const { context, actor } = await connect()
  const report = await runOnce({ actor, context, log, leaseSeconds })
  if (report.ran)
    log(
      `run ${report.runId}: ${report.outcome} after ${report.turns} turn(s) — ${report.summary.slice(0, 200)}`,
    )
  else if (report.skipped.length)
    log(`nothing to run (${report.skipped.join(' ')})`)
  if (once || stopping) break
  if (!report.ran) await Bun.sleep(pollSeconds * 1000)
} while (!stopping)

await handle.sql.end({ timeout: 5 })
