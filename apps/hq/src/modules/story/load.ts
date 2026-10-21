import 'server-only'
import { previewsFor } from '@theiceji/hq-assets/assets'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { openStory, variantOptions } from '@theiceji/hq-story/story'
import '@/modules/register'
import { generatorOptions } from '@/lib/generators'
import { fileOptions } from '@/lib/module-page'
import type { StoryPageProps } from './components/StoryPage'
import { boardData } from './data'

/**
 * What the Story page reads on the server: the story board (made on first
 * open), the prompt variants a shot may use, the project's ready media (for
 * character boards and for attaching a file a shot already has) and short-
 * lived previews of every result and board.
 */
export async function loadStory(
  actor: Actor,
  project: ProjectRow,
  params: { view?: string; shot?: string; character?: string },
): Promise<StoryPageProps> {
  const [board, variants, files, generators] = await Promise.all([
    openStory(actor, project.id),
    variantOptions(actor, project.id),
    fileOptions(actor, project.id, ['image', 'video', 'audio']),
    generatorOptions(actor),
  ])
  const previews = await previewsFor(actor, [
    ...board.scenes.flatMap((scene) =>
      scene.shots.flatMap((shot) => shot.results.map((asset) => asset.id)),
    ),
    ...board.characters.flatMap((character) =>
      character.boardAssetId ? [character.boardAssetId] : [],
    ),
  ]).catch(() => ({}))
  const view =
    params.view === 'shots' || params.view === 'characters'
      ? params.view
      : 'script'
  return {
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      color: project.color,
      status: project.status,
    },
    board: boardData(board),
    variants,
    files,
    generators,
    previews,
    view,
    selectedShotId: params.shot ?? null,
    selectedCharacterId: params.character ?? null,
  }
}
