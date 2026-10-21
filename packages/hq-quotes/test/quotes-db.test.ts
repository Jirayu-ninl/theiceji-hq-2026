import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  createClient,
  listClients,
  setClientArchived,
  updateClient,
} from '@theiceji/hq-core/clients'
import { searchHq } from '@theiceji/hq-core/search'
import { setQuoteIssuer } from '@theiceji/hq-core/settings'
import {
  assetAssets,
  assetCollectionItems,
  assetCollections,
  opsAuditEvents,
  quoteLines,
  quoteQuotes,
  refs,
} from '@theiceji/hq-db/schema'
import { runOpsTick } from '@theiceji/hq-ops/runtime'
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
import { and, eq, sql } from 'drizzle-orm'
import {
  createDraft,
  deleteDraft,
  expireQuotes,
  getQuote,
  listQuotes,
  markDecision,
  previewQuotePdf,
  quoteSummaries,
  reviseQuote,
  type StorePdf,
  sendQuote,
  updateDraft,
} from '../src/quotes'
import '../src/register'

/**
 * Quotes against Postgres. Destructive (truncates), so it runs only with
 * QUOTES_DB_TESTS=1 and a localhost DATABASE_URL — a throwaway database.
 * Storage isn't configured here: sending stores its PDF through a stand-in
 * that keeps the bytes in memory; the asset row itself is real.
 */

const suite = dbTestsEnabled('QUOTES_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'quote_lines',
  'quote_quotes',
  'clients',
  'asset_collection_items',
  'asset_collections',
  'asset_assets',
]

type Kept = { name: string; bytes: Uint8Array; collection: string | null }

