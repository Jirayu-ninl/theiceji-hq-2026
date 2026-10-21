import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { PROMPT_MEDIA, type PromptMedium } from '../enums'
import { inOwnProject, ownerColumn, trimmedLength } from './_module'
import { oneOf, tz } from './_shared'
import { tracked } from './_user'
import { assetAssets } from './assets'

/* ── prompts — the prompt library ───────────────────────
 *
 * A prompt is an intent ("a still for the listing cover") in one medium with
 * ONE text a generator runs — a template (2026-09-30): `<HAIR_COLOR>` marks a
 * slot, what the owner calls a variant, and each slot has options — a short
 * key picked by name and the value that goes into the text. A slot's options
 * are the prompt's own, the library's (`prompt_slots` with no prompt, shared
 * by every prompt that writes `<NAME>`), or both; a prompt's option with a
 * library option's key replaces it for that prompt. Copying fills every slot
 * with a picked option. The text's examples are assets that show what it
 * makes, each with the options it was made with (`prompt_example_picks`).
 *
 * The text keeps its old table, `prompt_variants`, one row per prompt: shots,
 * card links, generation jobs and examples point at it by id. Until
 * 2026-09-30 a prompt had several (A, B, C …, one the default); migration
 * 0005 moved each extra one into a prompt of its own.
 *
 * A prompt may float (no project) — the global route lists those — or live in
 * one project. `collection` is a free-form shelf name inside that scope.
 */

export const promptPrompts = pgTable(
  'prompt_prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    projectId: uuid('project_id'),
    title: text('title').notNull(),
    /** What it is for, in a sentence. */
    intent: text('intent').notNull().default(''),
    medium: text('medium').$type<PromptMedium>().notNull(),
    collection: text('collection'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    archivedAt: timestamp('archived_at', tz),
    /** In the Trash — always archived too, so reads that skip archived prompts skip it. */
    deletedAt: timestamp('deleted_at', tz),
  },
  (t) => [
    unique('prompt_prompts_owner_scope_key').on(t.id, t.ownerId),
    inOwnProject('prompt_prompts_project_fk', t),
    index('prompt_prompts_owner_idx').on(
      t.ownerId,
      t.projectId,
      t.archivedAt,
      t.updatedAt.desc(),
    ),
    index('prompt_prompts_tags_idx').using('gin', t.tags),
    check('prompt_prompts_title_check', trimmedLength(t.title, 160)),
    check('prompt_prompts_intent_check', sql`length(${t.intent}) <= 2000`),
    check(
      'prompt_prompts_deleted_check',
      sql`${t.deletedAt} is null or ${t.archivedAt} is not null`,
    ),
    check('prompt_prompts_medium_check', oneOf(t.medium, PROMPT_MEDIA)),
    check(
      'prompt_prompts_collection_check',
      sql`${t.collection} is null or length(btrim(${t.collection})) between 1 and 80`,
    ),
    check('prompt_prompts_tags_check', sql`cardinality(${t.tags}) <= 16`),
  ],
)

/** A prompt's text — one per prompt (`prompt_variants_one_key`); the name is historical. */
export const promptVariants = pgTable(
  'prompt_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    promptId: uuid('prompt_id').notNull(),
    /** `A` — from when a prompt had several texts; no longer shown. */
    label: text('label').notNull(),
    style: text('style').notNull().default(''),
    /** Which generator it was written for (`manual`, `openai`, an agent service). A hint, never a binding. */
    providerHint: text('provider_hint'),
    model: text('model'),
    text: text('text').notNull(),
    negativeText: text('negative_text').notNull().default(''),
    params: jsonb('params')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    position: integer('position').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [
    unique('prompt_variants_owner_scope_key').on(t.id, t.ownerId),
    foreignKey({
      name: 'prompt_variants_prompt_fk',
      columns: [t.promptId, t.ownerId],
      foreignColumns: [promptPrompts.id, promptPrompts.ownerId],
    }).onDelete('cascade'),
    uniqueIndex('prompt_variants_label_key').on(t.promptId, t.label),
    uniqueIndex('prompt_variants_default_key')
      .on(t.promptId)
      .where(sql`${t.isDefault}`),
    uniqueIndex('prompt_variants_one_key').on(t.promptId),
    index('prompt_variants_prompt_idx').on(t.promptId, t.position),
    check('prompt_variants_label_check', trimmedLength(t.label, 24)),
    check(
      'prompt_variants_text_check',
      sql`length(${t.text}) between 1 and 20000`,
    ),
    check(
      'prompt_variants_negative_check',
      sql`length(${t.negativeText}) <= 4000`,
    ),
    check('prompt_variants_style_check', sql`length(${t.style}) <= 200`),
    check(
      'prompt_variants_params_check',
      sql`jsonb_typeof(${t.params}) = 'object'`,
    ),
  ],
)

