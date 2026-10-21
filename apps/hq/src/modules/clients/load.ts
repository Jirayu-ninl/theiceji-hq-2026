import 'server-only'
import {
  clientLedger,
  listCardExtras,
  listCards,
} from '@theiceji/hq-board/board'
import '@theiceji/hq-board/register'
import { clientUses, listClients } from '@theiceji/hq-core/clients'
import { listProjects } from '@theiceji/hq-core/projects'
import type { Actor } from '@theiceji/hq-ops/access'
import { zonedDay } from '@theiceji/hq-ops/time'
import { listQuotes } from '@theiceji/hq-quotes/quotes'
import '@theiceji/hq-quotes/register'
import type { ClientsPageProps } from './components/ClientsPage'
import {
  type ClientDetailData,
  clientData,
  detailData,
  ledgerData,
  onceNames,
  projectData,
} from './data'

/**
 * What `/clients` reads on the server: every client, the
 * ledger that counts each baht once (hq-board `clientLedger`), the names
 * typed once on active cards, what points at each client (so Delete can
 * say why not, in place), and — so the first paint is whole — the selected
 * client's cards and quotes. A new selection fetches its detail through
 * `clientDetailAction`.
 */

/** This year as the ledger counts it — Bangkok's calendar, the database's fallback zone. */
export const currentYear = () =>
  zonedDay(new Date(), 'Asia/Bangkok').slice(0, 4)

/** One client's cards (paid ones too) with their follow-ups and payments, and their quotes. */
export async function loadClientDetail(
  actor: Actor,
  clientId: string,
  year = currentYear(),
): Promise<ClientDetailData> {
  const [cards, quotes] = await Promise.all([
    listCards(actor, { clientId, includeArchived: true, limit: 500 }),
    listQuotes(actor, { clientId, limit: 100 }),
  ])
  const extras = await listCardExtras(
    actor,
    cards.map((card) => card.id),
  )
  return detailData(clientId, cards, extras, quotes, `${year}-01-01`)
}

export async function loadClients(
  actor: Actor,
  params: { view?: string; client?: string },
): Promise<ClientsPageProps> {
  const view = params.view === 'archived' ? 'archived' : 'active'
  const year = currentYear()
  const [clients, ledger, projects, active, uses] = await Promise.all([
    listClients(actor, { includeArchived: true }),
    clientLedger(actor),
    listProjects(actor, { includeArchived: true }),
    // Only the active view lists the names used once.
    view === 'active' ? listCards(actor, { limit: 500 }) : Promise.resolve([]),
    clientUses(actor),
  ])
  const shown = clients.filter(
    (client) => Boolean(client.archivedAt) === (view === 'archived'),
  )
  // `?client=` selects; nothing else is read until a row is picked.
  const selected = shown.find((client) => client.id === params.client) ?? null
  return {
    clients: clients.map(clientData),
    ledger: Object.fromEntries(
      ledger.map((row) => [row.clientId, ledgerData(row)]),
    ),
    projects: projects.map(projectData),
    once: onceNames(active, clients),
    uses,
    view,
    year,
    selectedId:
      params.client && shown.some((client) => client.id === params.client)
        ? params.client
        : null,
    detail: selected ? await loadClientDetail(actor, selected.id, year) : null,
  }
}
