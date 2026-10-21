import { afterAll, describe, expect, test } from 'bun:test'
import { inspectDatabase, REQUIRED_TRIGGERS } from '@theiceji/hq-db/readiness'
import type postgres from 'postgres'
import { closeDb, getSql } from '../src/db'
import { MIGRATIONS } from '../src/db/migrations'

/**
 * Readiness notices what liveness can't — a pending migration, a
 * missing column, a missing or disabled history guard, a role without grants —
 * and says so by name. Each fault is introduced and undone inside the test.
 *
 * Runs only with HQ_DB_TESTS=1 (or the old CREATOR_DB_TESTS=1) and a localhost DATABASE_URL (it alters
 * the schema briefly and creates a throwaway role). Synthetic only.
 */

const url = process.env.DATABASE_URL ?? ''
const enabled =
  (process.env.HQ_DB_TESTS ?? process.env.CREATOR_DB_TESTS) === '1' &&
  /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)
const suite = enabled ? describe : describe.skip

const check = (
  report: Awaited<ReturnType<typeof inspectDatabase>>,
  name: string,
) => report.checks.find((entry) => entry.name === name)

suite('readiness (Postgres)', () => {
  const sql = () => {
    const client = getSql()
    if (!client) throw new Error('DATABASE_URL is required')
    return client
  }

  afterAll(async () => {
    await closeDb()
  })

  test('a migrated database is ready', async () => {
    const report = await inspectDatabase(sql(), { migrations: MIGRATIONS })
    expect(report.ok).toBe(true)
    const guards = REQUIRED_TRIGGERS.length
    expect(check(report, 'guards')?.summary).toStartWith(`${guards}/${guards}`)
  })

  test('a migration this build ships but the database lacks is pending', async () => {
    const report = await inspectDatabase(sql(), {
      migrations: [
        ...MIGRATIONS,
        { tag: '9999_future', createdAt: 4_102_444_800_000 },
      ],
    })
    expect(report.ok).toBe(false)
    expect(check(report, 'migrations')?.problems.join(' ')).toContain(
      '9999_future',
    )
  })

  test('a missing column and a disabled or dropped guard are named', async () => {
    const db = sql()
    await db`alter table oauth_grants rename column actor_type to actor_type_parked`
    await db`alter table ops_usage_events disable trigger ops_usage_events_append_only`
    await db`drop trigger board_card_events_append_only on board_card_events`
    try {
      const report = await inspectDatabase(db)
      expect(report.ok).toBe(false)
      expect(check(report, 'schema')?.problems.join(' ')).toContain(
        'oauth_grants.actor_type',
      )
      const guards = check(report, 'guards')?.problems.join(' ') ?? ''
      expect(guards).toContain('ops_usage_events.ops_usage_events_append_only')
      expect(guards).toContain(
        'board_card_events.board_card_events_append_only',
      )
    } finally {
      await db`alter table oauth_grants rename column actor_type_parked to actor_type`
      await db`alter table ops_usage_events enable trigger ops_usage_events_append_only`
      await db.unsafe(
        'create trigger "board_card_events_append_only" before update or delete on "board_card_events" for each row execute function "ops_reject_mutation"()',
      )
    }
    expect((await inspectDatabase(db)).ok).toBe(true)
  })

  test('a role that can’t read and write the tables is not ready', async () => {
    const db = sql()
    const role = `hq_ready_probe_${Date.now()}`
    await db.unsafe(`create role "${role}"`)
    try {
      const report = await db.begin(async (tx) => {
        await tx.unsafe(`set local role "${role}"`)
        return inspectDatabase(tx as unknown as postgres.Sql)
      })
      expect(check(report, 'privileges')?.ok).toBe(false)
      expect(report.ok).toBe(false)
    } finally {
      await db.unsafe(`drop role "${role}"`)
    }
  })
})
