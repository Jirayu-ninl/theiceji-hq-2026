import type {
  PreparedUpload,
  ProviderListResult,
  ProviderObjectInfo,
  StorageProvider,
} from '../provider'
import { StorageError } from '../r2'
import {
  assertBytes,
  assertMime,
  pathSegments,
  sha256Hex,
  splitPath,
  toBytes,
} from './shared'

/**
 * The `gdrive` StorageProvider — Google Drive API v3 over plain fetch, scope
 * `drive.file`: HQ sees only the files and folders it created, never the rest
 * of the owner's Drive. Key = Drive file id.
 *
 * Nothing here knows about HQ's database. The caller injects a
 * `GoogleDriveContext`: an access-token source (HQ mints and caches tokens
 * from the sealed refresh token), the HQ root folder, and a signer for HQ's
 * own content URLs. Build one provider per request or job — the folder cache
 * lives as long as the instance.
 *
 * Folders: an asset path `<project-slug>/<collection>/<filename>` becomes
 * nested folders under `rootFolderId`. Each segment is looked up by name under
 * its parent and created when missing; resolved ids (and in-flight lookups, so
 * two parallel uploads don't make twin folders) are cached.
 *
 * Browser upload (resumable — Drive has no presigned PUT):
 *   1. `prepareUpload({ path, mime, bytes, origin })` opens a session with
 *      `Origin: <browser origin>` and returns its `sessionUrl` plus a pending
 *      key `upload:<bytes>:<upload_id>`.
 *   2. The browser PUTs the bytes to `sessionUrl` (no token; the URL is the
 *      grant, valid a week). Google's final 200/201 carries `{ id }`.
 *   3. `finalize(pendingKey)` asks the session for its status (an empty PUT
 *      whose Content-Range names the total size), which answers with the
 *      file once complete — HQ never has to trust a file id sent by the
 *      client. It also accepts that file id directly. Store `result.key`
 *      (the file id).
 *   `head`/`get`/`delete` accept a pending key too; before completion there
 *   is no file, so they answer null / do nothing.
 *
 * Errors are StorageError: 401 `ReauthRequired` (reconnect Google), 429
 * `RateLimited` (retry later), 507 `DriveFull`, 502 `DriveUnavailable`,
 * 403 for anything else Drive refuses. Messages never carry a token.
 */

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type GoogleDriveContext = {
  /**
   * A live access token with `drive.file`. Called before every request; the
   * caller caches and refreshes, and throws StorageError 401
   * `ReauthRequired` when the refresh token is gone.
   */
  accessToken: () => Promise<string>
  /** The Drive folder HQ created as this owner's HQ root. */
  rootFolderId: string
  /** HQ's own short-lived content URL for a file (`/api/assets/<id>/content?t=…`). */
  accessUrl: (
    key: string,
    ttlSeconds: number,
    options: { filename?: string },
  ) => Promise<string>
  /** Default browser origin for resumable sessions, e.g. `https://hq.example.com`. */
  origin?: string
  /** Injected transport — tests pass a fake. Defaults to global fetch. */
  fetch?: FetchLike
}

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FILE_FIELDS = [
  'id',
  'name',
  'mimeType',
  'size',
  'md5Checksum',
  'sha256Checksum',
  'modifiedTime',
  'trashed',
  'appProperties',
  'thumbnailLink',
  'imageMediaMetadata(width,height)',
  'videoMediaMetadata(width,height,durationMillis)',
].join(',')
const LIST_FIELDS =
  'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)'
/** Drive's limit for a single multipart request; bigger files go resumable. */
const MULTIPART_MAX_BYTES = 5 * 1024 * 1024
/** A resumable session URI stays valid for a week. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PENDING = /^upload:(\d+):(\S+)$/
const FILE_ID = /^[\w-]+$/
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'sharingRateLimitExceeded',
])

type DriveFile = {
  id: string
  name?: string
  mimeType?: string
  /** int64 as a string; absent for Google-native documents. */
  size?: string
  md5Checksum?: string
  sha256Checksum?: string
  modifiedTime?: string
  trashed?: boolean
  appProperties?: Record<string, string>
  /** Short-lived (hours) — always re-read, never store. */
  thumbnailLink?: string
  imageMediaMetadata?: { width?: number; height?: number }
  videoMediaMetadata?: {
    width?: number
    height?: number
    durationMillis?: string
  }
}

type DriveErrorBody = {
  error?: { status?: string; errors?: { reason?: string }[] }
}

