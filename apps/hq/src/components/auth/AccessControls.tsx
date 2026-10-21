'use client'

import { useEffect, useState } from 'react'
import { type PrefValue, readPref, writePref } from '@/lib/prefs'

type Theme = PrefValue<'hq.theme'>

/** The same order as the palette's "Switch theme" (components/shell/Foot.tsx). */
const ORDER: readonly Theme[] = ['system', 'light', 'dark']
const LABEL: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

/**
 * The access screen's theme toggle: top right, outside the
 * card. It writes `hq.theme` — the key the boot script in app/layout.tsx
 * applies before paint — and applies the choice at once, even when the
 * browser won't store it.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system')
  useEffect(() => setTheme(readPref('hq.theme') ?? 'system'), [])
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? 'system'
  const name = `Theme: ${LABEL[theme]}. Switch to ${LABEL[next]}`
  return (
    <button
      type='button'
      className='iconbtn theme-btn'
      title={name}
      aria-label={name}
      onClick={() => {
        const root = document.documentElement
        if (next === 'system') delete root.dataset.theme
        else root.dataset.theme = next
        writePref('hq.theme', next)
        setTheme(next)
      }}
    >
      <svg className='i' viewBox='0 0 24 24' aria-hidden='true'>
        <path d='M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' />
      </svg>
    </button>
  )
}

const ZONE = 'Asia/Bangkok'
const DAY = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  timeZone: ZONE,
})
const TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: ZONE,
})

/**
 * Day · time · zone in the well's corner, from the browser's clock, like
 * `WED 23 · 14:32 · BKK`. Empty until mounted, so the server's
 * minute never disagrees with the browser's.
 */
export function Stamp() {
  const [text, setText] = useState('')
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setText(
        `${DAY.format(now).replace(',', '').toUpperCase()} · ${TIME.format(now)} · BKK`,
      )
    }
    tick()
    const id = window.setInterval(tick, 30_000)
    return () => window.clearInterval(id)
  }, [])
  return <span className='stamp'>{text}</span>
}
