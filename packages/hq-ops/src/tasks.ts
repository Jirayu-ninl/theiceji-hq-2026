import {
  MODULE_IDS,
  type ModuleId,
  OPS_TASK_CLAIMANTS,
  OPS_TASK_KINDS,
  type OpsAgentAction,
  type OpsTaskClaimant,
  type OpsTaskKind,
} from '@theiceji/hq-db/enums'
import {
  type OpsAgentRunRow,
  type OpsRunCheckpointRow,
  type OpsTaskRow,
  opsAgentRuns,
  opsHumanRequests,
  opsRunCheckpoints,
  opsTasks,
  type ProjectRow,
  projects,
} from '@theiceji/hq-db/schema'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import { z } from 'zod'
import {
  type Actor,
  assertAgentWork,
  assertKernelRead,
  can,
  type OpsCapability,
  workScope,
} from './access'
import { schedulerActor } from './actors'
import { dbNow, isUuid, nowPlus, type Reader, type Tx } from './db'
import {
  conflict,
  invalid,
  leaseLost,
  notFound,
  OpsError,
  policyBlocked,
} from './errors'
import { emitEvent } from './outbox'
import {
  currentPolicy,
  engagedKillSwitches,
  policyState,
  sameProject,
} from './policy-gate'
import {
  choice,
  choiceList,
  idList,
  int,
  machineKey,
  optionalChoice,
  optionalRecordId,
  parseInput,
  revision,
  text,
} from './schemas'
import {
  assertModuleOn,
  audit,
  authorize,
  ownedRow,
  ownProject,
  returned,
  withReader,
  withTransaction,
} from './store'
import { DEFAULT_TIME_ZONE, parseInstant } from './time'
import { auditSnapshot } from './values'

/**
 * The agent work queue, for every module.
 *
 * A task is claimed atomically: the claim takes a row lock with SKIP LOCKED,
 * starts a lease and bumps the task's fencing token. Everything a worker does
 * afterwards presents that token; once the lease lapses or someone else
 * claims the task, the old token is refused (`lease_lost`) — so two agents
 * can't both publish or both spend on the same task.
 *
 * State lives here, not in chat memory: each run writes checkpoints, and a
 * new claim of the same task returns the last one, so a fresh session picks
 * up where the previous one stopped.
 *
 * A task belongs to an owner and maybe a project. Its policy is that
 * project's, or the owner's no-project policy when `project_id` is null —
 * never one inheriting from the other. Every lease and every "is it due yet"
 * is judged by the database's clock.
 */

/**
 * The policy action an agent needs before it may claim a kind of task — the
 * authority the work itself will use, so a claim never promises what the
 * policy would refuse a minute later:
 *
 * · `routine` → `propose`: a routine run's output is proposals for the owner.
 *   Anything it writes directly is gated again at that tool.
 * · `generation` → `generate`: the task queues spend on a generator.
 * · `publication` → `publish`, `listing` → `list`: the release tasks.
 * · `import` → `import`: recording readings, sales and money.
 * · `reconcile` → `import`: reconciling reads a provider's state back and
 *   records it; it never dispatches (Creator's mapping, unchanged).
 * · `review` → `decide`: a review ends in a decision.
 * · `follow_up`, `other` → `draft`: the least authority that writes anything.
 */
export const TASK_ACTION: Record<OpsTaskKind, OpsAgentAction> = {
  routine: 'propose',
  generation: 'generate',
  publication: 'publish',
  listing: 'list',
  import: 'import',
  reconcile: 'import',
  review: 'decide',
  follow_up: 'draft',
  other: 'draft',
}

/**
 * The capability each policy action needs, which `workScope` turns into a
 * connection scope: `<module>:<capability>` for a module's task, `ops:decide`
 * for a decision, `agents:operate` for kernel work. There is no `import`
 * scope in HQ's catalog: recording is a write, and the
 * policy's `import` action is what tells it apart.
 */
export const ACTION_CAPABILITY: Record<OpsAgentAction, OpsCapability> = {
  draft: 'write',
  propose: 'write',
  import: 'write',
  generate: 'operate',
  authorize_release: 'operate',
  publish: 'operate',
  list: 'operate',
  price: 'operate',
  respond: 'operate',
  decide: 'decide',
}

/**
 * The gate for creating or changing a task, for anyone: a connection needs
 * the scope for its module's writing (`<module>:write`, or `agents:operate`
 * for kernel work — `workScope`) and a policy that allows `draft` there; a
 * person needs `write` by role.
 */
async function authorizeTaskWrite(
  reader: Reader,
  actor: Actor,
  project: ProjectRow | null,
  module: ModuleId | null,
): Promise<void> {
  const scope = workScope(actor, module, 'write')
  await authorize(reader, actor, project, scope.area, scope.capability, 'draft')
}

const MIN_LEASE_S = 30
const MAX_LEASE_S = 60 * 60
const DEFAULT_LEASE_S = 15 * 60

/** IDs and small parameters only — a task never carries copied instructions. */
const payloadValue = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(200), z.number()])).max(100),
])

