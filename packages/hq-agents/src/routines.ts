import {
  AGENT_AUTO_ACCEPTABLE,
  AGENT_RUNNERS,
  MODULE_IDS,
  type ModuleId,
} from '@theiceji/hq-db/enums'
import {
  type AgentRoutineRow,
  agentProposals,
  agentRoutines,
  type OpsTaskRow,
  opsAgentRuns,
  opsTasks,
  type ProjectRow,
  projects,
  providerConnections,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan, workScope } from '@theiceji/hq-ops/access'
import { schedulerActor } from '@theiceji/hq-ops/actors'
import { dbNow, type Reader, type Tx } from '@theiceji/hq-ops/db'
import {
  conflict,
  forbidden,
  invalid,
  notFound,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  choice,
  choiceList,
  int,
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
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { openTask } from '@theiceji/hq-ops/tasks'
import { DEFAULT_TIME_ZONE, isValidTimeZone } from '@theiceji/hq-ops/time'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  type SQL,
  sql,
} from 'drizzle-orm'
import { z } from 'zod'
import { CronError, describeCron, nextRun, parseCron } from './cron'

/**
 * Routines — the owner's schedule for an agent.
 *
 * · **The owner's alone**: creating, changing, pausing or archiving a routine
 *   is `manage` — no connection, no agent, can schedule itself.
 * · **The tick queues; it never runs.** When a routine falls due the ops tick
 *   opens one `ops_tasks` row (kind `routine`, target `agent_routine`) for
 *   whoever the routine names: an agent over MCP (`claimant: agent`) or HQ's
 *   builtin runner (`claimant: builtin`). A routine never has two runs
 *   waiting: while one is open, claimed or blocked, a due time only moves
 *   the next one along.
 * · **Due is the database's clock**, read in the routine's own timezone.
 * · **Delete goes to the Trash**: it stops like an archive
 *   (off, its queued run cancelled) and Restore brings it back switched off —
 *   the owner turns it on. Older routines were archived before the Trash;
 *   the Trash lists them too.
 */

registerConstraintMessages({
  agent_routines_name_key: 'A routine with that name already exists here.',
  agent_routines_auto_accept_check:
    'A routine may only accept notes and prompt variants on its own.',
  agent_routines_llm_fk: 'That LLM key isn’t one of your connections.',
  agent_routines_deleted_check: 'Only an archived routine can be in the Trash.',
})

/** The target type of a routine's ops task. */
export const ROUTINE_TARGET = 'agent_routine'

/** Unfinished task statuses: a routine with one of these waits, it doesn't pile up. */
const UNFINISHED = ['open', 'claimed', 'blocked'] as const

/* ── Reading ────────────────────────────────────────────────────────── */

export type RoutineProject = Pick<
  ProjectRow,
  'id' | 'slug' | 'name' | 'color' | 'kind' | 'timezone' | 'currency'
>

export type RunSummary = {
  id: string
  taskId: string
  status: string
  startedAt: Date
  endedAt: Date | null
  summary: string | null
  error: string | null
  actorType: string
  leaseExpiresAt: Date
  /** Known cost per currency, minor units. */
  cost: { currency: string; minor: number }[]
  /** Usage lines whose cost nobody knows — counted, never guessed. */
  unknownCosts: number
  tokens: number | null
  proposals: number
}

export type RoutineView = AgentRoutineRow & {
  project: RoutineProject | null
  schedule: string
  llm: { id: string; label: string; provider: string; hint: string } | null
  /** The routine's current task, if one waits or runs. */
  current: Pick<
    OpsTaskRow,
    'id' | 'status' | 'blockedReason' | 'leaseExpiresAt' | 'createdAt'
  > | null
  lastRun: RunSummary | null
  pendingProposals: number
}

const projectLite = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  color: projects.color,
  kind: projects.kind,
  timezone: projects.timezone,
  currency: projects.currency,
}

/** Runs of these tasks, newest first, with cost, tokens and proposals. */
export async function runSummaries(
  reader: Reader,
  ownerId: string,
  where: SQL,
  limit = 50,
): Promise<
  (RunSummary & { routineId: string | null; projectId: string | null })[]
