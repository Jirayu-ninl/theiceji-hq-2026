import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'

/**
 * Fetching a URL that someone else chose — a client metadata document, an
 * affiliate link's destination — without letting them point the server at itself.
 *
 * The classic check-then-fetch has two holes, and this closes both:
 *
 * 1. **DNS rebinding.** Resolving the host, checking the addresses, then
 *    calling `fetch(url)` resolves the name a second time — and the second
 *    answer can be 169.254.169.254. Here the host is resolved once, every
 *    address must be public, and the connection is made to that exact
 *    address through the socket's `lookup` hook. TLS still verifies the
 *    certificate against the hostname, so pinning can't be used to
 *    impersonate a site either.
 * 2. **Unbounded bodies.** Checking size after `response.text()` has already
 *    buffered whatever arrived. Here the body is read chunk by chunk and the
 *    connection is torn down the moment it passes the cap — declared length
 *    or not, chunked or not.
 *
 * Redirects are never followed; a 3xx comes back as data for the caller to
 * judge. Only http(s), no credentials in the URL, standard ports unless the
 * caller allows others.
 */

/* ── Addresses ─────────────────────────────────────────────────────── */

function ipv4IsPublic(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) {
    return false
  }
  const [a = 0, b = 0] = parts
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  if (a === 169 && b === 254) return false // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 0 || b === 168)) return false
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a >= 224) return false // multicast, reserved
  return true
}

/** Expand any IPv6 literal (incl. `::ffff:1.2.3.4`) to 16 bytes. */
function ipv6Bytes(address: string): number[] | null {
  let text = address.split('%')[0]?.toLowerCase() ?? ''
  let tail: number[] = []
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4?.[1]) {
    tail = v4[1].split('.').map(Number)
    if (tail.some((p) => !(p >= 0 && p <= 255))) return null
    text = `${text.slice(0, -v4[1].length)}0:0`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const filled = head.length + rest.length
  if (halves.length === 1 ? filled !== 8 : filled > 7) return null
  const groups = [...head, ...Array(8 - filled).fill('0'), ...rest]
  const bytes: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    const value = Number.parseInt(group, 16)
    bytes.push(value >> 8, value & 0xff)
  }
  if (tail.length === 4) bytes.splice(12, 4, ...tail)
  return bytes
}

function ipv6IsPublic(address: string): boolean {
  const b = ipv6Bytes(address)
  if (!b) return false
  const v4 = (offset: number) => b.slice(offset, offset + 4).join('.')
  const zeroUpTo = (n: number) => b.slice(0, n).every((x) => x === 0)
  if (zeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) {
    return ipv4IsPublic(v4(12)) // IPv4-mapped
  }
  if (zeroUpTo(12)) return false // ::, ::1, deprecated IPv4-compatible
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return ipv4IsPublic(v4(12)) // NAT64
  }
  if (b[0] === 0x20 && b[1] === 0x02) return ipv4IsPublic(v4(2)) // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) {
    return false // documentation
  }
  // Global unicast is 2000::/3; ULA, link-local and multicast fall outside.
  return ((b[0] ?? 0) & 0xe0) === 0x20
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return ipv4IsPublic(address)
  if (version === 6) return ipv6IsPublic(address)
  return false
}

export type ResolvedAddress = { address: string; family: 4 | 6 }

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }))

export type Destination =
  | { ok: true; url: URL; pinned: ResolvedAddress }
  | { ok: false; reason: GuardRefusal; detail: string }

export type GuardRefusal =
  | 'not-http'
  | 'credentials'
  | 'port'
  | 'unresolvable'
  | 'not-public'

export type GuardOptions = {
  /** Resolution, injectable for tests. Defaults to the system resolver. */
  resolve?: Resolver
  /** Address policy, injectable for tests only. Defaults to `isPublicAddress`. */
  allowAddress?: (address: string) => boolean
  /** Ports besides 80 and 443 the caller accepts. */
  extraPorts?: number[]
  /** Accept any port — only for an owner-configured local endpoint. */
  anyPort?: boolean
}

/**
 * Validates a URL and pins it to one public address. Every address the name
 * resolves to must be public — a name that answers with one public and one
 * private address is refused rather than raced.
 */