const createSchema = z.object({
  kind: choice(OPS_TASK_KINDS, 'Choose a task kind.'),
  module: optionalChoice(MODULE_IDS, 'That isn’t a module.'),
  title: text.required('Title', 200),
  detail: text.optional('Detail', 4000),
  payload: z
    .record(z.string().max(60), payloadValue)
    .refine((value) => Object.keys(value).length <= 40, 'At most 40 fields.')
    .optional(),
  priority: int('Priority', 0, 100),
  priorityReason: text.optional('Priority reason', 500),
  dependsOn: idList('Task', 20).optional(),
  dueAt: text.optional('Due', 40),
  notBefore: text.optional('Not before', 40),
  triggerKey: machineKey('Trigger key', 200).optional(),
  targetType: machineKey('Target type', 60).optional(),
  targetId: optionalRecordId('Target'),
  /** Who may claim it — the worker, an agent over MCP, HQ's builtin runner; anyone when absent. */
  claimant: optionalChoice(OPS_TASK_CLAIMANTS, 'Unknown claimant.'),
  maxAttempts: int('Attempts', 1, 20),
})

export type TaskCreated = { task: OpsTaskRow; deduplicated: boolean }

async function findByTrigger(
  tx: Tx,
  ownerId: string,
  triggerKey: string,
): Promise<OpsTaskRow | null> {
  const [existing] = await tx
    .select()
    .from(opsTasks)
    .where(
      and(eq(opsTasks.ownerId, ownerId), eq(opsTasks.triggerKey, triggerKey)),
    )
    .limit(1)
  return existing ?? null
}

async function insertTask(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  input: z.output<typeof createSchema>,
): Promise<TaskCreated> {
  const module = input.module ?? null
  // Notes is HQ-wide and never a project's module row, so it is never "off".
  if (project && module && module !== 'notes') assertModuleOn(project, module)
  // A trigger fires once per owner: the same fact never opens two tasks,
  // whichever project it was raised in.
  if (input.triggerKey) {
    const existing = await findByTrigger(tx, actor.userId, input.triggerKey)
    if (existing) return { task: existing, deduplicated: true }
  }
  const projectId = project?.id ?? null
  const dependsOn = [...new Set(input.dependsOn ?? [])]
  if (dependsOn.length > 0) {
    const found = await tx
      .select({ id: opsTasks.id })
      .from(opsTasks)
      .where(
        and(
          inArray(opsTasks.id, dependsOn),
          eq(opsTasks.ownerId, actor.userId),
          sameProject(opsTasks.projectId, projectId),
        ),
      )
    if (found.length !== dependsOn.length)
      throw invalid(
        'A task can only depend on tasks in the same project (or in no project, alike).',
        { dependsOn: 'Unknown task.' },
      )
  }
  const timeZone = project?.timezone ?? DEFAULT_TIME_ZONE
  const at = (raw: string | null | undefined, field: string) => {
    if (!raw) return null
    const value = parseInstant(raw, timeZone)
    if (!value)
      throw invalid('Use a valid date and time.', {
        [field]: 'Use a valid date and time.',
      })
    return value
  }
  const values = {
    kind: input.kind,
    module,
    title: input.title,
    detail: input.detail ?? null,
    payload: input.payload ?? {},
    priority: input.priority ?? 50,
    priorityReason: input.priorityReason ?? null,
    dependsOn,
    dueAt: at(input.dueAt, 'dueAt'),
    notBefore: at(input.notBefore, 'notBefore'),
    triggerKey: input.triggerKey ?? null,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    claimant: input.claimant ?? null,
    maxAttempts: input.maxAttempts ?? 3,
  }
  const inserted = await tx
    .insert(opsTasks)
    .values({
      ...values,
      ownerId: actor.userId,
      projectId,
      createdBy: actor.userId,
    })
    .onConflictDoNothing()
    .returning()
  const task = inserted[0]
  if (!task) {
    // A concurrent insert won the trigger key between our read and write.
    const winner = await findByTrigger(tx, actor.userId, input.triggerKey ?? '')
    if (!winner) throw conflict('The task could not be created. Try again.')
    return { task: winner, deduplicated: true }
  }
  await audit(tx, actor, {
    projectId,
    action: 'task.create',
    targetType: 'task',
    targetId: task.id,
    afterRevision: task.revision,
    changes: auditSnapshot({ ...values, payload: Object.keys(values.payload) }),
  })
  await emitEvent(tx, {
    ownerId: actor.userId,
    projectId,
    type: 'task.ready',
    subjectType: 'task',
    subjectId: task.id,
    dedupeKey: `task.ready:${task.id}:${task.fencingToken}`,
    payload: { kind: task.kind, module: task.module, priority: task.priority },
    availableAt: task.notBefore,
  })
  return { task, deduplicated: false }
}

/**
 * Queues work in a project, or in the owner's no-project queue when
 * `projectId` is null. An agent needs `<module>:write` (`agents:operate` for
 * kernel work) and a policy that allows `draft` there.
 */
export async function createTask(
  actor: Actor,
  projectId: string | null,
  raw: unknown,
): Promise<TaskCreated> {
  const input = parseInput(createSchema, raw)
  return withTransaction(async (tx) => {
    const project = projectId ? await ownProject(tx, actor, projectId) : null
    await authorizeTaskWrite(tx, actor, project, input.module ?? null)
    return insertTask(tx, actor, project, input)
  })
}

/**
 * For services that open follow-up work inside their own transaction (the
 * scheduler, inbound events, a module's own flow). The caller has already
 * authorized the work it is doing; this only validates and records.
 */
export async function openTask(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  raw: unknown,
): Promise<TaskCreated> {
  return insertTask(tx, actor, project, parseInput(createSchema, raw))
}

