/**
 * Postgres errors, explained.
 *
 * Drizzle wraps a driver failure as `Failed query: <sql>` and hangs the real
 * error off `.cause` — so printing `err.message` alone tells you which
 * statement died and nothing about why. These helpers walk the chain and turn
 * the common SQLSTATE codes into the fix.
 */

type PgError = Error & {
  code?: string
  detail?: string
  hint?: string
  routine?: string
}

/** The innermost error in a `.cause` chain. */
export function rootCause(e: unknown): PgError {
  let current = e as PgError
  while (current && typeof current === 'object' && 'cause' in current) {
    const next = (current as { cause?: unknown }).cause
    if (!next || typeof next !== 'object') break
    current = next as PgError
  }
  return current
}

/** `postgres://user@host/db` → the bits a GRANT statement needs. */
function connectionParts(url: string | undefined) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return {
      user: decodeURIComponent(parsed.username) || 'your_role',
      database:
        decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'your_db',
      host: parsed.hostname,
    }
  } catch {
    return null
  }
}

function hintFor(code: string | undefined, url: string | undefined): string[] {
  const parts = connectionParts(url)
  const user = parts?.user ?? 'your_role'
  const database = parts?.database ?? 'your_db'

  switch (code) {
    case '42501':
      return [
        'This role cannot create the schema Drizzle keeps its migration log in.',
        'Migrations need a role that owns the database; the app itself does not.',
        'Either point DATABASE_MIGRATE_URL at an owner/superuser connection, or',
        'have the owner run:',
        `  GRANT CREATE ON DATABASE "${database}" TO "${user}";`,
      ]
    case '3D000':
      return [
        `The database "${database}" does not exist yet. Create it first:`,
        `  CREATE DATABASE "${database}";`,
      ]
    case '28P01':
    case '28000':
      return [
        'The host rejected the credentials in DATABASE_URL.',
        'Check the user and password, and remember to percent-encode any',
        'special characters in the password.',
      ]
    case '25006':
      return [
        'The server refused a write: this connection is read-only.',
        'DATABASE_URL is probably pointing at a replica or a standby endpoint.',
      ]
    case '42P07':
      return [
        'A table this migration creates already exists.',
        'The schema was likely applied by hand. Either drop those tables, or',
        'mark the migration as applied in the drizzle migration log.',
      ]
    case '08006':
    case '08001':
    case '08003':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'ENOTFOUND':
      return [
        `Could not reach the server${parts ? ` at ${parts.host}` : ''}.`,
        'Check the host and port, that the server is running, and whether the',
        'host needs TLS (add ?sslmode=require to DATABASE_URL).',
      ]
    default:
      return []
  }
}

/** A block ready to print: the statement, the real reason, and what to do. */
export function explain(e: unknown, url = process.env.DATABASE_URL): string {
  const wrapper = e as PgError
  const cause = rootCause(e)
  const lines: string[] = []

  const query = wrapper?.message?.startsWith('Failed query:')
    ? wrapper.message.split('\n')[0]?.replace('Failed query: ', '')
    : null
  if (query) lines.push(`  statement : ${query}`)

  const reason = cause?.message ?? wrapper?.message ?? String(e)
  lines.push(`  reason    : ${reason}${cause?.code ? ` (${cause.code})` : ''}`)
  if (cause?.detail) lines.push(`  detail    : ${cause.detail}`)
  if (cause?.hint) lines.push(`  db hint   : ${cause.hint}`)

  const hint = hintFor(cause?.code, url)
  if (hint.length > 0) {
    lines.push('')
    for (const line of hint) lines.push(`  ${line}`)
  }

  return lines.join('\n')
}
