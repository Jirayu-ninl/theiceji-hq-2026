import { getTableName, is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import type postgres from 'postgres'
import * as schema from './schema'

/**
 * Readiness, as opposed to liveness.
 *
 * A process that answers `/healthz` may still be pointed at a database that
 * is missing a migration, a column, an append-only trigger or the grants its
 * role needs — and every tool call would then fail one at a time. This reads
 * the catalog once and says which of those is wrong, derived from the Drizzle
 * schema the code was built with, so it can't drift from what the code
 * expects.
 *
 * It reports names and counts only — never a connection string, a row or a
 * credential.
 */

export type ReadinessCheck = {
  name: string
  ok: boolean
  /** One line for a status page. */
  summary: string
  /** What exactly is wrong, for logs and `db:check`. */
  problems: string[]
  /** Not wrong enough to refuse traffic, but worth saying. */
  warnings?: string[]
}

export type ReadinessReport = {
  ok: boolean
  checkedAt: string
  checks: ReadinessCheck[]
}

/** A migration as this build knows it: journal `when`, and the SQL file's hash when available. */
export type ExpectedMigration = {
  tag: string
  createdAt: number
  hash?: string
}

/**
 * Guards that live only in custom SQL migrations (the schema file can't
 * express triggers). Missing one means a history table can be rewritten.
 */
export const REQUIRED_TRIGGERS: readonly (readonly [
  table: string,
  trigger: string,
])[] = [
  // The ops kernel, migration 0002.
  ...[
    'ops_policies',
    'ops_run_checkpoints',
    'ops_usage_events',
    'ops_audit_events',
    'ops_capability_checks',
    'ops_human_responses',
  ].map((table) => [table, `${table}_append_only`] as const),
  ['ops_release_authorizations', 'ops_release_authorizations_guard'],
  // The active-work modules, migration 0003.
  ['board_card_events', 'board_card_events_append_only'],
  ['asset_assets', 'asset_assets_freeze_ready'],
  ['quote_quotes', 'quote_quotes_freeze_sent'],
  ['quote_lines', 'quote_lines_freeze_sent'],
  // The passive-income modules, migration 0005.
  ...['publish_readings', 'market_sales_events', 'exp_decisions'].map(
    (table) => [table, `${table}_append_only`] as const,
  ),
  // A card's payment ledger.
  ['board_card_payments', 'board_card_payments_append_only'],
]

/** Postgres truncates identifiers to 63 bytes; compare the way it stores them. */
const pgName = (name: string) => name.slice(0, 63)

type ExpectedTable = {
  name: string
  columns: string[]
  constraints: string[]
  indexes: string[]
}

function expectedTables(): ExpectedTable[] {
  const tables: ExpectedTable[] = []
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue
    const config = getTableConfig(value)
    tables.push({
      name: getTableName(value),
      columns: config.columns.map((column) => column.name),
      constraints: [
        ...config.checks.map((check) => check.name),
        ...config.foreignKeys.map((key) => key.getName()),
        ...config.uniqueConstraints.map((unique) => unique.getName()),
      ]
        .filter((name): name is string => Boolean(name))
        .map(pgName),
      indexes: config.indexes
        .map((index) => index.config.name)
        .filter((name): name is string => Boolean(name))
        .map(pgName),
    })
  }
  return tables
}

const list = (items: string[], max = 8) =>
  items.length <= max
    ? items.join(', ')
    : `${items.slice(0, max).join(', ')} and ${items.length - max} more`

