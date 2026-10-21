'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { usePageKeys } from '@/components/bridge/parts'
import { useAnswer } from '@/components/Inbox'
import { type KeyHint, usePageKeyHints } from '@/components/shell/keys'
import { Arrange, weekHref } from './time/Arrange'
import type { TimeData, TimeGroup, TimelineItem } from './time/model'
import { Money, Selected, Waiting } from './time/Rack'
import './time.css'

/**
 * Home · Time: *when things happen, what is moving, and
 * what is late*. The week as an arrangement — a ruler with the playhead at
 * now, one group of tracks per project — over a rack of Waiting for you,
 * Money · 7 days and the selection.
 *
 * Keys: `← →` along a row, `↑ ↓` across rows (in Waiting, through the
 * queue), `↵` opens the item's page, `[` `]` change the week and `t` returns
 * to this one, Esc lets go. A letter printed on a button answers the
 * selected item's waiting request. Selecting on the timeline selects its
 * request in Waiting, and the other way round.
 */
export function Time({ data }: { data: TimeData }) {
  const router = useRouter()
  const [moving, start] = useTransition()
  // Folding is the owner's view of the tracks, so it outlives a week change.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const fold = (slug: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  const go = (week: string | null) =>
    start(() => router.push(weekHref(week), { scroll: false }))
  // A new week starts its selection over: the first thing that waits on it.
  return (
    <Week
      key={data.week.key}
      data={data}
      moving={moving}
      go={go}
      collapsed={collapsed}
      onFold={fold}
    />
  )
}

