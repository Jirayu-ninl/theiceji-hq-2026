'use server'

import type { OpsKillSwitchScope } from '@theiceji/hq-db/enums'
import {
  engageKillSwitch,
  getPolicyOverview,
  releaseKillSwitch,
  savePolicy,
} from '@theiceji/hq-ops/policy'
import { type ActionResult, runAction } from '@/lib/actions'
import { type EditablePolicy, editableOf, policyInput } from './policy-view'

/**
 * Settings › Policies. Every write goes through hq-ops as the owner: a
 * policy change is a new revision (`savePolicy`, revision-checked, audited),
 * a kill switch is engaged or released with a reason (`engageKillSwitch`,
 * `releaseKillSwitch`). The kernel refuses all three to any connection —
 * `manage` is a capability no scope grants — so only the owner, here, can
 * change what agents may do.
 */

const PATHS = ['/settings/policies']

/** Save the tab's fields as the next revision; the rest carries over from the one in force. */
export async function savePolicyAction(input: {
  projectId: string | null
  policy: EditablePolicy
}): Promise<ActionResult<EditablePolicy>> {
  return runAction(
    async (actor) => {
      const { policy: previous, project } = await getPolicyOverview(
        actor,
        input.projectId,
      )
      const saved = await savePolicy(
        actor,
        input.projectId,
        policyInput(input.policy, previous, Boolean(project)),
      )
      return editableOf(saved, {
        currency: saved.currency,
        timeZone: input.policy.timeZone,
      })
    },
    { revalidate: PATHS },
  )
}

export type SwitchOutcome = {
  stopped: number
  inFlight: number
  revoked: number
}

/**
 * Stop a class of agent work now. New work in scope is refused from the next
 * call; release authorizations in scope are voided; work a provider already
 * has is counted as in flight — HQ can't call it back.
 */
export async function engageKillSwitchAction(input: {
  projectId: string | null
  scope: OpsKillSwitchScope
  target: string | null
  reason: string
}): Promise<ActionResult<SwitchOutcome>> {
  return runAction(
    async (actor) => {
      const outcome = await engageKillSwitch(actor, input.projectId, {
        scope: input.scope,
        target: input.target ?? undefined,
        reason: input.reason,
      })
      return {
        stopped: outcome.stopped.length,
        inFlight: outcome.inFlight.length,
        revoked: outcome.revokedAuthorizations.length,
      }
    },
    { revalidate: PATHS },
  )
}

/** Let the work run again. The reason is kept in the audit trail. */
export async function releaseKillSwitchAction(input: {
  switchId: string
  reason: string
}): Promise<ActionResult> {
  return runAction(
    async (actor) => {
      await releaseKillSwitch(actor, input.switchId, { reason: input.reason })
      return null
    },
    { revalidate: PATHS },
  )
}
