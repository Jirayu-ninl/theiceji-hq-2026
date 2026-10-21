import {
  type CardDetail,
  type CardListItem,
  createCard,
  getCard,
  listCards,
  moveCard,
  openBoard,
  updateCard,
} from '@theiceji/hq-board/board'
import {
  addFollowup,
  type FollowupResult,
  updateFollowup,
} from '@theiceji/hq-board/followups'
import { owedOf } from '@theiceji/hq-board/payments'
import '@theiceji/hq-board/register'
import { listClients } from '@theiceji/hq-core/clients'
import { PROJECT_COLOR_NAMES } from '@theiceji/hq-db/enums'
import type {
  BoardCardPaymentRow,
  BoardCardRow,
  BoardFollowupRow,
} from '@theiceji/hq-db/schema'
import { notFound } from '@theiceji/hq-ops/errors'
import { z } from 'zod'
import { defineTool, defineWorkspace } from '../../kernel'
import {
  defined,
  expectedRevisionArg,
  idArg,
  idempotencyKeyArg,
  projectIdArg,
  READ,
  readTool,
  WRITE,
  writeTool,
} from '../support'

/**
 * `board` — the project's kanban: read cards, add them,
 * edit them, move them between lanes, and add or edit a card's follow-ups.
 * Recording a payment, marking a card paid, removing a follow-up, archiving,
 * deleting and shaping lanes are the owner's, in HQ; no tool here does them,
 * and no read here returns a card in the Trash.
 */

function cardOut(card: BoardCardRow | CardListItem) {
  return {
    id: card.id,
    project_id: card.projectId,
    board_id: card.boardId,
    lane_id: card.laneId,
    ...('laneName' in card
      ? { lane: card.laneName, lane_role: card.laneRole }
      : {}),
    title: card.title,
    body: card.body,
    labels: card.labels,
    price: card.price,
    total: card.total,
    paid_total: card.paidTotal,
    owed: owedOf(card),
    currency: card.currency,
    due_on: card.dueOn,
    client_id: card.clientId,
    client: card.client,
    ...('clientName' in card ? { client_name: card.clientName } : {}),
    color: card.color,
    position: card.position,
    paid_at: card.paidAt,
    archived_at: card.archivedAt,
    revision: card.revision,
    updated_at: card.updatedAt,
  }
}

function followupOut(followup: BoardFollowupRow, currency: string | null) {
  return {
    id: followup.id,
    card_id: followup.cardId,
    title: followup.title,
    body: followup.body,
    price: followup.price,
    currency: followup.price === null ? null : currency,
    due_on: followup.dueOn,
    position: followup.position,
    removed: followup.archivedAt !== null,
    revision: followup.revision,
    updated_at: followup.updatedAt,
  }
}

function paymentsOut(payments: readonly BoardCardPaymentRow[]) {
  const struck = new Set(
    payments.flatMap((line) => (line.voidsId ? [line.voidsId] : [])),
  )
  return payments.map((line) => ({
    id: line.id,
    kind: line.kind,
    amount: line.amount,
    currency: line.currency,
    received_on: line.receivedOn,
    note: line.note,
    voids_id: line.voidsId,
    counts: line.kind !== 'void' && !struck.has(line.id),
    created_at: line.createdAt,
  }))
}

function detailOut(detail: CardDetail, clientName: string | null) {
  return {
    ...cardOut(detail.card),
    lane: detail.lane.name,
    lane_role: detail.lane.role,
    client_name: clientName,
    followups: detail.followups.map((followup) =>
      followupOut(followup, detail.card.currency),
    ),
    payments: paymentsOut(detail.payments),
  }
}

function money(card: BoardCardRow): string {
  if (card.total === null) return 'no price'
  const owed = owedOf(card)
  return `total ${card.total} ${card.currency}, paid ${card.paidTotal}, owed ${owed}`
}

const priceArg = z
  .union([z.string().max(20), z.number().min(0)])
  .nullable()
  .optional()
  .describe(
    'The price, e.g. "36000" or 36000.50; null clears it. In the project’s currency unless currency says otherwise.',
  )

