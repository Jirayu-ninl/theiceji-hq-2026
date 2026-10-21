'use client'

import { formatMoney } from '@theiceji/hq-core/money'
import Link from 'next/link'
import { Fragment, useEffect, useState } from 'react'
import { age, Dot, isThai } from '@/components/bridge/parts'
import { Icon } from '@/components/shell/Icon'
import { menuKeys, usePlacement } from '@/components/shell/Menus'
import { useToast } from '@/components/Toast'
import type { HomeData, HomeProject } from '@/lib/home'
import { readWidgets, writeWidgets } from '@/lib/prefs'

/**
 * Space's widget column. `money.7d` is the one LCD: what
 * happened in the last 7 days (Readings — sales, earnings, paid cards, fees
 * and refunds, per currency, never converted), a spark of net per week, and
 * the payouts nobody has confirmed. Pending money (awaiting-payment lanes and
 * sent quotes) is its own widget. The rest: today, agents running,
 * awaiting payment, the next cleared posts, this week's sales, sent quotes,
 * parked notes. A widget whose module no project has on isn't offered. `＋`
 * adds, `×` removes with Undo; the list is remembered per browser in
 * `hq.home.widgets`.
 */

/**
 * Each widget's `open →` goes to the page that shows its data: Readings
 * (`/dashboard`, 7 days by default) for money and sales, the Agents runs
 * for what is running. Publish has no all-projects page, so its widget
 * opens the Publish page of the project whose post is next.
 */
const WIDGETS: Record<string, { label: string; href: string }> = {
  'money.7d': { label: 'Money · 7d', href: '/dashboard' },
  'money.pending': { label: 'Money · pending', href: '/board' },
  today: { label: 'Today', href: '/calendar' },
  'agents.running': { label: 'Agents · running', href: '/agents?view=runs' },
  'board.awaiting': { label: 'Awaiting payment', href: '/board' },
  // `hrefOf` sends it to a project's Publish; this is only its fallback.
  'publish.next': { label: 'Publish · cleared', href: '/projects' },
  'market.week': { label: 'Sales · this week', href: '/dashboard' },
  'quotes.sent': { label: 'Quotes · sent', href: '/quotes' },
  'notes.parked': { label: 'Notes · parked', href: '/notes' },
}

/** Where `open →` goes: the widget's page, or for Publish, a project's. */
function hrefOf(id: string, data: HomeData): string {
  if (id === 'publish.next') {
    const next = data.nextPosts?.[0]
    const project =
      data.projects.find((entry) => entry.id === next?.projectId) ??
      data.projects.find((entry) =>
        entry.modules.some((module) => module.id === 'publish'),
      )
    if (project) return `/p/${project.slug}/publish`
  }
  return WIDGETS[id]?.href ?? '/'
}

/** The set a browser starts with. */
const DEFAULT = ['money.7d', 'today', 'agents.running', 'board.awaiting']

