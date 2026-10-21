import { beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { getDb } from '@/db'
import { notes, users } from '@/db/schema'
import {
  checklistProgress,
  parseChecklist,
  stripChecklist,
  toggleItem,
} from '@/lib/notes/checklist'
import {
  createNote,
  emptyTrash,
  getNote,
  listLabels,
  listNotes,
  purge,
  purgeExpired,
  reorder,
  searchNotes,
  setArchived,
  setDeleted,
  updateNote,
} from '@/lib/notes/store'
import { fallbackTitle, normalizeLabels, viewOf } from '@/lib/notes/types'

/**
 * The Notes store against a real Postgres — the ordering, the two reversible
 * lifecycles, and the search escaping are all things only the database can
 * confirm.
 *
 * Destructive: it truncates `notes`. Skipped unless DATABASE_URL points at
 * localhost and NOTES_DB_TESTS=1:
 *
 *   NOTES_DB_TESTS=1 DATABASE_URL=postgres://…@127.0.0.1:5432/hq_notes \
 *     bun --env-file=<throwaway env> test test/notes-store.test.ts
 */

const url = process.env.DATABASE_URL ?? ''
const enabled =
  process.env.NOTES_DB_TESTS === '1' &&
  /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)
const suite = enabled ? describe : describe.skip

const ids = (list: { id: string }[]) => list.map((n) => n.id)

