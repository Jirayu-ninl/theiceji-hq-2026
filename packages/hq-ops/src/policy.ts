import {
  MODULE_IDS,
  type ModuleId,
  OPS_AGENT_ACTIONS,
  OPS_KILL_SWITCH_SCOPES,
  OPS_POLICY_COVERAGE,
  OPS_POLICY_STATUSES,
  OPS_RELEASE_MODES,
} from '@theiceji/hq-db/enums'
import {
  type OpsKillSwitchRow,
  type OpsPolicyRow,
  oauthGrants,
  opsKillSwitches,
  opsPolicies,
  opsReleaseAuthorizations,
  type ProjectRow,
} from '@theiceji/hq-db/schema'
import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import { type Actor, assertCan, assertKernelRead } from './access'
import { dbNow, isUuid, type Reader, type Tx } from './db'
import { conflict, invalid } from './errors'
import {
  currentPolicy,
  engagedKillSwitches,
  type PolicyState,
  policyState,
  sameProject,
} from './policy-gate'
import {
  choice,
  choiceList,
  idList,
  int,
  machineKey,
  parseInput,
  stringList,
  text,
} from './schemas'
import {
  audit,
  authorize,
  ownedRow,
  ownProject,
  returned,
  withReader,
  withTransaction,
} from './store'
import { DEFAULT_TIME_ZONE, parseInstant } from './time'
import { auditSnapshot, diffFields, toMinorUnits } from './values'

/**
 * Operating policy and kill switches — owner actions.
 *
 * A policy is written once per change as a new revision, per project or — for
 * work in no project — per owner; the newest one is in force. There is no
 * inheritance between the two (policy-gate.ts). Every service that lets an
 * agent act reads it through `authorize()`, and every reservation and
 * authorization names the revision it ran under.
 *
 * None of this is reachable by an agent: the capability is `manage`, which no
 * connection scope grants, so a connection is refused with a message that
 * points it at `agents_request_human`.
 *
 * What only one module reads is not a column here: it lives in
 * `extensions[module]`, validated by the parser that module registers.
 */

/** Conditions that stop agent work outright when they occur. */
export const STOP_CONDITIONS = [
  'unknown_quota',
  'provider_unhealthy',
  'budget_exhausted',
  'rights_unverified',
  'claims_unsupported',
] as const
export type StopCondition = (typeof STOP_CONDITIONS)[number]

/** A policy's currency when there is no project to take it from. */
export const DEFAULT_CURRENCY = 'THB'

const money = (label: string) => text.optional(label, 32)

const unitLimit = z.object({
  perJob: z.coerce.number().int().min(0).optional(),
  perDay: z.coerce.number().int().min(0).optional(),
  perMonth: z.coerce.number().int().min(0).optional(),
})

