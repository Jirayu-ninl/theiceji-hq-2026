'use server'

import '@theiceji/hq-assets/register'
import { getOwnerSettings, setQuoteIssuer } from '@theiceji/hq-core/settings'
import type { QuoteIssuer } from '@theiceji/hq-db/schema'
import {
  createDraft,
  deleteDraft,
  getQuote,
  markDecision,
  reviseQuote,
  sendQuote,
  updateDraft,
} from '@theiceji/hq-quotes/quotes'
import '@theiceji/hq-quotes/register'
import { type ActionResult, runAction } from '@/lib/actions'
import { type QuoteDetailData, quoteDetailData } from './data'

/**
 * Quotes' server actions — the hq-quotes services. Sending, deciding,
 * revising and deleting are the owner's own acts; the services refuse
 * anyone else. Every write answers the quote as it now is.
 */

type Actor = Parameters<Parameters<typeof runAction>[0]>[0]
const detail = async (actor: Actor, id: string) =>
  quoteDetailData(await getQuote(actor, id))

export type LineInput = {
  description: string
  qty: string
  unit: string
  unitPrice: string
}

export async function quoteAction(
  quoteId: string,
): Promise<ActionResult<QuoteDetailData>> {
  return runAction((actor) => detail(actor, quoteId), { read: true })
}

export async function createDraftAction(input: {
  projectId: string | null
  title?: string
  clientId?: string | null
  fromCard?: { id: string; title?: string; price?: string | null }
  lines?: LineInput[]
}): Promise<ActionResult<QuoteDetailData>> {
  return runAction(async (actor) => {
    const quote = await createDraft(actor, {
      projectId: input.projectId,
      title: input.title,
      clientId: input.clientId ?? undefined,
      fromCard: input.fromCard,
      lines: input.lines,
    })
    return detail(actor, quote.id)
  })
}

export async function updateDraftAction(input: {
  quoteId: string
  expectedRevision: number
  title?: string
  clientId?: string | null
  /** A client by name — the active one with that name, else a new one. */
  client?: { name: string }
  vat?: boolean
  wht?: boolean
  validDays?: number
  notes?: string
  lines?: LineInput[]
}): Promise<ActionResult<QuoteDetailData>> {
  return runAction(async (actor) => {
    const quote = await updateDraft(actor, input)
    return detail(actor, quote.id)
  })
}

export async function sendQuoteAction(input: {
  quoteId: string
  expectedRevision: number
}): Promise<ActionResult<QuoteDetailData>> {
  return runAction(async (actor) => {
    const quote = await sendQuote(actor, input)
    return detail(actor, quote.id)
  })
}

export async function decideQuoteAction(input: {
  quoteId: string
  expectedRevision: number
  decision: 'accepted' | 'declined'
}): Promise<ActionResult<QuoteDetailData>> {
  return runAction(async (actor) => {
    const quote = await markDecision(actor, input)
    return detail(actor, quote.id)
  })
}

export async function reviseQuoteAction(input: {
  quoteId: string
  expectedRevision: number
}): Promise<ActionResult<QuoteDetailData>> {
  return runAction(async (actor) => {
    const quote = await reviseQuote(actor, input)
    return detail(actor, quote.id)
  })
}

export async function deleteDraftAction(input: {
  quoteId: string
  expectedRevision: number
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await deleteDraft(actor, input)
    return null
  })
}

/** Who issues the owner's quotes — printed at the top of every PDF. */
export async function saveIssuerAction(
  input: QuoteIssuer,
): Promise<ActionResult<QuoteIssuer | null>> {
  return runAction(async (actor) => {
    const current = await getOwnerSettings(actor)
    const saved = await setQuoteIssuer(actor, {
      expectedRevision: current.revision,
      ...input,
    })
    return saved.quoteIssuer
  })
}
