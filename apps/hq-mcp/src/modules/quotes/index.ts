import { listClients } from '@theiceji/hq-core/clients'
import type { QuoteRow } from '@theiceji/hq-db/schema'
import { invalid } from '@theiceji/hq-ops/errors'
import {
  createDraft,
  getQuote,
  listQuotes,
  type QuoteDetail,
  type QuoteListItem,
  updateDraft,
} from '@theiceji/hq-quotes/quotes'
import '@theiceji/hq-quotes/register'
import type { QuoteTotals } from '@theiceji/hq-quotes/totals'
import { z } from 'zod'
import { defineTool, defineWorkspace } from '../../kernel'
import { clientOut } from '../hq'
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
 * `quotes` — the owner's quotations: read them, and draft
 * or edit a draft. Sending a quote to a client, recording the client's
 * answer, revising a sent quote and deleting are the owner's, in HQ; no tool
 * here does them.
 */

const STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const

function totalsOut(totals: QuoteTotals) {
  return {
    currency: totals.currency,
    subtotal: totals.subtotal,
    vat_pct: totals.vatPct,
    vat: totals.vat,
    wht_pct: totals.whtPct,
    wht: totals.wht,
    total: totals.total,
  }
}

function quoteOut(quote: QuoteRow | QuoteListItem) {
  return {
    id: quote.id,
    number: quote.number,
    project_id: quote.projectId,
    client_id: quote.clientId,
    ...('lineCount' in quote
      ? {
          client: quote.client?.name ?? null,
          project: quote.project?.slug ?? null,
          lines: quote.lineCount,
          totals: totalsOut(quote.totals),
        }
      : {}),
    title: quote.title,
    status: quote.status,
    currency: quote.currency,
    vat_pct: quote.vatPct,
    wht_pct: quote.whtPct,
    valid_days: quote.validDays,
    issued_on: quote.issuedOn,
    valid_until: quote.validUntil,
    sent_at: quote.sentAt,
    decided_at: quote.decidedAt,
    notes: quote.notes,
    pdf_asset_id: quote.pdfAssetId,
    revision: quote.revision,
    updated_at: quote.updatedAt,
  }
}

function detailOut(detail: QuoteDetail) {
  return {
    quote: quoteOut(detail.quote),
    lines: detail.lines.map((line) => ({
      id: line.id,
      position: line.position,
      description: line.description,
      qty: line.qty,
      unit: line.unit,
      unit_price: line.unitPrice,
      amount: line.amount,
    })),
    client: detail.client ? clientOut(detail.client) : null,
    totals: totalsOut(detail.totals),
    links: detail.refs.map((ref) => ({
      from: { type: ref.fromType, id: ref.fromId },
      role: ref.role,
      to: { type: ref.toType, id: ref.toId },
    })),
    missing_before_send: detail.missing,
  }
}

function summary(detail: QuoteDetail): string {
  const { quote, totals } = detail
  const missing = detail.missing.length
    ? ` Before the owner can send it: ${detail.missing.join(' ')}`
    : ''
  return `${quote.number} “${quote.title}” is ${quote.status}: ${detail.lines.length} line(s), total due ${totals.total} ${totals.currency} (revision ${quote.revision}).${missing}`
}

