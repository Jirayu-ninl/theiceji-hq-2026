import type { Metadata } from 'next'
import { ModuleOff } from '@/components/ModulePending'
import { currentActor } from '@/lib/actions'
import { lite, projectForPage, projectsWith } from '@/lib/project-page'
import { MarketPage } from '@/modules/market/components/MarketPage'
import { loadMarket } from '@/modules/market/load'
import '@/modules/market/market.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Market — HQ' }

/**
 * `/p/<slug>/market` — listings, products and money.
 * `?view=products|money`; `?listing=<id>` or `?product=<id>` selects.
 */
export default async function ProjectMarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<{ view?: string; listing?: string; product?: string }>
}) {
  const [{ project: slug }, query] = await Promise.all([params, searchParams])
  const project = await projectForPage(slug)
  if (!project.modules.enabled.includes('market')) {
    const others = (await projectsWith('market')).filter(
      (other) => other.id !== project.id,
    )
    return <ModuleOff module='market' project={lite(project)} others={others} />
  }
  const props = await loadMarket(await currentActor(), project, query)
  return <MarketPage key={`${project.id}-${props.view}`} {...props} />
}