const policySchema = z.object({
  /** The revision the form was rendered from; 0 when there is none yet. */
  expectedRevisionNo: z.coerce
    .number({ error: 'Reload the page and try again.' })
    .int()
    .min(0),
  status: choice(OPS_POLICY_STATUSES, 'Choose active or suspended.'),
  releaseMode: choice(OPS_RELEASE_MODES, 'Choose how releases happen.'),
  coverage: choice(
    OPS_POLICY_COVERAGE,
    'Choose which connections the policy covers.',
  ),
  grantIds: idList('Connection', 50).optional(),
  allowedActions: choiceList(
    OPS_AGENT_ACTIONS,
    'That isn’t an action a policy can allow.',
  ),
  /** Platform accounts or marketplaces (their module's record IDs). */
  allowedAccountIds: idList('Account', 50).optional(),
  allowedProviders: z
    .preprocess(
      (value) =>
        typeof value === 'string'
          ? value
              .split(/[\n,]/)
              .map((entry) => entry.trim())
              .filter(Boolean)
          : value,
      z.array(machineKey('Provider', 60)).max(50),
    )
    .optional(),
  /** Only for a policy of work in no project; a project's currency is its own. */
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code.')
    .optional(),
  cashLimitPerJob: money('Cash per job'),
  cashLimitPerDay: money('Cash per day'),
  cashLimitPerMonth: money('Cash per month'),
  unitLimits: z.record(machineKey('Unit', 120), unitLimit).optional(),
  maxConcurrentJobs: int('Concurrent jobs', 0, 50),
  maxPostsPerAccountPerDay: int('Posts per account per day', 0, 50),
  postCooldownMinutes: int('Cooldown between posts', 0, 10_080),
  wipLimit: int('WIP limit', 0, 1000),
  operatorMinutesPerWeek: int('Owner minutes per week', 0, 10_080),
  stopConditions: choiceList(
    STOP_CONDITIONS,
    'Unknown stop condition.',
  ).optional(),
  digest: choice(['daily', 'weekly'], 'Choose a digest cadence.').optional(),
  urgentKinds: stringList('kinds', 20, 40).optional(),
  effectiveFrom: text.optional('Effective from', 40),
  expiresAt: text.optional('Expires at', 40),
  note: text.optional('Note', 2000),
  /**
   * Module settings, keyed by module id. A key that is absent keeps the
   * previous revision's settings; `null` drops them; anything else goes
   * through that module's registered parser.
   */
  extensions: z.record(z.string().max(40), z.unknown()).optional(),
})

export type PolicyInput = z.input<typeof policySchema>

/* ── Module policy extensions ───────────────────────────────────────── */

type ExtensionParser = (raw: unknown) => Record<string, unknown>

const extensionParsers = new Map<ModuleId, ExtensionParser>()

/**
 * Called by a module package to own the part of a policy only it reads
 * (market: listing caps, price bounds; publish: offer freshness). The parser
 * throws on bad input; its output is what gets stored.
 */
export function registerPolicyExtension(
  module: ModuleId,
  parse: ExtensionParser,
): void {
  extensionParsers.set(module, parse)
}

function parseExtensions(
  raw: Record<string, unknown> | undefined,
  previous: OpsPolicyRow | null,
): Record<string, Record<string, unknown>> {
  const next: Record<string, Record<string, unknown>> = {
    ...(previous?.extensions ?? {}),
  }
  if (!raw) return next
  const unknown = Object.keys(raw).filter(
    (key) => !(MODULE_IDS as readonly string[]).includes(key),
  )
  if (unknown.length)
    throw invalid('Policy settings are kept per module.', {
      extensions: `Not a module: ${unknown.join(', ')}.`,
    })
  for (const [key, value] of Object.entries(raw)) {
    const module = key as ModuleId
    if (value === undefined) continue
    if (value === null) {
      delete next[module]
      continue
    }
    const parse = extensionParsers.get(module)
    if (!parse)
      throw invalid(`This build can’t read ${module} policy settings.`, {
        extensions: `No settings for ${module}.`,
      })
    try {
      next[module] = parse(value)
    } catch (e) {
      throw invalid(
        `The ${module} settings aren’t valid: ${e instanceof Error ? e.message.slice(0, 300) : 'check them'}.`,
        { extensions: `Invalid ${module} settings.` },
      )
    }
  }
  return next
}

function minor(
  raw: string | null | undefined,
  currency: string,
  field: string,
): number | null {
  if (raw === undefined || raw === null) return null
  const { minor: value, error } = toMinorUnits(raw, currency)
  if (error) throw invalid(error, { [field]: error })
  return value
}

function instant(
  raw: string | null | undefined,
  timeZone: string,
  field: string,
): Date | null {
  if (!raw) return null
  const at = parseInstant(raw, timeZone)
  if (!at)
    throw invalid('Use a valid date and time.', {
      [field]: 'Use a valid date and time.',
    })
  return at
}

async function assertOwnGrants(
  reader: Reader,
  actor: Actor,
  grantIds: string[],
): Promise<void> {
  if (grantIds.length === 0) return
  const rows = await reader
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .where(
      and(
        inArray(oauthGrants.id, grantIds),
        eq(oauthGrants.userId, actor.userId),
        isNull(oauthGrants.revokedAt),
      ),
    )
  if (rows.length !== new Set(grantIds).size)
    throw invalid(
      'Choose connections that belong to you and are not revoked.',
      {
        grantIds: 'Unknown or revoked connection.',
      },
    )
}