export function Widgets({ data }: { data: HomeData }) {
  const toast = useToast()
  const offered = data.catalog
  const fallback = DEFAULT.filter((id) => offered.includes(id))
  const [ids, setIds] = useState<string[]>(fallback)
  const menu = usePlacement('widget-menu', '.widgets .add')

  // What this browser remembers, once it is hydrated (the server renders the defaults).
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once on mount
  useEffect(() => {
    const stored = readWidgets(offered)
    if (stored) setIds(stored)
  }, [])

  const save = (next: string[]) => {
    setIds(next)
    writeWidgets(next)
  }
  const projectOf = (id: string | null) =>
    data.projects.find((project) => project.id === id) ?? null
  const rest = offered.filter((id) => !ids.includes(id))

  return (
    <aside className='pane widgets' aria-label='Widgets'>
      <header className='pane-head'>
        <span className='hud-label'>Widgets</span>
        <span className='dim'>{ids.length}</span>
        <button
          type='button'
          className='btn btn-sm add'
          popoverTarget='widget-menu'
          aria-haspopup='menu'
        >
          <Icon name='plus' size={12} /> add
        </button>
      </header>
      <div
        ref={menu}
        id='widget-menu'
        popover='auto'
        className='popover'
        role='menu'
        aria-label='Add widget'
        onKeyDown={menuKeys}
      >
        <div className='pane-head'>
          <span className='hud-label'>Add widget</span>
        </div>
        <div className='menu-list'>
          {rest.length ? (
            rest.map((id) => (
              <button
                key={id}
                type='button'
                role='menuitem'
                className='menu-item'
                onClick={() => {
                  save([...ids, id])
                  menu.current?.hidePopover()
                }}
              >
                <span className='label'>{WIDGETS[id]?.label ?? id}</span>
              </button>
            ))
          ) : (
            <p className='empty'>Every widget is already on the board.</p>
          )}
        </div>
      </div>
      <div className='pane-body'>
        <div className='wlist'>
          {ids.length === 0 ? (
            <div className='empty'>No widgets. Add one above.</div>
          ) : null}
          {ids.map((id) => {
            const widget = WIDGETS[id]
            if (!widget) return null
            return (
              <article key={id} className='widget card' data-id={id}>
                <header>
                  <span className='hud-label'>{widget.label}</span>
                  <Link className='open' href={hrefOf(id, data)}>
                    open →
                  </Link>
                  <button
                    type='button'
                    className='rm'
                    aria-label={`Remove ${widget.label}`}
                    title='Remove'
                    onClick={() => {
                      const before = ids
                      save(ids.filter((entry) => entry !== id))
                      toast(`Removed ${widget.label}`, {
                        undo: () => save(before),
                      })
                    }}
                  >
                    <Icon name='close' size={12} />
                  </button>
                </header>
                <div className='wbody'>
                  <Body id={id} data={data} projectOf={projectOf} />
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

/**
 * An LCD figure's amounts, one per currency (never converted). Each stays
 * whole, so a narrow column wraps between currencies, never inside one.
 */
function Amounts({ list }: { list: { currency: string; label: string }[] }) {
  return list.map((entry, i) => (
    <span key={entry.currency} className='amt'>
      {i ? `+ ${entry.label}` : entry.label}
    </span>
  ))
}

function Row({
  project,
  text,
  value,
  href,
  soon,
}: {
  project: HomeProject | null
  text: string
  value: string
  href: string
  soon?: boolean
}) {
  return (
    <Link className='r' href={href}>
      {project ? <Dot color={project.color} /> : null}
      <span className='t' lang={isThai(text) ? 'th' : undefined}>
        {text}
      </span>
      <span className={`v${soon ? ' soon' : ''}`}>{value}</span>
    </Link>
  )
}

function Body({
  id,
  data,
  projectOf,
}: {
  id: string
  data: HomeData
  projectOf: (id: string | null) => HomeProject | null
}) {
  switch (id) {
    case 'money.7d':
      return <MoneyWeek data={data} />
    case 'agents.running': {
      if (!data.agents) return <div className='empty'>— not read back</div>
      if (!data.agents.length)
        return <div className='empty'>nothing running</div>
      return (
        <div className='wrows'>
          {data.agents.map((run) => (
            <Row
              key={run.id}
              project={projectOf(run.projectId)}
              text={`▶ ${run.title}`}
              value={age(run.startedAt)}
              href='/agents?view=runs'
            />
          ))}
        </div>
      )
    }
    case 'publish.next': {
      if (!data.nextPosts) return <div className='empty'>— not read back</div>
      if (!data.nextPosts.length)
        return <div className='empty'>nothing cleared to post</div>
      return (
        <div className='wrows'>
          {data.nextPosts.map((post) => (
            <Row
              key={post.id}
              project={projectOf(post.projectId)}
              text={post.title}
              value={
                post.at
                  ? new Date(post.at).toLocaleString('en-GB', {
                      weekday: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'any time'
              }
              href={post.href}
            />
          ))}
        </div>
      )
    }
    case 'market.week': {
      if (!data.marketWeek) return <div className='empty'>— not read back</div>
      if (!data.marketWeek.length)
        return <div className='empty'>no sales recorded this week</div>
      return (
        <div className='wrows'>
          {data.marketWeek.map((row) => {
            const project = projectOf(row.projectId)
            return (
              <Row
                key={`${row.projectId}-${row.net.currency}`}
                project={project}
                text={`${row.units} sold`}
                value={row.net.label}
                // The project's own sale lines; the header opens every project's.
                href={
                  project
                    ? `/p/${project.slug}/market?view=money`
                    : '/dashboard'
                }
              />
            )
          })}
        </div>
      )
    }
    case 'money.pending': {
      const m = data.money
      if (!m.known)
        return (
          <>
            <div className='readout wl'>
              <div className='fig'>
                —<small>not read back</small>
              </div>
            </div>
            <div className='fl'>
              <span>HQ shows nothing rather than an estimate</span>
            </div>
          </>
        )
      const labels = (list: HomeData['money']['total']) =>
        list.length ? list.map((entry) => entry.label).join(' + ') : '฿0'
      return (
        <>
          <div className='readout wl'>
            <div className='fig'>
              {m.total.length ? <Amounts list={m.total} /> : '฿0'}
              <small>pending</small>
            </div>
            <div className='fl'>
              <span>awaiting payment</span>
              <span>{labels(m.awaiting)}</span>
            </div>
            <div className='fl'>
              <span>quotes sent</span>
              <span>{labels(m.quoted)}</span>
            </div>
          </div>
          <div className='fl'>
            <span>
              {m.awaitingCards} card{m.awaitingCards === 1 ? '' : 's'} ·{' '}
              {m.sentQuotes} quote{m.sentQuotes === 1 ? '' : 's'}
            </span>
            <span>not yet paid</span>
          </div>
        </>
      )
    }
    case 'today': {
      if (!data.todayItems) return <div className='empty'>— not read back</div>
      if (!data.todayItems.length)
        return <div className='empty'>nothing today</div>
      return (
        <div className='wrows'>
          {data.todayItems.map((item) => (
            <Row
              key={item.id}
              project={projectOf(item.projectId)}
              text={item.label}
              value={item.at}
              href={item.href}
              soon={item.at === 'overdue'}
            />
          ))}
        </div>
      )
    }
    case 'board.awaiting': {
      if (!data.awaitingCards)
        return <div className='empty'>— not read back</div>
      if (!data.awaitingCards.length)
        return <div className='empty'>nothing awaiting payment</div>
      const n = data.awaitingCards.length
      return (
        <>
          <div className='readout'>
            <div className='big'>
              {data.money.awaiting.map((entry) => entry.label).join(' + ') ||
                '—'}
            </div>
            <div className='sub'>
              awaiting payment · {n} card{n === 1 ? '' : 's'}
            </div>
          </div>
          <div className='wrows'>
            {data.awaitingCards.map((card) => (
              <Row
                key={card.id}
                project={projectOf(card.projectId)}
                text={card.title}
                value={card.price}
                href={card.href}
              />
            ))}
          </div>
        </>
      )
    }
    case 'quotes.sent': {
      if (!data.sentQuotes) return <div className='empty'>— not read back</div>
      if (!data.sentQuotes.length)
        return <div className='empty'>no quotes out</div>
      const n = data.sentQuotes.length
      const covered = data.sentQuotes.filter((quote) => quote.covered).length
      return (
        <>
          <div className='readout'>
            <div className='big'>
              {data.sentTotal.map((entry) => entry.label).join(' + ') || '—'}
            </div>
            <div className='sub'>
              {n} sent
              {covered
                ? ` · ${covered} already awaiting payment`
                : ' · waiting on the client'}
            </div>
          </div>
          <div className='wrows'>
            {data.sentQuotes.map((quote) => (
              <Row
                key={quote.id}
                project={projectOf(quote.projectId)}
                text={`${quote.number} · ${quote.total}`}
                value={
                  quote.validUntil
                    ? `until ${quote.validUntil.slice(5).replace('-', '/')}`
                    : 'sent'
                }
                href={quote.href}
                soon={Boolean(
                  quote.validUntil && quote.validUntil <= data.today,
                )}
              />
            ))}
          </div>
        </>
      )
    }
    case 'notes.parked': {
      if (!data.notes) return <div className='empty'>— not read back</div>
      if (!data.notes.parked) return <div className='empty'>nothing parked</div>
      return (
        <>
          <div className='wrows'>
            {data.notes.top.map((note) => (
              <Link
                key={note.id}
                className='wnote'
                href={`/notes?note=${note.id}`}
                lang={isThai(note.title) ? 'th' : undefined}
              >
                {note.title}
                <br />
                <small>{age(note.updatedAt)} ago</small>
              </Link>
            ))}
          </div>
          <div className='fl'>
            <span>{data.notes.parked} parked</span>
            {data.notes.stale ? (
              <span className='wait'>{data.notes.stale} untouched 30d+</span>
            ) : (
              <span>none stale</span>
            )}
          </div>
        </>
      )
    }
    default:
      return null
  }
}

/** A spark path over a series, scaled to its own range. */
function sparkPath(values: number[]): { line: string; area: string } {
  if (values.length < 2) return { line: '', area: '' }
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const points = values.map((value, i) => [
    (i / (values.length - 1)) * 100,
    30 - ((value - min) / span) * 28,
  ])
  const line = points
    .map(([x, y], i) => `${i ? 'L' : 'M'}${x?.toFixed(2)} ${y?.toFixed(2)}`)
    .join(' ')
  return { line, area: `${line} L100 32 L0 32 Z` }
}

/**
 * The one LCD (`money.7d`): net over the last 7 days per
 * currency, a spark of net per week, what it is made of, and the payouts no
 * one has confirmed yet. Nothing recorded is a word, never ฿0 pretending.
 */
function MoneyWeek({ data }: { data: HomeData }) {
  const earned = data.earned
  if (!earned)
    return (
      <div className='readout wl'>
        <div className='fig'>
          —<small>not read back</small>
        </div>
      </div>
    )
  const nonzero = (amount: string) => !/^-?0(\.0+)?$/.test(amount)
  const books = earned.books.filter((book) => nonzero(book.net))
  const label = (amount: string, currency: string) =>
    formatMoney(amount, currency)
  const parts = (key: 'sales' | 'earnings' | 'paid' | 'fees' | 'refunds') =>
    earned.books
      .filter((book) => nonzero(book[key]))
      .map((book) => label(book[key], book.currency))
      .join(' + ') || '—'
  const previous = (currency: string) =>
    earned.previous.find((book) => book.currency === currency)?.net ?? null
  const { line, area } = sparkPath(earned.spark)
  return (
    <>
      <div className='readout wl'>
        <div className='fig'>
          {books.length ? (
            <Amounts
              list={books.map((book) => ({
                currency: book.currency,
                label: label(book.net, book.currency),
              }))}
            />
          ) : (
            '○'
          )}
          <small>{books.length ? 'net · 7d' : 'nothing recorded yet'}</small>
        </div>
        {line ? (
          <svg
            className='spark'
            viewBox='0 0 100 32'
            preserveAspectRatio='none'
            role='img'
            aria-label={`Net per week, last ${earned.spark.length} weeks, in ${earned.sparkCurrency}`}
          >
            <path className='area' d={area} />
            <path className='line' d={line} />
          </svg>
        ) : null}
        <div className='fl'>
          <span>earnings</span>
          <span>{parts('earnings')}</span>
        </div>
        <div className='fl'>
          <span>sales</span>
          <span>{parts('sales')}</span>
        </div>
        <div className='fl'>
          <span>paid cards</span>
          <span>{parts('paid')}</span>
        </div>
        <div className='fl'>
          <span>fees · refunds</span>
          <span>
            {parts('fees')} · {parts('refunds')}
          </span>
        </div>
      </div>
      <div className='fl'>
        <span className='say'>
          {books.length
            ? books.map((book, i) => {
                const before = previous(book.currency)
                return (
                  <Fragment key={book.currency}>
                    {i ? ' · ' : null}
                    <span>
                      {before
                        ? `vs ${label(before, book.currency)} the week before`
                        : 'nothing the week before'}
                    </span>
                  </Fragment>
                )
              })
            : 'Readings counts what happened'}
        </span>
      </div>
      <div className='fl'>
        <span>payouts</span>
        <span className={earned.expectedCount ? 'wait' : undefined}>
          {earned.expectedCount
            ? `${earned.expected.map((entry) => entry.label).join(' + ')} unconfirmed`
            : 'none waiting'}
        </span>
      </div>
    </>
  )
}
