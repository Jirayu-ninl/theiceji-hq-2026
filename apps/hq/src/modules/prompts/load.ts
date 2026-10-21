import 'server-only'
import { previewUrls } from '@theiceji/hq-assets/assets'
import { listProjects } from '@theiceji/hq-core/projects'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import {
  getPrompt,
  listLibrarySlots,
  listPrompts,
  type PromptBucket,
  promptCollections,
} from '@theiceji/hq-prompts/prompts'
import { generatorOptions } from '@/lib/generators'
import '@theiceji/hq-prompts/register'
import type { PromptsPageProps } from './components/PromptsPage'
import {
  librarySlotData,
  type PromptData,
  type PromptProject,
  promptData,
  promptListData,
} from './data'

/**
 * What a Prompts page reads on the server: the prompts in the view's bucket
 * (Grid and List show the library; Archived and Trash what was put away or
 * deleted, restorable) — a project's, or every project's plus the floating
 * ones — with short-lived previews of each card's sample.
 */

const VIEWS = ['grid', 'list', 'library', 'archived', 'trash'] as const

/** Grid and List are one list, the library; Archived and Trash are their own. */
export const bucketOf = (view: PromptsPageProps['view']): PromptBucket =>
  view === 'archived' || view === 'trash' ? view : 'live'

const project = (row: ProjectRow): PromptProject => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  color: row.color,
  status: row.status,
  kind: row.kind,
})

export async function loadPrompts(
  actor: Actor,
  row: ProjectRow | null,
  params: { view?: string; prompt?: string; new?: string },
): Promise<PromptsPageProps> {
  const view = VIEWS.find((entry) => entry === params.view) ?? 'grid'
  // The Variants view is the library alone, HQ-wide — no prompts to read.
  if (view === 'library')
    return {
      full: null,
      project: row ? project(row) : null,
      projects: [],
      prompts: [],
      total: 0,
      collections: [],
      view,
      selectedId: null,
      creating: false,
      generators: [],
      library: (await listLibrarySlots(actor)).map(librarySlotData),
    }
  const bucket = bucketOf(view)
  const [{ prompts, total }, collections, projects, generators] =
    await Promise.all([
      listPrompts(
        actor,
        row
          ? { projectId: row.id, bucket, limit: 300 }
          : { bucket, limit: 300 },
      ),
      promptCollections(actor, row?.id),
      row ? Promise.resolve([row]) : listProjects(actor),
      generatorOptions(actor),
    ])
  const previews = await previewUrls(
    actor,
    prompts.flatMap((prompt) => prompt.previews),
  )
  // The selected prompt arrives whole, so a shared link opens straight into it.
  let full: PromptData | null = null
  if (params.prompt) {
    try {
      const view = await getPrompt(actor, params.prompt)
      const examples = (view.text?.examples ?? []).map(
        (example) => example.asset,
      )
      full = promptData(view, await previewUrls(actor, examples))
    } catch {
      full = null
    }
  }
  return {
    full,
    project: row ? project(row) : null,
    projects: projects
      .filter((entry) => entry.modules.enabled.includes('prompts'))
      .map(project),
    prompts: prompts.map((prompt) => promptListData(prompt, previews)),
    total,
    collections,
    view,
    selectedId: params.prompt ?? null,
    creating: bucket === 'live' && params.new === '1',
    library: [],
    generators,
  }
}
