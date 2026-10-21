'use client'

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { isThai, projectHex } from '@/components/bridge/parts'
import {
  drawnSpan,
  LANE_PAD,
  NARROW,
  packLane,
  plural,
  ROW_GAP,
  ROW_H,
  stateWord,
  type TimeData,
  type TimeGroup,
  type TimeLane,
  type TimelineItem,
} from './model'

/**
 * Time's arrange: a sticky Mon–Sun ruler with the transport
 * and the week in its corner, then one group per project whose rows are the
 * modules with dated records this week. Items are buttons placed on their
 * lane; overlapping ones split into rows. One tab stop for the whole week —
 * the selected item (or the first) — and the arrows move from there.
 */

const pct = (days: number) => `${((days / 7) * 100).toFixed(3)}%`
const varStyle = (vars: Record<string, string | number>) =>
  vars as CSSProperties

export function weekHref(key: string | null) {
  return key ? `/?view=time&week=${key}` : '/?view=time'
}

export function Arrange({
  data,
  selected,
  tabStop,
  collapsed,
  onSelect,
  onFold,
}: {
  data: TimeData
  selected: string | null
  /** The item that holds the week's one tab stop. */
  tabStop: string | null
  collapsed: ReadonlySet<string>
  onSelect: (id: string) => void
  onFold: (slug: string) => void
}) {
  const { week, now } = data
  const todayIndex = week.days.findIndex((day) => day.day === now.today)
  return (
    <section className='pane tl-arrange' aria-label='This week'>
      <div
        className='tl-tracks'
        tabIndex={-1}
        style={varStyle({
          '--now': ((now.at ?? 0) / 7).toFixed(4),
          '--today': todayIndex,
        })}
      >
        <div className='tl-ruler'>
          <div className='tl-corner'>
            {/* biome-ignore lint/a11y/useSemanticElements: the transport is a group of links, like a toolbar */}
            <div className='tl-transport' role='group' aria-label='Week'>
              <Link
                href={weekHref(week.prev)}
                scroll={false}
                title='Previous week  ['
                aria-label='Previous week'
              >
                ⏮︎
              </Link>
              <Link
                href={weekHref(null)}
                scroll={false}
                className={`today${week.current ? ' on' : ''}`}
                title='This week  t'
                aria-label='This week'
                aria-current={week.current ? 'date' : undefined}
              >
                ●
              </Link>
              <Link
                href={weekHref(week.next)}
                scroll={false}
                title='Next week  ]'
                aria-label='Next week'
              >
                ⏭︎
              </Link>
            </div>
            <span className='tl-week' title={`${week.label} · ${week.range}`}>
              <b>{week.label}</b>
              <span> · {week.range}</span>
            </span>
          </div>
          <div className='tl-days'>
            {week.days.map((day, index) => (
              <span
                key={day.day}
                className={`tl-day${index === todayIndex ? ' today' : day.day < now.today ? ' past' : ''}`}
                title={`${day.dow} ${day.num}${index === todayIndex ? ' · today' : ''}`}
                aria-current={index === todayIndex ? 'date' : undefined}
              >
                <span className='d-l'>{day.dow}</span>
                <span className='d-s' aria-hidden='true'>
                  {day.dow.slice(0, 2)}
                </span>
                &nbsp;{day.num}
              </span>
            ))}
          </div>
          {now.at !== null ? (
            <span className='tl-now-flag' aria-hidden='true'>
              now
            </span>
          ) : null}
        </div>
        <div className='tl-body'>
          {data.groups.length === 0 ? (
            <div className='empty'>
              No projects yet — a project’s dated records show here week by
              week.
            </div>
          ) : (
            data.groups.map((group) => (
              <Group
                key={group.project.id}
                group={group}
                collapsed={collapsed.has(group.project.slug)}
                selected={selected}
                tabStop={tabStop}
                onSelect={onSelect}
                onFold={onFold}
              />
            ))
          )}
          {now.at !== null ? (
            <div className='tl-playhead' aria-hidden='true' />
          ) : null}
        </div>
      </div>
    </section>
  )
}

