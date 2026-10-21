import type { Metadata } from 'next'
import { TabKeys } from '../forms'
import { AppearanceView } from './AppearanceView'

export const metadata: Metadata = { title: 'Appearance — Settings — HQ' }

/**
 * Settings › Appearance: this browser's preferences, applied at once. Nothing
 * here is on the server — the tab reads and writes `hq.*` in the browser,
 * so there is nothing to load and nothing to save.
 */
export default function AppearanceSettingsPage() {
  return (
    <>
      <TabKeys />
      <AppearanceView />
    </>
  )
}
