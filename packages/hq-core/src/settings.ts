import {
  STORAGE_PROVIDERS,
  type StorageProviderId,
} from '@theiceji/hq-db/enums'
import {
  type OwnerSettingsRow,
  ownerSettings,
  type ProjectRow,
  type QuoteIssuer,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import type { Reader } from '@theiceji/hq-ops/db'
import { conflict } from '@theiceji/hq-ops/errors'
import { choice, parseInput, text } from '@theiceji/hq-ops/schemas'
import {
  audit,
  authorize,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

/**
 * What the owner sets once for all of HQ: where new
 * files go when a project doesn't choose, and who issues their quotes. The
 * owner's alone — `manage`, which no connection holds. Reading is `hq:read`.
 *
 * No row means the defaults: R2 at HQ's root, and no issuer yet.
 */

export type OwnerSettings = {
  storageProvider: StorageProviderId
  storageRoot: string | null
  quoteIssuer: QuoteIssuer | null
  revision: number
}

const DEFAULTS: OwnerSettings = {
  storageProvider: 'r2',
  storageRoot: null,
  quoteIssuer: null,
  revision: 0,
}

function view(row: OwnerSettingsRow | undefined): OwnerSettings {
  if (!row) return DEFAULTS
  return {
    storageProvider: row.storageProvider,
    storageRoot: row.storageRoot,
    quoteIssuer: row.quoteIssuer ?? null,
    revision: row.revision,
  }
}

/** The owner's settings row, read inside any transaction or reader. */
export async function ownerSettingsOf(
  reader: Reader,
  ownerId: string,
): Promise<OwnerSettings> {
  const [row] = await reader
    .select()
    .from(ownerSettings)
    .where(eq(ownerSettings.ownerId, ownerId))
    .limit(1)
  return view(row)
}

export async function getOwnerSettings(actor: Actor): Promise<OwnerSettings> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'hq', 'read')
    return ownerSettingsOf(db, actor.userId)
  })
}

/**
 * Where a project's new files go: the project's own choice, else the
 * owner's default. The asset remembers the provider it was written to, so
 * changing either never moves an old file.
 */
export async function storageTarget(
  reader: Reader,
  ownerId: string,
  project: Pick<ProjectRow, 'storageProvider' | 'storageRoot'> | null,
): Promise<{ provider: StorageProviderId; root: string | null }> {
  if (project?.storageProvider)
    return { provider: project.storageProvider, root: project.storageRoot }
  const settings = await ownerSettingsOf(reader, ownerId)
  return { provider: settings.storageProvider, root: settings.storageRoot }
}

async function write(
  actor: Actor,
  expectedRevision: number,
  action: string,
  patch: Partial<typeof ownerSettings.$inferInsert>,
): Promise<OwnerSettings> {
  return withTransaction(async (tx) => {
    await authorize(tx, actor, null, 'hq', 'manage')
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`owner-settings:${actor.userId}`}, 0))`,
    )
    const before = await ownerSettingsOf(tx, actor.userId)
    if (before.revision !== expectedRevision) throw conflict()
    const [row] = await tx
      .insert(ownerSettings)
      .values({ ownerId: actor.userId, ...patch })
      .onConflictDoUpdate({
        target: ownerSettings.ownerId,
        set: {
          ...patch,
          revision: sql`${ownerSettings.revision} + 1`,
          updatedAt: sql`now()`,
        },
      })
      .returning()
    await audit(tx, actor, {
      projectId: null,
      action,
      targetType: 'owner_settings',
      targetId: null,
      beforeRevision: before.revision,
      afterRevision: row?.revision ?? null,
      changes: patch,
    })
    return view(row)
  })
}

const storageSchema = z.object({
  expectedRevision: z.coerce.number().int().min(0),
  provider: choice(STORAGE_PROVIDERS, 'Choose R2 or Google Drive.'),
  root: text.optional('Folder', 300),
})

/** Settings › Storage: the default provider (and folder) for new files. */
export async function setStorageDefault(
  actor: Actor,
  raw: z.input<typeof storageSchema>,
): Promise<OwnerSettings> {
  const input = parseInput(storageSchema, raw)
  return write(actor, input.expectedRevision, 'settings.storage', {
    storageProvider: input.provider,
    storageRoot: input.root ?? null,
  })
}

const issuerSchema = z.object({
  expectedRevision: z.coerce.number().int().min(0),
  name: text.required('Name', 160),
  taxId: text.optional('Tax ID', 40),
  address: text.optional('Address', 600),
  email: text.optional('Email', 200),
  phone: text.optional('Phone', 60),
  bank: text.optional('Bank details', 300),
})

/** Who issues quotes: printed at the top of every quote PDF. */
export async function setQuoteIssuer(
  actor: Actor,
  raw: z.input<typeof issuerSchema>,
): Promise<OwnerSettings> {
  const input = parseInput(issuerSchema, raw)
  const issuer: QuoteIssuer = { name: input.name as string }
  for (const key of ['taxId', 'address', 'email', 'phone', 'bank'] as const) {
    const value = input[key]
    if (value) issuer[key] = value
  }
  return write(actor, input.expectedRevision, 'settings.quote_issuer', {
    quoteIssuer: issuer,
  })
}
