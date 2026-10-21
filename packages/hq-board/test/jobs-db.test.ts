import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createClient, setClientArchived } from '@theiceji/hq-core/clients'
import { moneySources } from '@theiceji/hq-core/readings'
import {
  boardCardEvents,
  boardCardPayments,
  promptPrompts,
  promptVariants,
} from '@theiceji/hq-db/schema'
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
  type BoardView,
  boardSummaries,
  clientLedger,
  createCard,
  getCard,
  listCards,
  markPaid,
  moveCard,
  openBoard,
  paidSince,
  unmarkPaid,
  updateCard,
} from '../src/board'
import {
  addFollowup,
  setFollowupArchived,
  updateFollowup,
} from '../src/followups'
import { cardLinks, setPrompt, unlinkFromCard } from '../src/links'
import { owedOf, recordPayment, voidPayment } from '../src/payments'
import '../src/register'

/**
 * A card as a whole client job: clients, colour, follow-ups that
 * add to the card's total, and the payment ledger — deposits, part
 * payments, the rest at Mark paid. Destructive (truncates), so it runs only
 * with BOARD_DB_TESTS=1 and a localhost DATABASE_URL — a throwaway database
 * migrated to the latest (0001 restores the guards, 0002 adds clients, follow-ups and payments).
 */

const suite = dbTestsEnabled('BOARD_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'board_card_payments',
  'board_followups',
  'board_card_events',
  'board_cards',
  'board_lanes',
  'board_boards',
  'clients',
  'refs',
  'prompt_variants',
  'prompt_prompts',
]

