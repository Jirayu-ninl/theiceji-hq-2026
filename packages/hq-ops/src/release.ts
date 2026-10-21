import {
  MODULE_IDS,
  type ModuleId,
  OPS_AUTHORIZATION_MODES,
} from '@theiceji/hq-db/enums'
import {
  type OpsPolicyRow,
  type OpsReleaseAuthorizationRow,
  opsReleaseAuthorizations,
  type ProjectRow,
} from '@theiceji/hq-db/schema'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { type Actor, assertCan } from './access'
import { schedulerActor } from './actors'
import { dbNow, nowPlus, type Reader, type Tx } from './db'
import { conflict, forbidden, invalid, policyBlocked } from './errors'
import {
  currentPolicy,
  engagedKillSwitches,
  policyState,
  switchFor,
} from './policy-gate'
import {
  choice,
  idList,
  machineKey,
  parseInput,
  recordId,
  text,
} from './schemas'
import {
  audit,
  authorize,
  ownedRow,
  ownProject,
  returned,
  withTransaction,
} from './store'

/**
 * Release authorizations — the generic half.
 *
 * An authorization is the server's permission to let one exact thing leave
 * HQ — a post, a listing — bound to the hash of what will be sent, the asset
 * bytes, the account or marketplace, and either the owner who approved it
 * (`human_approval`) or the policy revision that allowed it
 * (`policy_gated`, never recorded as a human approval). It is consumed once,
 * in the same transaction that dispatches; it can be revoked; it expires.
 * The migration's guard keeps everything but its state immutable.
 *
 * What makes a subject releasable — the caption, disclosures, QA, the
 * account's freshness, offer terms — is the owning module's business. A
 * module registers a `ReleaseEvaluator` for each subject type it releases;
 * the kernel asks it for the current payload hash and its blockers, adds its
 * own (policy, mode, kill switches, payload drift), and only issues when the
 * list is empty. A subject no module evaluates can't be released at all.
 */

/** How long an unused authorization stays good. */
export const AUTHORIZATION_TTL_SECONDS = 24 * 3600

export type Blocker = { key: string; message: string; remediation?: string }

/** What a module reports about its subject at the moment of release. */
export type ReleaseSubjectState = {
  /** The hash of exactly what would be sent now. */
  payloadHash: string
  /** The bytes that would be sent, when there are any. */
  asset?: { id: string; sha256: string } | null
  /** The platform account or marketplace it would go to. */
  targetRef?: string | null
  /** Passing QA checks this release relies on. */
  qualityCheckIds?: string[]
  /** Every module reason it can't be released right now; empty when it can. */
  blockers: Blocker[]
}

/**
 * A module's check of one subject type, run inside the transaction that
 * issues (and, for dispatch, consumes) the authorization. It must read the
 * subject scoped to `actor.userId` and the given project, and throw
 * `not_found` for a subject that isn't the owner's.
 */
export type ReleaseEvaluator = (
  reader: Reader,
  actor: Actor,
  subject: { project: ProjectRow | null; type: string; id: string },
) => Promise<ReleaseSubjectState>

const evaluators = new Map<string, ReleaseEvaluator>()

const evaluatorKey = (module: ModuleId, subjectType: string) =>
  `${module}:${subjectType}`

export function registerReleaseEvaluator(
  module: ModuleId,
  subjectType: string,
  evaluate: ReleaseEvaluator,
): void {
  evaluators.set(evaluatorKey(module, subjectType), evaluate)
}

const createSchema = z.object({
  module: choice(MODULE_IDS, 'That isn’t a module.'),
  subjectType: machineKey('Subject type', 60),
  subjectId: recordId('Subject'),
  /** The hash the caller prepared — refused if the subject no longer hashes to it. */
  payloadHash: text.required('Payload hash', 200),
  mode: choice(
    OPS_AUTHORIZATION_MODES,
    'Choose human approval or policy-gated.',
  ),
})

export type AuthorizationRequest = z.input<typeof createSchema>

export type AuthorizationOutcome =
  | { ok: true; authorization: OpsReleaseAuthorizationRow; blockers: [] }
  | { ok: false; authorization: null; blockers: Blocker[] }

