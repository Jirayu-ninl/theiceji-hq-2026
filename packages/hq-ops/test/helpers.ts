import { describe } from 'bun:test'
import { createDbHandle, type Db, type DbHandle } from '@theiceji/hq-db'
import { MODULE_IDS } from '@theiceji/hq-db/enums'
import { oauthGrants, projects, users } from '@theiceji/hq-db/schema'
import { ALL_SCOPES as CATALOG } from '@theiceji/hq-db/scopes'
import { like, sql } from 'drizzle-orm'
import { type Actor, connectionActor, userActor } from '../src/access'
import { configureOpsDatabase } from '../src/db'

/**
 * The database suites' shared ground: they run only with `OPS_DB_TESTS=1`
 * and a localhost `DATABASE_URL` (a throwaway database — every suite
 * truncates the ops tables), each on its own pool so a race between two
 * claimers is a real race. All data here is synthetic.
 */

const url = process.env.DATABASE_URL ?? ''
export const enabled =
  process.env.OPS_DB_TESTS === '1' &&
  /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)
export const suite = enabled ? describe : describe.skip

/** Every table a suite may leave rows in, child first. */
const TABLES = [
  'ops_scheduler_leases',
  'ops_human_responses',
  'ops_event_deliveries',
  'ops_inbound_events',
  'ops_outbox_events',
  'ops_runtimes',
  'ops_release_authorizations',
  'ops_capability_checks',
  'ops_usage_events',
  'ops_budget_reservations',
  'ops_run_checkpoints',
  'ops_agent_runs',
  'ops_human_requests',
  'ops_tasks',
  'ops_idempotency_keys',
  'ops_kill_switches',
  'ops_policies',
  'ops_audit_events',
  'refs',
  'provider_connections',
  'google_connections',
  'projects',
]

export type Failure = {
  code?: string
  message: string
  details?: Record<string, unknown>
  cause?: unknown
}

/** The Postgres error under drizzle's "Failed query" wrapper: SQLSTATE and message. */
export function pgError(error: Failure): { code: string; message: string } {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth++) {
    const candidate = current as { code?: unknown; message?: unknown }
    if (
      typeof candidate.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    )
      return { code: candidate.code, message: String(candidate.message) }
    current = (current as { cause?: unknown }).cause
  }
  return { code: '', message: error.message }
}

/**
 * Awaits a call that must fail and returns its error. Never
 * `expect(promise).rejects` after Postgres I/O — it hangs forever in bun
 * 1.3.14.
 */
export async function failure(work: PromiseLike<unknown>): Promise<Failure> {
  try {
    await work
  } catch (error) {
    return error as Failure
  }
  throw new Error('Expected this call to fail, but it succeeded.')
}

/** Every scope HQ's catalog can grant. */
export const ALL_SCOPES: string[] = [...CATALOG]

/** Only the reading scopes: every `<module>:read` and `hq:read`. */
export const READ_SCOPES = ALL_SCOPES.filter((scope) => scope.endsWith(':read'))

export type World = {
  db: Db
  tag: string
  owner: Actor
  stranger: Actor
  agent: Actor
  otherAgent: Actor
  readOnly: Actor
  projectId: string
  strangerProjectId: string
}

let handle: DbHandle | null = null

async function truncate(db: Db): Promise<void> {
  await db.execute(sql.raw(`truncate table ${TABLES.join(', ')} cascade`))
  await db.delete(users).where(like(users.email, '%@ops.test'))
}

export async function connection(
  db: Db,
  userId: string,
  type: 'agent' | 'worker',
  scopes: string[],
  label: string,
): Promise<Actor> {
  const [row] = await db
    .insert(oauthGrants)
    .values({
      userId,
      kind: 'personal',
      label,
      scope: scopes.join(' '),
      resource: 'http://localhost:8991/mcp',
      actorType: type,
    })
    .returning()
  if (!row) throw new Error('grant not created')
  return connectionActor({
    type,
    grantId: row.id,
    userId,
    role: 'admin',
    scopes,
    label,
  })
}

export async function createProject(
  db: Db,
  ownerId: string,
  slug: string,
): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({
      ownerId,
      slug,
      name: `Test ${slug}`,
      kind: 'freelance',
      createdBy: ownerId,
      modules: {
        enabled: MODULE_IDS.filter((module) => module !== 'notes'),
        settings: {},
      },
    })
    .returning({ id: projects.id })
  if (!row) throw new Error('project not created')
  return row.id
}

export async function setupWorld(tag: string): Promise<World> {
  if (!handle) {
    handle = createDbHandle(url, { max: 10 })
    configureOpsDatabase(handle.db)
  }
  const db = handle.db
  await truncate(db)
  const [a, b] = await db
    .insert(users)
    .values([
      { email: `owner-${tag}@ops.test`, passwordHash: 'x', role: 'admin' },
      { email: `other-${tag}@ops.test`, passwordHash: 'x', role: 'admin' },
    ])
    .returning({ id: users.id, role: users.role })
  if (!a || !b) throw new Error('users not created')
  return {
    db,
    tag,
    owner: userActor(a),
    stranger: userActor(b),
    agent: await connection(db, a.id, 'agent', ALL_SCOPES, 'Agent (test)'),
    otherAgent: await connection(
      db,
      a.id,
      'agent',
      ALL_SCOPES,
      'Other agent (test)',
    ),
    readOnly: await connection(db, a.id, 'agent', READ_SCOPES, 'Reader (test)'),
    projectId: await createProject(db, a.id, `${tag}-pilot`),
    strangerProjectId: await createProject(db, b.id, `${tag}-theirs`),
  }
}

export async function teardown(): Promise<void> {
  if (!handle) return
  await truncate(handle.db)
  configureOpsDatabase(null)
  await handle.sql.end({ timeout: 5 })
  handle = null
}

/** A policy form for the tests: covers `grantIds`, allows `allowedActions`. */
export function policyInput(
  expectedRevisionNo: number,
  grantIds: (string | undefined)[],
  overrides: Record<string, unknown> = {},
) {
  return {
    expectedRevisionNo,
    status: 'active',
    releaseMode: 'human_required',
    coverage: 'selected',
    grantIds: grantIds.filter(Boolean),
    allowedActions: ['draft', 'propose', 'import', 'decide'],
    ...overrides,
  }
}

export async function count(db: Db, query: ReturnType<typeof sql>) {
  const rows = await db.execute<{ n: number }>(query)
  return Number(rows[0]?.n ?? 0)
}
