import { createDbHandle, type Db, type DbHandle } from '@theiceji/hq-db'
import { MODULE_IDS, type ProjectKind } from '@theiceji/hq-db/enums'
import {
  oauthGrants,
  type ProjectRow,
  projects,
  users,
} from '@theiceji/hq-db/schema'
import { ALL_SCOPES as CATALOG } from '@theiceji/hq-db/scopes'
import { like, sql } from 'drizzle-orm'
import { type Actor, connectionActor, userActor } from './access'
import { configureOpsDatabase } from './db'
import { savePolicy } from './policy'

/**
 * The ground every module's database suite stands on (DB tests are
 * opt-in with `<M>_DB_TESTS=1` + a localhost DATABASE_URL). Never imported
 * by an app — only by `packages/hq-<module>/test`.
 *
 * A suite truncates its own tables plus the core and kernel ones, so point
 * it at a throwaway database, never HQ's. Every row is synthetic.
 */

const url = () => process.env.DATABASE_URL ?? ''

/** True when `<flag>=1` and DATABASE_URL is on this machine. */
export function dbTestsEnabled(flag: string): boolean {
  return (
    process.env[flag] === '1' &&
    /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url())
  )
}

/** Tables every world clears, child first; a suite adds its module's in front. */
export const CORE_TABLES = [
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
  'owner_settings',
  'provider_connections',
  'google_connections',
  'projects',
] as const

export type Failure = {
  code?: string
  message: string
  details?: Record<string, unknown>
  fields?: Record<string, string>
  cause?: unknown
}

/**
 * Awaits a call that must fail and returns its error. Never
 * `expect(promise).rejects` after Postgres I/O — it hangs in bun 1.3.14.
 */
export async function failure(work: PromiseLike<unknown>): Promise<Failure> {
  try {
    await work
  } catch (error) {
    return error as Failure
  }
  throw new Error('Expected this call to fail, but it succeeded.')
}

/** The Postgres error under drizzle's wrapper: SQLSTATE and message. */
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

/** Every scope a connection can hold. */
export const ALL_SCOPES: string[] = [...CATALOG]
export const READ_SCOPES = ALL_SCOPES.filter((scope) => scope.endsWith(':read'))

export type World = {
  db: Db
  owner: Actor
  stranger: Actor
  /** Every scope; the owner's policy for `project` must still allow it (`allowAgent`). */
  agent: Actor
  /** Only `<module>:read` and `hq:read`. */
  reader: Actor
  project: ProjectRow
  strangerProject: ProjectRow
}

let handle: DbHandle | null = null

export function testDb(): Db {
  if (!handle) {
    handle = createDbHandle(url(), { max: 6 })
    configureOpsDatabase(handle.db)
  }
  return handle.db
}

async function grant(
  db: Db,
  userId: string,
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
      actorType: 'agent',
    })
    .returning()
  if (!row) throw new Error('grant not created')
  return connectionActor({
    type: 'agent',
    grantId: row.id,
    userId,
    role: 'admin',
    scopes,
    label,
  })
}

export async function makeProject(
  db: Db,
  ownerId: string,
  slug: string,
  kind: ProjectKind = 'freelance',
  enabled: readonly string[] = MODULE_IDS.filter((id) => id !== 'notes'),
): Promise<ProjectRow> {
  const [row] = await db
    .insert(projects)
    .values({
      ownerId,
      createdBy: ownerId,
      slug,
      name: `Test ${slug}`,
      kind,
      modules: { enabled: [...enabled], settings: {} },
    })
    .returning()
  if (!row) throw new Error('project not created')
  return row
}

/**
 * A fresh world: two owners, an agent and a reader for the first, one project
 * each. `tables` are the module's own, child first; they are cleared before
 * the core ones.
 */
export async function resetWorld(
  tables: readonly string[],
  options: { kind?: ProjectKind; enabled?: readonly string[] } = {},
): Promise<World> {
  const db = testDb()
  await db.execute(
    sql.raw(`truncate table ${[...tables, ...CORE_TABLES].join(', ')} cascade`),
  )
  await db.delete(users).where(like(users.email, '%@module.test'))
  const [a, b] = await db
    .insert(users)
    .values([
      { email: 'owner@module.test', passwordHash: 'x', role: 'admin' },
      { email: 'other@module.test', passwordHash: 'x', role: 'admin' },
    ])
    .returning({ id: users.id, role: users.role })
  if (!a || !b) throw new Error('users not created')
  return {
    db,
    owner: userActor(a),
    stranger: userActor(b),
    agent: await grant(db, a.id, ALL_SCOPES, 'Agent (test)'),
    reader: await grant(db, a.id, READ_SCOPES, 'Reader (test)'),
    project: await makeProject(
      db,
      a.id,
      'pilot',
      options.kind,
      options.enabled,
    ),
    strangerProject: await makeProject(
      db,
      b.id,
      'theirs',
      options.kind,
      options.enabled,
    ),
  }
}

/** The owner's policy for a project (or no project) that lets `agent` do `actions`. */
export async function allowAgent(
  world: World,
  actions: readonly string[],
  projectId: string | null = world.project.id,
): Promise<void> {
  await savePolicy(world.owner, projectId, {
    expectedRevisionNo: 0,
    status: 'active',
    releaseMode: 'human_required',
    coverage: 'selected',
    grantIds: [world.agent.grantId],
    allowedActions: [...actions],
  })
}

export async function closeTestDb(
  tables: readonly string[] = [],
): Promise<void> {
  if (!handle) return
  await handle.db.execute(
    sql.raw(`truncate table ${[...tables, ...CORE_TABLES].join(', ')} cascade`),
  )
  await handle.db.delete(users).where(like(users.email, '%@module.test'))
  configureOpsDatabase(null)
  await handle.sql.end({ timeout: 5 })
  handle = null
}
