import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDbHandle, type DbHandle } from '@theiceji/hq-db'
import * as schema from '@theiceji/hq-db/schema'
import {
  assetAssets,
  boardBoards,
  boardCards,
  boardLanes,
  notes,
  projects,
  providerConnections,
  users,
} from '@theiceji/hq-db/schema'
import { inArray, like } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import {
  BOM,
  buildBundle,
  CREDENTIAL,
  countSets,
  csvCell,
  type ExportColumn,
  exportFilename,
  exportSets,
  kindOf,
  NOT_EXPORTED,
  readSet,
  toCsv,
} from '@/lib/data-export'

/**
 * `/data` export (lib/data-export.ts): the CSV writer, the registry's promise
 * that no credential or raw storage key is ever in a file, and — against a
 * real Postgres — that every read is the owner's own rows, and a project's.
 *
 * The database part inserts and removes only its own rows (users
 * `*@data.test`), and runs only with DATA_DB_TESTS=1 and a localhost
 * DATABASE_URL:
 *
 *   DATA_DB_TESTS=1 DATABASE_URL=postgres://hq:…@localhost:55310/hq_data_test \
 *     bun --env-file=<empty env> test test/data-export.test.ts
 */

const TABLES = Object.values(schema)
  .filter((value): value is PgTable => value instanceof PgTable)
  .map((table) => getTableConfig(table))

