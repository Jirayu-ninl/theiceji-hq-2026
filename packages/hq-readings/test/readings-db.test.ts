import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  createCard,
  markPaid,
  moveCard,
  openBoard,
} from '@theiceji/hq-board/board'
import '@theiceji/hq-board/register'
import { opsUsageEvents } from '@theiceji/hq-db/schema'
import { saveMarketplace } from '@theiceji/hq-market/market'
import '@theiceji/hq-market/register'
import { recordSale } from '@theiceji/hq-market/sales'
import {
  closeTestDb,
  dbTestsEnabled,
  failure,
  makeProject,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import {
  planPost,
  recordManualPost,
  saveAccount,
} from '@theiceji/hq-publish/publish'
import { recordReading } from '@theiceji/hq-publish/readings'
import '@theiceji/hq-publish/register'
import { sql } from 'drizzle-orm'
import {
  costSince,
  dashboard,
  moneyReadings,
  moneySince,
  readingsQuery,
  weeklyNet,
} from '../src/readings'

/**
 * Readings against Postgres: money from Board, Market and Publish through the
 * hq-core registry, cost from ops usage, posts read at an age. Destructive
 * (truncates), so it runs only with READINGS_DB_TESTS=1 and a localhost
 * DATABASE_URL.
 */

const suite = dbTestsEnabled('READINGS_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'publish_readings',
  'publish_intents',
  'publish_posts',
  'publish_accounts',
  'market_sales_events',
  'market_payouts',
  'market_intents',
  'market_listings',
  'market_product_files',
  'market_products',
  'market_marketplaces',
  'board_card_events',
  'board_cards',
  'board_lanes',
  'board_boards',
]

const HOUR = 3_600_000
const DAY = 24 * HOUR

suite('hq-readings against Postgres', () => {
  let w: World

  beforeEach(async () => {
    w = await resetWorld(TABLES, { kind: 'channel' })
  })
  afterAll(() => closeTestDb(TABLES))

  async function world() {
    // A channel post with views at 72 hours and a week of earnings.
    const account = await saveAccount(w.owner, {
      projectId: w.project.id,
      platform: 'manual',
      handle: 'blog',
    })
    const planned = await planPost(w.owner, {
      projectId: w.project.id,
      accountId: account.id,
      caption: 'Desk setup in 30s',
    })
    const post = await recordManualPost(w.owner, {
      postId: planned.id,
      url: 'https://blog.example/1',
      postedAt: new Date(Date.now() - 100 * HOUR),
    })
    await recordReading(w.owner, {
      postId: post.id,
      metric: 'views',
      value: 800,
      asOf: new Date(Date.now() - 30 * HOUR),
    })
    await recordReading(w.owner, {
      postId: post.id,
      metric: 'earnings',
      value: '300',
      currency: 'THB',
      windowStart: new Date(Date.now() - 50 * HOUR),
      windowEnd: new Date(Date.now() - 2 * HOUR),
    })
    // A sale this week and one the week before, in USD.
    const shop = await saveMarketplace(w.owner, {
      projectId: w.project.id,
      kind: 'manual',
      shop: 'Own store',
      currency: 'USD',
    })
    await recordSale(w.owner, {
      marketplaceId: shop.id,
      kind: 'sale',
      amount: '12.00',
      fees: '1.00',
      occurredAt: new Date(Date.now() - 2 * HOUR),
    })
    await recordSale(w.owner, {
      marketplaceId: shop.id,
      kind: 'sale',
      amount: '20.00',
      occurredAt: new Date(Date.now() - 10 * DAY),
    })
    // A freelance card paid this week, in THB.
    const studio = await makeProject(
      w.db,
      w.owner.userId,
      'studio',
      'freelance',
    )
    const board = await openBoard(w.owner, studio.id)
    const awaiting = board?.lanes.find(
      (lane) => lane.role === 'awaiting_payment',
    )
    const card = await createCard(w.owner, {
      projectId: studio.id,
      title: 'Brand deck',
      price: '5000',
    })
    const moved = await moveCard(w.owner, {
      cardId: card.id,
      expectedRevision: card.revision,
      laneId: awaiting?.id as string,
    })
    await markPaid(w.owner, {
      cardId: card.id,
      expectedRevision: moved.revision,
    })
    // A generation that cost THB 1.50, and one nobody priced.
    for (const [cost, status] of [
      [150, 'estimated'],
      [null, 'unknown'],
    ] as const)
      await w.db.insert(opsUsageEvents).values({
        ownerId: w.owner.userId,
        projectId: w.project.id,
        subjectType: 'post',
        subjectId: post.id,
        provider: 'external:openai_compatible',
        kind: 'cash',
        unit: 'image',
        quantity: 1,
        costMinor: cost,
        currency: cost === null ? null : 'THB',
        costStatus: status,
        // Postgres's clock, like the ops ledger: the window
        // closes at the database's now, and a Node clock running ahead of it
        // would push these rows past the window's end.
        occurredAt: sql`now()`,
        actorType: 'user',
        actorId: w.owner.userId,
        createdBy: w.owner.userId,
      })
    return { post, studio }
  }

  test('money is what happened, per currency, never converted; the week before is its own', async () => {
    const { studio } = await world()
    const all = await dashboard(w.owner, { days: 7, ageHours: 72 })
    expect(all.total).toEqual([
      {
        currency: 'THB',
        sales: '0.00',
        refunds: '0.00',
        fees: '0.00',
        earnings: '300.00',
        paid: '5000.00',
        net: '5300.00',
      },
      {
        currency: 'USD',
        sales: '12.00',
        refunds: '0.00',
        fees: '-1.00',
        earnings: '0.00',
        paid: '0.00',
        net: '11.00',
      },
    ])
    expect(all.previousTotal).toEqual([
      expect.objectContaining({
        currency: 'USD',
        sales: '20.00',
        net: '20.00',
      }),
    ])
    expect(all.cost).toEqual([{ currency: 'THB', amount: '1.50' }])
    expect(all.costUnknown).toBe(1)
    const studioBoard = all.projects.find(
      (entry) => entry.project.id === studio.id,
    )
    expect(studioBoard?.money.map((line) => line.paid)).toEqual(['5000.00'])
    // A freelance project has neither Publish nor Market panels to show.
    const channel = all.projects.find(
      (entry) => entry.project.id === w.project.id,
    )
    const posts = channel?.subjects.find((panel) => panel.type === 'post')
    expect(posts?.rows[0]).toMatchObject({
      metric: 'views',
      atAge: { state: 'known', value: '800.0000' },
      toDate: { state: 'known', value: '300.00', currency: 'THB' },
    })
    const since = await moneySince(w.owner, 7)
    expect(since.byProject.get(studio.id)?.[0]?.paid).toBe('5000.00')
    // Home's lighter reads give State and Time the dashboard's own numbers.
    const costs = await costSince(w.owner, 7)
    expect(costs.get(w.project.id)).toEqual({
      cost: [{ currency: 'THB', amount: '1.50' }],
      unknown: 1,
    })
    for (const entry of all.projects) {
      expect(since.byProject.get(entry.project.id) ?? []).toEqual(entry.money)
      expect(since.previousByProject.get(entry.project.id) ?? []).toEqual(
        entry.previous,
      )
      expect(costs.get(entry.project.id) ?? { cost: [], unknown: 0 }).toEqual({
        cost: entry.cost,
        unknown: entry.costUnknown,
      })
    }
    // Home reads both from one pass over the sources: the same books.
    const both = await moneyReadings(w.owner, { days: 7, weeks: 8 })
    expect(both.since).toEqual(since)
    const weekly = await weeklyNet(w.owner, 8)
    expect(both.weekly.map((week) => week.book)).toEqual(
      weekly.map((week) => week.book),
    )
    expect(both.weekly.at(-1)?.book).toEqual(both.since.total)
  })

  test('one project, and readings_query at an age or to date', async () => {
    const { post } = await world()
    const one = await dashboard(w.owner, { projectId: w.project.id })
    expect(one.projects).toHaveLength(1)
    expect(one.total.map((line) => line.currency)).toEqual(['THB', 'USD'])
    const atAge = await readingsQuery(w.owner, {
      subjectType: 'post',
      projectId: w.project.id,
      metrics: ['views', 'likes'],
      ageHours: 72,
    })
    expect(atAge.rows[0]?.id).toBe(post.id)
    expect(atAge.rows[0]?.readings.views).toMatchObject({ state: 'known' })
    expect(atAge.rows[0]?.readings.likes).toEqual({ state: 'not_read' })
    const young = await readingsQuery(w.owner, {
      subjectType: 'post',
      ids: [post.id],
      metrics: ['views'],
      ageHours: 500,
    })
    expect(young.rows[0]?.readings.views?.state).toBe('too_young')
    const missing = await failure(
      readingsQuery(w.owner, { subjectType: 'post', metrics: ['views'] }),
    )
    expect(missing.code).toBe('invalid')
    const stranger = await readingsQuery(w.stranger, {
      subjectType: 'post',
      ids: [post.id],
      metrics: ['views'],
    })
    expect(stranger.rows).toHaveLength(0)
  })
})
