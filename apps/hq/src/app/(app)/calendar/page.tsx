import type { Metadata } from 'next'
import { currentActor } from '@/lib/actions'
import { CalendarPage } from '@/modules/calendar/components/CalendarPage'
import { loadCalendar } from '@/modules/calendar/load'
import '@/modules/calendar/calendar.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Calendar — HQ' }

/** `/calendar` — every event, every project's dues, in Bangkok time. */
export default async function AllCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; day?: string; event?: string }>
}) {
  const props = await loadCalendar(
    await currentActor(),
    null,
    await searchParams,
  )
  return <CalendarPage key={`${props.view}-${props.from}`} {...props} />
}
