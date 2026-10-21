#!/usr/bin/env bun
import { connectHq, httpTransfer } from './hq'
import { PLAN13_OPERATIONS, runPlan13Once } from './plan13'

/**
 * HQ local worker.
 *
 *   HQ_MCP_URL=https://mcp.example.com/mcp HQ_WORKER_TOKEN=hq_pat_… bun run apps/worker/src/index.ts
 *
 * It works the job queue: jobs in the modules' manifests (a Story scene's
 * ZIP today), claimed with `agents_claim_task`. The token is a personal access
 * token created in HQ → Settings → Connections with "Acts as: Worker" and the
 * agents:operate, assets:read, assets:write and assets:operate permissions;
 * each project's operating policy has to cover it and allow `generate` and
 * `draft`.
 *
 * env: HQ_MCP_URL, HQ_WORKER_TOKEN, WORKER_PROJECT_ID (optional),
 *      WORKER_POLL_SECONDS (30), WORKER_LEASE_SECONDS (600), WORKER_GIT_COMMIT
 */

const url = process.env.HQ_MCP_URL
const token = process.env.HQ_WORKER_TOKEN
if (!url || !token) {
  console.error(
    'Set HQ_MCP_URL and HQ_WORKER_TOKEN (a worker token from HQ → Settings → Connections).',
  )
  process.exit(1)
}

/**
 * The commit this worker runs, for the boot line: WORKER_GIT_COMMIT, else the
 * checkout it runs from.
 */
async function gitCommit(): Promise<string | null> {
  if (process.env.WORKER_GIT_COMMIT) return process.env.WORKER_GIT_COMMIT
  try {
    const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = (await new Response(child.stdout).text()).trim()
    return (await child.exited) === 0 && /^[0-9a-f]{40}$/.test(out) ? out : null
  } catch {
    return null
  }
}

const once = process.argv.includes('--once')
const pollSeconds = Number(process.env.WORKER_POLL_SECONDS ?? '30')
const leaseSeconds = Number(process.env.WORKER_LEASE_SECONDS ?? '600')

const log = (line: string) =>
  console.log(`[worker] ${new Date().toISOString()} ${line}`)
const commit = await gitCommit()
log(
  `plan13 · ${PLAN13_OPERATIONS.join(', ')} · commit ${commit?.slice(0, 12) ?? 'unknown'} · polling ${url} every ${pollSeconds}s`,
)

const hq = await connectHq({ url, token })
let stopping = false
const stop = () => {
  stopping = true
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

while (!stopping) {
  let outcome = null
  try {
    outcome = await runPlan13Once({
      hq,
      transfer: httpTransfer,
      leaseSeconds,
      ...(process.env.WORKER_PROJECT_ID
        ? { projectId: process.env.WORKER_PROJECT_ID }
        : {}),
      log,
    })
  } catch (error) {
    log(`claim failed: ${(error as Error).message}`)
  }
  if (once) break
  // Straight on to the next job after one finishes; wait when the queue is empty.
  if (!outcome && !stopping) await Bun.sleep(pollSeconds * 1000)
}

await hq.close()
log('stopped')
