import { describe, expect, test } from 'bun:test'
import {
  createDriveProvider,
  escapeQuery,
  type GoogleDriveContext,
  thumbnailUrl,
} from '../src/providers/gdrive'
import { StorageError } from '../src/r2'
import {
  driveError,
  FOLDER_MIME,
  fakeDrive,
  parseMultipart,
  type Recorded,
  ROOT,
  TOKEN,
} from './fake-drive'

/**
 * The gdrive provider against an in-memory Drive (no network,
 * no Google account). Each test builds its own fake so request logs start
 * empty.
 */

type Fake = ReturnType<typeof fakeDrive>

const HELLO_SHA256 =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

function provider(fake: Fake, extra: Partial<GoogleDriveContext> = {}) {
  return createDriveProvider({
    accessToken: async () => TOKEN,
    rootFolderId: ROOT,
    accessUrl: async (key, ttl, options) =>
      `https://hq.example.test/api/assets/${key}/content?t=signed-${ttl}${options.filename ? `&f=${options.filename}` : ''}`,
    fetch: fake.fetch,
    ...extra,
  })
}

async function failure(work: Promise<unknown>): Promise<StorageError> {
  try {
    await work
  } catch (error) {
    if (error instanceof StorageError) return error
    throw error
  }
  throw new Error('Expected a StorageError.')
}

function folderCreates(fake: Fake): Recorded[] {
  return fake.requests.filter(
    (r) => r.method === 'POST' && r.url.pathname === '/drive/v3/files',
  )
}

function folderLookups(fake: Fake): Recorded[] {
  return fake.requests.filter(
    (r) =>
      r.method === 'GET' &&
      r.url.pathname === '/drive/v3/files' &&
      r.url.searchParams.get('q')?.startsWith('name='),
  )
}

describe('folders', () => {
  test('resolves each path segment by name, creates what is missing, caches ids', async () => {
    const fake = fakeDrive()
    const drive = provider(fake)

    const first = await drive.put(null, 'hello', {
      path: 'acme-film/boards/brief.txt',
      contentType: 'text/plain',
    })
    expect(folderLookups(fake).map((r) => r.url.searchParams.get('q'))).toEqual(
      [
        `name='acme-film' and '${ROOT}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
        `name='boards' and '${fake.files.get('file1')?.id}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
      ],
    )
    expect(folderCreates(fake).map((r) => JSON.parse(r.text))).toEqual([
      { name: 'acme-film', mimeType: FOLDER_MIME, parents: [ROOT] },
      { name: 'boards', mimeType: FOLDER_MIME, parents: ['file1'] },
    ])
    expect(fake.files.get(first.key)?.parents).toEqual(['file2'])

    // Same instance: both folders come from the cache — one request only.
    const before = fake.requests.length
    await drive.put(null, 'again', { path: 'acme-film/boards/second.txt' })
    expect(fake.requests.length - before).toBe(1)

    // A fresh instance finds the existing folders and creates none.
    const again = provider(fake)
    await again.put(null, 'third', { path: 'acme-film/boards/third.txt' })
    expect(folderCreates(fake)).toHaveLength(2)
    expect(folderLookups(fake)).toHaveLength(4)
  })

  test('parallel uploads into a new folder create it once', async () => {
    const fake = fakeDrive()
    const drive = provider(fake)
    await Promise.all([
      drive.put(null, 'a', { path: 'studio/renders/a.txt' }),
      drive.put(null, 'b', { path: 'studio/renders/b.txt' }),
      drive.put(null, 'c', { path: 'studio/renders/c.txt' }),
    ])
    expect(folderCreates(fake)).toHaveLength(2)
    const parents = [...fake.files.values()]
      .filter((f) => f.mimeType !== FOLDER_MIME)
      .map((f) => f.parents[0])
    expect(new Set(parents).size).toBe(1)
  })

  test('escapes quotes and backslashes in folder queries', async () => {
    expect(escapeQuery(`O'Brien\\Co`)).toBe(`O\\'Brien\\\\Co`)
    const fake = fakeDrive()
    await provider(fake).put(null, 'x', { path: `O'Brien\\Co/x.txt` })
    expect(folderLookups(fake)[0]?.url.searchParams.get('q')).toStartWith(
      `name='O\\'Brien\\\\Co' and`,
    )
    // The fake unescapes like Drive, so a second instance finds that folder.
    await provider(fake).put(null, 'y', { path: `O'Brien\\Co/y.txt` })
    expect(folderCreates(fake)).toHaveLength(1)
  })

  test('refuses paths that climb out of the root', async () => {
    const fake = fakeDrive()
    const error = await failure(
      provider(fake).put(null, 'x', { path: 'acme/../escape.txt' }),
    )
    expect(error.status).toBe(400)
    expect(error.code).toBe('InvalidPath')
    expect(fake.requests).toHaveLength(0)
  })
})

