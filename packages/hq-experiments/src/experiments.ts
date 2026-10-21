import { fromMinor, toMinor } from '@theiceji/hq-core/money'
import {
  type AgeReading,
  type SubjectSummary,
  subjectProvider,
} from '@theiceji/hq-core/readings'
import { link, refsOf } from '@theiceji/hq-core/refs'
import { everyWord } from '@theiceji/hq-core/search'
import {
  EXP_STATUSES,
  EXP_SUBJECT_TYPES,
  EXP_VERDICTS,
  type ExpStatus,
} from '@theiceji/hq-db/enums'
import {
  type ExpDecisionRow,
  type ExpExperimentRow,
  type ExpItemRow,
  type ExpLearningRow,
  type ExpVariantRow,
  expDecisions,
  expExperiments,
  expItems,
  expLearnings,
  expVariants,
  type ProjectRow,
  projects,
  type RefRow,
  refs,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan } from '@theiceji/hq-ops/access'
import { dbNow, type Reader, type Tx } from '@theiceji/hq-ops/db'
import {
  conflict,
  invalid,
  notFound,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  choice,
  idempotencyKey,
  optionalRecordId,
  parseInput,
  recordId,
  revision,
  stringList,
  text,
} from '@theiceji/hq-ops/schemas'
import {
  assertModuleOn,
  audit,
  auditTrail,
  authorize,
  ownedProject,
  ownedRow,
  returned,
  runOperation,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  inArray,
  or,
  sql,
} from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { z } from 'zod'

/**
 * Experiments (ported from Creator's): one question, asked
 * once, answered from readings taken at the same age.
 *
 * · **A draft can change; a running experiment can't.** Once it starts, its
 *   question, metric, read age, subject type and variants are frozen — a
 *   different design is a different experiment. Items can be added while it
 *   runs.
 * · **Items are posts or listings**, found through the hq-core subject
 *   registry; Experiments never reads Publish's or Market's tables. An item
 *   links back in `refs` (`post —attached→ experiment`).
 * · **Comparable or not counted.** Each item is read at the experiment's age
 *   after it went out; younger items are `too young`, items with nothing read
 *   near that age are `not read`, and neither is a low number. A variant's
 *   middle value is one that was really observed (the lower middle when the
 *   count is even), never an average.
 * · **Deciding is a decision** (`ops:decide` for an agent, under the owner's
 *   policy). Every verdict is kept, with the readings it was made on.
 */

registerConstraintMessages({
  exp_variants_label_key: 'Two variants can’t share a label.',
  exp_items_subject_key: 'That item is already in this experiment.',
  exp_decisions_winner_check: 'A winner verdict names the winning variant.',
  // `MOVES` lists draft → archived, but an archived experiment must have
  // started, so the database refuses it; a draft is deleted instead.
  exp_experiments_started_check:
    'A draft that never started isn’t archived; the owner can delete it in HQ.',
})

/* ── Shapes ─────────────────────────────────────────────────────────── */

export type ItemRead = ExpItemRow & {
  subject: SubjectSummary | null
  reading: AgeReading
}

export type VariantRead = ExpVariantRow & {
  items: ItemRead[]
  /** Items with a known reading at the age. */
  covered: number
  tooYoung: number
  notRead: number
  /** An observed value, never an average; the lower middle for an even count. */
  median: string | null
  medianIsLower: boolean
  min: string | null
  max: string | null
  currency: string | null
}

export type ExperimentRead = {
  experiment: ExpExperimentRow
  project: ProjectRow
  variants: VariantRead[]
  /** The variant whose middle value is highest, in words — never a decision. */
  leader: { variantId: string; label: string; note: string } | null
  decisions: ExpDecisionRow[]
  learnings: ExpLearningRow[]
  refs: RefRow[]
  history: Awaited<ReturnType<typeof auditTrail>>
  /** When the read was taken, by the database's clock. */
  readAt: Date
}

export type ExperimentListItem = ExpExperimentRow & {
  project: Pick<ProjectRow, 'id' | 'slug' | 'name' | 'color' | 'status'>
  variants: Pick<ExpVariantRow, 'id' | 'label'>[]
  items: number
  lastDecision: Pick<ExpDecisionRow, 'verdict' | 'decidedAt'> | null
}

const METRIC = /^[a-z][a-z0-9_]{0,39}$/

/* ── Reading ────────────────────────────────────────────────────────── */

