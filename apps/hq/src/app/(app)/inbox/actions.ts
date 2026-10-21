'use server'

import '@/modules/register'

import {
  acceptProposal,
  holdProposal,
  rejectProposal,
} from '@theiceji/hq-agents/proposals'
import { respondToHumanRequest } from '@theiceji/hq-ops/human'
import { type ActionResult, runAction } from '@/lib/actions'

/**
 * Answer one human request — the owner's act, recorded append-only with the
 * revision it answered (hq-ops/human). An agent waiting on it sees the answer
 * on its next pull; a stale revision or an expired request is refused.
 */
export async function respondAction(input: {
  requestId: string
  expectedRevision: number
  choice: string
  note?: string
}): Promise<ActionResult<{ unblockedTasks: number }>> {
  return runAction(
    async (actor) => {
      const outcome = await respondToHumanRequest(actor, input.requestId, {
        expectedRevision: input.expectedRevision,
        choice: input.choice,
        note: input.note,
      })
      return { unblockedTasks: outcome.unblockedTasks.length }
    },
    { revalidate: ['/inbox'] },
  )
}

/**
 * Decide an agent's proposal — the owner's alone (hq-agents). Accepting makes
 * the record through its module's target adapter and links it back; rejecting
 * tells the routine why on its next pull; holding parks it, still waiting.
 */
export async function decideProposalAction(input: {
  proposalId: string
  expectedRevision: number
  choice: 'accept' | 'reject' | 'hold' | 'unhold'
  note?: string
}): Promise<ActionResult<{ href: string | null }>> {
  return runAction(
    async (actor) => {
      const decision = {
        proposalId: input.proposalId,
        expectedRevision: input.expectedRevision,
        note: input.note,
      }
      if (input.choice === 'accept') {
        const { created } = await acceptProposal(actor, decision)
        return { href: created.href }
      }
      if (input.choice === 'reject') await rejectProposal(actor, decision)
      else
        await holdProposal(actor, {
          ...decision,
          held: input.choice === 'hold',
        })
      return { href: null }
    },
    { revalidate: ['/inbox', '/', '/agents'] },
  )
}
