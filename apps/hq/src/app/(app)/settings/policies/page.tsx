import { listProjects } from '@theiceji/hq-core/projects'
import { OPS_AGENT_ACTIONS } from '@theiceji/hq-db/enums'
import { getBudgetStatus } from '@theiceji/hq-ops/budget'
import { getPolicyOverview, type StopCondition } from '@theiceji/hq-ops/policy'
import { ACTION_LABEL } from '@theiceji/hq-ops/policy-gate'
import { formatMinorUnits } from '@theiceji/hq-ops/values'
import type { Metadata } from 'next'
import { currentActor } from '@/lib/actions'
import { listConnections } from '@/lib/oauth/grants'
import { TabKeys } from '../forms'
import { Bar, when } from '../parts'
import {
  type BudgetView,
  type EngagedSwitch,
  PoliciesView,
} from './PoliciesView'
import { editableOf } from './policy-view'

export const metadata: Metadata = { title: 'Policies — Settings — HQ' }
export const dynamic = 'force-dynamic'

/** The kernel's stop conditions, in words. */
const STOPS: [StopCondition, string][] = [
  ['unknown_quota', 'A provider’s quota isn’t known'],
  ['provider_unhealthy', 'A provider is unhealthy'],
  ['budget_exhausted', 'The budget is used up'],
  ['rights_unverified', 'The rights to an asset aren’t verified'],
  ['claims_unsupported', 'A claim can’t be backed up'],
]

/**
 * Settings › Policies: the operating
 * policy agents act under, read and written through hq-ops as the owner —
 * one per project, or HQ-wide for work in no project (`?project=<slug>`
 * picks the scope). Budgets, releases and kill switches are the kernel's own
 * groups; auto-accept is set on each routine in Agents and quiet hours are
 * each routine's schedule, which the tab says and links. No red button:
 * nothing here lets anything leave HQ.
 */
export default async function PoliciesSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>
}) {
  const params = await searchParams
  const actor = await currentActor()
  const projects = await listProjects(actor)
  const project = params.project
    ? (projects.find((entry) => entry.slug === params.project) ?? null)
    : null
  const projectId = project?.id ?? null
  const [overview, budget, connections] = await Promise.all([
    getPolicyOverview(actor, projectId),
    getBudgetStatus(actor, projectId).catch(() => null),
    listConnections(actor.userId).catch(() => []),
  ])
  const policy = editableOf(overview.policy, {
    currency: project?.currency ?? null,
    timeZone: project?.timezone ?? null,
  })
  const amount = (value: number, kind: 'cash' | 'units', unit: string) =>
    kind === 'cash' ? formatMinorUnits(value, unit) : String(value)
  const budgetView: BudgetView = budget
    ? {
        lines: budget.lines.map((line) => ({
          unit: line.unit,
          today: `${amount(line.day.committed, line.kind, line.unit)} of ${line.limits.perDay === null ? 'none' : amount(line.limits.perDay, line.kind, line.unit)}`,
          month: `${amount(line.month.committed, line.kind, line.unit)} of ${line.limits.perMonth === null ? 'none' : amount(line.limits.perMonth, line.kind, line.unit)}`,
        })),
        openReservations: budget.openReservations,
        unknownCosts: budget.unknownCostEvents,
      }
    : null
  const switches: EngagedSwitch[] = overview.switches.map((entry) => ({
    id: entry.id,
    scope: entry.scope,
    target: entry.target,
    projectId: entry.projectId,
    reason: entry.reason,
    since: when(entry.engagedAt),
  }))
  const scopeName = project?.name ?? 'HQ-wide'
  const saved = overview.policy

  return (
    <>
      <TabKeys keys={[['s', 'save budgets']]} />
      {params.project && !project ? (
        <p className='why' role='alert'>
          <b>No project “{params.project}”.</b> Showing the HQ-wide policy
          instead.
        </p>
      ) : null}
      <Bar
        items={[
          ['scope', scopeName],
          ['policy', saved ? `revision ${saved.revisionNo}` : 'none'],
          [
            'in force',
            overview.inForce ? 'yes' : '◆ no',
            overview.inForce ? 'live' : 'wait',
          ],
          ['agents may', saved ? saved.allowedActions.length : 0],
          [
            'cash / day',
            policy.cashLimitPerDay
              ? `${policy.cashLimitPerDay} ${policy.currency}`
              : 'none',
          ],
          ['concurrent', saved ? saved.maxConcurrentJobs : '—'],
          [
            'kill switches',
            switches.length > 0 ? `◆ ${switches.length} on` : 'off',
            switches.length > 0 ? 'wait' : '',
          ],
        ]}
      />
      <PoliciesView
        key={projectId ?? 'hq'}
        scope={{ projectId, slug: project?.slug ?? null, name: scopeName }}
        scopes={[
          { slug: null, name: 'HQ-wide — work in no project' },
          ...projects.map((entry) => ({ slug: entry.slug, name: entry.name })),
        ]}
        policy={policy}
        inForce={overview.inForce}
        reason={overview.reason}
        actions={OPS_AGENT_ACTIONS.map((action) => [
          action,
          ACTION_LABEL[action],
        ])}
        stops={STOPS}
        connections={connections.map((connection) => ({
          id: connection.id,
          label: connection.label,
          kind: connection.kind,
        }))}
        switches={switches}
        budget={budgetView}
        kept={{
          accounts: saved?.allowedAccountIds.length ?? 0,
          providers: saved?.allowedProviders ?? [],
          unitLimits: Object.entries(saved?.unitLimits ?? {}).map(
            ([unit, limit]) =>
              `${unit}: ${[
                limit.perJob != null ? `${limit.perJob}/job` : null,
                limit.perDay != null ? `${limit.perDay}/day` : null,
                limit.perMonth != null ? `${limit.perMonth}/month` : null,
              ]
                .filter(Boolean)
                .join(' · ')}`,
          ),
          postsPerDay: saved?.maxPostsPerAccountPerDay ?? 0,
          cooldownMinutes: saved?.postCooldownMinutes ?? 0,
        }}
      />
    </>
  )
}
