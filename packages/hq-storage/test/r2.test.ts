import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { storageFor } from '../src/provider'
import { StorageError } from '../src/r2'

/**
 * The r2 provider over the unchanged `r2.ts`. R2 env is faked
 * (a made-up account, nothing real), and global fetch is replaced so any
 * request is captured and answered here; nothing reaches the network.
 */

const ENV_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_URL',
  'R2_ENDPOINT',
] as const
const saved = new Map<string, string | undefined>()
const realFetch = globalThis.fetch

type Captured = { method: string; url: URL; headers: Headers }
let captured: Captured[] = []
let answer: (req: Captured) => Response = () =>
  new Response('unexpected request', { status: 599 })

const HOST = '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com'
const HELLO_SHA256 =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

function fakeEnv() {
  process.env.R2_ACCOUNT_ID = '0123456789abcdef0123456789abcdef'
  process.env.R2_ACCESS_KEY_ID = 'test-access-key'
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key'
  process.env.R2_BUCKET = 'hq-test-bucket'
  delete process.env.R2_PUBLIC_URL
  delete process.env.R2_ENDPOINT
}

beforeAll(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key])
  fakeEnv()
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      const req = {
        method: request.method,
        url: new URL(request.url),
        headers: request.headers,
      }
      captured.push(req)
      return answer(req)
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch
})

afterEach(() => {
  captured = []
  answer = () => new Response('unexpected request', { status: 599 })
  fakeEnv()
})

