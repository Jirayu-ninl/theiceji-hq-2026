/**
 * Back up and verify the HQ database.
 *
 *   bun run db:backup                       # write a dump
 *   bun run db:backup --verify <file>       # restore it into a scratch
 *                                           # database and check what landed
 *
 * A dump nobody has restored is not a backup. `--verify` proves the file
 * actually comes back: it creates a throwaway database, restores into it,
 * counts the rows of every table that came back — a dump taken before the
 * cutover still holds the Creator and Merchant tables, and they are
 * counted too — and drops the scratch database again.
 *
 * It never writes to the database it dumped, and it refuses to restore over
 * one that already has rows — testing a restore by overwriting production is
 * how a backup procedure becomes an outage.
 *
 * Needs `pg_dump` and `psql` on PATH (PostgreSQL client tools).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import postgres from 'postgres'
import { explain } from './pgerror'

const url = process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL
if (!url) {
  console.error('Neither DATABASE_MIGRATE_URL nor DATABASE_URL is set.')
  process.exit(1)
}

const args = process.argv.slice(2)
const verifyAt = args.indexOf('--verify')
const verifying = verifyAt !== -1

function describe(target: string): string {
  try {
    const parsed = new URL(target)
    return `${parsed.username}@${parsed.hostname}/${parsed.pathname.replace(/^\//, '') || '?'}`
  } catch {
    return '(unparseable URL)'
  }
}

function run(command: string, commandArgs: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit' })
    child.on('error', (error) =>
      fail(
        new Error(
          `Could not run ${command}. Install the PostgreSQL client tools and try again. (${error.message})`,
        ),
      ),
    )
    child.on('close', (code) =>
      code === 0
        ? done()
        : fail(new Error(`${command} exited with ${code ?? 'a signal'}`)),
    )
  })
}

async function dump(target: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = resolve(
    process.env.HQ_BACKUP_DIR ?? './backups',
    `hq-${stamp}.dump`,
  )
  mkdirSync(dirname(file), { recursive: true })
  console.log(`Dumping ${describe(target)} → ${file}`)
  // Custom format: it restores selectively and compresses, unlike plain SQL.
  await run('pg_dump', [
    '--format=custom',
    '--no-owner',
    '--file',
    file,
    target,
  ])
  const size = statSync(file).size
  console.log(`Wrote ${(size / 1024 / 1024).toFixed(2)} MB.`)
  console.log(
    `Verify it now:  bun run db:backup --verify ${file}\n` +
      'A dump nobody has restored is not a backup.',
  )
  return file
}

async function verify(target: string, file: string): Promise<void> {
  const source = new URL(target)
  const scratchName = `hq_restore_check_${Date.now()}`
  const admin = new URL(target)
  admin.pathname = '/postgres'
  const scratch = new URL(target)
  scratch.pathname = `/${scratchName}`

  console.log(`Restoring ${file} into a scratch database (${scratchName}).`)
  const adminSql = postgres(admin.toString(), { max: 1, onnotice: () => {} })
  try {
    await adminSql.unsafe(`create database "${scratchName}"`)
  } finally {
    await adminSql.end({ timeout: 5 })
  }

  const scratchSql = postgres(scratch.toString(), {
    max: 1,
    onnotice: () => {},
  })
  try {
    // A restore only proves something on an empty database.
    const [existing] = await scratchSql`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public'`
    if ((existing?.n ?? 0) > 0)
      throw new Error(
        'The scratch database is not empty. Refusing to restore over it.',
      )

    await run('pg_restore', [
      '--no-owner',
      '--exit-on-error',
      '--dbname',
      scratch.toString(),
      file,
    ])

    console.log('\nWhat came back:')
    const tables = await scratchSql<{ name: string }[]>`
      select table_name as name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name`
    let rows = 0
    for (const { name } of tables) {
      const [count] = await scratchSql.unsafe(
        `select count(*)::int as n from "${name}"`,
      )
      const n = (count as { n: number } | undefined)?.n ?? 0
      rows += n
      if (n > 0) console.log(`  ${name.padEnd(34)} ${n}`)
    }
    console.log(`  ${'—'.padEnd(34)} ${rows} rows in ${tables.length} tables`)
    if (tables.some(({ name }) => /^(creator|merchant)_/.test(name)))
      console.log(
        '\nThis dump still has the legacy Creator and Merchant tables — it was taken before the cutover (migration 0008), which is what it is for.',
      )

    const stored = tables.some(({ name }) => name === 'asset_assets')
      ? await scratchSql`
          select count(*)::int as n from asset_assets where status = 'ready'`
      : []
    if ((stored[0]?.n ?? 0) > 0)
      console.log(
        `${stored[0]?.n} ready asset(s) point at stored objects (R2 or Drive). The database dump does not contain the files — check the bucket's own retention separately.`,
      )
  } finally {
    await scratchSql.end({ timeout: 5 })
    const cleanup = postgres(admin.toString(), { max: 1, onnotice: () => {} })
    try {
      await cleanup.unsafe(`drop database if exists "${scratchName}"`)
      console.log(`Dropped ${scratchName}.`)
    } finally {
      await cleanup.end({ timeout: 5 })
    }
  }
  console.log(
    `\nRestore verified. The source database ${describe(source.toString())} was never written to.`,
  )
}

try {
  if (verifying) {
    const file = args[verifyAt + 1]
    if (!file) {
      console.error('Usage: bun run db:backup --verify <file>')
      process.exit(1)
    }
    await verify(url, resolve(file))
  } else {
    await dump(url)
  }
} catch (error) {
  console.error(explain(error))
  process.exit(1)
}
