#!/usr/bin/env bun
/**
 * Acceptance for the MCP side: the `hq` workspace answers
 * over stdio — `hq_get_brief`, `hq_list_projects`, `hq_get_project`,
 * `hq_search` and `hq_get_capabilities` — against a throwaway database it
 * seeds itself (a user, two projects, an open request and an open task).
 *
 *   DATABASE_URL=postgres://…localhost…/<throwaway> bun run test/hq-stdio.ts
 *
 * Refuses anything but a localhost database, and truncates what it seeds.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createProject } from '@theiceji/hq-core/projects'
import { createDbHandle } from '@theiceji/hq-db'
import {
  assetAssets,
  opsHumanRequests,
  opsTasks,
  users,
} from '@theiceji/hq-db/schema'
import { saveMarketplace } from '@theiceji/hq-market/market'
import { userActor } from '@theiceji/hq-ops/access'
import { configureOpsDatabase } from '@theiceji/hq-ops/db'
import {
  authorizePost,
  planPost,
  saveAccount,
} from '@theiceji/hq-publish/publish'
import { catalog } from '@theiceji/mcp-kernel/catalog'
import { sql } from 'drizzle-orm'
import { MODULE_WORKSPACES } from '../src/modules'

const url = process.env.DATABASE_URL ?? ''
if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
  console.error(
    'Refusing: DATABASE_URL must be a localhost throwaway database.',
  )
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, '../src/stdio.ts')
const email = 'stdio-smoke@hq.test'

/* ── Seed ─────────────────────────────────────────────────────────── */
const handle = createDbHandle(url, { max: 2 })
configureOpsDatabase(handle.db)
await handle.db.execute(
  sql`truncate refs, ops_human_requests, ops_tasks, ops_audit_events, ops_idempotency_keys, board_boards, quote_quotes, clients, calendar_events, projects, users cascade`,
)
const [user] = await handle.db
  .insert(users)
  .values({ email, passwordHash: 'x', role: 'admin', name: 'Smoke' })
  .returning()
if (!user) throw new Error('no user')
const owner = userActor(user)
const client = await createProject(owner, {
  name: 'Client work',
  kind: 'freelance',
})
await createProject(owner, { name: 'Desk & Light', kind: 'channel' })
await handle.db.insert(opsHumanRequests).values({
  ownerId: user.id,
  projectId: client.id,
  createdBy: user.id,
  module: 'quotes',
  kind: 'approval',
  title: 'Send the Q-2026-014 quote?',
  reason: 'Sending a quote to a client is yours.',
  requestedAction: { tool: 'quotes_send', quote: 'Q-2026-014' },
  expiresAt: sql`now() + interval '3 days'`,
  actorType: 'user',
  actorId: user.id,
})
await handle.db.insert(opsTasks).values({
  ownerId: user.id,
  projectId: client.id,
  createdBy: user.id,
  kind: 'follow_up',
  module: 'board',
  title: 'Chase the invoice for the logo job',
})
// A channel account, a shop, a film, and files to sell.
const channel = await createProject(owner, {
  name: 'Desk Hooks',
  kind: 'channel',
})
const shopProject = await createProject(owner, {
  name: 'Paper Fog',
  kind: 'digital_assets',
})
const film = await createProject(owner, { name: 'Fog Line', kind: 'film' })
const account = await saveAccount(owner, {
  projectId: channel.id,
  platform: 'tiktok',
  handle: '@deskhooks',
})
const shop = await saveMarketplace(owner, {
  projectId: shopProject.id,
  kind: 'manual',
  shop: 'Own store',
  currency: 'USD',
})
const [pdf, png] = await handle.db
  .insert(assetAssets)
  .values(
    [
      ['set.pdf', 'doc', 'application/pdf'],
      ['cover.png', 'image', 'image/png'],
    ].map(([name, kind, mime]) => ({
      ownerId: user.id,
      createdBy: user.id,
      projectId: shopProject.id,
      storageProvider: 'r2' as const,
      storageKey: `stdio/${name}`,
      path: `paper-fog/${name}`,
      name: name as string,
      kind: kind as 'doc' | 'image',
      mime: mime as string,
      bytes: 100,
      status: 'ready' as const,
      readyAt: sql`now()`,
      actorType: 'user' as const,
      actorId: user.id,
    })),
  )
  .returning()
