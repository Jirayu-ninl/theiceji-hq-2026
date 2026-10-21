import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { ModuleId } from '@theiceji/hq-db/enums'
import {
  type OpsAuditEventRow,
  type OpsIdempotencyKeyRow,
  type OpsPolicyRow,
  opsAuditEvents,
  opsIdempotencyKeys,
  type ProjectRow,
  projects,
} from '@theiceji/hq-db/schema'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type {
  AnyPgColumn,
  PgTable,
  PgTransactionConfig,
} from 'drizzle-orm/pg-core'
import {
  type Actor,
  type AgentRequirement,
  assertCan,
  DEFAULT_AGENT_ACTION,
  isPerson,
  type OpsCapability,
  type ScopeArea,
} from './access'
import { database, isUuid, type Reader, type Tx } from './db'
import { asOpsError, forbidden, invalid, notFound, OpsError } from './errors'
import { assertPolicyAllows } from './policy-gate'

/**
 * Database plumbing for every service: transactions, the ownership and policy
 * gate, the audit writer and idempotency. Framework-free on purpose — HQ's
 * server actions, the MCP tools, the worker and the agent runner all run the
 * same services.
 */

export { configureOpsDatabase, isUuid, type Reader, type Tx } from './db'

/* ── Operation scope: audit refs + idempotency ──────────────────────── */

type Target = { type: string; id: string }

type OperationScope = {
  actor: Actor
  operation: string
  key: string | null
  requestHash: string
  /** Set once a transaction that claimed the key has committed. */
  claimed: boolean
  auditIds: string[]
  target: Target | null
  projectId: string | null
}

type TxScope = {
  auditIds: string[]
  target: Target | null
  projectId: string | null
}

const operations = new AsyncLocalStorage<OperationScope>()
const txScopes = new WeakMap<object, TxScope>()

/** Thrown inside a claiming transaction when another request holds the key. */
class IdempotencyRace extends Error {}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, stable(entry)]),
    )
  }
  return value
}

/** SHA-256 of a canonical JSON form — key order and `undefined` don't matter. */
export function hashRequest(operation: string, request: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([operation, stable(request)]))
    .digest('hex')
}

export async function withReader<T>(
  fn: (db: Reader) => Promise<T>,
): Promise<T> {
  const db = database()
  try {
    return await fn(db)
  } catch (e) {
    throw asOpsError(e)
  }
}

export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  const db = database()
  const operation = operations.getStore()
  const scope: TxScope = { auditIds: [], target: null, projectId: null }
  const claiming = Boolean(operation?.key && !operation.claimed)
  try {
    const value = await db.transaction(async (tx) => {
      txScopes.set(tx, scope)
      if (claiming && operation) await claimKey(tx, operation)
      const result = await fn(tx)
      if (claiming && operation) await recordClaim(tx, operation, scope)
      return result
    }, config)
    if (operation) {
      if (claiming) operation.claimed = true
      operation.auditIds.push(...scope.auditIds)
      operation.target ??= scope.target
      operation.projectId ??= scope.projectId
    }
    return value
  } catch (e) {
    if (e instanceof IdempotencyRace) throw e
    throw asOpsError(e)
  }
}

async function claimKey(tx: Tx, operation: OperationScope): Promise<void> {
  const [row] = await tx
    .insert(opsIdempotencyKeys)
    .values({
      actorId: operation.actor.id,
      ownerId: operation.actor.userId,
      key: operation.key as string,
      operation: operation.operation,
      requestHash: operation.requestHash,
      state: 'committed',
      expiresAt: sql`now() + interval '30 days'`,
    })
    .onConflictDoNothing({
      target: [opsIdempotencyKeys.actorId, opsIdempotencyKeys.key],
    })
    .returning({ id: opsIdempotencyKeys.id })
  if (!row) throw new IdempotencyRace()
}

async function recordClaim(
  tx: Tx,
  operation: OperationScope,
  scope: TxScope,
): Promise<void> {
  await tx
    .update(opsIdempotencyKeys)
    .set({
      targetType: scope.target?.type ?? null,
      targetId: scope.target?.id ?? null,
      projectId: scope.projectId,
      auditIds: scope.auditIds,
    })
    .where(
      and(
        eq(opsIdempotencyKeys.actorId, operation.actor.id),
        eq(opsIdempotencyKeys.key, operation.key as string),
      ),
    )
}

