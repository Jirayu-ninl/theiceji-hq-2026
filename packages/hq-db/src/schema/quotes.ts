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
import { QUOTE_STATUSES, type QuoteStatus } from '../enums'
import { inOwnProject, ownerColumn, trimmedLength } from './_module'
import { oneOf, tz } from './_shared'
import { tracked } from './_user'
import { assetAssets } from './assets'
import { clients } from './core'

/* ── quotes — quotations for freelance work ─────────
 *
 * A quote is numbered `Q-YYYY-NNN` per owner, in the currency of its project
 * (THB unless the project says otherwise), with VAT 7 % and withholding tax
 * 3 % each switched on or off. Its figures are computed from the lines every
 * time they are read — never stored twice — except the moment it is sent:
 * then `totals_snapshot` and the PDF (an asset) freeze what the client saw.
 *
 * Sending is the owner's own act (download the PDF, send it themselves); HQ
 * never emails a client. An agent may draft a quote and nothing else.
 * Clients are HQ-wide (`clients` in ./core); a quote bills one.
 */

/** Totals as they were sent — the only stored copy of the figures. */
export type QuoteTotalsSnapshot = {
  currency: string
  subtotal: string
  vat: string
  wht: string
  total: string
  vatPct: string
  whtPct: string
}

export const quoteQuotes = pgTable(
  'quote_quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id'),
    clientId: uuid('client_id'),
    /** `Q-YYYY-NNN`, unique per owner. */
    number: text('number').notNull(),
    title: text('title').notNull(),
    status: text('status').$type<QuoteStatus>().notNull().default('draft'),
    currency: text('currency').notNull().default('THB'),
    /** The day it goes out; set when it is sent. */
    issuedOn: date('issued_on', { mode: 'string' }),
    /** How many days it holds once issued. */
    validDays: integer('valid_days').notNull().default(30),
    /** `issued_on + valid_days`, once issued. */
    validUntil: date('valid_until', { mode: 'string' }),
    vatPct: numeric('vat_pct', { precision: 5, scale: 2, mode: 'string' })
      .notNull()
      .default('0'),
    whtPct: numeric('wht_pct', { precision: 5, scale: 2, mode: 'string' })
      .notNull()
      .default('0'),
    notes: text('notes').notNull().default(''),
    /** The PDF the client got — an asset, frozen once ready. */
    pdfAssetId: uuid('pdf_asset_id'),
    totalsSnapshot: jsonb('totals_snapshot').$type<QuoteTotalsSnapshot>(),
    sentAt: timestamp('sent_at', tz),
    decidedAt: timestamp('decided_at', tz),
  },
  (t) => [
    unique('quote_quotes_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('quote_quotes_project_fk', t),
    foreignKey({
      name: 'quote_quotes_client_fk',
      columns: [t.clientId, t.ownerId],
      foreignColumns: [clients.id, clients.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'quote_quotes_pdf_fk',
      columns: [t.pdfAssetId, t.ownerId],
      foreignColumns: [assetAssets.id, assetAssets.ownerId],
    }).onDelete('restrict'),
    uniqueIndex('quote_quotes_number_key').on(t.ownerId, t.number),
    index('quote_quotes_owner_idx').on(t.ownerId, t.projectId, t.status),
    check('quote_quotes_status_check', oneOf(t.status, QUOTE_STATUSES)),
    check(
      'quote_quotes_number_check',
      sql`${t.number} ~ '^Q-[0-9]{4}-[0-9]{3,}$'`,
    ),
    check('quote_quotes_title_check', trimmedLength(t.title, 200)),
    check('quote_quotes_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('quote_quotes_valid_check', sql`${t.validDays} between 1 and 365`),
    check(
      'quote_quotes_pct_check',
      sql`${t.vatPct} between 0 and 30 and ${t.whtPct} between 0 and 30`,
    ),
    check('quote_quotes_notes_check', sql`length(${t.notes}) <= 4000`),
    check(
      'quote_quotes_sent_check',
      sql`(${t.status} = 'draft') = (${t.sentAt} is null)`,
    ),
    check(
      'quote_quotes_issued_check',
      sql`(${t.sentAt} is null) = (${t.issuedOn} is null) and (${t.issuedOn} is null) = (${t.validUntil} is null)`,
    ),
    check(
      'quote_quotes_snapshot_check',
      sql`(${t.status} = 'draft') = (${t.totalsSnapshot} is null)`,
    ),
    check(
      'quote_quotes_decided_check',
      sql`(${t.status} in ('accepted', 'declined')) = (${t.decidedAt} is not null)`,
    ),
  ],
)

export const quoteLines = pgTable(
  'quote_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    quoteId: uuid('quote_id').notNull(),
    description: text('description').notNull(),
    qty: numeric('qty', { precision: 12, scale: 3, mode: 'string' })
      .notNull()
      .default('1'),
    /** `job`, `hour`, `ชิ้น` … — printed beside the quantity. */
    unit: text('unit').notNull().default(''),
    unitPrice: numeric('unit_price', {
      precision: 14,
      scale: 2,
      mode: 'string',
    })
      .notNull()
      .default('0'),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'quote_lines_quote_fk',
      columns: [t.quoteId, t.ownerId],
      foreignColumns: [quoteQuotes.id, quoteQuotes.ownerId],
    }).onDelete('cascade'),
    index('quote_lines_quote_idx').on(t.quoteId, t.position),
    check('quote_lines_description_check', trimmedLength(t.description, 600)),
    check('quote_lines_qty_check', sql`${t.qty} > 0`),
    check('quote_lines_price_check', sql`${t.unitPrice} >= 0`),
    check('quote_lines_unit_check', sql`length(${t.unit}) <= 24`),
  ],
)

export type QuoteRow = typeof quoteQuotes.$inferSelect
export type QuoteLineRow = typeof quoteLines.$inferSelect