/**
 * The project an owner action is about, or null for their no-project work —
 * with the owner-only gate either way.
 */
async function managedScope(
  reader: Reader,
  actor: Actor,
  projectId: string | null,
): Promise<ProjectRow | null> {
  assertCan(actor, 'hq', 'manage')
  const project = projectId ? await ownProject(reader, actor, projectId) : null
  await authorize(reader, actor, project, 'hq', 'manage')
  return project
}

/**
 * Writes the next policy revision for a project, or (`projectId` null) for
 * the owner's work in no project. The form sends the whole policy, so an
 * omitted list means "none" — widening what agents may do is always
 * explicit.
 */
export async function savePolicy(
  actor: Actor,
  projectId: string | null,
  raw: unknown,
): Promise<OpsPolicyRow> {
  const input = parseInput(policySchema, raw)
  return withTransaction(async (tx) => {
    const project = await managedScope(tx, actor, projectId)
    const scope = project?.id ?? null
    const previous = await currentPolicy(tx, actor.userId, scope)
    if ((previous?.revisionNo ?? 0) !== input.expectedRevisionNo)
      throw conflict(
        'The policy changed since you opened it. Reload to see the newest revision.',
      )
    if (project && input.currency && input.currency !== project.currency)
      throw invalid(
        `A project’s policy is in its own currency (${project.currency}).`,
        {
          currency: `Use ${project.currency}.`,
        },
      )
    const currency = project?.currency ?? input.currency ?? DEFAULT_CURRENCY
    const timeZone = project?.timezone ?? DEFAULT_TIME_ZONE
    const grantIds = [...new Set(input.grantIds ?? [])]
    if (input.coverage === 'selected' && grantIds.length === 0)
      throw invalid('Choose at least one connection, or cover all of them.', {
        grantIds: 'Required when the policy covers selected connections.',
      })
    await assertOwnGrants(tx, actor, grantIds)
    const allowedAccountIds = [...new Set(input.allowedAccountIds ?? [])]
    const allowedActions = [...new Set(input.allowedActions)]
    for (const action of ['publish', 'list'] as const)
      if (allowedActions.includes(action) && allowedAccountIds.length === 0)
        throw invalid(
          action === 'publish'
            ? 'Publishing needs at least one account the policy allows posting to.'
            : 'Listing needs at least one marketplace the policy allows listing on.',
          { allowedAccountIds: `Required when ${action} is allowed.` },
        )
    const effectiveFrom = instant(
      input.effectiveFrom,
      timeZone,
      'effectiveFrom',
    )
    const expiresAt = instant(input.expiresAt, timeZone, 'expiresAt')
    if (expiresAt) {
      const start = effectiveFrom ?? (await dbNow(tx))
      if (expiresAt.getTime() <= start.getTime())
        throw invalid('The policy must expire after it takes effect.', {
          expiresAt: 'Must be after the start.',
        })
    }

    const values = {
      status: input.status,
      releaseMode: input.releaseMode,
      coverage: input.coverage,
      grantIds: input.coverage === 'selected' ? grantIds : [],
      allowedActions,
      allowedAccountIds,
      allowedProviders: [...new Set(input.allowedProviders ?? [])],
      currency,
      cashLimitPerJobMinor: minor(
        input.cashLimitPerJob,
        currency,
        'cashLimitPerJob',
      ),
      cashLimitPerDayMinor: minor(
        input.cashLimitPerDay,
        currency,
        'cashLimitPerDay',
      ),
      cashLimitPerMonthMinor: minor(
        input.cashLimitPerMonth,
        currency,
        'cashLimitPerMonth',
      ),
      unitLimits: input.unitLimits ?? {},
      maxConcurrentJobs: input.maxConcurrentJobs ?? 1,
      maxPostsPerAccountPerDay: input.maxPostsPerAccountPerDay ?? 0,
      postCooldownMinutes: input.postCooldownMinutes ?? 0,
      wipLimit: input.wipLimit ?? null,
      operatorMinutesPerWeek: input.operatorMinutesPerWeek ?? null,
      stopConditions: [...new Set(input.stopConditions ?? [])],
      escalation: {
        digest: input.digest ?? 'daily',
        urgentKinds: input.urgentKinds ?? [],
      },
      expiresAt,
      note: input.note ?? null,
      extensions: parseExtensions(input.extensions, previous),
    }
    const policy = returned(
      (
        await tx
          .insert(opsPolicies)
          .values({
            ...values,
            ownerId: actor.userId,
            projectId: scope,
            revisionNo: (previous?.revisionNo ?? 0) + 1,
            supersedesId: previous?.id ?? null,
            // The database's clock: the gate compares against it (dbNow).
            effectiveFrom: effectiveFrom ?? sql`now()`,
            createdBy: actor.userId,
          })
          .returning()
      )[0],
    )
    await audit(tx, actor, {
      projectId: scope,
      action: previous ? 'policy.revise' : 'policy.create',
      targetType: 'operating_policy',
      targetId: policy.id,
      beforeRevision: previous?.revisionNo ?? null,
      afterRevision: policy.revisionNo,
      changes: previous
        ? diffFields(
            previous as unknown as Record<string, unknown>,
            values as unknown as Record<string, unknown>,
          )
        : auditSnapshot(values as unknown as Record<string, unknown>),
    })
    return policy
  })
}

