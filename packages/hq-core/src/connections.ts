import {
  PROVIDER_CONNECTION_KINDS,
  type ProviderConnectionKind,
} from '@theiceji/hq-db/enums'
import {
  type ProviderConnectionRow,
  providerConnections,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import type { Reader } from '@theiceji/hq-ops/db'
import {
  conflict,
  invalid,
  notFound,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  choice,
  optionalRecordId,
  parseInput,
  recordId,
  revision,
  text,
} from '@theiceji/hq-ops/schemas'
import { seal, secretHint, unseal } from '@theiceji/hq-ops/secrets'
import {
  audit,
  authorize,
  returned,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { guardedFetch } from '@theiceji/net-guard'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'

/**
 * The owner's provider connections (`provider_connections`):
 * shops and platforms today (Etsy, Facebook, YouTube, TikTok), generators
 * and LLM keys with Agents. A connection belongs to the owner, not
 * a project; an account or a marketplace names the one it goes through.
 *
 * · **The owner's alone** (`manage`): no connection — no agent — can add,
 *   replace or revoke one.
 * · **The secret is sealed** with the server's key the moment it arrives and
 *   is never read back: pages and tools see its label, kind, status and the
 *   last four characters.
 * · **Etsy's secret is JSON** (`apiKey`, `accessToken`, and `clientId`,
 *   `refreshToken`, `expiresAt`, `shopId` for refreshing) — the adapter
 *   refreshes the token and seals the new pair itself; anything else is one
 *   token.
 */

registerConstraintMessages({
  provider_connections_label_key:
    'A connection with that name already exists for this provider.',
})

/** The kinds a person connects in Settings: shops, platforms, generators and LLM keys. */
export const CONNECTABLE_NOW: readonly ProviderConnectionKind[] = [
  'etsy',
  'facebook',
  'youtube',
  'tiktok',
  'openai_compatible',
  'llm:anthropic',
]

/* ── Config: base URLs, models and prices — never a secret ─────────── */

const decimal = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,6})?$/, 'A price like 0.04.')
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'A three-letter currency.')
const model = z.string().trim().min(1).max(120)
const baseUrl = z
  .string()
  .trim()
  .max(300)
  .regex(/^https?:\/\/[^\s]+$/, 'A base URL like https://api.openai.com.')
  .transform((value) => value.replace(/\/+$/, '').replace(/\/v1$/, ''))

/**
 * An OpenAI-compatible generator: images through
 * `/v1/images/generations`; video, when the owner names a model, through
 * `/v1/videos` (submit, poll, content). Prices are what HQ holds against the
 * budget before it calls — without one, an agent can't spend on it.
 */
export const generatorConfig = z.object({
  baseUrl,
  currency: currency.optional(),
  image: z
    .object({
      model,
      size: z
        .string()
        .trim()
        .regex(/^\d{2,5}x\d{2,5}$/, 'A size like 1024x1024.')
        .optional(),
      pricePerImage: decimal.optional(),
    })
    .optional(),
  video: z
    .object({
      model,
      seconds: z.number().int().min(1).max(60).optional(),
      size: z
        .string()
        .trim()
        .regex(/^\d{2,5}x\d{2,5}$/, 'A size like 1280x720.')
        .optional(),
      pricePerSecond: decimal.optional(),
    })
    .optional(),
})
export type GeneratorConfig = z.output<typeof generatorConfig>

/** An LLM key for HQ's builtin runner — prices per million tokens. */
export const llmConfig = z.object({
  baseUrl: baseUrl.optional(),
  model,
  currency: currency.optional(),
  inputPerMTok: decimal.optional(),
  outputPerMTok: decimal.optional(),
  maxOutputTokens: z.number().int().min(256).max(64000).optional(),
})
export type LlmConfig = z.output<typeof llmConfig>

/** The config a provider takes; shops and platforms keep theirs in the secret. */
export function configSchemaFor(
  provider: ProviderConnectionKind,
): z.ZodType<Record<string, unknown>> | null {
  if (provider === 'openai_compatible') return generatorConfig
  if (provider === 'llm:anthropic') return llmConfig
  if (provider === 'llm:openai_compatible') return llmConfig.extend({ baseUrl })
  return null
}

export type ProviderConnectionView = Pick<
  ProviderConnectionRow,
  | 'id'
  | 'provider'
  | 'label'
  | 'config'
  | 'secretHint'
  | 'status'
  | 'problem'
  | 'lastCheckedAt'
  | 'revision'
  | 'updatedAt'