describe('csv', () => {
  test('RFC 4180 quoting', () => {
    expect(csvCell('text', 'plain')).toBe('plain')
    expect(csvCell('text', 'a,b')).toBe('"a,b"')
    expect(csvCell('text', 'say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('text', 'line one\r\nline two')).toBe(
      '"line one\r\nline two"',
    )
    expect(csvCell('text', 'line\nbreak')).toBe('"line\nbreak"')
    expect(csvCell('text', null)).toBe('')
    expect(csvCell('text', undefined)).toBe('')
    expect(csvCell('text', '')).toBe('')
  })

  test('a text cell that a spreadsheet would run as a formula is defused', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r'])
      expect(csvCell('text', `${lead}1+1`).replace(/^"/, '')).toStartWith(
        `'${lead}`,
      )
    expect(csvCell('text', '=HYPERLINK("http://x","go")')).toBe(
      `"'=HYPERLINK(""http://x"",""go"")"`,
    )
    expect(csvCell('json', { a: '=1' })).toBe('"{""a"":""=1""}"')
    expect(csvCell('json', -1)).toBe("'-1")
    expect(csvCell('text', 'a=b')).toBe('a=b')
  })

  test('money stays exact, numbers and times are not guarded', () => {
    expect(csvCell('decimal', '-12.50')).toBe('-12.50')
    expect(csvCell('decimal', '1234567890.10')).toBe('1234567890.10')
    expect(csvCell('number', -3)).toBe('-3')
    expect(csvCell('bool', false)).toBe('false')
    expect(csvCell('date', '2026-09-27')).toBe('2026-09-27')
    expect(csvCell('time', new Date('2026-09-27T01:02:03.004+07:00'))).toBe(
      '2026-09-26T18:02:03.004Z',
    )
  })

  test('arrays and json are JSON text; Thai is untouched', () => {
    expect(csvCell('array', ['a', 'b'])).toBe('"[""a"",""b""]"')
    expect(csvCell('array', [])).toBe('[]')
    expect(csvCell('json', { total: '1.00' })).toBe('"{""total"":""1.00""}"')
    expect(csvCell('text', 'งานลูกค้า')).toBe('งานลูกค้า')
  })

  test('the file: BOM, header of column names, CRLF', () => {
    const columns: ExportColumn[] = [
      { name: 'title', kind: 'text' },
      { name: 'price', kind: 'decimal' },
      { name: 'labels', kind: 'array' },
    ]
    const body = toCsv(columns, [
      { title: 'ป้าย, สอง', price: '-5.00', labels: ['x'] },
      { title: '@me', price: null, labels: [] },
    ])
    expect(body.charCodeAt(0)).toBe(0xfeff)
    expect(body.startsWith(BOM)).toBe(true)
    expect(body.slice(1).split('\r\n')).toEqual([
      'title,price,labels',
      '"ป้าย, สอง",-5.00,"[""x""]"',
      "'@me,,[]",
      '',
    ])
    expect(toCsv(columns, [])).toBe(`${BOM}title,price,labels\r\n`)
  })

  test('file names', () => {
    const at = new Date('2026-09-27T20:00:00Z')
    expect(exportFilename('board_cards', 'all', 'csv', at)).toBe(
      'hq-board_cards-all-2026-09-27.csv',
    )
    expect(exportFilename('everything', 'client-work', 'json', at)).toBe(
      'hq-everything-client-work-2026-09-27.json',
    )
  })

  test('column kinds', () => {
    expect(kindOf('numeric(12, 2)')).toBe('decimal')
    expect(kindOf('bigint')).toBe('number')
    expect(kindOf('text[]')).toBe('array')
    expect(kindOf('uuid[]')).toBe('array')
    expect(kindOf('timestamp with time zone')).toBe('time')
    expect(kindOf('date')).toBe('date')
    expect(kindOf('jsonb')).toBe('json')
    expect(kindOf('boolean')).toBe('bool')
    expect(kindOf('uuid')).toBe('text')
  })
})

describe('registry', () => {
  const sets = exportSets()

  test('every table is a set or is named as never exported', () => {
    const decided = new Set([
      ...sets.map((set) => set.table),
      ...NOT_EXPORTED.map((entry) => entry.table),
    ])
    const undecided = TABLES.map((table) => table.name).filter(
      (name) => !decided.has(name),
    )
    expect(undecided).toEqual([])
    const both = sets
      .map((set) => set.table)
      .filter((name) => NOT_EXPORTED.some((entry) => entry.table === name))
    expect(both).toEqual([])
    expect(sets.map((set) => set.table)).not.toContain('ops_scheduler_leases')
    expect(new Set(sets.map((set) => set.id)).size).toBe(sets.length)
  })

  test('no credential column and no raw storage key is in any set', () => {
    // Every column in the whole schema whose name says it holds a credential
    // (sealed, secret, hash, password, token), plus the raw storage keys.
    const forbidden = TABLES.flatMap((table) =>
      table.columns
        .filter(
          (column) =>
            CREDENTIAL.test(column.name) ||
            ['storage_key', 'thumb_key'].includes(column.name),
        )
        .map((column) => `${table.name}.${column.name}`),
    )
    for (const known of [
      'users.password_hash',
      'google_connections.refresh_token_sealed',
      'provider_connections.secret_sealed',
      'provider_connections.secret_hint',
      'ops_runtimes.sealed_delivery_secret',
      'oauth_clients.secret_hash',
      'calendar_sync_state.sync_token',
      'asset_assets.storage_key',
      'asset_assets.thumb_key',
      'ops_release_authorizations.payload_hash',
    ])
      expect(forbidden).toContain(known)

    const exported = sets.flatMap((set) =>
      set.columns.map((column) => `${set.table}.${column.name}`),
    )
    expect(exported.filter((name) => forbidden.includes(name))).toEqual([])
    for (const set of sets)
      for (const column of set.columns) {
        expect(CREDENTIAL.test(column.name)).toBe(false)
        expect(column.name).not.toMatch(/sealed|secret|hash|password/)
      }
    // Every left-out column says why.
    for (const set of sets)
      for (const omitted of set.omitted)
        expect(omitted.reason.length).toBeGreaterThan(5)
  })

  test('an LLM usage count is a number, not a credential', () => {
    const usage = sets.find((set) => set.id === 'ops_usage_events')
    expect(usage?.columns.map((column) => column.name)).toContain('tokens')
    expect(CREDENTIAL.test('tokens')).toBe(false)
    expect(CREDENTIAL.test('fencing_token')).toBe(true)
    expect(CREDENTIAL.test('refresh_token_sealed')).toBe(true)
  })

  test('sets that belong to no project say so', () => {
    const unscoped = sets
      .filter((set) => !set.projectScoped)
      .map((set) => set.id)
    expect(unscoped.sort()).toEqual(
      [
        'google_connections',
        'owner_settings',
        'provider_connections',
        'refs',
        'users',
      ].sort(),
    )
  })
})

// ─── against Postgres ──────────────────────────────────────────────────────

const url = process.env.DATABASE_URL ?? ''
const enabled =
  process.env.DATA_DB_TESTS === '1' &&
  /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)
