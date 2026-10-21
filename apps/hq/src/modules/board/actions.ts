'use server'

import {
  createCard,
  createLane,
  deleteLane,
  getCard,
  markPaid,
  moveCard,
  moveLane,
  renameLane,
  setCardArchived,
  setCardDeleted,
  unmarkPaid,
  updateCard,
} from '@theiceji/hq-board/board'
import {
  addFollowup,
  setFollowupArchived,
  updateFollowup,
} from '@theiceji/hq-board/followups'
import {
  attachFile,
  type CardFileLink,
  type CardPromptLink,
  cardLinks,
  setPrompt,
  unlinkFromCard,
} from '@theiceji/hq-board/links'
import { recordPayment, voidPayment } from '@theiceji/hq-board/payments'
import '@theiceji/hq-board/register'
import { previewsFor } from '@theiceji/hq-assets/assets'
import { createClient } from '@theiceji/hq-core/clients'
import { listRefs } from '@theiceji/hq-core/refs'
import { listPrompts, savePrompt } from '@theiceji/hq-prompts/prompts'
import { type ActionResult, runAction } from '@/lib/actions'
import {
  type CardData,
  type ClientOption,
  cardData,
  clientOption,
  type FollowupData,
  followupData,
  type LaneData,
  laneData,
  type PaymentData,
  paymentData,
} from './data'

/**
 * Board's server actions: each checks the session, runs
 * the hq-board service the MCP tools also run, and answers an ActionResult
 * the view can roll back on. Every write returns the card as it now is, so
 * the view keeps the revision for the next write.
 */

export async function createCardAction(input: {
  projectId: string
  laneId?: string
  title: string
  price?: string | null
  dueOn?: string | null
  clientId?: string | null
  client?: string | null
}): Promise<ActionResult<CardData>> {
  return runAction(async (actor) => cardData(await createCard(actor, input)))
}

export async function updateCardAction(input: {
  cardId: string
  expectedRevision: number
  title?: string
  body?: string
  labels?: string[]
  price?: string | null
  currency?: string | null
  dueOn?: string | null
  client?: string | null
  clientId?: string | null
  color?: string | null
}): Promise<ActionResult<CardData>> {
  return runAction(async (actor) =>
    cardData(
      await updateCard(actor, {
        ...input,
        color: input.color as Parameters<typeof updateCard>[1]['color'],
      }),
    ),
  )
}

export async function moveCardAction(input: {
  cardId: string
  expectedRevision: number
  laneId: string
  position?: number
}): Promise<ActionResult<CardData>> {
  return runAction(async (actor) => cardData(await moveCard(actor, input)))
}

export async function markPaidAction(input: {
  cardId: string
  expectedRevision: number
}): Promise<ActionResult<CardData>> {
  return runAction(async (actor) => cardData(await markPaid(actor, input)))
}

export async function unmarkPaidAction(input: {
  cardId: string
  expectedRevision: number
}): Promise<ActionResult<CardData>> {
  return runAction(async (actor) => cardData(await unmarkPaid(actor, input)))
}

export async function archiveCardAction(input: {
  cardId: string
  expectedRevision: number
  archived: boolean
}): Promise<ActionResult<CardData>> {
  return runAction(async (actor) =>
    cardData(await setCardArchived(actor, input)),
  )
}

/** Delete to the Trash (`deleted: true`) or restore from it — the owner's. */
export async function deleteCardAction(input: {
  cardId: string
  expectedRevision: number
  deleted: boolean
}): Promise<ActionResult<CardData>> {
  return runAction(async (actor) =>
    cardData(await setCardDeleted(actor, input)),
  )
}

/* ── Lanes ── the owner's to shape; each answers the lane as it now is */

export async function createLaneAction(input: {
  projectId: string
  name: string
}): Promise<ActionResult<LaneData>> {
  return runAction(async (actor) => laneData(await createLane(actor, input)))
}

export async function renameLaneAction(input: {
  laneId: string
  name: string
}): Promise<ActionResult<LaneData>> {
  return runAction(async (actor) => laneData(await renameLane(actor, input)))
}