describe('put (multipart)', () => {
  test('sends metadata then media as multipart/related and returns the stored file', async () => {
    const fake = fakeDrive()
    const drive = provider(fake)
    const info = await drive.put(null, 'hello', {
      path: 'acme-film/quotes/ใบเสนอราคา Q-2026-001.pdf',
      contentType: 'application/pdf',
      metadata: { assetId: 'a1' },
    })
    const upload = fake.requests.at(-1) as Recorded
    expect(upload.method).toBe('POST')
    expect(upload.url.origin + upload.url.pathname).toBe(
      'https://www.googleapis.com/upload/drive/v3/files',
    )
    expect(upload.url.searchParams.get('uploadType')).toBe('multipart')
    expect(upload.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    const contentType = upload.headers.get('Content-Type') ?? ''
    expect(contentType).toMatch(/^multipart\/related; boundary=hq-[\w-]+$/)

    const { boundary, parts } = parseMultipart(upload.text, contentType)
    const metadata = JSON.stringify({
      mimeType: 'application/pdf',
      appProperties: { assetId: 'a1' },
      name: 'ใบเสนอราคา Q-2026-001.pdf',
      parents: ['file2'],
    })
    expect(upload.text).toBe(
      `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        `${metadata}\r\n` +
        `--${boundary}\r\n` +
        'Content-Type: application/pdf\r\n\r\n' +
        'hello\r\n' +
        `--${boundary}--`,
    )
    expect(parts).toHaveLength(2)

    expect(info).toMatchObject({
      key: 'file3',
      name: 'ใบเสนอราคา Q-2026-001.pdf',
      size: 5,
      contentType: 'application/pdf',
      metadata: { assetId: 'a1' },
      sha256: HELLO_SHA256,
    })
    expect(new TextDecoder().decode(fake.files.get('file3')?.bytes)).toBe(
      'hello',
    )
  })

  test('with a key, replaces that file’s content in place', async () => {
    const fake = fakeDrive()
    const existing = fake.add({
      name: 'quote.pdf',
      mimeType: 'application/pdf',
    })
    const info = await provider(fake).put(existing.id, 'v2', {
      contentType: 'application/pdf',
    })
    const upload = fake.requests.at(-1) as Recorded
    expect(upload.method).toBe('PATCH')
    expect(upload.url.pathname).toBe(`/upload/drive/v3/files/${existing.id}`)
    const { parts } = parseMultipart(
      upload.text,
      upload.headers.get('Content-Type') ?? '',
    )
    expect(JSON.parse(parts[0]?.body ?? '')).toEqual({
      mimeType: 'application/pdf',
    })
    expect(info.key).toBe(existing.id)
    expect(info.size).toBe(2)
  })

  test('refuses bodies over 5 MB before any request', async () => {
    const fake = fakeDrive()
    const error = await failure(
      provider(fake).put(null, new Uint8Array(5 * 1024 * 1024 + 1), {
        path: 'a/big.bin',
      }),
    )
    expect(error.status).toBe(413)
    expect(error.code).toBe('TooLarge')
    expect(fake.requests).toHaveLength(0)
  })

  test('a new file needs a path', async () => {
    const error = await failure(provider(fakeDrive()).put(null, 'x', {}))
    expect(error.code).toBe('InvalidPath')
  })
})

describe('resumable upload + finalize', () => {
  test('opens the session with the browser Origin and parses Location', async () => {
    const fake = fakeDrive()
    const drive = provider(fake, { origin: 'https://context.example.test' })
    const prepared = await drive.prepareUpload({
      path: 'acme-film/renders/final cut.mp4',
      mime: 'video/mp4',
      bytes: 1234,
      origin: 'https://hq.example.test',
    })
    const session = fake.requests.at(-1) as Recorded
    expect(session.method).toBe('POST')
    expect(session.url.pathname).toBe('/upload/drive/v3/files')
    expect(session.url.searchParams.get('uploadType')).toBe('resumable')
    expect(session.headers.get('Origin')).toBe('https://hq.example.test')
    expect(session.headers.get('X-Upload-Content-Type')).toBe('video/mp4')
    expect(session.headers.get('X-Upload-Content-Length')).toBe('1234')
    expect(session.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(session.text)).toEqual({
      name: 'final cut.mp4',
      parents: ['file2'],
      mimeType: 'video/mp4',
    })

    const uploadId = [...fake.sessions.keys()][0] as string
    expect(prepared).toMatchObject({
      mode: 'resumable',
      sessionUrl: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}`,
      key: `upload:1234:${uploadId}`,
    })
    if (prepared.mode !== 'resumable') throw new Error('unreachable')
    const days = (prepared.expiresAt.getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThanOrEqual(7)
  })

  test('falls back to the context origin, and sends none when neither is set', async () => {
    const fake = fakeDrive()
    const spec = { path: 'a/b.png', mime: 'image/png', bytes: 1 }
    await provider(fake, {
      origin: 'https://context.example.test',
    }).prepareUpload(spec)
    expect(fake.requests.at(-1)?.headers.get('Origin')).toBe(
      'https://context.example.test',
    )
    await provider(fake).prepareUpload(spec)
    expect(fake.requests.at(-1)?.headers.has('Origin')).toBe(false)
  })

  test('a session answer without Location is an upstream failure', async () => {
    const fake = fakeDrive({
      override: (req) =>
        req.url.searchParams.get('uploadType') === 'resumable'
          ? new Response(null, { status: 200 })
          : undefined,
    })
    const error = await failure(
      provider(fake).prepareUpload({
        path: 'a/b.png',
        mime: 'image/png',
        bytes: 1,
      }),
    )
    expect(error.status).toBe(502)
  })

  test('finalize resolves the pending key through the session status', async () => {
    const fake = fakeDrive()
    const drive = provider(fake)
    const prepared = await drive.prepareUpload({
      path: 'acme-film/renders/cut.mp4',
      mime: 'video/mp4',
      bytes: 5,
    })
    const uploadId = [...fake.sessions.keys()][0] as string

    // Before the browser finishes: not complete, no file behind the key.
    const early = await failure(drive.finalize(prepared.key))
    expect(early.status).toBe(409)
    expect(early.code).toBe('UploadIncomplete')
    const status = fake.requests.at(-1) as Recorded
    expect(status.method).toBe('PUT')
    expect(status.url.searchParams.get('upload_id')).toBe(uploadId)
    expect(status.headers.get('Content-Range')).toBe('bytes */5')
    expect(status.text).toBe('')
    expect(await drive.head(prepared.key)).toBeNull()
    expect(await drive.get(prepared.key)).toBeNull()

    const file = fake.completeSession(uploadId, 'hello')
    const info = await drive.finalize(prepared.key)
    expect(info).toMatchObject({
      key: file.id,
      name: 'cut.mp4',
      size: 5,
      contentType: 'video/mp4',
    })
    // The file id Google handed the browser works as well.
    expect((await drive.finalize(file.id)).key).toBe(file.id)
  })

  test('finalize reports an unknown session and a trashed file as not found', async () => {
    const fake = fakeDrive()
    const drive = provider(fake)
    const lost = await failure(drive.finalize('upload:10:no-such-session'))
    expect(lost.status).toBe(404)
    expect(lost.code).toBe('UploadNotFound')

    const trashed = fake.add({ name: 'gone.png', trashed: true })
    const gone = await failure(drive.finalize(trashed.id))
    expect(gone.status).toBe(404)
    expect(gone.code).toBe('NotFound')
  })
})

describe('reads', () => {
  test('head maps Drive metadata: string sizes to numbers, media dimensions', async () => {
    const fake = fakeDrive()
    const image = fake.add({
      name: 'hero.png',
      mimeType: 'image/png',
      bytes: new Uint8Array(2048),
      md5Checksum: 'd41d8cd98f00b204e9800998ecf8427e',
      sha256Checksum: 'ab'.repeat(32),
      appProperties: { assetId: 'a9' },
      imageMediaMetadata: { width: 1920, height: 1080 },
    })
    const video = fake.add({
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      videoMediaMetadata: {
        width: 1080,
        height: 1920,
        durationMillis: '15500',
      },
    })
    const drive = provider(fake)

    const info = await drive.head(image.id)
    expect(info).toEqual({
      key: image.id,
      size: 2048,
      etag: 'd41d8cd98f00b204e9800998ecf8427e',
      lastModified: new Date('2026-09-26T01:02:03.000Z'),
      contentType: 'image/png',
      metadata: { assetId: 'a9' },
      sha256: 'ab'.repeat(32),
      md5: 'd41d8cd98f00b204e9800998ecf8427e',
      name: 'hero.png',
      width: 1920,
      height: 1080,
    })
    const fields = fake.requests.at(-1)?.url.searchParams.get('fields') ?? ''
    for (const field of [
      'size',
      'md5Checksum',
      'sha256Checksum',
      'trashed',
      'thumbnailLink',
      'imageMediaMetadata(width,height)',
      'videoMediaMetadata(width,height,durationMillis)',
    ]) {
      expect(fields).toContain(field)
    }

    expect(await drive.head(video.id)).toMatchObject({
      width: 1080,
      height: 1920,
      durationMs: 15500,
    })
  })

  test('head is null for a trashed or missing file', async () => {
    const fake = fakeDrive()
    const trashed = fake.add({ name: 'old.png', trashed: true })
    const drive = provider(fake)
    expect(await drive.head(trashed.id)).toBeNull()
    expect(await drive.head('missingFileId')).toBeNull()
  })

  test('get streams alt=media and is null when missing', async () => {
    const fake = fakeDrive()
    const file = fake.add({
      name: 'a.txt',
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode('stream me'),
    })
    const drive = provider(fake)
    const res = await drive.get(file.id)
    expect(fake.requests.at(-1)?.url.searchParams.get('alt')).toBe('media')
    expect(await res?.text()).toBe('stream me')
    expect(await drive.get('missingFileId')).toBeNull()
  })

  test('refuses keys that are not Drive file ids', async () => {
    const fake = fakeDrive()
    const error = await failure(provider(fake).head('../../files'))
    expect(error.status).toBe(400)
    expect(error.code).toBe('InvalidKey')
    expect(fake.requests).toHaveLength(0)
  })

  test('accessUrl delegates to HQ’s signer', async () => {
    const drive = provider(fakeDrive())
    expect(await drive.accessUrl('file7', 60, { filename: 'q.pdf' })).toBe(
      'https://hq.example.test/api/assets/file7/content?t=signed-60&f=q.pdf',
    )
  })
})

describe('delete', () => {
  test('moves the file to trash with PATCH and never deletes it', async () => {
    const fake = fakeDrive()
    const file = fake.add({ name: 'draft.png' })
    await provider(fake).delete(file.id)
    const trash = fake.requests.at(-1) as Recorded
    expect(trash.method).toBe('PATCH')
    expect(trash.url.pathname).toBe(`/drive/v3/files/${file.id}`)
    expect(JSON.parse(trash.text)).toEqual({ trashed: true })
    expect(fake.files.get(file.id)?.trashed).toBe(true)
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false)
  })

  test('is idempotent for missing files and unfinished uploads', async () => {
    const fake = fakeDrive()
    const drive = provider(fake)
    await drive.delete('missingFileId')
    const prepared = await drive.prepareUpload({
      path: 'a/b.png',
      mime: 'image/png',
      bytes: 3,
    })
    await drive.delete(prepared.key)
    expect(fake.requests.at(-1)?.method).toBe('PUT')
  })
})

