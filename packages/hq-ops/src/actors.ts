import type { OpsActorType } from '@theiceji/hq-db/enums'
import { oauthGrants, users } from '@theiceji/hq-db/schema'
import { and, eq } from 'drizzle-orm'
import { type Actor, connectionActor, userActor } from './access'
import type { Reader } from './db'

/**
 * Rebuilding an actor from a stored record — for work that runs later, on
 * the ops tick, in the name of whoever queued it. The actor is rebuilt from
 * the credential as it stands *now*: a revoked connection, a narrowed scope
 * or a deleted user comes back as a refusal or with less authority, so queued
 * work can't outlive the permission that queued it.
 */

/** The audit identity of the ops tick. Not a connection: it has no grant and no scopes. */
export const SCHEDULER_ACTOR_ID = 'ops-scheduler'

/**
 * The ops tick acting on one owner's rows — recovering a lapsed lease,
 * expiring a request. It never passes a policy gate (it only does what the
 * clock makes true) and never creates work an agent asked for.
 */
export function schedulerActor(ownerId: string): Actor {
  return {
    type: 'worker',
    id: SCHEDULER_ACTOR_ID,
    userId: ownerId,
    role: 'admin',
    label: 'HQ scheduler',
  }
}

export type ActorLookup =
  | { ok: true; actor: Actor }
  | { ok: false; reason: string }

export async function actorFromRecord(
  reader: Reader,
  ownerId: string,
  stored: { actorType: OpsActorType; actorId: string },
): Promise<ActorLookup> {
  const [owner] = await reader
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1)
  if (!owner) return { ok: false, reason: 'The owning user no longer exists.' }
  if (stored.actorType === 'user') {
    if (stored.actorId !== owner.id)
      return { ok: false, reason: 'Queued by someone other than the owner.' }
    return { ok: true, actor: userActor(owner) }
  }
  const [grant] = await reader
    .select()
    .from(oauthGrants)
    .where(
      and(eq(oauthGrants.id, stored.actorId), eq(oauthGrants.userId, owner.id)),
    )
    .limit(1)
  if (!grant)
    return {
      ok: false,
      reason: 'The connection that queued this work no longer exists.',
    }
  if (grant.revokedAt)
    return {
      ok: false,
      reason: `The connection “${grant.label}” that queued this work was revoked.`,
    }
  if (grant.actorType !== stored.actorType)
    return { ok: false, reason: 'The connection’s actor type changed.' }
  return {
    ok: true,
    actor: connectionActor({
      type: grant.actorType,
      grantId: grant.id,
      userId: owner.id,
      role: owner.role,
      scopes: grant.scope.split(/\s+/).filter(Boolean),
      label: grant.label,
    }),
  }
}
