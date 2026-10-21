import { opsHumanRequests, opsTasks, projects } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import type { Reader } from '@theiceji/hq-ops/db'
import { invalid } from '@theiceji/hq-ops/errors'
import { authorize, ownedProject, withReader } from '@theiceji/hq-ops/store'
import { and, desc, eq, ilike, ne, or } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

/**
 * One search across HQ (`hq_search`, the ⌘K palette). Each record type is a
 * provider registered by the package that owns it, so search never learns a
 * module's tables; core registers projects, and the kernel's requests and
 * tasks. A provider gets the owner, the words and an optional project, and
 * answers in one shape.
 *
 * Matching is case-insensitive `ilike` on each provider's text fields —
 * every word must match somewhere — which is plenty for one owner's records.
 */

export type SearchHit = {
  type: string
  id: string
  title: string
  projectId: string | null
  /** The page that shows it in HQ, when there is one. */
  href: string | null
  detail?: string | null
}

export type SearchProvider = {
  type: string
  label: string
  search(
    reader: Reader,
    query: {
      ownerId: string
      words: string[]
      projectId: string | null
      limit: number
    },
  ): Promise<SearchHit[]>
}

const providers = new Map<string, SearchProvider>()

export function registerSearch(provider: SearchProvider): void {
  providers.set(provider.type, provider)
}

export function searchTypes(): { type: string; label: string }[] {
  return [...providers.values()].map(({ type, label }) => ({ type, label }))
}

/** `ilike` for every word, each matching at least one of the fields. */
export function everyWord(fields: AnyPgColumn[], words: string[]) {
  const likeEscape = (word: string) => word.replace(/[\\%_]/g, (c) => `\\${c}`)
  return and(
    ...words.map((word) =>
      or(...fields.map((field) => ilike(field, `%${likeEscape(word)}%`))),
    ),
  )
}

registerSearch({
  type: 'project',
  label: 'Projects',
  async search(reader, { ownerId, words, limit }) {
    const rows = await reader
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.ownerId, ownerId),
          ne(projects.status, 'archived'),
          everyWord([projects.name, projects.slug], words),
        ),
      )
      .orderBy(projects.position)
      .limit(limit)
    return rows.map((row) => ({
      type: 'project',
      id: row.id,
      title: row.name,
      projectId: row.id,
      href: `/p/${row.slug}`,
      detail: `${row.kind}${row.status === 'paused' ? ' · paused' : ''}`,
    }))
  },
})

registerSearch({
  type: 'human_request',
  label: 'Waiting for you',
  async search(reader, { ownerId, words, projectId, limit }) {
    const rows = await reader
      .select()
      .from(opsHumanRequests)
      .where(
        and(
          eq(opsHumanRequests.ownerId, ownerId),
          projectId ? eq(opsHumanRequests.projectId, projectId) : undefined,
          everyWord([opsHumanRequests.title, opsHumanRequests.reason], words),
        ),
      )
      .orderBy(desc(opsHumanRequests.createdAt))
      .limit(limit)
    return rows.map((row) => ({
      type: 'human_request',
      id: row.id,
      title: row.title,
      projectId: row.projectId,
      href: `/inbox?item=${row.id}`,
      detail: row.status,
    }))
  },
})

registerSearch({
  type: 'task',
  label: 'Tasks',
  async search(reader, { ownerId, words, projectId, limit }) {
    const rows = await reader
      .select()
      .from(opsTasks)
      .where(
        and(
          eq(opsTasks.ownerId, ownerId),
          projectId ? eq(opsTasks.projectId, projectId) : undefined,
          everyWord([opsTasks.title], words),
        ),
      )
      .orderBy(desc(opsTasks.updatedAt))
      .limit(limit)
    return rows.map((row) => ({
      type: 'task',
      id: row.id,
      title: row.title,
      projectId: row.projectId,
      href: null,
      detail: `${row.kind} · ${row.status}`,
    }))
  },
})

export async function searchHq(
  actor: Actor,
  input: {
    query: string
    projectId?: string | null
    types?: string[]
    limit?: number
  },
): Promise<SearchHit[]> {
  const words = input.query.trim().split(/\s+/).filter(Boolean).slice(0, 8)
  if (words.length === 0) throw invalid('Say what to look for.')
  const limit = Math.min(Math.max(input.limit ?? 24, 1), 50)
  const wanted = input.types?.length
    ? input.types.map((type) => {
        const provider = providers.get(type)
        if (!provider)
          throw invalid(
            `HQ can’t search “${type}”. It can search: ${[...providers.keys()].join(', ')}.`,
          )
        return provider
      })
    : [...providers.values()]
  return withReader(async (db) => {
    if (input.projectId)
      await ownedProject(db, actor, input.projectId, 'hq', 'read')
    else await authorize(db, actor, null, 'hq', 'read')
    // Every provider at once (each is one read), kept in registration order.
    const found = await Promise.all(
      wanted.map((provider) =>
        provider.search(db, {
          ownerId: actor.userId,
          words,
          projectId: input.projectId ?? null,
          limit,
        }),
      ),
    )
    const hits: SearchHit[] = found.flat()
    return hits.slice(0, limit)
  })
}
