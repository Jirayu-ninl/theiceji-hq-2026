'use client'

import { formatMoney } from '@theiceji/hq-core/money'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from 'react'
import {
  Dot,
  Empty,
  isThai,
  Name,
  PaneHead,
  useNarrow,
  usePageKeys,
} from '@/components/bridge/parts'
import { Confirm } from '@/components/Confirm'
import { usePageKeyHints } from '@/components/shell/keys'
import { Splitter } from '@/components/shell/Splitter'
import { useToast } from '@/components/Toast'
import type { ActionResult } from '@/lib/actions'
import {
  addItemAction,
  createExperimentAction,
  decideAction,
  deleteExperimentAction,
  experimentAction,
  recordLearningAction,
  removeItemAction,
  retireLearningAction,
  transitionAction,
  updateExperimentAction,
} from '../actions'
import type {
  AgeReadingData,
  ExperimentData,
  ExperimentRowData,
  ExperimentsProject,
  LearningData,
} from '../data'

/**
 * Experiments:
 * one question, asked once, read at one age. A list beside a wide detail
 * that reads top-down — question · hypothesis · design → the actions of its
 * status → the instrument → the readouts with the leader in words → decide
 * or learn → items → decisions (append-only) → learnings.
 *
 * The instrument is the strip plot: an LCD with one row per variant on a
 * shared scale; a dot per item at its value at the age, the observed middle
 * as a taller tick, too-young items as hollow dots and not-read items as
 * dashed rings parked at the edge. Never an average, never a zero for "no
 * reading". Deciding is the owner's; HQ never decides.
 *
 * Removing: a draft never started, so Delete `⌫` takes it
 * for good and asks in place. Anything that started is history: Archive,
 * which also asks (nothing moves an archived experiment back), and where
 * Delete would be, the reason in words.
 */

export type SubjectOption = {
  type: 'post' | 'listing'
  id: string
  title: string
  where: string
  wentOutAt: string | null
}

export type ExperimentsPageProps = {
  project: ExperimentsProject
  experiments: ExperimentRowData[]
  detail: ExperimentData | null
  learnings: LearningData[]
  subjects: SubjectOption[]
  view: 'experiments' | 'learnings'
  query: string
}

type Status = ExperimentRowData['status']
const ORDER: Status[] = ['reading', 'running', 'draft', 'decided', 'archived']
const GROUP: Record<Status, string> = {
  reading: '◆ Waiting for you',
  running: 'Running',
  draft: 'Draft',
  decided: 'Decided',
  archived: 'Archived',
}
const VERDICTS = [
  ['winner', 'winner'],
  ['no_difference', 'no difference'],
  ['inconclusive', 'inconclusive'],
  ['stopped', 'stopped'],
] as const
type Verdict = (typeof VERDICTS)[number][0]
const verdictWord = (verdict: string) =>
  VERDICTS.find(([id]) => id === verdict)?.[1] ?? verdict
const AGES = [24, 48, 72, 168]
const METRICS: Record<'post' | 'listing', string[]> = {
  post: ['views', 'earnings', 'likes', 'comments', 'shares', 'watch_time_s'],
  listing: ['sales', 'net', 'views', 'favorites'],
}
const METRIC_RE = /^[a-z][a-z0-9_]{0,39}$/
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

const whenFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Bangkok',
})
const when = (iso: string | null) =>
  iso ? whenFormat.format(new Date(iso)) : '—'
