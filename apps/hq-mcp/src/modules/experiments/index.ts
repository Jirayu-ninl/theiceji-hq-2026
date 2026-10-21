import { EXP_STATUSES, EXP_VERDICTS } from '@theiceji/hq-db/enums'
import type { ExpExperimentRow, ExpLearningRow } from '@theiceji/hq-db/schema'
import {
  addItem,
  createExperiment,
  type ExperimentRead,
  listExperiments,
  readExperiment,
  recordDecision,
  recordLearning,
  removeItem,
  searchLearnings,
  transitionExperiment,
  updateExperiment,
} from '@theiceji/hq-experiments/experiments'
import '@theiceji/hq-experiments/register'
import { invalid } from '@theiceji/hq-ops/errors'
import { z } from 'zod'
import { defineTool, defineWorkspace } from '../../kernel'
import {
  defined,
  expectedRevisionArg,
  idArg,
  idempotencyKeyArg,
  projectIdArg,
  READ,
  readTool,
  WRITE,
  writeTool,
} from '../support'

/**
 * `experiments` — one question, asked once: design it, put
 * posts or listings under its variants, read them at the same age, decide,
 * and keep what was learned. Deciding needs ops:decide and a policy that
 * lets you decide; otherwise the owner decides in HQ.
 */

function experimentOut(experiment: ExpExperimentRow) {
  return {
    id: experiment.id,
    project_id: experiment.projectId,
    question: experiment.question,
    hypothesis: experiment.hypothesis,
    subject_type: experiment.subjectType,
    metric: experiment.metric,
    read_at_hours: experiment.readAtHours,
    status: experiment.status,
    started_at: experiment.startedAt,
    decided_at: experiment.decidedAt,
    revision: experiment.revision,
  }
}

function readOut(read: ExperimentRead) {
  return {
    experiment: experimentOut(read.experiment),
    read_at: read.readAt,
    variants: read.variants.map((variant) => ({
      id: variant.id,
      label: variant.label,
      description: variant.description,
      covered: variant.covered,
      too_young: variant.tooYoung,
      not_read: variant.notRead,
      median: variant.median,
      median_is_lower: variant.medianIsLower,
      min: variant.min,
      max: variant.max,
      currency: variant.currency,
      items: variant.items.map((item) => ({
        id: item.id,
        subject_id: item.subjectId,
        title: item.subject?.title ?? null,
        went_out_at: item.subject?.wentOutAt ?? null,
        reading: item.reading,
      })),
    })),
    leader: read.leader,
    decisions: read.decisions.map((decision) => ({
      verdict: decision.verdict,
      winner_variant_id: decision.winnerVariantId,
      rationale: decision.rationale,
      decided_at: decision.decidedAt,
    })),
    learnings: read.learnings.map(learningOut),
  }
}

function learningOut(learning: ExpLearningRow) {
  return {
    id: learning.id,
    project_id: learning.projectId,
    experiment_id: learning.experimentId,
    statement: learning.statement,
    evidence: learning.evidence,
    tags: learning.tags,
    status: learning.status,
    created_at: learning.createdAt,
  }
}