export async function listExperiments(
  actor: Actor,
  raw: { projectId?: string; status?: ExpStatus[] } = {},
): Promise<ExperimentListItem[]> {
  const input = parseInput(
    z.object({
      projectId: optionalRecordId('Project'),
      status: z.array(z.enum(EXP_STATUSES)).optional(),
    }),
    raw,
  )
  return withReader(async (db) => {
    if (input.projectId) {
      const project = await ownedProject(
        db,
        actor,
        input.projectId,
        'experiments',
        'read',
      )
      assertModuleOn(project, 'experiments')
    } else await authorize(db, actor, null, 'experiments', 'read')
    const rows = await db
      .select({
        experiment: expExperiments,
        project: {
          id: projects.id,
          slug: projects.slug,
          name: projects.name,
          color: projects.color,
          status: projects.status,
        },
      })
      .from(expExperiments)
      .innerJoin(projects, eq(projects.id, expExperiments.projectId))
      .where(
        and(
          eq(expExperiments.ownerId, actor.userId),
          input.projectId
            ? eq(expExperiments.projectId, input.projectId)
            : sql`${projects.status} <> 'archived'`,
          input.status?.length
            ? inArray(expExperiments.status, input.status)
            : sql`${expExperiments.status} <> 'archived'`,
        ),
      )
      .orderBy(desc(expExperiments.updatedAt))
      .limit(200)
    const ids = rows.map((row) => row.experiment.id)
    const [variants, items, decisions] = ids.length
      ? await Promise.all([
          db
            .select({
              id: expVariants.id,
              label: expVariants.label,
              experimentId: expVariants.experimentId,
            })
            .from(expVariants)
            .where(inArray(expVariants.experimentId, ids))
            .orderBy(asc(expVariants.position)),
          db
            .select({
              experimentId: expItems.experimentId,
              n: sql<number>`count(*)::int`,
            })
            .from(expItems)
            .where(inArray(expItems.experimentId, ids))
            .groupBy(expItems.experimentId),
          db
            .selectDistinctOn([expDecisions.experimentId], {
              experimentId: expDecisions.experimentId,
              verdict: expDecisions.verdict,
              decidedAt: expDecisions.decidedAt,
            })
            .from(expDecisions)
            .where(inArray(expDecisions.experimentId, ids))
            .orderBy(expDecisions.experimentId, desc(expDecisions.decidedAt)),
        ])
      : [[], [], []]
    return rows.map((row) => ({
      ...row.experiment,
      project: row.project,
      variants: variants
        .filter((variant) => variant.experimentId === row.experiment.id)
        .map(({ id, label }) => ({ id, label })),
      items:
        items.find((entry) => entry.experimentId === row.experiment.id)?.n ?? 0,
      lastDecision:
        decisions.find((entry) => entry.experimentId === row.experiment.id) ??
        null,
    }))
  })
}

/** Decimal strings compared exactly (four places is the readings' own scale). */
const scaled = (value: string) => toMinor(value, 4)

function summarize(variant: ExpVariantRow, items: ItemRead[]): VariantRead {
  const known = items
    .map((item) => item.reading)
    .filter(
      (reading): reading is Extract<AgeReading, { state: 'known' }> =>
        reading.state === 'known',
    )
    .sort((a, b) => {
      const d = scaled(a.value) - scaled(b.value)
      return d < 0n ? -1 : d > 0n ? 1 : 0
    })
  const n = known.length
  const middle = n ? known[Math.floor((n - 1) / 2)] : null
  const clean = (value: string | undefined) =>
    value === undefined
      ? null
      : fromMinor(scaled(value), 4).replace(/\.?0+$/, '') || '0'
  return {
    ...variant,
    items,
    covered: n,
    tooYoung: items.filter((item) => item.reading.state === 'too_young').length,
    notRead: items.filter((item) => item.reading.state === 'not_read').length,
    median: clean(middle?.value),
    medianIsLower: n > 0 && n % 2 === 0,
    min: clean(known[0]?.value),
    max: clean(known[n - 1]?.value),
    currency: known[0]?.currency ?? null,
  }
}

async function readOn(
  db: Reader,
  actor: Actor,
  experiment: ExpExperimentRow,
): Promise<{ variants: VariantRead[]; readAt: Date }> {
  const [variants, items, now] = await Promise.all([
    db
      .select()
      .from(expVariants)
      .where(eq(expVariants.experimentId, experiment.id))
      .orderBy(asc(expVariants.position), asc(expVariants.createdAt)),
    db
      .select()
      .from(expItems)
      .where(eq(expItems.experimentId, experiment.id))
      .orderBy(asc(expItems.addedAt)),
    dbNow(db),
  ])
  const provider = subjectProvider(experiment.subjectType)
  const ids = items.map((item) => item.subjectId)
  const [subjects, readings] = provider
    ? await Promise.all([
        provider.describe(db, actor.userId, ids),
        provider.atAge(
          db,
          actor.userId,
          ids,
          experiment.metric,
          experiment.readAtHours,
          now,
        ),
      ])
    : [[], new Map<string, AgeReading>()]
  return {
    readAt: now,
    variants: variants.map((variant) =>
      summarize(
        variant,
        items
          .filter((item) => item.variantId === variant.id)
          .map((item) => ({
            ...item,
            subject:
              subjects.find((subject) => subject.id === item.subjectId) ?? null,
            reading: readings.get(item.subjectId) ?? { state: 'not_read' },
          })),
      ),
    ),
  }
}