> {
  const rows = await reader
    .select({
      run: opsAgentRuns,
      routineId: opsTasks.targetId,
      targetType: opsTasks.targetType,
    })
    .from(opsAgentRuns)
    .innerJoin(opsTasks, eq(opsTasks.id, opsAgentRuns.taskId))
    .where(and(eq(opsAgentRuns.ownerId, ownerId), where))
    .orderBy(desc(opsAgentRuns.startedAt))
    .limit(limit)
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.run.id)
  const usage = await reader.execute<{
    subject_id: string
    currency: string | null
    minor: string | null
    unknown: string
    tokens: string | null
  }>(sql`
    select subject_id::text, currency,
      sum(cost_minor)::text as minor,
      count(*) filter (where cost_status = 'unknown')::text as unknown,
      sum(tokens)::text as tokens
    from ops_usage_events
    where owner_id = ${ownerId} and subject_type = 'agent_run'
      and subject_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    group by subject_id, currency`)
  const proposals = await reader
    .select({
      runId: agentProposals.runId,
      count: sql<number>`count(*)::int`,
    })
    .from(agentProposals)
    .where(
      and(
        eq(agentProposals.ownerId, ownerId),
        inArray(agentProposals.runId, ids),
      ),
    )
    .groupBy(agentProposals.runId)
  return rows.map(({ run, routineId, targetType }) => {
    const lines = [...usage].filter((line) => line.subject_id === run.id)
    const tokens = lines.reduce<number | null>(
      (sum, line) =>
        line.tokens === null ? sum : (sum ?? 0) + Number(line.tokens),
      null,
    )
    return {
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      summary: run.summary,
      error: run.error,
      actorType: run.actorType,
      leaseExpiresAt: run.leaseExpiresAt,
      cost: lines
        .filter((line) => line.currency && line.minor !== null)
        .map((line) => ({
          currency: line.currency as string,
          minor: Number(line.minor),
        })),
      unknownCosts: lines.reduce((sum, line) => sum + Number(line.unknown), 0),
      tokens,
      proposals: proposals.find((entry) => entry.runId === run.id)?.count ?? 0,
      routineId: targetType === ROUTINE_TARGET ? routineId : null,
      projectId: run.projectId,
    }
  })
}

async function views(
  reader: Reader,
  ownerId: string,
  routines: AgentRoutineRow[],
): Promise<RoutineView[]> {
  if (routines.length === 0) return []
  const ids = routines.map((routine) => routine.id)
  const projectIds = [
    ...new Set(routines.map((routine) => routine.projectId).filter(Boolean)),
  ] as string[]
  const llmIds = [
    ...new Set(
      routines.map((routine) => routine.llmConnectionId).filter(Boolean),
    ),
  ] as string[]
  const [projectRows, llms, current, pending, runs] = await Promise.all([
    projectIds.length
      ? reader
          .select(projectLite)
          .from(projects)
          .where(inArray(projects.id, projectIds))
      : Promise.resolve([]),
    llmIds.length
      ? reader
          .select({
            id: providerConnections.id,
            label: providerConnections.label,
            provider: providerConnections.provider,
            hint: providerConnections.secretHint,
          })
          .from(providerConnections)
          .where(inArray(providerConnections.id, llmIds))
      : Promise.resolve([]),
    reader
      .select({
        routineId: opsTasks.targetId,
        id: opsTasks.id,
        status: opsTasks.status,
        blockedReason: opsTasks.blockedReason,
        leaseExpiresAt: opsTasks.leaseExpiresAt,
        createdAt: opsTasks.createdAt,
      })
      .from(opsTasks)
      .where(
        and(
          eq(opsTasks.ownerId, ownerId),
          eq(opsTasks.targetType, ROUTINE_TARGET),
          inArray(opsTasks.targetId, ids),
          inArray(opsTasks.status, [...UNFINISHED]),
        ),
      )
      .orderBy(desc(opsTasks.createdAt)),
    reader
      .select({
        routineId: agentProposals.routineId,
        count: sql<number>`count(*)::int`,
      })
      .from(agentProposals)
      .where(
        and(
          eq(agentProposals.ownerId, ownerId),
          inArray(agentProposals.routineId, ids),
          eq(agentProposals.status, 'proposed'),
        ),
      )
      .groupBy(agentProposals.routineId),
    // The newest run of each routine.
    runSummaries(
      reader,
      ownerId,
      and(
        eq(opsTasks.targetType, ROUTINE_TARGET),
        inArray(opsTasks.targetId, ids),
        sql`${opsAgentRuns.id} in (
          select distinct on (t.target_id) r.id
          from ops_agent_runs r join ops_tasks t on t.id = r.task_id
          where t.owner_id = ${ownerId} and t.target_type = ${ROUTINE_TARGET}
          order by t.target_id, r.started_at desc
        )`,
      ) as SQL,
      ids.length,
    ),
  ])
  return routines.map((routine) => {
    const llm = llms.find((entry) => entry.id === routine.llmConnectionId)
    const task = current.find((entry) => entry.routineId === routine.id)
    return {
      ...routine,
      project:
        projectRows.find((project) => project.id === routine.projectId) ?? null,
      schedule: describeCron(routine.cron),
      llm: llm
        ? {
            id: llm.id,
            label: llm.label,
            provider: llm.provider,
            hint: llm.hint ?? '',
          }
        : null,
      current: task
        ? {
            id: task.id,
            status: task.status,
            blockedReason: task.blockedReason,
            leaseExpiresAt: task.leaseExpiresAt,
            createdAt: task.createdAt,
          }
        : null,
      lastRun: runs.find((run) => run.routineId === routine.id) ?? null,
      pendingProposals:
        pending.find((entry) => entry.routineId === routine.id)?.count ?? 0,
    }
  })
}

