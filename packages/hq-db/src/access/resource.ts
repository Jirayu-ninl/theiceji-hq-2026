/**
 * RFC 8707 resource identifiers — the MCP endpoint URL a token is valid at.
 *
 * Compared as canonical strings, never by prefix or host: a token minted for
 * `https://mcp.example.com/mcp` must not work at `/mcp-admin` or anywhere else
 * on the host. Canonical here means what clients send in practice (Claude
 * lower-cases the host and drops a trailing slash): scheme and host from URL
 * parsing, no fragment, no trailing slash on the path.
 *
 * Returns null for anything that isn't an http(s) URL.
 */
export function canonicalResource(value: string | null | undefined): string | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}${url.search}`
}
