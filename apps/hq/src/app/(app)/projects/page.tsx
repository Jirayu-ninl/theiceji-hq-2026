import { listProjects } from '@theiceji/hq-core/projects'
import { getDb } from '@theiceji/hq-db'
import { opsHumanRequests } from '@theiceji/hq-db/schema'
import { and, eq, sql } from 'drizzle-orm'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import {
  ProjectsView,
  type ProjectsViewName,
} from '@/components/projects/ProjectsView'
import { currentActor } from '@/lib/actions'
import './projects.css'

export const metadata: Metadata = { title: 'Projects — HQ' }
export const dynamic = 'force-dynamic'

/**
 * Every project in the owner's order, and the inspector that creates or
 * shapes one.
 * Views: Active · Archived (`?view=archived`) · Trash (`?view=trash`, the
 * one place a deleted project is listed). `?new=1` opens the form; `?id=`
 * selects; `?missing=1` says a link pointed at a project that isn't there.
 */
export default async function ProjectsPage({
  searchParams,
}: {
  // `new`, `id` and `missing` belong to the view (ProjectsView reads them).
  searchParams: Promise<{ view?: string; show?: string; id?: string }>
}) {
  const params = await searchParams
  // The Archived view was `?show=archived` until 2026-09-29; old links
  // (bookmarks, a tab left open) still land on it.
  if (params.show === 'archived') {
    const next = new URLSearchParams({ view: 'archived' })
    if (params.id) next.set('id', params.id)
    redirect(`/projects?${next}`)
  }
  const view: ProjectsViewName =
    params.view === 'archived' || params.view === 'trash'
      ? params.view
      : 'active'
  const actor = await currentActor()
  const all = await listProjects(actor, {
    includeArchived: true,
    includeTrash: true,
  })
  const viewOf = (project: (typeof all)[number]): ProjectsViewName =>
    project.deletedAt
      ? 'trash'
      : project.status === 'archived'
        ? 'archived'
        : 'active'
  const db = getDb()
  const waiting = db
    ? await db
        .select({
          projectId: opsHumanRequests.projectId,
          n: sql<number>`count(*)::int`,
        })
        .from(opsHumanRequests)
        .where(
          and(
            eq(opsHumanRequests.ownerId, actor.userId),
            eq(opsHumanRequests.status, 'open'),
          ),
        )
        .groupBy(opsHumanRequests.projectId)
    : []
  const counts = Object.fromEntries(
    waiting.map((row) => [row.projectId ?? '', row.n]),
  )
  return (
    <ProjectsView
      projects={all
        .filter((project) => viewOf(project) === view)
        .map((project) => ({
          id: project.id,
          slug: project.slug,
          name: project.name,
          kind: project.kind,
          status: project.status,
          color: project.color,
          revision: project.revision,
          enabled: project.modules.enabled,
          storageProvider: project.storageProvider,
          storageRoot: project.storageRoot,
          timezone: project.timezone,
          currency: project.currency,
          waiting: counts[project.id] ?? 0,
          deletedAt: project.deletedAt?.toISOString() ?? null,
        }))}
      counts={{
        active: all.filter((project) => viewOf(project) === 'active').length,
        archived: all.filter((project) => viewOf(project) === 'archived')
          .length,
        trash: all.filter((project) => viewOf(project) === 'trash').length,
      }}
      view={view}
    />
  )
}
