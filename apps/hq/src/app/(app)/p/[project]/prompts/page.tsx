import type { Metadata } from 'next'
import { ModuleOff } from '@/components/ModulePending'
import { currentActor } from '@/lib/actions'
import { lite, projectForPage, projectsWith } from '@/lib/project-page'
import { PromptsPage } from '@/modules/prompts/components/PromptsPage'
import { bucketOf, loadPrompts } from '@/modules/prompts/load'
import '@/modules/prompts/prompts.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Prompts — HQ' }

/** `/p/<slug>/prompts` — a project's prompt library. `?prompt=<id>` selects, `?new=1` opens the form, `?view=list|archived|trash`. */
export default async function ProjectPromptsPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<{ view?: string; prompt?: string; new?: string }>
}) {
  const [{ project: slug }, query] = await Promise.all([params, searchParams])
  const project = await projectForPage(slug)
  if (!project.modules.enabled.includes('prompts')) {
    const others = (await projectsWith('prompts')).filter(
      (other) => other.id !== project.id,
    )
    return (
      <ModuleOff module='prompts' project={lite(project)} others={others} />
    )
  }
  const props = await loadPrompts(await currentActor(), project, query)
  return (
    <PromptsPage key={`${project.id}-${bucketOf(props.view)}`} {...props} />
  )
}
