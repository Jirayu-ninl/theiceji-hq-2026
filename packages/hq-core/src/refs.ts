import {
  REF_ROLES,
  REF_TYPES,
  type RefRole,
  type RefType,
} from '@theiceji/hq-db/enums'
import { type RefRow, refs } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import type { Reader, Tx } from '@theiceji/hq-ops/db'
import { invalid, notFound } from '@theiceji/hq-ops/errors'
import {
  audit,
  authorize,
  isUuid,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { and, eq, or } from 'drizzle-orm'

/**
 * `refs` — the one edge between modules. A module never holds a
 * foreign key into another; it links through here, so either side can leave
 * HQ with its own tables and nothing to cut.
 *
 * `link` runs inside the caller's transaction: the edge exists exactly when
 * the thing it records (a promote, an accepted proposal) does. Both ends must
 * already belong to the actor — the module that calls `link` has checked its
 * own rows; the edge itself only records owner, types and IDs.
 */

export type RefEnd = { type: RefType; id: string }

const isRefType = (value: string): value is RefType =>
  (REF_TYPES as readonly string[]).includes(value)
const isRefRole = (value: string): value is RefRole =>
  (REF_ROLES as readonly string[]).includes(value)

function assertEnd(end: RefEnd, label: string): void {
  if (!isRefType(end.type)) throw invalid(`${label} can’t be linked.`)
  if (!isUuid(end.id)) throw notFound(label)
}

/** Records `from —role→ to`. Linking the same pair twice is a no-op. */
export async function link(
  tx: Tx,
  actor: Actor,
  from: RefEnd,
  to: RefEnd,
  role: RefRole,
): Promise<void> {
  assertEnd(from, 'The source')
  assertEnd(to, 'The target')
  if (!isRefRole(role)) throw invalid('That kind of link doesn’t exist.')
  await tx
    .insert(refs)
    .values({
      ownerId: actor.userId,
      fromType: from.type,
      fromId: from.id,
      toType: to.type,
      toId: to.id,
      role,
    })
    .onConflictDoNothing()
}

/** Every edge touching one record, either direction, newest first. */
export async function refsOf(
  reader: Reader,
  ownerId: string,
  end: RefEnd,
): Promise<RefRow[]> {
  if (!isRefType(end.type) || !isUuid(end.id)) return []
  return reader
    .select()
    .from(refs)
    .where(
      and(
        eq(refs.ownerId, ownerId),
        or(
          and(eq(refs.fromType, end.type), eq(refs.fromId, end.id)),
          and(eq(refs.toType, end.type), eq(refs.toId, end.id)),
        ),
      ),
    )
    .orderBy(refs.createdAt)
}

export async function listRefs(actor: Actor, end: RefEnd): Promise<RefRow[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'hq', 'read')
    return refsOf(db, actor.userId, end)
  })
}

/**
 * Unlink one edge — the two records stay. A person's act (Notes → Unlink);
 * an agent unlinks nothing.
 */
export async function unlink(actor: Actor, refId: string): Promise<void> {
  if (!isUuid(refId)) throw notFound('Link')
  await withTransaction(async (tx) => {
    await authorize(tx, actor, null, 'hq', 'manage')
    const [row] = await tx
      .delete(refs)
      .where(and(eq(refs.id, refId), eq(refs.ownerId, actor.userId)))
      .returning()
    if (!row) throw notFound('Link')
    await audit(tx, actor, {
      projectId: null,
      action: 'ref.unlink',
      targetType: row.fromType,
      targetId: row.fromId,
      changes: { to: { type: row.toType, id: row.toId }, role: row.role },
    })
  })
}
