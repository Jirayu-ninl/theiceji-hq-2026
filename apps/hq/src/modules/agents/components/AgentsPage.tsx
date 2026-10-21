'use client'

import { describeCron, isCron } from '@theiceji/hq-agents/cron'
import Link from 'next/link'
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { decideProposalAction } from '@/app/(app)/inbox/actions'
import {
  age,
  Dot,
  Empty,
  Facts,
  Inspector,
  InspectorHead,
  PaneHead,
  Readout,
  Tag,
  usePageKeys,
} from '@/components/bridge/parts'
import { type InboxEntry, InboxItem } from '@/components/Inbox'
import { usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import { Markdown } from '@/lib/md'
import {
  deleteRoutineAction,
  restoreRoutineAction,
  routineDetailAction,
  runRoutineNowAction,
  saveRoutineAction,
  setRoutineEnabledAction,
} from '../actions'
import { costText, type RoutineData, type RunData } from '../data'
import type { AgentsPageProps, AgentsProject } from '../load'

/**
 * Agents: the
 * owner's routines — when an agent runs, what it reads, who runs it — their
 * runs with what they cost, and the proposals they left. Table + Inspector,
 * with the proposals that wait under the table.
 *
 * The instrument is the run strip: one column per run over the last 14 days
 * on one money scale — height = cost, dashed = cost not known — with the
 * state as a glyph cap (▶ running · ◆ waits on you · amber ◆ failed or
 * stopped), a playhead at now and a ring at the next due time.
 *
 * Keys: `c` new · `e` edit · `r` run now · `t`/space on-off · `⌫` delete ·
 * ↑↓ move · `⌘S` saves · Esc cancels. In the proposals pane `a` accept ·
 * `r` reject · `h` hold. Delete goes to the Trash view,
 * where Restore `r` brings a routine back switched off.
 */

const DAY = 86_400_000
const KNOWN_KINDS = [
  ['note', 'Notes', 'A note on the board — the owner reads and files it.'],
  [
    'prompt_variant',
    'Prompt variants',
    'A new variant next to the old ones — nothing is generated.',
  ],
] as const
const NEVER = [
  [
    'card',
    'Board cards',
    'A card is work with a price; you decide what gets done.',
  ],
  [
    'shot',
    'Shots',
    'The shot board is your film; a shot lands only when you say.',
  ],
  [
    'event',
    'Calendar events',
    'Your time is yours; an event lands only when you accept it.',
  ],
  [
    'experiment',
    'Experiments',
    'An experiment changes what gets posted; you start one yourself.',
  ],
] as const

const pad = (n: number) => String(n).padStart(2, '0')
/**
 * Times read in the owner's zone — fixed, not the machine's, so the server
 * and the browser draw the same thing (HQ's default zone has no DST).
 */
const ZONE = 'Asia/Bangkok'
const ZONE_OFFSET = 7 * 3_600_000
const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const dayName = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  weekday: 'short',
  day: 'numeric',
})
const dayKey = (at: number) => Math.floor((at + ZONE_OFFSET) / DAY)
/** Midnight in the owner's zone on or before `at`. */
const midnight = (at: number) => dayKey(at) * DAY - ZONE_OFFSET
function when(iso: string | null, now: number): string {
  if (!iso) return '—'
  const at = Date.parse(iso)
  const time = clock.format(at)
  if (dayKey(at) === dayKey(now)) return time
  return `${dayName.format(at)} ${time}`
}
function duration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`
}
const tokens = (n: number | null) =>
  n === null
    ? ''
    : n >= 10_000
      ? `${Math.round(n / 1000)}k tok`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k tok`
        : `${n} tok`
const shortId = (id: string) => `#${id.slice(0, 4)}`

function Glyph({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <i className={`glyph ${tone}`} aria-hidden='true'>
      {children}{' '}
    </i>
  )
}

function RunWord({ run, short }: { run: RunData; short?: boolean }) {
  switch (run.state) {
    case 'running':
      return (
        <span className='state-word live'>
          <Glyph tone='live'>▶</Glyph>running
        </span>
      )
    case 'budget':
      return (
        <span className='state-word problem' title={run.error ?? undefined}>
          <Glyph tone='due'>◆</Glyph>
          {short ? '' : 'stopped · '}budget spent
        </span>
      )
    case 'failed':
      return (
        <span className='state-word problem' title={run.error ?? undefined}>
          <Glyph tone='due'>◆</Glyph>failed
        </span>
      )
    case 'abandoned':
      return <span className='state-word off'>abandoned · lease lapsed</span>
    case 'cancelled':
      return <span className='state-word off'>released</span>
    default:
      return <span className='state-word'>done</span>
  }
}

/* ── The run strip ─────────────────────────────────────────────────── */

const NICE = [
  1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000,
  50_000, 100_000,
]

