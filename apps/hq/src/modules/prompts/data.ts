import type {
  LibrarySlotView,
  PromptListItem,
  PromptView,
} from '@theiceji/hq-prompts/prompts'

/** Prompts as they cross to the page: plain JSON, dates as ISO strings. */

export type ExampleData = {
  id: string
  assetId: string
  /** The file name as uploaded. */
  name: string
  /** What HQ calls it: the owner's title, else the file name. */
  title: string
  kind: string
  width: number | null
  height: number | null
  durationMs: number | null
  caption: string
  rating: number | null
  preview: string | null
  /** The options it was made with: variant name → option id. */
  picks: Record<string, string>
}

/** The prompt's one text — a template when it writes `<VARIANTS>`. */
export type TextData = {
  id: string
  style: string
  providerHint: string | null
  model: string | null
  text: string
  negativeText: string
  params: Record<string, unknown>
  examples: ExampleData[]
}

export type OptionData = {
  id: string
  key: string
  value: string
  /** The library's, or the prompt's own. */
  from: 'library' | 'prompt'
  /** The library option with the same key this one replaces for the prompt. */
  replaces: string | null
}

/** A variant (`<NAME>`) as the prompt offers it: its own options and the library's. */
export type SlotData = {
  name: string
  /** Written in the text — picked before copying. */
  inText: boolean
  promptSlotId: string | null
  librarySlotId: string | null
  note: string
  options: OptionData[]
}

export type PromptProject = {
  id: string
  slug: string
  name: string
  color: string
  status: string
  kind: string
}

export type PromptData = {
  id: string
  projectId: string | null
  project: PromptProject | null
  title: string
  intent: string
  medium: 'image' | 'video' | 'text' | 'audio'
  collection: string | null
  tags: string[]
  revision: number
  updatedAt: string
  createdAt: string
  /** Put away (Archived), or with `deletedAt` too, in the Trash. */
  archivedAt: string | null
  deletedAt: string | null
  exampleCount: number
  /** The variants written in the text, in order. */
  slotNames: string[]
  /** Present when the full prompt was read; the pool has only the raw text. */
  text: TextData | null
  slots: SlotData[] | null
  rawText: string | null
  previews: { id: string; kind: string; preview: string | null }[]
}

/** A variant in the library, for the page that keeps it. */
export type LibrarySlotData = {
  id: string
  name: string
  note: string
  revision: number
  usedBy: number
  options: { id: string; key: string; value: string }[]
}

export function promptData(
  prompt: PromptView,
  previews: Record<string, string> = {},
): PromptData {
  const text: TextData | null = prompt.text
    ? {
        id: prompt.text.id,
        style: prompt.text.style,
        providerHint: prompt.text.providerHint,
        model: prompt.text.model,
        text: prompt.text.text,
        negativeText: prompt.text.negativeText,
        params: prompt.text.params,
        examples: prompt.text.examples.map((example) => ({
          id: example.id,
          assetId: example.assetId,
          name: example.asset.name,
          title: example.asset.title ?? example.asset.name,
          kind: example.asset.kind,
          width: example.asset.width,
          height: example.asset.height,
          durationMs: example.asset.durationMs,
          caption: example.caption,
          rating: example.rating,
          preview: previews[example.assetId] ?? null,
          picks: example.picks,
        })),
      }
    : null
  return {
    id: prompt.id,
    projectId: prompt.projectId,
    project: prompt.project,
    title: prompt.title,
    intent: prompt.intent,
    medium: prompt.medium,
    collection: prompt.collection,
    tags: prompt.tags,
    revision: prompt.revision,
    updatedAt: prompt.updatedAt.toISOString(),
    createdAt: prompt.createdAt.toISOString(),
    archivedAt: prompt.archivedAt?.toISOString() ?? null,
    deletedAt: prompt.deletedAt?.toISOString() ?? null,
    exampleCount: text?.examples.length ?? 0,
    slotNames: prompt.slots
      .filter((slot) => slot.inText)
      .map((slot) => slot.name),
    text,
    slots: prompt.slots.map((slot) => ({
      name: slot.name,
      inText: slot.inText,
      promptSlotId: slot.promptSlotId,
      librarySlotId: slot.librarySlotId,
      note: slot.note,
      options: slot.options.map((option) => ({
        id: option.id,
        key: option.key,
        value: option.value,
        from: option.from,
        replaces: option.replaces,
      })),
    })),
    rawText: text?.text ?? null,
    previews: (text?.examples ?? []).slice(0, 3).map((example) => ({
      id: example.assetId,
      kind: example.kind,
      preview: example.preview,
    })),
  }
}

export function promptListData(
  prompt: PromptListItem,
  previews: Record<string, string> = {},
): PromptData {
  return {
    id: prompt.id,
    projectId: prompt.projectId,
    project: prompt.project,
    title: prompt.title,
    intent: prompt.intent,
    medium: prompt.medium,
    collection: prompt.collection,
    tags: prompt.tags,
    revision: prompt.revision,
    updatedAt: prompt.updatedAt.toISOString(),
    createdAt: prompt.createdAt.toISOString(),
    archivedAt: prompt.archivedAt?.toISOString() ?? null,
    deletedAt: prompt.deletedAt?.toISOString() ?? null,
    exampleCount: prompt.exampleCount,
    slotNames: prompt.slotNames,
    text: null,
    slots: null,
    rawText: prompt.text?.text ?? null,
    previews: prompt.previews.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      preview: previews[asset.id] ?? null,
    })),
  }
}

export function librarySlotData(slot: LibrarySlotView): LibrarySlotData {
  return {
    id: slot.id,
    name: slot.name,
    note: slot.note,
    revision: slot.revision,
    usedBy: slot.usedBy,
    options: slot.options.map((option) => ({
      id: option.id,
      key: option.key,
      value: option.value,
    })),
  }
}