suite('hq-board · jobs, follow-ups and payments', () => {
  let w: World
  let view: BoardView

  beforeEach(async () => {
    w = await resetWorld(TABLES)
    view = (await openBoard(w.owner, w.project.id)) as BoardView
  })

  afterAll(() => closeTestDb(TABLES))

  const lane = (role: 'awaiting_payment' | 'first') =>
    (role === 'first'
      ? view.lanes[0]
      : view.lanes.find(
          (entry) => entry.role === role,
        )) as BoardView['lanes'][number]

  async function today(): Promise<string> {
    const [row] = await w.db.execute<{ day: string }>(
      sql`select ((now() at time zone ${w.project.timezone})::date)::text as day`,
    )
    return row?.day as string
  }
  const shift = (day: string, days: number) => {
    const d = new Date(`${day}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().slice(0, 10)
  }

  test('follow-ups add into the card’s total; the card is the record that changes', async () => {
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'Logo refinements',
      price: '8000',
    })
    expect(card.total).toBe('8000.00')
    const r2 = await addFollowup(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      title: 'Round 2 · wordmark spacing',
      price: '3,000',
      dueOn: '2026-09-28',
    })
    expect(r2.card.total).toBe('11000.00')
    expect(r2.card.revision).toBe(card.revision + 1)
    const note = await addFollowup(w.owner, {
      cardId: card.id,
      expectedRevision: r2.card.revision,
      title: 'Client prefers option B',
    })
    expect(note.card.total).toBe('11000.00')
    const edited = await updateFollowup(w.owner, {
      cardId: card.id,
      expectedRevision: note.card.revision,
      followupId: r2.followup.id,
      price: '3500.50',
    })
    expect(edited.card.total).toBe('11500.50')
    // A stale card revision is a conflict, never an overwrite.
    const stale = await failure(
      addFollowup(w.owner, {
        cardId: card.id,
        expectedRevision: note.card.revision,
        title: 'late',
      }),
    )
    expect(stale.code).toBe('conflict')
    const removed = await setFollowupArchived(w.owner, {
      cardId: card.id,
      expectedRevision: edited.card.revision,
      followupId: r2.followup.id,
      archived: true,
    })
    expect(removed.card.total).toBe('8000.00')
    const back = await setFollowupArchived(w.owner, {
      cardId: card.id,
      expectedRevision: removed.card.revision,
      followupId: r2.followup.id,
      archived: false,
    })
    expect(back.card.total).toBe('11500.50')
    const detail = await getCard(w.owner, card.id)
    expect(detail.followups.map((f) => f.title)).toEqual([
      'Round 2 · wordmark spacing',
      'Client prefers option B',
    ])
    const kinds = (
      await w.db
        .select({ kind: boardCardEvents.kind })
        .from(boardCardEvents)
        .where(eq(boardCardEvents.cardId, card.id))
    ).map((row) => row.kind)
    expect(kinds).toContain('followup_added')
    expect(kinds).toContain('followup_edited')
    expect(kinds).toContain('followup_removed')
    // A card with no price of its own still carries its follow-ups' money.
    const bare = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'Brand deck v2',
    })
    const investor = await addFollowup(w.owner, {
      cardId: bare.id,
      expectedRevision: bare.revision,
      title: 'Investor cut',
      price: 6000,
    })
    expect(investor.card.total).toBe('6000.00')
    expect(investor.card.currency).toBe('THB')
    expect(investor.card.price).toBeNull()
    const board = (await openBoard(w.owner, w.project.id)) as BoardView
    expect(board.lanes[0]?.sum).toBe('17500.50')
    expect(board.followups).toHaveLength(3)
  })

  test('agents add and edit follow-ups under the policy; removing is the owner’s', async () => {
    await allowAgent(w, ['draft'])
    const card = await createCard(w.agent, {
      projectId: w.project.id,
      title: 'x',
    })
    const added = await addFollowup(w.agent, {
      cardId: card.id,
      expectedRevision: card.revision,
      title: 'y',
      price: '100',
    })
    expect(added.card.total).toBe('100.00')
    const refused = await failure(
      setFollowupArchived(w.agent, {
        cardId: card.id,
        expectedRevision: added.card.revision,
        followupId: added.followup.id,
        archived: true,
      }),
    )
    expect(refused.code).toBe('forbidden')
  })

  test('a deposit of any size, part payments, then Mark paid records the rest', async () => {
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'Logo refinements',
      price: '8000',
    })
    const dep = await recordPayment(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      kind: 'deposit',
      amount: '3,000',
      note: 'มัดจำ',
    })
    expect(dep.card.paidTotal).toBe('3000.00')
    expect(owedOf(dep.card)).toBe('5000.00')
    // Follow-ups keep coming while money comes in part by part.
    const more = await addFollowup(w.owner, {
      cardId: card.id,
      expectedRevision: dep.card.revision,
      title: 'Round 2',
      price: '5500',
    })
    expect(owedOf(more.card)).toBe('10500.00')
    const part = await recordPayment(w.owner, {
      cardId: card.id,
      expectedRevision: more.card.revision,
      kind: 'part',
      amount: 4000,
    })
    expect(part.card.paidTotal).toBe('7000.00')
    // In the awaiting lane, the pending money is what is still owed.
    const moved = await moveCard(w.owner, {
      cardId: card.id,
      expectedRevision: part.card.revision,
      laneId: lane('awaiting_payment').id,
    })
    const summary = (await boardSummaries(w.owner)).find(
      (row) => row.projectId === w.project.id,
    )
    expect(summary?.awaiting).toEqual([
      { currency: 'THB', sum: '6500.00', cards: 1 },
    ])
    const board = (await openBoard(w.owner, w.project.id)) as BoardView
    const awaiting = board.lanes.find(
      (entry) => entry.role === 'awaiting_payment',
    )
    expect(awaiting?.sum).toBe('13500.00')
    expect(awaiting?.owed).toBe('6500.00')
    const paid = await markPaid(w.owner, {
      cardId: card.id,
      expectedRevision: moved.revision,
    })
    expect(paid.paidTotal).toBe('13500.00')
    expect(paid.archivedAt).not.toBeNull()
    const lines = await w.db
      .select()
      .from(boardCardPayments)
      .where(eq(boardCardPayments.cardId, card.id))
    expect(lines.map((line) => [line.kind, line.amount])).toEqual([
      ['deposit', '3000.00'],
      ['part', '4000.00'],
      ['final', '6500.00'],
    ])
    // Money in: every line on its own day, summing to the card's total.
    const came = await paidSince(w.owner, 7)
    expect(came).toEqual([
      { projectId: w.project.id, currency: 'THB', sum: '13500.00', cards: 1 },
    ])
    const source = moneySources().find((entry) => entry.module === 'board')
    const now = Date.now()
    const window = await source?.lines(w.db, w.owner.userId, {
      from: new Date(now - 7 * 86_400_000),
      to: new Date(now + 86_400_000),
      projectId: null,
    })
    expect(window?.map((line) => line.amount).sort()).toEqual([
      '3000.00',
      '4000.00',
      '6500.00',
    ])
    // Frozen once paid.
    const frozen = await failure(
      addFollowup(w.owner, {
        cardId: card.id,
        expectedRevision: paid.revision,
        title: 'too late',
      }),
    )
    expect(frozen.message).toContain('marked paid')
    // Undo strikes the final line and reopens the card.
    const undone = await unmarkPaid(w.owner, {
      cardId: card.id,
      expectedRevision: paid.revision,
    })
    expect(undone.paidTotal).toBe('7000.00')
    expect(undone.archivedAt).toBeNull()
    const kinds = (
      await w.db
        .select({ kind: boardCardPayments.kind })
        .from(boardCardPayments)
        .where(eq(boardCardPayments.cardId, card.id))
    ).map((row) => row.kind)
    expect(kinds).toEqual(['deposit', 'part', 'final', 'void'])
  })

  test('a card paid in full part by part records nothing more at Mark paid', async () => {
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'x',
      price: '1000',
    })
    const all = await recordPayment(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      kind: 'deposit',
      amount: '1000',
    })
    const moved = await moveCard(w.owner, {
      cardId: card.id,
      expectedRevision: all.card.revision,
      laneId: lane('awaiting_payment').id,
    })
    await markPaid(w.owner, {
      cardId: card.id,
      expectedRevision: moved.revision,
    })
    const lines = await w.db
      .select()
      .from(boardCardPayments)
      .where(eq(boardCardPayments.cardId, card.id))
    expect(lines).toHaveLength(1)
  })

  test('void strikes a line, keeps it, and the ledger refuses edits', async () => {
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'x',
      price: '5000',
    })
    const dep = await recordPayment(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      kind: 'deposit',
      amount: '2000',
    })
    const struck = await voidPayment(w.owner, {
      cardId: card.id,
      expectedRevision: dep.card.revision,
      paymentId: dep.payment.id,
      reason: 'wrong card',
    })
    expect(struck.card.paidTotal).toBe('0.00')
    expect(struck.payment.voidsId).toBe(dep.payment.id)
    const twice = await failure(
      voidPayment(w.owner, {
        cardId: card.id,
        expectedRevision: struck.card.revision,
        paymentId: dep.payment.id,
      }),
    )
    expect(twice.message).toContain('already voided')
    const detail = await getCard(w.owner, card.id)
    expect(detail.payments).toHaveLength(2)
    const edit = await failure(
      w.db
        .update(boardCardPayments)
        .set({ note: 'x' })
        .where(eq(boardCardPayments.id, dep.payment.id)),
    )
    expect(pgError(edit).message).toContain('append-only')
  })

  test('money is the owner’s: no agent records it, and none lands in the future', async () => {
    await allowAgent(w, ['draft'])
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'x',
      price: '5000',
    })
    const agent = await failure(
      recordPayment(w.agent, {
        cardId: card.id,
        expectedRevision: card.revision,
        kind: 'deposit',
        amount: '100',
      }),
    )
    expect(agent.code).toBe('forbidden')
    const ahead = await failure(
      recordPayment(w.owner, {
        cardId: card.id,
        expectedRevision: card.revision,
        kind: 'deposit',
        amount: '100',
        receivedOn: shift(await today(), 2),
      }),
    )
    expect(ahead.message).toContain('not ahead')
    const zero = await failure(
      recordPayment(w.owner, {
        cardId: card.id,
        expectedRevision: card.revision,
        kind: 'part',
        amount: '0',
      }),
    )
    expect(zero.code).toBe('invalid')
    // Paying ahead of an unpriced follow-up is allowed; the card reads overpaid.
    const over = await recordPayment(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      kind: 'deposit',
      amount: '6000',
    })
    expect(owedOf(over.card)).toBe('-1000.00')
    const moved = await moveCard(w.owner, {
      cardId: card.id,
      expectedRevision: over.card.revision,
      laneId: lane('awaiting_payment').id,
    })
    expect(moved.laneId).toBe(lane('awaiting_payment').id)
    const summary = (await boardSummaries(w.owner)).find(
      (row) => row.projectId === w.project.id,
    )
    expect(summary?.awaiting).toEqual([
      { currency: 'THB', sum: '0.00', cards: 1 },
    ])
  })

  test('the currency stays once follow-ups or money count in it', async () => {
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'x',
      price: '100',
    })
    const dep = await recordPayment(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      kind: 'deposit',
      amount: '50',
    })
    const error = await failure(
      updateCard(w.owner, {
        cardId: card.id,
        expectedRevision: dep.card.revision,
        price: '120',
        currency: 'USD',
      }),
    )
    expect(error.message).toContain('currency')
    // Clearing the price keeps the currency the payment is in.
    const cleared = await updateCard(w.owner, {
      cardId: card.id,
      expectedRevision: dep.card.revision,
      price: null,
    })
    expect(cleared.total).toBeNull()
    expect(cleared.currency).toBe('THB')
  })

  test('a client is a record or a name used once — never both', async () => {
    const orbit = await createClient(w.owner, { name: 'Orbit Co.' })
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'Brand deck',
      clientId: orbit.id,
      color: 'violet',
    })
    expect(card.clientId).toBe(orbit.id)
    expect(card.client).toBeNull()
    expect(card.color).toBe('violet')
    const both = await failure(
      createCard(w.owner, {
        projectId: w.project.id,
        title: 'x',
        clientId: orbit.id,
        client: 'Mint Café',
      }),
    )
    expect(both.code).toBe('invalid')
    const once = await updateCard(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      client: 'Mint Café',
    })
    expect(once.client).toBe('Mint Café')
    expect(once.clientId).toBeNull()
    const back = await updateCard(w.owner, {
      cardId: card.id,
      expectedRevision: once.revision,
      clientId: orbit.id,
      color: null,
    })
    expect(back.clientId).toBe(orbit.id)
    expect(back.client).toBeNull()
    expect(back.color).toBeNull()
    const listed = await listCards(w.owner, { clientId: orbit.id })
    expect(listed.map((row) => row.clientName)).toEqual(['Orbit Co.'])
    const bad = await failure(
      updateCard(w.owner, {
        cardId: card.id,
        expectedRevision: back.revision,
        color: 'neon' as 'violet',
      }),
    )
    expect(bad.code).toBe('invalid')
    const archived = await setClientArchived(w.owner, {
      clientId: orbit.id,
      expectedRevision: orbit.revision,
      archived: true,
    })
    expect(archived.archivedAt).not.toBeNull()
    const gone = await failure(
      createCard(w.owner, {
        projectId: w.project.id,
        title: 'y',
        clientId: orbit.id,
      }),
    )
    expect(gone.message).toContain('archived')
    const stranger = await createClient(w.stranger, { name: 'Theirs' })
    const theirs = await failure(
      createCard(w.owner, {
        projectId: w.project.id,
        title: 'z',
        clientId: stranger.id,
      }),
    )
    expect(theirs.code).toBe('not_found')
  })

  test('a job is due by its nearest date ahead — the card’s or a follow-up’s', async () => {
    const day = await today()
    const late = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'past its own due, follow-up ahead',
      dueOn: shift(day, -3),
    })
    await addFollowup(w.owner, {
      cardId: late.id,
      expectedRevision: late.revision,
      title: 'round 3',
      dueOn: shift(day, 2),
    })
    const todayJob = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'follow-up due today',
      dueOn: shift(day, -1),
    })
    await addFollowup(w.owner, {
      cardId: todayJob.id,
      expectedRevision: todayJob.revision,
      title: 'send files',
      dueOn: day,
    })
    await createCard(w.owner, {
      projectId: w.project.id,
      title: 'plain late',
      dueOn: shift(day, -1),
    })
    const summary = (await boardSummaries(w.owner)).find(
      (row) => row.projectId === w.project.id,
    )
    expect(summary?.cards).toBe(3)
    expect(summary?.dueToday).toBe(1)
    expect(summary?.overdue).toBe(1)
  })

  test('a lane sum keeps exact decimals across follow-ups', async () => {
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'x',
      price: '0.10',
    })
    const f = await addFollowup(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      title: 'y',
      price: '0.20',
    })
    expect(f.card.total).toBe('0.30')
    const board = (await openBoard(w.owner, w.project.id)) as BoardView
    expect(
      board.lanes.find((entry) => entry.id === lane('first').id)?.sum,
    ).toBe('0.30')
  })

  test('a client’s ledger counts each baht once: paid, awaiting, still on the board', async () => {
    const orbit = await createClient(w.owner, { name: 'Orbit Co.' })
    const doing = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'Logo',
      price: '8000',
      clientId: orbit.id,
    })
    const dep = await recordPayment(w.owner, {
      cardId: doing.id,
      expectedRevision: doing.revision,
      kind: 'deposit',
      amount: '3000',
    })
    const invoice = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'Website · invoice 2 of 2',
      price: '24000',
      clientId: orbit.id,
    })
    await moveCard(w.owner, {
      cardId: invoice.id,
      expectedRevision: invoice.revision,
      laneId: lane('awaiting_payment').id,
    })
    await createCard(w.owner, {
      projectId: w.project.id,
      title: 'once',
      price: '999',
      client: 'Mint Café',
    })
    const [row, ...rest] = await clientLedger(w.owner)
    expect(rest).toEqual([])
    expect(row?.clientId).toBe(orbit.id)
    expect(row?.cards).toBe(2)
    expect(row?.projectIds).toEqual([w.project.id])
    expect(row?.paidThisYear).toEqual([{ currency: 'THB', sum: '3000.00' }])
    expect(row?.onBoard).toEqual([{ currency: 'THB', sum: '5000.00' }])
    expect(row?.awaiting).toEqual([{ currency: 'THB', sum: '24000.00' }])
    expect(dep.card.paidTotal).toBe('3000.00')
  })

  test('a project in the Trash leaves the ledger; an archived one stays in it', async () => {
    const orbit = await createClient(w.owner, { name: 'Orbit Co.' })
    const side = await makeProject(w.db, w.owner.userId, 'side')
    await createCard(w.owner, {
      projectId: w.project.id,
      title: 'here',
      price: '1000',
      clientId: orbit.id,
    })
    const there = await createCard(w.owner, {
      projectId: side.id,
      title: 'there',
      price: '500',
      clientId: orbit.id,
    })
    await recordPayment(w.owner, {
      cardId: there.id,
      expectedRevision: there.revision,
      kind: 'deposit',
      amount: '200',
    })
    await w.db.execute(
      sql`update projects set status = 'archived', archived_at = now() where id = ${side.id}`,
    )
    const [archived] = await clientLedger(w.owner)
    expect(archived?.cards).toBe(2)
    expect(archived?.paidThisYear).toEqual([{ currency: 'THB', sum: '200.00' }])
    await w.db.execute(
      sql`update projects set deleted_at = now() where id = ${side.id}`,
    )
    const [trashed] = await clientLedger(w.owner)
    expect(trashed?.cards).toBe(1)
    expect(trashed?.projectIds).toEqual([w.project.id])
    expect(trashed?.onBoard).toEqual([{ currency: 'THB', sum: '1000.00' }])
    expect(trashed?.paidThisYear).toEqual([])
  })

  test('a card or a follow-up links the prompt it ran on — one each; unlinking keeps the prompt', async () => {
    const prompt = async (ownerId: string, title: string) => {
      const [p] = await w.db
        .insert(promptPrompts)
        .values({ ownerId, createdBy: ownerId, title, medium: 'image' })
        .returning()
      const [a] = await w.db
        .insert(promptVariants)
        .values({
          ownerId,
          createdBy: ownerId,
          promptId: p?.id as string,
          label: 'A',
          text: `${title} · variant A`,
          isDefault: true,
        })
        .returning()
      return { prompt: p, variant: a }
    }
    const logo = await prompt(w.owner.userId, 'Logo sketch, monoline')
    const menu = await prompt(w.owner.userId, 'Menu illustration')
    const card = await createCard(w.owner, {
      projectId: w.project.id,
      title: 'Logo',
    })
    const round = await addFollowup(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      title: 'Round 2',
    })
    await setPrompt(w.owner, {
      cardId: card.id,
      promptId: logo.prompt?.id as string,
    })
    await setPrompt(w.owner, {
      cardId: card.id,
      promptId: menu.prompt?.id as string,
    })
    await setPrompt(w.owner, {
      cardId: card.id,
      followupId: round.followup.id,
      promptId: logo.prompt?.id as string,
      variantId: logo.variant?.id as string,
    })
    const links = await cardLinks(w.owner, card.id)
    expect(
      links.prompts.map((link) => [link.holder.type, link.title, link.text]),
    ).toEqual(
      expect.arrayContaining([
        ['card', 'Menu illustration', 'Menu illustration · variant A'],
        [
          'followup',
          'Logo sketch, monoline',
          'Logo sketch, monoline · variant A',
        ],
      ]),
    )
    expect(links.prompts).toHaveLength(2)
    const counted = (await openBoard(w.owner, w.project.id))?.links
    expect(counted).toEqual([{ cardId: card.id, prompts: 2, files: 0 }])
    const cardLink = links.prompts.find((link) => link.holder.type === 'card')
    await unlinkFromCard(w.owner, {
      cardId: card.id,
      refId: cardLink?.refId as string,
    })
    expect((await cardLinks(w.owner, card.id)).prompts).toHaveLength(1)
    const theirs = await prompt(w.stranger.userId, 'Theirs')
    const refused = await failure(
      setPrompt(w.owner, {
        cardId: card.id,
        promptId: theirs.prompt?.id as string,
      }),
    )
    expect(refused.code).toBe('not_found')

    // A prompt put away is restored in Prompts before a job links it.
    const old = await prompt(w.owner.userId, 'Old poster')
    await w.db
      .update(promptPrompts)
      .set({ archivedAt: sql`now()` })
      .where(eq(promptPrompts.id, old.prompt?.id as string))
    const archived = await failure(
      setPrompt(w.owner, {
        cardId: card.id,
        promptId: old.prompt?.id as string,
      }),
    )
    expect(archived.code).toBe('invalid')
    expect(archived.message).toContain('archived')
    await w.db
      .update(promptPrompts)
      .set({ deletedAt: sql`now()` })
      .where(eq(promptPrompts.id, old.prompt?.id as string))
    const binned = await failure(
      setPrompt(w.owner, {
        cardId: card.id,
        followupId: round.followup.id,
        promptId: old.prompt?.id as string,
      }),
    )
    expect(binned.message).toContain('in the Trash')
    const still = await cardLinks(w.owner, card.id)
    expect(still.prompts.map((link) => link.title)).toEqual([
      'Logo sketch, monoline',
    ])
  })
})
