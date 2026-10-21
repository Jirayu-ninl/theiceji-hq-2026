'use client'

import { formatMoney, sumAmounts } from '@theiceji/hq-core/money'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type ReactNode, useTransition } from 'react'
import {
  Empty,
  isThai,
  PaneHead,
  projectHex,
  Tag,
  usePageKeys,
} from '@/components/bridge/parts'
import { usePageKeyHints } from '@/components/shell/keys'
import type { AgeReadingData } from '@/modules/experiments/data'

/**
 * Readings: the
 * dashboard. It owns no records; it reads the other modules. Money that
 * happened, per currency and never converted — sales · refunds · fees ·
 * earnings · paid → net — against the window before; generation cost from
 * usage (unknown cost counted, never guessed); posts and listings compared at
 * the same age, in words where there is no number.
 *
 * The instrument is the VU rack: one VU per project in its colour on one
 * shared scale per currency, fill = net this window, tick = the window
 * before. Read-only — its actions are links to the modules.
 */

type MoneyBook = {
  currency: string
  sales: string
  refunds: string
  fees: string
  earnings: string
  paid: string
  net: string
}

type Amount = { currency: string; amount: string }

type SubjectRowData = {
  id: string
  title: string
  where: string
  status: string
  href: string
  wentOutAt: string | null
  atAge: AgeReadingData
  toDate: AgeReadingData
}

export type DashboardProjectData = {
  project: {
    id: string
    slug: string
    name: string
    color: string
    kind: string
    status: string
    modules: string[]
  }
  money: MoneyBook[]
  previous: MoneyBook[]
  cost: Amount[]
  costUnknown: number
  subjects: {
    type: 'post' | 'listing'
    metric: string
    rows: SubjectRowData[]
  }[]
}

export type DashboardPageProps = {
  project: { id: string; slug: string; name: string; color: string } | null
  days: number
  ageHours: number
  readAt: string
  total: MoneyBook[]
  previousTotal: MoneyBook[]
  cost: Amount[]
  costUnknown: number
  projects: DashboardProjectData[]
  view?: 'money' | 'items'
}

const WINDOWS = [7, 30, 90] as const
const AGES = [24, 72, 168] as const
const AGE_WORD: Record<number, string> = { 24: '24h', 72: '72h', 168: '7d' }
const KINDS = ['sales', 'refunds', 'fees', 'earnings', 'paid'] as const
/** The modules a money kind comes from — a project without any of them shows "—", not 0. */
const FROM: Record<(typeof KINDS)[number], string[]> = {
  sales: ['market'],
  refunds: ['market'],
  fees: ['market', 'publish'],
  earnings: ['publish'],
  paid: ['board'],
}
const MODULE_WORD: Record<string, string> = {
  market: 'Market',
  publish: 'Publish',
  board: 'Board',
}

const money = (amount: string, currency: string) =>
  formatMoney(amount, currency)
const ledger = (amount: string, currency: string) =>
  formatMoney(amount, currency, { exact: true, symbol: false })
const isZero = (amount: string) => Number(amount) === 0
const short = (n: number) =>
  n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(+n.toFixed(2))
/** The smallest round figure above the loudest meter, with a little headroom. */
function niceMax(value: number): number {
  if (!(value > 0)) return 0
  const target = value * 1.05
  const e = 10 ** Math.floor(Math.log10(target))
  const m = [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].find(
    (step) => step * e >= target,
  )
  return (m ?? 10) * e
}
const level = (f: number) => `calc(${f.toFixed(4)} * (100% - 6px))`
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Asia/Bangkok',
})
function range(readAt: string, days: number) {
  const to = new Date(readAt)
  const from = new Date(to.getTime() - days * 86_400_000)
  const before = new Date(from.getTime() - days * 86_400_000)
  return {
    now: `${dayFormat.format(from)} – ${dayFormat.format(to)}`,
    before: `${dayFormat.format(before)} – ${dayFormat.format(from)}`,
  }
}
const windowWord = (days: number) => `${days} days`
const beforeWord = (days: number) => `the ${days} days before`

/** THB first, then the rest by code. */
const byCurrency = (a: string, b: string) =>
  a === 'THB' ? -1 : b === 'THB' ? 1 : a.localeCompare(b)

