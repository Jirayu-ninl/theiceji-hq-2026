import type { FetchLike } from '../src/providers/gdrive'

/**
 * An in-memory stand-in for the slice of Drive API v3 the gdrive provider
 * uses. It records every request and answers the way Google does: folder
 * queries parsed from `q` (with Drive's backslash escaping), multipart and
 * resumable uploads, metadata reads, trash, paging and thumbnails. Anything
 * it doesn't know is a 501 so a test fails loudly instead of passing by luck.
 * `override` lets a test answer first — for errors.
 */

export type Recorded = {
  method: string
  url: URL
  headers: Headers
  text: string
}

export type SimFile = {
  id: string
  name: string
  mimeType: string
  parents: string[]
  trashed: boolean
  bytes: Uint8Array
  appProperties?: Record<string, string>
  md5Checksum?: string
  sha256Checksum?: string
  thumbnailLink?: string
  imageMediaMetadata?: { width: number; height: number }
  videoMediaMetadata?: {
    width: number
    height: number
    durationMillis: string
  }
}

type Session = {
  name: string
  parents: string[]
  mimeType: string
  fileId: string | null
}

export const ROOT = 'root-folder-id'
export const TOKEN = 'ya29.test-token-never-in-messages'
export const FOLDER_MIME = 'application/vnd.google-apps.folder'

const FOLDER_QUERY =
  /^name='((?:[^'\\]|\\.)*)' and '((?:[^'\\]|\\.)*)' in parents and mimeType='application\/vnd\.google-apps\.folder' and trashed=false$/
const CHILDREN_QUERY = /^'((?:[^'\\]|\\.)*)' in parents and trashed=false$/

function unescapeQuery(value: string): string {
  return value.replace(/\\(.)/g, '$1')
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

export function driveError(status: number, reason: string) {
  return json(
    { error: { code: status, message: 'x', errors: [{ reason }] } },
    status,
  )
}

function meta(file: SimFile) {
  const { bytes, parents: _parents, ...rest } = file
  return file.mimeType === FOLDER_MIME
    ? rest
    : {
        ...rest,
        size: String(bytes.byteLength),
        modifiedTime: '2026-09-26T01:02:03.000Z',
      }
}

/** Splits a multipart/related body the way the provider builds it. */
export function parseMultipart(text: string, contentType: string) {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? ''
  const parts = text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const body = part.replace(/^\r\n/, '').replace(/\r\n$/, '')
      const split = body.indexOf('\r\n\r\n')
      return {
        headers: body.slice(0, split),
        body: body.slice(split + 4),
      }
    })
  return { boundary, parts }
}

