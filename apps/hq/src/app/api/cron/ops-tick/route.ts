import { claimUrgentForNotification } from '@theiceji/hq-ops/human'
import { runOpsTick } from '@theiceji/hq-ops/runtime'
import { isPushConfigured, sendPush } from '@theiceji/hq-push/send'
import { NextResponse } from 'next/server'
import { isDbConfigured } from '@/db'
// The modules' tick steps (routines due, calendar sync, asset checks, publish and
// market reconciles, proposals expiring, generator videos) run in this pass.
import '@/modules/register'

/**
 * GET /api/cron/ops-tick — one scheduler pass from HQ.
 *
 * 1. The ops tick (@theiceji/hq-ops): lapsed leases, expired requests,
 *    reservations and authorizations, stalled runs, every step a module
 *    registered, then event delivery — under the `ops-tick` lease row, so a
 *    second caller answers `ran: false`.
 * 2. A push for urgent requests nobody has been told about yet.
 *
 * The MCP server runs the same passes every minute; this route is the
 * backstop and the way to run it by hand. It must finish inside the 60 s a
 * Vercel function gets, so the ops tick works to a time budget.
 *
 * Public in proxy.ts; guards itself with CRON_SECRET like /api/cron/db-ping.
 *
 * env: CRON_SECRET, DATABASE_URL, VAPID_* (for the push)
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret)
    return NextResponse.json(
      { ok: false, error: 'not_configured' },
      { status: 503 },
    )
  if (request.headers.get('authorization') !== `Bearer ${secret}`)
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 },
    )
  if (!isDbConfigured())
    return NextResponse.json(
      { ok: false, error: 'db_not_configured' },
      { status: 503 },
    )

  const ops = await runOpsTick({ budgetMs: 30_000 })
  for (const error of ops.errors) console.error('[cron] ops tick', error)

  // Claim only when a push can actually go out, or an urgent request would
  // be marked notified without anyone being told.
  let notified = 0
  if (isPushConfigured()) {
    const urgent = await claimUrgentForNotification().catch(
      (error: unknown) => {
        console.error('[cron] urgent claim', (error as Error).message)
        return []
      },
    )
    const titles = urgent.map((entry) => entry.title)
    if (titles.length > 0) {
      notified = titles.length
      await sendPush({
        title:
          titles.length === 1
            ? 'HQ needs you'
            : `HQ needs you · ${titles.length} requests`,
        body: titles.join(' · ').slice(0, 160),
        url: '/inbox',
        tag: `hq-urgent-${urgent[0]?.id ?? 'batch'}`,
      })
    }
  }

  return NextResponse.json(
    {
      ok: ops.errors.length === 0,
      ran: ops.ran,
      notified,
      ops: {
        leases: ops.leases,
        expiredRequests: ops.expiredRequests,
        expiredReservations: ops.expiredReservations,
        expiredAuthorizations: ops.expiredAuthorizations,
        stalledRuns: ops.stalledRuns,
        delivery: ops.delivery,
        steps: ops.steps.map((step) => ({
          name: step.name,
          ok: step.ok,
          ms: step.ms,
        })),
        errors: ops.errors.length,
      },
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
