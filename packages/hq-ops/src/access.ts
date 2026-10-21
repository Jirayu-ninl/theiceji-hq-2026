import type {
  ModuleId,
  OpsActorType,
  OpsAgentAction,
  UserRole,
} from '@theiceji/hq-db/enums'
import { forbidden } from './errors'

/**
 * Who may do what, for every module.
 *
 * Three independent gates, all enforced by the services — never by hiding a
 * button or a tool:
 *
 * 1. **Ownership** — every row has an `owner_id`; a record of someone else's
 *    reads as "not found".
 * 2. **Capability** — a person's capabilities come from their role; an
 *    agent's or worker's are the owner's, narrowed to the scopes its
 *    connection was granted: `<area>:<capability>`, where the area is a
 *    module id, `hq` (reading across HQ) or `ops` (`ops:decide`).
 * 3. **Operating policy** (agents and workers only) — anything beyond reading
 *    also needs the owner's current policy to cover the connection and allow
 *    the action. That needs the database, so it runs in `authorize()`
 *    (store.ts) once the project is known.
 *
 * The actor always comes from the credential — the session or the bearer
 * token — and never from anything a caller sends.
 */

export const OPS_CAPABILITIES = [
  'read',
  'write',
  'operate',
  'decide',
  'manage',
] as const
export type OpsCapability = (typeof OPS_CAPABILITIES)[number]

/** A module, or one of the two areas that belong to no module. */
export type ScopeArea = ModuleId | 'hq' | 'ops'

const ROLE_GRANTS: Record<UserRole, readonly OpsCapability[]> = {
  admin: OPS_CAPABILITIES,
  editor: ['read', 'write'],
}

/**
 * The scope a connection needs for a capability in an area. `decide` is one
 * kernel scope for every module; `manage` has none — policies, budgets,
 * connections and settings are the owner's, and no connection can hold them.
 * A scope that isn't in the catalog (`notes:operate`) is simply never
 * granted, so asking for it is refused.
 */
export function scopeFor(
  area: ScopeArea,
  capability: OpsCapability,
): string | null {
  if (capability === 'manage') return null
  if (capability === 'decide') return 'ops:decide'
  return `${area}:${capability}`
}

export type Actor = {
  type: OpsActorType
  /**
   * The audit identity: the user's ID for a person, the connection (grant) ID
   * for an agent or a worker.
   */
  id: string
  /** The HQ user the actor works for — `owner_id` and `created_by`. */
  userId: string
  /** The owning user's role. An agent never exceeds it. */
  role: UserRole
  /** Agents and workers: the scopes their connection holds. */
  scopes?: ReadonlySet<string>
  /** Agents and workers: the connection they authenticated with. */
  grantId?: string
  label?: string
}

export function userActor(user: { id: string; role: UserRole }): Actor {
  return { type: 'user', id: user.id, userId: user.id, role: user.role }
}

export function connectionActor(input: {
  type: 'agent' | 'worker'
  grantId: string
  userId: string
  role: UserRole
  scopes: Iterable<string>
  label: string
}): Actor {
  return {
    type: input.type,
    id: input.grantId,
    userId: input.userId,
    role: input.role,
    scopes: new Set(input.scopes),
    grantId: input.grantId,
    label: input.label,
  }
}

export const isPerson = (actor: Actor): boolean => actor.type === 'user'

export function can(
  actor: Actor,
  area: ScopeArea,
  capability: OpsCapability,
): boolean {
  if (!(ROLE_GRANTS[actor.role]?.includes(capability) ?? false)) return false
  if (actor.type === 'user') return true
  const scope = scopeFor(area, capability)
  return Boolean(scope && actor.scopes?.has(scope))
}

const DENIED: Record<OpsCapability, string> = {
  read: 'Your account can’t open this.',
  write: 'Your account can’t change this.',
  operate: 'Your account can’t run production, release or publishing work.',
  decide: 'Only an admin can decide this.',
  manage: 'Only an admin can change settings, policies and connections.',
}

function agentDenied(area: ScopeArea, capability: OpsCapability): string {
  const scope = scopeFor(area, capability)
  if (scope)
    return `This connection doesn’t have ${scope}. Ask the owner to reconnect it with that permission in HQ → Settings → Connections.`
  return 'Policies, budgets, connections, kill switches and settings are the owner’s, in HQ. An agent can ask with agents_request_human.'
}

export function assertCan(
  actor: Actor,
  area: ScopeArea,
  capability: OpsCapability,
): void {
  if (can(actor, area, capability)) return
  throw forbidden(
    actor.type === 'user' ? DENIED[capability] : agentDenied(area, capability),
  )
}

/**
 * Kernel work — claiming, heartbeating, checkpointing and finishing tasks,
 * asking the owner, pulling and acknowledging events — is one scope for a
 * connection: `agents:operate` (the catalog). A person needs no
 * scope, and the kernel lifecycle asks nothing of their role.
 */
export function assertAgentWork(actor: Actor): void {
  if (actor.type === 'user') return
  assertCan(actor, 'agents', 'operate')
}

/**
 * Reading the kernel's own records — the inbox, a task's context, policies,
 * budgets, capabilities, runtimes: `hq:read` ("see what waits for you and
 * what is running"), or `agents:operate` for a connection that works the
 * queue and must read back what it did. A person reads by role.
 */
export function assertKernelRead(actor: Actor): void {
  if (actor.type === 'user') {
    assertCan(actor, 'hq', 'read')
    return
  }
  if (can(actor, 'hq', 'read') || can(actor, 'agents', 'operate')) return
  throw forbidden(
    'This connection doesn’t have hq:read or agents:operate. Ask the owner to reconnect it with that permission in HQ → Settings → Connections.',
  )
}

/**
 * Where the scope for a piece of work sits, for a connection: a decision is
 * `ops:decide` wherever it happens; work that names no module — or the agents
 * module itself, which has no read/write scopes — is `agents:operate`;
 * anything else is the module's own `<module>:<capability>`. A person is
 * judged by role, so for them the capability stays as asked.
 */
export function workScope(
  actor: Actor,
  module: ModuleId | null | undefined,
  capability: OpsCapability,
): { area: ScopeArea; capability: OpsCapability } {
  if (actor.type === 'user') return { area: module ?? 'agents', capability }
  if (capability === 'decide') return { area: 'ops', capability }
  if (!module || module === 'agents')
    return { area: 'agents', capability: 'operate' }
  return { area: module, capability }
}

/**
 * The policy action a capability needs by default when an agent uses it.
 * `operate` has no default: the service names the exact action it performs.
 */
export const DEFAULT_AGENT_ACTION: Partial<
  Record<OpsCapability, OpsAgentAction>
> = {
  write: 'draft',
  decide: 'decide',
}

/**
 * What an agent must hold in the operating policy for a given call: a named
 * action, or `owner_only` for things no policy can hand over (marking paid,
 * sending a quote, deleting a ready asset, settings).
 */
export type AgentRequirement = OpsAgentAction | 'owner_only'
