import {
  boardCards,
  type ClientRow,
  clients,
  quoteQuotes,
} from '@theiceji/hq-db/schema'
import {
  type Actor,
  assertCan,
  can,
  type OpsCapability,
  type ScopeArea,
} from '@theiceji/hq-ops/access'
import {
  conflict,
  invalid,
  notFound,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  idempotencyKey,
  parseInput,
  recordId,
  revision,
  text,
} from '@theiceji/hq-ops/schemas'
import {
  audit,
  authorize,
  isUuid,
  type Reader,
  returned,
  runOperation,
  type Tx,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { auditSnapshot, diffFields } from '@theiceji/hq-ops/values'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { z } from 'zod'

/**
 * Clients: who the owner works for — one record for all of HQ.
 * A Board card's Client points at one (or keeps a name used once, on the
 * card only), and a quote bills one. Moved here from Quotes, rules intact:
 *
 * · **Names are unique** among the owner's active clients (case-insensitive).
 * · **Archiving hides**, never deletes: cards and quotes that name a client
 *   keep naming it; it just can't be chosen again until it is restored.
 *   Archive and restore are the owner's.
 * · **Delete is for a client nothing points at** — no card in any state
 *   (archived and in the Trash too) and no quote. It can't come back, so
 *   it is the owner's and the page asks first; a client in use is archived.
 * · **Any connection that works with clients may use them**: a Quotes or a
 *   Board connection reads and drafts them (`quotes:*` or `board:*`), and
 *   `hq:read` reads them. Writing still needs the owner's policy (`draft`).
 */

export type { ClientRow }

registerConstraintMessages({
  clients_name_key: 'You already have a client with that name.',
  clients_tax_check: 'A tax ID is 1–40 characters.',
  clients_name_check: 'A client needs a name of 1–160 characters.',
  clients_address_check: 'An address is at most 600 characters.',
})

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The area a call is authorized under: the first the actor holds, Quotes before Board before HQ. */
function areaFor(actor: Actor, capability: OpsCapability): ScopeArea {
  const areas: ScopeArea[] =
    capability === 'read' ? ['quotes', 'board', 'hq'] : ['quotes', 'board']
  return areas.find((area) => can(actor, area, capability)) ?? 'quotes'
}

const email = text
  .optional('Email', 200)
  .refine(
    (value) => value == null || EMAIL.test(value),
    'Enter an email such as name@example.com.',
  )

export const clientFields = {
  taxId: text.optional('Tax ID', 40),
  address: text.optional('Address', 600),
  email,
  phone: text.optional('Phone', 60),
}

export const newClientSchema = z.object({
  name: text.required('Client name', 160),
  ...clientFields,
})

export type NewClientInput = z.input<typeof newClientSchema>

const listSchema = z.object({ includeArchived: z.boolean().optional() })

/** The owner's clients, by name; archived ones only when asked. */
export async function listClients(
  actor: Actor,
  raw: z.input<typeof listSchema> = {},
): Promise<ClientRow[]> {
  const input = parseInput(listSchema, raw)
  return withReader(async (db) => {
    await authorize(db, actor, null, areaFor(actor, 'read'), 'read')
    return db
      .select()
      .from(clients)
      .where(
        and(
          eq(clients.ownerId, actor.userId),
          input.includeArchived ? undefined : isNull(clients.archivedAt),
        ),
      )
      .orderBy(sql`lower(${clients.name})`)
  })
}

/** One of the owner's clients; someone else's reads as not found. */
export async function ownedClient(
  reader: Reader,
  actor: Actor,
  clientId: string,
  options: { lock?: boolean } = {},
): Promise<ClientRow> {
  if (!isUuid(clientId)) throw notFound('Client')
  const query = reader
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.ownerId, actor.userId)))
    .limit(1)
  const [client] = options.lock ? await query.for('update') : await query
  if (!client) throw notFound('Client')
  return client
}

/** A client that may be chosen for new work: the owner's and not archived. */
export async function activeClient(
  reader: Reader,
  actor: Actor,
  clientId: string,
): Promise<ClientRow> {
  const client = await ownedClient(reader, actor, clientId)
  if (client.archivedAt)
    throw invalid(
      'That client is archived. Bring it back in Clients, or choose another.',
      { clientId: 'Choose an active client.' },
    )
  return client
}

/** A new client inside the caller's transaction; `projectId` only files the audit event. */
export async function insertClient(
  tx: Tx,
  actor: Actor,
  input: z.output<typeof newClientSchema>,
  projectId: string | null,
): Promise<ClientRow> {
  const [row] = await tx
    .insert(clients)
    .values({
      ownerId: actor.userId,
      createdBy: actor.userId,
      name: input.name as string,
      taxId: input.taxId ?? null,
      address: input.address ?? '',
      email: input.email ?? null,
      phone: input.phone ?? null,
    })
    .returning()
  const client = returned(row)
  await audit(tx, actor, {
    projectId,
    action: 'client.create',
    targetType: 'client',
    targetId: client.id,
    afterRevision: client.revision,
    changes: auditSnapshot({ name: client.name, taxId: client.taxId }),
  })
  return client
}