export const listExperimentsTool = defineTool({
  name: 'list',
  title: 'List experiments',
  description:
    'Experiments of one project, or all. With experiment_id: that experiment read at its age now — each variant’s items, the observed middle value (never an average), min and max, how many are too young or not read, a leader in words (never a decision), and every decision.',
  scope: 'experiments:read',
  input: z.object({
    project_id: projectIdArg.optional(),
    experiment_id: idArg('Experiment').optional(),
    status: z.array(z.enum(EXP_STATUSES)).optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      async (actor) =>
        args.experiment_id
          ? {
              kind: 'read' as const,
              read: await readExperiment(actor, args.experiment_id),
            }
          : {
              kind: 'list' as const,
              list: await listExperiments(
                actor,
                defined({ projectId: args.project_id, status: args.status }),
              ),
            },
      (value) =>
        value.kind === 'read'
          ? {
              text: `“${value.read.experiment.question}” (${value.read.experiment.status}): ${value.read.variants.map((variant) => `${variant.label} ${variant.median ?? '—'} from ${variant.covered}`).join(' · ')}.${value.read.leader ? ` ${value.read.leader.note}` : ''}`,
              data: readOut(value.read),
            }
          : {
              text: `${value.list.length} experiment(s).`,
              data: {
                experiments: value.list.map((row) => ({
                  ...experimentOut(row),
                  variants: row.variants,
                  items: row.items,
                  last_decision: row.lastDecision,
                })),
              },
            },
    ),
})

export const saveExperimentTool = defineTool({
  name: 'save',
  title: 'Design an experiment or add items',
  description:
    'Without experiment_id: a new draft (question, what it compares — posts or listings —, the metric, the read age in hours, variants; A and B when none). With it: change a draft’s design (frozen once it runs; only hypothesis and the item limit change then), and put items under variants (add: variant_id + subject_id of a post or listing of the same project) or take them out (remove: item ids).',
  scope: 'experiments:write',
  input: z.object({
    project_id: projectIdArg.optional(),
    experiment_id: idArg('Experiment').optional(),
    expected_revision: expectedRevisionArg.optional(),
    question: z.string().min(1).max(400).optional(),
    hypothesis: z.string().max(4000).optional(),
    subject_type: z.enum(['post', 'listing']).optional(),
    metric: z.string().max(40).optional(),
    read_at_hours: z.number().int().min(1).max(8760).optional(),
    variants: z
      .array(
        z.object({
          label: z.string().max(40),
          description: z.string().max(2000).optional(),
        }),
      )
      .max(8)
      .optional(),
    max_items_per_variant: z.number().int().min(1).max(500).optional(),
    add: z
      .array(
        z.object({ variant_id: idArg('Variant'), subject_id: idArg('Item') }),
      )
      .max(50)
      .optional(),
    remove: z.array(idArg('Item')).max(50).optional(),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      async (actor) => {
        let id = args.experiment_id
        if (!id) {
          if (
            !args.project_id ||
            !args.question ||
            !args.subject_type ||
            !args.metric
          )
            throw invalid(
              'A new experiment needs project_id, question, subject_type and metric.',
            )
          id = (
            await createExperiment(
              actor,
              defined({
                projectId: args.project_id,
                question: args.question,
                hypothesis: args.hypothesis,
                subjectType: args.subject_type,
                metric: args.metric,
                readAtHours: args.read_at_hours,
                variants: args.variants,
                maxItemsPerVariant: args.max_items_per_variant,
                idempotencyKey: args.idempotency_key,
              }) as Parameters<typeof createExperiment>[1],
            )
          ).id
        } else if (
          args.question !== undefined ||
          args.hypothesis !== undefined ||
          args.metric !== undefined ||
          args.read_at_hours !== undefined ||
          args.variants !== undefined ||
          args.max_items_per_variant !== undefined
        ) {
          if (!args.expected_revision)
            throw invalid('Pass expected_revision to change the design.')
          await updateExperiment(
            actor,
            defined({
              experimentId: id,
              expectedRevision: args.expected_revision,
              question: args.question,
              hypothesis: args.hypothesis,
              metric: args.metric,
              readAtHours: args.read_at_hours,
              variants: args.variants,
              maxItemsPerVariant: args.max_items_per_variant,
              idempotencyKey: args.idempotency_key,
            }) as Parameters<typeof updateExperiment>[1],
          )
        }
        for (const [i, item] of (args.add ?? []).entries())
          await addItem(actor, {
            experimentId: id,
            variantId: item.variant_id,
            subjectId: item.subject_id,
            idempotencyKey: `${args.idempotency_key}:add:${i}`,
          })
        for (const itemId of args.remove ?? [])
          await removeItem(actor, { experimentId: id, itemId })
        return readExperiment(actor, id)
      },
      (read) => ({
        text: `“${read.experiment.question}” is ${read.experiment.status} with ${read.variants.map((variant) => `${variant.label} (${variant.items.length})`).join(', ')}.`,
        data: readOut(read),
      }),
    ),
})

export const transitionExperimentTool = defineTool({
  name: 'transition',
  title: 'Start, pause for reading, or archive',
  description:
    'running: start a draft (two variants at least; its design freezes). reading: stop adding items and wait for them to reach the read age. running again from reading. archived: put it away. Deciding is experiments_record_decision.',
  scope: 'experiments:write',
  input: z.object({
    experiment_id: idArg('Experiment'),
    expected_revision: expectedRevisionArg,
    to: z.enum(['running', 'reading', 'archived']),
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        transitionExperiment(actor, {
          experimentId: args.experiment_id,
          expectedRevision: args.expected_revision,
          to: args.to,
        }),
      (experiment) => ({
        text: `Now ${experiment.status} (revision ${experiment.revision}).`,
        data: { experiment: experimentOut(experiment) },
      }),
    ),
})

export const recordDecisionTool = defineTool({
  name: 'record_decision',
  title: 'Decide an experiment',
  description:
    'A verdict — winner (name the variant), no_difference, inconclusive or stopped — with the reason in words. The readings at the age are frozen into it. Needs ops:decide and a policy that lets you decide; otherwise ask the owner.',
  scope: 'ops:decide',
  input: z.object({
    experiment_id: idArg('Experiment'),
    expected_revision: expectedRevisionArg,
    verdict: z.enum(EXP_VERDICTS),
    winner_variant_id: idArg('Variant').optional(),
    rationale: z.string().min(1).max(4000),
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        recordDecision(
          actor,
          defined({
            experimentId: args.experiment_id,
            expectedRevision: args.expected_revision,
            verdict: args.verdict,
            winnerVariantId: args.winner_variant_id,
            rationale: args.rationale,
          }) as Parameters<typeof recordDecision>[1],
        ),
      ({ experiment, decision }) => ({
        text: `Decided: ${decision.verdict}.`,
        data: {
          experiment: experimentOut(experiment),
          decision: {
            id: decision.id,
            verdict: decision.verdict,
            winner_variant_id: decision.winnerVariantId,
            snapshot: decision.snapshot,
          },
        },
      }),
    ),
})

export const recordLearningTool = defineTool({
  name: 'record_learning',
  title: 'Record a learning',
  description:
    'What was learned, in one sentence, with its evidence and tags — from an experiment, for a project, or for everything the owner makes. Needs your policy to allow drafting.',
  scope: 'experiments:write',
  input: z.object({
    project_id: projectIdArg.optional(),
    experiment_id: idArg('Experiment').optional(),
    statement: z.string().min(1).max(1000),
    evidence: z.string().max(4000).optional(),
    tags: z.array(z.string().max(32)).max(12).optional(),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        recordLearning(
          actor,
          defined({
            projectId: args.project_id,
            experimentId: args.experiment_id,
            statement: args.statement,
            evidence: args.evidence,
            tags: args.tags,
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof recordLearning>[1],
        ),
      (learning) => ({
        text: `Learning recorded: “${learning.statement}”.`,
        data: { learning: learningOut(learning) },
      }),
    ),
})

export const searchLearningsTool = defineTool({
  name: 'search_learnings',
  title: 'Search learnings',
  description:
    'Learnings newest first, across projects unless one is named: every word of q must match the statement, evidence or tags. Read these before proposing a new experiment.',
  scope: 'experiments:read',
  input: z.object({
    q: z.string().max(200).optional(),
    project_id: projectIdArg.optional(),
    tags: z.array(z.string().max(32)).max(12).optional(),
    include_retired: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      (actor) =>
        searchLearnings(
          actor,
          defined({
            q: args.q,
            projectId: args.project_id,
            tags: args.tags,
            includeRetired: args.include_retired,
            limit: args.limit,
          }),
        ),
      (rows) => ({
        text: `${rows.length} learning(s).`,
        data: { learnings: rows.map(learningOut) },
      }),
    ),
})

export const experiments = defineWorkspace({
  id: 'experiments',
  label: 'Experiments',
  description:
    'One question asked once: variants, posts or listings read at the same age, decisions and learnings.',
  instructions:
    'Search learnings first. Design with experiments_save (a draft), start with experiments_transition, add items as they go out. Read with experiments_list(experiment_id): items younger than the read age are too young, not zero. Deciding is the owner’s unless your policy lets you decide.',
  tools: [
    listExperimentsTool,
    saveExperimentTool,
    transitionExperimentTool,
    recordDecisionTool,
    recordLearningTool,
    searchLearningsTool,
  ],
})
