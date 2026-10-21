import type { ModuleId, OpsTaskKind } from '@theiceji/hq-db/enums'
import {
  googleConnections,
  opsAgentRuns,
  opsHumanRequests,
  opsTasks,
  type ProjectRow,
  projects,
  providerConnections,
} from '@theiceji/hq-db/schema'
import { SCOPES } from '@theiceji/hq-db/scopes'
import type { Actor } from '@theiceji/hq-ops/access'
import { dbNow, type Reader } from '@theiceji/hq-ops/db'
import { currentPolicy, policyState } from '@theiceji/hq-ops/policy-gate'
import { authorize, ownedProject, withReader } from '@theiceji/hq-ops/store'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { orderedModules } from './modules'

/**
 * The brief (`hq_get_brief`) — what an agent, or the owner's
 * Home, reads first: every project with what waits for the owner and what is
 * running, the open requests and tasks, and whether the operating policy is
 * in force. Read-only, and every number comes from a row; nothing is
 * estimated.
 *
 * It reads the kernel's tables directly rather than through their services:
 * a brief is one pass of counts, not a list of every record.
 */

export type PolicySummary = {
  /** In force for *this* actor — a person is never gated, so for a person it says whether agents are. */
  inForce: boolean
  revision: number | null
  reason: string | null
}

export type BriefProject = {
  id: string
  slug: string
  name: string
  kind: ProjectRow['kind']
  status: ProjectRow['status']
  color: ProjectRow['color']
  modules: ModuleId[]
  waiting: number
  running: number
  openTasks: number
  policy: PolicySummary
}

export type Brief = {
  generatedAt: string
  projectId: string | null
  you: { type: Actor['type']; label: string; scopes: string[] }
  projects: BriefProject[]
  waiting: {
    id: string
    title: string
    kind: string
    urgency: string
    module: ModuleId | null
    projectId: string | null
    expiresAt: string
    createdAt: string
  }[]
  running: {
    id: string
    taskId: string
    projectId: string | null
    actorType: string
    heartbeatAt: string
    startedAt: string
    /** The lease ran out without a heartbeat; the ops tick will abandon it. */
    lapsed: boolean
  }[]
  tasks: {
    id: string
    title: string
    kind: OpsTaskKind
    module: ModuleId | null
    projectId: string | null
    priority: number
    dueAt: string | null
  }[]
  blockers: string[]
  nextActions: string[]
}

const iso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString()

async function policySummary(
  reader: Reader,
  actor: Actor,
  projectId: string | null,
  now: Date,
): Promise<PolicySummary> {
  const policy = await currentPolicy(reader, actor.userId, projectId)
  // A person isn't gated; the question for them is whether agents are.
  const subject: Actor =
    actor.type === 'user'
      ? { ...actor, type: 'agent', grantId: undefined }
      : actor
  const state = policyState(policy, subject, now)
  return {
    inForce: state.ok,
    revision: policy?.revisionNo ?? null,
    reason: state.ok ? null : state.reason,
  }
}

function countBy<T extends { projectId: string | null; n: number }>(
  rows: T[],
): Map<string | null, number> {
  return new Map(rows.map((row) => [row.projectId, Number(row.n)]))
}

/** The projects a read covers: one the actor owns, or every live one of theirs. */
async function scopeProjects(
  db: Reader,
  actor: Actor,
  projectId: string | null,
): Promise<ProjectRow[]> {
  if (projectId) return [await ownedProject(db, actor, projectId, 'hq', 'read')]
  await authorize(db, actor, null, 'hq', 'read')
  return db
    .select()
    .from(projects)
    .where(
      and(eq(projects.ownerId, actor.userId), ne(projects.status, 'archived')),
    )
    .orderBy(asc(projects.position))
}

