'use client'

import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useRef,
  useState,
} from 'react'
import { applySize, readSizes, writeSize } from '@/lib/prefs'

/**
 * A pane edge you drag: the rail's end edge, an
 * inspector's start edge, the console's top edge, a list pane's end edge.
 * Dragging moves the edge; the size shows at once as `--size-<id>` on
 * `<html>` and is remembered when you let go (`hq.sizes`), so a reload
 * opens at the same size before first paint. A double click, or ↵ on the
 * focused edge, puts the pane back at its default. The keyboard path is the
 * arrows (16px, ⇧ 64px) and Home / End for the smallest and largest size.
 *
 * It is a plain SaaS part: no ornament, a neutral line on hover and while
 * dragging — amber stays for "you are here".
 */

type Edge = 'start' | 'end' | 'top'

export function Splitter({
  id,
  label,
  edge,
  measure,
  min,
  max,
  onSize,
}: {
  /** The size it keeps: `--size-<id>` on `<html>`, remembered in `hq.sizes`. */
  id: string
  /** What it resizes, in words: "Resize the inspector". */
  label: string
  /** The pane edge it sits on; moving that edge outward grows the pane. */
  edge: Edge
  /** The pane's size now, in px (its width, or its height for `top`). */
  measure: () => number
  min: number
  /** The largest size the stage allows right now. */
  max: () => number
  /**
   * Instead of the plain size — the rail snaps to narrow. Show `px` and
   * return what to remember (`done`): a size, `null` to forget it, or
   * `undefined` to keep what is stored. `px` is `null` when the owner asked
   * for the default back; `key` says it came from the keyboard, one step.
   */
  onSize?: (
    px: number | null,
    done: boolean,
    key?: boolean,
  ) => number | null | undefined
}) {
  const axis = edge === 'top' ? 'y' : 'x'
  const [now, setNow] = useState<number | null>(null)
  const drag = useRef<{
    pointer: number
    from: number
    start: number
    size: number
  } | null>(null)
  const [dragging, setDragging] = useState(false)

  const clamp = useCallback(
    (px: number) => Math.round(Math.min(Math.max(px, min), max())),
    [min, max],
  )

  /** Show a size; `done` remembers it. */
  const show = useCallback(
    (px: number | null, done: boolean, key = false) => {
      if (onSize) {
        const kept = onSize(px, done, key)
        if (done && kept !== undefined) writeSize(id, kept)
      } else if (px === null) {
        if (done) writeSize(id, null)
        else applySize(id, null)
      } else if (done) writeSize(id, px)
      else applySize(id, px)
      setNow(px === null ? null : px)
    },
    [id, onSize],
  )

  const grow = (delta: number) => (edge === 'end' ? delta : -delta)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const start = measure()
    drag.current = {
      pointer: event.pointerId,
      from: axis === 'x' ? event.clientX : event.clientY,
      start,
      size: start,
    }
    setDragging(true)
    document.documentElement.dataset.resizing = axis
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointer !== event.pointerId) return
    const at = axis === 'x' ? event.clientX : event.clientY
    // The rail snaps below its smallest wide size, so it sees the raw size.
    const raw = state.start + grow(at - state.from)
    state.size = onSize ? Math.round(raw) : clamp(raw)
    show(state.size, false)
  }

  const finish = () => {
    const state = drag.current
    if (!state) return
    drag.current = null
    setDragging(false)
    delete document.documentElement.dataset.resizing
    if (state.size !== state.start) show(state.size, true)
  }

  const reset = () => show(null, true)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16
    const keys: Record<string, (() => number) | undefined> = {
      ArrowLeft: axis === 'x' ? () => grow(-step) : undefined,
      ArrowRight: axis === 'x' ? () => grow(step) : undefined,
      ArrowUp: axis === 'y' ? () => grow(-step) : undefined,
      ArrowDown: axis === 'y' ? () => grow(step) : undefined,
    }
    let next: number | null | undefined
    if (keys[event.key]) next = clamp(measure() + (keys[event.key]?.() ?? 0))
    else if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max()
    else if (event.key === 'Enter') next = null
    else return
    // The page's own arrows (select a record) must not run as well.
    event.preventDefault()
    event.stopPropagation()
    show(next, true, true)
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable pane edge is a separator widget; <hr> can't take focus or pointer drags
    <div
      className={`splitter at-${edge}`}
      role='separator'
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={now === null ? undefined : Math.max(min, max())}
      aria-valuenow={now ?? undefined}
      tabIndex={0}
      title={`${label} — drag, or double-click for the default`}
      data-dragging={dragging ? '' : undefined}
      data-size={id}
      onFocus={() => setNow(Math.round(measure()))}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  )
}

/** The size remembered for a pane, if it was ever dragged. */
export const storedSize = (id: string): number | null => readSizes()[id] ?? null
