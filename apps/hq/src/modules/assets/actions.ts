'use server'

import {
  assetAccess,
  createCollection,
  deleteAsset,
  deleteCollection,
  finalizeUpload,
  getAsset,
  prepareThumbnail,
  prepareUpload,
  previewUrls,
  rejectAsset,
  renameCollection,
  setAssetTags,
  setAssetTitle,
  setCollectionMember,
  setThumbnail,
} from '@theiceji/hq-assets/assets'
import '@theiceji/hq-assets/register'
import { headers } from 'next/headers'
import { type ActionResult, runAction } from '@/lib/actions'
import {
  type AssetData,
  assetData,
  type CollectionData,
  collectionData,
} from './data'

/**
 * Assets' server actions: the three upload steps, links, title, tags,
 * collections, reject and delete — each an hq-assets service. The MCP tools run the same
 * ones, less the removals, which are the owner's in HQ.
 * The bytes never pass through here: the browser sends them straight to
 * the URL `prepareUploadAction` answers.
 */

export type PreparedUploadData = {
  asset: AssetData
  upload:
    | { mode: 'presigned_put'; url: string; headers: Record<string, string> }
    | { mode: 'resumable'; url: string }
}

/** Step 1 — a pending asset and where to PUT its bytes. */
export async function prepareUploadAction(input: {
  projectId: string | null
  name: string
  mime: string
  bytes: number
  collectionId?: string
  /** The job this file answers (a shot's manual generation): stored as generated. */
  jobId?: string
}): Promise<ActionResult<PreparedUploadData>> {
  // Drive answers the browser's PUT only for the origin the session was
  // opened for — this page's own.
  const head = await headers()
  const origin = head.get('origin') ?? undefined
  return runAction(
    async (actor) => {
      const prepared = await prepareUpload(actor, { ...input, origin })
      const { upload } = prepared
      return {
        asset: assetData(prepared.asset),
        // The service refuses `proxy` uploads, so it is one of these two.
        upload:
          upload.mode === 'presigned_put'
            ? {
                mode: 'presigned_put' as const,
                url: upload.url,
                headers: upload.headers,
              }
            : {
                mode: 'resumable' as const,
                url: upload.mode === 'resumable' ? upload.sessionUrl : '',
              },
      }
    },
    { read: true },
  )
}

/** Step 3 — confirm the bytes and make the asset ready. */
export async function finalizeUploadAction(
  input: {
    assetId: string
    width?: number
    height?: number
    durationMs?: number
  },
  /** `quiet`: one file of a batch; the caller ends it with `refreshAction()`. */
  options: { quiet?: boolean } = {},
): Promise<ActionResult<AssetData>> {
  return runAction(
    async (actor) => assetData(await finalizeUpload(actor, input)),
    { quiet: options.quiet === true },
  )
}

/** A place for an R2 video's still, grabbed in the browser. */
export async function prepareThumbnailAction(input: {
  assetId: string
  bytes: number
}): Promise<
  ActionResult<{ url: string; headers: Record<string, string>; key: string }>
> {
  return runAction((actor) => prepareThumbnail(actor, input), { read: true })
}

export async function setThumbnailAction(
  input: {
    assetId: string
    key: string
  },
  /** `quiet`: part of an upload batch; the caller ends it with `refreshAction()`. */
  options: { quiet?: boolean } = {},
): Promise<ActionResult<AssetData>> {
  return runAction(
    async (actor) => assetData(await setThumbnail(actor, input)),
    { quiet: options.quiet === true },
  )
}

export async function rejectAssetAction(input: {
  assetId: string
  reason?: string
}): Promise<ActionResult<AssetData>> {
  return runAction(async (actor) => assetData(await rejectAsset(actor, input)))
}

export async function deleteAssetAction(
  assetId: string,
): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await deleteAsset(actor, assetId)
    return null
  })
}

export async function setTagsAction(input: {
  assetId: string
  expectedRevision: number
  tags: string[]
}): Promise<ActionResult<AssetData>> {
  return runAction(async (actor) => assetData(await setAssetTags(actor, input)))
}

/** A new title (empty puts the file name back); the file keeps its name and bytes. */
export async function setTitleAction(input: {
  assetId: string
  expectedRevision: number
  title: string
}): Promise<ActionResult<AssetData>> {
  return runAction(async (actor) =>
    assetData(await setAssetTitle(actor, input)),
  )
}

export async function setCollectionMemberAction(input: {
  collectionId: string
  assetId: string
  member: boolean
}): Promise<ActionResult<null>> {
  return runAction(async (actor) => {
    await setCollectionMember(actor, input)
    return null
  })
}

export async function createCollectionAction(input: {
  projectId: string | null
  name: string
  kind?: 'characters' | 'scenes' | 'refs' | 'generated' | 'custom'
}): Promise<ActionResult<CollectionData>> {
  return runAction(async (actor) =>
    collectionData({ ...(await createCollection(actor, input)), count: 0 }),
  )
}

/** The owner's: a new name; `count` is the page's, which a rename doesn't change. */
export async function renameCollectionAction(input: {
  collectionId: string
  expectedRevision: number
  name: string
  count: number
}): Promise<ActionResult<CollectionData>> {
  const { count, ...rename } = input
  return runAction(async (actor) =>
    collectionData({ ...(await renameCollection(actor, rename)), count }),
  )
}

/** The owner's: the grouping goes, every file in it stays. */
export async function deleteCollectionAction(
  collectionId: string,
): Promise<ActionResult<{ files: number }>> {
  return runAction((actor) => deleteCollection(actor, collectionId))
}

/** A short-lived link to the bytes — `download` saves it under its name. */
export async function accessUrlAction(input: {
  assetId: string
  download?: boolean
}): Promise<ActionResult<{ url: string }>> {
  return runAction(
    async (actor) => {
      const access = await assetAccess(actor, { ...input, ttlSeconds: 600 })
      return { url: access.url }
    },
    { read: true },
  )
}

export type AssetDetailData = {
  links: { type: string; id: string; role: string; direction: 'from' | 'to' }[]
  collectionIds: string[]
  preview: string | null
}

/** What the inspector shows beyond the row: links to other modules, collections, a preview. */
export async function assetDetailAction(
  assetId: string,
): Promise<ActionResult<AssetDetailData>> {
  return runAction(
    async (actor) => {
      const detail = await getAsset(actor, assetId)
      const previews = await previewUrls(actor, [detail.asset])
      return {
        links: detail.links,
        collectionIds: detail.collections.map((collection) => collection.id),
        preview: previews[detail.asset.id] ?? null,
      }
    },
    { read: true },
  )
}
