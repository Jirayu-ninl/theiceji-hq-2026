'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  Dot,
  Empty,
  Facts,
  InspectorHead,
  isThai,
  Name,
  Readout,
} from '@/components/bridge/parts'
import { type InboxEntry, InboxItem, type useAnswer } from '@/components/Inbox'
import type {
  MapNodeData,
  ProjectMapData,
  ReadoutData,
  RunRow,
  WeekRow,
} from '@/lib/project-map'

/**
 * The project map's inspector (340 wide; a sheet at ≤ 1100):
 * a readout and facts, then what waits behind the node with its real
 * buttons (the one Inbox markup), this week's dated rows, and routine runs.
 * With nothing selected it reads the project itself.
 */
export function MapInspector({
  data,
  slug,
  node,
  onClose,
  picked,
  onPick,
  answering,
}: {
  data: ProjectMapData
  slug: string
  node: MapNodeData | null
  onClose: () => void
  picked: string | null
  onPick: (id: string) => void
  answering: ReturnType<typeof useAnswer>
}) {
  const { project } = data
  const crumb = (tail?: ReactNode) => (
    <>
      <Dot color={project.color} />
      <Name text={project.name} />
      {tail ? (
        <>
          <span style={{ color: 'var(--ink-4)' }}>›</span>
          {tail}
        </>
      ) : null}
    </>
  )

  if (!node) {
    const n = data.entries.length
    return (
      <>
        <InspectorHead
          title={crumb()}
          meta={`${project.kindLabel}${project.status === 'active' ? '' : ` · ${project.status}`}`}
        />
        <div className='insp-body'>
          <div className='dev-read'>
            <Read read={data.overview.read} />
            <Facts rows={data.overview.facts} />
          </div>
          <div className='dev-main'>
            <h3 className='insp-title'>
              {n
                ? `${n} ${n === 1 ? 'thing waits' : 'things wait'} for you here.`
                : 'Nothing waits for you here.'}
            </h3>
            <p className='insp-p'>Select a node to see what is behind it.</p>
            <Queue
              entries={data.entries}
              picked={picked}
              onPick={onPick}
              answering={answering}
            />
            <div className='dev-h'>
              <span className='hud-label'>
                Modules ·{' '}
                {data.overview.modules.filter((module) => module.on).length} on
              </span>
            </div>
            <div className='mods'>
              {data.overview.modules.map((module) => (
                <span
                  key={module.id}
                  className={`chip${module.on ? '' : ' off'}`}
                  title={
                    module.on
                      ? `${module.label} is on`
                      : `${module.label} is off`
                  }
                >
                  {module.glyph} {module.label}
                  {module.on ? null : <span className='sr-only'> (off)</span>}
                </span>
              ))}
            </div>
            <div className='insp-links'>
              {data.overview.modules.some(
                (module) => module.id === 'board' && module.on,
              ) ? (
                <Link className='btn' href={`/p/${slug}/board`}>
                  Open Board
                </Link>
              ) : null}
              <Link className='btn' href={`/projects?id=${project.id}`}>
                Shape it in Projects
              </Link>
            </div>
          </div>
        </div>
      </>
    )
  }

  const entries = node.waiting
    .map((id) => data.entries.find((entry) => entry.id === id))
    .filter((entry): entry is InboxEntry => Boolean(entry))
  const week = data.week.filter((row) => row.node === node.id)
  const runs =
    node.module === 'agents'
      ? data.runs
      : data.runs.filter((run) => run.modules.includes(node.module))
  const meta =
    node.chip?.tone === 'live'
      ? node.chip.text
      : entries.length
        ? `◆ ${entries.length} waiting`
        : node.state === 'due'
          ? '● due today'
          : node.state === 'unknown'
            ? '— not read back'
            : ''
  const title =
    node.kind === 'lane' ? (
      <>
        Board<span style={{ color: 'var(--ink-4)' }}>›</span>
        <Name text={node.label} />
      </>
    ) : (
      node.label
    )

  let body: ReactNode = null
  if (node.module === 'notes')
    body = data.notes.length ? (
      <Rows
        label='Filed here'
        rows={data.notes.map((note) => ({
          id: note.id,
          title: note.title,
          value: note.promoted ? 'promoted' : 'parked',
          tone: '',
          href: note.href,
        }))}
      />
    ) : (
      <Empty>No notes are filed under this project.</Empty>
    )

  return (
    <>
      <InspectorHead title={crumb(title)} meta={meta} onClose={onClose} />
      <div className='insp-body'>
        <div className='dev-read'>
          <Read read={node.read} />
          <Facts rows={node.facts} />
        </div>
        <div className='dev-main'>
          <h3
            className='insp-title'
            lang={isThai(node.label) ? 'th' : undefined}
          >
            {node.label}
            {node.off ? ' is off' : ''}
          </h3>
          {node.about ? <p className='insp-p'>{node.about}</p> : null}
          {entries.length ? (
            <Queue
              entries={entries}
              picked={picked}
              onPick={onPick}
              answering={answering}
            />
          ) : null}
          {body}
          {week.length ? (
            <Rows
              label={node.kind === 'lane' ? 'Due, on this lane' : 'This week'}
              rows={week.map((row: WeekRow) => ({
                id: row.id,
                title: row.title,
                value: row.when,
                tone: row.tone,
                href: row.href,
              }))}
            />
          ) : null}
          {runs.length ? <Runs runs={runs} /> : null}
          {!entries.length && !week.length && !runs.length && !body ? (
            <Empty>
              {node.off
                ? 'Turn it on in Projects to give it a place here.'
                : 'Nothing waits here, and nothing is dated this week.'}
            </Empty>
          ) : null}
          <div className='insp-links'>
            <Link className='btn btn-pri' href={node.href}>
              {node.open}
              <kbd>↵</kbd>
            </Link>
          </div>
        </div>
      </div>
    </>
  )
}

