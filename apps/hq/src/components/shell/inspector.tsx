'use client'

import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { writePref } from '@/lib/prefs'

/**
 * The inspector's place in the shell. A page's
 * inspector (`components/bridge/Inspector.tsx`) tells the shell whether it
 * holds anything and how to clear it; the shell owns what is HQ-wide about
 * it — the top bar's show/hide button, `⇧I`, Esc — and the one preference,
 * `hq.inspector` on `<html>`:
 *
 * - `hidden` (the default): the inspector is on screen only while it holds
 *   something — a record you picked, a form you started. Nothing picked, the
 *   page has the full width.
 * - `open`: it stays on screen with nothing picked too, showing the page's
 *   "nothing selected" line.
 *
 * Showing and hiding is CSS (`data-inspector` × the aside's `data-empty`),
 * so the first paint is already right.
 */

const CHANGED = 'hq:inspector'

/** Whether the inspector stays open with nothing picked (`hq.inspector: open`). */
export const isPinned = () =>
  typeof document !== 'undefined' &&
  document.documentElement.dataset.inspector === 'open'

export function setPinned(open: boolean): void {
  document.documentElement.dataset.inspector = open ? 'open' : 'hidden'
  writePref('hq.inspector', open ? 'open' : 'hidden')
  window.dispatchEvent(new Event(CHANGED))
}

/** Tell subscribers `<html>` changed under them (another tab's prefs). */
export const announcePinned = () => window.dispatchEvent(new Event(CHANGED))

const subscribe = (notify: () => void) => {
  window.addEventListener(CHANGED, notify)
  return () => window.removeEventListener(CHANGED, notify)
}

export function usePinned(): boolean {
  return useSyncExternalStore(subscribe, isPinned, () => false)
}

type Held = {
  /** Nothing to show: no record picked, no form started. */
  empty: boolean
  /** Clear what it holds — the selection and any form. */
  close: () => void
}

type Registry = { set: (held: Held | null) => void }

const RegistryContext = createContext<Registry | null>(null)

export const useInspectorRegistry = () => useContext(RegistryContext)

export type InspectorControl = {
  /** The page on screen has an inspector. */
  present: boolean
  /** It is on screen (wide): kept open, or holding something. */
  shown: boolean
  /** The top bar's button and `⇧I`: hide it (clearing what it holds), or keep it open. */
  toggle: () => void
  /** Esc with nothing of the page's own to close: the record goes, never the preference. */
  escape: () => boolean
}

/**
 * The shell's side: the one inspector on screen registers here, and the
 * shell reads whether it is there, whether it shows, and the toggle. Hiding
 * clears what it holds, so a hidden inspector never keeps a selection the
 * page's keys would still act on.
 */
export function useInspectorHost(): {
  registry: Registry
  control: InspectorControl
} {
  const held = useRef<Held | null>(null)
  const [state, setState] = useState({ present: false, empty: true })
  const pinned = usePinned()
  const registry = useMemo<Registry>(
    () => ({
      set(next) {
        held.current = next
        const present = next !== null
        const empty = next?.empty ?? true
        setState((before) =>
          before.present === present && before.empty === empty
            ? before
            : { present, empty },
        )
      },
    }),
    [],
  )
  const { present, empty } = state
  const shown = present && (pinned || !empty)
  const control = useMemo<InspectorControl>(
    () => ({
      present,
      shown,
      toggle() {
        if (!present) return
        if (shown) {
          if (!empty) held.current?.close()
          setPinned(false)
        } else setPinned(true)
      },
      escape() {
        if (!present || empty) return false
        held.current?.close()
        return true
      },
    }),
    [present, shown, empty],
  )
  return { registry, control }
}

export function InspectorProvider({
  registry,
  children,
}: {
  registry: Registry
  children: ReactNode
}) {
  return (
    <RegistryContext.Provider value={registry}>
      {children}
    </RegistryContext.Provider>
  )
}
