import 'server-only'
import { getDb } from '@theiceji/hq-db'
import {
  agentProposals,
  googleConnections,
  opsAgentRuns,
  opsHumanRequests,
} from '@theiceji/hq-db/schema'
import { userActor } from '@theiceji/hq-ops/access'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { ModuleCell, ModuleId, ProjectLite } from '@/modules'
import {
  CELLED,
  cellsOf,
  loadModuleReads,
  loadProjects,
  safe,
  waitingOn,
} from './cells'

/**
 * What the Bridge shell shows on every page: the owner's projects (rail,
 * switcher, palette), how much waits and runs (◆ n, ▶ n) and the connection
 * chips in the footer, and each project's module cells for the rail counts
 * (`lib/cells.ts`, the same batch Home reads). Read once per layout render — the layout doesn't
 * re-render on client navigation, so actions that change these revalidate
 * the layout.
 *
 * Every number comes from a row. When the database isn't reachable the shell
 * still renders, with nothing in it and the footer saying so.
 */

export type ShellWaiting = {
  id: string
  title: string
  projectId: string | null
  /** Where it is answered: the inbox, on its item. */
  href: string
}

export type ShellData = {
  projects: (ProjectLite & {
    waiting: number
    /** One cell per enabled module, for the rail's counts. */
    cells: Partial<Record<ModuleId, ModuleCell | null>>
    /** What waits for you per module of this project. */
    waitingBy: Partial<Record<ModuleId, number>>
  })[]
  waiting: {
    total: number
    top: ShellWaiting[]
    /** What waits per module across every project — the all-projects rail. */
    byModule: Partial<Record<ModuleId, number>>
  }
  running: number
  google: { status: string; email: string | null }
  database: 'ok' | 'unavailable'
}

const EMPTY: ShellData = {
  projects: [],
  waiting: { total: 0, top: [], byModule: {} },
  running: 0,
  google: { status: 'not_connected', email: null },
  database: 'unavailable',
}

type ShellUser = { id: string; role: 'admin' | 'editor' }

/**
 * The last shell each owner was shown, with the database state it was read
 * at. Per server process, one entry per owner.
 */
const remembered = new Map<string, { version: string; data: ShellData }>()

/** Time-derived numbers (due today, the last 7 days) move on their own. */
const TIME_STEP_MS = 5 * 60_000

/**
 * The shell for this render. A full render — opening HQ, a reload, an
 * action's refresh — needs it, and reading it is 30-odd queries. So it is
 * reused while the database provably hasn't changed: `pg_current_snapshot()`
 * moves whenever any transaction commits or starts writing, whoever runs it
 * (this app, the MCP server, the agent runner, the ops tick), so an equal
 * snapshot means every row the shell read is still what it read. The
 * version also carries a five-minute step for what time alone changes.
 * One cheap query when nothing changed; the full read otherwise.
 */
export async function loadShell(user: ShellUser): Promise<ShellData> {
  const db = getDb()
  if (!db) return EMPTY
  const snapshot = await db
    .execute<{ v: string }>(sql`select pg_current_snapshot()::text as v`)
    .then((rows) => rows[0]?.v ?? null)
    .catch(() => null)
  const version = snapshot
    ? `${user.role}·${snapshot}·${Math.floor(Date.now() / TIME_STEP_MS)}`
    : null
  const last = remembered.get(user.id)
  if (version && last?.version === version) return last.data
  const data = await readShell(user)
  if (version && data.database === 'ok')
    remembered.set(user.id, { version, data })
  return data
}

async function readShell(user: ShellUser): Promise<ShellData> {
  const db = getDb()
  if (!db) return EMPTY
  const actor = userActor(user)
  try {
    const [
      projects,
      perProject,
      top,
      running,
      google,
      proposalsPerProject,
      topProposals,
      reads,
    ] = await Promise.all([
      loadProjects(actor),
      db
        .select({
          projectId: opsHumanRequests.projectId,
          n: sql<number>`count(*)::int`,
        })
        .from(opsHumanRequests)
        .where(
          and(
            eq(opsHumanRequests.ownerId, user.id),
            eq(opsHumanRequests.status, 'open'),
          ),
        )
        .groupBy(opsHumanRequests.projectId),
      db
        .select({
          id: opsHumanRequests.id,
          title: opsHumanRequests.title,
          projectId: opsHumanRequests.projectId,
        })
        .from(opsHumanRequests)
        .where(
          and(
            eq(opsHumanRequests.ownerId, user.id),
            eq(opsHumanRequests.status, 'open'),
          ),
        )
        .orderBy(
          desc(opsHumanRequests.urgency),
          desc(opsHumanRequests.createdAt),
        )
        .limit(6),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(opsAgentRuns)
        .where(
          and(
            eq(opsAgentRuns.ownerId, user.id),
            eq(opsAgentRuns.status, 'running'),
          ),
        ),
      db
        .select({
          status: googleConnections.status,
          email: googleConnections.email,
        })
        .from(googleConnections)
        .where(eq(googleConnections.ownerId, user.id))
        .limit(1),
      db
        .select({
          projectId: agentProposals.projectId,
          n: sql<number>`count(*)::int`,
        })
        .from(agentProposals)
        .where(
          and(
            eq(agentProposals.ownerId, user.id),
            eq(agentProposals.status, 'proposed'),
          ),
        )
        .groupBy(agentProposals.projectId),
      db
        .select({
          id: agentProposals.id,
          title: agentProposals.title,
          projectId: agentProposals.projectId,
        })
        .from(agentProposals)
        .where(
          and(
            eq(agentProposals.ownerId, user.id),
            eq(agentProposals.status, 'proposed'),
          ),
        )
        .orderBy(
          sql`${agentProposals.heldAt} is not null`,
          desc(agentProposals.createdAt),
        )
        .limit(6),
      safe(loadModuleReads(actor)),
    ])
    const byModule: Partial<Record<ModuleId, number>> = {}
    for (const entry of reads?.entries ?? [])
      if (entry.module)
        byModule[entry.module as ModuleId] =
          (byModule[entry.module as ModuleId] ?? 0) + 1
    const byProject = new Map<string | null, number>()
    for (const row of [...perProject, ...proposalsPerProject])
      byProject.set(row.projectId, (byProject.get(row.projectId) ?? 0) + row.n)
    const opsTotal = [...perProject, ...proposalsPerProject].reduce(
      (sum, row) => sum + row.n,
      0,
    )
    return {
      projects: projects.map((project) => ({
        id: project.id,
        slug: project.slug,
        name: project.name,
        kind: project.kind,
        status: project.status,
        color: project.color,
        modules: { enabled: project.modules.enabled },
        waiting: byProject.get(project.id) ?? 0,
        cells: reads ? cellsOf(reads, project) : {},
        waitingBy: Object.fromEntries(
          CELLED.map((id) => [
            id,
            waitingOn(reads?.entries ?? null, project.slug, id),
          ]).filter(([, n]) => n),
        ),
      })),
      waiting: {
        total: opsTotal,
        top: [
          ...top.map((row) => ({ ...row, href: `/inbox?item=${row.id}` })),
          ...topProposals.map((row) => ({
            ...row,
            href: `/inbox?kind=proposals&item=${row.id}`,
          })),
        ].slice(0, 6),
        byModule,
      },
      running: running[0]?.n ?? 0,
      google: google[0]
        ? { status: google[0].status, email: google[0].email }
        : { status: 'not_connected', email: null },
      database: 'ok',
    }
  } catch (error) {
    console.error('shell: could not load', error)
    return EMPTY
  }
}
