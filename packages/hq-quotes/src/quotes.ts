import {
  assetAccess,
  insertStoredAsset,
  storeGenerated,
} from '@theiceji/hq-assets/assets'
import {
  activeClient,
  type ClientRow,
  clientByName,
  newClientSchema,
  ownedClient,
} from '@theiceji/hq-core/clients'
import { digitsOf, fromMinor, toMinor } from '@theiceji/hq-core/money'
import { link, refsOf } from '@theiceji/hq-core/refs'
import { ownerSettingsOf } from '@theiceji/hq-core/settings'
import { QUOTE_STATUSES } from '@theiceji/hq-db/enums'
import {
  clients,
  type ProjectRow,
  projects,
  type QuoteIssuer,
  type QuoteLineRow,
  type QuoteRow,
  quoteLines,
  quoteQuotes,
  type RefRow,
  refs,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan } from '@theiceji/hq-ops/access'
import { schedulerActor } from '@theiceji/hq-ops/actors'
import {
  conflict,
  invalid,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  idempotencyKey,
  optionalInt,
  optionalRecordId,
  parseInput,
  recordId,
  revision,
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
import { addDays, DEFAULT_TIME_ZONE } from '@theiceji/hq-ops/time'
import { auditSnapshot, diffFields } from '@theiceji/hq-ops/values'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  like,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { type QuotePdfInput, quotePdfName, renderQuotePdf } from './pdf'
import {
  PRICE_DIGITS,
  parseQty,
  parseUnitPrice,
  QTY_DIGITS,
  type QuoteTotals,
  quoteTotals,
  VAT_PCT,
  WHT_PCT,
} from './totals'

/**
 * Quotes: quotations for the owner's freelance work.
 *
 * · **Numbered `Q-YYYY-NNN` per owner**, the year in the project's timezone
 *   (Bangkok without a project), counted under one advisory lock per owner
 *   so two drafts made at once never share a number. Past 999 it grows.
 * · **A draft changes freely**; its figures are computed from its lines on
 *   every read (`./totals`), never stored twice.
 * · **Sending is the owner's alone** (`owner_only`): it needs a line, a
 *   client and the owner's issuer name, renders the PDF, stores it as an
 *   asset, and freezes the quote — number, client, money, dates, PDF and
 *   `totals_snapshot` (a trigger holds them). HQ never emails a client: the
 *   owner downloads the PDF and sends it themselves.
 * · **After sending** the owner records the client's answer (accepted /
 *   declined), the ops tick expires it once `valid_until` passes, and
 *   `reviseQuote` takes a sent or expired quote back to draft — the PDF that
 *   went out stays in the library.
 * · **Agents draft and nothing else**: create and edit drafts under the
 *   owner's policy (`draft`); send, decide, revise and delete are the
 *   owner's.
 * · **Clients are HQ's** (`@theiceji/hq-core/clients`): a quote
 *   bills one, and Board cards point at the same records.
 */

registerConstraintMessages({
  quote_quotes_number_key: conflict().message,
  quote_quotes_client_fk: 'That client isn’t one of yours.',
  quote_quotes_project_fk: 'That project isn’t one of yours.',
  quote_quotes_valid_check: 'A quote holds for 1 to 365 days.',
  quote_quotes_pct_check: 'VAT and withholding tax are between 0 and 30 %.',
  quote_quotes_title_check: 'A title is 1–200 characters.',
  quote_lines_qty_check: 'A quantity must be more than zero.',
  quote_lines_price_check: 'A unit price can’t be negative.',
  quote_lines_description_check: 'Each line needs a description.',
})

/* ── Shapes ─────────────────────────────────────────────────────────── */

export type QuoteLineView = QuoteLineRow & {
  /** `qty × unit price`, rounded to the currency. */
  amount: string
}

export type QuoteDetail = {
  quote: QuoteRow
  lines: QuoteLineView[]
  client: ClientRow | null
  project: ProjectRow | null
  /** The frozen snapshot once sent; computed from the lines while a draft. */
  totals: QuoteTotals
  /**
   * Every edge touching the quote: the card it quotes (`card —quoted_by→
   * quote`) and each PDF it went out as (`quote —attached→ asset`).
   */
  refs: RefRow[]
  /** The owner's issuer details (Settings), as a PDF would print them now. */
  issuer: QuoteIssuer | null
  /** What a draft still needs before it can be sent, in words; empty when ready. */
  missing: string[]
}

export type QuoteListItem = QuoteRow & {
  client: { id: string; name: string } | null
  project: Pick<
    ProjectRow,
    'id' | 'slug' | 'name' | 'color' | 'status' | 'kind'
  > | null
  totals: QuoteTotals
  lineCount: number
}

const MAX_LINES = 100

const zoneOf = (project: Pick<ProjectRow, 'timezone'> | null) =>
  project?.timezone ?? DEFAULT_TIME_ZONE

/** Today in a timezone, by the database's clock. */
async function todayIn(reader: Reader, timeZone: string): Promise<string> {
  const [row] = await reader.execute<{ today: string }>(
    sql`select ((now() at time zone ${timeZone})::date)::text as today`,
  )
  if (!row) throw new Error('The database returned no date.')
  return row.today
}

/** `a, b and c`. */
function inWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

function totalsOf(
  quote: QuoteRow,
  lines: readonly Pick<QuoteLineRow, 'qty' | 'unitPrice'>[],
): { lines: string[]; totals: QuoteTotals } {
  const computed = quoteTotals({
    currency: quote.currency,
    vatPct: quote.vatPct,
    whtPct: quote.whtPct,
    lines,
  })
  return quote.totalsSnapshot
    ? { lines: computed.lines, totals: quote.totalsSnapshot }
    : computed
}

/** What stops a draft from being sent, as the owner should read it. */
function missingToSend(
  lines: readonly unknown[],
  client: ClientRow | null,
  issuer: QuoteIssuer | null,
): { phrase: string; field: string; hint: string }[] {
  const missing: { phrase: string; field: string; hint: string }[] = []
  if (lines.length === 0)
    missing.push({
      phrase: 'add at least one line',
      field: 'lines',
      hint: 'Add at least one line.',
    })
  if (!client)
    missing.push({
      phrase: 'choose a client',
      field: 'clientId',
      hint: 'Choose a client.',
    })
  if (!issuer?.name?.trim())
    missing.push({
      phrase: 'set your name as the issuer in Settings',
      field: 'issuer',
      hint: 'Set your issuer name in Settings.',
    })
  return missing
}

/* ── Drafts ─────────────────────────────────────────────────────────── */

const amount = z.union([z.string().max(40), z.number()])

const lineSchema = z.object({
  description: text.required('Description', 600),
  /** `1` when left out. */
  qty: amount.optional(),
  /** `job`, `hour`, `ชิ้น` … */
  unit: text.optional('Unit', 24),
  unitPrice: amount,
})

export type QuoteLineInput = z.input<typeof lineSchema>

const draftFields = {
  /** An existing client; null takes the client off the draft. */
  clientId: optionalRecordId('Client'),
  /** Or a client by name: the active one with that name, else a new one. */
  client: newClientSchema.optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, like THB.')
    .optional(),
  /** VAT 7 % on or off. */
  vat: z.boolean().optional(),
  /** Withholding tax 3 % on or off. */
  wht: z.boolean().optional(),
  validDays: optionalInt('Valid days', 1, 365),
  notes: text.optional('Notes', 4000),
  /** The whole list, in order — it replaces the lines there were. */
  lines: z
    .array(lineSchema)
    .max(MAX_LINES, `A quote holds at most ${MAX_LINES} lines.`)
    .optional(),
}

type NormalizedLine = {
  description: string
  qty: string
  unit: string
  unitPrice: string
  position: number
}

/** Lines as stored, or `invalid` naming the first line that doesn't fit. */
function normalizeLines(
  lines: readonly z.output<typeof lineSchema>[],
  currency: string,
): NormalizedLine[] {
  const fields: Record<string, string> = {}
  const out = lines.map((line, position) => {
    const qty = parseQty(line.qty ?? '1')
    const price = parseUnitPrice(line.unitPrice, currency)
    if ('error' in qty) fields[`lines.${position}.qty`] ??= qty.error
    if ('error' in price) fields[`lines.${position}.unitPrice`] ??= price.error
    return {
      description: line.description as string,
      qty: 'ok' in qty ? qty.ok : '1',
      unit: line.unit ?? '',
      unitPrice: 'ok' in price ? price.ok : '0',
      position,
    }
  })
  const [first] = Object.entries(fields)
  if (first) {
    const index = Number(first[0].split('.')[1]) + 1
    throw invalid(`Line ${index}: ${first[1]}`, fields)
  }
  return out
}

async function writeLines(
  tx: Tx,
  actor: Actor,
  quoteId: string,
  lines: readonly NormalizedLine[],
): Promise<void> {
  if (lines.length === 0) return
  await tx
    .insert(quoteLines)
    .values(lines.map((line) => ({ ...line, ownerId: actor.userId, quoteId })))
}

/**
 * The client a draft should name: the one chosen (active and the owner's),
 * one found or made by name, null to clear, or undefined for "unchanged".
 */
async function resolveClient(
  tx: Tx,
  actor: Actor,
  input: {
    clientId?: string | null
    client?: z.output<typeof newClientSchema>
  },
  projectId: string | null,
): Promise<ClientRow | null | undefined> {
  if (input.client) return clientByName(tx, actor, input.client, projectId)
  if (input.clientId === null) return null
  if (input.clientId === undefined) return undefined
  return activeClient(tx, actor, input.clientId)
}

/** The next `Q-YYYY-NNN` for the owner — call inside the transaction that inserts it. */
async function nextNumber(
  tx: Tx,
  ownerId: string,
  timeZone: string,
): Promise<string> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`quote-numbers:${ownerId}`}, 0))`,
  )
  const [clock] = await tx.execute<{ year: string }>(
    sql`select to_char(now() at time zone ${timeZone}, 'YYYY') as year`,
  )
  const prefix = `Q-${clock?.year}-`
  const [last] = await tx
    .select({
      // The CHECK guarantees `Q-YYYY-<digits>`; compared as numbers, so 1000 follows 999.
      n: sql<number>`coalesce(max(split_part(${quoteQuotes.number}, '-', 3)::int), 0)::int`,
    })
    .from(quoteQuotes)
    .where(
      and(
        eq(quoteQuotes.ownerId, ownerId),
        like(quoteQuotes.number, `${prefix}%`),
      ),
    )
  return `${prefix}${String((last?.n ?? 0) + 1).padStart(3, '0')}`
}

const createSchema = z.object({
  /** Normally set; a quote in no project is allowed. */
  projectId: optionalRecordId('Project'),
  /** Required unless `fromCard` names one. */
  title: text.optional('Title', 200),
  ...draftFields,
  /**
   * The board card this quotes — its id, and the title and price the caller
   * read from it. Quotes never reads Board's tables; it links
   * `card —quoted_by→ quote` and, when no lines are given, starts with one
   * line at the card's price.
   */
  fromCard: z
    .object({
      id: recordId('Card'),
      title: text.optional('Card title', 200),
      price: amount.nullable().optional(),
    })
    .optional(),
  idempotencyKey: idempotencyKey.optional(),
})

export type CreateDraftInput = z.input<typeof createSchema>

async function insertDraft(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  input: z.output<typeof createSchema>,
): Promise<QuoteRow> {
  const title = input.title ?? input.fromCard?.title
  if (!title)
    throw invalid('Title is required.', { title: 'Title is required.' })
  const currency = input.currency ?? project?.currency ?? 'THB'
  const client = await resolveClient(tx, actor, input, project?.id ?? null)
  const cardPrice = input.fromCard?.price
  const lines = normalizeLines(
    input.lines ??
      (cardPrice !== undefined && cardPrice !== null && cardPrice !== ''
        ? [{ description: title, qty: '1', unit: null, unitPrice: cardPrice }]
        : []),
    currency,
  )
  const number = await nextNumber(tx, actor.userId, zoneOf(project))
  const [row] = await tx
    .insert(quoteQuotes)
    .values({
      ownerId: actor.userId,
      createdBy: actor.userId,
      projectId: project?.id ?? null,
      clientId: client?.id ?? null,
      number,
      title,
      currency,
      vatPct: input.vat ? VAT_PCT : '0',
      whtPct: input.wht ? WHT_PCT : '0',
      validDays: input.validDays ?? 30,
      notes: input.notes ?? '',
    })
    .returning()
  const quote = returned(row)
  await writeLines(tx, actor, quote.id, lines)
  if (input.fromCard)
    await link(
      tx,
      actor,
      { type: 'card', id: input.fromCard.id },
      { type: 'quote', id: quote.id },
      'quoted_by',
    )
  await audit(tx, actor, {
    projectId: quote.projectId,
    action: 'quotes.quote.create',
    targetType: 'quote',
    targetId: quote.id,
    afterRevision: quote.revision,
    changes: auditSnapshot({
      number,
      title,
      currency,
      client: client?.name ?? null,
      lines: lines.length,
      vatPct: quote.vatPct,
      whtPct: quote.whtPct,
      fromCard: input.fromCard?.id,
    }),
  })
  return quote
}

/**
 * A new draft with the next number. The project's Quotes must be on; the
 * currency is the project's unless given. An agent needs the owner's policy
 * to allow drafting.
 */
export async function createDraft(
  actor: Actor,
  raw: CreateDraftInput,
): Promise<QuoteRow> {
  const input = parseInput(createSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'quotes_create_draft',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        let project: ProjectRow | null = null
        if (input.projectId) {
          project = await ownedProject(
            tx,
            actor,
            input.projectId,
            'quotes',
            'write',
          )
          assertModuleOn(project, 'quotes')
        } else {
          await authorize(tx, actor, null, 'quotes', 'write')
        }
        return insertDraft(tx, actor, project, input)
      }),
  )
  if (outcome.kind === 'replay') {
    // The stored answer names the quote; the first audited target may be a
    // client this call made on its way.
    const id = outcome.response?.quote_id
    if (typeof id !== 'string') throw conflict()
    return readQuote(actor, id)
  }
  await outcome.complete({
    quote_id: outcome.value.id,
    number: outcome.value.number,
  })
  return outcome.value
}

/** Load a quote for a write, locked, with its project; checks the revision. */
async function quoteForWrite(
  tx: Tx,
  actor: Actor,
  quoteId: string,
  expectedRevision: number,
  requirement?: 'owner_only',
): Promise<{ quote: QuoteRow; project: ProjectRow | null }> {
  assertCan(actor, 'quotes', 'write')
  const { row: quote, project } = await ownedRow<QuoteRow>(
    tx,
    actor,
    quoteQuotes,
    quoteId,
    'Quote',
    { lock: true },
  )
  await authorize(tx, actor, project, 'quotes', 'write', requirement)
  if (project) assertModuleOn(project, 'quotes')
  if (quote.revision !== expectedRevision) throw conflict()
  return { quote, project }
}

async function saveQuote(
  tx: Tx,
  quote: QuoteRow,
  patch: PgUpdateSetSource<typeof quoteQuotes>,
): Promise<QuoteRow> {
  const [row] = await tx
    .update(quoteQuotes)
    .set({
      ...patch,
      revision: sql`${quoteQuotes.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(quoteQuotes.id, quote.id),
        eq(quoteQuotes.revision, quote.revision),
      ),
    )
    .returning()
  if (!row) throw conflict()
  return row
}

