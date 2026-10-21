import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type GuardedFetchError,
  guardedFetch,
  isPublicAddress,
  type Resolver,
  resolveDestination,
} from '../src'

/**
 * Regression tests (SSRF guard). A local server stands in for "the internet";
 * the address policy is widened to loopback only where a test needs a real
 * connection, and every refusal is checked to happen before a connection.
 */

type Hit = { path: string; host?: string }

let server: http.Server
let port = 0
const hits: Hit[] = []

async function failure(work: Promise<unknown>): Promise<GuardedFetchError> {
  try {
    await work
  } catch (error) {
    return error as GuardedFetchError
  }
  throw new Error('Expected the fetch to be refused.')
}

beforeAll(async () => {
  server = http.createServer((request, response) => {
    hits.push({ path: request.url ?? '', host: request.headers.host })
    if (request.url === '/small') {
      response.setHeader('content-type', 'application/json')
      response.end('{"ok":true}')
    } else if (request.url === '/chunked-huge') {
      response.setHeader('content-type', 'application/octet-stream')
      // No content-length: chunked. 64 KB in 1 KB chunks.
      let sent = 0
      const tick = () => {
        if (sent >= 64 || response.destroyed) return response.end()
        sent += 1
        response.write(Buffer.alloc(1024, 97), tick)
      }
      tick()
    } else if (request.url === '/declared-huge') {
      response.setHeader('content-length', String(10 * 1024 * 1024))
      response.write(Buffer.alloc(16))
    } else if (request.url === '/redirect') {
      response.statusCode = 302
      response.setHeader('location', 'http://169.254.169.254/latest/meta-data/')
      response.end()
    } else if (request.url === '/hang') {
      // Never answers.
    } else {
      response.statusCode = 404
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const loopbackOnly = (address: string) => address === '127.0.0.1'

describe('address policy', () => {
  test('private, loopback, link-local and metadata addresses are not public', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ])
      expect(isPublicAddress(address)).toBe(false)
    for (const address of ['93.184.216.34', '2606:4700::6810:84e5'])
      expect(isPublicAddress(address)).toBe(true)
  })

  test('a name resolving to a private address is refused before connecting', async () => {
    const before = hits.length
    const resolve: Resolver = async () => [
      { address: '169.254.169.254', family: 4 },
    ]
    const error = await failure(
      guardedFetch(`http://metadata.example:${port}/small`, {
        resolve,
        extraPorts: [port],
        timeoutMs: 2000,
        maxBytes: 1024,
      }),
    )
    expect(error.reason).toBe('not-public')
    expect(hits.length).toBe(before)
  })

  test('a name with one public and one private answer is refused, not raced', async () => {
    const outcome = await resolveDestination('https://mixed.example/x', {
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('not-public')
  })

  test('credentials, other schemes and odd ports are refused', async () => {
    expect((await resolveDestination('https://u:p@example.com/')).ok).toBe(
      false,
    )
    expect((await resolveDestination('file:///etc/passwd')).ok).toBe(false)
    expect((await resolveDestination('https://example.com:8443/')).ok).toBe(
      false,
    )
  })

  test('loopback is refused under the default policy', async () => {
    const before = hits.length
    const error = await failure(
      guardedFetch(`http://127.0.0.1:${port}/small`, {
        extraPorts: [port],
        timeoutMs: 2000,
        maxBytes: 1024,
      }),
    )
    expect(error.reason).toBe('not-public')
    expect(hits.length).toBe(before)
  })
})

describe('pinned connection', () => {
  test('DNS changing after the check cannot redirect the connection', async () => {
    let calls = 0
    // First answer passes the policy; any later answer would not.
    const resolve: Resolver = async () => {
      calls += 1
      return calls === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '10.9.9.9', family: 4 }]
    }
    const response = await guardedFetch(`http://rebind.example:${port}/small`, {
      resolve,
      allowAddress: loopbackOnly,
      extraPorts: [port],
      timeoutMs: 3000,
      maxBytes: 1024,
    })
    expect(response.status).toBe(200)
    // Resolved once; `rebind.example` doesn't exist in real DNS, so reaching
    // the loopback server at all proves the connection used the pinned answer.
    expect(calls).toBe(1)
    expect(hits.at(-1)).toEqual({
      path: '/small',
      host: `rebind.example:${port}`,
    })
    expect(new TextDecoder().decode(response.body)).toBe('{"ok":true}')
  })
})

describe('bounded bodies', () => {
  test('a chunked body is cut off as soon as it passes the cap', async () => {
    const error = await failure(
      guardedFetch(`http://127.0.0.1:${port}/chunked-huge`, {
        allowAddress: loopbackOnly,
        extraPorts: [port],
        timeoutMs: 5000,
        maxBytes: 4096,
      }),
    )
    expect(error.reason).toBe('too-large')
  })

  test('a declared oversize body is refused without reading it', async () => {
    const error = await failure(
      guardedFetch(`http://127.0.0.1:${port}/declared-huge`, {
        allowAddress: loopbackOnly,
        extraPorts: [port],
        timeoutMs: 5000,
        maxBytes: 64 * 1024,
      }),
    )
    expect(error.reason).toBe('too-large')
  })

  test('redirects come back as data and are never followed', async () => {
    const response = await guardedFetch(`http://127.0.0.1:${port}/redirect`, {
      allowAddress: loopbackOnly,
      extraPorts: [port],
      timeoutMs: 3000,
      maxBytes: 1024,
    })
    expect(response.status).toBe(302)
    expect(response.location).toBe('http://169.254.169.254/latest/meta-data/')
  })

  test('a server that never answers times out', async () => {
    const error = await failure(
      guardedFetch(`http://127.0.0.1:${port}/hang`, {
        allowAddress: loopbackOnly,
        extraPorts: [port],
        timeoutMs: 300,
        maxBytes: 1024,
      }),
    )
    expect(error.reason).toBe('timeout')
  })
})