function RunStrip({
  routine,
  runs,
  now,
  mark,
}: {
  routine: RoutineData
  runs: RunData[]
  now: number
  mark?: string | null
}) {
  const t0 = now - 14 * DAY
  const t1 = now + DAY
  const x = (at: number) => (((at - t0) / (t1 - t0)) * 100).toFixed(2)
  const inWindow = runs.filter((run) => Date.parse(run.startedAt) >= t0)
  // One scale for one currency: the one most runs were charged in.
  const currency =
    inWindow.flatMap((run) => run.costMinor.map((line) => line.currency))[0] ??
    null
  const costOf = (run: RunData) =>
    currency
      ? (run.costMinor.find((line) => line.currency === currency)?.minor ??
        null)
      : null
  const known = inWindow.filter((run) => costOf(run) !== null)
  const max = Math.max(0, ...known.map((run) => costOf(run) as number))
  const top = max
    ? (NICE.find((value) => value * 100 >= max) ?? max / 100) * 100
    : 0
  const unknown = inWindow.filter(
    (run) => costOf(run) === null && run.state !== 'running',
  ).length
  const sum = known.reduce((total, run) => total + (costOf(run) as number), 0)
  const next = routine.nextDueAt ? Date.parse(routine.nextDueAt) : null
  const days: number[] = []
  for (let at = midnight(t0) + DAY; at < t1; at += DAY) days.push(at)
  const summary = !inWindow.length
    ? routine.enabled
      ? 'no runs in 14 days'
      : 'no runs · off'
    : `${inWindow.length} run${inWindow.length === 1 ? '' : 's'} · ${currency ? costText([{ currency, minor: sum }], 0) : '—'}${unknown ? ` · ${unknown} not known` : ''}${next ? ` · next ${when(routine.nextDueAt, now)}` : ''}`
  const has = (state: RunData['state']) =>
    inWindow.some((run) => run.state === state)
  return (
    <div
      className='rstrip'
      role='img'
      aria-label={`${routine.name}: runs over the last 14 days. ${summary}.`}
    >
      <div className='rs-h'>
        <span className='hud-label'>runs · 14 days</span>
        <span className='sum'>{summary}</span>
      </div>
      <div className='rs-plot' aria-hidden='true'>
        {top && currency ? (
          <i className='rs-top'>
            <span>{costText([{ currency, minor: top }], 0)}</span>
          </i>
        ) : null}
        {days.map((at) => (
          <i
            key={at}
            className='rs-day'
            style={{ ['--x' as string]: `${x(at)}%` }}
          />
        ))}
        <i className='rs-base' />
        {inWindow.map((run) => {
          const at = Date.parse(run.startedAt)
          const pos =
            run.state === 'running'
              ? Math.min(Number(x(at)), Number(x(now)) - 1.6)
              : Number(x(at))
          const cost = costOf(run)
          const height = cost === null ? 100 : top ? (cost / top) * 100 : 0
          const cls = [
            'rn',
            run.state === 'running' ? 'run' : '',
            run.state === 'failed' || run.state === 'budget' ? 'fail' : '',
            cost === null ? 'nk' : '',
          ]
            .filter(Boolean)
            .join(' ')
          const cap =
            run.state === 'running'
              ? ['live', '▶']
              : run.state === 'failed' || run.state === 'budget'
                ? ['due', '◆']
                : null
          const style = {
            ['--x' as string]: `${pos.toFixed(2)}%`,
            ['--h' as string]: `${height.toFixed(1)}%`,
          }
          return (
            <span key={run.id}>
              <i className={cls} style={style} />
              {cap ? (
                <b className={`rs-cap ${cap[0]}`} style={style}>
                  {cap[1]}
                </b>
              ) : null}
              {mark === run.id ? <i className='rs-sel' style={style} /> : null}
            </span>
          )
        })}
        {next && next <= t1 ? (
          <i className='rs-next' style={{ ['--x' as string]: `${x(next)}%` }} />
        ) : null}
        <i className='rs-now' style={{ ['--x' as string]: `${x(now)}%` }} />
      </div>
      <div className='rs-axis' aria-hidden='true'>
        {days
          .filter((_, index) => (days.length - 1 - index) % 2 === 0)
          .map((at) => (
            <span key={at} style={{ ['--x' as string]: `${x(at + DAY / 2)}%` }}>
              {dayName.format(at)}
            </span>
          ))}
      </div>
      <div className='rs-leg' aria-hidden='true'>
        <span>
          <i className='lg bar' />
          cost
        </span>
        {has('running') ? (
          <span>
            <b className='live'>▶</b>running
          </span>
        ) : null}
        {has('failed') || has('budget') ? (
          <span>
            <b className='due'>◆</b>failed · stopped
          </span>
        ) : null}
        {unknown ? (
          <span>
            <i className='lg nk' />
            cost not known
          </span>
        ) : null}
        <span>
          <i className='lg now' />
          now
        </span>
        {next ? (
          <span>
            <i className='lg next' />
            next
          </span>
        ) : null}
      </div>
    </div>
  )
}

/* ── The page ──────────────────────────────────────────────────────── */

type Mode = 'read' | 'edit' | 'new'

