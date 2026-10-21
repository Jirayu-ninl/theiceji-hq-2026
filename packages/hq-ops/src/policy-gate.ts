import type { OpsAgentAction } from '@theiceji/hq-db/enums'
import {
  type OpsKillSwitchRow,
  type OpsPolicyRow,
  opsKillSwitches,
  opsPolicies,
} from '@theiceji/hq-db/schema'
import { and, desc, eq, isNull, or, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { Actor } from './access'
import { dbNow, type Reader } from './db'
import { policyBlocked } from './errors'

/**
 * The operating-policy gate every agent write passes.
 * Kept apart from policy.ts, which writes policies, so the store can call it
 * without an import cycle.
 *
 * The rules are deliberately boring:
 * · no policy, a suspended one, one not in effect yet or expired, one that
 *   doesn't cover this connection, or one that doesn't list the action →
 *   refused, before anything is written;
 * · a policy is per project, or per owner for work in no project; there is no
 *   inheritance between the two;
 * · an engaged `all` switch, the project's switch, or this connection's
 *   switch → refused. Provider, account and marketplace switches are checked
 *   by the services about to touch that provider, right before the side
 *   effect (`switchFor`).
 *
 * Every time comparison uses the database's clock.
 */

export const ACTION_LABEL: Record<OpsAgentAction, string> = {
  draft: 'write notes, prompts, cards and shots',
  propose: 'leave proposals for the owner',
  generate: 'queue generation that can spend',
  import: 'record readings, sales and money',
  authorize_release: 'authorize releases',
  publish: 'publish or record posts',
  list: 'put, renew or retire marketplace listings',
  price: 'change listing prices',
  respond: 'answer customers',
  decide: 'decide experiments',
}

/** `project_id = $1`, or `project_id is null` for owner-level rows — on any ops table. */
export function sameProject(
  column: AnyPgColumn,
  projectId: string | null,
): SQL {
  return projectId === null ? isNull(column) : eq(column, projectId)
}

/** The newest policy revision for a project (or the owner's no-project work) — the policy — or null. */
export async function currentPolicy(
  reader: Reader,
  ownerId: string,
  projectId: string | null,
): Promise<OpsPolicyRow | null> {
  const [row] = await reader
    .select()
    .from(opsPolicies)
    .where(
      and(
        eq(opsPolicies.ownerId, ownerId),
        sameProject(opsPolicies.projectId, projectId),
      ),
    )
    .orderBy(desc(opsPolicies.revisionNo))
    .limit(1)
  return row ?? null
}

/**
 * Engaged switches that can apply to work in this project: the owner's `all`
 * switch, and every switch of this project or of no project.
 */
export async function engagedKillSwitches(
  reader: Reader,
  ownerId: string,
  projectId: string | null,
): Promise<OpsKillSwitchRow[]> {
  return reader
    .select()
    .from(opsKillSwitches)
    .where(
      and(
        eq(opsKillSwitches.ownerId, ownerId),
        isNull(opsKillSwitches.releasedAt),
        projectId === null
          ? isNull(opsKillSwitches.projectId)
          : or(
              isNull(opsKillSwitches.projectId),
              eq(opsKillSwitches.projectId, projectId),
            ),
      ),
    )
}

/**
 * The engaged switch that stops a side effect on one target, if any: the
 * `all` switch, the project's, or one naming this provider, connection,
 * account or marketplace.
 */
export function switchFor(
  switches: OpsKillSwitchRow[],
  target: {
    provider?: string | null
    connectionId?: string | null
    accountId?: string | null
    marketplaceId?: string | null
  } = {},
): OpsKillSwitchRow | null {
  return (
    switches.find((entry) => {
      switch (entry.scope) {
        case 'all':
        case 'project':
          return true
        case 'provider':
          return Boolean(target.provider) && entry.target === target.provider
        case 'connection':
          return (
            Boolean(target.connectionId) && entry.target === target.connectionId
          )
        case 'account':
          return Boolean(target.accountId) && entry.target === target.accountId
        case 'marketplace':
          return (
            Boolean(target.marketplaceId) &&
            entry.target === target.marketplaceId
          )
        default:
          return false
      }
    }) ?? null
  )
}

export type PolicyState =
  | { ok: true; policy: OpsPolicyRow }
  | { ok: false; reason: string; policy: OpsPolicyRow | null }

/** Whether a policy is usable at all by this connection, at `now` (the database's clock). */
export function policyState(
  policy: OpsPolicyRow | null,
  actor: Actor,
  now: Date,
): PolicyState {
  if (!policy)
    return {
      ok: false,
      policy,
      reason:
        'The owner hasn’t set an operating policy here, so agents can only read. The owner sets one in HQ → Settings → Policies.',
    }
  if (policy.status !== 'active')
    return {
      ok: false,
      policy,
      reason: `The operating policy is suspended (revision ${policy.revisionNo}). Only the owner can resume it.`,
    }
  if (policy.effectiveFrom.getTime() > now.getTime())
    return {
      ok: false,
      policy,
      reason: `The operating policy takes effect at ${policy.effectiveFrom.toISOString()}.`,
    }
  if (policy.expiresAt && policy.expiresAt.getTime() <= now.getTime())
    return {
      ok: false,
      policy,
      reason: `The operating policy expired at ${policy.expiresAt.toISOString()}. Only the owner can renew it.`,
    }
  if (
    policy.coverage === 'selected' &&
    !(actor.grantId && policy.grantIds.includes(actor.grantId))
  )
    return {
      ok: false,
      policy,
      reason:
        'The operating policy doesn’t cover this connection. The owner chooses which connections it covers.',
    }
  return { ok: true, policy }
}

export async function assertPolicyAllows(
  reader: Reader,
  actor: Actor,
  projectId: string | null,
  action: OpsAgentAction,
): Promise<OpsPolicyRow> {
  const [policy, now] = await Promise.all([
    currentPolicy(reader, actor.userId, projectId),
    dbNow(reader),
  ])
  const state = policyState(policy, actor, now)
  if (!state.ok)
    throw policyBlocked(state.reason, {
      projectId,
      action,
      policyRevision: state.policy?.revisionNo ?? null,
    })
  if (!state.policy.allowedActions.includes(action))
    throw policyBlocked(
      `The operating policy doesn’t let agents ${ACTION_LABEL[action]} here. Only the owner can add that.`,
      { projectId, action, policyRevision: state.policy.revisionNo },
    )
  const switches = await engagedKillSwitches(reader, actor.userId, projectId)
  const stop = switches.find(
    (entry) =>
      entry.scope === 'all' ||
      (entry.scope === 'project' && entry.projectId === projectId) ||
      (entry.scope === 'connection' && entry.target === actor.grantId),
  )
  if (stop)
    throw policyBlocked(
      `A kill switch is engaged (${stop.scope}): ${stop.reason}`,
      { projectId, action, killSwitchId: stop.id },
    )
  return state.policy
}
