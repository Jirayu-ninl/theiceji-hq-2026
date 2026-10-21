import type { Metadata } from 'next'
import { currentActor } from '@/lib/actions'
import { PromptsPage } from '@/modules/prompts/components/PromptsPage'
import { bucketOf, loadPrompts } from '@/modules/prompts/load'
import '@/modules/prompts/prompts.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Prompts — HQ' }

/** `/prompts` — every project's prompts and the floating ones. `?view=list|archived|trash`. */
export default async function AllPromptsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; prompt?: string; new?: string }>
}) {
  const props = await loadPrompts(
    await currentActor(),
    null,
    await searchParams,
  )
  // Archived and Trash are other lists: a fresh page, no selection carried over.
  return <PromptsPage key={bucketOf(props.view)} {...props} />
}
