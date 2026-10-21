/**
 * Kernel errors. Services throw these; a server action turns them into a
 * message a person can act on, and the MCP layer into a typed error an agent
 * can branch on (`wireError`). Anything else is a bug and is logged, never
 * shown raw.
 *
 * The vocabulary is the one the retired Creator kernel spoke,
 * unchanged on the wire: clients that learned `policy_blocked` or
 * `lease_lost` keep their meaning.
 */

export type OpsErrorCode =
  | 'invalid'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'unavailable'
  /** The owner's operating policy doesn't cover this. */
  | 'policy_blocked'
  /** A budget limit would be exceeded, or the price isn't known. */
  | 'budget_exceeded'
  /** The provider, account or adapter can't do this — or nobody checked. */
  | 'capability_unavailable'
  /** A connection needs the owner to sign in again. */
  | 'reauth_required'
  | 'rate_limited'
  /** A provider may have taken the work; reconcile before trying again. */
  | 'unknown_remote_outcome'
  | 'provider_unavailable'
  /** The same idempotency key was used for a different request. */
  | 'idempotency_conflict'
  /** A lease or fencing token is no longer current — another worker holds it. */
  | 'lease_lost'

export type OpsErrorOptions = {
  fields?: Record<string, string>
  /** Seconds to wait before a retry is worth trying. */
  retryAfterSeconds?: number
  /** Structured context: blockers, limits, the conflicting record. */
  details?: Record<string, unknown>
}

export class OpsError extends Error {
  readonly code: OpsErrorCode
  readonly fields: Record<string, string>
  readonly retryAfterSeconds: number | null
  readonly details: Record<string, unknown>

  constructor(
    code: OpsErrorCode,
    message: string,
    options: Record<string, string> | OpsErrorOptions = {},
  ) {
    super(message)
    this.name = 'OpsError'
    this.code = code
    const shaped =
      'fields' in options ||
      'retryAfterSeconds' in options ||
      'details' in options
        ? (options as OpsErrorOptions)
        : { fields: options as Record<string, string> }
    this.fields = shaped.fields ?? {}
    this.retryAfterSeconds = shaped.retryAfterSeconds ?? null
    this.details = shaped.details ?? {}
  }
}

export const invalid = (message: string, fields?: Record<string, string>) =>
  new OpsError('invalid', message, fields)

export const policyBlocked = (
  message: string,
  details?: Record<string, unknown>,
) => new OpsError('policy_blocked', message, { details })

export const budgetExceeded = (
  message: string,
  details?: Record<string, unknown>,
) => new OpsError('budget_exceeded', message, { details })

export const capabilityUnavailable = (
  message: string,
  details?: Record<string, unknown>,
) => new OpsError('capability_unavailable', message, { details })

export const reauthRequired = (
  message: string,
  details?: Record<string, unknown>,
) => new OpsError('reauth_required', message, { details })

export const leaseLost = (
  message = 'This work is no longer yours: the lease expired or another worker claimed it. Read the task again before doing anything else.',
) => new OpsError('lease_lost', message)

export const unknownRemote = (
  message: string,
  details?: Record<string, unknown>,
) => new OpsError('unknown_remote_outcome', message, { details })

/** Also used for records owned by someone else — existence is not disclosed. */
export const notFound = (what: string) =>
  new OpsError('not_found', `${what} not found.`)

export const forbidden = (
  message = 'Your account doesn’t have permission to do that.',
) => new OpsError('forbidden', message)

export const conflict = (
  message = 'This changed since you opened it. Reload to see the latest, then try again.',
) => new OpsError('conflict', message)

/** The code an agent sees, and whether retrying the same call can help. */
export type WireErrorCode =
  | 'permission_denied'
  | 'not_found'
  | 'revision_conflict'
  | 'idempotency_conflict'
  | 'policy_blocked'
  | 'budget_exceeded'
  | 'capability_unavailable'
  | 'reauth_required'
  | 'validation_failed'
  | 'rate_limited'
  | 'unknown_remote_outcome'
  | 'provider_unavailable'
  | 'lease_lost'
  | 'unavailable'

type Retry = 'no' | 'after_reading' | 'after_delay' | 'after_owner_action'

