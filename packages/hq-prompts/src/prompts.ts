import { queueGeneration } from '@theiceji/hq-assets/generate'
import type { JobView } from '@theiceji/hq-assets/jobs'
import { link } from '@theiceji/hq-core/refs'
import { PROMPT_MEDIA, type PromptMedium } from '@theiceji/hq-db/enums'
import {
  type AssetRow,
  assetAssets,
  type ProjectRow,
  type PromptExampleRow,
  type PromptRow,
  type PromptSlotOptionRow,
  type PromptSlotRow,
  type PromptVariantRow,
  projects,
  promptExamplePicks,
  promptExamples,
  promptPrompts,
  promptSlotOptions,
  promptSlots,
  promptVariants,
  refs,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan } from '@theiceji/hq-ops/access'
import type { Reader, Tx } from '@theiceji/hq-ops/db'
import {
  conflict,
  forbidden,
  invalid,
  notFound,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  choice,
  idempotencyKey,
  optionalChoice,
  parseInput,
  recordId,
  revision,
  stringList,
  text,
} from '@theiceji/hq-ops/schemas'
import {
  assertModuleOn,
  audit,
  authorize,
  ownedProject,
  ownedRecord,
  ownedRow,
  returned,
  runOperation,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { z } from 'zod'
import { fillSlots, SLOT_NAME, slotNames } from './template'

/**
 * Prompts: the library of prompts, each an intent in one
 * medium with one text — a template whose `<SLOTS>` (what the owner calls
 * variants) are filled from options when it is copied or run — and example
 * assets showing what it makes.
 *
 * · **A prompt may float.** With no project it belongs to the owner and shows
 *   on the all-projects page; in a project it needs Prompts on there.
 * · **One text** (`prompt_variants`, one row per prompt since 2026-09-30):
 *   style, model hint, negative text and parameters live with it. Shots, card
 *   links, generation jobs and examples point at the text's id.
 * · **Slots.** `<HAIR_COLOR>` in the text (or the negative text) is a slot;
 *   its options are the prompt's own, the library's — slots with no prompt,
 *   shared by every prompt of the owner that writes `<NAME>` — or both. A
 *   prompt's option with a library option's key replaces it for that prompt.
 *   A text is filled only with every slot in it picked (`fillPrompt`).
 * · **Examples are ready assets** of the owner — the prompt's project's, or
 *   floating ones — each with the options it was made with (its picks, one
 *   per slot, as many slots as known). Each is also a `refs` edge (asset →
 *   text, `example_of`), so the project map can draw it.
 * · Agents write drafts under the owner's policy (`draft`); nothing here
 *   generates or spends — that's Assets' generation jobs.
 * · **Removing is the owner's**: Archive puts a finished
 *   prompt away; Delete sends it to the Trash — archived too, so every read
 *   that skips archived prompts skips it — and Restore brings it back. An
 *   agent never sees the Trash: a deleted prompt reads as not found.
 */

registerConstraintMessages({
  prompt_variants_label_key: 'A prompt has one text.',
  prompt_variants_default_key: conflict().message,
  prompt_variants_one_key: 'A prompt has one text.',
  prompt_examples_asset_key: 'That asset is already an example of this prompt.',
  prompt_prompts_deleted_check: 'Only an archived prompt can be in the Trash.',
  prompt_slots_library_key: 'The library already has a variant with that name.',
  prompt_slots_prompt_key: 'This prompt already has a variant with that name.',
  prompt_slots_name_check:
    'A variant’s name is upper case — letters, digits and _, starting with a letter: HAIR_COLOR.',
  prompt_slot_options_key_key: 'Two options of one variant can’t share a key.',
  prompt_slot_options_key_check:
    'An option needs a key of 40 characters or fewer.',
})

/** Where a prompt is: in the library, put away, or in the Trash. */
export const PROMPT_BUCKETS = ['live', 'archived', 'trash'] as const
export type PromptBucket = (typeof PROMPT_BUCKETS)[number]

/** A person reads the Trash in HQ; an agent is never shown it. */
const seesTrash = (actor: Actor) => actor.type === 'user'

/* ── Shapes ─────────────────────────────────────────────────────────── */

export type ExampleView = PromptExampleRow & {
  asset: Pick<
    AssetRow,
    | 'id'
    | 'name'
    | 'title'
    | 'kind'
    | 'mime'
    | 'status'
    | 'width'
    | 'height'
    | 'durationMs'
    | 'storageProvider'
    | 'storageKey'
    | 'thumbKey'
    | 'ownerId'
    | 'projectId'
  >
  /** The options it was made with: slot name → option id (as the prompt offers it). */
  picks: Record<string, string>
}

/** The prompt's text — its template, negative text, hints and parameters — and its examples. */
export type TextView = PromptVariantRow & { examples: ExampleView[] }

/** An option as a prompt offers it. */
export type OptionView = Pick<
  PromptSlotOptionRow,
  'id' | 'key' | 'value' | 'position'
> & {
  /** The library's, or the prompt's own. */
  from: 'library' | 'prompt'
  /** The library option with the same key this prompt option replaces. */
  replaces: string | null
}

/** A slot as a prompt offers it: its own options and the library's, merged. */
export type SlotView = {
  name: string
  /** In the text or the negative text — a slot to pick before copying. */
  inText: boolean
  /** The prompt's own slot row, when it has one. */
  promptSlotId: string | null
  /** The library's slot of that name, when there is one. */
  librarySlotId: string | null
  note: string
  options: OptionView[]
}

export type PromptView = PromptRow & {
  project: Pick<
    ProjectRow,
    'id' | 'slug' | 'name' | 'color' | 'status' | 'kind'
  > | null
  /** Null until the prompt has a text. */
  text: TextView | null
  slots: SlotView[]
}

export type PromptListItem = PromptRow & {
  project: PromptView['project']
  exampleCount: number
  text: Pick<PromptVariantRow, 'id' | 'text' | 'negativeText'> | null
  /** The slots written in the text, in order. */
  slotNames: string[]
  /** Up to three example assets for the card's tiles. */
  previews: ExampleView['asset'][]
}

/** A slot in the library with its options, and how many prompts write it. */
export type LibrarySlotView = PromptSlotRow & {
  options: PromptSlotOptionRow[]
  usedBy: number
}

const normalizeTags = (raw: readonly string[]) => {
  const out: string[] = []
  for (const entry of raw) {
    const tag = entry.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 32)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out.slice(0, 16)
}

const assetColumns = {
  id: assetAssets.id,
  name: assetAssets.name,
  title: assetAssets.title,
  kind: assetAssets.kind,
  mime: assetAssets.mime,
  status: assetAssets.status,
  width: assetAssets.width,
  height: assetAssets.height,
  durationMs: assetAssets.durationMs,
  storageProvider: assetAssets.storageProvider,
  storageKey: assetAssets.storageKey,
  thumbKey: assetAssets.thumbKey,
  ownerId: assetAssets.ownerId,
  projectId: assetAssets.projectId,
}

const projectColumns = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  color: projects.color,
  status: projects.status,
  kind: projects.kind,
}

