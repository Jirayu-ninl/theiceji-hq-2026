'use client'

import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { ConsoleData, ConsoleRunRow } from '@/lib/console'
import { readConsoleAction } from './console-actions'
import { Icon } from './shell/Icon'
import { type KeyHint, usePageKeyList } from './shell/keys'
import { Splitter } from './shell/Splitter'
import './console.css'

/**
 * The console: a 240px LCD panel in the shell grid's
 * `console` row, under the stage and above the footer — Log (the owner's
 * audit trail, newest at the bottom), Runs (agent runs, running first) and
 * Shortcuts (every key the shell and this page answer to). ⌃` and the
 * footer's `⌃` console` toggle it, the footer's `▶ n` opens it on Runs, Esc
 * or × closes it. It is not remembered across loads, and it reads its data
 * only when it opens — again each time it reopens.
 */

export type ConsoleTab = 'log' | 'runs' | 'shortcuts'

/** The panel's id — the footer toggle's `aria-controls`. */
export const CONSOLE_ID = 'console'

const TABS: { id: ConsoleTab; label: string }[] = [
  { id: 'log', label: 'Log' },
  { id: 'runs', label: 'Runs' },
  { id: 'shortcuts', label: 'Shortcuts' },
]

type Load =
  | { status: 'idle' }
  | { status: 'loading'; data: ConsoleData | null }
  | { status: 'ready'; data: ConsoleData }
  | { status: 'error'; error: string; data: ConsoleData | null }

/** The console's top edge drags: 120px up to what leaves the stage 160px. */
const measureConsole = () =>
  document.getElementById(CONSOLE_ID)?.getBoundingClientRect().height ?? 240
const consoleMax = () => Math.max(120, window.innerHeight - 44 - 28 - 160)

const isThai = (text: string) => /\p{Script=Thai}/u.test(text)
const th = (text: string) => (isThai(text) ? 'th' : undefined)

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' })
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
})
const FULL = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
})
const pad = (n: number) => String(n).padStart(2, '0')

/** `14:31:58` today, `Tue 12:00` this week, `12 Sep 14:10` before that. */
function stamp(iso: string, now: number): string {
  const at = new Date(iso)
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (at.toDateString() === new Date(now).toDateString())
    return `${hm}:${pad(at.getSeconds())}`
  if (now - at.getTime() < 6 * 86_400_000) return `${WEEKDAY.format(at)} ${hm}`
  return `${DAY_MONTH.format(at)} ${hm}`
}

/** The Agents page's words for a run, in their short form. */
const RUN_WORD: Record<ConsoleRunRow['state'], string> = {
  running: 'running',
  succeeded: 'done',
  failed: 'failed',
  budget: 'budget spent',
  abandoned: 'abandoned',
  cancelled: 'released',
}
const runTone = (state: ConsoleRunRow['state']) =>
  state === 'running'
    ? 'running'
    : state === 'failed' || state === 'budget'
      ? 'failed'
      : 'idle'