export type PolicyOverview = {
  /** Null for the policy of work in no project. */
  project: ProjectRow | null
  policy: OpsPolicyRow | null
  revisions: OpsPolicyRow[]
  /** Switches engaged right now that apply here (the owner's `all` included). */
  switches: OpsKillSwitchRow[]
  /** The latest switches of this scope, released ones included, newest first. */
  switchHistory: OpsKillSwitchRow[]
  /** Whether the policy is usable at all, for a connection it covers. */
  inForce: boolean
  reason: string | null
}

export async function getPolicyOverview(
  actor: Actor,
  projectId: string | null,
): Promise<PolicyOverview> {
  assertKernelRead(actor)
  return withReader(async (db) => {
    const project = projectId ? await ownProject(db, actor, projectId) : null
    const scope = project?.id ?? null
    const revisions = await db
      .select()
      .from(opsPolicies)
      .where(
        and(
          eq(opsPolicies.ownerId, actor.userId),
          sameProject(opsPolicies.projectId, scope),
        ),
      )
      .orderBy(desc(opsPolicies.revisionNo))
      .limit(50)
    const policy = revisions[0] ?? null
    // Coverage is judged for a connection the policy covers, so a
    // selected-connections policy still reads as in force here.
    const probe: Actor = {
      ...actor,
      grantId: policy?.grantIds[0] ?? actor.grantId,
    }
    const state: PolicyState = policyState(policy, probe, await dbNow(db))
    const switches = await engagedKillSwitches(db, actor.userId, scope)
    const switchHistory = await db
      .select()
      .from(opsKillSwitches)
      .where(
        and(
          eq(opsKillSwitches.ownerId, actor.userId),
          sameProject(opsKillSwitches.projectId, scope),
        ),
      )
      .orderBy(desc(opsKillSwitches.engagedAt))
      .limit(20)
    return {
      project,
      policy,
      revisions,
      switches,
      switchHistory,
      inForce: state.ok,
      reason: state.ok ? null : state.reason,
    }
  })
}

/* ── Kill switches ──────────────────────────────────────────────────── */

const engageSchema = z.object({
  scope: choice(OPS_KILL_SWITCH_SCOPES, 'Choose what to stop.'),
  target: text.optional('Target', 200),
  reason: text.required('Reason', 1000),
})

const releaseSchema = z.object({ reason: text.required('Reason', 1000) })