function leaderOf(variants: VariantRead[]): ExperimentRead['leader'] {
  const ranked = variants
    .filter((variant) => variant.median !== null)
    .sort((a, b) => {
      const d = scaled(b.median as string) - scaled(a.median as string)
      return d < 0n ? -1 : d > 0n ? 1 : 0
    })
  if (ranked.length < 2) return null
  const [first, second] = ranked
  if (
    !first ||
    !second ||
    scaled(first.median as string) === scaled(second.median as string)
  )
    return null
  const thin = ranked.some((variant) => variant.covered < 3)
  return {
    variantId: first.id,
    label: first.label,
    note: thin
      ? `${first.label} leads on the middle value, from fewer than 3 items per variant — anecdote, not evidence.`
      : `${first.label} leads on the middle value.`,
  }
}

/** One experiment, read at its age now, with its decisions and learnings. */
export async function readExperiment(
  actor: Actor,
  experimentId: string,
): Promise<ExperimentRead> {
  return withReader(async (db) => {
    assertCan(actor, 'experiments', 'read')
    const { row: experiment, project } = await ownedRow<ExpExperimentRow>(
      db,
      actor,
      expExperiments,
      experimentId,
      'Experiment',
    )
    if (!project) throw notFound('Experiment')
    await authorize(db, actor, project, 'experiments', 'read')
    const [{ variants, readAt }, decisions, learnings, links, history] =
      await Promise.all([
        readOn(db, actor, experiment),
        db
          .select()
          .from(expDecisions)
          .where(eq(expDecisions.experimentId, experiment.id))
          .orderBy(desc(expDecisions.decidedAt)),
        db
          .select()
          .from(expLearnings)
          .where(
            and(
              eq(expLearnings.ownerId, actor.userId),
              eq(expLearnings.experimentId, experiment.id),
            ),
          )
          .orderBy(desc(expLearnings.createdAt)),
        refsOf(db, actor.userId, { type: 'experiment', id: experiment.id }),
        auditTrail(db, actor.userId, [experiment.id], 30),
      ])
    return {
      experiment,
      project,
      variants,
      leader: leaderOf(variants),
      decisions,
      learnings,
      refs: links,
      history,
      readAt,
    }
  })
}

/* ── Writing ────────────────────────────────────────────────────────── */

const variantInput = z.object({
  label: text.required('Variant label', 40),
  description: text.optional('Variant description', 2000),
})

const createSchema = z.object({
  projectId: recordId('Project'),
  question: text.required('Question', 400),
  hypothesis: text.optional('Hypothesis', 4000),
  subjectType: choice(EXP_SUBJECT_TYPES, 'Compare posts or listings.'),
  metric: z
    .string({ error: 'Name the metric it is decided on.' })
    .trim()
    .toLowerCase()
    .regex(METRIC, 'A metric is a lowercase name like views or sales.'),
  readAtHours: z.number().int().min(1).max(8760).optional(),
  variants: z.array(variantInput).max(8, 'At most 8 variants.').optional(),
  maxItemsPerVariant: z.number().int().min(1).max(500).optional(),
  idempotencyKey: idempotencyKey.optional(),
})

export type CreateExperimentInput = z.input<typeof createSchema>

async function writeVariants(
  tx: Tx,
  actor: Actor,
  experimentId: string,
  variants: { label: string; description?: string | null }[],
): Promise<void> {
  const labels = variants.map((variant) => variant.label.toLowerCase())
  if (new Set(labels).size !== labels.length)
    throw invalid('Two variants can’t share a label.')
  if (variants.length === 0) return
  await tx.insert(expVariants).values(
    variants.map((variant, position) => ({
      ownerId: actor.userId,
      experimentId,
      label: variant.label,
      description: variant.description ?? '',
      position,
    })),
  )
}

/**
 * A draft experiment inside the caller's transaction — for the `experiment`
 * target (an agent's accepted proposal). The caller has checked the project.
 */
export async function insertExperiment(
  tx: Tx,
  actor: Actor,
  project: ProjectRow,
  raw: Omit<CreateExperimentInput, 'projectId' | 'idempotencyKey'>,
): Promise<ExpExperimentRow> {
  const input = parseInput(createSchema, { ...raw, projectId: project.id })
  assertModuleOn(project, 'experiments')
  const [row] = await tx
    .insert(expExperiments)
    .values({
      ownerId: actor.userId,
      createdBy: actor.userId,
      projectId: project.id,
      question: input.question as string,
      hypothesis: input.hypothesis ?? '',
      subjectType: input.subjectType,
      metric: input.metric,
      readAtHours: input.readAtHours ?? 72,
      limits: input.maxItemsPerVariant
        ? { maxItemsPerVariant: input.maxItemsPerVariant }
        : {},
    })
    .returning()
  const experiment = returned(row)
  await writeVariants(
    tx,
    actor,
    experiment.id,
    (input.variants ?? [{ label: 'A' }, { label: 'B' }]).map((variant) => ({
      label: variant.label as string,
      description: variant.description,
    })),
  )
  await audit(tx, actor, {
    projectId: project.id,
    action: 'experiments.create',
    targetType: 'experiment',
    targetId: experiment.id,
    afterRevision: experiment.revision,
    changes: {
      question: experiment.question,
      metric: experiment.metric,
      readAtHours: experiment.readAtHours,
    },
  })
  return experiment
}

