'use server'

import { listAssets, previewUrls } from '@theiceji/hq-assets/assets'
import '@theiceji/hq-assets/register'
import {
  addExample,
  deleteLibrarySlot,
  editPromptDetails,
  generateExample,
  getPrompt,
  listLibrarySlots,
  removeExample,
  type SlotInput,
  saveLibrarySlot,
  savePrompt,
  setExamplePicks,
  setPromptArchived,
  setPromptDeleted,
} from '@theiceji/hq-prompts/prompts'
import '@theiceji/hq-prompts/register'
import type { PromptMedium } from '@theiceji/hq-db/enums'
import { type ActionResult, runAction } from '@/lib/actions'
import { type AssetData, assetData } from '../assets/data'
import {
  type LibrarySlotData,
  librarySlotData,
  type PromptData,
  promptData,
} from './data'

/**
 * Prompts' server actions — the hq-prompts services the MCP tools run too.
 * Every write answers the prompt as it now is, with its new revision.
 */

async function reread(
  actor: Parameters<Parameters<typeof runAction>[0]>[0],
  promptId: string,
) {
  const prompt = await getPrompt(actor, promptId)
  const assets = (prompt.text?.examples ?? []).map((example) => example.asset)
  return promptData(prompt, await previewUrls(actor, assets))
}

export async function savePromptAction(input: {
  promptId?: string
  expectedRevision?: number
  projectId?: string | null
  title: string
  intent?: string
  medium: PromptMedium
  collection?: string | null
  tags?: string[]
  /** The text and what goes with it; a key left out stays. */
  text?: string
  negativeText?: string
  style?: string
  providerHint?: string | null
  model?: string | null
  /** The prompt's own variants, the whole set. */
  slots?: SlotInput[]
}): Promise<ActionResult<PromptData>> {
  return runAction(async (actor) => {
    const saved = await savePrompt(actor, input)
    return reread(actor, saved.id)
  })
}

export async function addExampleAction(input: {
  promptId: string
  assetId: string
  rating?: number | null
  caption?: string
  /** The options it was made with: variant name → option id. */
  picks?: Record<string, string>
}): Promise<ActionResult<PromptData>> {
  return runAction(async (actor) => {
    await addExample(actor, input)
    return reread(actor, input.promptId)
  })
}

/** Which options an example was made with — the whole set; empty = not known. */
export async function setExamplePicksAction(input: {
  promptId: string
  exampleId: string
  picks: Record<string, string>
}): Promise<ActionResult<PromptData>> {
  return runAction(async (actor) => {
    await setExamplePicks(actor, {
      exampleId: input.exampleId,
      picks: input.picks,
    })
    return reread(actor, input.promptId)
  })
}

export async function removeExampleAction(input: {
  promptId: string
  exampleId: string
}): Promise<ActionResult<PromptData>> {
  return runAction(async (actor) => {
    await removeExample(actor, input.exampleId)
    return reread(actor, input.promptId)
  })
}

/** Title, what it's for, collection and tags — the variants stay as they are. */
export async function editPromptDetailsAction(input: {
  promptId: string
  expectedRevision: number
  title: string
  intent: string
  collection: string | null
  tags: string[]
}): Promise<ActionResult<PromptData>> {
  return runAction(async (actor) => {
    await editPromptDetails(actor, input)
    return reread(actor, input.promptId)
  })
}

/** Archive or restore from Archived; answers the prompt as it now is, for Undo. */
export async function archivePromptAction(input: {
  promptId: string
  expectedRevision: number
  archived: boolean
}): Promise<ActionResult<PromptData>> {
  return runAction(async (actor) => {
    await setPromptArchived(actor, input)
    return reread(actor, input.promptId)
  })
}

/**
 * Delete to the Trash, or restore from it — to the library, or back to
 * Archived (`archived`) when undoing a delete made there.
 */
export async function deletePromptAction(input: {
  promptId: string
  expectedRevision: number
  deleted: boolean
  archived?: boolean
}): Promise<ActionResult<PromptData>> {
  return runAction(async (actor) => {
    await setPromptDeleted(actor, input)
    return reread(actor, input.promptId)
  })
}

/** Ready images, videos and audio an example can come from: the project's own, or floating ones. */
export async function examplePickAction(
  projectId: string | null,
): Promise<
  ActionResult<{ assets: AssetData[]; previews: Record<string, string> }>
> {
  return runAction(
    async (actor) => {
      const { assets } = await listAssets(actor, {
        projectId,
        status: 'ready',
        limit: 60,
      })
      const usable = assets.filter(
        (asset) => asset.kind !== 'doc' && asset.kind !== 'other',
      )
      return {
        assets: usable.map(assetData),
        previews: await previewUrls(actor, usable),
      }
    },
    { read: true },
  )
}

/** The whole prompt — every variant and its examples — when one is selected. */
export async function promptAction(
  promptId: string,
): Promise<ActionResult<PromptData>> {
  return runAction((actor) => reread(actor, promptId), { read: true })
}

/**
 * Generate with one of the owner's generators, the text filled from the
 * picks: the result lands as an example with those picks (a video lands
 * when the tick collects it).
 */
export async function generateExampleAction(input: {
  promptId: string
  connectionId: string
  picks: Record<string, string>
}): Promise<
  ActionResult<{ prompt: PromptData; state: string; error: string | null }>
> {
  return runAction(async (actor) => {
    const job = await generateExample(actor, {
      promptId: input.promptId,
      connectionId: input.connectionId,
      picks: input.picks,
    })
    return {
      prompt: await reread(actor, input.promptId),
      state: job.state,
      error: job.error,
    }
  })
}

/** The library of variants — every prompt that writes `<NAME>` offers its options. */
export async function librarySlotsAction(): Promise<
  ActionResult<LibrarySlotData[]>
> {
  return runAction(
    async (actor) => (await listLibrarySlots(actor)).map(librarySlotData),
    { read: true },
  )
}

/** Put a variant in the library, or change one; its options are the whole set. */
export async function saveLibrarySlotAction(input: {
  id?: string
  expectedRevision?: number
  name: string
  note?: string
  options: { id?: string; key: string; value: string }[]
}): Promise<ActionResult<LibrarySlotData>> {
  return runAction(async (actor) =>
    librarySlotData(await saveLibrarySlot(actor, input)),
  )
}

/** Take a variant out of the library; asked in place, it can't come back. */
export async function deleteLibrarySlotAction(input: {
  slotId: string
  expectedRevision: number
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await deleteLibrarySlot(actor, input)
    return null
  })
}
