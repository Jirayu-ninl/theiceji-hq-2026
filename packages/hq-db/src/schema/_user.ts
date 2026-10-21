import { integer, timestamp, uuid } from 'drizzle-orm/pg-core'
import { tz } from './_shared'
import { users } from './auth'

/** A user reference for `created_by`, `owner_id` and the like. Lazy, so it never races the table. */
export const userRef = () => users.id

/** Columns every mutable row carries. A fresh set per table. */
export function tracked() {
  return {
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
    revision: integer('revision').notNull().default(1),
  }
}
