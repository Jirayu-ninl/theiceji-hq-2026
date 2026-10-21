import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { STORY_SHOT_STATUSES, type StoryShotStatus } from '../enums'
import { inOwnProject, ownerColumn, trimmedLength } from './_module'
import { oneOf, tz } from './_shared'
import { tracked } from './_user'
import { assetAssets } from './assets'
import { promptVariants } from './prompts'

/* ── story — a film's script, characters, scenes and shots ─
 *
 * · **A story belongs to a film project**: its script (markdown), the
 *   characters in it (each with a board image from Assets) and its scenes.
 * · **A shot is who does what**, for how long, drawn with a prompt variant
 *   for its still and one for its motion. Story requires Prompts and Assets
 *   (hq-core `MODULES.story.requires`), so a shot may name a variant
 *   directly; deleting the variant leaves the shot without one.
 * · **A shot's result is an asset** linked `asset —result_of→ shot` in `refs`
 *   by the generation job that made it (hq-assets). Its status moves
 *   boarded → generated → edited → done.
 * · **Editing is the owner's, on their own machine.** HQ ends at "every shot
 *   has its file" — and a scene's files as one ZIP from the local worker.
 */

export const storyStories = pgTable(
  'story_stories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id').notNull(),
    title: text('title').notNull(),
    logline: text('logline').notNull().default(''),
    /** Markdown. */
    script: text('script').notNull().default(''),
    position: integer('position').notNull().default(0),
    archivedAt: timestamp('archived_at', tz),
  },
  (t) => [
    unique('story_stories_owner_scope_key').on(t.id, t.ownerId),
    unique('story_stories_project_scope_key').on(t.id, t.projectId),
    inOwnProject('story_stories_project_fk', t),
    index('story_stories_owner_idx').on(t.ownerId, t.projectId, t.position),
    check('story_stories_title_check', trimmedLength(t.title, 200)),
    check('story_stories_logline_check', sql`length(${t.logline}) <= 1000`),
    check('story_stories_script_check', sql`length(${t.script}) <= 200000`),
  ],
)

export const storyCharacters = pgTable(
  'story_characters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    storyId: uuid('story_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** The character board: a ready image in Assets. */
    boardAssetId: uuid('board_asset_id'),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'story_characters_story_fk',
      columns: [t.storyId, t.ownerId],
      foreignColumns: [storyStories.id, storyStories.ownerId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'story_characters_board_fk',
      columns: [t.boardAssetId, t.ownerId],
      foreignColumns: [assetAssets.id, assetAssets.ownerId],
    }).onDelete('restrict'),
    index('story_characters_story_idx').on(t.storyId, t.position),
    check('story_characters_name_check', trimmedLength(t.name, 120)),
    check(
      'story_characters_description_check',
      sql`length(${t.description}) <= 4000`,
    ),
  ],
)

export const storyScenes = pgTable(
  'story_scenes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    storyId: uuid('story_id').notNull(),
    /** 1, 2, 3 … in story order; kept gapless by the service. */
    number: integer('number').notNull(),
    /** `INT. DESK — NIGHT` */
    heading: text('heading').notNull(),
    synopsis: text('synopsis').notNull().default(''),
  },
  (t) => [
    unique('story_scenes_story_scope_key').on(t.id, t.storyId),
    foreignKey({
      name: 'story_scenes_story_fk',
      columns: [t.storyId, t.ownerId],
      foreignColumns: [storyStories.id, storyStories.ownerId],
    }).onDelete('cascade'),
    index('story_scenes_story_idx').on(t.storyId, t.number),
    check('story_scenes_number_check', sql`${t.number} >= 1`),
    check('story_scenes_heading_check', trimmedLength(t.heading, 200)),
    check('story_scenes_synopsis_check', sql`length(${t.synopsis}) <= 4000`),
  ],
)

export const storyShots = pgTable(
  'story_shots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    /** The story's project, copied so a shot reads — and links — without its story. */
    projectId: uuid('project_id').notNull(),
    storyId: uuid('story_id').notNull(),
    sceneId: uuid('scene_id').notNull(),
    /** 1, 2, 3 … inside the scene; the board reads `scene.shot` (2.3). */
    number: integer('number').notNull(),
    /** Who does what. */
    action: text('action').notNull(),
    /** Seconds on screen. */
    durationS: numeric('duration_s', {
      precision: 6,
      scale: 2,
      mode: 'string',
    }),
    imageVariantId: uuid('image_variant_id').references(
      () => promptVariants.id,
      { onDelete: 'set null' },
    ),
    videoVariantId: uuid('video_variant_id').references(
      () => promptVariants.id,
      { onDelete: 'set null' },
    ),
    /** Who is in it — characters of the same story (checked by the service). */
    characterIds: uuid('character_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: text('status')
      .$type<StoryShotStatus>()
      .notNull()
      .default('boarded'),
    notes: text('notes').notNull().default(''),
  },
  (t) => [
    unique('story_shots_owner_scope_key').on(t.id, t.ownerId),
    foreignKey({
      name: 'story_shots_story_fk',
      columns: [t.storyId, t.projectId],
      foreignColumns: [storyStories.id, storyStories.projectId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'story_shots_scene_fk',
      columns: [t.sceneId, t.storyId],
      foreignColumns: [storyScenes.id, storyScenes.storyId],
    }).onDelete('cascade'),
    inOwnProject('story_shots_project_fk', t),
    index('story_shots_scene_idx').on(t.sceneId, t.number),
    index('story_shots_owner_idx').on(t.ownerId, t.projectId, t.status),
    check('story_shots_number_check', sql`${t.number} >= 1`),
    check('story_shots_status_check', oneOf(t.status, STORY_SHOT_STATUSES)),
    check('story_shots_action_check', trimmedLength(t.action, 2000)),
    check(
      'story_shots_duration_check',
      sql`${t.durationS} is null or ${t.durationS} > 0`,
    ),
    check('story_shots_notes_check', sql`length(${t.notes}) <= 4000`),
    check(
      'story_shots_cast_check',
      sql`cardinality(${t.characterIds}) <= 20`,
    ),
  ],
)

export type StoryRow = typeof storyStories.$inferSelect
export type StoryCharacterRow = typeof storyCharacters.$inferSelect
export type StorySceneRow = typeof storyScenes.$inferSelect
export type StoryShotRow = typeof storyShots.$inferSelect
