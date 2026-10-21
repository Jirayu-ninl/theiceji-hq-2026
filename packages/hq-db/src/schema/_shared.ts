import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

/**
 * Helpers every schema file shares: the timestamp mode, CHECKs built from the
 * literal tuples in ../enums. Nothing here references
 * a table, so every schema file can import it without a cycle; the helpers
 * that do (`userRef`, `tracked`) live in ./_user.ts.
 */

export const tz = { withTimezone: true } as const

/** `col in ('a','b')` from a literal tuple, so CHECKs track the TS unions. */
export function oneOf(col: AnyPgColumn, values: readonly string[]) {
  const list = values.map((v) => `'${v}'`).join(', ')
  return sql`${col} in ${sql.raw(`(${list})`)}`
}

export const nullableOneOf = (col: AnyPgColumn, values: readonly string[]) =>
  sql`${col} is null or ${oneOf(col, values)}`
