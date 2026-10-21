import {
  type GoogleConnectionView,
  googleBlocker,
} from '@theiceji/hq-core/google'

/**
 * Why Google Drive can't be chosen as where new files go, in words — or
 * null when it can. Drive storage runs on the owner's one Google connection,
 * so the answer is the connection's: the server has to be set
 * up for Google, the connection has to be live, and it has to include Drive.
 * `undefined` means the connection couldn't be read at all.
 */
export function driveUnavailable(
  connection: GoogleConnectionView | null | undefined,
  blocker: string | null = googleBlocker(),
): string | null {
  if (blocker) return `Google isn’t set up on this server. ${blocker}`
  if (connection === undefined)
    return 'HQ couldn’t read the Google connection just now. Try again.'
  if (!connection || connection.status === 'revoked')
    return 'Google isn’t connected. Connect it under Google first.'
  if (connection.status !== 'connected')
    return `Google needs you to reconnect under Google${connection.problem ? `: ${connection.problem}` : '.'}`
  if (!connection.drive)
    return 'The Google connection doesn’t include Drive. Reconnect it under Google.'
  return null
}