const updateSchema = z.object({
  quoteId: recordId('Quote'),
  expectedRevision: revision,
  title: text.required('Title', 200).optional(),
  ...draftFields,
  idempotencyKey: idempotencyKey.optional(),
})

export type UpdateDraftInput = z.input<typeof updateSchema>

/**
 * Title, client, currency, VAT and WHT on or off, valid days, notes and the
 * whole line list (replaced in order). Absent fields stay as they are. Only
 * a draft changes — a sent quote is revised back to draft first.
 */
export async function updateDraft(
  actor: Actor,
  raw: UpdateDraftInput,
): Promise<QuoteRow> {
  const input = parseInput(updateSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'quotes_update_draft',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { quote } = await quoteForWrite(
          tx,
          actor,
          input.quoteId,
          input.expectedRevision,
        )
        if (quote.status !== 'draft')
          throw invalid(
            'This quote was sent, so it doesn’t change. Revise it back to a draft first.',
          )
        const patch: Partial<typeof quoteQuotes.$inferInsert> = {}
        if (input.title !== undefined) patch.title = input.title as string
        if (input.currency !== undefined) patch.currency = input.currency
        // Numeric columns read back as `7.00`: only a real switch is a change.
        if (input.vat !== undefined && input.vat !== Number(quote.vatPct) > 0)
          patch.vatPct = input.vat ? VAT_PCT : '0'
        if (input.wht !== undefined && input.wht !== Number(quote.whtPct) > 0)
          patch.whtPct = input.wht ? WHT_PCT : '0'
        if (input.validDays !== undefined && input.validDays !== null)
          patch.validDays = input.validDays
        if (input.notes !== undefined) patch.notes = input.notes ?? ''
        const client = await resolveClient(tx, actor, input, quote.projectId)
        if (client !== undefined) patch.clientId = client?.id ?? null
        const currency = patch.currency ?? quote.currency
        const before = await linesOf(tx, [quote.id])
        // Every price must fit the currency's digits — new lines, or the
        // lines already there when only the currency changes.
        const lines = input.lines ? normalizeLines(input.lines, currency) : null
        if (!lines && currency !== quote.currency)
          normalizeLines(before, currency)
        const changes = diffFields(
          quote as unknown as Record<string, unknown>,
          patch,
        )
        const sameLines =
          !lines ||
          (before.length === lines.length &&
            lines.every((next, i) => {
              const row = before[i]
              return (
                row !== undefined &&
                row.description === next.description &&
                row.unit === next.unit &&
                toMinor(row.qty, QTY_DIGITS) ===
                  toMinor(next.qty, QTY_DIGITS) &&
                toMinor(row.unitPrice, PRICE_DIGITS) ===
                  toMinor(next.unitPrice, PRICE_DIGITS)
              )
            }))
        if (lines && !sameLines)
          changes.lines = { from: before.length, to: lines.length }
        if (Object.keys(changes).length === 0) return quote
        const saved = await saveQuote(tx, quote, patch)
        if (lines && !sameLines) {
          await tx.delete(quoteLines).where(eq(quoteLines.quoteId, quote.id))
          await writeLines(tx, actor, quote.id, lines)
        }
        await audit(tx, actor, {
          projectId: saved.projectId,
          action: 'quotes.quote.update',
          targetType: 'quote',
          targetId: saved.id,
          beforeRevision: quote.revision,
          afterRevision: saved.revision,
          changes,
        })
        return saved
      }),
  )
  if (outcome.kind === 'replay') return readQuote(actor, input.quoteId)
  await outcome.complete({
    quote_id: outcome.value.id,
    revision: outcome.value.revision,
  })
  return outcome.value
}

