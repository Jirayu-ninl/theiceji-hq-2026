/**
 * A path inside this app to continue to after a redirect, or the fallback.
 *
 * Checked after the URL parser has had its say, because that is what the
 * browser does with a `Location`: `\` becomes `/` and `.`/`..` segments
 * collapse, so `/..//evil.example`, `/.//evil.example` and `/\evil.example`
 * all come out as `//evil.example` — a link to another host. Only a plain
 * same-site path survives, and it comes back in that resolved form.
 *
 * Dependency-free: the proxy (edge runtime), server actions and client code
 * can all import it.
 */
export function internalPath(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return fallback
  try {
    const base = 'https://hq.invalid'
    const url = new URL(raw, base)
    if (url.origin !== base) return fallback
    const path = `${url.pathname}${url.search}${url.hash}`
    return path.startsWith('//') ? fallback : path
  } catch {
    return fallback
  }
}
