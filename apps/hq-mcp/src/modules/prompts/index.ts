import { PROMPT_MEDIA } from '@theiceji/hq-db/enums'
import {
  addExample,
  fillPrompt,
  getPrompt,
  listPrompts,
  type PromptListItem,
  type PromptView,
  savePrompt,
} from '@theiceji/hq-prompts/prompts'
import '@theiceji/hq-prompts/register'
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
 * `prompts` — the prompt library: prompts in one medium, each
 * with one text — a template whose `<SLOTS>` (the owner's "variants", e.g.
 * `<HAIR_COLOR>`) are filled from options — and example assets. A slot's
 * options are the prompt's own or the owner's library (shared by every
 * prompt that writes `<NAME>`); the library is edited in HQ. Saving sends the
 * text and, when given, the prompt's own variants as a whole set.
 */

function listOut(prompt: PromptListItem) {
  return {
    id: prompt.id,
    project_id: prompt.projectId,
    title: prompt.title,
    intent: prompt.intent,
    medium: prompt.medium,
    collection: prompt.collection,
    tags: prompt.tags,
    /** The `<SLOTS>` written in the text. */
    variants: prompt.slotNames,
    examples: prompt.exampleCount,
    text: prompt.text ? { id: prompt.text.id, text: prompt.text.text } : null,
    revision: prompt.revision,
    updated_at: prompt.updatedAt,
  }
}

function promptOut(prompt: PromptView, picks?: Record<string, string>) {
  const keyOf = (name: string, id: string) =>
    prompt.slots
      .find((slot) => slot.name === name)
      ?.options.find((option) => option.id === id)?.key ?? id
  const filled = picks ? fillPrompt(prompt, picks) : null
  return {
    id: prompt.id,
    project_id: prompt.projectId,
    title: prompt.title,
    intent: prompt.intent,
    medium: prompt.medium,
    collection: prompt.collection,
    tags: prompt.tags,
    revision: prompt.revision,
    /** The id Story shots (image/video variant) and generation jobs point at. */
    text_id: prompt.text?.id ?? null,
    text: prompt.text?.text ?? null,
    negative_text: prompt.text?.negativeText ?? '',
    style: prompt.text?.style ?? '',
    provider_hint: prompt.text?.providerHint ?? null,
    model: prompt.text?.model ?? null,
    params: prompt.text?.params ?? {},
    variants: prompt.slots.map((slot) => ({
      name: slot.name,
      in_text: slot.inText,
      note: slot.note,
      /** Own: the prompt's; library: shared by every prompt that writes the name. */
      options: slot.options.map((option) => ({
        key: option.key,
        value: option.value,
        from: option.from,
      })),
    })),
    ...(filled
      ? {
          filled: {
            text: filled.missing.length ? null : filled.text,
            negative_text: filled.missing.length ? null : filled.negativeText,
            missing: filled.missing,
            unknown: filled.unknown,
          },
        }
      : {}),
    examples: (prompt.text?.examples ?? []).map((example) => ({
      id: example.id,
      asset_id: example.assetId,
      name: example.asset.name,
      /** The owner's name for it in HQ, or null (then `name`, the file name, is what HQ shows). */
      title: example.asset.title,
      kind: example.asset.kind,
      caption: example.caption,
      rating: example.rating,
      /** The options it was made with: variant name → option key. */
      picks: Object.fromEntries(
        Object.entries(example.picks).map(([name, id]) => [
          name,
          keyOf(name, id),
        ]),
      ),
    })),
  }
}

const picksArg = z
  .record(z.string().max(40), z.string().max(40))
  .describe('Variant name → option key, e.g. { "HAIR_COLOR": "punk" }.')

