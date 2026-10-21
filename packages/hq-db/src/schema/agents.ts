import { sql } from 'drizzle-orm'
import {
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
  AGENT_AUTO_ACCEPTABLE,
  AGENT_PROPOSAL_KINDS,
  AGENT_PROPOSAL_STATUSES,
  AGENT_RUNNERS,
  type AgentProposalKind,
  type AgentProposalStatus,
  type AgentRunner,
  MODULE_IDS,
  type ModuleId,
  OPS_ACTOR_TYPES,
  type OpsActorType,
} from '../enums'
import {
  inOwnProject,
  ownerColumn,
  projectOrNone,
  trimmedLength,
} from './_module'
import { oneOf, tz } from './_shared'
import { tracked, userRef } from './_user'
import { providerConnections } from './core'
import { opsAgentRuns, opsTasks } from './ops'

/* ── agents — routines and their proposals ───────────
 *
 * · **A routine is the owner's schedule for an agent**: a cron in a
 *   timezone, a playbook (markdown the agent reads), the modules it may
 *   work in, and who runs it — an outside agent over MCP, or HQ's builtin
 *   runner with an LLM key from `provider_connections`.
 * · **A run is the ops kernel's.** When a routine falls due the ops tick
 *   opens an `ops_tasks` row (kind `routine`, target `agent_routine`) and
 *   whoever claims it gets an `ops_agent_runs` row with a lease and a
 *   fencing token. Cost and tokens are that run's `ops_usage_events`. No
 *   second run table — one record of what ran.
 * · **A run's output is proposals**: a card, a prompt variant, a shot … as a
 *   payload the target registry (hq-core `targets`) validates. The owner
 *   accepts one in the Inbox and the target adapter makes the record —
 *   `refs(proposal —proposed_as→ record)`. A routine may accept a proposal
 *   itself only for notes and prompt variants; the CHECK below is the rule,
 *   not a default.
 */