/** A new draft experiment. Drafting. */
export async function createExperiment(
  actor: Actor,
  raw: CreateExperimentInput,
): Promise<ExpExperimentRow> {
  const input = parseInput(createSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'experiments_create',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const project = await ownedProject(
          tx,
          actor,
          input.projectId,
          'experiments',
          'write',
        )
        return insertExperiment(tx, actor, project, input)
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.experiment_id
    if (typeof id !== 'string') throw conflict()
    return (await readExperiment(actor, id)).experiment
  }
  await outcome.complete({ experiment_id: outcome.value.id })
  return outcome.value
}

async function experimentForWrite(
  tx: Tx,
  actor: Actor,
  experimentId: string,
  expectedRevision: number | undefined,
  capability: 'write' | 'decide' = 'write',
): Promise<{ experiment: ExpExperimentRow; project: ProjectRow }> {
  assertCan(actor, 'experiments', capability)
  const { row: experiment, project } = await ownedRow<ExpExperimentRow>(
    tx,
    actor,
    expExperiments,
    experimentId,
    'Experiment',
    { lock: true },
  )
  if (!project) throw notFound('Experiment')
  await authorize(tx, actor, project, 'experiments', capability)
  assertModuleOn(project, 'experiments')
  if (expectedRevision && experiment.revision !== expectedRevision)
    throw conflict()
  return { experiment, project }
}