// The owner clears a post before the MCP call records it (clearing is theirs).
const cleared = await planPost(owner, {
  projectId: channel.id,
  accountId: account.id,
  caption: 'Wrist pain at your desk? Try this.',
})
const video = await handle.db
  .insert(assetAssets)
  .values({
    ownerId: user.id,
    createdBy: user.id,
    projectId: channel.id,
    storageProvider: 'r2',
    storageKey: 'stdio/hook.mp4',
    path: 'desk-hooks/hook.mp4',
    name: 'hook.mp4',
    kind: 'video',
    mime: 'video/mp4',
    bytes: 100,
    sha256: 'e'.repeat(64),
    status: 'ready',
    readyAt: sql`now()`,
    actorType: 'user',
    actorId: user.id,
  })
  .returning()
configureOpsDatabase(null)
await handle.sql.end({ timeout: 5 })

/* ── Call over stdio ──────────────────────────────────────────────── */
type Result = {
  isError?: boolean
  content?: { type: string; text?: string }[]
  structuredContent?: Record<string, unknown>
}

let failures = 0
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

const mcp = new Client({ name: 'hq-stdio', version: '0.0.0' })
await mcp.connect(
  new StdioClientTransport({
    command: 'bun',
    args: ['run', entry],
    env: {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      DATABASE_URL: url,
      HQ_LOCAL_USER_EMAIL: email,
    },
  }),
)
const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await mcp.callTool({ name, arguments: args })) as Result

const { tools } = await mcp.listTools()
const hqTools = tools
  .map((tool) => tool.name)
  .filter((name) => name.startsWith('hq_'))
  .sort()
check(
  'the hq workspace lists its seven tools',
  hqTools.join(',') ===
    'hq_create_client,hq_get_brief,hq_get_capabilities,hq_get_project,hq_list_clients,hq_list_projects,hq_search',
  hqTools.join(', '),
)

const brief = await call('hq_get_brief')
const data = brief.structuredContent as {
  ok: boolean
  projects: { name: string; waiting: number; openTasks: number }[]
  waiting: { title: string }[]
  tasks: { title: string }[]
}
console.log(`   hq_get_brief → ${brief.content?.[0]?.text}`)
check('hq_get_brief answers', !brief.isError && data.ok === true)
check(
  'the brief counts the open request on its project',
  data.projects.find((p) => p.name === 'Client work')?.waiting === 1,
)
check(
  'the brief lists the open task',
  data.tasks[0]?.title === 'Chase the invoice for the logo job',
)

const listed = await call('hq_list_projects')
console.log(`   hq_list_projects → ${listed.content?.[0]?.text}`)
check(
  'hq_list_projects lists every project, in order',
  (listed.structuredContent?.projects as { slug: string }[])
    ?.map((entry) => entry.slug)
    .join(',') === 'client-work,desk-light,desk-hooks,paper-fog,fog-line',
)

const project = await call('hq_get_project', { slug: 'client-work' })
check('hq_get_project by slug', !project.isError, project.content?.[0]?.text)

const found = await call('hq_search', { query: 'quote q-2026' })
check(
  'hq_search finds the request',
  ((found.structuredContent?.hits as { type: string }[]) ?? [])[0]?.type ===
    'human_request',
  found.content?.[0]?.text,
)

const capabilities = await call('hq_get_capabilities')
check(
  'hq_get_capabilities answers',
  !capabilities.isError,
  capabilities.content?.[0]?.text,
)

const refused = await call('hq_get_project', { slug: 'nope' })
check(
  'an unknown project is a typed not_found',
  refused.isError === true &&
    (refused.structuredContent?.error as { code?: string })?.code ===
      'not_found',
)

/* ── The active-work modules ─────────────────────────────── */
const named = (prefix: string) =>
  tools
    .map((tool) => tool.name)
    .filter((name) => name.startsWith(prefix))
    .sort()
for (const module of ['board', 'prompts', 'assets', 'calendar', 'quotes'])
  check(
    `the ${module} workspace lists its tools`,
    named(`${module}_`).length > 0,
    named(`${module}_`).join(', '),
  )
check(
  'quotes_list and quotes_draft are there',
  ['quotes_draft', 'quotes_list'].every((name) =>
    tools.some((tool) => tool.name === name),
  ),
)

const card = await call('board_create_card', {
  project_id: client.id,
  title: 'Logo refresh',
  price: '12000',
  idempotency_key: 'stdio-card-0001',
})
const cardId = (card.structuredContent?.card as { id?: string } | undefined)?.id
check('board_create_card with a price', !card.isError && Boolean(cardId))

