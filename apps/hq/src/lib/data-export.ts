import type { Db } from '@theiceji/hq-db'
import {
  agentProposals,
  agentRoutines,
  assetAssets,
  assetCollectionItems,
  assetCollections,
  assetGenerationJobs,
  boardBoards,
  boardCardEvents,
  boardCardPayments,
  boardCards,
  boardFollowups,
  boardLanes,
  calendarEvents,
  clients,
  expDecisions,
  expExperiments,
  expItems,
  expLearnings,
  expVariants,
  googleConnections,
  marketListings,
  marketMarketplaces,
  marketPayouts,
  marketProductFiles,
  marketProducts,
  marketSalesEvents,
  notes,
  opsAgentRuns,
  opsAuditEvents,
  opsHumanRequests,
  opsHumanResponses,
  opsKillSwitches,
  opsPolicies,
  opsReleaseAuthorizations,
  opsTasks,
  opsUsageEvents,
  ownerSettings,
  projects,
  promptExamplePicks,
  promptExamples,
  promptPrompts,
  promptSlotOptions,
  promptSlots,
  promptVariants,
  providerConnections,
  publishAccounts,
  publishPosts,
  publishReadings,
  quoteLines,
  quoteQuotes,
  refs,
  storyCharacters,
  storyScenes,
  storyShots,
  storyStories,
  users,
} from '@theiceji/hq-db/schema'
import { and, asc, eq, type SQL, sql } from 'drizzle-orm'
import {
  getTableConfig,
  type PgColumn,
  type PgTable,
} from 'drizzle-orm/pg-core'

/**
 * `/data` — every record the owner has in HQ, out. One set
 * is one table, read only through its owner column and, when a project is
 * chosen, through that project. Framework-free: the page, the export route and the tests all call it with a database handle.
 *
 * What never leaves: credentials (any column named like a sealed value, a
 * secret, a hash, a password or a token — `CREDENTIAL`), the raw storage keys
 * that could be turned into file URLs, and the tables that are sign-in state or
 * HQ's own machinery (`NOT_EXPORTED`).
 */

// ─── groups ────────────────────────────────────────────────────────────────

/** The table's groups, in the rail's order with Notes · Projects first. */
export const EXPORT_GROUPS = [
  { id: 'notes', label: 'Notes', glyph: '' },
  { id: 'projects', label: 'Projects', glyph: '' },
  { id: 'clients', label: 'Clients', glyph: '' },
  { id: 'board', label: 'Board', glyph: '▦' },
  { id: 'prompts', label: 'Prompts', glyph: '✎' },
  { id: 'assets', label: 'Assets', glyph: '▣' },
  { id: 'story', label: 'Story', glyph: '▤' },
  { id: 'calendar', label: 'Calendar', glyph: '▥' },
  { id: 'quotes', label: 'Quotes', glyph: '▧' },
  { id: 'publish', label: 'Publish', glyph: '▲' },
  { id: 'market', label: 'Market', glyph: '◈' },
  { id: 'experiments', label: 'Experiments', glyph: '◬' },
  { id: 'links', label: 'Links', glyph: '' },
  { id: 'agents', label: 'Agents', glyph: '◍' },
  { id: 'ops', label: 'Ops', glyph: '' },
  { id: 'settings', label: 'Settings', glyph: '' },
] as const

export type ExportGroupId = (typeof EXPORT_GROUPS)[number]['id']

// ─── what never leaves ─────────────────────────────────────────────────────

/**
 * A column that holds a credential, by its name: a sealed value, a secret (or
 * its hint), a hash, a password, a token. `tokens` — an LLM usage count — is a
 * number of words, not a credential, and stays.
 */
export const CREDENTIAL = /sealed|secret|hash|password|(^|_)token($|_)/

const CREDENTIAL_REASON = 'a credential — it never leaves HQ'

/** Tables that are not sets, and why. Every table in the schema is a set or here. */
export const NOT_EXPORTED: readonly { table: string; reason: string }[] = [
  { table: 'sessions', reason: 'sign-in sessions' },
  { table: 'oauth_clients', reason: 'connected-app registrations' },
  { table: 'oauth_codes', reason: 'OAuth codes' },
  { table: 'oauth_grants', reason: 'connected-app grants' },
  { table: 'oauth_tokens', reason: 'OAuth tokens' },
  { table: 'push_subscriptions', reason: 'push keys of your devices' },
  { table: 'ops_runtimes', reason: 'agent runtimes and their sealed secret' },
  { table: 'calendar_sync_state', reason: 'Google’s sync cursor' },
  { table: 'ops_scheduler_leases', reason: 'HQ’s scheduler lease' },
  { table: 'ops_idempotency_keys', reason: 'retry keys' },
  { table: 'ops_outbox_events', reason: 'HQ’s outbox' },
  { table: 'ops_event_deliveries', reason: 'webhook deliveries' },
  { table: 'ops_inbound_events', reason: 'inbound webhooks' },
  {
    table: 'ops_budget_reservations',
    reason: 'budget holds (spend is in Usage)',
  },
  { table: 'ops_run_checkpoints', reason: 'run checkpoints' },
  { table: 'ops_capability_checks', reason: 'provider checks' },
  {
    table: 'publish_intents',
    reason: 'posting attempts (posts carry the result)',
  },
  {
    table: 'market_intents',
    reason: 'listing attempts (listings carry the result)',
  },
]