export async function moveLaneAction(input: {
  laneId: string
  direction: -1 | 1
}): Promise<ActionResult<LaneData>> {
  return runAction(async (actor) => laneData(await moveLane(actor, input)))
}

export async function deleteLaneAction(input: {
  laneId: string
}): Promise<
  ActionResult<{ lane: LaneData; moved: number; into: string | null }>
> {
  return runAction(async (actor) => {
    const done = await deleteLane(actor, input)
    return {
      lane: laneData(done.lane),
      moved: done.moved,
      into: done.into?.name ?? null,
    }
  })
}

/* ── Follow-ups ── every write answers the card with its next revision */

export type FollowupResult = { card: CardData; followup: FollowupData }

export async function addFollowupAction(input: {
  cardId: string
  expectedRevision: number
  title: string
  body?: string
  price?: string | null
  dueOn?: string | null
}): Promise<ActionResult<FollowupResult>> {
  return runAction(async (actor) => {
    const done = await addFollowup(actor, input)
    return { card: cardData(done.card), followup: followupData(done.followup) }
  })
}

export async function updateFollowupAction(input: {
  cardId: string
  expectedRevision: number
  followupId: string
  title?: string
  body?: string
  price?: string | null
  dueOn?: string | null
}): Promise<ActionResult<FollowupResult>> {
  return runAction(async (actor) => {
    const done = await updateFollowup(actor, input)
    return { card: cardData(done.card), followup: followupData(done.followup) }
  })
}

export async function followupArchivedAction(input: {
  cardId: string
  expectedRevision: number
  followupId: string
  archived: boolean
}): Promise<ActionResult<FollowupResult>> {
  return runAction(async (actor) => {
    const done = await setFollowupArchived(actor, input)
    return { card: cardData(done.card), followup: followupData(done.followup) }
  })
}

/* ── Payments ── the owner's alone; the services refuse anyone else */

export type PaymentResult = { card: CardData; payment: PaymentData }

export async function recordPaymentAction(input: {
  cardId: string
  expectedRevision: number
  amount: string
  kind: 'deposit' | 'part'
  receivedOn?: string | null
  note?: string
}): Promise<ActionResult<PaymentResult>> {
  return runAction(async (actor) => {
    const done = await recordPayment(actor, input)
    return { card: cardData(done.card), payment: paymentData(done.payment) }
  })
}

export async function voidPaymentAction(input: {
  cardId: string
  expectedRevision: number
  paymentId: string
  reason?: string
}): Promise<ActionResult<PaymentResult>> {
  return runAction(async (actor) => {
    const done = await voidPayment(actor, input)
    return { card: cardData(done.card), payment: paymentData(done.payment) }
  })
}

/* ── Clients ── New client from the Client field's modal */

export async function createClientAction(input: {
  name: string
  email?: string
  phone?: string
  taxId?: string
  address?: string
}): Promise<ActionResult<ClientOption>> {
  return runAction(async (actor) =>
    clientOption(await createClient(actor, input)),
  )
}

/* ── Prompts ── the picker reads every prompt of the owner's */

export type PromptChoice = {
  promptId: string
  /** The prompt's text — what a card links to. */
  variantId: string | null
  title: string
  medium: string
  text: string | null
  /** The variants (`<SLOTS>`) written in the text. */
  slots: string[]
  project: { name: string; color: string; slug: string } | null
}

export async function promptChoicesAction(input: {
  query?: string
}): Promise<ActionResult<PromptChoice[]>> {
  return runAction(
    async (actor) => {
      const { prompts } = await listPrompts(actor, {
        query: input.query?.trim() || undefined,
        limit: 40,
      })
      return prompts.map((prompt) => ({
        promptId: prompt.id,
        variantId: prompt.text?.id ?? null,
        title: prompt.title,
        medium: prompt.medium,
        text: prompt.text?.text ?? null,
        slots: prompt.slotNames,
        project: prompt.project
          ? {
              name: prompt.project.name,
              color: prompt.project.color,
              slug: prompt.project.slug,
            }
          : null,
      }))
    },
    { read: true },
  )
}

/**
 * A new prompt from the card's modal: saved to the card's project when it
 * has Prompts on, else to the library (no project), and linked
 * to the card or follow-up it was written for.
 */
