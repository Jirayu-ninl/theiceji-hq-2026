import type { Metadata } from 'next'
import { currentActor } from '@/lib/actions'
import { AssetsPage } from '@/modules/assets/components/AssetsPage'
import { loadAllAssets } from '@/modules/assets/load'
import '@/modules/assets/assets.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Assets — HQ' }

/** `/assets` — every project's files, with a project column. */
export default async function AllAssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; asset?: string; collection?: string }>
}) {
  const props = await loadAllAssets(await currentActor(), await searchParams)
  return <AssetsPage {...props} />
}
