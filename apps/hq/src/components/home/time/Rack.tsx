'use client'

import { formatMoney, sumAmounts } from '@theiceji/hq-core/money'
import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import {
  Facts,
  isThai,
  PaneHead,
  projectHex,
  Tag,
} from '@/components/bridge/parts'
import { type InboxEntry, InboxItem, type useAnswer } from '@/components/Inbox'
import { MODULES } from '@/modules'
import {
  glyphClass,
  glyphFor,
  type MoneyColumn,
  type MoneyRack,
  niceMax,
  plural,
  stateWord,
  type TimeData,
  type TimeGroup,
  type TimelineItem,
} from './model'

/**
 * Time's rack: Waiting (the compact Inbox — buttons only on
 * the selected item), Money · 7 days (one VU per project in its colour on one
 * shared scale per currency) and Selected (the detail part).
 */

const varStyle = (vars: Record<string, string | number>) =>
  vars as CSSProperties

function oldestWords(entries: InboxEntry[]) {
  const hours = entries.reduce((max, entry) => Math.max(max, entry.ageHours), 0)
  return hours < 1
    ? '<1h'
    : hours < 48
      ? `${Math.round(hours)}h`
      : `${Math.round(hours / 24)}d`
}

/* ── Waiting ────────────────────────────────────────────────────────── */