/* ── Reading ────────────────────────────────────────────────────────── */

const listSchema = z.object({
  /** A project; `null` for the floating prompts; absent for everything. */
  projectId: z.uuid().nullable().optional(),
  medium: optionalChoice(PROMPT_MEDIA, 'Choose a medium.'),
  collection: z.string().trim().max(80).optional(),
  tag: z.string().trim().toLowerCase().max(32).optional(),
  query: z.string().trim().max(200).optional(),
  /** The library (the default — what every picker lists), Archived, or the Trash. */
  bucket: z.enum(PROMPT_BUCKETS).optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

export type ListPromptsInput = z.input<typeof listSchema>

/**
 * Prompts, most recently changed first: one project's, the floating ones, or
 * all of them in projects with Prompts on plus the floating ones. Each comes
 * with its text, the slots written in it and up to three example tiles.
 * Archived lists the prompts put away (not deleted), newest first; the
 * Trash, the deleted ones.
 */
export async function listPrompts(
  actor: Actor,
  raw: ListPromptsInput = {},
): Promise<{ prompts: PromptListItem[]; total: number }> {
  const input = parseInput(listSchema, raw)
  const bucket = input.bucket ?? 'live'
  if (bucket === 'trash' && !seesTrash(actor))
    throw forbidden('The Trash is the owner’s, in HQ.')
  return withReader(async (db) => {
    if (input.projectId) {
      const project = await ownedProject(
        db,
        actor,
        input.projectId,
        'prompts',
        'read',
      )
      assertModuleOn(project, 'prompts')
    } else await authorize(db, actor, null, 'prompts', 'read')
    const words = (input.query ?? '').split(/\s+/).filter(Boolean)
    const where = and(
      eq(promptPrompts.ownerId, actor.userId),
      input.projectId === null
        ? isNull(promptPrompts.projectId)
        : input.projectId
          ? eq(promptPrompts.projectId, input.projectId)
          : sql`(${promptPrompts.projectId} is null or (${projects.status} <> 'archived' and ${projects.modules} -> 'enabled' ? 'prompts'))`,
      input.medium ? eq(promptPrompts.medium, input.medium) : undefined,
      input.collection
        ? sql`lower(${promptPrompts.collection}) = lower(${input.collection})`
        : undefined,
      input.tag ? sql`${input.tag} = any(${promptPrompts.tags})` : undefined,
      bucket === 'trash'
        ? isNotNull(promptPrompts.deletedAt)
        : bucket === 'archived'
          ? and(
              isNotNull(promptPrompts.archivedAt),
              isNull(promptPrompts.deletedAt),
            )
          : isNull(promptPrompts.archivedAt),
      ...words.map((word) => {
        const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        return or(
          ilike(promptPrompts.title, like),
          ilike(promptPrompts.intent, like),
          sql`exists (select 1 from ${promptVariants} where ${promptVariants.promptId} = ${promptPrompts.id} and ${promptVariants.text} ilike ${like})`,
        )
      }),
    )
    const [rows, [total]] = await Promise.all([
      db
        .select({ prompt: promptPrompts, project: projectColumns })
        .from(promptPrompts)
        .leftJoin(projects, eq(projects.id, promptPrompts.projectId))
        .where(where)
        .orderBy(
          desc(
            bucket === 'trash'
              ? promptPrompts.deletedAt
              : bucket === 'archived'
                ? promptPrompts.archivedAt
                : promptPrompts.updatedAt,
          ),
          desc(promptPrompts.updatedAt),
        )
        .limit(input.limit ?? 200),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(promptPrompts)
        .leftJoin(projects, eq(projects.id, promptPrompts.projectId))
        .where(where),
    ])
    const ids = rows.map((row) => row.prompt.id)
    const [texts, examples] = ids.length
      ? await Promise.all([
          db
            .select({
              id: promptVariants.id,
              promptId: promptVariants.promptId,
              text: promptVariants.text,
              negativeText: promptVariants.negativeText,
            })
            .from(promptVariants)
            .where(inArray(promptVariants.promptId, ids)),
          db
            .select({
              promptId: promptVariants.promptId,
              example: promptExamples,
              asset: assetColumns,
            })
            .from(promptExamples)
            .innerJoin(
              promptVariants,
              eq(promptVariants.id, promptExamples.variantId),
            )
            .innerJoin(assetAssets, eq(assetAssets.id, promptExamples.assetId))
            .where(
              and(
                inArray(promptVariants.promptId, ids),
                eq(assetAssets.status, 'ready'),
              ),
            )
            .orderBy(
              asc(promptExamples.position),
              asc(promptExamples.createdAt),
            ),
        ])
      : [[], []]
    return {
      prompts: rows.map((row) => {
        const own = texts.find((entry) => entry.promptId === row.prompt.id)
        const shown = examples.filter(
          (entry) => entry.promptId === row.prompt.id,
        )
        return {
          ...row.prompt,
          project: row.project?.id ? row.project : null,
          exampleCount: shown.length,
          text: own
            ? { id: own.id, text: own.text, negativeText: own.negativeText }
            : null,
          slotNames: own ? slotNames(own.text, own.negativeText) : [],
          previews: shown.slice(0, 3).map((entry) => entry.asset),
        }
      }),
      total: total?.n ?? 0,
    }
  })
}

type SlotWithOptions = PromptSlotRow & { options: PromptSlotOptionRow[] }

async function slotsWithOptions(
  db: Reader,
  where: ReturnType<typeof and>,
): Promise<SlotWithOptions[]> {
  const slots = await db
    .select()
    .from(promptSlots)
    .where(where)
    .orderBy(asc(promptSlots.position), asc(promptSlots.name))
  const options = slots.length
    ? await db
        .select()
        .from(promptSlotOptions)
        .where(
          inArray(
            promptSlotOptions.slotId,
            slots.map((slot) => slot.id),
          ),
        )
        .orderBy(asc(promptSlotOptions.position), asc(promptSlotOptions.key))
    : []
  return slots.map((slot) => ({
    ...slot,
    options: options.filter((option) => option.slotId === slot.id),
  }))
}

/**
 * The slots a prompt offers: those written in its text, in order, then its
 * own that the text no longer writes. Each merges the library's options with
 * the prompt's own — a prompt option with a library key takes its place.
 */
export function mergeSlots(
  text: Pick<PromptVariantRow, 'text' | 'negativeText'> | null,
  own: SlotWithOptions[],
  library: SlotWithOptions[],
): SlotView[] {
  const written = slotNames(text?.text, text?.negativeText)
  const names = [
    ...written,
    ...own.map((slot) => slot.name).filter((name) => !written.includes(name)),
  ]
  return names.map((name) => {
    const mine = own.find((slot) => slot.name === name) ?? null
    const shared = library.find((slot) => slot.name === name) ?? null
    const options: OptionView[] = []
    const pick = (option: PromptSlotOptionRow) => ({
      id: option.id,
      key: option.key,
      value: option.value,
      position: option.position,
    })
    for (const option of shared?.options ?? []) {
      const over = mine?.options.find(
        (entry) => entry.key.toLowerCase() === option.key.toLowerCase(),
      )
      options.push(
        over
          ? { ...pick(over), from: 'prompt', replaces: option.id }
          : { ...pick(option), from: 'library', replaces: null },
      )
    }
    for (const option of mine?.options ?? [])
      if (!options.some((entry) => entry.id === option.id))
        options.push({ ...pick(option), from: 'prompt', replaces: null })
    return {
      name,
      inText: written.includes(name),
      promptSlotId: mine?.id ?? null,
      librarySlotId: shared?.id ?? null,
      note: mine?.note || shared?.note || '',
      options,
    }
  })
}

async function readPrompt(
  db: Reader,
  prompt: PromptRow,
): Promise<{ text: TextView | null; slots: SlotView[] }> {
  const [row] = await db
    .select()
    .from(promptVariants)
    .where(eq(promptVariants.promptId, prompt.id))
    .limit(1)
  const own = await slotsWithOptions(
    db,
    and(
      eq(promptSlots.ownerId, prompt.ownerId),
      eq(promptSlots.promptId, prompt.id),
    ),
  )
  const names = [
    ...slotNames(row?.text, row?.negativeText),
    ...own.map((slot) => slot.name),
  ]
  const library = names.length
    ? await slotsWithOptions(
        db,
        and(
          eq(promptSlots.ownerId, prompt.ownerId),
          isNull(promptSlots.promptId),
          inArray(promptSlots.name, names),
        ),
      )
    : []
  const slots = mergeSlots(row ?? null, own, library)
  if (!row) return { text: null, slots }
  const examples = await db
    .select({ example: promptExamples, asset: assetColumns })
    .from(promptExamples)
    .innerJoin(assetAssets, eq(assetAssets.id, promptExamples.assetId))
    .where(eq(promptExamples.variantId, row.id))
    .orderBy(asc(promptExamples.position), asc(promptExamples.createdAt))
  const picks = examples.length
    ? await db
        .select({
          exampleId: promptExamplePicks.exampleId,
          optionId: promptExamplePicks.optionId,
          name: promptSlots.name,
        })
        .from(promptExamplePicks)
        .innerJoin(
          promptSlotOptions,
          eq(promptSlotOptions.id, promptExamplePicks.optionId),
        )
        .innerJoin(promptSlots, eq(promptSlots.id, promptSlotOptions.slotId))
        .where(
          inArray(
            promptExamplePicks.exampleId,
            examples.map((entry) => entry.example.id),
          ),
        )
    : []
  // A pick of a library option this prompt replaces reads as the replacement.
  const replaced = new Map(
    slots.flatMap((slot) =>
      slot.options
        .filter((option) => option.replaces)
        .map((option) => [option.replaces as string, option.id] as const),
    ),
  )
  return {
    slots,
    text: {
      ...row,
      examples: examples.map((entry) => ({
        ...entry.example,
        asset: entry.asset,
        picks: Object.fromEntries(
          picks
            .filter((pick) => pick.exampleId === entry.example.id)
            .map((pick) => [
              pick.name,
              replaced.get(pick.optionId) ?? pick.optionId,
            ]),
        ),
      })),
    },
  }
}

/**
 * One prompt with its text, its examples and every slot it offers. A deleted
 * one is the owner's to read in the Trash; to an agent it isn't there.
 */
export async function getPrompt(
  actor: Actor,
  promptId: string,
): Promise<PromptView> {
  return withReader(async (db) => {
    const { row: prompt, project } = await ownedRecord<PromptRow>(
      db,
      actor,
      promptPrompts,
      promptId,
      'prompts',
      'read',
      'Prompt',
    )
    if (prompt.deletedAt && !seesTrash(actor)) throw notFound('Prompt')
    return {
      ...prompt,
      project: project
        ? {
            id: project.id,
            slug: project.slug,
            name: project.name,
            color: project.color,
            status: project.status,
            kind: project.kind,
          }
        : null,
      ...(await readPrompt(db, prompt)),
    }
  })
}

/**
 * The prompt's text with every slot in it filled from `picks` (slot name →
 * option id or key). `missing` names the slots still to pick; the text is
 * whole only when it is empty.
 */
export function fillPrompt(
  prompt: Pick<PromptView, 'text' | 'slots'>,
  picks: Readonly<Record<string, string>>,
): {
  text: string
  negativeText: string
  missing: string[]
  /** Picks that name no slot or option of this prompt. */
  unknown: string[]
  /** The option each slot was filled with. */
  options: Record<string, OptionView>
} {
  const values: Record<string, string> = {}
  const options: Record<string, OptionView> = {}
  const unknown: string[] = []
  for (const [name, ref] of Object.entries(picks)) {
    const slot = prompt.slots.find((entry) => entry.name === name)
    const option = slot ? optionOf(slot, ref) : null
    if (!option) {
      unknown.push(name)
      continue
    }
    values[name] = option.value
    options[name] = option
  }
  const missing = prompt.slots
    .filter((slot) => slot.inText && !Object.hasOwn(values, slot.name))
    .map((slot) => slot.name)
  return {
    text: fillSlots(prompt.text?.text ?? '', values),
    negativeText: fillSlots(prompt.text?.negativeText ?? '', values),
    missing,
    unknown,
    options,
  }
}

/** An option of a slot by id (or the library id it replaces) or by key, any case. */
function optionOf(slot: SlotView, ref: string): OptionView | null {
  const key = ref.trim().toLowerCase()
  return (
    slot.options.find((option) => option.id === ref) ??
    slot.options.find((option) => option.replaces === ref) ??
    slot.options.find((option) => option.key.toLowerCase() === key) ??
    null
  )
}

/** The collections in use in a scope — for the filter. */
export async function promptCollections(
  actor: Actor,
  projectId: string | null | undefined,
): Promise<{ name: string; count: number }[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'prompts', 'read')
    const rows = await db
      .select({
        name: sql<string>`min(${promptPrompts.collection})`,
        count: sql<number>`count(*)::int`,
      })
      .from(promptPrompts)
      .where(
        and(
          eq(promptPrompts.ownerId, actor.userId),
          isNull(promptPrompts.archivedAt),
          sql`${promptPrompts.collection} is not null`,
          projectId === null
            ? isNull(promptPrompts.projectId)
            : projectId
              ? eq(promptPrompts.projectId, projectId)
              : undefined,
        ),
      )
      .groupBy(sql`lower(${promptPrompts.collection})`)
      .orderBy(sql`min(${promptPrompts.collection})`)
    return rows
  })
}

