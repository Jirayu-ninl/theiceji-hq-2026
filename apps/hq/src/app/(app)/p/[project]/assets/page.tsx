import type { Metadata } from 'next'
import { ModuleOff } from '@/components/ModulePending'
import { currentActor } from '@/lib/actions'
import { lite, projectForPage, projectsWith } from '@/lib/project-page'
import { AssetsPage } from '@/modules/assets/components/AssetsPage'
import { loadProjectAssets } from '@/modules/assets/load'
import '@/modules/assets/assets.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Assets — HQ' }

/**
 * `/p/<slug>/assets` — one project's files. `?view=list`
 * or `?view=collections`; `?asset=<id>` selects an asset, `?collection=<id>`
 * a collection in Collections.
 */
export default async function ProjectAssetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<{ view?: string; asset?: string; collection?: string }>
}) {
  const [{ project: slug }, query] = await Promise.all([params, searchParams])
  const project = await projectForPage(slug)
  if (!project.modules.enabled.includes('assets')) {
    const others = (await projectsWith('assets')).filter(
      (other) => other.id !== project.id,
    )
    return <ModuleOff module='assets' project={lite(project)} others={others} />
  }
  const props = await loadProjectAssets(await currentActor(), project, query)
  return <AssetsPage key={project.id} {...props} />
}
