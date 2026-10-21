import type { Metadata } from 'next'
import { ModuleOff } from '@/components/ModulePending'
import { currentActor } from '@/lib/actions'
import { lite, projectForPage, projectsWith } from '@/lib/project-page'
import { PublishPage } from '@/modules/publish/components/PublishPage'
import { loadPublish } from '@/modules/publish/load'
import '@/modules/publish/publish.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Publish — HQ' }

/**
 * `/p/<slug>/publish` — a channel's posts and accounts.
 * `?view=accounts`; `?post=<id>` selects; `?new=1` opens the new-post form.
 */
export default async function ProjectPublishPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<{ view?: string; post?: string; new?: string }>
}) {
  const [{ project: slug }, query] = await Promise.all([params, searchParams])
  const project = await projectForPage(slug)
  if (!project.modules.enabled.includes('publish')) {
    const others = (await projectsWith('publish')).filter(
      (other) => other.id !== project.id,
    )
    return (
      <ModuleOff module='publish' project={lite(project)} others={others} />
    )
  }
  const props = await loadPublish(await currentActor(), project, query)
  return <PublishPage key={`${project.id}-${props.view}`} {...props} />
}
