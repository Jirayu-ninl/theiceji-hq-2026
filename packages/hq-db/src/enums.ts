/**
 * Value sets shared by the Drizzle schema and the apps' domain types.
 *
 * Deliberately dependency-free. `schema.ts` imports it (drizzle-kit bundles
 * that file on its own, outside Next's module graph) and so does HQ's client
 * views — so this module must pull in neither drizzle nor zod.
 *
 * Adding a value here and re-running `bun run db:generate` (in apps/hq) keeps
 * the CHECK constraints in step with the TypeScript unions.
 */

/**
 * A note's accent on the Notes board. Kept to a small set so the board stays
 * readable: every value renders as a tint over the card, never a solid fill,
 * and `none` is the plain panel card.
 */
export const NOTE_COLORS = [
  'none',
  'citron',
  'sage',
  'sky',
  'lilac',
  'blush',
  'sand',
  'clay',
] as const
export type NoteColor = (typeof NOTE_COLORS)[number]

/** Roles are carried for future use — every gate today only asks "signed in?". */
export const USER_ROLES = ['admin', 'editor'] as const
export type UserRole = (typeof USER_ROLES)[number]

/**
 * How an OAuth client introduced itself: Dynamic Client Registration (a row
 * HQ minted) or a Client ID Metadata Document (the `client_id` is an HTTPS URL
 * and the row caches what it served).
 */
export const OAUTH_CLIENT_KINDS = ['dcr', 'cimd'] as const
export type OAuthClientKind = (typeof OAUTH_CLIENT_KINDS)[number]

/** RFC 7591 `token_endpoint_auth_method` values HQ honours. */
export const CLIENT_AUTH_METHODS = [
  'none',
  'client_secret_post',
  'client_secret_basic',
] as const
export type ClientAuthMethod = (typeof CLIENT_AUTH_METHODS)[number]

/**
 * A grant is one connection: an app the owner consented to over OAuth, or a
 * personal access token they minted for an agent that only speaks headers.
 */
export const GRANT_KINDS = ['oauth', 'personal'] as const
export type GrantKind = (typeof GRANT_KINDS)[number]

export const TOKEN_KINDS = ['access', 'refresh', 'personal'] as const
export type TokenKind = (typeof TOKEN_KINDS)[number]

/**
 * Who a connection acts as: an agent (an assistant, an automation, HQ's own
 * runner) or a worker (the owner's machine doing production jobs). Chosen by
 * the owner when a personal token is minted; an OAuth app is always an
 * agent. It comes from the credential, never from anything a caller sends.
 */
export const GRANT_ACTOR_TYPES = ['agent', 'worker'] as const
export type GrantActorType = (typeof GRANT_ACTOR_TYPES)[number]

/* ── One app of projects × modules ──────────────────────────
 * The vocabulary of `projects`, `refs` and the `ops_*` kernel. Values that
 * appear in a CHECK live here so the schema and the apps agree; the module
 * manifests, defaults per kind and lane presets are built on top of them in
 * packages/hq-core/src/modules.ts.
 */

/**
 * Every module, in the one order the app draws them in: the matrix rows, the
 * planet reticle slots, Time rows and the rail within a kind.
 * Notes is a module too, but HQ-wide: it is never a matrix row.
 */
export const MODULE_IDS = [
  'board',
  'prompts',
  'assets',
  'story',
  'calendar',
  'quotes',
  'publish',
  'market',
  'experiments',
  'readings',
  'agents',
  'notes',
] as const
export type ModuleId = (typeof MODULE_IDS)[number]

/** What a project is — it decides which modules it starts with. */
export const PROJECT_KINDS = [
  'channel',
  'digital_assets',
  'film',
  'freelance',
  'personal',
] as const
export type ProjectKind = (typeof PROJECT_KINDS)[number]

export const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

/**
 * Project identity colours. Never a free hex: each swatch keeps `--ink` on its
 * `--tint` wash at ≥ 7:1 in both themes (checked by
 * packages/hq-core/test/colors.test.ts). They are the ten swatches the Bridge
 * design system offers for projects.
 */
