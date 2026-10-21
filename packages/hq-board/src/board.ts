import { activeClient } from '@theiceji/hq-core/clients'
import { LANE_PRESETS } from '@theiceji/hq-core/modules'
import { parseAmount, sumAmounts } from '@theiceji/hq-core/money'
import {
  type BoardCardEventKind,
  type BoardLaneRole,
  PROJECT_COLOR_NAMES,
  type ProjectColor,
} from '@theiceji/hq-db/enums'
import {
  type BoardBoardRow,
  type BoardCardEventRow,
  type BoardCardPaymentRow,
  type BoardCardRow,
  type BoardFollowupRow,
  type BoardLaneRow,
  boardBoards,
  boardCardEvents,
  boardCardPayments,
  boardCards,
  boardFollowups,
  boardLanes,
  clients,
  type ProjectRow,
  projects,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan, can } from '@theiceji/hq-ops/access'
import {
  conflict,
  invalid,
  notFound,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  day,
  idempotencyKey,
  optionalChoice,
  optionalRecordId,
  parseInput,
  recordId,
  revision,
  stringList,
  text,
} from '@theiceji/hq-ops/schemas'
import {
  assertModuleOn,
  audit,
  authorize,
  ownedProject,
  ownedRecord,
  ownedRow,
  type Reader,
  returned,
  runOperation,
  type Tx,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { auditSnapshot, diffFields } from '@theiceji/hq-ops/values'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { linkCounts } from './links'

/**
 * Board: the project's cards in its kind's lanes.
 *
 * · **One board per project, made on first open** from `LANE_PRESETS[kind]`
 *   by whoever may write to it — the owner opening the page, or an agent's
 *   first card. A reader who may not write just sees no board yet.
 * · **Every change is one transaction**: the card, its history row and the
 *   audit event together. Moves renumber the target lane so positions stay
 *   0…n-1.
 * · **Mark paid is the owner's** (`owner_only`): it needs the card in the
 *   board's awaiting-payment lane, sets `paid_at` and archives it — the lane's
 *   pending sum drops by its price. Undo is `unmarkPaid`, which puts it back.
 * · **Money is a decimal string** in the card's currency (the project's by
 *   default); sums run in SQL `numeric`, never in floats.
 * · **A card's money is its `total`**: its own price plus its
 *   follow-ups' (./followups), stored on the card by every write that changes
 *   either. What came in is `paid_total`, the payments ledger's sum
 *   (./payments); what the card still owes is `total − paid_total`. The
 *   awaiting-payment lane, Home's pending money and the rail read what is
 *   owed; Readings reads each payment on the day it came in.
 * · **Client** is a record in HQ's Clients (`client_id`) or a name
 *   used once on the card (`client`), never both; **colour** is a swatch name.
 * · **Archive and Trash**: Archive keeps a finished card for
 *   the record; Delete moves it to the Trash (`deleted_at`, always on an
 *   archived card). Only `listCards({ bucket: 'trash' })` and `getCard` read
 *   a card in the Trash — it is never work, never money, never in a count.
 * · **Lanes are the owner's to shape**: add, rename, move, delete — each in
 *   one transaction under the board's lane lock, positions kept 0…n-1, the
 *   awaiting-payment lane always last (it is drawn pinned right).
 */

registerConstraintMessages({
  board_lanes_awaiting_key: 'A board has one awaiting-payment lane.',
  board_lanes_position_key: conflict().message,
  board_lanes_name_check: 'A lane name is 1 to 60 characters.',
  board_cards_lane_fk:
    'That lane just changed — reload the board and try again.',
  board_cards_paid_check: 'A paid card is archived with it.',
  board_cards_deleted_check:
    'Money came in on this card, so it can’t be deleted. Void its payments, or archive it.',
  board_cards_price_check: 'A price needs a currency and can’t be negative.',
  board_cards_client_fk: 'That client isn’t one of yours.',
  board_cards_client_one_check:
    'Choose a client, or type a name used once — not both.',
  board_cards_color_check: 'Choose one of the swatches.',
})

/* ── Shapes ─────────────────────────────────────────────────────────── */

export type LaneView = BoardLaneRow & {
  /** Active cards in the lane. */
  count: number
  /** Sum of the active cards' totals in `currency`, or null when none has a price. */
  sum: string | null
  /** What those cards still owe (total − paid, never below zero), or null when none has a price. */
  owed: string | null
  currency: string | null
  /** Cards priced in another currency than `currency` — summed separately, never mixed. */
  otherCurrencies: number
}

export type BoardView = {
  board: BoardBoardRow
  lanes: LaneView[]
  /** Active cards, lane by lane in lane order, each lane in its own order. */
  cards: BoardCardRow[]
  /** The live follow-ups of those cards, card by card in their order. */
  followups: BoardFollowupRow[]
  /** Every payment line of those cards — voids too, so a struck line stays visible. */
  payments: BoardCardPaymentRow[]
  /** Prompts and files per card. */
  links: CardExtras['links']
}

export type CardExtras = {
  followups: BoardFollowupRow[]
  payments: BoardCardPaymentRow[]
  /** Prompts and files per card, its follow-ups' included (the tile's ✎ and ▣). */
  links: { cardId: string; prompts: number; files: number }[]
}

/** The follow-ups, payment lines and link counts of some cards — read with them, one query each. */
export async function cardExtras(
  reader: Reader,
  ownerId: string,
  cardIds: readonly string[],
): Promise<CardExtras> {
  if (cardIds.length === 0) return { followups: [], payments: [], links: [] }
  const ids = [...new Set(cardIds)]
  const [followups, payments, links] = await Promise.all([
    reader
      .select()
      .from(boardFollowups)
      .where(
        and(
          eq(boardFollowups.ownerId, ownerId),
          inArray(boardFollowups.cardId, ids),
          isNull(boardFollowups.archivedAt),
        ),
      )
      .orderBy(
        asc(boardFollowups.cardId),
        asc(boardFollowups.position),
        asc(boardFollowups.createdAt),
      ),
    reader
      .select()
      .from(boardCardPayments)
      .where(
        and(
          eq(boardCardPayments.ownerId, ownerId),
          inArray(boardCardPayments.cardId, ids),
        ),
      )
      .orderBy(
        asc(boardCardPayments.receivedOn),
        asc(boardCardPayments.createdAt),
      ),
    linkCounts(reader, ownerId, ids),
  ])
  return { followups, payments, links }
}

export type CardListItem = BoardCardRow & {
  /** The client's name: the record's, or the one used once on the card. */
  clientName: string | null
  laneName: string
  laneRole: BoardLaneRole
  lanePosition: number
  laneCount: number
  project: Pick<
    ProjectRow,
    'id' | 'slug' | 'name' | 'color' | 'status' | 'kind'
  > | null
}

const MAX_LABELS = 12

/** Labels: trimmed, lowercase, no repeats, at most 12 of 32 characters. */
export function normalizeLabels(raw: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of raw) {
    const label = entry.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 32)
    if (label && !out.includes(label)) out.push(label)
  }
  return out.slice(0, MAX_LABELS)
}

/* ── Boards ─────────────────────────────────────────────────────────── */

async function firstBoard(
  reader: Reader,
  ownerId: string,
  projectId: string,
): Promise<BoardBoardRow | null> {
  const [board] = await reader
    .select()
    .from(boardBoards)
    .where(
      and(
        eq(boardBoards.ownerId, ownerId),
        eq(boardBoards.projectId, projectId),
        isNull(boardBoards.archivedAt),
      ),
    )
    .orderBy(asc(boardBoards.position), asc(boardBoards.createdAt))
    .limit(1)
  return board ?? null
}

/**
 * The project's board, made from its kind's preset when it has none yet.
 * Runs inside the caller's transaction, under a per-project lock so two
 * first opens make one board.
 */
