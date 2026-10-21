import type { AssetKind, PublishPlatform } from '@theiceji/hq-db/enums'
import {
  type AssetRow,
  assetAssets,
  type PublishAccountRow,
  type PublishPostRow,
  publishAccounts,
  publishPosts,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import type { Reader } from '@theiceji/hq-ops/db'
import { notFound } from '@theiceji/hq-ops/errors'
import {
  type Blocker,
  registerReleaseEvaluator,
} from '@theiceji/hq-ops/release'
import { hashRequest } from '@theiceji/hq-ops/store'
import { and, eq } from 'drizzle-orm'
import type { PublishPayload } from './adapters'

/**
 * What a post would send, and every reason it can't go yet. The release
 * authorization binds the hash of this payload, so editing a cleared post
 * — its caption, title, file, account or disclosure — makes the clearance
 * stop fitting, and the post goes back to planned.
 */

export type PostAsset = Pick<
  AssetRow,
  'id' | 'name' | 'kind' | 'mime' | 'status' | 'sha256' | 'bytes' | 'origin'
>

/** What a platform asks of a post before it can go (checked, never guessed). */
export const PLATFORM_RULES: Record<
  PublishPlatform,
  {
    label: string
    titleRequired: boolean
    titleMax: number
    captionMax: number
    /** File kinds it takes; empty means a post can be words only. */
    media: readonly AssetKind[]
    mediaRequired: boolean
  }
> = {
  youtube: {
    label: 'YouTube',
    titleRequired: true,
    titleMax: 100,
    captionMax: 5000,
    media: ['video'],
    mediaRequired: true,
  },
  tiktok: {
    label: 'TikTok',
    titleRequired: false,
    titleMax: 100,
    captionMax: 2200,
    media: ['video', 'image'],
    mediaRequired: true,
  },
  facebook: {
    label: 'Facebook',
    titleRequired: false,
    titleMax: 200,
    captionMax: 5000,
    media: ['video', 'image'],
    mediaRequired: false,
  },
  manual: {
    label: 'Other',
    titleRequired: false,
    titleMax: 200,
    captionMax: 5000,
    media: ['video', 'image', 'audio', 'doc', 'other'],
    mediaRequired: false,
  },
}

/** The hash an asset is bound by: its SHA-256, or its frozen size when it was too big to hash. */
export const assetBinding = (asset: PostAsset): string =>
  asset.sha256 ?? `size:${asset.bytes}`

export function payloadOf(
  post: PublishPostRow,
  account: PublishAccountRow,
  asset: PostAsset | null,
): PublishPayload {
  return {
    platform: account.platform,
    account: {
      id: account.id,
      handle: account.handle,
      externalAccountId: account.externalAccountId,
    },
    title: post.title,
    caption: post.caption,
    disclosure: {
      aiGenerated: post.disclosure.aiGenerated,
      affiliate: post.disclosure.affiliate,
      ...(post.disclosure.text ? { text: post.disclosure.text } : {}),
    },
    asset: asset
      ? {
          id: asset.id,
          sha256: assetBinding(asset),
          mime: asset.mime,
          name: asset.name,
        }
      : null,
  }
}

export const hashPayload = (payload: PublishPayload): string =>
  hashRequest('publish.post', payload)

/** Every reason the post can't be cleared or sent as it stands. */
export function postBlockers(
  post: PublishPostRow,
  account: PublishAccountRow,
  asset: PostAsset | null,
): Blocker[] {
  const blockers: Blocker[] = []
  const rules = PLATFORM_RULES[account.platform]
  if (post.status !== 'planned' && post.status !== 'scheduled')
    blockers.push({
      key: 'post_state',
      message: `This post is ${post.status}; only a planned or scheduled post can be released.`,
    })
  if (account.archivedAt)
    blockers.push({
      key: 'account_archived',
      message: `The account ${account.handle} is archived.`,
      remediation: 'Restore the account, or move the post to another one.',
    })
  if (rules.titleRequired && !post.title)
    blockers.push({
      key: 'title_missing',
      message: `${rules.label} needs a title.`,
    })
  if (post.title && post.title.length > rules.titleMax)
    blockers.push({
      key: 'title_long',
      message: `${rules.label} titles are at most ${rules.titleMax} characters.`,
    })
  if (post.caption.length > rules.captionMax)
    blockers.push({
      key: 'caption_long',
      message: `${rules.label} captions are at most ${rules.captionMax} characters.`,
    })
  if (!asset && rules.mediaRequired)
    blockers.push({
      key: 'asset_missing',
      message: `${rules.label} needs a ${rules.media.join(' or ')} file.`,
      remediation: 'Attach a ready asset to the post.',
    })
  if (!asset && !post.caption.trim() && !post.title)
    blockers.push({
      key: 'empty',
      message: 'There is nothing to post: no file, no title, no caption.',
    })
  if (asset) {
    if (asset.status !== 'ready')
      blockers.push({
        key: 'asset_not_ready',
        message: `The file ${asset.name} is ${asset.status}, not ready.`,
        remediation: 'Finish its upload, or attach another file.',
      })
    if (!rules.media.includes(asset.kind))
      blockers.push({
        key: 'asset_kind',
        message: `${rules.label} doesn’t take a ${asset.kind} file here.`,
      })
    if (asset.origin === 'generated' && !post.disclosure.aiGenerated)
      blockers.push({
        key: 'disclosure_ai',
        message:
          'The file was generated, but the post doesn’t say it was made with AI.',
        remediation: 'Turn on the AI disclosure before it goes out.',
      })
  }
  return blockers
}

/** A post with its account and file, read inside the caller's transaction. */
export async function postParts(
  reader: Reader,
  ownerId: string,
  postId: string,
): Promise<{
  post: PublishPostRow
  account: PublishAccountRow
  asset: PostAsset | null
}> {
  const [found] = await reader
    .select({ post: publishPosts, account: publishAccounts })
    .from(publishPosts)
    .innerJoin(publishAccounts, eq(publishAccounts.id, publishPosts.accountId))
    .where(and(eq(publishPosts.id, postId), eq(publishPosts.ownerId, ownerId)))
    .limit(1)
  if (!found) throw notFound('Post')
  let asset: PostAsset | null = null
  if (found.post.assetId) {
    const [row] = await reader
      .select({
        id: assetAssets.id,
        name: assetAssets.name,
        kind: assetAssets.kind,
        mime: assetAssets.mime,
        status: assetAssets.status,
        sha256: assetAssets.sha256,
        bytes: assetAssets.bytes,
        origin: assetAssets.origin,
      })
      .from(assetAssets)
      .where(
        and(
          eq(assetAssets.id, found.post.assetId),
          eq(assetAssets.ownerId, ownerId),
        ),
      )
      .limit(1)
    asset = row ?? null
  }
  return { post: found.post, account: found.account, asset }
}

/**
 * The kernel asks this whenever a post is authorized or its clearance is
 * consumed: the hash of what would go now, the file's bytes, where it would
 * go, and every reason it can't.
 */
registerReleaseEvaluator(
  'publish',
  'post',
  async (reader, actor: Actor, subject) => {
    const { post, account, asset } = await postParts(
      reader,
      actor.userId,
      subject.id,
    )
    if (subject.project && post.projectId !== subject.project.id)
      throw notFound('Post')
    return {
      payloadHash: hashPayload(payloadOf(post, account, asset)),
      asset: asset ? { id: asset.id, sha256: assetBinding(asset) } : null,
      targetRef: account.id,
      blockers: postBlockers(post, account, asset),
    }
  },
)