/** A task of this owner, locked, with the gate for changing it. */
async function ownedTask(
  tx: Tx,
  actor: Actor,
  taskId: string,
): Promise<{ task: OpsTaskRow; project: ProjectRow | null }> {
  const { row: task, project } = await ownedRow<OpsTaskRow>(
    tx,
    actor,
    opsTasks,
    taskId,
    'Task',
    { lock: true },
  )
  await authorizeTaskWrite(tx, actor, project, task.module)
  return { task, project }
}

const prioritySchema = z.object({
  expectedRevision: revision,
  priority: z.coerce.number().int().min(0).max(100),
  priorityReason: text.required('Why the priority changes', 500),
})

export async function reprioritizeTask(
  actor: Actor,
  taskId: string,
  raw: unknown,
): Promise<OpsTaskRow> {
  const input = parseInput(prioritySchema, raw)
  return withTransaction(async (tx) => {
    const { task } = await ownedTask(tx, actor, taskId)
    if (task.revision !== input.expectedRevision) throw conflict()
    const [updated] = await tx
      .update(opsTasks)
      .set({
        priority: input.priority,
        priorityReason: input.priorityReason,
        revision: task.revision + 1,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(opsTasks.id, task.id), eq(opsTasks.revision, task.revision)),
      )
      .returning()
    if (!updated) throw conflict()
    await audit(tx, actor, {
      projectId: task.projectId,
      action: 'task.reprioritize',
      targetType: 'task',
      targetId: task.id,
      beforeRevision: task.revision,
      afterRevision: updated.revision,
      reason: input.priorityReason,
      changes: { priority: { from: task.priority, to: input.priority } },
    })
    return updated
  })
}

const cancelSchema = z.object({
  expectedRevision: revision,
  reason: text.required('Reason', 1000),
})

const FINAL_TASK_STATUSES = ['done', 'failed', 'cancelled']

export async function cancelTask(
  actor: Actor,
  taskId: string,
  raw: unknown,
): Promise<OpsTaskRow> {
  const input = parseInput(cancelSchema, raw)
  return withTransaction(async (tx) => {
    const { task } = await ownedTask(tx, actor, taskId)
    if (task.revision !== input.expectedRevision) throw conflict()
    if (FINAL_TASK_STATUSES.includes(task.status))
      throw invalid(`This task is already ${task.status}.`)
    const [updated] = await tx
      .update(opsTasks)
      .set({
        status: 'cancelled',
        leaseActorType: null,
        leaseActorId: null,
        leaseExpiresAt: null,
        // A cancelled task's old token must never act again.
        fencingToken: task.fencingToken + 1,
        completedAt: sql`now()`,
        lastError: input.reason,
        revision: task.revision + 1,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(opsTasks.id, task.id), eq(opsTasks.revision, task.revision)),
      )
      .returning()
    if (!updated) throw conflict()
    await tx
      .update(opsAgentRuns)
      .set({ status: 'cancelled', endedAt: sql`now()`, error: input.reason })
      .where(
        and(
          eq(opsAgentRuns.ownerId, task.ownerId),
          eq(opsAgentRuns.taskId, task.id),
          eq(opsAgentRuns.status, 'running'),
        ),
      )
    await audit(tx, actor, {
      projectId: task.projectId,
      action: 'task.cancel',
      targetType: 'task',
      targetId: task.id,
      beforeRevision: task.revision,
      afterRevision: updated.revision,
      reason: input.reason,
    })
    return updated
  })
}

/* ── Claim, heartbeat, checkpoint, finish ───────────────────────────── */

const claimSchema = z.object({
  taskId: optionalRecordId('Task'),
  kinds: choiceList(OPS_TASK_KINDS, 'Unknown task kind.').optional(),
  /** Only tasks of these modules; absent means every module and kernel work. */
  modules: choiceList(MODULE_IDS, 'Unknown module.').optional(),
  /**
   * Claim as HQ's builtin runner (apps/agent-runner). Not on the MCP tool: an
   * agent claims as an agent, the worker as the worker.
   */
  claimant: optionalChoice(OPS_TASK_CLAIMANTS, 'Unknown claimant.'),
  leaseSeconds: int('Lease', MIN_LEASE_S, MAX_LEASE_S),
})

/**
 * Which tasks a claim may take by claimant: those for anyone, and those for
 * who is asking — the worker's own jobs, an agent's, or (asked for
 * explicitly) the builtin runner's routines.
 */
function claimantIs(
  actor: Actor,
  asked: OpsTaskClaimant | null | undefined,
): SQL {
  const who: OpsTaskClaimant =
    asked ?? (actor.type === 'worker' ? 'worker' : 'agent')
  return or(isNull(opsTasks.claimant), eq(opsTasks.claimant, who)) as SQL
}

export type Claim = {
  task: OpsTaskRow
  run: OpsAgentRunRow
  /** Where the previous run on this task stopped — resume from here. */
  resumeFrom: OpsRunCheckpointRow | null
  previousRuns: Pick<
    OpsAgentRunRow,
    'id' | 'status' | 'summary' | 'error' | 'nextAction' | 'endedAt'
  >[]
}

function moduleIn(modules: (ModuleId | null)[]): SQL {
  const named = modules.filter((entry): entry is ModuleId => entry !== null)
  const parts: SQL[] = []
  if (named.length > 0) parts.push(inArray(opsTasks.module, named))
  if (modules.includes(null)) parts.push(isNull(opsTasks.module))
  return (parts.length === 1 ? parts[0] : or(...parts)) as SQL
}

