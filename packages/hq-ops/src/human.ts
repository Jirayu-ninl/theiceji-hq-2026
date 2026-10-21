import {
  MODULE_IDS,
  OPS_HUMAN_REQUEST_KINDS,
  OPS_HUMAN_REQUEST_STATUSES,
  OPS_URGENCIES,
} from '@theiceji/hq-db/enums'
import {
  type OpsHumanRequestRow,
  type OpsHumanResponseRow,
  opsHumanRequests,
  opsHumanResponses,
  opsTasks,
  type ProjectRow,
  projects,
} from '@theiceji/hq-db/schema'
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  type Actor,
  assertAgentWork,
  assertCan,
  assertKernelRead,
} from './access'
import { schedulerActor } from './actors'
import { dbNow, isUuid, nowPlus, type Reader, type Tx } from './db'
import { conflict, forbidden, invalid, notFound, policyBlocked } from './errors'
import { emitEvent } from './outbox'
import { currentPolicy, policyState, sameProject } from './policy-gate'
import {
  choice,
  int,
  machineKey,
  optionalChoice,
  optionalRecordId,
  parseInput,
  revision,
  text,
} from './schemas'
import {
  audit,
  authorize,
  ownProject,
  returned,
  withReader,
  withTransaction,
} from './store'
import { auditSnapshot } from './values'

/**
 * The owner's inbox of human requests (`/inbox`).
 *
 * An agent asks for what only the owner can do or decide — sign in, consent,
 * identity or payout details, a likeness release, more spending scope, a
 * dispute, a manual step — with the exact action, the record revision it is
 * about, what happens meanwhile and when the question stops mattering.
 *
 * The answer belongs to that revision. A response to revision 3 can't be
 * used for revision 4, an expired request can't be answered, and only the
 * owner can answer at all. Answering unblocks exactly the tasks that were
 * waiting on that request, and nothing else. An answer is information for
 * the agent: it never widens a policy or approves a release by itself —
 * those stay owner actions on their own records.
 *
 * A request sits under a project or under the owner alone, and names the
 * module it is about (null for a kernel question). A connection asks and
 * withdraws with `agents:operate` ("ask you for help") and reads answers with
 * that or `hq:read`; answering is a person's, never a scope's. Every "has it
 * expired" is the database's clock.
 */

const DEFAULT_EXPIRY_HOURS = 72

const option = z.object({
  key: machineKey('Option key', 40),
  label: z.string().trim().min(1).max(120),
})

const requestSchema = z.object({
  module: optionalChoice(MODULE_IDS, 'That isn’t a module.'),
  kind: choice(OPS_HUMAN_REQUEST_KINDS, 'Choose what kind of help this is.'),
  title: text.required('Title', 200),
  reason: text.required('Reason', 2000),
  /** The exact action being asked for, as data — tool, target and parameters. */
  requestedAction: z
    .record(z.string().max(80), z.unknown())
    .refine(
      (value) => Object.keys(value).length > 0,
      'Describe the exact action being asked for.',
    )
    .refine(
      (value) => JSON.stringify(value).length <= 16_000,
      'The requested action must be under 16 KB.',
    ),
  targetType: machineKey('Target type', 60).optional(),
  targetId: optionalRecordId('Target'),
  targetRevision: int('Target revision', 1, 1_000_000),
  impact: text.optional('Impact', 2000),
  meanwhile: text.optional('What happens meanwhile', 2000),
  options: z.array(option).max(10).optional(),
  urgency: choice(OPS_URGENCIES, 'Choose digest or urgent.').optional(),
  expiresInHours: int('Expires in', 1, 24 * 30),
  dedupeKey: machineKey('Dedupe key', 200).optional(),
  taskId: optionalRecordId('Task'),
})

export type HumanRequestInput = z.input<typeof requestSchema>

const DEFAULT_OPTIONS: Record<string, { key: string; label: string }[]> = {
  approval: [
    { key: 'approve', label: 'Approve' },
    { key: 'deny', label: 'Deny' },
  ],
  spend_scope: [
    { key: 'approve', label: 'I’ve changed the policy' },
    { key: 'deny', label: 'No' },
  ],
}

/* ── Manual steps finished elsewhere ────────────────────────────────── */

const manualStepTargets = new Map<string, string>()

