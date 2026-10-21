import 'server-only'
import {
  listBoards,
  listCardExtras,
  listCards,
  openBoard,
} from '@theiceji/hq-board/board'
import '@theiceji/hq-board/register'
import { listClients } from '@theiceji/hq-core/clients'
import { listProjects } from '@theiceji/hq-core/projects'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { zonedDay } from '@theiceji/hq-ops/time'
import type { BoardPageProps, BoardProject } from './components/BoardPage'
import {
  cardData,
  clientOption,
  followupData,
  laneData,
  paymentData,
} from './data'

/**
 * What a Board page reads on the server: one project's board (made on the
 * owner's first open), or every project's cards and lanes for `/board` —
 * with the cards' follow-ups and payment lines, and the owner's clients for
 * the Client field (archived ones too, so old cards keep their names).
 * `?view=archived` and `?view=trash` read those cards instead of the live
 * ones. "Today" is each project's own date, on this server's clock — it is
 * only shown, never stored.
 */

export function boardProject(project: ProjectRow): BoardProject {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    color: project.color,
    kind: project.kind,
    status: project.status,
    currency: project.currency,
    today: zonedDay(new Date(), project.timezone),
    modules: project.modules.enabled,
  }
}

/** Clients for the Client field; a reader without Board/Quotes scope simply gets none. */
async function clientsFor(actor: Actor) {
  try {
    return (await listClients(actor, { includeArchived: true })).map(
      clientOption,
    )
  } catch {
    return []
  }
}

/** `?view=`: Lanes (the default), Table, Archived or Trash. */
function viewOf(raw: string | undefined): BoardPageProps['view'] {
  return raw === 'table' || raw === 'archived' || raw === 'trash'
    ? raw
    : 'lanes'
}

/** Archived and Trash read their own cards, newest first; lanes only name them. */
function shelfOf(view: BoardPageProps['view']): 'archived' | 'trash' | null {
  return view === 'archived' || view === 'trash' ? view : null
}

export async function loadProjectBoard(
  actor: Actor,
  project: ProjectRow,
  params: { view?: string; card?: string; newFor?: string },
): Promise<BoardPageProps> {
  const view = viewOf(params.view)
  const shelf = shelfOf(view)
  const base = {
    project: boardProject(project),
    projects: [boardProject(project)],
    view,
    selectedId: params.card ?? null,
    newFor: params.newFor ?? null,
  }
  if (shelf) {
    const [boards, cards, clients] = await Promise.all([
      listBoards(actor),
      listCards(actor, { projectId: project.id, bucket: shelf, limit: 500 }),
      clientsFor(actor),
    ])
    const extras = await listCardExtras(
      actor,
      cards.map((card) => card.id),
    )
    const board = boards.find((entry) => entry.projectId === project.id)
    return {
      ...base,
      lanes: { [project.id]: board?.lanes.map(laneData) ?? [] },
      cards: cards.map(cardData),
      followups: extras.followups.map(followupData),
      payments: extras.payments.map(paymentData),
      links: extras.links,
      clients,
    }
  }
  const [board, clients] = await Promise.all([
    openBoard(actor, project.id),
    clientsFor(actor),
  ])
  return {
    ...base,
    lanes: { [project.id]: board?.lanes.map(laneData) ?? [] },
    cards: board?.cards.map(cardData) ?? [],
    followups: board?.followups.map(followupData) ?? [],
    payments: board?.payments.map(paymentData) ?? [],
    links: board?.links ?? [],
    clients,
  }
}

export async function loadAllBoards(
  actor: Actor,
  params: { view?: string; card?: string; newFor?: string },
): Promise<BoardPageProps> {
  const view = viewOf(params.view)
  const shelf = shelfOf(view)
  const [projects, boards, cards, clients] = await Promise.all([
    listProjects(actor),
    listBoards(actor),
    listCards(actor, shelf ? { bucket: shelf, limit: 500 } : {}),
    clientsFor(actor),
  ])
  const extras = await listCardExtras(
    actor,
    cards.map((card) => card.id),
  )
  const withBoard = projects.filter((project) =>
    project.modules.enabled.includes('board'),
  )
  return {
    project: null,
    projects: withBoard.map(boardProject),
    lanes: Object.fromEntries(
      boards.map((entry) => [entry.projectId, entry.lanes.map(laneData)]),
    ),
    cards: cards.map(cardData),
    followups: extras.followups.map(followupData),
    payments: extras.payments.map(paymentData),
    links: extras.links,
    clients,
    // Lanes need one project: the everywhere page's first view is the table.
    view: view === 'lanes' ? 'table' : view,
    selectedId: params.card ?? null,
    newFor: params.newFor ?? null,
  }
}
