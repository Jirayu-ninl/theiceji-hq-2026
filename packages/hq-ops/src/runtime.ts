import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { MODULE_IDS, type OpsRuntimeStatus } from '@theiceji/hq-db/enums'
import {
  type OpsOutboxEventRow,
  type OpsPolicyRow,
  type OpsRuntimeRow,
  oauthGrants,
  opsAgentRuns,
  opsEventDeliveries,
  opsInboundEvents,
  opsOutboxEvents,
  opsPolicies,
  opsRuntimes,
  opsSchedulerLeases,
  projects,
  users,
} from '@theiceji/hq-db/schema'
import { guardedFetch, isPublicAddress } from '@theiceji/net-guard'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import { z } from 'zod'
import {
  type Actor,
  assertAgentWork,
  assertCan,
  assertKernelRead,
  userActor,
} from './access'
import { expireReservations } from './budget'
import { dbNow, nowPlus, type Reader, type Tx } from './db'
import { conflict, forbidden, invalid, notFound } from './errors'
import { expireHumanRequests } from './human'
import { emitEvent } from './outbox'
import { policyState } from './policy-gate'
import { expireAuthorizations } from './release'
import { int, parseInput, recordId, revision, text } from './schemas'
import {
  mintSigningSecret,
  seal,
  signPayload,
  unseal,
  verifySignature,
} from './secrets'
import { audit, returned, withReader, withTransaction } from './store'
import { type LeaseRecovery, openTask, recoverLapsedLeases } from './tasks'

/**
 * The runtime contract, for every module.
 *
 * MCP is how an agent calls HQ; it doesn't wake an agent up. This file is the
 * other direction and the clock:
 *
 * · **Runtimes** — the owner registers each agent runtime or worker against
 *   the connection it authenticates with, optionally with a delivery URL.
 *   Its heartbeat is what HQ shows; a schedule alone never reads as
 *   "running".
 * · **Events** — the outbox (outbox.ts) is delivered at least once, signed
 *   (Standard Webhooks: `webhook-id`, `webhook-timestamp`,
 *   `webhook-signature`), with backoff and a dead-letter state. A runtime
 *   without a public URL pulls the same events and acknowledges them.
 *   `delivered` (its endpoint answered) and `acknowledged` (it took the work)
 *   stay separate, and a redelivery carries the same event ID — so a retry is
 *   recognisable and never a second instruction. Payloads are IDs only.
 *   A runtime sees its owner's events in the scopes (projects, or no-project
 *   work) whose current policy covers its connection.
 * · **Inbound events** — authenticated with the runtime's secret, inside a
 *   replay window, deduplicated by their own ID, attributed to the runtime's
 *   owner, and limited to an allowlist that only ever opens a task from a
 *   template.
 * · **The ops tick** — lapsed leases, expiries, stalled runs, the steps
 *   modules register, and delivery, once at a time under a lease row, in
 *   small batches so it ends well inside a cron's 60 seconds.
 *
 * Every "is it due", "has it expired" and backoff is the database's clock.
 */

const REPLAY_WINDOW_SECONDS = 5 * 60
const DELIVERY_TIMEOUT_MS = 10_000
const MAX_BACKOFF_SECONDS = 6 * 3600

/** Local development only: a runtime on this machine behind http://localhost. */
function allowPrivateRuntimes(): boolean {
  return (
    (process.env.HQ_RUNTIME_ALLOW_PRIVATE ??
      process.env.CREATOR_RUNTIME_ALLOW_PRIVATE) === '1'
  )
}

export type RuntimeHealth =
  | 'running'
  | 'stalled'
  | 'offline'
  | 'never_seen'
  | OpsRuntimeStatus

export type RuntimeView = Omit<OpsRuntimeRow, 'sealedDeliverySecret'> & {
  health: RuntimeHealth
  hasDeliveryUrl: boolean
}

/** `now` is the database's clock (dbNow). */
export function runtimeHealth(
  runtime: OpsRuntimeRow,
  now: Date,
): RuntimeHealth {
  if (runtime.status !== 'active') return runtime.status
  if (!runtime.lastHeartbeatAt) return 'never_seen'
  const age = now.getTime() - runtime.lastHeartbeatAt.getTime()
  if (age <= runtime.stalledAfterSeconds * 1000) return 'running'
  if (age <= runtime.stalledAfterSeconds * 4000) return 'stalled'
  return 'offline'
}

export function viewRuntime(runtime: OpsRuntimeRow, now: Date): RuntimeView {
  const { sealedDeliverySecret: _sealed, ...rest } = runtime
  return {
    ...rest,
    health: runtimeHealth(runtime, now),
    hasDeliveryUrl: Boolean(runtime.deliveryUrl),
  }
}

/* ── Owner: register runtimes ───────────────────────────────────────── */

const registerSchema = z.object({
  grantId: recordId('Connection'),
  label: text.required('Label', 120),
  deliveryUrl: text.optional('Delivery URL', 2000),
  stalledAfterSeconds: int('Stalled after', 60, 24 * 3600),
  maxConcurrency: int('Concurrency', 1, 20),
})

export type RegisteredRuntime = {
  runtime: RuntimeView
  /** Shown once, when a delivery URL is set or the secret rotates. */
  signingSecret: string | null
}

/**
 * A URL HQ may push to: https, no credentials, and never a literal private
 * address. A name is resolved and pinned to a public address at delivery
 * time (`guardedFetch`), so DNS can't point it inside later either.
 */
function checkDeliveryUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalid('The delivery URL isn’t a URL.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const local = ['localhost', '127.0.0.1', '::1'].includes(host)
  const allowPrivate = allowPrivateRuntimes()
  if (url.protocol !== 'https:' && !(local && allowPrivate))
    throw invalid('Event delivery needs an https URL.')
  if (url.username || url.password)
    throw invalid('The delivery URL can’t carry credentials.')
  if (isIP(host) && !isPublicAddress(host) && !allowPrivate)
    throw invalid(
      'The delivery URL points at a private address; HQ only delivers to public hosts.',
    )
  return url.toString()
}

function assertOwner(actor: Actor, what: string): void {
  if (actor.type !== 'user')
    throw forbidden(
      `${what} is the owner’s, in HQ. An agent can ask with agents_request_human.`,
    )
  assertCan(actor, 'hq', 'manage')
}

/**
 * Registers (or re-registers) the runtime behind one of the owner's
 * connections. A delivery URL mints a fresh signing secret, sealed at rest
 * and shown once; no URL means the runtime pulls.
 */
export async function registerRuntime(
  actor: Actor,
  raw: unknown,
): Promise<RegisteredRuntime> {
  assertOwner(actor, 'Registering a runtime')
  const input = parseInput(registerSchema, raw)
  const deliveryUrl = input.deliveryUrl
    ? checkDeliveryUrl(input.deliveryUrl)
    : null
  return withTransaction(async (tx) => {
    const [grant] = await tx
      .select()
      .from(oauthGrants)
      .where(
        and(
          eq(oauthGrants.id, input.grantId),
          eq(oauthGrants.userId, actor.userId),
          isNull(oauthGrants.revokedAt),
        ),
      )
      .limit(1)
    if (!grant) throw invalid('Choose one of your active connections.')
    const secret = deliveryUrl ? mintSigningSecret() : null
    const [existing] = await tx
      .select()
      .from(opsRuntimes)
      .where(
        and(
          eq(opsRuntimes.grantId, grant.id),
          eq(opsRuntimes.ownerId, actor.userId),
        ),
      )
      .limit(1)
      .for('update')
    const values = {
      label: input.label,
      kind: grant.actorType,
      deliveryUrl,
      sealedDeliverySecret: secret ? seal(secret) : null,
      stalledAfterSeconds: input.stalledAfterSeconds ?? 900,
      maxConcurrency: input.maxConcurrency ?? 1,
      status: 'active' as const,
      revokedAt: null,
    }
    const runtime = existing
      ? returned(
          (
            await tx
              .update(opsRuntimes)
              .set({
                ...values,
                revision: existing.revision + 1,
                updatedAt: sql`now()`,
              })
              .where(eq(opsRuntimes.id, existing.id))
              .returning()
          )[0],
        )
      : returned(
          (
            await tx
              .insert(opsRuntimes)
              .values({
                ...values,
                ownerId: actor.userId,
                grantId: grant.id,
                createdBy: actor.userId,
              })
              .returning()
          )[0],
        )
    await audit(tx, actor, {
      projectId: null,
      action: existing ? 'runtime.update' : 'runtime.register',
      targetType: 'runtime',
      targetId: runtime.id,
      beforeRevision: existing?.revision ?? null,
      afterRevision: runtime.revision,
      changes: {
        grantId: grant.id,
        kind: runtime.kind,
        deliveryUrl: Boolean(runtime.deliveryUrl),
        secretRotated: Boolean(secret),
      },
    })
    return {
      runtime: viewRuntime(runtime, await dbNow(tx)),
      signingSecret: secret,
    }
  })
}

const statusSchema = z.object({
  status: z.enum(['active', 'paused', 'revoked'], {
    error: 'Choose active, paused or revoked.',
  }),
  expectedRevision: revision,
})

/** Pause, resume or revoke a runtime. Revoking drops its URL and secret for good. */
export async function setRuntimeStatus(
  actor: Actor,
  runtimeId: string,
  raw: unknown,
): Promise<RuntimeView> {
  assertOwner(actor, 'Managing a runtime')
  const input = parseInput(statusSchema, raw)
  return withTransaction(async (tx) => {
    const [runtime] = await tx
      .select()
      .from(opsRuntimes)
      .where(
        and(
          eq(opsRuntimes.id, runtimeId),
          eq(opsRuntimes.ownerId, actor.userId),
        ),
      )
      .limit(1)
      .for('update')
    if (!runtime) throw notFound('Runtime')
    if (runtime.revision !== input.expectedRevision) throw conflict()
    if (runtime.status === 'revoked')
      throw invalid('A revoked runtime stays revoked. Register it again.')
    const updated = returned(
      (
        await tx
          .update(opsRuntimes)
          .set({
            status: input.status,
            revokedAt: input.status === 'revoked' ? sql`now()` : null,
            ...(input.status === 'revoked'
              ? { deliveryUrl: null, sealedDeliverySecret: null }
              : {}),
            revision: runtime.revision + 1,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(opsRuntimes.id, runtime.id),
              eq(opsRuntimes.revision, runtime.revision),
            ),
          )
          .returning()
      )[0],
    )
    await audit(tx, actor, {
      projectId: null,
      action: `runtime.${input.status}`,
      targetType: 'runtime',
      targetId: runtime.id,
      beforeRevision: runtime.revision,
      afterRevision: updated.revision,
      changes: { status: { from: runtime.status, to: updated.status } },
    })
    return viewRuntime(updated, await dbNow(tx))
  })
}

