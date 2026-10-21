'use server'

import '@/modules/register'
import {
  deleteRoutine,
  getRoutine,
  restoreRoutine,
  runRoutineNow,
  type SaveRoutineInput,
  saveRoutine,
  setRoutineEnabled,
} from '@theiceji/hq-agents/routines'
import { type ActionResult, runAction } from '@/lib/actions'
import { type RoutineData, type RunData, routineData, runData } from './data'

/**
 * Agents' server actions — the hq-agents services. Routines are the owner's
 * alone; every write answers the routine as it now is, with its runs.
 */

type Detail = { routine: RoutineData; runs: RunData[] }

async function detail(
  actor: Parameters<Parameters<typeof runAction>[0]>[0],
  routineId: string,
): Promise<Detail> {
  const found = await getRoutine(actor, routineId)
  return {
    routine: routineData(found),
    runs: found.runs.map((run) =>
      runData({ ...run, routineId: found.id, projectId: found.projectId }),
    ),
  }
}

export async function routineDetailAction(
  routineId: string,
): Promise<ActionResult<Detail>> {
  return runAction((actor) => detail(actor, routineId), { read: true })
}

export async function saveRoutineAction(
  input: SaveRoutineInput,
): Promise<ActionResult<Detail>> {
  return runAction(
    async (actor) => {
      const saved = await saveRoutine(actor, input)
      return detail(actor, saved.id)
    },
    { revalidate: ['/agents'] },
  )
}

export async function setRoutineEnabledAction(input: {
  routineId: string
  expectedRevision: number
  enabled: boolean
}): Promise<ActionResult<Detail>> {
  return runAction(
    async (actor) => {
      await setRoutineEnabled(actor, input)
      return detail(actor, input.routineId)
    },
    { revalidate: ['/agents'] },
  )
}

/** Queue a run now; a routine with one waiting gets that one back. */
export async function runRoutineNowAction(
  routineId: string,
): Promise<ActionResult<Detail & { queued: boolean }>> {
  return runAction(
    async (actor) => {
      const { queued } = await runRoutineNow(actor, { routineId })
      return { ...(await detail(actor, routineId)), queued }
    },
    { revalidate: ['/agents'] },
  )
}

/** Delete `⌫`: to the Trash, switched off, its queued run cancelled. */
export async function deleteRoutineAction(
  routineId: string,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    async (actor) => {
      await deleteRoutine(actor, { routineId })
      return { id: routineId }
    },
    { revalidate: ['/agents'] },
  )
}

/** Restore `r` (and Delete's Undo): back from the Trash, switched off. */
export async function restoreRoutineAction(
  routineId: string,
): Promise<ActionResult<Detail>> {
  return runAction(
    async (actor) => {
      await restoreRoutine(actor, { routineId })
      return detail(actor, routineId)
    },
    { revalidate: ['/agents'] },
  )
}
