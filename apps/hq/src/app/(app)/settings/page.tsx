import { redirect } from 'next/navigation'

/** `/settings` opens its first tab. */
export default function SettingsPage() {
  redirect('/settings/account')
}