export async function listRuntimes(actor: Actor): Promise<RuntimeView[]> {
  assertKernelRead(actor)
  return withReader(async (db) => {
    const [rows, now] = await Promise.all([
      db
        .select()
        .from(opsRuntimes)
        .where(eq(opsRuntimes.ownerId, actor.userId))
        .orderBy(desc(opsRuntimes.updatedAt)),
      dbNow(db),
    ])
    return rows.map((row) => viewRuntime(row, now))
  })
}

/* ── Runtime: heartbeat, pull, acknowledge ──────────────────────────── */

const heartbeatSchema = z.object({
  version: text.optional('Version', 80),
  nextWakeAt: text.optional('Next wake', 40),
  lastSuccessAt: text.optional('Last success', 40),
})

function assertConnection(actor: Actor, what: string): string {
  if (actor.type === 'user' || !actor.grantId)
    throw forbidden(`${what} is for an agent or worker connection.`)
  return actor.grantId
}

/** The caller's runtime, alive as of now — registered on first contact, without a URL. */
async function touchRuntime(
  tx: Tx,
  actor: Actor,
  patch: {
    reportedVersion?: string | null
    nextWakeAt?: Date | null
    lastSuccessAt?: Date | null
  } = {},
): Promise<OpsRuntimeRow> {
  const grantId = assertConnection(actor, 'A heartbeat')
  const [existing] = await tx
    .select()
    .from(opsRuntimes)
    .where(
      and(
        eq(opsRuntimes.grantId, grantId),
        eq(opsRuntimes.ownerId, actor.userId),
      ),
    )
    .limit(1)
    .for('update')
  if (existing?.status === 'revoked')
    throw forbidden('This runtime was revoked by the owner.')
  const values = {
    lastHeartbeatAt: sql`now()`,
    ...(patch.reportedVersion !== undefined
      ? { reportedVersion: patch.reportedVersion }
      : {}),
    ...(patch.nextWakeAt !== undefined ? { nextWakeAt: patch.nextWakeAt } : {}),
    ...(patch.lastSuccessAt !== undefined
      ? { lastSuccessAt: patch.lastSuccessAt }
      : {}),
  }
  if (existing)
    return returned(
      (
        await tx
          .update(opsRuntimes)
          .set(values)
          .where(eq(opsRuntimes.id, existing.id))
          .returning()
      )[0],
    )
  return returned(
    (
      await tx
        .insert(opsRuntimes)
        .values({
          ...values,
          ownerId: actor.userId,
          grantId,
          label: actor.label ?? 'runtime',
          kind: actor.type === 'worker' ? 'worker' : 'agent',
          createdBy: actor.userId,
        })
        .returning()
    )[0],
  )
}

/**
 * A runtime saying it is alive. The first heartbeat from a connection
 * registers it (without a delivery URL — the owner adds one). The times it
 * reports are its own and only shown, never compared.
 */
export async function heartbeatRuntime(
  actor: Actor,
  raw: unknown = {},
): Promise<RuntimeView> {
  assertConnection(actor, 'A heartbeat')
  const input = parseInput(heartbeatSchema, raw)
  const at = (value: string | null | undefined) => {
    if (!value) return undefined
    const date = new Date(value)
    if (Number.isNaN(date.getTime()))
      throw invalid('Times are ISO 8601 with an offset.')
    return date
  }
  return withTransaction(async (tx) => {
    const runtime = await touchRuntime(tx, actor, {
      ...(input.version ? { reportedVersion: input.version } : {}),
      ...(at(input.nextWakeAt) ? { nextWakeAt: at(input.nextWakeAt) } : {}),
      ...(at(input.lastSuccessAt)
        ? { lastSuccessAt: at(input.lastSuccessAt) }
        : {}),
    })
    return viewRuntime(runtime, await dbNow(tx))
  })
}

/** The scopes a connection's events come from: projects, and no-project work. */
type Coverage = { projectIds: string[]; noProject: boolean }

/**
 * Where an actor may see events: every live scope for a person; for a
 * connection, the owner's non-archived projects — and their no-project work —
 * whose current policy covers it (policyState, the one rule).
 */
async function coverageOf(
  reader: Reader,
  actor: Actor,
  now: Date,
): Promise<Coverage> {
  const owned = await reader
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.ownerId, actor.userId), ne(projects.status, 'archived')),
    )
  if (actor.type === 'user')
    return { projectIds: owned.map((row) => row.id), noProject: true }
  const policies = await reader
    .selectDistinctOn([opsPolicies.projectId])
    .from(opsPolicies)
    .where(eq(opsPolicies.ownerId, actor.userId))
    .orderBy(asc(opsPolicies.projectId), desc(opsPolicies.revisionNo))
  const byScope = new Map<string, OpsPolicyRow>(
    policies.map((policy) => [policy.projectId ?? '', policy]),
  )
  const covered = (projectId: string | null) =>
    policyState(byScope.get(projectId ?? '') ?? null, actor, now).ok
  return {
    projectIds: owned.map((row) => row.id).filter((id) => covered(id)),
    noProject: covered(null),
  }
}

function eventsIn(coverage: Coverage): SQL {
  const parts: SQL[] = []
  if (coverage.projectIds.length > 0)
    parts.push(inArray(opsOutboxEvents.projectId, coverage.projectIds))
  if (coverage.noProject) parts.push(isNull(opsOutboxEvents.projectId))
  if (parts.length === 0) return sql`false`
  return (parts.length === 1 ? parts[0] : or(...parts)) as SQL
}

