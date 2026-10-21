import 'server-only'
import { getDb } from '@theiceji/hq-db'
import { googleConnections, providerConnections } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { InboxEntry } from '@/components/Inbox'
import { MODULES } from '@/modules'
import { keysFor } from './inbox-keys'
import { openProposals, openRequests, requestNow } from './per-request'

/** The one line of a proposal worth reading before deciding: its text, action or question. */
function proposalQuote(payload: Record<string, unknown>): string | null {
  for (const key of ['text', 'body', 'action', 'question', 'title']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim())
      return value.length > 600 ? `${value.slice(0, 600)}…` : value
  }
  return null
}

/** "4h", "2d" — how long something has waited, from the database's clock. */
function age(from: Date, now: Date): { text: string; hours: number } {
  const minutes = Math.max(
    0,
    Math.round((now.getTime() - from.getTime()) / 60_000),
  )
  const hours = minutes / 60
  const text =
    minutes < 60
      ? `${minutes}m`
      : hours < 48
        ? `${Math.round(hours)}h`
        : `${Math.round(hours / 24)}d`
  return { text, hours }
}

const when = (date: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  }).format(date)

/**
 * Everything that waits for the owner in one queue: human requests from the
 * ops kernel and the proposals routines leave (hq-agents), both answered
 * here; and connection problems, which link to where they are fixed.
 *
 * Read by `/inbox` and by the dock on Home, so both show the same queue.
 */
export async function loadInboxEntries(actor: Actor): Promise<InboxEntry[]> {
  const db = getDb()
  const [requests, now, proposals] = await Promise.all([
    openRequests(actor),
    requestNow(),
    openProposals(actor),
  ])

  const entries: InboxEntry[] = requests.map(
    ({ request, project, answerable }) => {
      const waited = age(request.createdAt, now)
      return {
        id: request.id,
        kind: 'request',
        title: request.title,
        body: request.impact ?? null,
        why: request.reason,
        meanwhile: request.meanwhile ?? null,
        age: waited.text,
        ageHours: waited.hours,
        since: when(request.createdAt),
        project: project
          ? { slug: project.slug, name: project.name, color: project.color }
          : null,
        where: request.module
          ? (MODULES[request.module]?.label ?? request.module)
          : 'HQ',
        module: request.module ?? undefined,
        urgent: request.urgency === 'urgent',
        answer: answerable
          ? {
              revision: request.revision,
              options: keysFor(
                request.options.length > 0
                  ? request.options
                  : [{ key: 'done', label: 'Done' }],
              ),
            }
          : null,
        link: null,
        facts: [
          ['kind', request.kind.replace('_', ' ')],
          ['urgency', request.urgency],
          ['expires', when(request.expiresAt)],
          [
            'asked by',
            request.actorType === 'user' ? 'you' : request.actorType,
          ],
        ],
      }
    },
  )

  for (const { proposal, project, routine, label, module } of proposals) {
    const waited = age(proposal.createdAt, now)
    entries.push({
      id: proposal.id,
      kind: 'proposal',
      title: proposal.title,
      body: proposal.rationale || null,
      why: 'Proposals never land without you — a routine may accept notes and prompt variants on its own, nothing else.',
      meanwhile: null,
      quote: proposalQuote(proposal.payload),
      age: waited.text,
      ageHours: proposal.heldAt ? 0 : waited.hours,
      since: when(proposal.createdAt),
      project: project
        ? { slug: project.slug, name: project.name, color: project.color }
        : null,
      where: label,
      module: module ?? undefined,
      urgent: false,
      held: Boolean(proposal.heldAt),
      answer: {
        revision: proposal.revision,
        target: 'proposal',
        options: [
          { key: 'accept', label: 'Accept', hotkey: 'a' },
          { key: 'reject', label: 'Reject', hotkey: 'r' },
          proposal.heldAt
            ? { key: 'unhold', label: 'Unhold', hotkey: 'h' }
            : { key: 'hold', label: 'Hold', hotkey: 'h' },
        ],
      },
      link: routine
        ? {
            href: `/agents?routine=${routine.id}`,
            label: `Open ${routine.name}`,
          }
        : null,
      facts: [
        ['proposes', label],
        ['routine', routine?.name ?? 'an agent, on its own'],
        ...(proposal.heldAt
          ? [['held', when(proposal.heldAt)] as [string, string]]
          : []),
        ['expires', when(proposal.expiresAt)],
      ],
    })
  }

  if (db) {
    const [google, providers] = await Promise.all([
      db
        .select()
        .from(googleConnections)
        .where(eq(googleConnections.ownerId, actor.userId))
        .limit(1),
      db
        .select()
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.ownerId, actor.userId),
            isNull(providerConnections.revokedAt),
            inArray(providerConnections.status, ['needs_reauth', 'error']),
          ),
        ),
    ])
    const [connection] = google
    if (connection && connection.status === 'needs_reauth') {
      const since = age(connection.updatedAt, now)
      entries.push({
        id: `google-${connection.id}`,
        kind: 'problem',
        title: 'Reconnect Google',
        body: 'Drive storage and calendar sync wait until you sign in to Google again.',
        why: connection.problem ?? 'Google refused HQ’s access.',
        meanwhile: null,
        age: since.text,
        ageHours: since.hours,
        since: when(connection.updatedAt),
        project: null,
        where: 'Google',
        urgent: false,
        answer: null,
        link: { href: '/settings/google', label: 'Reconnect in Settings' },
        facts: [
          ['account', connection.email],
          ['status', 'needs sign-in'],
        ],
      })
    }
    for (const provider of providers) {
      const since = age(provider.updatedAt, now)
      entries.push({
        id: `provider-${provider.id}`,
        kind: 'problem',
        title: `Reconnect ${provider.label}`,
        body: 'Work that uses this connection waits until it is fixed.',
        why:
          provider.problem ??
          `The connection reports ${provider.status.replace('_', ' ')}.`,
        meanwhile: null,
        age: since.text,
        ageHours: since.hours,
        since: when(provider.updatedAt),
        project: null,
        where: provider.provider,
        urgent: false,
        answer: null,
        link: { href: '/settings/connections', label: 'Fix in Settings' },
        facts: [['status', provider.status.replace('_', ' ')]],
      })
    }
  }

  return entries
}