/** An asset that shows what a variant makes. */
export const promptExamples = pgTable(
  'prompt_examples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    variantId: uuid('variant_id').notNull(),
    assetId: uuid('asset_id').notNull(),
    caption: text('caption').notNull().default(''),
    rating: smallint('rating'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('prompt_examples_owner_scope_key').on(t.id, t.ownerId),
    foreignKey({
      name: 'prompt_examples_variant_fk',
      columns: [t.variantId, t.ownerId],
      foreignColumns: [promptVariants.id, promptVariants.ownerId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'prompt_examples_asset_fk',
      columns: [t.assetId, t.ownerId],
      foreignColumns: [assetAssets.id, assetAssets.ownerId],
    }).onDelete('cascade'),
    uniqueIndex('prompt_examples_asset_key').on(t.variantId, t.assetId),
    index('prompt_examples_asset_idx').on(t.assetId),
    check(
      'prompt_examples_rating_check',
      sql`${t.rating} is null or ${t.rating} between 1 and 5`,
    ),
    check('prompt_examples_caption_check', sql`length(${t.caption}) <= 300`),
  ],
)

/**
 * A slot — `<HAIR_COLOR>` in a text, what the owner calls a variant. With a
 * prompt it is that prompt's own; without one it is in the library, and
 * every prompt of the owner that writes `<NAME>` offers its options. Names
 * are unique in the library and inside a prompt; a prompt may have its own
 * slot with a library name, to add or replace options for itself.
 */
export const promptSlots = pgTable(
  'prompt_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tracked(),
    ownerId: ownerColumn(),
    /** The prompt it belongs to; null = the library. */
    promptId: uuid('prompt_id'),
    /** HAIR_COLOR — upper case, as written between `<` `>`. */
    name: text('name').notNull(),
    /** What it's for, in a line. */
    note: text('note').notNull().default(''),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    unique('prompt_slots_owner_scope_key').on(t.id, t.ownerId),
    foreignKey({
      name: 'prompt_slots_prompt_fk',
      columns: [t.promptId, t.ownerId],
      foreignColumns: [promptPrompts.id, promptPrompts.ownerId],
    }).onDelete('cascade'),
    uniqueIndex('prompt_slots_library_key')
      .on(t.ownerId, t.name)
      .where(sql`${t.promptId} is null`),
    uniqueIndex('prompt_slots_prompt_key')
      .on(t.promptId, t.name)
      .where(sql`${t.promptId} is not null`),
    check(
      'prompt_slots_name_check',
      sql`${t.name} ~ '^[A-Z][A-Z0-9_]{0,39}$'`,
    ),
    check('prompt_slots_note_check', sql`length(${t.note}) <= 300`),
  ],
)

/** One option of a slot: the key picked by name, the value put into the text. */
export const promptSlotOptions = pgTable(
  'prompt_slot_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: ownerColumn(),
    slotId: uuid('slot_id').notNull(),
    /** `punk` — short, unique inside the slot (any case). */
    key: text('key').notNull(),
    /** `black punk style with red highlight` — may be lines, may be empty. */
    value: text('value').notNull().default(''),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('prompt_slot_options_owner_scope_key').on(t.id, t.ownerId),
    foreignKey({
      name: 'prompt_slot_options_slot_fk',
      columns: [t.slotId, t.ownerId],
      foreignColumns: [promptSlots.id, promptSlots.ownerId],
    }).onDelete('cascade'),
    uniqueIndex('prompt_slot_options_key_key').on(t.slotId, sql`lower(${t.key})`),
    index('prompt_slot_options_slot_idx').on(t.slotId, t.position),
    check('prompt_slot_options_key_check', trimmedLength(t.key, 40)),
    check('prompt_slot_options_value_check', sql`length(${t.value}) <= 4000`),
  ],
)

/**
 * Which options an example was made with — one per slot name, as many slots
 * as the owner knows (the service keeps it one per name). Removing an option
 * removes its picks.
 */
export const promptExamplePicks = pgTable(
  'prompt_example_picks',
  {
    ownerId: ownerColumn(),
    exampleId: uuid('example_id').notNull(),
    optionId: uuid('option_id').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'prompt_example_picks_pkey',
      columns: [t.exampleId, t.optionId],
    }),
    foreignKey({
      name: 'prompt_example_picks_example_fk',
      columns: [t.exampleId, t.ownerId],
      foreignColumns: [promptExamples.id, promptExamples.ownerId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'prompt_example_picks_option_fk',
      columns: [t.optionId, t.ownerId],
      foreignColumns: [promptSlotOptions.id, promptSlotOptions.ownerId],
    }).onDelete('cascade'),
    index('prompt_example_picks_option_idx').on(t.optionId),
  ],
)

export type PromptRow = typeof promptPrompts.$inferSelect
export type PromptVariantRow = typeof promptVariants.$inferSelect
export type PromptExampleRow = typeof promptExamples.$inferSelect
export type PromptSlotRow = typeof promptSlots.$inferSelect
export type PromptSlotOptionRow = typeof promptSlotOptions.$inferSelect
export type PromptExamplePickRow = typeof promptExamplePicks.$inferSelect