export async function resolveDestination(
  raw: string | URL,
  options: GuardOptions = {},
): Promise<Destination> {
  let url: URL
  try {
    url = new URL(String(raw))
  } catch {
    return { ok: false, reason: 'not-http', detail: 'not a URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return {
      ok: false,
      reason: 'not-http',
      detail: `${url.protocol} is not fetched`,
    }
  if (url.username || url.password)
    return {
      ok: false,
      reason: 'credentials',
      detail: 'the URL carries credentials',
    }
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80
  if (
    !options.anyPort &&
    ![80, 443, ...(options.extraPorts ?? [])].includes(port)
  )
    return { ok: false, reason: 'port', detail: `port ${port} is not allowed` }
  const allow = options.allowAddress ?? isPublicAddress
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: ResolvedAddress[]
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) === 6 ? 6 : 4 }]
  } else {
    try {
      addresses = await (options.resolve ?? systemResolver)(hostname)
    } catch (error) {
      return {
        ok: false,
        reason: 'unresolvable',
        detail: (error as Error).message,
      }
    }
  }
  if (addresses.length === 0)
    return { ok: false, reason: 'unresolvable', detail: 'no addresses' }
  const blocked = addresses.find((entry) => !allow(entry.address))
  if (blocked)
    return {
      ok: false,
      reason: 'not-public',
      detail: `${hostname} resolves to a non-public address`,
    }
  return { ok: true, url, pinned: addresses[0] as ResolvedAddress }
}

/* ── Fetch ─────────────────────────────────────────────────────────── */

export class GuardedFetchError extends Error {
  readonly reason: GuardRefusal | 'timeout' | 'too-large' | 'network'

  constructor(reason: GuardedFetchError['reason'], message: string) {
    super(message)
    this.name = 'GuardedFetchError'
    this.reason = reason
  }
}

export type GuardedResponse = {
  status: number
  headers: Record<string, string>
  body: Uint8Array
  /** Where a 3xx pointed. Never followed. */
  location: string | null
  /** The address the connection actually used. */
  remoteAddress: string | null
}

export type GuardedFetchOptions = GuardOptions & {
  method?: 'GET' | 'HEAD' | 'POST'
  headers?: Record<string, string>
  /** Request body for POST, sent with an exact content-length. */
  body?: string
  /** Whole request, connect to last byte. */
  timeoutMs: number
  /** Largest body accepted; the connection is torn down past it. */
  maxBytes: number
}

export async function guardedFetch(
  raw: string | URL,
  options: GuardedFetchOptions,
): Promise<GuardedResponse> {
  const destination = await resolveDestination(raw, options)
  if (!destination.ok)
    throw new GuardedFetchError(destination.reason, destination.detail)
  const { url, pinned } = destination
  const client = url.protocol === 'https:' ? https : http
  const hostname = url.hostname.replace(/^\[|\]$/g, '')

  // The socket asks this for the address — and gets the validated one, every
  // time, whatever DNS would say now.
  const pinnedLookup: LookupFunction = (_host, lookupOptions, callback) => {
    const done = callback as (...args: unknown[]) => void
    if ((lookupOptions as { all?: boolean } | undefined)?.all)
      done(null, [{ address: pinned.address, family: pinned.family }])
    else done(null, pinned.address, pinned.family)
  }

  return new Promise<GuardedResponse>((resolve, reject) => {
    let settled = false
    let remoteAddress: string | null = null
    const finish = (error: Error | null, value?: GuardedResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value as GuardedResponse)
    }
    const request = client.request(
      {
        protocol: url.protocol,
        host: hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: {
          'accept-encoding': 'identity',
          ...(options.body !== undefined
            ? { 'content-length': String(Buffer.byteLength(options.body)) }
            : {}),
          ...(options.headers ?? {}),
        },
        lookup: pinnedLookup,
        ...(url.protocol === 'https:'
          ? { servername: isIP(hostname) ? undefined : hostname }
          : {}),
        agent: false,
      },
      (response) => {
        remoteAddress ??= response.socket?.remoteAddress ?? null
        const declared = Number(response.headers['content-length'] ?? '')
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy()
          request.destroy()
          finish(
            new GuardedFetchError(
              'too-large',
              `declared ${declared} bytes, over ${options.maxBytes}`,
            ),
          )
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > options.maxBytes) {
            response.destroy()
            request.destroy()
            finish(
              new GuardedFetchError(
                'too-large',
                `body passed ${options.maxBytes} bytes`,
              ),
            )
            return
          }
          chunks.push(chunk)
        })
        response.on('error', (error) =>
          finish(new GuardedFetchError('network', error.message)),
        )
        response.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined)
              headers[name] = Array.isArray(value) ? value.join(', ') : value
          const status = response.statusCode ?? 0
          finish(null, {
            status,
            headers,
            body: new Uint8Array(Buffer.concat(chunks)),
            location:
              status >= 300 && status < 400 ? (headers.location ?? null) : null,
            remoteAddress,
          })
        })
      },
    )
    request.on('socket', (socket) => {
      const record = () => {
        remoteAddress ??= socket.remoteAddress ?? null
      }
      record()
      socket.once('connect', record)
      socket.once('secureConnect', record)
    })
    const timer = setTimeout(() => {
      request.destroy()
      finish(
        new GuardedFetchError(
          'timeout',
          `no complete answer within ${options.timeoutMs} ms`,
        ),
      )
    }, options.timeoutMs)
    request.on('error', (error) => {
      if (!settled) finish(new GuardedFetchError('network', error.message))
    })
    request.end(options.body)
  })
}