export type StoppedWork = { type: string; id: string; status: string }

export type EngageOutcome = {
  switch: OpsKillSwitchRow
  /** Work that had not reached a provider and will not be sent. */
  stopped: StoppedWork[]
  /** Work a provider may already have — reconcile it; it may still happen. */
  inFlight: StoppedWork[]
  revokedAuthorizations: string[]
}

/**
 * The target a switch names, checked against what the kernel can check:
 * `all` and `project` name none; a connection is one of the owner's grants; a
 * provider is a provider key. Accounts and marketplaces are module records the
 * kernel holds no key into, so they are taken as IDs and matched by value.
 */
async function validateTarget(
  tx: Tx,
  actor: Actor,
  scope: OpsKillSwitchRow['scope'],
  projectId: string | null,
  target: string | null,
): Promise<string | null> {
  if (scope === 'all') {
    if (projectId)
      throw invalid(
        'Stopping everything names no project. Use a project switch for one project.',
      )
    return null
  }
  if (scope === 'project') {
    if (!projectId)
      throw invalid('Choose the project to stop.', { projectId: 'Required.' })
    return null
  }
  if (!target) throw invalid('Say which one to stop.', { target: 'Required.' })
  if (scope === 'connection') {
    if (!isUuid(target)) throw invalid('Choose one of your connections.')
    await assertOwnGrants(tx, actor, [target])
  }
  if (scope === 'provider' && !/^[a-z0-9][a-z0-9_.:-]*$/.test(target))
    throw invalid('Name the provider by its key, e.g. agent:fal.', {
      target: 'Not a provider key.',
    })
  if ((scope === 'account' || scope === 'marketplace') && !isUuid(target))
    throw invalid(`Choose the ${scope} to stop.`, { target: 'Not an ID.' })
  return target
}

/* ── Kill switch effects of modules ─────────────────────────────────── */

export type KillSwitchEffect = (
  tx: Tx,
  actor: Actor,
  engaged: OpsKillSwitchRow,
  project: ProjectRow | null,
) => Promise<{
  stopped: StoppedWork[]
  inFlight: StoppedWork[]
  revokedAuthorizations: string[]
}>

const killSwitchEffects: KillSwitchEffect[] = []

/**
 * A module's own queued work stops with the same switch: publish blocks posts
 * that haven't left and market blocks listing dispatches, in the transaction
 * that engages the switch. No module registers one yet.
 */
export function registerKillSwitchEffect(effect: KillSwitchEffect): void {
  if (!killSwitchEffects.includes(effect)) killSwitchEffects.push(effect)
}

/** Active release authorizations an engaged switch voids. */
function authorizationsInScope(
  ownerId: string,
  engaged: OpsKillSwitchRow,
): SQL | null {
  const base = and(
    eq(opsReleaseAuthorizations.ownerId, ownerId),
    eq(opsReleaseAuthorizations.status, 'active'),
  ) as SQL
  const inProject = engaged.projectId
    ? eq(opsReleaseAuthorizations.projectId, engaged.projectId)
    : undefined
  switch (engaged.scope) {
    case 'all':
      return base
    case 'project':
      return and(base, inProject) as SQL
    case 'account':
    case 'marketplace':
      return and(
        base,
        inProject,
        eq(opsReleaseAuthorizations.targetRef, engaged.target ?? ''),
      ) as SQL
    default:
      // A provider or connection switch stops the dispatch at the gate; the
      // authorization itself stays valid for another route.
      return null
  }
}

/**
 * Engages a kill switch. New agent work in scope is refused from the next
 * call; release authorizations in scope are revoked here and now; modules
 * stop their queued work through their registered effects; anything already
 * submitted is listed as in flight, because stopping it is up to the
 * provider and HQ won't pretend otherwise.
 */