export async function inspectDatabase(
  sql: postgres.Sql,
  options: {
    /** This build's migrations; omit where the files aren't shipped (anything but apps/hq). */
    migrations?: ExpectedMigration[]
    now?: Date
  } = {},
): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = []
  const report = (): ReadinessReport => ({
    ok: checks.every((check) => check.ok),
    checkedAt: (options.now ?? new Date()).toISOString(),
    checks,
  })

  try {
    const [info] = await sql<{ replica: boolean }[]>`
      select pg_is_in_recovery() as replica`
    checks.push({
      name: 'database',
      ok: info?.replica === false,
      summary: info?.replica
        ? 'connected to a read-only replica'
        : 'connected, writable',
      problems: info?.replica ? ['The server is in recovery (read-only).'] : [],
    })
  } catch (error) {
    checks.push({
      name: 'database',
      ok: false,
      summary: 'unreachable',
      problems: [
        error instanceof Error
          ? (error.message.split('\n')[0] ?? 'error')
          : 'error',
      ],
    })
    return report()
  }

  if (options.migrations) {
    const applied = await sql<{ hash: string; created_at: string | number }[]>`
      select hash, created_at from drizzle."__drizzle_migrations"`.catch(
      () => null,
    )
    if (!applied) {
      checks.push({
        name: 'migrations',
        ok: false,
        summary: 'no migration log',
        problems: [
          'drizzle.__drizzle_migrations is missing or unreadable — run `bun run db:migrate`.',
        ],
      })
    } else {
      const byTime = new Map(
        applied.map((row) => [Number(row.created_at), row.hash]),
      )
      const known = new Set(
        options.migrations.map((migration) => migration.createdAt),
      )
      const pending = options.migrations.filter(
        (migration) => !byTime.has(migration.createdAt),
      )
      const unknown = applied.filter(
        (row) => !known.has(Number(row.created_at)),
      )
      const changed = options.migrations.filter((migration) => {
        const hash = byTime.get(migration.createdAt)
        return Boolean(hash && migration.hash && hash !== migration.hash)
      })
      checks.push({
        name: 'migrations',
        ok: pending.length === 0,
        summary:
          pending.length > 0
            ? `${pending.length} pending`
            : `${applied.length} applied, none pending`,
        problems:
          pending.length > 0
            ? [
                `Not applied: ${list(pending.map((migration) => migration.tag))}.`,
              ]
            : [],
        warnings: [
          ...(unknown.length > 0
            ? [
                `${unknown.length} applied migration(s) this build doesn't know — the database is ahead of this deployment.`,
              ]
            : []),
          ...(changed.length > 0
            ? [
                `Applied SQL differs from this checkout for ${list(changed.map((migration) => migration.tag))} (an edited migration, or line endings when it was applied).`,
              ]
            : []),
        ],
      })
    }
  }

  const expected = expectedTables()
  const [relations, columns, constraints, indexes, triggers] =
    await Promise.all([
      sql<{ name: string }[]>`
      select c.relname as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')`,
      sql<{ tbl: string; name: string }[]>`
      select c.relname as tbl, a.attname as name from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and a.attnum > 0 and not a.attisdropped`,
      sql<{ name: string }[]>`
      select con.conname as name from pg_constraint con
      join pg_namespace n on n.oid = con.connamespace
      where n.nspname = 'public'`,
      sql<{ name: string }[]>`
      select indexname as name from pg_indexes where schemaname = 'public'`,
      sql<{ tbl: string; name: string; enabled: string }[]>`
      select c.relname as tbl, t.tgname as name, t.tgenabled as enabled from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal`,
    ])

  const tableSet = new Set(relations.map((row) => row.name))
  const missingTables = expected.filter((table) => !tableSet.has(table.name))
  const columnSet = new Set(columns.map((row) => `${row.tbl}.${row.name}`))
  const missingColumns = expected
    .filter((table) => tableSet.has(table.name))
    .flatMap((table) =>
      table.columns
        .filter((column) => !columnSet.has(`${table.name}.${column}`))
        .map((column) => `${table.name}.${column}`),
    )
  checks.push({
    name: 'schema',
    ok: missingTables.length === 0 && missingColumns.length === 0,
    summary: `${expected.length - missingTables.length}/${expected.length} tables${missingColumns.length > 0 ? `, ${missingColumns.length} column(s) missing` : ''}`,
    problems: [
      ...(missingTables.length > 0
        ? [`Missing tables: ${list(missingTables.map((table) => table.name))}.`]
        : []),
      ...(missingColumns.length > 0
        ? [`Missing columns: ${list(missingColumns)}.`]
        : []),
    ],
  })

  const constraintSet = new Set(
    [...constraints, ...indexes].map((row) => row.name),
  )
  const missingConstraints = expected
    .filter((table) => tableSet.has(table.name))
    .flatMap((table) => [...table.constraints, ...table.indexes])
    .filter((name) => !constraintSet.has(name))
  checks.push({
    name: 'constraints',
    ok: missingConstraints.length === 0,
    summary:
      missingConstraints.length === 0
        ? 'checks, keys and unique indexes in place'
        : `${missingConstraints.length} missing`,
    problems:
      missingConstraints.length > 0
        ? [`Missing: ${list(missingConstraints)}.`]
        : [],
  })

  const triggerSet = new Map(
    triggers.map((row) => [`${row.tbl}.${row.name}`, row.enabled]),
  )
  const missingTriggers = REQUIRED_TRIGGERS.filter(
    ([table, trigger]) =>
      tableSet.has(table) && !triggerSet.has(`${table}.${trigger}`),
  ).map(([table, trigger]) => `${table}.${trigger}`)
  const disabledTriggers = REQUIRED_TRIGGERS.filter(
    ([table, trigger]) => triggerSet.get(`${table}.${trigger}`) === 'D',
  ).map(([table, trigger]) => `${table}.${trigger}`)
  checks.push({
    name: 'guards',
    ok: missingTriggers.length === 0 && disabledTriggers.length === 0,
    summary: `${REQUIRED_TRIGGERS.length - missingTriggers.length - disabledTriggers.length}/${REQUIRED_TRIGGERS.length} history guards active`,
    problems: [
      ...(missingTriggers.length > 0
        ? [`Missing triggers: ${list(missingTriggers)}.`]
        : []),
      ...(disabledTriggers.length > 0
        ? [`Disabled triggers: ${list(disabledTriggers)}.`]
        : []),
    ],
  })

  const present = expected
    .map((table) => table.name)
    .filter((name) => tableSet.has(name))
  if (present.length > 0) {
    // By OID, not by name: resolving `public.<table>` itself needs USAGE on the
    // schema, and a role without it would make this check throw instead of
    // saying what's wrong.
    const [schemaAccess] = await sql<{ usage: boolean }[]>`
      select has_schema_privilege(current_user, 'public', 'USAGE') as usage`
    const grants = await sql<
      { tbl: string; sel: boolean; ins: boolean; upd: boolean; del: boolean }[]
    >`
      select c.relname as tbl,
        has_table_privilege(current_user, c.oid, 'SELECT') as sel,
        has_table_privilege(current_user, c.oid, 'INSERT') as ins,
        has_table_privilege(current_user, c.oid, 'UPDATE') as upd,
        has_table_privilege(current_user, c.oid, 'DELETE') as del
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any(${present}::text[])`
    const denied = grants
      .filter((grant) => !(grant.sel && grant.ins && grant.upd && grant.del))
      .map((grant) => grant.tbl)
    const usage = schemaAccess?.usage === true
    checks.push({
      name: 'privileges',
      ok: usage && denied.length === 0,
      summary: !usage
        ? 'no access to schema public'
        : denied.length === 0
          ? `read/write on all ${present.length} tables`
          : `denied on ${denied.length} table(s)`,
      problems: [
        ...(usage
          ? []
          : [
              "This role has no USAGE on schema public, so it can't reach any table.",
            ]),
        ...(denied.length > 0
          ? [`This role can't read and write: ${list(denied)}.`]
          : []),
      ],
    })
  }

  return report()
}