/**
 * The kernel's own reasons a release can't be authorized in this mode, for
 * this caller, right now — added to the module's.
 */
async function kernelBlockers(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  mode: OpsReleaseAuthorizationRow['mode'],
  state: ReleaseSubjectState,
  expectedHash: string,
): Promise<{ blockers: Blocker[]; policy: OpsPolicyRow | null }> {
  const blockers: Blocker[] = []
  const projectId = project?.id ?? null
  if (state.payloadHash !== expectedHash)
    blockers.push({
      key: 'payload_changed',
      message:
        'What would be sent no longer matches what was prepared (text, asset, target or version changed).',
      remediation: 'Prepare it again for the current payload.',
    })
  const [policy, now] = await Promise.all([
    currentPolicy(tx, actor.userId, projectId),
    dbNow(tx),
  ])
  if (mode === 'policy_gated') {
    // The owner can issue a policy-gated release too (a dispatcher acting on
    // the policy); coverage is then judged for a connection the policy covers.
    const probe =
      actor.type === 'user'
        ? { ...actor, grantId: policy?.grantIds[0] ?? actor.grantId }
        : actor
    const inForce = policyState(policy, probe, now)
    if (!inForce.ok)
      blockers.push({ key: 'policy_not_in_force', message: inForce.reason })
    else {
      if (inForce.policy.releaseMode !== 'policy_gated')
        blockers.push({
          key: 'human_approval_required',
          message:
            'The release mode is human_required: the owner has to approve this release.',
          remediation:
            'Ask the owner (agents_request_human, kind approval), or the owner changes the release mode.',
        })
      if (!inForce.policy.allowedActions.includes('authorize_release'))
        blockers.push({
          key: 'policy_action',
          message:
            'The operating policy doesn’t let agents authorize releases.',
        })
      if (
        state.targetRef &&
        !inForce.policy.allowedAccountIds.includes(state.targetRef)
      )
        blockers.push({
          key: 'target_not_allowed',
          message:
            'The operating policy doesn’t allow releasing to that account or marketplace.',
          remediation: 'Only the owner can add it to the policy.',
        })
    }
  }
  const stop = switchFor(
    await engagedKillSwitches(tx, actor.userId, projectId),
    {
      accountId: state.targetRef ?? null,
      marketplaceId: state.targetRef ?? null,
      connectionId: actor.grantId ?? null,
    },
  )
  if (stop)
    blockers.push({
      key: 'kill_switch',
      message: `A kill switch is engaged (${stop.scope}): ${stop.reason}`,
    })
  return { blockers, policy }
}

/**
 * Issues an authorization for one subject, or returns every reason it
 * can't. `human_approval` is the owner approving this exact payload — only a
 * person can give it, and it names them. `policy_gated` needs a policy in
 * force whose release mode is `policy_gated` and which allows
 * `authorize_release`; it names that policy revision. An older active
 * authorization for the same subject and target is superseded.
 *
 * Takes the caller's transaction, so a module moves its own record to
 * "authorized" in the same commit.
 */
