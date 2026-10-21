'use client'

import { useRouter } from 'next/navigation'
import { Fragment, useEffect, useState } from 'react'
import {
  age,
  Empty,
  Facts,
  Inspector,
  InspectorHead,
  isThai,
  Name,
  PaneHead,
  Readout,
  usePageKeys,
} from '@/components/bridge/parts'
import { usePageKeyHints } from '@/components/shell/keys'
import type {
  ExportGroupId,
  ExportSetInfo,
  OwnProject,
  SetCount,
} from '@/lib/data-export'

type Group = { id: ExportGroupId; label: string; glyph: string }

export type DataPageViewProps = {
  groups: Group[]
  sets: ExportSetInfo[]
  counts: Record<string, SetCount>
  projects: OwnProject[]
  /** The chosen project's slug; null = all projects. */
  scope: string | null
  /** `?project=` named a project that isn't the owner's. */
  missing: boolean
  selectedId: string | null
  never: string[]
  /** UTC date the files are named with. */
  today: string
  now: number
}

const fmt = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US')

const exportUrl = (set: string, format: 'csv' | 'json', scope: string | null) =>
  `/data/export?set=${encodeURIComponent(set)}&format=${format}${scope ? `&project=${encodeURIComponent(scope)}` : ''}`

/** Starts a download the way a click on its link would. */
function download(url: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = ''
  document.body.append(link)
  link.click()
  link.remove()
}

/**
 * Data: Table + Inspector 340, like
 * Projects. The table is every set grouped by module with its rows for the
 * scope and its last change; the inspector says what the file holds — the
 * readout, facts, the column strip (the page's one instrument), what stays
 * behind and why — and downloads it. Keys: ↑ ↓ sets · d CSV · j JSON ·
 * e everything · Esc closes the inspector.
 */
