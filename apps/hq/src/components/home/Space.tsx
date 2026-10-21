'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { usePageKeys } from '@/components/bridge/parts'
import { InboxDock, useAnswer } from '@/components/Inbox'
import { usePageKeyHints } from '@/components/shell/keys'
import type { HomeData } from '@/lib/home'
import { Orbit } from './Orbit'
import { Widgets } from './Widgets'

/**
 * Home · Space: widgets | the orbit | Waiting for you. It
 * answers *what is where, and what needs me*. The page owns the keys:
 * `← →` lock a planet (a second click or `↵` opens it), `↑ ↓` move through
 * what waits, the letter printed on a button answers the selected item.
 * At ≤ 900px the dock gives way and the core links to `/inbox`.
 */
export function Space({ data }: { data: HomeData }) {
  const router = useRouter()
  const [locked, setLocked] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(
    data.entries[0]?.id ?? null,
  )
  const answering = useAnswer()
  const entries = data.entries
  const selected =
    entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null
  const docked = () => window.matchMedia('(min-width: 901px)').matches

  const focusItem = (id: string) =>
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`.inbox.dock [data-id="${id}"]`)
        ?.focus({ preventScroll: false }),
    )
  const pick = (id: string) => {
    if (!docked()) {
      router.push(`/inbox?item=${id}`)
      return
    }
    setSelectedId(id)
    focusItem(id)
  }

  usePageKeyHints([
    ...(selected?.answer?.options.map(
      (option) => [option.hotkey, option.label.toLowerCase()] as const,
    ) ?? []),
    ['↵', 'open'],
    ['↑ ↓', 'waiting'],
    ['← →', 'lock planet'],
  ])

  usePageKeys((key) => {
    const projects = data.projects
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && projects.length) {
      const at = projects.findIndex((project) => project.slug === locked)
      const next =
        at < 0
          ? projects[0]
          : projects[
              (at + (key === 'ArrowRight' ? 1 : -1) + projects.length) %
                projects.length
            ]
      if (!next) return false
      setLocked(next.slug)
      const label = document.querySelector<HTMLElement>(
        `[data-planet="${next.slug}"]`,
      )
      if (
        label &&
        document.querySelector('.orbit')?.contains(document.activeElement)
      )
        label.focus({ preventScroll: true })
      return true
    }
    if (
      (key === 'ArrowDown' ||
        key === 'j' ||
        key === 'ArrowUp' ||
        key === 'k') &&
      entries.length
    ) {
      const at = Math.max(
        0,
        entries.findIndex((entry) => entry.id === selected?.id),
      )
      const step = key === 'ArrowDown' || key === 'j' ? 1 : -1
      const next = entries[Math.min(entries.length - 1, Math.max(0, at + step))]
      if (!next) return false
      setSelectedId(next.id)
      focusItem(next.id)
      return true
    }
    if (key === 'Enter') {
      // A focused link or button already does its own thing.
      if (document.activeElement?.closest('a, button')) return false
      if (selected?.link) router.push(selected.link.href)
      else if (selected?.project) router.push(`/p/${selected.project.slug}`)
      else if (locked) router.push(`/p/${locked}`)
      else return false
      return true
    }
    const option = selected?.answer?.options.find(
      (entry) => entry.hotkey === key,
    )
    if (option && selected) {
      answering.answer(selected, option.key)
      return true
    }
    return false
  })

  return (
    <div className='page space'>
      <Widgets data={data} />
      <Orbit
        projects={data.projects}
        entries={entries}
        slots={data.slots}
        week={data.week}
        timezone={data.timezone}
        locked={locked}
        onLock={setLocked}
        onWaiting={pick}
        onCore={(event) => {
          if (!docked() || !selected) return
          event.preventDefault()
          focusItem(selected.id)
        }}
      />
      <InboxDock
        entries={entries}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
        answering={answering}
      />
    </div>
  )
}