suite('hq-quotes against Postgres', () => {
  let w: World
  let kept: Kept[]
  const store: StorePdf = async (_actor, project, input) => {
    kept.push({
      name: input.name,
      bytes: input.body,
      collection: input.collection ?? null,
    })
    return {
      provider: 'r2',
      key: `test/${randomUUID()}.pdf`,
      path: `${project?.slug ?? '_hq'}/Quotes/${input.name}`,
      name: input.name,
      mime: input.mime,
      bytes: input.body.length,
      sha256: null,
    }
  }

  const year = async (zone = 'Asia/Bangkok') => {
    const [row] = await w.db.execute<{ y: string }>(
      sql`select to_char(now() at time zone ${zone}, 'YYYY') as y`,
    )
    return row?.y as string
  }
  const today = async (zone = 'Asia/Bangkok') => {
    const [row] = await w.db.execute<{ d: string }>(
      sql`select ((now() at time zone ${zone})::date)::text as d`,
    )
    return row?.d as string
  }
  const withIssuer = () =>
    setQuoteIssuer(w.owner, {
      expectedRevision: 0,
      name: 'Example Studio',
      taxId: '1100700123456',
      address: 'Bangkok',
      bank: 'Example Bank · 000-0-00000-0',
    })
  /** A draft that can be sent: a client, one line, VAT and WHT on. */
  const readyDraft = async (title = 'Brand deck v2') =>
    createDraft(w.owner, {
      projectId: w.project.id,
      title,
      client: { name: 'บริษัท กิ่งแก้ว ปั่นป่วน จำกัด', taxId: '0105561234567' },
      vat: true,
      wht: true,
      lines: [
        { description: 'ออกแบบแบรนด์', qty: 1, unitPrice: '30,000' },
        {
          description: 'Landing page',
          qty: '2',
          unit: 'page',
          unitPrice: 3000,
        },
      ],
    })

  beforeEach(async () => {
    w = await resetWorld(TABLES)
    kept = []
  })

  afterAll(() => closeTestDb(TABLES))

  /* ── Numbering ────────────────────────────────────────────────────── */

  test('numbers run Q-YYYY-NNN per owner, in the project’s year', async () => {
    const y = await year()
    const a = await createDraft(w.owner, {
      projectId: w.project.id,
      title: 'a',
    })
    const b = await createDraft(w.owner, {
      projectId: w.project.id,
      title: 'b',
    })
    const floating = await createDraft(w.owner, { title: 'no project' })
    expect([a.number, b.number, floating.number]).toEqual([
      `Q-${y}-001`,
      `Q-${y}-002`,
      `Q-${y}-003`,
    ])
    expect(a.status).toBe('draft')
    expect(a.currency).toBe('THB')
    expect(a.vatPct).toBe('0.00')
    expect(a.validDays).toBe(30)
    const theirs = await createDraft(w.stranger, {
      projectId: w.strangerProject.id,
      title: 'theirs',
    })
    expect(theirs.number).toBe(`Q-${y}-001`)
  })

  test('drafts made at the same moment never share a number', async () => {
    const y = await year()
    const made = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createDraft(w.owner, { projectId: w.project.id, title: `c${i}` }),
      ),
    )
    const numbers = made.map((quote) => quote.number).sort()
    expect(numbers).toEqual(
      Array.from({ length: 8 }, (_, i) => `Q-${y}-00${i + 1}`),
    )
  })

  test('a new year starts again at 001; past 999 the number grows', async () => {
    const y = await year()
    await w.db.insert(quoteQuotes).values([
      {
        ownerId: w.owner.userId,
        createdBy: w.owner.userId,
        projectId: w.project.id,
        number: `Q-${Number(y) - 1}-041`,
        title: 'last year',
      },
    ])
    const first = await createDraft(w.owner, {
      projectId: w.project.id,
      title: 'x',
    })
    expect(first.number).toBe(`Q-${y}-001`)
    await w.db.insert(quoteQuotes).values({
      ownerId: w.owner.userId,
      createdBy: w.owner.userId,
      number: `Q-${y}-999`,
      title: 'busy year',
    })
    const next = await createDraft(w.owner, {
      projectId: w.project.id,
      title: 'y',
    })
    expect(next.number).toBe(`Q-${y}-1000`)
    const after = await createDraft(w.owner, {
      projectId: w.project.id,
      title: 'z',
    })
    expect(after.number).toBe(`Q-${y}-1001`)
  })

  /* ── Drafts ───────────────────────────────────────────────────────── */

  test('a draft’s figures follow its lines, VAT and WHT, in exact decimals', async () => {
    const draft = await readyDraft()
    const detail = await getQuote(w.owner, draft.id)
    expect(
      detail.lines.map((line) => [line.position, line.qty, line.amount]),
    ).toEqual([
      [0, '1.000', '30000.00'],
      [1, '2.000', '6000.00'],
    ])
    expect(detail.totals).toEqual({
      currency: 'THB',
      vatPct: '7',
      whtPct: '3',
      subtotal: '36000.00',
      vat: '2520.00',
      wht: '1080.00',
      total: '37440.00',
    })
    expect(detail.client?.name).toBe('บริษัท กิ่งแก้ว ปั่นป่วน จำกัด')
    expect(detail.missing).toEqual(['Set your issuer name in Settings.'])

    const edited = await updateDraft(w.owner, {
      quoteId: draft.id,
      expectedRevision: draft.revision,
      wht: false,
      validDays: 14,
      notes: 'มัดจำ 50%',
      lines: [
        {
          description: 'ถ่ายภาพ',
          qty: '0.333',
          unit: 'วัน',
          unitPrice: '100.01',
        },
        { description: 'ตัดต่อ', unitPrice: '0.1' },
        { description: 'Extra', qty: 3, unitPrice: '0.10' },
      ],
    })
    expect(edited.revision).toBe(draft.revision + 1)
    expect(edited.whtPct).toBe('0.00')
    expect(edited.validDays).toBe(14)
    const after = await getQuote(w.owner, draft.id)
    expect(after.lines.map((line) => line.amount)).toEqual([
      '33.30',
      '0.10',
      '0.30',
    ])
    expect(after.totals).toMatchObject({
      subtotal: '33.70',
      vat: '2.36',
      wht: '0.00',
      total: '36.06',
    })

    const same = await updateDraft(w.owner, {
      quoteId: draft.id,
      expectedRevision: edited.revision,
      wht: false,
      notes: 'มัดจำ 50%',
    })
    expect(same.revision).toBe(edited.revision)

    const stale = await failure(
      updateDraft(w.owner, {
        quoteId: draft.id,
        expectedRevision: draft.revision,
        title: 'z',
      }),
    )
    expect(stale.code).toBe('conflict')
  })

  test('bad lines are refused in words, naming the line', async () => {
    const draft = await createDraft(w.owner, {
      projectId: w.project.id,
      title: 'x',
    })
    const error = await failure(
      updateDraft(w.owner, {
        quoteId: draft.id,
        expectedRevision: draft.revision,
        lines: [
          { description: 'ok', unitPrice: '1' },
          { description: 'bad', qty: 0, unitPrice: '1' },
        ],
      }),
    )
    expect(error.code).toBe('invalid')
    expect(error.message).toBe('Line 2: A quantity must be more than zero.')
    expect(error.fields).toMatchObject({
      'lines.1.qty': 'A quantity must be more than zero.',
    })
  })

  test('changing the currency checks the prices already there', async () => {
    const draft = await createDraft(w.owner, {
      projectId: w.project.id,
      title: 'x',
      lines: [{ description: 'a', unitPrice: '100.50' }],
    })
    const error = await failure(
      updateDraft(w.owner, {
        quoteId: draft.id,
        expectedRevision: draft.revision,
        currency: 'jpy',
      }),
    )
    expect(error.message).toBe('Line 1: JPY has no minor units.')
    const yen = await updateDraft(w.owner, {
      quoteId: draft.id,
      expectedRevision: draft.revision,
      currency: 'JPY',
      lines: [{ description: 'a', qty: '1.5', unitPrice: '101' }],
    })
    expect(yen.currency).toBe('JPY')
    expect((await getQuote(w.owner, draft.id)).totals.total).toBe('152')
  })

  test('a quote made from a card starts with its price and links card —quoted_by→ quote', async () => {
    const cardId = randomUUID()
    const quote = await createDraft(w.owner, {
      projectId: w.project.id,
      fromCard: { id: cardId, title: 'Website refresh', price: '24000' },
    })
    expect(quote.title).toBe('Website refresh')
    const detail = await getQuote(w.owner, quote.id)
    expect(
      detail.lines.map((line) => [line.description, line.unitPrice]),
    ).toEqual([['Website refresh', '24000.00']])
    expect(
      detail.refs.map((ref) => [
        ref.fromType,
        ref.fromId,
        ref.role,
        ref.toType,
        ref.toId,
      ]),
    ).toEqual([['card', cardId, 'quoted_by', 'quote', quote.id]])
  })

  test('a quote is only for a project with Quotes on; the currency is the project’s', async () => {
    const off = await makeProject(
      w.db,
      w.owner.userId,
      'no-quotes',
      'personal',
      ['calendar'],
    )
    const error = await failure(
      createDraft(w.owner, { projectId: off.id, title: 'x' }),
    )
    expect(error.message).toContain('Quotes is off')
    const usd = await makeProject(w.db, w.owner.userId, 'abroad')
    await w.db.execute(
      sql`update projects set currency = 'USD' where id = ${usd.id}`,
    )
    const quote = await createDraft(w.owner, { projectId: usd.id, title: 'x' })
    expect(quote.currency).toBe('USD')
  })

  /* ── Clients ──────────────────────────────────────────────────────── */

  test('clients: unique by name, found by name, archived but still referenced', async () => {
    const client = await createClient(w.owner, {
      name: 'Orbit Co.',
      email: 'ap@orbit.example',
      address: '1 Example Road',
    })
    const duplicate = await failure(
      createClient(w.owner, { name: 'orbit co.' }),
    )
    expect(duplicate.message).toBe('You already have a client with that name.')
    const badEmail = await failure(
      createClient(w.owner, { name: 'X', email: 'nope' }),
    )
    expect(badEmail.fields).toMatchObject({
      email: 'Enter an email such as name@example.com.',
    })
    const draft = await createDraft(w.owner, {
      projectId: w.project.id,
      title: 'x',
      client: { name: 'ORBIT CO.' },
    })
    expect(draft.clientId).toBe(client.id)
    const renamed = await updateClient(w.owner, {
      clientId: client.id,
      expectedRevision: client.revision,
      name: 'Orbit Company',
      phone: '02-000-0000',
    })
    expect(renamed.name).toBe('Orbit Company')
    const archived = await setClientArchived(w.owner, {
      clientId: client.id,
      expectedRevision: renamed.revision,
      archived: true,
    })
    expect(archived.archivedAt).not.toBeNull()
    expect(await listClients(w.owner)).toEqual([])
    expect(
      (await listClients(w.owner, { includeArchived: true })).map((c) => c.id),
    ).toEqual([client.id])
    expect((await getQuote(w.owner, draft.id)).client?.name).toBe(
      'Orbit Company',
    )
    const pick = await failure(
      createDraft(w.owner, {
        projectId: w.project.id,
        title: 'y',
        clientId: client.id,
      }),
    )
    expect(pick.message).toContain('archived')
    const strangerPick = await failure(
      createDraft(w.stranger, {
        projectId: w.strangerProject.id,
        title: 'y',
        clientId: client.id,
      }),
    )
    expect(strangerPick.code).toBe('not_found')
  })

  /* ── Sending ──────────────────────────────────────────────────────── */

  test('sending says exactly what is missing', async () => {
    const empty = await createDraft(w.owner, {
      projectId: w.project.id,
      title: 'x',
    })
    const error = await failure(
      sendQuote(
        w.owner,
        { quoteId: empty.id, expectedRevision: empty.revision },
        { store },
      ),
    )
    expect(error.code).toBe('invalid')
    expect(error.message).toBe(
      'To send this quote, add at least one line, choose a client and set your name as the issuer in Settings.',
    )
    expect(Object.keys(error.fields ?? {})).toEqual([
      'lines',
      'clientId',
      'issuer',
    ])
    await withIssuer()
    const onlyLines = await updateDraft(w.owner, {
      quoteId: empty.id,
      expectedRevision: empty.revision,
      lines: [{ description: 'a', unitPrice: '1' }],
    })
    const again = await failure(
      sendQuote(
        w.owner,
        { quoteId: empty.id, expectedRevision: onlyLines.revision },
        { store },
      ),
    )
    expect(again.message).toBe('To send this quote, choose a client.')
    expect(kept).toEqual([])
  })

  test('send renders, stores and freezes: dates in the zone, snapshot, PDF asset, refs, audit', async () => {
    await withIssuer()
    const draft = await readyDraft()
    const sent = await sendQuote(
      w.owner,
      { quoteId: draft.id, expectedRevision: draft.revision },
      { store },
    )
    const day = await today()
    expect(sent.status).toBe('sent')
    expect(sent.issuedOn).toBe(day)
    const expected = new Date(`${day}T00:00:00Z`)
    expected.setUTCDate(expected.getUTCDate() + 30)
    expect(sent.validUntil).toBe(expected.toISOString().slice(0, 10))
    expect(sent.sentAt).not.toBeNull()
    expect(sent.totalsSnapshot).toEqual({
      currency: 'THB',
      vatPct: '7',
      whtPct: '3',
      subtotal: '36000.00',
      vat: '2520.00',
      wht: '1080.00',
      total: '37440.00',
    })
    expect(kept).toHaveLength(1)
    expect(kept[0]?.name).toBe(`${sent.number}.pdf`)
    expect(kept[0]?.collection).toBe('Quotes')
    expect(new TextDecoder('latin1').decode(kept[0]?.bytes.slice(0, 5))).toBe(
      '%PDF-',
    )

    const [asset] = await w.db
      .select()
      .from(assetAssets)
      .where(eq(assetAssets.id, sent.pdfAssetId as string))
    expect(asset).toMatchObject({
      status: 'ready',
      kind: 'doc',
      mime: 'application/pdf',
      origin: 'generated',
      projectId: w.project.id,
      name: `${sent.number}.pdf`,
    })
    expect(asset?.tags).toEqual(['quote'])
    const [collection] = await w.db
      .select({ name: assetCollections.name })
      .from(assetCollectionItems)
      .innerJoin(
        assetCollections,
        eq(assetCollections.id, assetCollectionItems.collectionId),
      )
      .where(eq(assetCollectionItems.assetId, asset?.id as string))
    expect(collection?.name).toBe('Quotes')

    const detail = await getQuote(w.owner, sent.id)
    expect(detail.missing).toEqual([])
    expect(
      detail.refs
        .filter((ref) => ref.role === 'attached')
        .map((ref) => ref.toId),
    ).toEqual([asset?.id as string])
    const audit = await w.db
      .select()
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.action, 'quotes.quote.send'))
    expect(audit).toHaveLength(1)
    expect(audit[0]?.changes).toMatchObject({
      total: '37440.00',
      number: sent.number,
    })

    const resend = await failure(
      sendQuote(
        w.owner,
        { quoteId: sent.id, expectedRevision: sent.revision },
        { store },
      ),
    )
    expect(resend.message).toContain('already sent')
  })

  test('a sent quote is frozen by the database, not only by the service', async () => {
    await withIssuer()
    const draft = await readyDraft()
    const sent = await sendQuote(
      w.owner,
      { quoteId: draft.id, expectedRevision: draft.revision },
      { store },
    )
    const edit = await failure(
      updateDraft(w.owner, {
        quoteId: sent.id,
        expectedRevision: sent.revision,
        title: 'z',
      }),
    )
    expect(edit.message).toContain('Revise it back to a draft')
    const vat = await failure(
      w.db.execute(
        sql`update quote_quotes set vat_pct = 0 where id = ${sent.id}`,
      ),
    )
    expect(pgError(vat).message).toContain('a sent quote is frozen')
    const line = await failure(
      w.db.insert(quoteLines).values({
        ownerId: w.owner.userId,
        quoteId: sent.id,
        description: 'sneaked in',
        unitPrice: '1',
      }),
    )
    expect(pgError(line).message).toContain('lines are frozen')
    const price = await failure(
      w.db.execute(
        sql`update quote_lines set unit_price = 1 where quote_id = ${sent.id}`,
      ),
    )
    expect(pgError(price).message).toContain('lines are frozen')
    const gone = await failure(
      w.db.execute(sql`delete from quote_quotes where id = ${sent.id}`),
    )
    expect(pgError(gone).message).toContain('only a draft quote can be deleted')
  })

  test('the client’s answer, from sent only, and revising back to draft keeps the old PDF', async () => {
    await withIssuer()
    const draft = await readyDraft()
    const early = await failure(
      markDecision(w.owner, {
        quoteId: draft.id,
        expectedRevision: draft.revision,
        decision: 'accepted',
      }),
    )
    expect(early.message).toContain('Send this quote')
    const sent = await sendQuote(
      w.owner,
      { quoteId: draft.id, expectedRevision: draft.revision },
      { store },
    )
    const firstPdf = sent.pdfAssetId as string

    const revised = await reviseQuote(w.owner, {
      quoteId: sent.id,
      expectedRevision: sent.revision,
    })
    expect(revised).toMatchObject({
      status: 'draft',
      number: sent.number,
      issuedOn: null,
      validUntil: null,
      sentAt: null,
      totalsSnapshot: null,
      pdfAssetId: null,
    })
    const [old] = await w.db
      .select()
      .from(assetAssets)
      .where(eq(assetAssets.id, firstPdf))
    expect(old?.status).toBe('ready')
    const cannotDelete = await failure(
      deleteDraft(w.owner, {
        quoteId: revised.id,
        expectedRevision: revised.revision,
      }),
    )
    expect(cannotDelete.message).toContain('went to a client once')

    const edited = await updateDraft(w.owner, {
      quoteId: revised.id,
      expectedRevision: revised.revision,
      lines: [{ description: 'ออกแบบแบรนด์ (ลดราคา)', unitPrice: '32000' }],
    })
    const again = await sendQuote(
      w.owner,
      { quoteId: edited.id, expectedRevision: edited.revision },
      { store },
    )
    expect(again.pdfAssetId).not.toBe(firstPdf)
    expect(again.totalsSnapshot?.total).toBe('33280.00')
    const attached = (await getQuote(w.owner, again.id)).refs.filter(
      (ref) => ref.role === 'attached',
    )
    expect(attached.map((ref) => ref.toId).sort()).toEqual(
      [firstPdf, again.pdfAssetId as string].sort(),
    )

    const accepted = await markDecision(w.owner, {
      quoteId: again.id,
      expectedRevision: again.revision,
      decision: 'accepted',
    })
    expect(accepted.status).toBe('accepted')
    expect(accepted.decidedAt).not.toBeNull()
    expect(accepted.totalsSnapshot?.total).toBe('33280.00')
    const twice = await failure(
      markDecision(w.owner, {
        quoteId: again.id,
        expectedRevision: accepted.revision,
        decision: 'declined',
      }),
    )
    expect(twice.message).toContain('already recorded')
    const noRevise = await failure(
      reviseQuote(w.owner, {
        quoteId: again.id,
        expectedRevision: accepted.revision,
      }),
    )
    expect(noRevise.message).toContain('already answered')
  })

  test('the tick expires sent quotes past their last day in the project’s zone', async () => {
    const day = await today()
    const sentRow = (number: string, validUntil: string) => ({
      ownerId: w.owner.userId,
      createdBy: w.owner.userId,
      projectId: w.project.id,
      number,
      title: number,
      status: 'sent' as const,
      issuedOn: '2026-01-01',
      validUntil,
      sentAt: sql`now()`,
      totalsSnapshot: {
        currency: 'THB',
        vatPct: '0',
        whtPct: '0',
        subtotal: '100.00',
        vat: '0.00',
        wht: '0.00',
        total: '100.00',
      },
    })
    const [late] = await w.db
      .insert(quoteQuotes)
      .values(sentRow('Q-2026-901', '2026-01-31'))
      .returning()
    const [lastDay] = await w.db
      .insert(quoteQuotes)
      .values(sentRow('Q-2026-902', day))
      .returning()
    const report = await runOpsTick({ deliver: async () => ({ status: 204 }) })
    const step = report.steps.find((entry) => entry.name === 'quotes.expire')
    expect(step).toMatchObject({ ok: true, result: { expired: 1 } })
    const [a] = await w.db
      .select()
      .from(quoteQuotes)
      .where(eq(quoteQuotes.id, late?.id as string))
    const [b] = await w.db
      .select()
      .from(quoteQuotes)
      .where(eq(quoteQuotes.id, lastDay?.id as string))
    expect(a?.status).toBe('expired')
    expect(a?.revision).toBe(2)
    expect(b?.status).toBe('sent')
    const [audit] = await w.db
      .select()
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.action, 'quotes.quote.expire'))
    expect(audit).toMatchObject({
      actorType: 'worker',
      actorId: 'ops-scheduler',
      targetId: late?.id,
    })
    expect(await expireQuotes()).toBe(0)
    const revised = await reviseQuote(w.owner, {
      quoteId: a?.id as string,
      expectedRevision: 2,
    })
    expect(revised.status).toBe('draft')
  })

  /* ── Who may ──────────────────────────────────────────────────────── */

  test('an agent drafts under the owner’s policy and never sends, decides or deletes', async () => {
    const blocked = await failure(
      createDraft(w.agent, { projectId: w.project.id, title: 'x' }),
    )
    expect(blocked.code).toBe('policy_blocked')
    await allowAgent(w, ['draft'])
    await withIssuer()
    const draft = await createDraft(w.agent, {
      projectId: w.project.id,
      title: 'Drafted by an agent',
      client: { name: 'Agent Client Ltd' },
      lines: [{ description: 'Work', unitPrice: '1000' }],
    })
    expect(draft.createdBy).toBe(w.owner.userId)
    const edited = await updateDraft(w.agent, {
      quoteId: draft.id,
      expectedRevision: draft.revision,
      vat: true,
    })
    expect(edited.vatPct).toBe('7.00')
    const ref = { quoteId: draft.id, expectedRevision: edited.revision }
    for (const attempt of [
      () => sendQuote(w.agent, ref, { store }),
      () => deleteDraft(w.agent, ref),
      () => reviseQuote(w.agent, ref),
      () => markDecision(w.agent, { ...ref, decision: 'accepted' }),
    ]) {
      expect((await failure(attempt())).code).toBe('forbidden')
    }
    expect(kept).toEqual([])
    const noProject = await failure(createClient(w.agent, { name: 'Loose' }))
    expect(noProject.code).toBe('policy_blocked')
    const readerTry = await failure(
      createDraft(w.reader, { projectId: w.project.id, title: 'y' }),
    )
    expect(readerTry.code).toBe('forbidden')
    expect((await listQuotes(w.reader)).map((quote) => quote.id)).toEqual([
      draft.id,
    ])
  })

  test('someone else’s quotes read as not found and never list', async () => {
    const mine = await readyDraft()
    const peek = await failure(getQuote(w.stranger, mine.id))
    expect(peek.code).toBe('not_found')
    const edit = await failure(
      updateDraft(w.stranger, {
        quoteId: mine.id,
        expectedRevision: mine.revision,
        title: 'x',
      }),
    )
    expect(edit.code).toBe('not_found')
    const other = await failure(
      listQuotes(w.stranger, { projectId: w.project.id }),
    )
    expect(other.code).toBe('not_found')
    expect(await listQuotes(w.stranger)).toEqual([])
    expect(await quoteSummaries(w.stranger)).toEqual([])
    const theirs = await failure(
      createDraft(w.owner, { projectId: w.strangerProject.id, title: 'x' }),
    )
    expect(theirs.code).toBe('not_found')
  })

  test('the same idempotency key replays the first draft and spends one number', async () => {
    await allowAgent(w, ['draft'])
    const key = 'quote-key-0001'
    const input = {
      projectId: w.project.id,
      title: 'once',
      client: { name: 'New Client' },
      idempotencyKey: key,
    }
    const first = await createDraft(w.agent, input)
    const second = await createDraft(w.agent, input)
    expect(second.id).toBe(first.id)
    expect(second.number).toBe(first.number)
    const all = await w.db.select().from(quoteQuotes)
    expect(all).toHaveLength(1)
    const other = await failure(
      createDraft(w.agent, { ...input, title: 'different' }),
    )
    expect(other.code).toBe('idempotency_conflict')
  })

  /* ── Lists, summaries, deleting, search, preview ──────────────────── */

  test('lists and Home summaries: per project and currency, archived projects left out', async () => {
    await withIssuer()
    const a = await readyDraft('first')
    await sendQuote(
      w.owner,
      { quoteId: a.id, expectedRevision: a.revision },
      { store },
    )
    const b = await readyDraft('second')
    await sendQuote(
      w.owner,
      { quoteId: b.id, expectedRevision: b.revision },
      { store },
    )
    await createDraft(w.owner, {
      projectId: w.project.id,
      title: 'still a draft',
    })
    const loose = await createDraft(w.owner, {
      title: 'no project',
      lines: [{ description: 'x', unitPrice: '10' }],
    })
    const other = await makeProject(w.db, w.owner.userId, 'second')
    await createDraft(w.owner, {
      projectId: other.id,
      title: 'archived with its project',
    })
    await w.db.execute(
      sql`update projects set status = 'archived', archived_at = now() where id = ${other.id}`,
    )

    const all = await listQuotes(w.owner)
    expect(all.map((quote) => quote.title).sort()).toEqual(
      ['first', 'no project', 'second', 'still a draft'].sort(),
    )
    const sent = await listQuotes(w.owner, {
      projectId: w.project.id,
      status: 'sent',
    })
    expect(sent.map((quote) => quote.totals.total)).toEqual([
      '37440.00',
      '37440.00',
    ])
    expect(sent[0]?.client?.name).toBe('บริษัท กิ่งแก้ว ปั่นป่วน จำกัด')
    expect(sent[0]?.project?.slug).toBe('pilot')
    expect(sent[0]?.lineCount).toBe(2)
    const looseItem = all.find((quote) => quote.id === loose.id)
    expect(looseItem?.totals.total).toBe('10.00')
    expect(looseItem?.project).toBeNull()

    const summaries = await quoteSummaries(w.owner)
    expect(summaries.find((row) => row.projectId === w.project.id)).toEqual({
      projectId: w.project.id,
      currency: 'THB',
      drafts: 1,
      open: 2,
      pending: '74880.00',
      expiringSoon: 0,
    })
    expect(summaries.find((row) => row.projectId === null)).toMatchObject({
      drafts: 1,
      open: 0,
      pending: '0.00',
    })
    expect(summaries.some((row) => row.projectId === other.id)).toBe(false)
  })

  test('deleting a draft takes its lines and links with it', async () => {
    const cardId = randomUUID()
    const draft = await createDraft(w.owner, {
      projectId: w.project.id,
      fromCard: { id: cardId, title: 'Card', price: 100 },
    })
    await deleteDraft(w.owner, {
      quoteId: draft.id,
      expectedRevision: draft.revision,
    })
    expect(await w.db.select().from(quoteQuotes)).toEqual([])
    expect(await w.db.select().from(quoteLines)).toEqual([])
    expect(
      await w.db
        .select()
        .from(refs)
        .where(and(eq(refs.toType, 'quote'), eq(refs.toId, draft.id))),
    ).toEqual([])
    const [audit] = await w.db
      .select()
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.action, 'quotes.quote.delete'))
    expect(audit?.changes).toMatchObject({ number: draft.number })
  })

  test('search finds a quote by number or client', async () => {
    const draft = await readyDraft()
    const byNumber = await searchHq(w.owner, {
      query: draft.number,
      types: ['quote'],
    })
    expect(byNumber.map((hit) => hit.id)).toEqual([draft.id])
    expect(byNumber[0]?.href).toBe(`/p/pilot/quotes?quote=${draft.id}`)
    const byClient = await searchHq(w.owner, {
      query: 'กิ่งแก้ว',
      types: ['quote'],
    })
    expect(byClient.map((hit) => hit.id)).toEqual([draft.id])
    expect(
      await searchHq(w.stranger, { query: draft.number, types: ['quote'] }),
    ).toEqual([])
  })

  test('a preview renders the draft without storing anything', async () => {
    const draft = await readyDraft()
    const preview = await previewQuotePdf(w.owner, draft.id)
    expect(preview.draft).toBe(true)
    expect(preview.name).toBe(`${draft.number}.pdf`)
    expect(new TextDecoder('latin1').decode(preview.bytes.slice(0, 5))).toBe(
      '%PDF-',
    )
    expect(await w.db.select().from(assetAssets)).toEqual([])
    const reader = await previewQuotePdf(w.reader, draft.id)
    expect(reader.bytes.length).toBeGreaterThan(1000)
  })
})
