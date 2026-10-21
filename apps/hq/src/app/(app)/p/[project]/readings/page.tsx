import type { Metadata } from 'next'
import { ModuleOff } from '@/components/ModulePending'
import { currentActor } from '@/lib/actions'
import { lite, projectForPage, projectsWith } from '@/lib/project-page'
import { DashboardPage } from '@/modules/readings/components/DashboardPage'
import { loadDashboard } from '@/modules/readings/load'
import '@/modules/readings/readings.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Readings — HQ' }

/**
 * `/p/<slug>/readings` — one project's dashboard: money that happened, the window
 * before, cost, and posts and listings read at the same age. `?days=7|30|90&age=24|72|168`.
 */
export default async function ProjectReadingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<{ days?: string; age?: string; view?: string }>
}) {
  const [{ project: slug }, query] = await Promise.all([params, searchParams])
  const project = await projectForPage(slug)
  if (!project.modules.enabled.includes('readings')) {
    const others = (await projectsWith('readings')).filter(
      (other) => other.id !== project.id,
    )
    return (
      <ModuleOff module='readings' project={lite(project)} others={others} />
    )
  }
  const props = await loadDashboard(await currentActor(), project, query)
  return (
    <DashboardPage
      key={project.id}
      {...props}
      view={query.view === 'items' ? 'items' : 'money'}
    />
  )
}
