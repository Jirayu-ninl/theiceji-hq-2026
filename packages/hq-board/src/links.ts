import type {
  AssetKind,
  AssetStatus,
  PromptMedium,
  RefType,
} from '@theiceji/hq-db/enums'
import {
  assetAssets,
  type BoardCardRow,
  boardCards,
  boardFollowups,
  type ProjectRow,
  promptPrompts,
  promptVariants,
  refs,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan } from '@theiceji/hq-ops/access'
import { invalid, notFound } from '@theiceji/hq-ops/errors'
import { parseInput, recordId } from '@theiceji/hq-ops/schemas'
import {
  assertModuleOn,
  audit,
  authorize,
  ownedRecord,
  ownedRow,
  type Reader,
  type Tx,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'

/**
 * What a card (or one of its follow-ups) links to in other modules:
 * the prompt the job ran on — `made_with`, one per record —
 * and its files — `attached` assets. Edges live in `refs`; Board checks both
 * ends belong to the owner before it writes one, and unlinking never deletes
 * the prompt or the asset. Linking and unlinking are the owner's (agents
 * link through proposals and the target registry).
 */

type Holder = { type: 'card' | 'followup'; id: string }

export type CardPromptLink = {
  refId: string
  holder: Holder
  promptId: string
  variantId: string | null
  title: string
  medium: PromptMedium
  projectId: string | null
  /** The prompt's text — a template when it writes `<VARIANTS>`. */
  text: string | null
}

export type CardFileLink = {
  refId: string
  holder: Holder
  assetId: string
  name: string
  /** The owner's name for it in HQ, or null (then `name`, the file name, is what HQ shows). */
  title: string | null
  kind: AssetKind
  mime: string
  bytes: number
  status: AssetStatus
  projectId: string | null
}

export type CardLinks = { prompts: CardPromptLink[]; files: CardFileLink[] }

const holderSchema = z.object({
  cardId: recordId('Card'),
  /** A follow-up of the card; the card itself when left out. */
  followupId: recordId('Follow-up').optional(),
})

/** The card (for writing: owner, Board on) and the record that will hold the edge. */
async function holderFor(
  tx: Tx,
  actor: Actor,
  input: { cardId: string; followupId?: string },
): Promise<{ card: BoardCardRow; project: ProjectRow | null; holder: Holder }> {
  assertCan(actor, 'board', 'write')
  const { row: card, project } = await ownedRow<BoardCardRow>(
    tx,
    actor,
    boardCards,
    input.cardId,
    'Card',
  )
  await authorize(tx, actor, project, 'board', 'write', 'owner_only')
  if (project) assertModuleOn(project, 'board')
  if (card.archivedAt)
    throw invalid('This card is archived. Restore it to change its links.')
  if (!input.followupId)
    return { card, project, holder: { type: 'card', id: card.id } }
  const [followup] = await tx
    .select({ id: boardFollowups.id })
    .from(boardFollowups)
    .where(
      and(
        eq(boardFollowups.id, input.followupId),
        eq(boardFollowups.cardId, card.id),
        eq(boardFollowups.ownerId, actor.userId),
      ),
    )
  if (!followup) throw notFound('Follow-up')
  return { card, project, holder: { type: 'followup', id: followup.id } }
}

const promptSchema = holderSchema.extend({
  promptId: recordId('Prompt'),
  /** The variant the job ran on; the prompt's default when left out. */
  variantId: recordId('Variant').optional(),
})

/**
 * The prompt the job ran on — one per card or follow-up, so choosing another
 * replaces the edge. Any of the owner's live prompts: this project's, another
 * project's, or the library's. One put away (archived, or in the Trash) is
 * restored in Prompts first — the picker never offers it, and a stale id
 * doesn't slip past.
 */
export async function setPrompt(
  actor: Actor,
  raw: z.input<typeof promptSchema>,
): Promise<void> {
  const input = parseInput(promptSchema, raw)
  await withTransaction(async (tx) => {
    const { card, holder } = await holderFor(tx, actor, input)
    const [prompt] = await tx
      .select({
        id: promptPrompts.id,
        title: promptPrompts.title,
        archivedAt: promptPrompts.archivedAt,
        deletedAt: promptPrompts.deletedAt,
      })
      .from(promptPrompts)
      .where(
        and(
          eq(promptPrompts.id, input.promptId),
          eq(promptPrompts.ownerId, actor.userId),
        ),
      )
    if (!prompt) throw notFound('Prompt')
    if (prompt.deletedAt)
      throw invalid(
        'That prompt is in the Trash. Restore it in Prompts to link it.',
      )
    if (prompt.archivedAt)
      throw invalid(
        'That prompt is archived. Restore it in Prompts to link it.',
      )
    const [variant] = await tx
      .select({ id: promptVariants.id })
      .from(promptVariants)
      .where(
        and(
          eq(promptVariants.promptId, prompt.id),
          input.variantId
            ? eq(promptVariants.id, input.variantId)
            : eq(promptVariants.isDefault, true),
        ),
      )
      .limit(1)
    if (input.variantId && !variant) throw notFound('Variant')
    await tx
      .delete(refs)
      .where(
        and(
          eq(refs.ownerId, actor.userId),
          eq(refs.fromType, holder.type),
          eq(refs.fromId, holder.id),
          eq(refs.role, 'made_with'),
        ),
      )
    await tx.insert(refs).values({
      ownerId: actor.userId,
      fromType: holder.type,
      fromId: holder.id,
      toType: variant ? 'prompt_variant' : 'prompt',
      toId: variant?.id ?? prompt.id,
      role: 'made_with',
    })
    await audit(tx, actor, {
      projectId: card.projectId,
      action: 'board.prompt.link',
      targetType: 'card',
      targetId: card.id,
      changes: {
        holder,
        prompt: prompt.id,
        variant: variant?.id ?? null,
        title: prompt.title,
      },
    })
  })
}

const fileSchema = holderSchema.extend({ assetId: recordId('Asset') })

/** A file of the job — an asset of the owner's (uploaded through Assets first). */
export async function attachFile(
  actor: Actor,
  raw: z.input<typeof fileSchema>,
): Promise<void> {
  const input = parseInput(fileSchema, raw)
  await withTransaction(async (tx) => {
    const { card, holder } = await holderFor(tx, actor, input)
    const { row: asset } = await ownedRecord<{ id: string; name: string }>(
      tx,
      actor,
      assetAssets,
      input.assetId,
      'assets',
      'read',
      'Asset',
    )
    await tx
      .insert(refs)
      .values({
        ownerId: actor.userId,
        fromType: holder.type,
        fromId: holder.id,
        toType: 'asset',
        toId: asset.id,
        role: 'attached',
      })
      .onConflictDoNothing()
    await audit(tx, actor, {
      projectId: card.projectId,
      action: 'board.file.attach',
      targetType: 'card',
      targetId: card.id,
      changes: { holder, asset: asset.id, name: asset.name },
    })
  })
}

const unlinkSchema = z.object({
  cardId: recordId('Card'),
  refId: recordId('Link'),
})

/** Take a prompt or a file off the card or one of its follow-ups; both stay where they live. */
export async function unlinkFromCard(
  actor: Actor,
  raw: z.input<typeof unlinkSchema>,
): Promise<void> {
  const input = parseInput(unlinkSchema, raw)
  await withTransaction(async (tx) => {
    const { card } = await holderFor(tx, actor, { cardId: input.cardId })
    const followups = tx
      .select({ id: boardFollowups.id })
      .from(boardFollowups)
      .where(eq(boardFollowups.cardId, card.id))
    const [row] = await tx
      .delete(refs)
      .where(
        and(
          eq(refs.id, input.refId),
          eq(refs.ownerId, actor.userId),
          or(
            and(eq(refs.fromType, 'card'), eq(refs.fromId, card.id)),
            and(eq(refs.fromType, 'followup'), inArray(refs.fromId, followups)),
          ),
          inArray(refs.role, ['made_with', 'attached']),
        ),
      )
      .returning()
    if (!row) throw notFound('Link')
    await audit(tx, actor, {
      projectId: card.projectId,
      action:
        row.role === 'made_with' ? 'board.prompt.unlink' : 'board.file.detach',
      targetType: 'card',
      targetId: card.id,
      changes: {
        holder: { type: row.fromType, id: row.fromId },
        to: { type: row.toType, id: row.toId },
      },
    })
  })
}

/** The prompts and files of a card and its follow-ups, with what the inspector shows of each. */
export async function readCardLinks(
  reader: Reader,
  ownerId: string,
  cardId: string,
  followupIds: readonly string[],
): Promise<CardLinks> {
  const holders: { type: RefType; ids: string[] }[] = [
    { type: 'card', ids: [cardId] },
    { type: 'followup', ids: [...followupIds] },
  ]
  const edges = await reader
    .select()
    .from(refs)
    .where(
      and(
        eq(refs.ownerId, ownerId),
        or(
          ...holders
            .filter((entry) => entry.ids.length)
            .map((entry) =>
              and(
                eq(refs.fromType, entry.type),
                inArray(refs.fromId, entry.ids),
              ),
            ),
        ),
        inArray(refs.role, ['made_with', 'attached']),
      ),
    )
  const holderOf = (edge: (typeof edges)[number]): Holder => ({
    type: edge.fromType as Holder['type'],
    id: edge.fromId,
  })
  const variantIds = edges
    .filter(
      (edge) => edge.role === 'made_with' && edge.toType === 'prompt_variant',
    )
    .map((edge) => edge.toId)
  const promptIds = edges
    .filter((edge) => edge.role === 'made_with' && edge.toType === 'prompt')
    .map((edge) => edge.toId)
  const assetIds = edges
    .filter((edge) => edge.role === 'attached' && edge.toType === 'asset')
    .map((edge) => edge.toId)
  const [variants, prompts, assets] = await Promise.all([
    variantIds.length
      ? reader
          .select({ variant: promptVariants, prompt: promptPrompts })
          .from(promptVariants)
          .innerJoin(
            promptPrompts,
            eq(promptPrompts.id, promptVariants.promptId),
          )
          .where(
            and(
              eq(promptVariants.ownerId, ownerId),
              inArray(promptVariants.id, variantIds),
            ),
          )
      : [],
    promptIds.length
      ? reader
          .select({ prompt: promptPrompts, variant: promptVariants })
          .from(promptPrompts)
          .leftJoin(
            promptVariants,
            and(
              eq(promptVariants.promptId, promptPrompts.id),
              eq(promptVariants.isDefault, true),
            ),
          )
          .where(
            and(
              eq(promptPrompts.ownerId, ownerId),
              inArray(promptPrompts.id, promptIds),
            ),
          )
      : [],
    assetIds.length
      ? reader
          .select()
          .from(assetAssets)
          .where(
            and(
              eq(assetAssets.ownerId, ownerId),
              inArray(assetAssets.id, assetIds),
            ),
          )
      : [],
  ])
  const out: CardLinks = { prompts: [], files: [] }
  for (const edge of edges) {
    if (edge.role === 'made_with') {
      const found =
        edge.toType === 'prompt_variant'
          ? variants.find((row) => row.variant.id === edge.toId)
          : prompts.find((row) => row.prompt.id === edge.toId)
      if (!found) continue
      out.prompts.push({
        refId: edge.id,
        holder: holderOf(edge),
        promptId: found.prompt.id,
        variantId: found.variant?.id ?? null,
        title: found.prompt.title,
        medium: found.prompt.medium,
        projectId: found.prompt.projectId,
        text: found.variant?.text ?? null,
      })
    } else {
      const asset = assets.find((row) => row.id === edge.toId)
      if (!asset) continue
      out.files.push({
        refId: edge.id,
        holder: holderOf(edge),
        assetId: asset.id,
        name: asset.name,
        title: asset.title,
        kind: asset.kind,
        mime: asset.mime,
        bytes: asset.bytes,
        status: asset.status,
        projectId: asset.projectId,
      })
    }
  }
  return out
}

/** The links of one card the actor may read. */
export async function cardLinks(
  actor: Actor,
  cardId: string,
): Promise<CardLinks> {
  return withReader(async (db) => {
    const { row: card } = await ownedRecord<BoardCardRow>(
      db,
      actor,
      boardCards,
      cardId,
      'board',
      'read',
      'Card',
    )
    const followups = await db
      .select({ id: boardFollowups.id })
      .from(boardFollowups)
      .where(eq(boardFollowups.cardId, card.id))
    return readCardLinks(
      db,
      card.ownerId,
      card.id,
      followups.map((row) => row.id),
    )
  })
}

/** How many prompts and files each card carries, its follow-ups' included — the tile's ✎ and ▣ marks. */
export async function linkCounts(
  reader: Reader,
  ownerId: string,
  cardIds: readonly string[],
): Promise<{ cardId: string; prompts: number; files: number }[]> {
  if (cardIds.length === 0) return []
  const ids = [...new Set(cardIds)]
  const rows = await reader
    .select({
      cardId: sql<string>`coalesce(${boardFollowups.cardId}, ${refs.fromId})`,
      prompts: sql<number>`count(*) filter (where ${refs.role} = 'made_with')::int`,
      files: sql<number>`count(*) filter (where ${refs.role} = 'attached')::int`,
    })
    .from(refs)
    .leftJoin(
      boardFollowups,
      and(eq(refs.fromType, 'followup'), eq(boardFollowups.id, refs.fromId)),
    )
    .where(
      and(
        eq(refs.ownerId, ownerId),
        inArray(refs.role, ['made_with', 'attached']),
        or(
          and(eq(refs.fromType, 'card'), inArray(refs.fromId, ids)),
          and(
            eq(refs.fromType, 'followup'),
            inArray(boardFollowups.cardId, ids),
            isNull(boardFollowups.archivedAt),
          ),
        ),
      ),
    )
    .groupBy(sql`coalesce(${boardFollowups.cardId}, ${refs.fromId})`)
  return rows
}
