import { sql } from 'drizzle-orm'
import {
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
  EXP_LEARNING_STATUSES,
  EXP_STATUSES,
  EXP_SUBJECT_TYPES,
  EXP_VERDICTS,
  type ExpLearningStatus,
  type ExpStatus,
  type ExpSubjectType,
  type ExpVerdict,
  OPS_ACTOR_TYPES,
  type OpsActorType,
} from '../enums'
import { inOwnProject, ownerColumn, trimmedLength } from './_module'
import { oneOf, tz } from './_shared'
import { tracked } from './_user'

/* ── experiments — one question, asked once ─────────────
 *
 * · **An experiment asks one question** about posts or listings, on one
 *   metric, read at one age (`read_at_hours` after each item went out) so
 *   items are compared like with like. While it is a `draft` its design can
 *   change; once `running`, the question, metric, age and variants are
 *   frozen (the service refuses; nothing leaves a design silently).
 * · **Items are posts or listings** put under a variant. They belong to other
 *   modules, so an item holds the subject's type and ID — the same
 *   polymorphic pointer `refs` uses — and the subject links back with
 *   `post —attached→ experiment` in `refs`.
 * · **Decisions are append-only**, each with the readings it was made on;
 *   a later decision supersedes by being later. **Learnings** are what the
 *   owner (or an agent, as a draft) takes away, searchable across projects.
 */

export const expExperiments = pgTable(
  'exp_experiments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id').notNull(),
    question: text('question').notNull(),
    hypothesis: text('hypothesis').notNull().default(''),
    subjectType: text('subject_type').$type<ExpSubjectType>().notNull(),
    /** The reading it is decided on — `views`, `earnings`, `sales` … */
    metric: text('metric').notNull(),
    /** Read every item this many hours after it went out. */
    readAtHours: integer('read_at_hours').notNull().default(72),
    status: text('status').$type<ExpStatus>().notNull().default('draft'),
    /** Limits the owner set: `{ maxItemsPerVariant?: number }`. */
    limits: jsonb('limits')
      .$type<{ maxItemsPerVariant?: number }>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    startedAt: timestamp('started_at', tz),
    decidedAt: timestamp('decided_at', tz),
    archivedAt: timestamp('archived_at', tz),
  },
  (t) => [
    unique('exp_experiments_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('exp_experiments_project_fk', t),
    index('exp_experiments_owner_idx').on(t.ownerId, t.projectId, t.status),
    check('exp_experiments_status_check', oneOf(t.status, EXP_STATUSES)),
    check(
      'exp_experiments_subject_check',
      oneOf(t.subjectType, EXP_SUBJECT_TYPES),
    ),
    check('exp_experiments_question_check', trimmedLength(t.question, 400)),
    check(
      'exp_experiments_hypothesis_check',
      sql`length(${t.hypothesis}) <= 4000`,
    ),
    check(
      'exp_experiments_metric_check',
      sql`${t.metric} ~ '^[a-z][a-z0-9_]{0,39}$'`,
    ),
    check(
      'exp_experiments_age_check',
      sql`${t.readAtHours} between 1 and 8760`,
    ),
    check(
      'exp_experiments_started_check',
      sql`${t.status} = 'draft' or ${t.startedAt} is not null`,
    ),
    check(
      'exp_experiments_decided_check',
      sql`${t.status} <> 'decided' or ${t.decidedAt} is not null`,
    ),
    check(
      'exp_experiments_archived_check',
      sql`(${t.status} = 'archived') = (${t.archivedAt} is not null)`,
    ),
  ],
)

export const expVariants = pgTable(
  'exp_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    experimentId: uuid('experiment_id').notNull(),
    /** `A`, `B`, `hook-first` … */
    label: text('label').notNull(),
    description: text('description').notNull().default(''),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('exp_variants_experiment_scope_key').on(t.id, t.experimentId),
    foreignKey({
      name: 'exp_variants_experiment_fk',
      columns: [t.experimentId, t.ownerId],
      foreignColumns: [expExperiments.id, expExperiments.ownerId],
    }).onDelete('cascade'),
    uniqueIndex('exp_variants_label_key').on(
      t.experimentId,
      sql`lower(${t.label})`,
    ),
    check('exp_variants_label_check', trimmedLength(t.label, 40)),
    check(
      'exp_variants_description_check',
      sql`length(${t.description}) <= 2000`,
    ),
  ],
)

