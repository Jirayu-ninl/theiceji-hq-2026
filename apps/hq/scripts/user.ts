/**
 * HQ operator accounts. There is no sign-up screen — accounts are made here.
 *
 *   bun run user:create -- --email me@example.com --name 'Your Name'
 *   bun run user:list
 *   bun run user:passwd -- --email me@example.com
 *   bun run user:delete -- --email me@example.com
 *
 * The password may come from `--password`, from `HQ_USER_PASSWORD`, or from an
 * interactive prompt (hidden while typing). Addresses are stored lower-cased;
 * a unique index on `lower(email)` enforces that a second casing can't sneak in.
 */

import { MIN_PASSWORD_LENGTH } from '@theiceji/hq-auth/constants'
import { hashPassword } from '@theiceji/hq-auth/password'
import { count, eq, sql } from 'drizzle-orm'
import { closeDb, getDb } from '../src/db'
import { sessions, users } from '../src/db/schema'

type Args = { _: string[]; [flag: string]: string | boolean | string[] }

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token) continue
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const [flag, inline] = token.slice(2).split('=')
    if (!flag) continue
    const next = argv[i + 1]
    if (inline !== undefined) args[flag] = inline
    else if (next && !next.startsWith('--')) {
      args[flag] = next
      i++
    } else args[flag] = true
  }
  return args
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function fail(message: string): never {
  console.error(message)
  process.exitCode = 1
  throw new Error('__handled__')
}

const KEY_ENTER = ['\r', '\n']
const KEY_CANCEL = String.fromCharCode(3)
const KEY_BACKSPACE = [String.fromCharCode(127), String.fromCharCode(8)]
const ERASE = `${String.fromCharCode(8)} ${String.fromCharCode(8)}`

/** Prompt without echoing, when we have a real terminal to do it in. */
async function askSecret(question: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) return prompt(question) ?? ''

  process.stdout.write(question)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')

  return new Promise<string>((resolve) => {
    let value = ''
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (KEY_ENTER.includes(ch)) {
          stdin.removeListener('data', onData)
          stdin.setRawMode(false)
          stdin.pause()
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (ch === KEY_CANCEL) {
          stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (KEY_BACKSPACE.includes(ch)) {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write(ERASE)
          }
          continue
        }
        value += ch
        process.stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

async function resolvePassword(args: Args): Promise<string> {
  const given = str(args.password) ?? str(process.env.HQ_USER_PASSWORD)
  if (given) {
    if (given.length < MIN_PASSWORD_LENGTH) {
      fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
    }
    return given
  }

  const first = await askSecret('Password: ')
  if (first.length < MIN_PASSWORD_LENGTH) {
    fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  }
  const again = await askSecret('Confirm password: ')
  if (first !== again) fail('Passwords do not match.')
  return first
}

function requireEmail(args: Args): string {
  const email = str(args.email) ?? str(args._[0])
  if (!email) fail('Pass --email <address>.')
  if (!email.includes('@')) fail(`"${email}" does not look like an address.`)
  return email.toLowerCase()
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0] ?? 'list'
  const args = parseArgs(argv.slice(1))

  const db = getDb()
  if (!db) fail('DATABASE_URL is not set — check apps/hq/.env.local.')

  if (command === 'list') {
    const rows = await db
      .select({
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .orderBy(users.createdAt)

    if (rows.length === 0) {
      console.log('No users yet. Create one with `bun run user:create`.')
      return
    }
    for (const row of rows) {
      const last = row.lastLoginAt
        ? row.lastLoginAt.toISOString().slice(0, 16).replace('T', ' ')
        : 'never'
      console.log(
        `${row.email}\t${row.role}\t${row.name ?? '—'}\tlast login: ${last}`,
      )
    }
    return
  }

  const email = requireEmail(args)
  const [existing] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1)

  if (command === 'create') {
    if (existing && !args.force) {
      fail(
        `${email} already exists. Use \`bun run user:passwd -- --email ${email}\` to change the password, or pass --force.`,
      )
    }
    const password = await resolvePassword(args)
    const passwordHash = await hashPassword(password)
    const name = str(args.name)
    const role = str(args.role) === 'editor' ? 'editor' : 'admin'

    if (existing) {
      await db
        .update(users)
        .set({ passwordHash, ...(name ? { name } : {}) })
        .where(eq(users.id, existing.id))
      await db.delete(sessions).where(eq(sessions.userId, existing.id))
      console.log(`Updated ${email} (existing sessions signed out).`)
      return
    }

    await db.insert(users).values({ email, name, passwordHash, role })
    console.log(`Created ${email} (${role}). Sign in at /login.`)
    return
  }

  if (command === 'passwd') {
    if (!existing) fail(`No user with the address ${email}.`)
    const passwordHash = await hashPassword(await resolvePassword(args))
    await db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, existing.id))
    // A password change must end every session opened with the old one.
    await db.delete(sessions).where(eq(sessions.userId, existing.id))
    console.log(`Password changed for ${email}. All devices signed out.`)
    return
  }

  if (command === 'delete') {
    if (!existing) fail(`No user with the address ${email}.`)
    const [tally] = await db.select({ value: count() }).from(users)
    if ((tally?.value ?? 0) <= 1 && !args.force) {
      fail('That is the only account left — pass --force to delete it anyway.')
    }
    await db.delete(users).where(eq(users.id, existing.id))
    console.log(`Deleted ${email}.`)
    return
  }

  fail(`Unknown command "${command}". Use create, list, passwd or delete.`)
}

try {
  await main()
} catch (e) {
  if ((e as Error).message !== '__handled__') {
    console.error((e as Error).message)
    process.exitCode = 1
  }
} finally {
  await closeDb()
}