async function saveExperiment(
  tx: Tx,
  experiment: ExpExperimentRow,
  patch: PgUpdateSetSource<typeof expExperiments>,
): Promise<ExpExperimentRow> {
  const [row] = await tx
    .update(expExperiments)
    .set({
      ...patch,
      revision: sql`${expExperiments.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(expExperiments.id, experiment.id),
        eq(expExperiments.revision, experiment.revision),
      ),
    )
    .returning()
  if (!row) throw conflict()
  return row
}

const updateSchema = z.object({
  experimentId: recordId('Experiment'),
  expectedRevision: revision,
  question: text.required('Question', 400).optional(),
  hypothesis: text.optional('Hypothesis', 4000),
  metric: z
    .string()
    .trim()
    .toLowerCase()
    .regex(METRIC, 'A metric is a lowercase name like views or sales.')
    .optional(),
  readAtHours: z.number().int().min(1).max(8760).optional(),
  variants: z.array(variantInput).max(8).optional(),
  maxItemsPerVariant: z.number().int().min(1).max(500).nullable().optional(),
  idempotencyKey: idempotencyKey.optional(),
})

/**
 * Change a draft's design. Once it runs, only the hypothesis and the item
 * limit can change — everything that decides what is compared is frozen.
 */
export async function updateExperiment(
  actor: Actor,
  raw: z.input<typeof updateSchema>,
): Promise<ExpExperimentRow> {
  const input = parseInput(updateSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'experiments_update',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { experiment, project } = await experimentForWrite(
          tx,
          actor,
          input.experimentId,
          input.expectedRevision,
        )
        if (experiment.status === 'decided' || experiment.status === 'archived')
          throw invalid(`This experiment is ${experiment.status}.`)
        const frozen =
          experiment.status !== 'draft' &&
          (input.question !== undefined ||
            input.metric !== undefined ||
            input.readAtHours !== undefined ||
            input.variants !== undefined)
        if (frozen)
          throw invalid(
            'The design is frozen once it runs — the question, metric, read age and variants stay. Start a new experiment for a new design.',
          )
        const patch: Partial<typeof expExperiments.$inferInsert> = {}
        if (input.question !== undefined)
          patch.question = input.question as string
        if (input.hypothesis !== undefined)
          patch.hypothesis = input.hypothesis ?? ''
        if (input.metric !== undefined) patch.metric = input.metric
        if (input.readAtHours !== undefined)
          patch.readAtHours = input.readAtHours
        if (input.maxItemsPerVariant !== undefined)
          patch.limits = input.maxItemsPerVariant
            ? { maxItemsPerVariant: input.maxItemsPerVariant }
            : {}
        if (input.variants !== undefined) {
          const [used] = await tx
            .select({ id: expItems.id })
            .from(expItems)
            .where(eq(expItems.experimentId, experiment.id))
            .limit(1)
          if (used)
            throw invalid(
              'Items already sit under these variants. Remove them before changing the variants.',
            )
          await tx
            .delete(expVariants)
            .where(eq(expVariants.experimentId, experiment.id))
          await writeVariants(
            tx,
            actor,
            experiment.id,
            input.variants.map((variant) => ({
              label: variant.label as string,
              description: variant.description,
            })),
          )
        }
        const changes = diffPatch(experiment, patch)
        if (Object.keys(changes).length === 0 && input.variants === undefined)
          return experiment
        const saved = await saveExperiment(tx, experiment, patch)
        await audit(tx, actor, {
          projectId: project.id,
          action: 'experiments.update',
          targetType: 'experiment',
          targetId: saved.id,
          beforeRevision: experiment.revision,
          afterRevision: saved.revision,
          changes: {
            ...changes,
            ...(input.variants
              ? { variants: input.variants.map((variant) => variant.label) }
              : {}),
          },
        })
        return saved
      }),
  )
  if (outcome.kind === 'replay')
    return (await readExperiment(actor, input.experimentId)).experiment
  await outcome.complete({ experiment_id: outcome.value.id })
  return outcome.value
}

function diffPatch(
  row: ExpExperimentRow,
  patch: Partial<typeof expExperiments.$inferInsert>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    const before = (row as unknown as Record<string, unknown>)[key]
    if (JSON.stringify(before) !== JSON.stringify(value))
      out[key] = { from: before, to: value }
  }
  return out
}

const MOVES: Record<ExpStatus, readonly ExpStatus[]> = {
  draft: ['running', 'archived'],
  running: ['reading', 'archived'],
  reading: ['running', 'archived'],
  decided: ['archived'],
  archived: [],
}

/**
 * Move an experiment along: start it (at least two variants), stop adding
 * items and wait to read, go back to collecting, or archive it. Deciding is
 * `recordDecision`.
 */
export async function transitionExperiment(
  actor: Actor,
  raw: {
    experimentId: string
    expectedRevision: number
    to: 'running' | 'reading' | 'archived'
  },
): Promise<ExpExperimentRow> {
  const input = parseInput(
    z.object({
      experimentId: recordId('Experiment'),
      expectedRevision: revision,
      to: z.enum(['running', 'reading', 'archived']),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { experiment, project } = await experimentForWrite(
      tx,
      actor,
      input.experimentId,
      input.expectedRevision,
    )
    if (!MOVES[experiment.status].includes(input.to))
      throw invalid(
        `A ${experiment.status} experiment can’t become ${input.to}.`,
      )
    if (input.to === 'running' && experiment.status === 'draft') {
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(expVariants)
        .where(eq(expVariants.experimentId, experiment.id))
      if ((count?.n ?? 0) < 2)
        throw invalid('An experiment compares at least two variants.')
    }
    const saved = await saveExperiment(tx, experiment, {
      status: input.to,
      startedAt:
        input.to === 'running' && !experiment.startedAt
          ? sql`now()`
          : experiment.startedAt,
      archivedAt: input.to === 'archived' ? sql`now()` : null,
    })
    await audit(tx, actor, {
      projectId: project.id,
      action: `experiments.${input.to}`,
      targetType: 'experiment',
      targetId: saved.id,
      beforeRevision: experiment.revision,
      afterRevision: saved.revision,
      changes: { from: experiment.status, to: saved.status },
    })
    return saved
  })
}

/**
 * Why an experiment can't be deleted, in words — or null when it can. Only
 * a draft goes: once it starts it has read items and may have decisions, and
 * that is history, archived rather than removed.
 */
export function deleteBlocker(
  experiment: Pick<ExpExperimentRow, 'status' | 'startedAt'>,
): string | null {
  if (experiment.status === 'draft' && !experiment.startedAt) return null
  return experiment.status === 'archived'
    ? 'It ran, so it stays as a record.'
    : 'It has started, so it stays as a record — archive it instead.'
}

/**
 * Delete a draft — it never started — with its variants, any items put
 * under them and their links. A learning recorded on it stays, no longer
 * pointing at it. The owner's. It can't come back, so the page asks first;
 * anything that started is archived instead (`deleteBlocker` says why).
 */
export async function deleteExperiment(
  actor: Actor,
  raw: { experimentId: string; expectedRevision?: number },
): Promise<void> {
  const input = parseInput(
    z.object({
      experimentId: recordId('Experiment'),
      expectedRevision: revision.optional(),
    }),
    raw,
  )
  await withTransaction(async (tx) => {
    assertCan(actor, 'experiments', 'write')
    const { row: experiment, project } = await ownedRow<ExpExperimentRow>(
      tx,
      actor,
      expExperiments,
      input.experimentId,
      'Experiment',
      { lock: true },
    )
    if (!project) throw notFound('Experiment')
    await authorize(tx, actor, project, 'experiments', 'write', 'owner_only')
    if (
      input.expectedRevision &&
      experiment.revision !== input.expectedRevision
    )
      throw conflict()
    const blocker = deleteBlocker(experiment)
    if (blocker) throw invalid(blocker)
    const items = await tx
      .delete(expItems)
      .where(eq(expItems.experimentId, experiment.id))
      .returning({ id: expItems.id })
    const kept = await tx
      .update(expLearnings)
      .set({
        experimentId: null,
        revision: sql`${expLearnings.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(expLearnings.experimentId, experiment.id))
      .returning({ id: expLearnings.id })
    await tx
      .delete(refs)
      .where(
        and(
          eq(refs.ownerId, actor.userId),
          or(
            and(
              eq(refs.fromType, 'experiment'),
              eq(refs.fromId, experiment.id),
            ),
            and(eq(refs.toType, 'experiment'), eq(refs.toId, experiment.id)),
          ),
        ),
      )
    // Its variants go with it (`exp_variants_experiment_fk` cascades). A
    // draft has no decisions — deciding needs a start — and
    // `exp_decisions_experiment_fk` restricts, so an append-only decision is
    // never taken with it.
    await tx.delete(expExperiments).where(eq(expExperiments.id, experiment.id))
    await audit(tx, actor, {
      projectId: project.id,
      action: 'experiments.delete',
      targetType: 'experiment',
      targetId: experiment.id,
      beforeRevision: experiment.revision,
      changes: {
        question: experiment.question,
        items: items.length,
        learningsKept: kept.map((row) => row.id),
      },
    })
  })
}