/** Who may read routines: a person by role, a connection with `agents:operate`. */
function assertRead(actor: Actor): void {
  const scope = workScope(actor, 'agents', 'read')
  assertCan(actor, scope.area, scope.capability)
}

/**
 * The owner's routines — all, one project's, or only those in no project
 * (`projectId: null`). `trash` lists the deleted ones instead, newest first:
 * every archived routine, since the ones archived before the Trash existed
 * have nowhere else to be restored from. The Trash is the owner's, in HQ.
 */
export async function listRoutines(
  actor: Actor,
  options: {
    projectId?: string | null
    includeArchived?: boolean
    trash?: boolean
  } = {},
): Promise<RoutineView[]> {
  assertRead(actor)
  if (options.trash && actor.type !== 'user')
    throw forbidden('The Trash is the owner’s, in HQ.')
  return withReader(async (db) => {
    const rows = await db
      .select()
      .from(agentRoutines)
      .where(
        and(
          eq(agentRoutines.ownerId, actor.userId),
          options.projectId === undefined
            ? undefined
            : options.projectId === null
              ? isNull(agentRoutines.projectId)
              : eq(agentRoutines.projectId, options.projectId),
          options.trash
            ? isNotNull(agentRoutines.archivedAt)
            : options.includeArchived
              ? undefined
              : isNull(agentRoutines.archivedAt),
        ),
      )
      .orderBy(
        ...(options.trash
          ? [
              desc(
                sql`coalesce(${agentRoutines.deletedAt}, ${agentRoutines.archivedAt})`,
              ),
            ]
          : []),
        asc(agentRoutines.name),
      )
    return views(db, actor.userId, rows)
  })
}

export type RoutineSummary = {
  projectId: string
  /** Routines not archived. */
  routines: number
  /** Of those, switched on. */
  enabled: number
  /** Routine runs working right now. */
  running: number
  /** A running routine's name, when one runs. */
  runningName: string | null
  /** When the next routine falls due, if any is on. */
  nextDueAt: Date | null
  /** Routine runs in the last 7 days that failed or were abandoned. */
  failed7d: number
}

/**
 * One row per project with routines: Home's Agents cell,
 * the State matrix and the rail read it. A routine in no project is HQ-wide
 * and isn't in any project's cell.
 */
