import 'server-only'
import { getCard } from '@theiceji/hq-board/board'
import { listClients } from '@theiceji/hq-core/clients'
import { listProjects } from '@theiceji/hq-core/projects'
import { getOwnerSettings } from '@theiceji/hq-core/settings'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { getQuote, listQuotes } from '@theiceji/hq-quotes/quotes'
import '@theiceji/hq-quotes/register'
import { redirect } from 'next/navigation'
import type { QuotesPageProps } from './components/QuotesPage'
import {
  clientData,
  type QuoteDetailData,
  type QuoteProject,
  quoteDetailData,
  quoteRowData,
} from './data'

/**
 * What a Quotes page reads on the server. `?new=1&card=<id>` opens the new
 * quote form filled from a board card — read here through Board, because
 * the quotes package never reads another module's tables; `?new=1&client=<id>`
 * opens it for a client (Clients' ＋ Quote). Clients are HQ-wide, so the old
 * `?view=clients` goes to `/clients`.
 */

const project = (row: ProjectRow): QuoteProject => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  color: row.color,
  status: row.status,
  currency: row.currency,
})

export async function loadQuotes(
  actor: Actor,
  row: ProjectRow | null,
  params: {
    view?: string
    quote?: string
    new?: string
    card?: string
    client?: string
  },
): Promise<QuotesPageProps> {
  if (params.view === 'clients') redirect('/clients')
  const [quotes, clients, settings, projects] = await Promise.all([
    listQuotes(actor, row ? { projectId: row.id, limit: 300 } : { limit: 300 }),
    listClients(actor, { includeArchived: true }),
    getOwnerSettings(actor),
    row ? Promise.resolve([row]) : listProjects(actor),
  ])
  let fromCard: QuotesPageProps['fromCard'] = null
  if (params.new === '1' && params.card) {
    try {
      const { card } = await getCard(actor, params.card)
      // A card in the Trash isn't work any more; the form starts empty.
      if (card.deletedAt) throw new Error('card in the Trash')
      fromCard = {
        id: card.id,
        title: card.title,
        price: card.price,
        client: card.client,
        clientId: card.clientId,
        projectId: card.projectId,
      }
    } catch {
      fromCard = null
    }
  }
  // The selected quote arrives whole, so a shared link opens straight into it.
  let detail: QuoteDetailData | null = null
  if (params.quote) {
    try {
      detail = quoteDetailData(await getQuote(actor, params.quote))
    } catch {
      detail = null
    }
  }
  return {
    project: row ? project(row) : null,
    projects: projects
      .filter((entry) => entry.modules.enabled.includes('quotes'))
      .map(project),
    quotes: quotes.map(quoteRowData),
    detail,
    clients: clients.map(clientData),
    issuer: settings.quoteIssuer,
    view: 'quotes',
    selectedId: params.quote ?? null,
    creating: params.new === '1',
    fromCard,
    newClientId: params.new === '1' ? (params.client ?? null) : null,
  }
}
