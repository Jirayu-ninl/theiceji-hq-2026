import { KIND_LABEL, orderedModules } from '@theiceji/hq-core/modules'
import { getDb } from '@theiceji/hq-db'
import { PROJECT_COLORS, type ProjectColor } from '@theiceji/hq-db/enums'
import { opsHumanRequests, opsTasks } from '@theiceji/hq-db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ProjectMap } from '@/components/project/Map'
import { currentActor } from '@/lib/actions'
import { loadProjectMap } from '@/lib/project-map'
import { projectForPage } from '@/lib/project-page'
import { MODULES, projectModuleHref } from '@/modules'
import './project.css'

export const dynamic = 'force-dynamic'

type Params = Promise<{ project: string }>
type SearchParams = Promise<Record<string, string | string[] | undefined>>

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { project } = await params
  return { title: `${(await projectForPage(project)).name} — HQ` }
}

/**
 * `/p/<slug>` — one project, two views. **Map** (the
 * default) draws the kind's pipeline as LCD nodes joined by `refs`;
 * **Modules** (`?view=modules`) is the plain table — the project's modules
 * in rail order with what waits and is open in each — and the easier read
 * on a phone.
 */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { project: slug } = await params
  const { view } = await searchParams
  const project = await projectForPage(slug)
  if (view !== 'modules')
    return (
      <ProjectMap
        slug={project.slug}
        data={await loadProjectMap(await currentActor(), project)}
      />
    )
  const modules = orderedModules(project.kind, project.modules.enabled)
  const db = getDb()
  const [waiting, tasks] = db
    ? await Promise.all([
        db
          .select({
            module: opsHumanRequests.module,
            n: sql<number>`count(*)::int`,
          })
          .from(opsHumanRequests)
          .where(
            and(
              eq(opsHumanRequests.projectId, project.id),
              eq(opsHumanRequests.status, 'open'),
            ),
          )
          .groupBy(opsHumanRequests.module),
        db
          .select({ module: opsTasks.module, n: sql<number>`count(*)::int` })
          .from(opsTasks)
          .where(
            and(
              eq(opsTasks.projectId, project.id),
              inArray(opsTasks.status, ['open', 'claimed', 'blocked']),
            ),
          )
          .groupBy(opsTasks.module),
      ])
    : [[], []]
  const waitBy = new Map(waiting.map((row) => [row.module ?? '', row.n]))
  const taskBy = new Map(tasks.map((row) => [row.module ?? '', row.n]))
  const totalWaiting = waiting.reduce((sum, row) => sum + row.n, 0)
  const color = PROJECT_COLORS[project.color as ProjectColor]
  return (
    <div className='page project-page'>
      <section className='pane' aria-label={project.name}>
        <header className='pane-head'>
          <span className='hud-label tag'>
            <i
              className='dot'
              style={{ ['--project' as string]: color }}
              aria-hidden='true'
            />
            <span
              lang={/\p{Script=Thai}/u.test(project.name) ? 'th' : undefined}
            >
              {project.name}
            </span>
          </span>
          <span className='dim'>
            {KIND_LABEL[project.kind]}
            {project.status === 'active' ? '' : ` · ${project.status}`}
          </span>
        </header>
        <div className='toolbar'>
          <span className='hits'>
            {modules.length} modules ·{' '}
            {totalWaiting > 0 ? `◆ ${totalWaiting} waiting` : 'nothing waiting'}
          </span>
          <span className='sp' />
          <Link className='btn' href={`/projects?id=${project.id}`}>
            Shape it in Projects
          </Link>
        </div>
        <div className='pane-body'>
          {/* A list of links laid out as a table; each link reads as one sentence. */}
          <div className='tbl module-tbl'>
            <div className='tbl-head' aria-hidden='true'>
              <span />
              <span>Module</span>
              <span className='num'>◆</span>
              <span className='num'>Tasks</span>
            </div>
            {modules.map((id) => {
              const wait = waitBy.get(id) ?? 0
              const tasks = taskBy.get(id) ?? 0
              return (
                <Link
                  key={id}
                  className='tbl-row'
                  href={projectModuleHref(project.slug, id)}
                  aria-label={`${MODULES[id].label}: ${wait} waiting, ${tasks} open tasks`}
                >
                  <span aria-hidden='true'>{MODULES[id].glyph}</span>
                  <span>{MODULES[id].label}</span>
                  <span className={`num${wait > 0 ? ' state-word wait' : ''}`}>
                    {wait > 0 ? `◆ ${wait}` : '0'}
                  </span>
                  <span className='num'>{tasks}</span>
                </Link>
              )
            })}
          </div>
        </div>
      </section>
    </div>
  )
}
