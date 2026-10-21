'use client'

import './state.css'
import { MODULES, type ModuleId } from '@theiceji/hq-core/modules'
import { useRouter } from 'next/navigation'
import {
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from 'react'
import {
  setModuleAction,
  setProjectStatusAction,
} from '@/app/(app)/projects/actions'
import { usePageKeys } from '@/components/bridge/parts'
import { useAnswer } from '@/components/Inbox'
import { usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import { readPref, writePref } from '@/lib/prefs'
import type { StateData, StateProject } from '@/lib/state'
import { captureNoteAction, trashNoteAction } from '@/modules/notes/actions'
import { Browser } from './state/Browser'
import { Device, type PaneKind } from './state/Device'
import { Matrix, type Sel } from './state/Matrix'
import { accepts, TARGETS, waitingBehind } from './state/model'
import {
  promoteIntoCellAction,
  setProjectRoutinesAction,
} from './state-actions'

const PHONE = '(max-width: 720px)'
const phone = () => window.matchMedia(PHONE).matches

/**
 * Home · State: *exactly what state every project × module
 * is in*. The notes browser | the matrix with its master column and mixers
 * | the device pane for the selected cell. The page owns the keys:
 * `↑↓←→` move (off slots are skipped), `␣` opens the pane, `↵` opens the
 * page, `s` solos a column, `/` filters, `p` promotes a note (pick the cell
 * with the arrows, `↵` confirms), `⇥` hides the notes, and Esc closes one
 * layer at a time — filter, then promote, then the pane. The letter on a
 * waiting item's button answers it.
 */
export function State({ data }: { data: StateData }) {
  const router = useRouter()
  const toast = useToast()
  const answering = useAnswer()
  const [busy, start] = useTransition()
  const n = data.projects.length
  const rows = data.modules.length

  const [sel, setSel] = useState<Sel>(() => ({
    col: n,
    row: Math.max(
      0,
      data.modules.findIndex((id) => data.master[id].state === 'wait'),
    ),
  }))
  /** `null` until someone opens or closes it: open on a desk, shut on a phone. */
  const [paneOpen, setPaneOpen] = useState<boolean | null>(null)
  const [itemId, setItemId] = useState<string | null>(null)
  const [solo, setSolo] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [noteId, setNoteId] = useState<string | null>(null)
  const [promoting, setPromoting] = useState<string | null>(null)
  const [tab, setTab] = useState<'notes' | 'data'>('notes')
  /** `hq.state.browser`; `null` = the default for this width. */
  const [browser, setBrowser] = useState<'open' | 'closed' | null>(null)
  const [wide, setWide] = useState(true)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const [confirmTick, setConfirmTick] = useState(0)
  const [filterTick, setFilterTick] = useState(0)
  const [itemFocusTick, setItemFocusTick] = useState(0)

  const browserRef = useRef<HTMLElement>(null)
  const deviceRef = useRef<HTMLElement>(null)
  const matrixRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  // The selection survives a refresh that changed how many projects there are.
  const cur: Sel = {
    col: Math.min(sel.col, n),
    row: Math.min(sel.row, rows - 1),
  }
  const project: StateProject | undefined = data.projects[cur.col]
  const module: ModuleId | null =
    cur.row >= 0 ? (data.modules[cur.row] ?? null) : null
  const note = promoting
    ? (data.notes?.find((entry) => entry.id === promoting) ?? null)
    : null
  const kind: PaneKind =
    promoting && note
      ? 'promote'
      : cur.row === -1
        ? project
          ? 'project'
          : 'inbox'
        : 'cell'
  const items =
    kind === 'inbox'
      ? data.entries
      : kind === 'cell' && module
        ? project && !project.enabled.includes(module)
          ? []
          : waitingBehind(data.entries, project, module)
        : []
  const current = items.find((entry) => entry.id === itemId) ?? items[0]
  const paneShown = () => paneOpen === true || (paneOpen === null && !phone())
  const browserShown = browser ? browser === 'open' : wide

  /* ---------- the browser's remembered state ---------- */
  useLayoutEffect(() => {
    const remembered = readPref('hq.state.browser')
    if (remembered) setBrowser(remembered)
    const media = window.matchMedia('(max-width: 1280px)')
    const sync = () => setWide(!media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])
  const toggleBrowser = () => {
    const next = browserShown ? 'closed' : 'open'
    setBrowser(next)
    writePref('hq.state.browser', next)
  }

  /* ---------- focus follows the selection (roving tabindex) ---------- */
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a move asks for focus, reading the selection it made
  useEffect(() => {
    if (!focusTick) return
    const target = matrixRef.current?.querySelector<HTMLElement>(
      `[data-col="${cur.col}"][data-row="${cur.row}"]`,
    )
    if (!target) return
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [focusTick])
  useEffect(() => {
    if (confirmTick) confirmRef.current?.focus()
  }, [confirmTick])
  // Effects, not timers or animation frames: a background tab throttles
  // both, and the focus must still land right after the render.
  useEffect(() => {
    if (!filterTick) return
    filterRef.current?.focus()
    filterRef.current?.select()
  }, [filterTick])
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when ↑ ↓ in the pane asks for focus, reading the item it picked
  useEffect(() => {
    if (!itemFocusTick || !current) return
    deviceRef.current
      ?.querySelector<HTMLElement>(`.item[data-id="${current.id}"]`)
      ?.focus()
  }, [itemFocusTick])

  // On a phone the chip row follows the project the list shows.
  useEffect(() => {
    if (!window.matchMedia(PHONE).matches) return
    const chip = document.querySelector(
      `.state .tracks [data-track="${cur.col}"]`,
    )
    chip?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [cur.col])

  // A promoted or vanished note ends the promote step.
  useEffect(() => {
    if (
      promoting &&
      !data.notes?.some((entry) => entry.id === promoting && !entry.promoted)
    )
      setPromoting(null)
  }, [data.notes, promoting])

  /* ---------- the edges of a sideways-scrolled matrix ---------- */
  const edges = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.dataset.left = el.scrollLeft > 0 ? '1' : '0'
    el.dataset.right =
      el.scrollLeft + el.clientWidth < el.scrollWidth - 1 ? '1' : '0'
  }, [])
  useEffect(() => {
    edges()
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(edges)
    observer.observe(el)
    return () => observer.disconnect()
  }, [edges])

  /* ---------- a phone: swipe across the list changes project ---------- */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let from: { x: number; y: number } | null = null
    const down = (event: TouchEvent) => {
      const touch = event.changedTouches[0]
      from = touch ? { x: touch.clientX, y: touch.clientY } : null
    }
    const up = (event: TouchEvent) => {
      const touch = event.changedTouches[0]
      if (!from || !touch || !phone()) return
      const dx = touch.clientX - from.x
      const dy = touch.clientY - from.y
      from = null
      if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.5)
        setSel((at) => ({
          col: (Math.min(at.col, n) + (dx < 0 ? 1 : -1) + n + 1) % (n + 1),
          row: Math.max(0, at.row),
        }))
    }
    el.addEventListener('touchstart', down, { passive: true })
    el.addEventListener('touchend', up, { passive: true })
    return () => {
      el.removeEventListener('touchstart', down)
      el.removeEventListener('touchend', up)
    }
  }, [n])

  /* ---------- moving ---------- */
  const select = (col: number, row: number, focus = true) => {
    setSel({ col, row })
    setItemId(null)
    setError(null)
    if (focus) setFocusTick((tick) => tick + 1)
  }
  const move = (dc: number, dr: number) => {
    let { col, row } = cur
    const top = phone() || promoting ? 0 : -1
    for (let step = 0; step < 16; step++) {
      col += dc
      row += dr
      if (col < 0 || col > n || row < top || row >= rows) return
      const id = data.modules[row]
      if (
        row === -1 ||
        col === n ||
        promoting ||
        (id && data.projects[col]?.enabled.includes(id))
      ) {
        select(col, row)
        return
      }
    }
  }
  const focusCell = () => setFocusTick((tick) => tick + 1)

  const openPage = () => {
    if (cur.row === -1) {
      router.push(project ? `/p/${project.slug}` : '/inbox')
      return
    }
    if (!module) return
    if (project) router.push(`/p/${project.slug}/${module}`)
    else if (data.routes[module]) router.push(data.routes[module])
    else
      toast(
        `${MODULES[module].label} has a page in each project — pick a project’s column.`,
      )
  }

  /* ---------- filter ---------- */
  const openFilter = () => {
    setFilterOpen(true)
    setFilterTick((tick) => tick + 1)
  }
  const closeFilter = () => {
    setFilter('')
    setFilterOpen(false)
    focusCell()
  }

  /* ---------- actions (each ends in a toast, with Undo where there is an inverse) ---------- */
  const failed = (message: string) => {
    setError(message)
    toast(message)
  }
  const toggleActive = (target: StateProject) => {
    const status = target.status === 'active' ? 'paused' : 'active'
    start(async () => {
      const result = await setProjectStatusAction({
        projectId: target.id,
        expectedRevision: target.revision,
        status,
      })
      if (!result.ok) return failed(result.error)
      setError(null)
      toast(`${target.name} ${status === 'paused' ? 'paused' : 'resumed'}`, {
        undo: async () => {
          const back = await setProjectStatusAction({
            projectId: target.id,
            expectedRevision: result.data.revision,
            status: target.status,
          })
          if (!back.ok) toast(back.error)
        },
      })
    })
  }
  const toggleArm = (target: StateProject) => {
    const on = !((target.routines?.on ?? 0) > 0)
    start(async () => {
      const result = await setProjectRoutinesAction({
        projectId: target.id,
        on,
      })
      if (!result.ok) return failed(result.error)
      setError(null)
      const { changed, skipped } = result.data
      toast(
        `Routines ${on ? 'armed' : 'paused'} for ${target.name}${skipped.length ? ` — ${skipped.join(' ')}` : ''}`,
        changed.length
          ? {
              undo: async () => {
                const back = await setProjectRoutinesAction({
                  projectId: target.id,
                  on: !on,
                  routineIds: changed,
                })
                if (!back.ok) toast(back.error)
              },
            }
          : undefined,
      )
    })
  }
  const enable = (target: StateProject, id: ModuleId) => {
    start(async () => {
      const result = await setModuleAction({
        projectId: target.id,
        expectedRevision: target.revision,
        module: id,
        on: true,
      })
      if (!result.ok) return failed(result.error)
      setError(null)
      toast(`${MODULES[id].label} enabled for ${target.name}`, {
        undo: async () => {
          const back = await setModuleAction({
            projectId: target.id,
            expectedRevision: result.data.revision,
            module: id,
            on: false,
          })
          if (!back.ok) toast(back.error)
        },
      })
    })
  }
  const capture = async (body: string) => {
    const filedUnder = project ?? null
    const result = await captureNoteAction({
      body,
      projectId: filedUnder?.id ?? null,
    })
    if (!result.ok) {
      toast(result.error)
      return false
    }
    setNoteId(result.data.id)
    toast(
      `Parked${filedUnder ? ` under ${filedUnder.name}` : ''}: ${body.slice(0, 40)}`,
      {
        undo: async () => {
          const back = await trashNoteAction({
            noteId: result.data.id,
            deleted: true,
          })
          if (!back.ok) toast(back.error)
        },
      },
    )
    return true
  }

  /* ---------- promote: a note into a cell, through one confirm step ---------- */
  const startPromote = (id?: string) => {
    const notes = data.notes ?? []
    const picked =
      notes.find((entry) => entry.id === (id ?? noteId)) ??
      notes.find((entry) => !entry.promoted)
    if (!picked) return toast('Capture a note first.')
    if (picked.promoted)
      return toast('That note is already promoted — pick another.')
    if (!n) return toast('Make a project first — notes go into a project.')
    setNoteId(picked.id)
    setPromoting(picked.id)
    setPaneOpen(true)
    select(cur.col >= n ? 0 : cur.col, Math.max(0, cur.row))
  }
  const cancelPromote = () => {
    setPromoting(null)
    setError(null)
    focusCell()
  }
  const confirmPromote = () => {
    if (!note || !module) return
    if (!project || !accepts(project, module))
      return toast(
        'This cell doesn’t take notes — move to Board, Prompts, Story (film) or Calendar.',
      )
    const target = TARGETS[module] ?? 'record'
    start(async () => {
      const result = await promoteIntoCellAction({
        noteId: note.id,
        projectId: project.id,
        module,
      })
      if (!result.ok) return failed(result.error)
      setPromoting(null)
      setError(null)
      toast(
        `${target[0]?.toUpperCase()}${target.slice(1)} created in ${project.name} › ${MODULES[module].label}${result.data.enabled ? `, with ${MODULES[module].label} turned on` : ''}. The note stays in Notes.`,
      )
      focusCell()
    })
  }

  /* ---------- drag a note onto a cell: the same confirm step ---------- */
  const dragOver = (col: number, row: number, event: DragEvent) => {
    if (!dragging) return
    const id = data.modules[row]
    if (!id || !accepts(data.projects[col], id)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropAt(`${col}:${row}`)
  }
  const drop = (col: number, row: number, event: DragEvent) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain') || dragging
    setDragging(null)
    setDropAt(null)
    const dropped = data.notes?.find((entry) => entry.id === id)
    const target = data.modules[row]
    if (!dropped || dropped.promoted || !target) return
    if (!accepts(data.projects[col], target))
      return toast(
        'This cell doesn’t take notes — drop on Board, Prompts, Story (film) or Calendar.',
      )
    setNoteId(dropped.id)
    setPromoting(dropped.id)
    setPaneOpen(true)
    select(col, row, false)
    setConfirmTick((tick) => tick + 1)
  }

  /* ---------- keys ---------- */
  usePageKeys((key, event) => {
    const active = document.activeElement as HTMLElement | null
    const inBrowser = Boolean(active && browserRef.current?.contains(active))
    const inDevice = Boolean(active && deviceRef.current?.contains(active))
    const onCell = Boolean(active?.closest?.('[data-col][data-row]'))
    const shown = paneShown()

    if (key === 'Escape') {
      if (filterOpen) {
        closeFilter()
        return true
      }
      if (promoting) {
        cancelPromote()
        return true
      }
      if (shown) {
        setPaneOpen(false)
        focusCell()
        return true
      }
      return false
    }
    if (key === 'Tab') {
      // Only from the grid itself: the first Tab into the page still
      // reaches the skip link and the rail.
      if (event.shiftKey || !onCell) return false
      toggleBrowser()
      return true
    }
    if (key === '/') {
      openFilter()
      return true
    }
    // Up and down walk the list while the focus is in the pane.
    const printed = current?.answer?.options.some(
      (entry) => entry.hotkey === key,
    )
    if (
      inDevice &&
      items.length > 1 &&
      (key === 'ArrowDown' ||
        key === 'ArrowUp' ||
        ((key === 'j' || key === 'k') && !printed))
    ) {
      const at = Math.max(
        0,
        items.findIndex((entry) => entry.id === current?.id),
      )
      const step = key === 'ArrowDown' || key === 'j' ? 1 : -1
      const next = items[Math.min(items.length - 1, Math.max(0, at + step))]
      if (next) {
        setItemId(next.id)
        setItemFocusTick((tick) => tick + 1)
      }
      return true
    }
    // The letter printed on a waiting item's button answers it — before
    // the page's own letters, so every printed key works.
    const option =
      shown && !promoting && !inBrowser
        ? current?.answer?.options.find((entry) => entry.hotkey === key)
        : undefined
    if (option && current) {
      answering.answer(current, option.key)
      return true
    }
    if (key === 'p') {
      startPromote()
      return true
    }
    if (inBrowser) {
      if (key !== 'ArrowDown' && key !== 'ArrowUp') return false
      const notes = data.notes ?? []
      if (!notes.length) return true
      const at = Math.max(
        0,
        notes.findIndex((entry) => entry.id === noteId),
      )
      const next =
        notes[
          Math.max(
            0,
            Math.min(notes.length - 1, at + (key === 'ArrowDown' ? 1 : -1)),
          )
        ]
      if (next) {
        setNoteId(next.id)
        browserRef.current
          ?.querySelector<HTMLElement>(`[data-note="${next.id}"]`)
          ?.focus()
      }
      return true
    }
    // A focused button or link that isn't a cell does its own thing.
    if (
      (key === 'Enter' || key === ' ') &&
      !onCell &&
      active?.closest?.('a, button, [role="option"]')
    )
      return false
    if (key === 'Enter') {
      if (promoting) confirmPromote()
      else openPage()
      return true
    }
    if (key === 's') {
      if (project) setSolo((at) => (at === project.id ? null : project.id))
      return true
    }
    if (key === 'ArrowRight') {
      move(1, 0)
      return true
    }
    if (key === 'ArrowLeft') {
      move(-1, 0)
      return true
    }
    if (key === 'ArrowDown') {
      move(0, 1)
      return true
    }
    if (key === 'ArrowUp') {
      move(0, -1)
      return true
    }
    if (key === ' ') {
      if (shown && !promoting) setPaneOpen(false)
      else setPaneOpen(true)
      return true
    }
    return false
  })

  usePageKeyHints(
    promoting
      ? [
          ['↵', 'create'],
          ['Esc', 'cancel'],
          ['↑↓←→', 'pick a cell'],
        ]
      : [
          ...(paneOpen !== false
            ? (current?.answer?.options.map(
                (option) =>
                  [option.hotkey, option.label.toLowerCase()] as const,
              ) ?? [])
            : []),
          ['↑↓←→', 'move'],
          ['␣', 'inspect'],
          ['↵', 'open page'],
          ['s', 'solo'],
          ['p', 'promote note'],
          ['/', 'filter'],
          ['⇥', 'notes'],
          ['Esc', 'close'],
        ],
  )

  return (
    <div className='page state' data-browser={browser ?? undefined}>
      <Browser
        data={data}
        browserRef={browserRef}
        tab={tab}
        onTab={setTab}
        selected={noteId}
        onSelect={setNoteId}
        filedUnder={project ?? null}
        onCapture={capture}
        onPromote={() => startPromote()}
        onClose={toggleBrowser}
        onDragStart={(id) => {
          setDragging(id)
          setNoteId(id)
        }}
        onDragEnd={() => {
          setDragging(null)
          setDropAt(null)
        }}
        busy={busy}
      />
      <Matrix
        data={data}
        sel={cur}
        solo={solo}
        filter={filter}
        filterOpen={filterOpen}
        promoting={Boolean(promoting)}
        dragging={Boolean(dragging)}
        dropAt={dropAt}
        browserShown={browserShown}
        busy={busy}
        matrixRef={matrixRef}
        scrollRef={scrollRef}
        filterRef={filterRef}
        onCell={(col, row) => {
          if (!promoting) setPaneOpen(true)
          select(col, row)
        }}
        onHead={(col) => {
          setPromoting(null)
          setPaneOpen(true)
          select(col, -1)
        }}
        onTrack={(col) => select(col, Math.max(0, cur.row), false)}
        onSolo={(target) =>
          setSolo((at) => (at === target.id ? null : target.id))
        }
        onArm={toggleArm}
        onActive={toggleActive}
        onToggleBrowser={toggleBrowser}
        onDragOver={dragOver}
        onDragLeave={(col, row) =>
          setDropAt((at) => (at === `${col}:${row}` ? null : at))
        }
        onDrop={drop}
        onFilter={setFilter}
        onFilterKey={(key) => {
          if (key === 'Escape') closeFilter()
          else focusCell()
        }}
        onFilterClose={closeFilter}
        onScroll={edges}
      />
      {paneOpen !== false ? (
        <Device
          data={data}
          sel={cur}
          kind={kind}
          deviceRef={deviceRef}
          byDefault={paneOpen === null}
          items={items}
          itemId={current?.id ?? null}
          onItem={setItemId}
          answering={answering}
          note={note}
          busy={busy}
          error={error}
          confirmRef={confirmRef}
          onClose={() => {
            if (promoting) setPromoting(null)
            setPaneOpen(false)
            focusCell()
          }}
          onEnable={enable}
          onConfirm={confirmPromote}
          onCancel={cancelPromote}
          onActive={toggleActive}
          onArm={toggleArm}
        />
      ) : null}
    </div>
  )
}
