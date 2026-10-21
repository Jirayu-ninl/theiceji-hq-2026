import type { Metadata } from 'next'
import { currentActor } from '@/lib/actions'
import { AgentsPage } from '@/modules/agents/components/AgentsPage'
import { loadAgents } from '@/modules/agents/load'
import '@/modules/agents/agents.css'

export const metadata: Metadata = { title: 'Agents — HQ' }
export const dynamic = 'force-dynamic'

/**
 * `/agents` — every routine the owner scheduled, in whichever project or
 * none, their runs and the proposals they left.
 * `?view=runs` · `?view=trash` (deleted routines, restorable); `?routine=<id>` selects.
 */
export default async function AgentsRoute({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; routine?: string }>
}) {
  const props = await loadAgents(await currentActor(), null, await searchParams)
  return <AgentsPage key={props.view} {...props} />
}