afterAll(() => {
  globalThis.fetch = realFetch
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function failure(work: Promise<unknown>): Promise<StorageError> {
  try {
    await work
  } catch (error) {
    if (error instanceof StorageError) return error
    throw error
  }
  throw new Error('Expected a StorageError.')
}

const OWNER = '0b8e7c1e-1111-4222-8333-944445555666'
const r2 = (ownerId = OWNER) => storageFor('r2', { ownerId })

describe('r2 provider', () => {
  test('prepareUpload presigns a PUT to a key minted from the path, under the owner', async () => {
    const prepared = await r2().prepareUpload({
      path: 'Acme Film/Boards/Hero Shot.PNG',
      mime: 'image/png',
      bytes: 2048,
    })
    expect(prepared.mode).toBe('presigned_put')
    if (prepared.mode !== 'presigned_put') throw new Error('unreachable')
    expect(prepared.key).toMatch(
      new RegExp(
        String.raw`^${OWNER}/acme-film/boards/\d{4}/\d{2}/[0-9a-f]{16}-hero-shot\.png$`,
      ),
    )
    const url = new URL(prepared.url)
    expect(url.host).toBe(HOST)
    expect(url.pathname).toBe(`/hq-test-bucket/${prepared.key}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain(
      'content-length',
    )
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(prepared.headers).toEqual({ 'Content-Type': 'image/png' })
    expect(prepared.expiresAt.getTime()).toBeGreaterThan(Date.now())
    // Signing is local: no request left the process.
    expect(captured).toHaveLength(0)
  })

  test('prepareUpload refuses a path without a folder or a bad size', async () => {
    const noFolder = await failure(
      r2().prepareUpload({ path: 'loose.png', mime: 'image/png', bytes: 1 }),
    )
    expect(noFolder.code).toBe('InvalidPath')
    const badSize = await failure(
      r2().prepareUpload({ path: 'a/b.png', mime: 'image/png', bytes: -1 }),
    )
    expect(badSize.code).toBe('InvalidSize')
  })

  test('accessUrl is a presigned GET with the ttl and an optional filename', async () => {
    const url = new URL(
      await r2().accessUrl('acme/2026/09/abc-x.pdf', 120, {
        filename: 'Quote.pdf',
      }),
    )
    expect(url.host).toBe(HOST)
    expect(url.pathname).toBe('/hq-test-bucket/acme/2026/09/abc-x.pdf')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120')
    expect(url.searchParams.get('response-content-disposition')).toContain(
      'filename="Quote.pdf"',
    )
    expect(captured).toHaveLength(0)
  })

  test('finalize HEADs the key: missing is a 404, present is its info', async () => {
    answer = () => new Response(null, { status: 404 })
    const missing = await failure(r2().finalize('acme/2026/09/abc-x.png'))
    expect(missing.status).toBe(404)
    expect(missing.code).toBe('NotFound')
    expect(captured[0]?.method).toBe('HEAD')

    answer = () =>
      new Response(null, {
        status: 200,
        headers: {
          'Content-Length': '2048',
          'Content-Type': 'image/png',
          ETag: '"abc123"',
          'Last-Modified': 'Sat, 26 Sep 2026 01:02:03 GMT',
          'x-amz-meta-asset': 'a1',
        },
      })
    const info = await r2().finalize('acme/2026/09/abc-x.png')
    expect(info).toMatchObject({
      key: 'acme/2026/09/abc-x.png',
      size: 2048,
      etag: 'abc123',
      contentType: 'image/png',
      metadata: { asset: 'a1' },
    })
    // S3 HEAD reports no SHA-256.
    expect(info.sha256).toBeUndefined()
  })

  test('put writes the body and returns its size and SHA-256', async () => {
    answer = () =>
      new Response(null, { status: 200, headers: { ETag: '"e1"' } })
    const info = await r2().put(null, 'hello', {
      path: 'acme/quotes/q.txt',
      contentType: 'text/plain',
      metadata: { AssetId: 'a1' },
    })
    expect(captured[0]?.method).toBe('PUT')
    expect(captured[0]?.url.pathname).toBe(`/hq-test-bucket/${info.key}`)
    expect(captured[0]?.headers.get('x-amz-meta-assetid')).toBe('a1')
    expect(info).toMatchObject({
      size: 5,
      etag: 'e1',
      contentType: 'text/plain',
      metadata: { assetid: 'a1' },
      sha256: HELLO_SHA256,
    })
    expect(info.key).toMatch(
      new RegExp(
        String.raw`^${OWNER}/acme/quotes/\d{4}/\d{2}/[0-9a-f]{16}-q\.txt$`,
      ),
    )

    const overwrite = await r2().put('fixed/key.txt', 'hello', {})
    expect(overwrite.key).toBe('fixed/key.txt')
  })

  test('list reads one level under the slugged prefix, inside the owner', async () => {
    answer = () =>
      new Response(
        '<ListBucketResult><IsTruncated>false</IsTruncated>' +
          `<CommonPrefixes><Prefix>${OWNER}/acme-film/boards/2026/</Prefix></CommonPrefixes>` +
          '</ListBucketResult>',
        { status: 200 },
      )
    const result = await r2().list('Acme Film/Boards')
    const params = captured[0]?.url.searchParams
    expect(params?.get('prefix')).toBe(`${OWNER}/acme-film/boards/`)
    expect(params?.get('delimiter')).toBe('/')
    expect(result).toEqual({
      objects: [],
      prefixes: [`${OWNER}/acme-film/boards/2026/`],
      cursor: null,
    })
  })

  test('two owners mint the same path under different prefixes', async () => {
    const other = '7d2f0a93-aaaa-4bbb-8ccc-0ddd1eee2fff'
    const spec = { path: 'film/uploads/cut.mp4', mime: 'video/mp4', bytes: 9 }
    const mine = await r2().prepareUpload(spec)
    const theirs = await r2(other).prepareUpload(spec)
    expect(mine.key.startsWith(`${OWNER}/film/uploads/`)).toBe(true)
    expect(theirs.key.startsWith(`${other}/film/uploads/`)).toBe(true)
  })

  test('an empty list prefix is the owner’s top, never the bucket’s', async () => {
    answer = () =>
      new Response(
        '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
        { status: 200 },
      )
    await r2().list('')
    expect(captured[0]?.url.searchParams.get('prefix')).toBe(`${OWNER}/`)
  })

  test('an owner id that is not one clean segment is refused', () => {
    for (const ownerId of ['Owner-1', 'a/b', '../x', 'a b', 'x'.repeat(65)]) {
      let error: unknown
      try {
        r2(ownerId)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(StorageError)
      expect((error as StorageError).code).toBe('InvalidOwner')
    }
  })

  test('a key stored before the owner prefix is still read as it is', async () => {
    answer = () =>
      new Response(null, { status: 200, headers: { 'Content-Length': '3' } })
    const info = await r2().head('hq/film/uploads/2026/09/abc-x.png')
    expect(info?.key).toBe('hq/film/uploads/2026/09/abc-x.png')
    expect(captured[0]?.url.pathname).toBe(
      '/hq-test-bucket/hq/film/uploads/2026/09/abc-x.png',
    )
  })

  test('a call without R2 env is a 503 NotConfigured, as before', async () => {
    delete process.env.R2_BUCKET
    const error = await failure(r2().head('acme/x.png'))
    expect(error.status).toBe(503)
    expect(error.code).toBe('NotConfigured')
    expect(captured).toHaveLength(0)
  })

  test('has no thumbnail method (the worker renders R2 thumbnails)', () => {
    expect(r2().thumbnail).toBeUndefined()
  })
})
