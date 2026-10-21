import { describe, expect, test } from 'bun:test'
import { SESSION_COOKIE } from '@theiceji/hq-auth/constants'
import { NextRequest } from 'next/server'
import { HOME_COOKIE } from '../src/lib/prefs'
import { proxy } from '../src/proxy'

/**
 * `src/proxy.ts` — the fast bounce in front of every page (not the gate:
 * `requireUser()` is). What `/` answers depends on the session cookie: the
 * landing in place when there is none, Home when
 * there is one. Everything else keeps the old bounce to sign in.
 */

const ORIGIN = 'http://localhost:8990'

function ask(
  path: string,
  {
    method = 'GET',
    session = false,
    home,
    document = true,
  }: {
    method?: string
    session?: boolean
    home?: string
    document?: boolean
  } = {},
) {
  const cookies = [
    session ? `${SESSION_COOKIE}=token` : null,
    home ? `${HOME_COOKIE}=${home}` : null,
  ].filter(Boolean)
  const headers = new Headers()
  if (cookies.length) headers.set('cookie', cookies.join('; '))
  if (document) headers.set('sec-fetch-dest', 'document')
  return proxy(new NextRequest(`${ORIGIN}${path}`, { method, headers }))
}

const rewrittenTo = (response: Response) => {
  const to = response.headers.get('x-middleware-rewrite')
  return to ? new URL(to).pathname : null
}
const redirectedTo = (response: Response) => {
  const to = response.headers.get('location')
  if (!to) return null
  const url = new URL(to)
  return `${url.pathname}${url.search}`
}

describe('signed out', () => {
  test('`/` is the landing, served in place', async () => {
    const response = await ask('/')
    expect(response.status).toBe(200)
    expect(rewrittenTo(response)).toBe('/landing')
    expect(redirectedTo(response)).toBeNull()
  })

  test('a HEAD of `/` and a fetch without Sec-Fetch-Dest get it too', async () => {
    expect(rewrittenTo(await ask('/', { method: 'HEAD' }))).toBe('/landing')
    expect(rewrittenTo(await ask('/', { document: false }))).toBe('/landing')
  })

  test('a view of Home still goes to sign in and comes back to it', async () => {
    const response = await ask('/?view=state')
    expect(response.status).toBe(307)
    expect(redirectedTo(response)).toBe('/login?next=%2F%3Fview%3Dstate')
  })

  test('a POST to `/` is not the landing', async () => {
    const response = await ask('/', { method: 'POST' })
    expect(rewrittenTo(response)).toBeNull()
    expect(redirectedTo(response)).toBe('/login')
  })

  test('any other page still goes to sign in', async () => {
    expect(redirectedTo(await ask('/inbox'))).toBe('/login?next=%2Finbox')
    expect(redirectedTo(await ask('/p/client-work/board'))).toBe(
      '/login?next=%2Fp%2Fclient-work%2Fboard',
    )
  })

  test('an API call gets a 401 it can read', async () => {
    const response = await ask('/api/palette', { document: false })
    expect(response.status).toBe(401)
  })

  test('sign in itself is public', async () => {
    const response = await ask('/login')
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })
})

describe('signed in', () => {
  test('`/` is Home, never the landing', async () => {
    const response = await ask('/', { session: true })
    expect(rewrittenTo(response)).toBeNull()
    expect(redirectedTo(response)).toBeNull()
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  test('opening `/` still follows the Home view this browser opens on', async () => {
    const response = await ask('/', { session: true, home: 'state' })
    expect(redirectedTo(response)).toBe('/?view=state')
  })
})

describe('`/landing` is not an address', () => {
  test('it redirects to `/`, signed out or in', async () => {
    for (const session of [false, true]) {
      const response = await ask('/landing', { session })
      expect(response.status).toBe(307)
      expect(redirectedTo(response)).toBe('/')
    }
    expect(redirectedTo(await ask('/landing?x=1'))).toBe('/')
  })
})
