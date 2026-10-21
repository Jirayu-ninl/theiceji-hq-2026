import { type SQL, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  GRANT_ACTOR_TYPES,
  type GrantActorType,
  MODULE_IDS,
  type ModuleId,
  OPS_ACTOR_TYPES,
  OPS_AUTHORIZATION_MODES,
  OPS_AUTHORIZATION_STATUSES,
  OPS_BUDGET_KINDS,
  OPS_CAPABILITY_STATES,
  OPS_EVENT_STATUSES,
  OPS_EVENT_TYPES,
  OPS_HUMAN_REQUEST_KINDS,
  OPS_HUMAN_REQUEST_STATUSES,
  OPS_IDEMPOTENCY_STATES,
  OPS_INBOUND_STATUSES,
  OPS_KILL_SWITCH_SCOPES,
  OPS_POLICY_COVERAGE,
  OPS_POLICY_STATUSES,
  OPS_RELEASE_MODES,
  OPS_RESERVATION_STATUSES,
  OPS_RUN_STATUSES,
  OPS_RUNTIME_STATUSES,
  OPS_TASK_CLAIMANTS,
  OPS_TASK_KINDS,
  OPS_TASK_STATUSES,
  OPS_URGENCIES,
  OPS_USAGE_COST_STATUSES,
  type OpsActorType,
  type OpsAgentAction,
  type OpsAuthorizationMode,
  type OpsAuthorizationStatus,
  type OpsBudgetKind,
  type OpsCapabilityState,
  type OpsEventStatus,
  type OpsEventType,
  type OpsHumanRequestKind,
  type OpsHumanRequestStatus,
  type OpsIdempotencyState,
  type OpsInboundStatus,
  type OpsKillSwitchScope,
  type OpsPolicyCoverage,
  type OpsPolicyStatus,
  type OpsReleaseMode,
  type OpsReservationStatus,
  type OpsRunStatus,
  type OpsRuntimeStatus,
  type OpsTaskClaimant,
  type OpsTaskKind,
  type OpsTaskStatus,
  type OpsUrgency,
  type OpsUsageCostStatus,
} from '../enums'
import { nullableOneOf, oneOf, tz } from './_shared'
import { tracked, userRef } from './_user'
import { oauthGrants } from './auth'
import { projects, providerConnections } from './core'

/* ── ops — the one agent-operations kernel ────────────────
 *
 * The kernel the retired Creator domain had, lifted out of it so every module
 * runs on it: tasks with leases and fencing, runs and checkpoints, the
 * owner's inbox of human requests, operating policies and kill switches,
 * budget reservations and usage, audit, idempotency, the transactional
 * outbox and its deliveries, inbound events, runtimes and the scheduler
 * lease. Same meaning, column for column where the column was
 * about the kernel; three things changed:
 *
 * · **A row belongs to an owner, and maybe a project.** `owner_id` is NOT
 *   NULL on every row; `project_id` is null for work that belongs to no
 *   project (a routine across projects, a note-level task). Every parent has
 *   `unique (id, owner_id)` and every child's key includes `owner_id`, so a
 *   reference across owners is impossible even when `project_id` is null.
 *   `(project_id, owner_id) → projects` keeps a row inside its owner's
 *   project.
 * · **No foreign key into a module.** What Creator's release authorization
 *   pointed at by key (content, version, account, approval) is a subject here
 *   — a type and an ID — and the module that owns the subject checks it.
 * · **Domain knobs moved out of the policy.** What only one module reads
 *   lives in `extensions[module]`, validated by that module.
 *
 * Append-only history (policy revisions, run checkpoints, usage, audit,
 * capability checks, human responses) and the release-authorization guard are
 * triggers in the migration, counted by readiness.ts.
 */

const ownerId = () =>
  uuid('owner_id').notNull().references(userRef, { onDelete: 'restrict' })

const opsActor = () => ({
  actorType: text('actor_type').$type<OpsActorType>().notNull(),
  actorId: text('actor_id').notNull(),
})

const opsActorCheck = (name: string, col: AnyPgColumn) =>
  check(name, oneOf(col, OPS_ACTOR_TYPES))

/** Keeps a row inside a project of its own owner; skipped when there is no project. */
const inOwnProject = (
  name: string,
  t: { projectId: AnyPgColumn; ownerId: AnyPgColumn },
) =>
  foreignKey({
    name,
    columns: [t.projectId, t.ownerId],
    foreignColumns: [projects.id, projects.ownerId],
  }).onDelete('restrict')

/** A nil UUID stands in for "no project" where a unique index has to see it. */
const projectOrNone = (col: AnyPgColumn): SQL =>
  sql`coalesce(${col}, '00000000-0000-0000-0000-000000000000'::uuid)`

/** Per-provider unit limits: `{ "<provider>:<unit>": { perJob, perDay, perMonth } }`. */
export type OpsUnitLimits = Record<
  string,
  { perJob?: number; perDay?: number; perMonth?: number }
>