const itemSchema = z.object({
  experimentId: recordId('Experiment'),
  variantId: recordId('Variant'),
  subjectId: recordId('Item'),
  idempotencyKey: idempotencyKey.optional(),
})

/**
 * Put a post or listing under a variant. The subject must be the owner's, in
 * the experiment's project, and of the experiment's type.
 */
export async function addItem(
  actor: Actor,
  raw: z.input<typeof itemSchema>,
): Promise<ExpItemRow> {
  const input = parseInput(itemSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'experiments_add_item',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { experiment, project } = await experimentForWrite(
          tx,
          actor,
          input.experimentId,
          undefined,
        )
        if (experiment.status !== 'draft' && experiment.status !== 'running')
          throw invalid(
            `Items join a draft or a running experiment; this one is ${experiment.status}.`,
          )
        const [variant] = await tx
          .select()
          .from(expVariants)
          .where(
            and(
              eq(expVariants.id, input.variantId),
              eq(expVariants.experimentId, experiment.id),
            ),
          )
          .limit(1)
        if (!variant) throw notFound('Variant')
        const provider = subjectProvider(experiment.subjectType)
        if (!provider)
          throw invalid(
            `${experiment.subjectType === 'post' ? 'Publish' : 'Market'} isn’t running here, so its items can’t be read.`,
          )
        const [subject] = await provider.describe(tx, actor.userId, [
          input.subjectId,
        ])
        if (!subject)
          throw notFound(experiment.subjectType === 'post' ? 'Post' : 'Listing')
        if (subject.projectId !== project.id)
          throw invalid('That item belongs to another project.')
        const cap = experiment.limits.maxItemsPerVariant
        if (cap) {
          const [count] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(expItems)
            .where(eq(expItems.variantId, variant.id))
          if ((count?.n ?? 0) >= cap)
            throw invalid(
              `${variant.label} already holds ${cap} items, the limit.`,
            )
        }
        const [row] = await tx
          .insert(expItems)
          .values({
            ownerId: actor.userId,
            experimentId: experiment.id,
            variantId: variant.id,
            subjectType: experiment.subjectType,
            subjectId: subject.id,
            actorType: actor.type,
            actorId: actor.id,
          })
          .returning()
        const item = returned(row)
        await link(
          tx,
          actor,
          { type: experiment.subjectType, id: subject.id },
          { type: 'experiment', id: experiment.id },
          'attached',
        )
        await tx
          .update(expExperiments)
          .set({ updatedAt: sql`now()` })
          .where(eq(expExperiments.id, experiment.id))
        await audit(tx, actor, {
          projectId: project.id,
          action: 'experiments.item.add',
          targetType: 'experiment',
          targetId: experiment.id,
          changes: {
            variant: variant.label,
            subject: {
              type: subject.type,
              id: subject.id,
              title: subject.title,
            },
          },
        })
        return item
      }),
  )
  if (outcome.kind === 'replay') {
    const read = await readExperiment(actor, input.experimentId)
    const item = read.variants
      .flatMap((variant) => variant.items)
      .find((entry) => entry.subjectId === input.subjectId)
    if (!item) throw conflict()
    return item
  }
  await outcome.complete({ item_id: outcome.value.id })
  return outcome.value
}

/** Take an item out of a draft or running experiment. */
export async function removeItem(
  actor: Actor,
  raw: { experimentId: string; itemId: string },
): Promise<void> {
  const input = parseInput(
    z.object({
      experimentId: recordId('Experiment'),
      itemId: recordId('Item'),
    }),
    raw,
  )
  await withTransaction(async (tx) => {
    const { experiment, project } = await experimentForWrite(
      tx,
      actor,
      input.experimentId,
      undefined,
    )
    if (experiment.status !== 'draft' && experiment.status !== 'running')
      throw invalid('Items stay once the experiment is being read or decided.')
    const [item] = await tx
      .delete(expItems)
      .where(
        and(
          eq(expItems.id, input.itemId),
          eq(expItems.experimentId, experiment.id),
        ),
      )
      .returning()
    if (!item) throw notFound('Item')
    await tx
      .delete(refs)
      .where(
        and(
          eq(refs.ownerId, actor.userId),
          eq(refs.fromType, item.subjectType),
          eq(refs.fromId, item.subjectId),
          eq(refs.toType, 'experiment'),
          eq(refs.toId, experiment.id),
        ),
      )
    await audit(tx, actor, {
      projectId: project.id,
      action: 'experiments.item.remove',
      targetType: 'experiment',
      targetId: experiment.id,
      changes: { subject: { type: item.subjectType, id: item.subjectId } },
    })
  })
}

