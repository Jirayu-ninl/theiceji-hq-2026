import type { ReactNode } from 'react'
import { SettingsBody } from './SettingsBody'
import './bridge-settings.css'

/**
 * Settings: one document pane, a tab per concern —
 * Account · Appearance · Storage · Google · Connections · Policies · System.
 * The tabs are the `/settings` children in `components/navigation.ts` — the
 * top bar's views, the breadcrumb and the palette read the same list — and
 * each tab gates and loads its own data. Every tab is on Bridge.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className='page settingsp'>
      <SettingsBody>{children}</SettingsBody>
    </div>
  )
}
