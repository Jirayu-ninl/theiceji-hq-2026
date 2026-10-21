'use client'

import { usePathname, useRouter } from 'next/navigation'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { applyPrefs, writePref } from '@/lib/prefs'
import type { ShellData } from '@/lib/shell'
import { Console, type ConsoleTab } from '../Console'
import { projectSlugAt, viewsFor } from '../navigation'
import { ToastProvider } from '../Toast'
import { BottomBar } from './BottomBar'
import { Foot } from './Foot'
import {
  announcePinned,
  InspectorProvider,
  useInspectorHost,
} from './inspector'
import { PageKeysProvider } from './keys'
import { AccountMenu, MoreSheet, ProjectMenu, ShortcutsMenu } from './Menus'
import { Rail } from './Rail'
import { TopBar } from './TopBar'

export type ShellUser = {
  email: string
  name: string | null
  image: string | null
}

/**
 * The Bridge frame: top bar, rail, stage, footer —
 * permanent, 100dvh, and only panes scroll. Everything HQ-wide lives here:
 * the project switcher (⌘P), the prompt and palette (⌘K), the rail toggles
 * (\ and ⇧\), the inspector's show/hide (⇧I, and Esc to close what it
 * holds), the console (⌃`), quick note capture (n, which starts
 * `note "…"` in the footer prompt) and the inbox key
 * (i). Keys are ignored while typing, under a modifier, or over an open
 * dialog.
 *
 * The layout renders this once and never again on client navigation, so
 * anything that depends on where you are is read from the pathname here, not
 * passed down from the server.
 */
export function Shell({
  user,
  data,
  children,
}: {
  user: ShellUser
  data: ShellData
  children: ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const prompt = useRef<HTMLInputElement>(null)
  // Each `n` bumps this; the footer prompt starts a `note "…"` capture.
  const [captureNonce, setCaptureNonce] = useState(0)
  // Not a preference: the console starts closed on every load.
  const [consoleState, setConsole] = useState<{
    open: boolean
    tab: ConsoleTab
    focus: number
  }>({ open: false, tab: 'log', focus: 0 })
  const slug = projectSlugAt(pathname)
  const project = slug
    ? (data.projects.find((entry) => entry.slug === slug) ?? null)
    : null
  const views = viewsFor(pathname)
  const inspector = useInspectorHost()
  const inspectorControl = inspector.control

  const toggleRail = useCallback((width: boolean) => {
    const root = document.documentElement
    if (width) {
      const next = root.dataset.railWidth === 'narrow' ? 'wide' : 'narrow'
      root.dataset.railWidth = next
      writePref('hq.rail.width', next)
      if (root.dataset.rail === 'hidden') {
        root.dataset.rail = 'open'
        writePref('hq.rail', 'open')
      }
      return
    }
    const next = root.dataset.rail === 'hidden' ? 'open' : 'hidden'
    root.dataset.rail = next
    writePref('hq.rail', next)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: close transient layers on every route change
  useEffect(() => {
    for (const open of document.querySelectorAll<HTMLElement>(':popover-open'))
      open.hidePopover()
  }, [pathname])

  useEffect(() => {
    // Keep the attributes in step if another tab changed the prefs.
    const sync = (event: StorageEvent) => {
      if (!event.key?.startsWith('hq.')) return
      applyPrefs()
      announcePinned()
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      if (mod && key === 'k') {
        event.preventDefault()
        prompt.current?.focus()
        return
      }
      if (mod && key === 'p') {
        event.preventDefault()
        document.getElementById('project-menu')?.togglePopover()
        return
      }
      const target = event.target as HTMLElement | null
      const busy =
        target?.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '') ||
        document.querySelector('dialog[open]')
      // ⌃` by the key's place, so it works on a Thai layout too.
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.code === 'Backquote' || event.key === '`')
      ) {
        if (busy) return
        event.preventDefault()
        setConsole((state) =>
          state.open
            ? { ...state, open: false }
            : { ...state, open: true, focus: state.focus + 1 },
        )
        return
      }
      if (mod || event.altKey) return
      if (busy) return
      // Esc that closes a popover belongs to the popover.
      const overlay = Boolean(document.querySelector(':popover-open'))
      if (event.key === '\\' || event.key === '|') {
        event.preventDefault()
        toggleRail(event.shiftKey)
        return
      }
      // A page's own key wins over the shell's letters and digits (`n` is New
      // prompt on Prompts; an answer's key may be a digit). Page listeners
      // re-register on every render, so they may run before or after this
      // one: decide once every listener has seen the key.
      setTimeout(() => {
        if (!event.defaultPrevented) single(event, key, overlay)
      })
    }
    const single = (event: KeyboardEvent, key: string, overlay: boolean) => {
      // ⇧I by the key's place, so a Thai layout works too.
      if (event.shiftKey && (event.code === 'KeyI' || key === 'i')) {
        inspectorControl.toggle()
        return
      }
      if (event.key === 'Escape') {
        if (!overlay) inspectorControl.escape()
        return
      }
      if (key === 'n' && !event.shiftKey) {
        setCaptureNonce((n) => n + 1)
        return
      }
      if (key === 'i' && !event.shiftKey) {
        router.push('/inbox')
        return
      }
      if (event.key === '?') {
        document.getElementById('shortcuts-menu')?.togglePopover()
        return
      }
      if (/^[1-9]$/.test(event.key) && views.length > 0) {
        const view = views[Number(event.key) - 1]
        if (view) router.push(view.href)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [router, toggleRail, views, inspectorControl])

  return (
    <ToastProvider>
      <InspectorProvider registry={inspector.registry}>
        <PageKeysProvider>
          <div className='app'>
            <a className='skip-link' href='#stage'>
              Skip to content
            </a>
            <TopBar
              user={user}
              project={project}
              pathname={pathname}
              views={views}
              waiting={data.waiting.total}
              onSearch={() => prompt.current?.focus()}
              onToggleRail={() => toggleRail(false)}
              inspector={inspectorControl}
            />
            <Rail
              pathname={pathname}
              project={project}
              waiting={data.waiting.total}
              waitingByModule={data.waiting.byModule}
              running={data.running}
              onToggleWidth={() => toggleRail(true)}
            />
            <main className='stage' id='stage' tabIndex={-1}>
              {children}
            </main>
            <Console
              open={consoleState.open}
              tab={consoleState.tab}
              focus={consoleState.focus}
              viewLabels={views.map((view) => view.label)}
              onTab={(tab) => setConsole((state) => ({ ...state, tab }))}
              onClose={() => setConsole((state) => ({ ...state, open: false }))}
            />
            <Foot
              inputRef={prompt}
              pathname={pathname}
              project={project}
              data={data}
              consoleOpen={consoleState.open}
              onToggleConsole={() =>
                setConsole((state) => ({ ...state, open: !state.open }))
              }
              onOpenRuns={() =>
                setConsole((state) => ({ ...state, open: true, tab: 'runs' }))
              }
              captureNonce={captureNonce}
            />
            <BottomBar
              pathname={pathname}
              project={project}
              waiting={data.waiting.total}
            />
            <ProjectMenu projects={data.projects} current={project} />
            <AccountMenu user={user} />
            <ShortcutsMenu />
            <MoreSheet pathname={pathname} project={project} />
          </div>
        </PageKeysProvider>
      </InspectorProvider>
    </ToastProvider>
  )
}
