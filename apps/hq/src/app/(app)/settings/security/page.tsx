import { permanentRedirect } from 'next/navigation'

/**
 * The old Security tab moved into Account › Email and Password when
 * Settings went onto Bridge; bookmarks and old links land
 * there.
 */
export default function SecurityMoved() {
  permanentRedirect('/settings/account#password')
}
