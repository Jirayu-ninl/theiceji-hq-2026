'use client'

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react'
import { setPinned, useInspectorRegistry } from '../shell/inspector'
import { Splitter } from '../shell/Splitter'

/**
 * A page's inspector: the aside beside the
 * page's main pane that holds the selection's properties and actions.
 *
 * - `empty` — nothing picked, no form started. Wide, it is then hidden and
 *   the page takes the full width, unless the owner keeps the inspector open
 *   (`hq.inspector`, the top bar's button, `⇧I`). At ≤ 1100 it is a sheet
 *   that shows only while it holds something.
 * - `onClose` — clear what it holds: the selection and any form. The ✕ on
 *   its head, Esc and the top bar's button use it.
 * - Its start edge drags (`Splitter`); the width is remembered per page as
 *   `insp-<id>`, which the page's CSS reads as `--size-insp-<id>` over its
 *   default `--insp-w`.
 *
 * Pages never pre-select a record for it: an inspector with nothing in it
 * is just not there.
 */

/** What ✕ on an `InspectorHead` does when the head has no close of its own. */
const CloseContext = createContext<(() => void) | null>(null)
export const useInspectorClose = () => useContext(CloseContext)

const MIN = 280
const MAX = 720
/** What the main pane keeps, at least, beside a wide inspector. */
const MAIN_MIN = 360

export function Inspector({
  id,
  label,
  empty,
  onClose,
  className,
  children,
}: {
  /** The page it belongs to; its width is remembered as `insp-<id>`. */
  id: string
  label: string
  empty: boolean
  onClose: () => void
  className?: string
  children: ReactNode
}) {
  const registry = useInspectorRegistry()
  const aside = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    registry?.set({ empty, close: () => close.current() })
  }, [registry, empty])
  useEffect(() => () => registry?.set(null), [registry])

  // Holding something, ✕ clears it; holding nothing (kept open), ✕ hides it.
  const headClose = useCallback(
    () => (empty ? setPinned(false) : close.current()),
    [empty],
  )
  const measure = useCallback(
    () => aside.current?.getBoundingClientRect().width ?? MIN,
    [],
  )
  const max = useCallback(() => {
    const page = aside.current?.parentElement?.getBoundingClientRect().width
    return Math.max(MIN, Math.min(MAX, (page ?? MAX + MAIN_MIN) - MAIN_MIN))
  }, [])

  return (
    <CloseContext.Provider value={headClose}>
      <aside
        ref={aside}
        className={`pane inspector${className ? ` ${className}` : ''}`}
        aria-label={label}
        data-empty={empty ? '' : undefined}
      >
        <Splitter
          id={`insp-${id}`}
          label='Resize the inspector'
          edge='start'
          measure={measure}
          min={MIN}
          max={max}
        />
        {children}
      </aside>
    </CloseContext.Provider>
  )
}
