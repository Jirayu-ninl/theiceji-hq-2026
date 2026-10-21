import 'server-only'
import { listCards } from '@theiceji/hq-board/board'
import { monthGrid, weekRange } from '@theiceji/hq-calendar/dates'
import { calendarStatus, listEvents } from '@theiceji/hq-calendar/events'
import '@theiceji/hq-calendar/register'
import { listProjects } from '@theiceji/hq-core/projects'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { DEFAULT_TIME_ZONE, isDay, zonedDay } from '@theiceji/hq-ops/time'
import { listQuotes } from '@theiceji/hq-quotes/quotes'
import type { CalendarPageProps } from './components/CalendarPage'
import { eventData, type OverlayData, statusData } from './data'

/**
 * What a Calendar page reads on the server: the week (or the month's whole
 * weeks) around `?day=`, in the project's timezone; the Google sync status;
 * and the overlay — cards due and sent quotes running out in the range, read
 * from their own modules and never stored or synced here.
 */

export async function loadCalendar(
  actor: Actor,
  row: ProjectRow | null,
  params: { view?: string; day?: string; event?: string },
): Promise<CalendarPageProps> {
  const timezone = row?.timezone ?? DEFAULT_TIME_ZONE
  const today = zonedDay(new Date(), timezone)
  const day = params.day && isDay(params.day) ? params.day : today
  const view = params.view === 'month' ? 'month' : 'week'
  const monthSpan = view === 'month' ? monthGrid(day, timezone) : null
  const span = monthSpan ?? weekRange(day, timezone)
  const [range, status, projects] = await Promise.all([
    listEvents(actor, {
      from: span.from,
      to: span.to,
      projectId: row?.id,
      timezone,
      limit: 1000,
    }),
    calendarStatus(actor),
    row ? Promise.resolve([row]) : listProjects(actor),
  ])
  const colors = new Map(projects.map((entry) => [entry.id, entry.color]))
  const slugs = new Map(projects.map((entry) => [entry.id, entry.slug]))
  const overlay: OverlayData[] = []
  const boardOn = row ? row.modules.enabled.includes('board') : true
  const quotesOn = row ? row.modules.enabled.includes('quotes') : true
  const [cards, quotes] = await Promise.all([
    boardOn
      ? listCards(actor, row ? { projectId: row.id } : {}).catch(() => [])
      : Promise.resolve([]),
    quotesOn
      ? listQuotes(actor, {
          projectId: row?.id,
          status: 'sent',
          limit: 300,
        }).catch(() => [])
      : Promise.resolve([]),
  ])
  for (const card of cards)
    if (card.dueOn && card.dueOn >= span.from && card.dueOn <= span.to)
      overlay.push({
        id: `card-${card.id}`,
        kind: 'card',
        day: card.dueOn,
        label: card.title,
        projectId: card.projectId,
        color: card.projectId ? (colors.get(card.projectId) ?? null) : null,
        href: card.project
          ? `/p/${card.project.slug}/board?card=${card.id}`
          : `/board?card=${card.id}`,
      })
  for (const quote of quotes)
    if (
      quote.validUntil &&
      quote.validUntil >= span.from &&
      quote.validUntil <= span.to
    )
      overlay.push({
        id: `quote-${quote.id}`,
        kind: 'quote',
        day: quote.validUntil,
        label: `${quote.number} · runs out`,
        projectId: quote.projectId,
        color: quote.projectId ? (colors.get(quote.projectId) ?? null) : null,
        href:
          quote.projectId && slugs.get(quote.projectId)
            ? `/p/${slugs.get(quote.projectId)}/quotes?quote=${quote.id}`
            : `/quotes?quote=${quote.id}`,
      })
  return {
    project: row
      ? {
          id: row.id,
          slug: row.slug,
          name: row.name,
          color: row.color,
          status: row.status,
        }
      : null,
    projects: projects
      .filter((entry) => entry.modules.enabled.includes('calendar'))
      .map((entry) => ({
        id: entry.id,
        slug: entry.slug,
        name: entry.name,
        color: entry.color,
        status: entry.status,
      })),
    view,
    day,
    today,
    from: span.from,
    to: span.to,
    month: monthSpan?.month ?? null,
    timezone,
    events: range.events.map(eventData),
    overlay,
    status: statusData(status),
    selectedId: params.event ?? null,
  }
}
