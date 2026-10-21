import type { JobView } from '@theiceji/hq-assets/jobs'
import type {
  AssetLite,
  StoryBoard,
  VariantLite,
  VariantOption,
} from '@theiceji/hq-story/story'

/** Story as it crosses to the page: plain JSON, dates as ISO strings. */

export type StoryProject = {
  id: string
  slug: string
  name: string
  color: string
  status: string
}

export type JobData = {
  id: string
  provider: string
  operation: string
  title: string
  state: string
  variantId: string | null
  error: string | null
  results: { id: string; name: string; kind: string; status: string }[]
}

export type ShotData = {
  id: string
  sceneId: string
  number: number
  code: string
  action: string
  durationS: string | null
  startS: string
  imageVariantId: string | null
  videoVariantId: string | null
  image: VariantLite | null
  video: VariantLite | null
  characterIds: string[]
  status: 'boarded' | 'generated' | 'edited' | 'done'
  notes: string
  results: AssetLite[]
  job: JobData | null
  revision: number
}

export type SceneData = {
  id: string
  number: number
  heading: string
  synopsis: string
  revision: number
  shots: ShotData[]
  zip: JobData | null
}

export type CharacterData = {
  id: string
  name: string
  description: string
  boardAssetId: string | null
  board: AssetLite | null
  revision: number
}

export type StoryData = {
  id: string
  title: string
  logline: string
  script: string
  revision: number
} | null

export type StoryBoardData = {
  story: StoryData
  characters: CharacterData[]
  scenes: SceneData[]
  runtimeS: string
  counts: { shots: number; generated: number; done: number }
}

export type VariantOptionData = VariantOption

const jobData = (job: JobView | null): JobData | null =>
  job
    ? {
        id: job.id,
        provider: job.provider,
        operation: job.operation,
        title: job.title,
        state: job.state,
        variantId: job.variantId,
        error: job.error,
        results: job.results.map((asset) => ({
          id: asset.id,
          name: asset.name,
          kind: asset.kind,
          status: asset.status,
        })),
      }
    : null

export function boardData(board: StoryBoard): StoryBoardData {
  return {
    story: board.story
      ? {
          id: board.story.id,
          title: board.story.title,
          logline: board.story.logline,
          script: board.story.script,
          revision: board.story.revision,
        }
      : null,
    characters: board.characters.map((character) => ({
      id: character.id,
      name: character.name,
      description: character.description,
      boardAssetId: character.boardAssetId,
      board: character.board,
      revision: character.revision,
    })),
    scenes: board.scenes.map((scene) => ({
      id: scene.id,
      number: scene.number,
      heading: scene.heading,
      synopsis: scene.synopsis,
      revision: scene.revision,
      zip: jobData(scene.zip),
      shots: scene.shots.map((shot) => ({
        id: shot.id,
        sceneId: shot.sceneId,
        number: shot.number,
        code: shot.code,
        action: shot.action,
        durationS: shot.durationS,
        startS: shot.startS,
        imageVariantId: shot.imageVariantId,
        videoVariantId: shot.videoVariantId,
        image: shot.image,
        video: shot.video,
        characterIds: shot.characterIds,
        status: shot.status,
        notes: shot.notes,
        results: shot.results,
        job: jobData(shot.job),
        revision: shot.revision,
      })),
    })),
    runtimeS: board.runtimeS,
    counts: board.counts,
  }
}
