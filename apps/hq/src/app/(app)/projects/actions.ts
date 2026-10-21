'use server'

import {
  createProject,
  deleteProject,
  restoreProject,
  setModule,
  setProjectStatus,
  updateProject,
} from '@theiceji/hq-core/projects'
import { type ActionResult, runAction } from '@/lib/actions'

/**
 * Projects are the owner's to shape: every action here runs the
 * hq-core service the MCP server would, with the signed-in owner as actor, so
 * the rules — free slug, modules a kind may have, optimistic revisions — are
 * the same wherever a project changes.
 */

export async function createProjectAction(input: {
  name: string
  kind: string
  color?: string | null
}): Promise<ActionResult<{ slug: string }>> {
  return runAction(async (actor) => {
    const project = await createProject(actor, {
      name: input.name,
      kind: input.kind,
      color: input.color ?? undefined,
    })
    return { slug: project.slug }
  })
}

export async function updateProjectAction(input: {
  projectId: string
  expectedRevision: number
  name?: string
  color?: string
  storageProvider?: string | null
  storageRoot?: string | null
}): Promise<ActionResult<{ revision: number }>> {
  return runAction(async (actor) => {
    const project = await updateProject(actor, input)
    return { revision: project.revision }
  })
}

export async function setProjectStatusAction(input: {
  projectId: string
  expectedRevision: number
  status: 'active' | 'paused' | 'archived'
}): Promise<ActionResult<{ revision: number }>> {
  return runAction(async (actor) => {
    const project = await setProjectStatus(actor, input)
    return { revision: project.revision }
  })
}

export async function setModuleAction(input: {
  projectId: string
  expectedRevision: number
  module: string
  on: boolean
}): Promise<ActionResult<{ revision: number; enabled: string[] }>> {
  return runAction(async (actor) => {
    const project = await setModule(actor, input)
    return { revision: project.revision, enabled: project.modules.enabled }
  })
}

/** Delete: to the Trash, archived, every record kept — the owner's. */
export async function deleteProjectAction(input: {
  projectId: string
  expectedRevision: number
}): Promise<ActionResult<{ revision: number }>> {
  return runAction(async (actor) => {
    const project = await deleteProject(actor, input)
    return { revision: project.revision }
  })
}

/** Out of the Trash: archived (Restore), or as it was (Delete's Undo). */
export async function restoreProjectAction(input: {
  projectId: string
  expectedRevision: number
  status?: 'active' | 'paused' | 'archived'
}): Promise<ActionResult<{ revision: number }>> {
  return runAction(async (actor) => {
    const project = await restoreProject(actor, input)
    return { revision: project.revision }
  })
}