suite('notes store', () => {
  // Two owners: every note is someone's (migration 0009), and one owner's
  // store never sees the other's notes.
  let owner = ''
  let other = ''

  beforeEach(async () => {
    const db = getDb()
    if (!db) throw new Error('DATABASE_URL is required')
    await db.execute(sql`truncate table ${notes}`)
    const people: string[] = []
    for (const email of ['notes-owner@hq.test', 'notes-other@hq.test']) {
      const [found] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
      const [row] = found
        ? [found]
        : await db
            .insert(users)
            .values({ email, name: email, role: 'admin', passwordHash: 'x' })
            .returning({ id: users.id })
      if (!row) throw new Error('no user')
      people.push(row.id)
    }
    owner = people[0] as string
    other = people[1] as string
  })

  test('an owner reads and changes only their own notes', async () => {
    const mine = await createNote(owner, { title: 'Mine', labels: ['a'] })
    const theirs = await createNote(other, { title: 'Theirs', labels: ['b'] })

    expect(ids(await listNotes(owner))).toEqual([mine.id])
    expect(ids(await listNotes(other))).toEqual([theirs.id])
    expect(await getNote(owner, theirs.id)).toBeNull()
    expect(await updateNote(owner, theirs.id, { title: 'Taken' })).toBeNull()
    expect(await setDeleted(owner, theirs.id, true)).toBeNull()
    expect(ids(await searchNotes(owner, 'Theirs'))).toEqual([])
    expect(await listLabels(owner)).toEqual(['a'])
    await setDeleted(other, theirs.id, true)
    expect(await emptyTrash(owner)).toBe(0)
    expect((await getNote(other, theirs.id))?.title).toBe('Theirs')
  })

  test('a new note lands at the top of the board', async () => {
    const first = await createNote(owner, { title: 'First' })
    const second = await createNote(owner, { title: 'Second' })
    const third = await createNote(owner, { title: 'Third' })

    expect(third.position).toBeLessThan(second.position)
    expect(second.position).toBeLessThan(first.position)
    expect(ids(await listNotes(owner))).toEqual([third.id, second.id, first.id])
  })

  test('pinned notes sort above the rest, whatever their position', async () => {
    const old = await createNote(owner, { title: 'Old' })
    await createNote(owner, { title: 'New' })
    await updateNote(owner, old.id, { pinned: true })

    const board = await listNotes(owner)
    expect(board[0]?.id).toBe(old.id)
    expect(board[0]?.pinned).toBe(true)
  })

  test('a patch only touches the fields it carries', async () => {
    const note = await createNote(owner, { title: 'Keep me', body: 'body' })
    const patched = await updateNote(owner, note.id, { color: 'citron' })

    expect(patched?.title).toBe('Keep me')
    expect(patched?.body).toBe('body')
    expect(patched?.color).toBe('citron')
  })

  test('an empty title is stored as null, not an empty string', async () => {
    const note = await createNote(owner, { title: '   ', body: 'just a body' })
    expect(note.title).toBeNull()
  })

  test('labels are trimmed and de-duplicated case-insensitively', async () => {
    const note = await createNote(owner, {
      title: 'Tagged',
      labels: [' idea ', 'Idea', 'backlog', ''],
    })
    expect(note.labels).toEqual(['idea', 'backlog'])
    expect(normalizeLabels([' idea ', 'Idea'])).toEqual(['idea'])
  })

  test('archiving moves the bucket and drops the pin', async () => {
    const note = await createNote(owner, { title: 'Pinned then archived' })
    await updateNote(owner, note.id, { pinned: true })

    const archived = await setArchived(owner, note.id, true)
    expect(archived?.pinned).toBe(false)
    expect(archived?.archivedAt).not.toBeNull()
    expect(await listNotes(owner, { view: 'active' })).toHaveLength(0)
    expect(ids(await listNotes(owner, { view: 'archive' }))).toEqual([note.id])

    await setArchived(owner, note.id, false)
    expect(ids(await listNotes(owner, { view: 'active' }))).toEqual([note.id])
  })

  test('the trash returns a note to the bucket it came from', async () => {
    const note = await createNote(owner, { title: 'Archived then trashed' })
    await setArchived(owner, note.id, true)
    await setDeleted(owner, note.id, true)

    expect(await listNotes(owner, { view: 'archive' })).toHaveLength(0)
    expect(ids(await listNotes(owner, { view: 'trash' }))).toEqual([note.id])

    await setDeleted(owner, note.id, false)
    expect(ids(await listNotes(owner, { view: 'archive' }))).toEqual([note.id])
    expect(await listNotes(owner, { view: 'active' })).toHaveLength(0)
  })

  test('purge only reaches a note that is already in the trash', async () => {
    const live = await createNote(owner, { title: 'Live' })
    await purge(owner, live.id)
    expect(await getNote(owner, live.id)).not.toBeNull()

    await setDeleted(owner, live.id, true)
    await purge(owner, live.id)
    expect(await getNote(owner, live.id)).toBeNull()
  })

  test('the sweep takes trashed notes past 30 days and leaves the rest', async () => {
    const db = getDb()
    if (!db) throw new Error('DATABASE_URL is required')
    const stale = await createNote(owner, { title: 'Stale' })
    const fresh = await createNote(owner, { title: 'Fresh' })
    await setDeleted(owner, stale.id, true)
    await setDeleted(owner, fresh.id, true)
    await db.execute(
      sql`update ${notes} set deleted_at = now() - interval '31 days' where id = ${stale.id}`,
    )

    expect(await purgeExpired(owner)).toBe(1)
    expect(await getNote(owner, stale.id)).toBeNull()
    expect(await getNote(owner, fresh.id)).not.toBeNull()

    expect(await emptyTrash(owner)).toBe(1)
    expect(await listNotes(owner, { view: 'trash' })).toHaveLength(0)
  })

  test('reorder rewrites the hand-order outright', async () => {
    const a = await createNote(owner, { title: 'A' })
    const b = await createNote(owner, { title: 'B' })
    const c = await createNote(owner, { title: 'C' })

    await reorder(owner, [a.id, b.id, c.id])
    expect(ids(await listNotes(owner))).toEqual([a.id, b.id, c.id])

    await reorder(owner, [c.id, a.id, b.id])
    expect(ids(await listNotes(owner))).toEqual([c.id, a.id, b.id])
  })

  test('search reads the title and the body, and treats % as a literal', async () => {
    await createNote(owner, { title: 'Shader ideas', body: 'ember field' })
    await createNote(owner, {
      title: 'Budget',
      body: 'margin is 40% this month',
    })

    expect(await listNotes(owner, { query: 'shader' })).toHaveLength(1)
    expect(await listNotes(owner, { query: 'EMBER' })).toHaveLength(1)
    expect(await listNotes(owner, { query: '40%' })).toHaveLength(1)
    // A bare wildcard is a literal: it finds the row that contains a percent
    // sign, not every row in the table.
    const wildcard = await listNotes(owner, { query: '%' })
    expect(wildcard).toHaveLength(1)
    expect(wildcard[0]?.title).toBe('Budget')
    expect(await listNotes(owner, { query: '_' })).toHaveLength(0)
  })

  test('the menu lookup spans the archive, skips the trash and caps', async () => {
    const active = await createNote(owner, { title: 'Ember shader' })
    const archived = await createNote(owner, { title: 'Ember archive' })
    await setArchived(owner, archived.id, true)
    const trashed = await createNote(owner, { title: 'Ember trash' })
    await setDeleted(owner, trashed.id, true)

    const found = await searchNotes(owner, 'ember')
    expect(ids(found).sort()).toEqual([active.id, archived.id].sort())

    for (let i = 0; i < 8; i += 1)
      await createNote(owner, { title: `ember ${i}` })
    expect(await searchNotes(owner, 'ember')).toHaveLength(6)
    expect(await searchNotes(owner, 'ember', 2)).toHaveLength(2)
    // An empty query is not "match everything".
    expect(await searchNotes(owner, '   ')).toEqual([])
  })

  test('the menu lookup answers most-recently-touched first', async () => {
    const first = await createNote(owner, { title: 'Ember one' })
    await createNote(owner, { title: 'Ember two' })
    await updateNote(owner, first.id, { body: 'touched last' })

    expect((await searchNotes(owner, 'ember'))[0]?.id).toBe(first.id)
  })

  test('the label filter is an exact containment check', async () => {
    const tagged = await createNote(owner, {
      title: 'Tagged',
      labels: ['lab', 'gpu'],
    })
    await createNote(owner, { title: 'Untagged' })

    expect(ids(await listNotes(owner, { label: 'lab' }))).toEqual([tagged.id])
    expect(await listNotes(owner, { label: 'la' })).toHaveLength(0)
  })

  test('listLabels ignores the trash and folds case', async () => {
    await createNote(owner, { title: 'One', labels: ['Lab'] })
    await createNote(owner, { title: 'Two', labels: ['lab', 'gpu'] })
    const trashed = await createNote(owner, {
      title: 'Three',
      labels: ['gone'],
    })
    await setDeleted(owner, trashed.id, true)

    expect(await listLabels(owner)).toEqual(['gpu', 'Lab'])
  })
})

