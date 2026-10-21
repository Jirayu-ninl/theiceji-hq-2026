// biome-ignore-all lint/a11y/useSemanticElements: the matrix is an interactive ARIA grid laid out with CSS grid — rows are `display: contents` so heads, the row heads and the master column can stick; a <table> can't do that
'use client'

import { canEnable, MODULES, type ModuleId } from '@theiceji/hq-core/modules'
import Link from 'next/link'
import type { DragEvent, ReactNode, RefObject } from 'react'
import { projectHex } from '@/components/bridge/parts'
import { Icon } from '@/components/shell/Icon'
import type { StateData, StateProject } from '@/lib/state'
import {
  accepts,
  cellWords,
  isThai,
  isZero,
  matches,
  moneyText,
  stateGlyph,
  valueText,
  viewOf,
} from './model'

/** The selection: a column (projects, then the master) and a row (−1 = the heads). */
export type Sel = { col: number; row: number }

type Handlers = {
  onCell: (col: number, row: number) => void
  onHead: (col: number) => void
  onTrack: (col: number) => void
  onSolo: (project: StateProject) => void
  onArm: (project: StateProject) => void
  onActive: (project: StateProject) => void
  onToggleBrowser: () => void
  onDragOver: (col: number, row: number, event: DragEvent) => void
  onDragLeave: (col: number, row: number) => void
  onDrop: (col: number, row: number, event: DragEvent) => void
  onFilter: (value: string) => void
  onFilterKey: (key: string) => void
  onFilterClose: () => void
  onScroll: () => void
}

/**
 * The matrix: sticky project heads, the modules in
 * their fixed order as sticky row heads, one cell per project × module, the
 * master column on the right, and a mixer under every column. A `grid`
 * with a roving tabindex — only the selected cell or head takes Tab — and
 * every name in words. At ≤ 720 a chip row picks one project and the grid
 * reads as that project's list.
 */
