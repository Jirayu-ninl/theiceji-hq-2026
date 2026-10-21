import 'server-only'
import { listRuns, runningRuns } from '@theiceji/hq-agents/runs'
import {
  agentRoutines,
  oauthGrants,
  opsAuditEvents,
  opsTasks,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { SCHEDULER_ACTOR_ID } from '@theiceji/hq-ops/actors'
import { withReader } from '@theiceji/hq-ops/store'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { type RunData, runData } from '@/modules/agents/data'

/**
 * What the shell's console reads (its data owner is hq-ops): the signed-in
 * owner's audit trail for Log and their agent runs for Runs. Read only when
 * the console opens, never with the layout. Every query is filtered by the owner, and every number comes from a
 * row — a run nobody priced reads "—", never 0.
 */

export type ConsoleLogRow = {
  id: string
  at: string
  actor: string
  action: string
  result: string
  /** The policy's words, when the event carries any. */
  reason: string | null
  /** Something now waits for you, or something failed (drawn in a tint). */
  tone: 'wait' | null
}

export type ConsoleRunRow = {
  id: string
  label: string
  state: RunData['state']
  startedAt: string
  cost: string
}

export type ConsoleData = {
  log: ConsoleLogRow[]
  runs: ConsoleRunRow[]
}

const LOG_LIMIT = 200
const RUNS_LIMIT = 40
const TEXT_MAX = 160

/** Events that leave something waiting for the owner. */
const WAITS = new Set(['human_request.create', 'agents.proposal.create'])
const FAILS = /fail|budget_stop|orphan|vanished|stalled/

const clip = (text: string) =>
  text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idLike = (key: string, value: unknown) =>
  /(^id$|Id$|Token$|At$|^sha256$)/.test(key) ||
  (typeof value === 'string' && UUID.test(value))

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number') return String(value)
  return null
}

const isDiff = (value: unknown): value is { from?: unknown; to?: unknown } =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'to' in value

/**
 * One line of what an event did, from its own record: the fields it changed
 * (`lane Review → Awaiting payment`), else what it names (a title, a quote
 * number), its money, or its first plain facts; the reason when nothing else
 * says it; the record type as the last resort.
 */
export function auditResult(event: {
  action: string
  targetType: string
  afterRevision: number | null
  reason: string | null
  changes: Record<string, unknown>
}): { result: string; tone: 'wait' | null } {
  const changes = event.changes ?? {}
  const entries = Object.entries(changes)
  const parts: string[] = []

  const diffs = entries.filter(([, value]) => isDiff(value))
  for (const [key, value] of diffs.slice(0, 2)) {
    const diff = value as { from?: unknown; to?: unknown }
    const to = scalar(diff.to)
    const from = scalar(diff.from)
    parts.push(
      to === null
        ? `${key} cleared`
        : from === null
          ? `${key} → ${to}`
          : `${key} ${from} → ${to}`,
    )
  }
  if (diffs.length > 2) parts.push(`+${diffs.length - 2} more`)

  if (parts.length === 0) {
    const named = ['title', 'name', 'label', 'number']
      .map((key) => scalar(changes[key]))
      .find(Boolean)
    if (named) parts.push(named)
    const amount = ['total', 'price', 'amount']
      .map((key) => scalar(changes[key]))
      .find(Boolean)
    const currency = scalar(changes.currency)
    if (amount && currency) parts.push(`${amount} ${currency}`)
  }

  if (parts.length === 0) {
    const facts = entries
      .filter(([key, value]) => !idLike(key, value) && scalar(value) !== null)
      .slice(0, 2)
      .map(([key, value]) => `${key} ${scalar(value)}`)
    parts.push(...facts)
  }

  if (parts.length === 0 && event.reason) parts.push(event.reason)
  if (parts.length === 0)
    parts.push(
      event.afterRevision !== null
        ? `${event.targetType} r${event.afterRevision}`
        : event.targetType,
    )

  const waits = WAITS.has(event.action)
  const text = clip(parts.join(' · '))
  return {
    result: waits ? `${text} → waiting` : text,
    tone:
      waits ||
      FAILS.test(event.action) ||
      (event.reason ?? '').startsWith('budget_exceeded')
        ? 'wait'
        : null,
  }
}

