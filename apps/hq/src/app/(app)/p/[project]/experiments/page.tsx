import type { Metadata } from 'next'
import { ModuleOff } from '@/components/ModulePending'
import { currentActor } from '@/lib/actions'
import { lite, projectForPage, projectsWith } from '@/lib/project-page'
import { ExperimentsPage } from '@/modules/experiments/components/ExperimentsPage'
import { loadExperiments } from '@/modules/experiments/load'
import '@/modules/experiments/experiments.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Experiments — HQ' }

/**
 * `/p/<slug>/experiments` — one question asked once.
 * `?view=learnings&q=`; `?experiment=<id>` selects.
 */
export default async function ProjectExperimentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<{ view?: string; experiment?: string; q?: string }>
}) {
  const [{ project: slug }, query] = await Promise.all([params, searchParams])
  const project = await projectForPage(slug)
  if (!project.modules.enabled.includes('experiments')) {
    const others = (await projectsWith('experiments')).filter(
      (other) => other.id !== project.id,
    )
    return (
      <ModuleOff module='experiments' project={lite(project)} others={others} />
    )
  }
  const props = await loadExperiments(await currentActor(), project, query)
  return <ExperimentsPage key={`${project.id}-${props.view}`} {...props} />
}