function inWords(fromIso: string, toIso: string) {
  const hours = Math.max(
    0,
    (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000,
  )
  return hours < 1
    ? '<1h'
    : hours < 48
      ? `${Math.ceil(hours)}h`
      : `${Math.round(hours / 24)}d`
}

function fmt(value: string | null, currency: string | null) {
  if (value == null) return '—'
  if (currency) return formatMoney(value, currency)
  const n = Number(value)
  return Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function statusWord(row: {
  status: Status
  lastDecision?: { verdict: string } | null
}) {
  if (row.status === 'reading')
    return (
      <span className='state-word wait'>
        <i className='glyph wait' aria-hidden='true'>
          ◆
        </i>{' '}
        decide
      </span>
    )
  if (row.status === 'running')
    return (
      <span className='state-word live'>
        <i className='glyph live' aria-hidden='true'>
          ▶
        </i>{' '}
        running
      </span>
    )
  if (row.status === 'decided')
    return (
      <span className='state-word'>
        decided
        {row.lastDecision ? ` · ${verdictWord(row.lastDecision.verdict)}` : ''}
      </span>
    )
  return (
    <span className={`state-word${row.status === 'archived' ? ' off' : ''}`}>
      {row.status}
    </span>
  )
}

/** The list's end edge drags: 240px up to what leaves the detail 480px. */
const measureList = () =>
  document.querySelector('.expp .list-pane')?.getBoundingClientRect().width ??
  320
const listMax = () =>
  Math.max(
    240,
    (document.querySelector('.expp')?.getBoundingClientRect().width ?? 800) -
      480,
  )
export function ExperimentsPage(props: ExperimentsPageProps) {
  const toast = useToast()
  const narrow = useNarrow('(max-width: 720px)')
  const [rows, setRows] = useState(props.experiments)
  const [detail, setDetail] = useState(props.detail)
  const [learnings, setLearnings] = useState(props.learnings)
  const [selected, setSelected] = useState<string | null>(
    props.detail?.id ?? null,
  )
  const [mode, setMode] = useState<null | 'new' | 'edit' | 'decide' | 'learn'>(
    null,
  )
  const [showDetail, setShowDetail] = useState(false)
  /** Delete is asking in place — the button and `⌫` open the same question. */
  const [deleting, setDeleting] = useState(false)
  const project = props.project

  useEffect(() => setRows(props.experiments), [props.experiments])
  useEffect(() => setLearnings(props.learnings), [props.learnings])

  const ordered = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
          b.updatedAt.localeCompare(a.updatedAt),
      ),
    [rows],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch on a new selection only
  useEffect(() => {
    if (!selected || detail?.id === selected) return
    let alive = true
    experimentAction(selected).then((result) => {
      if (!alive) return
      if (result.ok) setDetail(result.data)
      else toast(result.error)
    })
    return () => {
      alive = false
    }
  }, [selected, toast])

  const select = (id: string | null) => {
    setSelected(id)
    setMode(null)
    setDeleting(false)
    setShowDetail(Boolean(id))
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('experiment', id)
    else url.searchParams.delete('experiment')
    window.history.replaceState(null, '', url)
  }

  /** A write's answer is the experiment read now; the list row follows it. */
  const apply = (result: ActionResult<ExperimentData>, message?: string) => {
    if (!result.ok) {
      toast(result.error)
      return null
    }
    const next = result.data
    setDetail(next)
    setSelected(next.id)
    setRows((list) => {
      const row: ExperimentRowData = {
        id: next.id,
        question: next.question,
        subjectType: next.subjectType,
        metric: next.metric,
        readAtHours: next.readAtHours,
        status: next.status,
        variants: next.variants.map((variant) => ({
          id: variant.id,
          label: variant.label,
        })),
        items: next.variants.reduce(
          (sum, variant) => sum + variant.items.length,
          0,
        ),
        lastDecision: next.decisions[0]
          ? {
              verdict: next.decisions[0].verdict,
              decidedAt: next.decisions[0].decidedAt,
            }
          : null,
        updatedAt: new Date().toISOString(),
      }
      return list.some((entry) => entry.id === row.id)
        ? list.map((entry) => (entry.id === row.id ? row : entry))
        : [row, ...list]
    })
    if (message) toast(message)
    return next
  }

  const current = detail && detail.id === selected ? detail : null

  const transition = async (to: 'running' | 'reading' | 'archived') => {
    if (!current) return
    const words = {
      running: 'Started — design frozen: question, metric, age and variants',
      reading: `Reading — no new items; it waits for the last to reach ${current.readAtHours}h`,
      archived: 'Archived — kept as a record',
    }
    apply(
      await transitionAction({
        experimentId: current.id,
        expectedRevision: current.revision,
        to,
      }),
      words[to],
    )
  }

  /** A draft, for good: the next one down takes the selection. */
  const remove = async () => {
    if (!current) return
    const gone = current
    const index = ordered.findIndex((row) => row.id === gone.id)
    const result = await deleteExperimentAction({
      experimentId: gone.id,
      expectedRevision: gone.revision,
    })
    if (!result.ok) {
      toast(result.error)
      return
    }
    const next = ordered[index + 1] ?? ordered[index - 1] ?? null
    setRows((list) => list.filter((row) => row.id !== gone.id))
    // A learning recorded on it stays, pointing at nothing now.
    setLearnings((list) =>
      list.map((entry) =>
        entry.experimentId === gone.id
          ? { ...entry, experimentId: null }
          : entry,
      ),
    )
    setDetail(null)
    select(next?.id ?? null)
    if (narrow) setShowDetail(false)
    toast(`Deleted: ${gone.question.slice(0, 60)}`)
  }

  const keys: [string, string][] =
    props.view === 'learnings'
      ? [
          ['l', 'record a learning'],
          ['/', 'search'],
          ['1 2', 'experiments · learnings'],
        ]
      : [
          ...((current
            ? {
                draft: [
                  ['e', 'edit design'],
                  ['s', 'start'],
                  ['⌫', 'delete'],
                ],
                running: [
                  ['a', 'add an item'],
                  ['p', 'stop adding — read'],
                ],
                reading: [['d', 'decide']],
                decided: [
                  ['l', 'record a learning'],
                  ['d', 'decide again'],
                ],
                archived: [],
              }[current.status]
            : []) as [string, string][]),
          ['c', 'new experiment'],
          ['↑ ↓', 'experiments'],
          ['1 2', 'experiments · learnings'],
        ]
  usePageKeyHints(keys)
  usePageKeys((key) => {
    if (props.view === 'learnings') {
      if (key === 'l') {
        setMode('learn')
        return true
      }
      if (key === '/') {
        document.querySelector<HTMLInputElement>('[data-lq]')?.focus()
        return true
      }
      if (key === 'Escape' && mode) {
        setMode(null)
        return true
      }
      return false
    }
    if (key === 'Escape') {
      if (mode) {
        setMode(null)
        return true
      }
      if (narrow && showDetail) {
        setShowDetail(false)
        return true
      }
      return false
    }
    if (key === 'c') {
      setMode('new')
      setShowDetail(true)
      return true
    }
    const index = ordered.findIndex((row) => row.id === selected)
    if (key === 'ArrowDown' || key === 'j') {
      const next = ordered[Math.min(ordered.length - 1, index + 1)]
      if (next) select(next.id)
      return Boolean(next)
    }
    if (key === 'ArrowUp' || key === 'k') {
      const next = ordered[Math.max(0, index - 1)]
      if (next) select(next.id)
      return Boolean(next)
    }
    if (!current) return false
    if (key === 'e' && current.status === 'draft') {
      setMode('edit')
      return true
    }
    if (key === 's' && current.status === 'draft') {
      void transition('running')
      return true
    }
    if (key === 'a' && current.status === 'running') {
      document.querySelector<HTMLSelectElement>('[data-add-subject]')?.focus()
      return true
    }
    if (key === 'p' && current.status === 'running') {
      void transition('reading')
      return true
    }
    if (
      key === 'd' &&
      (current.status === 'reading' || current.status === 'decided')
    ) {
      setMode('decide')
      return true
    }
    if (key === 'l' && current.status === 'decided') {
      setMode('learn')
      return true
    }
    // Not while the design form stands in for the detail and its buttons.
    if (
      (key === 'Backspace' || key === 'Delete') &&
      mode !== 'edit' &&
      mode !== 'new'
    ) {
      if (current.deleteBlocker) toast(current.deleteBlocker)
      else setDeleting(true)
      return true
    }
    return false
  })

  if (props.view === 'learnings')
    return (
      <div className='page expp' data-view='learnings'>
        <Learnings
          project={project}
          learnings={learnings}
          experiments={rows}
          query={props.query}
          open={mode === 'learn'}
          onOpen={() => setMode('learn')}
          onClose={() => setMode(null)}
          onSaved={(learning) => {
            setLearnings((list) =>
              list.some((entry) => entry.id === learning.id)
                ? list.map((entry) =>
                    entry.id === learning.id ? learning : entry,
                  )
                : [learning, ...list],
            )
          }}
        />
      </div>
    )

  const waiting = rows.filter((row) => row.status === 'reading').length
  const open = rows.filter((row) => row.status !== 'archived').length
  let group: Status | null = null

  return (
    <div
      className='page expp'
      data-view='experiments'
      data-show={narrow && !(showDetail || mode === 'new') ? 'list' : 'detail'}
    >
      <section className='pane list-pane' aria-label='Experiments'>
        <Splitter
          id='list-experiments'
          label='Resize the list'
          edge='end'
          measure={measureList}
          min={240}
          max={listMax}
        />
        <PaneHead
          title='Experiments'
          meta={
            rows.length ? (
              <>
                {rows.length}
                {waiting ? (
                  <>
                    {' · '}
                    <span className='wait-n'>◆ {waiting}</span>
                  </>
                ) : null}
              </>
            ) : (
              '○ nothing yet'
            )
          }
        />
        <div className='toolbar'>
          <span className='hits'>{open} open</span>
          <span className='sp' />
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => {
              setMode('new')
              setShowDetail(true)
            }}
          >
            ＋ New experiment<kbd>c</kbd>
          </button>
        </div>
        <div className='pane-body'>
          {ordered.length === 0 ? (
            <Empty>
              ○ no experiments yet — ask one question with <kbd>c</kbd>
            </Empty>
          ) : (
            <div className='exp-list' role='listbox' aria-label='Experiments'>
              {ordered.map((row) => {
                const starts = row.status !== group
                group = row.status
                const head = starts ? (
                  <div
                    key={`g-${row.status}`}
                    className={`exp-grp${row.status === 'reading' ? ' wait' : ''}`}
                    role='presentation'
                  >
                    <span className='hud-label'>{GROUP[row.status]}</span>
                    <span className='n'>
                      {
                        rows.filter((entry) => entry.status === row.status)
                          .length
                      }
                    </span>
                  </div>
                ) : null
                const on = row.id === selected
                return [
                  head,
                  <button
                    key={row.id}
                    type='button'
                    role='option'
                    aria-selected={on}
                    tabIndex={on ? 0 : -1}
                    className={`exp-row ${row.status}${on ? ' sel' : ''}`}
                    onClick={() => select(row.id)}
                  >
                    <span
                      className='q'
                      lang={isThai(row.question) ? 'th' : undefined}
                    >
                      {row.question}
                    </span>
                    {statusWord(row)}
                    <span className='m'>
                      {row.metric} @ {row.readAtHours}h ·{' '}
                      {plural(row.variants.length, 'variant')} ·{' '}
                      {plural(row.items, 'item')}
                    </span>
                  </button>,
                ]
              })}
            </div>
          )}
        </div>
      </section>
      <section className='pane detail-pane' aria-label='Experiment'>
        {mode === 'new' || (mode === 'edit' && current) ? (
          <DesignForm
            key={mode === 'edit' && current ? current.id : 'new'}
            project={project}
            experiment={mode === 'edit' ? current : null}
            onBack={() => setShowDetail(false)}
            onCancel={() => setMode(null)}
            onSaved={(next) => {
              setMode(null)
              select(next.id)
            }}
            apply={apply}
          />
        ) : !current ? (
          <>
            <DetailHead
              title='◬ Experiment'
              onBack={() => setShowDetail(false)}
            />
            <div className='pane-body'>
              <Empty>
                {selected
                  ? '…'
                  : rows.length
                    ? 'Select an experiment to read it here.'
                    : '○ no experiments yet — ask one question with c'}
              </Empty>
            </div>
          </>
        ) : (
          <Detail
            key={current.id}
            project={project}
            experiment={current}
            learnings={learnings.filter(
              (entry) => entry.experimentId === current.id,
            )}
            subjects={props.subjects}
            mode={mode}
            setMode={setMode}
            apply={apply}
            transition={transition}
            deleting={deleting}
            onDeleting={setDeleting}
            onDelete={remove}
            onBack={() => setShowDetail(false)}
            onLearned={(learning) => {
              setLearnings((list) => [learning, ...list])
              setMode(null)
            }}
          />
        )}
      </section>
    </div>
  )
}