export async function engageKillSwitch(
  actor: Actor,
  projectId: string | null,
  raw: unknown,
): Promise<EngageOutcome> {
  const input = parseInput(engageSchema, raw)
  return withTransaction(async (tx) => {
    const project = await managedScope(tx, actor, projectId)
    const scope = project?.id ?? null
    const target = await validateTarget(
      tx,
      actor,
      input.scope,
      scope,
      input.target ?? null,
    )
    const [existing] = await tx
      .select({ id: opsKillSwitches.id })
      .from(opsKillSwitches)
      .where(
        and(
          eq(opsKillSwitches.ownerId, actor.userId),
          sameProject(opsKillSwitches.projectId, scope),
          eq(opsKillSwitches.scope, input.scope),
          target === null
            ? isNull(opsKillSwitches.target)
            : eq(opsKillSwitches.target, target),
          isNull(opsKillSwitches.releasedAt),
        ),
      )
      .limit(1)
    if (existing) throw conflict('That kill switch is already engaged.')
    const row = returned(
      (
        await tx
          .insert(opsKillSwitches)
          .values({
            ownerId: actor.userId,
            projectId: scope,
            scope: input.scope,
            target,
            reason: input.reason,
            engagedBy: actor.userId,
          })
          .returning()
      )[0],
    )

    const stopped: StoppedWork[] = []
    const inFlight: StoppedWork[] = []
    const revokedAuthorizations: string[] = []
    const voided = authorizationsInScope(actor.userId, row)
    if (voided) {
      const revoked = await tx
        .update(opsReleaseAuthorizations)
        .set({
          status: 'revoked',
          revokedAt: sql`now()`,
          statusReason: `Kill switch (${input.scope}): ${input.reason}`,
        })
        .where(voided)
        .returning({ id: opsReleaseAuthorizations.id })
      revokedAuthorizations.push(...revoked.map((entry) => entry.id))
    }
    for (const effect of killSwitchEffects) {
      const outcome = await effect(tx, actor, row, project)
      stopped.push(...outcome.stopped)
      inFlight.push(...outcome.inFlight)
      revokedAuthorizations.push(...outcome.revokedAuthorizations)
    }

    await audit(tx, actor, {
      projectId: scope,
      action: 'kill_switch.engage',
      targetType: 'kill_switch',
      targetId: row.id,
      reason: input.reason,
      changes: {
        scope: input.scope,
        target,
        stopped: stopped.length,
        inFlight: inFlight.length,
        revokedAuthorizations: revokedAuthorizations.length,
      },
    })
    return { switch: row, stopped, inFlight, revokedAuthorizations }
  })
}

export async function releaseKillSwitch(
  actor: Actor,
  switchId: string,
  raw: unknown,
): Promise<OpsKillSwitchRow> {
  const input = parseInput(releaseSchema, raw)
  return withTransaction(async (tx) => {
    assertCan(actor, 'hq', 'manage')
    const { row, project } = await ownedRow<OpsKillSwitchRow>(
      tx,
      actor,
      opsKillSwitches,
      switchId,
      'Kill switch',
      { lock: true },
    )
    await authorize(tx, actor, project, 'hq', 'manage')
    if (row.releasedAt) throw invalid('That kill switch is already released.')
    const [released] = await tx
      .update(opsKillSwitches)
      .set({
        releasedAt: sql`now()`,
        releasedBy: actor.userId,
        releaseReason: input.reason,
      })
      .where(
        and(eq(opsKillSwitches.id, row.id), isNull(opsKillSwitches.releasedAt)),
      )
      .returning()
    if (!released) throw conflict()
    await audit(tx, actor, {
      projectId: row.projectId,
      action: 'kill_switch.release',
      targetType: 'kill_switch',
      targetId: row.id,
      reason: input.reason,
      changes: { scope: row.scope, target: row.target },
    })
    return released
  })
}

export async function getKillSwitch(
  actor: Actor,
  switchId: string,
): Promise<OpsKillSwitchRow> {
  assertKernelRead(actor)
  return withReader(async (db) => {
    const { row } = await ownedRow<OpsKillSwitchRow>(
      db,
      actor,
      opsKillSwitches,
      switchId,
      'Kill switch',
    )
    return row
  })
}
