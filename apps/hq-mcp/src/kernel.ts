import type { Db } from '@theiceji/hq-db'
import type {
  AccessGrant,
  AccessCheck as GrantCheck,
  Scope,
} from '@theiceji/hq-db/access'
import type { UserRole } from '@theiceji/hq-db/enums'
import {
  type AccessCheck,
  type Caller,
  type AnyTool as KernelTool,
  type Workspace as KernelWorkspace,
  type WorkspaceResource as KernelWorkspaceResource,
  type Logger,
  toolkit,
} from '@theiceji/mcp-kernel'

/**
 * @theiceji/mcp-kernel, specialised to HQ.
 *
 * The kernel only knows a caller's scopes, its grant and a label. HQ's tools
 * need more — the user's role, who the connection acts as and HQ's Postgres —
 * so this file widens the kernel's `Caller` and `ToolContext` once, and every
 * module workspace (./modules) imports `defineTool` / `defineWorkspace` from
 * here rather than the kernel.
 * That keeps each tool's `scope` checked against HQ's own vocabulary
 * (packages/hq-db/src/access/scopes.ts) at compile time.
 */

/** Who is calling — resolved from the bearer token before any tool runs. */
export type HqCaller = Caller<Scope> & {
  /** The owning user's role; a connection never exceeds it. */
  userRole: UserRole | null
  /**
   * Who the connection acts as: an `agent` or a `worker` for a grant, the
   * `user` themself over local stdio. Set by the owner on the grant — never
   * taken from the request.
   */
  actorType: 'agent' | 'worker' | 'user'
}

/**
 * What every tool runs with. There is no ambient project: a tool that works
 * inside a project takes `project_id` as an argument, and the module's
 * service checks that the caller's user owns it.
 */
export type ToolContext = {
  caller: HqCaller
  /** HQ's Postgres. Always present over HTTP; null over stdio without DATABASE_URL. */
  db: Db | null
  log: Logger
}

export type AnyTool = KernelTool<ToolContext>
export type Workspace = KernelWorkspace<ToolContext>
export type WorkspaceResource = KernelWorkspaceResource<ToolContext>

export const { defineTool, defineWorkspace } = toolkit<ToolContext>()

/** A verified HQ grant, as the caller its tools see. */
export function callerFromGrant(grant: AccessGrant): HqCaller {
  return {
    via: grant.kind === 'personal' ? 'personal' : 'oauth',
    userId: grant.userId,
    userRole: grant.userRole,
    grantId: grant.grantId,
    actorType: grant.actorType,
    label: grant.label,
    scopes: new Set(grant.scopes),
  }
}

/** hq-db's bearer check, in the shape the kernel's gate reads. */
export function fromGrantCheck(check: GrantCheck): AccessCheck<HqCaller> {
  if (!check.ok) return check
  const { grant } = check
  return {
    ok: true,
    caller: callerFromGrant(grant),
    clientId: grant.clientId,
    expiresAt: grant.expiresAt,
  }
}
