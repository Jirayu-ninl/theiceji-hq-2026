'use client'

import { useRouter } from 'next/navigation'
import {
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { PaletteHit, PaletteNote, PaletteResult } from '@/lib/palette'
import { writePref } from '@/lib/prefs'
import type { ShellData } from '@/lib/shell'
import {
  globalModules,
  MODULES,
  type ProjectLite,
  projectModules,
} from '@/modules'
import { captureNoteAction, trashNoteAction } from '@/modules/notes/actions'
import { CONSOLE_ID } from '../Console'
import { HQ_NAV, SETTINGS_TABS } from '../navigation'
import { useToast } from '../Toast'
import { usePageKeyList } from './keys'
import { NavLink } from './NavLink'
import { projectColor } from './TopBar'

type Item = {
  id: string
  group: string
  label: string
  hint?: string
  tone?: 'wait' | 'live' | 'problem'
  glyph?: string
  color?: string
  href?: string
  run?: () => void
  /** Choosing it leaves the palette open (it rewrites the prompt instead). */
  stay?: boolean
}

const isThai = (text: string) => /\p{Script=Thai}/u.test(text)

/** `note "…"` in the prompt is a capture. */
const CAPTURE = /^note\s+["“]?/i
export const CAPTURE_PREFIX = 'note "'

/** Every word must match somewhere in the label or the hint. */
function matches(item: Item, words: string[]): boolean {
  const hay = `${item.label} ${item.hint ?? ''} ${item.group}`.toLowerCase()
  return words.every((word) => hay.includes(word))
}

/**
 * The footer strip (an LCD in both themes): the prompt, which is the ⌘K
 * palette; the connection chips; running agents (`▶ n`, which opens the
 * console on Runs), the page's keys and the console toggle (⌃`).
 *
 * The palette rises from the prompt. Empty, it lists what waits for you and
 * where to go; typing searches every group — waiting items, pages, this
 * project's modules, projects, actions, notes and the modules' records
 * (cards, prompts, assets, events, quotes) — and every word must match.
 *
 * `note "…"` captures instead (the `n` key starts one): ↵ saves the note —
 * filed under the project you are in — and the toast offers Undo. A note
 * found by search opens on the Notes page.
 */
export function Foot({
  inputRef,
  pathname,
  project,
  data,
  consoleOpen,
  onToggleConsole,
  onOpenRuns,
  captureNonce,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  pathname: string
  project: ProjectLite | null
  data: ShellData
  consoleOpen: boolean
  onToggleConsole: () => void
  onOpenRuns: () => void
  /** Bumped by the shell's `n` key: start a capture in the prompt. */
  captureNonce: number
}) {
  const pageKeys = usePageKeyList()
  const router = useRouter()
  const toast = useToast()
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [notes, setNotes] = useState<PaletteNote[]>([])
  const [hits, setHits] = useState<PaletteHit[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const found = useRef(new Map<string, PaletteResult>())

  // biome-ignore lint/correctness/useExhaustiveDependencies: close the palette on every route change
  useEffect(() => {
    setOpen(false)
    setQuery('')
  }, [pathname])

  const startCapture = () => {
    setQuery(CAPTURE_PREFIX)
    setActive(0)
    setOpen(true)
    const input = inputRef.current
    input?.focus()
    requestAnimationFrame(() =>
      input?.setSelectionRange(input.value.length, input.value.length),
    )
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: only the shell's `n` starts a capture
  useEffect(() => {
    if (captureNonce > 0) startCapture()
  }, [captureNonce])

  const capture = async (text: string) => {
    const result = await captureNoteAction({
      body: text,
      projectId: project?.id ?? null,
    })
    if (!result.ok) {
      toast(result.error)
      return
    }
    const note = result.data
    toast(`Note captured: ${text.slice(0, 48)}`, {
      undo: async () => {
        const back = await trashNoteAction({ noteId: note.id, deleted: true })
        if (!back.ok) toast(back.error)
      },
    })
  }

  useEffect(() => {
    const text = query.trim()
    if (CAPTURE.test(text)) {
      setNotes([])
      setHits([])
      return
    }
    if (text.length < 2) {
      setNotes([])
      setHits([])
      return
    }
    // Typed before in this opening of the palette: no need to ask again.
    const known = found.current.get(text)
    if (known) {
      setNotes(known.notes)
      setHits(known.hits)
      return
    }
    // One request per pause in typing (lib/palette.ts), dropped the moment
    // the next keystroke makes it moot.
    const abort = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/palette', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ q: text }),
          signal: abort.signal,
        })
        if (!response.ok) return
        const result = (await response.json()) as PaletteResult
        found.current.set(text, result)
        setNotes(result.notes)
        setHits(result.hits)
      } catch {
        // Cancelled, or offline: the list keeps what it showed.
      }
    }, 160)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [query])
  // What the palette found lasts while it is open; the next opening asks again.
  useEffect(() => {
    if (!open) found.current.clear()
  }, [open])

  // biome-ignore lint/correctness/useExhaustiveDependencies: capture and startCapture only run on a click, reading the props of that render
  const items = useMemo<Item[]>(() => {
    if (CAPTURE.test(query.trimStart())) {
      const text = query
        .trimStart()
        .replace(CAPTURE, '')
        .replace(/["”]\s*$/, '')
        .trim()
      return [
        {
          id: 'c-note',
          group: 'Capture',
          label: `Create note: ${text || '…'}`,
          hint: project ? `${project.name} · ↵` : '↵',
          glyph: '+',
          run: text ? () => void capture(text) : undefined,
          stay: !text,
        },
      ]
    }
    const waiting: Item[] = data.waiting.top.map((entry) => ({
      id: `w-${entry.id}`,
      group: 'Waiting for you',
      label: entry.title,
      hint: 'inbox',
      tone: 'wait',
      glyph: '◆',
      href: entry.href,
    }))
    const place = (entry: (typeof HQ_NAV)[number]): Item => ({
      id: `g-${entry.href}`,
      group: 'Go to',
      label: entry.href.startsWith('/settings/')
        ? `Settings · ${entry.label}`
        : entry.label,
      hint: entry.description,
      href: entry.href,
    })
    // The all-projects module pages, named apart from a project's own
    // module (its group is the project), so they're reachable from anywhere.
    const everywhere: Item[] = [
      ...globalModules(),
      { ...MODULES.readings, href: '/dashboard' },
    ].map((module) => ({
      id: `g-${module.href}`,
      group: 'Go to',
      label: `${module.label} · all projects`,
      glyph: module.glyph,
      href: module.href,
    }))
    const goTo: Item[] = [
      ...HQ_NAV.map(place),
      ...everywhere,
      ...SETTINGS_TABS.map(place),
    ]
    const modules: Item[] = project
      ? projectModules(project).map((module) => ({
          id: `m-${module.id}`,
          group: project.name,
          label: module.label,
          glyph: module.glyph,
          href: module.href,
        }))
      : []
    const projects: Item[] = data.projects.map((entry) => ({
      id: `p-${entry.id}`,
      group: 'Projects',
      label: entry.name,
      hint:
        entry.waiting > 0 ? `◆ ${entry.waiting}` : entry.kind.replace('_', ' '),
      tone: entry.waiting > 0 ? 'wait' : undefined,
      color: projectColor(entry.color),
      href: `/p/${entry.slug}`,
    }))
    const actions: Item[] = [
      {
        id: 'a-note',
        group: 'Actions',
        label: 'Jot a note',
        hint: 'n',
        run: startCapture,
        stay: true,
      },
      {
        id: 'a-project',
        group: 'Actions',
        label: 'New project',
        href: '/projects?new=1',
      },
      {
        id: 'a-theme',
        group: 'Actions',
        label: 'Switch theme',
        hint: 'system → light → dark',
        run: () => {
          const root = document.documentElement
          const next =
            root.dataset.theme === 'light'
              ? 'dark'
              : root.dataset.theme === 'dark'
                ? 'system'
                : 'light'
          if (next === 'system') delete root.dataset.theme
          else root.dataset.theme = next
          writePref('hq.theme', next)
        },
      },
    ]
    const noteItems: Item[] = notes.map((note) => ({
      id: `n-${note.id}`,
      group: 'Notes',
      label: note.title,
      hint: note.labels.join(' · ') || undefined,
      href: `/notes?note=${note.id}`,
    }))
    const recordItems: Item[] = hits.map((hit) => {
      const owner = data.projects.find((entry) => entry.id === hit.projectId)
      return {
        id: `r-${hit.id}`,
        group: hit.group,
        label: hit.title,
        hint:
          [owner?.name, hit.detail].filter(Boolean).join(' · ') || undefined,
        color: owner ? projectColor(owner.color) : undefined,
        href: hit.href,
      }
    })
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return [...waiting, ...goTo.slice(0, 6)]
    return [
      ...[...waiting, ...goTo, ...modules, ...projects, ...actions].filter(
        (item) => matches(item, words),
      ),
      ...noteItems,
      ...recordItems,
    ].slice(0, 24)
  }, [data, project, query, notes, hits])

  useEffect(() => {
    setActive((value) => Math.min(value, Math.max(0, items.length - 1)))
  }, [items.length])

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the active row changes, to keep it in view
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (item: Item | undefined) => {
    if (!item) return
    if (item.stay) {
      item.run?.()
      return
    }
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
    if (item.run) item.run()
    else if (item.href) router.push(item.href)
  }

  const groups: { name: string; items: (Item & { index: number })[] }[] = []
  items.forEach((item, index) => {
    const last = groups[groups.length - 1]
    if (last && last.name === item.group) last.items.push({ ...item, index })
    else groups.push({ name: item.group, items: [{ ...item, index }] })
  })

  const google = data.google
  const placeholder = project
    ? `open ${projectModules(project)[0]?.label.toLowerCase() ?? 'a module'} · note · go anywhere`
    : 'go anywhere · open a project · note'

  return (
    <footer className='foot'>
      <form
        className='prompt'
        onSubmit={(event) => {
          event.preventDefault()
          choose(items[active])
        }}
      >
        <span className='prompt-caret' aria-hidden='true'>
          ›
        </span>
        <input
          ref={inputRef}
          type='text'
          role='combobox'
          aria-label='Go anywhere (⌘K)'
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete='list'
          aria-activedescendant={
            open && items[active] ? `${listId}-${active}` : undefined
          }
          placeholder={placeholder}
          value={query}
          autoComplete='off'
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActive((value) =>
                items.length ? (value + 1) % items.length : 0,
              )
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((value) =>
                items.length ? (value - 1 + items.length) % items.length : 0,
              )
            } else if (event.key === 'Escape') {
              event.preventDefault()
              if (query) setQuery('')
              else {
                setOpen(false)
                event.currentTarget.blur()
              }
            }
          }}
        />
      </form>
      {open ? (
        <div
          className='palette'
          id={listId}
          role='listbox'
          aria-label='Go anywhere'
          ref={listRef}
        >
          {items.length === 0 ? (
            <div className='palette-empty'>
              Nothing matches <b>{query}</b>.
            </div>
          ) : (
            groups.map((group) => (
              // biome-ignore lint/a11y/useSemanticElements: a group of listbox options (ARIA listbox pattern), not form fields
              <div key={group.name} role='group' aria-label={group.name}>
                <div
                  className='grp'
                  lang={isThai(group.name) ? 'th' : undefined}
                >
                  {group.name}
                </div>
                {group.items.map((item) => (
                  <div
                    key={item.id}
                    id={`${listId}-${item.index}`}
                    role='option'
                    tabIndex={-1}
                    aria-selected={item.index === active}
                    className='palette-item'
                    // Keep focus in the prompt so the click lands before blur closes the list.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(item.index)}
                    onClick={() => choose(item)}
                  >
                    {item.color ? (
                      <i
                        className='dot'
                        style={{ ['--project' as string]: item.color }}
                        aria-hidden='true'
                      />
                    ) : (
                      <i className={`pg ${item.tone ?? ''}`} aria-hidden='true'>
                        {item.glyph ?? '·'}
                      </i>
                    )}
                    <span
                      className='t'
                      lang={isThai(item.label) ? 'th' : undefined}
                    >
                      {item.label}
                    </span>
                    {item.hint ? (
                      <span
                        className={`hint ${item.tone === 'wait' ? 'wait' : ''}`}
                      >
                        {item.hint}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
      <div className='chips'>
        {data.database === 'ok' ? (
          <span className='ok'>db ok</span>
        ) : (
          <NavLink className='problem' href='/settings/system'>
            ◆ db · unreachable
          </NavLink>
        )}
        {google.status === 'connected' ? (
          <NavLink className='ok' href='/settings/google'>
            Google ok
          </NavLink>
        ) : google.status === 'needs_reauth' ? (
          <NavLink className='problem' href='/settings/google'>
            ◆ Google · reconnect
          </NavLink>
        ) : (
          <NavLink href='/settings/google'>Google · not connected</NavLink>
        )}
      </div>
      <div className='foot-end'>
        <button
          type='button'
          className={`agents${data.running > 0 ? '' : ' zero'}`}
          aria-label={`Agent runs: ${data.running} running`}
          title='Agent runs'
          onClick={onOpenRuns}
        >
          ▶ {data.running} running
        </button>
        {pageKeys.length > 0 ? (
          pageKeys.slice(0, 4).map(([key, label]) => (
            <span key={key} className='sc'>
              <kbd>{key}</kbd> {label}
            </span>
          ))
        ) : (
          <>
            <span className='sc'>
              <kbd>⌘K</kbd> go
            </span>
            <span className='sc'>
              <kbd>⌘P</kbd> project
            </span>
            <span className='sc'>
              <kbd>n</kbd> note
            </span>
          </>
        )}
        {/* A button, not only a key: the list of keys opens with a click too. */}
        <button
          type='button'
          className='sc keys-open'
          popoverTarget='shortcuts-menu'
          aria-haspopup='dialog'
          title='Every key on this page (?)'
        >
          <kbd>?</kbd> keys
        </button>
      </div>
      {/* After the keys, not among them: `? keys` stays the list's last `.sc` (the shortcuts popover's anchor). */}
      <button
        type='button'
        id='console-toggle'
        className='console-toggle'
        aria-expanded={consoleOpen}
        aria-controls={CONSOLE_ID}
        title='Console (⌃`)'
        onClick={onToggleConsole}
      >
        <kbd>⌃`</kbd> console
      </button>
    </footer>
  )
}