/* ── Slots: shapes shared by a prompt's own and the library's ─────────── */

const optionSchema = z.object({
  id: z.uuid().optional(),
  key: text.required('Option key', 40),
  value: z.string().max(4000, 'A value must be 4000 characters or fewer.'),
})

const slotSchema = z.object({
  id: z.uuid().optional(),
  name: z
    .string()
    .trim()
    .regex(
      SLOT_NAME,
      'A variant’s name is upper case — letters, digits and _, starting with a letter: HAIR_COLOR.',
    ),
  note: z.string().trim().max(300).optional(),
  options: z.array(optionSchema).max(100),
})

export type SlotInput = z.input<typeof slotSchema>

/**
 * Give each input without an id the id of the existing row it names (same
 * name or key, any case) unless another input claims that row by id — so a
 * save that names things instead of ids (an agent's) keeps them, and the
 * picks of their options.
 */
function claim<T extends { id?: string | undefined }, R extends { id: string }>(
  inputs: T[],
  existing: R[],
  same: (input: T, row: R) => boolean,
): T[] {
  const claimed = new Set(inputs.flatMap((input) => input.id ?? []))
  return inputs.map((input) => {
    if (input.id) return input
    const row = existing.find(
      (entry) => !claimed.has(entry.id) && same(input, entry),
    )
    if (!row) return input
    claimed.add(row.id)
    return { ...input, id: row.id }
  })
}

