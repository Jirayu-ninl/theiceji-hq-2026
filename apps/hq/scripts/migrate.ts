/**
 * Apply pending migrations from ./drizzle.
 *
 *   bun run db:migrate
 *
 * Safe to re-run: drizzle records what it has applied in its own
 * `__drizzle_migrations` table and skips those.
 *
 * Uses `DATABASE_MIGRATE_URL` when set, else `DATABASE_URL`. Keep them separate
 * when the app's runtime role is deliberately locked down — migrating needs to
 * create schemas and tables, serving does not.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { explain } from './pgerror'

const migrateUrl = process.env.DATABASE_MIGRATE_URL
const url = migrateUrl ?? process.env.DATABASE_URL

if (!url) {
  console.error('Neither DATABASE_MIGRATE_URL nor DATABASE_URL is set.')
  console.error('Add one to apps/hq/.env and try again.')
  process.exit(1)
}

function describe(target: string): string {
  try {
    const parsed = new URL(target)
    const db = parsed.pathname.replace(/^\//, '') || '?'
    return `${parsed.username}@${parsed.hostname}/${db}`
  } catch {
    return '(unparseable URL)'
  }
}

console.log(
  `Migrating ${describe(url)} via ${migrateUrl ? 'DATABASE_MIGRATE_URL' : 'DATABASE_URL'}`,
)

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

try {
  await migrate(drizzle(sql), { migrationsFolder: './drizzle' })
  console.log('Migrations applied.')
} catch (e) {
  console.error('Migration failed.')
  console.error(explain(e, url))
  console.error('')
  console.error('Run `bun run db:check` for a fuller picture of the database.')
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
