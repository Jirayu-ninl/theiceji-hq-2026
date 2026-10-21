import { AwsClient } from 'aws4fetch'
import { type StorageConfig, storageConfig } from './config'
import { assertKey } from './keys'

/**
 * R2 through its S3 API, signed by aws4fetch (SigV4 on WebCrypto + fetch — a
 * few kB where the AWS SDK is megabytes). Path-style: `<endpoint>/<bucket>/<key>`.
 *
 * Every call throws `StorageError`; status 503 means env is incomplete, so a
 * route can pass it straight through. Check `storageReadiness()` first when a
 * page should say "not configured" instead.
 *
 * Bodies are buffered types (string, bytes, Blob) because a retried request
 * replays its body, which a consumed stream can't. Files from a browser should
 * skip HQ altogether via `presignUpload()` — a Vercel function refuses request
 * bodies over 4.5 MB.
 */

export class StorageError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'StorageError'
    this.status = status
    this.code = code
  }
}

export type PutBody = string | Blob | ArrayBuffer | Uint8Array<ArrayBuffer>

export type PutOptions = {
  contentType?: string
  cacheControl?: string
  contentDisposition?: string
  /** Stored as `x-amz-meta-*` headers: ASCII values, names read back lower-cased. */
  metadata?: Record<string, string>
}

export type ObjectInfo = {
  key: string
  size: number
  etag: string
  lastModified: Date
  contentType: string | null
  metadata: Record<string, string>
}

export type ListedObject = {
  key: string
  size: number
  etag: string
  lastModified: Date
}

export type ListResult = {
  objects: ListedObject[]
  /** Folder-like prefixes, when listing with a delimiter. */
  prefixes: string[]
  /** Pass back as `cursor` for the next page; null on the last one. */
  cursor: string | null
}

export type PresignedUpload = {
  key: string
  url: string
  method: 'PUT'
  /** Send exactly these with the upload — they are part of the signature. */
  headers: Record<string, string>
  expiresAt: Date
}

/** SigV4 caps a presigned URL at seven days. */
const MAX_EXPIRES_IN = 604_800

/**
 * R2 gzips text and JSON for clients that accept it, and then drops
 * Content-Length: HEAD loses the size and GET arrives chunked with
 * `content-encoding: gzip`. Asking for identity keeps the stored bytes and
 * their length exact.
 */
const IDENTITY = { 'Accept-Encoding': 'identity' }

function connect(): { config: StorageConfig; aws: AwsClient } {
  const config = storageConfig()
  if (!config) {
    throw new StorageError(
      'R2 storage is not configured.',
      503,
      'NotConfigured',
    )
  }
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
    // aws4fetch retries 5xx/429 ten times by default — far too patient for a
    // request handler.
    retries: 2,
  })
  return { config, aws }
}

function encodeKey(key: string): string {
  assertKey(key)
  return key.split('/').map(encodeURIComponent).join('/')
}

function objectUrl(config: StorageConfig, key: string): URL {
  return new URL(`${config.endpoint}/${config.bucket}/${encodeKey(key)}`)
}

function expiry(seconds: number): number {
  return Math.min(Math.max(Math.floor(seconds), 1), MAX_EXPIRES_IN)
}

/**
 * URLSearchParams writes spaces as `+`; SigV4 canonicalises them as `%20`.
 * Every literal `+` is already `%2B`, so any `+` left in the query is a space.
 */
function href(url: URL | string): string {
  const s = url.toString()
  const q = s.indexOf('?')
  return q === -1 ? s : s.slice(0, q) + s.slice(q).replace(/\+/g, '%20')
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function unescapeXml(text: string): string {
  return text.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g,
    (_, hex?: string, dec?: string, name?: string) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
      if (dec) return String.fromCodePoint(Number(dec))
      return ENTITIES[name ?? ''] ?? ''
    },
  )
}

/** S3 responses are flat, predictable XML — one element's text is enough. */
function xmlText(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return match?.[1] === undefined ? null : unescapeXml(match[1])
}

function xmlBlocks(xml: string, tag: string): string[] {
  return [
    ...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')),
  ].map((match) => match[1] ?? '')
}

function unquote(etag: string | null): string {
  return (etag ?? '').replace(/^"|"$/g, '')
}

async function fail(res: Response, action: string): Promise<never> {
  const body = await res.text().catch(() => '')
  const code = xmlText(body, 'Code')
  const message = xmlText(body, 'Message') ?? res.statusText
  throw new StorageError(
    `R2 ${action}: ${res.status}${code ? ` ${code}` : ''}${message ? ` — ${message}` : ''}`,
    res.status,
    code,
  )
}

/** `attachment` with an ASCII fallback plus the RFC 5987 UTF-8 name. */
function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const utf8 = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

export async function putObject(
  key: string,
  body: PutBody,
  options: PutOptions = {},
): Promise<{ key: string; etag: string }> {
  const { config, aws } = connect()
  const headers = new Headers()
  if (options.contentType) headers.set('Content-Type', options.contentType)
  if (options.cacheControl) headers.set('Cache-Control', options.cacheControl)
  if (options.contentDisposition) {
    headers.set('Content-Disposition', options.contentDisposition)
  }
  for (const [name, value] of Object.entries(options.metadata ?? {})) {
    headers.set(`x-amz-meta-${name}`, value)
  }
  const res = await aws.fetch(objectUrl(config, key), {
    method: 'PUT',
    headers,
    body,
  })
  if (!res.ok) return fail(res, `PUT ${key}`)
  return { key, etag: unquote(res.headers.get('ETag')) }
}

