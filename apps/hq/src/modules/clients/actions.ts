'use server'

import { updateCard } from '@theiceji/hq-board/board'
import '@theiceji/hq-board/register'
import {
  createClient,
  deleteClient,
  listClients,
  setClientArchived,
  updateClient,
} from '@theiceji/hq-core/clients'
import { notFound, OpsError } from '@theiceji/hq-ops/errors'
import { type ActionResult, runAction } from '@/lib/actions'
import { type ClientData, type ClientDetailData, clientData } from './data'
import { loadClientDetail } from './load'

/**
 * Clients' server actions — the hq-core client services and Board's
 * `updateCard`, with the signed-in owner as actor, so the rules (unique
 * names, optimistic revisions, archive and delete are the owner's) are the
 * same here as over MCP. Every write answers the record as it now is.
 */

export type ClientFields = {
  name: string
  taxId?: string
  address?: string
  email?: string
  phone?: string
}

/** A client's cards and quotes, for the inspector on a new selection. */
export async function clientDetailAction(
  clientId: string,
): Promise<ActionResult<ClientDetailData>> {
  return runAction((actor) => loadClientDetail(actor, clientId), {
    read: true,
  })
}

/** A new client, or the selected one's name and details. */
export async function saveClientAction(
  input: ClientFields & { clientId?: string; expectedRevision?: number },
): Promise<ActionResult<ClientData>> {
  return runAction(async (actor) => {
    const fields = {
      name: input.name,
      taxId: input.taxId,
      address: input.address,
      email: input.email,
      phone: input.phone,
    }
    const row =
      input.clientId && input.expectedRevision
        ? await updateClient(actor, {
            clientId: input.clientId,
            expectedRevision: input.expectedRevision,
            ...fields,
          })
        : await createClient(actor, fields)
    return clientData(row)
  })
}

/** Archive or restore — the owner's. Cards and quotes keep naming the client. */
export async function archiveClientAction(input: {
  clientId: string
  expectedRevision: number
  archived: boolean
}): Promise<ActionResult<ClientData>> {
  return runAction(async (actor) =>
    clientData(await setClientArchived(actor, input)),
  )
}

/**
 * Delete for good — only a client nothing points at (no card in any state,
 * no quote). It can't come back; the page asks first.
 */
export async function deleteClientAction(input: {
  clientId: string
  expectedRevision: number
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await deleteClient(actor, input)
    return null
  })
}

type CardRef = { id: string; revision: number }

export type AdoptResult = {
  client: ClientData
  /** False when an active client already had the name and the cards were linked to it. */
  created: boolean
  /** The cards that now point at the client, at their new revisions. */
  cards: CardRef[]
  /** Cards that changed since the page read them, left as they were. */
  skipped: number
}

/**
 * "Add as client": a name typed once on cards becomes a record
 * — or, when an active client already has it, the cards link to that one —
 * and each card points at it instead of carrying the name. Each card keeps
 * its own revision check; one that changed meanwhile is left as it was.
 */
export async function adoptNameAction(input: {
  name: string
  clientId?: string | null
  cards: CardRef[]
}): Promise<ActionResult<AdoptResult>> {
  return runAction(async (actor) => {
    const existing = input.clientId
      ? (await listClients(actor)).find((row) => row.id === input.clientId)
      : null
    if (input.clientId && !existing) throw notFound('Client')
    const client = existing ?? (await createClient(actor, { name: input.name }))
    const cards: CardRef[] = []
    let skipped = 0
    for (const card of input.cards) {
      try {
        const saved = await updateCard(actor, {
          cardId: card.id,
          expectedRevision: card.revision,
          clientId: client.id,
        })
        cards.push({ id: saved.id, revision: saved.revision })
      } catch (error) {
        if (!(error instanceof OpsError)) throw error
        skipped++
      }
    }
    return { client: clientData(client), created: !existing, cards, skipped }
  })
}

/** Undo "Add as client": the cards carry the name once again, and a client made for it is archived. */
export async function undoAdoptAction(input: {
  name: string
  client: { id: string; revision: number }
  created: boolean
  cards: CardRef[]
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    for (const card of input.cards)
      await updateCard(actor, {
        cardId: card.id,
        expectedRevision: card.revision,
        client: input.name,
      })
    if (input.created)
      await setClientArchived(actor, {
        clientId: input.client.id,
        expectedRevision: input.client.revision,
        archived: true,
      })
    return null
  })
}
