import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

/**
 * The Postgres handle. **Server-only** — never import this from a client
 * component. (No `server-only` guard on purpose: the CLI scripts and the Bun
 * MCP server reuse it outside Next, where that package throws on import.)
 *
 * Two ways in:
 *
 * · `getDb()` — the env-driven singleton HQ uses. Returns null when
 *   `DATABASE_URL` isn't wired yet, so HQ degrades into a "not configured"
 *   banner instead of crashing during early setup. Cached on `globalThis` so
 *   Next's dev server doesn't open a fresh pool on every hot reload.
 * · `createDbHandle()` — an explicit pool for a long-running process (an MCP
 *   server),
 *   which owns its lifecycle and ends it on SIGTERM. It prepares statements
 *   only when asked (`{ prepare: true }`).
 *
 * env: DATABASE_URL, DATABASE_POOL_MAX, DATABASE_PREPARE (both optional)
 */

export type Db = PostgresJsDatabase<typeof schema>

export type DbHandle = { sql: postgres.Sql; db: Db }

export function createDbHandle(
  url: string,
  options: { max?: number; prepare?: boolean } = {},
): DbHandle {
  const prepare = options.prepare ?? false
  const sql = postgres(url, {
    max: options.max ?? 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare,
    onnotice: () => {},
  })
  return { sql, db: drizzle(prepare ? preparing(sql) : sql, { schema }) }
}

/**
 * Drizzle sends every query through `sql.unsafe()`, which postgres.js runs
 * unprepared: it asks the server to describe the statement, waits, then runs
 * it — two round trips per query, the biggest share of a page's time over a
 * real network. Asking `unsafe()` to prepare keeps each statement named on
 * its connection, so from the second use on a query is one round trip.
 *
 * postgres.js re-prepares by itself when the server has lost a statement
 * (`FetchPreparedStatement`: a transaction-mode pooler handed the query to
 * another backend) or the schema changed under it (`RevalidateCachedQuery`),
 * so this can cost a round trip but never fails a query. Transactions get
 * their own connection from `begin()`, wrapped the same way.
 */
function preparing(sql: postgres.Sql): postgres.Sql {
  return new Proxy(sql, {
    get(target, key, receiver) {
      if (key === 'unsafe')
        return (query: string, args?: unknown[], options?: object) =>
          target.unsafe(
            query,
            args as postgres.ParameterOrJSON<never>[],
            { prepare: true, ...options } as postgres.UnsafeQueryOptions,
          )
      if (key === 'begin')
        return (...args: unknown[]) => {
          const work = args.at(-1)
          if (typeof work !== 'function')
            return Reflect.apply(target.begin, target, args)
          return Reflect.apply(target.begin, target, [
            ...args.slice(0, -1),
            (tx: postgres.TransactionSql) =>
              work(preparing(tx as unknown as postgres.Sql)),
          ])
        }
      return Reflect.get(target, key, receiver)
    },
  })
}

const globalForDb = globalThis as unknown as { __horizonDb?: DbHandle }

/**
 * Connections per HQ instance. One page fans out a dozen reads at once
 * (`Promise.all` in the loaders), and a drizzle query costs two round trips
 * that can't share a connection (postgres.js describes an unprepared query
 * before running it), so one connection made every read wait its turn —
 * seconds per page over a real network. Four runs them four abreast.
 *
 * Kept small on purpose: the production database allows 20 connections in
 * all, shared with hq-mcp (5) and the agent runner (4), and a warm Vercel
 * instance keeps its pool while it waits for the next request.
 */
const DEFAULT_POOL_MAX = 4

function poolMax(): number {
  const n = Number(process.env.DATABASE_POOL_MAX)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_POOL_MAX
}

/**
 * Prepared statements (one round trip per query instead of two, see
 * `preparing`). On unless `DATABASE_PREPARE=false`: set that for a
 * transaction-mode pooler, where the server keeps losing them and each
 * query pays a retry.
 */
function prepareStatements(): boolean {
  const value = process.env.DATABASE_PREPARE?.trim().toLowerCase()
  return !(value === 'false' || value === '0' || value === 'off')
}

function handle(): DbHandle | null {
  if (globalForDb.__horizonDb) return globalForDb.__horizonDb
  const url = process.env.DATABASE_URL
  if (!url) return null
  globalForDb.__horizonDb = createDbHandle(url, {
    max: poolMax(),
    prepare: prepareStatements(),
  })
  return globalForDb.__horizonDb
}

/** The handle, or null when the database isn't configured. */
export function getDb(): Db | null {
  return handle()?.db ?? null
}

/** The handle, or a thrown error — for paths that cannot degrade. */
export function requireDb(): Db {
  const db = getDb()
  if (!db) throw new Error('DATABASE_URL is not configured.')
  return db
}

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL)
}

/** Raw postgres.js client — migrations and one-off scripts only. */
export function getSql(): postgres.Sql | null {
  return handle()?.sql ?? null
}

/** Let a CLI script exit instead of hanging on an open socket. */
export async function closeDb(): Promise<void> {
  const h = globalForDb.__horizonDb
  if (!h) return
  globalForDb.__horizonDb = undefined
  await h.sql.end({ timeout: 5 })
}

export { schema }