const pullSchema = z.object({
  /** Only one project's events; absent means every covered scope. */
  projectId: z.uuid().nullable().optional(),
  after: text.optional('Cursor', 400),
  limit: int('Limit', 1, 100),
  includeAcknowledged: z.boolean().optional(),
})

export type PulledEvent = {
  id: string
  type: string
  projectId: string | null
  subject: { type: string; id: string }
  payload: OpsOutboxEventRow['payload']
  createdAt: Date
  acknowledged: boolean
}

type Cursor = { at: string; id: string }

function decodeCursor(raw: string): Cursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Cursor
    if (typeof decoded.at !== 'string' || typeof decoded.id !== 'string')
      throw new Error('shape')
    return decoded
  } catch {
    throw invalid('That cursor isn’t one this service issued.')
  }
}

/**
 * The caller's events, oldest first after a cursor. Pulling doesn't
 * acknowledge — the runtime does that once it has taken the work, so a crash
 * between pull and ack means the event comes back. The cursor carries the
 * database's own timestamp text, so microseconds never make a page repeat.
 */
export async function pullEvents(
  actor: Actor,
  raw: unknown = {},
): Promise<{ events: PulledEvent[]; nextCursor: string | null }> {
  const grantId = assertConnection(actor, 'Pulling events')
  assertAgentWork(actor)
  const input = parseInput(pullSchema, raw)
  return withReader(async (db) => {
    const coverage = await coverageOf(db, actor, await dbNow(db))
    if (input.projectId !== undefined) {
      coverage.projectIds = coverage.projectIds.filter(
        (id) => id === input.projectId,
      )
      coverage.noProject = coverage.noProject && input.projectId === null
    }
    const [runtime] = await db
      .select({ id: opsRuntimes.id })
      .from(opsRuntimes)
      .where(
        and(
          eq(opsRuntimes.grantId, grantId),
          eq(opsRuntimes.ownerId, actor.userId),
        ),
      )
      .limit(1)
    const after = input.after ? decodeCursor(input.after) : null
    const limit = input.limit ?? 50
    const rows = await db
      .select({
        event: opsOutboxEvents,
        cursorAt: sql<string>`${opsOutboxEvents.createdAt}::text`,
        acknowledgedAt: opsEventDeliveries.acknowledgedAt,
      })
      .from(opsOutboxEvents)
      .leftJoin(
        opsEventDeliveries,
        and(
          eq(opsEventDeliveries.eventId, opsOutboxEvents.id),
          runtime ? eq(opsEventDeliveries.runtimeId, runtime.id) : sql`false`,
        ),
      )
      .where(
        and(
          eq(opsOutboxEvents.ownerId, actor.userId),
          eventsIn(coverage),
          sql`${opsOutboxEvents.availableAt} <= now()`,
          after
            ? sql`(${opsOutboxEvents.createdAt}, ${opsOutboxEvents.id}) > (${after.at}::timestamptz, ${after.id}::uuid)`
            : undefined,
          input.includeAcknowledged
            ? undefined
            : isNull(opsEventDeliveries.acknowledgedAt),
        ),
      )
      .orderBy(asc(opsOutboxEvents.createdAt), asc(opsOutboxEvents.id))
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      events: page.map(({ event, acknowledgedAt }) => ({
        id: event.id,
        type: event.type,
        projectId: event.projectId,
        subject: { type: event.subjectType, id: event.subjectId },
        payload: event.payload,
        createdAt: event.createdAt,
        acknowledged: Boolean(acknowledgedAt),
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.cursorAt, id: last.event.id }),
            ).toString('base64url')
          : null,
    }
  })
}

const ackSchema = z.object({ eventIds: z.array(z.uuid()).min(1).max(100) })

/** The runtime took these events. Unknown or out-of-scope IDs are listed, not errors. */
export async function acknowledgeEvents(
  actor: Actor,
  raw: unknown,
): Promise<{ acknowledged: string[]; unknown: string[] }> {
  assertConnection(actor, 'Acknowledging events')
  assertAgentWork(actor)
  const input = parseInput(ackSchema, raw)
  return withTransaction(async (tx) => {
    const runtime = await touchRuntime(tx, actor)
    const coverage = await coverageOf(tx, actor, await dbNow(tx))
    const events = await tx
      .select({ id: opsOutboxEvents.id })
      .from(opsOutboxEvents)
      .where(
        and(
          eq(opsOutboxEvents.ownerId, actor.userId),
          inArray(opsOutboxEvents.id, input.eventIds),
          eventsIn(coverage),
        ),
      )
    const known = new Set(events.map((event) => event.id))
    for (const event of events) {
      await tx
        .insert(opsEventDeliveries)
        .values({
          ownerId: actor.userId,
          eventId: event.id,
          runtimeId: runtime.id,
          status: 'acknowledged',
          acknowledgedAt: sql`now()`,
          deliveredAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: [opsEventDeliveries.eventId, opsEventDeliveries.runtimeId],
          set: { status: 'acknowledged', acknowledgedAt: sql`now()` },
        })
      await refreshEventStatus(tx, event.id)
    }
    return {
      acknowledged: [...known],
      unknown: input.eventIds.filter((id) => !known.has(id)),
    }
  })
}