/** Drive query strings quote with `'` and escape `\` and `'` by backslash. */
export function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** `…=s220` → `…=s<size>`; only Google hosts ever see the token. */
export function thumbnailUrl(link: string, size: number): string | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  const google =
    url.hostname.endsWith('.googleusercontent.com') ||
    url.hostname.endsWith('.google.com')
  if (url.protocol !== 'https:' || !google) return null
  const px = Math.min(Math.max(Math.floor(size) || 0, 16), 2048)
  const href = url.toString()
  return /=s\d+$/.test(href)
    ? href.replace(/=s\d+$/, `=s${px}`)
    : `${href}=s${px}`
}

function toInfo(file: DriveFile): ProviderObjectInfo {
  const media = file.imageMediaMetadata ?? file.videoMediaMetadata
  const info: ProviderObjectInfo = {
    key: file.id,
    size: Number(file.size ?? 0),
    // S3's single-part ETag is the MD5 too, so the two providers agree.
    etag: file.md5Checksum ?? '',
    lastModified: new Date(file.modifiedTime ?? 0),
    contentType: file.mimeType ?? null,
    metadata: { ...file.appProperties },
  }
  if (file.sha256Checksum) info.sha256 = file.sha256Checksum
  if (file.md5Checksum) info.md5 = file.md5Checksum
  if (file.name !== undefined) info.name = file.name
  if (media?.width !== undefined) info.width = media.width
  if (media?.height !== undefined) info.height = media.height
  if (file.videoMediaMetadata?.durationMillis !== undefined) {
    info.durationMs = Number(file.videoMediaMetadata.durationMillis)
  }
  return info
}

function assertFileId(key: string): string {
  if (!FILE_ID.test(key)) {
    throw new StorageError(
      `Not a Google Drive file id: ${JSON.stringify(key)}.`,
      400,
      'InvalidKey',
    )
  }
  return key
}

