import type { OpsEventType } from '@theiceji/hq-db/enums'
import { opsOutboxEvents } from '@theiceji/hq-db/schema'
import { sql } from 'drizzle-orm'
import type { Tx } from './db'

/**
 * The transactional outbox. An event is written in
 * the same transaction as the change it announces — so it exists exactly when
 * the change does — and delivered later by the ops tick (runtime.ts).
 *
 * The dedupe key names the fact, not the attempt: announcing "proposal X was
 * decided" twice is one event. Payloads carry IDs and small flags only; a
 * runtime reads the actual work back from HQ, so nothing a third party wrote
 * travels inside an event as an instruction.
 *
 * One clock: `available_at` defaults to the database's `now()`, and every
 * reader compares it with `now()` too.
 */

export type EventInput = {
  ownerId: string
  projectId: string | null
  type: OpsEventType
  subjectType: string
  subjectId: string
  dedupeKey: string
  payload?: Record<string, string | number | boolean | null>
  /** Seconds from now before the event may be delivered. */
  delaySeconds?: number
  /**
   * An instant the work itself names (a task's `not_before`). Never earlier
   * than the database's `now()`, so a past instant means "now", not "late".
   */
  availableAt?: Date | null
}

function availableAt(input: EventInput) {
  if (input.availableAt)
    return sql`greatest(now(), ${input.availableAt.toISOString()}::timestamptz)`
  if (input.delaySeconds)
    return sql`now() + make_interval(secs => ${input.delaySeconds})`
  return sql`now()`
}

export async function emitEvent(tx: Tx, input: EventInput): Promise<void> {
  await tx
    .insert(opsOutboxEvents)
    .values({
      ownerId: input.ownerId,
      projectId: input.projectId,
      type: input.type,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      dedupeKey: input.dedupeKey.slice(0, 300),
      payload: input.payload ?? {},
      availableAt: availableAt(input),
    })
    .onConflictDoNothing({
      target: [opsOutboxEvents.ownerId, opsOutboxEvents.dedupeKey],
    })
}