/** A slot's options become exactly these, in this order: kept (by id or key), added, the rest removed. */
async function writeOptions(
  tx: Tx,
  actor: Actor,
  slot: PromptSlotRow,
  raw: z.output<typeof optionSchema>[],
): Promise<void> {
  const keys = raw.map((option) => (option.key as string).toLowerCase())
  const twice = keys.find((key, index) => keys.indexOf(key) !== index)
  if (twice)
    throw invalid(`${slot.name} has two options with the key “${twice}”.`)
  const existing = await tx
    .select()
    .from(promptSlotOptions)
    .where(eq(promptSlotOptions.slotId, slot.id))
  const inputs = claim(
    raw,
    existing,
    (input, row) =>
      row.key.toLowerCase() === (input.key as string).toLowerCase(),
  )
  const kept = inputs.flatMap((option) => (option.id ? [option.id] : []))
  for (const id of kept)
    if (!existing.some((option) => option.id === id)) throw notFound('Option')
  if (existing.length)
    await tx
      .delete(promptSlotOptions)
      .where(
        and(
          eq(promptSlotOptions.slotId, slot.id),
          kept.length ? notInArray(promptSlotOptions.id, kept) : undefined,
        ),
      )
  for (const [position, option] of inputs.entries()) {
    if (option.id) {
      await tx
        .update(promptSlotOptions)
        .set({
          key: option.key as string,
          value: option.value,
          position,
          updatedAt: sql`now()`,
        })
        .where(eq(promptSlotOptions.id, option.id))
      continue
    }
    await tx.insert(promptSlotOptions).values({
      ownerId: actor.userId,
      slotId: slot.id,
      key: option.key as string,
      value: option.value,
      position,
    })
  }
}