function currenciesOf(boards: DashboardProjectData[]): string[] {
  const set = new Set<string>()
  for (const board of boards)
    for (const book of [...board.money, ...board.previous])
      set.add(book.currency)
  return [...set].sort(byCurrency)
}

function ago(iso: string | null, readAt: string) {
  if (!iso) return '—'
  const hours = (Date.parse(readAt) - Date.parse(iso)) / 3_600_000
  return hours < 48
    ? `${Math.max(0, Math.floor(hours))}h ago`
    : `${Math.floor(hours / 24)}d ago`
}
function soon(iso: string, readAt: string) {
  const hours = (Date.parse(iso) - Date.parse(readAt)) / 3_600_000
  return hours < 1
    ? '<1h'
    : hours <= 48
      ? `${Math.ceil(hours)}h`
      : `${Math.round(hours / 24)}d`
}

/** A reading in figures where there is one, in words where there isn't — never 0 for "not yet". */
function ReadingCell({
  reading,
  readAt,
  asMoney,
}: {
  reading: AgeReadingData
  readAt: string
  asMoney?: boolean
}) {
  if (reading.state === 'too_young')
    return (
      <span className='state-word'>
        too young · in {soon(reading.readyAt, readAt)}
      </span>
    )
  if (reading.state === 'not_out')
    return <span className='state-word'>not out yet</span>
  if (reading.state === 'not_read')
    return <span className='state-word'>— not read</span>
  if (asMoney && reading.currency)
    return <>{money(reading.value, reading.currency)}</>
  return <b>{Number(reading.value).toLocaleString('en-US')}</b>
}

export function DashboardPage(props: DashboardPageProps) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const view = props.view ?? 'money'
  const all = props.project === null
  const when = range(props.readAt, props.days)

  const go = (next: { days?: number; age?: number }) => {
    const url = new URL(window.location.href)
    if (next.days) url.searchParams.set('days', String(next.days))
    if (next.age) url.searchParams.set('age', String(next.age))
    start(() => router.replace(`${url.pathname}${url.search}`))
  }

  usePageKeyHints([
    ['[ ]', 'window'],
    ['w', 'next window'],
    ['g', 'age'],
    ['1 2', 'money · posts & listings'],
  ])
  usePageKeys((key) => {
    const index = WINDOWS.indexOf(props.days as (typeof WINDOWS)[number])
    if (key === '[' || key === ']') {
      const next = WINDOWS[index + (key === ']' ? 1 : -1)]
      if (next) go({ days: next })
      return true
    }
    if (key === 'w') {
      go({ days: WINDOWS[(index + 1) % WINDOWS.length] })
      return true
    }
    if (key === 'g') {
      const at = AGES.indexOf(props.ageHours as (typeof AGES)[number])
      go({ age: AGES[(at + 1) % AGES.length] })
      return true
    }
    return false
  })

  const netParts = props.total.map((book) => money(book.net, book.currency))
  const costParts = props.cost.map((row) => money(row.amount, row.currency))

  return (
    <div className='page readp' aria-busy={pending}>
      <section className='pane tool' aria-label='Window and age'>
        <div className='toolbar'>
          <span className='grp'>
            <span className='hud-label'>window</span>
            {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons */}
            <span className='seg' role='group' aria-label='Window — [ ] or w'>
              {WINDOWS.map((days) => (
                <button
                  key={days}
                  type='button'
                  aria-pressed={props.days === days}
                  onClick={() => go({ days })}
                >
                  {days}d
                </button>
              ))}
            </span>
          </span>
          <span className='grp'>
            <span className='hud-label'>read at</span>
            {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons */}
            <span className='seg' role='group' aria-label='Read at age — g'>
              {AGES.map((age) => (
                <button
                  key={age}
                  type='button'
                  aria-pressed={props.ageHours === age}
                  title={`Posts and listings read ${AGE_WORD[age]} after they went out`}
                  onClick={() => go({ age })}
                >
                  {AGE_WORD[age]}
                </button>
              ))}
            </span>
          </span>
          <span className='range' title={`before: ${when.before}`}>
            {when.now}
          </span>
          <span className='sp' />
          <div className='tb-read' aria-live='polite'>
            <div
              className='readout'
              title='Money that happened, per currency — never converted, never added across currencies'
            >
              <span className='k'>net {props.days}d ·</span>
              <span className='v'>
                {netParts.length ? (
                  netParts.map((part, index) => (
                    <span key={part}>
                      {index ? <span className='dim'> + </span> : null}
                      {part}
                    </span>
                  ))
                ) : (
                  <span className='dim'>○ nothing recorded</span>
                )}
              </span>
            </div>
            <div
              className='readout'
              title={
                props.costUnknown
                  ? `${plural(props.costUnknown, 'run')} whose cost nobody knows — counted, never guessed`
                  : 'Generation cost from usage, cash'
              }
            >
              <span className='k'>cost</span>
              <span className={`v${costParts.length ? '' : ' dim'}`}>
                {costParts.length
                  ? costParts.join(' + ')
                  : '○ nothing recorded'}
              </span>
              {props.costUnknown ? (
                <span className='dim'>· {props.costUnknown} unknown</span>
              ) : null}
            </div>
          </div>
        </div>
      </section>
      {view === 'items' ? (
        <Items {...props} all={all} />
      ) : (
        <Money {...props} all={all} when={when} />
      )}
    </div>
  )
}