const draft = await call('quotes_draft', {
  project_id: client.id,
  client: { name: 'บริษัท ทดสอบ จำกัด' },
  // Quotes never reads Board: the caller passes the card as board_list_cards shows it.
  from_card: { id: cardId, title: 'Logo refresh', price: '12000' },
  vat: true,
  idempotency_key: 'stdio-quote-0001',
})
check('quotes_draft from the card', !draft.isError, draft.content?.[0]?.text)

const quoted = await call('quotes_list', { project_id: client.id })
const first = (
  quoted.structuredContent?.quotes as
    | { status: string; totals?: { total: string } }[]
    | undefined
)?.[0]
check(
  'quotes_list shows the draft with VAT on the card’s price',
  first?.status === 'draft' && first.totals?.total === '12840.00',
  JSON.stringify(first?.totals),
)

/* ── Clients, card colour and money, follow-ups ─────────── */
type CardOut = {
  id: string
  revision: number
  client_id: string | null
  client: string | null
  client_name?: string | null
  color: string | null
  total: string | null
  paid_total: string
  owed: string | null
  followups?: { id: string; price: string | null }[]
  payments?: unknown[]
}
const cardOf = (result: Result) =>
  (result.structuredContent?.card ?? {}) as CardOut
const codeOf = (result: Result) =>
  (result.structuredContent?.error as { code?: string } | undefined)?.code

const orbit = await call('hq_create_client', {
  name: 'Orbit Co., Ltd.',
  tax_id: '0105559876543',
  idempotency_key: 'stdio-client-0001',
})
const orbitId = (orbit.structuredContent?.client as { id?: string })?.id
check('hq_create_client', !orbit.isError && Boolean(orbitId))
const clientNames = (
  ((await call('hq_list_clients')).structuredContent?.clients as {
    name: string
  }[]) ?? []
).map((entry) => entry.name)
check(
  'hq_list_clients lists the HQ-wide clients (the quote’s one too)',
  clientNames.includes('Orbit Co., Ltd.') &&
    clientNames.includes('บริษัท ทดสอบ จำกัด'),
  clientNames.join(', '),
)
const both = await call('board_create_card', {
  project_id: client.id,
  title: 'Two clients at once',
  client_id: orbitId,
  client: 'Somebody else',
  idempotency_key: 'stdio-card-0002',
})
check(
  'a card takes client_id or a name used once, not both',
  both.isError === true && codeOf(both) === 'validation_failed',
  both.content?.[0]?.text,
)
const deck = await call('board_create_card', {
  project_id: client.id,
  title: 'Orbit deck v2',
  price: '24000',
  client_id: orbitId,
  color: 'blue',
  idempotency_key: 'stdio-card-0003',
})
const deckCard = cardOf(deck)
check(
  'board_create_card with a client record and a colour',
  deckCard.client_id === orbitId &&
    deckCard.client === null &&
    deckCard.color === 'blue' &&
    deckCard.total === '24000.00' &&
    deckCard.paid_total === '0.00' &&
    deckCard.owed === '24000.00',
  deck.content?.[0]?.text,
)
const extra = await call('board_add_followup', {
  card_id: deckCard.id,
  expected_revision: deckCard.revision,
  title: 'Extra slides · 8 more',
  price: '6000',
  due_on: '2026-10-02',
  idempotency_key: 'stdio-followup-0001',
})
const afterExtra = cardOf(extra)
const extraId = (extra.structuredContent?.followup as { id?: string })?.id
check(
  'board_add_followup adds its price into the card’s total',
  !extra.isError &&
    afterExtra.total === '30000.00' &&
    afterExtra.owed === '30000.00' &&
    afterExtra.revision === deckCard.revision + 1,
  extra.content?.[0]?.text,
)
const replayed = await call('board_add_followup', {
  card_id: deckCard.id,
  expected_revision: deckCard.revision,
  title: 'Extra slides · 8 more',
  price: '6000',
  due_on: '2026-10-02',
  idempotency_key: 'stdio-followup-0001',
})
check(
  'a retried board_add_followup replays the first answer',
  (replayed.structuredContent?.followup as { id?: string })?.id === extraId,
  replayed.content?.[0]?.text,
)
const stale = await call('board_add_followup', {
  card_id: deckCard.id,
  expected_revision: deckCard.revision,
  title: 'Written against an old card',
  idempotency_key: 'stdio-followup-0002',
})
check(
  'a follow-up on a stale card revision is a revision_conflict',
  stale.isError === true && codeOf(stale) === 'revision_conflict',
  stale.content?.[0]?.text,
)
const note = await call('board_add_followup', {
  card_id: deckCard.id,
  expected_revision: afterExtra.revision,
  title: 'Client prefers palette B',
  body: 'On LINE, Thu: B, keep the old cover. No charge.',
  idempotency_key: 'stdio-followup-0003',
})
const afterNote = cardOf(note)
check(
  'a note-only follow-up leaves the total',
  !note.isError && afterNote.total === '30000.00',
  note.content?.[0]?.text,
)
const repriced = await call('board_update_followup', {
  card_id: deckCard.id,
  expected_revision: afterNote.revision,
  followup_id: extraId,
  price: 6500,
  idempotency_key: 'stdio-followup-0004',
})
check(
  'board_update_followup reprices the card',
  !repriced.isError && cardOf(repriced).total === '30500.00',
  repriced.content?.[0]?.text,
)
const one = await call('board_list_cards', { card_id: deckCard.id })
const full = cardOf(one)
check(
  'board_list_cards with card_id: the card in full, follow-ups and payments',
  full.client_name === 'Orbit Co., Ltd.' &&
    full.followups?.length === 2 &&
    full.followups[0]?.price === '6500.00' &&
    Array.isArray(full.payments),
  one.content?.[0]?.text,
)
const byClient = await call('board_list_cards', {
  project_id: client.id,
  client_id: orbitId,
})
const listedDeck = ((byClient.structuredContent?.cards as
  | CardOut[]
  | undefined) ?? [])[0]