export const PROJECT_COLORS = {
  violet: '#a08ef3',
  teal: '#4fc0c8',
  blue: '#6aa3ea',
  pink: '#e083b2',
  grey: '#9a9aa3',
  orange: '#f0a35a',
  mint: '#7fd1a8',
  gold: '#ffd166',
  lavender: '#c9b8ff',
  sky: '#5fb8ff',
} as const
export type ProjectColor = keyof typeof PROJECT_COLORS
export const PROJECT_COLOR_NAMES = Object.keys(PROJECT_COLORS) as ProjectColor[]

/** Where an asset's bytes live. An asset remembers its own provider forever. */
export const STORAGE_PROVIDERS = ['r2', 'gdrive'] as const
export type StorageProviderId = (typeof STORAGE_PROVIDERS)[number]

/** The one Google connection per owner. */
export const GOOGLE_CONNECTION_STATUSES = [
  'connected',
  'needs_reauth',
  'revoked',
] as const
export type GoogleConnectionStatus = (typeof GOOGLE_CONNECTION_STATUSES)[number]

/**
 * Services the owner connects once and every project can use — generators,
 * platforms, marketplaces and LLM keys. A secret is sealed; `config` never
 * holds one.
 */
export const PROVIDER_CONNECTION_KINDS = [
  'openai_compatible',
  'facebook',
  'youtube',
  'tiktok',
  'etsy',
  'llm:anthropic',
  'llm:openai_compatible',
] as const
export type ProviderConnectionKind = (typeof PROVIDER_CONNECTION_KINDS)[number]

export const PROVIDER_CONNECTION_STATUSES = [
  'not_connected',
  'connected',
  'needs_reauth',
  'error',
  'revoked',
] as const
export type ProviderConnectionStatus =
  (typeof PROVIDER_CONNECTION_STATUSES)[number]

/**
 * What a `refs` edge can point from or to. Every type is owned by exactly one
 * module; a module moves out with its rows, and `refs` is the only thing that
 * crosses between modules.
 */
export const REF_TYPES = [
  'note',
  'prompt',
  'prompt_variant',
  'card',
  'asset',
  'shot',
  'event',
  'quote',
  'post',
  'listing',
  'experiment',
  'proposal',
  'task',
  'human_request',
  'followup',
] as const
export type RefType = (typeof REF_TYPES)[number]

export const REF_ROLES = [
  'promoted_to',
  'attached',
  'example_of',
  'result_of',
  'scheduled_as',
  'quoted_by',
  'published_as',
  'listed_as',
  'proposed_as',
  'produced_by',
  /** A card or follow-up —made_with→ the prompt (or variant) the job ran on. */
  'made_with',
] as const
export type RefRole = (typeof REF_ROLES)[number]

/* ── ops — the agent-operations kernel ───────────────────
 * The same authorities the retired Creator kernel had, kept one for one and
 * named for modules instead of workspaces. A row sits under a project, or under the
 * owner alone when `project_id` is null.
 */

/** Who did it: the owner, one of their agent connections, or a worker. */
export const OPS_ACTOR_TYPES = ['user', 'agent', 'worker'] as const
export type OpsActorType = (typeof OPS_ACTOR_TYPES)[number]

export const OPS_POLICY_STATUSES = ['active', 'suspended'] as const
export type OpsPolicyStatus = (typeof OPS_POLICY_STATUSES)[number]

/**
 * `human_required` waits for the owner's approval of the exact payload;
 * `policy_gated` lets the server authorize it when every gate passes, and
 * never records that as a human approval.
 */
export const OPS_RELEASE_MODES = ['human_required', 'policy_gated'] as const
export type OpsReleaseMode = (typeof OPS_RELEASE_MODES)[number]

export const OPS_POLICY_COVERAGE = ['all_connections', 'selected'] as const
export type OpsPolicyCoverage = (typeof OPS_POLICY_COVERAGE)[number]

/**
 * The authorities an operating policy hands an agent, one by one. `draft`
 * writes notes, prompts, cards and shots; `propose` leaves a proposal for the
 * owner; `generate` spends on a generator; the rest are the release, import
 * and money authorities the publish and market modules ask for.
 */