/**
 * A module whose manual steps are finished by recording them on its own
 * record (a generation job's outputs, a post's URL and evidence) registers
 * that target type here. A `manual_step` request about one is then refused
 * as an answer — an answer would close the question and leave the work
 * itself stuck. The message tells the owner where to record it instead.
 */
export function registerManualStepTarget(
  targetType: string,
  message: string,
): void {
  manualStepTargets.set(targetType, message)
}

/* ── Asking ─────────────────────────────────────────────────────────── */

async function assertMayAsk(
  tx: Tx,
  actor: Actor,
  projectId: string | null,
): Promise<void> {
  if (actor.type === 'user') return
  // Asking for help must work even when the policy blocks the work itself —
  // that is usually why the agent is asking. It still needs a policy that
  // covers this connection, so a stranger's connection can't flood the inbox.
  const [policy, now] = await Promise.all([
    currentPolicy(tx, actor.userId, projectId),
    dbNow(tx),
  ])
  const state = policyState(policy, actor, now)
  if (!state.ok && state.policy === null)
    throw policyBlocked(state.reason, { projectId })
  if (
    !state.ok &&
    state.policy?.coverage === 'selected' &&
    !(actor.grantId && state.policy.grantIds.includes(actor.grantId))
  )
    throw policyBlocked(state.reason, { projectId })
}

export type HumanRequestCreated = {
  request: OpsHumanRequestRow
  /** True when an open request with the same dedupe key already existed. */
  deduplicated: boolean
}

async function openByDedupeKey(
  tx: Tx,
  ownerId: string,
  dedupeKey: string,
): Promise<OpsHumanRequestRow | null> {
  const [open] = await tx
    .select()
    .from(opsHumanRequests)
    .where(
      and(
        eq(opsHumanRequests.ownerId, ownerId),
        eq(opsHumanRequests.dedupeKey, dedupeKey),
        eq(opsHumanRequests.status, 'open'),
      ),
    )
    .limit(1)
  return open ?? null
}

/**
 * Asks the owner. `projectId` null is a question about work in no project.
 * An open request with the same `dedupeKey` (per owner) is returned instead
 * of a second one.
 */
export async function requestHumanAction(
  actor: Actor,
  projectId: string | null,
  raw: unknown,
): Promise<HumanRequestCreated> {
  assertAgentWork(actor)
  const input = parseInput(requestSchema, raw)
  return withTransaction(async (tx) => {
    const project = projectId ? await ownProject(tx, actor, projectId) : null
    const scope = project?.id ?? null
    await assertMayAsk(tx, actor, scope)
    if (input.dedupeKey) {
      const open = await openByDedupeKey(tx, actor.userId, input.dedupeKey)
      if (open) return { request: open, deduplicated: true }
    }
    if (input.taskId) {
      const [task] = await tx
        .select({ id: opsTasks.id })
        .from(opsTasks)
        .where(
          and(
            eq(opsTasks.id, input.taskId),
            eq(opsTasks.ownerId, actor.userId),
            sameProject(opsTasks.projectId, scope),
          ),
        )
        .limit(1)
      if (!task)
        throw invalid('That task is not in this project.', {
          taskId: 'Unknown task.',
        })
    }
    const values = {
      module: input.module ?? null,
      kind: input.kind,
      title: input.title,
      reason: input.reason,
      requestedAction: input.requestedAction,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      targetRevision: input.targetRevision ?? null,
      impact: input.impact ?? null,
      meanwhile: input.meanwhile ?? null,
      options: input.options ?? DEFAULT_OPTIONS[input.kind] ?? [],
      urgency: input.urgency ?? 'digest',
      dedupeKey: input.dedupeKey ?? null,
      taskId: input.taskId ?? null,
    }
    const inserted = await tx
      .insert(opsHumanRequests)
      .values({
        ...values,
        ownerId: actor.userId,
        projectId: scope,
        expiresAt: nowPlus(
          (input.expiresInHours ?? DEFAULT_EXPIRY_HOURS) * 3600,
        ),
        actorType: actor.type,
        actorId: actor.id,
        createdBy: actor.userId,
      })
      .onConflictDoNothing()
      .returning()
    const request = inserted[0]
    if (!request) {
      // A concurrent ask with the same dedupe key won the partial unique index.
      const open = await openByDedupeKey(
        tx,
        actor.userId,
        input.dedupeKey ?? '',
      )
      if (!open) throw conflict('The request could not be created. Try again.')
      return { request: open, deduplicated: true }
    }
    await audit(tx, actor, {
      projectId: scope,
      action: 'human_request.create',
      targetType: 'human_request',
      targetId: request.id,
      afterRevision: request.revision,
      reason: input.reason,
      changes: auditSnapshot({
        module: values.module,
        kind: values.kind,
        title: values.title,
        urgency: values.urgency,
        targetType: values.targetType,
        targetId: values.targetId,
        targetRevision: values.targetRevision,
        expiresAt: request.expiresAt,
      }),
    })
    return { request, deduplicated: false }
  })
}

