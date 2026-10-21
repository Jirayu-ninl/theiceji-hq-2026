'use client'

import { canEnable, MODULES, type ModuleId } from '@theiceji/hq-core/modules'
import Link from 'next/link'
import type { ReactNode, RefObject } from 'react'
import { Dot, Facts, Name } from '@/components/bridge/parts'
import { type InboxEntry, InboxItem, type useAnswer } from '@/components/Inbox'
import { Icon } from '@/components/shell/Icon'
import type { Detail, StateData, StateNote, StateProject } from '@/lib/state'
import type { ModuleCell } from '@/modules'
import type { Sel } from './Matrix'
import {
  accepts,
  isThai,
  moneyText,
  stateGlyph,
  stateWord,
  TARGETS,
  valueText,
  viewOf,
} from './model'

export type PaneKind = 'cell' | 'project' | 'inbox' | 'promote'

type Answering = ReturnType<typeof useAnswer>

/**
 * The device pane: what is behind the selected cell.
 * A readout and facts, then the items waiting there with their real buttons
 * (the one Inbox markup and its answering), or else the module's records.
 * From an off slot it offers Enable; from an empty cell, the first record.
 * A column head opens the project; the master head opens Waiting for you;
 * while promoting, it is the confirm step.
 */
export function Device({
  data,
  sel,
  kind,
  deviceRef,
  byDefault,
  items,
  itemId,
  onItem,
  answering,
  note,
  busy,
  error,
  confirmRef,
  onClose,
  onEnable,
  onConfirm,
  onCancel,
  onActive,
  onArm,
}: {
  data: StateData
  sel: Sel
  kind: PaneKind
  deviceRef: RefObject<HTMLElement | null>
  /** Open only because nobody closed it — a phone keeps it shut until a tap. */
  byDefault: boolean
  items: InboxEntry[]
  itemId: string | null
  onItem: (id: string) => void
  answering: Answering
  note: StateNote | null
  busy: boolean
  error: string | null
  confirmRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onEnable: (project: StateProject, module: ModuleId) => void
  onConfirm: () => void
  onCancel: () => void
  onActive: (project: StateProject) => void
  onArm: (project: StateProject) => void
}) {
  const project = data.projects[sel.col]
  const module = sel.row >= 0 ? (data.modules[sel.row] ?? null) : null
  const current = items.find((entry) => entry.id === itemId) ?? items[0]

  let head: ReactNode
  let body: ReactNode
  let inboxMode = false
  if (kind === 'promote' && note && module) {
    ;({ head, body } = promotePane(
      data,
      project,
      module,
      note,
      busy,
      error,
      confirmRef,
      onConfirm,
      onCancel,
    ))
  } else if (kind === 'project' && project) {
    ;({ head, body } = projectPane(data, project, busy, error, onActive, onArm))
  } else if (kind === 'inbox') {
    inboxMode = true
    const oldest = data.entries.reduce(
      (max, entry) => Math.max(max, entry.ageHours),
      0,
    )
    head = (
      <Head
        title={
          <>
            <span>All projects</span>
            <span className='sep'>›</span>
            <span>Waiting for you</span>
          </>
        }
        status={
          data.entries.length
            ? `${data.entries.length} · oldest ${hours(oldest)}`
            : 'nothing waiting'
        }
        tone={data.entries.length ? 'wait' : ''}
        open={{ href: '/inbox', label: 'Open inbox' }}
      />
    )
    body = data.entries.length ? (
      <Queue
        entries={data.entries}
        current={current}
        onItem={onItem}
        answering={answering}
        label='Waiting for you'
      />
    ) : (
      <div className='empty'>Nothing is waiting for you.</div>
    )
  } else if (module) {
    ;({ head, body } = cellPane(
      data,
      project,
      module,
      items,
      current,
      onItem,
      answering,
      busy,
      error,
      onEnable,
    ))
  }

  return (
    <section
      className='pane device'
      aria-label='Selected cell'
      tabIndex={-1}
      ref={deviceRef}
      data-default={byDefault ? '' : undefined}
    >
      <header className='pane-head device-head'>
        {head}
        <button
          type='button'
          className='iconbtn'
          aria-label='Close (Esc)'
          title='Close (Esc)'
          onClick={onClose}
        >
          <Icon name='close' size={14} />
        </button>
      </header>
      <div className={`pane-body device-body${inboxMode ? ' inbox-mode' : ''}`}>
        {body}
      </div>
    </section>
  )
}

