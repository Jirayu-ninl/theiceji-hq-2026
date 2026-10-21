import { type PutBody, StorageError } from '../r2'

/**
 * Helpers both providers share: asset paths, buffered bodies, hashing.
 *
 * An asset path is `<project-slug>/<collection>/<filename>` — folders, then
 * the file's own name. R2 slugs it into an object key (`objectKey()`); Drive
 * keeps every segment as a real folder or file name, so a Thai filename stays
 * readable in the owner's Drive. Either way a path can't climb out of its
 * root: `.`/`..` and control characters are refused, empty segments dropped.
 */

export function pathSegments(path: string): string[] {
  const segments = path
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || /\p{Cc}/u.test(segment)) {
      throw new StorageError(
        `Storage path ${JSON.stringify(path)} has an unusable segment.`,
        400,
        'InvalidPath',
      )
    }
  }
  return segments
}

/** `a/b/c.png` → folders `['a', 'b']`, name `c.png`. Needs at least a name. */
export function splitPath(path: string | undefined): {
  folders: string[]
  name: string
} {
  const segments = pathSegments(path ?? '')
  const name = segments.pop()
  if (!name) {
    throw new StorageError(
      'A new storage object needs a path ending in a file name.',
      400,
      'InvalidPath',
    )
  }
  return { folders: segments, name }
}

/** A MIME type safe to put in a header or a multipart part. */
export function assertMime(mime: string): string {
  const value = mime.trim()
  if (!value || /[\r\n]/.test(value)) {
    throw new StorageError(
      `Invalid content type: ${JSON.stringify(mime)}.`,
      400,
      'InvalidContentType',
    )
  }
  return value
}

export function assertBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new StorageError(`Invalid upload size: ${bytes}`, 400, 'InvalidSize')
  }
  return bytes
}

export async function toBytes(body: PutBody): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  return new Uint8Array(await body.arrayBuffer())
}

export async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
