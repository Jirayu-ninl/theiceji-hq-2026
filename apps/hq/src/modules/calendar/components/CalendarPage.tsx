'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import {
  age,
  Dot,
  Empty,
  Facts,
  Inspector,
  InspectorHead,
  isThai,
  PaneHead,
  projectHex,
  Tag,
  usePageKeys,
} from '@/components/bridge/parts'
import { Confirm } from '@/components/Confirm'
import { usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import { Markdown } from '@/lib/md'
import {
  createEventAction,
  deleteEventAction,
  type EventForm,
  restoreEventAction,
  retryEventSyncAction,
  syncNowAction,
  updateEventAction,
} from '../actions'
import type { EventData, OverlayData, StatusData } from '../data'

/**
 * Calendar: Week (07–22, a sticky
 * all-day row) or Month (Monday first), beside an inspector. Events are HQ's
 * and Google's; card dues and quotes running out are an overlay from their
 * own modules that never syncs. The instrument is the Google sync readout
 * in the toolbar, with the now line in today's column.
 *
 * Keys: e add · ↵ edit · ⌫ delete · g sync now · t today · [ ] move.
 * Deleting an event that syncs deletes it in Google too, so the key and
 * the button both ask first, in place; every delete's toast has Undo,
 * which works until the next sync has taken the event off Google.
 */

type CalProject = {
  id: string
  slug: string
  name: string
  color: string
  status: string
}

export type CalendarPageProps = {
  project: CalProject | null
  projects: CalProject[]
  view: 'week' | 'month'
  day: string
  today: string
  from: string
  to: string
  month: { first: string; last: string } | null
  timezone: string
  events: EventData[]
  overlay: OverlayData[]
  status: StatusData
  selectedId: string | null
}

const H0 = 7
const HOURS = 15
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n))
    .toISOString()
    .slice(0, 10)
}
function addMonths(day: string, n: number): string {
  const [y, m] = day.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + n, 1))
    .toISOString()
    .slice(0, 10)
}
const dayOfMonth = (day: string) => Number(day.slice(8, 10))
const labelOf = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`)
  return `${WEEKDAYS[(date.getUTCDay() + 6) % 7]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
}
function isoWeek(day: string): number {
  const date = new Date(`${day}T00:00:00Z`)
  const thursday = new Date(date)
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7))
  const first = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4))
  return (
    1 +
    Math.round(
      ((thursday.getTime() - first.getTime()) / 86400000 -
        3 +
        ((first.getUTCDay() + 6) % 7)) /
        7,
    )
  )
}

/** An instant as a day and an hour (with minutes as a fraction) in a zone. */
function localOf(
  iso: string,
  timeZone: string,
): { day: string; hour: number; text: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '00'
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    hour: hour + minute / 60,
    text: `${get('hour')}:${get('minute')}`,
  }
}

/** Every day an event covers, inclusive. */
function daysOf(
  event: EventData,
  timeZone: string,
): { first: string; last: string } {
  if (event.allDay && event.dates) return event.dates
  const start = localOf(event.startsAt, timeZone)
  const endMs = Math.max(
    Date.parse(event.startsAt),
    Date.parse(event.endsAt) - 1,
  )
  return {
    first: start.day,
    last: localOf(new Date(endMs).toISOString(), timeZone).day,
  }
}

function SyncChip({ status }: { status: StatusData }) {
  if (status.status === 'needs_reauth' || status.status === 'revoked')
    return (
      <Link
        className='sync problem'
        href='/settings/google'
        title='Reconnect at Settings › Google'
      >
        <i />◆ Google · reconnect
      </Link>
    )
  if (!status.ready)
    return (
      <Link
        className='sync off'
        href='/settings/google'
        title='Connect Google to sync'
      >
        <i />
        Google · not connected
      </Link>
    )
  if (status.problem)
    return (
      <span className='sync warn' title={status.problem}>
        <i />
        Google · {status.problem.slice(0, 40)}
      </span>
    )
  return (
    <span
      className='sync'
      title='Google → HQ every ten minutes; HQ → Google for events with sync on'
    >
      <i />
      Google ·{' '}
      {status.lastSyncedAt
        ? `synced ${age(status.lastSyncedAt)} ago`
        : 'first sync pending'}
      {status.pending ? ` · ${status.pending} to send` : ''}
      {status.errors ? ` · ${status.errors} failed` : ''}
    </span>
  )
}

