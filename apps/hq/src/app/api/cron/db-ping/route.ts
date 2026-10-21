import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { getDb } from '@/db'
import { sweepOAuth } from '@/lib/oauth/grants'

/**
 * GET /api/cron/db-ping — daily keep-alive for Postgres, plus OAuth
 * housekeeping (expired authorization codes and tokens) on the same call.
 *
 * Managed hosts (Neon, Supabase, …) suspend or pause an idle database, and HQ
 * can go days without a login. Vercel Cron hits this
 * once a day (schedule in vercel.json) so the database never sits idle long
 * enough to be put to sleep.
 *
 * Public in proxy.ts; guards itself instead. Vercel Cron sends
 * `Authorization: Bearer <CRON_SECRET>` automatically once the env var is set.
 *
 * env: CRON_SECRET, DATABASE_URL
 */

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: 'not_configured' },
      { status: 503 },
    )
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 },
    )
  }

  const db = getDb()
  if (!db) {
    return NextResponse.json(
      { ok: false, error: 'db_not_configured' },
      { status: 503 },
    )
  }

  const started = Date.now()
  try {
    await db.execute(sql`select 1`)
    const ms = Date.now() - started
    // Best effort: a sweep failure (e.g. the OAuth migration not applied yet)
    // must not turn the keep-alive red.
    const swept = await sweepOAuth().catch((e) => {
      console.error('[cron] oauth sweep', (e as Error).message)
      return null
    })
    console.log(
      `[cron] db-ping ok ${ms}ms${swept ? ` · swept ${swept.codes} codes, ${swept.tokens} tokens` : ''}`,
    )
    return NextResponse.json({ ok: true, ms, swept })
  } catch (e) {
    console.error('[cron] db-ping', (e as Error).message)
    return NextResponse.json(
      { ok: false, error: 'db_unreachable' },
      { status: 502 },
    )
  }
}
