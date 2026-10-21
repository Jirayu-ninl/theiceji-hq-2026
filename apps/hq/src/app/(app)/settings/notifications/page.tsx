import { permanentRedirect } from 'next/navigation'

/**
 * The old Notifications tab moved into Account › Notifications (push
 * devices) when Settings went onto Bridge; bookmarks and
 * old links land there.
 */
export default function NotificationsMoved() {
  permanentRedirect('/settings/account#push')
}
