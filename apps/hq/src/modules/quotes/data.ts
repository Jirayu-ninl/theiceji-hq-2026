import type { ClientRow, QuoteIssuer } from '@theiceji/hq-db/schema'
import type { QuoteDetail, QuoteListItem } from '@theiceji/hq-quotes/quotes'
import type { QuoteTotals } from '@theiceji/hq-quotes/totals'

/** Quotes as they cross to the page: plain JSON, dates as ISO strings, money as decimal strings. */

export type QuoteProject = {
  id: string
  slug: string
  name: string
  color: string
  status: string
  currency: string
}

export type ClientData = {
  id: string
  name: string
  taxId: string | null
  address: string
  email: string | null
  phone: string | null
  revision: number
  archived: boolean
}

export type QuoteRowData = {
  id: string
  number: string
  title: string
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired'
  projectId: string | null
  project: { id: string; slug: string; name: string; color: string } | null
  client: { id: string; name: string } | null
  currency: string
  totals: QuoteTotals
  issuedOn: string | null
  validUntil: string | null
  revision: number
  updatedAt: string
}

export type QuoteLineData = {
  description: string
  qty: string
  unit: string
  unitPrice: string
  amount: string
}

export type QuoteDetailData = QuoteRowData & {
  clientId: string | null
  vatPct: string
  whtPct: string
  validDays: number
  notes: string
  lines: QuoteLineData[]
  hasPdf: boolean
  cardIds: string[]
  missing: string[]
  sentAt: string | null
  decidedAt: string | null
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
  }
}

export function quoteRowData(row: QuoteListItem): QuoteRowData {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    projectId: row.projectId,
    project: row.project
      ? {
          id: row.project.id,
          slug: row.project.slug,
          name: row.project.name,
          color: row.project.color,
        }
      : null,
    client: row.client,
    currency: row.currency,
    totals: row.totals,
    issuedOn: row.issuedOn,
    validUntil: row.validUntil,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function quoteDetailData(detail: QuoteDetail): QuoteDetailData {
  const { quote } = detail
  return {
    id: quote.id,
    number: quote.number,
    title: quote.title,
    status: quote.status,
    projectId: quote.projectId,
    project: detail.project
      ? {
          id: detail.project.id,
          slug: detail.project.slug,
          name: detail.project.name,
          color: detail.project.color,
        }
      : null,
    client: detail.client
      ? { id: detail.client.id, name: detail.client.name }
      : null,
    clientId: quote.clientId,
    currency: quote.currency,
    totals: detail.totals,
    issuedOn: quote.issuedOn,
    validUntil: quote.validUntil,
    revision: quote.revision,
    updatedAt: quote.updatedAt.toISOString(),
    vatPct: quote.vatPct,
    whtPct: quote.whtPct,
    validDays: quote.validDays,
    notes: quote.notes,
    lines: detail.lines.map((line) => ({
      description: line.description,
      qty: line.qty,
      unit: line.unit,
      unitPrice: line.unitPrice,
      amount: line.amount,
    })),
    hasPdf: Boolean(quote.pdfAssetId),
    cardIds: detail.refs
      .filter((ref) => ref.fromType === 'card' && ref.role === 'quoted_by')
      .map((ref) => ref.fromId),
    missing: detail.missing,
    sentAt: quote.sentAt?.toISOString() ?? null,
    decidedAt: quote.decidedAt?.toISOString() ?? null,
  }
}

export type { QuoteIssuer }