const WIRE: Record<OpsErrorCode, { code: WireErrorCode; retryable: Retry }> = {
  invalid: { code: 'validation_failed', retryable: 'no' },
  not_found: { code: 'not_found', retryable: 'no' },
  forbidden: { code: 'permission_denied', retryable: 'after_owner_action' },
  conflict: { code: 'revision_conflict', retryable: 'after_reading' },
  unavailable: { code: 'unavailable', retryable: 'after_delay' },
  policy_blocked: { code: 'policy_blocked', retryable: 'after_owner_action' },
  budget_exceeded: { code: 'budget_exceeded', retryable: 'after_owner_action' },
  capability_unavailable: {
    code: 'capability_unavailable',
    retryable: 'after_owner_action',
  },
  reauth_required: { code: 'reauth_required', retryable: 'after_owner_action' },
  rate_limited: { code: 'rate_limited', retryable: 'after_delay' },
  // Never "retry": the work may already have happened.
  unknown_remote_outcome: {
    code: 'unknown_remote_outcome',
    retryable: 'after_reading',
  },
  provider_unavailable: {
    code: 'provider_unavailable',
    retryable: 'after_delay',
  },
  idempotency_conflict: { code: 'idempotency_conflict', retryable: 'no' },
  lease_lost: { code: 'lease_lost', retryable: 'after_reading' },
}

export type WireError = {
  code: WireErrorCode
  message: string
  /**
   * `no` — the same call will fail again; `after_reading` — read the current
   * state first (never blind-retry a side effect); `after_delay` — try again
   * later; `after_owner_action` — only the owner can unblock it.
   */
  retryable: Retry
  retry_after_seconds?: number
  fields?: Record<string, string>
  details?: Record<string, unknown>
}

/** The HTTP status a route answers a kernel error with. */
export const HTTP_STATUS: Record<OpsErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  unavailable: 503,
  policy_blocked: 403,
  budget_exceeded: 402,
  capability_unavailable: 409,
  reauth_required: 401,
  rate_limited: 429,
  unknown_remote_outcome: 409,
  provider_unavailable: 503,
  idempotency_conflict: 422,
  lease_lost: 409,
}

export function wireError(error: OpsError): WireError {
  const mapped = WIRE[error.code]
  return {
    code: mapped.code,
    message: error.message,
    retryable: mapped.retryable,
    ...(error.retryAfterSeconds != null
      ? { retry_after_seconds: error.retryAfterSeconds }
      : {}),
    ...(Object.keys(error.fields).length > 0 ? { fields: error.fields } : {}),
    ...(Object.keys(error.details).length > 0
      ? { details: error.details }
      : {}),
  }
}

/**
 * What a person should read when a named constraint stops a write. Modules
 * add theirs with `registerConstraintMessages` so this file never learns
 * their table names.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  projects_slug_key: 'You already have a project at that address.',
  provider_connections_label_key:
    'A connection to that service with that name already exists.',
  refs_edge_key: 'Those two are already linked.',
  ops_kill_switches_engaged_key: 'That kill switch is already engaged.',
  ops_human_requests_open_key: 'That question is already waiting for you.',
  ops_run_checkpoints_seq_key: conflict().message,
  ops_policies_revision_key: conflict().message,
}

export function registerConstraintMessages(
  messages: Record<string, string>,
): void {
  Object.assign(CONSTRAINT_MESSAGES, messages)
}

type PgLike = {
  code?: string
  constraint_name?: string
  constraint?: string
  cause?: unknown
}

/** postgres.js errors arrive wrapped by drizzle; the SQLSTATE sits on `.cause`. */
function pgError(e: unknown): PgLike | null {
  let current: unknown = e
  for (let depth = 0; depth < 4 && current; depth++) {
    const candidate = current as PgLike
    if (
      typeof candidate.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    )
      return candidate
    current = candidate.cause
  }
  return null
}

export function fromDatabaseError(e: unknown): OpsError | null {
  const pg = pgError(e)
  if (!pg?.code) return null
  const constraint = pg.constraint_name ?? pg.constraint ?? ''
  const known = CONSTRAINT_MESSAGES[constraint]
  switch (pg.code) {
    case '23505':
      return known
        ? new OpsError(
            known === conflict().message ? 'conflict' : 'invalid',
            known,
          )
        : conflict('That already exists.')
    case '23503':
      return invalid(
        known ?? 'That record is linked to something you don’t own.',
      )
    case '23514':
      return invalid(known ?? 'That combination of values isn’t allowed.')
    case '23001':
      return invalid(
        'This record is part of the evidence trail and can’t be changed.',
      )
    case '22P02':
      return notFound('Record')
    case '40001':
    case '40P01':
      return conflict()
    default:
      return null
  }
}

export function asOpsError(e: unknown): unknown {
  if (e instanceof OpsError) return e
  return fromDatabaseError(e) ?? e
}
