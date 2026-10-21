import { getDb } from '@theiceji/hq-db'
import type { Metadata } from 'next'
import { currentActor } from '@/lib/actions'
import {
  countSets,
  EXPORT_GROUPS,
  exportSets,
  listOwnProjects,
  NOT_EXPORTED,
} from '@/lib/data-export'
import { DataPageView } from './DataPageView'
import './data.css'

export const metadata: Metadata = { title: 'Data — HQ' }
export const dynamic = 'force-dynamic'

/**
 * `/data` — your data, out: every
 * set of records the owner has in HQ, per module and optionally per project,
 * as CSV or JSON. `?project=<slug>` scopes the counts and the files;
 * `?set=<id>` selects. The files come from `/data/export`.
 */
export default async function DataPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; set?: string }>
}) {
  const params = await searchParams
  const actor = await currentActor()
  const db = getDb()
  if (!db)
    return (
      <div className='page'>
        <section className='pane' aria-label='Data'>
          <header className='pane-head'>
            <span className='hud-label'>Data</span>
          </header>
          <div className='empty'>
            The database isn’t set up, so there is nothing to export.
          </div>
        </section>
      </div>
    )
  const projects = await listOwnProjects(db, actor.userId)
  const scope = params.project
    ? (projects.find((project) => project.slug === params.project) ?? null)
    : null
  const counts = await countSets(db, actor.userId, scope?.id ?? null)
  const now = new Date()
  return (
    <DataPageView
      key={scope?.slug ?? 'all'}
      groups={EXPORT_GROUPS.map((group) => ({ ...group }))}
      sets={exportSets()}
      counts={counts}
      projects={projects}
      scope={scope?.slug ?? null}
      missing={Boolean(params.project && !scope)}
      selectedId={params.set ?? null}
      never={NOT_EXPORTED.map((entry) => entry.reason)}
      today={now.toISOString().slice(0, 10)}
      now={now.getTime()}
    />
  )
}