/** The owner's audit trail, oldest of the newest first — newest at the bottom. */
async function readLog(actor: Actor): Promise<ConsoleLogRow[]> {
  return withReader(async (db) => {
    const rows = await db
      .select({
        id: opsAuditEvents.id,
        occurredAt: opsAuditEvents.occurredAt,
        actorType: opsAuditEvents.actorType,
        actorId: opsAuditEvents.actorId,
        action: opsAuditEvents.action,
        targetType: opsAuditEvents.targetType,
        afterRevision: opsAuditEvents.afterRevision,
        reason: opsAuditEvents.reason,
        changes: opsAuditEvents.changes,
      })
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.ownerId, actor.userId))
      .orderBy(desc(opsAuditEvents.occurredAt))
      .limit(LOG_LIMIT)
    // Agents and workers are their connection: name them by its label.
    const grantIds = [
      ...new Set(
        rows
          .filter((row) => row.actorType !== 'user' && UUID.test(row.actorId))
          .map((row) => row.actorId),
      ),
    ]
    const grants = grantIds.length
      ? await db
          .select({ id: oauthGrants.id, label: oauthGrants.label })
          .from(oauthGrants)
          .where(
            and(
              eq(oauthGrants.userId, actor.userId),
              inArray(oauthGrants.id, grantIds),
            ),
          )
      : []
    const labels = new Map(grants.map((grant) => [grant.id, grant.label]))
    const who = (row: (typeof rows)[number]) => {
      if (row.actorType === 'user')
        return row.actorId === actor.userId ? 'you' : 'user'
      if (row.actorId === SCHEDULER_ACTOR_ID) return 'scheduler'
      return labels.get(row.actorId) ?? row.actorType
    }
    return rows.reverse().map((row) => ({
      id: row.id,
      at: row.occurredAt.toISOString(),
      actor: who(row),
      action: row.action,
      reason: row.reason,
      ...auditResult(row),
    }))
  })
}

/** Running first, then the most recent, each named by its routine or task. */
async function readRuns(actor: Actor): Promise<ConsoleRunRow[]> {
  const [running, recent] = await Promise.all([
    runningRuns(actor),
    listRuns(actor, { limit: RUNS_LIMIT }),
  ])
  const runs = [
    ...running,
    ...recent.filter((run) => run.status !== 'running'),
  ].slice(0, RUNS_LIMIT)
  if (runs.length === 0) return []
  const taskIds = [...new Set(runs.map((run) => run.taskId))]
  const routineIds = [
    ...new Set(runs.map((run) => run.routineId).filter(Boolean)),
  ] as string[]
  const [tasks, routines] = await withReader((db) =>
    Promise.all([
      db
        .select({ id: opsTasks.id, title: opsTasks.title })
        .from(opsTasks)
        .where(
          and(
            eq(opsTasks.ownerId, actor.userId),
            inArray(opsTasks.id, taskIds),
          ),
        ),
      routineIds.length
        ? db
            .select({ id: agentRoutines.id, name: agentRoutines.name })
            .from(agentRoutines)
            .where(
              and(
                eq(agentRoutines.ownerId, actor.userId),
                inArray(agentRoutines.id, routineIds),
              ),
            )
        : Promise.resolve([]),
    ]),
  )
  const titles = new Map(tasks.map((task) => [task.id, task.title]))
  const names = new Map(routines.map((routine) => [routine.id, routine.name]))
  return runs.map((run) => {
    const data = runData(run)
    return {
      id: run.id,
      label:
        (run.routineId ? names.get(run.routineId) : undefined) ??
        titles.get(run.taskId) ??
        'run',
      state: data.state,
      startedAt: data.startedAt,
      cost: data.cost,
    }
  })
}

export async function readConsole(actor: Actor): Promise<ConsoleData> {
  const [log, runs] = await Promise.all([readLog(actor), readRuns(actor)])
  return { log, runs }
}