/* ── Money: rack · money lines · cost ─────────────────────────────── */

function Money(
  props: DashboardPageProps & {
    all: boolean
    when: { now: string; before: string }
  },
) {
  const { all, projects: boards, days } = props
  const currencies = currenciesOf(boards)
  return (
    <div className={`deck money ${all ? 'all' : 'one'}`}>
      <section className='pane rack' aria-label='Money — the instrument'>
        <PaneHead
          title={`Money · ${windowWord(days)}`}
          meta={
            all
              ? `net · tick = ${beforeWord(days)} · ${currencies.length > 1 ? 'one scale per currency' : 'one scale'}`
              : `tick = ${beforeWord(days)}`
          }
        />
        <div className='racks'>
          {currencies.length === 0 ? (
            <Empty>
              ○ nothing recorded in the last {windowWord(days)} or the{' '}
              {windowWord(days)} before — money comes from Market sales, Publish
              earnings and paid Board cards.
            </Empty>
          ) : (
            currencies.map((currency) => (
              <Rack
                key={currency}
                currency={currency}
                boards={boards}
                all={all}
                days={days}
              />
            ))
          )}
        </div>
      </section>
      <section className='pane lines' aria-label='Money lines'>
        <PaneHead
          title={`Money lines · ${props.when.now}`}
          meta='per currency · never converted'
        />
        <div className='pane-body'>
          <Lines {...props} currencies={currencies} />
        </div>
      </section>
      <section className='pane cost' aria-label='Generation cost'>
        <PaneHead
          title={`Generation cost · ${windowWord(days)}`}
          meta='cash · from usage'
        />
        <div className='pane-body'>
          <Cost {...props} />
        </div>
      </section>
    </div>
  )
}

