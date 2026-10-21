import { everyWord, registerSearch } from '@theiceji/hq-core/search'
import { clients, projects, quoteQuotes } from '@theiceji/hq-db/schema'
import { registerTickStep } from '@theiceji/hq-ops/runtime'
import { and, desc, eq } from 'drizzle-orm'
import { expireQuotes } from './quotes'

/**
 * What Quotes adds to HQ's shared registries when it loads — import this
 * once in every process that runs module services (apps/hq, apps/hq-mcp):
 *
 * · quotes in `hq_search` and the ⌘K palette, by number, title or client;
 * · the `quotes.expire` tick step: a sent quote past its last valid day (in
 *   its project's timezone) becomes `expired`, audited as the scheduler.
 *
 * The constraint messages live with the service (./quotes.ts), so they are
 * there whenever it runs.
 */

export const quoteHref = (slug: string | null, quoteId: string) =>
  slug ? `/p/${slug}/quotes?quote=${quoteId}` : `/quotes?quote=${quoteId}`

registerSearch({
  type: 'quote',
  label: 'Quotes',
  async search(reader, { ownerId, words, projectId, limit }) {
    const rows = await reader
      .select({
        id: quoteQuotes.id,
        number: quoteQuotes.number,
        title: quoteQuotes.title,
        status: quoteQuotes.status,
        projectId: quoteQuotes.projectId,
        client: clients.name,
        slug: projects.slug,
      })
      .from(quoteQuotes)
      .leftJoin(clients, eq(clients.id, quoteQuotes.clientId))
      .leftJoin(projects, eq(projects.id, quoteQuotes.projectId))
      .where(
        and(
          eq(quoteQuotes.ownerId, ownerId),
          projectId ? eq(quoteQuotes.projectId, projectId) : undefined,
          everyWord(
            [quoteQuotes.number, quoteQuotes.title, clients.name],
            words,
          ),
        ),
      )
      .orderBy(desc(quoteQuotes.createdAt))
      .limit(limit)
    return rows.map((row) => ({
      type: 'quote',
      id: row.id,
      title: `${row.number} · ${row.title}`,
      projectId: row.projectId,
      href: quoteHref(row.slug, row.id),
      detail: [row.status, row.client].filter(Boolean).join(' · '),
    }))
  },
})

registerTickStep('quotes.expire', async () => ({
  expired: await expireQuotes(),
}))