export async function ensureProjectBoard(
  tx: Tx,
  actor: Actor,
  project: ProjectRow,
): Promise<BoardBoardRow> {
  const existing = await firstBoard(tx, actor.userId, project.id)
  if (existing) return existing
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`board:${project.id}`}, 0))`,
  )
  const again = await firstBoard(tx, actor.userId, project.id)
  if (again) return again
  const [row] = await tx
    .insert(boardBoards)
    .values({
      ownerId: actor.userId,
      createdBy: actor.userId,
      projectId: project.id,
      name: project.name,
      preset: project.kind,
    })
    .returning()
  const board = returned(row)
  await tx.insert(boardLanes).values(
    LANE_PRESETS[project.kind].map((lane, position) => ({
      ownerId: actor.userId,
      boardId: board.id,
      name: lane.name,
      role: lane.role,
      position,
    })),
  )
  await audit(tx, actor, {
    projectId: project.id,
    action: 'board.create',
    targetType: 'board',
    targetId: board.id,
    afterRevision: board.revision,
    changes: {
      preset: project.kind,
      lanes: LANE_PRESETS[project.kind].map((lane) => lane.name),
    },
  })
  return board
}

async function lanesOf(
  reader: Reader,
  boardId: string,
): Promise<BoardLaneRow[]> {
  return reader
    .select()
    .from(boardLanes)
    .where(eq(boardLanes.boardId, boardId))
    .orderBy(asc(boardLanes.position))
}

async function laneTotals(reader: Reader, boardId: string) {
  return reader
    .select({
      laneId: boardCards.laneId,
      currency: boardCards.currency,
      count: sql<number>`count(*)::int`,
      priced: sql<number>`count(${boardCards.total})::int`,
      sum: sql<string | null>`sum(${boardCards.total})::text`,
      owed: sql<
        string | null
      >`sum(greatest(${boardCards.total} - ${boardCards.paidTotal}, 0))::numeric(12, 2)::text`,
    })
    .from(boardCards)
    .where(and(eq(boardCards.boardId, boardId), isNull(boardCards.archivedAt)))
    .groupBy(boardCards.laneId, boardCards.currency)
}

async function readBoard(
  reader: Reader,
  board: BoardBoardRow,
  fallbackCurrency: string,
): Promise<BoardView> {
  const [lanes, totals, cards] = await Promise.all([
    lanesOf(reader, board.id),
    laneTotals(reader, board.id),
    reader
      .select({ card: boardCards })
      .from(boardCards)
      .innerJoin(boardLanes, eq(boardLanes.id, boardCards.laneId))
      .where(
        and(eq(boardCards.boardId, board.id), isNull(boardCards.archivedAt)),
      )
      .orderBy(
        asc(boardLanes.position),
        asc(boardCards.position),
        asc(boardCards.createdAt),
      ),
  ])
  const extras = await cardExtras(
    reader,
    board.ownerId,
    cards.map((row) => row.card.id),
  )
  return {
    board,
    ...extras,
    lanes: lanes.map((lane) => {
      const rows = totals.filter((row) => row.laneId === lane.id)
      const count = rows.reduce((n, row) => n + row.count, 0)
      const priced = rows.filter((row) => row.priced > 0 && row.currency)
      // The lane's currency is the one most of its priced cards use — the
      // project's in practice; any other is counted, never added in.
      const main =
        priced.find((row) => row.currency === fallbackCurrency) ??
        [...priced].sort((a, b) => b.priced - a.priced)[0] ??
        null
      return {
        ...lane,
        count,
        sum: main?.sum ?? null,
        owed: main?.owed ?? null,
        currency: main?.currency ?? null,
        otherCurrencies: priced
          .filter((row) => row !== main)
          .reduce((n, row) => n + row.priced, 0),
      }
    }),
    cards: cards.map((row) => row.card),
  }
}

/**
 * The project's board with its lanes, lane totals and active cards. The owner
 * (or a connection that may write to Board) makes it on first open; anyone
 * else gets null until it exists.
 */
export async function openBoard(
  actor: Actor,
  projectId: string,
): Promise<BoardView | null> {
  const found = await withReader(async (db) => {
    const project = await ownedProject(db, actor, projectId, 'board', 'read')
    assertModuleOn(project, 'board')
    const board = await firstBoard(db, actor.userId, project.id)
    return { project, board }
  })
  if (found.board)
    return withReader((db) =>
      readBoard(db, found.board as BoardBoardRow, found.project.currency),
    )
  if (!can(actor, 'board', 'write') || found.project.status === 'archived')
    return null
  const board = await withTransaction(async (tx) => {
    const project = await ownedProject(tx, actor, projectId, 'board', 'write')
    assertModuleOn(project, 'board')
    return ensureProjectBoard(tx, actor, project)
  })
  return withReader((db) => readBoard(db, board, found.project.currency))
}

/**
 * Every project board the owner has, with its lanes — for the everywhere
 * page, which moves cards and adds them across projects. Boards are never
 * made here; a project without one gets it with its first card.
 */
export async function listBoards(
  actor: Actor,
): Promise<
  { projectId: string; board: BoardBoardRow; lanes: BoardLaneRow[] }[]
> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'board', 'read')
    const rows = await db
      .select({ board: boardBoards, lane: boardLanes })
      .from(boardBoards)
      .innerJoin(boardLanes, eq(boardLanes.boardId, boardBoards.id))
      .where(
        and(
          eq(boardBoards.ownerId, actor.userId),
          isNull(boardBoards.archivedAt),
          sql`${boardBoards.projectId} is not null`,
        ),
      )
      .orderBy(
        asc(boardBoards.position),
        asc(boardBoards.createdAt),
        asc(boardLanes.position),
      )
    const out = new Map<
      string,
      { projectId: string; board: BoardBoardRow; lanes: BoardLaneRow[] }
    >()
    for (const { board, lane } of rows) {
      const projectId = board.projectId as string
      const entry = out.get(projectId)
      // The first board of a project is its board.
      if (entry && entry.board.id !== board.id) continue
      if (entry) entry.lanes.push(lane)
      else out.set(projectId, { projectId, board, lanes: [lane] })
    }
    return [...out.values()]
  })
}

/* ── Reading cards ──────────────────────────────────────────────────── */

const listSchema = z.object({
  projectId: z.uuid().optional(),
  boardId: z.uuid().optional(),
  laneId: z.uuid().optional(),
  label: z.string().trim().toLowerCase().max(32).optional(),
  /** Only lanes of this role — `awaiting_payment` for what's owed. */
  role: z.enum(['normal', 'awaiting_payment', 'done']).optional(),
  /** Only one client's cards (Clients). */
  clientId: z.uuid().optional(),
  /**
   * Which cards: `live` (on the board, the default), `archived` (put away,
   * not deleted) or `trash` (deleted). The Archived and Trash views read
   * theirs; nothing else asks for the Trash.
   */
  bucket: z.enum(['live', 'archived', 'trash']).optional(),
  /** With `live`: archived cards too — never the ones in the Trash. */
  includeArchived: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

export type ListCardsInput = z.input<typeof listSchema>

/** Which cards a list reads — the Trash only when asked for by name. */
function bucketWhere(input: z.output<typeof listSchema>) {
  if (input.bucket === 'trash') return isNotNull(boardCards.deletedAt)
  if (input.bucket === 'archived')
    return and(isNotNull(boardCards.archivedAt), isNull(boardCards.deletedAt))
  return input.includeArchived
    ? isNull(boardCards.deletedAt)
    : isNull(boardCards.archivedAt)
}

/**
 * Cards across the owner's boards — one project's, or every project with
 * Board on (the global `/board` table and `board_list_cards`). Paused
 * projects are included; archived projects and archived cards are not,
 * unless asked; a card in the Trash only in the `trash` bucket. Archived and
 * Trash read newest first; live cards in lane order.
 */
export async function listCards(
  actor: Actor,
  raw: ListCardsInput = {},
): Promise<CardListItem[]> {
  const input = parseInput(listSchema, raw)
  const shelved =
    input.bucket === 'trash'
      ? boardCards.deletedAt
      : input.bucket === 'archived'
        ? boardCards.archivedAt
        : null
  return withReader(async (db) => {
    if (input.projectId) {
      const project = await ownedProject(
        db,
        actor,
        input.projectId,
        'board',
        'read',
      )
      assertModuleOn(project, 'board')
    } else {
      await authorize(db, actor, null, 'board', 'read')
    }
    const counts = db
      .select({
        laneId: boardCards.laneId,
        n: sql<number>`count(*)::int`.as('n'),
      })
      .from(boardCards)
      .where(
        and(
          eq(boardCards.ownerId, actor.userId),
          isNull(boardCards.archivedAt),
        ),
      )
      .groupBy(boardCards.laneId)
      .as('lane_counts')
    const rows = await db
      .select({
        card: boardCards,
        lane: boardLanes,
        project: {
          id: projects.id,
          slug: projects.slug,
          name: projects.name,
          color: projects.color,
          status: projects.status,
          kind: projects.kind,
        },
        laneCount: counts.n,
        clientName: clients.name,
      })
      .from(boardCards)
      .innerJoin(boardLanes, eq(boardLanes.id, boardCards.laneId))
      .leftJoin(projects, eq(projects.id, boardCards.projectId))
      .leftJoin(counts, eq(counts.laneId, boardCards.laneId))
      .leftJoin(clients, eq(clients.id, boardCards.clientId))
      .where(
        and(
          eq(boardCards.ownerId, actor.userId),
          input.projectId
            ? eq(boardCards.projectId, input.projectId)
            : undefined,
          input.boardId ? eq(boardCards.boardId, input.boardId) : undefined,
          input.laneId ? eq(boardCards.laneId, input.laneId) : undefined,
          input.role ? eq(boardLanes.role, input.role) : undefined,
          input.clientId ? eq(boardCards.clientId, input.clientId) : undefined,
          input.label
            ? sql`${input.label} = any(${boardCards.labels})`
            : undefined,
          bucketWhere(input),
          // A project that is archived — or has Board off — keeps its cards
          // but leaves the everywhere-list.
          input.projectId
            ? undefined
            : sql`(${boardCards.projectId} is null or (${projects.status} <> 'archived' and ${projects.modules} -> 'enabled' ? 'board'))`,
        ),
      )
      .orderBy(
        ...(shelved
          ? [desc(shelved), desc(boardCards.updatedAt)]
          : [
              asc(projects.position),
              asc(boardLanes.position),
              asc(boardCards.position),
              desc(boardCards.createdAt),
            ]),
      )
      .limit(input.limit ?? 300)
    return rows.map((row) => ({
      ...row.card,
      clientName: row.clientName ?? row.card.client,
      laneName: row.lane.name,
      laneRole: row.lane.role,
      lanePosition: row.lane.position,
      laneCount: row.laneCount ?? 0,
      project: row.project?.id ? row.project : null,
    }))
  })
}

export type CardDetail = {
  card: BoardCardRow
  lane: BoardLaneRow
  lanes: BoardLaneRow[]
  project: ProjectRow | null
  events: BoardCardEventRow[]
  followups: BoardFollowupRow[]
  payments: BoardCardPaymentRow[]
  links: CardExtras['links']
}

/**
 * One card with its board's lanes and its newest history first — a card in
 * the Trash too, for the Trash view's inspector (`card.deletedAt` says so;
 * a caller that must not see the Trash checks it).
 */
export async function getCard(
  actor: Actor,
  cardId: string,
): Promise<CardDetail> {
  return withReader(async (db) => {
    const { row: card, project } = await ownedRecord<BoardCardRow>(
      db,
      actor,
      boardCards,
      cardId,
      'board',
      'read',
      'Card',
    )
    const [lanes, events, extras] = await Promise.all([
      lanesOf(db, card.boardId),
      db
        .select()
        .from(boardCardEvents)
        .where(eq(boardCardEvents.cardId, card.id))
        .orderBy(desc(boardCardEvents.occurredAt))
        .limit(50),
      cardExtras(db, card.ownerId, [card.id]),
    ])
    const lane = lanes.find((entry) => entry.id === card.laneId)
    if (!lane) throw notFound('Lane')
    return { card, lane, lanes, project, events, ...extras }
  })
}

/* ── Writing cards ──────────────────────────────────────────────────── */

type CardFields = {
  title?: string | null
  body?: string | null
  labels?: string[]
  price?: string | number | null
  currency?: string | null
  dueOn?: string | null
  /** A name used once on this card only. */
  client?: string | null
  /** A record in Clients. */
  clientId?: string | null
  color?: ProjectColor | null
}

const cardFields = {
  body: text.optional('Body', 20000),
  labels: stringList('labels', MAX_LABELS, 32).optional(),
  /** An amount (`36000`, `"36,000.50"`); null or `""` clears it. */
  price: z.union([z.string(), z.number()]).nullable().optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, like THB.')
    .nullable()
    .optional(),
  dueOn: day('Due date'),
  /** A name used once on this card only; null or `""` clears it. */
  client: text.optional('Client', 120),
  /** A client from Clients; null clears it. */
  clientId: optionalRecordId('Client'),
  color: optionalChoice(
    PROJECT_COLOR_NAMES as [ProjectColor, ...ProjectColor[]],
    'Choose one of the swatches.',
  ),
}

/**
 * Who the work is for, as stored: a Clients record (active, the owner's) or a
 * name used once — setting one clears the other. Undefined when neither was
 * sent.
 */
async function clientOf(
  tx: Tx,
  actor: Actor,
  input: { client?: string | null; clientId?: string | null },
): Promise<{ clientId: string | null; client: string | null } | undefined> {
  if (input.clientId && input.client)
    throw invalid('Choose a client, or type a name used once — not both.', {
      clientId: 'Choose one.',
    })
  if (input.clientId)
    return {
      clientId: (await activeClient(tx, actor, input.clientId)).id,
      client: null,
    }
  if (input.client) return { clientId: null, client: input.client }
  if (input.clientId === null || input.client === null)
    return { clientId: null, client: null }
  return undefined
}

/**
 * The card's stored money after a change: `total` from its (new) price and
 * its live follow-ups, `paid_total` from the payments that count. Call inside
 * the transaction of the write, with the price the card will have.
 */
export async function moneyOf(
  tx: Tx,
  card: Pick<BoardCardRow, 'id' | 'currency'>,
  price: string | null,
  currency: string | null = card.currency,
): Promise<{ total: string | null; paidTotal: string }> {
  const [followups, paid] = await Promise.all([
    tx
      .select({
        sum: sql<string | null>`sum(${boardFollowups.price})::text`,
        priced: sql<number>`count(${boardFollowups.price})::int`,
      })
      .from(boardFollowups)
      .where(
        and(
          eq(boardFollowups.cardId, card.id),
          isNull(boardFollowups.archivedAt),
        ),
      ),
    tx
      .select({
        sum: sql<string>`coalesce(sum(${boardCardPayments.amount}), 0)::text`,
      })
      .from(boardCardPayments)
      .where(countingPayments(card.id)),
  ])
  const priced = followups[0]?.priced ?? 0
  const code = currency ?? 'THB'
  return {
    total:
      price === null && priced === 0
        ? null
        : sumAmounts([price ?? '0', followups[0]?.sum ?? '0'], code),
    paidTotal: sumAmounts([paid[0]?.sum ?? '0'], code),
  }
}

/** The payment lines of a card that count: deposits, parts and finals no void strikes. */
export function countingPayments(cardId: string) {
  return and(
    eq(boardCardPayments.cardId, cardId),
    ne(boardCardPayments.kind, 'void'),
    sql`not exists (select 1 from ${boardCardPayments} as v where v.voids_id = ${boardCardPayments.id})`,
  )
}

/** Price and currency as stored: both null, or an amount in a currency. */
function money(
  input: { price?: string | number | null; currency?: string | null },
  fallback: string,
): { price: string | null; currency: string | null } | undefined {
  if (input.price === undefined && input.currency === undefined)
    return undefined
  if (input.price === null || input.price === '')
    return { price: null, currency: null }
  const currency = input.currency ?? fallback
  if (input.price === undefined) return undefined
  const parsed = parseAmount(input.price, currency)
  if ('error' in parsed) throw invalid(parsed.error, { price: parsed.error })
  return { price: parsed.ok, currency }
}

export async function writeEvent(
  tx: Tx,
  actor: Actor,
  card: BoardCardRow,
  kind: BoardCardEventKind,
  extra: {
    fromLaneId?: string | null
    toLaneId?: string | null
    amount?: string | null
    currency?: string | null
    data?: Record<string, unknown>
  } = {},
): Promise<void> {
  await tx.insert(boardCardEvents).values({
    ownerId: actor.userId,
    cardId: card.id,
    boardId: card.boardId,
    projectId: card.projectId,
    kind,
    fromLaneId: extra.fromLaneId ?? null,
    toLaneId: extra.toLaneId ?? null,
    amount: extra.amount ?? null,
    currency: extra.currency ?? null,
    actorType: actor.type,
    actorId: actor.id,
    data: extra.data ?? {},
  })
}

/** The next position at the end of a lane's active cards. */
async function endOf(tx: Tx, laneId: string): Promise<number> {
  const [row] = await tx
    .select({
      max: sql<number>`coalesce(max(${boardCards.position}), -1)::int`,
    })
    .from(boardCards)
    .where(and(eq(boardCards.laneId, laneId), isNull(boardCards.archivedAt)))
  return (row?.max ?? -1) + 1
}

/**
 * Renumber a lane's active cards 0…n-1 — with `card` put at `index` (the end
 * when omitted), or just closing the gap one left behind.
 */
async function place(
  tx: Tx,
  laneId: string,
  card?: { id: string; index?: number },
): Promise<void> {
  const rows = await tx
    .select({ id: boardCards.id, position: boardCards.position })
    .from(boardCards)
    .where(
      and(
        eq(boardCards.laneId, laneId),
        isNull(boardCards.archivedAt),
        card ? ne(boardCards.id, card.id) : undefined,
      ),
    )
    .orderBy(asc(boardCards.position), asc(boardCards.createdAt))
  const order = rows.map((row) => row.id)
  if (card) {
    const at =
      card.index === undefined
        ? order.length
        : Math.max(0, Math.min(card.index, order.length))
    order.splice(at, 0, card.id)
  }
  const current = new Map(rows.map((row) => [row.id, row.position]))
  for (const [position, id] of order.entries()) {
    if (id !== card?.id && current.get(id) === position) continue
    await tx.update(boardCards).set({ position }).where(eq(boardCards.id, id))
  }
}

const createSchema = z.object({
  projectId: recordId('Project'),
  laneId: z.uuid({ error: 'Lane not found.' }).optional(),
  title: text.required('Title', 200),
  ...cardFields,
  idempotencyKey: idempotencyKey.optional(),
})

export type CreateCardInput = z.input<typeof createSchema>

/**
 * A new card inside the caller's transaction — for `createCard` and for the
 * target registry (a note promoted to a card, an accepted proposal). The
 * project's board is made first if it has none.
 */
export async function insertCard(
  tx: Tx,
  actor: Actor,
  project: ProjectRow,
  input: Omit<CardFields, 'title'> & { title: string; laneId?: string },
): Promise<BoardCardRow> {
  assertModuleOn(project, 'board')
  const board = await ensureProjectBoard(tx, actor, project)
  const lanes = await lanesOf(tx, board.id)
  const lane = input.laneId
    ? lanes.find((entry) => entry.id === input.laneId)
    : lanes[0]
  if (!lane) throw notFound('Lane')
  const priced = money(input, project.currency)
  const who = await clientOf(tx, actor, input)
  const [row] = await tx
    .insert(boardCards)
    .values({
      ownerId: actor.userId,
      createdBy: actor.userId,
      boardId: board.id,
      laneId: lane.id,
      projectId: project.id,
      title: input.title,
      body: input.body ?? '',
      labels: normalizeLabels(input.labels ?? []),
      price: priced?.price ?? null,
      total: priced?.price ?? null,
      currency: priced?.currency ?? null,
      dueOn: input.dueOn ?? null,
      client: who?.client ?? null,
      clientId: who?.clientId ?? null,
      color: input.color ?? null,
      position: await endOf(tx, lane.id),
    })
    .returning()
  const card = returned(row)
  await writeEvent(tx, actor, card, 'created', {
    toLaneId: lane.id,
    amount: card.price,
    currency: card.currency,
  })
  await audit(tx, actor, {
    projectId: project.id,
    action: 'board.card.create',
    targetType: 'card',
    targetId: card.id,
    afterRevision: card.revision,
    changes: auditSnapshot({
      title: card.title,
      lane: lane.name,
      price: card.price,
      currency: card.currency,
      dueOn: card.dueOn,
      labels: card.labels,
      clientId: card.clientId,
      client: card.client,
      color: card.color,
    }),
  })
  return card
}

export async function createCard(
  actor: Actor,
  raw: CreateCardInput,
): Promise<BoardCardRow> {
  const input = parseInput(createSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'board_create_card',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const project = await ownedProject(
          tx,
          actor,
          input.projectId,
          'board',
          'write',
        )
        return insertCard(tx, actor, project, {
          ...input,
          title: input.title as string,
        })
      }),
  )
  if (outcome.kind === 'replay') {
    // The stored answer names the card; the first audited target may be the
    // board this call made on its way.
    const id = outcome.response?.card_id
    if (typeof id !== 'string') throw conflict()
    return (await getCard(actor, id)).card
  }
  await outcome.complete({ card_id: outcome.value.id })
  return outcome.value
}

/** Load a card for a write, locked, with its project; checks the revision. */
export async function cardForWrite(
  tx: Tx,
  actor: Actor,
  cardId: string,
  expectedRevision: number,
  requirement?: 'owner_only',
): Promise<{ card: BoardCardRow; project: ProjectRow | null }> {
  assertCan(actor, 'board', 'write')
  const { row: card, project } = await ownedRow<BoardCardRow>(
    tx,
    actor,
    boardCards,
    cardId,
    'Card',
    { lock: true },
  )
  await authorize(tx, actor, project, 'board', 'write', requirement)
  if (project) assertModuleOn(project, 'board')
  if (card.revision !== expectedRevision) throw conflict()
  return { card, project }
}

export async function saveCard(
  tx: Tx,
  card: BoardCardRow,
  patch: PgUpdateSetSource<typeof boardCards>,
): Promise<BoardCardRow> {
  const [row] = await tx
    .update(boardCards)
    .set({
      ...patch,
      revision: sql`${boardCards.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(boardCards.id, card.id), eq(boardCards.revision, card.revision)),
    )
    .returning()
  if (!row) throw conflict()
  return row
}