// ─── the sets ──────────────────────────────────────────────────────────────

type ProjectFilter = (ownerId: string, projectId: string) => SQL

type SetDef = {
  /** The table's name — also the `?set=` id and the file name. */
  id: string
  group: ExportGroupId
  label: string
  /** What a row is, in words. */
  about: string
  table: PgTable
  owner: PgColumn
  /** When a row last changed; null when the table keeps no time. */
  changed: PgColumn | null
  order: PgColumn[]
  /** The rows of one project; null = the set belongs to no project. */
  inProject: ProjectFilter | null
  /** How a project picks its rows when it isn't a plain `project_id`. */
  scopeNote?: string
  /** Columns left out on purpose, and why (credentials are left out anyway). */
  omit?: Record<string, string>
}

const byColumn =
  (column: PgColumn): ProjectFilter =>
  (_owner, projectId) =>
    eq(column, projectId)

/** Rows whose parent (through `fk`) is the owner's and in the project. */
const byParent =
  (
    fk: PgColumn,
    parent: PgTable,
    parentId: PgColumn,
    parentOwner: PgColumn,
    parentFilter: ProjectFilter,
  ): ProjectFilter =>
  (ownerId, projectId) =>
    sql`${fk} in (select ${parentId} from ${parent} where ${parentOwner} = ${ownerId} and ${parentFilter(ownerId, projectId)})`

const promptsInProject = byColumn(promptPrompts.projectId)
const variantsInProject = byParent(
  promptVariants.promptId,
  promptPrompts,
  promptPrompts.id,
  promptPrompts.ownerId,
  promptsInProject,
)
const promptExamplesInProject = byParent(
  promptExamples.variantId,
  promptVariants,
  promptVariants.id,
  promptVariants.ownerId,
  variantsInProject,
)
const slotsInProject = byParent(
  promptSlots.promptId,
  promptPrompts,
  promptPrompts.id,
  promptPrompts.ownerId,
  promptsInProject,
)
const experimentsInProject = byColumn(expExperiments.projectId)
const storiesInProject = byColumn(storyStories.projectId)