/**
 * Which tasks this actor may claim, as a SQL filter: for a person, what their
 * role allows; for an agent, what its connection's scopes (per module) and
 * the policy of this project — or of no-project work — both allow. A policy
 * that isn't in force, or an engaged kill switch, is a refusal with its
 * reason — not an empty queue. Null means a person may claim nothing asked.
 */
async function claimableFilter(
  reader: Reader,
  actor: Actor,
  projectId: string | null,
  wantedKinds: OpsTaskKind[] | undefined,
  wantedModules: ModuleId[] | undefined,
): Promise<SQL | null> {
  const kinds = wantedKinds?.length ? wantedKinds : [...OPS_TASK_KINDS]
  const areas: (ModuleId | null)[] = wantedModules?.length
    ? wantedModules
    : [...MODULE_IDS, null]
  let allowedActions: readonly OpsAgentAction[] | null = null
  if (actor.type !== 'user') {
    const [policy, now] = await Promise.all([
      currentPolicy(reader, actor.userId, projectId),
      dbNow(reader),
    ])
    const state = policyState(policy, actor, now)
    if (!state.ok) throw policyBlocked(state.reason, { projectId })
    const stop = (
      await engagedKillSwitches(reader, actor.userId, projectId)
    ).find(
      (entry) =>
        entry.scope === 'all' ||
        (entry.scope === 'project' && entry.projectId === projectId) ||
        (entry.scope === 'connection' && entry.target === actor.grantId),
    )
    if (stop)
      throw policyBlocked(
        `A kill switch is engaged (${stop.scope}): ${stop.reason}`,
        { projectId, killSwitchId: stop.id },
      )
    allowedActions = state.policy.allowedActions
  }
  const clauses: SQL[] = []
  for (const kind of kinds) {
    const action = TASK_ACTION[kind]
    if (allowedActions && !allowedActions.includes(action)) continue
    const capability = ACTION_CAPABILITY[action]
    const modules = areas.filter((module) => {
      const scope = workScope(actor, module, capability)
      return can(actor, scope.area, scope.capability)
    })
    if (modules.length === 0) continue
    clauses.push(and(eq(opsTasks.kind, kind), moduleIn(modules)) as SQL)
  }
  if (clauses.length > 0) return or(...clauses) as SQL
  if (actor.type === 'user') return null
  throw policyBlocked(
    'Neither this connection’s permissions nor the operating policy let it take any of those kinds of task.',
    {
      projectId,
      requestedKinds: wantedKinds ?? null,
      requestedModules: wantedModules ?? null,
    },
  )
}

/**
 * Claims the most urgent eligible task (or the one named) in a project — or
 * in the owner's no-project queue when `projectId` is null: open or with a
 * lapsed lease, due, with every dependency done, not out of attempts, and of
 * a kind and module this actor may work. Returns null when there is none.
 */