const updateSchema = z.object({
  cardId: recordId('Card'),
  expectedRevision: revision,
  title: text.required('Title', 200).optional(),
  ...cardFields,
  idempotencyKey: idempotencyKey.optional(),
})

export type UpdateCardInput = z.input<typeof updateSchema>

/**
 * Title, body, labels, price, due date, client and colour. Absent fields stay
 * as they are. The currency can't change once follow-ups carry prices or
 * money came in — they are counted in it.
 */
export async function updateCard(
  actor: Actor,
  raw: UpdateCardInput,
): Promise<BoardCardRow> {
  const input = parseInput(updateSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'board_update_card',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { card, project } = await cardForWrite(
          tx,
          actor,
          input.cardId,
          input.expectedRevision,
        )
        if (card.archivedAt)
          throw invalid('This card is archived. Restore it to change it.')
        const patch: Partial<typeof boardCards.$inferInsert> = {}
        if (input.title !== undefined) patch.title = input.title as string
        if (input.body !== undefined) patch.body = input.body ?? ''
        if (input.labels !== undefined)
          patch.labels = normalizeLabels(input.labels)
        if (input.dueOn !== undefined) patch.dueOn = input.dueOn ?? null
        if (input.color !== undefined) patch.color = input.color ?? null
        const who = await clientOf(tx, actor, input)
        if (who) {
          patch.client = who.client
          patch.clientId = who.clientId
        }
        const priced = money(
          { price: input.price, currency: input.currency ?? card.currency },
          project?.currency ?? 'THB',
        )
        if (priced) {
          patch.price = priced.price
          // Clearing the price keeps the currency the follow-ups and payments are in.
          patch.currency = priced.currency ?? card.currency
        }
        if (
          patch.currency !== undefined &&
          card.currency !== null &&
          patch.currency !== card.currency &&
          (card.paidTotal !== '0.00' || card.total !== card.price)
        )
          throw invalid(
            'This card’s follow-ups or payments are counted in its currency — it can’t change now.',
            { currency: 'Keep the card’s currency.' },
          )
        if (patch.price !== undefined) {
          const counted = await moneyOf(
            tx,
            card,
            patch.price ?? null,
            patch.currency ?? card.currency,
          )
          patch.total = counted.total
          if (counted.total === null && card.paidTotal === '0.00')
            patch.currency = patch.price === null ? null : patch.currency
        }
        const changes = diffFields(
          card as unknown as Record<string, unknown>,
          patch,
        )
        if (Object.keys(changes).length === 0) return card
        const saved = await saveCard(tx, card, patch)
        const repriced = 'price' in changes || 'currency' in changes
        await writeEvent(tx, actor, saved, repriced ? 'priced' : 'edited', {
          amount: repriced ? saved.price : null,
          currency: repriced ? saved.currency : null,
          data: {
            fields: Object.keys(changes).filter((field) => field !== 'total'),
            ...(repriced ? { total: saved.total } : {}),
          },
        })
        await audit(tx, actor, {
          projectId: saved.projectId,
          action: 'board.card.update',
          targetType: 'card',
          targetId: saved.id,
          beforeRevision: card.revision,
          afterRevision: saved.revision,
          changes,
        })
        return saved
      }),
  )
  if (outcome.kind === 'replay')
    return (await getCard(actor, input.cardId)).card
  await outcome.complete({
    card_id: outcome.value.id,
    revision: outcome.value.revision,
  })
  return outcome.value
}

