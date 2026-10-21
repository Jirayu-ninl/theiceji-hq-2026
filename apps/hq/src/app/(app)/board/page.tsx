import type { Metadata } from 'next'
import { currentActor } from '@/lib/actions'
import { BoardPage } from '@/modules/board/components/BoardPage'
import { loadAllBoards } from '@/modules/board/load'
import '@/modules/board/board.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Board — HQ' }

/**
 * `/board` — every project's cards in one table, with what waits for
 * payment across all of them. Lanes need one project, so
 * the everywhere page is the table only; `?view=archived` and
 * `?view=trash` list every project's archived and deleted cards.
 */
export default async function AllBoardsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; card?: string; newFor?: string }>
}) {
  const props = await loadAllBoards(await currentActor(), await searchParams)
  return <BoardPage {...props} />
}
