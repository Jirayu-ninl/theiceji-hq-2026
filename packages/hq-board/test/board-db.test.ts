import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createTarget } from '@theiceji/hq-core/targets'
import {
  boardCardEvents,
  boardCards,
  opsAuditEvents,
} from '@theiceji/hq-db/schema'
import { withTransaction } from '@theiceji/hq-ops/store'
import {
  allowAgent,
  closeTestDb,
  dbTestsEnabled,
  failure,
  makeProject,
  pgError,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import { eq, sql } from 'drizzle-orm'
import {
  boardSummaries,
  createCard,
  createLane,
  deleteLane,
  getCard,
  listCards,
  markPaid,
  moveCard,
  moveLane,
  normalizeLabels,
  openBoard,
  paidSince,
  renameLane,
  setCardArchived,
  setCardDeleted,
  unmarkPaid,
  updateCard,
} from '../src/board'
import { recordPayment, voidPayment } from '../src/payments'
import '../src/register'

/**
 * Board against Postgres. Destructive (truncates), so it runs only with
 * BOARD_DB_TESTS=1 and a localhost DATABASE_URL — a throwaway database.
 */

const suite = dbTestsEnabled('BOARD_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'board_card_payments',
  'board_followups',
  'board_card_events',
  'board_cards',
  'board_lanes',
  'board_boards',
]

test('labels are trimmed, lowercased, unique and capped', () => {
  expect(
    normalizeLabels([' Client ', 'client', 'Deck  v2', '', 'งาน']),
  ).toEqual(['client', 'deck v2', 'งาน'])
  expect(
    normalizeLabels(Array.from({ length: 20 }, (_, i) => `l${i}`)),
  ).toHaveLength(12)
})

suite('hq-board against Postgres', () => {
  let w: World

  beforeEach(async () => {
    w = await resetWorld(TABLES)
  })

  afterAll(() => closeTestDb(TABLES))

  test('the first open makes the kind’s preset; awaiting payment is last and pinned', async () => {
    const view = await openBoard(w.owner, w.project.id)
    expect(view?.lanes.map((lane) => lane.name)).toEqual([
      'Backlog',
      'Quoted',
      'Doing',
      'Review',
      'Awaiting payment',
    ])
    expect(view?.lanes.at(-1)?.role).toBe('awaiting_payment')
    const again = await openBoard(w.owner, w.project.id)
    expect(again?.board.id).toBe(view?.board.id as string)
    const audit = await w.db
      .select()
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.action, 'board.create'))
    expect(audit).toHaveLength(1)
  })

  test('a reader sees no board until someone who may write opens it', async () => {
    expect(await openBoard(w.reader, w.project.id)).toBeNull()
    await openBoard(w.owner, w.project.id)
    expect((await openBoard(w.reader, w.project.id))?.lanes).toHaveLength(5)
  })

  test('someone else’s project reads as not found', async () => {
    const error = await failure(openBoard(w.stranger, w.project.id))
    expect(error.code).toBe('not_found')
  })

  test('a board is only for a project with Board on', async () => {
    const off = await makeProject(
      w.db,
      w.owner.userId,
      'no-board',
      'personal',
      ['calendar'],
    )
    const error = await failure(openBoard(w.owner, off.id))
    expect(error.message).toContain('Board is off')
  })

  test('create, price, move, and the lane sums follow in exact decimals', async () => {
    const a = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'Brand deck v2',
      price: '36,000',
      labels: ['Deck', 'client'],
      client: 'Orbit Co.',
      dueOn: '2026-10-02',
    })
    expect(a.price).toBe('36000.00')
    expect(a.currency).toBe('THB')
    expect(a.labels).toEqual(['deck', 'client'])
    const b = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'Invoice 2 of 2',
      price: 0.1,
    })
    const c = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'Invoice 3',
      price: '0.2',
    })
    const view = await openBoard(w.owner, w.project.id)
    const awaiting = view?.lanes.find(
      (lane) => lane.role === 'awaiting_payment',
    )
    if (!view || !awaiting) throw new Error('no board')
    for (const card of [b, c]) {
      await moveCard(w.owner, {
        cardId: card.id,
        expectedRevision: card.revision,
        laneId: awaiting.id,
      })
    }
    const after = await openBoard(w.owner, w.project.id)
    const lane = after?.lanes.find((entry) => entry.id === awaiting.id)
    expect(lane?.sum).toBe('0.30')
    expect(lane?.count).toBe(2)
    const first = after?.lanes[0]
    expect(first?.sum).toBe('36000.00')
    const events = await w.db
      .select()
      .from(boardCardEvents)
      .where(eq(boardCardEvents.kind, 'moved'))
    expect(events).toHaveLength(2)
  })

  test('moving renumbers both lanes and honours a position', async () => {
    const cards = []
    for (const title of ['one', 'two', 'three']) {
      cards.push(await createCard(w.owner, { projectId: w.project.id, title }))
    }
    const view = await openBoard(w.owner, w.project.id)
    const [backlog, quoted] = view?.lanes ?? []
    if (!backlog || !quoted) throw new Error('no lanes')
    const two = cards[1]
    if (!two) throw new Error('no card')
    await moveCard(w.owner, {
      cardId: two.id,
      expectedRevision: two.revision,
      laneId: quoted.id,
    })
    const three = cards[2]
    if (!three) throw new Error('no card')
    const moved = await moveCard(w.owner, {
      cardId: three.id,
      expectedRevision: three.revision,
      laneId: quoted.id,
      position: 0,
    })
    const rows = await w.db.select().from(boardCards)
    const place = (id: string) => rows.find((row) => row.id === id)
    expect(place(cards[0]?.id as string)?.position).toBe(0)
    expect(moved.position).toBe(0)
    expect(place(two.id)?.position).toBe(1)
  })

  test('a stale revision is a conflict, not an overwrite', async () => {
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'x',
    })
    await updateCard(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      title: 'y',
    })
    const error = await failure(
      updateCard(w.owner, {
        cardId: card.id,
        expectedRevision: card.revision,
        title: 'z',
      }),
    )
    expect(error.code).toBe('conflict')
  })

  test('only the owner marks paid, only from the awaiting lane; undo puts it back', async () => {
    await allowAgent(w, ['draft'])
    const card = await createCard(w.agent, {
      projectId: w.project.id,
      title: 'Website refresh · invoice 2',
      price: '24000',
    })
    const view = await openBoard(w.owner, w.project.id)
    const awaiting = view?.lanes.at(-1)
    if (!awaiting) throw new Error('no lane')
    const notYet = await failure(
      markPaid(w.owner, { cardId: card.id, expectedRevision: card.revision }),
    )
    expect(notYet.message).toContain('awaiting-payment lane')
    const moved = await moveCard(w.agent, {
      cardId: card.id,
      expectedRevision: card.revision,
      laneId: awaiting.id,
    })
    const agentTry = await failure(
      markPaid(w.agent, { cardId: card.id, expectedRevision: moved.revision }),
    )
    expect(agentTry.code).toBe('forbidden')
    const paid = await markPaid(w.owner, {
      cardId: card.id,
      expectedRevision: moved.revision,
    })
    expect(paid.paidAt).not.toBeNull()
    expect(paid.archivedAt).not.toBeNull()
    const summaries = await boardSummaries(w.owner)
    expect(
      summaries.find((row) => row.projectId === w.project.id)?.awaiting ?? [],
    ).toEqual([])
    const came = await paidSince(w.owner, 7)
    expect(came).toEqual([
      { projectId: w.project.id, currency: 'THB', sum: '24000.00', cards: 1 },
    ])
    const back = await unmarkPaid(w.owner, {
      cardId: card.id,
      expectedRevision: paid.revision,
    })
    expect(back.paidAt).toBeNull()
    const [again] = await boardSummaries(w.owner)
    expect(again?.awaiting).toEqual([
      { currency: 'THB', sum: '24000.00', cards: 1 },
    ])
  })

  test('an agent writes only under the owner’s policy', async () => {
    const blocked = await failure(
      createCard(w.agent, { projectId: w.project.id, title: 'x' }),
    )
    expect(blocked.code).toBe('policy_blocked')
    await allowAgent(w, ['draft'])
    const card = await createCard(w.agent, {
      projectId: w.project.id,
      title: 'x',
    })
    expect(card.createdBy).toBe(w.owner.userId)
    const readerTry = await failure(
      createCard(w.reader, { projectId: w.project.id, title: 'y' }),
    )
    expect(readerTry.code).toBe('forbidden')
  })

  test('the same idempotency key replays the first card', async () => {
    await allowAgent(w, ['draft'])
    const key = 'card-key-0001'
    const first = await createCard(w.agent, {
      projectId: w.project.id,
      title: 'once',
      idempotencyKey: key,
    })
    const second = await createCard(w.agent, {
      projectId: w.project.id,
      title: 'once',
      idempotencyKey: key,
    })
    expect(second.id).toBe(first.id)
    const other = await failure(
      createCard(w.agent, {
        projectId: w.project.id,
        title: 'different',
        idempotencyKey: key,
      }),
    )
    expect(other.code).toBe('idempotency_conflict')
  })

  test('card history is append-only in the database', async () => {
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'x',
    })
    const error = await failure(
      w.db.execute(
        sql`update board_card_events set kind = 'edited' where card_id = ${card.id}`,
      ),
    )
    expect(pgError(error).message).toContain('append-only')
    const detail = await getCard(w.owner, card.id)
    expect(detail.events.map((event) => event.kind)).toEqual(['created'])
  })

  test('the everywhere list leaves out archived cards, archived projects and Board-off projects', async () => {
    const other = await makeProject(w.db, w.owner.userId, 'second')
    const keep = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'keep',
    })
    const gone = await createCard(w.owner, {
      projectId: other.id,
      title: 'gone with its project',
    })
    const archived = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'archived',
    })
    await setCardArchived(w.owner, {
      cardId: archived.id,
      expectedRevision: archived.revision,
      archived: true,
    })
    await w.db.execute(
      sql`update projects set status = 'archived', archived_at = now() where id = ${other.id}`,
    )
    const all = await listCards(w.owner)
    expect(all.map((card) => card.id)).toEqual([keep.id])
    expect(all[0]?.laneName).toBe('Backlog')
    expect(all[0]?.project?.slug).toBe('pilot')
    expect(
      (
        await listCards(w.owner, { projectId: other.id, includeArchived: true })
      ).map((c) => c.id),
    ).toEqual([gone.id])
  })

  test('a note promoted to a card lands in the first lane through the target registry', async () => {
    const created = await withTransaction((tx) =>
      createTarget(
        'card',
        { title: 'From a note', body: 'Three angles', labels: ['idea'] },
        { tx, actor: w.owner, project: w.project },
      ),
    )
    expect(created.type).toBe('card')
    expect(created.href).toBe(`/p/pilot/board?card=${created.id}`)
    const detail = await getCard(w.owner, created.id)
    expect(detail.lane.name).toBe('Backlog')
    expect(detail.card.body).toBe('Three angles')
  })

  test('due today is the project’s own date', async () => {
    const [today] = await w.db.execute<{ d: string }>(
      sql`select ((now() at time zone ${w.project.timezone})::date)::text as d`,
    )
    await createCard(w.owner, {
      projectId: w.project.id,
      title: 'due',
      dueOn: today?.d,
    })
    await createCard(w.owner, {
      projectId: w.project.id,
      title: 'late',
      dueOn: '2020-01-01',
    })
    const [summary] = await boardSummaries(w.owner)
    expect(summary?.dueToday).toBe(1)
    expect(summary?.overdue).toBe(1)
    expect(summary?.cards).toBe(2)
  })

  /* ── Trash ── */

  const ids = (cards: { id: string }[]) => cards.map((card) => card.id)

  test('Delete moves a card to the Trash: off the board and every list but Trash; Restore puts it at the end of its lane', async () => {
    const [a, b, c] = [
      await createCard(w.owner, { projectId: w.project.id, title: 'a' }),
      await createCard(w.owner, { projectId: w.project.id, title: 'b' }),
      await createCard(w.owner, { projectId: w.project.id, title: 'c' }),
    ]
    if (!a || !b || !c) throw new Error('no cards')
    const gone = await setCardDeleted(w.owner, {
      cardId: a.id,
      expectedRevision: a.revision,
      deleted: true,
    })
    expect(gone.deletedAt).not.toBeNull()
    expect(gone.archivedAt).not.toBeNull()
    const view = await openBoard(w.owner, w.project.id)
    expect(ids(view?.cards ?? [])).toEqual([b.id, c.id])
    expect(view?.cards.map((card) => card.position)).toEqual([0, 1])
    expect(view?.lanes[0]?.count).toBe(2)
    expect(ids(await listCards(w.owner))).toEqual([b.id, c.id])
    expect(ids(await listCards(w.owner, { includeArchived: true }))).toEqual([
      b.id,
      c.id,
    ])
    expect(await listCards(w.owner, { bucket: 'archived' })).toEqual([])
    expect(ids(await listCards(w.owner, { bucket: 'trash' }))).toEqual([a.id])
    expect((await boardSummaries(w.owner))[0]?.cards).toBe(2)
    expect((await getCard(w.owner, a.id)).card.deletedAt).not.toBeNull()

    const back = await setCardDeleted(w.owner, {
      cardId: a.id,
      expectedRevision: gone.revision,
      deleted: false,
    })
    expect(back.deletedAt).toBeNull()
    expect(back.archivedAt).toBeNull()
    expect(back.position).toBe(2)
    expect(ids(await listCards(w.owner))).toEqual([b.id, c.id, a.id])
    const history = (await getCard(w.owner, a.id)).events.map(
      (event) => event.kind,
    )
    expect(history.slice(0, 2)).toEqual(['undeleted', 'deleted'])
    const audit = await w.db
      .select({ action: opsAuditEvents.action })
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.targetId, a.id))
    expect(audit.map((row) => row.action)).toContain('board.card.delete')
    expect(audit.map((row) => row.action)).toContain('board.card.undelete')
  })

  test('a card deleted from Archived goes back to Archived, and Archive’s Restore can’t pull it out of the Trash', async () => {
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'finished',
    })
    const archived = await setCardArchived(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      archived: true,
    })
    expect(ids(await listCards(w.owner, { bucket: 'archived' }))).toEqual([
      card.id,
    ])
    const gone = await setCardDeleted(w.owner, {
      cardId: card.id,
      expectedRevision: archived.revision,
      deleted: true,
    })
    expect(await listCards(w.owner, { bucket: 'archived' })).toEqual([])
    const wrongWay = await failure(
      setCardArchived(w.owner, {
        cardId: card.id,
        expectedRevision: gone.revision,
        archived: false,
      }),
    )
    expect(wrongWay.message).toContain('Trash')
    const back = await setCardDeleted(w.owner, {
      cardId: card.id,
      expectedRevision: gone.revision,
      deleted: false,
    })
    expect(back.deletedAt).toBeNull()
    expect(back.archivedAt).not.toBeNull()
    expect(ids(await listCards(w.owner, { bucket: 'archived' }))).toEqual([
      card.id,
    ])
  })

  test('money in keeps a card out of the Trash — the service says why and the database backs it; only the owner deletes', async () => {
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'deposit came in',
      price: '10000',
    })
    const paid = await recordPayment(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      amount: '3000',
      kind: 'deposit',
    })
    const refused = await failure(
      setCardDeleted(w.owner, {
        cardId: card.id,
        expectedRevision: paid.card.revision,
        deleted: true,
      }),
    )
    expect(refused.code).toBe('invalid')
    expect(refused.message).toContain('Void its payments, or archive it')
    const check = await failure(
      w.db.execute(
        sql`update board_cards set archived_at = now(), deleted_at = now() where id = ${card.id}`,
      ),
    )
    expect(pgError(check).message).toContain('board_cards_deleted_check')
    // Voided, nothing counts any more: now it may go, its ledger kept.
    const voided = await voidPayment(w.owner, {
      cardId: card.id,
      expectedRevision: paid.card.revision,
      paymentId: paid.payment.id,
    })
    await allowAgent(w, ['draft'])
    const agentTry = await failure(
      setCardDeleted(w.agent, {
        cardId: card.id,
        expectedRevision: voided.card.revision,
        deleted: true,
      }),
    )
    expect(agentTry.code).toBe('forbidden')
    const gone = await setCardDeleted(w.owner, {
      cardId: card.id,
      expectedRevision: voided.card.revision,
      deleted: true,
    })
    expect(gone.deletedAt).not.toBeNull()
    expect((await getCard(w.owner, card.id)).payments).toHaveLength(2)
    expect(await paidSince(w.owner, 7)).toEqual([])
  })

  test('a card marked paid never goes to the Trash', async () => {
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'paid in full',
      price: '500',
    })
    const view = await openBoard(w.owner, w.project.id)
    const awaiting = view?.lanes.at(-1)
    if (!awaiting) throw new Error('no lane')
    const moved = await moveCard(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      laneId: awaiting.id,
    })
    const paid = await markPaid(w.owner, {
      cardId: card.id,
      expectedRevision: moved.revision,
    })
    const refused = await failure(
      setCardDeleted(w.owner, {
        cardId: card.id,
        expectedRevision: paid.revision,
        deleted: true,
      }),
    )
    expect(refused.message).toContain('marked paid')
  })

  /* ── Lanes: the owner's to shape ── */

  const lanesNow = async () =>
    ((await openBoard(w.owner, w.project.id))?.lanes ?? []).map((lane) => ({
      name: lane.name,
      position: lane.position,
    }))

  test('a new lane lands before Awaiting payment, which stays last; names are the board’s own', async () => {
    // No board yet: the lane's write makes it from the kind's preset first.
    const lane = await createLane(w.owner, {
      projectId: w.project.id,
      name: '  Shipping ',
    })
    expect(lane.name).toBe('Shipping')
    expect(lane.position).toBe(4)
    expect(await lanesNow()).toEqual([
      { name: 'Backlog', position: 0 },
      { name: 'Quoted', position: 1 },
      { name: 'Doing', position: 2 },
      { name: 'Review', position: 3 },
      { name: 'Shipping', position: 4 },
      { name: 'Awaiting payment', position: 5 },
    ])
    const twice = await failure(
      createLane(w.owner, { projectId: w.project.id, name: 'doing' }),
    )
    expect(twice.message).toContain('already has a lane called “Doing”')
    const blank = await failure(
      createLane(w.owner, { projectId: w.project.id, name: '   ' }),
    )
    expect(blank.code).toBe('invalid')
    const renamed = await renameLane(w.owner, {
      laneId: lane.id,
      name: 'Delivery',
    })
    expect(renamed.name).toBe('Delivery')
    await allowAgent(w, ['draft'])
    const agentTry = await failure(
      createLane(w.agent, { projectId: w.project.id, name: 'Agent lane' }),
    )
    expect(agentTry.code).toBe('forbidden')
    const audit = await w.db
      .select({ action: opsAuditEvents.action })
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.targetId, lane.id))
    expect(audit.map((row) => row.action).sort()).toEqual([
      'board.lane.create',
      'board.lane.rename',
    ])
  })

  test('moving a lane swaps it with its neighbour; nothing moves past Awaiting payment', async () => {
    const view = await openBoard(w.owner, w.project.id)
    const [backlog, quoted, , review, awaiting] = view?.lanes ?? []
    if (!backlog || !quoted || !review || !awaiting) throw new Error('lanes')
    const first = await failure(
      moveLane(w.owner, { laneId: backlog.id, direction: -1 }),
    )
    expect(first.message).toContain('already first')
    const moved = await moveLane(w.owner, { laneId: backlog.id, direction: 1 })
    expect(moved.position).toBe(1)
    expect((await lanesNow()).map((lane) => lane.name)).toEqual([
      'Quoted',
      'Backlog',
      'Doing',
      'Review',
      'Awaiting payment',
    ])
    const pastPinned = await failure(
      moveLane(w.owner, { laneId: review.id, direction: 1 }),
    )
    expect(pastPinned.message).toContain('Awaiting payment')
    const pinned = await failure(
      moveLane(w.owner, { laneId: awaiting.id, direction: -1 }),
    )
    expect(pinned.message).toContain('pinned right')
    // A new card lands in whichever lane is first now.
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'x',
    })
    expect(card.laneId).toBe(quoted.id)
  })

  test('deleting a lane: refused with live cards, for Awaiting payment and for the last lane to work in; its archived and deleted cards move to the first lane', async () => {
    const view = await openBoard(w.owner, w.project.id)
    const [backlog, , doing, review, awaiting] = view?.lanes ?? []
    if (!backlog || !doing || !review || !awaiting) throw new Error('lanes')
    const live = await createCard(w.owner, {
      projectId: w.project.id,
      laneId: doing.id,
      title: 'still going',
    })
    const busy = await failure(deleteLane(w.owner, { laneId: doing.id }))
    expect(busy.message).toContain('Move its card to another lane first')
    const owed = await failure(deleteLane(w.owner, { laneId: awaiting.id }))
    expect(owed.message).toContain('rename it instead')

    const done = await createCard(w.owner, {
      projectId: w.project.id,
      laneId: review.id,
      title: 'done',
    })
    const binned = await createCard(w.owner, {
      projectId: w.project.id,
      laneId: review.id,
      title: 'binned',
    })
    await setCardArchived(w.owner, {
      cardId: done.id,
      expectedRevision: done.revision,
      archived: true,
    })
    await setCardDeleted(w.owner, {
      cardId: binned.id,
      expectedRevision: binned.revision,
      deleted: true,
    })
    await allowAgent(w, ['draft'])
    const agentTry = await failure(deleteLane(w.agent, { laneId: review.id }))
    expect(agentTry.code).toBe('forbidden')
    const result = await deleteLane(w.owner, { laneId: review.id })
    expect(result.moved).toBe(2)
    expect(result.into?.id).toBe(backlog.id)
    expect(await lanesNow()).toEqual([
      { name: 'Backlog', position: 0 },
      { name: 'Quoted', position: 1 },
      { name: 'Doing', position: 2 },
      { name: 'Awaiting payment', position: 3 },
    ])
    const doneNow = await getCard(w.owner, done.id)
    expect(doneNow.card.laneId).toBe(backlog.id)
    expect(doneNow.events[0]?.kind).toBe('moved')
    expect(doneNow.events[0]?.data).toEqual({ laneDeleted: 'Review' })
    // Restored from the Trash, it lands in the lane it now belongs to.
    const binnedNow = await getCard(w.owner, binned.id)
    const back = await setCardDeleted(w.owner, {
      cardId: binned.id,
      expectedRevision: binnedNow.card.revision,
      deleted: false,
    })
    expect(back.laneId).toBe(backlog.id)

    // Down to one lane to work in: it stays.
    await setCardArchived(w.owner, {
      cardId: live.id,
      expectedRevision: live.revision,
      archived: true,
    })
    await deleteLane(w.owner, { laneId: doing.id })
    const quotedNow = (await openBoard(w.owner, w.project.id))?.lanes[1]
    if (!quotedNow) throw new Error('lanes')
    await deleteLane(w.owner, { laneId: quotedNow.id })
    await setCardArchived(w.owner, {
      cardId: back.id,
      expectedRevision: back.revision,
      archived: true,
    })
    const last = await failure(deleteLane(w.owner, { laneId: backlog.id }))
    expect(last.message).toContain('besides Awaiting payment')
  })

  test('a board without an awaiting lane keeps its last lane', async () => {
    const personal = await makeProject(w.db, w.owner.userId, 'solo', 'personal')
    const view = await openBoard(w.owner, personal.id)
    const [backlog, doing, done] = view?.lanes ?? []
    if (!backlog || !doing || !done) throw new Error('lanes')
    await deleteLane(w.owner, { laneId: doing.id })
    await deleteLane(w.owner, { laneId: backlog.id })
    const last = await failure(deleteLane(w.owner, { laneId: done.id }))
    expect(last.message).toContain('at least one lane')
    const again = (await openBoard(w.owner, personal.id))?.lanes ?? []
    expect(again.map((lane) => [lane.name, lane.position])).toEqual([
      ['Done', 0],
    ])
  })
})
