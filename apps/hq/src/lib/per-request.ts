import 'server-only'
import { listProposals } from '@theiceji/hq-agents/proposals'
import { getDb } from '@theiceji/hq-db'
import type { UserRole } from '@theiceji/hq-db/enums'
import { type Actor, userActor } from '@theiceji/hq-ops/access'
import { dbNow } from '@theiceji/hq-ops/db'
import { listHumanRequests } from '@theiceji/hq-ops/human'
import { cache } from 'react'

/**
 * Reads several loaders of one render need, made once per request (React
 * `cache`, keyed by primitives so the layout and the page share them).
 * Home's Time and the Inbox queue both list what waits for you; every Home
 * projection asks the database for the time.
 */

/** The database's clock for this request (`dbNow`), or the host's without a database. */
export const requestNow = cache(async (): Promise<Date> => {
  const db = getDb()
  return db ? dbNow(db) : new Date()
})

const requestsFor = cache((userId: string, role: UserRole) =>
  listHumanRequests(userActor({ id: userId, role }), {
    status: 'open',
    limit: 200,
  }),
)

/** Open human requests, newest first — the Inbox queue and Time's lane. */
export function openRequests(actor: Actor) {
  return requestsFor(actor.userId, actor.role)
}

const proposalsFor = cache((userId: string, role: UserRole) =>
  listProposals(userActor({ id: userId, role }), {
    status: 'proposed',
    limit: 200,
  }),
)

/** Proposals waiting for a decision — the Inbox queue and Time's agents. */
export function openProposals(actor: Actor) {
  return proposalsFor(actor.userId, actor.role)
}
