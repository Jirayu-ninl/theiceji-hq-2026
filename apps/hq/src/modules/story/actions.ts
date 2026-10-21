'use server'

import { previewsFor } from '@theiceji/hq-assets/assets'
import {
  attachShotResult,
  deleteScene,
  deleteShot,
  generateShot,
  openStory,
  removeCharacter,
  saveCharacter,
  saveScene,
  saveShot,
  saveStory,
  setShotStatus,
  zipScene,
} from '@theiceji/hq-story/story'
import { type ActionResult, runAction } from '@/lib/actions'
import '@/modules/register'
import { boardData, type StoryBoardData } from './data'

/**
 * Story's server actions — the hq-story services. Every write answers the
 * whole board as it now is (numbers, timecodes and results move together).
 * Deleting a scene or a shot is the owner's.
 */

type Actor = Parameters<Parameters<typeof runAction>[0]>[0]
const board = async (actor: Actor, projectId: string) =>
  boardData(await openStory(actor, projectId))

export async function storyBoardAction(
  projectId: string,
): Promise<ActionResult<StoryBoardData>> {
  return runAction((actor) => board(actor, projectId), { read: true })
}

/** Short-lived previews for files the page just attached. */
export async function storyPreviewsAction(
  assetIds: string[],
): Promise<ActionResult<Record<string, string>>> {
  return runAction((actor) => previewsFor(actor, assetIds.slice(0, 200)), {
    read: true,
  })
}

export async function saveScriptAction(input: {
  projectId: string
  storyId: string
  expectedRevision: number
  title?: string
  logline?: string
  script?: string
}): Promise<ActionResult<StoryBoardData>> {
  return runAction(async (actor) => {
    const { projectId, ...rest } = input
    await saveStory(actor, rest)
    return board(actor, projectId)
  })
}

export async function saveCharacterAction(input: {
  projectId: string
  storyId: string
  characterId?: string
  expectedRevision?: number
  name: string
  description?: string
  boardAssetId?: string | null
}): Promise<ActionResult<StoryBoardData>> {
  return runAction(async (actor) => {
    const { projectId, ...rest } = input
    await saveCharacter(actor, rest)
    return board(actor, projectId)
  })
}

export async function removeCharacterAction(input: {
  projectId: string
  characterId: string
}): Promise<ActionResult<StoryBoardData>> {
  return runAction(async (actor) => {
    await removeCharacter(actor, { characterId: input.characterId })
    return board(actor, input.projectId)
  })
}

export async function saveSceneAction(input: {
  projectId: string
  storyId: string
  sceneId?: string
  expectedRevision?: number
  heading: string
  synopsis?: string
  number?: number
}): Promise<ActionResult<StoryBoardData>> {
  return runAction(async (actor) => {
    const { projectId, ...rest } = input
    await saveScene(actor, rest)
    return board(actor, projectId)
  })
}

export async function deleteSceneAction(input: {
  projectId: string
  sceneId: string
}): Promise<ActionResult<StoryBoardData>> {
  return runAction(async (actor) => {
    await deleteScene(actor, { sceneId: input.sceneId })
    return board(actor, input.projectId)
  })
}

export async function saveShotAction(input: {
  projectId: string
  sceneId: string
  shotId?: string
  expectedRevision?: number
  action: string
  durationS?: string | null
  imageVariantId?: string | null
  videoVariantId?: string | null
  characterIds?: string[]
  notes?: string
  number?: number
}): Promise<ActionResult<StoryBoardData>> {
  return runAction(async (actor) => {
    const { projectId, ...rest } = input
    await saveShot(actor, rest)
    return board(actor, projectId)
  })
}

export async function shotStatusAction(input: {
  projectId: string
  shotId: string
  expectedRevision: number
  status: 'boarded' | 'generated' | 'edited' | 'done'
}): Promise<ActionResult<StoryBoardData>> {
  return runAction(async (actor) => {
    const { projectId, ...rest } = input
    await setShotStatus(actor, rest)
    return board(actor, projectId)
  })
}

export async function deleteShotAction(input: {
  projectId: string
  shotId: string
  expectedRevision: number
}): Promise<ActionResult<StoryBoardData>> {
  return runAction(async (actor) => {
    const { projectId, ...rest } = input
    await deleteShot(actor, rest)
    return board(actor, projectId)
  })
}

export async function generateShotAction(input: {
  projectId: string
  shotId: string
  medium: 'image' | 'video'
  /** A generator connection; absent means by hand. */
  generatorId?: string | null
}): Promise<
  ActionResult<{
    board: StoryBoardData
    jobId: string
    state: string
    error: string | null
  }>
> {
  return runAction(async (actor) => {
    const job = await generateShot(actor, {
      shotId: input.shotId,
      medium: input.medium,
      ...(input.generatorId
        ? {
            provider: 'external:openai_compatible',
            connectionId: input.generatorId,
          }
        : {}),
    })
    return {
      board: await board(actor, input.projectId),
      jobId: job.id,
      state: job.state,
      error: job.error,
    }
  })
}

export async function attachResultAction(input: {
  projectId: string
  shotId: string
  assetId: string
  jobId?: string
}): Promise<ActionResult<StoryBoardData>> {
  return runAction(async (actor) => {
    await attachShotResult(actor, {
      shotId: input.shotId,
      assetId: input.assetId,
      jobId: input.jobId,
    })
    return board(actor, input.projectId)
  })
}

export async function zipSceneAction(input: {
  projectId: string
  sceneId: string
}): Promise<ActionResult<StoryBoardData>> {
  return runAction(async (actor) => {
    await zipScene(actor, { sceneId: input.sceneId })
    return board(actor, input.projectId)
  })
}