const moveSchema = z.object({
  cardId: recordId('Card'),
  expectedRevision: revision,
  laneId: recordId('Lane'),
  /** Index inside the target lane; the end when omitted. */
  position: z.number().int().min(0).max(10000).optional(),
  idempotencyKey: idempotencyKey.optional(),
})

export type MoveCardInput = z.input<typeof moveSchema>

/** Move a card to another lane of its board (or to another place in its own). */
export async function moveCard(
  actor: Actor,
  raw: MoveCardInput,
): Promise<BoardCardRow> {
  const input = parseInput(moveSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'board_move_card',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { card } = await cardForWrite(
          tx,
          actor,
          input.cardId,
          input.expectedRevision,
        )
        if (card.archivedAt)
          throw invalid('This card is archived. Restore it to move it.')
        const lanes = await lanesOf(tx, card.boardId)
        const to = lanes.find((lane) => lane.id === input.laneId)
        if (!to)
          throw invalid('That lane isn’t on this card’s board.', {
            laneId: 'Choose a lane of this board.',
          })
        const from = lanes.find((lane) => lane.id === card.laneId)
        await lockLanes(tx, card.boardId)
        const saved = await saveCard(tx, card, { laneId: to.id })
        await place(tx, to.id, { id: card.id, index: input.position })
        if (from && from.id !== to.id) await place(tx, from.id)
        const [placed] = await tx
          .select()
          .from(boardCards)
          .where(eq(boardCards.id, card.id))
        const result = placed ?? saved
        if (from?.id !== to.id) {
          await writeEvent(tx, actor, result, 'moved', {
            fromLaneId: from?.id ?? null,
            toLaneId: to.id,
          })
          await audit(tx, actor, {
            projectId: result.projectId,
            action: 'board.card.move',
            targetType: 'card',
            targetId: result.id,
            beforeRevision: card.revision,
            afterRevision: result.revision,
            changes: { lane: { from: from?.name ?? null, to: to.name } },
          })
        }
        return result
      }),
  )
  if (outcome.kind === 'replay')
    return (await getCard(actor, input.cardId)).card
  await outcome.complete({
    card_id: outcome.value.id,
    revision: outcome.value.revision,
  })
  return outcome.value
}

