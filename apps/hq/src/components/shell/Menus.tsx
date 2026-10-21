'use client'

import { signOut } from '@theiceji/hq-auth/actions'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import { readPref, writePref } from '@/lib/prefs'
import type { ShellData } from '@/lib/shell'
import type { ProjectLite } from '@/modules'
import { HQ_NAV, isCurrentPath, SETTINGS } from '../navigation'
import { Icon } from './Icon'
import { usePageKeyList } from './keys'
import { NavLink } from './NavLink'
import { iconFor } from './Rail'
import type { ShellUser } from './Shell'
import { projectColor } from './TopBar'

/** A menu's link navigates in the page, so it closes its popover itself. */
const closeMenu = (event: MouseEvent<HTMLAnchorElement>) =>
  event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover()

/**
 * The shell's overlays: top-layer popovers with a role that
 * fits their kind. The browser gives each one Esc, light dismiss and focus
 * return; this file only places them next to whatever opened them — the
 * invoker that was clicked, or the breadcrumb for ⌘P — and flips them above
 * it when it sits low on the screen. Shadow lives here and nowhere else.
 */

const isThai = (text: string) => /\p{Script=Thai}/u.test(text)

/** Place a popover beside its anchor, inside the viewport. */
function place(popover: HTMLElement, anchor: Element | null) {
  if (!anchor) return
  const rect = anchor.getBoundingClientRect()
  const width = popover.offsetWidth
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
  popover.style.left = `${left}px`
  if (rect.top > window.innerHeight / 2) {
    popover.style.top = 'auto'
    popover.style.bottom = `${window.innerHeight - rect.top + 6}px`
  } else {
    popover.style.bottom = 'auto'
    popover.style.top = `${rect.bottom + 6}px`
  }
}

/** The last element that opened each popover, so ⌘P and clicks both land right. */
export function usePlacement(id: string, fallback: string) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const popover = ref.current
    if (!popover) return
    let invoker: Element | null = null
    const remember = (event: Event) => {
      const target = (event.target as Element | null)?.closest(
        `[popovertarget="${id}"]`,
      )
      if (target) invoker = target
    }
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== 'open') {
        invoker = null
        return
      }
      const visible = (element: Element | null) =>
        element && (element as HTMLElement).offsetParent !== null
          ? element
          : null
      place(
        popover,
        visible(invoker) ?? visible(document.querySelector(fallback)),
      )
      const first =
        popover.querySelector<HTMLElement>('.menu-item[aria-current]') ??
        popover.querySelector<HTMLElement>('a, button')
      first?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', remember, true)
    popover.addEventListener('toggle', onToggle)
    return () => {
      document.removeEventListener('pointerdown', remember, true)
      popover.removeEventListener('toggle', onToggle)
    }
  }, [id, fallback])
  return ref
}

/** Arrow keys move through a menu's items. */
export function menuKeys(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('.menu-item'),
  ]
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next =
    event.key === 'ArrowDown'
      ? items[(at + 1) % items.length]
      : items[(at - 1 + items.length) % items.length]
  event.preventDefault()
  next?.focus()
}

/**
 * The project switcher (⌘P): every project with its dot and `◆ n`, then All
 * projects and the list. Links are plain anchors — a project is a URL, and a
 * menu never prefetches another project's pages.
 */
export function ProjectMenu({
  projects,
  current,
}: {
  projects: ShellData['projects']
  current: ProjectLite | null
}) {
  const ref = usePlacement('project-menu', '.crumb-proj')
  return (
    <div
      ref={ref}
      id='project-menu'
      popover='auto'
      className='popover'
      role='menu'
      aria-label='Switch project'
      onKeyDown={menuKeys}
    >
      <div className='pane-head'>
        <span className='hud-label'>Projects</span>
        <span className='dim'>⌘P</span>
      </div>
      <div className='menu-list'>
        {projects.length === 0 ? (
          <p className='empty'>○ no projects yet</p>
        ) : (
          projects.map((project) => (
            <a
              key={project.id}
              role='menuitem'
              className='menu-item'
              href={`/p/${project.slug}`}
              aria-current={current?.id === project.id ? 'true' : undefined}
            >
              <i
                className='dot'
                style={{ ['--project' as string]: projectColor(project.color) }}
                aria-hidden='true'
              />
              <span
                className='label'
                lang={isThai(project.name) ? 'th' : undefined}
              >
                {project.name}
              </span>
              {project.waiting > 0 ? (
                <span className='sub wait'>◆ {project.waiting}</span>
              ) : project.status === 'paused' ? (
                <span className='sub'>paused</span>
              ) : null}
            </a>
          ))
        )}
        <hr className='menu-sep' />
        <a
          role='menuitem'
          className='menu-item'
          href='/'
          aria-current={current ? undefined : 'true'}
        >
          <span className='label'>All projects</span>
        </a>
        <a role='menuitem' className='menu-item' href='/projects'>
          <span className='label'>Projects…</span>
        </a>
        <a role='menuitem' className='menu-item' href='/projects?new=1'>
          <span className='label'>New project…</span>
        </a>
      </div>
    </div>
  )
}