export async function getBrief(
  actor: Actor,
  options: { projectId?: string | null } = {},
): Promise<Brief> {
  return withReader(async (db) => {
    const projectId = options.projectId ?? null
    const scoped = await scopeProjects(db, actor, projectId)
    const inScope = (column: AnyPgColumn) =>
      projectId ? eq(column, projectId) : undefined
    const now = await dbNow(db)

    const [
      waitingCounts,
      runningCounts,
      taskCounts,
      waiting,
      running,
      tasks,
      google,
    ] = await Promise.all([
      db
        .select({
          projectId: opsHumanRequests.projectId,
          n: sql<number>`count(*)`,
        })
        .from(opsHumanRequests)
        .where(
          and(
            eq(opsHumanRequests.ownerId, actor.userId),
            eq(opsHumanRequests.status, 'open'),
          ),
        )
        .groupBy(opsHumanRequests.projectId),
      db
        .select({ projectId: opsAgentRuns.projectId, n: sql<number>`count(*)` })
        .from(opsAgentRuns)
        .where(
          and(
            eq(opsAgentRuns.ownerId, actor.userId),
            eq(opsAgentRuns.status, 'running'),
          ),
        )
        .groupBy(opsAgentRuns.projectId),
      db
        .select({ projectId: opsTasks.projectId, n: sql<number>`count(*)` })
        .from(opsTasks)
        .where(
          and(
            eq(opsTasks.ownerId, actor.userId),
            inArray(opsTasks.status, ['open', 'claimed', 'blocked']),
          ),
        )
        .groupBy(opsTasks.projectId),
      db
        .select()
        .from(opsHumanRequests)
        .where(
          and(
            eq(opsHumanRequests.ownerId, actor.userId),
            eq(opsHumanRequests.status, 'open'),
            inScope(opsHumanRequests.projectId),
          ),
        )
        .orderBy(
          desc(opsHumanRequests.urgency),
          desc(opsHumanRequests.createdAt),
        )
        .limit(20),
      db
        .select({
          run: opsAgentRuns,
          lapsed: sql<boolean>`${opsAgentRuns.leaseExpiresAt} < now()`,
        })
        .from(opsAgentRuns)
        .where(
          and(
            eq(opsAgentRuns.ownerId, actor.userId),
            eq(opsAgentRuns.status, 'running'),
            inScope(opsAgentRuns.projectId),
          ),
        )
        .orderBy(desc(opsAgentRuns.startedAt))
        .limit(20),
      db
        .select()
        .from(opsTasks)
        .where(
          and(
            eq(opsTasks.ownerId, actor.userId),
            eq(opsTasks.status, 'open'),
            inScope(opsTasks.projectId),
          ),
        )
        .orderBy(desc(opsTasks.priority), asc(opsTasks.dueAt))
        .limit(20),
      db
        .select({
          status: googleConnections.status,
          problem: googleConnections.problem,
        })
        .from(googleConnections)
        .where(eq(googleConnections.ownerId, actor.userId))
        .limit(1),
    ])

    const waitingBy = countBy(waitingCounts)
    const runningBy = countBy(runningCounts)
    const tasksBy = countBy(taskCounts)
    const briefProjects: BriefProject[] = []
    for (const project of scoped)
      briefProjects.push({
        id: project.id,
        slug: project.slug,
        name: project.name,
        kind: project.kind,
        status: project.status,
        color: project.color,
        modules: orderedModules(project.kind, project.modules.enabled),
        waiting: waitingBy.get(project.id) ?? 0,
        running: runningBy.get(project.id) ?? 0,
        openTasks: tasksBy.get(project.id) ?? 0,
        policy: await policySummary(db, actor, project.id, now),
      })

    const blockers: string[] = []
    const [connection] = google
    if (connection && connection.status !== 'connected')
      blockers.push(
        `Google needs the owner: ${connection.problem ?? connection.status}. Drive storage and calendar sync wait until it is reconnected in Settings › Google.`,
      )
    if (actor.type !== 'user')
      for (const project of briefProjects)
        if (!project.policy.inForce)
          blockers.push(`${project.name}: ${project.policy.reason}`)

    const nextActions: string[] = []
    const openRequests = [...waitingBy.entries()]
      .filter(([id]) => projectId === null || id === projectId)
      .reduce((sum, [, n]) => sum + n, 0)
    if (openRequests > 0)
      nextActions.push(
        `${openRequests} request(s) wait for the owner in HQ › Inbox; nothing they gate happens until they answer.`,
      )
    if (running.some((entry) => entry.lapsed))
      nextActions.push(
        'Some runs missed their heartbeat; the ops tick abandons them and reopens their tasks.',
      )
    if (briefProjects.length === 0)
      nextActions.push(
        'There are no projects yet — the owner creates them in HQ › Projects.',
      )

    return {
      generatedAt: now.toISOString(),
      projectId,
      you: {
        type: actor.type,
        label:
          actor.type === 'user' ? 'the owner' : (actor.label ?? 'connection'),
        scopes:
          actor.type === 'user'
            ? SCOPES.map((entry) => entry.scope)
            : [...(actor.scopes ?? [])],
      },
      projects: briefProjects,
      waiting: waiting.map((row) => ({
        id: row.id,
        title: row.title,
        kind: row.kind,
        urgency: row.urgency,
        module: row.module,
        projectId: row.projectId,
        expiresAt: iso(row.expiresAt),
        createdAt: iso(row.createdAt),
      })),
      running: running.map(({ run, lapsed }) => ({
        id: run.id,
        taskId: run.taskId,
        projectId: run.projectId,
        actorType: run.actorType,
        heartbeatAt: iso(run.heartbeatAt),
        startedAt: iso(run.startedAt),
        lapsed: Boolean(lapsed),
      })),
      tasks: tasks.map((row) => ({
        id: row.id,
        title: row.title,
        kind: row.kind,
        module: row.module,
        projectId: row.projectId,
        priority: row.priority,
        dueAt: row.dueAt ? iso(row.dueAt) : null,
      })),
      blockers,
      nextActions,
    }
  })
}