describe('list', () => {
  test('pages through one folder: files as objects, subfolders as prefixes', async () => {
    const fake = fakeDrive({ pageSize: 2 })
    const acme = fake.folder('acme-film')
    const boards = fake.folder('boards', acme.id)
    fake.folder('sketches', boards.id)
    fake.add({ name: 'a.png', mimeType: 'image/png', parents: [boards.id] })
    fake.add({ name: 'b.png', mimeType: 'image/png', parents: [boards.id] })
    fake.add({ name: 'c.png', parents: [boards.id], trashed: true })
    const drive = provider(fake)

    const first = await drive.list('acme-film/boards')
    const request = fake.requests.at(-1) as Recorded
    expect(request.url.searchParams.get('q')).toBe(
      `'${boards.id}' in parents and trashed=false`,
    )
    expect(request.url.searchParams.has('pageToken')).toBe(false)
    expect(first.prefixes).toEqual(['acme-film/boards/sketches/'])
    expect(first.objects.map((o) => o.name)).toEqual(['a.png'])
    expect(first.cursor).toBe('2')

    const second = await drive.list('acme-film/boards', first.cursor)
    expect(fake.requests.at(-1)?.url.searchParams.get('pageToken')).toBe('2')
    expect(second.objects).toMatchObject([
      { name: 'b.png', size: 0, contentType: 'image/png' },
    ])
    expect(second.prefixes).toEqual([])
    expect(second.cursor).toBeNull()
  })

  test('a missing folder is an empty listing and is not created', async () => {
    const fake = fakeDrive()
    expect(await provider(fake).list('nobody/here')).toEqual({
      objects: [],
      prefixes: [],
      cursor: null,
    })
    expect(folderCreates(fake)).toHaveLength(0)
  })
})