const decisionSchema = z.object({
  experimentId: recordId('Experiment'),
  expectedRevision: revision,
  verdict: choice(EXP_VERDICTS, 'Choose a verdict.'),
  winnerVariantId: optionalRecordId('Variant'),
  rationale: text.required('Rationale', 4000),
})

/**
 * Decide: winner, no difference, inconclusive or stopped — with the reason
 * in words and the readings at the age frozen into the decision. An agent
 * needs `ops:decide` and a policy that lets it decide.
 */
export async function recordDecision(
  actor: Actor,
  raw: z.input<typeof decisionSchema>,
): Promise<{ experiment: ExpExperimentRow; decision: ExpDecisionRow }> {
  const input = parseInput(decisionSchema, raw)
  if ((input.verdict === 'winner') !== Boolean(input.winnerVariantId))
    throw invalid(
      input.verdict === 'winner'
        ? 'Name the winning variant.'
        : 'Only a winner verdict names a variant.',
    )
  return withTransaction(async (tx) => {
    const { experiment, project } = await experimentForWrite(
      tx,
      actor,
      input.experimentId,
      input.expectedRevision,
      'decide',
    )
    if (!['running', 'reading', 'decided'].includes(experiment.status))
      throw invalid(
        experiment.status === 'draft'
          ? 'Start the experiment before deciding it.'
          : `This experiment is ${experiment.status}.`,
      )
    const { variants, readAt } = await readOn(tx, actor, experiment)
    if (
      input.winnerVariantId &&
      !variants.some((variant) => variant.id === input.winnerVariantId)
    )
      throw notFound('Variant')
    const snapshot = {
      readAt: readAt.toISOString(),
      metric: experiment.metric,
      readAtHours: experiment.readAtHours,
      variants: variants.map((variant) => ({
        id: variant.id,
        label: variant.label,
        covered: variant.covered,
        tooYoung: variant.tooYoung,
        notRead: variant.notRead,
        median: variant.median,
        medianIsLower: variant.medianIsLower,
        min: variant.min,
        max: variant.max,
        currency: variant.currency,
        items: variant.items.map((item) => ({
          subject: item.subjectId,
          reading: item.reading,
        })),
      })),
    }
    const [row] = await tx
      .insert(expDecisions)
      .values({
        ownerId: actor.userId,
        experimentId: experiment.id,
        verdict: input.verdict,
        winnerVariantId: input.winnerVariantId ?? null,
        rationale: input.rationale as string,
        snapshot,
        actorType: actor.type,
        actorId: actor.id,
      })
      .returning()
    const decision = returned(row)
    const saved = await saveExperiment(tx, experiment, {
      status: 'decided',
      decidedAt: sql`now()`,
    })
    await audit(tx, actor, {
      projectId: project.id,
      action: 'experiments.decide',
      targetType: 'experiment',
      targetId: saved.id,
      beforeRevision: experiment.revision,
      afterRevision: saved.revision,
      reason: input.rationale as string,
      changes: {
        verdict: decision.verdict,
        winner:
          variants.find((variant) => variant.id === decision.winnerVariantId)
            ?.label ?? null,
      },
    })
    return { experiment: saved, decision }
  })
}

/* ── Learnings ──────────────────────────────────────────────────────── */

const learningSchema = z.object({
  projectId: optionalRecordId('Project'),
  experimentId: optionalRecordId('Experiment'),
  statement: text.required('Learning', 1000),
  evidence: text.optional('Evidence', 4000),
  tags: stringList('tags', 12, 32).optional(),
  idempotencyKey: idempotencyKey.optional(),
})

/** What the owner — or an agent, drafting — takes away. */
export async function recordLearning(
  actor: Actor,
  raw: z.input<typeof learningSchema>,
): Promise<ExpLearningRow> {
  const input = parseInput(learningSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'experiments_record_learning',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        let project: ProjectRow | null = null
        let experimentId: string | null = null
        if (input.experimentId) {
          const found = await experimentForWrite(
            tx,
            actor,
            input.experimentId,
            undefined,
          )
          project = found.project
          experimentId = found.experiment.id
        } else if (input.projectId) {
          project = await ownedProject(
            tx,
            actor,
            input.projectId,
            'experiments',
            'write',
          )
          assertModuleOn(project, 'experiments')
        } else await authorize(tx, actor, null, 'experiments', 'write')
        const tags = [
          ...new Set((input.tags ?? []).map((tag) => tag.trim().toLowerCase())),
        ].filter(Boolean)
        const [row] = await tx
          .insert(expLearnings)
          .values({
            ownerId: actor.userId,
            createdBy: actor.userId,
            projectId: project?.id ?? null,
            experimentId,
            statement: input.statement as string,
            evidence: input.evidence ?? '',
            tags,
          })
          .returning()
        const learning = returned(row)
        await audit(tx, actor, {
          projectId: project?.id ?? null,
          action: 'experiments.learning.record',
          targetType: 'learning',
          targetId: learning.id,
          changes: { statement: learning.statement, tags },
        })
        return learning
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.learning_id
    if (typeof id !== 'string') throw conflict()
    const [row] = await searchLearnings(actor, { ids: [id] })
    if (!row) throw conflict()
    return row
  }
  await outcome.complete({ learning_id: outcome.value.id })
  return outcome.value
}