/**
 * What an owner lets agents do — in one project, or (project null) in work
 * that belongs to no project. One immutable revision per change; the newest
 * is the policy. There is no inheritance: a project without its own policy
 * lets agents read and nothing else. A missing limit means no new spend,
 * never no limit.
 */
export const opsPolicies = pgTable(
  'ops_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    projectId: uuid('project_id'),
    revisionNo: integer('revision_no').notNull(),
    supersedesId: uuid('supersedes_id'),
    status: text('status').$type<OpsPolicyStatus>().notNull(),
    releaseMode: text('release_mode')
      .$type<OpsReleaseMode>()
      .notNull()
      .default('human_required'),
    coverage: text('coverage')
      .$type<OpsPolicyCoverage>()
      .notNull()
      .default('all_connections'),
    /** Connection (grant) IDs the policy covers when `coverage = selected`. */
    grantIds: jsonb('grant_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    allowedActions: jsonb('allowed_actions')
      .$type<OpsAgentAction[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Platform accounts or marketplaces a release may target. Empty means none. */
    allowedAccountIds: jsonb('allowed_account_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Provider keys a job or dispatch may use (`agent:fal`, `external:…`). Empty means none. */
    allowedProviders: jsonb('allowed_providers')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    currency: text('currency').notNull(),
    /** Cash an agent may commit. Null means none — an unknown price is never free. */
    cashLimitPerJobMinor: bigint('cash_limit_per_job_minor', {
      mode: 'number',
    }),
    cashLimitPerDayMinor: bigint('cash_limit_per_day_minor', {
      mode: 'number',
    }),
    cashLimitPerMonthMinor: bigint('cash_limit_per_month_minor', {
      mode: 'number',
    }),
    unitLimits: jsonb('unit_limits')
      .$type<OpsUnitLimits>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    maxConcurrentJobs: integer('max_concurrent_jobs').notNull().default(1),
    maxPostsPerAccountPerDay: integer('max_posts_per_account_per_day')
      .notNull()
      .default(0),
    postCooldownMinutes: integer('post_cooldown_minutes').notNull().default(0),
    wipLimit: integer('wip_limit'),
    operatorMinutesPerWeek: integer('operator_minutes_per_week'),
    /** Conditions that stop agent work outright, e.g. `unknown_quota`. */
    stopConditions: jsonb('stop_conditions')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    escalation: jsonb('escalation')
      .$type<{ digest?: 'daily' | 'weekly'; urgentKinds?: string[] }>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * Settings only one module reads, keyed by module id. Part of the
     * revision, so changing them expires what the old revision authorized.
     * Validated by the module's own package, never trusted from the column.
     */
    extensions: jsonb('extensions')
      .$type<Record<string, Record<string, unknown>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    effectiveFrom: timestamp('effective_from', tz).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', tz),
    note: text('note'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
  },
  (t) => [
    unique('ops_policies_owner_scope_key').on(t.id, t.ownerId),
    uniqueIndex('ops_policies_revision_key').on(
      t.ownerId,
      projectOrNone(t.projectId),
      t.revisionNo,
    ),
    inOwnProject('ops_policies_project_fk', t),
    foreignKey({
      name: 'ops_policies_supersedes_fk',
      columns: [t.supersedesId, t.ownerId],
      foreignColumns: [t.id, t.ownerId],
    }).onDelete('restrict'),
    check('ops_policies_status_check', oneOf(t.status, OPS_POLICY_STATUSES)),
    check(
      'ops_policies_release_check',
      oneOf(t.releaseMode, OPS_RELEASE_MODES),
    ),
    check(
      'ops_policies_coverage_check',
      oneOf(t.coverage, OPS_POLICY_COVERAGE),
    ),
    check(
      'ops_policies_revision_check',
      sql`${t.revisionNo} >= 1 and (${t.revisionNo} = 1) = (${t.supersedesId} is null)`,
    ),
    check('ops_policies_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'ops_policies_limits_check',
      sql`coalesce(${t.cashLimitPerJobMinor}, 0) >= 0 and coalesce(${t.cashLimitPerDayMinor}, 0) >= 0 and coalesce(${t.cashLimitPerMonthMinor}, 0) >= 0 and ${t.maxConcurrentJobs} >= 0 and ${t.maxPostsPerAccountPerDay} >= 0 and ${t.postCooldownMinutes} >= 0 and coalesce(${t.wipLimit}, 0) >= 0 and coalesce(${t.operatorMinutesPerWeek}, 0) >= 0`,
    ),
    check(
      'ops_policies_period_check',
      sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.effectiveFrom}`,
    ),
  ],
)

/**
 * A stop button. Engaged switches refuse new agent work and new external side
 * effects in their scope; releasing one is its own recorded act.
 */
export const opsKillSwitches = pgTable(
  'ops_kill_switches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    projectId: uuid('project_id'),
    scope: text('scope').$type<OpsKillSwitchScope>().notNull(),
    /** Provider key, connection ID, account or marketplace ID; null for `all` and `project`. */
    target: text('target'),
    reason: text('reason').notNull(),
    engagedAt: timestamp('engaged_at', tz).notNull().defaultNow(),
    engagedBy: uuid('engaged_by')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
    releasedAt: timestamp('released_at', tz),
    releasedBy: uuid('released_by').references(userRef, {
      onDelete: 'restrict',
    }),
    releaseReason: text('release_reason'),
  },
  (t) => [
    inOwnProject('ops_kill_switches_project_fk', t),
    uniqueIndex('ops_kill_switches_engaged_key')
      .on(
        t.ownerId,
        projectOrNone(t.projectId),
        t.scope,
        sql`coalesce(${t.target}, '')`,
      )
      .where(sql`${t.releasedAt} is null`),
    check(
      'ops_kill_switches_scope_check',
      oneOf(t.scope, OPS_KILL_SWITCH_SCOPES),
    ),
    check(
      'ops_kill_switches_target_check',
      sql`case ${t.scope}
        when 'all' then ${t.projectId} is null and ${t.target} is null
        when 'project' then ${t.projectId} is not null and ${t.target} is null
        else ${t.target} is not null
      end`,
    ),
    check(
      'ops_kill_switches_release_check',
      sql`(${t.releasedAt} is null) = (${t.releasedBy} is null) and (${t.releasedAt} is null or ${t.releaseReason} is not null)`,
    ),
  ],
)

/**
 * One key per retried request. Claimed inside the transaction that does the
 * work, so a rolled-back attempt leaves no key behind; the same key with the
 * same payload replays the recorded result, a different payload conflicts.
 */
export const opsIdempotencyKeys = pgTable(
  'ops_idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The user, agent connection or worker the key belongs to. */
    actorId: text('actor_id').notNull(),
    ownerId: ownerId(),
    key: text('key').notNull(),
    operation: text('operation').notNull(),
    requestHash: text('request_hash').notNull(),
    state: text('state').$type<OpsIdempotencyState>().notNull(),
    projectId: uuid('project_id'),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    auditIds: jsonb('audit_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    response: jsonb('response').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    completedAt: timestamp('completed_at', tz),
    expiresAt: timestamp('expires_at', tz).notNull(),
  },
  (t) => [
    uniqueIndex('ops_idempotency_keys_key').on(t.actorId, t.key),
    index('ops_idempotency_keys_expires_idx').on(t.expiresAt),
    inOwnProject('ops_idempotency_keys_project_fk', t),
    check(
      'ops_idempotency_keys_state_check',
      oneOf(t.state, OPS_IDEMPOTENCY_STATES),
    ),
    check(
      'ops_idempotency_keys_length_check',
      sql`length(${t.key}) between 8 and 200`,
    ),
  ],
)

/**
 * Work for agents: one claimable unit with a lease. Claiming bumps the
 * fencing token; any later side effect presents it, and a token that is no
 * longer current is refused — two workers never both win a task.
 */
export const opsTasks = pgTable(
  'ops_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerId(),
    projectId: uuid('project_id'),
    kind: text('kind').$type<OpsTaskKind>().notNull(),
    /** The module whose work this is; null for kernel work (routines, reconciles). */
    module: text('module').$type<ModuleId>(),
    title: text('title').notNull(),
    detail: text('detail'),
    /** IDs and parameters only — never instructions copied from outside. */
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    priority: integer('priority').notNull().default(50),
    priorityReason: text('priority_reason'),
    status: text('status').$type<OpsTaskStatus>().notNull().default('open'),
    dependsOn: jsonb('depends_on')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dueAt: timestamp('due_at', tz),
    notBefore: timestamp('not_before', tz),
    /** What made the task — stops the same trigger opening it twice. */
    triggerKey: text('trigger_key'),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    /**
     * Who may claim it: the local worker, an agent over MCP, or HQ's builtin
     * runner; null for anyone the policy and scopes allow.
     */
    claimant: text('claimant').$type<OpsTaskClaimant>(),
    leaseActorType: text('lease_actor_type').$type<OpsActorType>(),
    leaseActorId: text('lease_actor_id'),
    leaseExpiresAt: timestamp('lease_expires_at', tz),
    fencingToken: bigint('fencing_token', { mode: 'number' })
      .notNull()
      .default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    waitingOnRequestId: uuid('waiting_on_request_id'),
    blockedReason: text('blocked_reason'),
    lastError: text('last_error'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    nextAction: text('next_action'),
    completedAt: timestamp('completed_at', tz),
  },
  (t) => [
    unique('ops_tasks_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('ops_tasks_project_fk', t),
    uniqueIndex('ops_tasks_trigger_key')
      .on(t.ownerId, t.triggerKey)
      .where(sql`${t.triggerKey} is not null`),
    index('ops_tasks_queue_idx').on(
      t.ownerId,
      t.status,
      t.priority.desc(),
      t.dueAt,
    ),
    index('ops_tasks_project_idx').on(t.projectId, t.status),
    check('ops_tasks_kind_check', oneOf(t.kind, OPS_TASK_KINDS)),
    check('ops_tasks_module_check', nullableOneOf(t.module, MODULE_IDS)),
    check('ops_tasks_status_check', oneOf(t.status, OPS_TASK_STATUSES)),
    check(
      'ops_tasks_lease_check',
      sql`(${t.status} = 'claimed') = (${t.leaseActorId} is not null and ${t.leaseExpiresAt} is not null and ${t.leaseActorType} is not null)`,
    ),
    check(
      'ops_tasks_blocked_check',
      sql`${t.status} <> 'blocked' or ${t.blockedReason} is not null`,
    ),
    check(
      'ops_tasks_attempts_check',
      sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1 and ${t.priority} between 0 and 100`,
    ),
    check(
      'ops_tasks_lease_actor_check',
      nullableOneOf(t.leaseActorType, OPS_ACTOR_TYPES),
    ),
    check(
      'ops_tasks_claimant_check',
      nullableOneOf(t.claimant, OPS_TASK_CLAIMANTS),
    ),
  ],
)

/**
 * One agent or worker session on a task. Checkpoints go to HQ, not to chat
 * memory, so a new session resumes from the last one. A run whose heartbeat
 * is late is reported stalled; one whose lease lapsed is abandoned.
 */
export const opsAgentRuns = pgTable(
  'ops_agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    projectId: uuid('project_id'),
    taskId: uuid('task_id').notNull(),
    ...opsActor(),
    status: text('status').$type<OpsRunStatus>().notNull().default('running'),
    fencingToken: bigint('fencing_token', { mode: 'number' }).notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', tz).notNull(),
    heartbeatAt: timestamp('heartbeat_at', tz).notNull().defaultNow(),
    checkpointSeq: integer('checkpoint_seq').notNull().default(0),
    lastCheckpoint: jsonb('last_checkpoint').$type<Record<string, unknown>>(),
    nextAction: text('next_action'),
    /** What this run was allowed and what it used, for the owner. */
    budgets: jsonb('budgets')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    outputRefs: jsonb('output_refs')
      .$type<{ type: string; id: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    summary: text('summary'),
    error: text('error'),
    startedAt: timestamp('started_at', tz).notNull().defaultNow(),
    endedAt: timestamp('ended_at', tz),
    createdBy: uuid('created_by')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
  },
  (t) => [
    unique('ops_agent_runs_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('ops_agent_runs_project_fk', t),
    foreignKey({
      name: 'ops_agent_runs_task_fk',
      columns: [t.taskId, t.ownerId],
      foreignColumns: [opsTasks.id, opsTasks.ownerId],
    }).onDelete('restrict'),
    index('ops_agent_runs_task_idx').on(t.taskId, t.startedAt.desc()),
    index('ops_agent_runs_status_idx').on(t.ownerId, t.status),
    opsActorCheck('ops_agent_runs_actor_check', t.actorType),
    check('ops_agent_runs_status_check', oneOf(t.status, OPS_RUN_STATUSES)),
    check(
      'ops_agent_runs_ended_check',
      sql`(${t.status} = 'running') = (${t.endedAt} is null)`,
    ),
  ],
)

/** Append-only: the state a run left for whoever comes next. */
export const opsRunCheckpoints = pgTable(
  'ops_run_checkpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    projectId: uuid('project_id'),
    runId: uuid('run_id').notNull(),
    seq: integer('seq').notNull(),
    summary: text('summary').notNull(),
    state: jsonb('state')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    nextAction: text('next_action'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    inOwnProject('ops_run_checkpoints_project_fk', t),
    foreignKey({
      name: 'ops_run_checkpoints_run_fk',
      columns: [t.runId, t.ownerId],
      foreignColumns: [opsAgentRuns.id, opsAgentRuns.ownerId],
    }).onDelete('restrict'),
    unique('ops_run_checkpoints_seq_key').on(t.runId, t.seq),
    check('ops_run_checkpoints_seq_check', sql`${t.seq} >= 1`),
  ],
)

/**
 * A money or unit limit held before work that may cost something, settled
 * against what it actually cost or released. Reserved plus settled in a
 * period is what the policy limit is checked against, under a lock.
 */
export const opsBudgetReservations = pgTable(
  'ops_budget_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    projectId: uuid('project_id'),
    policyId: uuid('policy_id').notNull(),
    kind: text('kind').$type<OpsBudgetKind>().notNull(),
    /** The currency for cash; `<provider>:<unit>` for credits and quota. */
    unit: text('unit').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    settledAmount: bigint('settled_amount', { mode: 'number' }),
    status: text('status')
      .$type<OpsReservationStatus>()
      .notNull()
      .default('reserved'),
    provider: text('provider'),
    purpose: text('purpose').notNull(),
    subjectType: text('subject_type'),
    subjectId: uuid('subject_id'),
    ...opsActor(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    settledAt: timestamp('settled_at', tz),
    releasedAt: timestamp('released_at', tz),
    statusReason: text('status_reason'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
  },
  (t) => [
    unique('ops_budget_reservations_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('ops_budget_reservations_project_fk', t),
    foreignKey({
      name: 'ops_budget_reservations_policy_fk',
      columns: [t.policyId, t.ownerId],
      foreignColumns: [opsPolicies.id, opsPolicies.ownerId],
    }).onDelete('restrict'),
    index('ops_budget_reservations_open_idx').on(
      t.ownerId,
      t.projectId,
      t.status,
      t.createdAt,
    ),
    check(
      'ops_budget_reservations_kind_check',
      oneOf(t.kind, OPS_BUDGET_KINDS),
    ),
    check(
      'ops_budget_reservations_status_check',
      oneOf(t.status, OPS_RESERVATION_STATUSES),
    ),
    opsActorCheck('ops_budget_reservations_actor_check', t.actorType),
    check(
      'ops_budget_reservations_amount_check',
      sql`${t.amount} >= 0 and coalesce(${t.settledAmount}, 0) >= 0`,
    ),
    check(
      'ops_budget_reservations_settled_check',
      sql`(${t.status} = 'settled') = (${t.settledAt} is not null and ${t.settledAmount} is not null)`,
    ),
  ],
)

/**
 * Append-only: what a provider call actually used and cost — including failed
 * attempts and retries, which are never dropped. Unknown cost is not zero.
 */
export const opsUsageEvents = pgTable(
  'ops_usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    projectId: uuid('project_id'),
    reservationId: uuid('reservation_id'),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    provider: text('provider').notNull(),
    kind: text('kind').$type<OpsBudgetKind>().notNull(),
    unit: text('unit').notNull(),
    quantity: bigint('quantity', { mode: 'number' }),
    costMinor: bigint('cost_minor', { mode: 'number' }),
    currency: text('currency'),
    costStatus: text('cost_status').$type<OpsUsageCostStatus>().notNull(),
    attemptNo: integer('attempt_no').notNull().default(1),
    failed: boolean('failed').notNull().default(false),
    /** LLM tokens for a run, when the provider reports them. */
    tokens: bigint('tokens', { mode: 'number' }),
    occurredAt: timestamp('occurred_at', tz).notNull(),
    note: text('note'),
    ...opsActor(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
  },
  (t) => [
    inOwnProject('ops_usage_events_project_fk', t),
    foreignKey({
      name: 'ops_usage_events_reservation_fk',
      columns: [t.reservationId, t.ownerId],
      foreignColumns: [opsBudgetReservations.id, opsBudgetReservations.ownerId],
    }).onDelete('restrict'),
    index('ops_usage_events_subject_idx').on(t.subjectType, t.subjectId),
    index('ops_usage_events_owner_idx').on(
      t.ownerId,
      t.projectId,
      t.occurredAt,
    ),
    check('ops_usage_events_kind_check', oneOf(t.kind, OPS_BUDGET_KINDS)),
    check(
      'ops_usage_events_cost_status_check',
      oneOf(t.costStatus, OPS_USAGE_COST_STATUSES),
    ),
    opsActorCheck('ops_usage_events_actor_check', t.actorType),
    check(
      'ops_usage_events_cost_check',
      sql`(${t.costStatus} = 'unknown') = (${t.costMinor} is null) and (${t.costMinor} is null or (${t.costMinor} >= 0 and ${t.currency} ~ '^[A-Z]{3}$'))`,
    ),
    check(
      'ops_usage_events_numbers_check',
      sql`coalesce(${t.quantity}, 0) >= 0 and coalesce(${t.tokens}, 0) >= 0 and ${t.attemptNo} >= 1`,
    ),
  ],
)

/** Append-only: who did what to which record, and what changed. */
export const opsAuditEvents = pgTable(
  'ops_audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', tz).notNull().defaultNow(),
    ownerId: ownerId(),
    ...opsActor(),
    projectId: uuid('project_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    beforeRevision: integer('before_revision'),
    afterRevision: integer('after_revision'),
    reason: text('reason'),
    changes: jsonb('changes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    inOwnProject('ops_audit_events_project_fk', t),
    index('ops_audit_owner_idx').on(t.ownerId, t.occurredAt.desc()),
    index('ops_audit_project_idx').on(t.projectId, t.occurredAt.desc()),
    index('ops_audit_target_idx').on(
      t.targetType,
      t.targetId,
      t.occurredAt.desc(),
    ),
    opsActorCheck('ops_audit_events_actor_check', t.actorType),
  ],
)

/**
 * Something happened that a runtime may need to act on. Written in the same
 * transaction as the change it announces, delivered later with a stable ID.
 * Payloads carry IDs only; the runtime reads the work back from HQ.
 */
export const opsOutboxEvents = pgTable(
  'ops_outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    projectId: uuid('project_id'),
    type: text('type').$type<OpsEventType>().notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    payload: jsonb('payload')
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text('status').$type<OpsEventStatus>().notNull().default('pending'),
    availableAt: timestamp('available_at', tz).notNull().defaultNow(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', tz),
  },
  (t) => [
    unique('ops_outbox_events_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('ops_outbox_events_project_fk', t),
    uniqueIndex('ops_outbox_events_dedupe_key').on(t.ownerId, t.dedupeKey),
    index('ops_outbox_events_pending_idx').on(t.status, t.availableAt),
    check('ops_outbox_events_type_check', oneOf(t.type, OPS_EVENT_TYPES)),
    check(
      'ops_outbox_events_status_check',
      oneOf(t.status, OPS_EVENT_STATUSES),
    ),
  ],
)

/**
 * An agent or worker process the owner registered: its connection, where
 * events are pushed (optional — pull always works), and whether it is alive.
 */
export const opsRuntimes = pgTable(
  'ops_runtimes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerId(),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    kind: text('kind').$type<GrantActorType>().notNull(),
    deliveryUrl: text('delivery_url'),
    sealedDeliverySecret: text('sealed_delivery_secret'),
    status: text('status')
      .$type<OpsRuntimeStatus>()
      .notNull()
      .default('active'),
    lastHeartbeatAt: timestamp('last_heartbeat_at', tz),
    lastSuccessAt: timestamp('last_success_at', tz),
    nextWakeAt: timestamp('next_wake_at', tz),
    reportedVersion: text('reported_version'),
    stalledAfterSeconds: integer('stalled_after_seconds')
      .notNull()
      .default(900),
    maxConcurrency: integer('max_concurrency').notNull().default(1),
    revokedAt: timestamp('revoked_at', tz),
  },
  (t) => [
    unique('ops_runtimes_owner_scope_key').on(t.id, t.ownerId),
    uniqueIndex('ops_runtimes_grant_key').on(t.grantId),
    check('ops_runtimes_kind_check', oneOf(t.kind, GRANT_ACTOR_TYPES)),
    check('ops_runtimes_status_check', oneOf(t.status, OPS_RUNTIME_STATUSES)),
    check(
      'ops_runtimes_delivery_check',
      sql`(${t.deliveryUrl} is null) = (${t.sealedDeliverySecret} is null)`,
    ),
    check(
      'ops_runtimes_numbers_check',
      sql`${t.stalledAfterSeconds} >= 60 and ${t.maxConcurrency} >= 1`,
    ),
    check(
      'ops_runtimes_revoked_check',
      sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`,
    ),
  ],
)

/** One event to one runtime: attempts, backoff, and whether it was taken. */
export const opsEventDeliveries = pgTable(
  'ops_event_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    eventId: uuid('event_id').notNull(),
    runtimeId: uuid('runtime_id').notNull(),
    status: text('status').$type<OpsEventStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    nextAttemptAt: timestamp('next_attempt_at', tz).notNull().defaultNow(),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', tz),
    acknowledgedAt: timestamp('acknowledged_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'ops_event_deliveries_event_fk',
      columns: [t.eventId, t.ownerId],
      foreignColumns: [opsOutboxEvents.id, opsOutboxEvents.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ops_event_deliveries_runtime_fk',
      columns: [t.runtimeId, t.ownerId],
      foreignColumns: [opsRuntimes.id, opsRuntimes.ownerId],
    }).onDelete('restrict'),
    uniqueIndex('ops_event_deliveries_key').on(t.eventId, t.runtimeId),
    index('ops_event_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    check(
      'ops_event_deliveries_status_check',
      oneOf(t.status, OPS_EVENT_STATUSES),
    ),
    check(
      'ops_event_deliveries_attempts_check',
      sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1`,
    ),
  ],
)

/**
 * An authenticated event that arrived from a runtime or provider. Its ID is
 * unique per source, which is what makes a duplicate webhook a no-op. An
 * event that can't be tied to an owner is refused before it is stored.
 */
export const opsInboundEvents = pgTable(
  'ops_inbound_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    source: text('source').notNull(),
    externalEventId: text('external_event_id').notNull(),
    projectId: uuid('project_id'),
    eventType: text('event_type').notNull(),
    payloadHash: text('payload_hash').notNull(),
    status: text('status').$type<OpsInboundStatus>().notNull(),
    reason: text('reason'),
    taskId: uuid('task_id'),
    receivedAt: timestamp('received_at', tz).notNull().defaultNow(),
  },
  (t) => [
    inOwnProject('ops_inbound_events_project_fk', t),
    uniqueIndex('ops_inbound_events_key').on(t.source, t.externalEventId),
    check(
      'ops_inbound_events_status_check',
      oneOf(t.status, OPS_INBOUND_STATUSES),
    ),
  ],
)

/**
 * Who is running a singleton background pass (the ops tick) right now. A row
 * lease rather than an advisory lock: HQ runs behind a pooled connection,
 * where a session lock taken on one checkout and released on another is never
 * released at all. It holds no owner's data — only which process runs the
 * pass — so it is the one `ops_*` table without `owner_id`.
 */
export const opsSchedulerLeases = pgTable(
  'ops_scheduler_leases',
  {
    name: text('name').primaryKey(),
    holder: uuid('holder').notNull(),
    acquiredAt: timestamp('acquired_at', tz).notNull(),
    expiresAt: timestamp('expires_at', tz).notNull(),
  },
  (t) => [
    check(
      'ops_scheduler_leases_expiry_check',
      sql`${t.expiresAt} > ${t.acquiredAt}`,
    ),
  ],
)

/**
 * Permission to let one exact thing leave HQ — a post, a listing — bound to
 * the hash of what will be sent. A human release names who approved it; a
 * policy release names the policy revision. Only its state may move (active →
 * consumed / revoked / expired), and never back (a trigger in the migration).
 * The subject is owned by the module that asked (`publish`, `market`), which
 * checks it; this table holds no key into that module.
 */
export const opsReleaseAuthorizations = pgTable(
  'ops_release_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    projectId: uuid('project_id'),
    module: text('module').$type<ModuleId>().notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    assetId: uuid('asset_id'),
    assetSha256: text('asset_sha256'),
    /** The platform account or marketplace it may go to. */
    targetRef: text('target_ref'),
    mode: text('mode').$type<OpsAuthorizationMode>().notNull(),
    policyId: uuid('policy_id'),
    approvedBy: uuid('approved_by').references(userRef, {
      onDelete: 'restrict',
    }),
    qualityCheckIds: jsonb('quality_check_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text('status')
      .$type<OpsAuthorizationStatus>()
      .notNull()
      .default('active'),
    expiresAt: timestamp('expires_at', tz).notNull(),
    consumedAt: timestamp('consumed_at', tz),
    revokedAt: timestamp('revoked_at', tz),
    statusReason: text('status_reason'),
    ...opsActor(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
  },
  (t) => [
    unique('ops_release_authorizations_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('ops_release_authorizations_project_fk', t),
    foreignKey({
      name: 'ops_release_authorizations_policy_fk',
      columns: [t.policyId, t.ownerId],
      foreignColumns: [opsPolicies.id, opsPolicies.ownerId],
    }).onDelete('restrict'),
    index('ops_release_authorizations_subject_idx').on(
      t.subjectType,
      t.subjectId,
      t.status,
    ),
    check(
      'ops_release_authorizations_module_check',
      oneOf(t.module, MODULE_IDS),
    ),
    check(
      'ops_release_authorizations_mode_check',
      oneOf(t.mode, OPS_AUTHORIZATION_MODES),
    ),
    check(
      'ops_release_authorizations_status_check',
      oneOf(t.status, OPS_AUTHORIZATION_STATUSES),
    ),
    // A human release names who approved; a policy release names the policy.
    check(
      'ops_release_authorizations_basis_check',
      sql`case ${t.mode}
        when 'human_approval' then ${t.approvedBy} is not null
        else ${t.policyId} is not null and ${t.approvedBy} is null
      end`,
    ),
    check(
      'ops_release_authorizations_asset_check',
      sql`(${t.assetId} is null) = (${t.assetSha256} is null)`,
    ),
    check(
      'ops_release_authorizations_state_check',
      sql`(${t.status} = 'consumed') = (${t.consumedAt} is not null) and (${t.status} = 'revoked') = (${t.revokedAt} is not null)`,
    ),
    opsActorCheck('ops_release_authorizations_actor_check', t.actorType),
  ],
)

/**
 * Append-only: what a provider or account can do, and how we know —
 * documented, tested for real, or known unavailable — with an expiry so a
 * stale "yes" stops counting.
 */
export const opsCapabilityChecks = pgTable(
  'ops_capability_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    projectId: uuid('project_id'),
    provider: text('provider').notNull(),
    connectionId: uuid('connection_id'),
    /** The platform account or marketplace checked, when it is one. */
    targetRef: text('target_ref'),
    capability: text('capability').notNull(),
    state: text('state').$type<OpsCapabilityState>().notNull(),
    evidence: text('evidence').notNull(),
    checkedAt: timestamp('checked_at', tz).notNull(),
    expiresAt: timestamp('expires_at', tz),
    ...opsActor(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
  },
  (t) => [
    inOwnProject('ops_capability_checks_project_fk', t),
    foreignKey({
      name: 'ops_capability_checks_connection_fk',
      columns: [t.connectionId, t.ownerId],
      foreignColumns: [providerConnections.id, providerConnections.ownerId],
    }).onDelete('restrict'),
    index('ops_capability_checks_lookup_idx').on(
      t.ownerId,
      t.provider,
      t.capability,
      t.checkedAt.desc(),
    ),
    check(
      'ops_capability_checks_state_check',
      oneOf(t.state, OPS_CAPABILITY_STATES),
    ),
    check(
      'ops_capability_checks_expiry_check',
      sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.checkedAt}`,
    ),
    opsActorCheck('ops_capability_checks_actor_check', t.actorType),
  ],
)

/**
 * Something only the owner can do or decide, asked once with the exact
 * action, the revision it is about, and when the question stops mattering.
 * Shown in `/inbox` beside agent proposals and connection problems.
 */
export const opsHumanRequests = pgTable(
  'ops_human_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerId(),
    projectId: uuid('project_id'),
    /** The module the request is about; null for kernel requests. */
    module: text('module').$type<ModuleId>(),
    kind: text('kind').$type<OpsHumanRequestKind>().notNull(),
    title: text('title').notNull(),
    reason: text('reason').notNull(),
    /** The exact action being asked for, as data. */
    requestedAction: jsonb('requested_action')
      .$type<Record<string, unknown>>()
      .notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    targetRevision: integer('target_revision'),
    impact: text('impact'),
    /** What the agent keeps doing while it waits. */
    meanwhile: text('meanwhile'),
    options: jsonb('options')
      .$type<{ key: string; label: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    urgency: text('urgency').$type<OpsUrgency>().notNull().default('digest'),
    status: text('status')
      .$type<OpsHumanRequestStatus>()
      .notNull()
      .default('open'),
    expiresAt: timestamp('expires_at', tz).notNull(),
    dedupeKey: text('dedupe_key'),
    taskId: uuid('task_id'),
    answeredAt: timestamp('answered_at', tz),
    /** When the owner was pushed about an urgent request; digest ones wait. */
    notifiedAt: timestamp('notified_at', tz),
    ...opsActor(),
  },
  (t) => [
    unique('ops_human_requests_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('ops_human_requests_project_fk', t),
    uniqueIndex('ops_human_requests_open_key')
      .on(t.ownerId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.status} = 'open'`),
    foreignKey({
      name: 'ops_human_requests_task_fk',
      columns: [t.taskId, t.ownerId],
      foreignColumns: [opsTasks.id, opsTasks.ownerId],
    }).onDelete('restrict'),
    index('ops_human_requests_open_idx').on(t.ownerId, t.status, t.expiresAt),
    check(
      'ops_human_requests_kind_check',
      oneOf(t.kind, OPS_HUMAN_REQUEST_KINDS),
    ),
    check(
      'ops_human_requests_module_check',
      nullableOneOf(t.module, MODULE_IDS),
    ),
    check(
      'ops_human_requests_status_check',
      oneOf(t.status, OPS_HUMAN_REQUEST_STATUSES),
    ),
    check('ops_human_requests_urgency_check', oneOf(t.urgency, OPS_URGENCIES)),
    check(
      'ops_human_requests_answered_check',
      sql`(${t.status} = 'answered') = (${t.answeredAt} is not null)`,
    ),
    opsActorCheck('ops_human_requests_actor_check', t.actorType),
  ],
)

/** Append-only: the owner's answer to one revision of a request. */
export const opsHumanResponses = pgTable(
  'ops_human_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerId(),
    projectId: uuid('project_id'),
    requestId: uuid('request_id').notNull(),
    requestRevision: integer('request_revision').notNull(),
    choice: text('choice').notNull(),
    note: text('note'),
    respondedBy: uuid('responded_by')
      .notNull()
      .references(userRef, { onDelete: 'restrict' }),
    respondedAt: timestamp('responded_at', tz).notNull().defaultNow(),
  },
  (t) => [
    inOwnProject('ops_human_responses_project_fk', t),
    foreignKey({
      name: 'ops_human_responses_request_fk',
      columns: [t.requestId, t.ownerId],
      foreignColumns: [opsHumanRequests.id, opsHumanRequests.ownerId],
    }).onDelete('restrict'),
    uniqueIndex('ops_human_responses_request_key').on(t.requestId),
  ],
)

export type OpsPolicyRow = typeof opsPolicies.$inferSelect
export type OpsKillSwitchRow = typeof opsKillSwitches.$inferSelect
export type OpsIdempotencyKeyRow = typeof opsIdempotencyKeys.$inferSelect
export type OpsTaskRow = typeof opsTasks.$inferSelect
export type OpsAgentRunRow = typeof opsAgentRuns.$inferSelect
export type OpsRunCheckpointRow = typeof opsRunCheckpoints.$inferSelect
export type OpsBudgetReservationRow = typeof opsBudgetReservations.$inferSelect
export type OpsUsageEventRow = typeof opsUsageEvents.$inferSelect
export type OpsAuditEventRow = typeof opsAuditEvents.$inferSelect
export type OpsOutboxEventRow = typeof opsOutboxEvents.$inferSelect
export type OpsRuntimeRow = typeof opsRuntimes.$inferSelect
export type OpsEventDeliveryRow = typeof opsEventDeliveries.$inferSelect
export type OpsInboundEventRow = typeof opsInboundEvents.$inferSelect
export type OpsSchedulerLeaseRow = typeof opsSchedulerLeases.$inferSelect
export type OpsReleaseAuthorizationRow =
  typeof opsReleaseAuthorizations.$inferSelect
export type OpsCapabilityCheckRow = typeof opsCapabilityChecks.$inferSelect
export type OpsHumanRequestRow = typeof opsHumanRequests.$inferSelect
export type OpsHumanResponseRow = typeof opsHumanResponses.$inferSelect