describe('thumbnail', () => {
  test('re-reads thumbnailLink and rewrites its size with the bearer token', async () => {
    const fake = fakeDrive()
    const file = fake.add({
      name: 'hero.png',
      thumbnailLink: 'https://lh3.googleusercontent.com/drive-storage/AbC=s220',
    })
    const drive = provider(fake)
    const res = await drive.thumbnail?.(file.id, 640)
    const request = fake.requests.at(-1) as Recorded
    expect(request.url.toString()).toBe(
      'https://lh3.googleusercontent.com/drive-storage/AbC=s640',
    )
    expect(request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(await res?.text()).toBe('thumb-bytes')
    // No cached link: the metadata read happens every time.
    await drive.thumbnail?.(file.id, 64)
    expect(
      fake.requests.filter(
        (r) => r.url.pathname === `/drive/v3/files/${file.id}`,
      ),
    ).toHaveLength(2)
  })

  test('never sends the token to a non-Google thumbnail host', async () => {
    const fake = fakeDrive()
    const file = fake.add({
      name: 'x.png',
      thumbnailLink: 'https://evil.example.test/t=s220',
    })
    expect(await provider(fake).thumbnail?.(file.id, 100)).toBeNull()
    expect(fake.requests.at(-1)?.url.hostname).toBe('www.googleapis.com')
  })

  test('thumbnailUrl rewrites or appends the size and clamps it', () => {
    const base = 'https://lh3.googleusercontent.com/d/x'
    expect(thumbnailUrl(`${base}=s220`, 400)).toBe(`${base}=s400`)
    expect(thumbnailUrl(base, 400)).toBe(`${base}=s400`)
    expect(thumbnailUrl(`${base}=s220`, 99_999)).toBe(`${base}=s2048`)
    expect(thumbnailUrl('http://lh3.googleusercontent.com/x', 400)).toBeNull()
    expect(thumbnailUrl('not a url', 400)).toBeNull()
  })
})

describe('error mapping', () => {
  function failing(response: () => Response) {
    return provider(fakeDrive({ override: () => response() }))
  }

  test('401 means reconnect Google, and the message carries no token', async () => {
    const error = await failure(
      failing(() => driveError(401, 'authError')).head('file1'),
    )
    expect(error.status).toBe(401)
    expect(error.code).toBe('ReauthRequired')
    expect(error.message).toContain('reconnect Google')
    expect(error.message).not.toContain(TOKEN)
  })

  test('403 rate limits become a retryable 429', async () => {
    for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded']) {
      const error = await failure(
        failing(() => driveError(403, reason)).list(''),
      )
      expect(error.status).toBe(429)
      expect(error.code).toBe('RateLimited')
    }
    const error = await failure(
      failing(() => new Response('slow down', { status: 429 })).head('file1'),
    )
    expect(error.code).toBe('RateLimited')
  })

  test('a full Drive, other refusals and outages stay distinct', async () => {
    const full = await failure(
      failing(() => driveError(403, 'storageQuotaExceeded')).put(null, 'x', {
        path: 'a/b.txt',
      }),
    )
    expect(full.status).toBe(507)
    expect(full.code).toBe('DriveFull')

    const denied = await failure(
      failing(() => driveError(403, 'appNotAuthorizedToFile')).head('file1'),
    )
    expect(denied.status).toBe(403)
    expect(denied.code).toBe('appNotAuthorizedToFile')

    const down = await failure(
      failing(() => new Response('oops', { status: 503 })).head('file1'),
    )
    expect(down.status).toBe(502)
    expect(down.code).toBe('DriveUnavailable')
  })
})
