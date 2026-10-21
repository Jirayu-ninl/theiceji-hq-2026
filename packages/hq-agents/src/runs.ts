import {
  type OpsAgentRunRow,
  type OpsTaskRow,
  opsAgentRuns,
  opsTasks,
  type ProjectRow,
  projects,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan, workScope } from '@theiceji/hq-ops/access'
import {
  recordUsage,
  releaseReservation,
  reserveBudget,
  settleReservation,
} from '@theiceji/hq-ops/budget'
import type { Tx } from '@theiceji/hq-ops/db'
import {
  budgetExceeded,
  invalid,
  notFound,
  OpsError,
} from '@theiceji/hq-ops/errors'
import { currentPolicy } from '@theiceji/hq-ops/policy-gate'
import {
  optionalRecordId,
  parseInput,
  recordId,
  text,
} from '@theiceji/hq-ops/schemas'
import { audit, withReader, withTransaction } from '@theiceji/hq-ops/store'
import { assertTaskFencing } from '@theiceji/hq-ops/tasks'
import { and, eq, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ROUTINE_TARGET, type RunSummary, runSummaries } from './routines'

/**
 * A run's cost — what an agent's LLM calls and paid
 * tools used, charged against the operating policy's budget.
 *
 * · **Known cost is charged**: reserved against the policy's cash limits for
 *   the run's project (per job, per day, per month in the project's own
 *   days) and settled at once; the usage line points at the run.
 * · **Over budget, the run stops**: the spend is still recorded (it
 *   happened), the run ends `failed`, its task is parked `blocked` with the
 *   reason, and the caller gets `budget_exceeded`. The old fencing token is
 *   dead, so nothing the run tries next can land.
 * · **Unknown cost is counted, never guessed** — recorded as unknown, no
 *   reservation.
 * · **HQ's builtin runner holds budget before each LLM call** (`holdRunSpend`
 *   with its worst case) and settles the real cost after (`chargeRunHold`),
 *   so it stops before spending, not after.
 */

type HeldRunContext = {
  run: OpsAgentRunRow
  task: OpsTaskRow
  project: ProjectRow | null
}

async function heldRun(
  tx: Tx,
  actor: Actor,
  runId: string,
  fencingToken: number,
): Promise<HeldRunContext> {
  const [row] = await tx
    .select({ run: opsAgentRuns, project: projects })
    .from(opsAgentRuns)
    .leftJoin(projects, eq(projects.id, opsAgentRuns.projectId))
    .where(
      and(eq(opsAgentRuns.id, runId), eq(opsAgentRuns.ownerId, actor.userId)),
    )
    .limit(1)
  if (!row) throw notFound('Run')
  const task = await assertTaskFencing(tx, actor, {
    taskId: row.run.taskId,
    fencingToken,
  })
  if (row.run.status !== 'running' || row.run.actorId !== actor.id)
    throw invalid('That run isn’t yours to charge.')
  return { run: row.run, task, project: row.project ?? null }
}