export function AgentsPage(props: AgentsPageProps) {
  const toast = useToast()
  const now = props.now
  const [routines, setRoutines] = useState(props.routines)
  const [runs, setRuns] = useState(props.selectedRuns)
  const [selected, setSelected] = useState<string | null>(props.selectedId)
  const [mode, setMode] = useState<Mode>('read')
  const [onoff, setOnoff] = useState<'all' | 'on' | 'off'>('all')
  const [who, setWho] = useState('all')
  const [runState, setRunState] = useState('all')
  const [runOf, setRunOf] = useState('all')
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [proposals, setProposals] = useState(props.proposals)
  const [proposal, setProposal] = useState<string | null>(
    props.proposals[0]?.id ?? null,
  )
  const [pending, start] = useTransition()
  const propsPane = useRef<HTMLElement>(null)
  const all = props.scope === null
  const view = props.view
  const trash = view === 'trash'

  useEffect(() => setRoutines(props.routines), [props.routines])
  useEffect(() => setProposals(props.proposals), [props.proposals])

  const current = routines.find((routine) => routine.id === selected) ?? null
  const shown = routines.filter(
    (routine) =>
      (onoff === 'all' ||
        (onoff === 'on' ? routine.enabled : !routine.enabled)) &&
      (!all ||
        who === 'all' ||
        (who === 'hq' ? !routine.projectId : routine.project?.slug === who)),
  )
  const shownRuns = props.runs.filter(
    (run) =>
      (runOf === 'all' || run.routineId === runOf) &&
      (runState === 'all' || run.state === runState),
  )
  const currentRun = props.runs.find((run) => run.id === selectedRun) ?? null

  const select = async (id: string | null) => {
    setSelected(id)
    setMode('read')
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('routine', id)
    else url.searchParams.delete('routine')
    window.history.replaceState(null, '', url)
    if (!id) return
    const result = await routineDetailAction(id)
    if (result.ok) setRuns(result.data.runs)
  }
  const replace = (routine: RoutineData, nextRuns?: RunData[]) => {
    setRoutines((list) =>
      list.some((entry) => entry.id === routine.id)
        ? list.map((entry) => (entry.id === routine.id ? routine : entry))
        : [...list, routine].sort((a, b) => a.name.localeCompare(b.name)),
    )
    if (nextRuns) setRuns(nextRuns)
  }

  const toggle = (routine: RoutineData) =>
    start(async () => {
      const result = await setRoutineEnabledAction({
        routineId: routine.id,
        expectedRevision: routine.revision,
        enabled: !routine.enabled,
      })
      if (!result.ok) return toast(result.error)
      replace(result.data.routine, result.data.runs)
      toast(
        result.data.routine.enabled
          ? `${routine.name} is on — next ${when(result.data.routine.nextDueAt, Date.now())}`
          : `${routine.name} is off — nothing is queued until you turn it on`,
      )
    })
  const runNow = (routine: RoutineData) =>
    start(async () => {
      const result = await runRoutineNowAction(routine.id)
      if (!result.ok) return toast(result.error)
      replace(result.data.routine, result.data.runs)
      toast(
        result.data.queued
          ? routine.runner === 'builtin'
            ? `${routine.name} queued — HQ’s runner takes it on its next poll`
            : `${routine.name} queued — your agent claims it over MCP`
          : `${routine.name} already has a run waiting`,
      )
    })
  /** A routine leaves this list; its neighbour is selected. */
  const drop = (id: string) => {
    const index = shown.findIndex((routine) => routine.id === id)
    const next = shown[index + 1] ?? shown[index - 1] ?? null
    setRoutines((list) => list.filter((routine) => routine.id !== id))
    void select(next && next.id !== id ? next.id : null)
  }
  /** Delete `⌫`: to the Trash, with Undo — it comes back switched off. */
  const remove = (routine: RoutineData) =>
    start(async () => {
      const result = await deleteRoutineAction(routine.id)
      if (!result.ok) return toast(result.error)
      drop(routine.id)
      toast(`Deleted ${routine.name} — Undo brings it back switched off`, {
        undo: async () => {
          const back = await restoreRoutineAction(routine.id)
          if (!back.ok) return toast(back.error)
          replace(back.data.routine, back.data.runs)
          setSelected(back.data.routine.id)
        },
      })
    })
  /** Restore `r` from the Trash: back in Routines, off until the owner turns it on. */
  const restore = (routine: RoutineData) =>
    start(async () => {
      const result = await restoreRoutineAction(routine.id)
      if (!result.ok) return toast(result.error)
      drop(routine.id)
      toast(`Restored ${routine.name} — it’s off until you turn it on`)
    })

  const decide = (
    entry: InboxEntry,
    choice: 'accept' | 'reject' | 'hold' | 'unhold',
  ) =>
    start(async () => {
      const result = await decideProposalAction({
        proposalId: entry.id,
        expectedRevision: entry.answer?.revision ?? 0,
        choice,
      })
      if (!result.ok) return toast(result.error)
      if (choice === 'accept' || choice === 'reject') {
        setProposals((list) => list.filter((item) => item.id !== entry.id))
        toast(
          choice === 'accept'
            ? `Accepted “${entry.title}”`
            : `Rejected “${entry.title}” — the routine reads why`,
        )
      }
    })

  usePageKeyHints(
    view === 'runs'
      ? [['↑ ↓', 'runs']]
      : trash
        ? [
            ['r', 'restore'],
            ['↑ ↓', 'routines'],
          ]
        : [
            ['c', 'new routine'],
            ['e', 'edit'],
            ['r', 'run now'],
            ['t', 'on / off'],
            ['⌫', 'delete'],
            ['a r h', 'proposals'],
          ],
  )
  usePageKeys((key) => {
    // The form comes first: Esc outside its fields cancels it, as inside.
    if (mode !== 'read') {
      if (key !== 'Escape') return false
      setMode('read')
      return true
    }
    const inProps = propsPane.current?.contains(document.activeElement) ?? false
    if (inProps) {
      const entry = proposals.find((item) => item.id === proposal)
      if (!entry) return false
      if (key === 'a') decide(entry, 'accept')
      else if (key === 'r') decide(entry, 'reject')
      else if (key === 'h') decide(entry, entry.held ? 'unhold' : 'hold')
      else return false
      return true
    }
    if (view === 'runs') {
      const index = shownRuns.findIndex((run) => run.id === selectedRun)
      if (key === 'ArrowDown' || key === 'j') {
        setSelectedRun(
          shownRuns[Math.min(shownRuns.length - 1, index + 1)]?.id ?? null,
        )
        return true
      }
      if (key === 'ArrowUp' || key === 'k') {
        setSelectedRun(shownRuns[Math.max(0, index - 1)]?.id ?? null)
        return true
      }
      return false
    }
    const index = shown.findIndex((routine) => routine.id === selected)
    if (key === 'ArrowDown' || key === 'j') {
      const next = shown[Math.min(shown.length - 1, index + 1)]
      if (next) void select(next.id)
      return Boolean(next)
    }
    if (key === 'ArrowUp' || key === 'k') {
      const next = shown[Math.max(0, index - 1)]
      if (next) void select(next.id)
      return Boolean(next)
    }
    if (trash) {
      if (key !== 'r' || !current || pending) return false
      restore(current)
      return true
    }
    if (key === 'c') {
      setMode('new')
      return true
    }
    if (!current) return false
    if (key === 'e') setMode('edit')
    else if (key === 'r') runNow(current)
    else if (key === 't' || key === ' ') toggle(current)
    else if (key === 'Backspace' || key === 'Delete') {
      if (!pending) remove(current)
    } else return false
    return true
  })

  const sevenDays = props.runs.filter(
    (run) => Date.parse(run.startedAt) >= now - 7 * DAY,
  )
  const weekCost = useMemo(() => {
    const byCurrency = new Map<string, number>()
    for (const run of sevenDays)
      for (const line of run.costMinor)
        byCurrency.set(
          line.currency,
          (byCurrency.get(line.currency) ?? 0) + line.minor,
        )
    return [...byCurrency].map(([currency, minor]) => ({ currency, minor }))
  }, [sevenDays])
  const weekUnknown = sevenDays.filter(
    (run) => !run.costMinor.length && run.state !== 'running',
  ).length
  const runningNow = props.runs.filter((run) => run.state === 'running')
  const nextDue = routines
    .filter((routine) => routine.nextDueAt)
    .sort((a, b) =>
      (a.nextDueAt as string).localeCompare(b.nextDueAt as string),
    )[0]

  const owners: [string, string][] = all
    ? [
        ['all', 'all projects'],
        ...(routines.some((routine) => !routine.projectId)
          ? ([['hq', 'HQ · no project']] as [string, string][])
          : []),
        ...props.projects
          .filter((project) =>
            routines.some((routine) => routine.project?.slug === project.slug),
          )
          .map((project) => [project.slug, project.name] as [string, string]),
      ]
    : []

  const list =
    view === 'runs' ? (
      <section className='pane ag-pane' aria-label='Runs'>
        <PaneHead
          title='Agents · runs'
          meta={`${props.runs.length} run${props.runs.length === 1 ? '' : 's'}`}
        />
        <div className='toolbar'>
          {/* biome-ignore lint/a11y/useSemanticElements: a segmented control */}
          <span className='seg' role='group' aria-label='Status'>
            {[
              ['all', 'all'],
              ['running', '▶ running'],
              ['succeeded', 'done'],
              ['failed', 'failed'],
              ['budget', 'budget'],
            ].map(([value, label]) => (
              <button
                key={value}
                type='button'
                aria-pressed={runState === value}
                onClick={() => setRunState(value as string)}
              >
                {label}
              </button>
            ))}
          </span>
          <select
            value={runOf}
            onChange={(event) => setRunOf(event.target.value)}
            aria-label='Routine'
          >
            <option value='all'>all routines</option>
            {routines.map((routine) => (
              <option key={routine.id} value={routine.id}>
                {routine.name}
              </option>
            ))}
          </select>
          <span className='sp' />
          <span className='hits'>
            {shownRuns.length} of {props.runs.length}
          </span>
        </div>
        <div className='ag-read'>
          <Readout
            big={
              <>
                {sevenDays.length} <span className='u'>runs · 7 days</span>
              </>
            }
            sub={[
              `${sevenDays.filter((run) => run.state === 'succeeded').length} done`,
              sevenDays.some(
                (run) => run.state === 'failed' || run.state === 'budget',
              )
                ? `${sevenDays.filter((run) => run.state === 'failed' || run.state === 'budget').length} failed or stopped`
                : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          />
          <Readout
            big={
              <>
                {costText(weekCost, 0)} <span className='u'>7 days</span>
              </>
            }
            sub={`${sevenDays.reduce((total, run) => total + (run.tokens ?? 0), 0).toLocaleString('en-US')} tokens${weekUnknown ? ` · ${weekUnknown} cost not reported` : ''}`}
          />
          <Readout
            big={
              <>
                {runningNow.length ? `▶ ${runningNow.length}` : '0'}{' '}
                <span className='u'>running</span>
              </>
            }
            sub={runningNow.length ? 'in flight now' : 'nothing in flight'}
            tone={runningNow.length ? 'live' : ''}
          />
        </div>
        <div className='pane-body'>
          {!props.runs.length ? (
            <Empty>
              {routines.length
                ? '○ no runs yet'
                : 'No routines yet — nothing has run.'}
            </Empty>
          ) : shownRuns.length ? (
            <div className='tbl run-tbl' role='listbox' aria-label='Runs'>
              <div className='tbl-head' aria-hidden='true'>
                <span className='hud-label'>run</span>
                <span className='hud-label c-rt'>routine</span>
                <span className='hud-label c-at'>started</span>
                <span className='hud-label c-took'>took</span>
                <span className='hud-label c-st'>status</span>
                <span className='hud-label c-sum'>summary</span>
                <span className='hud-label num c-np' title='proposals'>
                  ▶
                </span>
                <span className='hud-label num cost'>cost</span>
              </div>
              {shownRuns.map((run) => {
                const routine = routines.find(
                  (entry) => entry.id === run.routineId,
                )
                return (
                  <button
                    key={run.id}
                    type='button'
                    role='option'
                    aria-selected={run.id === selectedRun}
                    className={`tbl-row${run.id === selectedRun ? ' sel' : ''}`}
                    onClick={() => setSelectedRun(run.id)}
                  >
                    <span className='id'>{shortId(run.id)}</span>
                    <span className='c-rt'>
                      {routine?.project ? (
                        <Dot color={routine.project.color} />
                      ) : null}
                      <span>{routine?.name ?? 'a task'}</span>
                    </span>
                    <span className='c-at'>{when(run.startedAt, now)}</span>
                    <span className='c-took'>
                      {duration(
                        run.durationS ??
                          Math.round((now - Date.parse(run.startedAt)) / 1000),
                      )}
                    </span>
                    <span className='c-st'>
                      <RunWord run={run} short />
                    </span>
                    <span className='c-sum'>
                      {run.summary ?? run.error ?? ''}
                    </span>
                    <span className='num c-np'>{run.proposals || ''}</span>
                    <span
                      className={`num cost${run.costMinor.length ? '' : ' nk'}`}
                    >
                      {run.costMinor.length ? costText(run.costMinor, 0) : '—'}
                      <small>
                        {run.costMinor.length
                          ? tokens(run.tokens)
                          : run.state === 'running'
                            ? 'when it ends'
                            : 'not reported'}
                      </small>
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <Empty>○ nothing here</Empty>
          )}
        </div>
      </section>
    ) : trash ? (
      <section className='pane ag-pane' aria-label='Deleted routines'>
        <PaneHead
          title='Agents · trash'
          meta={`${routines.length} deleted · restore brings one back, switched off`}
        />
        <div className='toolbar'>
          {all ? (
            <select
              value={who}
              onChange={(event) => setWho(event.target.value)}
              aria-label='Project'
            >
              {owners.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          ) : null}
          <span className='sp' />
          <span className='hits'>
            {shown.length} of {routines.length}
          </span>
        </div>
        <div className='pane-body'>
          {shown.length ? (
            <div
              className={`tbl tr-tbl${all ? '' : ' one'}`}
              role='listbox'
              aria-label='Deleted routines'
            >
              <div className='tbl-head' aria-hidden='true'>
                <span className='hud-label'>routine</span>
                {all ? <span className='hud-label c-proj'>project</span> : null}
                <span className='hud-label c-sch'>schedule</span>
                <span className='hud-label num'>deleted</span>
              </div>
              {shown.map((routine) => (
                <div
                  key={routine.id}
                  role='option'
                  tabIndex={-1}
                  aria-selected={routine.id === selected}
                  className={`tbl-row${routine.id === selected ? ' sel' : ''}`}
                  onClick={() => void select(routine.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void select(routine.id)
                  }}
                >
                  <span className='nm'>
                    {all && routine.project ? (
                      <Dot color={routine.project.color} />
                    ) : null}
                    <b>{routine.name}</b>
                  </span>
                  {all ? (
                    <span className='c-proj'>
                      <Tag project={routine.project} />
                    </span>
                  ) : null}
                  <span
                    className='c-sch'
                    title={`${routine.cron} · ${routine.timezone}`}
                  >
                    {routine.schedule}
                  </span>
                  <span className='c-gone num'>
                    {age(routine.trashedAt)} ago
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>○ nothing here</Empty>
          )}
        </div>
      </section>
    ) : (
      <section className='pane ag-pane' aria-label='Routines'>
        <PaneHead
          title='Agents · routines'
          meta={`${routines.length} routine${routines.length === 1 ? '' : 's'} · ${routines.filter((routine) => routine.enabled).length} on${runningNow.length ? ` · ▶ ${runningNow.length} running` : ''}`}
        />
        <div className='toolbar'>
          {/* biome-ignore lint/a11y/useSemanticElements: a segmented control */}
          <span className='seg' role='group' aria-label='On or off'>
            {(['all', 'on', 'off'] as const).map((value) => (
              <button
                key={value}
                type='button'
                aria-pressed={onoff === value}
                onClick={() => setOnoff(value)}
              >
                {value}
              </button>
            ))}
          </span>
          {all ? (
            <select
              value={who}
              onChange={(event) => setWho(event.target.value)}
              aria-label='Project'
            >
              {owners.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          ) : null}
          <span className='sp' />
          <span className='hits'>
            {shown.length} of {routines.length}
          </span>
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => setMode('new')}
          >
            ＋ New routine<kbd>c</kbd>
          </button>
        </div>
        {routines.length ? (
          <div className='ag-read'>
            <Readout
              big={
                <>
                  {runningNow.length ? `▶ ${runningNow.length}` : '0'}{' '}
                  <span className='u'>running</span>
                </>
              }
              sub={runningNow.length ? 'in flight now' : 'nothing in flight'}
              tone={runningNow.length ? 'live' : ''}
            />
            <Readout
              big={
                <>
                  {proposals.length ? `◆ ${proposals.length}` : '0'}{' '}
                  <span className='u'>waiting</span>
                </>
              }
              sub={
                proposals.length
                  ? `${proposals.length} proposal${proposals.length === 1 ? '' : 's'}`
                  : 'nothing waiting'
              }
              tone={proposals.length ? 'wait' : ''}
            />
            <Readout
              big={
                <>
                  {costText(weekCost, 0)} <span className='u'>7 days</span>
                </>
              }
              sub={`${sevenDays.length} run${sevenDays.length === 1 ? '' : 's'}${weekUnknown ? ` · ${weekUnknown} cost not reported` : ''}`}
            />
            <Readout
              big={
                nextDue ? (
                  <>
                    {when(nextDue.nextDueAt, now)}{' '}
                    <span className='u'>next</span>
                  </>
                ) : (
                  '—'
                )
              }
              sub={
                nextDue
                  ? `${nextDue.name} · ${nextDue.runner}`
                  : 'nothing scheduled'
              }
              tone={nextDue ? '' : 'dim'}
            />
          </div>
        ) : null}
        <div className='pane-body'>
          {!routines.length ? (
            <div className='ag-empty'>
              <p>
                No routines{props.scope ? ` for ${props.scope.name}` : ''} yet —
                write a playbook and HQ queues it on a schedule.
              </p>
              <button
                type='button'
                className='btn btn-sm'
                onClick={() => setMode('new')}
              >
                ＋ New routine<kbd>c</kbd>
              </button>
            </div>
          ) : shown.length ? (
            <div
              className={`tbl rt-tbl${all ? '' : ' one'}`}
              role='listbox'
              aria-label='Routines'
            >
              <div className='tbl-head' aria-hidden='true'>
                <span className='hud-label'>routine</span>
                {all ? <span className='hud-label c-proj'>project</span> : null}
                <span className='hud-label c-sch'>schedule</span>
                <span className='hud-label c-cron'>cron</span>
                <span className='hud-label c-run'>runner</span>
                <span className='hud-label c-last'>last run</span>
                <span className='hud-label num c-next'>next</span>
                <span className='hud-label c-on'>
                  <span className='sr'>on</span>
                </span>
              </div>
              {shown.map((routine) => (
                <div
                  key={routine.id}
                  role='option'
                  tabIndex={-1}
                  aria-selected={routine.id === selected && mode !== 'new'}
                  className={`tbl-row${routine.id === selected && mode !== 'new' ? ' sel' : ''}${routine.enabled ? '' : ' is-off'}`}
                  onClick={() => void select(routine.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void select(routine.id)
                  }}
                >
                  <span className='nm'>
                    {all && routine.project ? (
                      <Dot color={routine.project.color} />
                    ) : null}
                    <b>{routine.name}</b>
                  </span>
                  {all ? (
                    <span className='c-proj'>
                      <Tag project={routine.project} />
                    </span>
                  ) : null}
                  <span
                    className='c-sch'
                    title={`${routine.cron} · ${routine.timezone}`}
                  >
                    {routine.schedule}
                  </span>
                  <span className='c-cron'>{routine.cron}</span>
                  <span
                    className='c-run'
                    title={
                      routine.runner === 'mcp'
                        ? 'your agent claims it over MCP'
                        : 'HQ’s runner, with an LLM key'
                    }
                  >
                    {routine.runner}
                  </span>
                  <span className='c-last'>
                    <LastRun routine={routine} now={now} />
                  </span>
                  <span className='c-next num'>
                    {routine.enabled ? (
                      <span title={routine.nextDueAt ?? ''}>
                        {when(routine.nextDueAt, now)}
                      </span>
                    ) : (
                      <span className='state-word off'>off</span>
                    )}
                  </span>
                  <span className='c-on'>
                    <button
                      type='button'
                      className='switch'
                      aria-pressed={routine.enabled}
                      aria-label={`${routine.name}: scheduled runs ${routine.enabled ? 'on' : 'off'}`}
                      title='On / off (t)'
                      disabled={pending}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggle(routine)
                      }}
                    />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>○ nothing here</Empty>
          )}
        </div>
      </section>
    )

  return (
    <div className={`page agp`} data-view={view}>
      {list}
      {view === 'routines' ? (
        <section
          className='pane props-pane'
          aria-label='Proposals waiting'
          ref={propsPane}
          data-scope='props'
        >
          <PaneHead
            title='Proposals waiting'
            meta={
              proposals.length
                ? `${proposals.length} · from routines · decided here or in Inbox`
                : 'nothing waiting'
            }
          >
            <Link className='btn btn-sm' href='/inbox?kind=proposals'>
              Inbox › Proposals
            </Link>
          </PaneHead>
          <div className='pane-body'>
            {proposals.length ? (
              <div
                className='queue'
                role='listbox'
                aria-label='Proposals waiting'
              >
                {proposals.map((entry) => (
                  <InboxItem
                    key={entry.id}
                    entry={entry}
                    selected={entry.id === proposal}
                    onSelect={() => setProposal(entry.id)}
                  >
                    {entry.id === proposal ? (
                      <>
                        {entry.quote ? (
                          <p className='quote'>
                            <span className='hud-label'>Proposed</span>
                            {entry.quote}
                          </p>
                        ) : null}
                        {entry.body ? <p>{entry.body}</p> : null}
                        <div className='acts'>
                          <button
                            type='button'
                            className='btn btn-sm btn-pri'
                            disabled={pending}
                            onClick={(event) => {
                              event.stopPropagation()
                              decide(entry, 'accept')
                            }}
                          >
                            Accept<kbd>a</kbd>
                          </button>
                          <button
                            type='button'
                            className='btn btn-sm'
                            disabled={pending}
                            onClick={(event) => {
                              event.stopPropagation()
                              decide(entry, 'reject')
                            }}
                          >
                            Reject<kbd>r</kbd>
                          </button>
                          <button
                            type='button'
                            className='btn btn-sm'
                            disabled={pending}
                            onClick={(event) => {
                              event.stopPropagation()
                              decide(entry, entry.held ? 'unhold' : 'hold')
                            }}
                          >
                            {entry.held ? 'Unhold' : 'Hold'}
                            <kbd>h</kbd>
                          </button>
                        </div>
                      </>
                    ) : null}
                  </InboxItem>
                ))}
              </div>
            ) : (
              <div className='empty'>No proposals are waiting.</div>
            )}
          </div>
        </section>
      ) : null}
      <Inspector
        id='agents'
        label={view === 'runs' ? 'Selected run' : 'Selected routine'}
        empty={mode === 'read' && (view === 'runs' ? !currentRun : !current)}
        onClose={() => {
          if (view === 'runs') {
            setMode('read')
            setSelectedRun(null)
          } else void select(null)
        }}
      >
        {mode === 'new' || (mode === 'edit' && current) ? (
          <RoutineForm
            key={mode === 'new' ? 'new' : current?.id}
            routine={mode === 'edit' ? current : null}
            scope={props.scope}
            projects={props.projects}
            llmKeys={props.llmKeys}
            moduleLabels={props.moduleLabels}
            onCancel={() => setMode('read')}
            onSaved={(routine, nextRuns) => {
              replace(routine, nextRuns)
              setSelected(routine.id)
              setMode('read')
              toast(
                mode === 'new'
                  ? `${routine.name} saved — next ${when(routine.nextDueAt, Date.now())}`
                  : `Saved ${routine.name} — the next run uses it`,
              )
            }}
          />
        ) : view === 'runs' ? (
          currentRun ? (
            <RunInspector
              run={currentRun}
              routine={
                routines.find(
                  (routine) => routine.id === currentRun.routineId,
                ) ?? null
              }
              runs={props.runs}
              now={now}
              onClose={() => setSelectedRun(null)}
            />
          ) : (
            <>
              <InspectorHead title='Run' meta='nothing selected' />
              <div className='insp-body'>
                <Empty>
                  Select a run to read what it did and what it cost.
                </Empty>
              </div>
            </>
          )
        ) : current ? (
          <RoutineInspector
            routine={current}
            runs={runs}
            now={now}
            pending={pending}
            trashed={trash}
            moduleLabels={props.moduleLabels}
            onEdit={() => setMode('edit')}
            onRunNow={() => runNow(current)}
            onToggle={() => toggle(current)}
            onClose={() => void select(null)}
            onDelete={() => remove(current)}
            onRestore={() => restore(current)}
          />
        ) : (
          <>
            <InspectorHead title='Routine' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>
                {trash
                  ? routines.length
                    ? 'Select a routine to read or restore it.'
                    : '○ nothing here'
                  : routines.length
                    ? 'Select a routine.'
                    : 'A routine is a playbook on a schedule. Make one with c.'}
              </Empty>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

function LastRun({ routine, now }: { routine: RoutineData; now: number }) {
  if (routine.current?.status === 'claimed')
    return (
      <span className='state-word live'>
        <Glyph tone='live'>▶</Glyph>running
      </span>
    )
  if (routine.current?.status === 'open')
    return <span className='state-word'>queued · not claimed yet</span>
  if (routine.current?.status === 'blocked')
    return (
      <span
        className='state-word wait'
        title={routine.current.blockedReason ?? undefined}
      >
        <Glyph tone='wait'>◆</Glyph>
        {routine.current.blockedReason?.startsWith('budget_exceeded')
          ? 'stopped · budget spent'
          : 'waits on you'}
      </span>
    )
  if (!routine.lastRun)
    return <span className='state-word off'>○ no runs yet</span>
  const run = routine.lastRun
  if (run.state !== 'succeeded') return <RunWord run={run} />
  return (
    <>
      <span className='state-word'>done {when(run.endedAt, now)}</span>
      {routine.pendingProposals ? (
        <span className='state-word live'>
          {' '}
          · ▶ {routine.pendingProposals} waiting
        </span>
      ) : null}
    </>
  )
}

/* ── Inspector: a routine ──────────────────────────────────────────── */

function RoutineInspector({
  routine,
  runs,
  now,
  pending,
  trashed,
  moduleLabels,
  onEdit,
  onRunNow,
  onToggle,
  onClose,
  onDelete,
  onRestore,
}: {
  routine: RoutineData
  runs: RunData[]
  now: number
  pending: boolean
  /** Read from the Trash: nothing runs; the one action is Restore. */
  trashed: boolean
  moduleLabels: Record<string, string>
  onEdit: () => void
  onRunNow: () => void
  onToggle: () => void
  onClose: (() => void) | null
  onDelete: () => void
  onRestore: () => void
}) {
  const stopped = runs.find(
    (run) => run.state === 'budget' && Date.parse(run.startedAt) > now - DAY,
  )
  const blockers: string[] = []
  if (routine.runner === 'builtin' && !routine.llm)
    blockers.push(
      'HQ’s runner needs an LLM key — add one in Settings › Connections › LLM keys.',
    )
  if (
    routine.current?.status === 'blocked' &&
    routine.current.blockedReason?.startsWith('budget_exceeded')
  )
    blockers.push(
      `stopped: ${routine.current.blockedReason.replace(/^budget_exceeded:\s*/, '')}`,
    )
  const runnerLine =
    routine.runner === 'mcp'
      ? `Claimed over MCP by your own agent — HQ only queues it at ${routine.schedule}.`
      : `HQ’s runner claims it at ${routine.schedule} and runs it with ${routine.llm ? routine.llm.label : '— no key'}.`
  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={routine.project} />
            <span style={{ color: 'var(--ink-4)' }}>›</span> routine
          </>
        }
        meta={
          trashed
            ? `deleted ${age(routine.trashedAt)} ago`
            : routine.enabled
              ? routine.schedule
              : 'off'
        }
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <Readout
            big={
              trashed
                ? 'deleted'
                : routine.current?.status === 'claimed'
                  ? '▶ running'
                  : routine.enabled
                    ? when(routine.nextDueAt, now)
                    : 'off'
            }
            sub={
              trashed
                ? 'restore brings it back, switched off'
                : routine.enabled
                  ? `next · ${routine.timezone}`
                  : 'nothing is queued until it’s on'
            }
            tone={
              !trashed && routine.current?.status === 'claimed'
                ? 'live'
                : !trashed && routine.enabled
                  ? ''
                  : 'dim'
            }
          />
          <RunStrip routine={routine} runs={runs} now={now} />
          <Facts
            rows={[
              ['schedule', `${routine.schedule} · ${routine.cron}`],
              ['timezone', routine.timezone],
              ['project', routine.project?.name ?? 'HQ · no project'],
              [
                'runner',
                routine.runner === 'mcp'
                  ? 'mcp · your agent'
                  : 'builtin · HQ’s runner',
              ],
              ...(routine.runner === 'builtin'
                ? ([
                    [
                      'LLM key',
                      routine.llm
                        ? `${routine.llm.label} ${routine.llm.hint ? `••••${routine.llm.hint.slice(-4)}` : ''}`
                        : '— none',
                    ],
                    ['turns', `at most ${routine.maxTurns}`],
                  ] as [string, string][])
                : []),
              [
                'waiting',
                routine.pendingProposals
                  ? `▶ ${routine.pendingProposals} proposal(s)`
                  : 'nothing',
              ],
            ]}
          />
        </div>
        <div className='dev-main'>
          <h2 className='item-title rt-title'>{routine.name}</h2>
          <p className='runner-line'>
            <span className='hud-label'>how it runs</span>
            {runnerLine}
          </p>
          {blockers.length && !trashed ? (
            <div className='blockers' role='note'>
              <ul>
                {blockers.map((line) => (
                  <li key={line}>
                    <i className='glyph due' aria-hidden='true'>
                      ◆
                    </i>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              {stopped ? (
                <Link className='btn btn-sm' href='/settings/policies'>
                  Settings › Policies
                </Link>
              ) : null}
            </div>
          ) : null}
          {trashed ? (
            <div className='dev-acts'>
              <button
                type='button'
                className='btn btn-pri'
                disabled={pending}
                onClick={onRestore}
              >
                Restore<kbd>r</kbd>
              </button>
            </div>
          ) : (
            <div className='dev-acts'>
              <button
                type='button'
                className='btn btn-pri'
                disabled={
                  pending || (routine.runner === 'builtin' && !routine.llm)
                }
                onClick={onRunNow}
              >
                Run now<kbd>r</kbd>
              </button>
              <button type='button' className='btn' onClick={onEdit}>
                Edit<kbd>e</kbd>
              </button>
              <button
                type='button'
                className='btn'
                disabled={pending}
                onClick={onToggle}
              >
                {routine.enabled ? 'Turn off' : 'Turn on'}
                <kbd>t</kbd>
              </button>
              <button
                type='button'
                className='btn'
                disabled={pending}
                onClick={onDelete}
              >
                Delete<kbd>⌫</kbd>
              </button>
            </div>
          )}
          <div className='sec'>
            <span className='hud-label'>playbook</span>
            <span className='dim'>what the agent reads first</span>
          </div>
          <div className='pb'>
            {routine.playbook.trim() ? (
              <Markdown source={routine.playbook} />
            ) : (
              <p className='dim'>
                Empty — the agent looks at the project and proposes what would
                help most.
              </p>
            )}
          </div>
          <div className='sec'>
            <span className='hud-label'>modules it may use</span>
          </div>
          <div className='mchips'>
            {routine.modules.length ? (
              routine.modules.map((module) => (
                <span key={module} className='label-chip'>
                  {moduleLabels[module] ?? module}
                </span>
              ))
            ) : (
              <span className='dim'>only HQ’s own tools (brief, search)</span>
            )}
          </div>
          <div className='aa'>
            <span className='fld-label hud-label'>auto-accept</span>
            {KNOWN_KINDS.map(([kind, label]) => (
              <div key={kind} className='aa-row'>
                <span className='n'>{label}</span>
                <span
                  className={`state-word${routine.autoAccept.includes(kind) ? ' live' : ' off'}`}
                >
                  {routine.autoAccept.includes(kind)
                    ? 'lands on its own'
                    : 'waits for you'}
                </span>
              </div>
            ))}
            {NEVER.map(([kind, label, why]) => (
              <div key={kind} className='aa-row locked'>
                <span className='n'>{label}</span>
                <span className='state-word off'>never</span>
                <span className='why-not'>{why}</span>
              </div>
            ))}
          </div>
          <div className='sec'>
            <span className='hud-label'>last runs</span>
          </div>
          {runs.length ? (
            <div className='tbl mini-tbl'>
              {runs.slice(0, 5).map((run) => (
                <div key={run.id} className='tbl-row'>
                  <span className='mono'>{shortId(run.id)}</span>
                  <span className='mono'>{when(run.startedAt, now)}</span>
                  <span>
                    <RunWord run={run} short />
                    {run.summary ? (
                      <span className='dim'> · {run.summary}</span>
                    ) : null}
                  </span>
                  <span
                    className={`num cost${run.costMinor.length ? '' : ' nk'}`}
                  >
                    {run.costMinor.length ? costText(run.costMinor, 0) : '—'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>No runs yet.</Empty>
          )}
        </div>
      </div>
    </>
  )
}

/* ── Inspector: a run ──────────────────────────────────────────────── */

function RunInspector({
  run,
  routine,
  runs,
  now,
  onClose,
}: {
  run: RunData
  routine: RoutineData | null
  runs: RunData[]
  now: number
  onClose: (() => void) | null
}) {
  return (
    <>
      <InspectorHead
        title={<>run {shortId(run.id)}</>}
        meta={routine?.name ?? 'a task'}
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <Readout
            big={run.costMinor.length ? costText(run.costMinor, 0) : '—'}
            sub={
              run.costMinor.length
                ? tokens(run.tokens) || 'cost'
                : run.state === 'running'
                  ? 'cost when it ends'
                  : 'cost not reported'
            }
            tone={run.state === 'running' ? 'live' : ''}
          />
          {routine ? (
            <RunStrip
              routine={routine}
              runs={runs.filter((entry) => entry.routineId === routine.id)}
              now={now}
              mark={run.id}
            />
          ) : null}
          <Facts
            rows={[
              ['status', <RunWord key='s' run={run} />],
              ['started', when(run.startedAt, now)],
              ['took', duration(run.durationS)],
              ['by', run.by],
              ['proposals', String(run.proposals)],
              [
                'tokens',
                run.tokens === null ? '—' : run.tokens.toLocaleString('en-US'),
              ],
            ]}
          />
        </div>
        <div className='dev-main'>
          <h2 className='item-title rt-title'>{routine?.name ?? 'Run'}</h2>
          {run.summary ? <p className='item-body'>{run.summary}</p> : null}
          {run.error ? <p className='run-err'>{run.error}</p> : null}
          {run.proposals ? (
            <div className='insp-links'>
              <Link className='btn btn-sm' href='/inbox?kind=proposals'>
                Its proposals in Inbox
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

/* ── Form: a routine ───────────────────────────────────────────────── */

function RoutineForm({
  routine,
  scope,
  projects,
  llmKeys,
  moduleLabels,
  onCancel,
  onSaved,
}: {
  routine: RoutineData | null
  scope: AgentsProject | null
  projects: AgentsProject[]
  llmKeys: { id: string; label: string; status: string }[]
  moduleLabels: Record<string, string>
  onCancel: () => void
  onSaved: (routine: RoutineData, runs: RunData[]) => void
}) {
  const [pending, start] = useTransition()
  const [name, setName] = useState(routine?.name ?? '')
  const [projectId, setProjectId] = useState<string>(
    routine?.projectId ?? scope?.id ?? '',
  )
  const [cron, setCron] = useState(routine?.cron ?? '0 9 * * *')
  const [timezone, setTimezone] = useState(routine?.timezone ?? 'Asia/Bangkok')
  const [runner, setRunner] = useState<'mcp' | 'builtin'>(
    routine?.runner ?? 'mcp',
  )
  const [llm, setLlm] = useState(
    routine?.llmConnectionId ?? llmKeys[0]?.id ?? '',
  )
  const [maxTurns, setMaxTurns] = useState(String(routine?.maxTurns ?? 20))
  const [modules, setModules] = useState<string[]>(routine?.modules ?? [])
  const [autoAccept, setAutoAccept] = useState<string[]>(
    routine?.autoAccept ?? [],
  )
  const [playbook, setPlaybook] = useState(routine?.playbook ?? '')
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const form = useRef<HTMLFormElement>(null)
  const project = projects.find((entry) => entry.id === projectId) ?? null
  const available = (project?.modules ?? Object.keys(moduleLabels)).filter(
    (module) => module !== 'agents' && module !== 'notes',
  )
  const valid = isCron(cron)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault()
        form.current?.requestSubmit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setFields({})
    start(async () => {
      const result = await saveRoutineAction({
        ...(routine
          ? { routineId: routine.id, expectedRevision: routine.revision }
          : {}),
        projectId: projectId || null,
        name,
        cron,
        timezone,
        playbook,
        modules: modules.filter((module) =>
          available.includes(module),
        ) as never,
        runner,
        llmConnectionId: runner === 'builtin' ? llm || null : null,
        maxTurns: Number(maxTurns) || 20,
        autoAccept: autoAccept as never,
        enabled: routine?.enabled ?? true,
      })
      if (!result.ok) {
        setError(result.error)
        setFields(result.fields ?? {})
        return
      }
      onSaved(result.data.routine, result.data.runs)
    })
  }

  return (
    <>
      <InspectorHead
        title={routine ? `Edit · ${routine.name}` : 'New routine'}
        meta='⌘S saves · Esc cancels'
        onClose={onCancel}
      />
      <div className='insp-body'>
        <form
          ref={form}
          className='fcard'
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onCancel()
            }
          }}
          aria-label={routine ? `Edit ${routine.name}` : 'New routine'}
        >
          <label>
            Name
            <input
              type='text'
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder='Daily hook review'
              // biome-ignore lint/a11y/noAutofocus: the form opens on purpose, from New routine or Edit
              autoFocus
              aria-invalid={Boolean(fields.name)}
            />
          </label>
          {scope ? null : (
            <label>
              Project
              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                disabled={Boolean(routine)}
              >
                <option value=''>HQ · no project</option>
                {projects.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className='row'>
            <label className='grow'>
              Schedule (cron)
              <input
                type='text'
                className='mono'
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                aria-invalid={!valid || Boolean(fields.cron)}
                spellCheck={false}
              />
            </label>
            <label className='grow'>
              Timezone
              <input
                type='text'
                className='mono'
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                spellCheck={false}
              />
            </label>
          </div>
          <p className='hint cron-words'>
            {valid ? (
              <>
                <b>{describeCron(cron)}</b> in {timezone}
              </>
            ) : (
              <span className='bad'>
                Five fields: minute hour day month weekday — e.g. 0 9 * * * is
                09:00 daily.
              </span>
            )}
          </p>
          <div className='row'>
            <span className='fld-label'>Runner</span>
            {/* biome-ignore lint/a11y/useSemanticElements: a segmented control */}
            <span className='seg' role='group' aria-label='Runner'>
              <button
                type='button'
                aria-pressed={runner === 'mcp'}
                onClick={() => setRunner('mcp')}
              >
                mcp · your agent
              </button>
              <button
                type='button'
                aria-pressed={runner === 'builtin'}
                onClick={() => setRunner('builtin')}
              >
                builtin · HQ
              </button>
            </span>
          </div>
          {runner === 'builtin' ? (
            <div className='row'>
              <label className='grow'>
                LLM key
                <select
                  value={llm}
                  onChange={(event) => setLlm(event.target.value)}
                  aria-invalid={Boolean(fields.llmConnectionId)}
                >
                  {llmKeys.length ? null : (
                    <option value=''>
                      — add one in Settings › Connections
                    </option>
                  )}
                  {llmKeys.map((key) => (
                    <option key={key.id} value={key.id}>
                      {key.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Turns
                <input
                  type='number'
                  min={1}
                  max={200}
                  value={maxTurns}
                  onChange={(event) => setMaxTurns(event.target.value)}
                  style={{ width: 70 }}
                />
              </label>
            </div>
          ) : (
            <p className='hint'>
              Your own agent claims the run over MCP (agents_claim_task) — HQ
              only queues it when it falls due.
            </p>
          )}
          <span className='fld-label'>Modules it may use</span>
          <div className='mpick'>
            {available.map((module) => (
              <button
                key={module}
                type='button'
                className='label-chip'
                aria-pressed={modules.includes(module)}
                onClick={() =>
                  setModules((list) =>
                    list.includes(module)
                      ? list.filter((entry) => entry !== module)
                      : [...list, module],
                  )
                }
              >
                {moduleLabels[module] ?? module}
              </button>
            ))}
          </div>
          <span className='fld-label'>Auto-accept</span>
          <div className='pub-sw'>
            {KNOWN_KINDS.map(([kind, label, why]) => (
              <div key={kind} className='srow'>
                <button
                  type='button'
                  className='switch'
                  aria-pressed={autoAccept.includes(kind)}
                  aria-label={`Auto-accept ${label}`}
                  onClick={() =>
                    setAutoAccept((list) =>
                      list.includes(kind)
                        ? list.filter((entry) => entry !== kind)
                        : [...list, kind],
                    )
                  }
                />
                {label}
                <span className='sub'>{why}</span>
              </div>
            ))}
            {NEVER.map(([kind, label]) => (
              <div key={kind} className='srow locked'>
                <span className='state-word off'>never</span>
                {label}
              </div>
            ))}
          </div>
          <label>
            Playbook
            <textarea
              className='editor'
              value={playbook}
              onChange={(event) => setPlaybook(event.target.value)}
              placeholder={
                '1. Read the readings of this project’s posts at 72h.\n2. Propose three new hook variants.'
              }
              spellCheck={false}
            />
          </label>
          {error ? (
            <p className='err' role='alert'>
              {error}
            </p>
          ) : null}
          <div className='row'>
            <button
              type='submit'
              className='btn btn-pri'
              disabled={pending || !name.trim() || !valid}
            >
              {pending ? 'Saving…' : 'Save'}
              <kbd>⌘S</kbd>
            </button>
            <button type='button' className='btn' onClick={onCancel}>
              Cancel<kbd>Esc</kbd>
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