/* ── Answering ──────────────────────────────────────────────────────── */

const respondSchema = z.object({
  expectedRevision: revision,
  choice: machineKey('Choice', 40),
  note: text.optional('Note', 2000),
})

export type HumanResponseInput = z.input<typeof respondSchema>

export type HumanResponseOutcome = {
  request: OpsHumanRequestRow
  response: OpsHumanResponseRow
  /** Tasks that were blocked on this request and are open again. */
  unblockedTasks: string[]
}

/** The request, locked, with whether it is still answerable by the database's clock. */
async function lockedRequest(
  tx: Tx,
  actor: Actor,
  requestId: string,
): Promise<{
  request: OpsHumanRequestRow
  project: ProjectRow | null
  expired: boolean
}> {
  if (!isUuid(requestId)) throw notFound('Request')
  const [row] = await tx
    .select({
      request: opsHumanRequests,
      project: projects,
      expired: sql<boolean>`${opsHumanRequests.expiresAt} <= now()`,
    })
    .from(opsHumanRequests)
    .leftJoin(projects, eq(projects.id, opsHumanRequests.projectId))
    .where(
      and(
        eq(opsHumanRequests.id, requestId),
        eq(opsHumanRequests.ownerId, actor.userId),
      ),
    )
    .limit(1)
    .for('update', { of: opsHumanRequests })
  if (!row) throw notFound('Request')
  return {
    request: row.request,
    project: (row.project as ProjectRow | null) ?? null,
    expired: row.expired,
  }
}

/**
 * The owner's answer — what `/inbox` calls. Only a person can give one; a
 * connection can't answer its own question. The response row is
 * append-only; answering emits `human.responded` and reopens exactly the
 * tasks that were blocked waiting on this request.
 */
