'use client'

import { PROJECT_COLORS, type ProjectColor } from '@theiceji/hq-db/enums'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useState,
  useTransition,
} from 'react'
import { decideProposalAction, respondAction } from '@/app/(app)/inbox/actions'
import { isPlainClick } from '@/lib/url-state'
import { Inspector } from './bridge/parts'
import { Icon } from './shell/Icon'
import { usePageKeyHints } from './shell/keys'

/**
 * Waiting for you — the one item markup every queue uses.
 * An item reads in one order: glyph · title ·
 * age, then where it is, then the body, the buttons with their keys, why it
 * stopped, and the facts. Kinds: ◆ request · ▶ proposal · amber ◆ problem.
 */

export type InboxEntry = {
  id: string
  kind: 'request' | 'proposal' | 'problem'
  title: string
  body: string | null
  why: string
  meanwhile: string | null
  /** A proposal's own words — the variant text, the card title, the shot's action. */
  quote?: string | null
  /** A proposal the owner parked: still waiting, sorted last. */
  held?: boolean
  age: string
  ageHours: number
  since: string
  project: { slug: string; name: string; color: string } | null
  /** Module or place in words: `Quotes`, `Google`, `Prompts · variant`. */
  where: string
  /** The module it belongs to, when it is one (Home lights that module's moon). */
  module?: string
  urgent: boolean
  /** Present when the owner can answer here. */
  answer: {
    revision: number
    /** What answering decides: a human request (default) or an agent's proposal. */
    target?: 'request' | 'proposal'
    options: { key: string; label: string; hotkey: string }[]
  } | null
  /** Where it is decided instead (a Settings tab, a routine). */
  link: { href: string; label: string } | null
  facts: [string, string][]
}

const isThai = (text: string) => /\p{Script=Thai}/u.test(text)
const hex = (color: string) =>
  PROJECT_COLORS[color as ProjectColor] ?? PROJECT_COLORS.grey

function typing(target: EventTarget | null) {
  const element = target as HTMLElement | null
  return (
    element?.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(element?.tagName ?? '') ||
    Boolean(document.querySelector('dialog[open], :popover-open'))
  )
}

function Tag({ project }: { project: InboxEntry['project'] }) {
  return (
    <span className='tag'>
      {project ? (
        <>
          <i
            className='dot'
            style={{ ['--project' as string]: hex(project.color) }}
            aria-hidden='true'
          />
          <span lang={isThai(project.name) ? 'th' : undefined}>
            {project.name}
          </span>
        </>
      ) : (
        'HQ'
      )}
    </span>
  )
}