function Read({ read }: { read: ReadoutData }) {
  return (
    <Readout
      tone={read.tone}
      big={
        <>
          {read.mark ? `${read.mark} ` : ''}
          {read.big}
          {read.unit ? <span className='u'> {read.unit}</span> : null}
        </>
      }
      sub={read.sub || undefined}
    />
  )
}

/** Dated rows or notes, each a real link to its record. */
function Rows({
  label,
  rows,
}: {
  label: string
  rows: {
    id: string
    title: string
    value: string
    tone: string
    href: string
  }[]
}) {
  return (
    <>
      <div className='dev-h'>
        <span className='hud-label'>{label}</span>
      </div>
      <div className='insp-rows'>
        {rows.map((row) => (
          <Link key={row.id} className='insp-row' href={row.href}>
            <span className='t' lang={isThai(row.title) ? 'th' : undefined}>
              {row.title}
            </span>
            <span className={`v${row.tone ? ` ${row.tone}` : ''}`}>
              {row.value}
            </span>
          </Link>
        ))}
      </div>
    </>
  )
}

function Runs({ runs }: { runs: RunRow[] }) {
  return (
    <>
      <div className='dev-h'>
        <span className='hud-label'>Runs · routines</span>
      </div>
      <div className='insp-rows'>
        {runs.map((run) => (
          <Link key={run.id} className='insp-row' href={run.href}>
            <i className={`glyph ${run.tone}`} aria-hidden='true'>
              {run.glyph}
            </i>
            <span className='t' lang={isThai(run.routine) ? 'th' : undefined}>
              {run.routine}
            </span>
            <span className={`v ${run.tone}`}>
              {run.status} · {run.when} · {run.cost}
            </span>
          </Link>
        ))}
      </div>
    </>
  )
}

/**
 * What waits behind a node, in the Inbox's one markup: the picked item opens
 * in place with its buttons and their keys, why it stopped and its facts.
 */
function Queue({
  entries,
  picked,
  onPick,
  answering,
}: {
  entries: InboxEntry[]
  picked: string | null
  onPick: (id: string) => void
  answering: ReturnType<typeof useAnswer>
}) {
  if (!entries.length) return null
  const { answer, pending, error } = answering
  const current = entries.find((entry) => entry.id === picked) ?? entries[0]
  return (
    <div className='queue' role='listbox' aria-label='Waiting for you here'>
      {entries.map((entry) => {
        const selected = entry.id === current?.id
        return (
          <InboxItem
            key={entry.id}
            entry={entry}
            selected={selected}
            onSelect={() => onPick(entry.id)}
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
                {entry.answer ? (
                  <div className='acts'>
                    {entry.answer.options.map((option, index) => (
                      <button
                        key={option.key}
                        type='button'
                        className={`btn btn-sm${index === 0 ? ' btn-pri' : ''}`}
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
                ) : null}
                {error ? (
                  <p className='why' role='alert'>
                    <b>Not answered:</b> {error}
                  </p>
                ) : null}
                <p className='why'>
                  <b>Why it stopped:</b> {entry.why}
                </p>
                <dl className='facts'>
                  {entry.facts.map(([key, value]) => (
                    <div key={key} style={{ display: 'contents' }}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : null}
          </InboxItem>
        )
      })}
    </div>
  )
}