const decideSchema = z.object({
  cardId: recordId('Card'),
  expectedRevision: revision,
})

/**
 * The money came in: the owner marks a card in
 * the awaiting-payment lane paid. What it still owed (total − paid) is
 * recorded as its final payment, on the project's today; the card is archived
 * with `paid_at` in the same write and the lane's pending sum drops. A card
 * paid in full by earlier payments records nothing more. Never an agent's.
 */
export async function markPaid(
  actor: Actor,
  raw: z.input<typeof decideSchema>,
): Promise<BoardCardRow> {
  const input = parseInput(decideSchema, raw)
  return withTransaction(async (tx) => {
    const { card } = await cardForWrite(
      tx,
      actor,
      input.cardId,
      input.expectedRevision,
      'owner_only',
    )
    if (card.archivedAt) throw invalid('This card is already archived.')
    const [lane] = await tx
      .select()
      .from(boardLanes)
      .where(eq(boardLanes.id, card.laneId))
    if (lane?.role !== 'awaiting_payment')
      throw invalid(
        'Only a card in the awaiting-payment lane can be marked paid. Move it there first.',
      )
    const rest =
      card.total !== null && card.currency
        ? sumAmounts([card.total, `-${card.paidTotal}`], card.currency)
        : null
    let finalId: string | null = null
    if (rest !== null && !rest.startsWith('-') && Number(rest) > 0) {
      const [line] = await tx
        .insert(boardCardPayments)
        .values({
          ownerId: actor.userId,
          cardId: card.id,
          projectId: card.projectId,
          kind: 'final',
          amount: rest,
          currency: card.currency as string,
          receivedOn: sql`(now() at time zone coalesce((select ${projects.timezone} from ${projects} where ${projects.id} = ${card.projectId}), 'Asia/Bangkok'))::date`,
          createdBy: actor.userId,
        })
        .returning({ id: boardCardPayments.id })
      finalId = line?.id ?? null
    }
    const counted = await moneyOf(tx, card, card.price)
    const saved = await saveCard(tx, card, {
      paidAt: sql`now()`,
      archivedAt: sql`now()`,
      paidTotal: counted.paidTotal,
    })
    await place(tx, card.laneId)
    await writeEvent(tx, actor, saved, 'paid', {
      amount: saved.total,
      currency: saved.currency,
      data: { finalPaymentId: finalId, rest },
    })
    await audit(tx, actor, {
      projectId: saved.projectId,
      action: 'board.card.mark_paid',
      targetType: 'card',
      targetId: saved.id,
      beforeRevision: card.revision,
      afterRevision: saved.revision,
      changes: {
        total: saved.total,
        currency: saved.currency,
        final: rest,
      },
    })
    return saved
  })
}

/**
 * Undo a Mark paid: the final payment it recorded is struck (a void line —
 * the ledger never loses a row) and the card returns to the end of its lane,
 * unpaid. The owner's.
 */
export async function unmarkPaid(
  actor: Actor,
  raw: z.input<typeof decideSchema>,
): Promise<BoardCardRow> {
  const input = parseInput(decideSchema, raw)
  return withTransaction(async (tx) => {
    const { card } = await cardForWrite(
      tx,
      actor,
      input.cardId,
      input.expectedRevision,
      'owner_only',
    )
    if (!card.paidAt) throw invalid('This card isn’t marked paid.')
    const [paidEvent] = await tx
      .select({ data: boardCardEvents.data })
      .from(boardCardEvents)
      .where(
        and(
          eq(boardCardEvents.cardId, card.id),
          eq(boardCardEvents.kind, 'paid'),
        ),
      )
      .orderBy(desc(boardCardEvents.occurredAt))
      .limit(1)
    const finalId = paidEvent?.data?.finalPaymentId
    if (typeof finalId === 'string') {
      const [line] = await tx
        .select()
        .from(boardCardPayments)
        .where(
          and(eq(boardCardPayments.id, finalId), countingPayments(card.id)),
        )
      if (line)
        await tx.insert(boardCardPayments).values({
          ownerId: actor.userId,
          cardId: card.id,
          projectId: card.projectId,
          kind: 'void',
          amount: line.amount,
          currency: line.currency,
          receivedOn: line.receivedOn,
          note: 'Mark paid undone',
          voidsId: line.id,
          createdBy: actor.userId,
        })
    }
    const counted = await moneyOf(tx, card, card.price)
    const saved = await saveCard(tx, card, {
      paidAt: null,
      archivedAt: null,
      paidTotal: counted.paidTotal,
      position: await endOf(tx, card.laneId),
    })
    await writeEvent(tx, actor, saved, 'unpaid', {
      amount: saved.price,
      currency: saved.currency,
    })
    await audit(tx, actor, {
      projectId: saved.projectId,
      action: 'board.card.unmark_paid',
      targetType: 'card',
      targetId: saved.id,
      beforeRevision: card.revision,
      afterRevision: saved.revision,
    })
    return saved
  })
}

/** Take a card off the board, or put it back (at the end of its lane). The owner's. */
export async function setCardArchived(
  actor: Actor,
  raw: z.input<typeof decideSchema> & { archived: boolean },
): Promise<BoardCardRow> {
  const input = parseInput(decideSchema.extend({ archived: z.boolean() }), raw)
  return withTransaction(async (tx) => {
    const { card } = await cardForWrite(
      tx,
      actor,
      input.cardId,
      input.expectedRevision,
      'owner_only',
    )
    if (Boolean(card.archivedAt) === input.archived) return card
    if (!input.archived && card.paidAt)
      throw invalid(
        'This card was marked paid. Undo the payment to bring it back.',
      )
    if (!input.archived && card.deletedAt)
      throw invalid('This card is in the Trash. Restore it from there.')
    const saved = await saveCard(
      tx,
      card,
      input.archived
        ? { archivedAt: sql`now()` }
        : { archivedAt: null, position: await endOf(tx, card.laneId) },
    )
    if (input.archived) await place(tx, card.laneId)
    await writeEvent(tx, actor, saved, input.archived ? 'archived' : 'restored')
    await audit(tx, actor, {
      projectId: saved.projectId,
      action: input.archived ? 'board.card.archive' : 'board.card.restore',
      targetType: 'card',
      targetId: saved.id,
      beforeRevision: card.revision,
      afterRevision: saved.revision,
    })
    return saved
  })
}

