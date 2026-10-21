import type { Metadata } from 'next'
import { currentActor } from '@/lib/actions'
import { QuotesPage } from '@/modules/quotes/components/QuotesPage'
import { loadQuotes } from '@/modules/quotes/load'
import '@/modules/quotes/quotes.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Quotes — HQ' }

/** `/quotes` — every project's quotations and the clients they go to. */
export default async function AllQuotesPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string
    quote?: string
    new?: string
    card?: string
  }>
}) {
  const props = await loadQuotes(await currentActor(), null, await searchParams)
  return <QuotesPage key={props.view} {...props} />
}
