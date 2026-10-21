import 'server-only'
import { assetTitle, listAssets } from '@theiceji/hq-assets/assets'
import '@theiceji/hq-assets/register'
import { getDb } from '@theiceji/hq-db'
import type { ProviderConnectionKind } from '@theiceji/hq-db/enums'
import { providerConnections } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

/**
 * Reads the Phase 3–4 module pages share: a project's ready files for a
 * picker, and the owner's provider connections of some kinds for an account
 * or marketplace form (their state only — never a secret).
 */

export type FileOption = {
  id: string
  /** The file name as uploaded. */
  name: string
  /** What HQ calls it: the owner's title, else the file name (`assetTitle`). */
  title: string
  kind: string
  origin: string
  mime: string
}

export async function fileOptions(
  actor: Actor,
  projectId: string,
  kinds?: readonly string[],
): Promise<FileOption[]> {
  try {
    const { assets: rows } = await listAssets(actor, {
      projectId,
      status: 'ready',
      limit: 300,
    })
    return rows
      .filter((row) => !kinds || kinds.includes(row.kind))
      .map((row) => ({
        id: row.id,
        name: row.name,
        title: assetTitle(row),
        kind: row.kind,
        origin: row.origin,
        mime: row.mime,
      }))
  } catch {
    return []
  }
}

export type ConnectionOption = {
  id: string
  provider: string
  label: string
  status: string
}

export async function connectionOptions(
  actor: Actor,
  kinds: readonly ProviderConnectionKind[],
): Promise<ConnectionOption[]> {
  const db = getDb()
  if (!db) return []
  return db
    .select({
      id: providerConnections.id,
      provider: providerConnections.provider,
      label: providerConnections.label,
      status: providerConnections.status,
    })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.ownerId, actor.userId),
        inArray(providerConnections.provider, [...kinds]),
        isNull(providerConnections.revokedAt),
      ),
    )
    .orderBy(asc(providerConnections.label))
}
