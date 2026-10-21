import type { CardListItem, ClientLedgerRow } from '@theiceji/hq-board/board'
import { sumAmounts } from '@theiceji/hq-core/money'
import type { ProjectColor } from '@theiceji/hq-db/enums'
import type {
  BoardCardPaymentRow,
  BoardFollowupRow,
  ClientRow,
  ProjectRow,
} from '@theiceji/hq-db/schema'
import type { QuoteListItem } from '@theiceji/hq-quotes/quotes'

/**
 * Clients as they cross to the page: plain JSON, dates as ISO strings,
 * money as decimal strings per currency — never converted, never floats.
 */

/** An amount in one currency, as the ledger counts it. */
export type Money = { currency: string; sum: string }

export type ClientData = {
  id: string
  name: string
  taxId: string | null
  address: string
  email: string | null
  phone: string | null
  revision: number
  archived: boolean
  /** When the record was made — "client since". */
  since: string
}

/** What points at a client — cards in any state (archived and in the Trash too) and quotes; absent means nothing, so it may be deleted. */
export type ClientUseData = { cards: number; quotes: number }

/** One client's money, each baht once (hq-board `clientLedger`). */
export type LedgerData = {
  /** Cards on a board now. */
  cards: number
  projectIds: string[]
  onBoard: Money[]
  awaiting: Money[]
  paid: Money[]
}

export type ClientProject = {
  id: string
  slug: string
  name: string
  color: string
  archived: boolean
  /** Board is on, so a new card can start there. */
  board: boolean
}

/** A client name typed once on active cards, not a record in Clients. */
export type OnceNameData = {
  name: string
  cards: { id: string; title: string; revision: number }[]
  /** An active client that already has this name — linking, not adding. */
  match: { id: string; name: string } | null
}

export type ClientCardData = {
  id: string
  title: string
  href: string
  color: ProjectColor | null
  /** Price + follow-ups, in `currency`. */
  total: string | null
  currency: string | null
  laneName: string
  awaiting: boolean
  archived: boolean
  paidAt: string | null
  followups: number
  /** What came in on this card this year (payments that count). */
  paidThisYear: string | null
  paymentsThisYear: number
  /** The day the newest of those came in. */
  lastPaidOn: string | null
  project: { slug: string; name: string; color: string } | null
}

export type ClientQuoteData = {
  id: string
  number: string
  title: string
  status: QuoteListItem['status']
  total: string
  currency: string
  href: string
}

export type ClientDetailData = {
  clientId: string
  cards: ClientCardData[]
  quotes: ClientQuoteData[]
}

export function clientData(row: ClientRow): ClientData {
  return {
    id: row.id,
    name: row.name,
    taxId: row.taxId,
    address: row.address,
    email: row.email,
    phone: row.phone,
    revision: row.revision,
    archived: Boolean(row.archivedAt),
    since: row.createdAt.toISOString(),
  }
}

/** Money lists without the zero rows a currency group can leave behind. */
const nonZero = (list: Money[]) =>
  list.filter((entry) => /[1-9]/.test(entry.sum))

export function ledgerData(row: ClientLedgerRow): LedgerData {
  return {
    cards: row.cards,
    projectIds: row.projectIds,
    onBoard: nonZero(row.onBoard),
    awaiting: nonZero(row.awaiting),
    paid: nonZero(row.paidThisYear),
  }
}

export function projectData(row: ProjectRow): ClientProject {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    color: row.color,
    archived: row.status === 'archived',
    board: row.status !== 'archived' && row.modules.enabled.includes('board'),
  }
}

/**
 * The one-time names on active cards, grouped case-insensitively — the path
 * from a name typed once to a record.
 */
export function onceNames(
  cards: CardListItem[],
  clients: ClientRow[],
): OnceNameData[] {
  const groups = new Map<string, OnceNameData>()
  for (const card of cards) {
    const name = card.client?.trim()
    if (!name || card.clientId || card.archivedAt) continue
    const key = name.toLowerCase()
    const group = groups.get(key) ?? { name, cards: [], match: null }
    group.cards.push({
      id: card.id,
      title: card.title,
      revision: card.revision,
    })
    groups.set(key, group)
  }
  for (const [key, group] of groups) {
    const match = clients.find(
      (client) => !client.archivedAt && client.name.toLowerCase() === key,
    )
    if (match) group.match = { id: match.id, name: match.name }
  }
  return [...groups.values()].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  )
}

const cardHref = (slug: string | null, cardId: string) =>
  slug ? `/p/${slug}/board?card=${cardId}` : `/board?card=${cardId}`

/**
 * One client's cards and quotes for the inspector. A card's paid line is
 * what came in on it since `yearStart` — payments that count (not a void,
 * not struck by one), the same rule as the ledger.
 */
export function detailData(
  clientId: string,
  cards: CardListItem[],
  extras: { followups: BoardFollowupRow[]; payments: BoardCardPaymentRow[] },
  quotes: QuoteListItem[],
  yearStart: string,
): ClientDetailData {
  const struck = new Set(
    extras.payments
      .filter((line) => line.kind === 'void' && line.voidsId)
      .map((line) => line.voidsId as string),
  )
  const counting = extras.payments.filter(
    (line) =>
      line.kind !== 'void' &&
      !struck.has(line.id) &&
      line.receivedOn >= yearStart,
  )
  return {
    clientId,
    cards: cards.map((card) => {
      const lines = counting.filter((line) => line.cardId === card.id)
      const currency = lines[0]?.currency ?? card.currency
      return {
        id: card.id,
        title: card.title,
        href: cardHref(card.project?.slug ?? null, card.id),
        color: card.color,
        total: card.total,
        currency: card.currency,
        laneName: card.laneName,
        awaiting: card.laneRole === 'awaiting_payment',
        archived: Boolean(card.archivedAt),
        paidAt: card.paidAt?.toISOString() ?? null,
        followups: extras.followups.filter(
          (followup) => followup.cardId === card.id,
        ).length,
        paidThisYear:
          lines.length && currency
            ? sumAmounts(
                lines.map((line) => line.amount),
                currency,
              )
            : null,
        paymentsThisYear: lines.length,
        lastPaidOn: lines.reduce<string | null>(
          (last, line) =>
            last && last > line.receivedOn ? last : line.receivedOn,
          null,
        ),
        project: card.project
          ? {
              slug: card.project.slug,
              name: card.project.name,
              color: card.project.color,
            }
          : null,
      }
    }),
    quotes: quotes.map((quote) => ({
      id: quote.id,
      number: quote.number,
      title: quote.title,
      status: quote.status,
      total: quote.totals.total,
      currency: quote.currency,
      href: quote.project
        ? `/p/${quote.project.slug}/quotes?quote=${quote.id}`
        : `/quotes?quote=${quote.id}`,
    })),
  }
}
