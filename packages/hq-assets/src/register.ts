import { everyWord, registerSearch } from '@theiceji/hq-core/search'
import { type AssetRow, assetAssets, projects } from '@theiceji/hq-db/schema'
import { schedulerActor } from '@theiceji/hq-ops/actors'
import { database } from '@theiceji/hq-ops/db'
import { registerTickStep } from '@theiceji/hq-ops/runtime'
import { audit, withTransaction } from '@theiceji/hq-ops/store'
import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { providerOf } from './assets'
import { collectGeneratorVideos } from './generate'
import { settleOrphanJobs } from './jobs'

/**
 * What Assets adds to HQ's registries when it loads (import once per
 * process that runs module services):
 *
 * · assets in `hq_search` and the ⌘K palette;
 * · the `assets.check` tick step: once a day per file, a
 *   ready file in the owner's Drive is looked for — one the owner moved or
 *   deleted in Drive becomes `rejected`, with the reason — and an upload left
 *   `pending` for a week is rejected so it stops waiting.
 */

export const assetHref = (slug: string | null, assetId: string) =>
  slug ? `/p/${slug}/assets?asset=${assetId}` : `/assets?asset=${assetId}`

registerSearch({
  type: 'asset',
  label: 'Assets',
  async search(reader, { ownerId, words, projectId, limit }) {
    const rows = await reader
      .select({
        id: assetAssets.id,
        name: assetAssets.name,
        title: assetAssets.title,
        kind: assetAssets.kind,
        projectId: assetAssets.projectId,
        slug: projects.slug,
      })
      .from(assetAssets)
      .leftJoin(projects, eq(projects.id, assetAssets.projectId))
      .where(
        and(
          eq(assetAssets.ownerId, ownerId),
          eq(assetAssets.status, 'ready'),
          projectId ? eq(assetAssets.projectId, projectId) : undefined,
          everyWord(
            [assetAssets.name, assetAssets.title, assetAssets.path],
            words,
          ),
        ),
      )
      .orderBy(desc(assetAssets.createdAt))
      .limit(limit)
    return rows.map((row) => ({
      type: 'asset',
      id: row.id,
      title: row.title ?? row.name,
      projectId: row.projectId,
      href: assetHref(row.slug, row.id),
      detail: row.kind,
    }))
  },
})

/** How many Drive files one tick looks for — the rest wait for the next. */
const CHECKS_PER_TICK = 20

async function reject(asset: AssetRow, problem: string): Promise<void> {
  const actor = schedulerActor(asset.ownerId)
  await withTransaction(async (tx) => {
    const [row] = await tx
      .update(assetAssets)
      .set({
        status: 'rejected',
        problem,
        revision: sql`${assetAssets.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(assetAssets.id, asset.id),
          eq(assetAssets.revision, asset.revision),
        ),
      )
      .returning()
    if (!row) return
    await audit(tx, actor, {
      projectId: asset.projectId,
      action: 'asset.vanished',
      targetType: 'asset',
      targetId: asset.id,
      beforeRevision: asset.revision,
      afterRevision: row.revision,
      reason: problem,
    })
  })
}

registerTickStep('assets.check', async () => {
  const db = database()
  const stale = await db
    .select()
    .from(assetAssets)
    .where(
      and(
        eq(assetAssets.status, 'pending'),
        lt(assetAssets.createdAt, sql`now() - interval '7 days'`),
      ),
    )
    .limit(CHECKS_PER_TICK)
  for (const asset of stale)
    await reject(asset, 'The upload never finished within a week.')

  const due = await db
    .select({ asset: assetAssets, project: projects })
    .from(assetAssets)
    .leftJoin(projects, eq(projects.id, assetAssets.projectId))
    .where(
      and(
        eq(assetAssets.status, 'ready'),
        eq(assetAssets.storageProvider, 'gdrive'),
        or(
          isNull(assetAssets.checkedAt),
          lt(assetAssets.checkedAt, sql`now() - interval '1 day'`),
        ),
      ),
    )
    .orderBy(asc(assetAssets.checkedAt))
    .limit(CHECKS_PER_TICK)
  let checked = 0
  let vanished = 0
  for (const { asset, project } of due) {
    try {
      const provider = await providerOf(db, asset, project)
      const head = await provider.head(asset.storageKey)
      if (!head) {
        vanished++
        await reject(
          asset,
          'The file is no longer in your Google Drive — it was moved or deleted there.',
        )
        continue
      }
      checked++
      await db
        .update(assetAssets)
        .set({ checkedAt: sql`now()` })
        .where(eq(assetAssets.id, asset.id))
    } catch {
      // Google unreachable or not connected: the connection says so in
      // Settings; the file isn't judged missing on a failed look.
    }
  }
  return { stalePending: stale.length, checked, vanished }
})

registerTickStep('assets.jobs', async () => ({
  orphaned: await settleOrphanJobs(),
  videosCollected: await collectGeneratorVideos(5),
}))