export async function respondToHumanRequest(
  actor: Actor,
  requestId: string,
  raw: unknown,
): Promise<HumanResponseOutcome> {
  const input = parseInput(respondSchema, raw)
  if (actor.type !== 'user')
    throw forbidden(
      'Only the owner answers a human request. A connection can’t answer its own question.',
    )
  assertCan(actor, 'ops', 'decide')
  return withTransaction(async (tx) => {
    const { request, project, expired } = await lockedRequest(
      tx,
      actor,
      requestId,
    )
    await authorize(tx, actor, project, 'ops', 'decide')
    if (request.status !== 'open')
      throw invalid(`This request is already ${request.status}.`)
    if (expired)
      throw invalid(
        'This request expired, so its answer would be about a situation that may have changed. The agent can ask again.',
      )
    if (request.revision !== input.expectedRevision)
      throw conflict(
        'The request changed since you opened it. Reload and answer the current version.',
      )
    const elsewhere =
      request.kind === 'manual_step' && request.targetType
        ? manualStepTargets.get(request.targetType)
        : undefined
    if (elsewhere) throw invalid(elsewhere)
    if (
      request.options.length > 0 &&
      !request.options.some((entry) => entry.key === input.choice)
    )
      throw invalid('Choose one of the offered answers.', {
        choice: 'Not one of the options.',
      })

    const response = returned(
      (
        await tx
          .insert(opsHumanResponses)
          .values({
            ownerId: request.ownerId,
            projectId: request.projectId,
            requestId: request.id,
            requestRevision: request.revision,
            choice: input.choice,
            note: input.note ?? null,
            respondedBy: actor.userId,
          })
          .returning()
      )[0],
    )
    const [answered] = await tx
      .update(opsHumanRequests)
      .set({
        status: 'answered',
        answeredAt: sql`now()`,
        revision: request.revision + 1,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(opsHumanRequests.id, request.id),
          eq(opsHumanRequests.revision, request.revision),
        ),
      )
      .returning()
    if (!answered) throw conflict()

    const unblocked = await tx
      .update(opsTasks)
      .set({
        status: 'open',
        blockedReason: null,
        waitingOnRequestId: null,
        revision: sql`${opsTasks.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(opsTasks.ownerId, request.ownerId),
          eq(opsTasks.status, 'blocked'),
          eq(opsTasks.waitingOnRequestId, request.id),
        ),
      )
      .returning({ id: opsTasks.id, projectId: opsTasks.projectId })
    for (const task of unblocked)
      await emitEvent(tx, {
        ownerId: request.ownerId,
        projectId: task.projectId,
        type: 'task.ready',
        subjectType: 'task',
        subjectId: task.id,
        dedupeKey: `task.ready:${task.id}:after:${response.id}`,
        payload: { unblockedBy: request.id },
      })
    await emitEvent(tx, {
      ownerId: request.ownerId,
      projectId: request.projectId,
      type: 'human.responded',
      subjectType: 'human_request',
      subjectId: request.id,
      dedupeKey: `human.responded:${request.id}`,
      payload: {
        choice: input.choice,
        requestRevision: request.revision,
        module: request.module,
      },
    })
    await audit(tx, actor, {
      projectId: request.projectId,
      action: 'human_request.answer',
      targetType: 'human_request',
      targetId: request.id,
      beforeRevision: request.revision,
      afterRevision: answered.revision,
      reason: input.note ?? null,
      changes: {
        choice: input.choice,
        responseId: response.id,
        unblockedTasks: unblocked.length,
      },
    })
    return {
      request: answered,
      response,
      unblockedTasks: unblocked.map((task) => task.id),
    }
  })
}

const withdrawSchema = z.object({
  expectedRevision: revision,
  reason: text.required('Reason', 1000),
})

/** The asking connection, or the owner, takes a question back. */
export async function withdrawHumanRequest(
  actor: Actor,
  requestId: string,
  raw: unknown,
): Promise<OpsHumanRequestRow> {
  assertAgentWork(actor)
  const input = parseInput(withdrawSchema, raw)
  return withTransaction(async (tx) => {
    const { request } = await lockedRequest(tx, actor, requestId)
    if (actor.type !== 'user' && request.actorId !== actor.id)
      throw forbidden(
        'Only the connection that asked, or the owner, can withdraw this.',
      )
    if (request.status !== 'open')
      throw invalid(`This request is already ${request.status}.`)
    if (request.revision !== input.expectedRevision) throw conflict()
    const [withdrawn] = await tx
      .update(opsHumanRequests)
      .set({
        status: 'withdrawn',
        revision: request.revision + 1,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(opsHumanRequests.id, request.id),
          eq(opsHumanRequests.revision, request.revision),
        ),
      )
      .returning()
    if (!withdrawn) throw conflict()
    await audit(tx, actor, {
      projectId: request.projectId,
      action: 'human_request.withdraw',
      targetType: 'human_request',
      targetId: request.id,
      beforeRevision: request.revision,
      afterRevision: withdrawn.revision,
      reason: input.reason,
    })
    return withdrawn
  })
}

/* ── The ops tick ───────────────────────────────────────────────────── */

/**
 * Open requests past their expiry stop being answerable. A task waiting on
 * one stays blocked, with a reason that says the question lapsed — the owner
 * (or the agent) decides whether to ask again. A batch at a time, for every
 * owner unless `ownerId` narrows it.
 */
export async function expireHumanRequests(
  options: { ownerId?: string; limit?: number } = {},
): Promise<string[]> {
  return withTransaction(async (tx) => {
    const due = await tx
      .select({ id: opsHumanRequests.id })
      .from(opsHumanRequests)
      .where(
        and(
          options.ownerId
            ? eq(opsHumanRequests.ownerId, options.ownerId)
            : undefined,
          eq(opsHumanRequests.status, 'open'),
          sql`${opsHumanRequests.expiresAt} <= now()`,
        ),
      )
      .orderBy(asc(opsHumanRequests.expiresAt))
      .limit(options.limit ?? 200)
      .for('update', { skipLocked: true })
    if (due.length === 0) return []
    const expired = await tx
      .update(opsHumanRequests)
      .set({
        status: 'expired',
        revision: sql`${opsHumanRequests.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          inArray(
            opsHumanRequests.id,
            due.map((row) => row.id),
          ),
          eq(opsHumanRequests.status, 'open'),
        ),
      )
      .returning()
    for (const request of expired) {
      await tx
        .update(opsTasks)
        .set({
          blockedReason: `The human request “${request.title}” expired unanswered. Decide whether to ask again or drop the task.`,
          revision: sql`${opsTasks.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(opsTasks.ownerId, request.ownerId),
            eq(opsTasks.waitingOnRequestId, request.id),
            eq(opsTasks.status, 'blocked'),
          ),
        )
      await emitEvent(tx, {
        ownerId: request.ownerId,
        projectId: request.projectId,
        type: 'human.responded',
        subjectType: 'human_request',
        subjectId: request.id,
        dedupeKey: `human.responded:${request.id}`,
        payload: { status: 'expired', module: request.module },
      })
      await audit(tx, schedulerActor(request.ownerId), {
        projectId: request.projectId,
        action: 'human_request.expire',
        targetType: 'human_request',
        targetId: request.id,
        beforeRevision: request.revision - 1,
        afterRevision: request.revision,
      })
    }
    return expired.map((request) => request.id)
  })
}

/**
 * Urgent open requests nobody has been pushed about yet, marked as pushed in
 * the same statement — so two ticks never notify twice. Returns the rows
 * (with `ownerId`) for HQ to push to that owner's devices.
 */
export async function claimUrgentForNotification(
  options: { ownerId?: string; limit?: number } = {},
): Promise<OpsHumanRequestRow[]> {
  return withTransaction(async (tx) => {
    const due = await tx
      .select({ id: opsHumanRequests.id })
      .from(opsHumanRequests)
      .where(
        and(
          options.ownerId
            ? eq(opsHumanRequests.ownerId, options.ownerId)
            : undefined,
          eq(opsHumanRequests.status, 'open'),
          eq(opsHumanRequests.urgency, 'urgent'),
          isNull(opsHumanRequests.notifiedAt),
          sql`${opsHumanRequests.expiresAt} > now()`,
        ),
      )
      .orderBy(asc(opsHumanRequests.createdAt))
      .limit(options.limit ?? 50)
      .for('update', { skipLocked: true })
    if (due.length === 0) return []
    return tx
      .update(opsHumanRequests)
      .set({ notifiedAt: sql`now()` })
      .where(
        and(
          inArray(
            opsHumanRequests.id,
            due.map((row) => row.id),
          ),
          isNull(opsHumanRequests.notifiedAt),
        ),
      )
      .returning()
  })
}

/* ── Reading (the inbox) ────────────────────────────────────────────── */

/** `'none'` (or JSON null) means "work in no project"; absent means every project. */
const projectFilter = z.preprocess(
  (value) => (value === 'none' ? null : value === '' ? undefined : value),
  z.uuid({ error: 'Project not found.' }).nullable().optional(),
)

const listSchema = z.object({
  status: optionalChoice(OPS_HUMAN_REQUEST_STATUSES, 'Unknown status.'),
  projectId: projectFilter,
  module: optionalChoice(MODULE_IDS, 'Unknown module.'),
  since: text.optional('Since', 40),
  limit: int('Limit', 1, 200),
})

export type HumanRequestFilter = {
  status?: OpsHumanRequestRow['status'] | null
  /** A project ID, `null` / `'none'` for requests in no project, absent for all. */
  projectId?: string | null
  module?: OpsHumanRequestRow['module']
  /** Only requests changed at or after this ISO instant. */
  since?: string | null
  limit?: number | null
}

export type InboxProject = Pick<
  ProjectRow,
  'id' | 'slug' | 'name' | 'color' | 'kind'
>

export type HumanRequestItem = {
  request: OpsHumanRequestRow
  /** The owner's answer, once there is one. */
  response: OpsHumanResponseRow | null
  /** The project the request is about; null for work in no project. */
  project: InboxProject | null
  /** Open and not yet past its expiry by the database's clock. */
  answerable: boolean
}

function itemQuery(reader: Reader) {
  return reader
    .select({
      request: opsHumanRequests,
      response: opsHumanResponses,
      project: {
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        color: projects.color,
        kind: projects.kind,
      },
      answerable: sql<boolean>`(${opsHumanRequests.status} = 'open' and ${opsHumanRequests.expiresAt} > now())`,
    })
    .from(opsHumanRequests)
    .leftJoin(
      opsHumanResponses,
      and(
        eq(opsHumanResponses.requestId, opsHumanRequests.id),
        eq(opsHumanResponses.ownerId, opsHumanRequests.ownerId),
      ),
    )
    .leftJoin(projects, eq(projects.id, opsHumanRequests.projectId))
}

function toItem(row: {
  request: OpsHumanRequestRow
  response: OpsHumanResponseRow | null
  project: InboxProject | null
  answerable: boolean
}): HumanRequestItem {
  return {
    request: row.request,
    response: row.response ?? null,
    project: row.project?.id ? row.project : null,
    answerable: Boolean(row.answerable),
  }
}

/**
 * Requests and their answers, newest questions that still matter first: open
 * ones (urgent first, soonest to expire first), then the rest by last change.
 * What `/inbox` lists and what an agent reads its answers back with.
 */
export async function listHumanRequests(
  actor: Actor,
  raw: HumanRequestFilter | Record<string, unknown> = {},
): Promise<HumanRequestItem[]> {
  assertKernelRead(actor)
  const input = parseInput(listSchema, raw)
  return withReader(async (db) => {
    // Someone else's project reads as "not found", not as an empty inbox.
    if (typeof input.projectId === 'string')
      await ownProject(db, actor, input.projectId)
    const since = input.since ? new Date(input.since) : null
    if (since && Number.isNaN(since.getTime()))
      throw invalid('Since must be an ISO date and time.', {
        since: 'Use an ISO date and time.',
      })
    const rows = await itemQuery(db)
      .where(
        and(
          eq(opsHumanRequests.ownerId, actor.userId),
          input.projectId === undefined
            ? undefined
            : sameProject(opsHumanRequests.projectId, input.projectId),
          input.status ? eq(opsHumanRequests.status, input.status) : undefined,
          input.module ? eq(opsHumanRequests.module, input.module) : undefined,
          since ? gte(opsHumanRequests.updatedAt, since) : undefined,
        ),
      )
      .orderBy(
        sql`case when ${opsHumanRequests.status} = 'open' then 0 else 1 end`,
        sql`case when ${opsHumanRequests.status} = 'open' and ${opsHumanRequests.urgency} = 'urgent' then 0 else 1 end`,
        sql`case when ${opsHumanRequests.status} = 'open' then ${opsHumanRequests.expiresAt} end asc nulls last`,
        desc(opsHumanRequests.updatedAt),
      )
      .limit(input.limit ?? 50)
    return rows.map(toItem)
  })
}

/** One request with its answer — the inbox's detail pane. */
export async function getHumanRequest(
  actor: Actor,
  requestId: string,
): Promise<HumanRequestItem> {
  assertKernelRead(actor)
  if (!isUuid(requestId)) throw notFound('Request')
  return withReader(async (db) => {
    const [row] = await itemQuery(db)
      .where(
        and(
          eq(opsHumanRequests.id, requestId),
          eq(opsHumanRequests.ownerId, actor.userId),
        ),
      )
      .limit(1)
    if (!row) throw notFound('Request')
    return toItem(row)
  })
}

/** How many questions are waiting — the inbox badge. */
export async function countOpenHumanRequests(
  actor: Actor,
): Promise<{ open: number; urgent: number }> {
  assertKernelRead(actor)
  return withReader(async (db) => {
    const [row] = await db
      .select({
        open: sql<number>`count(*)::int`,
        urgent: sql<number>`(count(*) filter (where ${opsHumanRequests.urgency} = 'urgent'))::int`,
      })
      .from(opsHumanRequests)
      .where(
        and(
          eq(opsHumanRequests.ownerId, actor.userId),
          eq(opsHumanRequests.status, 'open'),
          sql`${opsHumanRequests.expiresAt} > now()`,
        ),
      )
    return { open: row?.open ?? 0, urgent: row?.urgent ?? 0 }
  })
}