function Week({
  data,
  moving,
  go,
  collapsed,
  onFold,
}: {
  data: TimeData
  moving: boolean
  go: (week: string | null) => void
  collapsed: ReadonlySet<string>
  onFold: (slug: string) => void
}) {
  const router = useRouter()
  const answering = useAnswer()
  const { entries } = data

  const index = useMemo(() => {
    const items = new Map<string, { item: TimelineItem; group: TimeGroup }>()
    for (const group of data.groups)
      for (const lane of group.lanes)
        for (const item of lane.items) items.set(item.id, { item, group })
    return items
  }, [data.groups])
  const itemFor = (waitingId: string) =>
    [...index.values()].find(
      ({ item }) => item.waitingId === waitingId && item.state === 'wait',
    )?.item ?? null

  const [selId, setSelId] = useState<string | null>(() =>
    entries[0] ? (itemFor(entries[0].id)?.id ?? null) : null,
  )
  const [waitId, setWaitId] = useState<string | null>(entries[0]?.id ?? null)

  const picked = selId ? (index.get(selId) ?? null) : null
  const linked = picked?.item.waitingId
    ? (entries.find((entry) => entry.id === picked.item.waitingId) ?? null)
    : null
  const waiting =
    entries.find((entry) => entry.id === waitId) ?? entries[0] ?? null

  /** Rows in reading order: every lane of every open group, items by start. */
  const rows = useMemo(
    () =>
      data.groups.flatMap((group) =>
        collapsed.has(group.project.slug)
          ? []
          : group.lanes
              .filter((lane) => lane.items.length)
              .map((lane) => [...lane.items].sort((a, b) => a.from - b.from)),
      ),
    [data.groups, collapsed],
  )
  const tabStop =
    picked && !collapsed.has(picked.group.project.slug)
      ? picked.item.id
      : (rows[0]?.[0]?.id ?? null)

  const reveal = (id: string, focus: boolean) => {
    const element = document.querySelector<HTMLElement>(
      `.tl-tracks [data-id="${CSS.escape(id)}"]`,
    )
    if (!element) return
    if (focus) element.focus({ preventScroll: true })
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  const select = (id: string | null, focus = false) => {
    setSelId(id)
    const item = id ? index.get(id)?.item : null
    if (item?.waitingId && entries.some((entry) => entry.id === item.waitingId))
      setWaitId(item.waitingId)
    if (id) reveal(id, focus)
  }
  const selectWaiting = (id: string, focus = false) => {
    setWaitId(id)
    const item = itemFor(id)
    if (item) {
      setSelId(item.id)
      reveal(item.id, false)
    }
    if (focus)
      document
        .querySelector<HTMLElement>(`.tl-waiting [data-id="${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: false })
  }
  const inWaiting = () =>
    Boolean(document.activeElement?.closest('.tl-waiting'))
  const nav: KeyHint[] = [
    ['← →', 'items'],
    ['↑ ↓', 'tracks'],
    ['↵', 'open'],
    ['[ ]', 'week'],
    ['t', 'today'],
  ]
  usePageKeyHints([
    ...(linked?.answer?.options.map(
      (option) => [option.hotkey, option.label.toLowerCase()] as const,
    ) ?? []),
    ...nav.filter(
      ([key]) =>
        !linked?.answer?.options.some((option) => option.hotkey === key),
    ),
  ])

  usePageKeys((key) => {
    // A letter printed on a button wins over the page's own letters.
    const answerTo = inWaiting() ? waiting : linked
    const option = answerTo?.answer?.options.find(
      (entry) => entry.hotkey === key,
    )
    if (option && answerTo) {
      answering.answer(answerTo, option.key)
      return true
    }
    if (key === '[' || key === ']') {
      go(key === '[' ? data.week.prev : data.week.next)
      return true
    }
    if (key === 't') {
      if (data.week.current) {
        document.querySelector('.tl-playhead')?.scrollIntoView({
          block: 'nearest',
        })
        return true
      }
      go(null)
      return true
    }

    // In Waiting, ↑ ↓ walk the queue and ↵ opens where the item is decided.
    if (inWaiting() && entries.length) {
      const at = Math.max(
        0,
        entries.findIndex((entry) => entry.id === waiting?.id),
      )
      if (
        key === 'ArrowDown' ||
        key === 'j' ||
        key === 'ArrowUp' ||
        key === 'k'
      ) {
        const step = key === 'ArrowDown' || key === 'j' ? 1 : -1
        const next =
          entries[Math.min(entries.length - 1, Math.max(0, at + step))]
        if (next) selectWaiting(next.id, true)
        return true
      }
      if (key === 'Enter' && waiting) {
        if (document.activeElement?.closest('a, button')) return false
        const item = itemFor(waiting.id)
        const href =
          waiting.link?.href ??
          item?.href ??
          (waiting.project ? `/p/${waiting.project.slug}` : null)
        if (!href) return false
        router.push(href)
        return true
      }
    }

    let row = -1
    let col = -1
    rows.forEach((items, r) => {
      const c = items.findIndex((item) => item.id === selId)
      if (c >= 0) {
        row = r
        col = c
      }
    })
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      if (!rows.length) return false
      const items = rows[row]
      if (row < 0 || !items) {
        select(rows[0]?.[0]?.id ?? null, true)
        return true
      }
      const next =
        items[
          key === 'ArrowRight'
            ? Math.min(items.length - 1, col + 1)
            : Math.max(0, col - 1)
        ]
      select(next?.id ?? null, true)
      return true
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (!rows.length) return false
      const items = rows[row]
      const current = items?.[col]
      if (row < 0 || !current) {
        select(rows[0]?.[0]?.id ?? null, true)
        return true
      }
      const target =
        rows[
          key === 'ArrowDown'
            ? Math.min(rows.length - 1, row + 1)
            : Math.max(0, row - 1)
        ] ?? []
      const nearest = target.reduce<TimelineItem | null>(
        (best, item) =>
          !best ||
          Math.abs(item.from - current.from) <
            Math.abs(best.from - current.from)
            ? item
            : best,
        null,
      )
      if (nearest) select(nearest.id, true)
      return true
    }
    if (key === 'Enter') {
      if (!picked) return false
      const focused = document.activeElement
      if (focused?.closest('a, button') && !focused.closest('.tl-lane'))
        return false
      router.push(picked.item.href)
      return true
    }
    if (key === 'Escape') {
      if (!selId) return false
      setSelId(null)
      return true
    }
    return false
  })

  return (
    <div className='page time' aria-busy={moving || undefined}>
      <Arrange
        data={data}
        selected={picked?.item.id ?? null}
        tabStop={tabStop}
        collapsed={collapsed}
        onSelect={(id) => select(id)}
        onFold={onFold}
      />
      <section className='tl-rack' aria-label='Rack'>
        <Waiting
          entries={entries}
          selectedId={waiting?.id ?? null}
          onSelect={(id) => selectWaiting(id)}
          answering={answering}
        />
        <Money money={data.money} />
        <Selected
          item={picked?.item ?? null}
          group={picked?.group ?? null}
          entry={linked}
          answering={answering}
        />
      </section>
    </div>
  )
}
