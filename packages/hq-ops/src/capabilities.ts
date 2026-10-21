import {
  MODULE_IDS,
  OPS_CAPABILITY_STATES,
  type OpsCapabilityState,
} from '@theiceji/hq-db/enums'
import {
  type OpsCapabilityCheckRow,
  opsCapabilityChecks,
  type ProjectRow,
  providerConnections,
} from '@theiceji/hq-db/schema'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { type Actor, assertKernelRead, workScope } from './access'
import { dbNow, nowPlus, type Reader, type Tx } from './db'
import { invalid } from './errors'
import { sameProject } from './policy-gate'
import {
  choice,
  int,
  machineKey,
  optionalChoice,
  optionalRecordId,
  parseInput,
  text,
} from './schemas'
import {
  audit,
  authorize,
  ownProject,
  returned,
  withReader,
  withTransaction,
} from './store'
import { DEFAULT_TIME_ZONE, parseInstant } from './time'

/**
 * How we know what a provider, connection or account can do:
 * documented (`declared`), tried for real
 * (`tested`), or known missing (`unavailable`) — with the evidence and an
 * expiry, so a stale "yes" stops counting. Append-only: a new check is a new
 * row, and the newest per provider/connection/target/capability is what
 * holds.
 *
 * The table names no module; the caller says which module's work the check
 * is for (`module`), and an agent needs that module's `write` scope
 * (`agents:operate` for a kernel check with no module) and a policy that
 * allows `import` — recording what a provider reported is recording, not
 * drafting. Reading them is `hq:read` ("see what this connection may do").
 */

const DEFAULT_VALID_HOURS = 24 * 30
/** A reported check time this far ahead of the database's clock is refused. */
const FUTURE_SKEW_SECONDS = 5 * 60

const recordSchema = z.object({
  module: optionalChoice(MODULE_IDS, 'That isn’t a module.'),
  provider: machineKey('Provider', 60),
  connectionId: optionalRecordId('Connection'),
  /** The platform account or marketplace checked, when it is one. */
  targetRef: text.optional('Target', 200),
  capability: machineKey('Capability', 80),
  state: choice(
    OPS_CAPABILITY_STATES,
    'Choose declared, tested or unavailable.',
  ),
  evidence: text.required('Evidence', 2000),
  /** When the check ran, if not now — an ISO instant or project-local time. */
  checkedAt: text.optional('Checked at', 40),
  expiresInHours: int('Valid for', 1, 24 * 365),
})

export type CapabilityCheckInput = z.input<typeof recordSchema>

/**
 * Appends one check inside the caller's transaction — for a module service
 * that learns a capability as part of its own work (a sign-in test, a
 * publish that came back unsupported). Authorization is the caller's.
 */
export async function insertCapabilityCheck(
  tx: Tx,
  actor: Actor,
  project: ProjectRow | null,
  raw: unknown,
): Promise<OpsCapabilityCheckRow> {
  const input = parseInput(recordSchema, raw)
  const projectId = project?.id ?? null
  if (input.connectionId) {
    const [connection] = await tx
      .select({ id: providerConnections.id })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, input.connectionId),
          eq(providerConnections.ownerId, actor.userId),
        ),
      )
      .limit(1)
    if (!connection)
      throw invalid('That connection isn’t one of yours.', {
        connectionId: 'Unknown connection.',
      })
  }
  const hours = input.expiresInHours ?? DEFAULT_VALID_HOURS
  let checkedAt: Date | ReturnType<typeof sql> = sql`now()`
  let expiresAt: Date | ReturnType<typeof sql> = nowPlus(hours * 3600)
  if (input.checkedAt) {
    const at = parseInstant(
      input.checkedAt,
      project?.timezone ?? DEFAULT_TIME_ZONE,
    )
    if (!at)
      throw invalid('Checked at must be a date and time.', {
        checkedAt: 'Use a date and time.',
      })
    const now = await dbNow(tx)
    if (at.getTime() > now.getTime() + FUTURE_SKEW_SECONDS * 1000)
      throw invalid('Checked at can’t be in the future.', {
        checkedAt: 'In the future.',
      })
    checkedAt = at
    // Derived from the reported instant, not from any clock.
    expiresAt = new Date(at.getTime() + hours * 3_600_000)
  }
  const row = returned(
    (
      await tx
        .insert(opsCapabilityChecks)
        .values({
          ownerId: actor.userId,
          projectId,
          provider: input.provider,
          connectionId: input.connectionId ?? null,
          targetRef: input.targetRef ?? null,
          capability: input.capability,
          state: input.state,
          evidence: input.evidence,
          checkedAt,
          expiresAt,
          actorType: actor.type,
          actorId: actor.id,
          createdBy: actor.userId,
        })
        .returning()
    )[0],
  )
  await audit(tx, actor, {
    projectId,
    action: 'capability.check',
    targetType: 'capability_check',
    targetId: row.id,
    changes: {
      provider: row.provider,
      capability: row.capability,
      state: row.state,
      targetRef: row.targetRef,
      expiresAt: row.expiresAt,
    },
  })
  return row
}