/** A prompt's own slots become exactly these: kept (by id or name), added, the rest removed (their picks too). */
async function writeOwnSlots(
  tx: Tx,
  actor: Actor,
  prompt: PromptRow,
  raw: z.output<typeof slotSchema>[],
): Promise<void> {
  const names = raw.map((slot) => slot.name)
  const twice = names.find((name, index) => names.indexOf(name) !== index)
  if (twice) throw invalid(`Two variants are called ${twice}.`)
  const existing = await tx
    .select()
    .from(promptSlots)
    .where(eq(promptSlots.promptId, prompt.id))
  const inputs = claim(raw, existing, (input, row) => row.name === input.name)
  const kept = inputs.flatMap((slot) => (slot.id ? [slot.id] : []))
  for (const id of kept)
    if (!existing.some((slot) => slot.id === id)) throw notFound('Variant')
  if (existing.length)
    await tx
      .delete(promptSlots)
      .where(
        and(
          eq(promptSlots.promptId, prompt.id),
          kept.length ? notInArray(promptSlots.id, kept) : undefined,
        ),
      )
  for (const [position, input] of inputs.entries()) {
    let slot: PromptSlotRow
    if (input.id) {
      const [row] = await tx
        .update(promptSlots)
        .set({
          name: input.name,
          note: input.note ?? '',
          position,
          revision: sql`${promptSlots.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(promptSlots.id, input.id))
        .returning()
      slot = returned(row)
    } else {
      const [row] = await tx
        .insert(promptSlots)
        .values({
          ownerId: actor.userId,
          createdBy: actor.userId,
          promptId: prompt.id,
          name: input.name,
          note: input.note ?? '',
          position,
        })
        .returning()
      slot = returned(row)
    }
    await writeOptions(tx, actor, slot, input.options)
  }
}

/* ── Writing a prompt ───────────────────────────────────────────────── */

/** What the text row holds; a key left out stays as it is. */
const textFields = {
  text: text.required('Prompt text', 20000).optional(),
  negativeText: z.string().max(4000).optional(),
  style: z.string().trim().max(200).optional(),
  providerHint: text.optional('Provider hint', 80),
  model: text.optional('Model', 120),
  params: z.record(z.string(), z.unknown()).optional(),
}

type TextInput = {
  text?: string | undefined
  negativeText?: string | undefined
  style?: string | undefined
  providerHint?: string | null | undefined
  model?: string | null | undefined
  params?: Record<string, unknown> | undefined
}

const saveSchema = z.object({
  promptId: z.uuid().optional(),
  expectedRevision: revision.optional(),
  projectId: z.uuid().nullable().optional(),
  title: text.required('Title', 160),
  intent: z.string().trim().max(2000).optional(),
  medium: choice(PROMPT_MEDIA, 'Choose image, video, text or audio.'),
  collection: text.optional('Collection', 80),
  tags: stringList('tags', 16, 32).optional(),
  ...textFields,
  /** The prompt's own variants, the whole set: one left out goes, with its options and the picks of them. */
  slots: z.array(slotSchema).max(40).optional(),
  idempotencyKey: idempotencyKey.optional(),
})

export type SavePromptInput = z.input<typeof saveSchema>

async function scopeFor(
  tx: Tx,
  actor: Actor,
  projectId: string | null | undefined,
): Promise<ProjectRow | null> {
  if (!projectId) {
    await authorize(tx, actor, null, 'prompts', 'write')
    return null
  }
  const project = await ownedProject(tx, actor, projectId, 'prompts', 'write')
  assertModuleOn(project, 'prompts')
  return project
}

const hasText = (input: TextInput) =>
  (Object.keys(textFields) as (keyof TextInput)[]).some(
    (key) => input[key] !== undefined,
  )

/** Write the prompt's text: change the one it has, or give it one. */
async function writeText(
  tx: Tx,
  actor: Actor,
  prompt: PromptRow,
  input: TextInput,
): Promise<PromptVariantRow | null> {
  if (!hasText(input)) return null
  const [current] = await tx
    .select()
    .from(promptVariants)
    .where(eq(promptVariants.promptId, prompt.id))
    .limit(1)
  if (current) {
    const [row] = await tx
      .update(promptVariants)
      .set({
        text: input.text ?? current.text,
        negativeText: input.negativeText ?? current.negativeText,
        style: input.style ?? current.style,
        providerHint:
          input.providerHint !== undefined
            ? input.providerHint
            : current.providerHint,
        model: input.model !== undefined ? input.model : current.model,
        params: input.params ?? current.params,
        revision: sql`${promptVariants.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(promptVariants.id, current.id))
      .returning()
    return returned(row)
  }
  if (!input.text) throw invalid('Write the prompt’s text first.')
  const [row] = await tx
    .insert(promptVariants)
    .values({
      ownerId: actor.userId,
      createdBy: actor.userId,
      promptId: prompt.id,
      label: 'A',
      style: input.style ?? '',
      providerHint: input.providerHint ?? null,
      model: input.model ?? null,
      text: input.text,
      negativeText: input.negativeText ?? '',
      params: input.params ?? {},
      position: 0,
      isDefault: true,
    })
    .returning()
  return returned(row)
}

/**
 * A new prompt, inside the caller's transaction — for `savePrompt` and the
 * target registry (a note promoted to a prompt, an agent's alternative).
 */
export async function insertPrompt(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  input: TextInput & {
    title: string
    intent?: string | null
    medium: PromptMedium
    collection?: string | null
    tags?: string[]
    slots?: z.output<typeof slotSchema>[]
  },
): Promise<PromptRow> {
  if (project) assertModuleOn(project, 'prompts')
  const [row] = await tx
    .insert(promptPrompts)
    .values({
      ownerId: actor.userId,
      createdBy: actor.userId,
      projectId: project?.id ?? null,
      title: input.title,
      intent: input.intent ?? '',
      medium: input.medium,
      collection: input.collection ?? null,
      tags: normalizeTags(input.tags ?? []),
    })
    .returning()
  const prompt = returned(row)
  await writeText(tx, actor, prompt, input)
  if (input.slots?.length) await writeOwnSlots(tx, actor, prompt, input.slots)
  await audit(tx, actor, {
    projectId: prompt.projectId,
    action: 'prompt.create',
    targetType: 'prompt',
    targetId: prompt.id,
    afterRevision: prompt.revision,
    changes: {
      title: prompt.title,
      medium: prompt.medium,
      text: Boolean(input.text),
      slots: input.slots?.length ?? 0,
    },
  })
  return prompt
}

/**
 * Another text for an existing prompt — an agent's accepted proposal — is a
 * prompt of its own beside it (a prompt has one text): the same project,
 * medium, intent, collection and tags, titled `<title> · <style or "alt">`.
 * Answers the new text, which the proposal links to.
 */
export async function insertAlternative(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  prompt: PromptRow,
  input: TextInput & { text: string },
): Promise<PromptVariantRow> {
  const suffix = (input.style?.trim() || 'alt').slice(0, 40)
  const fresh = await insertPrompt(tx, actor, project, {
    ...input,
    title: `${prompt.title.slice(0, 157 - suffix.length)} · ${suffix}`,
    intent: prompt.intent,
    medium: prompt.medium,
    collection: prompt.collection,
    tags: prompt.tags,
  })
  const [row] = await tx
    .select()
    .from(promptVariants)
    .where(eq(promptVariants.promptId, fresh.id))
    .limit(1)
  return returned(row)
}

/**
 * Create a prompt, or change one (`promptId` + `expectedRevision`): its
 * details, its text (a key left out stays) and — when sent — its own
 * variants, the whole set. A prompt can move between projects (or float)
 * only by the owner in HQ — not here.
 */
export async function savePrompt(
  actor: Actor,
  raw: SavePromptInput,
): Promise<PromptView> {
  const input = parseInput(saveSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'prompts_save',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        if (!input.promptId) {
          const project = await scopeFor(tx, actor, input.projectId)
          return insertPrompt(tx, actor, project, {
            ...input,
            title: input.title as string,
            text: input.text as string | undefined,
          })
        }
        assertCan(actor, 'prompts', 'write')
        const { row: prompt, project } = await ownedRow<PromptRow>(
          tx,
          actor,
          promptPrompts,
          input.promptId,
          'Prompt',
          { lock: true },
        )
        await authorize(tx, actor, project, 'prompts', 'write')
        if (project) assertModuleOn(project, 'prompts')
        if (prompt.deletedAt && !seesTrash(actor)) throw notFound('Prompt')
        if (
          input.expectedRevision === undefined ||
          prompt.revision !== input.expectedRevision
        )
          throw conflict()
        if (prompt.archivedAt)
          throw invalid('This prompt is archived. Restore it to change it.')
        const [row] = await tx
          .update(promptPrompts)
          .set({
            title: input.title as string,
            ...(input.intent !== undefined ? { intent: input.intent } : {}),
            medium: input.medium,
            ...(input.collection !== undefined
              ? { collection: input.collection ?? null }
              : {}),
            ...(input.tags !== undefined
              ? { tags: normalizeTags(input.tags) }
              : {}),
            revision: sql`${promptPrompts.revision} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(promptPrompts.id, prompt.id),
              eq(promptPrompts.revision, prompt.revision),
            ),
          )
          .returning()
        const saved = returned(row)
        const written = await writeText(tx, actor, saved, {
          ...input,
          text: input.text as string | undefined,
        })
        if (input.slots) await writeOwnSlots(tx, actor, saved, input.slots)
        await audit(tx, actor, {
          projectId: saved.projectId,
          action: 'prompt.update',
          targetType: 'prompt',
          targetId: saved.id,
          beforeRevision: prompt.revision,
          afterRevision: saved.revision,
          changes: {
            title: saved.title,
            text: Boolean(written),
            ...(input.slots ? { slots: input.slots.length } : {}),
          },
        })
        return saved
      }),
  )
  const id =
    outcome.kind === 'replay' ? outcome.response?.prompt_id : outcome.value.id
  if (typeof id !== 'string') throw conflict()
  if (outcome.kind === 'fresh') await outcome.complete({ prompt_id: id })
  return getPrompt(actor, id)
}

/** A prompt to change something of (its examples, its picks), with its text. */
async function promptForWrite(
  tx: Tx,
  actor: Actor,
  promptId: string,
): Promise<{
  prompt: PromptRow
  text: PromptVariantRow | null
  project: ProjectRow | null
}> {
  assertCan(actor, 'prompts', 'write')
  const { row: prompt, project } = await ownedRow<PromptRow>(
    tx,
    actor,
    promptPrompts,
    promptId,
    'Prompt',
  )
  // A deleted prompt takes no new example or pick: to an agent it isn't
  // there; the owner restores it first.
  if (prompt.deletedAt) {
    if (!seesTrash(actor)) throw notFound('Prompt')
    throw invalid('This prompt is in the Trash. Restore it to change it.')
  }
  await authorize(tx, actor, project, 'prompts', 'write')
  if (project) assertModuleOn(project, 'prompts')
  const [text] = await tx
    .select()
    .from(promptVariants)
    .where(eq(promptVariants.promptId, prompt.id))
    .limit(1)
  return { prompt, text: text ?? null, project }
}

/* ── The library of variants ────────────────────────────────────────── */

/** The library: slots every prompt of the owner can write, with how many do. */
export async function listLibrarySlots(
  actor: Actor,
): Promise<LibrarySlotView[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'prompts', 'read')
    const slots = await slotsWithOptions(
      db,
      and(eq(promptSlots.ownerId, actor.userId), isNull(promptSlots.promptId)),
    )
    if (!slots.length) return []
    const used = await db
      .select({
        name: promptSlots.name,
        n: sql<number>`count(distinct ${promptVariants.promptId})::int`,
      })
      .from(promptSlots)
      .innerJoin(
        promptVariants,
        and(
          eq(promptVariants.ownerId, promptSlots.ownerId),
          sql`(strpos(${promptVariants.text}, '<' || ${promptSlots.name} || '>') > 0 or strpos(${promptVariants.negativeText}, '<' || ${promptSlots.name} || '>') > 0)`,
        ),
      )
      .innerJoin(promptPrompts, eq(promptPrompts.id, promptVariants.promptId))
      .where(
        and(
          eq(promptSlots.ownerId, actor.userId),
          isNull(promptSlots.promptId),
          isNull(promptPrompts.deletedAt),
        ),
      )
      .groupBy(promptSlots.name)
    return slots.map((slot) => ({
      ...slot,
      usedBy: used.find((entry) => entry.name === slot.name)?.n ?? 0,
    }))
  })
}

const librarySlotSchema = slotSchema.extend({
  expectedRevision: revision.optional(),
})

/**
 * Put a variant in the library, or change one (`id` + `expectedRevision`):
 * its name, what it's for and its options, the whole set. Every prompt that
 * writes `<NAME>` offers them from then on.
 */
export async function saveLibrarySlot(
  actor: Actor,
  raw: z.input<typeof librarySlotSchema>,
): Promise<LibrarySlotView> {
  const input = parseInput(librarySlotSchema, raw)
  const id = await withTransaction(async (tx) => {
    await authorize(tx, actor, null, 'prompts', 'write')
    let slot: PromptSlotRow
    if (input.id) {
      const [current] = await tx
        .select()
        .from(promptSlots)
        .where(
          and(
            eq(promptSlots.id, input.id),
            eq(promptSlots.ownerId, actor.userId),
            isNull(promptSlots.promptId),
          ),
        )
        .for('update')
        .limit(1)
      if (!current) throw notFound('Variant')
      if (
        input.expectedRevision === undefined ||
        current.revision !== input.expectedRevision
      )
        throw conflict()
      const [row] = await tx
        .update(promptSlots)
        .set({
          name: input.name,
          note: input.note ?? current.note,
          revision: sql`${promptSlots.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(promptSlots.id, current.id))
        .returning()
      slot = returned(row)
    } else {
      const [last] = await tx
        .select({
          n: sql<number>`coalesce(max(${promptSlots.position}), -1)::int`,
        })
        .from(promptSlots)
        .where(
          and(
            eq(promptSlots.ownerId, actor.userId),
            isNull(promptSlots.promptId),
          ),
        )
      const [row] = await tx
        .insert(promptSlots)
        .values({
          ownerId: actor.userId,
          createdBy: actor.userId,
          promptId: null,
          name: input.name,
          note: input.note ?? '',
          position: (last?.n ?? -1) + 1,
        })
        .returning()
      slot = returned(row)
    }
    await writeOptions(tx, actor, slot, input.options)
    await audit(tx, actor, {
      projectId: null,
      action: input.id ? 'prompt.library.update' : 'prompt.library.add',
      targetType: 'prompt_slot',
      targetId: slot.id,
      afterRevision: slot.revision,
      changes: { name: slot.name, options: input.options.length },
    })
    return slot.id
  })
  const found = (await listLibrarySlots(actor)).find((slot) => slot.id === id)
  if (!found) throw notFound('Variant')
  return found
}

/**
 * Take a variant out of the library, options and all — the prompts that
 * write `<NAME>` keep only their own options, and examples lose the picks of
 * its options. Asked in place in HQ; it can't come back.
 */
export async function deleteLibrarySlot(
  actor: Actor,
  raw: { slotId: string; expectedRevision: number },
): Promise<void> {
  const input = parseInput(
    z.object({ slotId: recordId('Variant'), expectedRevision: revision }),
    raw,
  )
  await withTransaction(async (tx) => {
    await authorize(tx, actor, null, 'prompts', 'write', 'owner_only')
    const [slot] = await tx
      .select()
      .from(promptSlots)
      .where(
        and(
          eq(promptSlots.id, input.slotId),
          eq(promptSlots.ownerId, actor.userId),
          isNull(promptSlots.promptId),
        ),
      )
      .for('update')
      .limit(1)
    if (!slot) throw notFound('Variant')
    if (slot.revision !== input.expectedRevision) throw conflict()
    await tx.delete(promptSlots).where(eq(promptSlots.id, slot.id))
    await audit(tx, actor, {
      projectId: null,
      action: 'prompt.library.delete',
      targetType: 'prompt_slot',
      targetId: slot.id,
      beforeRevision: slot.revision,
      changes: { name: slot.name },
    })
  })
}

/* ── Examples and their picks ───────────────────────────────────────── */

const picksSchema = z
  .record(
    z.string().trim().regex(SLOT_NAME, 'Name a variant, like HAIR_COLOR.'),
    z.string().trim().min(1).max(40),
  )
  .optional()

/**
 * The option ids for `picks` (slot name → option id or key) among what the
 * prompt offers — a name or option it doesn't offer is invalid. Library
 * options a prompt replaces resolve to the prompt's.
 */
async function optionIdsFor(
  db: Reader,
  prompt: PromptRow,
  picks: Record<string, string> | undefined,
): Promise<string[]> {
  const entries = Object.entries(picks ?? {})
  if (!entries.length) return []
  const { slots } = await readPrompt(db, prompt)
  return entries.map(([name, ref]) => {
    const slot = slots.find((entry) => entry.name === name)
    if (!slot) throw invalid(`${name} isn’t a variant of this prompt.`)
    const option = optionOf(slot, ref)
    if (!option) throw invalid(`${name} has no option “${ref}”.`)
    return option.id
  })
}

async function writePicks(
  tx: Tx,
  actor: Actor,
  exampleId: string,
  optionIds: string[],
): Promise<void> {
  await tx
    .delete(promptExamplePicks)
    .where(eq(promptExamplePicks.exampleId, exampleId))
  if (optionIds.length)
    await tx
      .insert(promptExamplePicks)
      .values(
        optionIds.map((optionId) => ({
          ownerId: actor.userId,
          exampleId,
          optionId,
        })),
      )
      .onConflictDoNothing()
}

const exampleSchema = z.object({
  promptId: recordId('Prompt'),
  assetId: recordId('Asset'),
  caption: z.string().trim().max(300).optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  /** The options it was made with: slot name → option id or key. */
  picks: picksSchema,
  idempotencyKey: idempotencyKey.optional(),
})

/**
 * Show what a prompt makes with a ready asset of the same project (or a
 * floating one), and which options made it — "Attach result" in HQ,
 * `prompts_add_example` for agents.
 */
export async function addExample(
  actor: Actor,
  raw: z.input<typeof exampleSchema>,
): Promise<PromptExampleRow> {
  const input = parseInput(exampleSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'prompts_add_example',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { prompt, text: body } = await promptForWrite(
          tx,
          actor,
          input.promptId,
        )
        if (!body)
          throw invalid('Write the prompt’s text before showing what it makes.')
        const { row: asset } = await ownedRecord<AssetRow>(
          tx,
          actor,
          assetAssets,
          input.assetId,
          'assets',
          'read',
          'Asset',
        )
        if (asset.status !== 'ready')
          throw invalid(
            'Only a ready asset can be an example — finish its upload first.',
          )
        if (asset.projectId && asset.projectId !== prompt.projectId)
          throw invalid('That asset belongs to another project.', {
            assetId: 'Choose an asset of this project.',
          })
        const optionIds = await optionIdsFor(tx, prompt, input.picks)
        const [last] = await tx
          .select({
            n: sql<number>`coalesce(max(${promptExamples.position}), -1)::int`,
          })
          .from(promptExamples)
          .where(eq(promptExamples.variantId, body.id))
        const [row] = await tx
          .insert(promptExamples)
          .values({
            ownerId: actor.userId,
            variantId: body.id,
            assetId: asset.id,
            caption: input.caption ?? '',
            rating: input.rating ?? null,
            position: (last?.n ?? -1) + 1,
          })
          .returning()
        const example = returned(row)
        await writePicks(tx, actor, example.id, optionIds)
        await link(
          tx,
          actor,
          { type: 'asset', id: asset.id },
          { type: 'prompt_variant', id: body.id },
          'example_of',
        )
        await tx
          .update(promptPrompts)
          .set({ updatedAt: sql`now()` })
          .where(eq(promptPrompts.id, prompt.id))
        await audit(tx, actor, {
          projectId: prompt.projectId,
          action: 'prompt.example.add',
          targetType: 'prompt_variant',
          targetId: body.id,
          changes: {
            asset: asset.name,
            rating: example.rating,
            picks: optionIds.length,
          },
        })
        return example
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.example_id
    const [row] =
      typeof id === 'string'
        ? await withReader((db) =>
            db
              .select()
              .from(promptExamples)
              .where(
                and(
                  eq(promptExamples.id, id),
                  eq(promptExamples.ownerId, actor.userId),
                ),
              ),
          )
        : []
    if (!row) throw conflict()
    return row
  }
  await outcome.complete({ example_id: outcome.value.id })
  return outcome.value
}

/** The example and the prompt it shows, for a change to it. */
async function exampleForWrite(
  tx: Tx,
  actor: Actor,
  exampleId: string,
): Promise<{ example: PromptExampleRow; prompt: PromptRow }> {
  const [found] = await tx
    .select({ example: promptExamples, promptId: promptVariants.promptId })
    .from(promptExamples)
    .innerJoin(promptVariants, eq(promptVariants.id, promptExamples.variantId))
    .where(
      and(
        eq(promptExamples.id, exampleId),
        eq(promptExamples.ownerId, actor.userId),
      ),
    )
    .limit(1)
  if (!found) throw notFound('Example')
  const { prompt } = await promptForWrite(tx, actor, found.promptId)
  return { example: found.example, prompt }
}

/**
 * Which options an example was made with — the whole set (slot name → option
 * id or key); an empty set says it's not known.
 */
export async function setExamplePicks(
  actor: Actor,
  raw: { exampleId: string; picks: Record<string, string> },
): Promise<void> {
  const input = parseInput(
    z.object({ exampleId: recordId('Example'), picks: picksSchema }),
    raw,
  )
  await withTransaction(async (tx) => {
    const { example, prompt } = await exampleForWrite(
      tx,
      actor,
      input.exampleId,
    )
    const optionIds = await optionIdsFor(tx, prompt, input.picks)
    await writePicks(tx, actor, example.id, optionIds)
    await audit(tx, actor, {
      projectId: prompt.projectId,
      action: 'prompt.example.picks',
      targetType: 'prompt_variant',
      targetId: example.variantId,
      changes: { example: example.id, picks: optionIds.length },
    })
  })
}

/** Take an example off a prompt; the asset stays in the library. */
export async function removeExample(
  actor: Actor,
  exampleId: string,
): Promise<void> {
  const id = parseInput(recordId('Example'), exampleId)
  await withTransaction(async (tx) => {
    const { example, prompt } = await exampleForWrite(tx, actor, id)
    await tx.delete(promptExamples).where(eq(promptExamples.id, example.id))
    await tx
      .delete(refs)
      .where(
        and(
          eq(refs.ownerId, actor.userId),
          eq(refs.fromType, 'asset'),
          eq(refs.fromId, example.assetId),
          eq(refs.toType, 'prompt_variant'),
          eq(refs.toId, example.variantId),
          eq(refs.role, 'example_of'),
        ),
      )
    await audit(tx, actor, {
      projectId: prompt.projectId,
      action: 'prompt.example.remove',
      targetType: 'prompt_variant',
      targetId: example.variantId,
      changes: { assetId: example.assetId },
    })
  })
}

/* ── Details, archive, delete ───────────────────────────────────────── */

const detailsSchema = z.object({
  promptId: recordId('Prompt'),
  expectedRevision: revision,
  title: text.required('Title', 160).optional(),
  intent: z.string().trim().max(2000).optional(),
  collection: text.optional('Collection', 80),
  tags: stringList('tags', 16, 32).optional(),
})

export type PromptDetailsInput = z.input<typeof detailsSchema>

/**
 * Change what a prompt is — its title, what it's for, its collection and
 * tags — without touching its text. A key left out stays as it is; an empty
 * collection clears it. The project stays: examples and shots are checked
 * against it, so a prompt doesn't move.
 */
export async function editPromptDetails(
  actor: Actor,
  raw: PromptDetailsInput,
): Promise<PromptRow> {
  const input = parseInput(detailsSchema, raw)
  return withTransaction(async (tx) => {
    assertCan(actor, 'prompts', 'write')
    const { row: prompt, project } = await ownedRow<PromptRow>(
      tx,
      actor,
      promptPrompts,
      input.promptId,
      'Prompt',
      { lock: true },
    )
    await authorize(tx, actor, project, 'prompts', 'write')
    if (project) assertModuleOn(project, 'prompts')
    if (prompt.deletedAt && !seesTrash(actor)) throw notFound('Prompt')
    if (prompt.revision !== input.expectedRevision) throw conflict()
    if (prompt.archivedAt)
      throw invalid(
        prompt.deletedAt
          ? 'This prompt is in the Trash. Restore it to change it.'
          : 'This prompt is archived. Restore it to change it.',
      )
    const next = {
      title: (input.title as string | undefined) ?? prompt.title,
      intent: input.intent ?? prompt.intent,
      collection:
        input.collection !== undefined ? input.collection : prompt.collection,
      tags: input.tags !== undefined ? normalizeTags(input.tags) : prompt.tags,
    }
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
      (key) => JSON.stringify(next[key]) !== JSON.stringify(prompt[key]),
    )
    if (changed.length === 0) return prompt
    const [row] = await tx
      .update(promptPrompts)
      .set({
        ...next,
        revision: sql`${promptPrompts.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(promptPrompts.id, prompt.id))
      .returning()
    const saved = returned(row)
    await audit(tx, actor, {
      projectId: saved.projectId,
      action: 'prompt.update',
      targetType: 'prompt',
      targetId: saved.id,
      beforeRevision: prompt.revision,
      afterRevision: saved.revision,
      changes: { title: saved.title, fields: changed },
    })
    return saved
  })
}

/** The prompt, locked, for the owner to put away, delete or bring back. */
async function promptForOwner(
  tx: Tx,
  actor: Actor,
  promptId: string,
  expectedRevision: number,
): Promise<PromptRow> {
  assertCan(actor, 'prompts', 'write')
  const { row: prompt, project } = await ownedRow<PromptRow>(
    tx,
    actor,
    promptPrompts,
    promptId,
    'Prompt',
    { lock: true },
  )
  await authorize(tx, actor, project, 'prompts', 'write', 'owner_only')
  if (prompt.revision !== expectedRevision) throw conflict()
  return prompt
}

/** Archive a prompt or bring it back. The owner's; agents leave the library as it is. */
export async function setPromptArchived(
  actor: Actor,
  raw: { promptId: string; expectedRevision: number; archived: boolean },
): Promise<PromptRow> {
  const input = parseInput(
    z.object({
      promptId: recordId('Prompt'),
      expectedRevision: revision,
      archived: z.boolean(),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const prompt = await promptForOwner(
      tx,
      actor,
      input.promptId,
      input.expectedRevision,
    )
    if (Boolean(prompt.archivedAt) === input.archived) return prompt
    if (prompt.deletedAt)
      throw invalid('This prompt is in the Trash. Restore it from there.')
    const [row] = await tx
      .update(promptPrompts)
      .set({
        archivedAt: input.archived ? sql`now()` : null,
        revision: sql`${promptPrompts.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(promptPrompts.id, prompt.id))
      .returning()
    await audit(tx, actor, {
      projectId: prompt.projectId,
      action: input.archived ? 'prompt.archive' : 'prompt.restore',
      targetType: 'prompt',
      targetId: prompt.id,
      beforeRevision: prompt.revision,
      afterRevision: row?.revision ?? null,
    })
    return returned(row)
  })
}

const deleteSchema = z.object({
  promptId: recordId('Prompt'),
  expectedRevision: revision,
  deleted: z.boolean(),
  /** Restoring: back to Archived rather than the library — Undo of a delete made there. */
  archived: z.boolean().optional(),
})

/**
 * Delete a prompt to the Trash, or restore it. Deleting
 * archives it too, so it leaves every list, count and picker; its text,
 * variants, examples and links stay, and Restore brings it back whole — to
 * the library, or to Archived when asked (the Undo of a delete made there).
 * The owner's, in HQ.
 */
export async function setPromptDeleted(
  actor: Actor,
  raw: z.input<typeof deleteSchema>,
): Promise<PromptRow> {
  const input = parseInput(deleteSchema, raw)
  return withTransaction(async (tx) => {
    const prompt = await promptForOwner(
      tx,
      actor,
      input.promptId,
      input.expectedRevision,
    )
    if (Boolean(prompt.deletedAt) === input.deleted) return prompt
    const [row] = await tx
      .update(promptPrompts)
      .set({
        ...(input.deleted
          ? {
              archivedAt: sql`coalesce(${promptPrompts.archivedAt}, now())`,
              deletedAt: sql`now()`,
            }
          : {
              archivedAt: input.archived ? prompt.archivedAt : null,
              deletedAt: null,
            }),
        revision: sql`${promptPrompts.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(promptPrompts.id, prompt.id))
      .returning()
    const saved = returned(row)
    await audit(tx, actor, {
      projectId: prompt.projectId,
      action: input.deleted ? 'prompt.delete' : 'prompt.undelete',
      targetType: 'prompt',
      targetId: prompt.id,
      beforeRevision: prompt.revision,
      afterRevision: saved.revision,
      changes: input.deleted
        ? {
            title: prompt.title,
            from: prompt.archivedAt ? 'archived' : 'library',
          }
        : {
            title: prompt.title,
            to: saved.archivedAt ? 'archived' : 'library',
          },
    })
    return saved
  })
}

/* ── Summaries ──────────────────────────────────────────────────────── */

/** Per project: prompts, and how many are new in the last 7 days — the Prompts cell. */
export async function promptSummaries(actor: Actor): Promise<
  {
    projectId: string | null
    prompts: number
    newThisWeek: number
  }[]
> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'prompts', 'read')
    return db
      .select({
        projectId: promptPrompts.projectId,
        prompts: sql<number>`count(*)::int`,
        newThisWeek: sql<number>`count(*) filter (where ${promptPrompts.createdAt} > now() - interval '7 days')::int`,
      })
      .from(promptPrompts)
      .where(
        and(
          eq(promptPrompts.ownerId, actor.userId),
          isNull(promptPrompts.archivedAt),
        ),
      )
      .groupBy(promptPrompts.projectId)
  })
}

/**
 * Make an example with one of the owner's generators
 * ("Generate with…"): HQ calls it with the prompt's text filled from `picks`
 * — every variant in the text picked — and the file lands as an example
 * (`asset —example_of→ text`, a `prompt_examples` row) with those picks.
 * Images come back at once; a video is collected by the ops tick and lands
 * the same way.
 */
export async function generateExample(
  actor: Actor,
  raw: {
    promptId: string
    connectionId: string
    picks?: Record<string, string>
  },
): Promise<JobView> {
  const input = parseInput(
    z.object({
      promptId: recordId('Prompt'),
      connectionId: recordId('Generator'),
      picks: picksSchema,
    }),
    raw,
  )
  const { prompt, text: body } = await withTransaction((tx) =>
    promptForWrite(tx, actor, input.promptId),
  )
  if (!body) throw invalid('Write the prompt’s text first.')
  if (prompt.medium !== 'image' && prompt.medium !== 'video')
    throw invalid('Only image and video prompts can be generated.')
  const view = await getPrompt(actor, prompt.id)
  const filled = fillPrompt(view, input.picks ?? {})
  if (filled.unknown.length)
    throw invalid(
      `${filled.unknown.join(', ')} ${filled.unknown.length === 1 ? 'isn’t a variant' : 'aren’t variants'} of this prompt, or the option is gone.`,
    )
  if (filled.missing.length)
    throw invalid(`Pick ${filled.missing.join(', ')} first.`)
  const picked = Object.entries(filled.options)
  return queueGeneration(actor, {
    projectId: prompt.projectId,
    provider: 'external:openai_compatible',
    connectionId: input.connectionId,
    operation: 'generate',
    title: [prompt.title, ...picked.map(([, option]) => option.key)]
      .join(' · ')
      .slice(0, 200),
    input: {
      medium: prompt.medium,
      prompt: filled.text,
      ...(filled.negativeText ? { negativePrompt: filled.negativeText } : {}),
      picks: picked.map(([, option]) => option.id),
    },
    target: { type: 'prompt_variant', id: body.id, role: 'example_of' },
    variantId: body.id,
  })
}
