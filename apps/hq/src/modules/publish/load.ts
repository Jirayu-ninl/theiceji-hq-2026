import 'server-only'
import { subjectProvider } from '@theiceji/hq-core/readings'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { dbNow } from '@theiceji/hq-ops/db'
import { withReader } from '@theiceji/hq-ops/store'
import { getPost, listAccounts, listPosts } from '@theiceji/hq-publish/publish'
import '@theiceji/hq-publish/register'
import { connectionOptions, fileOptions } from '@/lib/module-page'
import { type AgeReadingData, ageReadingData } from '@/modules/experiments/data'
import type { PublishPageProps } from './components/PublishPage'
import {
  accountData,
  type PostDetailData,
  postDetailData,
  postRowData,
} from './data'

/** The ages the ruler marks, in hours: 1h · 24h · 72h · 7d. */
export const RULER_AGES = [1, 24, 72, 168] as const

/**
 * Views at each ruler age for these posts, judged now (a
 * reading counts within [0.75 × age, age]); words where there is no number.
 */
export async function viewsAtAges(
  actor: Actor,
  ids: string[],
): Promise<{
  readAt: string
  ages: Record<string, Record<string, AgeReadingData>>
}> {
  const provider = subjectProvider('post')
  return withReader(async (db) => {
    const now = await dbNow(db)
    const ages: Record<string, Record<string, AgeReadingData>> = {}
    if (provider && ids.length)
      for (const age of RULER_AGES) {
        const read = await provider.atAge(
          db,
          actor.userId,
          ids,
          'views',
          age,
          now,
        )
        for (const id of ids) {
          ages[id] ??= {}
          ;(ages[id] as Record<string, AgeReadingData>)[String(age)] =
            ageReadingData(read.get(id) ?? { state: 'not_read' })
        }
      }
    return { readAt: now.toISOString(), ages }
  })
}

/**
 * What the Publish page reads on the server: the project's accounts and
 * posts, the selected post whole (so a shared link opens straight into it),
 * the project's ready files for the new-post form and the owner's platform
 * connections for the account form.
 */
export async function loadPublish(
  actor: Actor,
  project: ProjectRow,
  params: { view?: string; post?: string; new?: string },
): Promise<PublishPageProps> {
  const [accounts, posts, files, connections] = await Promise.all([
    listAccounts(actor, { projectId: project.id, includeArchived: true }),
    listPosts(actor, { projectId: project.id, limit: 300 }),
    fileOptions(actor, project.id, ['video', 'image']),
    connectionOptions(actor, ['facebook', 'youtube', 'tiktok']),
  ])
  const { readAt, ages } = await viewsAtAges(
    actor,
    posts.map((post) => post.id),
  )
  let detail: PostDetailData | null = null
  if (params.post) {
    try {
      detail = postDetailData(await getPost(actor, params.post))
    } catch {
      detail = null
    }
  }
  return {
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      color: project.color,
      status: project.status,
      timezone: project.timezone,
    },
    accounts: accounts.map(accountData),
    posts: posts.map(postRowData),
    ages,
    readAt,
    detail,
    files,
    connections,
    view: params.view === 'accounts' ? 'accounts' : 'posts',
    selectedId: params.post ?? null,
    creating: params.new === '1',
  }
}
