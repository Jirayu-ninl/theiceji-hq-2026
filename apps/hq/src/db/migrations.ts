import type { ExpectedMigration } from '@theiceji/hq-db/readiness'
import journal from '../../drizzle/meta/_journal.json'

/**
 * The migrations this build ships, by journal identity (`when` is what
 * Drizzle records as `created_at`). The SQL hashes are added by
 * `scripts/check-db.ts`, which can read the files; a deployed route can't
 * count on them being traced into the bundle.
 */
export const MIGRATIONS: ExpectedMigration[] = journal.entries.map((entry) => ({
  tag: entry.tag,
  createdAt: entry.when,
}))