/** Pure helpers — these run everywhere, database or not. */
describe('notes checklist', () => {
  const LF = String.fromCharCode(10)
  const body = ['groceries', '- [ ] milk', '* [x] bread', '+ [X] eggs'].join(LF)

  test('parses every marker style and its checked state', () => {
    expect(parseChecklist(body)).toEqual([
      { line: 1, checked: false, text: 'milk' },
      { line: 2, checked: true, text: 'bread' },
      { line: 3, checked: true, text: 'eggs' },
    ])
  })

  test('toggling flips one line and leaves the rest byte-identical', () => {
    const next = toggleItem(body, 1)
    expect(next.split(LF)[1]).toBe('- [x] milk')
    expect(next.split(LF)[2]).toBe('* [x] bread')
    expect(toggleItem(next, 1)).toBe(body)
  })

  test('a line that is not an item, or is gone, is a no-op', () => {
    expect(toggleItem(body, 0)).toBe(body)
    expect(toggleItem(body, 99)).toBe(body)
  })

  test('progress and prose are read off the same body', () => {
    expect(checklistProgress(body)).toEqual({ done: 2, total: 3 })
    expect(checklistProgress('no list here')).toBeNull()
    expect(stripChecklist(body)).toBe('groceries')
  })

  test('a titleless note falls back to its first real line', () => {
    const list = ['', '', '- [ ] call the studio', 'rest'].join(LF)
    expect(fallbackTitle(list)).toBe('call the studio')
    expect(fallbackTitle(['## Heading', 'body'].join(LF))).toBe('Heading')
    expect(fallbackTitle(['   ', '', ''].join(LF))).toBe('')
  })

  test('a note carries its own bucket, trash winning over archive', () => {
    const base = {
      id: 'x',
      createdAt: '',
      updatedAt: '',
      title: null,
      body: '',
      color: 'none' as const,
      pinned: false,
      labels: [],
      position: 0,
      promotedTo: null,
      archivedAt: null,
      deletedAt: null,
    }
    expect(viewOf(base)).toBe('active')
    expect(viewOf({ ...base, archivedAt: 'now' })).toBe('archive')
    expect(viewOf({ ...base, archivedAt: 'now', deletedAt: 'now' })).toBe(
      'trash',
    )
  })
})
