import { fromMinor, sumAmounts, toMinor } from '@theiceji/hq-core/money'
import {
  type AgeReading,
  pickAtAge,
  registerMoneySource,
  registerSubject,
  type SubjectSummary,
} from '@theiceji/hq-core/readings'
import { everyWord, registerSearch } from '@theiceji/hq-core/search'
import {
  projects,
  publishAccounts,
  publishPosts,
  publishReadings,
} from '@theiceji/hq-db/schema'
import type { Reader } from '@theiceji/hq-ops/db'
import { registerTickStep } from '@theiceji/hq-ops/runtime'
import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { PLATFORM_RULES } from './payload'
import { reconcilePublishing } from './publish'
import { isCurrent, KNOWN_METRICS } from './readings'

/**
 * What Publish adds to HQ's shared registries when it loads — import this
 * once in every process that runs module services (apps/hq, apps/hq-mcp):
 *
 * · posts in `hq_search` and the ⌘K palette;
 * · posts as experiment subjects, read at an age (hq-core readings);
 * · earnings readings as money lines for the dashboard and Home;
 * · the `publish.reconcile` tick step: dispatches read back, lapsed
 *   clearances returned to planned.
 */

export const postHref = (slug: string, postId: string) =>
  `/p/${slug}/publish?post=${postId}`

const titleOf = (post: { title: string | null; caption: string }) =>
  post.title?.trim() ||
  post.caption.trim().split('\n')[0]?.slice(0, 80) ||
  'Untitled post'

registerSearch({
  type: 'post',
  label: 'Posts',
  async search(reader, { ownerId, words, projectId, limit }) {
    const rows = await reader
      .select({
        id: publishPosts.id,
        title: publishPosts.title,
        caption: publishPosts.caption,
        status: publishPosts.status,
        projectId: publishPosts.projectId,
        slug: projects.slug,
        handle: publishAccounts.handle,
      })
      .from(publishPosts)
      .innerJoin(projects, eq(projects.id, publishPosts.projectId))
      .innerJoin(
        publishAccounts,
        eq(publishAccounts.id, publishPosts.accountId),
      )
      .where(
        and(
          eq(publishPosts.ownerId, ownerId),
          projectId ? eq(publishPosts.projectId, projectId) : undefined,
          everyWord(
            [publishPosts.title, publishPosts.caption, publishAccounts.handle],
            words,
          ),
        ),
      )
      .orderBy(desc(publishPosts.updatedAt))
      .limit(limit)
    return rows.map((row) => ({
      type: 'post',
      id: row.id,
      title: titleOf(row),
      projectId: row.projectId,
      href: postHref(row.slug, row.id),
      detail: `${row.status} · ${row.handle}`,
    }))
  },
})

async function describePosts(
  reader: Reader,
  ownerId: string,
  where: ReturnType<typeof and>,
  limit: number,
): Promise<SubjectSummary[]> {
  const rows = await reader
    .select({
      id: publishPosts.id,
      projectId: publishPosts.projectId,
      title: publishPosts.title,
      caption: publishPosts.caption,
      status: publishPosts.status,
      postedAt: publishPosts.postedAt,
      platform: publishAccounts.platform,
      handle: publishAccounts.handle,
      slug: projects.slug,
    })
    .from(publishPosts)
    .innerJoin(publishAccounts, eq(publishAccounts.id, publishPosts.accountId))
    .innerJoin(projects, eq(projects.id, publishPosts.projectId))
    .where(and(eq(publishPosts.ownerId, ownerId), where))
    .orderBy(
      sql`coalesce(${publishPosts.postedAt}, ${publishPosts.createdAt}) desc`,
    )
    .limit(limit)
  return rows.map((row) => ({
    type: 'post',
    id: row.id,
    projectId: row.projectId,
    title: titleOf(row),
    where: `${PLATFORM_RULES[row.platform].label} · ${row.handle}`,
    status: row.status,
    // Only a post on the record counts as out.
    wentOutAt: ['posted', 'verified', 'removed'].includes(row.status)
      ? row.postedAt
      : null,
    href: postHref(row.slug, row.id),
  }))
}

type Spanned = {
  postId: string | null
  window: 'lifetime' | 'interval'
  value: string
  currency: string | null
  asOf: Date | null
  windowEnd: Date | null
}

/** Current readings of one metric on some posts. */
async function readingsOf(
  reader: Reader,
  ownerId: string,
  ids: readonly string[],
  metric: string,
): Promise<Spanned[]> {
  return reader
    .select({
      postId: publishReadings.postId,
      window: publishReadings.window,
      value: publishReadings.value,
      currency: publishReadings.currency,
      asOf: publishReadings.asOf,
      windowEnd: publishReadings.windowEnd,
    })
    .from(publishReadings)
    .where(
      and(
        eq(publishReadings.ownerId, ownerId),
        inArray(publishReadings.postId, [...ids]),
        eq(publishReadings.metric, metric),
        isCurrent(),
      ),
    )
}

