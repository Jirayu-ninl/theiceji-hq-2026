import { sql } from 'drizzle-orm'
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  BOARD_CARD_EVENT_KINDS,
  BOARD_LANE_ROLES,
  BOARD_PAYMENT_KINDS,
  type BoardCardEventKind,
  type BoardLaneRole,
  type BoardPaymentKind,
  OPS_ACTOR_TYPES,
  type OpsActorType,
  PROJECT_COLOR_NAMES,
  PROJECT_KINDS,
  type ProjectColor,
  type ProjectKind,
} from '../enums'
import {
  currencyCode,
  inOwnProject,
  ownerColumn,
  trimmedLength,
} from './_module'
import { nullableOneOf, oneOf, tz } from './_shared'
import { tracked, userRef } from './_user'
import { clients } from './core'

/* ── board — kanban for every kind of project ───────────
 *
 * A board has lanes and lanes hold cards. A project's first board is made
 * from its kind's lane preset (hq-core `LANE_PRESETS`) the first time the
 * board is opened; a board without a project is the owner's own.
 *
 * · **One pinned lane.** A board has at most one `awaiting_payment` lane; it
 *   is drawn pinned right, and its footer — the sum of its cards' prices — is
 *   money that is owed but not income yet.
 * · **Mark paid** sets `paid_at` and archives the card in one write; the card
 *   leaves the board and the pending sum drops. It is the owner's act only.
 * · **Archive and Trash.** Archive takes a finished card off the board and
 *   keeps it in the Archive view. Delete moves it to the Trash: `deleted_at`
 *   set on an archived card, so every read that skips archived cards skips
 *   deleted ones too. History is append-only, so a card is never removed
 *   for good; one with money in (`paid_total > 0`) can't be deleted at all.
 * · **A card stays inside its board.** `(lane_id, board_id)` references the
 *   lane of *that* board, so a card can't sit in another board's lane.
 * · **History is append-only.** Every move, price change and payment writes a
 *   `board_card_events` row that is never updated or deleted (a trigger in
 *   the migration).
 * · **Client**: a record in HQ's `clients`, or a name used
 *   once on this card only — never both.
 * · **Money**: `total` = the card's own `price` + its
 *   follow-ups' prices, `paid_total` = the payments that count; hq-board
 *   writes both in the same transaction as whatever changed them, and what
 *   the card still owes is `total − paid_total`. Everything that reads a card
 *   as money reads these, never `price` alone.
 * · **Follow-ups** are work that came after the card's own task was done —
 *   a revision round, an add-on, the client's note. Not sub-tasks: they have
 *   no done state, only details, a price, a due day, a prompt and files.
 * · **Payments are a ledger.** A deposit (any size, or none), part payments,
 *   the rest at Mark paid; a mistake is struck by a `void` row, never edited
 *   or deleted (a trigger in the migration).
 */

export const boardBoards = pgTable(
  'board_boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id'),
    name: text('name').notNull(),
    /** The project kind whose lanes it started from, or null for a board made by hand. */
    preset: text('preset').$type<ProjectKind>(),
    position: integer('position').notNull().default(0),
    archivedAt: timestamp('archived_at', tz),
  },
  (t) => [
    unique('board_boards_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('board_boards_project_fk', t),
    index('board_boards_owner_idx').on(t.ownerId, t.projectId, t.position),
    check('board_boards_name_check', trimmedLength(t.name, 120)),
    check('board_boards_preset_check', nullableOneOf(t.preset, PROJECT_KINDS)),
  ],
)

export const boardLanes = pgTable(
  'board_lanes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    boardId: uuid('board_id').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    role: text('role').$type<BoardLaneRole>().notNull().default('normal'),
    /** Cards the lane should hold at most; null is no limit. Shown, never enforced. */
    wipLimit: integer('wip_limit'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('board_lanes_owner_scope_key').on(t.id, t.ownerId),
    unique('board_lanes_board_scope_key').on(t.id, t.boardId),
    foreignKey({
      name: 'board_lanes_board_fk',
      columns: [t.boardId, t.ownerId],
      foreignColumns: [boardBoards.id, boardBoards.ownerId],
    }).onDelete('cascade'),
    uniqueIndex('board_lanes_position_key').on(t.boardId, t.position),
    uniqueIndex('board_lanes_awaiting_key')
      .on(t.boardId)
      .where(sql`${t.role} = 'awaiting_payment'`),
    check('board_lanes_name_check', trimmedLength(t.name, 60)),
    check('board_lanes_role_check', oneOf(t.role, BOARD_LANE_ROLES)),
    check(
      'board_lanes_wip_check',
      sql`${t.wipLimit} is null or ${t.wipLimit} > 0`,
    ),
  ],
)

