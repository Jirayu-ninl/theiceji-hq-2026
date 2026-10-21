/**
 * Preflight for the HQ database.
 *
 *   bun run db:check
 *
 * Answers, in one pass: can we connect, who are we, may we create what the
 * migrator needs, is every migration this checkout ships applied (by identity
 * and SQL hash), does every table, column, constraint and history guard the
 * schema declares exist, and may this role actually read and write them. Run it before
 * `db:migrate` on a new host, and whenever HQ says the database is not
 * configured.
 *
 * When DATABASE_MIGRATE_URL is set it reports both connections, because the
 * usual failure on a locked-down host is a runtime role that can see nothing
 * the migrator created.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ExpectedMigration,
  inspectDatabase,
} from '@theiceji/hq-db/readiness'
import postgres from 'postgres'
import { MIGRATIONS } from '../src/db/migrations'
import { explain } from './pgerror'

/** Journal identities plus each SQL file's hash, computed the way Drizzle's migrator does. */
function migrationsWithHashes(): ExpectedMigration[] {
  return MIGRATIONS.map((migration) => {
    try {
      const text = readFileSync(
        // Relative to apps/hq, like `db:migrate`'s migrationsFolder.
        join('drizzle', `${migration.tag}.sql`),
      ).toString()
      return {
        ...migration,
        hash: createHash('sha256').update(text).digest('hex'),
      }
    } catch {
      return migration
    }
  })
}
const DML = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const

const migrateUrl = process.env.DATABASE_MIGRATE_URL
const runtimeUrl = process.env.DATABASE_URL

if (!runtimeUrl && !migrateUrl) {
  console.error('DATABASE_URL is not set. Add it to apps/hq/.env.')
  process.exit(1)
}

const yes = (value: unknown) => (value ? 'yes' : 'NO')

type Outcome = { ok: boolean; notes: string[] }

async function report(target: string, label: string): Promise<Outcome> {
  const notes: string[] = []
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    console.log(`${label}  unparseable URL`)
    return { ok: false, notes }
  }
  console.log(
    `${label}  ${parsed.username}@${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`,
  )

  const sql = postgres(target, { max: 1, prepare: false, onnotice: () => {} })
  try {
    const [info] = await sql`
      select
        current_user                                                      as role,
        current_database()                                                as db,
        current_setting('server_version')                                 as version,
        has_database_privilege(current_user, current_database(), 'CREATE') as can_create_schema,
        has_schema_privilege(current_user, 'public', 'CREATE')             as can_create_tables,
        pg_is_in_recovery()                                               as replica
    `
    if (!info) {
      console.log('  connected, but the server returned nothing')
      return { ok: false, notes }
    }

    console.log(`  connected           postgres ${info.version}`)
    console.log(`  role                ${info.role}`)
    console.log(`  create schema       ${yes(info.can_create_schema)}`)
    console.log(`  create in public    ${yes(info.can_create_tables)}`)
    if (info.replica)
      console.log('  read-only replica   yes (writes will fail)')

    // The whole readiness picture the deployed app reports (/api/ready, the
    // MCP server's /readyz): migrations by identity and SQL hash, every table
    // and column the schema declares, constraints, the history guards, and
    // read/write grants — from the catalog, so a table this role can't see
    // is reported as a grant problem rather than as missing.
    const readiness = await inspectDatabase(sql, {
      migrations: migrationsWithHashes(),
    })
    for (const check of readiness.checks) {
      if (check.name === 'database') continue
      console.log(
        `  ${check.name.padEnd(19)} ${check.ok ? '' : 'FAIL — '}${check.summary}`,
      )
      for (const line of check.problems) console.log(`      ${line}`)
      for (const line of check.warnings ?? [])
        console.log(`      note: ${line}`)
    }
    const failed = new Set(
      readiness.checks.filter((check) => !check.ok).map((check) => check.name),
    )
    const missing =
      failed.has('schema') || failed.has('migrations') ? ['schema'] : []
    const ungranted = failed.has('privileges') ? ['tables'] : []

    if (missing.length > 0 && !info.can_create_schema) {
      notes.push(
        'This role cannot create the schema Drizzle keeps its migration log in,',
        'and tables are still missing. Point DATABASE_MIGRATE_URL at an owner',
        'connection, or have the owner run:',
        `  GRANT CREATE ON DATABASE "${info.db}" TO "${info.role}";`,
      )
    } else if (missing.length > 0) {
      notes.push('Run `bun run db:migrate` to create the missing tables.')
    }

    if (ungranted.length > 0) {
      notes.push(
        `Role "${info.role}" cannot read/write tables that already exist.`,
        'This is what you get when another role ran the migration. Have the',
        'owner grant it, including for tables future migrations add:',
        `  GRANT ${DML.join(', ')} ON ALL TABLES IN SCHEMA public TO "${info.role}";`,
        `  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${info.role}";`,
        `  ALTER DEFAULT PRIVILEGES IN SCHEMA public`,
        `    GRANT ${DML.join(', ')} ON TABLES TO "${info.role}";`,
      )
    }

    if (failed.has('constraints') || failed.has('guards')) {
      notes.push(
        'Tables exist but constraints or history guards are missing — a migration',
        'was applied partially or edited. Compare with apps/hq/drizzle before',
        'serving traffic; the guards are what keep history tables append-only.',
      )
    }

    if (readiness.ok) {
      notes.push('Schema is in place. `bun run user:list` shows the accounts.')
    }

    return { ok: readiness.ok, notes }
  } catch (e) {
    console.log('  could not query the database:')
    console.log(explain(e, target))
    return { ok: false, notes }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function printNotes(notes: string[]) {
  if (notes.length === 0) return
  console.log('')
  for (const line of notes) console.log(`  ${line}`)
}

const runtime = await report(runtimeUrl ?? (migrateUrl as string), 'runtime ')
printNotes(runtime.notes)

if (migrateUrl && migrateUrl !== runtimeUrl) {
  console.log('')
  const migrator = await report(migrateUrl, 'migrator')
  printNotes(migrator.notes)
}

// The runtime connection is the one HQ actually serves from.
if (!runtime.ok) process.exitCode = 1
