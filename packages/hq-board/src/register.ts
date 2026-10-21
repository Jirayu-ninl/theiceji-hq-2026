import { registerMoneySource } from '@theiceji/hq-core/readings'
import { everyWord, registerSearch } from '@theiceji/hq-core/search'
import { registerTarget } from '@theiceji/hq-core/targets'
import {
  boardCardPayments,
  boardCards,
  boardLanes,
  clients,
  projects,
} from '@theiceji/hq-db/schema'
import { day, stringList, text } from '@theiceji/hq-ops/schemas'
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { insertCard } from './board'

/**
 * What Board adds to HQ's shared registries when it loads — import this once
 * in every process that runs module services (apps/hq, apps/hq-mcp):
 *
 * · the `card` target — a note promoted to a card, an agent's accepted
 *   proposal, always into the project's board;
 * · cards in `hq_search` and the ⌘K palette;
 * · card payments as money lines for the dashboard (Readings, Home) — each
 *   deposit, part payment and final counts on the day it came in, never
 *   while the card only waits.
 */

export const cardHref = (slug: string | null, cardId: string) =>
  slug ? `/p/${slug}/board?card=${cardId}` : `/board?card=${cardId}`

registerTarget({
  type: 'card',
  module: 'board',
  label: 'Board · card',
  schema: z.object({
    title: text.required('Title', 200),
    body: text.optional('Body', 20000),
    labels: stringList('labels', 12, 32).optional(),
    price: z.union([z.string(), z.number()]).nullable().optional(),
    dueOn: day('Due date'),
    client: text.optional('Client', 120),
  }),
  async create(payload, { tx, actor, project }) {
    if (!project) throw new Error('A card belongs to a project.')
    const card = await insertCard(tx, actor, project, {
      title: payload.title as string,
      body: payload.body ?? null,
      labels: payload.labels,
      price: payload.price ?? null,
      dueOn: payload.dueOn ?? null,
      client: payload.client ?? null,
    })
    return { type: 'card', id: card.id, href: cardHref(project.slug, card.id) }
  },
})

registerSearch({
  type: 'card',
  label: 'Cards',
  async search(reader, { ownerId, words, projectId, limit }) {
    const rows = await reader
      .select({
        id: boardCards.id,
        title: boardCards.title,
        projectId: boardCards.projectId,
        lane: boardLanes.name,
        slug: projects.slug,
      })
      .from(boardCards)
      .innerJoin(boardLanes, eq(boardLanes.id, boardCards.laneId))
      .leftJoin(projects, eq(projects.id, boardCards.projectId))
      .leftJoin(clients, eq(clients.id, boardCards.clientId))
      .where(
        and(
          eq(boardCards.ownerId, ownerId),
          isNull(boardCards.archivedAt),
          projectId ? eq(boardCards.projectId, projectId) : undefined,
          everyWord(
            [
              boardCards.title,
              boardCards.body,
              boardCards.client,
              clients.name,
            ],
            words,
          ),
        ),
      )
      .orderBy(desc(boardCards.updatedAt))
      .limit(limit)
    return rows.map((row) => ({
      type: 'card',
      id: row.id,
      title: row.title,
      projectId: row.projectId,
      href: cardHref(row.slug, row.id),
      detail: row.lane,
    }))
  },
})

registerMoneySource({
  module: 'board',
  async lines(reader, ownerId, { from, to, projectId }) {
    // A line's instant is the start of its day in the project's own calendar.
    const at = sql<Date>`(${boardCardPayments.receivedOn}::timestamp at time zone coalesce(${projects.timezone}, 'Asia/Bangkok'))`
    const rows = await reader
      .select({
        projectId: boardCardPayments.projectId,
        amount: boardCardPayments.amount,
        currency: boardCardPayments.currency,
        at,
      })
      .from(boardCardPayments)
      .leftJoin(projects, eq(projects.id, boardCardPayments.projectId))
      .where(
        and(
          eq(boardCardPayments.ownerId, ownerId),
          projectId ? eq(boardCardPayments.projectId, projectId) : undefined,
          ne(boardCardPayments.kind, 'void'),
          sql`not exists (select 1 from ${boardCardPayments} as v where v.voids_id = ${boardCardPayments.id})`,
          sql`${at} >= ${from.toISOString()}::timestamptz`,
          sql`${at} < ${to.toISOString()}::timestamptz`,
        ),
      )
    return rows.map((row) => ({
      module: 'board' as const,
      projectId: row.projectId,
      kind: 'paid' as const,
      currency: row.currency,
      amount: row.amount,
      at: new Date(row.at),
    }))
  },
})