export function Matrix({
  data,
  sel,
  solo,
  filter,
  filterOpen,
  promoting,
  dragging,
  dropAt,
  browserShown,
  busy,
  matrixRef,
  scrollRef,
  filterRef,
  ...on
}: Handlers & {
  data: StateData
  sel: Sel
  solo: string | null
  filter: string
  filterOpen: boolean
  promoting: boolean
  dragging: boolean
  dropAt: string | null
  browserShown: boolean
  busy: boolean
  matrixRef: RefObject<HTMLDivElement | null>
  scrollRef: RefObject<HTMLDivElement | null>
  filterRef: RefObject<HTMLInputElement | null>
}) {
  const projects = data.projects
  const n = projects.length
  const modules = data.modules
  const muted = (project: StateProject | undefined) =>
    Boolean(project && solo && solo !== project.id)
  const paused = (project: StateProject | undefined) =>
    project?.status === 'paused'
  const hay = (col: number, module: ModuleId) => {
    const project = projects[col]
    return `${cellWords(data, col, module)} ${project ? `${project.kindLabel} ${project.slug}` : 'all projects master'}`
  }
  let hits = 0
  if (filter)
    for (let col = 0; col < n; col++)
      for (const module of modules)
        if (matches(filter, hay(col, module))) hits++

  const cls = (...names: (string | false | null | undefined)[]) =>
    names.filter(Boolean).join(' ')

  const cell = (col: number, row: number, module: ModuleId) => {
    const project = projects[col]
    const master = !project
    const label = MODULES[module].label
    const view = viewOf(data, col, module)
    const selected = sel.col === col && sel.row === row
    const key = `${col}:${row}`
    const enable =
      view.kind === 'off' && project
        ? canEnable(project.kind, project.enabled, module)
        : null
    let glyph = ''
    let tone = ''
    let body: ReactNode
    const names = ['cell']
    if (view.kind === 'off') {
      names.push('off')
      body = (
        <>
          <strong>
            {enable?.ok ? (
              <>
                ＋ <span className='u'>enable {label}</span>
              </>
            ) : (
              'off'
            )}
          </strong>
          {enable && !enable.ok ? <small>{enable.reason}</small> : null}
        </>
      )
    } else if (view.kind === 'none') {
      names.push('none')
      glyph = '○'
      tone = 'off'
      body = (
        <>
          <strong>nothing yet</strong>
          <small>no record</small>
        </>
      )
    } else {
      const { cell: reading } = view
      if (reading.state) names.push(reading.state)
      if (isZero(reading)) names.push('zero')
      glyph = stateGlyph(reading.state)
      tone =
        reading.state === 'wait' ||
        reading.state === 'live' ||
        reading.state === 'due'
          ? reading.state
          : ''
      const value = valueText(reading.value)
      body = (
        <>
          <strong>
            {value ? `${value} ` : ''}
            <span className='u'>{reading.unit ?? ''}</span>
          </strong>
          {reading.sub ? (
            <small lang={isThai(reading.sub) ? 'th' : undefined}>
              {reading.sub}
            </small>
          ) : null}
        </>
      )
    }
    if (selected) names.push('sel')
    if (dragging && accepts(project, module)) names.push('can-drop')
    if (dropAt === key) names.push('drop')
    return (
      <div
        key={key}
        role='gridcell'
        aria-selected={selected}
        className={cls(
          'cell-wrap',
          master && 'master',
          sel.col === col && 'phone',
          muted(project) && 'muted-col',
          paused(project) && 'paused-col',
          filter && !matches(filter, hay(col, module)) && 'filtered',
        )}
        style={
          project
            ? { ['--project' as string]: projectHex(project.color) }
            : undefined
        }
      >
        <button
          type='button'
          className={names.join(' ')}
          data-col={col}
          data-row={row}
          tabIndex={selected ? 0 : -1}
          aria-label={`${cellWords(data, col, module)}${enable ? (enable.ok ? ', can be turned on' : `, ${enable.reason}`) : ''}`}
          onClick={() => on.onCell(col, row)}
          onDragOver={(event) => on.onDragOver(col, row, event)}
          onDragLeave={() => on.onDragLeave(col, row)}
          onDrop={(event) => on.onDrop(col, row, event)}
        >
          <span className='lbl'>{label}</span>
          <i className={`g glyph ${tone}`} aria-hidden='true'>
            {glyph}
          </i>
          <span className='r'>{body}</span>
        </button>
      </div>
    )
  }

  const head = (project: StateProject, col: number) => {
    const selected = sel.col === col && sel.row === -1
    return (
      <button
        key={project.id}
        type='button'
        role='columnheader'
        className={cls(
          'col-head',
          sel.col === col && 'sel',
          sel.col === col && 'current',
          muted(project) && 'muted-col',
          paused(project) && 'paused-col',
        )}
        data-col={col}
        data-row={-1}
        tabIndex={selected ? 0 : -1}
        style={{ ['--project' as string]: projectHex(project.color) }}
        title={`${project.name} — open the project pane`}
        aria-label={`${project.name}, ${project.kindLabel}${project.status === 'paused' ? ', paused' : ''}${solo === project.id ? ', solo' : ''}${project.fresh ? ', new' : ''}`}
        onClick={() => on.onHead(col)}
      >
        <span className='name'>
          <i className='dot' aria-hidden='true' />
          <span lang={isThai(project.name) ? 'th' : undefined}>
            {project.name}
          </span>
        </span>
        <span className='kind'>
          <span className='hud-label'>{project.kindLabel}</span>
          {project.status === 'paused' ? (
            <span className='hud-label paused-tag'>paused</span>
          ) : null}
          {solo === project.id ? (
            <span className='hud-label solo-tag'>solo</span>
          ) : null}
          {project.fresh ? <span className='hud-label'>new</span> : null}
        </span>
      </button>
    )
  }

  const waiting = data.entries.length
  const masterHead = (
    <button
      type='button'
      role='columnheader'
      className={cls('master-head', sel.col === n && 'sel')}
      data-col={n}
      data-row={-1}
      tabIndex={sel.col === n && sel.row === -1 ? 0 : -1}
      title='Waiting for you across all projects'
      aria-label={`All projects: ${waiting ? `${waiting} waiting for you` : 'nothing waiting'}`}
      onClick={() => on.onHead(n)}
    >
      <span className='hud-label'>All projects</span>
      <span className='name'>
        <i className={`glyph ${waiting ? 'wait' : 'off'}`} aria-hidden='true'>
          {waiting ? '◆' : '○'}
        </i>
        <span className={`n${waiting ? '' : ' zero'}`}>{waiting}</span>
        <span>{waiting ? 'waiting for you' : 'nothing waiting'}</span>
      </span>
    </button>
  )

  const mixer = (col: number) => {
    const project = projects[col]
    const master = !project
    let amount = '—'
    let tag = 'not read back'
    let level = 0
    let pending = false
    let unknown = false
    let foot: ReactNode
    if (master) {
      const m = data.money
      unknown = !m
      if (m) {
        amount = m.total.length ? moneyText(m.total) : '0'
        tag = m.week
        level = m.level
      }
      foot = (
        <div className='cost'>
          <span>
            {m
              ? `last week ${m.previous.length ? moneyText(m.previous) : '0'}`
              : ''}
          </span>
        </div>
      )
    } else {
      const earned = project.earned
      unknown = earned === null
      if (earned?.length) {
        amount = moneyText(earned)
        tag = '7d'
        level = project.level
      } else if (project.pending.length) {
        pending = true
        amount = `(${moneyText(project.pending)})`
        tag = 'awaiting'
      } else if (earned) {
        amount = '0'
        tag = '7d'
      }
      const cost = project.cost
      const costText = !cost
        ? 'cost —'
        : `cost ${cost.known.length ? moneyText(cost.known) : cost.unknown ? '' : '0'}${cost.unknown ? `${cost.known.length ? ' + ' : ''}—` : ''}`
      const armed = (project.routines?.on ?? 0) > 0
      const hasAgents = project.enabled.includes('agents')
      foot = (
        <div className='cost'>
          <span
            title={
              cost?.unknown
                ? `${cost.unknown} generation${cost.unknown === 1 ? '’s' : 's’'} cost not known`
                : undefined
            }
          >
            {costText}
          </span>
          <span className='mix-controls'>
            {hasAgents ? (
              <button
                type='button'
                className='arm'
                tabIndex={-1}
                aria-pressed={armed}
                disabled={busy || !project.routines?.total}
                aria-label={`Routines for ${project.name}: ${!project.routines ? 'not read back' : !project.routines.total ? 'none yet' : armed ? 'armed — pause them' : 'paused — arm them'}`}
                title={
                  !project.routines?.total
                    ? 'No routines yet — make one in Agents'
                    : armed
                      ? 'Routines armed — click to pause them'
                      : 'Routines paused — click to arm them'
                }
                onClick={() => on.onArm(project)}
              >
                arm
              </button>
            ) : null}
            <button
              type='button'
              className='solo'
              tabIndex={-1}
              aria-pressed={solo === project.id}
              aria-label={`Solo ${project.name}`}
              title='Solo this project (s)'
              onClick={() => on.onSolo(project)}
            >
              s
            </button>
            <button
              type='button'
              className='activator'
              tabIndex={-1}
              aria-pressed={project.status === 'active'}
              disabled={busy}
              aria-label={`${project.name} is ${project.status === 'active' ? 'on — pause the project' : 'paused — resume the project'}`}
              title={
                project.status === 'active'
                  ? 'Active — click to pause the project'
                  : 'Paused — click to resume the project'
              }
              onClick={() => on.onActive(project)}
            >
              {project.status === 'active' ? 'on' : 'off'}
            </button>
          </span>
        </div>
      )
    }
    const meterWords = master
      ? unknown
        ? 'Money over 7 days: not read back'
        : `Money this week ${amount}, last week ${data.money?.previous.length ? moneyText(data.money.previous) : '0'}`
      : `${project.name} money: ${unknown ? 'not read back' : `${amount} ${tag}`}`
    return (
      <div
        key={`mixer-${col}`}
        role='gridcell'
        className={cls(
          'mixer',
          master && 'master',
          sel.col === col && 'phone',
          muted(project) && 'muted-col',
          paused(project) && 'paused-col',
        )}
      >
        <div className={cls('amt', pending && 'pending', unknown && 'unknown')}>
          <span>{amount}</span>
          <span className='hud-label'>{tag}</span>
        </div>
        <div
          className={cls('meter', (pending || unknown) && 'pending')}
          role='img'
          aria-label={meterWords}
        >
          <span style={{ ['--level' as string]: `${level}%` }} />
        </div>
        {foot}
      </div>
    )
  }

  return (
    <section className='pane matrix-shell' aria-label='Projects by module'>
      {filterOpen ? (
        <div className='filter-bar'>
          <span className='hud-label'>Filter</span>
          <input
            ref={filterRef}
            aria-label='Filter cells by project, module, readout or agent'
            placeholder='project, module, readout, agent…'
            value={filter}
            onChange={(event) => on.onFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' || event.key === 'Enter') {
                event.preventDefault()
                on.onFilterKey(event.key)
              }
            }}
          />
          <span className='hits'>
            {filter ? `${hits} of ${n * modules.length} cells` : ''}
          </span>
          <button
            type='button'
            className='btn btn-sm'
            onClick={on.onFilterClose}
          >
            Clear<kbd>Esc</kbd>
          </button>
        </div>
      ) : null}
      <nav className='tracks' aria-label='Projects'>
        <button
          type='button'
          className='tracks-notes'
          title='Notes'
          aria-label='Show or hide notes'
          aria-pressed={browserShown}
          onClick={on.onToggleBrowser}
        >
          <Icon name='notes' />
        </button>
        <button
          type='button'
          aria-pressed={sel.col === n}
          data-track={n}
          onClick={() => on.onTrack(n)}
        >
          All
        </button>
        {projects.map((project, col) => (
          <button
            key={project.id}
            type='button'
            aria-pressed={sel.col === col}
            data-track={col}
            style={{ ['--project' as string]: projectHex(project.color) }}
            onClick={() => on.onTrack(col)}
          >
            <i className='dot' aria-hidden='true' />
            <span lang={isThai(project.name) ? 'th' : undefined}>
              {project.name}
            </span>
          </button>
        ))}
      </nav>
      <div className='matrix-scroll' ref={scrollRef} onScroll={on.onScroll}>
        <div
          ref={matrixRef}
          className={cls('matrix', dragging && 'dragging', !n && 'bare')}
          role='grid'
          aria-label='Projects by module'
          aria-rowcount={modules.length + 2}
          aria-colcount={n + 2}
          style={{ ['--projects' as string]: n }}
        >
          <div role='row'>
            <div role='columnheader' className='corner'>
              <button
                type='button'
                className='btn btn-sm'
                aria-pressed={browserShown}
                aria-label='Show or hide notes'
                title='Show or hide notes (⇥)'
                onClick={on.onToggleBrowser}
              >
                <Icon name='notes' />
                <kbd>⇥</kbd>
              </button>
              <span className='hud-label'>
                {n} × {modules.length}
              </span>
            </div>
            {projects.map((project, col) => head(project, col))}
            {masterHead}
          </div>
          {modules.map((module, row) => (
            <div role='row' key={module}>
              <div
                role='rowheader'
                className={cls('row-head', sel.row === row && 'sel')}
              >
                <span className='idx' aria-hidden='true'>
                  {String(row + 1).padStart(2, '0')}
                </span>
                <span className='g' aria-hidden='true'>
                  {MODULES[module].glyph}
                </span>
                {MODULES[module].label}
              </div>
              {projects.map((_, col) => cell(col, row, module))}
              {cell(n, row, module)}
            </div>
          ))}
          <div role='row'>
            <div role='rowheader' className='mixer-label'>
              <span className='hud-label'>Money · 7d</span>
              <span className='hud-label'>cost · arm · solo</span>
            </div>
            {projects.map((_, col) => mixer(col))}
            {mixer(n)}
          </div>
        </div>
        {n ? null : (
          <p className='empty'>
            No projects yet. <Link href='/projects?new=1'>Make one</Link> and
            its modules line up here.
          </p>
        )}
      </div>
    </section>
  )
}
