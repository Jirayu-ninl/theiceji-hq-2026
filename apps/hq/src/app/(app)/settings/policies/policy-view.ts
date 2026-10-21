import type {
  OpsAgentAction,
  OpsPolicyCoverage,
  OpsPolicyStatus,
  OpsReleaseMode,
} from '@theiceji/hq-db/enums'
import type { OpsPolicyRow } from '@theiceji/hq-db/schema'
import {
  DEFAULT_CURRENCY,
  type PolicyInput,
  STOP_CONDITIONS,
  type StopCondition,
} from '@theiceji/hq-ops/policy'
import { DEFAULT_TIME_ZONE, toLocalInput } from '@theiceji/hq-ops/time'
import { formatMinorUnits } from '@theiceji/hq-ops/values'

/**
 * The part of an operating policy Settings › Policies edits, as plain data
 * the client can hold (hq-ops `savePolicy` takes the whole policy and writes
 * it as the next revision). Money is in major units as text, the way the
 * kernel parses it; the end is wall-clock time in the policy's zone. What the
 * tab doesn't edit — accounts, providers, unit limits, posting limits, the
 * digest, module extensions — is carried over from the revision in force by
 * `policyInput`, read on the server, never round-tripped through the browser.
 */
export type EditablePolicy = {
  /** The revision this was read from; 0 when there is none yet. */
  revision: number
  status: OpsPolicyStatus
  releaseMode: OpsReleaseMode
  coverage: OpsPolicyCoverage
  grantIds: string[]
  allowedActions: OpsAgentAction[]
  stopConditions: StopCondition[]
  currency: string
  cashLimitPerJob: string
  cashLimitPerDay: string
  cashLimitPerMonth: string
  maxConcurrentJobs: string
  /** `YYYY-MM-DDTHH:mm` in `timeZone`, or '' for no end. */
  expiresAt: string
  timeZone: string
}

const money = (minor: number | null, currency: string) =>
  minor === null ? '' : formatMinorUnits(minor, currency)

/**
 * A policy as the tab edits it. With no policy yet, the draft is the
 * cautious one: active once saved, releases wait for the owner, every stop
 * condition on, nothing allowed, no money.
 */
export function editableOf(
  row: OpsPolicyRow | null,
  scope: { currency: string | null; timeZone: string | null },
): EditablePolicy {
  const timeZone = scope.timeZone ?? DEFAULT_TIME_ZONE
  if (!row)
    return {
      revision: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'all_connections',
      grantIds: [],
      allowedActions: [],
      stopConditions: [...STOP_CONDITIONS],
      currency: scope.currency ?? DEFAULT_CURRENCY,
      cashLimitPerJob: '',
      cashLimitPerDay: '',
      cashLimitPerMonth: '',
      maxConcurrentJobs: '1',
      expiresAt: '',
      timeZone,
    }
  return {
    revision: row.revisionNo,
    status: row.status,
    releaseMode: row.releaseMode,
    coverage: row.coverage,
    grantIds: row.grantIds,
    allowedActions: row.allowedActions,
    stopConditions: row.stopConditions.filter((entry): entry is StopCondition =>
      (STOP_CONDITIONS as readonly string[]).includes(entry),
    ),
    currency: row.currency,
    cashLimitPerJob: money(row.cashLimitPerJobMinor, row.currency),
    cashLimitPerDay: money(row.cashLimitPerDayMinor, row.currency),
    cashLimitPerMonth: money(row.cashLimitPerMonthMinor, row.currency),
    maxConcurrentJobs: String(row.maxConcurrentJobs),
    expiresAt: row.expiresAt ? toLocalInput(row.expiresAt, timeZone) : '',
    timeZone,
  }
}

/**
 * The whole policy for `savePolicy`: the tab's fields from the owner, the
 * rest from the revision in force. A policy of work in no project keeps its
 * own currency; a project's is the project's.
 */
export function policyInput(
  edit: EditablePolicy,
  previous: OpsPolicyRow | null,
  inProject: boolean,
): PolicyInput {
  const blank = (value: string) => (value.trim() === '' ? undefined : value)
  return {
    expectedRevisionNo: edit.revision,
    status: edit.status,
    releaseMode: edit.releaseMode,
    coverage: edit.coverage,
    grantIds: edit.coverage === 'selected' ? edit.grantIds : [],
    allowedActions: edit.allowedActions,
    allowedAccountIds: previous?.allowedAccountIds ?? [],
    allowedProviders: previous?.allowedProviders ?? [],
    currency: inProject ? undefined : (previous?.currency ?? DEFAULT_CURRENCY),
    cashLimitPerJob: blank(edit.cashLimitPerJob),
    cashLimitPerDay: blank(edit.cashLimitPerDay),
    cashLimitPerMonth: blank(edit.cashLimitPerMonth),
    unitLimits: previous?.unitLimits ?? {},
    maxConcurrentJobs: blank(edit.maxConcurrentJobs),
    maxPostsPerAccountPerDay: previous?.maxPostsPerAccountPerDay,
    postCooldownMinutes: previous?.postCooldownMinutes,
    wipLimit: previous?.wipLimit ?? undefined,
    operatorMinutesPerWeek: previous?.operatorMinutesPerWeek ?? undefined,
    stopConditions: edit.stopConditions,
    digest: previous?.escalation.digest,
    urgentKinds: previous?.escalation.urgentKinds,
    expiresAt: blank(edit.expiresAt),
    note: previous?.note ?? undefined,
  }
}