const SETS: SetDef[] = [
  {
    id: 'notes',
    group: 'notes',
    label: 'Notes',
    about: 'Every note, with the archived and trashed ones.',
    table: notes,
    owner: notes.ownerId,
    changed: notes.updatedAt,
    order: [notes.createdAt, notes.id],
    inProject: byColumn(notes.projectId),
    scopeNote: 'the notes tagged with the project',
  },
  {
    id: 'projects',
    group: 'projects',
    label: 'Projects',
    about: 'Name, kind, colour, modules and storage of each project.',
    table: projects,
    owner: projects.ownerId,
    changed: projects.updatedAt,
    order: [projects.position, projects.id],
    inProject: (_owner, projectId) => eq(projects.id, projectId),
    scopeNote: 'the project itself',
  },
  {
    id: 'clients',
    group: 'clients',
    label: 'Clients',
    about:
      'Each client’s name, tax id, address and contact — one record for Board and Quotes.',
    table: clients,
    owner: clients.ownerId,
    changed: clients.updatedAt,
    order: [clients.name, clients.id],
    inProject: (ownerId, projectId) =>
      sql`${clients.id} in (select ${boardCards.clientId} from ${boardCards} where ${boardCards.ownerId} = ${ownerId} and ${boardCards.projectId} = ${projectId} union select ${quoteQuotes.clientId} from ${quoteQuotes} where ${quoteQuotes.ownerId} = ${ownerId} and ${quoteQuotes.projectId} = ${projectId})`,
    scopeNote: 'the clients the project’s cards and quotes name',
  },
  {
    id: 'board_boards',
    group: 'board',
    label: 'Boards',
    about: 'Each board and the preset it started from.',
    table: boardBoards,
    owner: boardBoards.ownerId,
    changed: boardBoards.updatedAt,
    order: [boardBoards.position, boardBoards.id],
    inProject: byColumn(boardBoards.projectId),
  },
  {
    id: 'board_lanes',
    group: 'board',
    label: 'Lanes',
    about: 'The lanes of each board, in order.',
    table: boardLanes,
    owner: boardLanes.ownerId,
    changed: boardLanes.updatedAt,
    order: [boardLanes.boardId, boardLanes.position],
    inProject: byParent(
      boardLanes.boardId,
      boardBoards,
      boardBoards.id,
      boardBoards.ownerId,
      byColumn(boardBoards.projectId),
    ),
    scopeNote: 'the lanes of the project’s boards',
  },
  {
    id: 'board_cards',
    group: 'board',
    label: 'Cards',
    about:
      'Every card: body, labels, price, total with follow-ups, paid so far, currency, due, client, colour, paid.',
    table: boardCards,
    owner: boardCards.ownerId,
    changed: boardCards.updatedAt,
    order: [boardCards.createdAt, boardCards.id],
    inProject: byColumn(boardCards.projectId),
  },
  {
    id: 'board_followups',
    group: 'board',
    label: 'Follow-ups',
    about:
      'Work that came after a card’s own task: details, price in the card’s currency, due, removed.',
    table: boardFollowups,
    owner: boardFollowups.ownerId,
    changed: boardFollowups.updatedAt,
    order: [boardFollowups.cardId, boardFollowups.position, boardFollowups.id],
    inProject: byColumn(boardFollowups.projectId),
  },
  {
    id: 'board_card_payments',
    group: 'board',
    label: 'Payments',
    about:
      'Every payment line of a card — deposit, part, final — and the voids that strike one. Append-only.',
    table: boardCardPayments,
    owner: boardCardPayments.ownerId,
    changed: boardCardPayments.createdAt,
    order: [
      boardCardPayments.receivedOn,
      boardCardPayments.createdAt,
      boardCardPayments.id,
    ],
    inProject: byColumn(boardCardPayments.projectId),
  },
  {
    id: 'board_card_events',
    group: 'board',
    label: 'Card history',
    about: 'Each move, price change and payment of a card.',
    table: boardCardEvents,
    owner: boardCardEvents.ownerId,
    changed: boardCardEvents.occurredAt,
    order: [boardCardEvents.occurredAt, boardCardEvents.id],
    inProject: byColumn(boardCardEvents.projectId),
  },
  {
    id: 'prompt_prompts',
    group: 'prompts',
    label: 'Prompts',
    about: 'Each prompt’s title, intent, medium, collection and tags.',
    table: promptPrompts,
    owner: promptPrompts.ownerId,
    changed: promptPrompts.updatedAt,
    order: [promptPrompts.createdAt, promptPrompts.id],
    inProject: promptsInProject,
  },
  {
    id: 'prompt_variants',
    group: 'prompts',
    label: 'Texts',
    about:
      'Each prompt’s text (a template: <NAME> is a variant), its negative text, provider hint and parameters.',
    table: promptVariants,
    owner: promptVariants.ownerId,
    changed: promptVariants.updatedAt,
    order: [promptVariants.promptId, promptVariants.position],
    inProject: variantsInProject,
    scopeNote: 'the texts of the project’s prompts',
  },
  {
    id: 'prompt_examples',
    group: 'prompts',
    label: 'Examples',
    about: 'The assets pinned to a prompt as examples, with captions.',
    table: promptExamples,
    owner: promptExamples.ownerId,
    changed: promptExamples.createdAt,
    order: [promptExamples.variantId, promptExamples.position],
    inProject: promptExamplesInProject,
    scopeNote: 'the examples of the project’s prompts',
  },
  {
    id: 'prompt_slots',
    group: 'prompts',
    label: 'Variants',
    about:
      'Each variant (<NAME> in a text): the library’s (no prompt) and each prompt’s own.',
    table: promptSlots,
    owner: promptSlots.ownerId,
    changed: promptSlots.updatedAt,
    order: [promptSlots.promptId, promptSlots.position, promptSlots.name],
    inProject: slotsInProject,
    scopeNote: 'the project’s prompts’ own variants (the library is HQ-wide)',
  },
  {
    id: 'prompt_slot_options',
    group: 'prompts',
    label: 'Variant options',
    about:
      'Each option of a variant: the key picked by name, the value put into the text.',
    table: promptSlotOptions,
    owner: promptSlotOptions.ownerId,
    changed: promptSlotOptions.updatedAt,
    order: [promptSlotOptions.slotId, promptSlotOptions.position],
    inProject: byParent(
      promptSlotOptions.slotId,
      promptSlots,
      promptSlots.id,
      promptSlots.ownerId,
      slotsInProject,
    ),
    scopeNote: 'the options of the project’s prompts’ own variants',
  },
  {
    id: 'prompt_example_picks',
    group: 'prompts',
    label: 'Example picks',
    about: 'Which option of each variant an example was made with.',
    table: promptExamplePicks,
    owner: promptExamplePicks.ownerId,
    changed: promptExamplePicks.createdAt,
    order: [promptExamplePicks.exampleId, promptExamplePicks.optionId],
    inProject: byParent(
      promptExamplePicks.exampleId,
      promptExamples,
      promptExamples.id,
      promptExamples.ownerId,
      promptExamplesInProject,
    ),
    scopeNote: 'the picks of the project’s prompts’ examples',
  },
  {
    id: 'asset_assets',
    group: 'assets',
    label: 'Assets',
    about:
      'What each file is — name, path, kind, size, checksum, tags. Not the files.',
    table: assetAssets,
    owner: assetAssets.ownerId,
    changed: assetAssets.updatedAt,
    order: [assetAssets.createdAt, assetAssets.id],
    inProject: byColumn(assetAssets.projectId),
    omit: {
      storage_key: 'the raw storage key could be turned into a file URL',
      thumb_key: 'the raw thumbnail key could be turned into a file URL',
    },
  },
  {
    id: 'asset_collections',
    group: 'assets',
    label: 'Collections',
    about: 'Each collection of assets.',
    table: assetCollections,
    owner: assetCollections.ownerId,
    changed: assetCollections.updatedAt,
    order: [assetCollections.position, assetCollections.id],
    inProject: byColumn(assetCollections.projectId),
  },
  {
    id: 'asset_collection_items',
    group: 'assets',
    label: 'Collection items',
    about: 'Which asset sits in which collection, in order.',
    table: assetCollectionItems,
    owner: assetCollectionItems.ownerId,
    changed: assetCollectionItems.addedAt,
    order: [assetCollectionItems.collectionId, assetCollectionItems.position],
    inProject: byParent(
      assetCollectionItems.collectionId,
      assetCollections,
      assetCollections.id,
      assetCollections.ownerId,
      byColumn(assetCollections.projectId),
    ),
    scopeNote: 'the items of the project’s collections',
  },
  {
    id: 'asset_generation_jobs',
    group: 'assets',
    label: 'Generation jobs',
    about: 'Each generation: provider, input, status and the assets it made.',
    table: assetGenerationJobs,
    owner: assetGenerationJobs.ownerId,
    changed: assetGenerationJobs.updatedAt,
    order: [assetGenerationJobs.createdAt, assetGenerationJobs.id],
    inProject: byColumn(assetGenerationJobs.projectId),
  },
  {
    id: 'story_stories',
    group: 'story',
    label: 'Stories',
    about: 'Each film’s title, logline and script.',
    table: storyStories,
    owner: storyStories.ownerId,
    changed: storyStories.updatedAt,
    order: [storyStories.position, storyStories.id],
    inProject: storiesInProject,
  },
  {
    id: 'story_scenes',
    group: 'story',
    label: 'Scenes',
    about: 'The scenes of each story, with heading and synopsis.',
    table: storyScenes,
    owner: storyScenes.ownerId,
    changed: storyScenes.updatedAt,
    order: [storyScenes.storyId, storyScenes.number],
    inProject: byParent(
      storyScenes.storyId,
      storyStories,
      storyStories.id,
      storyStories.ownerId,
      storiesInProject,
    ),
    scopeNote: 'the scenes of the project’s stories',
  },
  {
    id: 'story_characters',
    group: 'story',
    label: 'Characters',
    about: 'The characters of each story and their board asset.',
    table: storyCharacters,
    owner: storyCharacters.ownerId,
    changed: storyCharacters.updatedAt,
    order: [storyCharacters.storyId, storyCharacters.position],
    inProject: byParent(
      storyCharacters.storyId,
      storyStories,
      storyStories.id,
      storyStories.ownerId,
      storiesInProject,
    ),
    scopeNote: 'the characters of the project’s stories',
  },
  {
    id: 'story_shots',
    group: 'story',
    label: 'Shots',
    about: 'Every shot: action, duration, the variants it uses, status.',
    table: storyShots,
    owner: storyShots.ownerId,
    changed: storyShots.updatedAt,
    order: [storyShots.sceneId, storyShots.number],
    inProject: byColumn(storyShots.projectId),
  },
  {
    id: 'calendar_events',
    group: 'calendar',
    label: 'Events',
    about: 'Every event, from HQ or Google, with its sync state.',
    table: calendarEvents,
    owner: calendarEvents.ownerId,
    changed: calendarEvents.updatedAt,
    order: [calendarEvents.startsAt, calendarEvents.id],
    inProject: byColumn(calendarEvents.projectId),
  },
  {
    id: 'quote_quotes',
    group: 'quotes',
    label: 'Quotes',
    about:
      'Each quote: number, client, status, VAT and WHT, the totals it froze.',
    table: quoteQuotes,
    owner: quoteQuotes.ownerId,
    changed: quoteQuotes.updatedAt,
    order: [quoteQuotes.number, quoteQuotes.id],
    inProject: byColumn(quoteQuotes.projectId),
  },
  {
    id: 'quote_lines',
    group: 'quotes',
    label: 'Quote lines',
    about: 'The lines of each quote: description, quantity, unit price.',
    table: quoteLines,
    owner: quoteLines.ownerId,
    changed: null,
    order: [quoteLines.quoteId, quoteLines.position],
    inProject: byParent(
      quoteLines.quoteId,
      quoteQuotes,
      quoteQuotes.id,
      quoteQuotes.ownerId,
      byColumn(quoteQuotes.projectId),
    ),
    scopeNote: 'the lines of the project’s quotes',
  },
  {
    id: 'publish_accounts',
    group: 'publish',
    label: 'Accounts',
    about: 'Each account you post from: platform, handle, profile.',
    table: publishAccounts,
    owner: publishAccounts.ownerId,
    changed: publishAccounts.updatedAt,
    order: [publishAccounts.createdAt, publishAccounts.id],
    inProject: byColumn(publishAccounts.projectId),
  },
  {
    id: 'publish_posts',
    group: 'publish',
    label: 'Posts',
    about:
      'Every post: caption, disclosure, status, when and where it went out.',
    table: publishPosts,
    owner: publishPosts.ownerId,
    changed: publishPosts.updatedAt,
    order: [publishPosts.createdAt, publishPosts.id],
    inProject: byColumn(publishPosts.projectId),
  },
  {
    id: 'publish_readings',
    group: 'publish',
    label: 'Readings',
    about: 'Views and earnings as read back, with corrections.',
    table: publishReadings,
    owner: publishReadings.ownerId,
    changed: publishReadings.observedAt,
    order: [publishReadings.observedAt, publishReadings.id],
    inProject: byColumn(publishReadings.projectId),
  },
  {
    id: 'market_marketplaces',
    group: 'market',
    label: 'Shops',
    about: 'Each shop: marketplace, currency, fee sheet.',
    table: marketMarketplaces,
    owner: marketMarketplaces.ownerId,
    changed: marketMarketplaces.updatedAt,
    order: [marketMarketplaces.createdAt, marketMarketplaces.id],
    inProject: byColumn(marketMarketplaces.projectId),
  },
  {
    id: 'market_products',
    group: 'market',
    label: 'Products',
    about: 'Each product: title, description, price, tags.',
    table: marketProducts,
    owner: marketProducts.ownerId,
    changed: marketProducts.updatedAt,
    order: [marketProducts.createdAt, marketProducts.id],
    inProject: byColumn(marketProducts.projectId),
  },
  {
    id: 'market_product_files',
    group: 'market',
    label: 'Product files',
    about: 'Which asset is a product’s deliverable or preview.',
    table: marketProductFiles,
    owner: marketProductFiles.ownerId,
    changed: marketProductFiles.createdAt,
    order: [marketProductFiles.productId, marketProductFiles.position],
    inProject: byParent(
      marketProductFiles.productId,
      marketProducts,
      marketProducts.id,
      marketProducts.ownerId,
      byColumn(marketProducts.projectId),
    ),
    scopeNote: 'the files of the project’s products',
  },
  {
    id: 'market_listings',
    group: 'market',
    label: 'Listings',
    about: 'Each listing: shop, price, status, where it is listed.',
    table: marketListings,
    owner: marketListings.ownerId,
    changed: marketListings.updatedAt,
    order: [marketListings.createdAt, marketListings.id],
    inProject: byColumn(marketListings.projectId),
  },
  {
    id: 'market_sales_events',
    group: 'market',
    label: 'Money lines',
    about: 'Sales, refunds and fees, append-only, each in its own currency.',
    table: marketSalesEvents,
    owner: marketSalesEvents.ownerId,
    changed: marketSalesEvents.createdAt,
    order: [marketSalesEvents.occurredAt, marketSalesEvents.id],
    inProject: byColumn(marketSalesEvents.projectId),
  },
  {
    id: 'market_payouts',
    group: 'market',
    label: 'Payouts',
    about: 'Payouts, expected and confirmed.',
    table: marketPayouts,
    owner: marketPayouts.ownerId,
    changed: marketPayouts.updatedAt,
    order: [marketPayouts.createdAt, marketPayouts.id],
    inProject: byColumn(marketPayouts.projectId),
  },
  {
    id: 'exp_experiments',
    group: 'experiments',
    label: 'Experiments',
    about: 'Each experiment: question, hypothesis, metric, status.',
    table: expExperiments,
    owner: expExperiments.ownerId,
    changed: expExperiments.updatedAt,
    order: [expExperiments.createdAt, expExperiments.id],
    inProject: experimentsInProject,
  },
  {
    id: 'exp_variants',
    group: 'experiments',
    label: 'Variants',
    about: 'The variants each experiment compares.',
    table: expVariants,
    owner: expVariants.ownerId,
    changed: expVariants.updatedAt,
    order: [expVariants.experimentId, expVariants.position],
    inProject: byParent(
      expVariants.experimentId,
      expExperiments,
      expExperiments.id,
      expExperiments.ownerId,
      experimentsInProject,
    ),
    scopeNote: 'the variants of the project’s experiments',
  },
  {
    id: 'exp_items',
    group: 'experiments',
    label: 'Items',
    about: 'Which post or listing ran under which variant.',
    table: expItems,
    owner: expItems.ownerId,
    changed: expItems.addedAt,
    order: [expItems.experimentId, expItems.addedAt],
    inProject: byParent(
      expItems.experimentId,
      expExperiments,
      expExperiments.id,
      expExperiments.ownerId,
      experimentsInProject,
    ),
    scopeNote: 'the items of the project’s experiments',
  },
  {
    id: 'exp_decisions',
    group: 'experiments',
    label: 'Decisions',
    about: 'Each verdict, its rationale and the readings it froze.',
    table: expDecisions,
    owner: expDecisions.ownerId,
    changed: expDecisions.decidedAt,
    order: [expDecisions.decidedAt, expDecisions.id],
    inProject: byParent(
      expDecisions.experimentId,
      expExperiments,
      expExperiments.id,
      expExperiments.ownerId,
      experimentsInProject,
    ),
    scopeNote: 'the decisions of the project’s experiments',
  },
  {
    id: 'exp_learnings',
    group: 'experiments',
    label: 'Learnings',
    about: 'What you learned, with the evidence.',
    table: expLearnings,
    owner: expLearnings.ownerId,
    changed: expLearnings.updatedAt,
    order: [expLearnings.createdAt, expLearnings.id],
    inProject: byColumn(expLearnings.projectId),
  },
  {
    id: 'refs',
    group: 'links',
    label: 'Links between records',
    about: 'Which record points at which: quoted by, made from, used in.',
    table: refs,
    owner: refs.ownerId,
    changed: refs.createdAt,
    order: [refs.createdAt, refs.id],
    inProject: null,
  },
  {
    id: 'agent_routines',
    group: 'agents',
    label: 'Routines',
    about: 'Each routine: schedule, runner, modules, playbook.',
    table: agentRoutines,
    owner: agentRoutines.ownerId,
    changed: agentRoutines.updatedAt,
    order: [agentRoutines.createdAt, agentRoutines.id],
    inProject: byColumn(agentRoutines.projectId),
  },
  {
    id: 'agent_proposals',
    group: 'agents',
    label: 'Proposals',
    about: 'What agents proposed, and what you decided.',
    table: agentProposals,
    owner: agentProposals.ownerId,
    changed: agentProposals.updatedAt,
    order: [agentProposals.createdAt, agentProposals.id],
    inProject: byColumn(agentProposals.projectId),
  },
  {
    id: 'ops_tasks',
    group: 'ops',
    label: 'Tasks',
    about: 'Work queued for agents and HQ, with its result.',
    table: opsTasks,
    owner: opsTasks.ownerId,
    changed: opsTasks.updatedAt,
    order: [opsTasks.createdAt, opsTasks.id],
    inProject: byColumn(opsTasks.projectId),
    omit: { fencing_token: 'a lease counter — HQ’s own machinery' },
  },
  {
    id: 'ops_agent_runs',
    group: 'ops',
    label: 'Runs',
    about: 'Every agent run: status, summary, budgets, what it made.',
    table: opsAgentRuns,
    owner: opsAgentRuns.ownerId,
    changed: opsAgentRuns.heartbeatAt,
    order: [opsAgentRuns.startedAt, opsAgentRuns.id],
    inProject: byColumn(opsAgentRuns.projectId),
    omit: { fencing_token: 'a lease counter — HQ’s own machinery' },
  },
  {
    id: 'ops_usage_events',
    group: 'ops',
    label: 'Usage and cost',
    about: 'What each run or generation used and cost, in minor units.',
    table: opsUsageEvents,
    owner: opsUsageEvents.ownerId,
    changed: opsUsageEvents.occurredAt,
    order: [opsUsageEvents.occurredAt, opsUsageEvents.id],
    inProject: byColumn(opsUsageEvents.projectId),
  },
  {
    id: 'ops_human_requests',
    group: 'ops',
    label: 'Requests',
    about: 'Everything that waited for you, and why it stopped.',
    table: opsHumanRequests,
    owner: opsHumanRequests.ownerId,
    changed: opsHumanRequests.updatedAt,
    order: [opsHumanRequests.createdAt, opsHumanRequests.id],
    inProject: byColumn(opsHumanRequests.projectId),
  },
  {
    id: 'ops_human_responses',
    group: 'ops',
    label: 'Your answers',
    about: 'How you answered each request.',
    table: opsHumanResponses,
    owner: opsHumanResponses.ownerId,
    changed: opsHumanResponses.respondedAt,
    order: [opsHumanResponses.respondedAt, opsHumanResponses.id],
    inProject: byColumn(opsHumanResponses.projectId),
  },
  {
    id: 'ops_audit_events',
    group: 'ops',
    label: 'Audit log',
    about: 'Who changed what, and when.',
    table: opsAuditEvents,
    owner: opsAuditEvents.ownerId,
    changed: opsAuditEvents.occurredAt,
    order: [opsAuditEvents.occurredAt, opsAuditEvents.id],
    inProject: byColumn(opsAuditEvents.projectId),
  },
  {
    id: 'ops_policies',
    group: 'ops',
    label: 'Policies',
    about: 'Budgets, release rules and limits, every revision.',
    table: opsPolicies,
    owner: opsPolicies.ownerId,
    changed: opsPolicies.createdAt,
    order: [opsPolicies.createdAt, opsPolicies.id],
    inProject: byColumn(opsPolicies.projectId),
  },
  {
    id: 'ops_release_authorizations',
    group: 'ops',
    label: 'Release approvals',
    about: 'Each time you cleared something to leave HQ.',
    table: opsReleaseAuthorizations,
    owner: opsReleaseAuthorizations.ownerId,
    changed: opsReleaseAuthorizations.createdAt,
    order: [opsReleaseAuthorizations.createdAt, opsReleaseAuthorizations.id],
    inProject: byColumn(opsReleaseAuthorizations.projectId),
    omit: {
      payload_hash: 'the fingerprint HQ checks before a release',
    },
  },
  {
    id: 'ops_kill_switches',
    group: 'ops',
    label: 'Kill switches',
    about: 'Each stop you engaged and released.',
    table: opsKillSwitches,
    owner: opsKillSwitches.ownerId,
    changed: opsKillSwitches.engagedAt,
    order: [opsKillSwitches.engagedAt, opsKillSwitches.id],
    inProject: byColumn(opsKillSwitches.projectId),
  },
  {
    id: 'users',
    group: 'settings',
    label: 'Account',
    about: 'Your email, name and role.',
    table: users,
    owner: users.id,
    changed: users.createdAt,
    order: [users.id],
    inProject: null,
    omit: { password_hash: 'your password’s hash never leaves HQ' },
  },
  {
    id: 'owner_settings',
    group: 'settings',
    label: 'Owner settings',
    about: 'Default storage and the quote issuer.',
    table: ownerSettings,
    owner: ownerSettings.ownerId,
    changed: ownerSettings.updatedAt,
    order: [ownerSettings.ownerId],
    inProject: null,
  },
  {
    id: 'provider_connections',
    group: 'settings',
    label: 'Connections',
    about: 'Each provider you connected: label, settings, status.',
    table: providerConnections,
    owner: providerConnections.ownerId,
    changed: providerConnections.updatedAt,
    order: [providerConnections.createdAt, providerConnections.id],
    inProject: null,
    omit: {
      secret_sealed: 'the sealed secret never leaves HQ',
      secret_hint: 'part of a secret',
    },
  },
  {
    id: 'google_connections',
    group: 'settings',
    label: 'Google',
    about: 'The Google account, its scopes and folders.',
    table: googleConnections,
    owner: googleConnections.ownerId,
    changed: googleConnections.updatedAt,
    order: [googleConnections.createdAt, googleConnections.id],
    inProject: null,
    omit: { refresh_token_sealed: 'the sealed refresh token never leaves HQ' },
  },
]

