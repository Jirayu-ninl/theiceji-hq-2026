import { Loading } from '@/components/Loading'

/**
 * A page loading inside the Bridge frame: the frame stays, the stage reads
 * `…` until the page's reads land.
 */
export default function PageLoading() {
  return <Loading label='Loading…' />
}