export async function issueAuthorization(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  raw: unknown,
): Promise<AuthorizationOutcome> {
  const input = parseInput(createSchema, raw)
  if (input.mode === 'human_approval') {
    if (actor.type !== 'user')
      throw forbidden(
        'Only the owner approves a release. An agent can ask with agents_request_human, or release through a policy-gated authorization.',
      )
    await authorize(tx, actor, project, input.module, 'decide')
  } else {
    // "Authorize releases where your operating policy lets the server
    // decide" is `ops:decide` in the catalog, whatever the module.
    await authorize(tx, actor, project, 'ops', 'decide', 'authorize_release')
  }
  const evaluate = evaluators.get(evaluatorKey(input.module, input.subjectType))
  if (!evaluate)
    throw invalid(
      `Nothing in this build can check a ${input.subjectType} of ${input.module} for release, so it can’t be released.`,
      { subjectType: 'Not releasable.' },
    )
  const state = await evaluate(tx, actor, {
    project,
    type: input.subjectType,
    id: input.subjectId,
  })
  if ((state.asset?.id == null) !== (state.asset?.sha256 == null))
    throw new Error('A release evaluator returned an asset without its hash.')
  const kernel = await kernelBlockers(
    tx,
    actor,
    project,
    input.mode,
    state,
    input.payloadHash,
  )
  const blockers = [...state.blockers, ...kernel.blockers]
  if (blockers.length > 0) return { ok: false, authorization: null, blockers }
  const projectId = project?.id ?? null
  const targetRef = state.targetRef ?? null

  // Supersede an older active authorization for the same subject and target.
  await tx
    .update(opsReleaseAuthorizations)
    .set({
      status: 'revoked',
      revokedAt: sql`now()`,
      statusReason: 'Superseded by a newer authorization.',
    })
    .where(
      and(
        eq(opsReleaseAuthorizations.ownerId, actor.userId),
        eq(opsReleaseAuthorizations.module, input.module),
        eq(opsReleaseAuthorizations.subjectType, input.subjectType),
        eq(opsReleaseAuthorizations.subjectId, input.subjectId),
        targetRef === null
          ? sql`${opsReleaseAuthorizations.targetRef} is null`
          : eq(opsReleaseAuthorizations.targetRef, targetRef),
        eq(opsReleaseAuthorizations.status, 'active'),
      ),
    )
  const policyGated = input.mode === 'policy_gated'
  const authorization = returned(
    (
      await tx
        .insert(opsReleaseAuthorizations)
        .values({
          ownerId: actor.userId,
          projectId,
          module: input.module,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          payloadHash: state.payloadHash,
          assetId: state.asset?.id ?? null,
          assetSha256: state.asset?.sha256 ?? null,
          targetRef,
          mode: input.mode,
          policyId: policyGated ? (kernel.policy?.id ?? null) : null,
          approvedBy: policyGated ? null : actor.userId,
          qualityCheckIds: state.qualityCheckIds ?? [],
          expiresAt: nowPlus(AUTHORIZATION_TTL_SECONDS),
          actorType: actor.type,
          actorId: actor.id,
          createdBy: actor.userId,
        })
        .returning()
    )[0],
  )
  await audit(tx, actor, {
    projectId,
    action: 'release.authorize',
    targetType: 'release_authorization',
    targetId: authorization.id,
    changes: {
      module: input.module,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      mode: authorization.mode,
      policyRevision: policyGated ? (kernel.policy?.revisionNo ?? null) : null,
      approvedBy: authorization.approvedBy,
      payloadHash: authorization.payloadHash,
      targetRef,
      qualityChecks: authorization.qualityCheckIds.length,
    },
  })
  return { ok: true, authorization, blockers: [] }
}

/**
 * `issueAuthorization` in its own transaction, for a caller that has nothing
 * else to commit with it (the owner approving from `/inbox`, a tool).
 * `projectId` null is a subject in no project.
 */
export async function createAuthorization(
  actor: Actor,
  projectId: string | null,
  raw: unknown,
): Promise<AuthorizationOutcome> {
  return withTransaction(async (tx) => {
    const project = projectId ? await ownProject(tx, actor, projectId) : null
    return issueAuthorization(tx, actor, project, raw)
  })
}

/** What dispatch is about to send, to compare with what was authorized. */
export type DispatchState = {
  payloadHash: string
  assetSha256?: string | null
  targetRef?: string | null
}

/**
 * Every reason an authorization no longer fits what is about to be sent:
 * inactive, expired (by the database's clock), a different payload, asset or
 * target, or — for a policy release — a policy that has changed since.
 */