/**
 * The object as a fetch Response — stream `res.body` onward or buffer it.
 * Null when the key doesn't exist.
 */
export async function getObject(key: string): Promise<Response | null> {
  const { config, aws } = connect()
  const res = await aws.fetch(objectUrl(config, key), {
    method: 'GET',
    headers: IDENTITY,
  })
  if (res.status === 404) {
    await res.body?.cancel()
    return null
  }
  if (!res.ok) return fail(res, `GET ${key}`)
  return res
}

export async function headObject(key: string): Promise<ObjectInfo | null> {
  const { config, aws } = connect()
  const res = await aws.fetch(objectUrl(config, key), {
    method: 'HEAD',
    headers: IDENTITY,
  })
  if (res.status === 404) return null
  if (!res.ok) return fail(res, `HEAD ${key}`)
  const metadata: Record<string, string> = {}
  res.headers.forEach((value, name) => {
    if (name.startsWith('x-amz-meta-')) metadata[name.slice(11)] = value
  })
  return {
    key,
    size: Number(res.headers.get('Content-Length') ?? 0),
    etag: unquote(res.headers.get('ETag')),
    lastModified: new Date(res.headers.get('Last-Modified') ?? 0),
    contentType: res.headers.get('Content-Type'),
    metadata,
  }
}

/** Idempotent: deleting a key that doesn't exist succeeds. */
export async function deleteObject(key: string): Promise<void> {
  const { config, aws } = connect()
  const res = await aws.fetch(objectUrl(config, key), { method: 'DELETE' })
  if (!res.ok) return fail(res, `DELETE ${key}`)
}

export async function listObjects(
  options: {
    prefix?: string
    /** `/` groups keys into `prefixes`, like folders. */
    delimiter?: string
    cursor?: string | null
    /** 1–1000, default 1000. */
    limit?: number
  } = {},
): Promise<ListResult> {
  const { config, aws } = connect()
  const url = new URL(`${config.endpoint}/${config.bucket}`)
  url.searchParams.set('list-type', '2')
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 1000), 1), 1000)
  url.searchParams.set('max-keys', String(limit))
  if (options.prefix) url.searchParams.set('prefix', options.prefix)
  if (options.delimiter) url.searchParams.set('delimiter', options.delimiter)
  if (options.cursor) {
    url.searchParams.set('continuation-token', options.cursor)
  }
  const res = await aws.fetch(href(url), { method: 'GET' })
  if (!res.ok) return fail(res, 'LIST')
  const xml = await res.text()
  return {
    objects: xmlBlocks(xml, 'Contents').map((block) => ({
      key: xmlText(block, 'Key') ?? '',
      size: Number(xmlText(block, 'Size') ?? 0),
      etag: unquote(xmlText(block, 'ETag')),
      lastModified: new Date(xmlText(block, 'LastModified') ?? 0),
    })),
    prefixes: xmlBlocks(xml, 'CommonPrefixes')
      .map((block) => xmlText(block, 'Prefix') ?? '')
      .filter(Boolean),
    cursor:
      xmlText(xml, 'IsTruncated') === 'true'
        ? xmlText(xml, 'NextContinuationToken')
        : null,
  }
}

/**
 * A URL the browser PUTs one file to directly, never touching HQ.
 *
 * Content-Type is signed, so the upload must declare the type HQ approved.
 * Pass `size` to sign Content-Length as well: the body must then be exactly
 * that many bytes. Presigned PUTs have no max-size policy, so validating the
 * declared size and then signing it is how a limit is enforced.
 *
 * The bucket needs a CORS rule allowing PUT from HQ's origin (DEPLOY.md).
 */
export async function presignUpload(
  key: string,
  options: { contentType: string; size?: number; expiresIn?: number },
): Promise<PresignedUpload> {
  const { config, aws } = connect()
  const { contentType, size } = options
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) {
    throw new StorageError(`Invalid upload size: ${size}`, 400, 'InvalidSize')
  }
  const expiresIn = expiry(options.expiresIn ?? 600)
  const url = objectUrl(config, key)
  url.searchParams.set('X-Amz-Expires', String(expiresIn))
  const signedHeaders: Record<string, string> = { 'Content-Type': contentType }
  if (size !== undefined) signedHeaders['Content-Length'] = String(size)
  const signed = await aws.sign(url, {
    method: 'PUT',
    headers: signedHeaders,
    // Content-Type and Content-Length are left unsigned unless asked for.
    aws: { signQuery: true, allHeaders: true },
  })
  return {
    key,
    url: href(signed.url),
    method: 'PUT',
    // A browser sets Content-Length itself; only the type is the caller's job.
    headers: { 'Content-Type': contentType },
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  }
}

/**
 * A time-limited GET URL for a private object. `filename` makes the browser
 * download it under that name instead of displaying it.
 */
export async function presignDownload(
  key: string,
  options: { expiresIn?: number; filename?: string } = {},
): Promise<string> {
  const { config, aws } = connect()
  const url = objectUrl(config, key)
  url.searchParams.set(
    'X-Amz-Expires',
    String(expiry(options.expiresIn ?? 300)),
  )
  if (options.filename) {
    url.searchParams.set(
      'response-content-disposition',
      attachment(options.filename),
    )
  }
  const signed = await aws.sign(url, {
    method: 'GET',
    aws: { signQuery: true },
  })
  return href(signed.url)
}

/**
 * The object's permanent public address, or null when R2_PUBLIC_URL is unset
 * (a private bucket — use `presignDownload()`).
 */
export function publicUrl(key: string): string | null {
  const base = storageConfig()?.publicUrl
  return base ? `${base}/${encodeKey(key)}` : null
}