function DetailHead({
  title,
  meta,
  onBack,
}: {
  title: ReactNode
  meta?: ReactNode
  onBack: () => void
}) {
  return (
    <header className='pane-head'>
      <button
        type='button'
        className='iconbtn back'
        aria-label='Back to experiments'
        title='Back (Esc)'
        onClick={onBack}
      >
        ‹
      </button>
      <span className='hud-label'>{title}</span>
      {meta ? <span className='dim'>{meta}</span> : null}
    </header>
  )
}

/* ── The instrument: strip plot ────────────────────────────────────── */

function niceStep(value: number) {
  const e = Math.floor(Math.log10(value))
  const f = value / 10 ** e
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * 10 ** e
}
function scaleOf(values: number[]) {
  if (!values.length) return null
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1
    lo -= pad
    hi += pad
  }
  const step = niceStep((hi - lo) / 4)
  lo = +(Math.floor(lo / step) * step).toFixed(6)
  hi = +(Math.ceil(hi / step) * step).toFixed(6)
  const ticks: number[] = []
  for (let t = lo; t <= hi + step / 1e6; t = +(t + step).toFixed(6))
    ticks.push(t)
  return { lo, hi, ticks, step }
}

function Strip({ experiment }: { experiment: ExperimentData }) {
  const x = experiment
  const known = (reading: AgeReadingData) =>
    reading.state === 'known' ? Number(reading.value) : null
  const values = x.variants.flatMap((variant) =>
    variant.items
      .map((item) => known(item.reading))
      .filter((v): v is number => v !== null),
  )
  const scale = scaleOf(values)
  const currency =
    x.variants.find((variant) => variant.currency)?.currency ?? null
  const pos = (v: number) =>
    scale ? 3 + ((v - scale.lo) / (scale.hi - scale.lo)) * 94 : 50
  const noun = x.subjectType === 'listing' ? 'listing' : 'post'
  return (
    <figure
      className='strip'
      aria-label={`Strip plot — ${x.metric} at ${x.readAtHours}h per variant`}
    >
      <div className='sp-head'>
        <span>
          {x.metric} at {x.readAtHours}h · one dot per {noun}
        </span>
        <span>read {when(x.readAt)}</span>
      </div>
      {x.variants.map((variant) => {
        const isLead = x.leader?.variantId === variant.id
        const points = variant.items
          .map((item) => ({ item, v: known(item.reading) }))
          .filter(
            (entry): entry is { item: typeof entry.item; v: number } =>
              entry.v !== null,
          )
          .sort((a, b) => a.v - b.v)
        const middle = variant.median !== null ? Number(variant.median) : null
        const young = variant.items.filter(
          (item) => item.reading.state === 'too_young',
        )
        const notRead = variant.items.filter(
          (item) =>
            item.reading.state === 'not_read' ||
            item.reading.state === 'not_out',
        )
        const total = variant.items.length
        const sub = !total
          ? 'no items'
          : `${variant.covered} of ${total} read${variant.medianIsLower ? ' · lower middle' : ''}`
        const aria = `${variant.label}${variant.description ? ` (${variant.description})` : ''}: ${points.length ? `${points.length} read at ${x.readAtHours}h — ${points.map((p) => fmt(String(p.v), currency)).join(', ')}; ${variant.medianIsLower ? 'lower middle' : 'middle'} ${fmt(variant.median, currency)}` : 'nothing read'}${young.length ? `; ${young.length} too young` : ''}${notRead.length ? `; ${notRead.length} not read` : ''}`
        let previous = -99
        let flip = 1
        return (
          <div key={variant.id} className='sp-row'>
            <div className='sp-lab'>
              <b>{variant.label}</b>
              {variant.description ? (
                <span lang={isThai(variant.description) ? 'th' : undefined}>
                  {variant.description}
                </span>
              ) : null}
              <small>{sub}</small>
            </div>
            <svg className='sp-track' role='img' aria-label={aria}>
              <line className='sp-base' x1='0' x2='100%' y1='30' y2='30' />
              {scale
                ? scale.ticks.map((tick) => (
                    <line
                      key={tick}
                      className='sp-grid'
                      x1={`${pos(tick).toFixed(2)}%`}
                      x2={`${pos(tick).toFixed(2)}%`}
                      y1='25'
                      y2='35'
                    />
                  ))
                : null}
              {points.length && middle !== null ? (
                <>
                  <line
                    className={`sp-mid${isLead ? ' lead' : ''}`}
                    x1={`${pos(middle).toFixed(2)}%`}
                    x2={`${pos(middle).toFixed(2)}%`}
                    y1='17'
                    y2='43'
                  />
                  <text
                    className={`sp-mv${isLead ? ' lead' : ''}`}
                    x={`${pos(middle).toFixed(2)}%`}
                    y='11'
                    textAnchor={
                      pos(middle) < 10
                        ? 'start'
                        : pos(middle) > 90
                          ? 'end'
                          : 'middle'
                    }
                  >
                    {fmt(variant.median, currency)}
                  </text>
                  {points.map(({ item, v }) => {
                    const px = pos(v)
                    if (px - previous < 1.6) flip = -flip
                    const dy = px - previous < 1.6 ? flip * 4 : 0
                    previous = px
                    return (
                      <circle
                        key={item.id}
                        className={`sp-pt${v === middle ? ' is-mid' : ''}`}
                        cx={`${px.toFixed(2)}%`}
                        cy={30 + dy}
                        r='4'
                      />
                    )
                  })}
                </>
              ) : (
                <text className='sp-none' x='50%' y='22' textAnchor='middle'>
                  {total
                    ? `nothing read at ${x.readAtHours}h yet`
                    : '○ no items yet'}
                </text>
              )}
            </svg>
            <div className='sp-park'>
              {young.map((item) => (
                <span
                  key={item.id}
                  className='pk'
                  title={`${item.title ?? 'item'} — too young, reads at ${x.readAtHours}h`}
                >
                  <svg viewBox='0 0 10 10' aria-hidden='true'>
                    <circle className='young' cx='5' cy='5' r='3.6' />
                  </svg>
                  in{' '}
                  {item.reading.state === 'too_young'
                    ? inWords(x.readAt, item.reading.readyAt)
                    : '—'}
                </span>
              ))}
              {notRead.map((item) => (
                <span
                  key={item.id}
                  className='pk'
                  title={`${item.title ?? 'item'} — old enough, nothing read near ${x.readAtHours}h`}
                >
                  <svg viewBox='0 0 10 10' aria-hidden='true'>
                    <circle className='nr' cx='5' cy='5' r='3.6' />
                  </svg>
                  {item.reading.state === 'not_out' ? 'not out' : '— not read'}
                </span>
              ))}
            </div>
          </div>
        )
      })}
      <div className='sp-row sp-scale'>
        <div className='sp-axis'>
          <span>{scale ? fmt(String(scale.lo), currency) : '—'}</span>
          <span>
            {scale
              ? `ticks every ${fmt(String(+scale.step.toFixed(6)), currency)}`
              : 'no readings yet'}
          </span>
          <span>{scale ? fmt(String(scale.hi), currency) : '—'}</span>
        </div>
      </div>
      <div className='sp-legend' aria-hidden='true'>
        <span>
          <svg viewBox='0 0 10 10'>
            <circle className='pt' cx='5' cy='5' r='3.6' />
          </svg>
          read at {x.readAtHours}h
        </span>
        <span>
          <svg viewBox='0 0 10 10'>
            <line className='mid' x1='5' x2='5' y1='0' y2='10' />
          </svg>
          observed middle
        </span>
        <span>
          <svg viewBox='0 0 10 10'>
            <circle className='young' cx='5' cy='5' r='3.6' />
          </svg>
          too young
        </span>
        <span>
          <svg viewBox='0 0 10 10'>
            <circle className='nr' cx='5' cy='5' r='3.6' />
          </svg>
          not read
        </span>
      </div>
    </figure>
  )
}

