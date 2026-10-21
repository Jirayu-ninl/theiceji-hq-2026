'use server'

import {
  authorizePost,
  deletePost,
  dispatchPost,
  getPost,
  markRemoved,
  planPost,
  recordManualPost,
  saveAccount,
  setAccountArchived,
  unschedulePost,
  updatePost,
} from '@theiceji/hq-publish/publish'
import { recordReading } from '@theiceji/hq-publish/readings'
import '@theiceji/hq-publish/register'
import { type ActionResult, runAction } from '@/lib/actions'
import type { AgeReadingData } from '@/modules/experiments/data'
import { type PostDetailData, postDetailData } from './data'
import { viewsAtAges } from './load'

/**
 * Publish's server actions — the hq-publish services the MCP tools run too.
 * Clearing a post is the owner's release of exactly that payload; recording
 * one made by hand puts it on the record with the owner's word. Every write
 * answers the post as it now is.
 */

type Actor = Parameters<Parameters<typeof runAction>[0]>[0]
const detail = async (actor: Actor, id: string) =>
  postDetailData(await getPost(actor, id))

export async function postAction(
  postId: string,
): Promise<ActionResult<PostDetailData>> {
  return runAction((actor) => detail(actor, postId), { read: true })
}

/** Views at the ruler's ages for one post, read again after a write. */
export async function postAgesAction(
  postId: string,
): Promise<ActionResult<Record<string, AgeReadingData>>> {
  return runAction(
    async (actor) => (await viewsAtAges(actor, [postId])).ages[postId] ?? {},
    { read: true },
  )
}

export type PostFields = {
  accountId?: string
  assetId?: string | null
  title?: string | null
  caption?: string
  aiGenerated?: boolean
  affiliate?: boolean
  scheduledFor?: string | null
}

const disclosure = (fields: PostFields) =>
  fields.aiGenerated === undefined && fields.affiliate === undefined
    ? undefined
    : { aiGenerated: fields.aiGenerated, affiliate: fields.affiliate }

export async function planPostAction(
  input: PostFields & { projectId: string; accountId: string },
): Promise<ActionResult<PostDetailData>> {
  return runAction(async (actor) => {
    const post = await planPost(actor, {
      projectId: input.projectId,
      accountId: input.accountId,
      assetId: input.assetId ?? undefined,
      title: input.title ?? undefined,
      caption: input.caption,
      disclosure: disclosure(input),
      scheduledFor: input.scheduledFor ?? undefined,
    })
    return detail(actor, post.id)
  })
}

export async function updatePostAction(
  input: PostFields & { postId: string; expectedRevision: number },
): Promise<ActionResult<PostDetailData>> {
  return runAction(async (actor) => {
    const post = await updatePost(actor, {
      postId: input.postId,
      expectedRevision: input.expectedRevision,
      accountId: input.accountId,
      assetId: input.assetId,
      title: input.title,
      caption: input.caption,
      disclosure: disclosure(input),
      scheduledFor: input.scheduledFor,
    })
    return detail(actor, post.id)
  })
}

/** The owner clears a post: a release authorization of exactly this payload. */
export async function clearPostAction(input: {
  postId: string
  expectedRevision: number
}): Promise<
  ActionResult<{ detail: PostDetailData; blockers: { message: string }[] }>
> {
  return runAction(async (actor) => {
    const outcome = await authorizePost(actor, input)
    return {
      detail: await detail(actor, input.postId),
      blockers: outcome.blockers,
    }
  })
}

export async function unschedulePostAction(input: {
  postId: string
  expectedRevision: number
}): Promise<ActionResult<PostDetailData>> {
  return runAction(async (actor) => {
    await unschedulePost(actor, input)
    return detail(actor, input.postId)
  })
}

export async function deletePostAction(input: {
  postId: string
  expectedRevision: number
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await deletePost(actor, input)
    return null
  })
}

export async function recordPostedAction(input: {
  postId: string
  expectedRevision: number
  url?: string
  externalId?: string
  postedAt?: string
  evidenceLevel?: 'owner_attested' | 'screenshot' | 'platform_export'
  evidenceNote?: string
}): Promise<ActionResult<PostDetailData>> {
  return runAction(async (actor) => {
    await recordManualPost(actor, {
      ...input,
      url: input.url || undefined,
      externalId: input.externalId || undefined,
      postedAt: input.postedAt || undefined,
    })
    return detail(actor, input.postId)
  })
}

export async function dispatchPostAction(input: {
  postId: string
}): Promise<ActionResult<{ detail: PostDetailData; message: string }>> {
  return runAction(async (actor) => {
    const outcome = await dispatchPost(actor, {
      postId: input.postId,
      idempotencyKey: `ui:${input.postId}:${crypto.randomUUID()}`,
    })
    return {
      detail: await detail(actor, input.postId),
      message: outcome.message,
    }
  })
}

export async function removePostAction(input: {
  postId: string
  expectedRevision: number
  reason: string
}): Promise<ActionResult<PostDetailData>> {
  return runAction(async (actor) => {
    await markRemoved(actor, input)
    return detail(actor, input.postId)
  })
}

export async function recordReadingAction(input: {
  postId: string
  metric: string
  value: string
  currency?: string
  asOf?: string
  windowStart?: string
  windowEnd?: string
  note?: string
  supersedesId?: string
  correctionReason?: string
}): Promise<ActionResult<PostDetailData>> {
  return runAction(async (actor) => {
    await recordReading(actor, {
      postId: input.postId,
      metric: input.metric,
      value: input.value,
      currency: input.currency || undefined,
      asOf: input.asOf || undefined,
      windowStart: input.windowStart || undefined,
      windowEnd: input.windowEnd || undefined,
      note: input.note || undefined,
      supersedesId: input.supersedesId || undefined,
      correctionReason: input.correctionReason || undefined,
    })
    return detail(actor, input.postId)
  })
}

export async function saveAccountAction(input: {
  projectId: string
  accountId?: string
  expectedRevision?: number
  platform: 'facebook' | 'youtube' | 'tiktok' | 'manual'
  handle: string
  profileUrl?: string
  externalAccountId?: string
  connectionId?: string | null
  notes?: string
}): Promise<ActionResult<{ id: string }>> {
  return runAction(async (actor) => {
    const account = await saveAccount(actor, {
      ...input,
      profileUrl: input.profileUrl || undefined,
      externalAccountId: input.externalAccountId || undefined,
      connectionId: input.connectionId || undefined,
    })
    return { id: account.id }
  })
}

export async function archiveAccountAction(input: {
  accountId: string
  expectedRevision: number
  archived: boolean
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await setAccountArchived(actor, input)
    return null
  })
}