export const boardCards = pgTable(
  'board_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    boardId: uuid('board_id').notNull(),
    laneId: uuid('lane_id').notNull(),
    /** The board's project, copied so a card reads without its board. */
    projectId: uuid('project_id'),
    title: text('title').notNull(),
    /** Markdown. */
    body: text('body').notNull().default(''),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    price: numeric('price', { precision: 12, scale: 2, mode: 'string' }),
    currency: text('currency'),
    /** A day, not an instant: "due Thursday" in the project's own calendar. */
    dueOn: date('due_on', { mode: 'string' }),
    /** Who the work is for — a record in Clients; `client` is then null. */
    clientId: uuid('client_id'),
    /** Who the work is for, as a name used once on this card only. */
    client: text('client'),
    /** A swatch name for the card's stripe — identity, never a state. */
    color: text('color').$type<ProjectColor>(),
    /** `price` + the live follow-ups' prices, in `currency`; null while nothing is priced. */
    total: numeric('total', { precision: 12, scale: 2, mode: 'string' }),
    /** The payments that count (not voided), in `currency`. */
    paidTotal: numeric('paid_total', { precision: 12, scale: 2, mode: 'string' })
      .notNull()
      .default('0'),
    /** Order inside the lane, ascending. */
    position: integer('position').notNull().default(0),
    paidAt: timestamp('paid_at', tz),
    archivedAt: timestamp('archived_at', tz),
    /** In the Trash: off the board like an archived card, listed only in Trash. Always archived too. */
    deletedAt: timestamp('deleted_at', tz),
  },
  (t) => [
    unique('board_cards_owner_scope_key').on(t.id, t.ownerId),
    foreignKey({
      name: 'board_cards_board_fk',
      columns: [t.boardId, t.ownerId],
      foreignColumns: [boardBoards.id, boardBoards.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'board_cards_lane_fk',
      columns: [t.laneId, t.boardId],
      foreignColumns: [boardLanes.id, boardLanes.boardId],
    }).onDelete('restrict'),
    inOwnProject('board_cards_project_fk', t),
    foreignKey({
      name: 'board_cards_client_fk',
      columns: [t.clientId, t.ownerId],
      foreignColumns: [clients.id, clients.ownerId],
    }).onDelete('restrict'),
    index('board_cards_client_idx')
      .on(t.ownerId, t.clientId)
      .where(sql`${t.clientId} is not null`),
    index('board_cards_lane_idx')
      .on(t.laneId, t.position)
      .where(sql`${t.archivedAt} is null`),
    index('board_cards_owner_idx').on(t.ownerId, t.projectId, t.archivedAt),
    index('board_cards_labels_idx').using('gin', t.labels),
    check('board_cards_title_check', trimmedLength(t.title, 200)),
    check('board_cards_body_check', sql`length(${t.body}) <= 20000`),
    check(
      'board_cards_price_check',
      sql`${t.price} is null or (${t.price} >= 0 and ${t.currency} is not null)`,
    ),
    check('board_cards_currency_check', currencyCode(t.currency)),
    check(
      'board_cards_client_check',
      sql`${t.client} is null or length(btrim(${t.client})) between 1 and 120`,
    ),
    check(
      'board_cards_client_one_check',
      sql`${t.clientId} is null or ${t.client} is null`,
    ),
    check('board_cards_color_check', nullableOneOf(t.color, PROJECT_COLOR_NAMES)),
    check(
      'board_cards_total_check',
      sql`${t.total} is null or (${t.total} >= 0 and ${t.currency} is not null)`,
    ),
    check(
      'board_cards_paid_total_check',
      sql`${t.paidTotal} >= 0 and (${t.paidTotal} = 0 or ${t.currency} is not null)`,
    ),
    check('board_cards_labels_check', sql`cardinality(${t.labels}) <= 12`),
    check(
      'board_cards_paid_check',
      sql`${t.paidAt} is null or ${t.archivedAt} is not null`,
    ),
    check(
      'board_cards_deleted_check',
      sql`${t.deletedAt} is null or (${t.archivedAt} is not null and ${t.paidTotal} = 0)`,
    ),
  ],
)

/**
 * A card's history, append-only. `amount`/`currency` are the price a
 * `priced` or `paid` event recorded; `from_lane_id`/`to_lane_id` a move.
 */
export const boardCardEvents = pgTable(
  'board_card_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    cardId: uuid('card_id').notNull(),
    boardId: uuid('board_id').notNull(),
    projectId: uuid('project_id'),
    kind: text('kind').$type<BoardCardEventKind>().notNull(),
    fromLaneId: uuid('from_lane_id'),
    toLaneId: uuid('to_lane_id'),
    amount: numeric('amount', { precision: 12, scale: 2, mode: 'string' }),
    currency: text('currency'),
    actorType: text('actor_type').$type<OpsActorType>().notNull(),
    actorId: text('actor_id').notNull(),
    data: jsonb('data')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', tz).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'board_card_events_card_fk',
      columns: [t.cardId, t.ownerId],
      foreignColumns: [boardCards.id, boardCards.ownerId],
    }).onDelete('restrict'),
    inOwnProject('board_card_events_project_fk', t),
    index('board_card_events_card_idx').on(t.cardId, t.occurredAt),
    index('board_card_events_owner_idx').on(t.ownerId, t.kind, t.occurredAt),
    check(
      'board_card_events_kind_check',
      oneOf(t.kind, BOARD_CARD_EVENT_KINDS),
    ),
    check('board_card_events_actor_check', oneOf(t.actorType, OPS_ACTOR_TYPES)),
    check('board_card_events_currency_check', currencyCode(t.currency)),
  ],
)

