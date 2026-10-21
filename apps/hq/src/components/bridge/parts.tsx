'use client'

import { PROJECT_COLORS, type ProjectColor } from '@theiceji/hq-db/enums'
import { type ReactNode, useEffect, useState } from 'react'
import { Icon } from '../shell/Icon'
import { useInspectorClose } from './Inspector'

export { Inspector } from './Inspector'

/**
 * The Bridge parts every module page composes: a project's
 * dot and name, the pane head, the inspector head, the readout, facts and
 * the empty line. Plain SaaS parts — the one LCD is `Readout`.
 */

export const isThai = (text: string | null | undefined) =>
  Boolean(text && /\p{Script=Thai}/u.test(text))

export const projectHex = (color: string) =>
  PROJECT_COLORS[color as ProjectColor] ?? PROJECT_COLORS.grey

export type ProjectTagData = { name: string; color: string; slug?: string }

export function Dot({ color }: { color: string }) {
  return (
    <i
      className='dot'
      style={{ ['--project' as string]: projectHex(color) }}
      aria-hidden='true'
    />
  )
}

export function Name({ text }: { text: string }) {
  return <span lang={isThai(text) ? 'th' : undefined}>{text}</span>
}

export function Tag({ project }: { project: ProjectTagData | null }) {
  return (
    <span className='tag'>
      {project ? <Dot color={project.color} /> : null}
      <Name text={project?.name ?? 'HQ'} />
    </span>
  )
}

export function PaneHead({
  title,
  meta,
  children,
}: {
  title: ReactNode
  meta?: ReactNode
  children?: ReactNode
}) {
  return (
    <header className='pane-head'>
      <span className='hud-label'>{title}</span>
      {meta ? <span className='dim'>{meta}</span> : null}
      {children ? (
        <span
          style={{
            marginLeft: meta ? 8 : 'auto',
            display: 'flex',
            gap: 4,
            alignItems: 'center',
          }}
        >
          {children}
        </span>
      ) : null}
    </header>
  )
}

/**
 * The inspector's head, with its close button: ✕
 * runs `onClose` — a form's cancel, a record's deselect — and, without one,
 * clears whatever the surrounding `Inspector` holds (or, holding nothing,
 * hides it). `children` are the record's own controls, before ✕ — its ⋯
 * menu (`MoreMenu`).
 */
export function InspectorHead({
  title,
  meta,
  onClose,
  children,
}: {
  title: ReactNode
  meta?: ReactNode
  onClose?: (() => void) | null
  children?: ReactNode
}) {
  const inspectorClose = useInspectorClose()
  const close = onClose ?? inspectorClose
  return (
    <header className='pane-head'>
      <span
        className='hud-label'
        style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
      >
        {title}
      </span>
      {meta ? <span className='dim'>{meta}</span> : null}
      {children ? (
        <span className='head-acts' style={{ marginLeft: meta ? 6 : 'auto' }}>
          {children}
        </span>
      ) : null}
      {close ? (
        <button
          type='button'
          className='iconbtn'
          style={{
            width: 22,
            height: 22,
            marginLeft: meta || children ? 4 : 'auto',
          }}
          aria-label='Close (Esc)'
          title='Close (Esc)'
          onClick={close}
        >
          <Icon name='close' size={14} />
        </button>
      ) : null}
    </header>
  )
}

export function Readout({
  big,
  sub,
  tone,
  label,
}: {
  big: ReactNode
  sub?: ReactNode
  tone?: 'wait' | 'live' | 'accent' | 'dim' | ''
  /** Words for a screen reader when `big` is only a figure. */
  label?: string
}) {
  return (
    <div
      className='readout'
      {...(label ? { role: 'status', 'aria-label': label } : {})}
    >
      <div className={`big${tone ? ` ${tone}` : ''}`}>{big}</div>
      {sub ? <div className='sub'>{sub}</div> : null}
    </div>
  )
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className='facts'>
      {rows.map(([key, value]) => (
        <Row key={key} term={key} value={value} />
      ))}
    </dl>
  )
}

function Row({ term, value }: { term: string; value: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{value ?? '—'}</dd>
    </>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className='empty'>{children}</div>
}

/** True at ≤ 1100px, where the inspector becomes a sheet. */
export function useNarrow(query = '(max-width: 1100px)'): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const media = window.matchMedia(query)
    const sync = () => setNarrow(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [query])
  return narrow
}

/** Keys that belong to the page, not to a field someone is typing in. */
export function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return Boolean(
    element?.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(element?.tagName ?? '') ||
      document.querySelector('dialog[open], :popover-open'),
  )
}

/**
 * A page's own keys: ignored while typing, under a
 * modifier, or with an overlay open. The handler returns true when it used
 * the key.
 */
export function usePageKeys(
  handler: (key: string, event: KeyboardEvent) => boolean | undefined,
) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Esc inside a field belongs to that field's form, which handles it.
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        typing(event.target)
      )
        return
      if (handler(event.key, event)) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

/** "3m", "2h", "5d" — how long ago, from the server's timestamp and the browser's clock. */
export function age(
  iso: string | Date | null | undefined,
  now = Date.now(),
): string {
  if (!iso) return '—'
  const then = typeof iso === 'string' ? Date.parse(iso) : iso.getTime()
  const minutes = Math.max(0, Math.round((now - then) / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** `1.2 MB`, `640 KB` — decimal units, the way storage bills them. */
export function bytesLabel(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`
}

/** `00:01:23` for a duration in ms. */
export function durationLabel(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}
