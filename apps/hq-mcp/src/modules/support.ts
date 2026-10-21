import type { CallToolResult } from '@modelcontextprotocol/server'
import { type Actor, connectionActor, userActor } from '@theiceji/hq-ops/access'
import { OpsError, wireError } from '@theiceji/hq-ops/errors'
import { fail, failWith, type Json, ok } from '@theiceji/mcp-kernel/results'
import { z } from 'zod'
import type { ToolContext } from '../kernel'

/**
 * The glue between MCP and the module services (`@theiceji/hq-core`,
 * `@theiceji/hq-ops` and each `@theiceji/hq-<module>`). A module's tools
 * never re-implement a rule: they turn snake_case arguments into the
 * service's input, run the one service HQ's screens also run, and answer the
 * same way every time — `{ ok: true, … }` or `{ ok: false, error: { code,
 * retryable, … } }` with the wire codes agents already know.
 *
 * The actor comes from the verified credential (`context.caller`), never from
 * the arguments.
 */

export function opsActorFor(context: ToolContext): Actor | null {
  const { caller } = context
  if (!caller.userId || !caller.userRole) return null
  if (caller.actorType === 'user')
    return userActor({ id: caller.userId, role: caller.userRole })
  if (!caller.grantId) return null
  return connectionActor({
    type: caller.actorType,
    grantId: caller.grantId,
    userId: caller.userId,
    role: caller.userRole,
    scopes: caller.scopes,
    label: caller.label,
  })
}

const NO_USER = fail(
  'HQ tools act as an HQ user, and this connection has none. Over local stdio, set HQ_LOCAL_USER_EMAIL in apps/hq-mcp/.env; over HTTP, connect with an HQ grant.',
)

const NO_DATABASE = fail(
  'HQ tools need HQ’s database, and this MCP server has no DATABASE_URL.',
)

/** JSON-safe copy: Dates become ISO strings, undefined keys disappear. */
export function plain<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json
}

export function refusal(error: unknown): CallToolResult {
  if (error instanceof OpsError) {
    const wire = wireError(error)
    const hint =
      wire.retryable === 'after_reading'
        ? ' Read the current state before trying again — don’t repeat the call blindly.'
        : wire.retryable === 'after_owner_action'
          ? ' Only the owner can unblock this.'
          : wire.retryable === 'after_delay'
            ? ' Try again later.'
            : ''
    return failWith(
      `${wire.code}: ${wire.message}${hint}`,
      wire as unknown as Json,
    )
  }
  throw error
}

export type Presented = { text: string; data: Json }

/** A read: no idempotency, typed refusals. */
export async function readTool<T>(
  context: ToolContext,
  work: (actor: Actor) => Promise<T>,
  present: (value: T) => Presented,
): Promise<CallToolResult> {
  if (!context.db) return NO_DATABASE
  const actor = opsActorFor(context)
  if (!actor) return NO_USER
  try {
    const value = await work(actor)
    const { text, data } = present(value)
    return ok(text, { ok: true, ...plain(data) })
  } catch (error) {
    return refusal(error)
  }
}

/* ── Shared argument shapes ─────────────────────────────────────────── */

export const idArg = (label: string) =>
  z
    .uuid({ error: `${label} must be a UUID.` })
    .describe(`The ${label.toLowerCase()} ID.`)

export const projectIdArg = idArg('Project')

export const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

/**
 * A write. The module service owns idempotency — the tool passes
 * `idempotency_key` through, and a retry with the same key gets the first
 * record back — and optimistic revisions (`expected_revision`); the tool only
 * shapes the answer.
 */
export const writeTool = readTool

export const idempotencyKeyArg = z
  .string()
  .min(8)
  .max(200)
  .describe(
    'A unique key for this call (a UUID works). Retrying with the same key returns the first result instead of doing the work twice; reusing it for a different request is refused.',
  )

export const expectedRevisionArg = z
  .number()
  .int()
  .min(1)
  .describe(
    'The revision you last read. If the record changed since, the call is refused with revision_conflict instead of overwriting.',
  )

export const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

/** Drops keys whose value is undefined, so a service sees "unchanged", not null. */
export function defined<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}