function Group({
  group,
  collapsed,
  selected,
  tabStop,
  onSelect,
  onFold,
}: {
  group: TimeGroup
  collapsed: boolean
  selected: string | null
  tabStop: string | null
  onSelect: (id: string) => void
  onFold: (slug: string) => void
}) {
  const { project, lanes } = group
  const paused = project.status === 'paused'
  const count = lanes.reduce((n, lane) => n + lane.items.length, 0)
  const lanesId = `tl-g-${project.slug}`
  return (
    <section
      className={`tl-group${paused ? ' paused' : ''}${collapsed ? ' collapsed' : ''}`}
      style={varStyle({ '--project': projectHex(project.color) })}
      aria-label={`${project.name}${paused ? ', paused' : ''}`}
    >
      <div className='tl-ghead'>
        <div className='tl-gth'>
          <button
            type='button'
            className='tl-fold'
            aria-expanded={!collapsed}
            aria-controls={lanesId}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${project.name}`}
            title={`${collapsed ? 'Expand' : 'Collapse'} ${project.name}`}
            onClick={() => onFold(project.slug)}
          >
            {collapsed ? '▸' : '▾'}
          </button>
          <i className='dot' aria-hidden='true' />
          {/* A plain link: opening a project is a document request. */}
          <a
            className='tl-gname'
            href={`/p/${project.slug}`}
            lang={isThai(project.name) ? 'th' : undefined}
            title={`${project.name} — project page`}
          >
            {project.name}
          </a>
          <span className='tl-gkind'>{project.kindLabel}</span>
          {paused ? <span className='tl-gstat'>paused</span> : null}
        </div>
        <div className='tl-glane'>
          {collapsed
            ? `${plural(lanes.length, 'lane')} · ${plural(count, 'item')}`
            : ''}
        </div>
      </div>
      <div className='tl-glanes' id={lanesId}>
        {lanes.length ? (
          lanes.map((lane) => (
            <Lane
              key={lane.module}
              lane={lane}
              projectName={project.name}
              selected={selected}
              tabStop={tabStop}
              onSelect={onSelect}
            />
          ))
        ) : (
          <div className='tl-track none'>
            <div className='tl-th' />
            <div className='tl-lane'>
              <span className='tl-nothing'>nothing scheduled</span>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function Lane({
  lane,
  projectName,
  selected,
  tabStop,
  onSelect,
}: {
  lane: TimeLane
  projectName: string
  selected: string | null
  tabStop: string | null
  onSelect: (id: string) => void
}) {
  if (lane.unknown)
    return (
      <div className='tl-track none' data-module={lane.module}>
        <div className='tl-th'>
          <span className='tl-mglyph' aria-hidden='true'>
            {lane.glyph}
          </span>
          <span className='tl-mname'>{lane.label}</span>
        </div>
        <div className='tl-lane'>
          <span className='tl-nothing unknown'>— not read back</span>
        </div>
      </div>
    )
  const packed = packLane(lane.items)
  const n = lane.items.length
  return (
    <div
      className='tl-track'
      style={{ height: packed.height }}
      data-module={lane.module}
    >
      <div className='tl-th'>
        <span className='tl-mglyph' aria-hidden='true'>
          {lane.glyph}
        </span>
        <span className='tl-mname'>{lane.label}</span>
        <span className='tl-cnt' title={`${plural(n, 'item')} this week`}>
          {n}
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a lane is a labelled group of item buttons */}
      <div
        className='tl-lane'
        role='group'
        aria-label={`${projectName} · ${lane.label}`}
      >
        {lane.items.map((item) => (
          <Item
            key={item.id}
            item={item}
            laneLabel={lane.label}
            top={LANE_PAD + (packed.rows.get(item.id) ?? 0) * (ROW_H + ROW_GAP)}
            selected={item.id === selected}
            tabbable={item.id === tabStop}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}

function Item({
  item,
  laneLabel,
  top,
  selected,
  tabbable,
  onSelect,
}: {
  item: TimelineItem
  laneLabel: string
  top: number
  selected: boolean
  tabbable: boolean
  onSelect: (id: string) => void
}) {
  const word = stateWord(item)
  const lang = isThai(item.label) ? 'th' : undefined
  const common = {
    type: 'button' as const,
    'data-id': item.id,
    'aria-pressed': selected,
    tabIndex: tabbable ? 0 : -1,
    title: `${item.label} · ${item.when} · ${word}`,
    'aria-label': `${item.label}, ${laneLabel}, ${item.when}, ${word}`,
    onClick: () => onSelect(item.id),
  }
  const sel = selected ? ' sel' : ''
  const span = drawnSpan(item)
  if (item.kind === 'mark')
    return (
      <button
        {...common}
        className={`tl-mark st-${item.state}${sel}`}
        style={{ left: pct(span.from), top }}
      >
        <i aria-hidden='true' />
        <span className='tl-mlbl' lang={lang}>
          {item.label}
        </span>
      </button>
    )
  if (item.kind === 'tick')
    return (
      <button
        {...common}
        className={`tl-tick st-${item.state}${sel}`}
        style={{ left: pct(span.from), top: top + 3 }}
      />
    )
  const width = span.to - span.from
  const narrow = width < NARROW
  const glyph =
    item.state === 'wait' ? (
      <i className='glyph wait' aria-hidden='true'>
        ◆
      </i>
    ) : null
  const level =
    item.state === 'doing' && item.progress != null
      ? Math.max(0, Math.min(100, item.progress))
      : null
  return (
    <>
      <button
        {...common}
        className={`tl-blk st-${item.state}${narrow ? ' narrow' : ''}${sel}`}
        style={{
          left: pct(span.from),
          width: pct(width),
          top,
          ...(level !== null ? varStyle({ '--level': `${level}%` }) : {}),
        }}
      >
        {glyph}
        {narrow ? null : (
          <span className='t' lang={lang}>
            {item.label}
          </span>
        )}
        {level !== null ? (
          <span className='prog' aria-hidden='true'>
            <i />
          </span>
        ) : null}
      </button>
      {narrow ? (
        <span
          className='tl-lbl-out'
          style={{ left: `calc(${pct(span.to)} + 4px)`, top }}
          lang={lang}
          aria-hidden='true'
        >
          {item.label}
        </span>
      ) : null}
    </>
  )
}