// ─── columns ───────────────────────────────────────────────────────────────

/** How a column's values are written out. */
export type CellKind =
  | 'text'
  | 'decimal'
  | 'number'
  | 'bool'
  | 'time'
  | 'date'
  | 'json'
  | 'array'

export type ExportColumn = { name: string; kind: CellKind }

export function kindOf(sqlType: string): CellKind {
  if (sqlType.endsWith('[]')) return 'array'
  if (sqlType.startsWith('numeric')) return 'decimal'
  if (
    ['integer', 'smallint', 'bigint', 'real', 'double precision'].includes(
      sqlType,
    )
  )
    return 'number'
  if (sqlType === 'boolean') return 'bool'
  if (sqlType.startsWith('timestamp')) return 'time'
  if (sqlType === 'date') return 'date'
  if (sqlType === 'jsonb' || sqlType === 'json') return 'json'
  return 'text'
}

type Resolved = SetDef & {
  table_name: string
  included: (ExportColumn & { column: PgColumn })[]
  omitted: { name: string; reason: string }[]
}

function resolve(def: SetDef): Resolved {
  const config = getTableConfig(def.table)
  const included: Resolved['included'] = []
  const omitted: Resolved['omitted'] = []
  for (const column of config.columns) {
    const reason =
      def.omit?.[column.name] ??
      (CREDENTIAL.test(column.name) ? CREDENTIAL_REASON : null)
    if (reason) omitted.push({ name: column.name, reason })
    else
      included.push({
        name: column.name,
        kind: kindOf(column.getSQLType()),
        column,
      })
  }
  return { ...def, table_name: config.name, included, omitted }
}