export const OPS_AGENT_ACTIONS = [
  'draft',
  'propose',
  'generate',
  'import',
  'authorize_release',
  'publish',
  'list',
  'price',
  'respond',
  'decide',
] as const
export type OpsAgentAction = (typeof OPS_AGENT_ACTIONS)[number]

/**
 * `all` stops every agent of the owner (no project, no target); `project`
 * stops one project; the others stop one provider, connection, account or
 * marketplace, inside one project or — with no project — everywhere.
 */
export const OPS_KILL_SWITCH_SCOPES = [
  'all',
  'project',
  'provider',
  'connection',
  'account',
  'marketplace',
] as const
export type OpsKillSwitchScope = (typeof OPS_KILL_SWITCH_SCOPES)[number]

export const OPS_IDEMPOTENCY_STATES = ['committed', 'completed'] as const
export type OpsIdempotencyState = (typeof OPS_IDEMPOTENCY_STATES)[number]

/** What a budget limit counts. Credits and quota are never cash. */
export const OPS_BUDGET_KINDS = ['cash', 'credits', 'quota'] as const
export type OpsBudgetKind = (typeof OPS_BUDGET_KINDS)[number]

export const OPS_RESERVATION_STATUSES = [
  'reserved',
  'settled',
  'released',
  'expired',
] as const
export type OpsReservationStatus = (typeof OPS_RESERVATION_STATUSES)[number]

/** Whether a usage cost is a quote, a reconciled bill, or not known at all. */
export const OPS_USAGE_COST_STATUSES = [
  'estimated',
  'reconciled',
  'unknown',
] as const
export type OpsUsageCostStatus = (typeof OPS_USAGE_COST_STATUSES)[number]

export const OPS_TASK_KINDS = [
  'routine',
  'generation',
  'publication',
  'listing',
  'import',
  'reconcile',
  'review',
  'follow_up',
  'other',
] as const
export type OpsTaskKind = (typeof OPS_TASK_KINDS)[number]

export const OPS_TASK_STATUSES = [
  'open',
  'claimed',
  'blocked',
  'done',
  'failed',
  'cancelled',
] as const
export type OpsTaskStatus = (typeof OPS_TASK_STATUSES)[number]

/** A run is stalled when its heartbeat is late — derived, never stored. */
export const OPS_RUN_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'abandoned',
  'cancelled',
] as const
export type OpsRunStatus = (typeof OPS_RUN_STATUSES)[number]

export const OPS_AUTHORIZATION_MODES = [
  'human_approval',
  'policy_gated',
] as const
export type OpsAuthorizationMode = (typeof OPS_AUTHORIZATION_MODES)[number]

export const OPS_AUTHORIZATION_STATUSES = [
  'active',
  'consumed',
  'revoked',
  'expired',
] as const
export type OpsAuthorizationStatus = (typeof OPS_AUTHORIZATION_STATUSES)[number]

/** How a capability is known: documented, tested for real, or known missing. */
export const OPS_CAPABILITY_STATES = [
  'declared',
  'tested',
  'unavailable',
] as const
export type OpsCapabilityState = (typeof OPS_CAPABILITY_STATES)[number]

export const OPS_RUNTIME_STATUSES = ['active', 'paused', 'revoked'] as const
export type OpsRuntimeStatus = (typeof OPS_RUNTIME_STATUSES)[number]

/**
 * Delivered means the runtime's endpoint answered 2xx; acknowledged means the
 * runtime says it took the work. Neither means the work is done.
 */
export const OPS_EVENT_STATUSES = [
  'pending',
  'delivered',
  'acknowledged',
  'dead_letter',
  'cancelled',
] as const
export type OpsEventStatus = (typeof OPS_EVENT_STATUSES)[number]

export const OPS_EVENT_TYPES = [
  'task.ready',
  'job.finished',
  'human.responded',
  'proposal.decided',
  'run.stalled',
  'publication.changed',
  'listing.changed',
  'order.received',
  'sync.failed',
  'budget.warning',
] as const
export type OpsEventType = (typeof OPS_EVENT_TYPES)[number]

export const OPS_INBOUND_STATUSES = [
  'accepted',
  'rejected',
  'duplicate',
] as const
export type OpsInboundStatus = (typeof OPS_INBOUND_STATUSES)[number]

