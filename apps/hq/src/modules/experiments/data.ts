import type { AgeReading } from '@theiceji/hq-core/readings'
import type { ExpLearningRow } from '@theiceji/hq-db/schema'
import {
  deleteBlocker,
  type ExperimentListItem,
  type ExperimentRead,
} from '@theiceji/hq-experiments/experiments'

/** Experiments as they cross to the page: plain JSON, dates as ISO strings. */

export type ExperimentsProject = {
  id: string
  slug: string
  name: string
  color: string
  status: string
}

export type AgeReadingData =
  | { state: 'known'; value: string; asOf: string; currency: string | null }
  | { state: 'too_young'; readyAt: string }
  | { state: 'not_out' }
  | { state: 'not_read' }

export const ageReadingData = (reading: AgeReading): AgeReadingData =>
  reading.state === 'known'
    ? {
        state: 'known',
        value: reading.value,
        asOf: reading.asOf.toISOString(),
        currency: reading.currency,
      }
    : reading.state === 'too_young'
      ? { state: 'too_young', readyAt: reading.readyAt.toISOString() }
      : { state: reading.state }

export type ExperimentRowData = {
  id: string
  question: string
  subjectType: 'post' | 'listing'
  metric: string
  readAtHours: number
  status: 'draft' | 'running' | 'reading' | 'decided' | 'archived'
  variants: { id: string; label: string }[]
  items: number
  lastDecision: { verdict: string; decidedAt: string } | null
  updatedAt: string
}

export type ExperimentData = {
  id: string
  question: string
  hypothesis: string
  subjectType: 'post' | 'listing'
  metric: string
  readAtHours: number
  status: ExperimentRowData['status']
  maxItemsPerVariant: number | null
  startedAt: string | null
  decidedAt: string | null
  revision: number
  readAt: string
  /** Why Delete isn't offered, in words — null for a draft, which may go. */
  deleteBlocker: string | null
  variants: {
    id: string
    label: string
    description: string
    covered: number
    tooYoung: number
    notRead: number
    median: string | null
    medianIsLower: boolean
    min: string | null
    max: string | null
    currency: string | null
    items: {
      id: string
      subjectId: string
      title: string | null
      where: string | null
      href: string | null
      wentOutAt: string | null
      reading: AgeReadingData
    }[]
  }[]
  leader: { variantId: string; label: string; note: string } | null
  decisions: {
    id: string
    verdict: string
    winnerVariantId: string | null
    rationale: string
    decidedAt: string
    snapshot: Record<string, unknown>
  }[]
}

export type LearningData = {
  id: string
  projectId: string | null
  experimentId: string | null
  statement: string
  evidence: string
  tags: string[]
  status: 'active' | 'retired'
  createdAt: string
  revision: number
}

export function experimentRowData(row: ExperimentListItem): ExperimentRowData {
  return {
    id: row.id,
    question: row.question,
    subjectType: row.subjectType,
    metric: row.metric,
    readAtHours: row.readAtHours,
    status: row.status,
    variants: row.variants,
    items: row.items,
    lastDecision: row.lastDecision
      ? {
          verdict: row.lastDecision.verdict,
          decidedAt: row.lastDecision.decidedAt.toISOString(),
        }
      : null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function experimentData(read: ExperimentRead): ExperimentData {
  const { experiment } = read
  return {
    id: experiment.id,
    question: experiment.question,
    hypothesis: experiment.hypothesis,
    subjectType: experiment.subjectType,
    metric: experiment.metric,
    readAtHours: experiment.readAtHours,
    status: experiment.status,
    maxItemsPerVariant: experiment.limits.maxItemsPerVariant ?? null,
    startedAt: experiment.startedAt?.toISOString() ?? null,
    decidedAt: experiment.decidedAt?.toISOString() ?? null,
    revision: experiment.revision,
    readAt: read.readAt.toISOString(),
    deleteBlocker: deleteBlocker(experiment),
    variants: read.variants.map((variant) => ({
      id: variant.id,
      label: variant.label,
      description: variant.description,
      covered: variant.covered,
      tooYoung: variant.tooYoung,
      notRead: variant.notRead,
      median: variant.median,
      medianIsLower: variant.medianIsLower,
      min: variant.min,
      max: variant.max,
      currency: variant.currency,
      items: variant.items.map((item) => ({
        id: item.id,
        subjectId: item.subjectId,
        title: item.subject?.title ?? null,
        where: item.subject?.where ?? null,
        href: item.subject?.href ?? null,
        wentOutAt: item.subject?.wentOutAt?.toISOString() ?? null,
        reading: ageReadingData(item.reading),
      })),
    })),
    leader: read.leader,
    decisions: read.decisions.map((decision) => ({
      id: decision.id,
      verdict: decision.verdict,
      winnerVariantId: decision.winnerVariantId,
      rationale: decision.rationale,
      decidedAt: decision.decidedAt.toISOString(),
      snapshot: decision.snapshot,
    })),
  }
}

export function learningData(row: ExpLearningRow): LearningData {
  return {
    id: row.id,
    projectId: row.projectId,
    experimentId: row.experimentId,
    statement: row.statement,
    evidence: row.evidence,
    tags: row.tags,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    revision: row.revision,
  }
}
