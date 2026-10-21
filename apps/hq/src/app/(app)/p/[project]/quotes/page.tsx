import type { Metadata } from 'next'
import { ModuleOff } from '@/components/ModulePending'
import { currentActor } from '@/lib/actions'
import { lite, projectForPage, projectsWith } from '@/lib/project-page'
import { QuotesPage } from '@/modules/quotes/components/QuotesPage'
import { loadQuotes } from '@/modules/quotes/load'
import '@/modules/quotes/quotes.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Quotes — HQ' }

/**
 * `/p/<slug>/quotes` — a project's quotations.
 * `?quote=<id>` selects; `?new=1&card=<id>` quotes a card; `?view=clients`
 * goes to `/clients`, where HQ's clients now live.
 */
export default async function ProjectQuotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<{
    view?: string
    quote?: string
    new?: string
    card?: string
  }>
}) {
  const [{ project: slug }, query] = await Promise.all([params, searchParams])
  const project = await projectForPage(slug)
  if (!project.modules.enabled.includes('quotes')) {
    const others = (await projectsWith('quotes')).filter(
      (other) => other.id !== project.id,
    )
    return <ModuleOff module='quotes' project={lite(project)} others={others} />
  }
  const props = await loadQuotes(await currentActor(), project, query)
  return <QuotesPage key={`${project.id}-${props.view}`} {...props} />
}