const suite = enabled ? describe : describe.skip

const SECRET = 'SEALED-SECRET-VALUE-do-not-export'
const RAW_KEY = 'raw/storage/KEY-do-not-export'

suite('reads are the owner’s own', () => {
  let handle: DbHandle
  let owner = ''
  let stranger = ''
  let project = { id: '', slug: '', name: '' }
  let strangerProject = ''

  const cleanup = async () => {
    const db = handle.db
    const people = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(like(users.email, '%@data.test'))
    ).map((row) => row.id)
    if (!people.length) return
    for (const table of [
      boardCards,
      boardLanes,
      boardBoards,
      notes,
      assetAssets,
      providerConnections,
    ])
      await db.delete(table).where(inArray(table.ownerId, people))
    await db.delete(projects).where(inArray(projects.ownerId, people))
    await db.delete(users).where(inArray(users.id, people))
  }

  /** One owner's world: a project, notes in it and outside it, a board, a card, a connection, an asset. */
  const world = async (userId: string, slug: string, title: string) => {
    const db = handle.db
    const [p] = await db
      .insert(projects)
      .values({
        ownerId: userId,
        createdBy: userId,
        slug,
        name: slug === 'pilot' ? 'งานทดลอง' : 'Theirs',
        kind: 'freelance',
        modules: { enabled: ['board', 'assets'], settings: {} },
      })
      .returning()
    if (!p) throw new Error('project not created')
    await db.insert(notes).values([
      { ownerId: userId, body: `${title} in the project`, projectId: p.id },
      { ownerId: userId, body: `${title} with no project` },
    ])
    const [board] = await db
      .insert(boardBoards)
      .values({
        ownerId: userId,
        createdBy: userId,
        projectId: p.id,
        name: 'Work',
      })
      .returning()
    if (!board) throw new Error('board not created')
    const [lane] = await db
      .insert(boardLanes)
      .values({
        ownerId: userId,
        boardId: board.id,
        name: 'Doing',
        position: 0,
        role: 'normal',
      })
      .returning()
    if (!lane) throw new Error('lane not created')
    await db.insert(boardCards).values({
      ownerId: userId,
      createdBy: userId,
      boardId: board.id,
      laneId: lane.id,
      projectId: p.id,
      title,
      body: 'ส่งงาน, "draft" แล้ว',
      labels: ['client'],
      price: '1234.50',
      currency: 'THB',
    })
    await db.insert(providerConnections).values({
      ownerId: userId,
      createdBy: userId,
      provider: 'openai_compatible',
      label: 'Main key',
      config: { baseUrl: 'http://localhost:1234/v1' },
      secretSealed: SECRET,
      secretHint: '9f2a',
      status: 'connected',
    })
    await db.insert(assetAssets).values({
      ownerId: userId,
      createdBy: userId,
      projectId: p.id,
      storageProvider: 'r2',
      storageKey: `${RAW_KEY}-${slug}`,
      path: `${slug}/files/brief.pdf`,
      name: 'brief.pdf',
      kind: 'doc',
      mime: 'application/pdf',
      bytes: 2048,
      origin: 'upload',
      status: 'pending',
      actorType: 'user',
      actorId: userId,
    })
    return p
  }

  beforeAll(async () => {
    handle = createDbHandle(url, { max: 2 })
    await cleanup()
    const made = await handle.db
      .insert(users)
      .values([
        { email: 'owner@data.test', passwordHash: 'x-hash', role: 'admin' },
        { email: 'other@data.test', passwordHash: 'x-hash', role: 'admin' },
      ])
      .returning({ id: users.id })
    owner = made[0]?.id ?? ''
    stranger = made[1]?.id ?? ''
    const mine = await world(
      owner,
      'pilot',
      '=HYPERLINK("http://evil","click")',
    )
    project = { id: mine.id, slug: mine.slug, name: mine.name }
    strangerProject = (await world(stranger, 'theirs', 'Their card')).id
  })

  afterAll(async () => {
    await cleanup()
    await handle.sql.end({ timeout: 5 })
  })

  test('counts are the owner’s rows, all projects or one', async () => {
    const all = await countSets(handle.db, owner, null)
    expect(all.notes?.rows).toBe(2)
    expect(all.projects?.rows).toBe(1)
    expect(all.board_cards?.rows).toBe(1)
    expect(all.board_lanes?.rows).toBe(1)
    expect(all.provider_connections?.rows).toBe(1)
    expect(all.users?.rows).toBe(1)
    expect(all.quote_lines?.rows).toBe(0)
    expect(all.quote_lines?.last).toBeNull()
    expect(all.notes?.last).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)

    const one = await countSets(handle.db, owner, project.id)
    expect(one.notes?.rows).toBe(1)
    expect(one.projects?.rows).toBe(1)
    expect(one.board_lanes?.rows).toBe(1)
    expect(one.refs?.rows).toBeNull()
    expect(one.users?.rows).toBeNull()

    // Someone else's project scopes nothing of the owner's — and nothing of theirs.
    const theirs = await countSets(handle.db, owner, strangerProject)
    expect(theirs.notes?.rows).toBe(0)
    expect(theirs.board_cards?.rows).toBe(0)
    expect(theirs.board_lanes?.rows).toBe(0)
    expect(theirs.projects?.rows).toBe(0)
  })

  test('a set’s rows are the owner’s own', async () => {
    const mine = await readSet(handle.db, owner, 'notes', null)
    expect(mine.map((row) => row.owner_id)).toEqual([owner, owner])
    const lanes = await readSet(handle.db, owner, 'board_lanes', project.id)
    expect(lanes).toHaveLength(1)
    expect(lanes[0]?.owner_id).toBe(owner)
    const account = await readSet(handle.db, owner, 'users', null)
    expect(account).toHaveLength(1)
    expect(account[0]?.id).toBe(owner)
    expect(account[0]).not.toHaveProperty('password_hash')
  })

  test('the CSV of cards: guarded title, exact price, Thai body', async () => {
    const set = exportSets().find((entry) => entry.id === 'board_cards')
    if (!set) throw new Error('no board_cards set')
    const rows = await readSet(handle.db, owner, 'board_cards', project.id)
    const body = toCsv(set.columns, rows)
    expect(body).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`)
    expect(body).toContain(',1234.50,THB,')
    expect(body).toContain('"ส่งงาน, ""draft"" แล้ว"')
    expect(body).not.toContain('Their card')
    expect(body).not.toContain(stranger)
  })

  test('everything as JSON: no credential, no raw key, no one else', async () => {
    const ids = exportSets().map((set) => set.id)
    const bundle = await buildBundle(handle.db, owner, ids, null)
    const text = JSON.stringify(bundle)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('9f2a')
    expect(text).not.toContain(RAW_KEY)
    expect(text).not.toContain('x-hash')
    expect(text).not.toContain(stranger)
    expect(text).not.toContain('Their card')
    for (const set of Object.values(bundle.sets))
      for (const row of set.rows)
        for (const key of Object.keys(row)) {
          expect(CREDENTIAL.test(key)).toBe(false)
          expect(['storage_key', 'thumb_key']).not.toContain(key)
        }
    const card = bundle.sets.board_cards?.rows[0]
    expect(card?.price).toBe('1234.50')
    expect(card?.currency).toBe('THB')
    expect(String(card?.created_at)).toMatch(/Z$/)
    expect(bundle.sets.asset_assets?.rows[0]?.path).toBe(
      'pilot/files/brief.pdf',
    )
  })

  test('a project’s file holds that project’s rows only', async () => {
    const ids = exportSets().map((set) => set.id)
    const bundle = await buildBundle(handle.db, owner, ids, project)
    expect(bundle.scope.project?.slug).toBe('pilot')
    expect(bundle.notByProject.sort()).toEqual(
      [
        'google_connections',
        'owner_settings',
        'provider_connections',
        'refs',
        'users',
      ].sort(),
    )
    expect(bundle.sets.notes?.rows).toHaveLength(1)
    for (const set of Object.values(bundle.sets))
      for (const row of set.rows)
        if ('project_id' in row) expect(row.project_id).toBe(project.id)
    expect(bundle.sets.projects?.rows.map((row) => row.slug)).toEqual(['pilot'])
  })
})