/** The active client with this name, or a new one — for "a client by name" in a draft. */
export async function clientByName(
  tx: Tx,
  actor: Actor,
  input: z.output<typeof newClientSchema>,
  projectId: string | null,
): Promise<ClientRow> {
  const [found] = await tx
    .select()
    .from(clients)
    .where(
      and(
        eq(clients.ownerId, actor.userId),
        isNull(clients.archivedAt),
        sql`lower(${clients.name}) = lower(${input.name as string})`,
      ),
    )
    .limit(1)
  return found ?? insertClient(tx, actor, input, projectId)
}

const createSchema = newClientSchema.extend({
  idempotencyKey: idempotencyKey.optional(),
})

/** A new client. Names are unique among the owner's active clients. */
export async function createClient(
  actor: Actor,
  raw: z.input<typeof createSchema>,
): Promise<ClientRow> {
  const input = parseInput(createSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'clients_create',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        await authorize(tx, actor, null, areaFor(actor, 'write'), 'write')
        return insertClient(tx, actor, input, null)
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.client_id
    if (typeof id !== 'string') throw conflict()
    return withReader(async (db) => {
      await authorize(db, actor, null, areaFor(actor, 'read'), 'read')
      return ownedClient(db, actor, id)
    })
  }
  await outcome.complete({ client_id: outcome.value.id })
  return outcome.value
}

