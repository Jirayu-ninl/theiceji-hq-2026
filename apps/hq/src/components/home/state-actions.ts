'use server'

import '@/modules/register'
import { listRoutines, setRoutineEnabled } from '@theiceji/hq-agents/routines'
import { isModuleId } from '@theiceji/hq-core/modules'
import { getProject, setModule } from '@theiceji/hq-core/projects'
import { invalid, notFound, OpsError } from '@theiceji/hq-ops/errors'
import { type ActionResult, runAction } from '@/lib/actions'
import { promoteNote } from '@/lib/notes/promote'

/**
 * The two writes Home · State needs that no other page exports.
 * Everything else State does — pause, enable, capture, answer —
 * goes through the actions the Projects, Notes and Inbox pages already use.
 *
 * Both run the same owner-scoped services the MCP server would, through
 * `runAction` (the session is checked on every call).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The record a note becomes in each module that takes notes. */
const TARGET_OF: Record<string, string> = {
  board: 'card',
  prompts: 'prompt',
  story: 'shot',
  calendar: 'event',
}

/**
 * Promote a note into one cell of the matrix — a project and a module. When
 * the module is off but may be turned on, it is turned on first; if the
 * promote then fails, it is turned off again, so the owner sees one step
 * that happened or didn't.
 */
export async function promoteIntoCellAction(input: {
  noteId: string
  projectId: string
  module: string
}): Promise<
  ActionResult<{ type: string; href: string; enabled: boolean; label: string }>
> {
  return runAction(async (actor) => {
    if (!UUID.test(input.noteId)) throw notFound('Note')
    if (!UUID.test(input.projectId)) throw notFound('Project')
    const module = input.module
    const target = TARGET_OF[module]
    if (!target || !isModuleId(module))
      throw invalid(
        'Notes become a card, a prompt, a shot or an event — pick Board, Prompts, Story or Calendar.',
      )
    let project = await getProject(actor, input.projectId)
    let enabled = false
    if (!project.modules.enabled.includes(module)) {
      project = await setModule(actor, {
        projectId: project.id,
        expectedRevision: project.revision,
        module,
        on: true,
      })
      enabled = true
    }
    try {
      const created = await promoteNote(actor, {
        noteId: input.noteId,
        projectId: project.id,
        target,
      })
      return {
        type: created.type,
        href: created.href,
        enabled,
        label: project.name,
      }
    } catch (error) {
      if (enabled)
        await setModule(actor, {
          projectId: project.id,
          expectedRevision: project.revision,
          module,
          on: false,
        }).catch((undo: unknown) =>
          console.error('[state] turning the module back off failed', undo),
        )
      throw error
    }
  })
}

/**
 * The mixer's `arm`: switch a project's routines on or off together. With
 * `routineIds`, only those (Undo passes back exactly what changed). A
 * routine that can't be switched (HQ's own runner without an LLM key) is
 * skipped and named; if none could change, that reason is the error.
 */
export async function setProjectRoutinesAction(input: {
  projectId: string
  on: boolean
  routineIds?: string[]
}): Promise<ActionResult<{ changed: string[]; skipped: string[] }>> {
  return runAction(
    async (actor) => {
      if (!UUID.test(input.projectId)) throw notFound('Project')
      const routines = await listRoutines(actor, {
        projectId: input.projectId,
      })
      const wanted = routines.filter(
        (routine) =>
          !routine.archivedAt &&
          routine.enabled !== input.on &&
          (!input.routineIds || input.routineIds.includes(routine.id)),
      )
      if (!routines.some((routine) => !routine.archivedAt))
        throw invalid('This project has no routines yet. Make one in Agents.')
      const changed: string[] = []
      const skipped: string[] = []
      for (const routine of wanted) {
        try {
          await setRoutineEnabled(actor, {
            routineId: routine.id,
            enabled: input.on,
          })
          changed.push(routine.id)
        } catch (error) {
          if (!(error instanceof OpsError)) throw error
          skipped.push(`${routine.name}: ${error.message}`)
        }
      }
      if (!changed.length && skipped.length) throw invalid(skipped.join(' '))
      return { changed, skipped }
    },
    { revalidate: ['/agents'] },
  )
}