>

const view = (row: ProviderConnectionRow): ProviderConnectionView => ({
  id: row.id,
  provider: row.provider,
  label: row.label,
  config: row.config,
  secretHint: row.secretHint,
  status: row.status,
  problem: row.problem,
  lastCheckedAt: row.lastCheckedAt,
  revision: row.revision,
  updatedAt: row.updatedAt,
})

export async function listProviderConnections(
  actor: Actor,
): Promise<ProviderConnectionView[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'hq', 'read')
    const rows = await db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.ownerId, actor.userId),
          isNull(providerConnections.revokedAt),
        ),
      )
      .orderBy(
        asc(providerConnections.provider),
        asc(providerConnections.label),
      )
    return rows.map(view)
  })
}

const saveSchema = z.object({
  connectionId: optionalRecordId('Connection'),
  expectedRevision: revision.optional(),
  provider: choice(PROVIDER_CONNECTION_KINDS, 'Choose a provider.'),
  label: text.required('Name', 80),
  /** Replaces the sealed secret; absent keeps the one stored. */
  secret: z.string().trim().max(8000).optional(),
  /** Base URL, models and prices (generators, LLM keys); absent keeps it. */
  config: z.record(z.string(), z.unknown()).optional(),
})

function checkConfig(
  provider: ProviderConnectionKind,
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  const schema = configSchemaFor(provider)
  if (!schema) return {}
  return parseInput(schema, raw)
}

export type SaveProviderConnectionInput = z.input<typeof saveSchema>

/**
 * The secret checked for its provider's shape, and what its hint is cut from
 * — Etsy's JSON is hinted by its API key, which a token refresh never changes.
 */
function checkSecret(provider: ProviderConnectionKind, secret: string): string {
  if (provider !== 'etsy') return secret
  let parsed: unknown
  try {
    parsed = JSON.parse(secret)
  } catch {
    throw invalid(
      'Etsy’s secret is JSON: {"apiKey", "clientId", "accessToken", "refreshToken", "expiresAt"}.',
      { secret: 'Paste the JSON your Etsy app gave you.' },
    )
  }
  const record = (parsed ?? {}) as Record<string, unknown>
  for (const key of ['apiKey', 'accessToken'])
    if (typeof record[key] !== 'string' || !record[key])
      throw invalid(`Etsy’s secret needs ${key}.`, { secret: `Add "${key}".` })
  return record.apiKey as string
}

/**
 * Add a connection, or rename one / replace its secret. The secret is sealed
 * before it touches the database; a connection with a secret is `connected`
 * (HQ checks it the first time it is used, and says so when it fails).
 */
export async function saveProviderConnection(
  actor: Actor,
  raw: SaveProviderConnectionInput,
): Promise<ProviderConnectionView> {
  const input = parseInput(saveSchema, raw)
  const hintOf = input.secret ? checkSecret(input.provider, input.secret) : ''
  const config = checkConfig(input.provider, input.config)
  const needsConfig = configSchemaFor(input.provider)
  return withTransaction(async (tx) => {
    await authorize(tx, actor, null, 'hq', 'manage')
    if (!input.connectionId) {
      if (!input.secret)
        throw invalid('Paste the secret HQ should keep.', {
          secret: 'Required for a new connection.',
        })
      if (needsConfig && !config)
        throw invalid('Say where it is and which model to use.', {
          config: 'Required for this provider.',
        })
      const [row] = await tx
        .insert(providerConnections)
        .values({
          ownerId: actor.userId,
          createdBy: actor.userId,
          provider: input.provider,
          label: input.label as string,
          config: config ?? {},
          secretSealed: seal(input.secret),
          secretHint: secretHint(hintOf),
          status: 'connected',
        })
        .returning()
      const saved = returned(row)
      await audit(tx, actor, {
        projectId: null,
        action: 'connection.create',
        targetType: 'provider_connection',
        targetId: saved.id,
        changes: { provider: saved.provider, label: saved.label },
      })
      return view(saved)
    }
    const [current] = await tx
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, input.connectionId),
          eq(providerConnections.ownerId, actor.userId),
          isNull(providerConnections.revokedAt),
        ),
      )
      .for('update')
    if (!current) throw notFound('Connection')
    if (input.expectedRevision && current.revision !== input.expectedRevision)
      throw conflict()
    if (current.provider !== input.provider)
      throw invalid('A connection keeps its provider; add a new one instead.')
    const [row] = await tx
      .update(providerConnections)
      .set({
        label: input.label as string,
        ...(config ? { config } : {}),
        ...(input.secret
          ? {
              secretSealed: seal(input.secret),
              secretHint: secretHint(hintOf),
              status: 'connected' as const,
              problem: null,
            }
          : {}),
        revision: sql`${providerConnections.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(providerConnections.id, current.id))
      .returning()
    const saved = returned(row)
    await audit(tx, actor, {
      projectId: null,
      action: 'connection.update',
      targetType: 'provider_connection',
      targetId: saved.id,
      beforeRevision: current.revision,
      afterRevision: saved.revision,
      changes: {
        label: saved.label,
        ...(input.secret ? { secret: 'replaced' } : {}),
      },
    })
    return view(saved)
  })
}

/** Revoke a connection: its secret is dropped; accounts and shops that named it fall back to by hand. */
export async function revokeProviderConnection(
  actor: Actor,
  raw: { connectionId: string },
): Promise<void> {
  const input = parseInput(
    z.object({ connectionId: recordId('Connection') }),
    raw,
  )
  await withTransaction(async (tx) => {
    await authorize(tx, actor, null, 'hq', 'manage')
    const [row] = await tx
      .update(providerConnections)
      .set({
        status: 'revoked',
        revokedAt: sql`now()`,
        secretSealed: null,
        revision: sql`${providerConnections.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(providerConnections.id, input.connectionId),
          eq(providerConnections.ownerId, actor.userId),
          isNull(providerConnections.revokedAt),
        ),
      )
      .returning()
    if (!row) throw notFound('Connection')
    await audit(tx, actor, {
      projectId: null,
      action: 'connection.revoke',
      targetType: 'provider_connection',
      targetId: row.id,
    })
  })
}