/** What keeps a card out of the Trash, in words — null when it may go. */
export function deleteRefusal(
  card: Pick<BoardCardRow, 'paidAt' | 'paidTotal'>,
): string | null {
  if (card.paidAt)
    return 'This card was marked paid — it stays in Archived for the record.'
  if (Number(card.paidTotal) > 0)
    return 'Money came in on this card, so it can’t be deleted. Void its payments, or archive it.'
  return null
}

/**
 * Delete: the card goes to the Trash — archived if it
 * wasn't, `deleted_at` set, its lane renumbered like an archive — and keeps
 * its history, follow-ups and payment lines. A card with money in can't go
 * (the `board_cards_deleted_check` backs this): its payments are the record
 * of money that came in. Restore puts it back where Delete found it — the
 * end of its lane, or Archived if it was archived — so Undo is exact. The
 * owner's.
 */
export async function setCardDeleted(
  actor: Actor,
  raw: z.input<typeof decideSchema> & { deleted: boolean },
): Promise<BoardCardRow> {
  const input = parseInput(decideSchema.extend({ deleted: z.boolean() }), raw)
  return withTransaction(async (tx) => {
    const { card } = await cardForWrite(
      tx,
      actor,
      input.cardId,
      input.expectedRevision,
      'owner_only',
    )
    if (Boolean(card.deletedAt) === input.deleted) return card
    if (input.deleted) {
      const refused = deleteRefusal(card)
      if (refused) throw invalid(refused)
      const wasArchived = card.archivedAt !== null
      const saved = await saveCard(tx, card, {
        deletedAt: sql`now()`,
        ...(wasArchived ? {} : { archivedAt: sql`now()` }),
      })
      if (!wasArchived) await place(tx, card.laneId)
      await writeEvent(tx, actor, saved, 'deleted', {
        data: { archivedBefore: wasArchived },
      })
      await audit(tx, actor, {
        projectId: saved.projectId,
        action: 'board.card.delete',
        targetType: 'card',
        targetId: saved.id,
        beforeRevision: card.revision,
        afterRevision: saved.revision,
        changes: { title: card.title, archivedBefore: wasArchived },
      })
      return saved
    }
    const [deleted] = await tx
      .select({ data: boardCardEvents.data })
      .from(boardCardEvents)
      .where(
        and(
          eq(boardCardEvents.cardId, card.id),
          eq(boardCardEvents.kind, 'deleted'),
        ),
      )
      .orderBy(desc(boardCardEvents.occurredAt))
      .limit(1)
    // A paid card never reaches the Trash, but one that did would break the
    // paid check off the board: it goes back to Archived.
    const toArchived =
      deleted?.data?.archivedBefore === true || card.paidAt !== null
    const saved = await saveCard(
      tx,
      card,
      toArchived
        ? { deletedAt: null }
        : {
            deletedAt: null,
            archivedAt: null,
            position: await endOf(tx, card.laneId),
          },
    )
    await writeEvent(tx, actor, saved, 'undeleted', {
      data: { to: toArchived ? 'archived' : 'board' },
    })
    await audit(tx, actor, {
      projectId: saved.projectId,
      action: 'board.card.undelete',
      targetType: 'card',
      targetId: saved.id,
      beforeRevision: card.revision,
      afterRevision: saved.revision,
      changes: { to: toArchived ? 'archived' : 'board' },
    })
    return saved
  })
}

/* ── Lanes (the owner's) ───────────────────────────────────────────── */