/**
 * Work that came after a card's own task was done: details, a
 * price in the card's currency, a due day. Removing one archives it (Undo
 * brings it back); the card's `total` counts only the live ones.
 */
export const boardFollowups = pgTable(
  'board_followups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    cardId: uuid('card_id').notNull(),
    /** The card's project, copied so a follow-up reads without its card. */
    projectId: uuid('project_id'),
    title: text('title').notNull(),
    /** Markdown. */
    body: text('body').notNull().default(''),
    /** In the card's currency. */
    price: numeric('price', { precision: 12, scale: 2, mode: 'string' }),
    dueOn: date('due_on', { mode: 'string' }),
    position: integer('position').notNull().default(0),
    archivedAt: timestamp('archived_at', tz),
  },
  (t) => [
    unique('board_followups_owner_scope_key').on(t.id, t.ownerId),
    foreignKey({
      name: 'board_followups_card_fk',
      columns: [t.cardId, t.ownerId],
      foreignColumns: [boardCards.id, boardCards.ownerId],
    }).onDelete('restrict'),
    inOwnProject('board_followups_project_fk', t),
    index('board_followups_card_idx')
      .on(t.cardId, t.position)
      .where(sql`${t.archivedAt} is null`),
    check('board_followups_title_check', trimmedLength(t.title, 200)),
    check('board_followups_body_check', sql`length(${t.body}) <= 20000`),
    check(
      'board_followups_price_check',
      sql`${t.price} is null or ${t.price} >= 0`,
    ),
  ],
)

/**
 * A card's payment ledger, append-only. The lines that count
 * are the deposits, part payments and finals that no `void` row strikes.
 * `received_on` is the day the money reached the owner's account, in the
 * project's own calendar — the day it counts as money in.
 */
export const boardCardPayments = pgTable(
  'board_card_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    cardId: uuid('card_id').notNull(),
    projectId: uuid('project_id'),
    kind: text('kind').$type<BoardPaymentKind>().notNull(),
    amount: numeric('amount', {
      precision: 12,
      scale: 2,
      mode: 'string',
    }).notNull(),
    currency: text('currency').notNull(),
    receivedOn: date('received_on', { mode: 'string' }).notNull(),
    note: text('note').notNull().default(''),
    /** A `void` row names the payment it strikes. */
    voidsId: uuid('voids_id'),
    createdBy: uuid('created_by')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('board_card_payments_owner_scope_key').on(t.id, t.ownerId),
    foreignKey({
      name: 'board_card_payments_card_fk',
      columns: [t.cardId, t.ownerId],
      foreignColumns: [boardCards.id, boardCards.ownerId],
    }).onDelete('restrict'),
    inOwnProject('board_card_payments_project_fk', t),
    foreignKey({
      name: 'board_card_payments_voids_fk',
      columns: [t.voidsId, t.ownerId],
      foreignColumns: [t.id, t.ownerId],
    }).onDelete('restrict'),
    uniqueIndex('board_card_payments_voids_key')
      .on(t.voidsId)
      .where(sql`${t.voidsId} is not null`),
    index('board_card_payments_card_idx').on(t.cardId, t.createdAt),
    index('board_card_payments_owner_idx').on(t.ownerId, t.receivedOn),
    check('board_card_payments_kind_check', oneOf(t.kind, BOARD_PAYMENT_KINDS)),
    check('board_card_payments_amount_check', sql`${t.amount} > 0`),
    check(
      'board_card_payments_currency_check',
      sql`${t.currency} ~ '^[A-Z]{3}$'`,
    ),
    check('board_card_payments_note_check', sql`length(${t.note}) <= 200`),
    check(
      'board_card_payments_void_check',
      sql`(${t.kind} = 'void') = (${t.voidsId} is not null)`,
    ),
  ],
)

export type BoardBoardRow = typeof boardBoards.$inferSelect
export type BoardLaneRow = typeof boardLanes.$inferSelect
export type BoardCardRow = typeof boardCards.$inferSelect
export type BoardCardEventRow = typeof boardCardEvents.$inferSelect
export type BoardFollowupRow = typeof boardFollowups.$inferSelect
export type BoardCardPaymentRow = typeof boardCardPayments.$inferSelect
