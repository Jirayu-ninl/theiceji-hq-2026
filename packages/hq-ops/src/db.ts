import { type Db, requireDb } from '@theiceji/hq-db'
import { type SQL, sql } from 'drizzle-orm'
import { OpsError } from './errors'

/**
 * The database handle the kernel and every module service share.
 *
 * A long-running process (apps/hq-mcp, the worker, the agent runner) hands
 * the services its own pool with `configureOpsDatabase`; without one they use
 * `DATABASE_URL`'s singleton, which is what HQ's server actions do.
 */

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type Reader = Db | Tx

let configured: Db | null = null

export function configureOpsDatabase(db: Db | null): void {
  configured = db
}

export function database(): Db {
  if (configured) return configured
  try {
    return requireDb()
  } catch {
    throw new OpsError(
      'unavailable',
      'The database isn’t configured. Set DATABASE_URL and run bun run db:migrate.',
    )
  }
}

/**
 * The database's clock. Anything compared with a stored timestamp is
 * compared with this, never with the app server's `Date.now()` — a database
 * running even a second ahead of the host once made just-written rows read
 * as "not yet" (the outbox fix, cd1b719).
 */
export async function dbNow(reader: Reader): Promise<Date> {
  const rows = await reader.execute<{ now: Date | string }>(
    sql`select now() as now`,
  )
  const value = rows[0]?.now
  return value instanceof Date ? value : new Date(String(value))
}

/**
 * `now() + n seconds`, evaluated by the database — for a lease, an expiry or
 * a backoff that is stored and later compared with `now()` again. Whole
 * seconds: nothing in the kernel needs finer.
 */
export function nowPlus(seconds: number): SQL {
  return sql`now() + (${Math.round(seconds)}::int * interval '1 second')`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value)