const dueArg = z
  .string()
  .nullable()
  .optional()
  .describe('YYYY-MM-DD in the project’s calendar; null clears it.')

const cardFieldArgs = {
  body: z.string().max(20000).optional().describe('Markdown.'),
  labels: z
    .array(z.string().max(32))
    .max(12)
    .optional()
    .describe('Replaces the labels; lowercase words like "client", "invoice".'),
  price: priceArg,
  currency: z.string().length(3).optional().describe('ISO code, e.g. THB.'),
  due_on: dueArg,
  client_id: idArg('Client')
    .nullable()
    .optional()
    .describe(
      'Who the work is for: one of the owner’s clients (hq_list_clients; hq_create_client adds one). null takes the client off. Give client_id or client, not both.',
    ),
  client: z
    .string()
    .max(120)
    .nullable()
    .optional()
    .describe(
      'A client name used on this card only — a one-off job not worth a Clients record. Setting it clears client_id; null clears it. A client with more than one job belongs in client_id.',
    ),
  color: z
    .enum(PROJECT_COLOR_NAMES)
    .nullable()
    .optional()
    .describe(
      'The stripe on the card’s left edge — one of the swatches; null takes it off. Identity (a client, a kind of job), not state.',
    ),
}

export const listCardsTool = defineTool({
  name: 'list_cards',
  title: 'List board cards',
  description:
    'Cards on the boards: one project’s (with its lanes and each lane’s total), or every project with Board on. Filter by lane, lane role (awaiting_payment is money owed but not paid), label or client. Each card has total (its price + its follow-ups’ prices), paid_total (deposits and part payments that came in) and owed (total − paid_total; below zero is overpaid). Archived cards only with include_archived. With card_id, one card in full: its follow-ups (with the followup_id board_update_followup needs) and its payment lines.',
  scope: 'board:read',
  input: z.object({
    card_id: idArg('Card').optional(),
    project_id: projectIdArg.optional(),
    board_id: idArg('Board').optional(),
    lane_id: idArg('Lane').optional(),
    lane_role: z.enum(['normal', 'awaiting_payment', 'done']).optional(),
    label: z.string().max(32).optional(),
    client_id: idArg('Client').optional(),
    include_archived: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      async (actor) => {
        if (args.card_id) {
          const detail = await getCard(actor, args.card_id)
          // The Trash is the owner's, in HQ: a deleted card
          // reads as one that isn't there.
          if (detail.card.deletedAt) throw notFound('Card')
          const { clientId } = detail.card
          const clientName = clientId
            ? ((await listClients(actor, { includeArchived: true })).find(
                (entry) => entry.id === clientId,
              )?.name ?? null)
            : detail.card.client
          return { one: { detail, clientName }, many: null }
        }
        const [board, cards] = await Promise.all([
          args.project_id
            ? openBoard(actor, args.project_id)
            : Promise.resolve(null),
          listCards(actor, {
            projectId: args.project_id,
            boardId: args.board_id,
            laneId: args.lane_id,
            role: args.lane_role,
            label: args.label,
            clientId: args.client_id,
            includeArchived: args.include_archived,
            limit: args.limit,
          }),
        ])
        return { one: null, many: { board, cards } }
      },
      ({ one, many }) => {
        if (one) {
          const { card, lane, followups, payments } = one.detail
          return {
            text: `“${card.title}” is in ${lane.name}: ${money(card)}; ${followups.length} follow-up(s), ${payments.length} payment line(s) (revision ${card.revision}).`,
            data: { card: detailOut(one.detail, one.clientName) },
          }
        }
        const board = many?.board ?? null
        const cards = many?.cards ?? []
        return {
          text:
            `${cards.length} card(s)` +
            (board
              ? ` on ${board.lanes.length} lanes: ${board.lanes
                  .map(
                    (lane) =>
                      `${lane.name} ${lane.count}${lane.sum ? ` (${lane.sum} ${lane.currency}${lane.owed !== null && lane.owed !== lane.sum ? `, ${lane.owed} owed` : ''})` : ''}`,
                  )
                  .join(' · ')}.`
              : '.'),
          data: {
            board: board
              ? {
                  id: board.board.id,
                  lanes: board.lanes.map((lane) => ({
                    id: lane.id,
                    name: lane.name,
                    role: lane.role,
                    position: lane.position,
                    cards: lane.count,
                    sum: lane.sum,
                    owed: lane.owed,
                    currency: lane.currency,
                  })),
                }
              : null,
            cards: cards.map(cardOut),
          },
        }
      },
    ),
})

export const createCardTool = defineTool({
  name: 'create_card',
  title: 'Create a card',
  description:
    'Add a card to a project’s board — the first lane unless lane_id says otherwise. The board is made from the project kind’s lanes if it has none yet. Name who it is for with client_id (a Clients record) or client (a name used once). Needs your operating policy to allow drafting.',
  scope: 'board:write',
  input: z.object({
    project_id: projectIdArg,
    lane_id: idArg('Lane').optional(),
    title: z.string().min(1).max(200),
    ...cardFieldArgs,
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        createCard(
          actor,
          defined({
            projectId: args.project_id,
            laneId: args.lane_id,
            title: args.title,
            body: args.body,
            labels: args.labels,
            price: args.price,
            currency: args.currency,
            dueOn: args.due_on,
            clientId: args.client_id,
            client: args.client,
            color: args.color,
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof createCard>[1],
        ),
      (card) => ({
        text: `Created card “${card.title}” (revision ${card.revision}).`,
        data: {
          target: { type: 'card', id: card.id, revision: card.revision },
          card: cardOut(card),
        },
      }),
    ),
})

export const updateCardTool = defineTool({
  name: 'update_card',
  title: 'Update a card',
  description:
    'Change a card’s title, body, labels, price, due date, client or colour. Fields you leave out stay as they are. Work that came after the card’s task was done is a follow-up (board_add_followup), not a new price here. Recording payments and marking paid are the owner’s and aren’t here.',
  scope: 'board:write',
  input: z.object({
    card_id: idArg('Card'),
    expected_revision: expectedRevisionArg,
    title: z.string().min(1).max(200).optional(),
    ...cardFieldArgs,
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        updateCard(
          actor,
          defined({
            cardId: args.card_id,
            expectedRevision: args.expected_revision,
            title: args.title,
            body: args.body,
            labels: args.labels,
            price: args.price,
            currency: args.currency,
            dueOn: args.due_on,
            clientId: args.client_id,
            client: args.client,
            color: args.color,
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof updateCard>[1],
        ),
      (card) => ({
        text: `Updated “${card.title}” (revision ${card.revision}).`,
        data: {
          target: { type: 'card', id: card.id, revision: card.revision },
          card: cardOut(card),
        },
      }),
    ),
})

export const moveCardTool = defineTool({
  name: 'move_card',
  title: 'Move a card',
  description:
    'Move a card to another lane of its board (lane ids come from board_list_cards), optionally to a position inside it. Moving into the awaiting-payment lane doesn’t mark anything paid.',
  scope: 'board:write',
  input: z.object({
    card_id: idArg('Card'),
    expected_revision: expectedRevisionArg,
    lane_id: idArg('Lane'),
    position: z.number().int().min(0).max(10000).optional(),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      async (actor) => {
        const card = await moveCard(actor, {
          cardId: args.card_id,
          expectedRevision: args.expected_revision,
          laneId: args.lane_id,
          position: args.position,
          idempotencyKey: args.idempotency_key,
        })
        return getCard(actor, card.id)
      },
      ({ card, lane }) => ({
        text: `“${card.title}” is in ${lane.name} (revision ${card.revision}).`,
        data: {
          target: { type: 'card', id: card.id, revision: card.revision },
          card: { ...cardOut(card), lane: lane.name, lane_role: lane.role },
        },
      }),
    ),
})

/* ── Follow-ups ────────────────────────────────────────── */

const FOLLOWUP_RULES =
  'A follow-up is work that came after the card’s own task was done — a revision round, an add-on the client asked for, the client’s words worth keeping. It is not a sub-task and has no done state. Its price is in the card’s currency and adds into the card’s total (and so into what the client owes); leave the price out for a note with no charge. expected_revision is the CARD’s revision (board_list_cards), and the answer carries the card’s new revision and total for your next write. A card marked paid or archived is frozen. Removing a follow-up is the owner’s, in HQ.'

const followupFieldArgs = {
  body: z
    .string()
    .max(20000)
    .optional()
    .describe('Markdown: what was asked, by whom, what was agreed.'),
  price: z
    .union([z.string().max(20), z.number().min(0)])
    .nullable()
    .optional()
    .describe(
      'What this follow-up adds to the card’s total, in the card’s currency, e.g. "3000"; null clears it.',
    ),
  due_on: dueArg,
}

const cardRevisionArg = expectedRevisionArg.describe(
  'The card’s revision you last read (board_list_cards) — follow-ups change the card. If the card changed since, the call is refused with revision_conflict instead of overwriting.',
)

function followupAnswer(verb: string, { card, followup }: FollowupResult) {
  return {
    text: `${verb} follow-up “${followup.title}”${followup.price ? ` (${followup.price} ${card.currency})` : ''} on “${card.title}” — ${money(card)} (card revision ${card.revision}).`,
    data: {
      target: { type: 'card', id: card.id, revision: card.revision },
      followup: followupOut(followup, card.currency),
      card: cardOut(card),
    },
  }
}

export const addFollowupTool = defineTool({
  name: 'add_followup',
  title: 'Add a follow-up to a card',
  description: `Add a follow-up at the end of a card’s list. ${FOLLOWUP_RULES} Needs your operating policy to allow drafting.`,
  scope: 'board:write',
  input: z.object({
    card_id: idArg('Card'),
    expected_revision: cardRevisionArg,
    title: z.string().min(1).max(200),
    ...followupFieldArgs,
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        addFollowup(
          actor,
          defined({
            cardId: args.card_id,
            expectedRevision: args.expected_revision,
            title: args.title,
            body: args.body,
            price: args.price,
            dueOn: args.due_on,
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof addFollowup>[1],
        ),
      (result) => followupAnswer('Added', result),
    ),
})

export const updateFollowupTool = defineTool({
  name: 'update_followup',
  title: 'Update a follow-up',
  description: `Change a follow-up’s title, details, price or due date (followup_id from board_list_cards with card_id). Fields you leave out stay as they are. ${FOLLOWUP_RULES} Needs your operating policy to allow drafting.`,
  scope: 'board:write',
  input: z.object({
    card_id: idArg('Card'),
    expected_revision: cardRevisionArg,
    followup_id: idArg('Follow-up'),
    title: z.string().min(1).max(200).optional(),
    ...followupFieldArgs,
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        updateFollowup(
          actor,
          defined({
            cardId: args.card_id,
            expectedRevision: args.expected_revision,
            followupId: args.followup_id,
            title: args.title,
            body: args.body,
            price: args.price,
            dueOn: args.due_on,
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof updateFollowup>[1],
        ),
      (result) => followupAnswer('Updated', result),
    ),
})

export const board = defineWorkspace({
  id: 'board',
  label: 'Board',
  description:
    'Each project’s kanban: cards in the kind’s lanes, with price, due date, client, colour and labels, and follow-ups whose prices add into the card’s total.',
  instructions:
    'Read a project’s lanes and cards with board_list_cards before writing (card_id for one card with its follow-ups and payments). A card’s total is its price plus its follow-ups’ prices; paid_total is what came in (deposits, part payments) and owed is total − paid_total. The awaiting-payment lane holds money owed, not income. Work that came after a card’s task was done is a follow-up (board_add_followup), not a new card or a sub-task. A card’s client is a Clients record (client_id, from hq_list_clients) or a name used once (client). Recording payments, marking a card paid and removing follow-ups are the owner’s, in HQ — no tool does them.',
  tools: [
    listCardsTool,
    createCardTool,
    updateCardTool,
    moveCardTool,
    addFollowupTool,
    updateFollowupTool,
  ],
})
