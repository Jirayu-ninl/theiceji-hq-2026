import type { Metadata } from 'next'
import { ModuleOff } from '@/components/ModulePending'
import { currentActor } from '@/lib/actions'
import { lite, projectForPage, projectsWith } from '@/lib/project-page'
import { CalendarPage } from '@/modules/calendar/components/CalendarPage'
import { loadCalendar } from '@/modules/calendar/load'
import '@/modules/calendar/calendar.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Calendar — HQ' }

/**
 * `/p/<slug>/calendar` — a project's events, in its own timezone.
 * `?view=month`; `?day=YYYY-MM-DD` moves; `?event=<id>`
 * selects.
 */
export default async function ProjectCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>
  searchParams: Promise<{ view?: string; day?: string; event?: string }>
}) {
  const [{ project: slug }, query] = await Promise.all([params, searchParams])
  const project = await projectForPage(slug)
  if (!project.modules.enabled.includes('calendar')) {
    const others = (await projectsWith('calendar')).filter(
      (other) => other.id !== project.id,
    )
    return (
      <ModuleOff module='calendar' project={lite(project)} others={others} />
    )
  }
  const props = await loadCalendar(await currentActor(), project, query)
  return (
    <CalendarPage
      key={`${project.id}-${props.view}-${props.from}`}
      {...props}
    />
  )
}