export function CalendarPage(props: CalendarPageProps) {
  const router = useRouter()
  const pathname = usePathname()
  const toast = useToast()
  const [events, setEvents] = useState(props.events)
  const [status, setStatus] = useState(props.status)
  const [selected, setSelected] = useState<string | null>(props.selectedId)
  const [pickedDay, setPickedDay] = useState<string | null>(null)
  const [mode, setMode] = useState<'read' | 'new' | 'edit'>('read')
  const [draftAt, setDraftAt] = useState<{ day: string; hour: number | null }>({
    day: props.day,
    hour: null,
  })
  const [showOverlay, setShowOverlay] = useState(true)
  // Delete of an event that syncs asks in place; ⌫ opens the same question.
  const [asking, setAsking] = useState(false)
  const [pending, start] = useTransition()
  const scrollRef = useRef<HTMLDivElement>(null)
  const all = props.project === null
  const tz = props.timezone

  useEffect(() => setEvents(props.events), [props.events])
  useEffect(() => setStatus(props.status), [props.status])

  const colorOf = useCallback(
    (projectId: string | null) =>
      props.projects.find((entry) => entry.id === projectId)?.color ??
      props.project?.color ??
      null,
    [props.projects, props.project],
  )
  const days = useMemo(() => {
    const out: string[] = []
    for (let day = props.from; day <= props.to; day = addDays(day, 1))
      out.push(day)
    return out
  }, [props.from, props.to])
  const current = events.find((event) => event.id === selected) ?? null

  // Morning in view: the week opens scrolled to 08:00, never to midnight.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 40
  }, [])

  const go = (params: Record<string, string | null>) => {
    const url = new URLSearchParams(window.location.search)
    for (const [key, value] of Object.entries(params)) {
      if (value === null) url.delete(key)
      else url.set(key, value)
    }
    url.delete('event')
    const query = url.toString()
    router.push(query ? `${pathname}?${query}` : pathname)
  }
  const step = (direction: -1 | 1) =>
    go({
      day:
        props.view === 'month'
          ? addMonths(props.month?.first ?? props.day, direction)
          : addDays(props.day, 7 * direction),
    })

  const select = (id: string | null) => {
    setSelected(id)
    setMode('read')
    setPickedDay(null)
    setAsking(false)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('event', id)
    else url.searchParams.delete('event')
    window.history.replaceState(null, '', url)
  }

  const replace = (next: EventData) =>
    setEvents((list) =>
      list.some((event) => event.id === next.id)
        ? list.map((event) => (event.id === next.id ? next : event))
        : [...list, next],
    )

  const syncNow = () =>
    start(async () => {
      const result = await syncNowAction()
      if (result.ok) {
        setStatus(result.data)
        toast('Synced with Google')
      } else toast(result.error)
    })

  /** Delete, with Undo — the key and the button both land here. */
  const remove = async (event: EventData) => {
    const result = await deleteEventAction({
      eventId: event.id,
      expectedRevision: event.revision,
    })
    if (!result.ok) {
      toast(result.error)
      return
    }
    setEvents((list) => list.filter((entry) => entry.id !== event.id))
    select(null)
    toast(
      `Deleted: ${event.title}${event.sync ? ' — it leaves Google on the next sync' : ''}`,
      {
        undo: async () => {
          const back = await restoreEventAction({
            eventId: event.id,
            expectedRevision: result.data.revision,
          })
          if (!back.ok) {
            // After the toast closes, so the answer stays on screen:
            // Google already took it off, and Undo says so in words.
            setTimeout(() => toast(back.error))
            return
          }
          replace(back.data)
          select(back.data.id)
        },
      },
    )
  }

  usePageKeyHints([
    ['e', 'add event'],
    ['↵', 'edit'],
    ['⌫', 'delete'],
    ['g', 'sync now'],
    ['t', 'today'],
    ['[ ]', props.view === 'month' ? 'month' : 'week'],
    ['1 2', 'week · month'],
  ])

  usePageKeys((key) => {
    // While Delete asks, its two answers have the keys: ↵ gives the one
    // with focus, Esc keeps the event.
    if (asking) {
      if (key !== 'Escape') return false
      setAsking(false)
      return true
    }
    if (key === 'Escape') {
      if (mode !== 'read') {
        setMode('read')
        return true
      }
      if (selected || pickedDay) {
        select(null)
        return true
      }
      return false
    }
    if (key === 'e') {
      setDraftAt({
        day:
          pickedDay ??
          (props.day >= props.from && props.day <= props.to
            ? props.today
            : props.from),
        hour: null,
      })
      setMode('new')
      return true
    }
    if (key === 'g') {
      syncNow()
      return true
    }
    if (key === 't') {
      go({ day: null })
      return true
    }
    if (key === '[' || key === ']') {
      step(key === '[' ? -1 : 1)
      return true
    }
    if (!current) return false
    if (key === 'Enter') {
      setMode('edit')
      return true
    }
    if (key === 'Backspace' || key === 'Delete') {
      // The same path as the button: an event that syncs asks first.
      if (current.sync) setAsking(true)
      else if (!pending) start(() => remove(current))
      return true
    }
    return false
  })

  const overlay = showOverlay ? props.overlay : []
  const allDayOn = (day: string) =>
    events.filter(
      (event) =>
        event.allDay &&
        daysOf(event, tz).first <= day &&
        daysOf(event, tz).last >= day,
    )
  const timedOn = (day: string) =>
    events.filter(
      (event) => !event.allDay && localOf(event.startsAt, tz).day === day,
    )
  const overlayOn = (day: string) =>
    overlay.filter((entry) => entry.day === day)
  const rangeLabel =
    props.view === 'month' && props.month
      ? `${MONTH_NAMES[Number(props.month.first.slice(5, 7)) - 1]} ${props.month.first.slice(0, 4)}`
      : `W${isoWeek(props.from)} · ${labelOf(props.from)} – ${labelOf(props.to)}`
  const nowParts = localOf(new Date().toISOString(), tz)

  return (
    <div
      className={`page calp${props.project?.status === 'paused' ? ' paused' : ''}`}
    >
      <section
        className={`pane cal-pane${props.project?.status === 'paused' ? ' paused' : ''}`}
        aria-label='Calendar'
      >
        <PaneHead
          title={
            all ? (
              'All projects · Calendar'
            ) : (
              <>
                {props.project ? <Dot color={props.project.color} /> : null}{' '}
                Calendar
              </>
            )
          }
          meta={`${events.length} ${events.length === 1 ? 'event' : 'events'}${props.overlay.length ? ` · ${props.overlay.length} dues` : ''} · ${tz}`}
        />
        <div className='toolbar cal-toolbar'>
          {/* biome-ignore lint/a11y/useSemanticElements: the transport is a group of buttons */}
          <span
            className='transport'
            role='group'
            aria-label={props.view === 'month' ? 'Month' : 'Week'}
          >
            <button type='button' title='Previous ([)' onClick={() => step(-1)}>
              ⏮
            </button>
            <button
              type='button'
              className='today'
              title='Today (t)'
              onClick={() => go({ day: null })}
            >
              ●
            </button>
            <button type='button' title='Next (])' onClick={() => step(1)}>
              ⏭
            </button>
          </span>
          <span className='cal-range'>{rangeLabel}</span>
          <SyncChip status={status} />
          {status.ready ? (
            <button
              type='button'
              className='btn btn-sm'
              disabled={pending}
              onClick={syncNow}
            >
              Sync now<kbd>g</kbd>
            </button>
          ) : null}
          <span className='sp' />
          <label className='dues-toggle'>
            <button
              type='button'
              className='switch'
              aria-pressed={showOverlay}
              aria-label='Show dues'
              onClick={() => setShowOverlay((on) => !on)}
            />
            <span>dues · never synced</span>
          </label>
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => {
              setDraftAt({
                day:
                  pickedDay ??
                  (props.today >= props.from && props.today <= props.to
                    ? props.today
                    : props.from),
                hour: null,
              })
              setMode('new')
            }}
          >
            ＋ Event<kbd>e</kbd>
          </button>
        </div>
        {status.status === 'needs_reauth' ? (
          <p className='why cal-banner'>
            <b>Sync is paused:</b> Google needs you to sign in again. Events
            stay as they were;{' '}
            <Link href='/settings/google' style={{ color: 'var(--accent)' }}>
              reconnect at Settings › Google
            </Link>
            .
          </p>
        ) : null}
        <div className='pane-body'>
          {props.view === 'month' ? (
            <div className='cal-month'>
              <div className='mh' aria-hidden='true'>
                <span>wk</span>
                {WEEKDAYS.map((name, index) => (
                  <span
                    key={name}
                    className={
                      days[index] &&
                      WEEKDAYS[
                        (new Date(`${props.today}T00:00:00Z`).getUTCDay() + 6) %
                          7
                      ] === name
                        ? 'today'
                        : undefined
                    }
                  >
                    {name}
                  </span>
                ))}
              </div>
              {Array.from({ length: Math.ceil(days.length / 7) }, (_, row) =>
                days.slice(row * 7, row * 7 + 7),
              ).map((week) => (
                <div key={week[0]} className='mrow'>
                  <span
                    className={`wk${week.includes(props.today) ? ' cur' : ''}`}
                  >
                    {week[0] ? isoWeek(week[0]) : ''}
                  </span>
                  {week.map((day) => {
                    const inMonth = props.month
                      ? day >= props.month.first && day <= props.month.last
                      : true
                    const items = [...allDayOn(day), ...timedOn(day)]
                    const dues = overlayOn(day)
                    const shown = items.slice(0, 3)
                    return (
                      <button
                        key={day}
                        type='button'
                        className={`mcell${inMonth ? '' : ' other'}${day === props.today ? ' today' : ''}${pickedDay === day ? ' sel' : ''}`}
                        aria-label={`${labelOf(day)}: ${items.length} events, ${dues.length} dues`}
                        onClick={() => {
                          setPickedDay(day)
                          setSelected(null)
                          setMode('read')
                        }}
                      >
                        <span className='d'>{dayOfMonth(day)}</span>
                        {shown.map((event) => (
                          <span
                            key={event.id}
                            className='aday'
                            style={{
                              ['--project' as string]: colorOf(event.projectId)
                                ? projectHex(colorOf(event.projectId) as string)
                                : undefined,
                            }}
                          >
                            <span className='t'>
                              {event.allDay
                                ? ''
                                : `${localOf(event.startsAt, tz).text} `}
                              {event.title}
                            </span>
                          </span>
                        ))}
                        {dues.slice(0, 2).map((entry) => (
                          <span
                            key={entry.id}
                            className='aday due'
                            style={{
                              ['--project' as string]: entry.color
                                ? projectHex(entry.color)
                                : undefined,
                            }}
                          >
                            <span className='g'>
                              {entry.kind === 'card' ? '▦' : '▧'}
                            </span>
                            <span className='t'>{entry.label}</span>
                          </span>
                        ))}
                        {items.length + dues.length >
                        shown.length + Math.min(2, dues.length) ? (
                          <span className='more'>
                            +
                            {items.length +
                              dues.length -
                              shown.length -
                              Math.min(2, dues.length)}{' '}
                            more
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          ) : (
            <div className='cal-week' ref={scrollRef}>
              <div className='cal-grid'>
                <div className='cal-head'>
                  <span className='corner'>{tz.split('/').pop()}</span>
                  {days.map((day) => (
                    <span
                      key={day}
                      className={`day${day === props.today ? ' today' : ''}${day < props.today ? ' past' : ''}`}
                      style={{ position: 'sticky' }}
                    >
                      {labelOf(day).split(' ')[0]}
                      <b>{dayOfMonth(day)}</b>
                    </span>
                  ))}
                </div>
                <div className='cal-allday'>
                  <span className='corner'>all day</span>
                  {days.map((day) => (
                    <div
                      key={day}
                      className={`cell${day === props.today ? ' today' : ''}`}
                    >
                      {allDayOn(day).map((event) => (
                        <button
                          key={event.id}
                          type='button'
                          className={`aday${event.id === selected ? ' sel' : ''}`}
                          style={{
                            ['--project' as string]: colorOf(event.projectId)
                              ? projectHex(colorOf(event.projectId) as string)
                              : undefined,
                          }}
                          onClick={() => select(event.id)}
                        >
                          <span
                            className='t'
                            lang={isThai(event.title) ? 'th' : undefined}
                          >
                            {event.title}
                          </span>
                        </button>
                      ))}
                      {overlayOn(day).map((entry) => (
                        <Link
                          key={entry.id}
                          href={entry.href}
                          className='aday due'
                          style={{
                            ['--project' as string]: entry.color
                              ? projectHex(entry.color)
                              : undefined,
                          }}
                          title={`${entry.label} — from ${entry.kind === 'card' ? 'Board' : 'Quotes'}, never synced`}
                        >
                          <span className='g'>
                            {entry.kind === 'card' ? '▦' : '▧'}
                          </span>
                          <span className='t'>{entry.label}</span>
                        </Link>
                      ))}
                    </div>
                  ))}
                </div>
                <div className='cal-body'>
                  <div className='gutter'>
                    {Array.from({ length: HOURS }, (_, i) => (
                      <span key={i} style={{ ['--i' as string]: i }}>
                        {String(H0 + i).padStart(2, '0')}
                      </span>
                    ))}
                  </div>
                  {days.map((day) => {
                    const items = timedOn(day)
                      .map((event) => {
                        const start = localOf(event.startsAt, tz)
                        const endHour =
                          start.hour +
                          (Date.parse(event.endsAt) -
                            Date.parse(event.startsAt)) /
                            3600000
                        return {
                          event,
                          start,
                          top: Math.max(0, start.hour - H0),
                          bottom: Math.min(
                            HOURS,
                            Math.max(endHour, start.hour + 0.4) - H0,
                          ),
                        }
                      })
                      .sort((a, b) => a.top - b.top)
                    // Overlaps share the column's width, first come first placed.
                    const lanes: number[] = []
                    const placed = items.map((item) => {
                      let lane = lanes.findIndex((end) => end <= item.top)
                      if (lane < 0) lane = lanes.length
                      lanes[lane] = item.bottom
                      return { ...item, lane }
                    })
                    const width = Math.max(1, lanes.length)
                    return (
                      <div
                        key={day}
                        className={`col${day === props.today ? ' today' : ''}`}
                        role='presentation'
                        onDoubleClick={(event) => {
                          const rect =
                            event.currentTarget.getBoundingClientRect()
                          const hour =
                            H0 +
                            Math.floor(
                              ((event.clientY - rect.top) / rect.height) *
                                HOURS,
                            )
                          setDraftAt({ day, hour })
                          setMode('new')
                        }}
                      >
                        {placed.map(({ event, start, top, bottom, lane }) => (
                          <button
                            key={event.id}
                            type='button'
                            className={`ev${event.id === selected ? ' sel' : ''}${day < props.today ? ' past' : ''}${event.syncState === 'error' ? ' wait' : ''}`}
                            style={{
                              top: `calc(${top} * var(--hh))`,
                              height: `max(18px, calc(${Math.max(0.4, bottom - top)} * var(--hh) - 2px))`,
                              left: `calc(${(lane / width) * 100}% + 3px)`,
                              width: `calc(${100 / width}% - 6px)`,
                              right: 'auto',
                              ['--project' as string]: colorOf(event.projectId)
                                ? projectHex(colorOf(event.projectId) as string)
                                : undefined,
                            }}
                            aria-label={`${event.title}, ${labelOf(day)} ${start.text}${event.sync ? ', syncs with Google' : ''}`}
                            onClick={() => select(event.id)}
                          >
                            <span className='tm'>{start.text}</span>
                            <span
                              className='t'
                              lang={isThai(event.title) ? 'th' : undefined}
                            >
                              {event.title}
                            </span>
                            {event.source === 'google' ? (
                              <span className='sm'>G</span>
                            ) : event.sync ? (
                              <span className='sm'>↔</span>
                            ) : null}
                          </button>
                        ))}
                        {day === props.today &&
                        nowParts.hour >= H0 &&
                        nowParts.hour <= H0 + HOURS ? (
                          <div
                            className='nowline'
                            style={{
                              top: `calc(${nowParts.hour - H0} * var(--hh))`,
                            }}
                          >
                            <span>{nowParts.text}</span>
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>
              {events.length === 0 && overlay.length === 0 ? (
                <p className='cal-quiet'>
                  ○ nothing scheduled this week — press e to add an event.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </section>
      <Inspector
        id='calendar'
        label='Event'
        empty={!current && mode === 'read' && !pickedDay}
        onClose={() => select(null)}
      >
        {mode === 'new' || (mode === 'edit' && current) ? (
          <EventEditor
            key={
              mode === 'edit'
                ? current?.id
                : `new-${draftAt.day}-${draftAt.hour}`
            }
            event={mode === 'edit' ? current : null}
            draftAt={draftAt}
            timezone={tz}
            projects={
              all ? props.projects : props.project ? [props.project] : []
            }
            defaultProjectId={props.project?.id ?? null}
            googleReady={status.ready}
            onCancel={() => setMode('read')}
            onSaved={(event, created) => {
              replace(event)
              setSelected(event.id)
              setMode('read')
              toast(
                `${created ? 'Added' : 'Saved'}: ${event.title}${event.sync ? ' — goes to Google on the next sync' : ''}`,
              )
            }}
          />
        ) : current ? (
          <EventInspector
            event={current}
            timezone={tz}
            busy={pending}
            onClose={() => select(null)}
            onEdit={() => setMode('edit')}
            onDelete={() => remove(current)}
            asking={asking}
            onAsking={setAsking}
            onChanged={(event) => {
              replace(event)
            }}
          />
        ) : pickedDay ? (
          <>
            <InspectorHead
              title={labelOf(pickedDay)}
              meta={pickedDay === props.today ? 'today' : ''}
              onClose={() => setPickedDay(null)}
            />
            <div className='insp-body'>
              <div className='day-list'>
                {[...allDayOn(pickedDay), ...timedOn(pickedDay)].map(
                  (event) => (
                    <button
                      key={event.id}
                      type='button'
                      className='dev-row'
                      onClick={() => select(event.id)}
                    >
                      <span className='t'>{event.title}</span>
                      <span className='v'>
                        {event.allDay
                          ? 'all day'
                          : localOf(event.startsAt, tz).text}
                      </span>
                    </button>
                  ),
                )}
                {overlayOn(pickedDay).map((entry) => (
                  <Link key={entry.id} className='dev-row' href={entry.href}>
                    <span className='t'>
                      {entry.kind === 'card' ? '▦' : '▧'} {entry.label}
                    </span>
                    <span className='v'>
                      {entry.kind === 'card' ? 'due' : 'runs out'}
                    </span>
                  </Link>
                ))}
                {allDayOn(pickedDay).length +
                  timedOn(pickedDay).length +
                  overlayOn(pickedDay).length ===
                0 ? (
                  <Empty>○ nothing on this day</Empty>
                ) : null}
              </div>
              <div className='dev-acts'>
                <button
                  type='button'
                  className='btn btn-sm'
                  onClick={() => {
                    setDraftAt({ day: pickedDay, hour: null })
                    setMode('new')
                  }}
                >
                  ＋ Event on this day<kbd>e</kbd>
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <InspectorHead title='Event' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>
                Select an event, or press e to add one. Double-click an hour to
                add it there.
              </Empty>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

function whenText(event: EventData, timeZone: string): string {
  if (event.allDay && event.dates)
    return event.dates.first === event.dates.last
      ? `${labelOf(event.dates.first)} · all day`
      : `${labelOf(event.dates.first)} – ${labelOf(event.dates.last)} · all day`
  const start = localOf(event.startsAt, timeZone)
  const end = localOf(event.endsAt, timeZone)
  return start.day === end.day
    ? `${labelOf(start.day)} · ${start.text}–${end.text}`
    : `${labelOf(start.day)} ${start.text} – ${labelOf(end.day)} ${end.text}`
}

function EventInspector({
  event,
  timezone,
  busy,
  onClose,
  onEdit,
  onDelete,
  asking,
  onAsking,
  onChanged,
}: {
  event: EventData
  timezone: string
  busy: boolean
  onClose: () => void
  onEdit: () => void
  onDelete: () => Promise<void>
  /** Delete of an event that syncs is asking. */
  asking: boolean
  onAsking: (asking: boolean) => void
  onChanged: (event: EventData) => void
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const syncWord =
    event.syncState === 'synced'
      ? 'in Google · synced'
      : event.syncState === 'pending'
        ? 'going to Google on the next sync'
        : event.syncState === 'error'
          ? 'Google refused the last change'
          : 'HQ only'
  return (
    <>
      <InspectorHead
        title={<Tag project={event.project} />}
        meta={event.source === 'google' ? 'from Google' : 'made in HQ'}
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <div className='readout'>
            <div className='big note'>
              {whenText(event, event.timezone ?? timezone)}
            </div>
            <div className='sub'>{syncWord}</div>
          </div>
          <Facts
            rows={[
              ['where', event.location ?? '—'],
              ['zone', event.allDay ? 'dates' : (event.timezone ?? timezone)],
              ['source', event.source],
              ['sync', event.sync ? 'on' : 'off'],
            ]}
          />
        </div>
        <div className='dev-main'>
          <h2
            className='ev-title'
            lang={isThai(event.title) ? 'th' : undefined}
          >
            {event.title}
          </h2>
          <Markdown source={event.description} />
          {event.syncState === 'error' && event.syncProblem ? (
            <p className='why'>
              <b>Not in Google:</b> {event.syncProblem}
            </p>
          ) : null}
          <div className='dev-acts'>
            <button type='button' className='btn btn-sm' onClick={onEdit}>
              Edit<kbd>↵</kbd>
            </button>
            {event.syncState === 'error' ? (
              <button
                type='button'
                className='btn btn-sm'
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const result = await retryEventSyncAction({
                      eventId: event.id,
                      expectedRevision: event.revision,
                    })
                    if (result.ok) {
                      onChanged(result.data)
                      toast('It goes to Google again on the next sync')
                    } else toast(result.error)
                  })
                }
              >
                Retry sync
              </button>
            ) : null}
            {event.sync ? (
              <Confirm
                label='Delete'
                kbd='⌫'
                question='Delete here and in Google?'
                yes='Delete in both'
                run={onDelete}
                disabled={busy || pending}
                asking={asking}
                onAsking={onAsking}
              />
            ) : (
              <button
                type='button'
                className='btn btn-sm'
                disabled={busy || pending}
                onClick={() => start(onDelete)}
              >
                Delete<kbd>⌫</kbd>
              </button>
            )}
          </div>
          <div className='insp-links'>
            {event.googleLink ? (
              <a
                className='btn btn-sm'
                href={event.googleLink}
                target='_blank'
                rel='noreferrer'
              >
                Open in Google Calendar
              </a>
            ) : null}
            {event.project ? (
              <Link className='btn btn-sm' href={`/p/${event.project.slug}`}>
                Project map
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}

function EventEditor({
  event,
  draftAt,
  timezone,
  projects,
  defaultProjectId,
  googleReady,
  onCancel,
  onSaved,
}: {
  event: EventData | null
  draftAt: { day: string; hour: number | null }
  timezone: string
  projects: CalProject[]
  defaultProjectId: string | null
  googleReady: boolean
  onCancel: () => void
  onSaved: (event: EventData, created: boolean) => void
}) {
  const initial = (() => {
    if (event) {
      if (event.allDay && event.dates)
        return { allDay: true, start: event.dates.first, end: event.dates.last }
      const zone = event.timezone ?? timezone
      const start = localOf(event.startsAt, zone)
      const end = localOf(event.endsAt, zone)
      return {
        allDay: false,
        start: `${start.day}T${start.text}`,
        end: `${end.day}T${end.text}`,
      }
    }
    if (draftAt.hour === null)
      return { allDay: true, start: draftAt.day, end: draftAt.day }
    const hh = String(draftAt.hour).padStart(2, '0')
    const next = String(Math.min(23, draftAt.hour + 1)).padStart(2, '0')
    return {
      allDay: false,
      start: `${draftAt.day}T${hh}:00`,
      end: `${draftAt.day}T${next}:00`,
    }
  })()
  const [title, setTitle] = useState(event?.title ?? '')
  const [allDay, setAllDay] = useState(initial.allDay)
  const [startsAt, setStartsAt] = useState(initial.start)
  const [endsAt, setEndsAt] = useState(initial.end)
  const [projectId, setProjectId] = useState(
    event?.projectId ?? defaultProjectId ?? '',
  )
  const [location, setLocation] = useState(event?.location ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [sync, setSync] = useState(event ? event.sync : googleReady)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  const switchAllDay = (on: boolean) => {
    setAllDay(on)
    if (on) {
      setStartsAt(startsAt.slice(0, 10))
      setEndsAt(endsAt.slice(0, 10))
    } else {
      setStartsAt(`${startsAt.slice(0, 10)}T09:00`)
      setEndsAt(`${endsAt.slice(0, 10)}T10:00`)
    }
  }
  return (
    <>
      <InspectorHead
        title={event ? 'Edit event' : 'New event'}
        meta='not saved yet'
        onClose={onCancel}
      />
      <div className='insp-body'>
        <form
          className='fcard'
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === 'Escape') {
              keyEvent.preventDefault()
              keyEvent.stopPropagation()
              onCancel()
            }
          }}
          onSubmit={(submit) => {
            submit.preventDefault()
            setError(null)
            const form: EventForm = {
              title,
              allDay,
              startsAt,
              endsAt,
              timezone: event?.timezone ?? timezone,
              projectId: projectId || null,
              description,
              location,
              sync,
            }
            start(async () => {
              const result = event
                ? await updateEventAction({
                    ...form,
                    eventId: event.id,
                    expectedRevision: event.revision,
                  })
                : await createEventAction(form)
              if (result.ok) onSaved(result.data, !event)
              else setError(result.error)
            })
          }}
        >
          <label>
            Title
            <input
              ref={first}
              type='text'
              required
              maxLength={200}
              value={title}
              lang={isThai(title) ? 'th' : undefined}
              onChange={(change) => setTitle(change.target.value)}
            />
          </label>
          <div className='row'>
            <button
              type='button'
              className='switch'
              aria-pressed={allDay}
              aria-label='All day'
              onClick={() => switchAllDay(!allDay)}
            />
            <span>All day</span>
          </div>
          <div className='row'>
            <label style={{ flex: 1 }}>
              Starts
              <input
                type={allDay ? 'date' : 'datetime-local'}
                required
                value={startsAt}
                onChange={(change) => setStartsAt(change.target.value)}
              />
            </label>
            <label style={{ flex: 1 }}>
              {allDay ? 'Last day' : 'Ends'}
              <input
                type={allDay ? 'date' : 'datetime-local'}
                value={endsAt}
                onChange={(change) => setEndsAt(change.target.value)}
              />
            </label>
          </div>
          {projects.length > 1 || !defaultProjectId ? (
            <label>
              Project
              <select
                value={projectId}
                onChange={(change) => setProjectId(change.target.value)}
              >
                <option value=''>No project</option>
                {projects.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            Where
            <input
              type='text'
              maxLength={500}
              value={location}
              onChange={(change) => setLocation(change.target.value)}
            />
          </label>
          <label>
            Notes · markdown
            <textarea
              rows={3}
              maxLength={8000}
              value={description}
              onChange={(change) => setDescription(change.target.value)}
            />
          </label>
          <div className='row'>
            <button
              type='button'
              className='switch'
              aria-pressed={sync}
              aria-label='Sync with Google'
              disabled={!googleReady || event?.source === 'google'}
              onClick={() => setSync((on) => !on)}
            />
            <span>
              {event?.source === 'google'
                ? 'From Google — changes go back there'
                : googleReady
                  ? 'Sync with Google'
                  : 'Google isn’t connected — stays in HQ'}
            </span>
          </div>
          {error ? (
            <p className='err' role='alert'>
              {error}
            </p>
          ) : null}
          <div className='row'>
            <button
              type='submit'
              className='btn btn-pri'
              disabled={pending || !title.trim() || !startsAt}
            >
              {pending ? 'Saving…' : event ? 'Save' : 'Add event'}
              <kbd>↵</kbd>
            </button>
            <button type='button' className='btn' onClick={onCancel}>
              Cancel<kbd>Esc</kbd>
            </button>
          </div>
          <p className='hint'>
            Times are read in {event?.timezone ?? timezone}.
          </p>
        </form>
      </div>
    </>
  )
}
