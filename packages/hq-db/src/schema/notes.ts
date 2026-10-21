import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { NOTE_COLORS, type NoteColor } from '../enums'
import { ownerColumn } from './_module'
import { oneOf, tz } from './_shared'
import { projects } from './core'

/**
 * The Notes board — HQ's scratchpad for ideas and backlog, deliberately owned
 * by no project. A note is one markdown body; checklists are `- [ ]` lines
 * in it, not a second shape.
 *
 * Every note has an owner (since `0009_notes_owner`): the board,
 * search, capture and Promote read and write only the signed-in owner's
 * notes. A note filed under a project can only name a project of its own
 * owner — `notes_project_owner_fk`, written by hand in that migration
 * because it sets only `project_id` null when a project goes away, which
 * drizzle can't express.
 *
 * Two lifecycles, both reversible: `archivedAt` takes a note off the board,
 * `deletedAt` moves it to the trash, where the board's own load sweeps rows
 * older than 30 days. `promotedTo` is the record of a note that became a draft
 * somewhere else — written later, read never, until the promote flow lands.
 */
export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
    /** Optional — a note is allowed to be a body and nothing else. */
    title: text('title'),
    body: text('body').notNull().default(''),
    color: text('color').$type<NoteColor>().notNull().default('none'),
    pinned: boolean('pinned').notNull().default(false),
    /** Free-form, the same convention as the website's project tags. */
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    /**
     * Manual order, ascending, gaps allowed. A new note takes the lowest
     * position so it lands first; a drag rewrites the column outright.
     */
    position: integer('position').notNull().default(0),
    /** `{ type, id, href, projectId, at }` once a note has been promoted into another module. */
    promotedTo: jsonb('promoted_to').$type<Record<string, unknown>>(),
    /**
     * The project a note is parked under, if any: Notes
     * belong to all of HQ, and this only files one — for the filter and as
     * Promote's default. A project going away leaves the note unfiled.
     */
    projectId: uuid('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    archivedAt: timestamp('archived_at', tz),
    deletedAt: timestamp('deleted_at', tz),
  },
  (t) => [
    // The board reads one owner's bucket at a time: both timestamps null
    // (active), archived, or trashed — so they lead, and the sort keys follow.
    index('notes_board_idx').on(
      t.ownerId,
      t.deletedAt,
      t.archivedAt,
      t.pinned.desc(),
      t.position,
      t.updatedAt.desc(),
    ),
    // Filtering by label, and listing the labels that exist.
    index('notes_labels_idx').using('gin', t.labels),
    index('notes_project_idx').on(t.projectId),
    check('notes_color_check', oneOf(t.color, NOTE_COLORS)),
  ],
)

export type NoteRow = typeof notes.$inferSelect
