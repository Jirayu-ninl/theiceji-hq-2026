import { type SQL, sql } from 'drizzle-orm'
import { type AnyPgColumn, foreignKey, uuid } from 'drizzle-orm/pg-core'
import { userRef } from './_user'
import { projects } from './core'

/**
 * Columns and keys every module schema shares: the owner
 * on every row, and a project of that same owner when the row has one.
 * ops.ts keeps its own copies — it predates this file and moves nowhere.
 */

/** `owner_id` — NOT NULL on every row of every module. */
export const ownerColumn = () =>
  uuid('owner_id').notNull().references(userRef, { onDelete: 'restrict' })

/** Keeps a row inside a project of its own owner; skipped when there is no project. */
export const inOwnProject = (
  name: string,
  t: { projectId: AnyPgColumn; ownerId: AnyPgColumn },
) =>
  foreignKey({
    name,
    columns: [t.projectId, t.ownerId],
    foreignColumns: [projects.id, projects.ownerId],
  }).onDelete('restrict')

/** A nil UUID stands in for "no project" where a unique index has to see it. */
export const projectOrNone = (col: AnyPgColumn): SQL =>
  sql`coalesce(${col}, '00000000-0000-0000-0000-000000000000'::uuid)`

/** `length(btrim(col)) between 1 and max` — a required, trimmed text. */
export const trimmedLength = (col: AnyPgColumn, max: number): SQL =>
  sql`length(btrim(${col})) between 1 and ${sql.raw(String(max))}`

/** A three-letter currency code, or null. */
export const currencyCode = (col: AnyPgColumn): SQL =>
  sql`${col} is null or ${col} ~ '^[A-Z]{3}$'`