/** Records how we know a provider or account can (or can't) do something. */
export async function recordCapabilityCheck(
  actor: Actor,
  projectId: string | null,
  raw: unknown,
): Promise<OpsCapabilityCheckRow> {
  const input = parseInput(recordSchema, raw)
  return withTransaction(async (tx) => {
    const project = projectId ? await ownProject(tx, actor, projectId) : null
    const scope = workScope(actor, input.module ?? null, 'write')
    await authorize(tx, actor, project, scope.area, scope.capability, 'import')
    return insertCapabilityCheck(tx, actor, project, raw)
  })
}

export type CapabilityLine = {
  provider: string
  connectionId: string | null
  targetRef: string | null
  capability: string
  /** `expired` when the newest check is past its expiry — a stale "yes" isn't a yes. */
  state: OpsCapabilityState | 'expired'
  checkedAt: Date
  expiresAt: Date | null
  evidence: string
  projectId: string | null
  checkId: string
}

export type CapabilityFilter = {
  provider?: string
  /** A project's checks plus the owner's no-project ones; absent means all. */
  projectId?: string | null
}

/**
 * The newest check per provider, connection, target and capability, for one
 * owner, with expiry judged by the database's clock. A project's view
 * includes the owner's no-project checks (a provider key is the owner's, not
 * the project's).
 */
export async function capabilityLines(
  reader: Reader,
  ownerId: string,
  filter: CapabilityFilter = {},
): Promise<CapabilityLine[]> {
  const rows = await reader
    .selectDistinctOn(
      [
        opsCapabilityChecks.provider,
        opsCapabilityChecks.connectionId,
        opsCapabilityChecks.targetRef,
        opsCapabilityChecks.capability,
      ],
      {
        check: opsCapabilityChecks,
        expired: sql<boolean>`coalesce(${opsCapabilityChecks.expiresAt} <= now(), false)`,
      },
    )
    .from(opsCapabilityChecks)
    .where(
      and(
        eq(opsCapabilityChecks.ownerId, ownerId),
        filter.provider
          ? eq(opsCapabilityChecks.provider, filter.provider)
          : undefined,
        filter.projectId === undefined
          ? undefined
          : filter.projectId === null
            ? sameProject(opsCapabilityChecks.projectId, null)
            : sql`(${opsCapabilityChecks.projectId} is null or ${opsCapabilityChecks.projectId} = ${filter.projectId})`,
      ),
    )
    .orderBy(
      asc(opsCapabilityChecks.provider),
      asc(opsCapabilityChecks.connectionId),
      asc(opsCapabilityChecks.targetRef),
      asc(opsCapabilityChecks.capability),
      desc(opsCapabilityChecks.checkedAt),
      desc(opsCapabilityChecks.createdAt),
    )
    .limit(1000)
  return rows.map(({ check, expired }) => ({
    provider: check.provider,
    connectionId: check.connectionId,
    targetRef: check.targetRef,
    capability: check.capability,
    state: expired ? 'expired' : check.state,
    checkedAt: check.checkedAt,
    expiresAt: check.expiresAt,
    evidence: check.evidence,
    projectId: check.projectId,
    checkId: check.id,
  }))
}

const latestSchema = z.object({
  provider: machineKey('Provider', 60).optional(),
  projectId: optionalRecordId('Project'),
})

/** What the owner's providers can do now — for HQ's settings and an agent's capabilities. */
export async function latestCapabilities(
  actor: Actor,
  raw: { provider?: string; projectId?: string | null } = {},
): Promise<CapabilityLine[]> {
  assertKernelRead(actor)
  const input = parseInput(latestSchema, raw)
  return withReader(async (db) => {
    const project = input.projectId
      ? await ownProject(db, actor, input.projectId)
      : null
    return capabilityLines(db, actor.userId, {
      ...(input.provider ? { provider: input.provider } : {}),
      ...(project ? { projectId: project.id } : {}),
    })
  })
}