export const listPromptsTool = defineTool({
  name: 'list',
  title: 'List prompts',
  description:
    'Prompts, most recently changed first: one project’s, the floating ones (project_id null) or all, each with its text and the variants (`<SLOTS>`) written in it. Filter by medium, collection, tag or words (also matched inside the text).',
  scope: 'prompts:read',
  input: z.object({
    project_id: projectIdArg.nullable().optional(),
    medium: z.enum(PROMPT_MEDIA).optional(),
    collection: z.string().max(80).optional(),
    tag: z.string().max(32).optional(),
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      (actor) =>
        listPrompts(actor, {
          projectId: args.project_id,
          medium: args.medium,
          collection: args.collection,
          tag: args.tag,
          query: args.query,
          limit: args.limit,
        }),
      ({ prompts, total }) => ({
        text: `${prompts.length} of ${total} prompt(s).`,
        data: { total, prompts: prompts.map(listOut) },
      }),
    ),
})

export const getPromptTool = defineTool({
  name: 'get',
  title: 'Get a prompt',
  description:
    'One prompt: its text (a template — `<HAIR_COLOR>` is a variant), style, model hint, params, every variant with its options (key → value; from the prompt or the owner’s library), and its examples with the options each was made with. Send picks (variant → option key) to get the text filled; it is filled only with every variant in it picked.',
  scope: 'prompts:read',
  input: z.object({
    prompt_id: idArg('Prompt'),
    picks: picksArg.optional(),
  }),
  annotations: READ,
  run: ({ prompt_id, picks }, context) =>
    readTool(
      context,
      (actor) => getPrompt(actor, prompt_id),
      (prompt) => ({
        text: `“${prompt.title}” — ${prompt.medium}, ${prompt.slots.filter((slot) => slot.inText).length} variant(s) in the text.`,
        data: { prompt: promptOut(prompt, picks) },
      }),
    ),
})

const variantArg = z.object({
  name: z
    .string()
    .max(40)
    .describe('As written in the text between < >: HAIR_COLOR.'),
  note: z.string().max(300).optional(),
  options: z
    .array(
      z.object({
        key: z.string().min(1).max(40).describe('Short, picked by name: punk.'),
        value: z
          .string()
          .max(4000)
          .describe('What goes into the text; may be lines, may be empty.'),
      }),
    )
    .max(100),
})

export const savePromptTool = defineTool({
  name: 'save',
  title: 'Save a prompt',
  description:
    'Create a prompt (no prompt_id) or change one (prompt_id + expected_revision). `text` is the one text a generator runs — write a variant as <NAME> (upper case). `variants`, when sent, is the prompt’s own set: each named one is kept or added with exactly those options (matched by name and key, so examples keep their picks); one left out goes. The owner’s library variants need no entry here. Needs your operating policy to allow drafting.',
  scope: 'prompts:write',
  input: z.object({
    prompt_id: idArg('Prompt').optional(),
    expected_revision: expectedRevisionArg.optional(),
    project_id: projectIdArg.nullable().optional(),
    title: z.string().min(1).max(160),
    intent: z.string().max(2000).optional(),
    medium: z.enum(PROMPT_MEDIA),
    collection: z.string().max(80).nullable().optional(),
    tags: z.array(z.string().max(32)).max(16).optional(),
    text: z.string().min(1).max(20000).optional(),
    negative_text: z.string().max(4000).optional(),
    style: z.string().max(200).optional(),
    provider_hint: z.string().max(80).optional(),
    model: z.string().max(120).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    variants: z.array(variantArg).max(40).optional(),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        savePrompt(
          actor,
          defined({
            promptId: args.prompt_id,
            expectedRevision: args.expected_revision,
            projectId: args.project_id,
            title: args.title,
            intent: args.intent,
            medium: args.medium,
            collection: args.collection,
            tags: args.tags,
            text: args.text,
            negativeText: args.negative_text,
            style: args.style,
            providerHint: args.provider_hint,
            model: args.model,
            params: args.params,
            slots: args.variants?.map((variant) =>
              defined({
                name: variant.name,
                note: variant.note,
                options: variant.options,
              }),
            ),
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof savePrompt>[1],
        ),
      (prompt) => ({
        text: `Saved “${prompt.title}” (revision ${prompt.revision}, ${prompt.slots.filter((slot) => slot.inText).length} variant(s) in the text).`,
        data: {
          target: { type: 'prompt', id: prompt.id, revision: prompt.revision },
          prompt: promptOut(prompt),
        },
      }),
    ),
})

export const addExampleTool = defineTool({
  name: 'add_example',
  title: 'Add an example to a prompt',
  description:
    'Show what a prompt makes with a ready asset of the same project (or a floating one), and which options made it (picks: variant → option key). Rating 1–5 is optional.',
  scope: 'prompts:write',
  input: z.object({
    prompt_id: idArg('Prompt'),
    asset_id: idArg('Asset'),
    picks: picksArg.optional(),
    caption: z.string().max(300).optional(),
    rating: z.number().int().min(1).max(5).optional(),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        addExample(actor, {
          promptId: args.prompt_id,
          assetId: args.asset_id,
          picks: args.picks,
          caption: args.caption,
          rating: args.rating,
          idempotencyKey: args.idempotency_key,
        }),
      (example) => ({
        text: 'Example added.',
        data: { target: { type: 'prompt_example', id: example.id }, example },
      }),
    ),
})

export const prompts = defineWorkspace({
  id: 'prompts',
  label: 'Prompts',
  description:
    'The prompt library: prompts, their text with <VARIANTS> and options, and example assets.',
  instructions:
    'Read a prompt with prompts_get before saving over it, and send expected_revision. A prompt has one text; a variant is <NAME> in it, filled from an option. Examples must be ready assets of the same project.',
  tools: [listPromptsTool, getPromptTool, savePromptTool, addExampleTool],
})
