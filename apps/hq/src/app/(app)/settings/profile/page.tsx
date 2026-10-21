import { permanentRedirect } from 'next/navigation'

/**
 * The old Profile tab is now the Profile group at the top of Account,
 * since Settings went onto Bridge; bookmarks and old
 * links land there.
 */
export default function ProfileMoved() {
  permanentRedirect('/settings/account')
}