/** An event's own status is the least-advanced of its deliveries. */
async function refreshEventStatus(tx: Tx, eventId: string): Promise<void> {
  const deliveries = await tx
    .select({ status: opsEventDeliveries.status })
    .from(opsEventDeliveries)
    .where(eq(opsEventDeliveries.eventId, eventId))
  if (deliveries.length === 0) return
  const all = (allowed: string[]) =>
    deliveries.every((entry) => allowed.includes(entry.status))
  const status = all(['acknowledged'])
    ? 'acknowledged'
    : all(['acknowledged', 'delivered'])
      ? 'delivered'
      : all(['acknowledged', 'delivered', 'dead_letter'])
        ? 'dead_letter'
        : 'pending'
  await tx
    .update(opsOutboxEvents)
    .set({ status, resolvedAt: status === 'pending' ? null : sql`now()` })
    .where(eq(opsOutboxEvents.id, eventId))
}

/* ── Delivery (the ops tick) ────────────────────────────────────────── */

/** Sends one signed request. Injectable so tests never touch the network. */
export type Deliverer = (input: {
  url: string
  body: string
  headers: Record<string, string>
}) => Promise<{ status: number }>

const defaultDeliverer: Deliverer = async ({ url, body, headers }) => {
  const response = await guardedFetch(url, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
    timeoutMs: DELIVERY_TIMEOUT_MS,
    maxBytes: 16 * 1024,
    ...(allowPrivateRuntimes()
      ? { allowAddress: () => true, anyPort: true }
      : {}),
  })
  return { status: response.status }
}

export type DeliveryReport = {
  scheduled: number
  delivered: string[]
  retrying: string[]
  deadLetter: string[]
  /** Due deliveries left for the next tick because the time budget ran out. */
  deferred: number
}

export type DeliveryOptions = {
  deliver?: Deliverer
  /** Most deliveries attempted in one call. */
  limit?: number
  /** Stop starting new deliveries after this many milliseconds. */
  budgetMs?: number
}

/**
 * Schedules a delivery for each pending event to each of its owner's active
 * runtimes that has a URL and is covered where the event happened, then
 * sends what is due — oldest first, until the batch or the time budget runs
 * out. A 4xx other than 408/429 is final (dead letter); anything else backs
 * off exponentially up to six hours.
 */