export const agentRoutines = pgTable(
  'agent_routines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    /** Null: a routine across the owner's HQ, under the no-project policy. */
    projectId: uuid('project_id'),
    name: text('name').notNull(),
    /** Five-field cron (`0 9 * * *`), read in `timezone`. */
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('Asia/Bangkok'),
    /** Markdown the agent reads first — what to look at and what to propose. */
    playbook: text('playbook').notNull().default(''),
    /** Modules the run may work in. */
    modules: text('modules')
      .array()
      .$type<ModuleId[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    runner: text('runner').$type<AgentRunner>().notNull().default('mcp'),
    /** The builtin runner's LLM key (a `llm:*` provider connection). */
    llmConnectionId: uuid('llm_connection_id'),
    /** The builtin runner's turn cap per run. */
    maxTurns: integer('max_turns').notNull().default(20),
    /** Proposal kinds accepted without the owner — a subset of note, prompt_variant. */
    autoAccept: text('auto_accept')
      .array()
      .$type<AgentProposalKind[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    enabled: boolean('enabled').notNull().default(true),
    /** When the ops tick queues the next run; null while disabled. */
    nextDueAt: timestamp('next_due_at', tz),
    lastQueuedAt: timestamp('last_queued_at', tz),
    archivedAt: timestamp('archived_at', tz),
    /** In the Trash — always archived (so off and never queued) too. */
    deletedAt: timestamp('deleted_at', tz),
  },
  (t) => [
    unique('agent_routines_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('agent_routines_project_fk', t),
    foreignKey({
      name: 'agent_routines_llm_fk',
      columns: [t.llmConnectionId, t.ownerId],
      foreignColumns: [providerConnections.id, providerConnections.ownerId],
    }).onDelete('restrict'),
    uniqueIndex('agent_routines_name_key')
      .on(t.ownerId, projectOrNone(t.projectId), sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    index('agent_routines_due_idx')
      .on(t.nextDueAt)
      .where(sql`${t.enabled} and ${t.archivedAt} is null`),
    index('agent_routines_owner_idx').on(t.ownerId, t.projectId),
    check('agent_routines_name_check', trimmedLength(t.name, 120)),
    check('agent_routines_cron_check', trimmedLength(t.cron, 120)),
    check('agent_routines_timezone_check', trimmedLength(t.timezone, 64)),
    check(
      'agent_routines_playbook_check',
      sql`length(${t.playbook}) <= 50000`,
    ),
    check(
      'agent_routines_modules_check',
      sql`${t.modules} <@ ${sql.raw(`array[${MODULE_IDS.map((id) => `'${id}'`).join(', ')}]::text[]`)}`,
    ),
    check('agent_routines_runner_check', oneOf(t.runner, AGENT_RUNNERS)),
    check(
      'agent_routines_auto_accept_check',
      sql`${t.autoAccept} <@ ${sql.raw(`array[${AGENT_AUTO_ACCEPTABLE.map((id) => `'${id}'`).join(', ')}]::text[]`)}`,
    ),
    check(
      'agent_routines_max_turns_check',
      sql`${t.maxTurns} between 1 and 200`,
    ),
    check(
      'agent_routines_due_check',
      sql`${t.enabled} or ${t.nextDueAt} is null`,
    ),
    check(
      'agent_routines_deleted_check',
      sql`${t.deletedAt} is null or ${t.archivedAt} is not null`,
    ),
  ],
)

export const agentProposals = pgTable(
  'agent_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id'),
    /** The routine whose run proposed it; null for an agent proposing on its own. */
    routineId: uuid('routine_id'),
    taskId: uuid('task_id'),
    runId: uuid('run_id'),
    kind: text('kind').$type<AgentProposalKind>().notNull(),
    /** What the owner reads in the Inbox: "New hook variant for Desk tour". */
    title: text('title').notNull(),
    /** The target adapter's payload, validated when proposed and again when accepted. */
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    rationale: text('rationale').notNull().default(''),
    status: text('status')
      .$type<AgentProposalStatus>()
      .notNull()
      .default('proposed'),
    /** `{ type, id, href }` of what accepting made. */
    acceptedAs: jsonb('accepted_as').$type<{
      type: string
      id: string
      href: string
    }>(),
    decidedAt: timestamp('decided_at', tz),
    decidedBy: uuid('decided_by').references(userRef, {
      onDelete: 'restrict',
    }),
    /** The owner's reason for a rejection, or "auto-accepted by <routine>". */
    decisionNote: text('decision_note'),
    /** Parked by the owner ("hold"): still waiting, sorted last. */
    heldAt: timestamp('held_at', tz),
    /** An undecided proposal lapses; the ops tick expires it. */
    expiresAt: timestamp('expires_at', tz)
      .notNull()
      .default(sql`now() + interval '14 days'`),
    actorType: text('actor_type').$type<OpsActorType>().notNull(),
    actorId: text('actor_id').notNull(),
  },
  (t) => [
    unique('agent_proposals_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('agent_proposals_project_fk', t),
    foreignKey({
      name: 'agent_proposals_routine_fk',
      columns: [t.routineId],
      foreignColumns: [agentRoutines.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'agent_proposals_task_fk',
      columns: [t.taskId, t.ownerId],
      foreignColumns: [opsTasks.id, opsTasks.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'agent_proposals_run_fk',
      columns: [t.runId, t.ownerId],
      foreignColumns: [opsAgentRuns.id, opsAgentRuns.ownerId],
    }).onDelete('restrict'),
    index('agent_proposals_owner_idx').on(
      t.ownerId,
      t.status,
      t.createdAt.desc(),
    ),
    index('agent_proposals_routine_idx').on(t.routineId, t.createdAt.desc()),
    index('agent_proposals_run_idx').on(t.runId),
    check('agent_proposals_kind_check', oneOf(t.kind, AGENT_PROPOSAL_KINDS)),
    check(
      'agent_proposals_status_check',
      oneOf(t.status, AGENT_PROPOSAL_STATUSES),
    ),
    check('agent_proposals_title_check', trimmedLength(t.title, 200)),
    check(
      'agent_proposals_rationale_check',
      sql`length(${t.rationale}) <= 4000`,
    ),
    check(
      'agent_proposals_payload_check',
      sql`jsonb_typeof(${t.payload}) = 'object'`,
    ),
    check(
      'agent_proposals_accepted_check',
      sql`(${t.status} = 'accepted') = (${t.acceptedAs} is not null)`,
    ),
    check(
      'agent_proposals_decided_check',
      sql`(${t.status} = 'proposed') = (${t.decidedAt} is null)`,
    ),
    check('agent_proposals_actor_check', oneOf(t.actorType, OPS_ACTOR_TYPES)),
  ],
)

export type AgentRoutineRow = typeof agentRoutines.$inferSelect
export type AgentProposalRow = typeof agentProposals.$inferSelect
