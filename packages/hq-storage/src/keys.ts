/**
 * Object keys.
 *
 * Everything HQ writes should be named by `objectKey()` so the bucket stays
 * browsable by prefix and a user-supplied filename can neither escape its
 * prefix nor collide with another upload:
 *
 *   inbox/attachments/2026/09/3f9c1a7be04d52e1-brief-v2.pdf
 *
 * The slug keeps ASCII only — a Thai or emoji filename becomes `file`, and the
 * random part keeps it unique. Store the original name alongside the key (a DB
 * column, or `metadata` on the put) when it matters.
 */

const MAX_KEY_BYTES = 1024

function slug(value: string, max: number): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
}

/** `inbox//Attachments/../x` → `inbox/attachments/x`. Throws if nothing is left. */
export function normalizePrefix(prefix: string): string {
  const segments = prefix
    .split('/')
    .map((segment) => slug(segment, 64))
    .filter(Boolean)
  if (segments.length === 0) {
    throw new Error(`Storage prefix "${prefix}" has no usable segments.`)
  }
  return segments.join('/')
}

/**
 * The first segment of every key minted for an owner: `<ownerId>/`. No two
 * owners share a prefix, so one owner's files can be listed, sized, exported
 * or emptied on their own. An owner id is a uuid; one that isn't already a
 * clean segment is refused rather than slugged, because slugging could fold
 * two ids into one prefix.
 */
export function ownerPrefix(ownerId: string): string {
  if (ownerId.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(ownerId)) {
    throw new Error(
      `Owner id ${JSON.stringify(ownerId)} can't start a storage key.`,
    )
  }
  return `${ownerId}/`
}

export function objectKey(
  prefix: string,
  filename: string,
  now: Date = new Date(),
): string {
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? slug(filename.slice(dot + 1), 10) : ''
  const name = slug(base, 60) || 'file'
  const id = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${normalizePrefix(prefix)}/${yyyy}/${mm}/${id}-${name}${ext ? `.${ext}` : ''}`
}

/**
 * Guard for keys that arrive from outside (a route param, a form field): no
 * leading slash, no `.`/`..` segments, no control characters, within S3's
 * 1024-byte limit. Keys minted by `objectKey()` always pass.
 */
export function isSafeKey(key: string): boolean {
  if (!key || key.startsWith('/')) return false
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) return false
  if (/\p{Cc}/u.test(key)) return false
  return key.split('/').every((s) => s !== '.' && s !== '..')
}

export function assertKey(key: string): void {
  if (!isSafeKey(key)) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`)
  }
}