const RESOLVED: Resolved[] = SETS.map(resolve)
const BY_ID = new Map(RESOLVED.map((set) => [set.id, set]))

/** A set as the page and the file describe it — plain data. */
export type ExportSetInfo = {
  id: string
  group: ExportGroupId
  label: string
  about: string
  table: string
  projectScoped: boolean
  scopeNote: string | null
  columns: ExportColumn[]
  omitted: { name: string; reason: string }[]
}

const info = (set: Resolved): ExportSetInfo => ({
  id: set.id,
  group: set.group,
  label: set.label,
  about: set.about,
  table: set.table_name,
  projectScoped: set.inProject !== null,
  scopeNote: set.inProject ? (set.scopeNote ?? null) : null,
  columns: set.included.map(({ name, kind }) => ({ name, kind })),
  omitted: set.omitted,
})

/** Every set, in the page's order. */
export function exportSets(): ExportSetInfo[] {
  return RESOLVED.map(info)
}

export function exportSet(id: string): ExportSetInfo | null {
  const set = BY_ID.get(id)
  return set ? info(set) : null
}

// ─── reading ───────────────────────────────────────────────────────────────

export type OwnProject = {
  id: string
  slug: string
  name: string
  color: string
  status: string
}

/** The owner's projects, in their order, archived ones included. */
export async function listOwnProjects(
  db: Db,
  ownerId: string,
): Promise<OwnProject[]> {
  return db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      color: projects.color,
      status: projects.status,
    })
    .from(projects)
    .where(eq(projects.ownerId, ownerId))
    .orderBy(asc(projects.position), asc(projects.createdAt))
}