const hours = (h: number) =>
  h < 1 ? '<1h' : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`

function Head({
  title,
  status,
  tone,
  open,
}: {
  title: ReactNode
  status: string
  tone: string
  open: { href: string; label: string } | null
}) {
  return (
    <>
      <div className='title'>{title}</div>
      <span className={`status ${tone}`}>{status}</span>
      <div className='tools'>
        {open ? (
          <Link className='btn btn-sm' href={open.href} title={open.label}>
            {open.label}
            <kbd>↵</kbd>
          </Link>
        ) : null}
      </div>
    </>
  )
}

function Who({ project }: { project: StateProject | undefined }) {
  return project ? (
    <>
      <Dot color={project.color} />
      <Name text={project.name} />
    </>
  ) : (
    <span>All projects</span>
  )
}

/** The waiting items, the one Inbox markup: the selected one opens in place. */
function Queue({
  entries,
  current,
  onItem,
  answering,
  label,
}: {
  entries: InboxEntry[]
  current: InboxEntry | undefined
  onItem: (id: string) => void
  answering: Answering
  label: string
}) {
  const { answer, pending, error } = answering
  const buttons = (entry: InboxEntry, small: boolean) =>
    entry.answer ? (
      <div className='acts'>
        {entry.answer.options.map((option, index) => (
          <button
            key={option.key}
            type='button'
            className={`btn btn-sm${index === 0 && !small ? ' btn-pri' : ''}`}
            disabled={pending}
            onClick={(event) => {
              event.stopPropagation()
              answer(entry, option.key)
            }}
          >
            {option.label}
            <kbd>{option.hotkey}</kbd>
          </button>
        ))}
      </div>
    ) : entry.link ? (
      <div className='acts'>
        <Link
          className='btn btn-sm'
          href={entry.link.href}
          onClick={(event) => event.stopPropagation()}
        >
          {entry.link.label}
        </Link>
      </div>
    ) : null
  return (
    <div className='queue' role='listbox' aria-label={label}>
      {entries.map((entry) => {
        const selected = entry.id === current?.id
        return (
          <InboxItem
            key={entry.id}
            entry={entry}
            selected={selected}
            onSelect={() => onItem(entry.id)}
          >
            {selected ? (
              <>
                {entry.body ? (
                  <p lang={isThai(entry.body) ? 'th' : undefined}>
                    {entry.body}
                  </p>
                ) : null}
                {entry.meanwhile ? (
                  <p className='quote'>
                    <span className='hud-label'>While it waits</span>
                    {entry.meanwhile}
                  </p>
                ) : null}
                {entry.quote ? (
                  <p
                    className='quote'
                    lang={isThai(entry.quote) ? 'th' : undefined}
                  >
                    <span className='hud-label'>Proposed</span>
                    {entry.quote}
                  </p>
                ) : null}
                {buttons(entry, false)}
                {error ? (
                  <p className='why' role='alert'>
                    <b>Not answered:</b> {error}
                  </p>
                ) : null}
                <p className='why'>
                  <b>Why it stopped:</b> {entry.why}
                </p>
                {entry.facts.length ? (
                  <dl className='facts'>
                    {entry.facts.map(([key, value]) => (
                      <div key={key} style={{ display: 'contents' }}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </>
            ) : (
              buttons(entry, true)
            )}
          </InboxItem>
        )
      })}
    </div>
  )
}

function Rows({ data, detail }: { data: StateData; detail: Detail }) {
  const projectOf = (id: string | null) =>
    id ? data.projects.find((project) => project.id === id) : undefined
  return (
    <>
      <div className='dev-h'>
        <span className='hud-label'>{detail.label}</span>
      </div>
      <div className='dev-rows'>
        {detail.rows.map((row) => {
          const project = projectOf(row.projectId)
          const inner = (
            <>
              {project ? <Dot color={project.color} /> : null}
              <span className='t' lang={isThai(row.text) ? 'th' : undefined}>
                {row.text}
              </span>
              <span className={`v ${row.tone}`}>{row.value}</span>
            </>
          )
          return row.href ? (
            <Link key={row.key} className='dev-row' href={row.href}>
              {inner}
            </Link>
          ) : (
            <div key={row.key} className='dev-row'>
              {inner}
            </div>
          )
        })}
      </div>
    </>
  )
}

function Spark({ spark }: { spark: NonNullable<StateData['spark']> }) {
  const values = spark.values
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const w = 300
  const h = 28
  const points = values.map((v, i) => [
    (i / (values.length - 1)) * w,
    h - 3 - ((v - min) / (max - min || 1)) * (h - 6),
  ])
  const line = `M${points.map((p) => p.map((x) => (x ?? 0).toFixed(1)).join(' ')).join(' L')}`
  return (
    <div className='spark-wrap'>
      <div className='dev-h'>
        <span className='hud-label'>
          all projects · last {spark.weeks} weeks
          {spark.currency ? ` · ${spark.currency}` : ''}
        </span>
      </div>
      <svg
        className='spark'
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio='none'
        role='img'
        aria-label={`Net money per week over the last ${spark.weeks} weeks${spark.currency ? `, in ${spark.currency}` : ''}`}
      >
        <path className='area' d={`${line} L${w} ${h} L0 ${h}Z`} />
        <path d={line} />
      </svg>
    </div>
  )
}

function Readout({
  big,
  unit,
  sub,
  tone,
}: {
  big: string
  unit?: string
  sub: string
  tone?: string
}) {
  return (
    <div className='readout'>
      <div className={`big${tone ? ` ${tone}` : ''}`}>
        {big}
        {unit ? (
          <>
            {' '}
            <span className='u'>{unit}</span>
          </>
        ) : null}
      </div>
      <div className='sub'>{sub}</div>
    </div>
  )
}

const routinesText = (project: StateProject) =>
  !project.enabled.includes('agents')
    ? 'none'
    : !project.routines
      ? '—'
      : !project.routines.total
        ? 'none yet'
        : project.routines.on
          ? `armed · ${project.routines.on} of ${project.routines.total} on`
          : `paused · ${project.routines.total}`

const costText = (project: StateProject) =>
  !project.cost
    ? '—'
    : `${project.cost.known.length ? moneyText(project.cost.known) : project.cost.unknown ? '' : '0'}${project.cost.unknown ? `${project.cost.known.length ? ' + ' : ''}— (${project.cost.unknown} not known)` : ''}`

function cellPane(
  data: StateData,
  project: StateProject | undefined,
  module: ModuleId,
  items: InboxEntry[],
  current: InboxEntry | undefined,
  onItem: (id: string) => void,
  answering: Answering,
  busy: boolean,
  error: string | null,
  onEnable: (project: StateProject, module: ModuleId) => void,
): { head: ReactNode; body: ReactNode } {
  const label = MODULES[module].label
  const col = project ? data.projects.indexOf(project) : data.projects.length
  const view = viewOf(data, col, module)
  const cell: ModuleCell | null = view.kind === 'cell' ? view.cell : null
  const since = items[0] ? `since ${items[0].since} (${items[0].age})` : ''
  const status =
    view.kind === 'off'
      ? 'module off'
      : view.kind === 'none'
        ? 'nothing yet'
        : cell?.state
          ? `${stateGlyph(cell.state) || '—'} ${stateWord(cell.state)}${since ? ` · ${since}` : ''}`
          : project?.status === 'paused'
            ? 'paused'
            : project
              ? ''
              : 'all projects'
  const route = project
    ? `/p/${project.slug}/${module}`
    : (data.routes[module] ?? null)
  const head = (
    <Head
      title={
        <>
          <Who project={project} />
          <span className='sep'>›</span>
          <span>{label}</span>
        </>
      }
      status={status}
      tone={cell?.state ?? ''}
      open={
        view.kind !== 'off' && route
          ? { href: route, label: 'Open page' }
          : null
      }
    />
  )

  let read: ReactNode
  if (view.kind === 'off')
    read = (
      <Readout
        big='off'
        tone='dim'
        sub={`${label} is not on for this project`}
      />
    )
  else if (view.kind === 'none')
    read = (
      <Readout big='○ nothing yet' tone='dim' sub={`no record in ${label}`} />
    )
  else if (cell)
    read = (
      <Readout
        big={`${stateGlyph(cell.state) ? `${stateGlyph(cell.state)} ` : ''}${valueText(cell.value)}`}
        unit={cell.unit}
        sub={cell.sub || stateWord(cell.state) || '—'}
        tone={cell.state === 'unknown' ? '' : cell.state}
      />
    )

  const facts: [string, ReactNode][] = project
    ? [
        ['kind', project.kindLabel],
        ['status', project.status],
        ['routines', routinesText(project)],
        ['cost 7d', costText(project)],
      ]
    : [
        ['scope', 'all projects'],
        ['route', data.routes[module] ?? 'per project'],
        ['projects', String(data.master[module].projects)],
      ]

  let main: ReactNode
  if (view.kind === 'off' && project) {
    const check = canEnable(project.kind, project.enabled, module)
    main = (
      <>
        <h3 className='dev-title'>
          {label} is off for <Name text={project.name} />
        </h3>
        <p className='dev-p'>
          {check.ok
            ? `Give this project a place for ${label.toLowerCase()}. Off keeps every record; on shows them again.`
            : check.reason}
        </p>
        {check.ok ? (
          <div className='dev-acts'>
            <button
              type='button'
              className='btn'
              disabled={busy || project.status === 'archived'}
              onClick={() => onEnable(project, module)}
            >
              Enable {label}
            </button>
          </div>
        ) : null}
        {error ? (
          <p className='why' role='alert'>
            <b>Didn’t change:</b> {error}
          </p>
        ) : null}
      </>
    )
  } else if (view.kind === 'none' && project) {
    main = (
      <>
        <h3 className='dev-title'>Nothing here yet.</h3>
        <p className='dev-p'>
          {label} is on and has no record — that is not a zero.
        </p>
        <div className='dev-acts'>
          <Link className='btn' href={`/p/${project.slug}/${module}`}>
            Create the first record
          </Link>
        </div>
      </>
    )
  } else if (items.length) {
    main = (
      <Queue
        entries={items}
        current={current}
        onItem={onItem}
        answering={answering}
        label='Waiting behind this cell'
      />
    )
  } else if (cell?.state === 'unknown') {
    main = (
      <>
        <h3 className='dev-title'>— not read back</h3>
        <p className='dev-p'>
          {label} couldn’t be read just now. No estimate is substituted.
        </p>
      </>
    )
  } else {
    const detail = data.detail[project ? project.id : 'all']?.[module]
    const spark =
      !project && module === 'readings' && data.spark ? (
        <Spark spark={data.spark} />
      ) : null
    main =
      detail || spark ? (
        <>
          {spark}
          {detail ? <Rows data={data} detail={detail} /> : null}
        </>
      ) : (
        <>
          <h3 className='dev-title'>
            {cell ? `${valueText(cell.value)} ${cell.unit ?? ''}` : label}
          </h3>
          <p className='dev-p'>
            {cell?.sub ?? 'Nothing else to show here — the page has the rest.'}
          </p>
        </>
      )
  }

  return {
    head,
    body: (
      <>
        <div className='dev-read'>
          {read}
          <Facts rows={facts} />
        </div>
        <div className='dev-main'>{main}</div>
      </>
    ),
  }
}

function projectPane(
  data: StateData,
  project: StateProject,
  busy: boolean,
  error: string | null,
  onActive: (project: StateProject) => void,
  onArm: (project: StateProject) => void,
): { head: ReactNode; body: ReactNode } {
  const cells = Object.values(project.cells)
  const live = cells.filter((cell) => cell?.state === 'live').length
  const due = cells.filter((cell) => cell?.state === 'due').length
  const head = (
    <Head
      title={<Who project={project} />}
      status={`${project.kindLabel}${project.status === 'paused' ? ' · paused' : ''}${project.fresh ? ' · new' : ''}`}
      tone={project.status === 'paused' ? 'due' : ''}
      open={{ href: `/p/${project.slug}`, label: 'Open project' }}
    />
  )
  const read =
    project.earned === null ? (
      <Readout
        big='— not read back'
        tone='dim'
        sub='money over 7 days could not be read'
      />
    ) : project.earned.length ? (
      <Readout big={moneyText(project.earned)} unit='7d' sub='net, recorded' />
    ) : project.pending.length ? (
      <Readout
        big={`(${moneyText(project.pending)})`}
        unit='awaiting'
        sub='not counted until the bank reads it back'
      />
    ) : (
      <Readout big='0' unit='7d' sub='nothing recorded' />
    )
  const hasAgents = project.enabled.includes('agents')
  const armed = (project.routines?.on ?? 0) > 0
  return {
    head,
    body: (
      <>
        <div className='dev-read'>
          {read}
          <Facts
            rows={[
              ['waiting', project.waiting ? `◆ ${project.waiting}` : 'nothing'],
              ['running', live ? `▶ ${live}` : '0'],
              ['due today', String(due)],
              ['routines', routinesText(project)],
              ['cost 7d', costText(project)],
            ]}
          />
        </div>
        <div className='dev-main'>
          <div className='dev-h'>
            <span className='hud-label'>
              Modules · {project.enabled.length} on
            </span>
          </div>
          <div className='mods'>
            {data.modules.map((id) => (
              <span
                key={id}
                className={`chip${project.enabled.includes(id) ? '' : ' off'}`}
              >
                {MODULES[id].glyph} {MODULES[id].label}
                {project.enabled.includes(id) ? '' : ' · off'}
              </span>
            ))}
          </div>
          <div className='dev-acts'>
            <button
              type='button'
              className='btn'
              disabled={busy || project.status === 'archived'}
              onClick={() => onActive(project)}
            >
              {project.status === 'active' ? 'Pause project' : 'Resume project'}
            </button>
            {hasAgents && project.routines?.total ? (
              <button
                type='button'
                className='btn'
                disabled={busy}
                onClick={() => onArm(project)}
              >
                {armed ? 'Pause routines' : 'Arm routines'}
              </button>
            ) : null}
            <a className='btn' href={`/projects?id=${project.id}`}>
              Settings
            </a>
          </div>
          {error ? (
            <p className='why' role='alert'>
              <b>Didn’t change:</b> {error}
            </p>
          ) : null}
        </div>
      </>
    ),
  }
}

function promotePane(
  data: StateData,
  project: StateProject | undefined,
  module: ModuleId,
  note: StateNote,
  busy: boolean,
  error: string | null,
  confirmRef: RefObject<HTMLButtonElement | null>,
  onConfirm: () => void,
  onCancel: () => void,
): { head: ReactNode; body: ReactNode } {
  const label = MODULES[module].label
  const target = TARGETS[module]
  const ok = accepts(project, module)
  const on = Boolean(project?.enabled.includes(module))
  const filed = note.projectId
    ? data.projects.find((entry) => entry.id === note.projectId)
    : undefined
  const head = (
    <Head
      title={
        <>
          <span>Promote note</span>
          <span className='sep'>›</span>
          <Who project={project} />
          <span className='sep'>›</span>
          <span>{label}</span>
        </>
      }
      status={
        ok
          ? on
            ? `creates ${an(target)}`
            : `turns ${label} on · creates ${an(target)}`
          : 'this cell does not take notes'
      }
      tone={ok ? '' : 'wait'}
      open={null}
    />
  )
  return {
    head,
    body: (
      <>
        <div className='dev-read'>
          <div className='readout'>
            <div
              className='big note'
              lang={isThai(note.text) ? 'th' : undefined}
            >
              {note.text}
            </div>
            <div className='sub'>
              {note.age} · {filed ? filed.name : 'HQ'}
            </div>
          </div>
        </div>
        <div className='dev-main'>
          <h3 className='dev-title'>
            {ok && project ? (
              <>
                Create {an(target)} in {label} for <Name text={project.name} />
              </>
            ) : project ? (
              `${label} does not take notes`
            ) : (
              'All projects does not take notes'
            )}
          </h3>
          <p className='dev-p'>
            {ok
              ? 'The note stays in Notes, linked to its new home.'
              : 'Move to Board, Prompts, Story (film) or Calendar with the arrows, then press ↵.'}
          </p>
          <div className='dev-acts'>
            {ok ? (
              <button
                ref={confirmRef}
                type='button'
                className='btn btn-pri'
                disabled={busy}
                onClick={onConfirm}
              >
                Create {target}
                <kbd>↵</kbd>
              </button>
            ) : null}
            <button type='button' className='btn' onClick={onCancel}>
              Cancel<kbd>Esc</kbd>
            </button>
          </div>
          {error ? (
            <p className='why' role='alert'>
              <b>Not promoted:</b> {error}
            </p>
          ) : null}
        </div>
      </>
    ),
  }
}

/** `a card`, `an event`. */
const an = (word: string | undefined) =>
  word ? `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}` : 'a record'