export async function checkAuthorizationStillValid(
  reader: Reader,
  authorization: OpsReleaseAuthorizationRow,
  current: DispatchState,
): Promise<Blocker[]> {
  const blockers: Blocker[] = []
  if (authorization.status !== 'active')
    blockers.push({
      key: 'authorization_inactive',
      message: `The authorization is ${authorization.status}${authorization.statusReason ? `: ${authorization.statusReason}` : ''}.`,
    })
  const now = await dbNow(reader)
  if (authorization.expiresAt.getTime() <= now.getTime())
    blockers.push({
      key: 'authorization_expired',
      message: 'The authorization expired; authorize the release again.',
    })
  if (authorization.payloadHash !== current.payloadHash)
    blockers.push({
      key: 'authorization_payload_mismatch',
      message: 'The payload changed after it was authorized.',
    })
  if (
    current.assetSha256 !== undefined &&
    authorization.assetSha256 !== (current.assetSha256 ?? null)
  )
    blockers.push({
      key: 'authorization_asset_mismatch',
      message: 'The asset bytes differ from the authorized ones.',
    })
  if (
    current.targetRef !== undefined &&
    authorization.targetRef !== (current.targetRef ?? null)
  )
    blockers.push({
      key: 'authorization_target_mismatch',
      message: 'It would go somewhere other than where it was authorized to.',
    })
  if (authorization.mode === 'policy_gated') {
    const policy = await currentPolicy(
      reader,
      authorization.ownerId,
      authorization.projectId,
    )
    if (authorization.policyId !== policy?.id)
      blockers.push({
        key: 'policy_changed',
        message:
          'The operating policy changed after this release was authorized.',
        remediation: 'Authorize the release again under the current policy.',
      })
  }
  return blockers
}

const consumeSchema = z.object({
  authorizationId: recordId('Authorization'),
  payloadHash: text.required('Payload hash', 200),
  assetSha256: text.optional('Asset hash', 200),
  targetRef: text.optional('Target', 200),
})

/**
 * Uses an authorization up — in the transaction that dispatches, so the
 * dispatch and the consumption commit together or not at all. Locks the row;
 * refuses (`policy_blocked`, with the blockers) unless it is active,
 * unexpired, fits exactly what is being sent and no kill switch stops this
 * target or connection. Only its state changes; the guard trigger refuses
 * anything else.
 *
 * The caller has already gated its own dispatch (`publish` for a post,
 * `list` for a listing) and checked the provider's switch; this is the
 * release half of that same step.
 */
export async function consumeAuthorization(
  tx: Tx,
  actor: Actor,
  raw: unknown,
): Promise<OpsReleaseAuthorizationRow> {
  const input = parseInput(consumeSchema, raw)
  const { row } = await ownedRow<OpsReleaseAuthorizationRow>(
    tx,
    actor,
    opsReleaseAuthorizations,
    input.authorizationId,
    'Authorization',
    { lock: true },
  )
  assertCan(actor, row.module, 'operate')
  const blockers = await checkAuthorizationStillValid(tx, row, {
    payloadHash: input.payloadHash,
    ...(input.assetSha256 !== undefined
      ? { assetSha256: input.assetSha256 }
      : {}),
    ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
  })
  const stop = switchFor(
    await engagedKillSwitches(tx, actor.userId, row.projectId),
    {
      accountId: row.targetRef,
      marketplaceId: row.targetRef,
      connectionId: actor.grantId ?? null,
    },
  )
  if (stop)
    blockers.push({
      key: 'kill_switch',
      message: `A kill switch is engaged (${stop.scope}): ${stop.reason}`,
    })
  if (blockers.length > 0)
    throw policyBlocked(
      `This release isn’t authorized for what is being sent: ${blockers.map((entry) => entry.message).join(' ')}`,
      { blockers, authorizationId: row.id },
    )
  const [consumed] = await tx
    .update(opsReleaseAuthorizations)
    .set({ status: 'consumed', consumedAt: sql`now()` })
    .where(
      and(
        eq(opsReleaseAuthorizations.id, row.id),
        eq(opsReleaseAuthorizations.status, 'active'),
      ),
    )
    .returning()
  if (!consumed)
    throw conflict('That authorization was used or revoked just now.')
  await audit(tx, actor, {
    projectId: row.projectId,
    action: 'release.consume',
    targetType: 'release_authorization',
    targetId: row.id,
    changes: {
      module: row.module,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      mode: row.mode,
    },
  })
  return consumed
}

const revokeSchema = z.object({ reason: text.required('Reason', 1000) })

