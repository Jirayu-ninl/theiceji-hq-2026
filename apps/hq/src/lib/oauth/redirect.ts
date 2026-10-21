/**
 * Redirect-URI validation and matching — the field an attacker most wants to
 * control, because an open redirect hands the owner's authorization code to
 * whoever asked.
 *
 * Accepted shapes:
 *   · `https://…`                           web apps (claude.ai, chatgpt.com)
 *   · `http://localhost|127.0.0.1|[::1]…`   native loopback (Claude Code,
 *                                           Hermes Agent, VS Code — RFC 8252 §7.3)
 *   · `private.scheme:/…`                   native app schemes (RFC 8252 §7.1),
 *                                           e.g. `cursor://…`
 * Refused: plain http to anything else, fragments, whitespace, and schemes a
 * browser would execute or read locally.
 *
 * Matching is exact string comparison, with one exception: a loopback URI's
 * port is ignored on both sides, because native clients declare
 * `http://localhost/callback` and bind an ephemeral port at runtime. An
 * authorization server that compares those exactly refuses every Claude Code
 * connection.
 */

const REFUSED_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
  'about:',
  'filesystem:',
  'ftp:',
  'ws:',
  'wss:',
])

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function parse(uri: string): URL | null {
  try {
    return new URL(uri)
  } catch {
    return null
  }
}

export function isLoopbackRedirect(uri: string): boolean {
  const url = parse(uri)
  return !!url && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

export function isValidRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string') return false
  if (uri.length < 8 || uri.length > 2000) return false
  if (uri.includes('#') || /\s/.test(uri)) return false
  const url = parse(uri)
  if (!url || url.username || url.password) return false
  if (url.protocol === 'https:') return url.hostname.length > 0
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname)
  return (
    /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) &&
    !REFUSED_SCHEMES.has(url.protocol)
  )
}

function withoutPort(uri: string): string {
  const url = new URL(uri)
  url.port = ''
  return url.href
}

/** Is `presented` one of `registered`? */
export function redirectMatches(
  presented: string,
  registered: readonly string[],
): boolean {
  if (!isValidRedirectUri(presented)) return false
  if (registered.includes(presented)) return true
  if (!isLoopbackRedirect(presented)) return false
  const normalised = withoutPort(presented)
  return registered.some(
    (candidate) =>
      isLoopbackRedirect(candidate) && withoutPort(candidate) === normalised,
  )
}

/** What the consent screen shows for a redirect target. */
export function redirectLabel(uri: string): string {
  const url = parse(uri)
  if (!url) return uri
  if (url.protocol === 'https:' || url.protocol === 'http:') return url.host
  return `${url.protocol}//${url.host}`
}