/* ── Using a connection (server side) ───────────────────────────────── */

export type OpenedConnection = {
  row: ProviderConnectionRow
  /** The unsealed secret — keep it in memory, never in a log or a response. */
  secret: string
}

/**
 * A live connection and its secret, for the service that calls the
 * provider (a generator, the builtin runner's LLM). Revoked, missing or of
 * another kind reads as not found.
 */
export async function openConnection(
  reader: Reader,
  ownerId: string,
  connectionId: string,
  kinds: readonly ProviderConnectionKind[],
): Promise<OpenedConnection> {
  const [row] = await reader
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, connectionId),
        eq(providerConnections.ownerId, ownerId),
        isNull(providerConnections.revokedAt),
      ),
    )
    .limit(1)
  if (!row || !kinds.includes(row.provider) || !row.secretSealed)
    throw notFound('Connection')
  return { row, secret: unseal(row.secretSealed) }
}

/** Marks a connection's problem (or clears it) after a call told us. */
export async function reportConnection(
  connectionId: string,
  problem: string | null,
  status: 'connected' | 'needs_reauth' | 'error' = problem
    ? 'error'
    : 'connected',
): Promise<void> {
  await withTransaction((tx) =>
    tx
      .update(providerConnections)
      .set({ status, problem, lastCheckedAt: sql`now()` })
      .where(eq(providerConnections.id, connectionId)),
  )
}

/** Owner-configured endpoints on this machine are allowed only when HQ says so (local dev). */
function allowPrivateProviders(): boolean {
  const flag =
    process.env.HQ_RUNTIME_ALLOW_PRIVATE ??
    process.env.CREATOR_RUNTIME_ALLOW_PRIVATE
  return flag === '1' || flag === 'true'
}

export type ProviderResponse = {
  status: number
  headers: Record<string, string>
  body: Uint8Array
  json<T = unknown>(): T
  text(): string
}

/**
 * A call to an owner-configured provider endpoint: pinned to a public
 * address (no redirects followed, no private networks unless
 * HQ_RUNTIME_ALLOW_PRIVATE=1), with a timeout and a size cap.
 */
export async function providerFetch(
  url: string,
  options: {
    method?: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: string
    timeoutMs: number
    maxBytes: number
  },
): Promise<ProviderResponse> {
  const allowPrivate = allowPrivateProviders()
  const response = await guardedFetch(url, {
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    ...(options.body !== undefined ? { body: options.body } : {}),
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    ...(allowPrivate ? { allowAddress: () => true, anyPort: true } : {}),
  })
  const decode = () => new TextDecoder().decode(response.body)
  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
    text: decode,
    json: <T>() => JSON.parse(decode()) as T,
  }
}