/* ── Reading ────────────────────────────────────────────────────────── */

async function linesOf(
  reader: Reader,
  quoteIds: readonly string[],
): Promise<QuoteLineRow[]> {
  if (quoteIds.length === 0) return []
  return reader
    .select()
    .from(quoteLines)
    .where(inArray(quoteLines.quoteId, [...quoteIds]))
    .orderBy(asc(quoteLines.quoteId), asc(quoteLines.position))
}

/** One quote row, for a caller who may read Quotes. */
export async function readQuote(
  actor: Actor,
  quoteId: string,
): Promise<QuoteRow> {
  return withReader(async (db) => {
    const { row } = await ownedRecord<QuoteRow>(
      db,
      actor,
      quoteQuotes,
      quoteId,
      'quotes',
      'read',
      'Quote',
    )
    return row
  })
}

async function detailOf(
  reader: Reader,
  actor: Actor,
  quote: QuoteRow,
  project: ProjectRow | null,
): Promise<QuoteDetail> {
  const [lines, client, edges, settings] = await Promise.all([
    linesOf(reader, [quote.id]),
    quote.clientId
      ? ownedClient(reader, actor, quote.clientId)
      : Promise.resolve(null),
    refsOf(reader, actor.userId, { type: 'quote', id: quote.id }),
    ownerSettingsOf(reader, actor.userId),
  ])
  const figures = totalsOf(quote, lines)
  return {
    quote,
    lines: lines.map((line, i) => ({
      ...line,
      amount: figures.lines[i] ?? '0',
    })),
    client,
    project,
    totals: figures.totals,
    refs: edges,
    issuer: settings.quoteIssuer,
    missing:
      quote.status === 'draft'
        ? missingToSend(lines, client, settings.quoteIssuer).map(
            (entry) => entry.hint,
          )
        : [],
  }
}