/**
 * Takes an authorization back before it is used. The owner always can; an
 * agent needs `ops:decide` and a policy that allows `authorize_release`.
 */
export async function revokeAuthorization(
  actor: Actor,
  authorizationId: string,
  raw: unknown,
): Promise<OpsReleaseAuthorizationRow> {
  const input = parseInput(revokeSchema, raw)
  return withTransaction(async (tx) => {
    const { row, project } = await ownedRow<OpsReleaseAuthorizationRow>(
      tx,
      actor,
      opsReleaseAuthorizations,
      authorizationId,
      'Authorization',
      { lock: true },
    )
    await authorize(tx, actor, project, 'ops', 'decide', 'authorize_release')
    if (row.status !== 'active')
      throw invalid(`The authorization is already ${row.status}.`)
    const revoked = returned(
      (
        await tx
          .update(opsReleaseAuthorizations)
          .set({
            status: 'revoked',
            revokedAt: sql`now()`,
            statusReason: input.reason,
          })
          .where(
            and(
              eq(opsReleaseAuthorizations.id, row.id),
              eq(opsReleaseAuthorizations.status, 'active'),
            ),
          )
          .returning()
      )[0],
    )
    await audit(tx, actor, {
      projectId: row.projectId,
      action: 'release.revoke',
      targetType: 'release_authorization',
      targetId: row.id,
      reason: input.reason,
    })
    return revoked
  })
}

/**
 * The tick: authorizations past their expiry are marked expired, a batch at
 * a time. Dispatch refuses them already (the check reads the database's
 * clock); this keeps the list of what is live honest.
 */
export async function expireAuthorizations(
  options: { ownerId?: string; limit?: number } = {},
): Promise<string[]> {
  return withTransaction(async (tx) => {
    const due = await tx
      .select({ id: opsReleaseAuthorizations.id })
      .from(opsReleaseAuthorizations)
      .where(
        and(
          options.ownerId
            ? eq(opsReleaseAuthorizations.ownerId, options.ownerId)
            : undefined,
          eq(opsReleaseAuthorizations.status, 'active'),
          sql`${opsReleaseAuthorizations.expiresAt} < now()`,
        ),
      )
      .orderBy(asc(opsReleaseAuthorizations.expiresAt))
      .limit(options.limit ?? 200)
      .for('update', { skipLocked: true })
    if (due.length === 0) return []
    const expired = await tx
      .update(opsReleaseAuthorizations)
      .set({ status: 'expired', statusReason: 'Expired unused.' })
      .where(
        and(
          inArray(
            opsReleaseAuthorizations.id,
            due.map((row) => row.id),
          ),
          eq(opsReleaseAuthorizations.status, 'active'),
        ),
      )
      .returning()
    for (const row of expired)
      await audit(tx, schedulerActor(row.ownerId), {
        projectId: row.projectId,
        action: 'release.expire',
        targetType: 'release_authorization',
        targetId: row.id,
      })
    return expired.map((row) => row.id)
  })
}

const listSchema = z.object({
  module: choice(MODULE_IDS, 'That isn’t a module.'),
  subjectType: machineKey('Subject type', 60),
  subjectIds: idList('Subject', 100),
})

/** The live authorizations for some subjects — for a module's detail view. */
export async function activeAuthorizations(
  reader: Reader,
  actor: Actor,
  raw: unknown,
): Promise<OpsReleaseAuthorizationRow[]> {
  const input = parseInput(listSchema, raw)
  assertCan(actor, input.module, 'read')
  if (input.subjectIds.length === 0) return []
  return reader
    .select()
    .from(opsReleaseAuthorizations)
    .where(
      and(
        eq(opsReleaseAuthorizations.ownerId, actor.userId),
        eq(opsReleaseAuthorizations.module, input.module),
        eq(opsReleaseAuthorizations.subjectType, input.subjectType),
        inArray(opsReleaseAuthorizations.subjectId, input.subjectIds),
        eq(opsReleaseAuthorizations.status, 'active'),
        sql`${opsReleaseAuthorizations.expiresAt} > now()`,
      ),
    )
}
