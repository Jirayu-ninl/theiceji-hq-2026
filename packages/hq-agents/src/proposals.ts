import { link } from '@theiceji/hq-core/refs'
import { createTarget, targetFor } from '@theiceji/hq-core/targets'
import {
  AGENT_PROPOSAL_KINDS,
  AGENT_PROPOSAL_STATUSES,
} from '@theiceji/hq-db/enums'
import {
  type AgentProposalRow,
  type AgentRoutineRow,
  agentProposals,
  agentRoutines,
  type OpsAgentRunRow,
  opsAgentRuns,
  opsTasks,
  type ProjectRow,
  projects,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan, can, workScope } from '@theiceji/hq-ops/access'
import { schedulerActor } from '@theiceji/hq-ops/actors'
import { dbNow, type Reader, type Tx } from '@theiceji/hq-ops/db'
import {
  conflict,
  forbidden,
  invalid,
  notFound,
  OpsError,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import { emitEvent } from '@theiceji/hq-ops/outbox'
import { assertPolicyAllows } from '@theiceji/hq-ops/policy-gate'
import {
  choice,
  idempotencyKey,
  optionalRecordId,
  parseInput,
  recordId,
  revision,
  text,
} from '@theiceji/hq-ops/schemas'
import {
  audit,
  authorize,
  ownedRow,
  ownProject,
  returned,
  runOperation,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { assertTaskFencing } from '@theiceji/hq-ops/tasks'
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ROUTINE_TARGET } from './routines'

/**
 * Proposals — what an agent's run leaves for the owner.
 *
 * · **A proposal is a target payload**: the kind names a target in the
 *   hq-core registry (card, prompt variant, shot …) and the payload is
 *   validated by that target's own schema when proposed — an agent learns at
 *   once that a proposal can't be made — and again when accepted.
 * · **Proposing is the policy's `propose`.** Inside a run the caller passes
 *   the run and its fencing token; a run whose lease was lost can't propose.
 * · **Accepting, rejecting and holding are the owner's.** Accepting makes the
 *   record through the target adapter in the same transaction, and links
 *   `proposal —proposed_as→ record`.
 * · **Auto-accept** happens only when the run's routine lists the kind, the
 *   kind is a note or a prompt variant (a CHECK on the routine), and the
 *   policy lets the agent draft there. Otherwise it waits for the owner.
 */

registerConstraintMessages({
  agent_proposals_accepted_check: 'An accepted proposal names what it made.',
})

/** How a proposal kind reads in words: "Board · card". */
export function proposalLabel(kind: string): string {
  return targetFor(kind)?.label ?? kind
}

/* ── Proposing ──────────────────────────────────────────────────────── */

const proposeSchema = z.object({
  projectId: optionalRecordId('Project'),
  kind: choice(AGENT_PROPOSAL_KINDS, 'That can’t be proposed.'),
  title: text.required('Title', 200),
  payload: z.record(z.string(), z.unknown()),
  rationale: text.optional('Rationale', 4000),
  runId: optionalRecordId('Run'),
  fencingToken: z.coerce.number().int().min(1).optional(),
  idempotencyKey: idempotencyKey.optional(),
})

export type ProposeInput = z.input<typeof proposeSchema>

export type ProposalOutcome = {
  proposal: AgentProposalRow
  /** Set when the routine accepted it on the owner's behalf. */
  accepted: { type: string; id: string; href: string } | null
}

async function runContext(
  tx: Tx,
  actor: Actor,
  runId: string,
  fencingToken: number | undefined,
): Promise<{ run: OpsAgentRunRow; routine: AgentRoutineRow | null }> {
  if (!fencingToken)
    throw invalid('Pass the fencing token of the run you hold.', {
      fencing_token: 'Required with run_id.',
    })
  const [row] = await tx
    .select({ run: opsAgentRuns, task: opsTasks })
    .from(opsAgentRuns)
    .innerJoin(opsTasks, eq(opsTasks.id, opsAgentRuns.taskId))
    .where(
      and(eq(opsAgentRuns.id, runId), eq(opsAgentRuns.ownerId, actor.userId)),
    )
    .limit(1)
  if (!row) throw notFound('Run')
  await assertTaskFencing(tx, actor, {
    taskId: row.run.taskId,
    fencingToken,
  })
  let routine: AgentRoutineRow | null = null
  if (row.task.targetType === ROUTINE_TARGET && row.task.targetId) {
    const [found] = await tx
      .select()
      .from(agentRoutines)
      .where(
        and(
          eq(agentRoutines.id, row.task.targetId),
          eq(agentRoutines.ownerId, actor.userId),
        ),
      )
      .limit(1)
    routine = found ?? null
  }
  return { run: row.run, routine }
}

/** Whether the policy lets this agent draft in the project — auto-accept's gate. */
async function mayDraft(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  module: string,
): Promise<boolean> {
  if (actor.type === 'user') return true
  const scope = workScope(
    actor,
    module as Parameters<typeof workScope>[1],
    'write',
  )
  if (!can(actor, scope.area, scope.capability)) return false
  try {
    await assertPolicyAllows(tx, actor, project?.id ?? null, 'draft')
    return true
  } catch (error) {
    if (error instanceof OpsError) return false
    throw error
  }
}

async function accept(
  tx: Tx,
  actor: Actor,
  proposal: AgentProposalRow,
  project: ProjectRow | null,
  note: string | null,
): Promise<{
  proposal: AgentProposalRow
  created: { type: string; id: string; href: string }
}> {
  const created = await createTarget(proposal.kind, proposal.payload, {
    tx,
    actor,
    project,
  })
  const [row] = await tx
    .update(agentProposals)
    .set({
      status: 'accepted',
      acceptedAs: created,
      decidedAt: sql`now()`,
      decidedBy: actor.type === 'user' ? actor.userId : null,
      decisionNote: note,
      heldAt: null,
      revision: sql`${agentProposals.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(agentProposals.id, proposal.id),
        eq(agentProposals.revision, proposal.revision),
      ),
    )
    .returning()
  if (!row) throw conflict()
  await link(
    tx,
    actor,
    { type: 'proposal', id: proposal.id },
    { type: created.type, id: created.id },
    'proposed_as',
  )
  await audit(tx, actor, {
    projectId: proposal.projectId,
    action: 'agents.proposal.accept',
    targetType: 'proposal',
    targetId: proposal.id,
    beforeRevision: proposal.revision,
    afterRevision: row.revision,
    reason: note,
    changes: { kind: proposal.kind, acceptedAs: created },
  })
  await emitEvent(tx, {
    ownerId: proposal.ownerId,
    projectId: proposal.projectId,
    type: 'proposal.decided',
    subjectType: 'proposal',
    subjectId: proposal.id,
    dedupeKey: `proposal.decided:${proposal.id}`,
    payload: {
      status: 'accepted',
      kind: proposal.kind,
      accepted_type: created.type,
      accepted_id: created.id,
    },
  })
  return { proposal: row, created }
}

/**
 * Leave a proposal for the owner. An agent needs `agents:operate` and a
 * policy that allows `propose` where it lands; inside a run it passes the
 * run and its fencing token, and a routine's run proposes only into the
 * routine's project (a routine in no project may propose anywhere).
 */
export async function propose(
  actor: Actor,
  raw: ProposeInput,
): Promise<ProposalOutcome> {
  const input = parseInput(proposeSchema, raw)
  const adapter = targetFor(input.kind)
  if (!adapter)
    throw invalid(`Nothing can be made as “${input.kind}” in this HQ yet.`)
  // The target's own rules, now — not when the owner clicks Accept.
  const payload = parseInput(adapter.schema, input.payload) as Record<
    string,
    unknown
  >
  const outcome = await runOperation(
    actor,
    {
      operation: 'agents_propose',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined, fencingToken: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const context = input.runId
          ? await runContext(tx, actor, input.runId, input.fencingToken)
          : null
        const routine = context?.routine ?? null
        let projectId = input.projectId ?? null
        if (routine?.projectId) {
          if (projectId && projectId !== routine.projectId)
            throw invalid(
              `This routine works in its own project; propose there.`,
              { project_id: 'Not the routine’s project.' },
            )
          projectId = routine.projectId
        }
        const project = projectId
          ? await ownProject(tx, actor, projectId)
          : null
        if (!project && !adapter.projectOptional)
          throw invalid(`A ${adapter.label} belongs to a project. Name one.`, {
            project_id: 'Required for this kind.',
          })
        if (
          project &&
          adapter.module !== 'notes' &&
          !project.modules.enabled.includes(adapter.module)
        )
          throw invalid(`${adapter.label} is off for ${project.name}.`)
        const scope = workScope(actor, 'agents', 'write')
        await authorize(
          tx,
          actor,
          project,
          scope.area,
          scope.capability,
          'propose',
        )
        const [row] = await tx
          .insert(agentProposals)
          .values({
            ownerId: actor.userId,
            createdBy: actor.userId,
            projectId: project?.id ?? null,
            routineId: routine?.id ?? null,
            taskId: context?.run.taskId ?? null,
            runId: context?.run.id ?? null,
            kind: input.kind,
            title: input.title as string,
            payload,
            rationale: input.rationale ?? '',
            actorType: actor.type,
            actorId: actor.id,
          })
          .returning()
        const proposal = returned(row)
        await audit(tx, actor, {
          projectId: proposal.projectId,
          action: 'agents.proposal.create',
          targetType: 'proposal',
          targetId: proposal.id,
          afterRevision: proposal.revision,
          changes: {
            kind: proposal.kind,
            title: proposal.title,
            routine: routine?.name ?? null,
          },
        })
        if (
          routine?.autoAccept.includes(input.kind) &&
          (await mayDraft(tx, actor, project, adapter.module))
        ) {
          const done = await accept(
            tx,
            actor,
            proposal,
            project,
            `Auto-accepted by the routine “${routine.name}”.`,
          )
          return { proposal: done.proposal, accepted: done.created }
        }
        return { proposal, accepted: null }
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.proposal_id
    if (typeof id !== 'string') throw conflict()
    const proposal = await getProposal(actor, id)
    return { proposal, accepted: proposal.acceptedAs ?? null }
  }
  await outcome.complete({ proposal_id: outcome.value.proposal.id })
  return outcome.value
}

/* ── Deciding (the owner's) ─────────────────────────────────────────── */

async function lockedProposal(
  tx: Tx,
  actor: Actor,
  proposalId: string,
  expectedRevision: number | undefined,
): Promise<{ proposal: AgentProposalRow; project: ProjectRow | null }> {
  const { row, project } = await ownedRow<AgentProposalRow>(
    tx,
    actor,
    agentProposals,
    proposalId,
    'Proposal',
    { lock: true },
  )
  // Deciding is the owner's: no connection decides a proposal.
  if (actor.type !== 'user')
    throw forbidden(
      'Only the owner decides a proposal, in HQ’s Inbox. Read the decision with agents_pull_events.',
    )
  await authorize(tx, actor, project, 'agents', 'write')
  if (expectedRevision && row.revision !== expectedRevision) throw conflict()
  if (row.status !== 'proposed')
    throw invalid(`This proposal was already ${row.status}.`)
  if (row.expiresAt.getTime() < (await dbNow(tx)).getTime())
    throw invalid('This proposal expired. Ask the routine again.')
  return { proposal: row, project }
}

const decideSchema = z.object({
  proposalId: recordId('Proposal'),
  expectedRevision: revision.optional(),
  note: text.optional('Note', 1000),
})

/** Accept: the target adapter makes the record, linked back to the proposal. */
export async function acceptProposal(
  actor: Actor,
  raw: z.input<typeof decideSchema>,
): Promise<{
  proposal: AgentProposalRow
  created: { type: string; id: string; href: string }
}> {
  const input = parseInput(decideSchema, raw)
  return withTransaction(async (tx) => {
    const { proposal, project } = await lockedProposal(
      tx,
      actor,
      input.proposalId,
      input.expectedRevision,
    )
    if (project?.status === 'archived')
      throw invalid('Its project is archived. Restore it first.')
    return accept(tx, actor, proposal, project, input.note ?? null)
  })
}

/** Reject, with a reason the agent reads on its next pull. */
export async function rejectProposal(
  actor: Actor,
  raw: z.input<typeof decideSchema>,
): Promise<AgentProposalRow> {
  const input = parseInput(decideSchema, raw)
  return withTransaction(async (tx) => {
    const { proposal } = await lockedProposal(
      tx,
      actor,
      input.proposalId,
      input.expectedRevision,
    )
    const [row] = await tx
      .update(agentProposals)
      .set({
        status: 'rejected',
        decidedAt: sql`now()`,
        decidedBy: actor.userId,
        decisionNote: input.note ?? null,
        heldAt: null,
        revision: sql`${agentProposals.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(agentProposals.id, proposal.id))
      .returning()
    const saved = returned(row)
    await audit(tx, actor, {
      projectId: proposal.projectId,
      action: 'agents.proposal.reject',
      targetType: 'proposal',
      targetId: proposal.id,
      beforeRevision: proposal.revision,
      afterRevision: saved.revision,
      reason: input.note ?? null,
    })
    await emitEvent(tx, {
      ownerId: proposal.ownerId,
      projectId: proposal.projectId,
      type: 'proposal.decided',
      subjectType: 'proposal',
      subjectId: proposal.id,
      dedupeKey: `proposal.decided:${proposal.id}`,
      payload: {
        status: 'rejected',
        kind: proposal.kind,
        note: input.note ?? null,
      },
    })
    return saved
  })
}

/** Hold: it keeps waiting, sorted last, until decided — or held no more. */
export async function holdProposal(
  actor: Actor,
  raw: { proposalId: string; expectedRevision?: number; held?: boolean },
): Promise<AgentProposalRow> {
  const input = parseInput(
    decideSchema.extend({ held: z.boolean().optional() }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { proposal } = await lockedProposal(
      tx,
      actor,
      input.proposalId,
      input.expectedRevision,
    )
    const held = input.held ?? true
    const [row] = await tx
      .update(agentProposals)
      .set({
        heldAt: held ? sql`now()` : null,
        revision: sql`${agentProposals.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(agentProposals.id, proposal.id))
      .returning()
    const saved = returned(row)
    await audit(tx, actor, {
      projectId: proposal.projectId,
      action: held ? 'agents.proposal.hold' : 'agents.proposal.unhold',
      targetType: 'proposal',
      targetId: proposal.id,
      beforeRevision: proposal.revision,
      afterRevision: saved.revision,
    })
    return saved
  })
}

/* ── Reading ────────────────────────────────────────────────────────── */

export type ProposalItem = {
  proposal: AgentProposalRow
  project: Pick<ProjectRow, 'id' | 'slug' | 'name' | 'color'> | null
  routine: { id: string; name: string } | null
  label: string
  module: string | null
}

function assertRead(actor: Actor): void {
  const scope = workScope(actor, 'agents', 'read')
  assertCan(actor, scope.area, scope.capability)
}

export async function getProposal(
  actor: Actor,
  proposalId: string,
): Promise<AgentProposalRow> {
  assertRead(actor)
  return withReader(async (db) => {
    const { row } = await ownedRow<AgentProposalRow>(
      db,
      actor,
      agentProposals,
      proposalId,
      'Proposal',
    )
    return row
  })
}

const listSchema = z.object({
  status: z.enum(AGENT_PROPOSAL_STATUSES).optional(),
  projectId: optionalRecordId('Project'),
  routineId: optionalRecordId('Routine'),
  runId: optionalRecordId('Run'),
  kinds: z.array(z.enum(AGENT_PROPOSAL_KINDS)).optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

async function items(
  reader: Reader,
  ownerId: string,
  rows: AgentProposalRow[],
): Promise<ProposalItem[]> {
  if (rows.length === 0) return []
  const projectIds = [
    ...new Set(rows.map((row) => row.projectId).filter(Boolean)),
  ] as string[]
  const routineIds = [
    ...new Set(rows.map((row) => row.routineId).filter(Boolean)),
  ] as string[]
  const [projectRows, routineRows] = await Promise.all([
    projectIds.length
      ? reader
          .select({
            id: projects.id,
            slug: projects.slug,
            name: projects.name,
            color: projects.color,
          })
          .from(projects)
          .where(
            and(
              eq(projects.ownerId, ownerId),
              inArray(projects.id, projectIds),
            ),
          )
      : Promise.resolve([]),
    routineIds.length
      ? reader
          .select({ id: agentRoutines.id, name: agentRoutines.name })
          .from(agentRoutines)
          .where(inArray(agentRoutines.id, routineIds))
      : Promise.resolve([]),
  ])
  return rows.map((proposal) => {
    const adapter = targetFor(proposal.kind)
    return {
      proposal,
      project:
        projectRows.find((project) => project.id === proposal.projectId) ??
        null,
      routine:
        routineRows.find((routine) => routine.id === proposal.routineId) ??
        null,
      label: adapter?.label ?? proposal.kind,
      module: adapter?.module ?? null,
    }
  })
}

/**
 * Proposals, newest first — or, for the waiting ones, held last. An agent
 * reads its own routines' decisions this way (with `agents:operate`).
 */
export async function listProposals(
  actor: Actor,
  raw: z.input<typeof listSchema> = {},
): Promise<ProposalItem[]> {
  assertRead(actor)
  const input = parseInput(listSchema, raw)
  return withReader(async (db) => {
    const rows = await db
      .select()
      .from(agentProposals)
      .where(
        and(
          eq(agentProposals.ownerId, actor.userId),
          input.status ? eq(agentProposals.status, input.status) : undefined,
          input.projectId
            ? eq(agentProposals.projectId, input.projectId)
            : undefined,
          input.routineId
            ? eq(agentProposals.routineId, input.routineId)
            : undefined,
          input.runId ? eq(agentProposals.runId, input.runId) : undefined,
          input.kinds?.length
            ? inArray(agentProposals.kind, input.kinds)
            : undefined,
        ),
      )
      .orderBy(
        sql`${agentProposals.heldAt} is not null`,
        desc(agentProposals.createdAt),
      )
      .limit(input.limit ?? 100)
    return items(db, actor.userId, rows)
  })
}

/** Waiting proposals per project (null = no project) — for Home and State. */
export async function countOpenProposals(
  actor: Actor,
): Promise<{ projectId: string | null; count: number }[]> {
  assertRead(actor)
  return withReader((db) =>
    db
      .select({
        projectId: agentProposals.projectId,
        count: sql<number>`count(*)::int`,
      })
      .from(agentProposals)
      .where(
        and(
          eq(agentProposals.ownerId, actor.userId),
          eq(agentProposals.status, 'proposed'),
        ),
      )
      .groupBy(agentProposals.projectId),
  )
}

/**
 * The ops tick: an undecided proposal past its expiry lapses — the agent
 * learns it on its next pull; nothing is made.
 */
export async function expireProposals(limit = 100): Promise<number> {
  return withTransaction(async (tx) => {
    const lapsed = await tx
      .select()
      .from(agentProposals)
      .where(
        and(
          eq(agentProposals.status, 'proposed'),
          lt(agentProposals.expiresAt, sql`now()`),
        ),
      )
      .orderBy(asc(agentProposals.expiresAt))
      .limit(limit)
      .for('update', { skipLocked: true })
    for (const proposal of lapsed) {
      await tx
        .update(agentProposals)
        .set({
          status: 'expired',
          decidedAt: sql`now()`,
          revision: sql`${agentProposals.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(agentProposals.id, proposal.id))
      await audit(tx, schedulerActor(proposal.ownerId), {
        projectId: proposal.projectId,
        action: 'agents.proposal.expire',
        targetType: 'proposal',
        targetId: proposal.id,
      })
      await emitEvent(tx, {
        ownerId: proposal.ownerId,
        projectId: proposal.projectId,
        type: 'proposal.decided',
        subjectType: 'proposal',
        subjectId: proposal.id,
        dedupeKey: `proposal.decided:${proposal.id}`,
        payload: { status: 'expired', kind: proposal.kind },
      })
    }
    return lapsed.length
  })
}