export type OperationSpec = {
  /** A stable name, e.g. `board_create_card`. */
  operation: string
  /** The caller's idempotency key, when the call creates or has side effects. */
  key?: string | null
  /** Everything that defines the request, hashed to detect key reuse. */
  request: unknown
}

export type OperationOutcome<T> =
  | {
      kind: 'fresh'
      value: T
      auditIds: string[]
      target: Target | null
      /** Store the response a replay of this key should return. */
      complete: (response: Record<string, unknown>) => Promise<void>
    }
  | {
      kind: 'replay'
      /** Null when the work committed but its response was never stored. */
      response: Record<string, unknown> | null
      target: Target | null
      auditIds: string[]
      completedAt: Date | null
    }

async function findKey(
  actor: Actor,
  key: string,
): Promise<(OpsIdempotencyKeyRow & { live: boolean }) | null> {
  const [row] = await database()
    .select({
      row: opsIdempotencyKeys,
      live: sql<boolean>`${opsIdempotencyKeys.expiresAt} > now()`,
    })
    .from(opsIdempotencyKeys)
    .where(
      and(
        eq(opsIdempotencyKeys.actorId, actor.id),
        eq(opsIdempotencyKeys.key, key),
      ),
    )
    .limit(1)
  return row ? { ...row.row, live: row.live } : null
}

function replayOf<T>(
  row: OpsIdempotencyKeyRow,
  operation: string,
  requestHash: string,
): OperationOutcome<T> {
  if (row.operation !== operation || row.requestHash !== requestHash)
    throw new OpsError(
      'idempotency_conflict',
      `That idempotency key was already used for a different ${row.operation === operation ? 'request' : `operation (${row.operation})`}. Use a new key for a new request.`,
      { details: { operation: row.operation, createdAt: row.createdAt } },
    )
  return {
    kind: 'replay',
    response: row.response ?? null,
    target:
      row.targetType && row.targetId
        ? { type: row.targetType, id: row.targetId }
        : null,
    auditIds: row.auditIds,
    completedAt: row.completedAt,
  }
}

/**
 * Runs one operation with idempotency and collects its audit refs.
 *
 * With a key: an earlier call with the same key and payload replays its
 * result; a different payload is an `idempotency_conflict`. The key is
 * claimed inside the first transaction the operation commits, so a failed
 * attempt leaves no key behind and two concurrent calls can't both run.
 */
export async function runOperation<T>(
  actor: Actor,
  spec: OperationSpec,
  work: () => Promise<T>,
): Promise<OperationOutcome<T>> {
  const key = spec.key ?? null
  if (key !== null && (key.length < 8 || key.length > 200))
    throw invalid('An idempotency key must be 8–200 characters.', {
      idempotency_key: 'Use a UUID or another unique string.',
    })
  const requestHash = hashRequest(spec.operation, spec.request)
  if (key) {
    const existing = await withReader(() => findKey(actor, key))
    if (existing) {
      if (existing.live) return replayOf(existing, spec.operation, requestHash)
      await database()
        .delete(opsIdempotencyKeys)
        .where(eq(opsIdempotencyKeys.id, existing.id))
    }
  }
  const scope: OperationScope = {
    actor,
    operation: spec.operation,
    key,
    requestHash,
    claimed: false,
    auditIds: [],
    target: null,
    projectId: null,
  }
  try {
    const value = await operations.run(scope, work)
    return {
      kind: 'fresh',
      value,
      auditIds: scope.auditIds,
      target: scope.target,
      complete: async (response) => {
        if (!key || !scope.claimed) return
        await database()
          .update(opsIdempotencyKeys)
          .set({ state: 'completed', response, completedAt: sql`now()` })
          .where(
            and(
              eq(opsIdempotencyKeys.actorId, actor.id),
              eq(opsIdempotencyKeys.key, key),
            ),
          )
      },
    }
  } catch (e) {
    if (e instanceof IdempotencyRace && key) {
      const row = await withReader(() => findKey(actor, key))
      if (row) return replayOf(row, spec.operation, requestHash)
      throw new OpsError(
        'conflict',
        'Another request is using that idempotency key. Read the target back, then retry with the same key.',
      )
    }
    throw e
  }
}