/** One of the owner's projects by its slug; another owner's is not found. */
export async function findOwnProject(
  db: Db,
  ownerId: string,
  slug: string,
): Promise<OwnProject | null> {
  const [row] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      color: projects.color,
      status: projects.status,
    })
    .from(projects)
    .where(and(eq(projects.ownerId, ownerId), eq(projects.slug, slug)))
    .limit(1)
  return row ?? null
}

function scopeOf(set: Resolved, ownerId: string, projectId: string | null) {
  const own = eq(set.owner, ownerId)
  if (!projectId) return own
  if (!set.inProject) throw new Error(`${set.id} belongs to no project.`)
  return and(own, set.inProject(ownerId, projectId)) as SQL
}

export type SetCount = {
  /** null when a project is chosen and the set belongs to no project. */
  rows: number | null
  /** ISO 8601 UTC of the newest change, or null. */
  last: string | null
}

/**
 * Row counts and last change for every set, in one round trip (a UNION ALL
 * of one count per set) — never a query per project.
 */
export async function countSets(
  db: Db,
  ownerId: string,
  projectId: string | null,
): Promise<Record<string, SetCount>> {
  const counted = RESOLVED.filter((set) => !projectId || set.inProject)
  const parts = counted.map((set) => {
    const last = set.changed
      ? sql`to_char(max(${set.changed}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
      : sql`null::text`
    return sql`(select ${set.id}::text as set, count(*)::int as n, ${last} as last from ${set.table} where ${scopeOf(set, ownerId, projectId)})`
  })
  const result = await db.execute(sql.join(parts, sql` union all `))
  const rows = result as unknown as {
    set: string
    n: number
    last: string | null
  }[]
  const out: Record<string, SetCount> = {}
  for (const set of RESOLVED) out[set.id] = { rows: null, last: null }
  for (const row of rows)
    out[row.set] = { rows: Number(row.n), last: row.last ?? null }
  return out
}

/** The set's rows for the owner (and project), keyed by column name. */
export async function readSet(
  db: Db,
  ownerId: string,
  id: string,
  projectId: string | null,
): Promise<Record<string, unknown>[]> {
  const set = BY_ID.get(id)
  if (!set) throw new Error(`Unknown set ${id}.`)
  const selection = Object.fromEntries(
    set.included.map((column) => [column.name, column.column]),
  ) as Record<string, PgColumn>
  return db
    .select(selection)
    .from(set.table)
    .where(scopeOf(set, ownerId, projectId))
    .orderBy(...set.order.map((column) => asc(column)))
}

// ─── writing ───────────────────────────────────────────────────────────────

/** A value as JSON carries it: times as ISO 8601 UTC, big integers as text, money as its exact text. */
export function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  return value ?? null
}

/** The byte-order mark that tells Excel the file is UTF-8. */
export const BOM = String.fromCharCode(0xfeff)

/** A text cell a spreadsheet would read as a formula starts with one of these. */
const FORMULA = /^[=+\-@\t\r]/

/** One CSV field (RFC 4180), with the formula guard on text. */
export function csvCell(kind: CellKind, value: unknown): string {
  if (value === null || value === undefined) return ''
  let text: string
  let guard = false
  if (value instanceof Date) text = value.toISOString()
  else if (kind === 'json' || kind === 'array' || typeof value === 'object') {
    text = JSON.stringify(value, (_key, inner) =>
      typeof inner === 'bigint' ? inner.toString() : inner,
    )
    guard = true
  } else if (kind === 'text') {
    text = String(value)
    guard = true
  } else text = String(value)
  if (guard && FORMULA.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * The whole file: UTF-8 with a BOM (so Excel reads Thai), a header row of
 * column names, CRLF line ends.
 */
export function toCsv(
  columns: readonly ExportColumn[],
  rows: readonly Record<string, unknown>[],
): string {
  const lines = [
    columns.map((column) => csvCell('text', column.name)).join(','),
  ]
  for (const row of rows)
    lines.push(
      columns.map((column) => csvCell(column.kind, row[column.name])).join(','),
    )
  return `${BOM}${lines.join('\r\n')}\r\n`
}

/** `hq-<set>-<scope>-<YYYY-MM-DD>.<ext>`, dated in UTC. */
export function exportFilename(
  set: string,
  scope: string,
  format: 'csv' | 'json',
  now: Date = new Date(),
): string {
  return `hq-${set}-${scope}-${now.toISOString().slice(0, 10)}.${format}`
}

export type ExportBundle = {
  format: 'hq-export'
  version: 1
  exportedAt: string
  scope: { project: { id: string; slug: string; name: string } | null }
  /** Sets that belong to no project, left out of a project's file. */
  notByProject: string[]
  sets: Record<string, ExportSetInfo & { rows: Record<string, unknown>[] }>
}

/**
 * One file for one or more sets, as JSON. A single set's JSON is this shape
 * with one entry, so one reader takes both.
 */
export async function buildBundle(
  db: Db,
  ownerId: string,
  ids: readonly string[],
  project: { id: string; slug: string; name: string } | null,
  now: Date = new Date(),
): Promise<ExportBundle> {
  const bundle: ExportBundle = {
    format: 'hq-export',
    version: 1,
    exportedAt: now.toISOString(),
    scope: { project },
    notByProject: [],
    sets: {},
  }
  for (const id of ids) {
    const set = BY_ID.get(id)
    if (!set) throw new Error(`Unknown set ${id}.`)
    if (project && !set.inProject) {
      bundle.notByProject.push(id)
      continue
    }
    const rows = await readSet(db, ownerId, id, project?.id ?? null)
    bundle.sets[id] = {
      ...info(set),
      rows: rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, jsonValue(value)]),
        ),
      ),
    }
  }
  return bundle
}