/** One board's lane writes and card moves, one at a time. */
async function lockLanes(tx: Tx, boardId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`board-lanes:${boardId}`}, 0))`,
  )
}

/**
 * Put a board's lanes in `order` (every lane of the board), positions
 * 0…n-1. `board_lanes_position_key` is checked row by row, so the lanes that
 * move are parked on negative places first and no two ever share one.
 */
async function orderLanes(
  tx: Tx,
  lanes: readonly BoardLaneRow[],
  order: readonly string[],
): Promise<void> {
  const now = new Map(lanes.map((lane) => [lane.id, lane.position]))
  const moving = order.filter((id, position) => now.get(id) !== position)
  for (const [index, id] of moving.entries())
    await tx
      .update(boardLanes)
      .set({ position: -(index + 1) })
      .where(eq(boardLanes.id, id))
  for (const id of moving)
    await tx
      .update(boardLanes)
      .set({ position: order.indexOf(id), updatedAt: sql`now()` })
      .where(eq(boardLanes.id, id))
}

/** The awaiting-payment lane stays last: any other order puts it back there. */
function awaitingLast(lanes: readonly BoardLaneRow[]): string[] {
  return [
    ...lanes.filter((lane) => lane.role !== 'awaiting_payment'),
    ...lanes.filter((lane) => lane.role === 'awaiting_payment'),
  ].map((lane) => lane.id)
}

const laneName = text.required('Lane name', 60)

function assertFreeName(
  lanes: readonly BoardLaneRow[],
  name: string,
  except?: string,
): void {
  const taken = lanes.find(
    (lane) =>
      lane.id !== except && lane.name.toLowerCase() === name.toLowerCase(),
  )
  if (taken)
    throw invalid(`This board already has a lane called “${taken.name}”.`, {
      name: 'Choose another name.',
    })
}

type LaneWrite = {
  lane: BoardLaneRow
  board: BoardBoardRow
  project: ProjectRow | null
  /** Every lane of the board, in order, read under the lane lock. */
  lanes: BoardLaneRow[]
}

/** A lane for the owner to change, with its board's lanes, under the lane lock. */
async function laneForWrite(
  tx: Tx,
  actor: Actor,
  laneId: string,
): Promise<LaneWrite> {
  assertCan(actor, 'board', 'write')
  const [found] = await tx
    .select({ lane: boardLanes, board: boardBoards, project: projects })
    .from(boardLanes)
    .innerJoin(boardBoards, eq(boardBoards.id, boardLanes.boardId))
    .leftJoin(projects, eq(projects.id, boardBoards.projectId))
    .where(and(eq(boardLanes.id, laneId), eq(boardLanes.ownerId, actor.userId)))
    .limit(1)
  if (!found) throw notFound('Lane')
  const project = (found.project as ProjectRow | null) ?? null
  await authorize(tx, actor, project, 'board', 'write', 'owner_only')
  if (project) assertModuleOn(project, 'board')
  await lockLanes(tx, found.board.id)
  const lanes = await lanesOf(tx, found.board.id)
  const lane = lanes.find((entry) => entry.id === laneId)
  if (!lane) throw notFound('Lane')
  return { lane, board: found.board, project, lanes }
}

async function laneAfter(tx: Tx, laneId: string): Promise<BoardLaneRow> {
  const [row] = await tx
    .select()
    .from(boardLanes)
    .where(eq(boardLanes.id, laneId))
  return returned(row)
}

/**
 * A new lane at the end of the ones you work in — just before the
 * awaiting-payment lane, which stays last. The project's board is made first
 * if it has none. The owner's.
 */
export async function createLane(
  actor: Actor,
  raw: { projectId: string; name: string },
): Promise<BoardLaneRow> {
  const input = parseInput(
    z.object({ projectId: recordId('Project'), name: laneName }),
    raw,
  )
  return withTransaction(async (tx) => {
    const project = await ownedProject(
      tx,
      actor,
      input.projectId,
      'board',
      'write',
      'owner_only',
    )
    assertModuleOn(project, 'board')
    const board = await ensureProjectBoard(tx, actor, project)
    await lockLanes(tx, board.id)
    const lanes = await lanesOf(tx, board.id)
    const name = input.name as string
    assertFreeName(lanes, name)
    const [row] = await tx
      .insert(boardLanes)
      .values({
        ownerId: actor.userId,
        boardId: board.id,
        name,
        position: (lanes.at(-1)?.position ?? -1) + 1,
      })
      .returning()
    const lane = returned(row)
    await orderLanes(tx, [...lanes, lane], awaitingLast([...lanes, lane]))
    const placed = await laneAfter(tx, lane.id)
    await audit(tx, actor, {
      projectId: project.id,
      action: 'board.lane.create',
      targetType: 'lane',
      targetId: lane.id,
      changes: { name, position: placed.position },
    })
    return placed
  })
}

/** A lane's new name. The owner's. */
export async function renameLane(
  actor: Actor,
  raw: { laneId: string; name: string },
): Promise<BoardLaneRow> {
  const input = parseInput(
    z.object({ laneId: recordId('Lane'), name: laneName }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { lane, board, lanes } = await laneForWrite(tx, actor, input.laneId)
    const name = input.name as string
    if (name === lane.name) return lane
    assertFreeName(lanes, name, lane.id)
    const [row] = await tx
      .update(boardLanes)
      .set({ name, updatedAt: sql`now()` })
      .where(eq(boardLanes.id, lane.id))
      .returning()
    await audit(tx, actor, {
      projectId: board.projectId,
      action: 'board.lane.rename',
      targetType: 'lane',
      targetId: lane.id,
      changes: { name: { from: lane.name, to: name } },
    })
    return returned(row)
  })
}

/**
 * A lane one place left (-1) or right (1) among the lanes you work in. The
 * awaiting-payment lane doesn't move and nothing moves past it: it is drawn
 * pinned right. The owner's.
 */
export async function moveLane(
  actor: Actor,
  raw: { laneId: string; direction: -1 | 1 },
): Promise<BoardLaneRow> {
  const input = parseInput(
    z.object({
      laneId: recordId('Lane'),
      direction: z.union([z.literal(-1), z.literal(1)], {
        error: 'Move a lane one place left or right.',
      }),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { lane, board, lanes } = await laneForWrite(tx, actor, input.laneId)
    if (lane.role === 'awaiting_payment')
      throw invalid('Awaiting payment stays pinned right, after every lane.')
    const order = awaitingLast(lanes)
    const at = order.indexOf(lane.id)
    const to = at + input.direction
    const other = lanes.find((entry) => entry.id === order[to])
    if (!other || other.role === 'awaiting_payment')
      throw invalid(
        input.direction < 0
          ? 'This lane is already first.'
          : 'This lane is already last before Awaiting payment.',
      )
    order[to] = lane.id
    order[at] = other.id
    await orderLanes(tx, lanes, order)
    const placed = await laneAfter(tx, lane.id)
    await audit(tx, actor, {
      projectId: board.projectId,
      action: 'board.lane.move',
      targetType: 'lane',
      targetId: lane.id,
      changes: { position: { from: lane.position, to: placed.position } },
    })
    return placed
  })
}

/**
 * Delete a lane that holds no live cards. Refused for the awaiting-payment
 * lane (it holds what is owed), a lane with cards on it, and a board's last
 * lane. Its archived and deleted cards move to the first lane left — a card
 * always sits in a lane of its board — each with a `moved` line in its
 * history naming the lane that went. Lanes renumber 0…n-1. Asks first in
 * HQ: there is no Undo. The owner's.
 */
export async function deleteLane(
  actor: Actor,
  raw: { laneId: string },
): Promise<{ lane: BoardLaneRow; moved: number; into: BoardLaneRow | null }> {
  const input = parseInput(z.object({ laneId: recordId('Lane') }), raw)
  return withTransaction(async (tx) => {
    const { lane, board, lanes } = await laneForWrite(tx, actor, input.laneId)
    if (lane.role === 'awaiting_payment')
      throw invalid(
        'Awaiting payment holds what is owed — rename it instead of deleting it.',
      )
    const rest = lanes.filter((entry) => entry.id !== lane.id)
    if (rest.length === 0) throw invalid('A board keeps at least one lane.')
    // Never Awaiting payment: a card restored there would read as money owed.
    const into = rest.find((entry) => entry.role !== 'awaiting_payment')
    if (!into)
      throw invalid(
        'A board keeps one lane to work in besides Awaiting payment.',
      )
    const [live] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(boardCards)
      .where(and(eq(boardCards.laneId, lane.id), isNull(boardCards.archivedAt)))
    const n = live?.n ?? 0
    if (n > 0)
      throw invalid(
        `Move its ${n === 1 ? 'card' : `${n} cards`} to another lane first.`,
      )
    // Only cards off the board move. One restored meanwhile stays, and the
    // lane's delete below is refused by its foreign key instead.
    const shelved = await tx
      .update(boardCards)
      .set({
        laneId: into.id,
        revision: sql`${boardCards.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(boardCards.laneId, lane.id), isNotNull(boardCards.archivedAt)),
      )
      .returning()
    if (shelved.length)
      await tx.insert(boardCardEvents).values(
        shelved.map((card) => ({
          ownerId: actor.userId,
          cardId: card.id,
          boardId: card.boardId,
          projectId: card.projectId,
          kind: 'moved' as const,
          fromLaneId: lane.id,
          toLaneId: into.id,
          actorType: actor.type,
          actorId: actor.id,
          data: { laneDeleted: lane.name },
        })),
      )
    await tx.delete(boardLanes).where(eq(boardLanes.id, lane.id))
    await orderLanes(tx, rest, awaitingLast(rest))
    await audit(tx, actor, {
      projectId: board.projectId,
      action: 'board.lane.delete',
      targetType: 'lane',
      targetId: lane.id,
      changes: {
        name: lane.name,
        position: lane.position,
        movedCards: shelved.length,
        into: shelved.length ? into.name : null,
      },
    })
    return {
      lane,
      moved: shelved.length,
      into: shelved.length ? await laneAfter(tx, into.id) : null,
    }
  })
}

/* ── Summaries (Home, State, the rail) ─────────────────────────────── */

export type BoardSummary = {
  projectId: string
  /** Active cards. */
  cards: number
  /** Active cards whose job is due on the project's today, or overdue (the card and its follow-ups). */
  dueToday: number
  overdue: number
  /** What sits in the awaiting-payment lane, per currency. */
  awaiting: { currency: string; sum: string; cards: number }[]
}

/**
 * One row per project with Board on: how many cards, how many are due, and
 * what waits for payment. `today` is each project's own date (its timezone),
 * computed by the database.
 */
export async function boardSummaries(actor: Actor): Promise<BoardSummary[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'board', 'read')
    // A job's due: the nearest due still ahead among the card
    // and its live follow-ups; overdue only once every one of them has passed.
    const counts = await db.execute<{
      projectId: string
      cards: number
      dueToday: number
      overdue: number
    }>(sql`
      select c.project_id as "projectId",
        count(*)::int as "cards",
        count(*) filter (where d.next = d.today)::int as "dueToday",
        count(*) filter (where d.next is null and d.last < d.today)::int as "overdue"
      from ${boardCards} as c
      join ${projects} as p on p.id = c.project_id
      cross join lateral (
        select min(x.due) filter (where x.due >= t.today) as next, max(x.due) as last, t.today
        from (select (now() at time zone p.timezone)::date as today) as t,
          (select c.due_on as due
           union all
           select f.due_on from ${boardFollowups} as f
           where f.card_id = c.id and f.archived_at is null and f.due_on is not null) as x
        group by t.today
      ) as d
      where c.owner_id = ${actor.userId} and c.archived_at is null
      group by c.project_id`)
    const awaiting = await db
      .select({
        projectId: boardCards.projectId,
        currency: boardCards.currency,
        sum: sql<string>`sum(greatest(${boardCards.total} - ${boardCards.paidTotal}, 0))::numeric(12, 2)::text`,
        cards: sql<number>`count(*)::int`,
      })
      .from(boardCards)
      .innerJoin(boardLanes, eq(boardLanes.id, boardCards.laneId))
      .where(
        and(
          eq(boardCards.ownerId, actor.userId),
          isNull(boardCards.archivedAt),
          eq(boardLanes.role, 'awaiting_payment'),
          sql`${boardCards.total} is not null`,
        ),
      )
      .groupBy(boardCards.projectId, boardCards.currency)
    const ids = new Set(
      [...counts, ...awaiting]
        .map((row) => row.projectId)
        .filter((id): id is string => Boolean(id)),
    )
    return [...ids].map((projectId) => {
      const count = counts.find((row) => row.projectId === projectId)
      return {
        projectId,
        cards: count?.cards ?? 0,
        dueToday: count?.dueToday ?? 0,
        overdue: count?.overdue ?? 0,
        awaiting: awaiting
          .filter((row) => row.projectId === projectId && row.currency)
          .map((row) => ({
            currency: row.currency as string,
            sum: row.sum,
            cards: row.cards,
          })),
      }
    })
  })
}