check(
  'board_list_cards by client shows client_name, colour and money',
  listedDeck?.client_name === 'Orbit Co., Ltd.' &&
    listedDeck.color === 'blue' &&
    listedDeck.total === '30500.00' &&
    listedDeck.owed === '30500.00',
  byClient.content?.[0]?.text,
)
check(
  'money stays the owner’s: no tool records or voids a payment, or marks paid',
  !tools.some((tool) => /payment|paid/.test(tool.name)),
)

const event = await call('calendar_create_event', {
  project_id: client.id,
  title: 'Kick-off call',
  starts_at: '2026-10-05T10:00',
  idempotency_key: 'stdio-event-0001',
})
check('calendar_create_event', !event.isError, event.content?.[0]?.text)

/* ── Publish · market · experiments · readings · story ── */
for (const module of [
  'publish',
  'market',
  'experiments',
  'readings',
  'story',
  'agents',
])
  check(
    `the ${module} workspace lists its tools`,
    named(`${module}_`).length > 0,
    named(`${module}_`).join(', '),
  )
check(
  'the catalog stays under the cap of 60 tools',
  tools.length <= 60,
  `${tools.length} tools`,
)
const MODULE_IDS = MODULE_WORKSPACES.map((workspace) => workspace.id)
check(
  'every tool belongs to a module workspace, nothing else',
  tools.length === catalog(MODULE_WORKSPACES).length &&
    tools.every((tool) =>
      MODULE_IDS.some((id) => tool.name.startsWith(`${id}_`)),
    ),
  MODULE_IDS.join(', '),
)

const hook = await call('publish_prepare', {
  post_id: cleared.id,
  expected_revision: cleared.revision,
  asset_id: video[0]?.id,
  idempotency_key: 'stdio-post-0001',
})
const hookPost = hook.structuredContent?.post as
  | { id: string; status: string; revision: number }
  | undefined
check(
  'publish_prepare attaches the file',
  hookPost?.status === 'planned',
  hook.content?.[0]?.text,
)
// The owner's clearance (in HQ); the local stdio user is the owner.
{
  const seed = createDbHandle(url, { max: 1 })
  configureOpsDatabase(seed.db)
  await authorizePost(owner, { postId: cleared.id })
  configureOpsDatabase(null)
  await seed.sql.end({ timeout: 5 })
}
const out = await call('publish_record_manual', {
  post_id: cleared.id,
  url: 'https://www.tiktok.com/@deskhooks/video/42',
  posted_at: new Date(Date.now() - 80 * 3_600_000).toISOString(),
  idempotency_key: 'stdio-record-0001',
})
check(
  'publish_record_manual puts the cleared post on the record',
  (out.structuredContent?.post as { status?: string })?.status === 'posted',
  out.content?.[0]?.text,
)
const views = await call('publish_record_reading', {
  post_id: cleared.id,
  metric: 'views',
  value: 1250,
  as_of: new Date(Date.now() - 9 * 3_600_000).toISOString(),
  idempotency_key: 'stdio-reading-0001',
})
check('publish_record_reading', !views.isError, views.content?.[0]?.text)
const read = await call('readings_query', {
  subject_type: 'post',
  project_id: channel.id,
  metrics: ['views'],
  age_hours: 72,
  money_days: 7,
})
const readItem = (
  read.structuredContent?.items as
    | { readings: { views: { state: string; value?: string } } }[]
    | undefined
)?.[0]
check(
  'readings_query reads the post at 72 hours',
  readItem?.readings.views.state === 'known' &&
    readItem.readings.views.value === '1250.0000',
  read.content?.[0]?.text,
)