async function saveClient(
  tx: Tx,
  client: ClientRow,
  patch: PgUpdateSetSource<typeof clients>,
): Promise<ClientRow> {
  const [row] = await tx
    .update(clients)
    .set({
      ...patch,
      revision: sql`${clients.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(clients.id, client.id), eq(clients.revision, client.revision)),
    )
    .returning()
  if (!row) throw conflict()
  return row
}

const updateSchema = z.object({
  clientId: recordId('Client'),
  expectedRevision: revision,
  name: text.required('Client name', 160).optional(),
  ...clientFields,
  idempotencyKey: idempotencyKey.optional(),
})

/**
 * Name, tax ID, address, email and phone. Absent fields stay as they are.
 * Cards and draft quotes show the new name; a PDF already sent keeps the
 * details it was printed with.
 */
export async function updateClient(
  actor: Actor,
  raw: z.input<typeof updateSchema>,
): Promise<ClientRow> {
  const input = parseInput(updateSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'clients_update',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const area = areaFor(actor, 'write')
        assertCan(actor, area, 'write')
        const client = await ownedClient(tx, actor, input.clientId, {
          lock: true,
        })
        await authorize(tx, actor, null, area, 'write')
        if (client.revision !== input.expectedRevision) throw conflict()
        const patch: Partial<typeof clients.$inferInsert> = {}
        if (input.name !== undefined) patch.name = input.name as string
        if (input.taxId !== undefined) patch.taxId = input.taxId ?? null
        if (input.address !== undefined) patch.address = input.address ?? ''
        if (input.email !== undefined) patch.email = input.email ?? null
        if (input.phone !== undefined) patch.phone = input.phone ?? null
        const changes = diffFields(
          client as unknown as Record<string, unknown>,
          patch,
        )
        if (Object.keys(changes).length === 0) return client
        const saved = await saveClient(tx, client, patch)
        await audit(tx, actor, {
          projectId: null,
          action: 'client.update',
          targetType: 'client',
          targetId: saved.id,
          beforeRevision: client.revision,
          afterRevision: saved.revision,
          changes,
        })
        return saved
      }),
  )
  if (outcome.kind === 'replay')
    return withReader(async (db) => {
      await authorize(db, actor, null, areaFor(actor, 'read'), 'read')
      return ownedClient(db, actor, input.clientId)
    })
  await outcome.complete({
    client_id: outcome.value.id,
    revision: outcome.value.revision,
  })
  return outcome.value
}

const archiveSchema = z.object({
  clientId: recordId('Client'),
  expectedRevision: revision,
  archived: z.boolean(),
})

/**
 * Take a client off the list, or bring one back. Cards and quotes that name
 * it keep naming it; it just can't be chosen for new work. The owner's.
 */
export async function setClientArchived(
  actor: Actor,
  raw: z.input<typeof archiveSchema>,
): Promise<ClientRow> {
  const input = parseInput(archiveSchema, raw)
  return withTransaction(async (tx) => {
    const area = areaFor(actor, 'write')
    assertCan(actor, area, 'write')
    const client = await ownedClient(tx, actor, input.clientId, { lock: true })
    await authorize(tx, actor, null, area, 'write', 'owner_only')
    if (client.revision !== input.expectedRevision) throw conflict()
    if (Boolean(client.archivedAt) === input.archived) return client
    const saved = await saveClient(tx, client, {
      archivedAt: input.archived ? sql`now()` : null,
    })
    await audit(tx, actor, {
      projectId: null,
      action: input.archived ? 'client.archive' : 'client.restore',
      targetType: 'client',
      targetId: saved.id,
      beforeRevision: client.revision,
      afterRevision: saved.revision,
    })
    return saved
  })
}

/** What points at a client: cards in any state (archived and in the Trash too) and quotes. */
export type ClientUse = { cards: number; quotes: number }

/**
 * The cards and quotes that point at each client — the two foreign keys
 * into `clients` (`board_cards_client_fk`, `quote_quotes_client_fk`), both
 * `restrict`, so these are exactly what would stop a delete.
 */
async function usesOf(
  reader: Reader,
  ownerId: string,
  clientIds?: string[],
): Promise<Map<string, ClientUse>> {
  const uses = new Map<string, ClientUse>()
  if (clientIds?.length === 0) return uses
  const use = (id: string) => {
    const found = uses.get(id) ?? { cards: 0, quotes: 0 }
    uses.set(id, found)
    return found
  }
  // One after the other: inside a transaction both run on its connection.
  const cards = await reader
    .select({ id: boardCards.clientId, n: sql<number>`count(*)::int` })
    .from(boardCards)
    .where(
      and(
        eq(boardCards.ownerId, ownerId),
        clientIds
          ? inArray(boardCards.clientId, clientIds)
          : sql`${boardCards.clientId} is not null`,
      ),
    )
    .groupBy(boardCards.clientId)
  const quotes = await reader
    .select({ id: quoteQuotes.clientId, n: sql<number>`count(*)::int` })
    .from(quoteQuotes)
    .where(
      and(
        eq(quoteQuotes.ownerId, ownerId),
        clientIds
          ? inArray(quoteQuotes.clientId, clientIds)
          : sql`${quoteQuotes.clientId} is not null`,
      ),
    )
    .groupBy(quoteQuotes.clientId)
  for (const row of cards) if (row.id) use(row.id).cards = row.n
  for (const row of quotes) if (row.id) use(row.id).quotes = row.n
  return uses
}

/** Every client that something points at, with what — a client missing here can be deleted. */
export async function clientUses(
  actor: Actor,
): Promise<Record<string, ClientUse>> {
  return withReader(async (db) => {
    await authorize(db, actor, null, areaFor(actor, 'read'), 'read')
    return Object.fromEntries(await usesOf(db, actor.userId))
  })
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Why a client in use can't be deleted, in words; null when nothing points at it. */
export function clientInUse(use: ClientUse | undefined): string | null {
  if (!use || (use.cards === 0 && use.quotes === 0)) return null
  const what = [
    use.cards ? count(use.cards, 'card') : null,
    use.quotes ? count(use.quotes, 'quote') : null,
  ]
    .filter(Boolean)
    .join(' and ')
  const keeps = use.cards + use.quotes === 1 ? 'keeps' : 'keep'
  return `It’s on ${what}, which ${keeps} naming it — archive it instead.`
}

const deleteSchema = z.object({
  clientId: recordId('Client'),
  expectedRevision: revision,
})

/**
 * Delete a client for good — one made by mistake, or never used. Nothing
 * may point at it: a client on a card (archived and in the Trash too) or a
 * quote is archived instead, since those keep naming it. It can't come
 * back, so it is the owner's alone, and the page asks first.
 */
export async function deleteClient(
  actor: Actor,
  raw: z.input<typeof deleteSchema>,
): Promise<ClientRow> {
  const input = parseInput(deleteSchema, raw)
  return withTransaction(async (tx) => {
    const area = areaFor(actor, 'write')
    assertCan(actor, area, 'write')
    // Locked: a card or quote that would name it now waits for this write,
    // and then finds the client gone.
    const client = await ownedClient(tx, actor, input.clientId, { lock: true })
    await authorize(tx, actor, null, area, 'write', 'owner_only')
    if (client.revision !== input.expectedRevision) throw conflict()
    const why = clientInUse(
      (await usesOf(tx, actor.userId, [client.id])).get(client.id),
    )
    if (why) throw invalid(why)
    await tx
      .delete(clients)
      .where(and(eq(clients.id, client.id), eq(clients.ownerId, actor.userId)))
    await audit(tx, actor, {
      projectId: null,
      action: 'client.delete',
      targetType: 'client',
      targetId: client.id,
      beforeRevision: client.revision,
      changes: auditSnapshot({ name: client.name, taxId: client.taxId }),
    })
    return client
  })
}