const THEMES = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
] as const

/** The account menu: who is signed in, the theme, Settings and sign out. */
export function AccountMenu({ user }: { user: ShellUser }) {
  const ref = usePlacement('account-menu', '.avatar')
  const [theme, setTheme] = useState<(typeof THEMES)[number][0]>('system')
  // Read on every open: Settings › Appearance and the palette change the theme too.
  useEffect(() => {
    const menu = ref.current
    const sync = () => setTheme(readPref('hq.theme') ?? 'system')
    sync()
    menu?.addEventListener('toggle', sync)
    return () => menu?.removeEventListener('toggle', sync)
  }, [ref])
  const choose = (value: (typeof THEMES)[number][0]) => {
    const root = document.documentElement
    if (value === 'system') delete root.dataset.theme
    else root.dataset.theme = value
    writePref('hq.theme', value)
    setTheme(value)
  }
  return (
    <div
      ref={ref}
      id='account-menu'
      popover='auto'
      className='popover'
      role='menu'
      aria-label='Account'
      onKeyDown={menuKeys}
    >
      <div className='menu-list'>
        <div className='menu-who'>
          <div className='who-name'>{user.name ?? 'Owner'}</div>
          <small>{user.email}</small>
        </div>
        <hr className='menu-sep' />
        <div className='menu-row'>
          <span className='hud-label'>Theme</span>
          {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons, not a fieldset */}
          <span className='seg' role='group' aria-label='Theme'>
            {THEMES.map(([value, label]) => (
              <button
                key={value}
                type='button'
                aria-pressed={theme === value}
                onClick={() => choose(value)}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
        <hr className='menu-sep' />
        <NavLink
          onClick={closeMenu}
          role='menuitem'
          className='menu-item'
          href={SETTINGS.href}
        >
          <Icon name='settings' size={16} />
          <span className='label'>Settings</span>
        </NavLink>
        <form action={signOut} style={{ display: 'contents' }}>
          <button type='submit' role='menuitem' className='menu-item'>
            <span className='label'>Sign out</span>
          </button>
        </form>
      </div>
    </div>
  )
}

const KEYS: [string, string][] = [
  ['⌘K', 'go anywhere — the prompt in the footer'],
  ['⌘P', 'switch project'],
  ['1 2 3', 'this page’s views'],
  ['\\', 'show or hide the rail'],
  ['⇧\\', 'wide or narrow rail'],
  ['⇧I', 'show or hide the inspector'],
  ['n', 'jot a note — note "…" in the prompt, ↵ saves'],
  ['i', 'what waits for you'],
  ['⌃`', 'console: log, runs and every key'],
  ['↑ ↓ ↵', 'move and open in a list'],
  ['Esc', 'close one layer at a time'],
  ['?', 'these keys'],
]

/** Every key the shell answers to — none is hidden. */
export function ShortcutsMenu() {
  const ref = usePlacement('shortcuts-menu', '.foot .sc:last-child')
  const pageKeys = usePageKeyList()
  return (
    <div
      ref={ref}
      id='shortcuts-menu'
      popover='auto'
      className='popover'
      role='dialog'
      aria-label='Keyboard shortcuts'
      tabIndex={-1}
    >
      <div className='pane-head'>
        <span className='hud-label'>Keys</span>
      </div>
      <dl className='facts keys-list'>
        {[...pageKeys, ...KEYS].map(([key, what], index) => (
          <div key={`${index}-${key}`} style={{ display: 'contents' }}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** On a phone the rail is a sheet behind the bottom bar's More. */
export function MoreSheet({
  pathname,
  project,
}: {
  pathname: string
  project: ProjectLite | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={ref}
      id='more-sheet'
      popover='auto'
      className='sheet'
      role='dialog'
      aria-label='All sections'
    >
      <div className='pane-head'>
        <span className='hud-label'>Sections</span>
        <button
          type='button'
          className='iconbtn sheet-close'
          popoverTarget='more-sheet'
          popoverTargetAction='hide'
          aria-label='Close'
        >
          ×
        </button>
      </div>
      <div className='menu-list'>
        {[...HQ_NAV, SETTINGS].map((item) => {
          return (
            <NavLink
              onClick={closeMenu}
              key={item.href}
              className='menu-item'
              href={item.href}
              aria-current={
                isCurrentPath(pathname, item.href, item.href === '/')
                  ? 'page'
                  : undefined
              }
            >
              <Icon name={iconFor(item.href)} size={16} />
              <span className='label'>{item.label}</span>
            </NavLink>
          )
        })}
        {project ? (
          <a className='menu-item' href={`/p/${project.slug}`}>
            <i
              className='dot'
              style={{ ['--project' as string]: projectColor(project.color) }}
              aria-hidden='true'
            />
            <span className='label'>{project.name}</span>
          </a>
        ) : null}
      </div>
    </div>
  )
}
