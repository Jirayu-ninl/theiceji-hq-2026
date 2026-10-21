import type { Metadata } from 'next'
import { ModuleOff } from '@/components/ModulePending'
import { currentActor } from '@/lib/actions'
import { lite, projectForPage, projectsWith } from '@/lib/project-page'
import { StoryPage } from '@/modules/story/components/StoryPage'
import { loadStory } from '@/modules/story/load'
import '@/modules/story/story.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Story — HQ' }

/**
 * `/p/<slug>/story` — a film's script, characters and shot board.
 * `?view=script|characters|shots`; `?shot=<id>` selects.
 */
export default async function ProjectStoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<{ view?: string; shot?: string; character?: string }>
}) {
  const [{ project: slug }, query] = await Promise.all([params, searchParams])
  const project = await projectForPage(slug)
  if (!project.modules.enabled.includes('story')) {
    const others = (await projectsWith('story')).filter(
      (other) => other.id !== project.id,
    )
    return <ModuleOff module='story' project={lite(project)} others={others} />
  }
  const props = await loadStory(await currentActor(), project, query)
  return <StoryPage key={`${project.id}-${props.view}`} {...props} />
}
