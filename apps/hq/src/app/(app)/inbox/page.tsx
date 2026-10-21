import type { Metadata } from 'next'
import { InboxView } from '@/components/Inbox'
import { currentActor } from '@/lib/actions'
import { loadInboxEntries } from '@/lib/inbox'
import './inbox.css'

export const metadata: Metadata = { title: 'Inbox — HQ' }
export const dynamic = 'force-dynamic'

const KINDS = ['requests', 'proposals', 'problems'] as const

/**
 * `/inbox` — everything that waits for the owner in one queue,
 * filtered by kind (the top bar's views) and by project. The queue is
 * read in lib/inbox.ts, shared with the dock on Home.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>
}) {
  const params = await searchParams
  const kind = KINDS.find((entry) => entry === params.kind) ?? 'all'
  const entries = await loadInboxEntries(await currentActor())
  return <InboxView entries={entries} kind={kind} />
}