export const expItems = pgTable(
  'exp_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    experimentId: uuid('experiment_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    subjectType: text('subject_type').$type<ExpSubjectType>().notNull(),
    /** A post or a listing of the same owner (checked by the service). */
    subjectId: uuid('subject_id').notNull(),
    actorType: text('actor_type').$type<OpsActorType>().notNull(),
    actorId: text('actor_id').notNull(),
    addedAt: timestamp('added_at', tz).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'exp_items_experiment_fk',
      columns: [t.experimentId, t.ownerId],
      foreignColumns: [expExperiments.id, expExperiments.ownerId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'exp_items_variant_fk',
      columns: [t.variantId, t.experimentId],
      foreignColumns: [expVariants.id, expVariants.experimentId],
    }).onDelete('restrict'),
    uniqueIndex('exp_items_subject_key').on(
      t.experimentId,
      t.subjectType,
      t.subjectId,
    ),
    index('exp_items_subject_idx').on(t.ownerId, t.subjectType, t.subjectId),
    check(
      'exp_items_subject_type_check',
      oneOf(t.subjectType, EXP_SUBJECT_TYPES),
    ),
    check('exp_items_actor_check', oneOf(t.actorType, OPS_ACTOR_TYPES)),
  ],
)

/** Append-only: every verdict, with the readings it was made on. */
export const expDecisions = pgTable(
  'exp_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    experimentId: uuid('experiment_id').notNull(),
    verdict: text('verdict').$type<ExpVerdict>().notNull(),
    winnerVariantId: uuid('winner_variant_id'),
    rationale: text('rationale').notNull(),
    /** Each variant's items and their readings at the read age, as decided on. */
    snapshot: jsonb('snapshot')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    actorType: text('actor_type').$type<OpsActorType>().notNull(),
    actorId: text('actor_id').notNull(),
    decidedAt: timestamp('decided_at', tz).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'exp_decisions_experiment_fk',
      columns: [t.experimentId, t.ownerId],
      foreignColumns: [expExperiments.id, expExperiments.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'exp_decisions_winner_fk',
      columns: [t.winnerVariantId, t.experimentId],
      foreignColumns: [expVariants.id, expVariants.experimentId],
    }).onDelete('restrict'),
    index('exp_decisions_experiment_idx').on(t.experimentId, t.decidedAt),
    check('exp_decisions_verdict_check', oneOf(t.verdict, EXP_VERDICTS)),
    check(
      'exp_decisions_winner_check',
      sql`(${t.verdict} = 'winner') = (${t.winnerVariantId} is not null)`,
    ),
    check('exp_decisions_rationale_check', trimmedLength(t.rationale, 4000)),
    check('exp_decisions_actor_check', oneOf(t.actorType, OPS_ACTOR_TYPES)),
  ],
)

export const expLearnings = pgTable(
  'exp_learnings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    /** Null for a learning about everything the owner makes. */
    projectId: uuid('project_id'),
    experimentId: uuid('experiment_id'),
    statement: text('statement').notNull(),
    evidence: text('evidence').notNull().default(''),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    status: text('status')
      .$type<ExpLearningStatus>()
      .notNull()
      .default('active'),
    retiredAt: timestamp('retired_at', tz),
  },
  (t) => [
    unique('exp_learnings_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('exp_learnings_project_fk', t),
    foreignKey({
      name: 'exp_learnings_experiment_fk',
      columns: [t.experimentId, t.ownerId],
      foreignColumns: [expExperiments.id, expExperiments.ownerId],
    }).onDelete('restrict'),
    index('exp_learnings_owner_idx').on(t.ownerId, t.projectId, t.status),
    index('exp_learnings_tags_idx').using('gin', t.tags),
    check('exp_learnings_status_check', oneOf(t.status, EXP_LEARNING_STATUSES)),
    check('exp_learnings_statement_check', trimmedLength(t.statement, 1000)),
    check('exp_learnings_evidence_check', sql`length(${t.evidence}) <= 4000`),
    check('exp_learnings_tags_check', sql`cardinality(${t.tags}) <= 12`),
    check(
      'exp_learnings_retired_check',
      sql`(${t.status} = 'retired') = (${t.retiredAt} is not null)`,
    ),
  ],
)

export type ExpExperimentRow = typeof expExperiments.$inferSelect
export type ExpVariantRow = typeof expVariants.$inferSelect
export type ExpItemRow = typeof expItems.$inferSelect
export type ExpDecisionRow = typeof expDecisions.$inferSelect
export type ExpLearningRow = typeof expLearnings.$inferSelect
