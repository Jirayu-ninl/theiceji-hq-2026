import 'server-only'
import { getProjectBySlug, listProjects } from '@theiceji/hq-core/projects'
import type { UserRole } from '@theiceji/hq-db/enums'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import { userActor } from '@theiceji/hq-ops/access'
import { OpsError } from '@theiceji/hq-ops/errors'
import { redirect } from 'next/navigation'
import { cache } from 'react'
import type { ProjectLite } from '@/modules'
import { currentActor } from './actions'

// A page and its `generateMetadata` both ask; one read per request.
const projectBySlug = cache((userId: string, role: UserRole, slug: string) =>
  getProjectBySlug(userActor({ id: userId, role }), slug),
)

/**
 * The project a `/p/<slug>/…` page is for. A slug that isn't one of yours —
 * a stale link, someone else's — lands on the project list, which says so
 * (the rule the legacy screens keep too).
 */
export async function projectForPage(slug: string): Promise<ProjectRow> {
  const actor = await currentActor()
  try {
    return await projectBySlug(actor.userId, actor.role, slug)
  } catch (error) {
    if (error instanceof OpsError && error.code === 'not_found')
      redirect('/projects?missing=1')
    throw error
  }
}

export const lite = (project: ProjectRow): ProjectLite => ({
  id: project.id,
  slug: project.slug,
  name: project.name,
  kind: project.kind,
  status: project.status,
  color: project.color,
  modules: { enabled: project.modules.enabled },
})

/** The owner's other projects that have a module on — for an off-state's picks. */
export async function projectsWith(module: string): Promise<ProjectLite[]> {
  const actor = await currentActor()
  const all = await listProjects(actor)
  return all
    .filter((project) => project.modules.enabled.includes(module))
    .map(lite)
}