/** Ends a run the budget stopped: the task waits for the owner, not a retry. */
async function stopForBudget(
  actor: Actor,
  runId: string,
  fencingToken: number,
  reason: string,
): Promise<void> {
  await withTransaction(async (tx) => {
    let held: HeldRunContext
    try {
      held = await heldRun(tx, actor, runId, fencingToken)
    } catch {
      return
    }
    await tx
      .update(opsAgentRuns)
      .set({
        status: 'failed',
        error: `budget_exceeded: ${reason}`,
        summary: 'Stopped: the operating policy’s budget is spent.',
        endedAt: sql`now()`,
      })
      .where(eq(opsAgentRuns.id, held.run.id))
    await tx
      .update(opsTasks)
      .set({
        status: 'blocked',
        blockedReason: `budget_exceeded: ${reason}`,
        leaseActorType: null,
        leaseActorId: null,
        leaseExpiresAt: null,
        fencingToken: held.task.fencingToken + 1,
        revision: sql`${opsTasks.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(opsTasks.id, held.task.id))
    await audit(tx, actor, {
      projectId: held.task.projectId,
      action: 'task.budget_stop',
      targetType: 'task',
      targetId: held.task.id,
      reason,
      changes: { runId: held.run.id },
    })
  })
}

const costSchema = z.object({
  runId: recordId('Run'),
  fencingToken: z.coerce.number().int().min(1),
  /** Who was paid: `anthropic`, `openai`, `midjourney` … */
  provider: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9_.:-]*$/, 'A provider is a lowercase key.'),
  /** Minor units (satang, cents). Absent when nobody knows the price. */
  costMinor: z.number().int().min(0).nullable().optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'A three-letter currency.')
    .optional(),
  tokens: z.number().int().min(0).nullable().optional(),
  /** What was counted: `tokens`, `images`, `seconds`, `calls`. */
  unit: z.string().trim().min(1).max(40).optional(),
  quantity: z.number().int().min(0).nullable().optional(),
  /** `estimated` until the bill says otherwise. */
  reconciled: z.boolean().optional(),
  note: text.optional('Note', 500),
})

export type RecordCostInput = z.input<typeof costSchema>

async function charge(
  tx: Tx,
  actor: Actor,
  held: HeldRunContext,
  input: z.output<typeof costSchema>,
  reservationId: string | null,
): Promise<void> {
  const known = input.costMinor !== null && input.costMinor !== undefined
  let reservation = reservationId
  if (known && actor.type !== 'user') {
    const policy = await currentPolicy(
      tx,
      actor.userId,
      held.project?.id ?? null,
    )
    if (!policy)
      throw budgetExceeded(
        'No operating policy covers this project, so nothing may be spent here.',
      )
    if (!reservation)
      reservation = (
        await reserveBudget(tx, actor, held.project, policy, {
          spend: {
            kind: 'cash',
            unit: input.currency as string,
            amount: input.costMinor as number,
          },
          provider: input.provider,
          purpose: 'agent run',
          subjectType: 'agent_run',
          subjectId: held.run.id,
        })
      ).id
    await settleReservation(
      tx,
      actor,
      reservation,
      input.costMinor as number,
      'charged by the run',
    )
  }
  await recordUsage(tx, actor, held.project, {
    reservationId: known ? reservation : null,
    subjectType: 'agent_run',
    subjectId: held.run.id,
    provider: input.provider,
    kind: 'cash',
    unit: input.unit ?? (known ? (input.currency as string) : 'calls'),
    quantity: input.quantity ?? null,
    costMinor: known ? (input.costMinor as number) : null,
    currency: known ? (input.currency ?? null) : null,
    costStatus: known
      ? input.reconciled
        ? 'reconciled'
        : 'estimated'
      : 'unknown',
    tokens: input.tokens ?? null,
    note: input.note ?? null,
  })
}

/**
 * Record what a run spent. Known cost is charged against the budget; past
 * the limit the run is stopped (see above) and `budget_exceeded` is thrown.
 */
export async function recordRunCost(
  actor: Actor,
  raw: RecordCostInput,
): Promise<void> {
  const input = parseInput(costSchema, raw)
  if (input.costMinor != null && !input.currency)
    throw invalid('A cost needs its currency.', { currency: 'Required.' })
  try {
    await withTransaction(async (tx) => {
      const held = await heldRun(tx, actor, input.runId, input.fencingToken)
      await charge(tx, actor, held, input, null)
    })
  } catch (error) {
    if (error instanceof OpsError && error.code === 'budget_exceeded') {
      // It was spent whether or not the budget allowed it: record it, then stop.
      await withTransaction(async (tx) => {
        const held = await heldRun(tx, actor, input.runId, input.fencingToken)
        await recordUsage(tx, actor, held.project, {
          subjectType: 'agent_run',
          subjectId: held.run.id,
          provider: input.provider,
          kind: 'cash',
          unit: input.unit ?? (input.currency as string),
          quantity: input.quantity ?? null,
          costMinor: input.costMinor ?? null,
          currency: input.currency ?? null,
          costStatus: input.reconciled ? 'reconciled' : 'estimated',
          tokens: input.tokens ?? null,
          note: `Over budget: ${error.message}`,
        })
      })
      await stopForBudget(actor, input.runId, input.fencingToken, error.message)
    }
    throw error
  }
}

/**
 * Hold budget before a paid call — the builtin runner's worst case for one
 * LLM turn. `budget_exceeded` stops the run before anything is spent.
 */
export async function holdRunSpend(
  actor: Actor,
  raw: {
    runId: string
    fencingToken: number
    provider: string
    amountMinor: number
    currency: string
  },
): Promise<{ reservationId: string | null }> {
  if (actor.type === 'user') return { reservationId: null }
  try {
    return await withTransaction(async (tx) => {
      const held = await heldRun(tx, actor, raw.runId, raw.fencingToken)
      const policy = await currentPolicy(
        tx,
        actor.userId,
        held.project?.id ?? null,
      )
      if (!policy)
        throw budgetExceeded(
          'No operating policy covers this project, so nothing may be spent here.',
        )
      const reservation = await reserveBudget(tx, actor, held.project, policy, {
        spend: { kind: 'cash', unit: raw.currency, amount: raw.amountMinor },
        provider: raw.provider,
        purpose: 'agent run turn',
        subjectType: 'agent_run',
        subjectId: held.run.id,
        ttlSeconds: 15 * 60,
      })
      return { reservationId: reservation.id }
    })
  } catch (error) {
    if (error instanceof OpsError && error.code === 'budget_exceeded')
      await stopForBudget(actor, raw.runId, raw.fencingToken, error.message)
    throw error
  }
}

/** Settle a hold at the real cost (or give it back when the call failed). */
export async function chargeRunHold(
  actor: Actor,
  reservationId: string | null,
  raw: RecordCostInput,
): Promise<void> {
  const input = parseInput(costSchema, raw)
  await withTransaction(async (tx) => {
    const held = await heldRun(tx, actor, input.runId, input.fencingToken)
    if (
      reservationId &&
      (input.costMinor === null || input.costMinor === undefined)
    )
      await releaseReservation(
        tx,
        actor,
        reservationId,
        'the call cost nothing known',
      )
    await charge(
      tx,
      actor,
      held,
      input,
      input.costMinor === null || input.costMinor === undefined
        ? null
        : reservationId,
    )
  })
}

/* ── Reading ────────────────────────────────────────────────────────── */

const runsSchema = z.object({
  routineId: optionalRecordId('Routine'),
  projectId: optionalRecordId('Project'),
  limit: z.number().int().min(1).max(200).optional(),
})

export type RunItem = RunSummary & {
  routineId: string | null
  projectId: string | null
}

/** Runs — of one routine, one project, or all — newest first, with cost. */
export async function listRuns(
  actor: Actor,
  raw: z.input<typeof runsSchema> = {},
): Promise<RunItem[]> {
  const scope = workScope(actor, 'agents', 'read')
  assertCan(actor, scope.area, scope.capability)
  const input = parseInput(runsSchema, raw)
  return withReader((db) =>
    runSummaries(
      db,
      actor.userId,
      and(
        input.routineId
          ? and(
              eq(opsTasks.targetType, ROUTINE_TARGET),
              eq(opsTasks.targetId, input.routineId),
            )
          : undefined,
        input.projectId
          ? eq(opsAgentRuns.projectId, input.projectId)
          : undefined,
      ) ?? sql`true`,
      input.limit ?? 50,
    ),
  ) as Promise<RunItem[]>
}

/** Running now, across the owner's projects — Home's "agents running" and the top bar. */
export async function runningRuns(actor: Actor): Promise<RunItem[]> {
  const scope = workScope(actor, 'agents', 'read')
  assertCan(actor, scope.area, scope.capability)
  return withReader((db) =>
    runSummaries(
      db,
      actor.userId,
      eq(opsAgentRuns.status, 'running') as SQL,
      50,
    ),
  ) as Promise<RunItem[]>
}
