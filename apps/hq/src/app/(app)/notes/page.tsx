import type { Metadata } from 'next'
import { currentActor } from '@/lib/actions'
import { NotesPage } from '@/modules/notes/components/NotesPage'
import { loadNotes } from '@/modules/notes/load'
import '@/modules/notes/notes.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Notes — HQ' }

/**
 * `/notes` — parked thoughts that belong to all of HQ. No
 * agent reads a note unless it is promoted. `?note=<id>` selects one;
 * `?open=<id>` is the same, from Share to Notes; `?new=1` opens New note.
 */
export default async function NotesRoute({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string
    note?: string
    open?: string
    new?: string
  }>
}) {
  const props = await loadNotes(await currentActor(), await searchParams)
  return <NotesPage {...props} />
}
