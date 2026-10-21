import type { StoryRow } from '@theiceji/hq-db/schema'
import { invalid } from '@theiceji/hq-ops/errors'
import {
  openStory,
  type StoryBoard,
  saveScene,
  saveShots,
  saveStory,
} from '@theiceji/hq-story/story'
import '@theiceji/hq-story/register'
import { z } from 'zod'
import { defineTool, defineWorkspace } from '../../kernel'
import {
  defined,
  expectedRevisionArg,
  idArg,
  idempotencyKeyArg,
  projectIdArg,
  READ,
  readTool,
  WRITE,
  writeTool,
} from '../support'

/**
 * `story` — a film's script and shot board. Read the board,
 * write the script, lay out a scene's shots with their prompt variants.
 * Generating a shot's file and editing are the owner's (by hand, then on
 * their own machine); deleting a scene or shot is the owner's, in HQ.
 */

function storyOut(story: StoryRow) {
  return {
    id: story.id,
    project_id: story.projectId,
    title: story.title,
    logline: story.logline,
    script: story.script,
    revision: story.revision,
  }
}

function boardOut(board: StoryBoard) {
  return {
    story: board.story ? storyOut(board.story) : null,
    runtime_s: board.runtimeS,
    counts: board.counts,
    characters: board.characters.map((character) => ({
      id: character.id,
      name: character.name,
      description: character.description,
      board_asset_id: character.boardAssetId,
    })),
    scenes: board.scenes.map((scene) => ({
      id: scene.id,
      number: scene.number,
      heading: scene.heading,
      synopsis: scene.synopsis,
      zip: scene.zip
        ? {
            job_id: scene.zip.id,
            state: scene.zip.state,
            results: scene.zip.resultAssetIds,
          }
        : null,
      shots: scene.shots.map((shot) => ({
        id: shot.id,
        code: shot.code,
        action: shot.action,
        duration_s: shot.durationS,
        starts_at_s: shot.startS,
        image_variant: shot.image
          ? {
              id: shot.image.id,
              label: shot.image.label,
              prompt: shot.image.promptTitle,
            }
          : null,
        video_variant: shot.video
          ? {
              id: shot.video.id,
              label: shot.video.label,
              prompt: shot.video.promptTitle,
            }
          : null,
        cast: shot.characterIds,
        status: shot.status,
        results: shot.results.map((asset) => ({
          id: asset.id,
          name: asset.name,
          /** The owner's name for it in HQ, or null (then `name`, the file name, is what HQ shows). */
          title: asset.title,
          kind: asset.kind,
        })),
        job: shot.job ? { id: shot.job.id, state: shot.job.state } : null,
        revision: shot.revision,
      })),
    })),
  }
}

export const getStoryTool = defineTool({
  name: 'get',
  title: 'Get the story board',
  description:
    'A film project’s story: the script (markdown), characters, scenes and every shot — code (scene.shot), who does what, seconds, its still and motion variants, cast, status, results and the newest job. The story is made on first open when you may write to it.',
  scope: 'story:read',
  input: z.object({ project_id: projectIdArg }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      (actor) => openStory(actor, args.project_id),
      (board) => ({
        text: board.story
          ? `“${board.story.title}”: ${board.scenes.length} scene(s), ${board.counts.shots} shot(s), ${board.counts.generated} with a result, ${board.runtimeS}s.`
          : 'No story yet.',
        data: boardOut(board),
      }),
    ),
})

export const saveScriptTool = defineTool({
  name: 'save_script',
  title: 'Save the script',
  description:
    'The story’s title, logline and script (markdown, replaced whole). Fields you leave out stay. Needs your policy to allow drafting.',
  scope: 'story:write',
  input: z.object({
    story_id: idArg('Story'),
    expected_revision: expectedRevisionArg,
    title: z.string().min(1).max(200).optional(),
    logline: z.string().max(1000).optional(),
    script: z.string().max(200000).optional(),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        saveStory(
          actor,
          defined({
            storyId: args.story_id,
            expectedRevision: args.expected_revision,
            title: args.title,
            logline: args.logline,
            script: args.script,
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof saveStory>[1],
        ),
      (story) => ({
        text: `Saved “${story.title}” (revision ${story.revision}).`,
        data: { story: storyOut(story) },
      }),
    ),
})

export const saveShotsTool = defineTool({
  name: 'save_shots',
  title: 'Lay out a scene’s shots',
  description:
    'A scene’s shots in one go: each with shot_id is changed, each without is added, and the scene is numbered in the order given. Name the scene by scene_id, or make one with new_scene. image_variant_id and video_variant_id are a prompt’s text_id (from prompts_get) — a prompt of this project, or a floating one; cast are character ids of this story. Needs your policy to allow drafting.',
  scope: 'story:write',
  input: z.object({
    story_id: idArg('Story'),
    scene_id: idArg('Scene').optional(),
    new_scene: z
      .object({
        heading: z.string().min(1).max(200),
        synopsis: z.string().max(4000).optional(),
      })
      .optional(),
    shots: z
      .array(
        z.object({
          shot_id: idArg('Shot').optional(),
          action: z.string().min(1).max(2000),
          duration_s: z
            .union([z.number().positive(), z.string().max(10)])
            .optional(),
          image_variant_id: idArg('Variant').nullable().optional(),
          video_variant_id: idArg('Variant').nullable().optional(),
          cast: z.array(idArg('Character')).max(20).optional(),
          notes: z.string().max(4000).optional(),
        }),
      )
      .min(1)
      .max(100),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      async (actor) => {
        let sceneId = args.scene_id
        if (!sceneId) {
          if (!args.new_scene)
            throw invalid('Name the scene, or make one with new_scene.')
          sceneId = (
            await saveScene(
              actor,
              defined({
                storyId: args.story_id,
                heading: args.new_scene.heading,
                synopsis: args.new_scene.synopsis,
              }) as Parameters<typeof saveScene>[1],
            )
          ).id
        }
        return saveShots(actor, {
          sceneId,
          idempotencyKey: args.idempotency_key,
          shots: args.shots.map(
            (shot) =>
              defined({
                shotId: shot.shot_id,
                action: shot.action,
                durationS: shot.duration_s,
                imageVariantId: shot.image_variant_id,
                videoVariantId: shot.video_variant_id,
                characterIds: shot.cast,
                notes: shot.notes,
              }) as { action: string },
          ),
        })
      },
      (shots) => ({
        text: `${shots.length} shot(s) saved.`,
        data: {
          shots: shots.map((shot) => ({
            id: shot.id,
            scene_id: shot.sceneId,
            number: shot.number,
            action: shot.action,
            duration_s: shot.durationS,
            status: shot.status,
            revision: shot.revision,
          })),
        },
      }),
    ),
})

export const story = defineWorkspace({
  id: 'story',
  label: 'Story',
  description: 'A film’s script, characters, scenes and shot board.',
  instructions:
    'Read with story_get. Write the script with story_save_script and lay out shots with story_save_shots. The owner generates each shot’s file and edits on their own machine.',
  tools: [getStoryTool, saveScriptTool, saveShotsTool],
})