export async function routineSummaries(
  actor: Actor,
): Promise<RoutineSummary[]> {
  assertRead(actor)
  return withReader(async (db) => {
    const [routines, runs] = await Promise.all([
      db
        .select({
          projectId: agentRoutines.projectId,
          routines: sql<number>`count(*)::int`,
          enabled: sql<number>`count(*) filter (where ${agentRoutines.enabled})::int`,
          nextDueAt:
            sql<Date | null>`min(${agentRoutines.nextDueAt}) filter (where ${agentRoutines.enabled})`.mapWith(
              agentRoutines.nextDueAt,
            ),
        })
        .from(agentRoutines)
        .where(
          and(
            eq(agentRoutines.ownerId, actor.userId),
            isNull(agentRoutines.archivedAt),
            sql`${agentRoutines.projectId} is not null`,
          ),
        )
        .groupBy(agentRoutines.projectId),
      db
        .select({
          projectId: opsAgentRuns.projectId,
          running: sql<number>`count(*) filter (where ${opsAgentRuns.status} = 'running')::int`,
          runningName: sql<
            string | null
          >`min(${agentRoutines.name}) filter (where ${opsAgentRuns.status} = 'running')`,
          failed7d: sql<number>`count(*) filter (where ${opsAgentRuns.status} in ('failed', 'abandoned') and ${opsAgentRuns.startedAt} > now() - interval '7 days')::int`,
        })
        .from(opsAgentRuns)
        .innerJoin(opsTasks, eq(opsTasks.id, opsAgentRuns.taskId))
        .leftJoin(
          agentRoutines,
          and(
            eq(agentRoutines.id, opsTasks.targetId),
            eq(agentRoutines.ownerId, opsAgentRuns.ownerId),
          ),
        )
        .where(
          and(
            eq(opsAgentRuns.ownerId, actor.userId),
            eq(opsTasks.targetType, ROUTINE_TARGET),
            sql`${opsAgentRuns.projectId} is not null`,
            sql`(${opsAgentRuns.status} = 'running' or ${opsAgentRuns.startedAt} > now() - interval '7 days')`,
          ),
        )
        .groupBy(opsAgentRuns.projectId),
    ])
    const ids = new Set(
      [...routines, ...runs]
        .map((row) => row.projectId)
        .filter((id): id is string => Boolean(id)),
    )
    return [...ids].map((projectId) => {
      const routine = routines.find((row) => row.projectId === projectId)
      const run = runs.find((row) => row.projectId === projectId)
      return {
        projectId,
        routines: routine?.routines ?? 0,
        enabled: routine?.enabled ?? 0,
        running: run?.running ?? 0,
        runningName: run?.runningName ?? null,
        nextDueAt: routine?.nextDueAt ?? null,
        failed7d: run?.failed7d ?? 0,
      }
    })
  })
}

export type RoutineDetail = RoutineView & { runs: RunSummary[] }

export async function getRoutine(
  actor: Actor,
  routineId: string,
): Promise<RoutineDetail> {
  assertRead(actor)
  return withReader(async (db) => {
    const { row } = await ownedRow<AgentRoutineRow>(
      db,
      actor,
      agentRoutines,
      routineId,
      'Routine',
    )
    const [view] = await views(db, actor.userId, [row])
    const runs = await runSummaries(
      db,
      actor.userId,
      and(
        eq(opsTasks.targetType, ROUTINE_TARGET),
        eq(opsTasks.targetId, row.id),
      ) as SQL,
      60,
    )
    return { ...returned(view), runs }
  })
}

/**
 * What a claimed routine task hands its agent: the playbook, the modules it
 * may use, where it runs. Null when the task isn't a routine's.
 */
export async function routineForTask(
  reader: Reader,
  task: Pick<OpsTaskRow, 'ownerId' | 'targetType' | 'targetId'>,
): Promise<(AgentRoutineRow & { project: RoutineProject | null }) | null> {
  if (task.targetType !== ROUTINE_TARGET || !task.targetId) return null
  const [row] = await reader
    .select({ routine: agentRoutines, project: projectLite })
    .from(agentRoutines)
    .leftJoin(projects, eq(projects.id, agentRoutines.projectId))
    .where(
      and(
        eq(agentRoutines.id, task.targetId),
        eq(agentRoutines.ownerId, task.ownerId),
      ),
    )
    .limit(1)
  if (!row) return null
  return {
    ...row.routine,
    project: row.project?.id ? (row.project as RoutineProject) : null,
  }
}

/* ── Writing (the owner's) ──────────────────────────────────────────── */

