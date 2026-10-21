import type {
  BoardCardPaymentRow,
  BoardCardRow,
  BoardFollowupRow,
  BoardLaneRow,
  ClientRow,
} from '@theiceji/hq-db/schema'

/**
 * Board records as they cross from the server to the page: plain JSON,
 * dates as ISO strings, money as decimal strings.
 */

export type CardData = {
  id: string
  boardId: string
  laneId: string
  projectId: string | null
  title: string
  body: string
  labels: string[]
  /** The card's own price. */
  price: string | null
  /** price + the live follow-ups' prices — what the card is worth. */
  total: string | null
  /** What came in so far. */
  paidTotal: string
  currency: string | null
  dueOn: string | null
  /** A client from Clients… */
  clientId: string | null
  /** …or a name used once on this card only. */
  client: string | null
  /** A swatch name for the card's stripe. */
  color: string | null
  position: number
  paidAt: string | null
  archivedAt: string | null
  /** In the Trash (always archived too). */
  deletedAt: string | null
  revision: number
  updatedAt: string
}

export type LaneData = {
  id: string
  name: string
  role: BoardLaneRow['role']
  position: number
  wipLimit: number | null
}

/** Work that came after a card's own task. */
export type FollowupData = {
  id: string
  cardId: string
  title: string
  body: string
  /** In the card's currency. */
  price: string | null
  dueOn: string | null
  position: number
  revision: number
}

/** One line of a card's payment ledger; a `void` line names the one it strikes. */
export type PaymentData = {
  id: string
  cardId: string
  kind: BoardCardPaymentRow['kind']
  amount: string
  currency: string
  receivedOn: string
  note: string
  voidsId: string | null
  createdAt: string
}

/** A client the Client field can offer (archived ones only name old cards). */
export type ClientOption = { id: string; name: string; archived: boolean }

export function cardData(card: BoardCardRow): CardData {
  return {
    id: card.id,
    boardId: card.boardId,
    laneId: card.laneId,
    projectId: card.projectId,
    title: card.title,
    body: card.body,
    labels: card.labels,
    price: card.price,
    total: card.total,
    paidTotal: card.paidTotal,
    currency: card.currency,
    dueOn: card.dueOn,
    clientId: card.clientId,
    client: card.client,
    color: card.color,
    position: card.position,
    paidAt: card.paidAt?.toISOString() ?? null,
    archivedAt: card.archivedAt?.toISOString() ?? null,
    deletedAt: card.deletedAt?.toISOString() ?? null,
    revision: card.revision,
    updatedAt: card.updatedAt.toISOString(),
  }
}

export function laneData(lane: BoardLaneRow): LaneData {
  return {
    id: lane.id,
    name: lane.name,
    role: lane.role,
    position: lane.position,
    wipLimit: lane.wipLimit,
  }
}

export function followupData(row: BoardFollowupRow): FollowupData {
  return {
    id: row.id,
    cardId: row.cardId,
    title: row.title,
    body: row.body,
    price: row.price,
    dueOn: row.dueOn,
    position: row.position,
    revision: row.revision,
  }
}

export function paymentData(row: BoardCardPaymentRow): PaymentData {
  return {
    id: row.id,
    cardId: row.cardId,
    kind: row.kind,
    amount: row.amount,
    currency: row.currency,
    receivedOn: row.receivedOn,
    note: row.note,
    voidsId: row.voidsId,
    createdAt: row.createdAt.toISOString(),
  }
}

export function clientOption(row: ClientRow): ClientOption {
  return { id: row.id, name: row.name, archived: Boolean(row.archivedAt) }
}