export async function deliverEvents(
  options: DeliveryOptions = {},
): Promise<DeliveryReport> {
  const started = performance.now()
  const budgetMs = options.budgetMs ?? 30_000
  const limit = options.limit ?? 25
  const deliver = options.deliver ?? defaultDeliverer
  const report: DeliveryReport = {
    scheduled: 0,
    delivered: [],
    retrying: [],
    deadLetter: [],
    deferred: 0,
  }

  await withTransaction(async (tx) => {
    const now = await dbNow(tx)
    const runtimes = await tx
      .select({ runtime: opsRuntimes, grant: oauthGrants, role: users.role })
      .from(opsRuntimes)
      .innerJoin(oauthGrants, eq(oauthGrants.id, opsRuntimes.grantId))
      .innerJoin(users, eq(users.id, opsRuntimes.ownerId))
      .where(
        and(
          eq(opsRuntimes.status, 'active'),
          sql`${opsRuntimes.deliveryUrl} is not null`,
          isNull(oauthGrants.revokedAt),
          eq(oauthGrants.userId, opsRuntimes.ownerId),
        ),
      )
    for (const { runtime, grant, role } of runtimes) {
      const probe: Actor = {
        type: grant.actorType,
        id: grant.id,
        grantId: grant.id,
        userId: runtime.ownerId,
        role,
      }
      const coverage = await coverageOf(tx, probe, now)
      // Only events this runtime has no delivery for yet — so a backlog it
      // already has never crowds out what just happened.
      const fresh = await tx
        .select({ id: opsOutboxEvents.id })
        .from(opsOutboxEvents)
        .where(
          and(
            eq(opsOutboxEvents.ownerId, runtime.ownerId),
            eq(opsOutboxEvents.status, 'pending'),
            sql`${opsOutboxEvents.availableAt} <= now()`,
            eventsIn(coverage),
            sql`not exists (select 1 from ${opsEventDeliveries} as d where d.event_id = ${opsOutboxEvents.id} and d.runtime_id = ${runtime.id}::uuid)`,
          ),
        )
        .orderBy(asc(opsOutboxEvents.createdAt))
        .limit(200)
      if (fresh.length === 0) continue
      const inserted = await tx
        .insert(opsEventDeliveries)
        .values(
          fresh.map((event) => ({
            ownerId: runtime.ownerId,
            eventId: event.id,
            runtimeId: runtime.id,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: opsEventDeliveries.id })
      report.scheduled += inserted.length
    }
  })

  const [due, now] = await withReader((db) =>
    Promise.all([
      db
        .select({
          delivery: opsEventDeliveries,
          event: opsOutboxEvents,
          runtime: opsRuntimes,
        })
        .from(opsEventDeliveries)
        .innerJoin(
          opsOutboxEvents,
          and(
            eq(opsOutboxEvents.id, opsEventDeliveries.eventId),
            eq(opsOutboxEvents.ownerId, opsEventDeliveries.ownerId),
          ),
        )
        .innerJoin(
          opsRuntimes,
          and(
            eq(opsRuntimes.id, opsEventDeliveries.runtimeId),
            eq(opsRuntimes.ownerId, opsEventDeliveries.ownerId),
          ),
        )
        .where(
          and(
            eq(opsEventDeliveries.status, 'pending'),
            sql`${opsEventDeliveries.nextAttemptAt} <= now()`,
          ),
        )
        .orderBy(asc(opsEventDeliveries.nextAttemptAt))
        .limit(limit),
      dbNow(db),
    ]),
  )
  const timestamp = Math.floor(now.getTime() / 1000)
  for (const [index, { delivery, event, runtime }] of due.entries()) {
    if (performance.now() - started > budgetMs) {
      report.deferred = due.length - index
      break
    }
    if (
      !runtime.deliveryUrl ||
      !runtime.sealedDeliverySecret ||
      runtime.status !== 'active'
    )
      continue
    const body = JSON.stringify({
      id: event.id,
      type: event.type,
      project_id: event.projectId,
      subject: { type: event.subjectType, id: event.subjectId },
      payload: event.payload,
      created_at: event.createdAt.toISOString(),
      attempt: delivery.attempts + 1,
    })
    const signature = signPayload(unseal(runtime.sealedDeliverySecret), {
      id: event.id,
      timestamp,
      body,
    })
    let status = 0
    let error: string | null = null
    try {
      status = (
        await deliver({
          url: runtime.deliveryUrl,
          body,
          headers: {
            'webhook-id': event.id,
            'webhook-timestamp': String(timestamp),
            'webhook-signature': `v1,${signature}`,
          },
        })
      ).status
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'delivery failed'
    }
    await withTransaction(async (tx) => {
      const attempts = delivery.attempts + 1
      const permanent =
        status >= 400 && status < 500 && status !== 408 && status !== 429
      const ok = status >= 200 && status < 300
      const exhausted = attempts >= delivery.maxAttempts
      const next = ok
        ? 'delivered'
        : permanent || exhausted
          ? 'dead_letter'
          : 'pending'
      const [updated] = await tx
        .update(opsEventDeliveries)
        .set({
          status: next,
          attempts,
          lastStatusCode: status || null,
          lastError: ok ? null : (error ?? `HTTP ${status}`).slice(0, 500),
          deliveredAt: ok ? sql`now()` : delivery.deliveredAt,
          nextAttemptAt:
            next === 'pending'
              ? nowPlus(Math.min(2 ** attempts * 30, MAX_BACKOFF_SECONDS))
              : delivery.nextAttemptAt,
        })
        .where(
          and(
            eq(opsEventDeliveries.id, delivery.id),
            eq(opsEventDeliveries.attempts, delivery.attempts),
          ),
        )
        .returning({ id: opsEventDeliveries.id })
      // Another tick recorded this attempt first; its report counts it.
      if (!updated) return
      if (ok)
        await tx
          .update(opsRuntimes)
          .set({ lastSuccessAt: sql`now()` })
          .where(eq(opsRuntimes.id, runtime.id))
      await refreshEventStatus(tx, event.id)
      ;(ok
        ? report.delivered
        : next === 'dead_letter'
          ? report.deadLetter
          : report.retrying
      ).push(delivery.id)
    })
  }
  return report
}

/* ── Inbound events ─────────────────────────────────────────────────── */

/** What a runtime may tell HQ. Each maps to a fixed, allowlisted effect. */
export const INBOUND_TYPES = [
  'task.request',
  'run.progress',
  'provider.callback',
] as const

/**
 * The only tasks a runtime can ask for, by template. Never free-form: the
 * body's note becomes the task's detail — data, not an instruction.
 */
export const INBOUND_TEMPLATES = {
  follow_up: 'follow_up',
  reconcile: 'reconcile',
  review: 'review',
} as const

const inboundSchema = z.object({
  type: z.enum(INBOUND_TYPES),
  /** Null or absent: work in no project. */
  project_id: z.uuid().nullable().optional(),
  module: z.enum(MODULE_IDS).optional(),
  template: z
    .enum(
      Object.keys(INBOUND_TEMPLATES) as [
        keyof typeof INBOUND_TEMPLATES,
        ...(keyof typeof INBOUND_TEMPLATES)[],
      ],
    )
    .optional(),
  subject: z
    .object({
      type: z.string().max(60),
      id: z.uuid(),
    })
    .optional(),
  note: z.string().max(500).optional(),
})

export type InboundOutcome = {
  status: 'accepted' | 'duplicate' | 'rejected'
  reason?: string
  taskId?: string | null
}

/**
 * An authenticated event from a registered runtime. The signature is checked
 * with that runtime's secret over `<id>.<timestamp>.<body>`, the timestamp
 * must be inside the replay window (by the database's clock), and the event
 * ID is recorded per source so a redelivery is a no-op. It belongs to the
 * runtime's owner; an event HQ can't tie to an owner is refused before it is
 * stored. The body is untrusted: only its type, IDs and a template key are
 * used, and the only thing it can cause is opening a task from a template.
 */
export async function receiveInboundEvent(input: {
  runtimeId: string
  headers: {
    id: string | null
    timestamp: string | null
    signature: string | null
  }
  body: string
}): Promise<InboundOutcome> {
  const reject = (reason: string): InboundOutcome => ({
    status: 'rejected',
    reason,
  })
  const { id, timestamp: stamp, signature } = input.headers
  if (!id || !stamp || !signature) return reject('missing signature headers')
  if (id.length > 200) return reject('event id too long')
  if (!/^[0-9a-f-]{36}$/i.test(input.runtimeId))
    return reject('unknown or inactive runtime')
  const timestamp = Number(stamp)
  const [runtime, now] = await withReader((db) =>
    Promise.all([
      db
        .select()
        .from(opsRuntimes)
        .where(eq(opsRuntimes.id, input.runtimeId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      dbNow(db),
    ]),
  )
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(now.getTime() / 1000 - timestamp) > REPLAY_WINDOW_SECONDS
  )
    return reject('outside the replay window')
  if (!runtime?.sealedDeliverySecret || runtime.status !== 'active')
    return reject('unknown or inactive runtime')
  if (
    !verifySignature(
      unseal(runtime.sealedDeliverySecret),
      { id, timestamp, body: input.body },
      signature,
    )
  )
    return reject('bad signature')
  let parsed: z.output<typeof inboundSchema>
  try {
    parsed = inboundSchema.parse(JSON.parse(input.body))
  } catch {
    return reject('body is not an allowed event')
  }
  const payloadHash = createHash('sha256').update(input.body).digest('hex')
  const source = `runtime:${runtime.id}`
  return withTransaction(async (tx) => {
    const [project] = parsed.project_id
      ? await tx
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, parsed.project_id),
              eq(projects.ownerId, runtime.ownerId),
            ),
          )
          .limit(1)
      : []
    const foreign = Boolean(parsed.project_id && !project)
    const inserted = await tx
      .insert(opsInboundEvents)
      .values({
        ownerId: runtime.ownerId,
        source,
        externalEventId: id,
        projectId: project?.id ?? null,
        eventType: parsed.type,
        payloadHash,
        status: foreign ? 'rejected' : 'accepted',
        reason: foreign ? 'project not owned by this runtime’s owner' : null,
      })
      .onConflictDoNothing({
        target: [opsInboundEvents.source, opsInboundEvents.externalEventId],
      })
      .returning({ id: opsInboundEvents.id })
    const stored = inserted[0]
    if (!stored) return { status: 'duplicate' as const }
    if (foreign) return reject('project not owned by this runtime’s owner')
    let taskId: string | null = null
    if (parsed.type === 'task.request' && parsed.template) {
      const [owner] = await tx
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, runtime.ownerId))
        .limit(1)
      if (owner) {
        const created = await openTask(tx, userActor(owner), project ?? null, {
          kind: INBOUND_TEMPLATES[parsed.template],
          module: parsed.module ?? null,
          title: `Requested by runtime: ${parsed.template.replaceAll('_', ' ')}`,
          detail: parsed.note ?? null,
          payload: parsed.subject
            ? {
                subjectType: parsed.subject.type,
                subjectId: parsed.subject.id,
              }
            : {},
          triggerKey: `inbound:${runtime.id}:${id}`.toLowerCase(),
          targetType:
            parsed.subject?.type.toLowerCase().replace(/[^a-z0-9_.:-]/g, '') ||
            undefined,
          targetId: parsed.subject?.id,
        })
        taskId = created.task.id
        await tx
          .update(opsInboundEvents)
          .set({ taskId })
          .where(eq(opsInboundEvents.id, stored.id))
      }
    }
    return { status: 'accepted' as const, taskId }
  })
}