/* ── Ownership and authorization ────────────────────────────────────── */

/** Throws unless the project can take changes. Reads are always allowed. */
export function assertWritable(
  project: ProjectRow | null,
  capability: OpsCapability,
): void {
  if (!project || capability === 'read') return
  if (project.status === 'archived')
    throw invalid(
      'This project is archived. Restore it in Projects to make changes.',
    )
}

/**
 * Throws unless a module is on for the project. A module that is off keeps
 * its rows, but nothing new is written through it until it is turned on.
 */
export function assertModuleOn(project: ProjectRow, module: ModuleId): void {
  if (!project.modules.enabled.includes(module))
    throw invalid(
      `${module[0]?.toUpperCase()}${module.slice(1)} is off for ${project.name}. Turn it on in the project’s settings.`,
    )
}

/**
 * The whole gate for one call: capability (role, and scope for a
 * connection), archived-project refusal, and — for agents and workers doing
 * anything but reading — the owner's operating policy and kill switches for
 * that project, or for their no-project work when `project` is null.
 *
 * Returns the policy an agent is operating under, or null for a person or a
 * read. Runs before any write, so a refusal leaves nothing behind.
 */
export async function authorize(
  reader: Reader,
  actor: Actor,
  project: ProjectRow | null,
  area: ScopeArea,
  capability: OpsCapability,
  requirement?: AgentRequirement,
): Promise<OpsPolicyRow | null> {
  assertCan(actor, area, capability)
  assertWritable(project, capability)
  if (actor.type === 'user' || capability === 'read') return null
  if (requirement === 'owner_only' || capability === 'manage')
    throw forbidden(
      'Only the owner can do this, in HQ. An agent can ask with agents_request_human.',
    )
  const action = requirement ?? DEFAULT_AGENT_ACTION[capability]
  if (!action)
    throw new Error(`The ${capability} capability needs an explicit action.`)
  return assertPolicyAllows(reader, actor, project?.id ?? null, action)
}

/** The project, if the actor owns it and may do this to it. */
/**
 * A project in the Trash is the owner's alone: to an agent
 * or a connection it, and every row in it, reads as "not found". The owner
 * still reaches it — Trash lists it and Restore brings it back.
 */
const hiddenFrom = (actor: Actor, project: ProjectRow | null) =>
  Boolean(project?.deletedAt) && !isPerson(actor)

export async function ownedProject(
  reader: Reader,
  actor: Actor,
  projectId: string,
  area: ScopeArea,
  capability: OpsCapability,
  requirement?: AgentRequirement,
): Promise<ProjectRow> {
  assertCan(actor, area, capability)
  if (!isUuid(projectId)) throw notFound('Project')
  const [project] = await reader
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, actor.userId)))
    .limit(1)
  if (!project || hiddenFrom(actor, project)) throw notFound('Project')
  await authorize(reader, actor, project, area, capability, requirement)
  return project
}

/** A table whose rows all belong to one owner, and maybe one project. */
export type OwnerScoped = PgTable & {
  id: AnyPgColumn
  ownerId: AnyPgColumn
  projectId: AnyPgColumn
}

/**
 * One row of an owner-scoped table, with its project (null for a row in no
 * project) — for an actor who owns it and may do this to it. Someone else's
 * row reads as "not found", exactly like one that never existed.
 *
 * The cast is the price of naming the table at the call site: drizzle can't
 * infer a row type from a table passed as a value, and every caller knows the
 * one it asked for.
 */