/** What only the owner can do, or decide. */
export const OPS_HUMAN_REQUEST_KINDS = [
  'approval',
  'choice',
  'sign_in',
  'consent',
  'identity',
  'payout',
  'likeness',
  'spend_scope',
  'account_dispute',
  'manual_step',
  'information',
] as const
export type OpsHumanRequestKind = (typeof OPS_HUMAN_REQUEST_KINDS)[number]

export const OPS_HUMAN_REQUEST_STATUSES = [
  'open',
  'answered',
  'expired',
  'withdrawn',
] as const
export type OpsHumanRequestStatus = (typeof OPS_HUMAN_REQUEST_STATUSES)[number]

export const OPS_URGENCIES = ['digest', 'urgent'] as const
export type OpsUrgency = (typeof OPS_URGENCIES)[number]

/* ── The active-work modules ────────────────────────
 * Board · Prompts · Assets · Calendar · Quotes. Each list is
 * a CHECK in its module's schema file and a union the services type with.
 */

/** A board lane's job: an ordinary step, the one pinned "awaiting payment" lane, or the last. */
export const BOARD_LANE_ROLES = ['normal', 'awaiting_payment', 'done'] as const
export type BoardLaneRole = (typeof BOARD_LANE_ROLES)[number]

/** What happened to a card — its append-only history. */
export const BOARD_CARD_EVENT_KINDS = [
  'created',
  'moved',
  'edited',
  'priced',
  'paid',
  'unpaid',
  'archived',
  'restored',
  'deleted',
  'undeleted',
  'followup_added',
  'followup_edited',
  'followup_removed',
  'payment_recorded',
  'payment_voided',
] as const
export type BoardCardEventKind = (typeof BOARD_CARD_EVENT_KINDS)[number]

/**
 * A line in a card's payment ledger: a deposit (any size, or none at all), a
 * part payment while the work goes on, the rest when the card is marked paid
 * — or a void that strikes one of those. The ledger is append-only.
 */
export const BOARD_PAYMENT_KINDS = ['deposit', 'part', 'final', 'void'] as const
export type BoardPaymentKind = (typeof BOARD_PAYMENT_KINDS)[number]

/** What a prompt makes. */
export const PROMPT_MEDIA = ['image', 'video', 'text', 'audio'] as const
export type PromptMedium = (typeof PROMPT_MEDIA)[number]

export const ASSET_KINDS = ['image', 'video', 'audio', 'doc', 'other'] as const
export type AssetKind = (typeof ASSET_KINDS)[number]

/** How the bytes arrived: the owner uploaded them, HQ or an agent made them, or they came in with an import. */
export const ASSET_ORIGINS = ['upload', 'generated', 'import'] as const
export type AssetOrigin = (typeof ASSET_ORIGINS)[number]

/**
 * `pending` until the bytes are confirmed in storage; `ready` is immutable
 * from then on; `rejected` is a pending upload the owner turned down, or a
 * ready file that vanished from its storage.
 */
export const ASSET_STATUSES = ['pending', 'ready', 'rejected'] as const
export type AssetStatus = (typeof ASSET_STATUSES)[number]

export const ASSET_COLLECTION_KINDS = [
  'characters',
  'scenes',
  'refs',
  'generated',
  'custom',
] as const
export type AssetCollectionKind = (typeof ASSET_COLLECTION_KINDS)[number]

/** Where a calendar event was made. A Google event is read from Google; a change made in HQ is written back. */
export const CALENDAR_EVENT_SOURCES = ['hq', 'google'] as const
export type CalendarEventSource = (typeof CALENDAR_EVENT_SOURCES)[number]

/**
 * An HQ event's round trip to Google: `local` never leaves HQ; `pending`
 * waits for the next sync step; `synced` matches Google; `error` says why not.
 */
export const CALENDAR_SYNC_STATES = [
  'local',
  'pending',
  'synced',
  'error',
] as const
export type CalendarSyncState = (typeof CALENDAR_SYNC_STATES)[number]

/** A quote's life. Sending it is the owner's own act. */
export const QUOTE_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
] as const
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]