const drafted = await call('market_prepare', {
  project_id: shopProject.id,
  product: {
    title: 'Wabi-sabi wall art set',
    price: '12.00',
    currency: 'USD',
    files: [
      { asset_id: pdf?.id, role: 'deliverable' },
      { asset_id: png?.id, role: 'preview' },
    ],
  },
  listing: { marketplace_id: shop.id },
  idempotency_key: 'stdio-market-0001',
})
const listing = drafted.structuredContent?.listing as
  | { id: string; status: string; price: string }
  | undefined
check(
  'market_prepare makes the product and plans its listing',
  listing?.status === 'planned' && listing.price === '12.00',
  drafted.content?.[0]?.text,
)
const live = await call('market_record_manual', {
  listing_id: listing?.id,
  url: 'https://shop.example/p/wabi-sabi',
  idempotency_key: 'stdio-listed-0001',
})
check(
  'market_record_manual (the owner’s word)',
  (live.structuredContent?.listing as { status?: string })?.status === 'listed',
  live.content?.[0]?.text,
)
const sale = await call('market_record_sale', {
  marketplace_id: shop.id,
  listing_id: listing?.id,
  kind: 'sale',
  amount: '12.00',
  fees: '0.80',
  order_ref: 'stdio-1:1',
  idempotency_key: 'stdio-sale-0001',
})
check(
  'market_record_sale nets out the fees',
  (sale.structuredContent?.line as { net?: string })?.net === '11.20',
  sale.content?.[0]?.text,
)

const designed = await call('experiments_save', {
  project_id: channel.id,
  question: 'Does a question hook beat a statement?',
  subject_type: 'post',
  metric: 'views',
  read_at_hours: 72,
  idempotency_key: 'stdio-exp-0001',
})
const design = designed.structuredContent as
  | {
      experiment: { id: string; revision: number; status: string }
      variants: { id: string; label: string }[]
    }
  | undefined
check(
  'experiments_save makes a draft with A and B',
  design?.variants.length === 2,
  designed.content?.[0]?.text,
)
const added = await call('experiments_save', {
  experiment_id: design?.experiment.id,
  add: [{ variant_id: design?.variants[0]?.id, subject_id: cleared.id }],
  idempotency_key: 'stdio-exp-0002',
})
check(
  'experiments_save adds the post under A',
  !added.isError,
  added.content?.[0]?.text,
)
const readExp = await call('experiments_list', {
  experiment_id: design?.experiment.id,
})
const variantA = (
  readExp.structuredContent?.variants as
    | { covered: number; median: string | null }[]
    | undefined
)?.[0]
check(
  'experiments_list reads A at its age',
  variantA?.covered === 1 && variantA.median === '1250',
  readExp.content?.[0]?.text,
)

const board = await call('story_get', { project_id: film.id })
const story = board.structuredContent?.story as
  | { id: string; revision: number }
  | null
  | undefined
check(
  'story_get makes the film’s story on first open',
  Boolean(story?.id),
  board.content?.[0]?.text,
)
const script = await call('story_save_script', {
  story_id: story?.id,
  expected_revision: story?.revision,
  script: '# Scene 1\nMara wakes.',
  idempotency_key: 'stdio-script-0001',
})
check('story_save_script', !script.isError, script.content?.[0]?.text)
const shots = await call('story_save_shots', {
  story_id: story?.id,
  new_scene: { heading: 'INT. FERRY HOUSE — MORNING' },
  shots: [
    { action: 'Mara wakes.', duration_s: 3 },
    { action: 'Hand on the pane.', duration_s: 2.5 },
  ],
  idempotency_key: 'stdio-shots-0001',
})
check(
  'story_save_shots makes a scene and two shots',
  (shots.structuredContent?.shots as unknown[] | undefined)?.length === 2,
  shots.content?.[0]?.text,
)
const claim = await call('agents_claim_task', { kinds: ['generation'] })
check(
  'agents_claim_task answers null when nothing waits',
  !claim.isError && claim.structuredContent?.task === null,
  claim.content?.[0]?.text,
)

await mcp.close()
console.log(failures === 0 ? '\nall good.' : `\n${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