/** One queue row in list mode: no body, keys on the meta line. */
export function InboxItem({
  entry,
  selected,
  onSelect,
  children,
}: {
  entry: InboxEntry
  selected: boolean
  onSelect: () => void
  /** The selected item's body, answers and facts, where the item is decided in place (Home's dock). */
  children?: ReactNode
}) {
  const cls = [
    'item',
    selected ? 'sel' : '',
    entry.kind !== 'request' ? entry.kind : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div
      className={cls}
      role='option'
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-id={entry.id}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      <div className='ih'>
        <i className='k' aria-hidden='true'>
          {entry.kind === 'proposal' ? '▶' : '◆'}
        </i>
        <span className='t' lang={isThai(entry.title) ? 'th' : undefined}>
          {entry.title}
        </span>
        <span
          className={`age${entry.ageHours >= 24 ? ' old' : ''}`}
          title={`waiting since ${entry.since}`}
        >
          {entry.age}
        </span>
      </div>
      <div className='who'>
        <Tag project={entry.project} />
        <span className='sep' aria-hidden='true'>
          ·
        </span>
        <span>{entry.where}</span>
        <span className='sep' aria-hidden='true'>
          ·
        </span>
        <span className={`kindlabel ${entry.kind}`}>
          {entry.held ? 'held' : entry.kind}
        </span>
        {entry.urgent ? (
          <>
            <span className='sep' aria-hidden='true'>
              ·
            </span>
            <span>urgent</span>
          </>
        ) : null}
        {entry.answer ? (
          <span className='keys'>
            {entry.answer.options.map((option) =>
              option.hotkey ? (
                <kbd key={option.key}>{option.hotkey}</kbd>
              ) : null,
            )}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  )
}

/**
 * `/inbox`: one list filtered by kind (the top bar's views)
 * and by project, and the selected item decided in the inspector. Keys: ↑ ↓
 * move · the letter printed on a button answers · ↵ opens where it's decided
 * · Esc closes.
 *
 * The page reads the whole queue, so the project filter (`?project=`) and the
 * selection (`?item=`) are this view's own: they live in the URL for links,
 * reloads and Back, and changing them never asks the server for the page again.
 */
export function InboxView({
  entries,
  kind,
}: {
  entries: InboxEntry[]
  kind: 'all' | 'requests' | 'proposals' | 'problems'
}) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const projectFilter = search.get('project') ?? 'all'
  const selectedId = search.get('item')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const wanted = kind === 'all' ? null : kind.slice(0, -1)
  const shown = entries.filter(
    (entry) =>
      (!wanted || entry.kind === wanted) &&
      (projectFilter === 'all' ||
        (projectFilter === 'hq'
          ? !entry.project
          : entry.project?.slug === projectFilter)),
  )
  // The selection is local and immediate — the URL follows it — so a key
  // pressed right after ↓ answers the item the owner now sees, never the one
  // before it while the router catches up.
  const [picked, setPicked] = useState<string | null>(selectedId)
  useEffect(() => setPicked(selectedId), [selectedId])
  const selected = shown.find((entry) => entry.id === picked) ?? null

  const href = (params: Record<string, string | null>) => {
    const next = new URLSearchParams()
    if (kind !== 'all') next.set('kind', kind)
    if (projectFilter !== 'all') next.set('project', projectFilter)
    for (const [key, value] of Object.entries(params)) {
      if (value === null) next.delete(key)
      else next.set(key, value)
    }
    const query = next.toString()
    return query ? `${pathname}?${query}` : pathname
  }
  const select = (id: string | null) => {
    setPicked(id)
    setNote('')
    setError(null)
    window.history.replaceState(null, '', href({ item: id }))
  }
  /** A filter link: a plain click filters here; a new tab still gets the URL. */
  const filterTo = (project: string | null) => ({
    href: href({ project, item: null }),
    // Filtering happens here, so there is no page to prefetch.
    prefetch: false,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainClick(event)) return
      event.preventDefault()
      setPicked(null)
      setNote('')
      setError(null)
      window.history.pushState(null, '', href({ project, item: null }))
    },
  })
  const answer = (choice: string) => {
    if (!selected?.answer) return
    setError(null)
    start(async () => {
      const result = await decide(selected, choice, note.trim() || undefined)
      if (!result.ok) setError(result.error)
      else {
        setNote('')
      }
    })
  }

  // The keys `?` lists and the footer shows: the selected item's answers first.
  usePageKeyHints([
    ...(selected?.answer?.options
      .filter((option) => option.hotkey)
      .map((option) => [option.hotkey, option.label.toLowerCase()] as const) ??
      []),
    ...(selected?.link ? ([['↵', 'open']] as const) : []),
    ['↑ ↓', 'waiting'],
    ['1–4', 'views'],
    ...(selected ? ([['Esc', 'close']] as const) : []),
  ])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        typing(event.target)
      )
        return
      const index = shown.findIndex((entry) => entry.id === selected?.id)
      if (event.key === 'ArrowDown' || event.key === 'j') {
        const next = shown[Math.min(shown.length - 1, index + 1)]
        if (next) {
          event.preventDefault()
          select(next.id)
        }
        return
      }
      if (event.key === 'ArrowUp' || event.key === 'k') {
        const next = shown[Math.max(0, index - 1)]
        if (next) {
          event.preventDefault()
          select(next.id)
        }
        return
      }
      if (event.key === 'Escape' && selected) {
        event.preventDefault()
        select(null)
        return
      }
      if (event.key === 'Enter' && selected?.link) {
        event.preventDefault()
        router.push(selected.link.href)
        return
      }
      const option = selected?.answer?.options.find(
        (entry) => entry.hotkey && entry.hotkey === event.key,
      )
      if (option && !pending) {
        event.preventDefault()
        answer(option.key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const projects = [
    ...new Map(
      entries
        .filter((entry) => entry.project)
        .map((entry) => [entry.project?.slug, entry.project]),
    ).values(),
  ].filter((project): project is NonNullable<InboxEntry['project']> =>
    Boolean(project),
  )
  const oldest = entries.reduce(
    (max, entry) => Math.max(max, entry.ageHours),
    0,
  )

  return (
    <div className='page inboxp'>
      <section className='pane queue-pane' aria-label='Waiting for you'>
        <header className='pane-head'>
          <span className='hud-label'>Waiting for you</span>
          {entries.length > 0 ? (
            <span className='dim'>
              <b className='n wait'>{entries.length}</b> · oldest{' '}
              {oldest < 1
                ? '<1h'
                : oldest < 48
                  ? `${Math.round(oldest)}h`
                  : `${Math.round(oldest / 24)}d`}{' '}
              · {kind === 'all' ? 'all kinds' : kind}
            </span>
          ) : (
            <span className='dim'>nothing waiting</span>
          )}
        </header>
        <div className='toolbar'>
          <nav className='who-filter' aria-label='Filter by project'>
            <Link
              {...filterTo(null)}
              aria-current={projectFilter === 'all' ? 'true' : undefined}
            >
              All
            </Link>
            {projects.map((project) => (
              <Link
                key={project.slug}
                {...filterTo(project.slug)}
                aria-current={
                  projectFilter === project.slug ? 'true' : undefined
                }
              >
                <i
                  className='dot'
                  style={{ ['--project' as string]: hex(project.color) }}
                  aria-hidden='true'
                />
                <span lang={isThai(project.name) ? 'th' : undefined}>
                  {project.name}
                </span>
              </Link>
            ))}
            {entries.some((entry) => !entry.project) ? (
              <Link
                {...filterTo('hq')}
                aria-current={projectFilter === 'hq' ? 'true' : undefined}
              >
                HQ
              </Link>
            ) : null}
          </nav>
          <span className='sp' />
          <span className='hits'>
            {shown.length} of {entries.length}
          </span>
        </div>
        <div className='pane-body'>
          {entries.length === 0 ? (
            <div className='calm'>
              <b>Nothing is waiting for you.</b>
              <p>
                Agents keep running inside their policies. This page stays quiet
                until one of them needs a decision.
              </p>
            </div>
          ) : shown.length === 0 ? (
            <div className='calm'>
              <b>Nothing here.</b>
              <p>
                {kind === 'proposals'
                  ? 'No agent proposals are waiting. Routines leave them here when they run.'
                  : kind === 'problems'
                    ? 'Every connection is fine.'
                    : 'Nothing in this filter.'}
              </p>
            </div>
          ) : (
            <div className='queue' role='listbox' aria-label='Waiting for you'>
              {shown.map((entry) => (
                <InboxItem
                  key={entry.id}
                  entry={entry}
                  selected={entry.id === selected?.id}
                  onSelect={() => select(entry.id)}
                />
              ))}
            </div>
          )}
        </div>
      </section>
      <Inspector
        id='inbox'
        label='Selected item'
        empty={!selected}
        onClose={() => select(null)}
      >
        {selected ? (
          <>
            <header className='pane-head'>
              <span
                className='hud-label'
                style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}
              >
                <Tag project={selected.project} />
                <span style={{ color: 'var(--ink-4)' }}>›</span>
                {selected.where}
              </span>
              <span
                className={`kindlabel ${selected.kind}`}
                style={{ marginLeft: 'auto' }}
              >
                {selected.kind}
              </span>
              <button
                type='button'
                className='iconbtn'
                style={{ width: 22, height: 22, marginLeft: 4 }}
                aria-label='Close (Esc)'
                title='Close (Esc)'
                onClick={() => select(null)}
              >
                <Icon name='close' size={14} />
              </button>
            </header>
            <div className='insp-body'>
              <div className='dev-read'>
                <div className='readout'>
                  <div
                    className={`big ${selected.kind === 'problem' ? 'accent' : 'wait'}`}
                  >
                    {selected.kind === 'problem'
                      ? '◆ connection'
                      : `◆ ${selected.age}`}
                  </div>
                  <div className='sub'>waiting since {selected.since}</div>
                </div>
                <dl className='facts'>
                  {selected.facts.map(([key, value]) => (
                    <div key={key} style={{ display: 'contents' }}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className='dev-main'>
                <h2
                  className='item-title'
                  lang={isThai(selected.title) ? 'th' : undefined}
                >
                  {selected.title}
                </h2>
                {selected.body ? (
                  <p className='item-body'>{selected.body}</p>
                ) : null}
                {selected.meanwhile ? (
                  <p className='quote'>
                    <span className='hud-label'>While it waits</span>
                    {selected.meanwhile}
                  </p>
                ) : null}
                {selected.quote ? (
                  <p
                    className='quote'
                    lang={isThai(selected.quote) ? 'th' : undefined}
                  >
                    <span className='hud-label'>Proposed</span>
                    {selected.quote}
                  </p>
                ) : null}
                {selected.answer ? (
                  <>
                    <textarea
                      className='note-field'
                      placeholder={
                        selected.kind === 'proposal'
                          ? 'Why, for the routine (optional)'
                          : 'Note for the agent (optional)'
                      }
                      aria-label='Note for the agent'
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                    />
                    <div className='acts'>
                      {selected.answer.options.map((option, index) => (
                        <button
                          key={option.key}
                          type='button'
                          className={`btn${index === 0 ? ' btn-pri' : ''}`}
                          disabled={pending}
                          onClick={() => answer(option.key)}
                        >
                          {option.label}
                          {option.hotkey ? <kbd>{option.hotkey}</kbd> : null}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
                {error ? (
                  <p className='why' role='alert'>
                    <b>Not answered:</b> {error}
                  </p>
                ) : null}
                <p className='why'>
                  <b>Why it stopped:</b> {selected.why}
                </p>
                {selected.link ? (
                  <div className='insp-links'>
                    <Link className='btn btn-sm' href={selected.link.href}>
                      {selected.link.label}
                      <kbd>↵</kbd>
                    </Link>
                  </div>
                ) : null}
                {selected.project ? (
                  <div className='insp-links'>
                    <Link
                      className='btn btn-sm'
                      href={`/p/${selected.project.slug}`}
                    >
                      Open project
                    </Link>
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <>
            <header className='pane-head'>
              <span className='hud-label'>Selected</span>
              <span className='dim'>nothing selected</span>
            </header>
            <div className='insp-body'>
              <div className='empty'>Select an item to decide it here.</div>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

/**
 * Waiting for you, docked on Home: the same queue as
 * `/inbox`, where the selected item opens in place — body, answers with
 * their keys, why it stopped and the facts. The page owns the keys (↑ ↓, the
 * letter on a button, ↵) and the answering (`useAnswer`), because Space
 * shares its keys with the orbit.
 */
export function InboxDock({
  entries,
  selectedId,
  onSelect,
  answering,
}: {
  entries: InboxEntry[]
  selectedId: string | null
  onSelect: (id: string) => void
  answering: ReturnType<typeof useAnswer>
}) {
  const { answer, pending, error } = answering
  const oldest = entries.reduce(
    (max, entry) => Math.max(max, entry.ageHours),
    0,
  )

  return (
    <aside
      className='pane inbox dock'
      aria-label='Waiting for you'
      data-scope='inbox'
      tabIndex={-1}
    >
      <header className='pane-head'>
        <span className='hud-label'>Waiting for you</span>
        <b
          className={`n${entries.length ? ' wait' : ''}`}
          style={entries.length ? undefined : { color: 'var(--ink-4)' }}
        >
          {entries.length}
        </b>
        <span className='dim'>
          {entries.length
            ? `oldest ${oldest < 1 ? '<1h' : oldest < 48 ? `${Math.round(oldest)}h` : `${Math.round(oldest / 24)}d`}`
            : 'nothing waiting'}
        </span>
      </header>
      <div className='pane-body'>
        {entries.length === 0 ? (
          <div className='empty'>Nothing is waiting for you.</div>
        ) : (
          <div className='queue' role='listbox' aria-label='Waiting for you'>
            {entries.map((entry) => {
              const selected = entry.id === selectedId
              return (
                <InboxItem
                  key={entry.id}
                  entry={entry}
                  selected={selected}
                  onSelect={() => onSelect(entry.id)}
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
                        <p className='quote'>
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
                              {option.hotkey ? (
                                <kbd>{option.hotkey}</kbd>
                              ) : null}
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
                            <kbd>↵</kbd>
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
        )}
      </div>
    </aside>
  )
}

/** Answer a request from anywhere but `/inbox` (Home's dock): the same action, which re-renders the page. */
export function useAnswer() {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const answer = (entry: InboxEntry, choice: string) => {
    if (!entry.answer || pending) return
    setError(null)
    start(async () => {
      const result = await decide(entry, choice)
      if (!result.ok) setError(result.error)
    })
  }
  return { answer, pending, error }
}

/** One answer, to whichever kind of item it is. */
function decide(entry: InboxEntry, choice: string, note?: string) {
  const expectedRevision = entry.answer?.revision ?? 0
  if (entry.answer?.target === 'proposal')
    return decideProposalAction({
      proposalId: entry.id,
      expectedRevision,
      choice: choice as 'accept' | 'reject' | 'hold' | 'unhold',
      note,
    })
  return respondAction({ requestId: entry.id, expectedRevision, choice, note })
}