function Rack({
  currency,
  boards,
  all,
  days,
}: {
  currency: string
  boards: DashboardProjectData[]
  all: boolean
  days: number
}) {
  const columns = boards
    .filter(
      (board) =>
        !all ||
        [...board.money, ...board.previous].some(
          (book) => book.currency === currency,
        ),
    )
    .map((board) => {
      const now = board.money.find((book) => book.currency === currency)
      const before = board.previous.find((book) => book.currency === currency)
      return {
        board,
        net: now ? Number(now.net) : null,
        netText: now?.net ?? null,
        prev: before ? Number(before.net) : null,
        prevText: before?.net ?? null,
      }
    })
  const max = niceMax(
    Math.max(0, ...columns.flatMap((c) => [c.net ?? 0, c.prev ?? 0])),
  )
  const f = (value: number) => (max ? Math.max(0, Math.min(1, value / max)) : 0)
  const ticks = max ? [0.25, 0.5, 0.75, 1] : []
  const symbol = formatMoney('0', currency).replace(/[\d.,\s−-]/g, '')
  return (
    <section
      className={`rk${columns.length > 7 ? ' dense' : ''}`}
      style={{ ['--n' as string]: columns.length }}
      aria-label={`${currency} — ${plural(columns.length, 'project')} on one scale`}
    >
      <div className='rk-h'>
        <span className='hud-label'>{currency}</span>
        <span className='dim'>
          {max ? `scale ${money(String(max), currency)}` : ''}
        </span>
      </div>
      <div className='meters'>
        <div className='axis' aria-hidden='true'>
          {ticks.map((tick) => (
            <span key={tick} style={{ ['--f' as string]: tick }}>
              {tick === 1 ? symbol : ''}
              {short(max * tick)}
            </span>
          ))}
          {ticks.length ? (
            <span style={{ ['--f' as string]: 0 }}>0</span>
          ) : null}
        </div>
        <div className='guides' aria-hidden='true'>
          {ticks.map((tick) => (
            <i key={tick} style={{ ['--f' as string]: tick }} />
          ))}
        </div>
        {columns.map((column, index) => {
          const { board } = column
          const project = board.project
          const known = column.netText !== null
          const said = `${known ? `${money(column.netText as string, currency)} in the last ${windowWord(days)}` : `nothing recorded in the last ${windowWord(days)}`}${column.prevText !== null ? `, ${money(column.prevText, currency)} ${beforeWord(days)}` : known ? `, nothing ${beforeWord(days)}` : ''}`
          const name = (
            <>
              <i className='dot' aria-hidden='true' />
              <span lang={isThai(project.name) ? 'th' : undefined}>
                {project.name}
              </span>
              {project.status === 'paused' ? (
                <span className='ps'>paused</span>
              ) : null}
            </>
          )
          return (
            <div
              key={project.id}
              className={`mtr${project.status === 'paused' ? ' paused' : ''}`}
              style={{
                ['--project' as string]: projectHex(project.color),
                ['--c' as string]: projectHex(project.color),
                gridColumn: index + 2,
              }}
              title={`${project.name} · ${said}`}
            >
              <div
                className='vu'
                role='img'
                aria-label={`${project.name}: ${said}`}
              >
                {known ? (
                  <div
                    className='fill'
                    style={{
                      ['--level' as string]: level(f(column.net as number)),
                    }}
                  />
                ) : null}
                {column.prev !== null ? (
                  <div
                    className='peak'
                    style={{
                      ['--peak' as string]: `calc(${level(f(column.prev))} + 2px)`,
                    }}
                  />
                ) : null}
              </div>
              {known ? (
                <div className='v'>
                  {money(column.netText as string, currency)}
                </div>
              ) : (
                <div className='v dim'>○ nothing recorded</div>
              )}
              <div className='vs'>
                {column.prevText !== null
                  ? `vs ${money(column.prevText, currency)}`
                  : known
                    ? 'nothing before'
                    : ''}
              </div>
              {all && project.modules.includes('readings') ? (
                <Link
                  className='l'
                  href={`/p/${project.slug}/readings`}
                  title={`${project.name} — its own readings`}
                >
                  {name}
                </Link>
              ) : (
                <span className='l'>{name}</span>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Lines({
  projects: boards,
  total,
  previousTotal,
  all,
  days,
  currencies,
}: DashboardPageProps & { all: boolean; currencies: string[] }) {
  return (
    <div className='tbl lines-tbl'>
      <div className='tbl-head'>
        <span className='hud-label'>project</span>
        <span className='hud-label cur'>cur</span>
        {[...KINDS, 'net'].map((kind) => (
          <span key={kind} className='hud-label num'>
            {kind}
          </span>
        ))}
        <span className='hud-label num' title={`net ${beforeWord(days)}`}>
          before
        </span>
      </div>
      {boards.map((board) => {
        const tag = (
          <span>
            <Tag project={board.project} />
          </span>
        )
        if (board.money.length === 0) {
          const before = board.previous
            .map((book) => money(book.net, book.currency))
            .join(' + ')
          return (
            <div key={board.project.id} className='tbl-row'>
              {tag}
              <span className='cur off'>—</span>
              <span className='span'>
                ○ nothing recorded
                {before ? ` · ${before} ${beforeWord(days)}` : ''}
              </span>
            </div>
          )
        }
        return board.money.map((book) => {
          const prev = board.previous.find(
            (entry) => entry.currency === book.currency,
          )
          return (
            <div
              key={`${board.project.id}-${book.currency}`}
              className='tbl-row'
            >
              {tag}
              <span className='cur'>{book.currency}</span>
              {KINDS.map((kind) => {
                const on = FROM[kind].some((module) =>
                  board.project.modules.includes(module),
                )
                if (!on && isZero(book[kind]))
                  return (
                    <span
                      key={kind}
                      className='num off'
                      title={`${board.project.name} has no ${FROM[kind].map((module) => MODULE_WORD[module]).join(' or ')}`}
                    >
                      —
                    </span>
                  )
                return (
                  <span
                    key={kind}
                    className={`num${isZero(book[kind]) ? ' zero' : ''}`}
                  >
                    {ledger(book[kind], book.currency)}
                  </span>
                )
              })}
              <span className='num net'>{ledger(book.net, book.currency)}</span>
              <span className={`num before${prev ? '' : ' off'}`}>
                {prev ? ledger(prev.net, prev.currency) : '—'}
              </span>
            </div>
          )
        })
      })}
      {all
        ? currencies.map((currency) => {
            const now = total.find((book) => book.currency === currency)
            const prev = previousTotal.find(
              (book) => book.currency === currency,
            )
            if (!now && !prev) return null
            const label = (
              <>
                <span className='tl'>All projects</span>
                <span className='cur'>{currency}</span>
              </>
            )
            if (!now)
              return (
                <div key={currency} className='tbl-row tot'>
                  {label}
                  <span className='span'>
                    ○ nothing recorded ·{' '}
                    {money((prev as MoneyBook).net, currency)}{' '}
                    {beforeWord(days)}
                  </span>
                </div>
              )
            return (
              <div key={currency} className='tbl-row tot'>
                {label}
                {KINDS.map((kind) => (
                  <span key={kind} className='num'>
                    {ledger(now[kind], currency)}
                  </span>
                ))}
                <span className='num net'>{ledger(now.net, currency)}</span>
                <span className='num before'>
                  {prev ? ledger(prev.net, currency) : '—'}
                </span>
              </div>
            )
          })
        : null}
    </div>
  )
}

function Cost({
  projects: boards,
  cost,
  costUnknown,
  all,
}: DashboardPageProps & { all: boolean }) {
  // What no project carries: the total less every project's share.
  const hq = cost
    .map((row) => ({
      currency: row.currency,
      amount: sumAmounts(
        [
          row.amount,
          ...boards.flatMap((board) =>
            board.cost
              .filter((entry) => entry.currency === row.currency)
              .map((entry) =>
                entry.amount.startsWith('-')
                  ? entry.amount.slice(1)
                  : `-${entry.amount}`,
              ),
          ),
        ],
        row.currency,
      ),
    }))
    .filter((row) => !isZero(row.amount))
  const hqUnknown =
    costUnknown - boards.reduce((sum, board) => sum + board.costUnknown, 0)
  const row = (
    key: string,
    label: ReactNode,
    amounts: Amount[],
    unknown: number,
  ) => (
    <div key={key} className='tbl-row'>
      {label}
      {amounts.length || unknown ? (
        <>
          <span className='num'>
            {amounts.length
              ? amounts
                  .map((entry) => money(entry.amount, entry.currency))
                  .join(' + ')
              : '—'}
          </span>
          <span className={`num${unknown ? '' : ' zero'}`}>{unknown}</span>
        </>
      ) : (
        <span className='span'>○ nothing recorded</span>
      )}
    </div>
  )
  return (
    <>
      <div className='tbl cost-tbl'>
        <div className='tbl-head'>
          <span className='hud-label'>project</span>
          <span className='hud-label num'>cash</span>
          <span className='hud-label num' title='runs whose cost nobody knows'>
            unknown
          </span>
        </div>
        {boards.map((board) =>
          row(
            board.project.id,
            <span>
              <Tag project={board.project} />
            </span>,
            board.cost,
            board.costUnknown,
          ),
        )}
        {all && (hq.length || hqUnknown > 0)
          ? row(
              'hq',
              <span className='hqrow'>
                <Tag project={null} />
                <small>not tied to a project</small>
              </span>,
              hq,
              Math.max(0, hqUnknown),
            )
          : null}
        {all && (cost.length || costUnknown) ? (
          <div className='tbl-row tot'>
            <span className='tl'>All</span>
            <span className='num'>
              {cost.length
                ? cost
                    .map((entry) => money(entry.amount, entry.currency))
                    .join(' + ')
                : '—'}
            </span>
            <span className='num'>{costUnknown}</span>
          </div>
        ) : null}
      </div>
      {costUnknown ? (
        <p className='cnote'>
          {plural(costUnknown, 'run')} with unknown cost — counted, never
          guessed.
        </p>
      ) : (
        <p className='cnote'>
          What generations and agent runs spent in this window, as each provider
          reported it.
        </p>
      )}
    </>
  )
}

/* ── Posts & listings: the same age for everything ───────────────── */

function Items(props: DashboardPageProps & { all: boolean }) {
  const { projects: boards, all, ageHours, readAt } = props
  const panes = (['post', 'listing'] as const)
    .map((type) => {
      const module = type === 'post' ? 'publish' : 'market'
      const mine = boards.filter((board) =>
        board.project.modules.includes(module),
      )
      if (mine.length === 0) return null
      const rows = mine.flatMap((board) =>
        board.subjects
          .filter((panel) => panel.type === type)
          .flatMap((panel) =>
            panel.rows.map((row) => ({ row, board, metric: panel.metric })),
          ),
      )
      return { type, module, rows }
    })
    .filter((pane) => pane !== null)

  if (panes.length === 0)
    return (
      <div className='deck items'>
        <section className='pane'>
          <PaneHead title='Posts & listings' />
          <Empty>
            ○ nothing to compare — posts come from Publish, listings from
            Market.
          </Empty>
        </section>
      </div>
    )

  return (
    <div
      className={`deck items ${all ? 'all' : 'one'}`}
      style={{ ['--panes' as string]: panes.length }}
    >
      {panes.map(({ type, module, rows }) => {
        const post = type === 'post'
        const word = AGE_WORD[ageHours] ?? `${ageHours}h`
        const heads = post
          ? [
              'post',
              'account',
              'went out',
              `views at ${word}`,
              'earnings to date',
              '',
            ]
          : ['listing', 'shop', 'listed', `sales at ${word}`, 'net to date', '']
        return (
          <section
            key={type}
            className='pane subj'
            aria-label={`${post ? 'Posts' : 'Listings'} at ${word}`}
          >
            <PaneHead
              title={`${post ? 'Posts' : 'Listings'} at ${word}`}
              meta={`${plural(rows.length, 'newest', 'newest')}${all ? ' · per project' : ''}`}
            />
            <p className='cmp'>
              Compared at the same age — younger {post ? 'posts' : 'listings'}{' '}
              are too young, not zero.
            </p>
            <div className='pane-body'>
              {rows.length === 0 ? (
                <Empty>○ nothing {post ? 'posted' : 'listed'} yet</Empty>
              ) : (
                <div className={`tbl subj-tbl${all ? ' global' : ''}`}>
                  <div className='tbl-head'>
                    {all ? <span className='hud-label'>project</span> : null}
                    {heads.map((head, index) => (
                      <span
                        key={head || 'go'}
                        className={`hud-label${index === 3 || index === 4 ? ' num' : ''}`}
                      >
                        {head}
                      </span>
                    ))}
                  </div>
                  {rows.map(({ row, board }) => (
                    <div key={row.id} className='tbl-row'>
                      {all ? (
                        <span>
                          <Tag project={board.project} />
                        </span>
                      ) : null}
                      <span className='ttl'>
                        <span
                          className='t'
                          lang={isThai(row.title) ? 'th' : undefined}
                        >
                          {row.title}
                        </span>
                      </span>
                      <span className='acct'>{row.where}</span>
                      <span className='when' title={row.wentOutAt ?? ''}>
                        {ago(row.wentOutAt, readAt)}
                      </span>
                      <span className='num'>
                        <ReadingCell reading={row.atAge} readAt={readAt} />
                      </span>
                      <span className='num'>
                        <ReadingCell
                          reading={row.toDate}
                          readAt={readAt}
                          asMoney
                        />
                      </span>
                      <span className='go'>
                        <Link
                          className='btn btn-sm'
                          href={row.href}
                          title={`Open in ${MODULE_WORD[module]}`}
                        >
                          {MODULE_WORD[module]} ›
                        </Link>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
