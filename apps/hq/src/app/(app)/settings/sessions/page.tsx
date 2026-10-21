import { permanentRedirect } from 'next/navigation'

/**
 * The old Sessions tab moved into Account › Sessions when Settings went
 * onto Bridge; bookmarks and old links land there.
 */
export default function SessionsMoved() {
  permanentRedirect('/settings/account#sessions')
}