const saveSchema = z.object({
  routineId: optionalRecordId('Routine'),
  expectedRevision: revision.optional(),
  projectId: optionalRecordId('Project'),
  name: text.required('Name', 120),
  cron: text.required('Schedule', 120),
  timezone: text.optional('Timezone', 64),
  playbook: z.string().max(50000, 'A playbook is at most 50,000 characters.'),
  modules: choiceList(MODULE_IDS, 'Unknown module.').optional(),
  runner: choice(AGENT_RUNNERS, 'Choose who runs it: mcp or builtin.'),
  llmConnectionId: optionalRecordId('LLM key'),
  maxTurns: int('Turns', 1, 200),
  autoAccept: choiceList(
    AGENT_AUTO_ACCEPTABLE,
    'A routine may only accept notes and prompt variants on its own.',
  ).optional(),
  enabled: z.boolean().optional(),
})

export type SaveRoutineInput = z.input<typeof saveSchema>

function schedule(cron: string, timeZone: string, now: Date): Date {
  try {
    const at = nextRun(parseCron(cron), timeZone, now)
    if (!at) throw invalid('That schedule never fires.', { cron: 'Never due.' })
    return at
  } catch (error) {
    if (error instanceof CronError)
      throw invalid(error.message, { cron: error.message })
    throw error
  }
}

async function checkLlm(
  tx: Tx,
  actor: Actor,
  connectionId: string,
): Promise<void> {
  const [row] = await tx
    .select({
      provider: providerConnections.provider,
      revokedAt: providerConnections.revokedAt,
    })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, connectionId),
        eq(providerConnections.ownerId, actor.userId),
      ),
    )
    .limit(1)
  if (!row || row.revokedAt) throw notFound('LLM key')
  // HQ's own runner speaks to Claude; other LLM keys wait for their runner.
  if (row.provider !== 'llm:anthropic')
    throw invalid(
      'HQ’s own runner uses an Anthropic key (Settings › Connections › LLM keys).',
      { llmConnectionId: 'Not an Anthropic key.' },
    )
}

/**
 * Create a routine, or change one. The owner's alone. The next due time is
 * worked out from the schedule; a disabled routine has none.
 */
