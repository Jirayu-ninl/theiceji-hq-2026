import type { Metadata } from 'next'
import { currentActor } from '@/lib/actions'
import { ClientsPage } from '@/modules/clients/components/ClientsPage'
import { loadClients } from '@/modules/clients/load'
import '@/modules/clients/clients.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Clients — HQ' }

/**
 * `/clients` — who the work is for, across every project.
 * `?view=archived` is the other view;
 * `?client=<id>` selects.
 */
export default async function ClientsRoute({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; client?: string }>
}) {
  const props = await loadClients(await currentActor(), await searchParams)
  return <ClientsPage key={props.view} {...props} />
}