export function fakeDrive(
  options: {
    override?: (req: Recorded) => Response | undefined
    pageSize?: number
  } = {},
) {
  const files = new Map<string, SimFile>()
  const sessions = new Map<string, Session>()
  const requests: Recorded[] = []
  let seq = 0

  function add(file: Partial<SimFile> & { name: string }): SimFile {
    const full: SimFile = {
      id: `file${++seq}`,
      mimeType: 'application/octet-stream',
      parents: [ROOT],
      trashed: false,
      bytes: new Uint8Array(),
      ...file,
    }
    files.set(full.id, full)
    return full
  }

  function folder(name: string, parent = ROOT): SimFile {
    return add({ name, mimeType: FOLDER_MIME, parents: [parent] })
  }

  /** What the browser's final PUT to the session URL does. */
  function completeSession(uploadId: string, body: string): SimFile {
    const session = sessions.get(uploadId)
    if (!session) throw new Error(`no session ${uploadId}`)
    const file = add({
      name: session.name,
      mimeType: session.mimeType,
      parents: session.parents,
      bytes: new TextEncoder().encode(body),
    })
    session.fileId = file.id
    return file
  }

  function route(req: Recorded): Response {
    const { method, url } = req
    const path = url.pathname
    const params = url.searchParams

    if (url.hostname === 'lh3.googleusercontent.com') {
      return new Response('thumb-bytes', {
        headers: { 'Content-Type': 'image/png' },
      })
    }

    if (path === '/drive/v3/files' && method === 'GET') {
      const q = params.get('q') ?? ''
      const folderQuery = FOLDER_QUERY.exec(q)
      if (folderQuery) {
        const name = unescapeQuery(folderQuery[1] ?? '')
        const parent = unescapeQuery(folderQuery[2] ?? '')
        const found = [...files.values()].filter(
          (f) =>
            f.mimeType === FOLDER_MIME &&
            !f.trashed &&
            f.name === name &&
            f.parents.includes(parent),
        )
        return json({ files: found.slice(0, 1).map((f) => ({ id: f.id })) })
      }
      const children = CHILDREN_QUERY.exec(q)
      if (children) {
        const parent = unescapeQuery(children[1] ?? '')
        const all = [...files.values()]
          .filter((f) => !f.trashed && f.parents.includes(parent))
          .sort(
            (a, b) =>
              Number(b.mimeType === FOLDER_MIME) -
                Number(a.mimeType === FOLDER_MIME) ||
              a.name.localeCompare(b.name),
          )
        const size = options.pageSize ?? Number(params.get('pageSize'))
        const start = Number(params.get('pageToken') ?? 0)
        const page = all.slice(start, start + size)
        const next = start + size < all.length ? String(start + size) : null
        return json({
          files: page.map(meta),
          ...(next ? { nextPageToken: next } : {}),
        })
      }
      return new Response(`unknown q: ${q}`, { status: 501 })
    }

    if (path === '/drive/v3/files' && method === 'POST') {
      const body = JSON.parse(req.text) as {
        name: string
        mimeType: string
        parents: string[]
      }
      const file = add(body)
      return json({ id: file.id })
    }

    if (path === '/upload/drive/v3/files' && method === 'POST') {
      const type = params.get('uploadType')
      if (type === 'multipart') {
        const { parts } = parseMultipart(
          req.text,
          req.headers.get('Content-Type') ?? '',
        )
        const metadata = JSON.parse(parts[0]?.body ?? '{}') as Partial<SimFile>
        const file = add({
          name: metadata.name ?? 'untitled',
          mimeType: metadata.mimeType ?? 'application/octet-stream',
          parents: metadata.parents ?? [ROOT],
          appProperties: metadata.appProperties,
          bytes: new TextEncoder().encode(parts[1]?.body ?? ''),
        })
        return json(meta(file))
      }
      if (type === 'resumable') {
        const body = JSON.parse(req.text) as Session
        const uploadId = `session-${++seq}`
        sessions.set(uploadId, { ...body, fileId: null })
        return new Response(null, {
          status: 200,
          headers: {
            Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}`,
          },
        })
      }
    }

    if (path === '/upload/drive/v3/files' && method === 'PUT') {
      const session = sessions.get(params.get('upload_id') ?? '')
      if (!session) return driveError(404, 'notFound')
      if (!session.fileId) {
        return new Response(null, {
          status: 308,
          headers: { Range: 'bytes=0-99' },
        })
      }
      const file = files.get(session.fileId) as SimFile
      return json({ kind: 'drive#file', id: file.id, name: file.name })
    }

    const upload = /^\/upload\/drive\/v3\/files\/([\w-]+)$/.exec(path)
    if (upload && method === 'PATCH') {
      const file = files.get(upload[1] ?? '')
      if (!file) return driveError(404, 'notFound')
      const { parts } = parseMultipart(
        req.text,
        req.headers.get('Content-Type') ?? '',
      )
      const metadata = JSON.parse(parts[0]?.body ?? '{}') as Partial<SimFile>
      if (metadata.mimeType) file.mimeType = metadata.mimeType
      file.bytes = new TextEncoder().encode(parts[1]?.body ?? '')
      return json(meta(file))
    }

    const one = /^\/drive\/v3\/files\/([\w-]+)$/.exec(path)
    if (one) {
      const file = files.get(one[1] ?? '')
      if (!file) return driveError(404, 'notFound')
      if (method === 'GET' && params.get('alt') === 'media') {
        return new Response(file.bytes.slice(), {
          headers: { 'Content-Type': file.mimeType },
        })
      }
      if (method === 'GET') return json(meta(file))
      if (method === 'PATCH') {
        const body = JSON.parse(req.text) as { trashed?: boolean }
        if (body.trashed) file.trashed = true
        return json({ id: file.id })
      }
    }

    return new Response(`unrouted ${method} ${url}`, { status: 501 })
  }

  const fetch: FetchLike = async (input, init = {}) => {
    const request = new Request(input, init)
    const recorded: Recorded = {
      method: request.method,
      url: new URL(request.url),
      headers: new Headers(init.headers),
      text: await request.text(),
    }
    requests.push(recorded)
    return options.override?.(recorded) ?? route(recorded)
  }

  return { fetch, files, sessions, requests, add, folder, completeSession }
}