export function Waiting({
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
  return (
    <aside
      className='pane tl-waiting'
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
            ? `oldest ${oldestWords(entries)}`
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
                  {selected && entry.answer ? (
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
                  ) : selected && entry.link ? (
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
                  {selected && error ? (
                    <p className='why' role='alert'>
                      <b>Not answered:</b> {error}
                    </p>
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

/* ── Money · 7 days ─────────────────────────────────────────────────── */

export function Money({ money }: { money: TimeData['money'] }) {
  const { racks, known } = money
  const single = racks.length === 1 ? racks[0] : null
  return (
    <aside className='pane tl-money' aria-label='Money, the last 7 days'>
      <PaneHead
        title='Money · 7 days'
        meta={
          !known
            ? '— not read back'
            : single
              ? `${single.currency} · tick = the 7 days before`
              : 'tick = the 7 days before · one scale per currency'
        }
      />
      <div className='pane-body'>
        {racks.length === 0 ? (
          <div className='empty'>
            ○ nothing recorded — money comes from Market sales, Publish earnings
            and paid Board cards.
          </div>
        ) : (
          racks.map((rack) => (
            <Rack
              key={rack.currency}
              rack={rack}
              known={known}
              head={racks.length > 1}
            />
          ))
        )}
      </div>
    </aside>
  )
}

function Rack({
  rack,
  known,
  head,
}: {
  rack: MoneyRack
  known: boolean
  head: boolean
}) {
  const { currency, columns } = rack
  const add = (a: string | null, b: string | null) =>
    a && b ? sumAmounts([a, b], currency) : (a ?? b)
  const max = niceMax(
    Math.max(
      0,
      ...columns.flatMap((column) => [
        Number(
          add(
            column.net && Number(column.net) > 0 ? column.net : null,
            column.pending,
          ) ?? 0,
        ),
        Number(column.prev ?? 0),
      ]),
    ),
  )
  const level = (value: string | null) =>
    max && value ? Math.max(0, Math.min(100, (Number(value) / max) * 100)) : 0
  return (
    <section
      className={`tl-rk${head ? '' : ' bare'}${columns.length > 7 ? ' dense' : ''}`}
      style={varStyle({ '--n': columns.length })}
      aria-label={`${currency} — ${plural(columns.length, 'project')} on one scale`}
    >
      {head ? (
        <div className='tl-rk-h'>
          <span className='hud-label'>{currency}</span>
          <span className='dim'>
            {max ? `scale ${formatMoney(String(max), currency)}` : ''}
          </span>
        </div>
      ) : (
        <span className='sr-only'>{currency}</span>
      )}
      <div className='tl-meters' style={varStyle({ '--n': columns.length })}>
        {columns.map((column) => (
          <Meter
            key={column.project.id}
            column={column}
            currency={currency}
            known={known}
            level={level}
            owed={add(
              column.net && Number(column.net) > 0 ? column.net : null,
              column.pending,
            )}
          />
        ))}
      </div>
    </section>
  )
}

function Meter({
  column,
  currency,
  known,
  level,
  owed,
}: {
  column: MoneyColumn
  currency: string
  known: boolean
  level: (value: string | null) => number
  /** Net plus pending — where the dashed cap sits. */
  owed: string | null
}) {
  const { project, net, prev, pending } = column
  const money = (amount: string) => formatMoney(amount, currency)
  const hex = projectHex(project.color)
  const said = !known
    ? 'not read back'
    : [
        net
          ? `${money(net)} in the last 7 days`
          : 'nothing recorded in the last 7 days',
        prev ? `${money(prev)} the 7 days before` : null,
        pending
          ? `${money(pending)} awaiting payment or quoted — not money yet`
          : null,
      ]
        .filter(Boolean)
        .join(', ')
  const value: ReactNode = !known
    ? '—'
    : net
      ? formatMoney(net, currency, { symbol: false })
      : pending
        ? `(${formatMoney(pending, currency, { symbol: false })})`
        : '0'
  return (
    <div
      className={`tl-mtr${project.status === 'paused' ? ' paused' : ''}`}
      title={`${project.name} · ${said}`}
    >
      <div
        className={`vu${known ? '' : ' pending'}`}
        style={varStyle({ '--c': hex })}
        role='img'
        aria-label={`${project.name}: ${said}`}
      >
        {known && pending ? (
          <>
            <div
              className='fill pend'
              style={varStyle({ '--level': `${level(owed)}%` })}
            />
            <div
              className='cap'
              style={varStyle({ '--level': `${level(owed)}%` })}
            />
          </>
        ) : null}
        {known && net && Number(net) > 0 ? (
          <div
            className='fill'
            style={varStyle({ '--level': `${level(net)}%` })}
          />
        ) : null}
        {known && prev && Number(prev) > 0 ? (
          <div
            className='peak'
            style={varStyle({ '--peak': `${level(prev)}%` })}
          />
        ) : null}
      </div>
      <div className={`v${!known || !net ? ' dim' : ''}`}>{value}</div>
      <div className='l'>
        <i
          className='dot'
          style={varStyle({ '--project': hex })}
          aria-hidden='true'
        />
        <span lang={isThai(project.name) ? 'th' : undefined}>
          {project.name}
        </span>
      </div>
    </div>
  )
}

/* ── Selected ───────────────────────────────────────────────────────── */

const KIND_WORD = { block: 'block', mark: 'mark', tick: 'tick' } as const

export function Selected({
  item,
  group,
  entry,
  answering,
}: {
  item: TimelineItem | null
  group: TimeGroup | null
  /** The Inbox entry the item waits on, if any — its buttons act here. */
  entry: InboxEntry | null
  answering: ReturnType<typeof useAnswer>
}) {
  if (!item || !group)
    return (
      <aside className='pane tl-selected' aria-label='Selected'>
        <PaneHead title='Selected' meta='nothing' />
        <div className='pane-body'>
          <div className='empty'>
            Nothing selected — click a block, or move with <kbd>←</kbd>
            <kbd>→</kbd> <kbd>↑</kbd>
            <kbd>↓</kbd>.
          </div>
        </div>
      </aside>
    )
  const module = MODULES[item.module]
  const word = stateWord(item)
  const { answer, pending, error } = answering
  const seen = new Set<string>()
  const facts = (
    [
      ['project', group.project.name],
      ['module', `${module.glyph} ${module.label}`],
      ['when', item.when],
      [
        'state',
        <span key='state' className={`st-${item.state}`}>
          {word}
        </span>,
      ],
      ...item.facts,
      ...(entry?.facts ?? []),
    ] as [string, ReactNode][]
  ).filter(([key]) => {
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return (
    <aside className='pane tl-selected' aria-label='Selected'>
      <PaneHead
        title='Selected'
        meta={`${module.label} · ${KIND_WORD[item.kind]}`}
      />
      <div className='pane-body'>
        <div className='tl-sbody'>
          <div className='tl-stitle'>
            <Tag project={group.project} />
            <span className='mod'>
              {module.glyph} {module.label}
            </span>
            <i className={`glyph ${glyphClass(item.state)}`} aria-hidden='true'>
              {glyphFor(item.state)}
            </i>
          </div>
          <div className='t' lang={isThai(item.label) ? 'th' : undefined}>
            {item.label}
          </div>
          {entry?.body ? (
            <p lang={isThai(entry.body) ? 'th' : undefined}>{entry.body}</p>
          ) : null}
          {entry?.quote ? (
            <p className='quote'>
              <span className='hud-label'>Proposed</span>
              {entry.quote}
            </p>
          ) : null}
          <div className='acts'>
            {entry?.answer
              ? entry.answer.options.map((option, index) => (
                  <button
                    key={option.key}
                    type='button'
                    className={`btn${index === 0 ? ' btn-pri' : ''}`}
                    disabled={pending}
                    onClick={() => answer(entry, option.key)}
                  >
                    {option.label}
                    <kbd>{option.hotkey}</kbd>
                  </button>
                ))
              : null}
            <Link className='btn' href={item.href}>
              Open page
              <kbd>↵</kbd>
            </Link>
          </div>
          {entry && error ? (
            <p className='why' role='alert'>
              <b>Not answered:</b> {error}
            </p>
          ) : null}
          {entry ? (
            <p className='why'>
              <b>Why it stopped:</b> {entry.why}
            </p>
          ) : null}
          <Facts rows={facts} />
        </div>
      </div>
    </aside>
  )
}