export async function saveRoutine(
  actor: Actor,
  raw: SaveRoutineInput,
): Promise<AgentRoutineRow> {
  const input = parseInput(saveSchema, raw)
  const timeZone = input.timezone ?? DEFAULT_TIME_ZONE
  if (!isValidTimeZone(timeZone))
    throw invalid(`“${timeZone}” isn’t a timezone.`, {
      timezone: 'Use an IANA name like Asia/Bangkok.',
    })
  const modules = [...new Set(input.modules ?? [])] as ModuleId[]
  return withTransaction(async (tx) => {
    const project = input.projectId
      ? await ownProject(tx, actor, input.projectId)
      : null
    await authorize(tx, actor, project, 'agents', 'manage')
    if (project) {
      const off = modules.filter(
        (module) =>
          module !== 'notes' && !project.modules.enabled.includes(module),
      )
      if (off.length)
        throw invalid(
          `${off.join(', ')} ${off.length > 1 ? 'are' : 'is'} off for ${project.name}.`,
          {
            modules: 'Only modules this project has on.',
          },
        )
    }
    if (input.llmConnectionId) await checkLlm(tx, actor, input.llmConnectionId)
    const enabled = input.enabled ?? true
    if (input.runner === 'builtin' && enabled && !input.llmConnectionId)
      throw invalid(
        'HQ’s own runner needs an LLM key. Add one in Settings › Connections › LLM keys, or let an outside agent run it (mcp).',
        { llmConnectionId: 'Required for the builtin runner.' },
      )
    const now = await dbNow(tx)
    const nextDueAt = enabled
      ? schedule(input.cron as string, timeZone, now)
      : null
    const values = {
      projectId: project?.id ?? null,
      name: input.name as string,
      cron: parseCron(input.cron as string).source,
      timezone: timeZone,
      playbook: input.playbook,
      modules,
      runner: input.runner,
      llmConnectionId: input.llmConnectionId ?? null,
      maxTurns: input.maxTurns ?? 20,
      autoAccept: [...new Set(input.autoAccept ?? [])],
      enabled,
      nextDueAt,
    }
    if (!input.routineId) {
      const [row] = await tx
        .insert(agentRoutines)
        .values({ ...values, ownerId: actor.userId, createdBy: actor.userId })
        .returning()
      const routine = returned(row)
      await audit(tx, actor, {
        projectId: routine.projectId,
        action: 'agents.routine.create',
        targetType: ROUTINE_TARGET,
        targetId: routine.id,
        afterRevision: routine.revision,
        changes: {
          name: routine.name,
          cron: routine.cron,
          runner: routine.runner,
          autoAccept: routine.autoAccept,
        },
      })
      return routine
    }
    const { row: current } = await ownedRow<AgentRoutineRow>(
      tx,
      actor,
      agentRoutines,
      input.routineId,
      'Routine',
      { lock: true },
    )
    if (current.archivedAt) throw invalid('This routine is archived.')
    if (input.expectedRevision && current.revision !== input.expectedRevision)
      throw conflict()
    if ((current.projectId ?? null) !== (project?.id ?? null))
      throw invalid('A routine keeps its project; make a new one elsewhere.')
    const [row] = await tx
      .update(agentRoutines)
      .set({
        ...values,
        revision: sql`${agentRoutines.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(agentRoutines.id, current.id))
      .returning()
    const routine = returned(row)
    await audit(tx, actor, {
      projectId: routine.projectId,
      action: 'agents.routine.update',
      targetType: ROUTINE_TARGET,
      targetId: routine.id,
      beforeRevision: current.revision,
      afterRevision: routine.revision,
      changes: {
        name: routine.name,
        cron: routine.cron,
        runner: routine.runner,
        enabled: routine.enabled,
        autoAccept: routine.autoAccept,
        playbook: current.playbook === routine.playbook ? undefined : 'changed',
      },
    })
    return routine
  })
}

async function lockedRoutine(
  tx: Tx,
  actor: Actor,
  routineId: string,
): Promise<{ routine: AgentRoutineRow; project: ProjectRow | null }> {
  const { row, project } = await ownedRow<AgentRoutineRow>(
    tx,
    actor,
    agentRoutines,
    routineId,
    'Routine',
    { lock: true },
  )
  await authorize(tx, actor, project, 'agents', 'manage')
  return { routine: row, project }
}

/** Pause or resume. Resuming schedules the next due time from now. */
export async function setRoutineEnabled(
  actor: Actor,
  raw: { routineId: string; expectedRevision?: number; enabled: boolean },
): Promise<AgentRoutineRow> {
  const input = parseInput(
    z.object({
      routineId: recordId('Routine'),
      expectedRevision: revision.optional(),
      enabled: z.boolean(),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { routine } = await lockedRoutine(tx, actor, input.routineId)
    if (routine.archivedAt) throw invalid('This routine is archived.')
    if (input.expectedRevision && routine.revision !== input.expectedRevision)
      throw conflict()
    if (
      input.enabled &&
      routine.runner === 'builtin' &&
      !routine.llmConnectionId
    )
      throw invalid('HQ’s own runner needs an LLM key first.')
    const nextDueAt = input.enabled
      ? schedule(routine.cron, routine.timezone, await dbNow(tx))
      : null
    const [row] = await tx
      .update(agentRoutines)
      .set({
        enabled: input.enabled,
        nextDueAt,
        revision: sql`${agentRoutines.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(agentRoutines.id, routine.id))
      .returning()
    const saved = returned(row)
    await audit(tx, actor, {
      projectId: saved.projectId,
      action: input.enabled ? 'agents.routine.resume' : 'agents.routine.pause',
      targetType: ROUTINE_TARGET,
      targetId: saved.id,
      beforeRevision: routine.revision,
      afterRevision: saved.revision,
    })
    return saved
  })
}

/** A stopped routine's run that nobody claimed yet won't be. One already claimed finishes. */
async function cancelQueued(
  tx: Tx,
  actor: Actor,
  routine: AgentRoutineRow,
  why: string,
): Promise<void> {
  await tx
    .update(opsTasks)
    .set({
      status: 'cancelled',
      lastError: why,
      revision: sql`${opsTasks.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(opsTasks.ownerId, actor.userId),
        eq(opsTasks.targetType, ROUTINE_TARGET),
        eq(opsTasks.targetId, routine.id),
        eq(opsTasks.status, 'open'),
      ),
    )
}

/** Archive: it stops, its runs and proposals stay on record. */
export async function archiveRoutine(
  actor: Actor,
  raw: { routineId: string },
): Promise<void> {
  const input = parseInput(z.object({ routineId: recordId('Routine') }), raw)
  await withTransaction(async (tx) => {
    const { routine } = await lockedRoutine(tx, actor, input.routineId)
    if (routine.archivedAt) return
    await tx
      .update(agentRoutines)
      .set({
        enabled: false,
        nextDueAt: null,
        archivedAt: sql`now()`,
        revision: sql`${agentRoutines.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(agentRoutines.id, routine.id))
    await cancelQueued(tx, actor, routine, 'Its routine was archived.')
    await audit(tx, actor, {
      projectId: routine.projectId,
      action: 'agents.routine.archive',
      targetType: ROUTINE_TARGET,
      targetId: routine.id,
      beforeRevision: routine.revision,
    })
  })
}

/**
 * Delete: the routine goes to the Trash. It stops as an archive does —
 * switched off, its queued run cancelled — and its runs and proposals stay
 * on record. One archived before the Trash existed just moves into it.
 */
export async function deleteRoutine(
  actor: Actor,
  raw: { routineId: string },
): Promise<AgentRoutineRow> {
  const input = parseInput(z.object({ routineId: recordId('Routine') }), raw)
  return withTransaction(async (tx) => {
    const { routine } = await lockedRoutine(tx, actor, input.routineId)
    if (routine.deletedAt) return routine
    const [row] = await tx
      .update(agentRoutines)
      .set({
        enabled: false,
        nextDueAt: null,
        archivedAt: sql`coalesce(${agentRoutines.archivedAt}, now())`,
        deletedAt: sql`now()`,
        revision: sql`${agentRoutines.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(agentRoutines.id, routine.id))
      .returning()
    const saved = returned(row)
    await cancelQueued(tx, actor, routine, 'Its routine was deleted.')
    await audit(tx, actor, {
      projectId: routine.projectId,
      action: 'agents.routine.delete',
      targetType: ROUTINE_TARGET,
      targetId: routine.id,
      beforeRevision: routine.revision,
      afterRevision: saved.revision,
      changes: { name: routine.name, wasOn: routine.enabled },
    })
    return saved
  })
}

/**
 * Restore a routine from the Trash (or one archived before it). It comes
 * back switched off — the owner turns it on — with its playbook, runs and
 * proposals as they were. A name another routine here took meanwhile has to
 * change first.
 */
export async function restoreRoutine(
  actor: Actor,
  raw: { routineId: string },
): Promise<AgentRoutineRow> {
  const input = parseInput(z.object({ routineId: recordId('Routine') }), raw)
  return withTransaction(async (tx) => {
    const { routine } = await lockedRoutine(tx, actor, input.routineId)
    if (!routine.archivedAt) return routine
    // `agent_routines_name_key` holds among live routines; say which name
    // and what to do rather than the constraint's general words.
    const [clash] = await tx
      .select({ id: agentRoutines.id })
      .from(agentRoutines)
      .where(
        and(
          eq(agentRoutines.ownerId, routine.ownerId),
          routine.projectId
            ? eq(agentRoutines.projectId, routine.projectId)
            : isNull(agentRoutines.projectId),
          isNull(agentRoutines.archivedAt),
          sql`lower(${agentRoutines.name}) = lower(${routine.name})`,
        ),
      )
      .limit(1)
    if (clash)
      throw invalid(
        `Another routine here is called “${routine.name}” now. Rename or delete that one, then restore this.`,
        { name: 'A live routine has this name.' },
      )
    const [row] = await tx
      .update(agentRoutines)
      .set({
        enabled: false,
        nextDueAt: null,
        archivedAt: null,
        deletedAt: null,
        revision: sql`${agentRoutines.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(agentRoutines.id, routine.id))
      .returning()
    const saved = returned(row)
    await audit(tx, actor, {
      projectId: routine.projectId,
      action: 'agents.routine.restore',
      targetType: ROUTINE_TARGET,
      targetId: routine.id,
      beforeRevision: routine.revision,
      afterRevision: saved.revision,
      changes: { name: routine.name },
    })
    return saved
  })
}

/* ── Queueing runs ──────────────────────────────────────────────────── */

async function unfinishedTask(
  tx: Tx,
  routine: AgentRoutineRow,
): Promise<OpsTaskRow | null> {
  const [task] = await tx
    .select()
    .from(opsTasks)
    .where(
      and(
        eq(opsTasks.ownerId, routine.ownerId),
        eq(opsTasks.targetType, ROUTINE_TARGET),
        eq(opsTasks.targetId, routine.id),
        inArray(opsTasks.status, [...UNFINISHED]),
      ),
    )
    .limit(1)
  return task ?? null
}

async function queueRun(
  tx: Tx,
  actor: Actor,
  routine: AgentRoutineRow,
  project: ProjectRow | null,
  triggerKey: string,
  title: string,
): Promise<OpsTaskRow> {
  const { task } = await openTask(tx, actor, project, {
    kind: 'routine',
    module: 'agents',
    title,
    payload: { routine_id: routine.id, runner: routine.runner },
    targetType: ROUTINE_TARGET,
    targetId: routine.id,
    triggerKey,
    claimant: routine.runner === 'builtin' ? 'builtin' : 'agent',
    priority: 40,
    maxAttempts: 2,
  })
  return task
}

/**
 * Queue a run now, outside the schedule. The owner's. A routine that already
 * has a run waiting or running gets that one back instead of a second.
 */
export async function runRoutineNow(
  actor: Actor,
  raw: { routineId: string },
): Promise<{ task: OpsTaskRow; queued: boolean }> {
  const input = parseInput(z.object({ routineId: recordId('Routine') }), raw)
  return withTransaction(async (tx) => {
    const { routine, project } = await lockedRoutine(tx, actor, input.routineId)
    if (routine.archivedAt) throw invalid('This routine is archived.')
    if (routine.runner === 'builtin' && !routine.llmConnectionId)
      throw invalid('HQ’s own runner needs an LLM key first.')
    if (project?.status === 'archived')
      throw invalid('Its project is archived.')
    const waiting = await unfinishedTask(tx, routine)
    if (waiting) return { task: waiting, queued: false }
    const now = await dbNow(tx)
    const task = await queueRun(
      tx,
      actor,
      routine,
      project,
      `routine:${routine.id}:now:${now.getTime()}`,
      `${routine.name} · run now`,
    )
    await tx
      .update(agentRoutines)
      .set({ lastQueuedAt: sql`now()` })
      .where(eq(agentRoutines.id, routine.id))
    return { task, queued: true }
  })
}

export type RoutineTickReport = {
  queued: number
  waiting: number
  skipped: number
}

/**
 * The ops tick's pass: every enabled routine whose time has come gets one
 * run queued (by the database's clock), and its next due time moves on. A
 * routine whose last run hasn't finished just moves on — no pile-up. One in
 * a paused or archived project is skipped until it's back.
 */
export async function queueDueRoutines(
  options: { limit?: number } = {},
): Promise<RoutineTickReport> {
  return withTransaction(async (tx) => {
    const due = await tx
      .select({ routine: agentRoutines, project: projects })
      .from(agentRoutines)
      .leftJoin(projects, eq(projects.id, agentRoutines.projectId))
      .where(
        and(
          eq(agentRoutines.enabled, true),
          isNull(agentRoutines.archivedAt),
          lte(agentRoutines.nextDueAt, sql`now()`),
        ),
      )
      .orderBy(asc(agentRoutines.nextDueAt))
      .limit(options.limit ?? 25)
      .for('update', { of: agentRoutines, skipLocked: true })
    const report: RoutineTickReport = { queued: 0, waiting: 0, skipped: 0 }
    const now = await dbNow(tx)
    for (const { routine, project } of due) {
      const dueAt = routine.nextDueAt as Date
      let next: Date | null = null
      try {
        next = nextRun(routine.cron, routine.timezone, now)
      } catch {
        next = null
      }
      const actor = schedulerActor(routine.ownerId)
      const inactive = project && project.status !== 'active'
      const needsKey = routine.runner === 'builtin' && !routine.llmConnectionId
      let queued = false
      if (inactive || needsKey) report.skipped += 1
      else if (await unfinishedTask(tx, routine)) report.waiting += 1
      else {
        queued = true
        await queueRun(
          tx,
          actor,
          routine,
          project,
          `routine:${routine.id}:${dueAt.getTime()}`,
          routine.name,
        )
        report.queued += 1
      }
      await tx
        .update(agentRoutines)
        .set({
          nextDueAt: next,
          enabled: next !== null,
          ...(queued ? { lastQueuedAt: sql`now()` } : {}),
        })
        .where(eq(agentRoutines.id, routine.id))
    }
    return report
  })
}
