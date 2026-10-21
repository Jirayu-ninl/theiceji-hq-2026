import type { Metadata } from 'next'
import { ModuleOff } from '@/components/ModulePending'
import { currentActor } from '@/lib/actions'
import { lite, projectForPage, projectsWith } from '@/lib/project-page'
import { BoardPage } from '@/modules/board/components/BoardPage'
import { loadProjectBoard } from '@/modules/board/load'
import '@/modules/board/board.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Board — HQ' }

/**
 * `/p/<slug>/board` — one project's cards in its kind's lanes.
 * `?view=table` is the table, `?view=archived` and `?view=trash` the
 * cards put away and deleted; `?card=<id>` selects; `?newFor=<client>` opens
 * New card with that client (Clients links here); `#lane-<i>` brings a lane
 * into view.
 */
export default async function ProjectBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<{ view?: string; card?: string; newFor?: string }>
}) {
  const [{ project: slug }, query] = await Promise.all([params, searchParams])
  const project = await projectForPage(slug)
  if (!project.modules.enabled.includes('board')) {
    const others = (await projectsWith('board')).filter(
      (other) => other.id !== project.id,
    )
    return <ModuleOff module='board' project={lite(project)} others={others} />
  }
  const props = await loadProjectBoard(await currentActor(), project, query)
  return <BoardPage key={project.id} {...props} />
}