async function fail(res: Response, action: string): Promise<never> {
  const text = await res.text().catch(() => '')
  let reason: string | null = null
  try {
    const body = JSON.parse(text) as DriveErrorBody
    reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? null
  } catch {
    // Not JSON — the status alone has to do.
  }
  if (res.status === 401) {
    throw new StorageError(
      'Google Drive refused HQ’s access; reconnect Google in HQ Settings.',
      401,
      'ReauthRequired',
    )
  }
  if (
    res.status === 429 ||
    (res.status === 403 && reason && RATE_LIMIT_REASONS.has(reason))
  ) {
    throw new StorageError(
      `Google Drive is rate limiting HQ (${action}); retry in a minute.`,
      429,
      'RateLimited',
    )
  }
  if (res.status === 403 && reason === 'storageQuotaExceeded') {
    throw new StorageError(
      'The owner’s Google Drive storage is full.',
      507,
      'DriveFull',
    )
  }
  if (res.status === 403) {
    throw new StorageError(
      `Google Drive refused ${action}${reason ? ` (${reason})` : ''}; HQ can only reach files it created.`,
      403,
      reason ?? 'Forbidden',
    )
  }
  if (res.status === 404) {
    throw new StorageError(
      `Google Drive ${action}: file not found.`,
      404,
      'NotFound',
    )
  }
  if (res.status >= 500) {
    throw new StorageError(
      `Google Drive is unavailable (${action}: ${res.status}); retry shortly.`,
      502,
      'DriveUnavailable',
    )
  }
  throw new StorageError(
    `Google Drive ${action} failed: ${res.status}${reason ? ` ${reason}` : ''}.`,
    res.status,
    reason,
  )
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  )
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/** `multipart/related`: a JSON metadata part, then the media part. */
function multipart(
  boundary: string,
  metadata: Record<string, unknown>,
  contentType: string,
  bytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const text = new TextEncoder()
  return concat(
    text.encode(
      `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    text.encode(`\r\n--${boundary}--`),
  )
}

export function createDriveProvider(
  context: GoogleDriveContext,
): StorageProvider {
  const transport: FetchLike =
    context.fetch ?? ((input, init) => fetch(input, init))
  /** Folder path (`a/b`) → id, including lookups still in flight. */
  const folders = new Map<string, Promise<string>>()

  async function drive(url: URL | string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await context.accessToken()}`)
    return transport(url.toString(), { ...init, headers })
  }

  function endpoint(
    base: string,
    path: string,
    params: Record<string, string>,
  ) {
    const url = new URL(`${base}${path}`)
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value)
    }
    return url
  }

  async function findFolder(name: string, parent: string) {
    const q =
      `name='${escapeQuery(name)}' and '${escapeQuery(parent)}' in parents` +
      ` and mimeType='${FOLDER_MIME}' and trashed=false`
    const res = await drive(
      endpoint(API, '/files', {
        q,
        fields: 'files(id)',
        orderBy: 'createdTime',
        pageSize: '1',
      }),
    )
    if (!res.ok) return fail(res, 'folder lookup')
    const body = (await res.json()) as { files?: { id: string }[] }
    return body.files?.[0]?.id ?? null
  }

  async function createFolder(name: string, parent: string) {
    const res = await drive(endpoint(API, '/files', { fields: 'id' }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
    })
    if (!res.ok) return fail(res, 'folder create')
    return ((await res.json()) as { id: string }).id
  }

  /** The folder for `segments` under the root; null when missing and !create. */
  async function folderFor(
    segments: string[],
    create: boolean,
  ): Promise<string | null> {
    let parent = context.rootFolderId
    for (let depth = 1; depth <= segments.length; depth++) {
      const path = segments.slice(0, depth).join('/')
      const name = segments[depth - 1] as string
      let pending = folders.get(path)
      if (!pending) {
        const under = parent
        if (create) {
          pending = findFolder(name, under).then(
            (id) => id ?? createFolder(name, under),
          )
        } else {
          const id = await findFolder(name, under)
          if (!id) return null
          pending = folders.get(path) ?? Promise.resolve(id)
        }
        const cached = pending
        folders.set(path, cached)
        cached.catch(() => {
          if (folders.get(path) === cached) folders.delete(path)
        })
      }
      parent = await pending
    }
    return parent
  }

  async function readFile(fileId: string): Promise<DriveFile | null> {
    const res = await drive(
      endpoint(API, `/files/${fileId}`, { fields: FILE_FIELDS }),
    )
    if (res.status === 404) {
      await res.body?.cancel()
      return null
    }
    if (!res.ok) return fail(res, 'metadata read')
    const file = (await res.json()) as DriveFile
    return file.trashed ? null : file
  }

  /** The finished file behind a pending upload key; throws while unfinished. */
  async function completedUpload(key: string): Promise<string> {
    const match = PENDING.exec(key)
    if (!match) return assertFileId(key)
    const res = await drive(
      endpoint(UPLOAD, '/files', {
        uploadType: 'resumable',
        upload_id: match[2] ?? '',
      }),
      { method: 'PUT', headers: { 'Content-Range': `bytes */${match[1]}` } },
    )
    if (res.status === 200 || res.status === 201) {
      return assertFileId(((await res.json()) as { id: string }).id)
    }
    await res.body?.cancel()
    if (res.status === 308) {
      throw new StorageError(
        'The Google Drive upload is not complete yet.',
        409,
        'UploadIncomplete',
      )
    }
    if (res.status === 404 || res.status === 410) {
      throw new StorageError(
        'The Google Drive upload session expired or never existed.',
        404,
        'UploadNotFound',
      )
    }
    return fail(res, 'upload status')
  }

  /** File id for any key, or null when a pending upload has no file yet. */
  async function fileIdOf(key: string): Promise<string | null> {
    if (!PENDING.test(key)) return assertFileId(key)
    try {
      return await completedUpload(key)
    } catch (error) {
      const code = error instanceof StorageError ? error.code : null
      if (code === 'UploadIncomplete' || code === 'UploadNotFound') return null
      throw error
    }
  }

  return {
    id: 'gdrive',

    async put(key, body, options) {
      const bytes = await toBytes(body)
      if (bytes.byteLength > MULTIPART_MAX_BYTES) {
        throw new StorageError(
          'Google Drive takes at most 5 MB in one request; use prepareUpload.',
          413,
          'TooLarge',
        )
      }
      const contentType = assertMime(
        options.contentType ?? 'application/octet-stream',
      )
      const metadata: Record<string, unknown> = { mimeType: contentType }
      if (options.metadata && Object.keys(options.metadata).length > 0) {
        // Private to HQ's OAuth client; Drive has no Cache-Control or
        // Content-Disposition, so those options don't apply here.
        metadata.appProperties = options.metadata
      }
      let url: URL
      let method: 'POST' | 'PATCH'
      if (key === null) {
        const { folders: path, name } = splitPath(options.path)
        metadata.name = name
        metadata.parents = [await folderFor(path, true)]
        url = endpoint(UPLOAD, '/files', {
          uploadType: 'multipart',
          fields: FILE_FIELDS,
        })
        method = 'POST'
      } else {
        url = endpoint(UPLOAD, `/files/${assertFileId(key)}`, {
          uploadType: 'multipart',
          fields: FILE_FIELDS,
        })
        method = 'PATCH'
      }
      const boundary = `hq-${crypto.randomUUID()}`
      const res = await drive(url, {
        method,
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipart(boundary, metadata, contentType, bytes),
      })
      if (!res.ok) return fail(res, 'upload')
      const info = toInfo((await res.json()) as DriveFile)
      return { ...info, sha256: info.sha256 ?? (await sha256Hex(bytes)) }
    },

    /** A trashed file still downloads; `head` is the existence check. */
    async get(key) {
      const fileId = await fileIdOf(key)
      if (!fileId) return null
      const res = await drive(
        endpoint(API, `/files/${fileId}`, { alt: 'media' }),
      )
      if (res.status === 404) {
        await res.body?.cancel()
        return null
      }
      if (!res.ok) return fail(res, 'download')
      return res
    },

    async head(key) {
      const fileId = await fileIdOf(key)
      if (!fileId) return null
      const file = await readFile(fileId)
      return file ? toInfo(file) : null
    },

    /**
     * Trash, never a permanent delete: the owner can restore the file from
     * Drive's trash for 30 days. Missing or already-trashed files succeed.
     */
    async delete(key) {
      const fileId = await fileIdOf(key)
      if (!fileId) return
      const res = await drive(
        endpoint(API, `/files/${fileId}`, { fields: 'id' }),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ trashed: true }),
        },
      )
      if (res.status === 404) {
        await res.body?.cancel()
        return
      }
      if (!res.ok) return fail(res, 'trash')
      await res.body?.cancel()
    },

    async list(prefix, cursor): Promise<ProviderListResult> {
      const segments = pathSegments(prefix)
      const folderId = await folderFor(segments, false)
      if (!folderId) return { objects: [], prefixes: [], cursor: null }
      const params: Record<string, string> = {
        q: `'${escapeQuery(folderId)}' in parents and trashed=false`,
        fields: LIST_FIELDS,
        orderBy: 'folder,name',
        pageSize: '1000',
      }
      if (cursor) params.pageToken = cursor
      const res = await drive(endpoint(API, '/files', params))
      if (!res.ok) return fail(res, 'list')
      const body = (await res.json()) as {
        nextPageToken?: string
        files?: DriveFile[]
      }
      const files = body.files ?? []
      const base = segments.length > 0 ? `${segments.join('/')}/` : ''
      return {
        objects: files
          .filter((file) => file.mimeType !== FOLDER_MIME)
          .map((file) => ({
            key: file.id,
            size: Number(file.size ?? 0),
            etag: file.md5Checksum ?? '',
            lastModified: new Date(file.modifiedTime ?? 0),
            name: file.name ?? '',
            contentType: file.mimeType ?? null,
          })),
        prefixes: files
          .filter((file) => file.mimeType === FOLDER_MIME)
          .map((file) => `${base}${file.name ?? file.id}/`),
        cursor: body.nextPageToken ?? null,
      }
    },

    async prepareUpload(spec): Promise<PreparedUpload> {
      const contentType = assertMime(spec.mime)
      const bytes = assertBytes(spec.bytes)
      const { folders: path, name } = splitPath(spec.path)
      const parent = await folderFor(path, true)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(bytes),
      }
      // Google binds the session's CORS answer to this Origin; without it a
      // browser's PUT to the session URL fails its preflight.
      const origin = spec.origin ?? context.origin
      if (origin) headers.Origin = origin
      const res = await drive(
        endpoint(UPLOAD, '/files', { uploadType: 'resumable' }),
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name,
            parents: [parent],
            mimeType: contentType,
          }),
        },
      )
      if (!res.ok) return fail(res, 'upload session')
      await res.body?.cancel()
      const location = res.headers.get('Location')
      let uploadId: string | null = null
      try {
        const session = new URL(location ?? '')
        if (
          session.protocol === 'https:' &&
          session.hostname.endsWith('googleapis.com')
        ) {
          uploadId = session.searchParams.get('upload_id')
        }
      } catch {
        // Handled below.
      }
      if (!location || !uploadId) {
        throw new StorageError(
          'Google Drive opened no usable upload session.',
          502,
          'DriveUnavailable',
        )
      }
      return {
        mode: 'resumable',
        sessionUrl: location,
        key: `upload:${bytes}:${uploadId}`,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      }
    },

    async finalize(key) {
      const file = await readFile(await completedUpload(key))
      if (!file) {
        throw new StorageError(
          'The uploaded file is missing from Google Drive.',
          404,
          'NotFound',
        )
      }
      return toInfo(file)
    },

    accessUrl: (key, ttlSeconds, options = {}) =>
      context.accessUrl(key, ttlSeconds, options),

    /** `thumbnailLink` expires within hours, so it's re-read on every call. */
    async thumbnail(key, size) {
      const fileId = await fileIdOf(key)
      if (!fileId) return null
      const file = await readFile(fileId)
      const url = file?.thumbnailLink
        ? thumbnailUrl(file.thumbnailLink, size)
        : null
      if (!url) return null
      const res = await drive(url)
      if (res.status === 404) {
        await res.body?.cancel()
        return null
      }
      if (!res.ok) return fail(res, 'thumbnail')
      return res
    },
  }
}
