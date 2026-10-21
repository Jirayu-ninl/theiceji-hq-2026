import 'server-only'
import {
  listAssets,
  listCollections,
  previewUrls,
} from '@theiceji/hq-assets/assets'
import '@theiceji/hq-assets/register'
import { listProjects } from '@theiceji/hq-core/projects'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import type { AssetsPageProps, AssetsProject } from './components/AssetsPage'
import { assetData, collectionData } from './data'

/**
 * What an Assets page reads on the server: one project's files (or every
 * project's with Assets on), its collections, and short-lived preview links
 * for the first page of tiles.
 */

const PAGE = 200

const project = (row: ProjectRow): AssetsProject => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  color: row.color,
  status: row.status,
})

const viewOf = (view?: string): AssetsPageProps['view'] =>
  view === 'list' ? 'list' : view === 'collections' ? 'collections' : 'grid'

export async function loadProjectAssets(
  actor: Actor,
  row: ProjectRow,
  params: { view?: string; asset?: string; collection?: string },
): Promise<AssetsPageProps> {
  const [{ assets, total }, collections] = await Promise.all([
    listAssets(actor, { projectId: row.id, limit: PAGE }),
    listCollections(actor, row.id),
  ])
  return {
    project: project(row),
    projects: [project(row)],
    assets: assets.map(assetData),
    total,
    collections: collections.map(collectionData),
    previews: await previewUrls(actor, assets.slice(0, 120)),
    view: viewOf(params.view),
    selectedId: params.asset ?? null,
    selectedCollectionId: params.collection ?? null,
  }
}

export async function loadAllAssets(
  actor: Actor,
  params: { view?: string; asset?: string; collection?: string },
): Promise<AssetsPageProps> {
  const [projects, { assets, total }] = await Promise.all([
    listProjects(actor),
    listAssets(actor, { limit: PAGE }),
  ])
  const withAssets = projects.filter((row) =>
    row.modules.enabled.includes('assets'),
  )
  const collections = (
    await Promise.all(withAssets.map((row) => listCollections(actor, row.id)))
  ).flat()
  return {
    project: null,
    projects: withAssets.map(project),
    assets: assets.map(assetData),
    total,
    collections: collections.map(collectionData),
    previews: await previewUrls(actor, assets.slice(0, 120)),
    view: viewOf(params.view),
    selectedId: params.asset ?? null,
    selectedCollectionId: params.collection ?? null,
  }
}