/** Retire a learning that stopped being true (it stays, marked). The owner's. */
export async function setLearningRetired(
  actor: Actor,
  raw: { learningId: string; expectedRevision: number; retired: boolean },
): Promise<ExpLearningRow> {
  const input = parseInput(
    z.object({
      learningId: recordId('Learning'),
      expectedRevision: revision,
      retired: z.boolean(),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    assertCan(actor, 'experiments', 'write')
    const { row, project } = await ownedRow<ExpLearningRow>(
      tx,
      actor,
      expLearnings,
      input.learningId,
      'Learning',
      { lock: true },
    )
    await authorize(tx, actor, project, 'experiments', 'write', 'owner_only')
    if (row.revision !== input.expectedRevision) throw conflict()
    if ((row.status === 'retired') === input.retired) return row
    const saved = returned(
      (
        await tx
          .update(expLearnings)
          .set({
            status: input.retired ? 'retired' : 'active',
            retiredAt: input.retired ? sql`now()` : null,
            revision: sql`${expLearnings.revision} + 1`,
            updatedAt: sql`now()`,
          })
          .where(eq(expLearnings.id, row.id))
          .returning()
      )[0],
    )
    await audit(tx, actor, {
      projectId: project?.id ?? null,
      action: input.retired
        ? 'experiments.learning.retire'
        : 'experiments.learning.restore',
      targetType: 'learning',
      targetId: saved.id,
      beforeRevision: row.revision,
      afterRevision: saved.revision,
    })
    return saved
  })
}

/**
 * Learnings, newest first: every word of `q` must match the statement,
 * evidence or a tag. Across all projects unless one is named; retired ones
 * only when asked.
 */
export async function searchLearnings(
  actor: Actor,
  raw: {
    q?: string
    projectId?: string
    tags?: string[]
    includeRetired?: boolean
    ids?: string[]
    limit?: number
  } = {},
): Promise<ExpLearningRow[]> {
  const input = parseInput(
    z.object({
      q: z.string().trim().max(200).optional(),
      projectId: optionalRecordId('Project'),
      tags: z.array(z.string().trim().toLowerCase().max(32)).max(12).optional(),
      includeRetired: z.boolean().optional(),
      ids: z.array(z.uuid()).max(100).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    raw,
  )
  return withReader(async (db) => {
    await authorize(db, actor, null, 'experiments', 'read')
    const words = (input.q ?? '').split(/\s+/).filter(Boolean)
    return db
      .select()
      .from(expLearnings)
      .where(
        and(
          eq(expLearnings.ownerId, actor.userId),
          input.ids?.length ? inArray(expLearnings.id, input.ids) : undefined,
          input.projectId
            ? eq(expLearnings.projectId, input.projectId)
            : undefined,
          input.includeRetired ? undefined : eq(expLearnings.status, 'active'),
          input.tags?.length
            ? arrayContains(expLearnings.tags, input.tags)
            : undefined,
          words.length
            ? everyWord(
                [expLearnings.statement, expLearnings.evidence, tagText],
                words,
              )
            : undefined,
        ),
      )
      .orderBy(desc(expLearnings.createdAt))
      .limit(input.limit ?? 50)
  })
}

/** A learning's tags as one searchable text. */
const tagText =
  sql`array_to_string(${expLearnings.tags}, ' ')` as unknown as Parameters<
    typeof everyWord
  >[0][number]

/* ── Home ───────────────────────────────────────────────────────────── */

export type ExperimentSummary = {
  projectId: string
  running: number
  reading: number
  drafts: number
}

export async function experimentSummaries(
  actor: Actor,
): Promise<ExperimentSummary[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'experiments', 'read')
    return db
      .select({
        projectId: expExperiments.projectId,
        running: sql<number>`count(*) filter (where ${expExperiments.status} = 'running')::int`,
        reading: sql<number>`count(*) filter (where ${expExperiments.status} = 'reading')::int`,
        drafts: sql<number>`count(*) filter (where ${expExperiments.status} = 'draft')::int`,
      })
      .from(expExperiments)
      .where(eq(expExperiments.ownerId, actor.userId))
      .groupBy(expExperiments.projectId)
  })
}
