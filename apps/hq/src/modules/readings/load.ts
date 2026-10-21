import 'server-only'
import type { AgeReading } from '@theiceji/hq-core/readings'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { dashboard } from '@theiceji/hq-readings/readings'
import { ageReadingData } from '@/modules/experiments/data'
import '@/modules/register'
import type { DashboardPageProps } from './components/DashboardPage'

/**
 * What the Readings dashboard reads on the server — one project's (with
 * Readings on) or every live project's money, the window before, cost, and
 * posts and listings read at the chosen age.
 */

const WINDOWS = [7, 30, 90] as const
const AGES = [24, 72, 168] as const

export async function loadDashboard(
  actor: Actor,
  project: ProjectRow | null,
  params: { days?: string; age?: string },
): Promise<DashboardPageProps> {
  const days = WINDOWS.find((value) => String(value) === params.days) ?? 7
  const ageHours = AGES.find((value) => String(value) === params.age) ?? 72
  const read = await dashboard(actor, {
    projectId: project?.id,
    days,
    ageHours,
  })
  const reading = (value: AgeReading) => ageReadingData(value)
  return {
    project: project
      ? {
          id: project.id,
          slug: project.slug,
          name: project.name,
          color: project.color,
        }
      : null,
    days,
    ageHours,
    readAt: read.readAt.toISOString(),
    total: read.total,
    previousTotal: read.previousTotal,
    cost: read.cost,
    costUnknown: read.costUnknown,
    projects: read.projects.map((board) => ({
      project: {
        id: board.project.id,
        slug: board.project.slug,
        name: board.project.name,
        color: board.project.color,
        kind: board.project.kind,
        status: board.project.status,
        modules: board.project.modules.enabled,
      },
      money: board.money,
      previous: board.previous,
      cost: board.cost,
      costUnknown: board.costUnknown,
      subjects: board.subjects.map((panel) => ({
        type: panel.type,
        metric: panel.metric,
        rows: panel.rows.map((row) => ({
          id: row.id,
          title: row.title,
          where: row.where,
          status: row.status,
          href: row.href,
          wentOutAt: row.wentOutAt?.toISOString() ?? null,
          atAge: reading(row.atAge),
          toDate: reading(row.toDate),
        })),
      })),
    })),
  }
}