export async function claimTask(
  actor: Actor,
  projectId: string | null,
  raw: unknown = {},
): Promise<Claim | null> {
  assertAgentWork(actor)
  const input = parseInput(claimSchema, raw)
  const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_S
  return withTransaction(async (tx) => {
    const project = projectId ? await ownProject(tx, actor, projectId) : null
    const scope = project?.id ?? null
    const filter = await claimableFilter(
      tx,
      actor,
      scope,
      input.kinds,
      input.modules,
    )
    if (!filter) return null
    const [candidate] = await tx
      .select({
        id: opsTasks.id,
        status: opsTasks.status,
        fencingToken: opsTasks.fencingToken,
      })
      .from(opsTasks)
      .where(
        and(
          eq(opsTasks.ownerId, actor.userId),
          sameProject(opsTasks.projectId, scope),
          filter,
          claimantIs(actor, input.claimant),
          or(
            eq(opsTasks.status, 'open'),
            and(
              eq(opsTasks.status, 'claimed'),
              sql`${opsTasks.leaseExpiresAt} < now()`,
            ),
          ),
          sql`(${opsTasks.notBefore} is null or ${opsTasks.notBefore} <= now())`,
          sql`${opsTasks.attempts} < ${opsTasks.maxAttempts}`,
          sql`not exists (
            select 1 from ${opsTasks} as dep
            where dep.owner_id = ${opsTasks.ownerId}
              and dep.id::text in (select jsonb_array_elements_text(${opsTasks.dependsOn}))
              and dep.status <> 'done'
          )`,
          input.taskId ? eq(opsTasks.id, input.taskId) : undefined,
        ),
      )
      .orderBy(
        desc(opsTasks.priority),
        sql`${opsTasks.dueAt} asc nulls last`,
        asc(opsTasks.createdAt),
      )
      .limit(1)
      .for('update', { skipLocked: true })
    if (!candidate) return null

    const lapsed = candidate.status === 'claimed'
    const fencingToken = candidate.fencingToken + 1
    const task = returned(
      (
        await tx
          .update(opsTasks)
          .set({
            status: 'claimed',
            leaseActorType: actor.type,
            leaseActorId: actor.id,
            leaseExpiresAt: nowPlus(leaseSeconds),
            fencingToken,
            attempts: sql`${opsTasks.attempts} + 1`,
            revision: sql`${opsTasks.revision} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(opsTasks.id, candidate.id),
              eq(opsTasks.fencingToken, candidate.fencingToken),
            ),
          )
          .returning()
      )[0],
    )
    const leaseExpiresAt = task.leaseExpiresAt as Date
    if (lapsed)
      await tx
        .update(opsAgentRuns)
        .set({
          status: 'abandoned',
          endedAt: sql`now()`,
          error: 'The lease lapsed and the task was claimed again.',
        })
        .where(
          and(
            eq(opsAgentRuns.ownerId, task.ownerId),
            eq(opsAgentRuns.taskId, task.id),
            eq(opsAgentRuns.status, 'running'),
          ),
        )

    const run = returned(
      (
        await tx
          .insert(opsAgentRuns)
          .values({
            ownerId: task.ownerId,
            projectId: task.projectId,
            taskId: task.id,
            actorType: actor.type,
            actorId: actor.id,
            fencingToken,
            leaseExpiresAt,
            createdBy: actor.userId,
          })
          .returning()
      )[0],
    )
    const [resumeFrom] = await tx
      .select({ checkpoint: opsRunCheckpoints })
      .from(opsRunCheckpoints)
      .innerJoin(opsAgentRuns, eq(opsAgentRuns.id, opsRunCheckpoints.runId))
      .where(
        and(
          eq(opsAgentRuns.ownerId, task.ownerId),
          eq(opsAgentRuns.taskId, task.id),
        ),
      )
      .orderBy(desc(opsRunCheckpoints.createdAt), desc(opsRunCheckpoints.seq))
      .limit(1)
    const previousRuns = await tx
      .select({
        id: opsAgentRuns.id,
        status: opsAgentRuns.status,
        summary: opsAgentRuns.summary,
        error: opsAgentRuns.error,
        nextAction: opsAgentRuns.nextAction,
        endedAt: opsAgentRuns.endedAt,
      })
      .from(opsAgentRuns)
      .where(
        and(
          eq(opsAgentRuns.ownerId, task.ownerId),
          eq(opsAgentRuns.taskId, task.id),
          sql`${opsAgentRuns.id} <> ${run.id}`,
        ),
      )
      .orderBy(desc(opsAgentRuns.startedAt))
      .limit(10)
    await audit(tx, actor, {
      projectId: task.projectId,
      action: lapsed ? 'task.reclaim' : 'task.claim',
      targetType: 'task',
      targetId: task.id,
      afterRevision: task.revision,
      changes: {
        runId: run.id,
        fencingToken,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        attempt: task.attempts,
      },
    })
    return {
      task,
      run,
      resumeFrom: resumeFrom?.checkpoint ?? null,
      previousRuns,
    }
  })
}

/**
 * Claims the next task this actor may work, in any of the owner's projects
 * or in no project — for a worker that serves them all (apps/worker). Each
 * project with open work of the wanted kinds is tried in turn, most urgent
 * work first; a project whose policy doesn't cover this actor (or whose kill
 * switch is engaged) is skipped, not an error. `skipped` says which and why,
 * so an empty queue and a blocked one read differently.
 */
export async function claimNextTask(
  actor: Actor,
  raw: unknown = {},
): Promise<{
  claim: Claim | null
  skipped: { projectId: string | null; reason: string }[]
}> {
  assertAgentWork(actor)
  const input = parseInput(claimSchema, raw)
  const scopes = await withTransaction(async (tx) =>
    tx
      .selectDistinctOn([opsTasks.projectId], {
        projectId: opsTasks.projectId,
        priority: sql<number>`max(${opsTasks.priority}) over (partition by ${opsTasks.projectId})`,
      })
      .from(opsTasks)
      .where(
        and(
          eq(opsTasks.ownerId, actor.userId),
          or(
            eq(opsTasks.status, 'open'),
            and(
              eq(opsTasks.status, 'claimed'),
              sql`${opsTasks.leaseExpiresAt} < now()`,
            ),
          ),
          input.kinds?.length ? inArray(opsTasks.kind, input.kinds) : undefined,
          input.modules?.length
            ? inArray(opsTasks.module, input.modules)
            : undefined,
          claimantIs(actor, input.claimant),
          sql`(${opsTasks.notBefore} is null or ${opsTasks.notBefore} <= now())`,
        ),
      ),
  )
  const skipped: { projectId: string | null; reason: string }[] = []
  for (const scope of scopes.sort((a, b) => b.priority - a.priority)) {
    try {
      const claim = await claimTask(actor, scope.projectId, {
        kinds: input.kinds,
        modules: input.modules,
        claimant: input.claimant,
        leaseSeconds: input.leaseSeconds,
      })
      if (claim) return { claim, skipped }
    } catch (error) {
      if (error instanceof OpsError && error.code === 'policy_blocked') {
        skipped.push({ projectId: scope.projectId, reason: error.message })
        continue
      }
      throw error
    }
  }
  return { claim: null, skipped }
}

type HeldRun = {
  run: OpsAgentRunRow
  task: OpsTaskRow
  project: ProjectRow | null
}

/**
 * The run, if this actor started it and still holds the task with this exact
 * token, with the lease alive by the database's clock. Anything else is
 * `lease_lost` — a stale worker learns it is stale before it can change
 * anything.
 */
async function heldRun(
  tx: Tx,
  actor: Actor,
  runId: string,
  fencingToken: number,
): Promise<HeldRun> {
  // The lease is the permission: no policy check here, so a holder can still
  // checkpoint, finish or release its work after a switch stops new work.
  assertAgentWork(actor)
  if (!isUuid(runId)) throw notFound('Run')
  const [row] = await tx
    .select({
      run: opsAgentRuns,
      task: opsTasks,
      project: projects,
      live: sql<boolean>`coalesce(${opsTasks.leaseExpiresAt} > now(), false)`,
    })
    .from(opsAgentRuns)
    .innerJoin(
      opsTasks,
      and(
        eq(opsTasks.id, opsAgentRuns.taskId),
        eq(opsTasks.ownerId, opsAgentRuns.ownerId),
      ),
    )
    .leftJoin(projects, eq(projects.id, opsAgentRuns.projectId))
    .where(
      and(eq(opsAgentRuns.id, runId), eq(opsAgentRuns.ownerId, actor.userId)),
    )
    .limit(1)
    .for('update', { of: opsTasks })
  if (!row) throw notFound('Run')
  if (
    row.run.actorId !== actor.id ||
    row.run.status !== 'running' ||
    row.task.status !== 'claimed' ||
    row.task.leaseActorId !== actor.id ||
    row.task.fencingToken !== fencingToken ||
    row.run.fencingToken !== fencingToken ||
    !row.live
  )
    throw leaseLost()
  return { run: row.run, task: row.task, project: row.project }
}

/**
 * For services that cause a side effect on behalf of a task: throws
 * `lease_lost` unless the actor holds the task with this token right now.
 * Takes the task's row lock, so the side effect and a competing claim can't
 * interleave.
 */
export async function assertTaskFencing(
  tx: Tx,
  actor: Actor,
  task: { taskId: string; fencingToken: number },
): Promise<OpsTaskRow> {
  if (!isUuid(task.taskId)) throw notFound('Task')
  const [row] = await tx
    .select({
      task: opsTasks,
      live: sql<boolean>`coalesce(${opsTasks.leaseExpiresAt} > now(), false)`,
    })
    .from(opsTasks)
    .where(
      and(eq(opsTasks.id, task.taskId), eq(opsTasks.ownerId, actor.userId)),
    )
    .limit(1)
    .for('update')
  if (
    row?.task.status !== 'claimed' ||
    row.task.leaseActorId !== actor.id ||
    row.task.fencingToken !== task.fencingToken ||
    !row.live
  )
    throw leaseLost()
  return row.task
}

const heartbeatSchema = z.object({
  fencingToken: z.coerce.number().int().min(1),
  leaseSeconds: int('Lease', MIN_LEASE_S, MAX_LEASE_S),
})

/**
 * Extends the lease. Not audited: a heartbeat changes no state anyone
 * decides on, and an audit row per minute would bury the ones that do.
 */
export async function heartbeatRun(
  actor: Actor,
  runId: string,
  raw: unknown,
): Promise<{ run: OpsAgentRunRow; task: OpsTaskRow }> {
  const input = parseInput(heartbeatSchema, raw)
  return withTransaction(async (tx) => {
    const held = await heldRun(tx, actor, runId, input.fencingToken)
    const lease = nowPlus(input.leaseSeconds ?? DEFAULT_LEASE_S)
    const task = returned(
      (
        await tx
          .update(opsTasks)
          .set({ leaseExpiresAt: lease, updatedAt: sql`now()` })
          .where(eq(opsTasks.id, held.task.id))
          .returning()
      )[0],
    )
    const run = returned(
      (
        await tx
          .update(opsAgentRuns)
          .set({
            leaseExpiresAt: task.leaseExpiresAt as Date,
            heartbeatAt: sql`now()`,
          })
          .where(eq(opsAgentRuns.id, held.run.id))
          .returning()
      )[0],
    )
    return { run, task }
  })
}

const checkpointSchema = z.object({
  fencingToken: z.coerce.number().int().min(1),
  summary: text.required('Summary', 2000),
  state: z
    .record(z.string().max(80), z.unknown())
    .refine(
      (value) => JSON.stringify(value).length <= 32_000,
      'Checkpoint state must be under 32 KB — store records in HQ and reference their IDs.',
    )
    .optional(),
  nextAction: text.optional('Next action', 1000),
  leaseSeconds: int('Lease', MIN_LEASE_S, MAX_LEASE_S),
})

/** Appends the state a run leaves for whoever comes next, and extends the lease. */
export async function checkpointRun(
  actor: Actor,
  runId: string,
  raw: unknown,
): Promise<{ run: OpsAgentRunRow; checkpoint: OpsRunCheckpointRow }> {
  const input = parseInput(checkpointSchema, raw)
  return withTransaction(async (tx) => {
    const held = await heldRun(tx, actor, runId, input.fencingToken)
    const seq = held.run.checkpointSeq + 1
    const checkpoint = returned(
      (
        await tx
          .insert(opsRunCheckpoints)
          .values({
            ownerId: held.run.ownerId,
            projectId: held.run.projectId,
            runId: held.run.id,
            seq,
            summary: input.summary,
            state: input.state ?? {},
            nextAction: input.nextAction ?? null,
          })
          .returning()
      )[0],
    )
    const task = returned(
      (
        await tx
          .update(opsTasks)
          .set({
            leaseExpiresAt: nowPlus(input.leaseSeconds ?? DEFAULT_LEASE_S),
            nextAction: input.nextAction ?? held.task.nextAction,
            updatedAt: sql`now()`,
          })
          .where(eq(opsTasks.id, held.task.id))
          .returning()
      )[0],
    )
    const run = returned(
      (
        await tx
          .update(opsAgentRuns)
          .set({
            checkpointSeq: seq,
            lastCheckpoint: {
              seq,
              summary: input.summary,
              state: input.state ?? {},
            },
            nextAction: input.nextAction ?? held.run.nextAction,
            heartbeatAt: sql`now()`,
            leaseExpiresAt: task.leaseExpiresAt as Date,
          })
          .where(eq(opsAgentRuns.id, held.run.id))
          .returning()
      )[0],
    )
    await audit(tx, actor, {
      projectId: held.task.projectId,
      action: 'run.checkpoint',
      targetType: 'task',
      targetId: held.task.id,
      changes: { runId: held.run.id, seq },
    })
    return { run, checkpoint }
  })
}

const outputRef = z.object({
  type: machineKey('Output type', 60),
  id: z.uuid(),
})

const finishSchema = z.object({
  fencingToken: z.coerce.number().int().min(1),
  outcome: choice(
    ['done', 'failed', 'blocked', 'released'],
    'Say how the run ended: done, failed, blocked or released.',
  ),
  summary: text.required('Summary', 4000),
  result: z.record(z.string().max(80), z.unknown()).optional(),
  outputRefs: z.array(outputRef).max(100).optional(),
  error: text.optional('Error', 2000),
  nextAction: text.optional('Next action', 1000),
  blockedReason: text.optional('Blocked reason', 1000),
  waitingOnRequestId: optionalRecordId('Human request'),
  /** Delay before a failed task becomes claimable again. */
  retryAfterSeconds: int('Retry after', 0, 7 * 24 * 3600),
})

/**
 * Ends a run. `done` closes the task; `failed` reopens it for another attempt
 * (or fails it when attempts are spent); `blocked` parks it — waiting on a
 * human request if one is named; `released` hands it back untouched.
 */
export async function finishRun(
  actor: Actor,
  runId: string,
  raw: unknown,
): Promise<{ run: OpsAgentRunRow; task: OpsTaskRow }> {
  const input = parseInput(finishSchema, raw)
  return withTransaction(async (tx) => {
    const held = await heldRun(tx, actor, runId, input.fencingToken)
    const { task } = held
    if (input.outcome === 'failed' && !input.error)
      throw invalid('Say what went wrong.', { error: 'Required when failing.' })
    if (input.outcome === 'blocked' && !input.blockedReason)
      throw invalid('Say what the task is waiting for.', {
        blockedReason: 'Required when blocked.',
      })
    if (input.waitingOnRequestId) {
      const [request] = await tx
        .select({ id: opsHumanRequests.id })
        .from(opsHumanRequests)
        .where(
          and(
            eq(opsHumanRequests.id, input.waitingOnRequestId),
            eq(opsHumanRequests.ownerId, task.ownerId),
            sameProject(opsHumanRequests.projectId, task.projectId),
          ),
        )
        .limit(1)
      if (!request)
        throw invalid('That human request is not about this task’s project.', {
          waitingOnRequestId: 'Unknown request.',
        })
    }
    const spent = task.attempts >= task.maxAttempts
    const taskStatus =
      input.outcome === 'done'
        ? 'done'
        : input.outcome === 'blocked'
          ? 'blocked'
          : input.outcome === 'failed' && spent
            ? 'failed'
            : 'open'
    const runStatus =
      input.outcome === 'done'
        ? 'succeeded'
        : input.outcome === 'released'
          ? 'cancelled'
          : input.outcome === 'blocked'
            ? 'succeeded'
            : 'failed'
    const final = taskStatus === 'done' || taskStatus === 'failed'
    const run = returned(
      (
        await tx
          .update(opsAgentRuns)
          .set({
            status: runStatus,
            summary: input.summary,
            error: input.error ?? null,
            nextAction: input.nextAction ?? null,
            outputRefs: input.outputRefs ?? [],
            endedAt: sql`now()`,
            heartbeatAt: sql`now()`,
          })
          .where(eq(opsAgentRuns.id, held.run.id))
          .returning()
      )[0],
    )
    const updated = returned(
      (
        await tx
          .update(opsTasks)
          .set({
            status: taskStatus,
            leaseActorType: null,
            leaseActorId: null,
            leaseExpiresAt: null,
            result: input.result ?? task.result,
            lastError:
              input.error ?? (input.outcome === 'done' ? null : task.lastError),
            nextAction: input.nextAction ?? null,
            blockedReason:
              taskStatus === 'blocked' ? (input.blockedReason ?? null) : null,
            waitingOnRequestId:
              taskStatus === 'blocked'
                ? (input.waitingOnRequestId ?? null)
                : null,
            notBefore:
              taskStatus === 'open' && input.retryAfterSeconds
                ? nowPlus(input.retryAfterSeconds)
                : task.notBefore,
            completedAt: final ? sql`now()` : null,
            revision: task.revision + 1,
            updatedAt: sql`now()`,
          })
          .where(eq(opsTasks.id, task.id))
          .returning()
      )[0],
    )
    await audit(tx, actor, {
      projectId: task.projectId,
      action: `task.${input.outcome}`,
      targetType: 'task',
      targetId: task.id,
      beforeRevision: task.revision,
      afterRevision: updated.revision,
      reason: input.error ?? input.blockedReason ?? null,
      changes: {
        runId: run.id,
        status: { from: task.status, to: taskStatus },
        outputs: (input.outputRefs ?? []).length,
      },
    })
    if (taskStatus === 'open')
      await emitEvent(tx, {
        ownerId: task.ownerId,
        projectId: task.projectId,
        type: 'task.ready',
        subjectType: 'task',
        subjectId: task.id,
        dedupeKey: `task.ready:${task.id}:${updated.fencingToken}:${updated.attempts}`,
        payload: {
          kind: task.kind,
          module: task.module,
          priority: task.priority,
          retry: true,
        },
        availableAt: updated.notBefore,
      })
    return { run, task: updated }
  })
}

/* ── Recovery (the ops tick) ────────────────────────────────────────── */

export type LeaseRecovery = {
  reopened: string[]
  failed: string[]
  abandonedRuns: string[]
}

/**
 * Lapsed leases: the run is abandoned (its checkpoints stay) and the task goes
 * back to the queue — or fails when its attempts are spent. Nothing is
 * retried here; a new claim resumes from the checkpoint. The tick passes no
 * owner and recovers everyone's, a batch at a time; `ownerId` narrows it.
 */
export async function recoverLapsedLeases(
  options: { ownerId?: string; limit?: number } = {},
): Promise<LeaseRecovery> {
  return withTransaction(async (tx) => {
    const lapsed = await tx
      .select()
      .from(opsTasks)
      .where(
        and(
          options.ownerId ? eq(opsTasks.ownerId, options.ownerId) : undefined,
          eq(opsTasks.status, 'claimed'),
          sql`${opsTasks.leaseExpiresAt} < now()`,
        ),
      )
      .orderBy(asc(opsTasks.leaseExpiresAt))
      .limit(options.limit ?? 100)
      .for('update', { skipLocked: true })
    const result: LeaseRecovery = {
      reopened: [],
      failed: [],
      abandonedRuns: [],
    }
    for (const task of lapsed) {
      const spent = task.attempts >= task.maxAttempts
      const [updated] = await tx
        .update(opsTasks)
        .set({
          status: spent ? 'failed' : 'open',
          leaseActorType: null,
          leaseActorId: null,
          leaseExpiresAt: null,
          fencingToken: task.fencingToken + 1,
          lastError: 'The lease lapsed without the run finishing.',
          completedAt: spent ? sql`now()` : null,
          revision: task.revision + 1,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(opsTasks.id, task.id),
            eq(opsTasks.fencingToken, task.fencingToken),
          ),
        )
        .returning()
      if (!updated) continue
      const runs = await tx
        .update(opsAgentRuns)
        .set({
          status: 'abandoned',
          endedAt: sql`now()`,
          error: 'The lease lapsed without the run finishing.',
        })
        .where(
          and(
            eq(opsAgentRuns.ownerId, task.ownerId),
            eq(opsAgentRuns.taskId, task.id),
            eq(opsAgentRuns.status, 'running'),
          ),
        )
        .returning({ id: opsAgentRuns.id })
      result.abandonedRuns.push(...runs.map((run) => run.id))
      ;(spent ? result.failed : result.reopened).push(task.id)
      await audit(tx, schedulerActor(task.ownerId), {
        projectId: task.projectId,
        action: spent ? 'task.lease_lapsed_failed' : 'task.lease_lapsed',
        targetType: 'task',
        targetId: task.id,
        beforeRevision: task.revision,
        afterRevision: updated.revision,
        changes: { abandonedRuns: runs.length },
      })
      if (!spent)
        await emitEvent(tx, {
          ownerId: task.ownerId,
          projectId: task.projectId,
          type: 'task.ready',
          subjectType: 'task',
          subjectId: task.id,
          dedupeKey: `task.ready:${task.id}:${updated.fencingToken}`,
          payload: {
            kind: task.kind,
            module: task.module,
            priority: task.priority,
            recovered: true,
          },
        })
    }
    return result
  })
}

/* ── Reading ────────────────────────────────────────────────────────── */

export type TaskContext = {
  task: OpsTaskRow
  project: ProjectRow | null
  runs: OpsAgentRunRow[]
  checkpoints: OpsRunCheckpointRow[]
  dependencies: Pick<OpsTaskRow, 'id' | 'title' | 'status'>[]
}

/** A task with its runs and checkpoints — what a fresh session reads before resuming. */
export async function getTaskContext(
  actor: Actor,
  taskId: string,
): Promise<TaskContext> {
  assertKernelRead(actor)
  return withReader(async (db) => {
    const { row: task, project } = await ownedRow<OpsTaskRow>(
      db,
      actor,
      opsTasks,
      taskId,
      'Task',
    )
    const runs = await db
      .select()
      .from(opsAgentRuns)
      .where(
        and(
          eq(opsAgentRuns.ownerId, task.ownerId),
          eq(opsAgentRuns.taskId, task.id),
        ),
      )
      .orderBy(desc(opsAgentRuns.startedAt))
      .limit(20)
    const checkpoints = runs.length
      ? await db
          .select()
          .from(opsRunCheckpoints)
          .where(
            and(
              eq(opsRunCheckpoints.ownerId, task.ownerId),
              inArray(
                opsRunCheckpoints.runId,
                runs.map((run) => run.id),
              ),
            ),
          )
          .orderBy(
            desc(opsRunCheckpoints.createdAt),
            desc(opsRunCheckpoints.seq),
          )
          .limit(50)
      : []
    const dependencies = task.dependsOn.length
      ? await db
          .select({
            id: opsTasks.id,
            title: opsTasks.title,
            status: opsTasks.status,
          })
          .from(opsTasks)
          .where(
            and(
              eq(opsTasks.ownerId, task.ownerId),
              inArray(opsTasks.id, task.dependsOn),
            ),
          )
      : []
    return { task, project, runs, checkpoints, dependencies }
  })
}