/** One quote with its lines, client, figures, links and what it still needs. */
export async function getQuote(
  actor: Actor,
  quoteId: string,
): Promise<QuoteDetail> {
  return withReader(async (db) => {
    const { row, project } = await ownedRecord<QuoteRow>(
      db,
      actor,
      quoteQuotes,
      quoteId,
      'quotes',
      'read',
      'Quote',
    )
    return detailOf(db, actor, row, project)
  })
}

const statusSchema = z.enum(QUOTE_STATUSES, {
  error: 'Choose draft, sent, accepted, declined or expired.',
})

const listSchema = z.object({
  projectId: z.uuid().optional(),
  status: z.union([statusSchema, z.array(statusSchema)]).optional(),
  clientId: z.uuid().optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

export type ListQuotesInput = z.input<typeof listSchema>

/**
 * Quotes, newest first — one project's, or every project with Quotes on
 * plus quotes in no project (the global `/quotes`). Archived projects leave
 * the everywhere-list. Each comes with its figures.
 */
export async function listQuotes(
  actor: Actor,
  raw: ListQuotesInput = {},
): Promise<QuoteListItem[]> {
  const input = parseInput(listSchema, raw)
  const statuses =
    input.status === undefined
      ? null
      : Array.isArray(input.status)
        ? input.status
        : [input.status]
  return withReader(async (db) => {
    if (input.projectId) {
      const project = await ownedProject(
        db,
        actor,
        input.projectId,
        'quotes',
        'read',
      )
      assertModuleOn(project, 'quotes')
    } else {
      await authorize(db, actor, null, 'quotes', 'read')
    }
    const rows = await db
      .select({
        quote: quoteQuotes,
        client: { id: clients.id, name: clients.name },
        project: {
          id: projects.id,
          slug: projects.slug,
          name: projects.name,
          color: projects.color,
          status: projects.status,
          kind: projects.kind,
        },
      })
      .from(quoteQuotes)
      .leftJoin(clients, eq(clients.id, quoteQuotes.clientId))
      .leftJoin(projects, eq(projects.id, quoteQuotes.projectId))
      .where(
        and(
          eq(quoteQuotes.ownerId, actor.userId),
          input.projectId
            ? eq(quoteQuotes.projectId, input.projectId)
            : sql`(${quoteQuotes.projectId} is null or (${projects.status} <> 'archived' and ${projects.modules} -> 'enabled' ? 'quotes'))`,
          statuses ? inArray(quoteQuotes.status, statuses) : undefined,
          input.clientId ? eq(quoteQuotes.clientId, input.clientId) : undefined,
        ),
      )
      .orderBy(desc(quoteQuotes.createdAt), desc(quoteQuotes.number))
      .limit(input.limit ?? 200)
    const lines = await linesOf(
      db,
      rows.map((row) => row.quote.id),
    )
    const byQuote = new Map<string, QuoteLineRow[]>()
    for (const line of lines) {
      const list = byQuote.get(line.quoteId) ?? []
      list.push(line)
      byQuote.set(line.quoteId, list)
    }
    return rows.map((row) => {
      const own = byQuote.get(row.quote.id) ?? []
      return {
        ...row.quote,
        client: row.client?.id ? row.client : null,
        project: row.project?.id ? row.project : null,
        totals: totalsOf(row.quote, own).totals,
        lineCount: own.length,
      }
    })
  })
}

/* ── The PDF ────────────────────────────────────────────────────────── */

function pdfInput(
  detail: QuoteDetail,
  issuer: QuoteIssuer | null,
  dates: { issuedOn: string; validUntil: string },
  draft: boolean,
): QuotePdfInput {
  const { quote, client } = detail
  return {
    number: quote.number,
    title: quote.title,
    draft,
    issuedOn: dates.issuedOn,
    validUntil: dates.validUntil,
    currency: quote.currency,
    issuer,
    client: client
      ? {
          name: client.name,
          taxId: client.taxId,
          address: client.address,
          email: client.email,
          phone: client.phone,
        }
      : null,
    lines: detail.lines.map((line) => ({
      description: line.description,
      qty: line.qty,
      unit: line.unit,
      unitPrice: line.unitPrice,
      amount: line.amount,
    })),
    totals: detail.totals,
    notes: quote.notes,
  }
}

/**
 * The quote as it would print now — for the editor's Preview and a
 * download of a draft. Nothing is stored. A draft is dated today (the
 * project's day) and marked "Draft · not sent"; without an issuer it says
 * so. A sent quote re-renders from its frozen figures, but the PDF the
 * client got is the stored one (`quotePdfUrl`).
 */
export async function previewQuotePdf(
  actor: Actor,
  quoteId: string,
): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer>; draft: boolean }> {
  const { input } = await withReader(async (db) => {
    const { row, project } = await ownedRecord<QuoteRow>(
      db,
      actor,
      quoteQuotes,
      quoteId,
      'quotes',
      'read',
      'Quote',
    )
    const detail = await detailOf(db, actor, row, project)
    const issuedOn = row.issuedOn ?? (await todayIn(db, zoneOf(project)))
    const validUntil = row.validUntil ?? addDays(issuedOn, row.validDays)
    return {
      input: pdfInput(
        detail,
        detail.issuer,
        { issuedOn, validUntil },
        row.status === 'draft',
      ),
    }
  })
  return {
    name: quotePdfName(input.number),
    bytes: await renderQuotePdf(input),
    draft: input.draft,
  }
}

/**
 * A short-lived link to the PDF the client got — the stored asset, never a
 * re-render. Needs `assets:read` as well as `quotes:read`.
 */
export async function quotePdfUrl(
  actor: Actor,
  quoteId: string,
  options: { download?: boolean; ttlSeconds?: number } = {},
): Promise<{ url: string; expiresAt: Date; name: string; assetId: string }> {
  const quote = await readQuote(actor, quoteId)
  if (!quote.pdfAssetId)
    throw invalid(
      'This quote hasn’t been sent, so it has no PDF yet. Preview it instead.',
    )
  const access = await assetAccess(actor, {
    assetId: quote.pdfAssetId,
    download: options.download,
    ttlSeconds: options.ttlSeconds,
  })
  return {
    url: access.url,
    expiresAt: access.expiresAt,
    name: access.asset.name,
    assetId: access.asset.id,
  }
}

/* ── Sending and after ──────────────────────────────────────────────── */

const decideSchema = z.object({
  quoteId: recordId('Quote'),
  expectedRevision: revision,
})

/** Where a sent PDF goes — `storeGenerated`, or a stand-in in tests. */
export type StorePdf = typeof storeGenerated

/**
 * The owner sends a draft: it needs at least one line, a
 * client and the owner's issuer name — the refusal says which are missing.
 * The PDF is rendered and stored first (outside any transaction), then in
 * one transaction: the ready asset in the project's "Quotes" collection,
 * the quote `sent` with today's date in its zone, `valid_until`, `sent_at`,
 * the frozen totals and the PDF, `quote —attached→ asset`, and the audit.
 * If the quote changed in between, nothing is sent (the orphan file is
 * harmless). Never an agent's.
 */
export async function sendQuote(
  actor: Actor,
  raw: z.input<typeof decideSchema>,
  deps: { store?: StorePdf } = {},
): Promise<QuoteRow> {
  const input = parseInput(decideSchema, raw)
  const store = deps.store ?? storeGenerated
  const ready = await withReader(async (db) => {
    const { row: quote, project } = await ownedRow<QuoteRow>(
      db,
      actor,
      quoteQuotes,
      input.quoteId,
      'Quote',
    )
    await authorize(db, actor, project, 'quotes', 'write', 'owner_only')
    if (project) assertModuleOn(project, 'quotes')
    if (quote.revision !== input.expectedRevision) throw conflict()
    if (quote.status !== 'draft')
      throw invalid(
        'This quote was already sent. Revise it back to a draft to send it again.',
      )
    const detail = await detailOf(db, actor, quote, project)
    const missing = missingToSend(detail.lines, detail.client, detail.issuer)
    if (missing.length > 0)
      throw invalid(
        `To send this quote, ${inWords(missing.map((entry) => entry.phrase))}.`,
        Object.fromEntries(missing.map((entry) => [entry.field, entry.hint])),
      )
    const issuedOn = await todayIn(db, zoneOf(project))
    const validUntil = addDays(issuedOn, quote.validDays)
    return {
      project,
      totals: detail.totals,
      issuedOn,
      validUntil,
      pdf: pdfInput(detail, detail.issuer, { issuedOn, validUntil }, false),
    }
  })
  const bytes = await renderQuotePdf(ready.pdf)
  const stored = await store(actor, ready.project, {
    name: quotePdfName(ready.pdf.number),
    mime: 'application/pdf',
    body: bytes,
    collection: 'Quotes',
  })
  return withTransaction(async (tx) => {
    const { quote, project } = await quoteForWrite(
      tx,
      actor,
      input.quoteId,
      input.expectedRevision,
      'owner_only',
    )
    if (quote.status !== 'draft') throw conflict()
    const asset = await insertStoredAsset(tx, actor, project, stored, {
      collection: 'Quotes',
      tags: ['quote'],
    })
    const saved = await saveQuote(tx, quote, {
      status: 'sent',
      issuedOn: ready.issuedOn,
      validUntil: ready.validUntil,
      sentAt: sql`now()`,
      totalsSnapshot: ready.totals,
      pdfAssetId: asset.id,
    })
    await link(
      tx,
      actor,
      { type: 'quote', id: saved.id },
      { type: 'asset', id: asset.id },
      'attached',
    )
    await audit(tx, actor, {
      projectId: saved.projectId,
      action: 'quotes.quote.send',
      targetType: 'quote',
      targetId: saved.id,
      beforeRevision: quote.revision,
      afterRevision: saved.revision,
      changes: {
        number: saved.number,
        issuedOn: ready.issuedOn,
        validUntil: ready.validUntil,
        currency: ready.totals.currency,
        total: ready.totals.total,
        pdfAssetId: asset.id,
      },
    })
    return saved
  })
}

const decisionSchema = decideSchema.extend({
  decision: z.enum(['accepted', 'declined'], {
    error: 'Choose accepted or declined.',
  }),
})

/** The client's answer to a sent quote: accepted or declined. The owner's. */
export async function markDecision(
  actor: Actor,
  raw: z.input<typeof decisionSchema>,
): Promise<QuoteRow> {
  const input = parseInput(decisionSchema, raw)
  return withTransaction(async (tx) => {
    const { quote } = await quoteForWrite(
      tx,
      actor,
      input.quoteId,
      input.expectedRevision,
      'owner_only',
    )
    if (quote.status !== 'sent')
      throw invalid(
        quote.status === 'draft'
          ? 'Send this quote before recording the client’s answer.'
          : quote.status === 'expired'
            ? 'This quote expired. Revise it and send it again.'
            : 'The client’s answer is already recorded.',
      )
    const saved = await saveQuote(tx, quote, {
      status: input.decision,
      decidedAt: sql`now()`,
    })
    await audit(tx, actor, {
      projectId: saved.projectId,
      action:
        input.decision === 'accepted'
          ? 'quotes.quote.accept'
          : 'quotes.quote.decline',
      targetType: 'quote',
      targetId: saved.id,
      beforeRevision: quote.revision,
      afterRevision: saved.revision,
      changes: { status: { from: quote.status, to: saved.status } },
    })
    return saved
  })
}

/**
 * A sent or expired quote back to draft, to change and send again. Its
 * number stays; the send (dates, frozen totals, the PDF link) is cleared,
 * and the PDF that went out stays in the library, still linked from the
 * quote. The owner's.
 */
export async function reviseQuote(
  actor: Actor,
  raw: z.input<typeof decideSchema>,
): Promise<QuoteRow> {
  const input = parseInput(decideSchema, raw)
  return withTransaction(async (tx) => {
    const { quote } = await quoteForWrite(
      tx,
      actor,
      input.quoteId,
      input.expectedRevision,
      'owner_only',
    )
    if (quote.status !== 'sent' && quote.status !== 'expired')
      throw invalid(
        quote.status === 'draft'
          ? 'This quote is already a draft.'
          : 'The client already answered this quote. Make a new one instead.',
      )
    const saved = await saveQuote(tx, quote, {
      status: 'draft',
      issuedOn: null,
      validUntil: null,
      sentAt: null,
      totalsSnapshot: null,
      pdfAssetId: null,
      decidedAt: null,
    })
    await audit(tx, actor, {
      projectId: saved.projectId,
      action: 'quotes.quote.revise',
      targetType: 'quote',
      targetId: saved.id,
      beforeRevision: quote.revision,
      afterRevision: saved.revision,
      changes: {
        status: { from: quote.status, to: 'draft' },
        sentPdf: quote.pdfAssetId,
      },
    })
    return saved
  })
}

/**
 * Delete a draft that never went out, with its lines and links. A quote
 * that was sent once keeps its number on record — it can be revised and
 * sent again, never deleted. The owner's.
 */
export async function deleteDraft(
  actor: Actor,
  raw: z.input<typeof decideSchema>,
): Promise<void> {
  const input = parseInput(decideSchema, raw)
  await withTransaction(async (tx) => {
    const { quote } = await quoteForWrite(
      tx,
      actor,
      input.quoteId,
      input.expectedRevision,
      'owner_only',
    )
    if (quote.status !== 'draft') throw invalid('Only a draft can be deleted.')
    const edge = (end: 'from' | 'to'): SQL | undefined =>
      end === 'from'
        ? and(eq(refs.fromType, 'quote'), eq(refs.fromId, quote.id))
        : and(eq(refs.toType, 'quote'), eq(refs.toId, quote.id))
    const [sent] = await tx
      .select({ id: refs.id })
      .from(refs)
      .where(
        and(
          eq(refs.ownerId, actor.userId),
          edge('from'),
          eq(refs.toType, 'asset'),
          eq(refs.role, 'attached'),
        ),
      )
      .limit(1)
    if (sent)
      throw invalid(
        `${quote.number} went to a client once, so it stays on record. Revise it and send it again, or leave it as a draft.`,
      )
    await tx
      .delete(refs)
      .where(and(eq(refs.ownerId, actor.userId), or(edge('from'), edge('to'))))
    await tx.delete(quoteQuotes).where(eq(quoteQuotes.id, quote.id))
    await audit(tx, actor, {
      projectId: quote.projectId,
      action: 'quotes.quote.delete',
      targetType: 'quote',
      targetId: quote.id,
      beforeRevision: quote.revision,
      changes: { number: quote.number, title: quote.title },
    })
  })
}

/* ── The clock (the ops tick) ───────────────────────────────────────── */

/**
 * Sent quotes past `valid_until` — in their project's timezone, Bangkok
 * without one — become `expired`, audited as the scheduler. A small batch
 * per tick; the rest wait for the next. Returns how many expired.
 */
export async function expireQuotes(
  options: { limit?: number } = {},
): Promise<number> {
  return withTransaction(async (tx) => {
    const due = await tx
      .select({ quote: quoteQuotes })
      .from(quoteQuotes)
      .leftJoin(projects, eq(projects.id, quoteQuotes.projectId))
      .where(
        and(
          eq(quoteQuotes.status, 'sent'),
          sql`${quoteQuotes.validUntil} < (now() at time zone coalesce(${projects.timezone}, ${DEFAULT_TIME_ZONE}))::date`,
        ),
      )
      .orderBy(asc(quoteQuotes.validUntil))
      .limit(options.limit ?? 200)
      .for('update', { of: quoteQuotes, skipLocked: true })
    let expired = 0
    for (const { quote } of due) {
      const [row] = await tx
        .update(quoteQuotes)
        .set({
          status: 'expired',
          revision: sql`${quoteQuotes.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(quoteQuotes.id, quote.id), eq(quoteQuotes.status, 'sent')),
        )
        .returning()
      if (!row) continue
      expired += 1
      await audit(tx, schedulerActor(row.ownerId), {
        projectId: row.projectId,
        action: 'quotes.quote.expire',
        targetType: 'quote',
        targetId: row.id,
        beforeRevision: quote.revision,
        afterRevision: row.revision,
        changes: { validUntil: row.validUntil },
      })
    }
    return expired
  })
}

/* ── Summaries (Home) ───────────────────────────────────────────────── */

export type QuoteSummary = {
  /** Null for quotes in no project. */
  projectId: string | null
  currency: string
  drafts: number
  /** Sent and not yet answered or expired. */
  open: number
  /** The sum of the open quotes' sent totals — money quoted, not yet won. */
  pending: string
  /** Open quotes whose last valid day is within 7 days of the project's today (or past it). */
  expiringSoon: number
}

/**
 * Per project and currency: drafts, open quotes, what they add up to, and
 * how many run out within a week. Archived projects are left out.
 */
export async function quoteSummaries(actor: Actor): Promise<QuoteSummary[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'quotes', 'read')
    const today = sql`(now() at time zone coalesce(${projects.timezone}, ${DEFAULT_TIME_ZONE}))::date`
    const rows = await db
      .select({
        projectId: quoteQuotes.projectId,
        currency: quoteQuotes.currency,
        drafts: sql<number>`count(*) filter (where ${quoteQuotes.status} = 'draft')::int`,
        open: sql<number>`count(*) filter (where ${quoteQuotes.status} = 'sent')::int`,
        pending: sql<
          string | null
        >`(sum((${quoteQuotes.totalsSnapshot} ->> 'total')::numeric) filter (where ${quoteQuotes.status} = 'sent'))::text`,
        expiringSoon: sql<number>`count(*) filter (where ${quoteQuotes.status} = 'sent' and ${quoteQuotes.validUntil} <= ${today} + 7)::int`,
      })
      .from(quoteQuotes)
      .leftJoin(projects, eq(projects.id, quoteQuotes.projectId))
      .where(
        and(
          eq(quoteQuotes.ownerId, actor.userId),
          sql`(${quoteQuotes.projectId} is null or ${projects.status} <> 'archived')`,
        ),
      )
      .groupBy(quoteQuotes.projectId, quoteQuotes.currency, projects.timezone)
    return rows
      .filter((row) => row.drafts > 0 || row.open > 0)
      .map((row) => ({
        projectId: row.projectId,
        currency: row.currency,
        drafts: row.drafts,
        open: row.open,
        pending: row.pending ?? fromMinor(0n, digitsOf(row.currency)),
        expiringSoon: row.expiringSoon,
      }))
  })
}