/* ── The passive-income modules ─────────────────────
 * Publish · Market · Experiments. Readings has no tables of
 * its own; it reads theirs. The release path of a post or a listing is the
 * ops kernel's (`ops_release_authorizations`): nothing leaves HQ unless the
 * owner approved that exact payload, or a policy they set did.
 */

/** Where a channel posts. `manual` is anywhere HQ only records by hand. */
export const PUBLISH_PLATFORMS = [
  'facebook',
  'youtube',
  'tiktok',
  'manual',
] as const
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number]

/**
 * A post's life. `planned` is a draft nobody has cleared; `scheduled` is
 * cleared by the owner (a release authorization) and waits for its time or
 * for someone to post it; `dispatched` was sent through a platform's API and
 * not read back yet; `posted` is on the record with evidence; `verified` is a
 * post the platform itself read back. Planned is never posted.
 */
export const PUBLISH_POST_STATUSES = [
  'planned',
  'scheduled',
  'dispatched',
  'posted',
  'verified',
  'removed',
  'failed',
] as const
export type PublishPostStatus = (typeof PUBLISH_POST_STATUSES)[number]

/** How we know a post is out: who said so, or what showed it. */
export const PUBLISH_EVIDENCE_LEVELS = [
  'owner_attested',
  'agent_attested',
  'screenshot',
  'platform_export',
  'provider_verified',
] as const
export type PublishEvidenceLevel = (typeof PUBLISH_EVIDENCE_LEVELS)[number]

/**
 * One API dispatch of a post. `unknown` is a submit whose answer never came
 * back — it is reconciled by reading the platform, never sent twice.
 */
export const PUBLISH_INTENT_STATUSES = [
  'submitting',
  'submitted',
  'unknown',
  'verified',
  'failed',
  'cancelled',
] as const
export type PublishIntentStatus = (typeof PUBLISH_INTENT_STATUSES)[number]

/** Where a reading came from. */
export const READING_SOURCES = [
  'manual',
  'agent',
  'provider',
  'import',
] as const
export type ReadingSource = (typeof READING_SOURCES)[number]

/**
 * `lifetime` is a counter as of a moment (never summed with another);
 * `interval` is what happened between two moments (money is always one).
 */
export const READING_WINDOWS = ['lifetime', 'interval'] as const
export type ReadingWindow = (typeof READING_WINDOWS)[number]

/** Where digital assets are sold. `manual` is any shop HQ only records by hand. */
export const MARKET_KINDS = ['etsy', 'pod', 'gumroad', 'manual'] as const
export type MarketKind = (typeof MARKET_KINDS)[number]

export const MARKET_PRODUCT_STATUSES = ['draft', 'ready', 'retired'] as const
export type MarketProductStatus = (typeof MARKET_PRODUCT_STATUSES)[number]

/** A product's files: what the buyer downloads, and what the listing shows. */
export const MARKET_FILE_ROLES = ['deliverable', 'preview'] as const
export type MarketFileRole = (typeof MARKET_FILE_ROLES)[number]

/**
 * A listing's life, parallel to a post's: `approved` is cleared by the owner
 * and waits to go out; `listed` is live on the record; `verified` was read
 * back from the marketplace; `inactive` was taken down or expired.
 */
export const MARKET_LISTING_STATUSES = [
  'planned',
  'approved',
  'dispatched',
  'listed',
  'verified',
  'inactive',
  'failed',
] as const
export type MarketListingStatus = (typeof MARKET_LISTING_STATUSES)[number]

/** One API dispatch of a listing — like a post's. */
export const MARKET_INTENT_STATUSES = PUBLISH_INTENT_STATUSES
export type MarketIntentStatus = PublishIntentStatus

/** What a money line from a marketplace is. Append-only; a fix supersedes. */
export const MARKET_SALE_KINDS = [
  'sale',
  'refund',
  'fee',
  'adjustment',
] as const
export type MarketSaleKind = (typeof MARKET_SALE_KINDS)[number]

/** A payout the marketplace says is coming, or one the bank showed. */
export const MARKET_PAYOUT_STATUSES = ['expected', 'confirmed'] as const
export type MarketPayoutStatus = (typeof MARKET_PAYOUT_STATUSES)[number]