export function DataPageView(props: DataPageViewProps) {
  const router = useRouter()
  const [selected, setSelected] = useState<string | null>(props.selectedId)
  const [filter, setFilter] = useState('')
  const { counts, scope } = props
  const project = props.projects.find((entry) => entry.slug === scope) ?? null
  const groupOf = (id: ExportGroupId) =>
    props.groups.find((group) => group.id === id) ?? {
      id,
      label: id,
      glyph: '',
    }
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shown = props.sets.filter((set) =>
    words.every((word) =>
      `${set.label} ${set.table} ${groupOf(set.group).label} ${set.about}`
        .toLowerCase()
        .includes(word),
    ),
  )
  const offScope = (set: ExportSetInfo) => Boolean(scope && !set.projectScoped)
  const rowsOf = (set: ExportSetInfo) =>
    offScope(set) ? 0 : (counts[set.id]?.rows ?? 0)
  const total = shown.reduce((sum, set) => sum + rowsOf(set), 0)

  // Nothing is chosen until you pick (or the link names a set).
  const current = shown.find((set) => set.id === selected) ?? null

  const select = (id: string | null) => {
    setSelected(id)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('set', id)
    else url.searchParams.delete('set')
    window.history.replaceState(null, '', url)
  }
  const currentId = current?.id
  useEffect(() => {
    if (!currentId) return
    document
      .querySelector('.data-tbl .tbl-row.sel')
      ?.scrollIntoView({ block: 'nearest' })
  }, [currentId])

  const goScope = (slug: string | null) => {
    const next = new URLSearchParams()
    if (slug) next.set('project', slug)
    if (current) next.set('set', current.id)
    const query = next.toString()
    router.push(query ? `/data?${query}` : '/data', { scroll: false })
  }
  const file = (set: string, ext: 'csv' | 'json') =>
    `hq-${set}-${scope ?? 'all'}-${props.today}.${ext}`

  usePageKeyHints([
    ['↑ ↓', 'sets'],
    ['d', 'CSV'],
    ['j', 'JSON'],
    ['e', 'everything'],
  ])
  usePageKeys((key) => {
    if (key === 'e') {
      download(exportUrl('all', 'json', scope))
      return true
    }
    if ((key === 'd' || key === 'j') && current && !offScope(current)) {
      download(exportUrl(current.id, key === 'd' ? 'csv' : 'json', scope))
      return true
    }
    const index = shown.findIndex((set) => set.id === current?.id)
    if (key === 'ArrowDown') {
      const next = shown[Math.min(shown.length - 1, index + 1)]
      if (next) select(next.id)
      return Boolean(next)
    }
    if (key === 'ArrowUp') {
      const next = shown[Math.max(0, index - 1)]
      if (next) select(next.id)
      return Boolean(next)
    }
    if (key === 'Escape' && current) {
      select(null)
      return true
    }
    return false
  })

  const groups = props.groups
    .map((group) => ({
      group,
      list: shown.filter((set) => set.group === group.id),
    }))
    .filter((entry) => entry.list.length > 0)

  return (
    <div className='page datap'>
      <section className='pane list-pane' aria-label='Sets'>
        <PaneHead
          title='Data'
          meta={`your data, out · ${props.sets.length} sets`}
        />
        {props.missing ? (
          <p className='notice' role='status'>
            That project isn’t yours or isn’t here — showing all projects.
          </p>
        ) : null}
        <div className='toolbar'>
          <label className='scope'>
            Scope
            <select
              value={scope ?? ''}
              lang={project && isThai(project.name) ? 'th' : undefined}
              onChange={(event) => goScope(event.target.value || null)}
            >
              <option value=''>All projects</option>
              {props.projects.map((entry) => (
                <option
                  key={entry.id}
                  value={entry.slug}
                  lang={isThai(entry.name) ? 'th' : undefined}
                >
                  {entry.name}
                  {entry.status === 'active' ? '' : ` · ${entry.status}`}
                </option>
              ))}
            </select>
          </label>
          <input
            type='search'
            placeholder='Filter sets'
            aria-label='Filter sets'
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <span className='sp' />
          <span className='hits'>
            {shown.length} of {props.sets.length} sets · {fmt(total)} rows
          </span>
          <a
            className='btn btn-pri'
            href={exportUrl('all', 'json', scope)}
            download
            title={file('everything', 'json')}
          >
            Everything as JSON<kbd>e</kbd>
          </a>
        </div>
        <div className='pane-body'>
          {shown.length === 0 ? (
            <Empty>○ no set matches “{filter}”</Empty>
          ) : (
            <div className='tbl data-tbl'>
              <div className='tbl-head' aria-hidden='true'>
                <span>Set</span>
                <span className='num'>Rows</span>
                <span className='num c-hide'>Last</span>
                <span className='num c-hide'>Files</span>
              </div>
              {groups.map(({ group, list }) => {
                const allOff = list.every(offScope)
                const sum = list.reduce((n, set) => n + rowsOf(set), 0)
                return (
                  <Fragment key={group.id}>
                    {/* biome-ignore lint/a11y/useSemanticElements: a group head inside the table's grid, not a document heading */}
                    <div className='data-grp' role='heading' aria-level={3}>
                      <span className='g' aria-hidden='true'>
                        {group.glyph}
                      </span>
                      <span className='hud-label'>{group.label}</span>
                      <span className='dim'>
                        {list.length} {list.length === 1 ? 'set' : 'sets'} ·{' '}
                        {allOff ? 'not by project' : fmt(sum)}
                      </span>
                    </div>
                    {list.map((set) => (
                      <SetRow
                        key={set.id}
                        set={set}
                        group={group.label}
                        count={counts[set.id]}
                        off={offScope(set)}
                        on={set.id === current?.id}
                        now={props.now}
                        scope={scope}
                        file={file}
                        onSelect={() => select(set.id)}
                      />
                    ))}
                  </Fragment>
                )
              })}
            </div>
          )}
          <p className='data-never'>
            Never exported: {props.never.join(' · ')}; and in every set,
            credentials and raw storage keys.
          </p>
        </div>
      </section>
      <Inspector
        id='data'
        label='Selected set'
        empty={!current}
        onClose={() => select(null)}
      >
        {current ? (
          <SetInspector
            key={current.id}
            set={current}
            group={groupOf(current.group)}
            count={counts[current.id]}
            off={offScope(current)}
            project={project}
            scope={scope}
            now={props.now}
            file={file}
            onClose={() => select(null)}
            onAllProjects={() => goScope(null)}
          />
        ) : (
          <>
            <PaneHead title='Set' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>Select a set to see what its file holds.</Empty>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

function SetRow({
  set,
  group,
  count,
  off,
  on,
  now,
  scope,
  file,
  onSelect,
}: {
  set: ExportSetInfo
  group: string
  count: SetCount | undefined
  off: boolean
  on: boolean
  now: number
  scope: string | null
  file: (set: string, ext: 'csv' | 'json') => string
  onSelect: () => void
}) {
  const rows = off ? '—' : fmt(count?.rows ?? 0)
  const last = off || !count?.last ? '—' : age(count.last, now)
  return (
    <div className={`tbl-row${on ? ' sel' : ''}${off ? ' nobp' : ''}`}>
      <button
        type='button'
        className='nm'
        aria-pressed={on}
        aria-label={`${set.label}, ${group}: ${off ? 'belongs to no project' : `${rows} rows`}`}
        onClick={onSelect}
      >
        <span className='lb'>{set.label}</span>
        <span className='tb'>{set.table}</span>
      </button>
      <span className='num' aria-hidden='true'>
        {rows}
      </span>
      <span
        className='last c-hide'
        aria-hidden='true'
        title={
          count?.last && !off ? `changed ${count.last}` : 'no change recorded'
        }
      >
        {last}
      </span>
      <span className='files c-hide'>
        {off ? (
          <span className='state-word off'>not by project</span>
        ) : (
          <>
            <a
              className='btn btn-sm'
              href={exportUrl(set.id, 'csv', scope)}
              download
              title={file(set.id, 'csv')}
              aria-label={`Download ${set.label} as CSV`}
            >
              CSV
            </a>
            <a
              className='btn btn-sm'
              href={exportUrl(set.id, 'json', scope)}
              download
              title={file(set.id, 'json')}
              aria-label={`Download ${set.label} as JSON`}
            >
              JSON
            </a>
          </>
        )}
      </span>
    </div>
  )
}

function SetInspector({
  set,
  group,
  count,
  off,
  project,
  scope,
  now,
  file,
  onClose,
  onAllProjects,
}: {
  set: ExportSetInfo
  group: Group
  count: SetCount | undefined
  off: boolean
  project: OwnProject | null
  scope: string | null
  now: number
  file: (set: string, ext: 'csv' | 'json') => string
  onClose: () => void
  onAllProjects: () => void
}) {
  const rows = count?.rows ?? 0
  const where = project ? <Name text={project.name} /> : 'all projects'
  const all = set.columns.length + set.omitted.length
  return (
    <>
      <InspectorHead
        title={
          <>
            {group.glyph ? <span aria-hidden='true'>{group.glyph}</span> : null}
            {set.label}
          </>
        }
        meta={group.label}
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <Readout
            big={off ? '—' : fmt(rows)}
            tone={off || rows === 0 ? 'dim' : ''}
            sub={
              off ? (
                'belongs to no project'
              ) : (
                <>
                  {rows === 1 ? 'row' : 'rows'} · {where}
                  {rows === 0 ? ' · the file is its header' : ''}
                </>
              )
            }
            label={
              off
                ? `${set.label} belongs to no project`
                : `${rows} ${rows === 1 ? 'row' : 'rows'} in ${set.label}`
            }
          />
          <Facts
            rows={[
              ['table', set.table],
              [
                'scope',
                !project ? (
                  'all projects'
                ) : off ? (
                  'no project'
                ) : (
                  <>
                    <Name text={project.name} /> — {set.scopeNote ?? 'its rows'}
                  </>
                ),
              ],
              ['columns', `${set.columns.length} of ${all}`],
              [
                'last change',
                count?.last && !off ? `${age(count.last, now)} ago` : '—',
              ],
              ['file', off ? '—' : file(set.id, 'csv')],
            ]}
          />
        </div>
        <div className='dev-main'>
          <p className='insp-about'>{set.about}</p>
          <figure
            className='colstrip'
            aria-label={`${set.columns.length} of ${all} columns go in the file${set.omitted.length ? `; left out: ${set.omitted.map((entry) => entry.name).join(', ')}` : ''}`}
          >
            <div className='hd'>
              <span>
                Columns · <b>{set.columns.length}</b> in the file
              </span>
              <span>
                {set.omitted.length
                  ? `${set.omitted.length} left out`
                  : 'none left out'}
              </span>
            </div>
            <div className='cols' aria-hidden='true'>
              {set.columns.map((column) => (
                <span key={column.name} className='c'>
                  {column.name}
                </span>
              ))}
              {set.omitted.map((column) => (
                <span key={column.name} className='c out'>
                  {column.name}
                </span>
              ))}
            </div>
          </figure>
          {set.omitted.length ? (
            <ul className='left-out'>
              {set.omitted.map((column) => (
                <li key={column.name}>
                  <code>{column.name}</code> — {column.reason}
                </li>
              ))}
            </ul>
          ) : null}
          {off ? (
            <>
              <p className='insp-hint'>
                {set.label} belongs to no project, so a project’s file leaves it
                out.
              </p>
              <div className='dev-acts'>
                <button type='button' className='btn' onClick={onAllProjects}>
                  All projects
                </button>
              </div>
            </>
          ) : (
            <>
              <div className='dev-acts'>
                <a
                  className='btn btn-pri'
                  href={exportUrl(set.id, 'csv', scope)}
                  download
                >
                  Download CSV<kbd>d</kbd>
                </a>
                <a
                  className='btn'
                  href={exportUrl(set.id, 'json', scope)}
                  download
                >
                  Download JSON<kbd>j</kbd>
                </a>
              </div>
              <p className='insp-hint'>
                CSV is UTF-8 with a BOM, so Thai opens right in Excel; money
                keeps its exact digits beside its currency, and times are UTC.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  )
}
