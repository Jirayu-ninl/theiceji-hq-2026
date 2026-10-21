import type { Metadata } from 'next'
import { Suspense } from 'react'
import { HomeView } from '@/components/home/HomeView'
import { Space } from '@/components/home/Space'
import { State } from '@/components/home/State'
import { Time } from '@/components/home/Time'
import '@/components/home/space.css'
import { Loading } from '@/components/Loading'
import { currentActor } from '@/lib/actions'
import { loadHome } from '@/lib/home'
import { loadState } from '@/lib/state'
import { loadTime } from '@/lib/time'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Home — HQ' }

type SearchParams = Promise<Record<string, string | string[] | undefined>>
type Projection = 'space' | 'state' | 'time'

/**
 * `/` — Home on Bridge: one overview, three projections,
 * each a URL (`1` `2` `3` in the top bar's views).
 *
 * · **Space** (`/`) — what is where, and what needs you: the orbit, the
 *   widgets and Waiting for you.
 * · **State** (`/?view=state`) — every project × module as one number and
 *   one state, with the notes browser and the device pane.
 * · **Time** (`/?view=time`) — this week's tracks per project, the playhead,
 *   and the rack of waiting, money and the selection.
 *
 * A bare `/` opened fresh follows `hq.home.view` (`HomeView`).
 *
 * The page answers before its reads do: switching projection shows `…` at
 * once and the projection streams in when its reads land.
 * The boundary is keyed by projection only — stepping Time's week keeps the
 * week on screen and marks it busy instead.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const params = await searchParams
  const view: Projection =
    params.view === 'state' || params.view === 'time' ? params.view : 'space'
  const week = typeof params.week === 'string' ? params.week : undefined
  return (
    <>
      <HomeView view={view} />
      <Suspense key={view} fallback={<Loading label='Loading Home…' />}>
        <HomeProjection view={view} week={week} />
      </Suspense>
    </>
  )
}

async function HomeProjection({
  view,
  week,
}: {
  view: Projection
  week: string | undefined
}) {
  const actor = await currentActor()
  if (view === 'state') return <State data={await loadState(actor)} />
  if (view === 'time') return <Time data={await loadTime(actor, { week })} />
  return <Space data={await loadHome(actor)} />
}
