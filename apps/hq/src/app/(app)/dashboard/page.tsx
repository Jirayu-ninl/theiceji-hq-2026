import type { Metadata } from 'next'
import { currentActor } from '@/lib/actions'
import { DashboardPage } from '@/modules/readings/components/DashboardPage'
import { loadDashboard } from '@/modules/readings/load'
import '@/modules/readings/readings.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Readings — HQ' }

/**
 * `/dashboard` — Readings across every live project: money, cost and
 * readings on one page (the route is still called dashboard; the owner sees
 * Readings everywhere). Home's money widget opens it. `?days=&age=&view=items`.
 */
export default async function AllProjectsDashboard({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; age?: string; view?: string }>
}) {
  const query = await searchParams
  const props = await loadDashboard(await currentActor(), null, query)
  return (
    <DashboardPage
      {...props}
      view={query.view === 'items' ? 'items' : 'money'}
    />
  )
}
