import 'server-only'
import { getRoutine, listRoutines } from '@theiceji/hq-agents/routines'
import { listRuns } from '@theiceji/hq-agents/runs'
import { listProjects } from '@theiceji/hq-core/projects'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import '@/modules/register'
import type { InboxEntry } from '@/components/Inbox'
import { loadInboxEntries } from '@/lib/inbox'
import { connectionOptions } from '@/lib/module-page'
import { MODULES } from '@/modules'
import { type RoutineData, type RunData, routineData, runData } from './data'

/**
 * What the Agents page reads on the server:
 * routines (all, or one project's), the selected one's runs, recent runs
 * across them, the proposals they left waiting, and what the routine form
 * offers — projects with their modules, and the owner's Anthropic keys.
 * The Trash view reads the deleted routines instead.
 */

export type AgentsProject = {
  id: string
  slug: string
  name: string
  color: string
  modules: string[]
}

export type AgentsPageProps = {
  /** Null on `/agents` (every routine); a project on `/p/<slug>/agents`. */
  scope: AgentsProject | null
  view: 'routines' | 'runs' | 'trash'
  routines: RoutineData[]
  selectedId: string | null
  runs: RunData[]
  selectedRuns: RunData[]
  proposals: InboxEntry[]
  projects: AgentsProject[]
  llmKeys: { id: string; label: string; status: string }[]
  moduleLabels: Record<string, string>
  /** The server's clock at render, so the page draws the same strip twice. */
  now: number
}

export async function loadAgents(
  actor: Actor,
  project: ProjectRow | null,
  params: { view?: string; routine?: string },
): Promise<AgentsPageProps> {
  const view =
    params.view === 'runs' || params.view === 'trash' ? params.view : 'routines'
  const trash = view === 'trash'
  const [routines, runs, projects, llmKeys, inbox] = await Promise.all([
    listRoutines(actor, {
      ...(project ? { projectId: project.id } : {}),
      trash,
    }),
    trash
      ? []
      : listRuns(
          actor,
          project ? { projectId: project.id, limit: 80 } : { limit: 80 },
        ),
    listProjects(actor),
    connectionOptions(actor, ['llm:anthropic']),
    trash
      ? ([] as InboxEntry[])
      : loadInboxEntries(actor).catch(() => [] as InboxEntry[]),
  ])
  const selectedId =
    routines.find((routine) => routine.id === params.routine)?.id ?? null
  const selected = selectedId ? await getRoutine(actor, selectedId) : null
  const lite = (row: ProjectRow): AgentsProject => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    color: row.color,
    modules: row.modules.enabled,
  })
  return {
    scope: project ? lite(project) : null,
    view,
    routines: routines.map(routineData),
    selectedId,
    runs: runs.map(runData),
    selectedRuns: selected
      ? selected.runs.map((run) =>
          runData({
            ...run,
            routineId: selected.id,
            projectId: selected.projectId,
          }),
        )
      : [],
    proposals: inbox.filter(
      (entry) =>
        entry.kind === 'proposal' &&
        (!project || entry.project?.slug === project.slug),
    ),
    projects: projects.filter((row) => row.status !== 'archived').map(lite),
    llmKeys: llmKeys.map((key) => ({
      id: key.id,
      label: key.label,
      status: key.status,
    })),
    now: Date.now(),
    moduleLabels: Object.fromEntries(
      Object.values(MODULES).map((meta) => [meta.id, meta.label]),
    ),
  }
}