/**
 * Money that came in since `days` ago — every payment that counts, on the
 * day it came in — per project and currency: the "came in" line on Home.
 */
export async function paidSince(
  actor: Actor,
  days: number,
): Promise<
  { projectId: string | null; currency: string; sum: string; cards: number }[]
> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'board', 'read')
    const rows = await db
      .select({
        projectId: boardCardPayments.projectId,
        currency: boardCardPayments.currency,
        sum: sql<string>`sum(${boardCardPayments.amount})::text`,
        cards: sql<number>`count(distinct ${boardCardPayments.cardId})::int`,
      })
      .from(boardCardPayments)
      .where(
        and(
          eq(boardCardPayments.ownerId, actor.userId),
          ne(boardCardPayments.kind, 'void'),
          sql`not exists (select 1 from ${boardCardPayments} as v where v.voids_id = ${boardCardPayments.id})`,
          sql`${boardCardPayments.receivedOn} >= (now() - make_interval(days => ${Math.max(1, Math.round(days))}))::date`,
        ),
      )
      .groupBy(boardCardPayments.projectId, boardCardPayments.currency)
    return rows
      .filter((row) => row.currency)
      .map((row) => ({ ...row, currency: row.currency as string }))
  })
}

/** Cards with a due date inside `[from, to]` (days), for the calendar overlay and Time. */
export async function cardsDueBetween(
  actor: Actor,
  range: { from: string; to: string; projectId?: string | null },
): Promise<CardListItem[]> {
  const cards = await listCards(
    actor,
    range.projectId ? { projectId: range.projectId } : {},
  )
  return cards.filter(
    (card) =>
      card.dueOn !== null && card.dueOn >= range.from && card.dueOn <= range.to,
  )
}

/**
 * Follow-ups with a due day inside `[from, to]`, with their card — Time and
 * the calendar overlay draw each as its own mark.
 */
export async function followupsDueBetween(
  actor: Actor,
  range: { from: string; to: string; projectId?: string | null },
): Promise<
  (BoardFollowupRow & {
    cardTitle: string
    cardProjectId: string | null
  })[]
> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'board', 'read')
    const rows = await db
      .select({ followup: boardFollowups, card: boardCards })
      .from(boardFollowups)
      .innerJoin(boardCards, eq(boardCards.id, boardFollowups.cardId))
      .where(
        and(
          eq(boardFollowups.ownerId, actor.userId),
          isNull(boardFollowups.archivedAt),
          isNull(boardCards.archivedAt),
          range.projectId
            ? eq(boardFollowups.projectId, range.projectId)
            : undefined,
          sql`${boardFollowups.dueOn} between ${range.from} and ${range.to}`,
        ),
      )
      .orderBy(asc(boardFollowups.dueOn))
    return rows.map((row) => ({
      ...row.followup,
      cardTitle: row.card.title,
      cardProjectId: row.card.projectId,
    }))
  })
}

/* ── Clients ─────────────────────────────────────────── */

export type ClientLedgerRow = {
  clientId: string
  /** Cards on a board now. */
  cards: number
  /** Projects the client has work in: cards on a board, or money this year. */
  projectIds: string[]
  /** What active cards outside the awaiting lane still owe (total − paid), per currency. */
  onBoard: { currency: string; sum: string }[]
  /** What cards in an awaiting-payment lane still owe, per currency. */
  awaiting: { currency: string; sum: string }[]
  /** Every payment that counts, received this calendar year, per currency. */
  paidThisYear: { currency: string; sum: string }[]
  /** When one of the client's cards last changed. */
  lastChange: string | null
}

/**
 * Money per client, each baht once: what came in this year
 * (payments), what is owed in awaiting lanes, and what the rest of the
 * board still holds — both as `total − paid`, so a deposit is never counted
 * twice. Quotes stay out: a quoted card already holds that money. So do the
 * cards of a project in the Trash (an archived project's still count); a
 * card in the Trash has no money to count.
 */
export async function clientLedger(actor: Actor): Promise<ClientLedgerRow[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'board', 'read')
    const owedRows = await db
      .select({
        clientId: boardCards.clientId,
        currency: boardCards.currency,
        awaiting: sql<boolean>`${boardLanes.role} = 'awaiting_payment'`,
        cards: sql<number>`count(*)::int`,
        owed: sql<string>`coalesce(sum(greatest(${boardCards.total} - ${boardCards.paidTotal}, 0)), 0)::numeric(12, 2)::text`,
        projectIds: sql<
          string[]
        >`array_agg(distinct ${boardCards.projectId}) filter (where ${boardCards.projectId} is not null)`,
        lastChange: sql<string | null>`max(${boardCards.updatedAt})::text`,
      })
      .from(boardCards)
      .innerJoin(boardLanes, eq(boardLanes.id, boardCards.laneId))
      .leftJoin(projects, eq(projects.id, boardCards.projectId))
      .where(
        and(
          eq(boardCards.ownerId, actor.userId),
          isNull(boardCards.archivedAt),
          sql`${boardCards.clientId} is not null`,
          // A project in the Trash is off every total.
          isNull(projects.deletedAt),
        ),
      )
      .groupBy(
        boardCards.clientId,
        boardCards.currency,
        sql`${boardLanes.role} = 'awaiting_payment'`,
      )
    const paidRows = await db
      .select({
        clientId: boardCards.clientId,
        currency: boardCardPayments.currency,
        sum: sql<string>`sum(${boardCardPayments.amount})::text`,
        projectIds: sql<
          string[]
        >`array_agg(distinct ${boardCardPayments.projectId}) filter (where ${boardCardPayments.projectId} is not null)`,
        lastChange: sql<string | null>`max(${boardCards.updatedAt})::text`,
      })
      .from(boardCardPayments)
      .innerJoin(boardCards, eq(boardCards.id, boardCardPayments.cardId))
      .leftJoin(projects, eq(projects.id, boardCardPayments.projectId))
      .where(
        and(
          eq(boardCardPayments.ownerId, actor.userId),
          sql`${boardCards.clientId} is not null`,
          isNull(projects.deletedAt),
          ne(boardCardPayments.kind, 'void'),
          sql`not exists (select 1 from ${boardCardPayments} as v where v.voids_id = ${boardCardPayments.id})`,
          sql`${boardCardPayments.receivedOn} >= date_trunc('year', now() at time zone coalesce(${projects.timezone}, 'Asia/Bangkok'))::date`,
        ),
      )
      .groupBy(boardCards.clientId, boardCardPayments.currency)
    const out = new Map<string, ClientLedgerRow>()
    const entry = (clientId: string) => {
      let row = out.get(clientId)
      if (!row) {
        row = {
          clientId,
          cards: 0,
          projectIds: [],
          onBoard: [],
          awaiting: [],
          paidThisYear: [],
          lastChange: null,
        }
        out.set(clientId, row)
      }
      return row
    }
    const later = (a: string | null, b: string | null) =>
      a && b ? (a > b ? a : b) : (a ?? b)
    const add = (
      list: { currency: string; sum: string }[],
      currency: string,
      sum: string,
    ) => {
      const found = list.find((item) => item.currency === currency)
      if (found) found.sum = sumAmounts([found.sum, sum], currency)
      else list.push({ currency, sum: sumAmounts([sum], currency) })
    }
    for (const row of owedRows) {
      if (!row.clientId) continue
      const ledger = entry(row.clientId)
      ledger.cards += row.cards
      ledger.projectIds = [
        ...new Set([...ledger.projectIds, ...(row.projectIds ?? [])]),
      ]
      ledger.lastChange = later(ledger.lastChange, row.lastChange)
      if (row.currency)
        add(
          row.awaiting ? ledger.awaiting : ledger.onBoard,
          row.currency,
          row.owed,
        )
    }
    for (const row of paidRows) {
      if (!row.clientId) continue
      const ledger = entry(row.clientId)
      ledger.projectIds = [
        ...new Set([...ledger.projectIds, ...(row.projectIds ?? [])]),
      ]
      ledger.lastChange = later(ledger.lastChange, row.lastChange)
      add(ledger.paidThisYear, row.currency, row.sum)
    }
    return [...out.values()]
  })
}

/** The follow-ups and payment lines of cards the actor may read — for the everywhere board. */
export async function listCardExtras(
  actor: Actor,
  cardIds: readonly string[],
): Promise<CardExtras> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'board', 'read')
    return cardExtras(db, actor.userId, cardIds)
  })
}