/** The sum of spans (money) that ended by `until`, exactly — never floats. */
function sumSpans(spans: readonly Spanned[], until: number): AgeReading {
  const ended = spans.filter(
    (row) =>
      row.window === 'interval' &&
      row.windowEnd &&
      row.windowEnd.getTime() <= until,
  )
  if (ended.length === 0) return { state: 'not_read' }
  const currency = ended[0]?.currency ?? null
  const total = currency
    ? sumAmounts(
        ended.map((row) => row.value),
        currency,
      )
    : fromMinor(
        ended.reduce((sum, row) => sum + toMinor(row.value, 4), 0n),
        4,
      ).replace(/\.?0+$/, '')
  return {
    state: 'known',
    value: total,
    asOf: new Date(
      Math.max(...ended.map((row) => (row.windowEnd as Date).getTime())),
    ),
    currency,
  }
}

const lifetimeOf = (rows: readonly Spanned[]) =>
  rows
    .filter((row) => row.window === 'lifetime' && row.asOf)
    .map((row) => ({
      asOf: row.asOf as Date,
      value: row.value,
      currency: row.currency,
    }))

registerSubject({
  type: 'post',
  module: 'publish',
  metrics: KNOWN_METRICS,
  describe: (reader, ownerId, ids) =>
    ids.length
      ? describePosts(
          reader,
          ownerId,
          inArray(publishPosts.id, [...ids]),
          ids.length,
        )
      : Promise.resolve([]),
  list: (reader, ownerId, { projectId, limit }) =>
    describePosts(
      reader,
      ownerId,
      projectId ? eq(publishPosts.projectId, projectId) : undefined,
      limit,
    ),
  async atAge(reader, ownerId, ids, metric, ageHours, now) {
    const out = new Map<string, AgeReading>()
    if (ids.length === 0) return out
    const [posts, readings] = await Promise.all([
      describePosts(
        reader,
        ownerId,
        inArray(publishPosts.id, [...ids]),
        ids.length,
      ),
      readingsOf(reader, ownerId, ids, metric),
    ])
    for (const post of posts) {
      const mine = readings.filter((row) => row.postId === post.id)
      const lifetime = lifetimeOf(mine)
      const judged = pickAtAge(lifetime, post.wentOutAt, ageHours, now)
      // Spans (money): the sum of what ended by that age.
      if (
        lifetime.length === 0 &&
        judged.state === 'not_read' &&
        post.wentOutAt &&
        mine.some((row) => row.window === 'interval')
      )
        out.set(
          post.id,
          sumSpans(mine, post.wentOutAt.getTime() + ageHours * 3_600_000),
        )
      else out.set(post.id, judged)
    }
    return out
  },
  async latest(reader, ownerId, ids, metric, now) {
    const out = new Map<string, AgeReading>()
    if (ids.length === 0) return out
    const [posts, readings] = await Promise.all([
      describePosts(
        reader,
        ownerId,
        inArray(publishPosts.id, [...ids]),
        ids.length,
      ),
      readingsOf(reader, ownerId, ids, metric),
    ])
    for (const post of posts) {
      if (!post.wentOutAt) {
        out.set(post.id, { state: 'not_out' })
        continue
      }
      const mine = readings.filter((row) => row.postId === post.id)
      const newest = lifetimeOf(mine).sort(
        (a, b) => b.asOf.getTime() - a.asOf.getTime(),
      )[0]
      out.set(
        post.id,
        newest
          ? {
              state: 'known',
              value: newest.value,
              asOf: newest.asOf,
              currency: newest.currency ?? null,
            }
          : sumSpans(mine, now.getTime()),
      )
    }
    return out
  },
})

registerMoneySource({
  module: 'publish',
  async lines(reader, ownerId, { from, to, projectId }) {
    const rows = await reader
      .select({
        projectId: publishReadings.projectId,
        currency: publishReadings.currency,
        value: publishReadings.value,
        at: publishReadings.windowEnd,
      })
      .from(publishReadings)
      .where(
        and(
          eq(publishReadings.ownerId, ownerId),
          projectId ? eq(publishReadings.projectId, projectId) : undefined,
          eq(publishReadings.window, 'interval'),
          isNotNull(publishReadings.currency),
          gte(publishReadings.windowEnd, from),
          lt(publishReadings.windowEnd, to),
          isCurrent(),
        ),
      )
    return rows.map((row) => ({
      module: 'publish' as const,
      projectId: row.projectId,
      kind: 'earnings' as const,
      currency: row.currency as string,
      amount: row.value,
      at: row.at as Date,
    }))
  },
})

registerTickStep('publish.reconcile', () => reconcilePublishing({ limit: 10 }))