export const listQuotesTool = defineTool({
  name: 'list',
  title: 'List quotes',
  description:
    'Quotes with their totals (subtotal, VAT 7 %, withholding 3 %, total due — decimal strings in the quote’s currency): one project’s, or every project with Quotes on. Filter by status or client. With quote_id, one quote in full — its lines, client, totals, links (the card it quotes, the PDFs it was sent as) and what it still needs before the owner can send it. Also lists the owner’s active clients — the same HQ-wide list as hq_list_clients — so a draft can name one by client_id.',
  scope: 'quotes:read',
  input: z.object({
    quote_id: idArg('Quote').optional(),
    project_id: projectIdArg.optional(),
    status: z.array(z.enum(STATUSES)).max(5).optional(),
    client_id: idArg('Client').optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      async (actor) => {
        if (args.quote_id)
          return { one: await getQuote(actor, args.quote_id), many: null }
        const [quotes, clients] = await Promise.all([
          listQuotes(actor, {
            projectId: args.project_id,
            status: args.status,
            clientId: args.client_id,
            limit: args.limit,
          }),
          listClients(actor),
        ])
        return { one: null, many: { quotes, clients } }
      },
      ({ one, many }) =>
        one
          ? { text: summary(one), data: detailOut(one) }
          : {
              text: `${many?.quotes.length ?? 0} quote(s); ${many?.clients.length ?? 0} active client(s).`,
              data: {
                quotes: (many?.quotes ?? []).map(quoteOut),
                clients: (many?.clients ?? []).map(clientOut),
              },
            },
    ),
})

const lineArg = z.object({
  description: z.string().min(1).max(600),
  qty: z
    .union([z.string().max(20), z.number().positive()])
    .optional()
    .describe('Quantity, up to 3 decimals; 1 when left out.'),
  unit: z
    .string()
    .max(24)
    .optional()
    .describe('Printed beside the quantity: "job", "hour", "ชิ้น".'),
  unit_price: z
    .union([z.string().max(20), z.number().min(0)])
    .describe(
      'Price per unit, e.g. "36000" or 1250.50 — no more decimals than the currency has.',
    ),
})

export const draftQuoteTool = defineTool({
  name: 'draft',
  title: 'Draft a quote',
  description:
    'Create a draft quote (with project_id), or change a draft (with quote_id and expected_revision). A new draft gets the next number Q-YYYY-NNN and the project’s currency. lines replaces the whole list, in order. Name the client with client_id (from quotes_list or hq_list_clients — clients are HQ-wide, shared with Board cards) or client (found by name among the owner’s clients, else added). from_card links the board card it quotes and, without lines, starts with one line at the card’s price. Never sends: sending, the client’s answer and deleting are the owner’s. Needs the operating policy to allow drafting.',
  scope: 'quotes:write',
  input: z.object({
    quote_id: idArg('Quote').optional(),
    expected_revision: expectedRevisionArg.optional(),
    project_id: projectIdArg.optional(),
    title: z.string().min(1).max(200).optional(),
    client_id: idArg('Client')
      .nullable()
      .optional()
      .describe('An existing client; null takes the client off the draft.'),
    client: z
      .object({
        name: z.string().min(1).max(160),
        tax_id: z.string().max(40).optional(),
        address: z.string().max(600).optional(),
        email: z.string().max(200).optional(),
        phone: z.string().max(60).optional(),
      })
      .optional()
      .describe(
        'A client by name — the owner’s client with that name, or a new one.',
      ),
    currency: z.string().length(3).optional().describe('ISO code, e.g. THB.'),
    vat: z.boolean().optional().describe('VAT 7 % on the subtotal.'),
    wht: z
      .boolean()
      .optional()
      .describe('Withholding tax 3 % (หัก ณ ที่จ่าย), deducted by the client.'),
    valid_days: z.number().int().min(1).max(365).optional(),
    notes: z.string().max(4000).optional(),
    lines: z.array(lineArg).max(100).optional(),
    from_card: z
      .object({
        id: idArg('Card'),
        title: z.string().max(200).optional(),
        price: z
          .union([z.string().max(20), z.number().min(0)])
          .nullable()
          .optional(),
      })
      .optional()
      .describe(
        'The board card this quotes: its id, title and price as board_list_cards shows them.',
      ),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      async (actor) => {
        const client = args.client
          ? defined({
              name: args.client.name,
              taxId: args.client.tax_id,
              address: args.client.address,
              email: args.client.email,
              phone: args.client.phone,
            })
          : undefined
        const lines = args.lines?.map((line) =>
          defined({
            description: line.description,
            qty: line.qty,
            unit: line.unit,
            unitPrice: line.unit_price,
          }),
        )
        const fields = defined({
          clientId: args.client_id,
          client,
          currency: args.currency,
          vat: args.vat,
          wht: args.wht,
          validDays: args.valid_days,
          notes: args.notes,
          lines,
          idempotencyKey: args.idempotency_key,
        })
        let quote: QuoteRow
        if (args.quote_id) {
          if (args.expected_revision === undefined)
            throw invalid(
              'Changing a draft needs expected_revision — read it with quotes_list first.',
              {
                expected_revision: 'Required with quote_id.',
              },
            )
          if (args.from_card || args.project_id)
            throw invalid('from_card and project_id only apply to a new draft.')
          quote = await updateDraft(actor, {
            ...fields,
            quoteId: args.quote_id,
            expectedRevision: args.expected_revision,
            title: args.title,
          } as Parameters<typeof updateDraft>[1])
        } else {
          quote = await createDraft(actor, {
            ...fields,
            projectId: args.project_id,
            title: args.title,
            fromCard: args.from_card
              ? defined({
                  id: args.from_card.id,
                  title: args.from_card.title,
                  price: args.from_card.price,
                })
              : undefined,
          } as Parameters<typeof createDraft>[1])
        }
        return getQuote(actor, quote.id)
      },
      (detail) => ({
        text: `${args.quote_id ? 'Updated' : 'Drafted'} ${summary(detail)}`,
        data: {
          target: {
            type: 'quote',
            id: detail.quote.id,
            revision: detail.quote.revision,
          },
          ...detailOut(detail),
        },
      }),
    ),
})

export const quotes = defineWorkspace({
  id: 'quotes',
  label: 'Quotes',
  description:
    'Quotations for the owner’s client work: numbered drafts with lines, VAT 7 % and withholding 3 %, and the PDF the owner sends.',
  instructions:
    'Read with quotes_list before writing; amounts are decimal strings in the quote’s currency. You draft — quotes_draft creates or edits a draft and never sends. Sending a quote, recording the client’s answer, revising a sent quote and deleting stay the owner’s, in HQ.',
  tools: [listQuotesTool, draftQuoteTool],
})