function frozenWords(x: ExperimentData) {
  return x.variants
    .map(
      (variant) =>
        `${variant.label} ${fmt(variant.median, variant.currency)} from ${variant.covered}${variant.medianIsLower ? ' (lower middle)' : ''}`,
    )
    .join(' · ')
}

type SnapshotVariant = {
  label: string
  covered: number
  median: string | null
  medianIsLower: boolean
  currency: string | null
}

/* ── Detail ────────────────────────────────────────────────────────── */

function Detail({
  project,
  experiment: x,
  learnings,
  subjects,
  mode,
  setMode,
  apply,
  transition,
  deleting,
  onDeleting,
  onDelete,
  onBack,
  onLearned,
}: {
  project: ExperimentsProject
  experiment: ExperimentData
  learnings: LearningData[]
  subjects: SubjectOption[]
  mode: null | 'new' | 'edit' | 'decide' | 'learn'
  setMode: (mode: null | 'new' | 'edit' | 'decide' | 'learn') => void
  apply: (
    result: ActionResult<ExperimentData>,
    message?: string,
  ) => ExperimentData | null
  transition: (to: 'running' | 'reading' | 'archived') => Promise<void>
  deleting: boolean
  onDeleting: (asking: boolean) => void
  onDelete: () => Promise<void>
  onBack: () => void
  onLearned: (learning: LearningData) => void
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const [closedDecide, setClosedDecide] = useState(false)
  const [pickVariant, setPickVariant] = useState(x.variants[0]?.id ?? '')
  const [pickSubject, setPickSubject] = useState('')
  const young = x.variants.reduce((sum, variant) => sum + variant.tooYoung, 0)
  const items = x.variants.flatMap((variant) =>
    variant.items.map((item) => ({ ...item, variant })),
  )
  const used = new Set(items.map((item) => item.subjectId))
  const candidates = subjects.filter(
    (subject) => subject.type === x.subjectType && !used.has(subject.id),
  )
  const decideOpen =
    mode === 'decide' ||
    (x.status === 'reading' && !closedDecide && mode === null)
  const noun = x.subjectType === 'listing' ? 'listing' : 'post'

  const design: [string, string][] = [
    ['compares', `${noun}s`],
    ['metric', x.metric],
    ['read at', `${x.readAtHours}h after it went out`],
    x.startedAt ? ['started', when(x.startedAt)] : ['draft', 'not started'],
  ]

  let actions: ReactNode = null
  let hint = ''
  if (x.status === 'draft') {
    const ok = x.variants.length >= 2
    actions = (
      <>
        <button type='button' className='btn' onClick={() => setMode('edit')}>
          Edit design<kbd>e</kbd>
        </button>
        <button
          type='button'
          className='btn btn-pri'
          disabled={!ok || pending}
          onClick={() => start(() => transition('running'))}
        >
          Start<kbd>s</kbd>
        </button>
      </>
    )
    hint = ok
      ? `Start freezes the design — the question, metric, age and variants stop changing. ${noun[0]?.toUpperCase()}${noun.slice(1)}s are added once it runs.`
      : 'Start needs two variants.'
  } else if (x.status === 'running') {
    actions = (
      <button
        type='button'
        className='btn'
        disabled={pending}
        onClick={() => start(() => transition('reading'))}
      >
        Stop adding — read<kbd>p</kbd>
      </button>
    )
    hint = `Design frozen; ${noun}s can still be added below. Each is read ${x.readAtHours}h after it went out.`
  } else if (x.status === 'reading') {
    actions = (
      <button
        type='button'
        className='btn btn-pri'
        onClick={() => setMode('decide')}
      >
        Decide<kbd>d</kbd>
      </button>
    )
    hint = young
      ? `No new items. ${young} still too young — deciding now freezes only what was read at ${x.readAtHours}h.`
      : `No new items. Every item has reached ${x.readAtHours}h.`
  } else if (x.status === 'decided') {
    actions = (
      <>
        <button
          type='button'
          className='btn btn-pri'
          onClick={() => setMode('learn')}
        >
          Record a learning<kbd>l</kbd>
        </button>
        <button
          type='button'
          className='btn btn-sm'
          onClick={() => setMode('decide')}
        >
          Decide again<kbd>d</kbd>
        </button>
      </>
    )
    hint = 'A later decision follows the earlier ones; nothing is overwritten.'
  } else hint = 'Archived — kept as a record, read-only.'

  // Removal ends the row: Archive for what started — it
  // asks, since nothing moves it back — then Delete for a draft, or why not.
  const learned = learnings.length
  const removal = (
    <>
      {x.status !== 'draft' && x.status !== 'archived' ? (
        <Confirm
          small={false}
          label='Archive'
          question='Archive it? It stays read-only for good.'
          yes='Archive'
          disabled={pending}
          run={() => transition('archived')}
        />
      ) : null}
      {x.deleteBlocker === null ? (
        <Confirm
          small={false}
          label='Delete'
          kbd='⌫'
          question={
            learned
              ? `Delete this draft? ${learned === 1 ? 'Its learning stays' : `Its ${learned} learnings stay`}, unlinked.`
              : 'Delete this draft? It can’t come back.'
          }
          yes='Delete'
          disabled={pending}
          asking={deleting}
          onAsking={onDeleting}
          run={onDelete}
        />
      ) : x.status !== 'archived' ? (
        <span className='why-not'>{x.deleteBlocker}</span>
      ) : null}
    </>
  )

  const addItem = () =>
    start(async () => {
      if (!pickSubject || !pickVariant) return
      const variant = x.variants.find((entry) => entry.id === pickVariant)
      if (
        apply(
          await addItemAction({
            experimentId: x.id,
            variantId: pickVariant,
            subjectId: pickSubject,
          }),
          `Added to ${variant?.label ?? 'the variant'}`,
        )
      )
        setPickSubject('')
    })
  const removeItem = (itemId: string) =>
    start(async () => {
      apply(
        await removeItemAction({ experimentId: x.id, itemId }),
        'Item removed',
      )
    })

  return (
    <>
      <DetailHead
        title={
          <>
            <Dot color={project.color} /> ◬ Experiment
          </>
        }
        meta={statusWord({
          status: x.status,
          lastDecision: x.decisions[0] ?? null,
        })}
        onBack={onBack}
      />
      <div className='pane-body'>
        <div className='exp-det'>
          <div className='exp-title'>
            <h2 lang={isThai(x.question) ? 'th' : undefined}>{x.question}</h2>
            {x.hypothesis ? (
              <p className='exp-hyp'>
                <span className='hud-label'>hypothesis</span>
                <span lang={isThai(x.hypothesis) ? 'th' : undefined}>
                  {x.hypothesis}
                </span>
              </p>
            ) : null}
            <p className='exp-design'>
              {design.map(([key, value]) => (
                <span key={key}>
                  {key} <b>{value}</b>
                </span>
              ))}
              {x.status !== 'draft' && x.status !== 'archived' ? (
                <span className='frz'>design frozen</span>
              ) : null}
            </p>
          </div>
          <div className='exp-acts'>
            {actions}
            {removal}
            <p className='hint'>{hint}</p>
          </div>
          <Strip experiment={x} />
          {items.length ? (
            <div className='exp-cmp'>
              <div className='compare'>
                {x.variants.map((variant) => {
                  const isLead = x.leader?.variantId === variant.id
                  const value =
                    variant.median !== null
                      ? fmt(variant.median, variant.currency)
                      : variant.tooYoung
                        ? 'too young'
                        : variant.items.length
                          ? '— not read'
                          : '○ nothing yet'
                  const range =
                    variant.covered > 1
                      ? ` · ${fmt(variant.min, variant.currency)}–${fmt(variant.max, variant.currency)}`
                      : ''
                  const rest = [
                    variant.tooYoung ? `${variant.tooYoung} too young` : '',
                    variant.notRead ? `${variant.notRead} not read` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                  const sub =
                    variant.median !== null
                      ? `${variant.medianIsLower ? 'lower middle' : 'middle'} · ${variant.covered} of ${variant.items.length} read${range}${rest ? ` · ${rest}` : ''}`
                      : plural(variant.items.length, 'item')
                  return (
                    <div
                      key={variant.id}
                      className={`readout${isLead ? ' lead' : ''}`}
                    >
                      <span className='hud-label'>
                        {variant.label}
                        {isLead ? ' · leads' : ''}
                        {variant.description ? ` · ${variant.description}` : ''}
                      </span>
                      <b>{value}</b>
                      <small>{sub}</small>
                    </div>
                  )
                })}
              </div>
              {x.leader ? (
                <p className='lead-words'>{x.leader.note}</p>
              ) : (
                <p className='lead-words'>
                  No leader yet — fewer than two variants have a reading at the
                  age.
                </p>
              )}
            </div>
          ) : null}

          {decideOpen && (x.status === 'reading' || x.status === 'decided') ? (
            <DecideForm
              experiment={x}
              onCancel={() => {
                setClosedDecide(true)
                setMode(null)
              }}
              onDecided={async (input) => {
                const next = apply(
                  await decideAction({
                    experimentId: x.id,
                    expectedRevision: x.revision,
                    ...input,
                  }),
                  `Decided: ${verdictWord(input.verdict)}`,
                )
                if (next) setMode(null)
              }}
            />
          ) : null}
          {mode === 'learn' && x.status === 'decided' ? (
            <LearningForm
              projectId={project.id}
              experiment={x}
              onCancel={() => setMode(null)}
              onSaved={(learning) => {
                toast('Learning recorded — searchable across projects')
                onLearned(learning)
              }}
            />
          ) : null}

          <h3 className='sec'>
            <span className='hud-label'>Items</span>
            <span className='n'>
              {plural(items.length, noun)} · read at {x.readAtHours}h
            </span>
          </h3>
          {x.status === 'running' ? (
            <div className='fcard add-item'>
              <div className='row'>
                <label>
                  Variant
                  <select
                    value={pickVariant}
                    onChange={(event) => setPickVariant(event.target.value)}
                  >
                    {x.variants.map((variant) => (
                      <option key={variant.id} value={variant.id}>
                        {variant.label}
                        {variant.description ? ` · ${variant.description}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className='grow'>
                  A {noun} that went out
                  <select
                    data-add-subject
                    value={pickSubject}
                    onChange={(event) => setPickSubject(event.target.value)}
                  >
                    <option value=''>— choose —</option>
                    {candidates.map((subject) => (
                      <option key={subject.id} value={subject.id}>
                        {subject.title} · {subject.where} ·{' '}
                        {when(subject.wentOutAt)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type='button'
                  className='btn btn-pri'
                  disabled={!pickSubject || pending}
                  onClick={addItem}
                >
                  Add<kbd>a</kbd>
                </button>
              </div>
              <p className='hint'>
                {candidates.length
                  ? `Only ${noun}s that went out can be added; each is read ${x.readAtHours}h after.`
                  : `No ${noun} that went out is free to add — post one in ${noun === 'post' ? 'Publish' : 'Market'} first.`}
              </p>
            </div>
          ) : null}
          {items.length === 0 ? (
            <Empty>
              {x.status === 'draft'
                ? `○ no ${noun}s yet — start it, then add ${noun}s`
                : '○ no items yet'}
            </Empty>
          ) : (
            <div className='tbl items-tbl'>
              <div className='tbl-head'>
                <span className='hud-label'>variant</span>
                <span className='hud-label'>{noun}</span>
                <span className='hud-label c-hide'>went out</span>
                <span className='hud-label num'>at {x.readAtHours}h</span>
                <span className='hud-label c-hide'>link</span>
              </div>
              {items.map((item) => (
                <div key={item.id} className='tbl-row'>
                  <span className='var'>{item.variant.label}</span>
                  <span
                    lang={isThai(item.title) ? 'th' : undefined}
                    title={item.title ?? undefined}
                  >
                    {item.title ?? '—'}
                  </span>
                  <span className='mono c-hide'>{when(item.wentOutAt)}</span>
                  {item.reading.state === 'known' ? (
                    <span className='v'>
                      {fmt(item.reading.value, item.reading.currency)}
                    </span>
                  ) : item.reading.state === 'too_young' ? (
                    <span className='v word'>
                      too young · in {inWords(x.readAt, item.reading.readyAt)}
                    </span>
                  ) : (
                    <span className='v word'>
                      {item.reading.state === 'not_out'
                        ? 'not out'
                        : '— not read'}
                    </span>
                  )}
                  <span className='c-hide'>
                    {item.href ? (
                      <Link className='lnk' href={item.href}>
                        {item.where ?? 'open'} ↗
                      </Link>
                    ) : (
                      '—'
                    )}
                    {x.status === 'running' ? (
                      <button
                        type='button'
                        className='linkish'
                        disabled={pending}
                        onClick={() => removeItem(item.id)}
                        title='Remove from this experiment'
                      >
                        {' '}
                        ×
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          )}

          <h3 className='sec'>
            <span className='hud-label'>Decisions</span>
            {x.decisions.length ? (
              <span className='n'>
                {x.decisions.length} · append-only, newest first
              </span>
            ) : null}
          </h3>
          {x.decisions.length === 0 ? (
            <Empty>
              {x.status === 'reading'
                ? '○ nothing decided yet — deciding is yours'
                : '○ nothing decided yet'}
            </Empty>
          ) : (
            <div className='decs'>
              {x.decisions.map((decision, index) => {
                const winner = x.variants.find(
                  (variant) => variant.id === decision.winnerVariantId,
                )
                const later = index > 0 ? x.decisions[index - 1] : null
                const frozen = (decision.snapshot.variants ??
                  []) as SnapshotVariant[]
                return (
                  <article
                    key={decision.id}
                    className={`dec${later ? ' earlier' : ''}`}
                  >
                    <div className='dh'>
                      <span className='verdict'>
                        {verdictWord(decision.verdict)}
                        {winner ? ` · ${winner.label}` : ''}
                      </span>
                      <span className='when'>{when(decision.decidedAt)}</span>
                    </div>
                    <p
                      className='dev-p'
                      lang={isThai(decision.rationale) ? 'th' : undefined}
                    >
                      {decision.rationale}
                    </p>
                    {frozen.length ? (
                      <p className='frozen'>
                        <span className='hud-label'>
                          readings frozen at{' '}
                          {String(
                            decision.snapshot.readAtHours ?? x.readAtHours,
                          )}
                          h
                        </span>
                        {frozen
                          .map(
                            (variant) =>
                              `${variant.label} ${fmt(variant.median, variant.currency)} from ${variant.covered}${variant.medianIsLower ? ' (lower middle)' : ''}`,
                          )
                          .join(' · ')}
                      </p>
                    ) : null}
                    {later ? (
                      <small>
                        followed by {when(later.decidedAt)} ·{' '}
                        {verdictWord(later.verdict)}
                      </small>
                    ) : null}
                  </article>
                )
              })}
            </div>
          )}
          {learnings.length ? (
            <>
              <h3 className='sec'>
                <span className='hud-label'>Learnings</span>
                <span className='n'>{learnings.length}</span>
              </h3>
              <div className='lrns boxed'>
                {learnings.map((learning) => (
                  <article
                    key={learning.id}
                    className={`lrn${learning.status === 'retired' ? ' retired' : ''}`}
                  >
                    <p
                      className='st'
                      lang={isThai(learning.statement) ? 'th' : undefined}
                    >
                      {learning.statement}
                    </p>
                    {learning.evidence ? (
                      <p className='ev'>{learning.evidence}</p>
                    ) : null}
                    <div className='lm'>
                      {learning.tags.map((tag) => (
                        <span key={tag} className='label-chip'>
                          {tag}
                        </span>
                      ))}
                      <span className='when'>{when(learning.createdAt)}</span>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  )
}

function DecideForm({
  experiment: x,
  onCancel,
  onDecided,
}: {
  experiment: ExperimentData
  onCancel: () => void
  onDecided: (input: {
    verdict: Verdict
    winnerVariantId?: string
    rationale: string
  }) => Promise<void>
}) {
  const [verdict, setVerdict] = useState<Verdict>('winner')
  const [winner, setWinner] = useState(
    x.leader?.variantId ?? x.variants[0]?.id ?? '',
  )
  const [rationale, setRationale] = useState('')
  const [pending, start] = useTransition()
  const submit = () =>
    start(async () => {
      if (!rationale.trim()) return
      await onDecided({
        verdict,
        ...(verdict === 'winner' ? { winnerVariantId: winner } : {}),
        rationale,
      })
    })
  return (
    <form
      className='fcard'
      aria-label='Decide'
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          submit()
        }
      }}
    >
      <div className='fh'>
        <span className='hud-label'>Decide</span>
        <small>
          {x.status === 'reading' ? '◆ waiting for you · ' : ''}deciding is
          yours; nothing leaves HQ
        </small>
      </div>
      <span className='fld-label'>Verdict</span>
      {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons */}
      <span className='seg' role='group' aria-label='Verdict'>
        {VERDICTS.map(([id, word]) => (
          <button
            key={id}
            type='button'
            aria-pressed={verdict === id}
            onClick={() => setVerdict(id)}
          >
            {word}
          </button>
        ))}
      </span>
      {verdict === 'winner' ? (
        <label>
          Winner
          <select
            value={winner}
            onChange={(event) => setWinner(event.target.value)}
          >
            {x.variants.map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variant.label}
                {variant.description ? ` · ${variant.description}` : ''}
                {x.leader?.variantId === variant.id
                  ? ' — leads on the middle'
                  : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label>
        Rationale
        <textarea
          rows={3}
          value={rationale}
          maxLength={4000}
          placeholder='In words: why this verdict, from what was read.'
          // biome-ignore lint/a11y/noAutofocus: the form opens on purpose
          autoFocus
          onChange={(event) => setRationale(event.target.value)}
        />
      </label>
      <p className='hint'>
        Freezes the readings at {x.readAtHours}h into the decision:{' '}
        {frozenWords(x)}.
      </p>
      <div className='row'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={!rationale.trim() || pending}
        >
          Record decision<kbd>⌘↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
        {rationale.trim() ? null : (
          <small className='need'>needs a rationale in words</small>
        )}
      </div>
    </form>
  )
}

function LearningForm({
  projectId,
  experiment,
  onCancel,
  onSaved,
}: {
  projectId: string
  experiment: ExperimentData | null
  onCancel: () => void
  onSaved: (learning: LearningData) => void
}) {
  const toast = useToast()
  const last = experiment?.decisions[0]
  const [statement, setStatement] = useState('')
  const [evidence, setEvidence] = useState(
    experiment && last
      ? `Readings frozen at ${experiment.readAtHours}h: ${frozenWords(experiment)}`
      : '',
  )
  const [tags, setTags] = useState('')
  const [pending, start] = useTransition()
  const submit = () =>
    start(async () => {
      if (!statement.trim()) return
      const result = await recordLearningAction({
        projectId,
        ...(experiment ? { experimentId: experiment.id } : {}),
        statement,
        evidence,
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      })
      if (!result.ok) {
        toast(result.error)
        return
      }
      onSaved(result.data)
    })
  return (
    <form
      className='fcard'
      aria-label='Record a learning'
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          submit()
        }
      }}
    >
      <div className='fh'>
        <span className='hud-label'>Record a learning</span>
        <small>one sentence, searchable across projects</small>
      </div>
      <label>
        Statement
        <input
          type='text'
          value={statement}
          maxLength={400}
          placeholder='One sentence you now believe.'
          // biome-ignore lint/a11y/noAutofocus: the form opens on purpose
          autoFocus
          onChange={(event) => setStatement(event.target.value)}
        />
      </label>
      <label>
        Evidence
        <textarea
          rows={2}
          value={evidence}
          maxLength={4000}
          placeholder='What it rests on — readings, counts, where they came from.'
          onChange={(event) => setEvidence(event.target.value)}
        />
      </label>
      <label>
        Tags
        <input
          type='text'
          value={tags}
          placeholder='hooks, timing'
          onChange={(event) => setTags(event.target.value)}
        />
      </label>
      <div className='row'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={!statement.trim() || pending}
        >
          Record learning<kbd>⌘↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
        {statement.trim() ? null : (
          <small className='need'>needs a statement</small>
        )}
      </div>
    </form>
  )
}

function DesignForm({
  project,
  experiment,
  onBack,
  onCancel,
  onSaved,
  apply,
}: {
  project: ExperimentsProject
  experiment: ExperimentData | null
  onBack: () => void
  onCancel: () => void
  onSaved: (next: ExperimentData) => void
  apply: (
    result: ActionResult<ExperimentData>,
    message?: string,
  ) => ExperimentData | null
}) {
  const x = experiment
  const [question, setQuestion] = useState(x?.question ?? '')
  const [hypothesis, setHypothesis] = useState(x?.hypothesis ?? '')
  const [subject, setSubject] = useState<'post' | 'listing'>(
    x?.subjectType ?? 'post',
  )
  const [metric, setMetric] = useState(x?.metric ?? 'views')
  const [readAt, setReadAt] = useState(x?.readAtHours ?? 72)
  const [variants, setVariants] = useState(
    x
      ? x.variants.map((variant) => ({
          label: variant.label,
          description: variant.description,
        }))
      : [
          { label: 'A', description: '' },
          { label: 'B', description: '' },
        ],
  )
  const [pending, start] = useTransition()
  const labels = variants.map((variant) => variant.label.trim().toLowerCase())
  const problem = !question.trim()
    ? 'needs a question'
    : !METRIC_RE.test(metric.trim())
      ? 'a metric is a–z, 0–9 and _ (e.g. retention_3s)'
      : labels.some((label) => !label)
        ? 'every variant needs a label'
        : new Set(labels).size !== labels.length
          ? 'two variants can’t share a label'
          : ''
  const save = () =>
    start(async () => {
      if (problem) return
      const clean = variants.map((variant) => ({
        label: variant.label.trim(),
        description: variant.description.trim(),
      }))
      const next = x
        ? apply(
            await updateExperimentAction({
              experimentId: x.id,
              expectedRevision: x.revision,
              question,
              hypothesis,
              metric: metric.trim(),
              readAtHours: readAt,
              variants: clean,
            }),
            'Design saved — still a draft',
          )
        : apply(
            await createExperimentAction({
              projectId: project.id,
              question,
              hypothesis,
              subjectType: subject,
              metric: metric.trim(),
              readAtHours: readAt,
              variants: clean,
            }),
            'Draft created — its design can change until it starts',
          )
      if (next) onSaved(next)
    })
  return (
    <>
      <DetailHead
        title={x ? '◬ Edit design' : '◬ New experiment'}
        meta={<span className='state-word'>draft</span>}
        onBack={onBack}
      />
      <div className='pane-body'>
        <div className='exp-det'>
          <form
            className='fcard design'
            aria-label={x ? 'Edit design' : 'New experiment'}
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                save()
              }
            }}
          >
            <div className='fh'>
              <span className='hud-label'>
                {x ? (
                  'Edit design'
                ) : (
                  <>
                    New experiment · <Name text={project.name} />
                  </>
                )}
              </span>
              <small>one question, asked once</small>
            </div>
            <label>
              Question
              <input
                type='text'
                value={question}
                maxLength={400}
                placeholder='Does a warm thumbnail get more views than a cool one?'
                // biome-ignore lint/a11y/noAutofocus: the form opens on purpose
                autoFocus
                onChange={(event) => setQuestion(event.target.value)}
              />
            </label>
            <label>
              Hypothesis
              <input
                type='text'
                value={hypothesis}
                maxLength={1000}
                placeholder='What you expect, in one sentence.'
                onChange={(event) => setHypothesis(event.target.value)}
              />
            </label>
            <div className='fgrid'>
              <div className='fcol'>
                <span className='fld-label'>Compares</span>
                {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons */}
                <span className='seg' role='group' aria-label='Compares'>
                  {(['post', 'listing'] as const).map((entry) => (
                    <button
                      key={entry}
                      type='button'
                      aria-pressed={subject === entry}
                      disabled={Boolean(x)}
                      onClick={() => {
                        setSubject(entry)
                        setMetric(METRICS[entry][0] ?? 'views')
                      }}
                    >
                      {entry}s
                    </button>
                  ))}
                </span>
              </div>
              <div className='fcol'>
                <span className='fld-label'>Read at</span>
                {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons */}
                <span className='seg' role='group' aria-label='Read at'>
                  {AGES.map((age) => (
                    <button
                      key={age}
                      type='button'
                      aria-pressed={readAt === age}
                      onClick={() => setReadAt(age)}
                    >
                      {age} h
                    </button>
                  ))}
                </span>
              </div>
            </div>
            <div className='row metric-row'>
              <label>
                Metric
                <input
                  type='text'
                  className='mono'
                  list='exp-metrics'
                  value={metric}
                  maxLength={40}
                  onChange={(event) => setMetric(event.target.value)}
                />
                <datalist id='exp-metrics'>
                  {METRICS[subject].map((entry) => (
                    <option key={entry} value={entry} />
                  ))}
                </datalist>
              </label>
            </div>
            <p className='hint'>
              Every item is read {readAt}h after it went out, so {subject}s are
              compared at the same age.
            </p>
            <span className='fld-label'>Variants</span>
            <div className='var-rows'>
              {variants.map((variant, index) => (
                <div key={index} className='var-row'>
                  <input
                    type='text'
                    value={variant.label}
                    maxLength={40}
                    aria-label={`Variant ${index + 1} label`}
                    onChange={(event) =>
                      setVariants((list) =>
                        list.map((entry, i) =>
                          i === index
                            ? { ...entry, label: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <input
                    type='text'
                    value={variant.description}
                    placeholder='what differs, e.g. 0.8 s hook'
                    aria-label={`Variant ${index + 1} description`}
                    onChange={(event) =>
                      setVariants((list) =>
                        list.map((entry, i) =>
                          i === index
                            ? { ...entry, description: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <button
                    type='button'
                    className='rm'
                    aria-label={`Remove variant ${variant.label}`}
                    disabled={variants.length <= 1}
                    onClick={() =>
                      setVariants((list) => list.filter((_, i) => i !== index))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className='row'>
              <button
                type='button'
                className='btn btn-sm'
                disabled={variants.length >= 6}
                onClick={() =>
                  setVariants((list) => [
                    ...list,
                    {
                      label: String.fromCharCode(65 + list.length),
                      description: '',
                    },
                  ])
                }
              >
                ＋ Variant
              </button>
              <small>
                {variants.length < 2 ? 'Start needs two variants.' : ''}
              </small>
            </div>
            <p className='hint'>
              {x
                ? 'Still a draft — the design can change until it starts.'
                : 'A draft can change. Start freezes the question, metric, age and variants.'}
            </p>
            <div className='row'>
              <button
                type='submit'
                className='btn btn-pri'
                disabled={Boolean(problem) || pending}
              >
                {x ? 'Save design' : 'Create draft'}
                <kbd>⌘↵</kbd>
              </button>
              <button type='button' className='btn' onClick={onCancel}>
                Cancel<kbd>Esc</kbd>
              </button>
              {problem ? <small className='need'>{problem}</small> : null}
            </div>
          </form>
        </div>
      </div>
    </>
  )
}

/* ── Learnings ─────────────────────────────────────────────────────── */

function Learnings({
  project,
  learnings,
  experiments,
  query,
  open,
  onOpen,
  onClose,
  onSaved,
}: {
  project: ExperimentsProject
  learnings: LearningData[]
  experiments: ExperimentRowData[]
  query: string
  open: boolean
  onOpen: () => void
  onClose: () => void
  onSaved: (learning: LearningData) => void
}) {
  const toast = useToast()
  const router = useRouter()
  const [q, setQ] = useState(query)
  const [tag, setTag] = useState('all')
  const [scope, setScope] = useState<'project' | 'all'>('all')
  const [showRetired, setShowRetired] = useState(false)
  const [, start] = useTransition()
  const tags = [
    ...new Set(learnings.flatMap((learning) => learning.tags)),
  ].sort()
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const inScope = learnings.filter(
    (learning) =>
      scope === 'all' ||
      learning.projectId === project.id ||
      learning.projectId === null,
  )
  const source = (learning: LearningData) =>
    experiments.find((entry) => entry.id === learning.experimentId) ?? null
  const hay = (learning: LearningData) =>
    `${learning.statement} ${learning.evidence} ${learning.tags.join(' ')} ${source(learning)?.question ?? ''}`.toLowerCase()
  const matched = inScope.filter(
    (learning) =>
      (tag === 'all' || learning.tags.includes(tag)) &&
      words.every((word) => hay(learning).includes(word)),
  )
  const active = matched.filter((learning) => learning.status !== 'retired')
  const retired = matched.filter((learning) => learning.status === 'retired')
  const retiredCount = learnings.filter(
    (learning) => learning.status === 'retired',
  ).length

  const retire = (learning: LearningData) =>
    start(async () => {
      const result = await retireLearningAction({
        learningId: learning.id,
        expectedRevision: learning.revision,
        retired: learning.status !== 'retired',
      })
      if (!result.ok) {
        toast(result.error)
        return
      }
      onSaved(result.data)
      toast(
        result.data.status === 'retired'
          ? 'Retired — kept, out of the way'
          : 'Restored',
      )
    })

  const card = (learning: LearningData) => {
    const from = source(learning)
    return (
      <article
        key={learning.id}
        className={`lrn${learning.status === 'retired' ? ' retired' : ''}`}
      >
        <p className='st' lang={isThai(learning.statement) ? 'th' : undefined}>
          {learning.statement}
        </p>
        {learning.evidence ? (
          <p className='ev' lang={isThai(learning.evidence) ? 'th' : undefined}>
            {learning.evidence}
          </p>
        ) : null}
        <div className='lm'>
          {learning.tags.map((entry) => (
            <span key={entry} className='label-chip'>
              {entry}
            </span>
          ))}
          {from ? (
            <button
              type='button'
              className='src'
              title='Open the experiment'
              onClick={() =>
                router.push(
                  `/p/${project.slug}/experiments?experiment=${from.id}`,
                )
              }
            >
              from ◬ <span>{from.question}</span>
            </button>
          ) : (
            <span className='src none'>
              {learning.experimentId
                ? 'from another project’s experiment'
                : 'from a note · no experiment'}
            </span>
          )}
          <span className='when'>{when(learning.createdAt)}</span>
          <span className='sp' />
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => retire(learning)}
          >
            {learning.status === 'retired' ? 'Restore' : 'Retire'}
          </button>
        </div>
      </article>
    )
  }

  return (
    <section className='pane detail-pane' aria-label='Learnings'>
      <PaneHead
        title='Learnings'
        meta={`${learnings.length - retiredCount} active · ${retiredCount} retired`}
      />
      <div className='toolbar lrn-tools'>
        <input
          type='search'
          data-lq
          aria-label='Search learnings'
          placeholder='Search — every word must match'
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons */}
        <span className='seg' role='group' aria-label='Scope'>
          <button
            type='button'
            aria-pressed={scope === 'project'}
            onClick={() => setScope('project')}
          >
            <Dot color={project.color} />
            <Name text={project.name} />
          </button>
          <button
            type='button'
            aria-pressed={scope === 'all'}
            onClick={() => setScope('all')}
          >
            All projects
          </button>
        </span>
        {tags.length ? (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons
          <span className='seg' role='group' aria-label='Tag'>
            <button
              type='button'
              aria-pressed={tag === 'all'}
              onClick={() => setTag('all')}
            >
              all tags
            </button>
            {tags.map((entry) => (
              <button
                key={entry}
                type='button'
                aria-pressed={tag === entry}
                onClick={() => setTag(entry)}
              >
                {entry}
              </button>
            ))}
          </span>
        ) : null}
        <span className='sp' />
        <span className='hits'>
          {active.length + (showRetired ? retired.length : 0)} of{' '}
          {inScope.length}
        </span>
        <span className='sw'>
          <button
            type='button'
            className='switch'
            aria-pressed={showRetired}
            aria-label='Show retired learnings'
            onClick={() => setShowRetired((value) => !value)}
          />
          show retired · {retiredCount}
        </span>
        <button type='button' className='btn btn-sm' onClick={onOpen}>
          ＋ Record a learning<kbd>l</kbd>
        </button>
      </div>
      <div className='pane-body'>
        {open ? (
          <div className='lrn-form'>
            <LearningForm
              projectId={project.id}
              experiment={null}
              onCancel={onClose}
              onSaved={(learning) => {
                onSaved(learning)
                onClose()
                toast('Learning recorded — searchable across projects')
              }}
            />
          </div>
        ) : null}
        {inScope.length === 0 ? (
          <Empty>
            ○ no learnings yet — record one with <kbd>l</kbd>
          </Empty>
        ) : active.length === 0 && retired.length === 0 ? (
          <Empty>
            Nothing matches{q.trim() ? ` “${q.trim()}”` : ''}
            {tag !== 'all' ? ` in ${tag}` : ''} — every word must match.
          </Empty>
        ) : (
          <div className='lrns'>
            {active.map(card)}
            {retired.length ? (
              showRetired ? (
                <>
                  <div className='lrn-sub'>
                    <span className='hud-label'>retired</span>
                    <span className='n'>{retired.length}</span>
                  </div>
                  {retired.map(card)}
                </>
              ) : (
                <p className='lrn-more'>
                  {plural(retired.length, 'retired learning')} hidden —{' '}
                  <button
                    type='button'
                    className='linkish'
                    onClick={() => setShowRetired(true)}
                  >
                    show
                  </button>
                </p>
              )
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}