/* ── The ops tick ───────────────────────────────────────────────────── */

/** What a registered step gets: how long it may still take. */
export type TickContext = {
  /** Milliseconds left before the tick should stop starting new work. */
  remainingMs: () => number
}

/**
 * A module's pass on the tick (calendar sync, due routines). It should do a
 * small batch and leave the rest for the next tick; whatever it returns is
 * reported under its name, and a throw is reported without stopping the
 * steps after it.
 */
export type TickStep = (context: TickContext) => Promise<unknown>

const KERNEL_STEPS = [
  'leases',
  'requests',
  'reservations',
  'authorizations',
  'stalled_runs',
  'delivery',
] as const

const moduleSteps: { name: string; run: TickStep }[] = []

/**
 * Adds a step to every tick, after the kernel's own passes and before
 * delivery (so the events a step emits go out in the same tick). Steps run
 * in registration order; registering a name again replaces it in place.
 */
export function registerTickStep(name: string, run: TickStep): void {
  if (!/^[a-z0-9][a-z0-9_.:-]*$/.test(name))
    throw new Error(`A tick step name is a machine key: ${name}`)
  if ((KERNEL_STEPS as readonly string[]).includes(name))
    throw new Error(`“${name}” is a kernel tick step.`)
  const index = moduleSteps.findIndex((step) => step.name === name)
  if (index >= 0) moduleSteps[index] = { name, run }
  else moduleSteps.push({ name, run })
}

export function unregisterTickStep(name: string): boolean {
  const index = moduleSteps.findIndex((step) => step.name === name)
  if (index < 0) return false
  moduleSteps.splice(index, 1)
  return true
}

export type TickStepReport = {
  name: string
  ok: boolean
  ms: number
  result: unknown
  error: string | null
}

export type TickReport = {
  /** False when another process holds the tick — nothing ran. */
  ran: boolean
  leases: LeaseRecovery | null
  expiredRequests: number
  expiredReservations: number
  expiredAuthorizations: number
  stalledRuns: number
  delivery: DeliveryReport | null
  /** Every step in the order it ran, kernel and module alike. */
  steps: TickStepReport[]
  /** `<step>: <message>` for each step that threw — reported, never fatal. */
  errors: string[]
}

export type TickOptions = {
  deliver?: Deliverer
  /** The whole tick's time budget; well under a cron's 60 seconds. */
  budgetMs?: number
}

export const TICK_LEASE_NAME = 'ops-tick'
/** Longer than any tick may run; a crashed holder blocks the next one this long. */
const TICK_LEASE_SECONDS = 120

/**
 * One tick at a time across every process (HQ's cron, the MCP server, the
 * worker). A row lease, not an advisory lock: HQ runs behind a pooled
 * connection, where a session lock can be taken on one checkout and never
 * released on another. Taken and judged by the database's clock.
 */