/**
 * `draft` can still change its design; `running` collects items; `reading`
 * waits for the items to reach the read age; `decided` has a verdict.
 */
export const EXP_STATUSES = [
  'draft',
  'running',
  'reading',
  'decided',
  'archived',
] as const
export type ExpStatus = (typeof EXP_STATUSES)[number]

/** What an experiment compares: posts, or listings. */
export const EXP_SUBJECT_TYPES = ['post', 'listing'] as const
export type ExpSubjectType = (typeof EXP_SUBJECT_TYPES)[number]

export const EXP_VERDICTS = [
  'winner',
  'no_difference',
  'inconclusive',
  'stopped',
] as const
export type ExpVerdict = (typeof EXP_VERDICTS)[number]

export const EXP_LEARNING_STATUSES = ['active', 'retired'] as const
export type ExpLearningStatus = (typeof EXP_LEARNING_STATUSES)[number]

/* ── Story ──────────────────────────────────────────
 * A film's script, characters, scenes and shots. Editing is
 * the owner's, on their own machine: HQ ends at "every shot has its file".
 */

/** A shot's life on the board: drawn · has a result · cut · done. */
export const STORY_SHOT_STATUSES = [
  'boarded',
  'generated',
  'edited',
  'done',
] as const
export type StoryShotStatus = (typeof STORY_SHOT_STATUSES)[number]

/**
 * A generation or production job. `manual` jobs wait for the
 * owner's upload; worker jobs are claimed with a lease through the ops task
 * they sit on. `ready` means a result is attached.
 */
export const ASSET_JOB_STATUSES = [
  'awaiting_upload',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type AssetJobStatus = (typeof ASSET_JOB_STATUSES)[number]

/** What a job makes: a generated medium, or a worker's production step. */
export const ASSET_JOB_OPERATIONS = [
  'generate',
  'thumbnail',
  'zip',
  'compose',
  'render',
  'package',
  'mockup',
  'probe',
] as const
export type AssetJobOperation = (typeof ASSET_JOB_OPERATIONS)[number]

/**
 * Who may claim an ops task: the local worker, an agent
 * connection working over MCP, or HQ's own builtin runner. Null on a task
 * means anyone the policy and scopes allow.
 */
export const OPS_TASK_CLAIMANTS = ['worker', 'agent', 'builtin'] as const
export type OpsTaskClaimant = (typeof OPS_TASK_CLAIMANTS)[number]

/* ── Agents ─────────────────────────────────────────
 * Routines the owner schedules, and the proposals their runs leave in the
 * Inbox. A run itself is the ops kernel's (`ops_tasks`
 * kind `routine` + `ops_agent_runs`); cost is its `ops_usage_events`.
 */

/**
 * `mcp`: HQ queues the run and an outside agent claims it over MCP. `builtin`:
 * HQ's own runner (apps/agent-runner) claims it and runs an LLM with the
 * owner's key.
 */
export const AGENT_RUNNERS = ['mcp', 'builtin'] as const
export type AgentRunner = (typeof AGENT_RUNNERS)[number]

/**
 * What a proposal becomes once the owner accepts it — each a target in the
 * hq-core registry.
 */
export const AGENT_PROPOSAL_KINDS = [
  'note',
  'prompt',
  'prompt_variant',
  'card',
  'shot',
  'event',
  'experiment',
] as const
export type AgentProposalKind = (typeof AGENT_PROPOSAL_KINDS)[number]

/**
 * The only kinds a routine may accept on the owner's behalf: nothing that
 * reaches the board, the calendar, a film or an experiment — and nothing
 * that publishes or spends — lands without the owner. A CHECK
 * in the database, not a setting.
 */
export const AGENT_AUTO_ACCEPTABLE = ['note', 'prompt_variant'] as const
export type AgentAutoAcceptable = (typeof AGENT_AUTO_ACCEPTABLE)[number]

export const AGENT_PROPOSAL_STATUSES = [
  'proposed',
  'accepted',
  'rejected',
  'expired',
] as const
export type AgentProposalStatus = (typeof AGENT_PROPOSAL_STATUSES)[number]