export function Console({
  open,
  tab,
  focus,
  viewLabels,
  onTab,
  onClose,
}: {
  open: boolean
  tab: ConsoleTab
  /** Bumped when a key opened the console: focus moves to its tabs. */
  focus: number
  /** This page's views, for the `1 2 3` row of Shortcuts. */
  viewLabels: string[]
  onTab: (tab: ConsoleTab) => void
  onClose: () => void
}) {
  const base = useId()
  const ref = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const inside = useRef(false)
  const request = useRef(0)
  const [load, setLoad] = useState<Load>({ status: 'idle' })
  const pageKeys = usePageKeyList()

  // The grid row follows `data-console` on <html>; closing hands focus back.
  useLayoutEffect(() => {
    const root = document.documentElement
    if (open) {
      root.dataset.console = 'open'
      const active = document.activeElement as HTMLElement | null
      opener.current =
        active && active !== document.body && !ref.current?.contains(active)
          ? active
          : null
      return
    }
    delete root.dataset.console
    if (inside.current || ref.current?.contains(document.activeElement)) {
      inside.current = false
      const back = opener.current?.isConnected
        ? opener.current
        : document.getElementById('console-toggle')
      back?.focus()
    }
  }, [open])

  useEffect(
    () => () => {
      delete document.documentElement.dataset.console
    },
    [],
  )

  // Read on every open; a reply to an older open is dropped.
  useEffect(() => {
    if (!open) return
    const seq = ++request.current
    setLoad((last) => ({
      status: 'loading',
      data: last.status === 'idle' ? null : last.data,
    }))
    readConsoleAction()
      .then((result) => {
        if (seq !== request.current) return
        setLoad((last) =>
          result.ok
            ? { status: 'ready', data: result.data }
            : {
                status: 'error',
                error: result.error,
                data: last.status === 'idle' ? null : last.data,
              },
        )
      })
      .catch(() => {
        if (seq !== request.current) return
        setLoad((last) => ({
          status: 'error',
          error: 'The console couldn’t be read. Try again in a moment.',
          data: last.status === 'idle' ? null : last.data,
        }))
      })
  }, [open])

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus follows each key that opened the console, not its tab
  useEffect(() => {
    if (focus > 0 && open)
      document.getElementById(`${base}-tab-${tab}`)?.focus()
  }, [focus])

  const data = load.status === 'idle' ? null : load.data
  const log = data?.log ?? null

  // Log reads newest at the bottom: open it scrolled there.
  useLayoutEffect(() => {
    if (open && tab === 'log' && log && body.current)
      body.current.scrollTop = body.current.scrollHeight
  }, [open, tab, log])

  const moveTab = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((entry) => entry.id === tab)
    const next =
      event.key === 'ArrowRight'
        ? (at + 1) % TABS.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + TABS.length) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TABS.length - 1
              : -1
    const target = TABS[next]
    if (!target) return
    event.preventDefault()
    onTab(target.id)
    document.getElementById(`${base}-tab-${target.id}`)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return
    // An open popover or dialog takes Esc first: one layer at a time.
    if (document.querySelector(':popover-open, dialog[open]')) return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  const now = Date.now()
  const shellKeys: KeyHint[] = [
    ['⌘K', 'Go anywhere'],
    ['⌘P', 'Switch project'],
    viewLabels.length > 0
      ? [
          viewLabels
            .slice(0, 9)
            .map((_, index) => index + 1)
            .join(' '),
          viewLabels.slice(0, 9).join(' · '),
        ]
      : ['1 2 3', 'This page’s views'],
    ['\\', 'Show / hide rail'],
    ['⇧\\', 'Wide / narrow rail'],
    ['⇧I', 'Show / hide inspector'],
    ['⌃`', 'Console'],
    ['i', 'Waiting for you'],
    ['n', 'Jot a note'],
    ['?', 'Shortcuts'],
    ['↑ ↓', 'Move in a list'],
    ['↵', 'Open'],
    ['Esc', 'Close'],
  ]

  const note = (text: string, tone?: 'problem') => (
    <p className={`console-note${tone ? ` ${tone}` : ''}`}>{text}</p>
  )

  let content: ReactNode
  if (tab === 'shortcuts') {
    content = (
      <dl className='shortcuts-grid'>
        {[...shellKeys, ...pageKeys].map(([key, label], index) => (
          <div key={`${index}-${key}`}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
    )
  } else if (!data) {
    content =
      load.status === 'error' ? note(`◆ ${load.error}`, 'problem') : note('…')
  } else if (tab === 'log') {
    content =
      data.log.length === 0 ? (
        note('○ nothing logged yet')
      ) : (
        <ol className='log'>
          {data.log.map((row) => (
            <li key={row.id} title={row.reason ?? undefined}>
              <time
                className='ts'
                dateTime={row.at}
                title={FULL.format(new Date(row.at))}
              >
                {stamp(row.at, now)}
              </time>
              <span className='actor' lang={th(row.actor)}>
                {row.actor}
              </span>
              <span className='act'>{row.action}</span>
              <span
                className={`res${row.tone ? ` ${row.tone}` : ''}`}
                lang={th(row.result)}
                title={row.reason ?? row.result}
              >
                {row.result}
              </span>
            </li>
          ))}
        </ol>
      )
  } else {
    content =
      data.runs.length === 0 ? (
        note('○ no runs yet')
      ) : (
        <ol className='runs'>
          {data.runs.map((run) => (
            <li
              key={run.id}
              className='run'
              title={`${run.label} · started ${FULL.format(new Date(run.startedAt))}`}
            >
              <span className='label' lang={th(run.label)}>
                {run.label}
              </span>
              <span
                className='prog'
                aria-hidden='true'
                style={{
                  ['--level' as string]:
                    run.state === 'running' ? '100%' : '0%',
                }}
              >
                <i />
              </span>
              <span className={`state state-${runTone(run.state)}`}>
                {RUN_WORD[run.state]}
              </span>
              <span className='cost'>
                {run.cost === '—' ? (
                  <>
                    <span aria-hidden='true'>—</span>
                    <span className='sr-only'>no cost recorded</span>
                  </>
                ) : (
                  run.cost
                )}
              </span>
            </li>
          ))}
        </ol>
      )
  }

  const stale = load.status === 'error' && data
  return (
    <section
      ref={ref}
      id={CONSOLE_ID}
      className='console'
      aria-label='Console'
      inert={!open}
      onKeyDown={onKeyDown}
      onFocus={() => {
        inside.current = true
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          inside.current = false
      }}
    >
      <Splitter
        id='console'
        label='Resize the console'
        edge='top'
        measure={measureConsole}
        min={120}
        max={consoleMax}
      />
      <div
        className='console-tabs'
        role='tablist'
        aria-label='Console'
        onKeyDown={moveTab}
      >
        {TABS.map((entry) => (
          <button
            key={entry.id}
            id={`${base}-tab-${entry.id}`}
            type='button'
            role='tab'
            aria-selected={entry.id === tab}
            aria-controls={`${base}-panel`}
            tabIndex={entry.id === tab ? 0 : -1}
            onClick={() => onTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
        <span className='sp' />
        {stale ? <span className='console-stale'>◆ not refreshed</span> : null}
        <button
          type='button'
          className='iconbtn'
          aria-label='Close console'
          title='Close (Esc)'
          onClick={onClose}
        >
          <Icon name='close' size={14} />
        </button>
      </div>
      <div
        ref={body}
        id={`${base}-panel`}
        className='console-body'
        role='tabpanel'
        aria-labelledby={`${base}-tab-${tab}`}
        aria-busy={load.status === 'loading'}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the panel scrolls, so the keyboard needs to reach it
        tabIndex={0}
      >
        {content}
      </div>
    </section>
  )
}
