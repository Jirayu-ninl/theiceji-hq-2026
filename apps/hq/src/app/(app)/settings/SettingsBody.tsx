'use client'

import { useSelectedLayoutSegment } from 'next/navigation'
import { type ReactNode, useRef } from 'react'
import { usePageKeys } from '@/components/bridge/parts'
import { SETTINGS_TABS } from '@/components/navigation'

/**
 * The Settings pane: the head names the tab — the tabs
 * themselves are the top bar's views — and the body is one document of group
 * cards. A tab's own key (`s` save, `g` connect, `c` create) is answered here
 * by pressing the element that prints it (`data-key`), so a key exists only
 * while its button is on screen and enabled; the tab lists its keys with
 * `TabKeys`.
 */
export function SettingsBody({ children }: { children: ReactNode }) {
  const segment = useSelectedLayoutSegment()
  const tab = SETTINGS_TABS.find(
    (entry) => entry.href === `/settings/${segment}`,
  )
  const doc = useRef<HTMLDivElement>(null)

  usePageKeys((key) => {
    if (key.length !== 1 || /\d/.test(key)) return false
    const target = doc.current?.querySelector<HTMLElement>(
      `[data-key="${CSS.escape(key)}"]`,
    )
    if (!target || target.matches(':disabled')) return false
    target.click()
    return true
  })

  return (
    <section
      className='pane settings-pane'
      aria-label={`Settings — ${tab?.label ?? ''}`}
    >
      <header className='pane-head'>
        <span className='hud-label'>Settings</span>
        <span className='dim'>owner · {tab?.label ?? '…'}</span>
      </header>
      <div className='pane-body'>
        <div className='settings-doc' ref={doc}>
          {children}
        </div>
      </div>
    </section>
  )
}
