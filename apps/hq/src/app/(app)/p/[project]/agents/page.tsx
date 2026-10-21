import type { Metadata } from 'next'
import { ModuleOff } from '@/components/ModulePending'
import { currentActor } from '@/lib/actions'
import { lite, projectForPage, projectsWith } from '@/lib/project-page'
import { AgentsPage } from '@/modules/agents/components/AgentsPage'
import { loadAgents } from '@/modules/agents/load'
import '@/modules/agents/agents.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Agents — HQ' }

/**
 * `/p/<slug>/agents` — one project's routines, their runs and proposals.
 * `?view=runs` · `?view=trash` (deleted routines, restorable); `?routine=<id>` selects.
 */
export default async function ProjectAgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<{ view?: string; routine?: string }>
}) {
  const [{ project: slug }, query] = await Promise.all([params, searchParams])
  const project = await projectForPage(slug)
  if (!project.modules.enabled.includes('agents')) {
    const others = (await projectsWith('agents')).filter(
      (other) => other.id !== project.id,
    )
    return <ModuleOff module='agents' project={lite(project)} others={others} />
  }
  const props = await loadAgents(await currentActor(), project, query)
  return <AgentsPage key={`${project.id}-${props.view}`} {...props} />
}