export type Capabilities = {
  you: { type: Actor['type']; label: string }
  scopes: { scope: string; label: string; granted: boolean }[]
  projects: {
    id: string
    slug: string
    name: string
    modules: ModuleId[]
    policy: PolicySummary
  }[]
  /** The owner's work in no project runs under its own policy. */
  noProjectPolicy: PolicySummary
  google: {
    status: string
    drive: boolean
    calendar: boolean
    problem: string | null
  }
  providers: {
    provider: string
    label: string
    status: string
    problem: string | null
  }[]
}

/**
 * What this connection may do, and what stands in the way — the second read
 * of every session (`hq_get_capabilities`). Secrets never appear: a provider
 * is its status and a label.
 */
export async function getCapabilities(
  actor: Actor,
  options: { projectId?: string | null } = {},
): Promise<Capabilities> {
  return withReader(async (db) => {
    const scoped = await scopeProjects(db, actor, options.projectId ?? null)
    const now = await dbNow(db)
    const [google] = await db
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.ownerId, actor.userId))
      .limit(1)
    const providers = await db
      .select({
        provider: providerConnections.provider,
        label: providerConnections.label,
        status: providerConnections.status,
        problem: providerConnections.problem,
      })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.ownerId, actor.userId),
          isNull(providerConnections.revokedAt),
        ),
      )
    const held =
      actor.type === 'user' ? null : (actor.scopes ?? new Set<string>())
    const projectsOut: Capabilities['projects'] = []
    for (const project of scoped)
      projectsOut.push({
        id: project.id,
        slug: project.slug,
        name: project.name,
        modules: orderedModules(project.kind, project.modules.enabled),
        policy: await policySummary(db, actor, project.id, now),
      })
    return {
      you: {
        type: actor.type,
        label:
          actor.type === 'user' ? 'the owner' : (actor.label ?? 'connection'),
      },
      scopes: SCOPES.map((entry) => ({
        scope: entry.scope,
        label: entry.label,
        granted: held === null || held.has(entry.scope),
      })),
      projects: projectsOut,
      noProjectPolicy: await policySummary(db, actor, null, now),
      google: google
        ? {
            status: google.status,
            drive: google.scopes.some((scope) => scope.endsWith('/drive.file')),
            calendar: google.scopes.some((scope) =>
              scope.endsWith('/calendar.events'),
            ),
            problem: google.problem,
          }
        : {
            status: 'not_connected',
            drive: false,
            calendar: false,
            problem: null,
          },
      providers,
    }
  })
}
