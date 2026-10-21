import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit config. `db:generate` diffs packages/hq-db/src/schema.ts against the SQL
 * already in ./drizzle and writes the next migration; `db:migrate` applies the
 * pending ones. Only `db:migrate`/`db:studio` need DATABASE_URL.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: '../../packages/hq-db/src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  casing: 'snake_case',
  strict: true,
  verbose: true,
})