export async function ownedRecord<Row>(
  reader: Reader,
  actor: Actor,
  table: OwnerScoped,
  id: string,
  area: ScopeArea,
  capability: OpsCapability,
  label: string,
  requirement?: AgentRequirement,
): Promise<{ row: Row; project: ProjectRow | null }> {
  assertCan(actor, area, capability)
  if (!isUuid(id)) throw notFound(label)
  const [found] = await reader
    .select({ row: table, project: projects })
    .from(table)
    .leftJoin(projects, eq(projects.id, table.projectId))
    .where(and(eq(table.id, id), eq(table.ownerId, actor.userId)))
    .limit(1)
  if (!found) throw notFound(label)
  const project = (found.project as ProjectRow | null) ?? null
  if (hiddenFrom(actor, project)) throw notFound(label)
  await authorize(reader, actor, project, area, capability, requirement)
  return { row: found.row as Row, project }
}

/**
 * One owner-scoped row and its project, checked for ownership only — for a
 * service whose scope area comes from the row itself (a task's module, a
 * release authorization's module). The caller runs `authorize()` next with
 * the area the row names. Someone else's row reads as "not found".
 *
 * `lock` takes the row lock (`for update of` the table, never the project),
 * for a write that must not race another one on the same row.
 */
export async function ownedRow<Row>(
  reader: Reader,
  actor: Actor,
  table: OwnerScoped,
  id: string,
  label: string,
  options: { lock?: boolean } = {},
): Promise<{ row: Row; project: ProjectRow | null }> {
  if (!isUuid(id)) throw notFound(label)
  const query = reader
    .select({ row: table, project: projects })
    .from(table)
    .leftJoin(projects, eq(projects.id, table.projectId))
    .where(and(eq(table.id, id), eq(table.ownerId, actor.userId)))
    .limit(1)
  const [found] = options.lock
    ? await query.for('update', { of: table })
    : await query
  const project = (found?.project as ProjectRow | null | undefined) ?? null
  if (!found || hiddenFrom(actor, project)) throw notFound(label)
  return { row: found.row as Row, project }
}

/**
 * The project, if the actor owns it — ownership only, no capability. For a
 * service that checks capability per row afterwards (claiming across
 * modules). Someone else's project reads as "not found".
 */
export async function ownProject(
  reader: Reader,
  actor: Actor,
  projectId: string,
): Promise<ProjectRow> {
  if (!isUuid(projectId)) throw notFound('Project')
  const [project] = await reader
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, actor.userId)))
    .limit(1)
  if (!project || hiddenFrom(actor, project)) throw notFound('Project')
  return project
}

/* ── Audit ──────────────────────────────────────────────────────────── */

export type AuditInput = {
  projectId: string | null
  action: string
  targetType: string
  targetId: string | null
  beforeRevision?: number | null
  afterRevision?: number | null
  reason?: string | null
  changes?: Record<string, unknown>
}

/** Writes one audit event and returns its ID — the `audit_ref` a tool reports. */
export async function audit(
  tx: Tx,
  actor: Actor,
  event: AuditInput,
): Promise<string> {
  const [row] = await tx
    .insert(opsAuditEvents)
    .values({
      ownerId: actor.userId,
      actorType: actor.type,
      actorId: actor.id,
      projectId: event.projectId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      beforeRevision: event.beforeRevision ?? null,
      afterRevision: event.afterRevision ?? null,
      reason: event.reason ?? null,
      changes: event.changes ?? {},
    })
    .returning({ id: opsAuditEvents.id })
  const id = returned(row).id
  const scope = txScopes.get(tx)
  if (scope) {
    scope.auditIds.push(id)
    if (!scope.target && event.targetId)
      scope.target = { type: event.targetType, id: event.targetId }
    scope.projectId ??= event.projectId
  }
  return id
}

/** The newest audit events about some records, for a detail panel or the console. */
export async function auditTrail(
  reader: Reader,
  ownerId: string,
  targetIds: string[],
  limit = 40,
): Promise<OpsAuditEventRow[]> {
  if (targetIds.length === 0) return []
  return reader
    .select()
    .from(opsAuditEvents)
    .where(
      and(
        eq(opsAuditEvents.ownerId, ownerId),
        inArray(opsAuditEvents.targetId, targetIds),
      ),
    )
    .orderBy(desc(opsAuditEvents.occurredAt))
    .limit(limit)
}

export function returned<T>(row: T | undefined): T {
  if (!row) throw new Error('The write returned no row.')
  return row
}