export async function createPromptAction(input: {
  cardId: string
  followupId?: string
  projectId: string | null
  title: string
  medium: 'image' | 'video' | 'text' | 'audio'
  text: string
  providerHint?: string
}): Promise<ActionResult<PromptChoice>> {
  return runAction(async (actor) => {
    const saved = await savePrompt(actor, {
      projectId: input.projectId,
      title: input.title,
      medium: input.medium,
      text: input.text,
      providerHint: input.providerHint || undefined,
    })
    const variant = saved.text
    await setPrompt(actor, {
      cardId: input.cardId,
      followupId: input.followupId,
      promptId: saved.id,
      variantId: variant?.id,
    })
    return {
      promptId: saved.id,
      variantId: variant?.id ?? null,
      title: saved.title,
      medium: saved.medium,
      text: variant?.text ?? null,
      slots: saved.slots.filter((slot) => slot.inText).map((slot) => slot.name),
      project: saved.project
        ? {
            name: saved.project.name,
            color: saved.project.color,
            slug: saved.project.slug,
          }
        : null,
    }
  })
}

export async function setPromptAction(input: {
  cardId: string
  followupId?: string
  promptId: string
  variantId?: string | null
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await setPrompt(actor, {
      ...input,
      variantId: input.variantId ?? undefined,
    })
    return null
  })
}

/* ── Files ── uploaded through Assets first, then attached */

export async function attachFileAction(input: {
  cardId: string
  followupId?: string
  assetId: string
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await attachFile(actor, input)
    return null
  })
}

/** Take a prompt or a file off the card; the prompt or asset stays where it lives. */
export async function unlinkAction(input: {
  cardId: string
  refId: string
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await unlinkFromCard(actor, input)
    return null
  })
}

export type CardHistory = {
  events: {
    id: string
    kind: string
    at: string
    actor: string
    amount: string | null
    currency: string | null
    from: string | null
    to: string | null
  }[]
  links: { type: string; id: string; role: string; direction: 'from' | 'to' }[]
  /** The prompt of the card and of each follow-up (`made_with`). */
  prompts: CardPromptLink[]
  /** The files of the card and of each follow-up, with a preview where one can be shown. */
  files: (CardFileLink & { preview: string | null })[]
}

/** A card's history and its links to other modules — read when it is selected. */
export async function cardHistoryAction(
  cardId: string,
): Promise<ActionResult<CardHistory>> {
  return runAction(
    async (actor) => {
      const [detail, edges, linked] = await Promise.all([
        getCard(actor, cardId),
        listRefs(actor, { type: 'card', id: cardId }),
        cardLinks(actor, cardId),
      ])
      const previews = await previewsFor(
        actor,
        linked.files
          .filter((file) => file.status === 'ready' && file.kind !== 'doc')
          .map((file) => file.assetId),
      ).catch(() => ({}) as Record<string, string>)
      // A lane that isn't on the board any more was deleted; a move made by
      // that delete names it in its data.
      const laneName = (id: string | null, gone?: unknown) =>
        id
          ? (detail.lanes.find((lane) => lane.id === id)?.name ??
            (typeof gone === 'string' ? gone : 'a deleted lane'))
          : null
      return {
        events: detail.events.map((event) => ({
          id: event.id,
          kind: event.kind,
          at: event.occurredAt.toISOString(),
          actor: event.actorType === 'user' ? 'you' : event.actorType,
          amount: event.amount,
          currency: event.currency,
          from: laneName(event.fromLaneId, event.data.laneDeleted),
          to: laneName(event.toLaneId),
        })),
        links: edges.map((edge) =>
          edge.fromType === 'card' && edge.fromId === cardId
            ? {
                type: edge.toType,
                id: edge.toId,
                role: edge.role,
                direction: 'to' as const,
              }
            : {
                type: edge.fromType,
                id: edge.fromId,
                role: edge.role,
                direction: 'from' as const,
              },
        ),
        prompts: linked.prompts,
        files: linked.files.map((file) => ({
          ...file,
          preview: previews[file.assetId] ?? null,
        })),
      }
    },
    { read: true },
  )
}
