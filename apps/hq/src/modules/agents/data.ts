import type { RoutineView, RunSummary } from '@theiceji/hq-agents/routines'
import { digitsOf, formatMoney, fromMinor } from '@theiceji/hq-core/money'

/**
 * What the Agents page carries to the client — plain, serialisable, every
 * number already in words where the page shows words (money in
 * its own currency, never converted; unknown cost is "—", never 0).
 */

export type RunData = {
  id: string
  taskId: string
  routineId: string | null
  projectId: string | null
  status: string
  /** `running` · `succeeded` · `failed` · `blocked` (waiting on you) · `abandoned` (lease lapsed) · `budget` (the budget stopped it). */
  state:
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'budget'
    | 'abandoned'
    | 'cancelled'
  startedAt: string
  endedAt: string | null
  durationS: number | null
  summary: string | null
  error: string | null
  by: string
  cost: string
  /** Minor units per currency, for the run strip's bar height. */
  costMinor: { currency: string; minor: number }[]
  unknownCosts: number
  tokens: number | null
  proposals: number
  leaseExpiresAt: string
}

export type RoutineData = {
  id: string
  name: string
  projectId: string | null
  project: { slug: string; name: string; color: string } | null
  cron: string
  schedule: string
  timezone: string
  playbook: string
  modules: string[]
  runner: 'mcp' | 'builtin'
  llmConnectionId: string | null
  llm: { label: string; hint: string } | null
  maxTurns: number
  autoAccept: string[]
  enabled: boolean
  nextDueAt: string | null
  lastQueuedAt: string | null
  /** In the Trash since (deleted, or archived before the Trash existed); null while it's live. */
  trashedAt: string | null
  revision: number
  current: { status: string; blockedReason: string | null } | null
  lastRun: RunData | null
  pendingProposals: number
}

export function costText(
  cost: { currency: string; minor: number }[],
  unknown: number,
): string {
  const known = cost.map((line) =>
    formatMoney(
      fromMinor(BigInt(line.minor), digitsOf(line.currency)),
      line.currency,
      { exact: true },
    ),
  )
  if (known.length === 0) return unknown ? '— unknown' : '—'
  return `${known.join(' + ')}${unknown ? ` + ${unknown} unknown` : ''}`
}

export function runData(
  run: RunSummary & { routineId: string | null; projectId: string | null },
): RunData {
  const budget =
    run.status === 'failed' && (run.error ?? '').startsWith('budget_exceeded')
  return {
    id: run.id,
    taskId: run.taskId,
    routineId: run.routineId,
    projectId: run.projectId,
    status: run.status,
    state: budget
      ? 'budget'
      : (run.status as Exclude<RunData['state'], 'budget'>),
    startedAt: run.startedAt.toISOString(),
    endedAt: run.endedAt?.toISOString() ?? null,
    durationS: run.endedAt
      ? Math.max(
          0,
          Math.round((run.endedAt.getTime() - run.startedAt.getTime()) / 1000),
        )
      : null,
    summary: run.summary,
    error: run.error,
    by: run.actorType === 'agent' ? 'agent' : run.actorType,
    cost: costText(run.cost, run.unknownCosts),
    costMinor: run.cost,
    unknownCosts: run.unknownCosts,
    tokens: run.tokens,
    proposals: run.proposals,
    leaseExpiresAt: run.leaseExpiresAt.toISOString(),
  }
}

export function routineData(routine: RoutineView): RoutineData {
  return {
    id: routine.id,
    name: routine.name,
    projectId: routine.projectId,
    project: routine.project
      ? {
          slug: routine.project.slug,
          name: routine.project.name,
          color: routine.project.color,
        }
      : null,
    cron: routine.cron,
    schedule: routine.schedule,
    timezone: routine.timezone,
    playbook: routine.playbook,
    modules: routine.modules,
    runner: routine.runner,
    llmConnectionId: routine.llmConnectionId,
    llm: routine.llm
      ? { label: routine.llm.label, hint: routine.llm.hint }
      : null,
    maxTurns: routine.maxTurns,
    autoAccept: routine.autoAccept,
    enabled: routine.enabled,
    nextDueAt: routine.nextDueAt?.toISOString() ?? null,
    lastQueuedAt: routine.lastQueuedAt?.toISOString() ?? null,
    trashedAt: (routine.deletedAt ?? routine.archivedAt)?.toISOString() ?? null,
    revision: routine.revision,
    current: routine.current
      ? {
          status: routine.current.status,
          blockedReason: routine.current.blockedReason,
        }
      : null,
    lastRun: routine.lastRun
      ? runData({
          ...routine.lastRun,
          routineId: routine.id,
          projectId: routine.projectId,
        })
      : null,
    pendingProposals: routine.pendingProposals,
  }
}
