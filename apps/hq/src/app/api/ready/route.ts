import { getCurrentUser } from '@theiceji/hq-auth'
import { inspectDatabase, type ReadinessCheck } from '@theiceji/hq-db/readiness'
import { NextResponse } from 'next/server'
import { getSql } from '@/db'
import { MIGRATIONS } from '@/db/migrations'
import { integrations } from '@/lib/integrations'

/**
 * GET /api/ready — readiness, not liveness.
 *
 * Ready means the database is reachable and writable, every migration this
 * build ships is applied, the schema, constraints and history guards the code
 * expects are there, and this role may read and write them. Optional
 * integrations that aren't configured (R2, the sealing key, OAuth, cron, Web
 * Push — see `lib/integrations.ts`) don't make HQ unready: they are listed as
 * blocked capabilities, which is what `hq_get_brief` reports too.
 *
 * Public in proxy.ts so a monitor can poll it; an anonymous caller gets only
 * `{ ok }` and the status code. The signed-in owner, or a caller presenting
 * CRON_SECRET, gets the checks — names and counts, never a credential.
 */
export const dynamic = 'force-dynamic'

function capabilities(): ReadinessCheck {
  // The database has its own check above; the rest are optional.
  const blocked = integrations()
    .filter((integration) => integration.id !== 'database' && !integration.ok)
    .map((integration) => integration.blocked)
  return {
    name: 'capabilities',
    ok: true,
    summary:
      blocked.length === 0 ? 'all configured' : `${blocked.length} blocked`,
    problems: [],
    warnings: blocked.map((line) => `Blocked: ${line}.`),
  }
}

async function detailed(request: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get('authorization') === `Bearer ${secret}`)
    return true
  return Boolean(await getCurrentUser().catch(() => null))
}

export async function GET(request: Request) {
  const sql = getSql()
  const checks: ReadinessCheck[] = sql
    ? await inspectDatabase(sql, { migrations: MIGRATIONS })
        .then((report) => report.checks)
        .catch((error: unknown) => {
          console.error('[ready]', (error as Error).message)
          return [
            {
              name: 'database',
              ok: false,
              summary: 'inspection failed',
              problems: [],
            },
          ]
        })
    : [
        {
          name: 'database',
          ok: false,
          summary: 'DATABASE_URL is not set',
          problems: [],
        },
      ]
  checks.push(capabilities())
  const ok = checks.every((check) => check.ok)
  for (const check of checks)
    if (!check.ok)
      console.error(`[ready] ${check.name}: ${check.problems.join(' ')}`)
  const body = (await detailed(request))
    ? { ok, checkedAt: new Date().toISOString(), checks }
    : { ok }
  return NextResponse.json(body, {
    status: ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  })
}
