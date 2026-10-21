import {
  type AssetListItem,
  assetTitle,
  collectionHeld,
} from '@theiceji/hq-assets/assets'
import type { AssetCollectionRow, AssetRow } from '@theiceji/hq-db/schema'

/** Assets as they cross to the page: plain JSON, dates as ISO strings. */

export type AssetData = {
  id: string
  projectId: string | null
  /** The file name as uploaded — what a download saves as. */
  name: string
  /** What HQ calls it: the owner's title, else the file name (`assetTitle`). */
  title: string
  /** The owner renamed it. */
  titled: boolean
  path: string
  kind: AssetRow['kind']
  mime: string
  bytes: number
  sha256: string | null
  sha256Note: string | null
  width: number | null
  height: number | null
  durationMs: number | null
  origin: AssetRow['origin']
  status: AssetRow['status']
  problem: string | null
  tags: string[]
  storage: AssetRow['storageProvider']
  hasThumb: boolean
  actorType: AssetRow['actorType']
  collectionIds: string[]
  revision: number
  createdAt: string
  readyAt: string | null
}

export type CollectionData = {
  id: string
  projectId: string | null
  name: string
  kind: AssetCollectionRow['kind']
  count: number
  revision: number
  /** Why it keeps its name and stays (HQ files into it), or null: the owner may rename or delete it. */
  held: string | null
}

export function assetData(asset: AssetRow | AssetListItem): AssetData {
  return {
    id: asset.id,
    projectId: asset.projectId,
    name: asset.name,
    title: assetTitle(asset),
    titled: asset.title !== null,
    path: asset.path,
    kind: asset.kind,
    mime: asset.mime,
    bytes: asset.bytes,
    sha256: asset.sha256,
    sha256Note: asset.sha256Note,
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
    origin: asset.origin,
    status: asset.status,
    problem: asset.problem,
    tags: asset.tags,
    storage: asset.storageProvider,
    hasThumb: Boolean(asset.thumbKey),
    actorType: asset.actorType,
    collectionIds: 'collectionIds' in asset ? asset.collectionIds : [],
    revision: asset.revision,
    createdAt: asset.createdAt.toISOString(),
    readyAt: asset.readyAt?.toISOString() ?? null,
  }
}

export function collectionData(
  collection: AssetCollectionRow & { count: number },
): CollectionData {
  return {
    id: collection.id,
    projectId: collection.projectId,
    name: collection.name,
    kind: collection.kind,
    count: collection.count,
    revision: collection.revision,
    held: collectionHeld(collection),
  }
}