async function acquireTickLease(): Promise<string | null> {
  const holder = randomUUID()
  const rows = await withReader((db) =>
    db
      .insert(opsSchedulerLeases)
      .values({
        name: TICK_LEASE_NAME,
        holder,
        acquiredAt: sql`now()`,
        expiresAt: nowPlus(TICK_LEASE_SECONDS),
      })
      .onConflictDoUpdate({
        target: opsSchedulerLeases.name,
        set: {
          holder,
          acquiredAt: sql`now()`,
          expiresAt: nowPlus(TICK_LEASE_SECONDS),
        },
        setWhere: sql`${opsSchedulerLeases.expiresAt} < now()`,
      })
      .returning({ holder: opsSchedulerLeases.holder }),
  )
  return rows[0]?.holder === holder ? holder : null
}

async function releaseTickLease(holder: string): Promise<void> {
  await withReader((db) =>
    db
      .delete(opsSchedulerLeases)
      .where(
        and(
          eq(opsSchedulerLeases.name, TICK_LEASE_NAME),
          eq(opsSchedulerLeases.holder, holder),
        ),
      ),
  )
}

/**
 * Runs that stopped sending heartbeats — later than their runtime's
 * `stalled_after_seconds` (15 minutes without one) — are announced as
 * `run.stalled`, once per quiet period. The lease, not this, decides when the
 * task goes back to the queue.
 */
export async function flagStalledRuns(
  options: { limit?: number } = {},
): Promise<number> {
  return withTransaction(async (tx) => {
    const allowance = sql`coalesce(${opsRuntimes.stalledAfterSeconds}, 900)`
    const running = await tx
      .select({
        run: opsAgentRuns,
        bucket: sql<string>`floor(extract(epoch from ${opsAgentRuns.heartbeatAt}) / ${allowance})::bigint::text`,
      })
      .from(opsAgentRuns)
      .leftJoin(
        opsRuntimes,
        and(
          eq(opsRuntimes.ownerId, opsAgentRuns.ownerId),
          sql`${opsRuntimes.grantId}::text = ${opsAgentRuns.actorId}`,
        ),
      )
      .where(
        and(
          eq(opsAgentRuns.status, 'running'),
          sql`${opsAgentRuns.heartbeatAt} < now() - (${allowance} * interval '1 second')`,
        ),
      )
      .orderBy(asc(opsAgentRuns.heartbeatAt))
      .limit(options.limit ?? 200)
    for (const { run, bucket } of running)
      await emitEvent(tx, {
        ownerId: run.ownerId,
        projectId: run.projectId,
        type: 'run.stalled',
        subjectType: 'agent_run',
        subjectId: run.id,
        dedupeKey: `run.stalled:${run.id}:${bucket}`,
        payload: {
          taskId: run.taskId,
          lastHeartbeat: run.heartbeatAt.toISOString(),
        },
      })
    return running.length
  })
}

/**
 * The scheduler tick behind `/api/cron/ops-tick`: recover lapsed leases,
 * expire human requests, budget holds and release authorizations, flag
 * stalled runs, run the modules' registered steps, then deliver events —
 * each step isolated (a throw is reported, never fatal), each in a small
 * batch, all inside `budgetMs`. A second tick while one runs does nothing
 * (`ran: false`).
 */
export async function runOpsTick(
  options: TickOptions = {},
): Promise<TickReport> {
  const started = performance.now()
  const budgetMs = options.budgetMs ?? 45_000
  const remainingMs = () =>
    Math.max(0, budgetMs - (performance.now() - started))
  const report: TickReport = {
    ran: false,
    leases: null,
    expiredRequests: 0,
    expiredReservations: 0,
    expiredAuthorizations: 0,
    stalledRuns: 0,
    delivery: null,
    steps: [],
    errors: [],
  }
  const holder = await acquireTickLease()
  if (!holder) return report
  report.ran = true
  const step = async (name: string, work: () => Promise<unknown>) => {
    const at = performance.now()
    try {
      const result = await work()
      report.steps.push({
        name,
        ok: true,
        ms: Math.round(performance.now() - at),
        result: result ?? null,
        error: null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      report.steps.push({
        name,
        ok: false,
        ms: Math.round(performance.now() - at),
        result: null,
        error: message,
      })
      report.errors.push(`${name}: ${message}`)
    }
  }
  try {
    await step('leases', async () => {
      report.leases = await recoverLapsedLeases()
      return report.leases
    })
    await step('requests', async () => {
      report.expiredRequests = (await expireHumanRequests()).length
      return report.expiredRequests
    })
    await step('reservations', async () => {
      report.expiredReservations = (await expireReservations()).length
      return report.expiredReservations
    })
    await step('authorizations', async () => {
      report.expiredAuthorizations = (await expireAuthorizations()).length
      return report.expiredAuthorizations
    })
    await step('stalled_runs', async () => {
      report.stalledRuns = await flagStalledRuns()
      return report.stalledRuns
    })
    for (const entry of [...moduleSteps])
      await step(entry.name, () => entry.run({ remainingMs }))
    await step('delivery', async () => {
      report.delivery = await deliverEvents({
        ...(options.deliver ? { deliver: options.deliver } : {}),
        budgetMs: Math.max(0, remainingMs() - 5_000),
      })
      return report.delivery
    })
  } finally {
    await releaseTickLease(holder)
  }
  return report
}
