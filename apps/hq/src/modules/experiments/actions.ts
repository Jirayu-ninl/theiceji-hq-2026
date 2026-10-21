'use server'

import {
  addItem,
  createExperiment,
  deleteExperiment,
  readExperiment,
  recordDecision,
  recordLearning,
  removeItem,
  setLearningRetired,
  transitionExperiment,
  updateExperiment,
} from '@theiceji/hq-experiments/experiments'
import { type ActionResult, runAction } from '@/lib/actions'
import '@/modules/register'
import {
  type ExperimentData,
  experimentData,
  type LearningData,
  learningData,
} from './data'

/**
 * Experiments' server actions — the hq-experiments services. Deciding is the
 * owner's; every write answers the experiment read at its age now.
 */

type Actor = Parameters<Parameters<typeof runAction>[0]>[0]
const read = async (actor: Actor, id: string) =>
  experimentData(await readExperiment(actor, id))

export async function experimentAction(
  experimentId: string,
): Promise<ActionResult<ExperimentData>> {
  return runAction((actor) => read(actor, experimentId), { read: true })
}

export async function createExperimentAction(input: {
  projectId: string
  question: string
  hypothesis?: string
  subjectType: 'post' | 'listing'
  metric: string
  readAtHours: number
  variants: { label: string; description?: string }[]
}): Promise<ActionResult<ExperimentData>> {
  return runAction(async (actor) => {
    const experiment = await createExperiment(actor, input)
    return read(actor, experiment.id)
  })
}

export async function updateExperimentAction(input: {
  experimentId: string
  expectedRevision: number
  question?: string
  hypothesis?: string
  metric?: string
  readAtHours?: number
  variants?: { label: string; description?: string }[]
}): Promise<ActionResult<ExperimentData>> {
  return runAction(async (actor) => {
    await updateExperiment(actor, input)
    return read(actor, input.experimentId)
  })
}

export async function transitionAction(input: {
  experimentId: string
  expectedRevision: number
  to: 'running' | 'reading' | 'archived'
}): Promise<ActionResult<ExperimentData>> {
  return runAction(async (actor) => {
    await transitionExperiment(actor, input)
    return read(actor, input.experimentId)
  })
}

/** The owner's: a draft goes for good (the page asks first); anything that started is archived instead. */
export async function deleteExperimentAction(input: {
  experimentId: string
  expectedRevision: number
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await deleteExperiment(actor, input)
    return null
  })
}

export async function addItemAction(input: {
  experimentId: string
  variantId: string
  subjectId: string
}): Promise<ActionResult<ExperimentData>> {
  return runAction(async (actor) => {
    await addItem(actor, input)
    return read(actor, input.experimentId)
  })
}

export async function removeItemAction(input: {
  experimentId: string
  itemId: string
}): Promise<ActionResult<ExperimentData>> {
  return runAction(async (actor) => {
    await removeItem(actor, input)
    return read(actor, input.experimentId)
  })
}

export async function decideAction(input: {
  experimentId: string
  expectedRevision: number
  verdict: 'winner' | 'no_difference' | 'inconclusive' | 'stopped'
  winnerVariantId?: string
  rationale: string
}): Promise<ActionResult<ExperimentData>> {
  return runAction(async (actor) => {
    await recordDecision(actor, input)
    return read(actor, input.experimentId)
  })
}

export async function recordLearningAction(input: {
  projectId?: string
  experimentId?: string
  statement: string
  evidence?: string
  tags?: string[]
}): Promise<ActionResult<LearningData>> {
  return runAction(async (actor) =>
    learningData(await recordLearning(actor, input)),
  )
}

export async function retireLearningAction(input: {
  learningId: string
  expectedRevision: number
  retired: boolean
}): Promise<ActionResult<LearningData>> {
  return runAction(async (actor) =>
    learningData(await setLearningRetired(actor, input)),
  )
}
