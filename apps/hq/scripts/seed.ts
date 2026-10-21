/**
 * A realistic LOCAL HQ: five projects, one of each kind, and every
 * module with something honest to show — so Home's State and Time, the
 * project Map, the rail's counts, the Inbox and the Console read real rows.
 *
 *   bun run db:seed                              # seeds for the first admin
 *   bun run db:seed -- --email me@example.com    # seeds for that account
 *   bun run db:seed -- --reset                   # deletes that owner's rows first
 *
 * Refuses anything but a localhost DATABASE_URL, and a database that already
 * has projects unless --reset. --reset deletes the seeded owner's module
 * rows, child tables first (the append-only guards are switched off for
 * that one transaction and back on before it commits); it never drops a
 * table and leaves users, sessions, settings and real connections alone.
 *
 * Every record goes through the module services — validation, audit,
 * append-only history — as the owner, or as the "(seed) agent" connection
 * where only an agent can act: claiming a routine run, proposing, asking the
 * owner for something. Dates follow the database's clock in Asia/Bangkok:
 * the past two weeks, this week (Monday–Sunday around today) and next week.
 *
 * Files: with R2_* set (the repo's fake S3 —
 * `bun run packages/hq-storage/test/fake-s3.ts`, with `FAKE_S3_DIR=<folder>`
 * to keep the files across restarts) they are uploaded the way the browser
 * does it, prepare → PUT → finalize, and previews load. Without
 * R2 they live in this process's memory: the rows are real, the previews
 * won't load. Generated images come from a stand-in OpenAI-compatible
 * generator served on 127.0.0.1 for the length of the run, so the real
 * generation service records their cost; its connection is revoked after.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { deflateSync } from 'node:zlib'
import { propose } from '@theiceji/hq-agents/proposals'
import '@theiceji/hq-agents/register'
import {
  runRoutineNow,
  saveRoutine,
  setRoutineEnabled,
} from '@theiceji/hq-agents/routines'
import { recordRunCost } from '@theiceji/hq-agents/runs'
import {
  createCollection,
  finalizeUpload,
  prepareUpload,
} from '@theiceji/hq-assets/assets'
import { queueGeneration } from '@theiceji/hq-assets/generate'
import '@theiceji/hq-assets/register'
import { configureAssetStorage } from '@theiceji/hq-assets/storage'
import {
  createCard,
  markPaid,
  moveCard,
  openBoard,
} from '@theiceji/hq-board/board'
import { addFollowup, setFollowupArchived } from '@theiceji/hq-board/followups'
import { attachFile, setPrompt } from '@theiceji/hq-board/links'
import { recordPayment, voidPayment } from '@theiceji/hq-board/payments'
import '@theiceji/hq-board/register'
import { createEvent } from '@theiceji/hq-calendar/events'
import '@theiceji/hq-calendar/register'
import {
  type ClientRow,
  createClient,
  setClientArchived,
} from '@theiceji/hq-core/clients'
import {
  revokeProviderConnection,
  saveProviderConnection,
} from '@theiceji/hq-core/connections'
import '@theiceji/hq-core/notes'
import { createProject } from '@theiceji/hq-core/projects'
import { link } from '@theiceji/hq-core/refs'
import { getOwnerSettings, setQuoteIssuer } from '@theiceji/hq-core/settings'
import { createTarget } from '@theiceji/hq-core/targets'
import { createDbHandle, type Db, type DbHandle } from '@theiceji/hq-db'
import type {
  NoteColor,
  ProjectColor,
  ProjectKind,
} from '@theiceji/hq-db/enums'
import {
  type AssetRow,
  notes,
  oauthGrants,
  type ProjectRow,
  users,
} from '@theiceji/hq-db/schema'
import { ALL_SCOPES } from '@theiceji/hq-db/scopes'
import {
  addItem,
  createExperiment,
  readExperiment,
  recordLearning,
  transitionExperiment,
} from '@theiceji/hq-experiments/experiments'
import '@theiceji/hq-experiments/register'
import {
  approveListing,
  planListing,
  recordManualListing,
  saveMarketplace,
  saveProduct,
  setProductFiles,
} from '@theiceji/hq-market/market'
import '@theiceji/hq-market/register'
import {
  confirmPayout,
  recordPayout,
  recordSale,
} from '@theiceji/hq-market/sales'
import { type Actor, connectionActor, userActor } from '@theiceji/hq-ops/access'
import { configureOpsDatabase, dbNow } from '@theiceji/hq-ops/db'
import { requestHumanAction } from '@theiceji/hq-ops/human'
import { savePolicy } from '@theiceji/hq-ops/policy'
import { isSealingConfigured } from '@theiceji/hq-ops/secrets'
import { audit, withTransaction } from '@theiceji/hq-ops/store'
import { checkpointRun, claimTask, finishRun } from '@theiceji/hq-ops/tasks'
import {
  addExample,
  generateExample,
  saveLibrarySlot,
  savePrompt,
} from '@theiceji/hq-prompts/prompts'
import '@theiceji/hq-prompts/register'
import {
  authorizePost,
  planPost,
  recordManualPost,
  saveAccount,
} from '@theiceji/hq-publish/publish'
import { recordReading } from '@theiceji/hq-publish/readings'
import '@theiceji/hq-publish/register'
import { createDraft, sendQuote } from '@theiceji/hq-quotes/quotes'
import '@theiceji/hq-quotes/register'
import {
  type ProviderObjectInfo,
  type StorageProvider,
  type StorageProviderId,
  storageReadiness,
} from '@theiceji/hq-storage'
import {
  attachShotResult,
  generateShot,
  openStory,
  saveCharacter,
  saveScene,
  saveShots,
  saveStory,
  setShotStatus,
} from '@theiceji/hq-story/story'
import '@theiceji/hq-story/register'
import { asc, eq, type SQL, sql } from 'drizzle-orm'

const SEED = '(seed)'
const TZ = 'Asia/Bangkok'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/* ── Arguments and the guard ─────────────────────────────────────────── */

function flag(name: string): string | boolean | undefined {
  const argv = process.argv.slice(2)
  const i = argv.findIndex(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`),
  )
  if (i < 0) return undefined
  const token = argv[i] as string
  if (token.includes('=')) return token.split('=').slice(1).join('=')
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

class Refusal extends Error {}

function localUrl(): string {
  const url = process.env.DATABASE_URL ?? ''
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    host = ''
  }
  if (host !== 'localhost' && host !== '127.0.0.1')
    throw new Refusal(
      'Refusing to seed: DATABASE_URL does not point at localhost. Mock data is for a local database only.',
    )
  return url
}

/* ── The clock: today and its week, in Bangkok ───────────────────────── */

type Clock = {
  /** The database's now. */
  now: Date
  /** `YYYY-MM-DD` in Asia/Bangkok. */
  today: string
  /** Monday of this week. */
  weekStart: string
  /** Monday of next week. */
  nextWeek: string
  /** Monday of last week. */
  lastWeek: string
}

function plusDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** An instant at a Bangkok wall-clock time (UTC+7 all year, no DST). */
const at = (day: string, time: string) => new Date(`${day}T${time}:00+07:00`)

async function readClock(db: Db): Promise<Clock> {
  const now = await dbNow(db)
  const [row] = await db.execute<{ today: string }>(
    sql`select ((now() at time zone ${TZ})::date)::text as today`,
  )
  const today = row?.today as string
  const monday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7
  const weekStart = plusDays(today, -monday)
  return {
    now,
    today,
    weekStart,
    nextWeek: plusDays(weekStart, 7),
    lastWeek: plusDays(weekStart, -7),
  }
}

/* ── Owner, reset, and the empty check ───────────────────────────────── */

type Owner = { id: string; email: string; role: 'admin' | 'editor' }

async function resolveOwner(db: Db): Promise<Owner> {
  const email = flag('email')
  const rows = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(
      typeof email === 'string'
        ? eq(sql`lower(${users.email})`, email.toLowerCase())
        : eq(users.role, 'admin'),
    )
    .orderBy(asc(users.createdAt))
    .limit(1)
  const row = rows[0]
  if (!row)
    throw new Refusal(
      typeof email === 'string'
        ? `No account for ${email}. Create it first:\n  bun run user:create -- --email ${email} --name 'Owner'`
        : "No admin account yet. Create one first:\n  bun run user:create -- --email me@example.com --name 'Owner'",
    )
  if (row.role !== 'admin')
    throw new Refusal(
      `${row.email} is not an admin; HQ's modules need the owner's account.`,
    )
  return row
}

/**
 * The owner's rows in every module table, children before parents. Tables
 * with no owner of their own (scheduler leases) and the owner's settings,
 * Google connection, runtimes and HQ-wide policies are left alone.
 */
const RESET_ORDER = [
  'agent_proposals',
  'agent_routines',
  'exp_decisions',
  'exp_items',
  'exp_learnings',
  'exp_variants',
  'exp_experiments',
  'market_sales_events',
  'market_payouts',
  'market_intents',
  'market_listings',
  'market_product_files',
  'market_products',
  'market_marketplaces',
  'publish_readings',
  'publish_intents',
  'publish_posts',
  'publish_accounts',
  'story_shots',
  'story_scenes',
  'story_characters',
  'story_stories',
  'quote_lines',
  'quote_quotes',
  'calendar_events',
  'prompt_example_picks',
  'prompt_slot_options',
  'prompt_slots',
  'prompt_examples',
  'prompt_variants',
  'prompt_prompts',
  'board_card_payments',
  'board_followups',
  'board_card_events',
  'board_cards',
  'board_lanes',
  'board_boards',
  // After the cards and quotes that point at them.
  'clients',
  'asset_generation_jobs',
  'asset_collection_items',
  'asset_collections',
  'asset_assets',
  'notes',
  'refs',
  'ops_event_deliveries',
  'ops_outbox_events',
  'ops_inbound_events',
  'ops_human_responses',
  'ops_human_requests',
  'ops_run_checkpoints',
  'ops_usage_events',
  'ops_budget_reservations',
  'ops_capability_checks',
  'ops_release_authorizations',
  'ops_agent_runs',
  'ops_tasks',
  'ops_idempotency_keys',
  'ops_audit_events',
] as const

/** Tables the reset touches beyond RESET_ORDER — their guards go off too. */
const RESET_EXTRA = [
  'ops_policies',
  'ops_kill_switches',
  'projects',
  'provider_connections',
] as const

async function reset(db: Db, ownerId: string): Promise<void> {
  const tables = [...RESET_ORDER, ...RESET_EXTRA]
  try {
    await db.transaction(async (tx) => {
      // History tables refuse DELETE row by row (append-only guards). They
      // are switched off inside this transaction only: a failure rolls the
      // switch back with everything else.
      const guarded = await tx.execute<{ name: string }>(
        sql`select distinct c.relname as name from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname = 'public' and c.relname in (${sql.join(
          tables.map((table) => sql`${table}`),
          sql`, `,
        )})`,
      )
      const names = guarded.map((row) => row.name)
      for (const name of names)
        await tx.execute(
          sql`alter table ${sql.identifier(name)} disable trigger user`,
        )
      for (const table of RESET_ORDER)
        await tx.execute(
          sql`delete from ${sql.identifier(table)} where owner_id = ${ownerId}`,
        )
      await tx.execute(
        sql`delete from ops_policies where owner_id = ${ownerId} and project_id is not null`,
      )
      await tx.execute(
        sql`delete from ops_kill_switches where owner_id = ${ownerId} and project_id is not null`,
      )
      await tx.execute(sql`delete from projects where owner_id = ${ownerId}`)
      await tx.execute(
        sql`delete from provider_connections where owner_id = ${ownerId} and label like ${`${SEED}%`}`,
      )
      await tx.execute(
        sql`delete from oauth_grants where user_id = ${ownerId} and label like ${`${SEED}%`}`,
      )
      for (const name of names)
        await tx.execute(
          sql`alter table ${sql.identifier(name)} enable trigger user`,
        )
    })
  } catch (error) {
    const code = pgCode(error)
    if (code === '42501')
      throw new Refusal(
        '--reset needs to own the tables (it switches their append-only guards off for one transaction). Use the migrator role in DATABASE_URL, or drop and recreate the throwaway database and run db:migrate.',
      )
    throw error
  }
  console.log(
    `reset       the owner’s rows in ${RESET_ORDER.length + 2} module tables, their projects and the seed connections`,
  )
}

function pgCode(error: unknown): string {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return ''
}

async function assertEmpty(db: Db, ownerId: string): Promise<void> {
  const [row] = await db.execute<{ projects: number; notes: number }>(
    sql`select (select count(*)::int from projects) as projects, (select count(*)::int from notes where owner_id = ${ownerId}) as notes`,
  )
  if ((row?.projects ?? 0) + (row?.notes ?? 0) > 0)
    throw new Refusal(
      `The database already has ${row?.projects ?? 0} project(s) and ${row?.notes ?? 0} note(s) for this owner. Re-run with --reset to delete the owner's rows and seed again.`,
    )
}

/* ── Pictures and documents ──────────────────────────────────────────── */

type Rgb = readonly [number, number, number]

const rgbOf = (hex: string): Rgb => {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

function randomFrom(text: string): () => number {
  let state = 2166136261
  for (const char of text)
    state = Math.imul(state ^ char.charCodeAt(0), 16777619)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/**
 * A small artwork as PNG bytes: a diagonal wash in the project's colour, a
 * glowing disc and mist bands, different for every name.
 */
function picture(
  name: string,
  tint: string,
  width = 640,
  height = 400,
): Uint8Array<ArrayBuffer> {
  const random = randomFrom(name)
  const base = rgbOf(tint)
  const deep = mixRgb(base, [14, 16, 24], 0.72)
  const light = mixRgb(base, [252, 248, 238], 0.5)
  const glow: Rgb = [255, 238, 204]
  const cx = width * (0.2 + random() * 0.6)
  const cy = height * (0.2 + random() * 0.45)
  const radius = Math.min(width, height) * (0.1 + random() * 0.14)
  const bands = 2 + Math.floor(random() * 4)
  const phase = random() * Math.PI * 2
  const swing = 1.5 + random() * 4
  const stride = width * 3 + 1
  const raw = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < width; x++) {
      let color = mixRgb(light, deep, (x / width) * 0.55 + (y / height) * 0.45)
      const d = Math.hypot(x - cx, y - cy)
      if (d < radius) color = mixRgb(color, glow, 0.9 * (1 - d / radius) ** 0.4)
      else if (d < radius * 2)
        color = mixRgb(color, glow, 0.22 * (1 - (d - radius) / radius))
      const wave = Math.sin(
        (y / height) * Math.PI * bands * 2 +
          Math.sin((x / width) * swing + phase) * 1.6,
      )
      if (wave > 0.9) color = mixRgb(color, [236, 238, 244], 0.2)
      const i = y * stride + 1 + x * 3
      raw[i] = Math.round(color[0])
      raw[i + 1] = Math.round(color[1])
      raw[i + 2] = Math.round(color[2])
    }
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolour
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array(0)),
  ])
}

/** A one-page PDF (Helvetica, ASCII) with a title and a few lines. */
function pdfDocument(title: string, lines: string[]): Uint8Array<ArrayBuffer> {
  const literal = (value: string) =>
    value.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`)
  const content = [
    'BT',
    '/F1 22 Tf',
    '56 770 Td',
    `(${literal(title)}) Tj`,
    '/F1 11 Tf',
    '0 -14 Td',
    ...lines.flatMap((line) => ['0 -18 Td', `(${literal(line)}) Tj`]),
    'ET',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [i, body] of objects.entries()) {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets)
    out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out) as Uint8Array<ArrayBuffer>
}

/** Not a playable video — a named stand-in so a video row has bytes. */
function videoPlaceholder(): Uint8Array<ArrayBuffer> {
  return concat([
    new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]),
    new TextEncoder().encode('HQ seed placeholder - not a playable video.'),
  ])
}

/* ── Storage: R2 when configured, else this process's memory ─────────── */

type StorageMode = 'r2' | 'memory'

const memoryObjects = new Map<string, { bytes: Uint8Array; mime: string }>()
let memorySerial = 0

function memoryProvider(id: StorageProviderId): StorageProvider {
  const info = (key: string): ProviderObjectInfo | null => {
    const entry = memoryObjects.get(key)
    if (!entry) return null
    return {
      key,
      size: entry.bytes.byteLength,
      etag: '',
      lastModified: new Date(),
      contentType: entry.mime,
      metadata: {},
    }
  }
  return {
    id,
    async put(key, body, options) {
      const bytes =
        body instanceof Uint8Array
          ? body
          : body instanceof ArrayBuffer
            ? new Uint8Array(body)
            : body instanceof Blob
              ? new Uint8Array(await body.arrayBuffer())
              : new TextEncoder().encode(body)
      const target = key ?? `${options.path ?? 'seed'}#${++memorySerial}`
      memoryObjects.set(target, {
        bytes,
        mime: options.contentType ?? 'application/octet-stream',
      })
      return {
        ...(info(target) as ProviderObjectInfo),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    },
    async get(key) {
      const entry = memoryObjects.get(key)
      return entry ? new Response(entry.bytes as Uint8Array<ArrayBuffer>) : null
    },
    head: async (key) => info(key),
    delete: async (key) => {
      memoryObjects.delete(key)
    },
    list: async () => ({ objects: [], prefixes: [], cursor: null }),
    async prepareUpload(spec) {
      const key = `${spec.path}#${++memorySerial}`
      return {
        mode: 'presigned_put',
        url: `memory://${key}`,
        headers: {},
        key,
        expiresAt: new Date(Date.now() + HOUR),
      }
    },
    async finalize(key) {
      const found = info(key)
      if (!found)
        throw Object.assign(new Error('The upload never arrived.'), {
          status: 404,
        })
      return found
    },
    accessUrl: async (key, ttl) => `memory://${key}?ttl=${ttl}`,
  }
}

function configureStorage(): StorageMode {
  if (storageReadiness().ok) return 'r2'
  configureAssetStorage({
    providerOverride: (_owner, id) => memoryProvider(id),
  })
  return 'memory'
}

/* ── The seed's context ──────────────────────────────────────────────── */

type ProjectKey = 'channel' | 'shop' | 'film' | 'client' | 'home'

type Ctx = {
  db: Db
  owner: Actor
  agent: Actor
  ownerId: string
  clock: Clock
  p: Record<ProjectKey, ProjectRow>
  /** The stand-in generator's connection, for as long as it runs. */
  generatorId: string
}

/** A past instant, `ms` before the database's now. */
const ago = (x: Ctx, ms: number) => new Date(x.clock.now.getTime() - ms)

/**
 * Up to `n` instants this week (Monday 00:00 Bangkok onwards) and before
 * now, newest first — at least one, even on a Monday morning.
 */
function thisWeek(x: Ctx, n: number): Date[] {
  const start = at(x.clock.weekStart, '00:00').getTime()
  const found = [3, 27, 51, 75, 99, 123]
    .map((hours) => ago(x, hours * HOUR))
    .filter((date) => date.getTime() >= start)
    .slice(0, n)
  return found.length > 0 ? found : [ago(x, MINUTE)]
}

type FileSpec = {
  name: string
  mime: string
  body: Uint8Array<ArrayBuffer>
  width?: number
  height?: number
  durationMs?: number
  collectionId?: string
  tags?: string[]
}

const png = (
  name: string,
  tint: string,
  size: [number, number] = [640, 400],
  extra: Partial<FileSpec> = {},
): FileSpec => ({
  name,
  mime: 'image/png',
  body: picture(name, tint, size[0], size[1]),
  width: size[0],
  height: size[1],
  ...extra,
})

const pdf = (name: string, title: string, lines: string[]): FileSpec => ({
  name,
  mime: 'application/pdf',
  body: pdfDocument(title, lines),
})

/** Upload the way HQ's browser does: prepare → send the bytes → finalize. */
async function upload(
  x: Ctx,
  project: ProjectRow | null,
  file: FileSpec,
): Promise<AssetRow> {
  const prepared = await prepareUpload(x.owner, {
    projectId: project?.id ?? null,
    name: file.name,
    mime: file.mime,
    bytes: file.body.byteLength,
    collectionId: file.collectionId,
    tags: file.tags,
  })
  const target = prepared.upload
  if (target.mode !== 'presigned_put')
    throw new Error(
      `${file.name}: storage asked for a ${target.mode} upload; the seed only speaks presigned PUT (R2).`,
    )
  if (target.url.startsWith('memory://'))
    memoryObjects.set(target.key, { bytes: file.body, mime: file.mime })
  else {
    const response = await fetch(target.url, {
      method: 'PUT',
      headers: target.headers,
      body: file.body,
    }).catch((error: unknown) => {
      throw new Error(
        `Couldn't reach storage at ${new URL(target.url).origin} (${String(error)}). Is the fake S3 running?`,
      )
    })
    if (!response.ok)
      throw new Error(`Storage refused ${file.name}: HTTP ${response.status}.`)
  }
  return finalizeUpload(x.owner, {
    assetId: prepared.asset.id,
    width: file.width,
    height: file.height,
    durationMs: file.durationMs,
  })
}

/* ── The stand-in generator (OpenAI-compatible images) ───────────────── */

type Generator = { url: string; stop: () => Promise<void> }

async function startGenerator(): Promise<Generator> {
  let made = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (
        request.method !== 'POST' ||
        request.url !== '/v1/images/generations'
      ) {
        response.writeHead(404).end('not found')
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
        prompt?: string
        n?: number
      }
      const count = Math.max(1, Math.min(4, Number(body.n ?? 1)))
      const data = Array.from({ length: count }, () => {
        made += 1
        const bytes = picture(
          `${body.prompt ?? 'image'} #${made}`,
          ['#4fc0c8', '#a08ef3', '#f0a35a', '#5fb8ff'][made % 4] as string,
          640,
          400,
        )
        return { b64_json: Buffer.from(bytes).toString('base64') }
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data }))
    })
  })
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/* ── Projects, the agent and its policies ────────────────────────────── */

const PROJECTS: {
  key: ProjectKey
  name: string
  slug: string
  kind: ProjectKind
  color: ProjectColor
  currency: string
}[] = [
  {
    key: 'channel',
    name: 'Desk & Light',
    slug: 'desk-light',
    kind: 'channel',
    color: 'sky',
    currency: 'THB',
  },
  {
    key: 'shop',
    name: 'Paper Fog Prints',
    slug: 'paper-fog',
    kind: 'digital_assets',
    color: 'lavender',
    currency: 'USD',
  },
  {
    key: 'film',
    name: 'Fog Line · หมอกริมน้ำ',
    slug: 'fog-line',
    kind: 'film',
    color: 'teal',
    currency: 'THB',
  },
  {
    key: 'client',
    name: 'Client work · งานลูกค้า',
    slug: 'client-work',
    kind: 'freelance',
    color: 'orange',
    currency: 'THB',
  },
  {
    key: 'home',
    name: 'Home & Health',
    slug: 'home',
    kind: 'personal',
    color: 'mint',
    currency: 'THB',
  },
]

const TINT: Record<ProjectKey, string> = {
  channel: '#5fb8ff',
  shop: '#c9b8ff',
  film: '#4fc0c8',
  client: '#f0a35a',
  home: '#7fd1a8',
}

async function makeProjects(
  owner: Actor,
): Promise<Record<ProjectKey, ProjectRow>> {
  const made = {} as Record<ProjectKey, ProjectRow>
  for (const spec of PROJECTS)
    made[spec.key] = await createProject(owner, {
      name: spec.name,
      slug: spec.slug,
      kind: spec.kind,
      color: spec.color,
      currency: spec.currency,
      timezone: TZ,
    })
  return made
}

/** The "(seed) agent" connection — the minimal grant hq-ops/testing makes. */
async function makeAgent(db: Db, ownerId: string): Promise<Actor> {
  const label = `${SEED} agent`
  await db
    .delete(oauthGrants)
    .where(
      sql`${oauthGrants.userId} = ${ownerId} and ${oauthGrants.label} = ${label}`,
    )
  const scopes = [...ALL_SCOPES]
  const [row] = await db
    .insert(oauthGrants)
    .values({
      userId: ownerId,
      kind: 'personal',
      label,
      scope: scopes.join(' '),
      resource: 'http://localhost:8991/mcp',
      actorType: 'agent',
    })
    .returning()
  if (!row) throw new Error('The seed agent’s grant was not created.')
  return connectionActor({
    type: 'agent',
    grantId: row.id,
    userId: ownerId,
    role: 'admin',
    scopes,
    label,
  })
}

/**
 * The owner's operating policy for the seed agent in one project: what it
 * may do, its cash budget in the project's currency and — once the project
 * has an account or a shop — where it may publish or list.
 */
async function agentPolicy(
  x: Ctx,
  project: ProjectRow,
  revision: number,
  allowedActions: string[],
  allowedAccountIds: string[] = [],
): Promise<void> {
  const limits =
    project.currency === 'USD'
      ? {
          cashLimitPerJob: '5.00',
          cashLimitPerDay: '20.00',
          cashLimitPerMonth: '200.00',
        }
      : {
          cashLimitPerJob: '60.00',
          cashLimitPerDay: '300.00',
          cashLimitPerMonth: '3000.00',
        }
  await savePolicy(x.owner, project.id, {
    expectedRevisionNo: revision,
    status: 'active',
    releaseMode: 'human_required',
    coverage: 'selected',
    grantIds: [x.agent.grantId as string],
    allowedActions,
    allowedAccountIds,
    ...limits,
    note: `${SEED} What the seed agent may do in ${project.name}.`,
  })
}

/** Revision 1 everywhere the agent works; Publish and Market add a second. */
async function policies(x: Ctx): Promise<void> {
  await agentPolicy(x, x.p.channel, 0, ['draft', 'propose', 'import'])
  await agentPolicy(x, x.p.shop, 0, ['draft', 'propose', 'import'])
  await agentPolicy(x, x.p.film, 0, ['draft', 'propose', 'generate'])
  await agentPolicy(x, x.p.client, 0, ['draft'])
}

/* ── Notes ───────────────────────────────────────────────────────────── */

type NoteSeed = {
  title?: string
  body: string
  color?: NoteColor
  pinned?: boolean
  labels?: string[]
  project?: ProjectKey
  /** Last touched this many hours ago. */
  hours: number
  archived?: boolean
  trashed?: boolean
  promote?: boolean
}

const NOTES: NoteSeed[] = [
  {
    title: 'This week',
    body: '- [x] Seed HQ with real rows\n- [ ] Send Kinkaew the logo system\n- [ ] Clear the lamp tour post\n- [ ] Chase Lumen Plaza invoice 2/2',
    color: 'citron',
    pinned: true,
    labels: ['todo'],
    hours: 3,
  },
  {
    title: 'Hook ideas',
    body: '- "Your wrist hurts because of this one habit"\n- "I tested 3 monitor arms under ฿1,000"\n- "Stop buying desk lamps"',
    color: 'sky',
    pinned: true,
    labels: ['ideas', 'hooks'],
    project: 'channel',
    hours: 6,
  },
  {
    title: 'Idea: a 3-second cold open',
    body: 'Open on the lamp switching on, cut to the whole desk before the 3-second mark. Try it on the lamp tour.',
    labels: ['ideas'],
    project: 'channel',
    hours: 30,
    promote: true,
  },
  {
    title: 'Bundle pricing',
    body: 'Singles at $4.90–5.90, a bundle of three at $11.90. The shop takes 6.5% + $0.20 a listing — check the fee sheet before the bundle goes out.',
    color: 'sand',
    labels: ['pricing'],
    project: 'shop',
    hours: 26,
  },
  {
    title: 'Lantern motif',
    body: 'The lantern is the only warm light in the film; every other source stays blue-grey. Shot 2.1 is where it first swings into frame.',
    color: 'lilac',
    labels: ['film'],
    project: 'film',
    hours: 50,
  },
  {
    title: 'บรีฟกิ่งแก้ว',
    body: 'ลูกค้าอยากได้โทนสีอบอุ่น ไม่เอาสีฟ้า\n- [ ] โลโก้ต้องอ่านง่ายบนป้ายหน้าร้าน\n- [ ] ส่งงานรอบแรกภายในวันศุกร์',
    color: 'blush',
    labels: ['client'],
    project: 'client',
    hours: 75,
  },
  {
    title: 'Passport checklist',
    body: '- [ ] Two 1.5-inch photos\n- [ ] Old passport\n- [ ] Book a slot at the passport office',
    color: 'sage',
    labels: ['errands'],
    project: 'home',
    hours: 96,
  },
  {
    title: 'Reading',
    body: '- [ ] The Nature of Code (2nd ed.)\n- [ ] Real-Time Rendering ch. 14\n- [x] Designing Data-Intensive Applications',
    labels: ['reading'],
    hours: 5 * 24,
  },
  {
    title: 'Gear to test for the desk channel',
    body: '- Gel wrist rest\n- Clamp monitor arm\n- Under-desk cable tray\n- LED light bar',
    color: 'clay',
    labels: ['gear'],
    project: 'channel',
    hours: 40 * 24,
  },
  {
    title: 'Old infra notes',
    body: 'Supabase → plain Postgres migration checklist. Done; kept for reference.',
    labels: ['infra'],
    hours: 55 * 24,
  },
  {
    title: 'Q3 retro',
    body: 'Shipped: the new board. Missed: the shop relaunch.',
    labels: ['retro'],
    hours: 20 * 24,
    archived: true,
  },
  {
    body: 'Duplicate of "Hook ideas"',
    hours: 4 * 24,
    trashed: true,
  },
]

async function seedNotes(x: Ctx): Promise<number> {
  let promoted = 0
  for (const [position, seed] of NOTES.entries()) {
    const touched = sql`now() - make_interval(hours => ${seed.hours})`
    const [row] = await x.db
      .insert(notes)
      .values({
        ownerId: x.ownerId,
        title: seed.title ?? null,
        body: seed.body,
        color: seed.color ?? 'none',
        pinned: seed.pinned ?? false,
        labels: seed.labels ?? [],
        position,
        projectId: seed.project ? x.p[seed.project].id : null,
        createdAt: sql`now() - make_interval(hours => ${seed.hours + 2})`,
        updatedAt: touched,
        archivedAt: seed.archived ? touched : null,
        deletedAt: seed.trashed ? touched : null,
      })
      .returning()
    if (!row) throw new Error('A note was not created.')
    if (seed.promote && seed.project) {
      await promoteToCard(x, row.id, x.p[seed.project], seed)
      promoted += 1
    }
  }
  return promoted
}

/**
 * What Notes › Promote does (apps/hq/src/lib/notes/promote.ts, which is
 * server-only): the card through the target registry, `note —promoted_to→
 * card`, the note's record of where it went, and the audit — one transaction.
 */
async function promoteToCard(
  x: Ctx,
  noteId: string,
  project: ProjectRow,
  seed: NoteSeed,
): Promise<void> {
  const title = seed.title ?? 'Untitled note'
  await withTransaction(async (tx) => {
    const created = await createTarget(
      'card',
      { title, body: seed.body, labels: seed.labels ?? [] },
      { tx, actor: x.owner, project },
    )
    await link(
      tx,
      x.owner,
      { type: 'note', id: noteId },
      { type: created.type, id: created.id },
      'promoted_to',
    )
    await tx
      .update(notes)
      .set({
        promotedTo: {
          type: created.type,
          id: created.id,
          href: created.href,
          projectId: project.id,
          label: title.slice(0, 60),
        },
      })
      .where(eq(notes.id, noteId))
    await audit(tx, x.owner, {
      projectId: project.id,
      action: 'note.promote',
      targetType: 'note',
      targetId: noteId,
      changes: {
        to: { type: created.type, id: created.id },
        label: title.slice(0, 60),
      },
    })
  })
}

/* ── Files ───────────────────────────────────────────────────────────── */

type Files = {
  thumbs: AssetRow[]
  teaser: AssetRow
  prints: Record<string, { preview: AssetRow; file: AssetRow }>
  boards: { mara: AssetRow; ferryman: AssetRow }
  still: AssetRow
  brief: AssetRow
  moodboard: AssetRow
  wireframe: AssetRow
  slides: AssetRow
  richMenu: AssetRow
  stickers: AssetRow
  pending: AssetRow
}

async function seedFiles(x: Ctx): Promise<Files> {
  const { channel, shop, film, client, home } = x.p
  const thumbs: AssetRow[] = []
  for (const name of [
    'thumb-wrist-rest.png',
    'thumb-monitor-arm.png',
    'thumb-cable-tray.png',
    'thumb-desk-lamp.png',
  ])
    thumbs.push(
      await upload(
        x,
        channel,
        png(name, TINT.channel, [360, 640], { tags: ['thumbnail'] }),
      ),
    )
  const teaser = await upload(x, channel, {
    name: 'lamp-tour-teaser (placeholder).mp4',
    mime: 'video/mp4',
    body: videoPlaceholder(),
    width: 1080,
    height: 1920,
    durationMs: 14_000,
    tags: ['teaser', 'placeholder'],
  })

  const prints: Files['prints'] = {}
  for (const [key, title] of [
    ['wabi', 'Wabi-sabi wall art set'],
    ['chladni', 'Chladni pattern print'],
    ['attractor', 'Strange attractor poster'],
    ['fog', 'Fog river print bundle'],
    ['lantern', 'Lantern night poster'],
  ] as const)
    prints[key] = {
      preview: await upload(
        x,
        shop,
        png(`${key}-cover.png`, TINT.shop, [400, 600], { tags: ['preview'] }),
      ),
      file: await upload(
        x,
        shop,
        pdf(`${key}-print.pdf`, title, [
          'Printable, 2:3, 300 dpi.',
          'Personal use. Thank you for buying from Paper Fog.',
        ]),
      ),
    }

  const characters = await createCollection(x.owner, {
    projectId: film.id,
    name: 'Characters',
    kind: 'characters',
  })
  const boards = {
    mara: await upload(
      x,
      film,
      png('mara-board.png', TINT.film, [480, 640], {
        collectionId: characters.id,
      }),
    ),
    ferryman: await upload(
      x,
      film,
      png('ferryman-board.png', TINT.film, [480, 640], {
        collectionId: characters.id,
      }),
    ),
  }
  const still = await upload(x, film, png('shot-1-2-pane.png', TINT.film))

  const brief = await upload(
    x,
    client,
    pdf('kinkaew-brief.pdf', 'Kinkaew Creative - brief', [
      'Warm palette; no blue.',
      'Logo must read on the shop sign at 10 m.',
      'First round due Friday.',
    ]),
  )
  const moodboard = await upload(
    x,
    client,
    png('kinkaew-moodboard.png', TINT.client),
  )
  // Files of client jobs and their follow-ups.
  const wireframe = await upload(
    x,
    client,
    png('kinkaew-landing-wireframe.png', TINT.client, [400, 640]),
  )
  const slides = await upload(
    x,
    client,
    png('orbit-extra-slides-draft.png', TINT.client, [640, 360]),
  )
  const richMenu = await upload(
    x,
    client,
    png('baan-rich-menu-round-2.png', TINT.client, [625, 422]),
  )
  const stickers = await upload(
    x,
    client,
    pdf('baan-stickers-sheet.pdf', 'Baan Khun Ya - LINE stickers', [
      '8 stickers, 370 x 320 px, transparent PNG.',
      'Characters: grandma, the cat, the khanom tray.',
    ]),
  )
  // An upload that never finished: the row waits, pending.
  const pending = (
    await prepareUpload(x.owner, {
      projectId: client.id,
      name: 'kinkaew-logo-final.png',
      mime: 'image/png',
      bytes: 482_113,
    })
  ).asset

  await upload(x, home, png('desk-by-the-window.png', TINT.home))
  await upload(
    x,
    home,
    pdf('balcony-light-receipt.pdf', 'Receipt - balcony light', [
      'LED wall light, warm white: 690.00 THB',
    ]),
  )
  return {
    thumbs,
    teaser,
    prints,
    boards,
    still,
    brief,
    moodboard,
    wireframe,
    slides,
    richMenu,
    stickers,
    pending,
  }
}

/* ── Clients ─────────────────────────────────────────────────────────── */

type Clients = {
  kinkaew: ClientRow
  orbit: ClientRow
  baan: ClientRow
  lumenplaza: ClientRow
  northwind: ClientRow
}

/**
 * The owner's clients, HQ-wide — made before the boards so
 * cards point at them. A client with one small job stays a name used once on
 * its card (the wedding card, Kite Mobile, Typewell), which Clients lists under "Used
 * once".
 */
async function seedClients(x: Ctx): Promise<Clients> {
  const kinkaew = await createClient(x.owner, {
    name: 'บริษัท กิ่งแก้ว ครีเอทีฟ จำกัด',
    taxId: '0105561234567',
    address: '88 ซอยดาวเหนือ 4 แขวงลมหนาว เขตทุ่งหมอก กรุงเทพฯ 10999',
    email: 'hello@kinkaew.local',
  })
  const orbit = await createClient(x.owner, {
    name: 'Orbit Co., Ltd.',
    taxId: '0105559876543',
    address: 'Bangkok',
  })
  const baan = await createClient(x.owner, {
    name: 'ร้านขนมบ้านคุณย่า',
    phone: '080 000 0000',
  })
  const lumenplaza = await createClient(x.owner, {
    name: 'Lumen Plaza',
    taxId: '0105562468021',
    address: '123 ถนนแสงจันทร์ แขวงทางช้างเผือก เขตทุ่งหมอก กรุงเทพฯ 10999',
    email: 'marketing@lumenplaza.local',
    phone: '02 000 0011',
  })
  // Billed in USD: Clients names the dollars beside the baht, never converted.
  const northwind = await createClient(x.owner, {
    name: 'Northwind Studio (Tokyo)',
    email: 'producer@northwind.local',
    address: 'Tokyo',
  })
  // Put away: hidden from the pickers, listed under Archived, never deleted.
  const nine = await createClient(x.owner, {
    name: 'Studio Nine',
    email: 'hi@studionine.local',
  })
  await setClientArchived(x.owner, {
    clientId: nine.id,
    expectedRevision: nine.revision,
    archived: true,
  })
  return { kinkaew, orbit, baan, lumenplaza, northwind }
}

/* ── Board ───────────────────────────────────────────────────────────── */

type Cards = {
  kinkaewLogo: { id: string; title: string; price: string | null }
  orbitDeck: { id: string; extraSlides: string }
  landing: { id: string; contactForm: string }
  richMenu: { id: string; round2: string; stickers: string }
}

async function lanesOf(x: Ctx, project: ProjectRow) {
  const view = await openBoard(x.owner, project.id)
  if (!view) throw new Error(`${project.name} has no board.`)
  return (name: string): string => {
    const lane = view.lanes.find((entry) => entry.name === name)
    if (!lane) throw new Error(`${project.name} has no lane “${name}”.`)
    return lane.id
  }
}

async function seedBoards(x: Ctx, clients: Clients): Promise<Cards> {
  const { today, weekStart, nextWeek } = x.clock
  const weekEnd = plusDays(weekStart, 6)
  const due = {
    today,
    overdue: plusDays(today, -2),
    late: plusDays(today, -5),
    // Later this week when there is a later day; on a Sunday, Thursday.
    week:
      plusDays(today, 1) <= weekEnd
        ? plusDays(today, 1)
        : plusDays(weekStart, 3),
    next: (n: number) => plusDays(nextWeek, n),
  }
  const card = (
    project: ProjectRow,
    laneId: string,
    input: {
      title: string
      body?: string
      price?: string
      /** The project's (THB here) when left out. */
      currency?: string
      labels?: string[]
      /** A name used once, on this card only. */
      client?: string
      /** A record in Clients. */
      clientId?: string
      color?: ProjectColor
      dueOn?: string
    },
  ) => createCard(x.owner, { projectId: project.id, laneId, ...input })

  const { channel, shop, film, client, home } = x.p
  let lane = await lanesOf(x, channel)
  await card(channel, lane('Idea'), {
    title: 'Lamp tour · 30s',
    labels: ['short'],
    dueOn: due.next(2),
  })
  await card(channel, lane('Idea'), {
    title: 'Sponsored: Typewell keyboard review',
    price: '8,000',
    client: 'Typewell',
    color: 'gold',
    labels: ['sponsor'],
    dueOn: due.next(4),
  })
  // A client with work in two projects: Clients counts both, and "Card for
  // this client" asks which board.
  await card(channel, lane('Prompted'), {
    title: 'Sponsored: Lumen Plaza mall walk vlog',
    price: '25,000',
    clientId: clients.lumenplaza.id,
    color: 'teal',
    labels: ['sponsor'],
    dueOn: due.next(1),
  })
  await card(channel, lane('Prompted'), {
    title: 'Monitor arm under ฿1,000 · part 2',
    labels: ['short'],
    dueOn: due.today,
  })
  await card(channel, lane('Generated'), {
    title: 'Cable tray hook · recut',
    dueOn: due.week,
  })
  await card(channel, lane('Posted'), { title: 'Wrist rest verdict' })
  await card(channel, lane('Reviewed'), { title: 'September recap' })

  lane = await lanesOf(x, shop)
  await card(shop, lane('Idea'), {
    title: 'Lantern night poster',
    price: '5.50',
    dueOn: due.next(3),
  })
  await card(shop, lane('Prompted'), {
    title: 'Bundle of 3 · cover art',
    dueOn: due.overdue,
  })
  await card(shop, lane('Rendered'), {
    title: 'Fog river print bundle',
    price: '11.90',
    dueOn: due.today,
  })
  await card(shop, lane('Listed'), {
    title: 'Wabi-sabi wall art set',
    price: '12.00',
  })

  lane = await lanesOf(x, film)
  await card(film, lane('Script'), {
    title: 'Lock scene 2 dialogue',
    dueOn: due.late,
  })
  await card(film, lane('Boarded'), {
    title: 'Board shots 2.1–2.3',
    dueOn: due.today,
  })
  await card(film, lane('Generated'), {
    title: 'Pick stills for 1.1–1.3',
    dueOn: due.week,
  })
  await card(film, lane('Edited'), {
    title: 'Rough cut v1',
    dueOn: due.next(4),
  })

  // Client work: clients are records, a few cards carry a colour,
  // follow-ups add into a card's total, and money comes in along the way —
  // a deposit (or none), a part payment, the rest at Mark paid. The awaiting
  // lane, Home and State read what is still owed.
  lane = await lanesOf(x, client)
  const { kinkaew, orbit, baan } = clients
  // No deposit: this client pays when the illustrations are delivered.
  await card(client, lane('Backlog'), {
    title: 'Menu illustrations · ร้านขนมบ้านคุณย่า',
    price: '12,000',
    clientId: baan.id,
    dueOn: due.next(1),
  })
  // A one-off job: the client is a name used once, not a Clients record.
  await card(client, lane('Backlog'), {
    title: 'การ์ดแต่งงาน · คุณแพร & คุณต้น',
    body: 'การ์ดเชิญ 120 ใบ + ไฟล์สำหรับส่งทาง LINE — โทนเขียวเซจกับทอง',
    price: '4,500',
    client: 'คุณแพร (งานแต่ง)',
    labels: ['print'],
    dueOn: due.next(3),
  })
  const logo = await card(client, lane('Quoted'), {
    title: 'Kinkaew rebrand · logo system',
    price: '36,000',
    clientId: kinkaew.id,
    color: 'violet',
    labels: ['brand'],
    dueOn: due.next(0),
  })
  // Doing, on a 30 % deposit — first typed wrong, voided, typed again.
  const landing = await card(client, lane('Doing'), {
    title: 'Kinkaew · landing page',
    price: '18,000',
    clientId: kinkaew.id,
    color: 'violet',
    labels: ['web'],
    dueOn: due.week,
  })
  const typo = await recordPayment(x.owner, {
    cardId: landing.id,
    expectedRevision: landing.revision,
    kind: 'deposit',
    amount: '4,500',
    receivedOn: plusDays(today, -9),
    note: 'มัดจำ 30%',
  })
  const struck = await voidPayment(x.owner, {
    cardId: landing.id,
    expectedRevision: typo.card.revision,
    paymentId: typo.payment.id,
    reason: 'พิมพ์ยอดผิด — โอนมา 5,400',
  })
  const deposit = await recordPayment(x.owner, {
    cardId: landing.id,
    expectedRevision: struck.card.revision,
    kind: 'deposit',
    amount: '5,400',
    receivedOn: plusDays(today, -9),
    note: 'มัดจำ 30% · โอนเข้าบัญชีธนาคาร',
  })
  // Asked for mid-build: its due falls before the card's, so the job's due
  // is the follow-up's.
  const contactForm = await addFollowup(x.owner, {
    cardId: landing.id,
    expectedRevision: deposit.card.revision,
    title: 'Contact form + ปุ่ม LINE',
    body: 'ฟอร์มติดต่อส่งเข้าอีเมล + ปุ่ม Add friend LINE OA มุมขวาล่าง',
    price: '3,500',
    dueOn: due.today,
  })
  // In review, half paid up front. After the review the client asked for
  // eight more slides (the sent "extra slides" quote) — a priced follow-up,
  // due in three days — and left a note that costs nothing.
  const deck = await card(client, lane('Review'), {
    title: 'Orbit deck v2',
    price: '24,000',
    clientId: orbit.id,
    color: 'blue',
    labels: ['deck'],
    dueOn: due.overdue,
  })
  const half = await recordPayment(x.owner, {
    cardId: deck.id,
    expectedRevision: deck.revision,
    kind: 'deposit',
    amount: '12,000',
    receivedOn: plusDays(today, -12),
    note: 'มัดจำ 50% ตามใบเสนอราคา',
  })
  const extraSlides = await addFollowup(x.owner, {
    cardId: deck.id,
    expectedRevision: half.card.revision,
    title: 'Extra slides · 8 more',
    body: 'ขอเพิ่มหลังรีวิวรอบแรก: market size, roadmap, team, the ask — ใช้แม่แบบเดิม (ใบเสนอราคา “Orbit deck v2 · extra slides” ส่งแล้ว)',
    price: '6,000',
    dueOn: plusDays(today, 3),
  })
  await addFollowup(x.owner, {
    cardId: deck.id,
    expectedRevision: extraSlides.card.revision,
    title: 'ลูกค้าเลือก palette B',
    body: 'คุณพลอยทาง LINE พฤหัส 21:10 — เอา B แต่คงหน้าปกเดิมไว้ ไม่คิดเพิ่ม',
  })
  // Awaiting payment, partly paid: 20,000 of 45,000 came in, the rest
  // follows the client's month-end run; the master files went out since.
  const lumenplaza = await card(client, lane('Review'), {
    title: 'Lumen Plaza LED avatar · invoice 2/2',
    price: '45,000',
    clientId: clients.lumenplaza.id,
    color: 'teal',
    dueOn: due.late,
  })
  const invoiced = await moveCard(x.owner, {
    cardId: lumenplaza.id,
    expectedRevision: lumenplaza.revision,
    laneId: lane('Awaiting payment'),
  })
  const part = await recordPayment(x.owner, {
    cardId: invoiced.id,
    expectedRevision: invoiced.revision,
    kind: 'part',
    amount: '20,000',
    receivedOn: plusDays(today, -2),
    note: 'โอนก่อนบางส่วน — ที่เหลือรอบจ่ายสิ้นเดือน',
  })
  await addFollowup(x.owner, {
    cardId: invoiced.id,
    expectedRevision: part.card.revision,
    title: 'ส่งไฟล์ master 4K + LED loop แล้ว',
    body: 'ส่งทาง Google Drive วันอังคาร — ไม่มีค่าใช้จ่ายเพิ่ม',
  })
  // Paid in full: Mark paid records what was owed as the final payment. A
  // cut-down asked for before the invoice rides along, frozen with the card.
  const kite = await card(client, lane('Doing'), {
    title: 'Kite Mobile case film · invoice 1/2',
    price: '30,000',
    client: 'Kite Mobile',
    dueOn: plusDays(today, -1),
  })
  const cutdown = await addFollowup(x.owner, {
    cardId: kite.id,
    expectedRevision: kite.revision,
    title: 'Cut-down 15s สำหรับ social',
    price: '5,000',
    dueOn: plusDays(today, -1),
  })
  const waiting = await moveCard(x.owner, {
    cardId: kite.id,
    expectedRevision: cutdown.card.revision,
    laneId: lane('Awaiting payment'),
  })
  await markPaid(x.owner, {
    cardId: waiting.id,
    expectedRevision: waiting.revision,
  })

  // The whole ledger, then paid: a 30 % deposit, a part payment when the
  // first posts went up, and Mark paid for the rest.
  const social = await card(client, lane('Doing'), {
    title: 'Kinkaew · social media kit',
    price: '15,000',
    clientId: kinkaew.id,
    color: 'violet',
    labels: ['social'],
    dueOn: plusDays(today, -4),
  })
  const socialDeposit = await recordPayment(x.owner, {
    cardId: social.id,
    expectedRevision: social.revision,
    kind: 'deposit',
    amount: '4,500',
    receivedOn: plusDays(today, -20),
    note: 'มัดจำ 30%',
  })
  const socialPart = await recordPayment(x.owner, {
    cardId: social.id,
    expectedRevision: socialDeposit.card.revision,
    kind: 'part',
    amount: '6,000',
    receivedOn: plusDays(today, -8),
    note: 'หลังส่งชุดโพสต์แรก',
  })
  const socialDue = await moveCard(x.owner, {
    cardId: social.id,
    expectedRevision: socialPart.card.revision,
    laneId: lane('Awaiting payment'),
  })
  await markPaid(x.owner, {
    cardId: socialDue.id,
    expectedRevision: socialDue.revision,
  })

  // The job that keeps going (the owner's case): no deposit, the card's own
  // due long passed, a revision round and a sticker set as follow-ups, one
  // add-on dropped, and the client paying in parts along the way. The job's
  // due is the stickers' — still ahead — so it isn't late.
  const richMenu = await card(client, lane('Doing'), {
    title: 'ร้านขนมบ้านคุณย่า · LINE OA rich menu',
    body: 'Rich menu 6 ช่อง + ภาพปก LINE OA — ลูกค้าจ่ายเป็นรอบตามงานที่ส่ง ไม่มีมัดจำ',
    price: '6,000',
    clientId: baan.id,
    color: 'orange',
    labels: ['line'],
    dueOn: plusDays(today, -10),
  })
  const round2 = await addFollowup(x.owner, {
    cardId: richMenu.id,
    expectedRevision: richMenu.revision,
    title: 'Round 2 · ปรับสีตามหน้าร้าน',
    body: 'เปลี่ยนจากครีมเป็นเขียวใบเตยให้ตรงกับป้ายหน้าร้าน + เพิ่มปุ่มสั่งล่วงหน้า',
    price: '1,500',
    dueOn: plusDays(today, -6),
  })
  const firstPart = await recordPayment(x.owner, {
    cardId: richMenu.id,
    expectedRevision: round2.card.revision,
    kind: 'part',
    amount: '3,000',
    receivedOn: plusDays(today, -7),
    note: 'จ่ายรอบแรกหลังส่ง rich menu v1',
  })
  const stickerSet = await addFollowup(x.owner, {
    cardId: richMenu.id,
    expectedRevision: firstPart.card.revision,
    title: 'สติกเกอร์ LINE 8 ตัว',
    body: 'คุณย่า · แมว · ถาดขนม — ขนาด 370×320 ส่งเป็น PNG โปร่งใส',
    price: '4,800',
    dueOn: plusDays(today, 5),
  })
  const sign = await addFollowup(x.owner, {
    cardId: richMenu.id,
    expectedRevision: stickerSet.card.revision,
    title: 'ป้ายหน้าร้าน A1',
    price: '2,000',
    dueOn: plusDays(today, 8),
  })
  // Dropped: the shop's nephew prints the sign. Removed, out of the total,
  // still in the card's history.
  const dropped = await setFollowupArchived(x.owner, {
    cardId: richMenu.id,
    expectedRevision: sign.card.revision,
    followupId: sign.followup.id,
    archived: true,
  })
  await recordPayment(x.owner, {
    cardId: richMenu.id,
    expectedRevision: dropped.card.revision,
    kind: 'part',
    amount: '2,500',
    receivedOn: plusDays(today, -1),
    note: 'จ่ายเพิ่มหลังส่ง round 2',
  })

  // Billed in USD: the lane sums it apart from the baht, never converted.
  const motion = await card(client, lane('Doing'), {
    title: 'Northwind · motion pack',
    price: '1,200',
    currency: 'USD',
    clientId: clients.northwind.id,
    color: 'sky',
    labels: ['motion'],
    dueOn: due.next(2),
  })
  await recordPayment(x.owner, {
    cardId: motion.id,
    expectedRevision: motion.revision,
    kind: 'deposit',
    amount: '360',
    receivedOn: plusDays(today, -4),
    note: '30% via Wise',
  })

  lane = await lanesOf(x, home)
  await card(home, lane('Backlog'), {
    title: 'Renew passport',
    dueOn: due.next(2),
  })
  await card(home, lane('Backlog'), {
    title: 'Book the dentist follow-up',
    dueOn: due.today,
  })
  await card(home, lane('Backlog'), {
    title: 'ยื่นภาษี ภ.ง.ด.90 (late filing)',
    dueOn: due.late,
  })
  await card(home, lane('Doing'), {
    title: 'Move the desk to the window',
    dueOn: due.week,
  })
  await card(home, lane('Done'), { title: 'Fix the balcony light' })

  return {
    kinkaewLogo: { id: logo.id, title: logo.title, price: logo.price },
    orbitDeck: { id: deck.id, extraSlides: extraSlides.followup.id },
    landing: { id: landing.id, contactForm: contactForm.followup.id },
    richMenu: {
      id: richMenu.id,
      round2: round2.followup.id,
      stickers: stickerSet.followup.id,
    },
  }
}

/**
 * What the client jobs ran on and their files, through the
 * Board's own link services — one `made_with` per card or follow-up, files
 * `attached`, each audited. Client work has no Prompts module, so its prompts
 * live in the library.
 */
async function seedCardLinks(
  x: Ctx,
  cards: Cards,
  files: Files,
): Promise<void> {
  // A prompt has one text; another take on it is a prompt of its own.
  const headline = await savePrompt(x.owner, {
    title: 'Deck headline, punchier',
    medium: 'text',
    tags: ['deck', 'client'],
    text: 'Rewrite each slide headline so it lands in under nine words. Present tense, no jargon, keep the client’s product names exactly.',
  })
  const investor = await savePrompt(x.owner, {
    title: 'Deck headline, punchier · Investor',
    medium: 'text',
    tags: ['deck', 'client'],
    style: 'Investor',
    text: 'Investor cut: one claim per slide headline, with a number where there is one, under eight words.',
  })
  const tiles = await savePrompt(x.owner, {
    title: 'LINE rich menu tiles',
    medium: 'image',
    intent: 'A six-tile LINE OA rich menu that reads at thumb size.',
    tags: ['line', 'client'],
    text: 'Six flat tiles, 2500×1686, one icon and a two-word Thai label each; pandan green and cream, rounded Thai sans, no photos.',
  })
  const stickers = await savePrompt(x.owner, {
    title: 'LINE rich menu tiles · Stickers',
    medium: 'image',
    tags: ['line', 'client'],
    style: 'Stickers',
    text: 'LINE sticker, 370×320, transparent: a cheerful Thai grandma holding a tray of khanom chan, thick outline, flat colours.',
  })

  const prompts: Parameters<typeof setPrompt>[1][] = [
    // The prompt's text when none is named.
    { cardId: cards.orbitDeck.id, promptId: headline.id },
    {
      cardId: cards.orbitDeck.id,
      followupId: cards.orbitDeck.extraSlides,
      promptId: investor.id,
      variantId: investor.text?.id,
    },
    { cardId: cards.richMenu.id, promptId: tiles.id },
    {
      cardId: cards.richMenu.id,
      followupId: cards.richMenu.stickers,
      promptId: stickers.id,
      variantId: stickers.text?.id,
    },
  ]
  for (const input of prompts) await setPrompt(x.owner, input)

  const attached: Parameters<typeof attachFile>[1][] = [
    { cardId: cards.kinkaewLogo.id, assetId: files.brief.id },
    { cardId: cards.kinkaewLogo.id, assetId: files.moodboard.id },
    { cardId: cards.landing.id, assetId: files.wireframe.id },
    {
      cardId: cards.orbitDeck.id,
      followupId: cards.orbitDeck.extraSlides,
      assetId: files.slides.id,
    },
    {
      cardId: cards.richMenu.id,
      followupId: cards.richMenu.round2,
      assetId: files.richMenu.id,
    },
    {
      cardId: cards.richMenu.id,
      followupId: cards.richMenu.stickers,
      assetId: files.stickers.id,
    },
  ]
  for (const input of attached) await attachFile(x.owner, input)
}

/* ── Prompts ─────────────────────────────────────────────────────────── */

type Prompts = {
  deskHook: string
  fogStill: { a: string; b: string; prompt: string }
  lanternMotion: { a: string; prompt: string }
}

/** The text of a seeded prompt — what shots and card links point at. */
const textOf = (prompt: { title: string; text: { id: string } | null }) => {
  if (!prompt.text) throw new Error(`${prompt.title} has no text.`)
  return prompt.text.id
}

/**
 * Prompts are templates: `<HAIR_COLOR>` is a variant, filled from options —
 * the library's (HAIR_COLOR, ASPECT, shared by every prompt that writes
 * them) and a prompt's own (SHIRT_COLOR, LIGHT, the STYLE block). Examples
 * keep the options they were made with; one prompt still has none picked.
 */
async function seedPrompts(x: Ctx, files: Files): Promise<Prompts> {
  const { channel, shop, film } = x.p
  await saveLibrarySlot(x.owner, {
    name: 'HAIR_COLOR',
    note: 'A character’s hair, for every character sheet.',
    options: [
      { key: 'red', value: 'red short' },
      { key: 'blue', value: 'blue long' },
      { key: 'punk', value: 'black punk style with red highlight' },
    ],
  })
  await saveLibrarySlot(x.owner, {
    name: 'ASPECT',
    note: 'Where it will be seen.',
    options: [
      { key: 'vertical', value: '9:16' },
      { key: 'square', value: '1:1' },
      { key: 'wide', value: '16:9' },
    ],
  })

  const deskHook = await savePrompt(x.owner, {
    projectId: channel.id,
    title: 'Desk tour hook',
    medium: 'video',
    intent: 'The first three seconds of a desk short.',
    collection: 'Hooks',
    tags: ['hook', 'short'],
    text: 'A slow push-in on the desk lamp at dusk, warm key light, <ASPECT>.',
  })
  await addExample(x.owner, {
    promptId: deskHook.id,
    assetId: files.teaser.id,
    caption: 'Placeholder teaser cut.',
    picks: { ASPECT: 'vertical' },
  })
  await savePrompt(x.owner, {
    projectId: channel.id,
    title: 'Desk tour hook · Top-down',
    medium: 'video',
    collection: 'Hooks',
    tags: ['hook', 'short'],
    style: 'Top-down',
    text: 'Top-down reveal of the desk, cables tidied in one move, <ASPECT>.',
  })

  const thumb = await savePrompt(x.owner, {
    projectId: channel.id,
    title: 'Thumbnail · wrist rest',
    medium: 'image',
    collection: 'Thumbnails',
    tags: ['thumbnail'],
    text: 'Close-up of a gel wrist rest on a walnut desk, <LIGHT>, bold negative space for a title.',
    slots: [
      {
        name: 'LIGHT',
        options: [
          { key: 'window', value: 'soft window light' },
          { key: 'neon', value: 'pink and blue neon rim light' },
        ],
      },
    ],
  })
  // One example made by the generator (its cost lands in ops usage), one uploaded.
  await generateExample(x.owner, {
    promptId: thumb.id,
    connectionId: x.generatorId,
    picks: { LIGHT: 'window' },
  })
  const flatLay = await savePrompt(x.owner, {
    projectId: channel.id,
    title: 'Thumbnail · wrist rest · Flat lay',
    medium: 'image',
    collection: 'Thumbnails',
    tags: ['thumbnail'],
    style: 'Flat lay',
    text: 'Flat lay: keyboard, wrist rest, coffee, top-down, pastel background.',
  })
  await addExample(x.owner, {
    promptId: flatLay.id,
    assetId: files.thumbs[0]?.id as string,
    rating: 4,
    caption: 'What went out on the wrist rest short.',
  })

  // A block variant: a whole paragraph swaps between the header and the end.
  const chladni = await savePrompt(x.owner, {
    projectId: shop.id,
    title: 'Chladni print',
    medium: 'image',
    collection: 'Prints',
    tags: ['print', 'physics'],
    text: 'Chladni figure, museum print, 2:3.\n<STYLE>\nNo text, no frame.',
    slots: [
      {
        name: 'STYLE',
        note: 'The plate and the light, as a block.',
        options: [
          {
            key: 'noir',
            value:
              'Sand on a black plate, hard rim light.\nDeep shadow, high contrast.',
          },
          {
            key: 'paper',
            value: 'White sand lines on cream paper.\nSoft daylight, minimal.',
          },
        ],
      },
    ],
  })
  await addExample(x.owner, {
    promptId: chladni.id,
    assetId: files.prints.chladni?.preview.id as string,
    rating: 5,
    picks: { STYLE: 'noir' },
  })

  const fog = await savePrompt(x.owner, {
    projectId: film.id,
    title: 'Fog river still',
    medium: 'image',
    collection: 'Stills',
    tags: ['still'],
    text: 'A raft on a river swallowed by fog, lantern glow, 35mm, blue-grey.',
  })
  await addExample(x.owner, { promptId: fog.id, assetId: files.still.id })
  const fogNight = await savePrompt(x.owner, {
    projectId: film.id,
    title: 'Fog river still · Night',
    medium: 'image',
    collection: 'Stills',
    tags: ['still'],
    style: 'Night',
    text: 'Night river, a single lantern, heavy fog, anamorphic flare.',
  })
  const character = await savePrompt(x.owner, {
    projectId: film.id,
    title: 'Character sheet',
    medium: 'image',
    intent: 'One look for a character, front and three-quarter.',
    collection: 'Characters',
    tags: ['character'],
    text: 'Generate a character with <HAIR_COLOR> hair, and <SHIRT_COLOR> shirt.',
    slots: [
      // HAIR_COLOR is the library's; this prompt adds one of its own.
      {
        name: 'HAIR_COLOR',
        options: [{ key: 'grey', value: 'silver-grey, tied back' }],
      },
      {
        name: 'SHIRT_COLOR',
        options: [
          { key: 'white', value: 'a plain white' },
          { key: 'denim', value: 'a faded denim' },
          { key: 'stripe', value: 'a navy breton-stripe' },
        ],
      },
    ],
  })
  await addExample(x.owner, {
    promptId: character.id,
    assetId: files.boards.ferryman.id,
    caption: 'The ferryman, first pass.',
    rating: 3,
    picks: { HAIR_COLOR: 'grey', SHIRT_COLOR: 'denim' },
  })
  const motion = await savePrompt(x.owner, {
    projectId: film.id,
    title: 'Lantern motion',
    medium: 'video',
    collection: 'Motion',
    text: 'The lantern swings slowly over black water, fog drifting left, 4 s.',
  })
  await addExample(x.owner, {
    promptId: motion.id,
    assetId: files.boards.ferryman.id,
    caption: 'Board frame for the motion.',
  })
  await savePrompt(x.owner, {
    projectId: film.id,
    title: 'Lantern motion · Close',
    medium: 'video',
    collection: 'Motion',
    style: 'Close',
    text: 'Push-in on the ferryman’s face lit by the lantern, 3 s.',
  })

  // A floating prompt: no project.
  await savePrompt(x.owner, {
    title: 'Caption voice',
    medium: 'text',
    tags: ['caption'],
    text: 'Short, first person, one concrete number, no emoji.',
  })
  await savePrompt(x.owner, {
    title: 'Caption voice · Question',
    medium: 'text',
    tags: ['caption'],
    style: 'Question',
    text: 'Question first, the answer on the second line, end with a tip.',
  })

  return {
    deskHook: deskHook.id,
    fogStill: { prompt: fog.id, a: textOf(fog), b: textOf(fogNight) },
    lanternMotion: { prompt: motion.id, a: textOf(motion) },
  }
}

/* ── Calendar ────────────────────────────────────────────────────────── */

async function seedCalendar(x: Ctx): Promise<void> {
  const { weekStart, nextWeek, lastWeek, today } = x.clock
  const { channel, film, client, home } = x.p
  const event = (
    project: ProjectRow | null,
    input: {
      title: string
      startsAt: string
      endsAt?: string
      location?: string
      description?: string
    },
  ) =>
    createEvent(x.owner, {
      projectId: project?.id ?? null,
      sync: false,
      ...input,
    })
  // Last week.
  await event(client, {
    title: 'Studio visit · Lumen Plaza',
    startsAt: `${plusDays(lastWeek, 3)}T13:00`,
    endsAt: `${plusDays(lastWeek, 3)}T15:00`,
    location: 'Lumen Plaza',
  })
  // This week.
  await event(client, {
    title: 'Kinkaew kickoff call',
    startsAt: `${weekStart}T10:00`,
    endsAt: `${weekStart}T11:00`,
    description: 'Walk through the brief; agree on the first-round date.',
  })
  await event(film, {
    title: 'Shoot day · ferry house',
    startsAt: plusDays(weekStart, 2),
    location: 'The old ferry pier',
  })
  await event(null, {
    title: 'Marketplace fee change',
    startsAt: plusDays(weekStart, 4),
    description: 'Listing fees move to $0.20 from today.',
  })
  await event(home, {
    title: 'Dentist',
    startsAt: `${today}T16:30`,
    endsAt: `${today}T17:15`,
    location: 'The dental clinic',
  })
  await event(channel, {
    title: 'Film the lamp tour',
    startsAt: `${today}T19:00`,
    endsAt: `${today}T20:30`,
  })
  // Next week.
  await event(client, {
    title: 'Orbit deck review',
    startsAt: `${nextWeek}T14:00`,
    endsAt: `${nextWeek}T15:00`,
    location: 'Google Meet',
  })
  await event(film, {
    title: 'Colour grade · Fog Line',
    startsAt: plusDays(nextWeek, 1),
    endsAt: plusDays(nextWeek, 3),
  })
  await event(home, {
    title: 'Renew passport',
    startsAt: `${plusDays(nextWeek, 2)}T09:30`,
    endsAt: `${plusDays(nextWeek, 2)}T11:00`,
    location: 'Passport office',
  })
  await event(channel, {
    title: 'Weekly channel review',
    startsAt: `${plusDays(nextWeek, 4)}T18:00`,
    endsAt: `${plusDays(nextWeek, 4)}T18:45`,
  })
  // Left to the default: with no Google connection it stays in HQ.
  await createEvent(x.owner, {
    title: 'Quarterly taxes check-in',
    startsAt: `${plusDays(nextWeek, 3)}T10:00`,
  })
}

/* ── Quotes ──────────────────────────────────────────────────────────── */

async function seedQuotes(
  x: Ctx,
  cards: Cards,
  clients: Clients,
): Promise<void> {
  const settings = await getOwnerSettings(x.owner)
  if (!settings.quoteIssuer?.name?.trim())
    await setQuoteIssuer(x.owner, {
      expectedRevision: settings.revision,
      name: 'Example Studio',
      taxId: '0105566012345',
      address: 'Bangkok',
      email: 'studio@example.com',
      bank: 'Example Bank · 000-0-00000-0',
    })
  const { client } = x.p
  const { kinkaew, orbit, baan } = clients

  // Sent, from the card on the board (card —quoted_by→ quote).
  const logo = await createDraft(x.owner, {
    projectId: client.id,
    fromCard: {
      id: cards.kinkaewLogo.id,
      title: cards.kinkaewLogo.title,
      price: cards.kinkaewLogo.price,
    },
    clientId: kinkaew.id,
    vat: true,
    wht: true,
    notes: 'มัดจำ 50% ก่อนเริ่มงาน',
    lines: [
      { description: 'ออกแบบระบบโลโก้', qty: 1, unitPrice: '30,000' },
      {
        description: 'Brand guidelines (PDF)',
        qty: 1,
        unit: 'set',
        unitPrice: '6,000',
      },
    ],
  })
  await sendQuote(x.owner, {
    quoteId: logo.id,
    expectedRevision: logo.revision,
  })
  // Sent, valid for three more days.
  const extra = await createDraft(x.owner, {
    projectId: client.id,
    title: 'Orbit deck v2 · extra slides',
    clientId: orbit.id,
    vat: true,
    validDays: 3,
    lines: [
      {
        description: 'Additional slides',
        qty: 8,
        unit: 'slide',
        unitPrice: 750,
      },
    ],
  })
  await sendQuote(x.owner, {
    quoteId: extra.id,
    expectedRevision: extra.revision,
  })
  // A draft still being written.
  await createDraft(x.owner, {
    projectId: client.id,
    title: 'Menu illustrations',
    clientId: baan.id,
    lines: [
      { description: 'ภาพประกอบเมนู', qty: 12, unit: 'ภาพ', unitPrice: 1000 },
    ],
  })
}

/* ── Publish ─────────────────────────────────────────────────────────── */

type Posts = {
  out: { id: string; question: boolean }[]
  waiting: { id: string; title: string; revision: number; at: string }
}

async function seedPublish(x: Ctx, files: Files): Promise<Posts> {
  const { channel } = x.p
  const account = await saveAccount(x.owner, {
    projectId: channel.id,
    platform: 'manual',
    handle: '@deskandlight',
    profileUrl: 'https://deskandlight.example/@deskandlight',
    notes: 'Shorts posted by hand; HQ keeps the record.',
  })
  // Policy revision 2: the agent may now record posts on this account.
  await agentPolicy(
    x,
    channel,
    1,
    ['draft', 'propose', 'import', 'publish'],
    [account.id],
  )
  const OUT = [
    {
      title: 'Wrist rest verdict',
      caption: 'Gel or foam? Two weeks on each. #desk',
      hours: 12 * 24 + 3,
      thumb: 0,
      question: true,
      views: [820, 2140, 3050],
      likes: 212,
      earnings: '185.40',
    },
    {
      title: 'Monitor arm under ฿1,000',
      caption: 'Three clamps, one winner.',
      hours: 9 * 24 + 5,
      thumb: 1,
      question: false,
      views: [1310, 3900, 5420],
      likes: 388,
      earnings: '312.75',
    },
    {
      title: 'Cable tray hook',
      caption: 'Why is nobody talking about under-desk trays?',
      hours: 5 * 24 + 2,
      thumb: 2,
      question: true,
      views: [640, 1720],
      likes: 97,
    },
    {
      title: 'Desk lamp at dusk',
      caption: 'One lamp, three moods.',
      hours: 2 * 24 + 1,
      thumb: 3,
      question: false,
      views: [450],
    },
    {
      title: 'Lamp tour teaser',
      caption: 'Which mood is yours? Full tour this week.',
      hours: 10,
      question: true,
      views: [],
    },
  ]
  const AGES = [24, 72, 168]
  const out: Posts['out'] = []
  for (const [i, spec] of OUT.entries()) {
    const planned = await planPost(x.owner, {
      projectId: channel.id,
      accountId: account.id,
      assetId:
        spec.thumb === undefined ? undefined : files.thumbs[spec.thumb]?.id,
      title: spec.title,
      caption: spec.caption,
    })
    const postedAt = ago(x, spec.hours * HOUR)
    const post = await recordManualPost(x.owner, {
      postId: planned.id,
      url: `https://deskandlight.example/shorts/${i + 1}`,
      postedAt,
      evidenceLevel: 'owner_attested',
    })
    out.push({ id: post.id, question: spec.question })
    for (const [n, value] of spec.views.entries()) {
      const asOf = new Date(postedAt.getTime() + (AGES[n] as number) * HOUR)
      // The newest post's first read came in through the agent.
      const byAgent = i === 3
      await recordReading(byAgent ? x.agent : x.owner, {
        postId: post.id,
        metric: 'views',
        value,
        asOf,
        source: byAgent ? 'agent' : 'manual',
      })
    }
    if (spec.likes)
      await recordReading(x.owner, {
        postId: post.id,
        metric: 'likes',
        value: spec.likes,
        asOf: ago(x, 2 * HOUR),
      })
    if (spec.earnings)
      await recordReading(x.owner, {
        postId: post.id,
        metric: 'earnings',
        value: spec.earnings,
        currency: 'THB',
        windowStart: new Date(postedAt.getTime() + DAY),
        windowEnd: new Date(postedAt.getTime() + 8 * DAY),
        note: 'From the creator fund statement.',
      })
  }

  const { today, nextWeek } = x.clock
  // Cleared by the owner: scheduled, one of them for today.
  for (const [title, day, time, thumb] of [
    ['Lamp tour · full', today, '21:00', 3],
    ['Cable tray · recut', plusDays(today, 1), '19:00', 2],
  ] as const) {
    const planned = await planPost(x.owner, {
      projectId: channel.id,
      accountId: account.id,
      assetId: files.thumbs[thumb]?.id,
      title,
      caption: `${title} — link in bio.`,
      scheduledFor: `${day}T${time}`,
    })
    const cleared = await authorizePost(x.owner, { postId: planned.id })
    if (cleared.blockers.length > 0)
      throw new Error(
        `“${title}” couldn't be cleared: ${cleared.blockers.map((b) => b.message).join(' ')}`,
      )
  }
  // Planned by the agent for next week — it waits for the owner to clear it.
  const slot = plusDays(nextWeek, 1)
  const waiting = await planPost(x.agent, {
    projectId: channel.id,
    accountId: account.id,
    assetId: files.teaser.id,
    title: 'Typewell keyboard · first look',
    caption: 'Sponsored. Two weeks with the Typewell 75. #ad',
    disclosure: { affiliate: true, text: 'Sponsored by Typewell.' },
    scheduledFor: `${slot}T19:00`,
  })
  // And a draft with no time yet.
  await planPost(x.owner, {
    projectId: channel.id,
    accountId: account.id,
    caption: 'Draft: the cheapest upgrade for a small desk.',
  })
  return {
    out,
    waiting: {
      id: waiting.id,
      title: waiting.title ?? 'Typewell keyboard · first look',
      revision: waiting.revision,
      at: `${slot} 19:00`,
    },
  }
}

/* ── Market ──────────────────────────────────────────────────────────── */

type Market = {
  bundle: string[]
  singles: string[]
  approved: string
}

async function seedMarket(x: Ctx, files: Files): Promise<Market> {
  const { shop } = x.p
  const store = await saveMarketplace(x.owner, {
    projectId: shop.id,
    kind: 'manual',
    shop: 'Paper Fog (own store)',
    url: 'https://paperfog.example',
    currency: 'USD',
    feeSheet: {
      listingFee: '0.20',
      transactionPct: '6.5',
      processingPct: '3',
      processingFixed: '0.25',
    },
  })
  // Policy revision 2: the agent may now list on this shop.
  await agentPolicy(
    x,
    shop,
    1,
    ['draft', 'propose', 'import', 'list'],
    [store.id],
  )
  const PRODUCTS = [
    {
      key: 'wabi',
      title: 'Wabi-sabi wall art set',
      description: 'Six printable posters in warm earth tones, 2:3, 300 dpi.',
      price: '12.00',
      tags: ['wall art', 'printable', 'wabi sabi'],
      listedDaysAgo: 16,
    },
    {
      key: 'chladni',
      title: 'Chladni pattern print',
      description: 'Sand on a vibrating plate, drawn as a print. 2:3, 300 dpi.',
      price: '4.90',
      tags: ['physics', 'poster', 'printable'],
      listedDaysAgo: 14,
    },
    {
      key: 'attractor',
      title: 'Strange attractor poster',
      description: 'A Lorenz attractor in one continuous line. 2:3, 300 dpi.',
      price: '5.90',
      tags: ['math', 'poster'],
      listedDaysAgo: 4,
    },
    {
      key: 'fog',
      title: 'Fog river print bundle',
      description: 'Three stills from Fog Line as prints.',
      price: '11.90',
      tags: ['bundle', 'film', 'printable'],
    },
    {
      key: 'lantern',
      title: 'Lantern night poster',
      description: 'The lantern from Fog Line, alone on black water.',
      price: '5.50',
      tags: ['film', 'poster'],
    },
  ]
  const listings: Record<string, string> = {}
  let approved = ''
  for (const spec of PRODUCTS) {
    const files2 = files.prints[spec.key]
    if (!files2) throw new Error(`No files for ${spec.key}.`)
    // The last one is the agent's draft; the owner made the rest.
    const drafter = spec.key === 'lantern' ? x.agent : x.owner
    const product = await saveProduct(drafter, {
      projectId: shop.id,
      title: spec.title,
      description: spec.description,
      price: spec.price,
      currency: 'USD',
      tags: spec.tags,
    })
    await setProductFiles(drafter, {
      productId: product.id,
      expectedRevision: product.revision,
      files: [
        { assetId: files2.file.id, role: 'deliverable' },
        { assetId: files2.preview.id, role: 'preview' },
      ],
    })
    const listing = await planListing(drafter, {
      productId: product.id,
      marketplaceId: store.id,
    })
    listings[spec.key] = listing.id
    if (spec.listedDaysAgo !== undefined) {
      const listedAt = ago(x, spec.listedDaysAgo * DAY)
      await recordManualListing(x.owner, {
        listingId: listing.id,
        url: `https://paperfog.example/p/${spec.key}`,
        listedAt,
        evidenceLevel: 'owner_attested',
      })
      await recordSale(x.owner, {
        marketplaceId: store.id,
        listingId: listing.id,
        kind: 'fee',
        amount: '0.20',
        occurredAt: new Date(listedAt.getTime() + MINUTE),
        note: 'Listing fee',
      })
    } else if (spec.key === 'fog') {
      const outcome = await approveListing(x.owner, { listingId: listing.id })
      if (outcome.blockers.length > 0)
        throw new Error(
          `The bundle couldn't be approved: ${outcome.blockers.map((b) => b.message).join(' ')}`,
        )
      approved = listing.id
    }
  }

  const sale = (
    key: string,
    when: Date,
    amount: string,
    extra: { quantity?: number; orderRef?: string } = {},
  ) => {
    const gross = Number(amount) * (extra.quantity ?? 1)
    return recordSale(x.owner, {
      marketplaceId: store.id,
      listingId: listings[key],
      kind: 'sale',
      amount: gross.toFixed(2),
      fees: (gross * 0.065 + 0.25).toFixed(2),
      quantity: extra.quantity ?? 1,
      occurredAt: when,
      orderRef: extra.orderRef,
    })
  }
  const { lastWeek, nextWeek } = x.clock
  // Last week.
  await sale('wabi', at(plusDays(lastWeek, 1), '15:10'), '12.00', {
    orderRef: 'PF-1041',
  })
  await sale('chladni', at(plusDays(lastWeek, 3), '11:20'), '4.90', {
    orderRef: 'PF-1042',
  })
  await sale('wabi', at(plusDays(lastWeek, 5), '20:05'), '12.00', {
    orderRef: 'PF-1043',
  })
  // This week.
  const [a, b, c, d] = thisWeek(x, 4)
  await sale('attractor', a as Date, '5.90', { orderRef: 'PF-1044' })
  if (b) await sale('chladni', b, '4.90', { quantity: 2, orderRef: 'PF-1045' })
  if (c) await sale('wabi', c, '12.00', { orderRef: 'PF-1046' })
  await recordSale(x.owner, {
    marketplaceId: store.id,
    listingId: listings.wabi,
    kind: 'refund',
    amount: '12.00',
    occurredAt: d ?? (a as Date),
    orderRef: 'PF-1043',
    note: 'Printed the wrong size; refunded.',
  })
  // Payouts: last week's confirmed, next one expected.
  const paid = await recordPayout(x.owner, {
    marketplaceId: store.id,
    amount: '38.60',
    expectedOn: plusDays(lastWeek, 4),
    reference: 'PO-0918',
  })
  await confirmPayout(x.owner, {
    payoutId: paid.id,
    expectedRevision: paid.revision,
    paidOn: plusDays(lastWeek, 5),
    amount: '38.60',
  })
  await recordPayout(x.owner, {
    marketplaceId: store.id,
    amount: '46.10',
    expectedOn: plusDays(nextWeek, 2),
    reference: 'PO-0925',
  })
  return {
    bundle: [listings.wabi as string],
    singles: [listings.chladni as string, listings.attractor as string],
    approved,
  }
}

/* ── Experiments ─────────────────────────────────────────────────────── */

async function seedExperiments(
  x: Ctx,
  posts: Posts,
  market: Market,
): Promise<void> {
  const { channel, shop } = x.p
  // Running: posts are still coming in.
  const hooks = await createExperiment(x.owner, {
    projectId: channel.id,
    question: 'Does a question hook beat a statement hook?',
    hypothesis:
      'A question in the first second invites a reply, and replies lift reach.',
    subjectType: 'post',
    metric: 'views',
    readAtHours: 72,
    variants: [
      { label: 'Question', description: 'Open with a question.' },
      { label: 'Statement', description: 'Open with a claim.' },
    ],
  })
  const [question, statement] = (await readExperiment(x.owner, hooks.id))
    .variants
  await transitionExperiment(x.owner, {
    experimentId: hooks.id,
    expectedRevision: hooks.revision,
    to: 'running',
  })
  for (const [i, post] of posts.out.entries())
    await addItem(i === posts.out.length - 1 ? x.agent : x.owner, {
      experimentId: hooks.id,
      variantId: (post.question ? question?.id : statement?.id) as string,
      subjectId: post.id,
    })

  // Reading: nothing more is added; it waits for the owner's verdict.
  const bundles = await createExperiment(x.owner, {
    projectId: shop.id,
    question: 'Do bundles out-sell single prints in their first 72 hours?',
    subjectType: 'listing',
    metric: 'sales',
    readAtHours: 72,
    variants: [{ label: 'Bundle' }, { label: 'Single' }],
  })
  const [bundle, single] = (await readExperiment(x.owner, bundles.id)).variants
  await transitionExperiment(x.owner, {
    experimentId: bundles.id,
    expectedRevision: bundles.revision,
    to: 'running',
  })
  for (const id of market.bundle)
    await addItem(x.owner, {
      experimentId: bundles.id,
      variantId: bundle?.id as string,
      subjectId: id,
    })
  for (const id of market.singles)
    await addItem(x.owner, {
      experimentId: bundles.id,
      variantId: single?.id as string,
      subjectId: id,
    })
  const current = (await readExperiment(x.owner, bundles.id)).experiment
  await transitionExperiment(x.owner, {
    experimentId: bundles.id,
    expectedRevision: current.revision,
    to: 'reading',
  })

  await recordLearning(x.owner, {
    projectId: channel.id,
    statement:
      'Posts that open on motion reach about twice the views at 72 hours.',
    evidence:
      'Monitor arm (motion open) vs wrist rest (static), 72-hour reads.',
    tags: ['hooks', 'shorts'],
  })
  await recordLearning(x.owner, {
    statement: 'Posting after 19:00 Bangkok time does better than lunch slots.',
    tags: ['timing'],
  })
  await recordLearning(x.agent, {
    projectId: shop.id,
    experimentId: bundles.id,
    statement: 'The bundle sold in its first 72 hours; singles took longer.',
    evidence: 'Sales per listing at 72 hours, from the shop’s record.',
    tags: ['pricing', 'bundles'],
  })
}

/* ── Story ───────────────────────────────────────────────────────────── */

async function seedStory(x: Ctx, files: Files, prompts: Prompts) {
  const { film } = x.p
  const board = await openStory(x.owner, film.id)
  if (!board.story) throw new Error('The film has no story.')
  const story = await saveStory(x.owner, {
    storyId: board.story.id,
    expectedRevision: board.story.revision,
    title: 'Fog Line',
    logline:
      'A ferry keeper who has never crossed the river follows a lantern into the fog.',
    script: [
      '# Scene 1 — The ferry house',
      'Before dawn. MARA wakes in the dark ferry house. Fog presses on the glass.',
      '',
      '# Scene 2 — Lantern call',
      'A lantern swings over black water. THE FERRYMAN waits on a raft.',
      '',
      'MARA: ข้ามไปได้จริงเหรอ',
      'FERRYMAN: Only if you don’t look back.',
    ].join('\n'),
  })
  const mara = await saveCharacter(x.owner, {
    storyId: story.id,
    name: 'Mara',
    description: 'The ferry keeper. Has never crossed.',
    boardAssetId: files.boards.mara.id,
  })
  const ferryman = await saveCharacter(x.owner, {
    storyId: story.id,
    name: 'The ferryman',
    description: 'Seen only by lantern light.',
    boardAssetId: files.boards.ferryman.id,
  })
  const house = await saveScene(x.owner, {
    storyId: story.id,
    heading: 'The ferry house',
    synopsis: 'Mara wakes; the fog has come in.',
  })
  const call = await saveScene(x.owner, {
    storyId: story.id,
    heading: 'Lantern call',
    synopsis: 'The lantern, the raft, the crossing.',
  })
  const [s11, s12] = await saveShots(x.owner, {
    sceneId: house.id,
    shots: [
      {
        action: 'Mara wakes in the dark ferry house.',
        durationS: 3,
        imageVariantId: prompts.fogStill.a,
        characterIds: [mara.id],
      },
      {
        action: 'A hand on the fogged pane.',
        durationS: '2.5',
        imageVariantId: prompts.fogStill.a,
        characterIds: [mara.id],
      },
      {
        action: 'Boots by the door.',
        durationS: 2,
        imageVariantId: prompts.fogStill.b,
      },
    ],
  })
  const [s21, , s23] = await saveShots(x.owner, {
    sceneId: call.id,
    shots: [
      {
        action: 'The lantern swings over black water.',
        durationS: 4,
        imageVariantId: prompts.fogStill.b,
        videoVariantId: prompts.lanternMotion.a,
      },
      {
        action: 'The ferryman’s face in the glow.',
        durationS: 3,
        imageVariantId: prompts.fogStill.b,
        characterIds: [ferryman.id],
      },
      {
        action: 'The raft leaves into the fog.',
        durationS: 5,
        imageVariantId: prompts.fogStill.a,
        characterIds: [mara.id, ferryman.id],
      },
    ],
  })
  if (!s11 || !s12 || !s21 || !s23) throw new Error('Shots were not made.')
  // Two stills from the generator (cost on record), one uploaded by hand…
  for (const shot of [s11, s21])
    await generateShot(x.owner, {
      shotId: shot.id,
      medium: 'image',
      provider: 'external:openai_compatible',
      connectionId: x.generatorId,
    })
  await attachShotResult(x.owner, { shotId: s12.id, assetId: files.still.id })
  // …and one waiting for its file.
  await generateShot(x.owner, { shotId: s23.id, medium: 'image' })
  const view = await openStory(x.owner, film.id)
  const first = view.scenes
    .flatMap((scene) => scene.shots)
    .find((shot) => shot.id === s11.id)
  if (first)
    await setShotStatus(x.owner, {
      shotId: first.id,
      expectedRevision: first.revision,
      status: 'edited',
    })
}

/* ── Agents ──────────────────────────────────────────────────────────── */

async function claimRun(x: Ctx, routineId: string, projectId: string) {
  const { task } = await runRoutineNow(x.owner, { routineId })
  const claim = await claimTask(x.agent, projectId, {
    taskId: task.id,
    leaseSeconds: 3600,
  })
  if (!claim) throw new Error('The seed agent could not claim its run.')
  return { runId: claim.run.id, fencingToken: claim.task.fencingToken }
}

async function seedAgents(
  x: Ctx,
  prompts: Prompts,
  posts: Posts,
  market: Market,
): Promise<void> {
  const { channel, shop } = x.p
  const { nextWeek } = x.clock
  const routine = (
    project: ProjectRow,
    input: {
      name: string
      cron: string
      playbook: string
      modules: ('readings' | 'prompts' | 'board' | 'calendar' | 'market')[]
      enabled?: boolean
    },
  ) =>
    saveRoutine(x.owner, {
      projectId: project.id,
      timezone: TZ,
      runner: 'mcp',
      maxTurns: 20,
      ...input,
    })
  const hooks = await routine(channel, {
    name: 'Hook review',
    cron: '0 9 * * *',
    playbook:
      'Read the last 7 days of readings for this channel. Propose one new hook variant, one card for the next short and a posting slot.',
    modules: ['readings', 'prompts', 'board', 'calendar'],
  })
  const recap = await routine(shop, {
    name: 'Weekly sales recap',
    cron: '0 18 * * 5',
    playbook:
      'Sum the week’s sales, fees and refunds per listing and write what changed.',
    modules: ['readings', 'market'],
  })
  const tags = await routine(shop, {
    name: 'Listing tag sweep',
    cron: '30 8 * * *',
    playbook:
      'Check every listing’s tags against the shop’s limits and propose fixes.',
    modules: ['market'],
  })
  const comments = await routine(channel, {
    name: 'Comment digest',
    cron: '0 21 * * *',
    playbook: 'Summarise new comments worth answering.',
    modules: ['readings'],
  })
  await setRoutineEnabled(x.owner, { routineId: comments.id, enabled: false })

  // 1. A finished run: three proposals wait in the Inbox, its cost on record.
  const done = await claimRun(x, hooks.id, channel.id)
  await propose(x.agent, {
    ...done,
    kind: 'prompt_variant',
    title: 'Cold-open hook',
    payload: {
      promptId: prompts.deskHook,
      text: 'The lamp switches on, cut to the whole desk before the 3-second mark, 9:16.',
      style: 'Cold open',
    },
    rationale:
      'The two posts that opened on motion read about 2× the views at 72 hours.',
  })
  await propose(x.agent, {
    ...done,
    kind: 'card',
    title: 'Film the lamp tour B-roll',
    payload: {
      title: 'Film the lamp tour B-roll',
      body: 'Three angles at dusk; 20 seconds each.',
      labels: ['short'],
      dueOn: plusDays(nextWeek, 1),
    },
    rationale: 'The full tour is scheduled; the B-roll isn’t on the board.',
  })
  await propose(x.agent, {
    ...done,
    kind: 'event',
    title: 'Posting slot: Thursday 19:30',
    payload: {
      title: 'Post: cable tray recut',
      startsAt: `${plusDays(nextWeek, 3)}T19:30`,
      endsAt: `${plusDays(nextWeek, 3)}T20:00`,
    },
    rationale: 'Evening posts read higher than lunch posts over two weeks.',
  })
  await recordRunCost(x.agent, {
    ...done,
    provider: 'anthropic',
    costMinor: 1840,
    currency: 'THB',
    tokens: 21_400,
    unit: 'tokens',
    quantity: 21_400,
    note: `${SEED} Two turns of a mid-size model.`,
  })
  await finishRun(x.agent, done.runId, {
    fencingToken: done.fencingToken,
    outcome: 'done',
    summary:
      'Read 7 days of readings; proposed a hook variant, a card and a posting slot.',
  })

  // 2. A failed run: it asked for sales that weren't recorded yet.
  const failed = await claimRun(x, recap.id, shop.id)
  await recordRunCost(x.agent, {
    ...failed,
    provider: 'anthropic',
    costMinor: 45,
    currency: 'USD',
    tokens: 6_200,
    unit: 'tokens',
    quantity: 6_200,
  })
  await finishRun(x.agent, failed.runId, {
    fencingToken: failed.fencingToken,
    outcome: 'failed',
    summary: 'Stopped before writing the recap.',
    error: 'market_list_sales returned nothing for the last 24 hours.',
    retryAfterSeconds: 12 * 3600,
  })

  // 3. A run still working, under a live lease (it lapses in an hour; the
  //    ops tick then marks it abandoned — that's fine).
  const live = await claimRun(x, tags.id, shop.id)
  await checkpointRun(x.agent, live.runId, {
    fencingToken: live.fencingToken,
    summary: 'Checked 3 of 5 listings’ tags against the shop’s limits.',
    state: { checked: 3, of: 5 },
    nextAction: 'Check the last two listings, then propose fixes.',
    leaseSeconds: 3600,
  })

  // What the agent asks the owner for.
  await requestHumanAction(x.agent, channel.id, {
    module: 'publish',
    kind: 'approval',
    title: `Clear “${posts.waiting.title}” for ${posts.waiting.at}`,
    reason:
      'It is planned with its file and caption, but only you can clear a post to go out.',
    requestedAction: {
      tool: 'publish_authorize_post',
      post_id: posts.waiting.id,
    },
    targetType: 'post',
    targetId: posts.waiting.id,
    targetRevision: posts.waiting.revision,
    impact: 'Without it the post stays planned and misses its slot.',
    meanwhile: 'I’ll keep drafting captions for the next two posts.',
    dedupeKey: 'seed-clear-typewell-post',
  })
  await requestHumanAction(x.agent, shop.id, {
    module: 'market',
    kind: 'choice',
    title: 'Which price for the Fog river bundle?',
    reason:
      'Singles sell at $4.90–5.90; the bundle at $11.90 undercuts two singles.',
    requestedAction: {
      tool: 'market_update_listing',
      listing_id: market.approved,
      field: 'price',
    },
    targetType: 'listing',
    targetId: market.approved,
    options: [
      { key: 'keep', label: 'Keep $11.90' },
      { key: 'raise', label: 'Raise to $14.90' },
    ],
    dedupeKey: 'seed-bundle-price',
  })
}

/* ── Summary ─────────────────────────────────────────────────────────── */

async function summary(x: Ctx, storage: StorageMode): Promise<void> {
  const count = async (query: SQL) => {
    const [row] = await x.db.execute<{ n: number }>(query)
    return Number(row?.n ?? 0)
  }
  const owned = (table: string, where = sql`true`) =>
    count(
      sql`select count(*)::int as n from ${sql.identifier(table)} where owner_id = ${x.ownerId} and ${where}`,
    )
  const lines: [string, string][] = [
    [
      'notes',
      `${await owned('notes', sql`deleted_at is null and archived_at is null`)} on the board · ${await owned('notes', sql`updated_at < now() - interval '30 days'`)} stale · ${await owned('notes', sql`promoted_to is not null`)} promoted · ${await owned('notes', sql`archived_at is not null and deleted_at is null`)} archived · ${await owned('notes', sql`deleted_at is not null`)} in the trash`,
    ],
    [
      'board',
      `${await owned('board_cards', sql`archived_at is null`)} cards · ${await owned('board_cards', sql`color is not null`)} coloured · ${await owned('board_followups', sql`archived_at is null`)} follow-ups · ${await owned('board_card_payments', sql`kind <> 'void'`)} payment lines (${await owned('board_card_payments', sql`kind = 'void'`)} voided) · ${await owned('board_cards', sql`paid_at >= now() - interval '7 days'`)} paid in the last 7 days · ${await count(sql`select count(*)::int as n from board_cards c join board_lanes l on l.id = c.lane_id where c.owner_id = ${x.ownerId} and l.role = 'awaiting_payment' and c.archived_at is null`)} awaiting payment, ฿${(await count(sql`select round(coalesce(sum(greatest(c.total - c.paid_total, 0)), 0))::int as n from board_cards c join board_lanes l on l.id = c.lane_id where c.owner_id = ${x.ownerId} and l.role = 'awaiting_payment' and c.archived_at is null`)).toLocaleString('en-US')} still owed`,
    ],
    [
      'follow-ups',
      `${await owned('board_followups', sql`archived_at is null and price is not null`)} priced · ${await owned('board_followups', sql`archived_at is null and price is null`)} notes · ${await owned('board_followups', sql`archived_at is not null`)} removed · ${await owned('board_cards', sql`archived_at is null and paid_total > 0 and paid_total < total`)} cards part-paid · ${await owned('board_cards', sql`archived_at is null and currency <> (select p.currency from projects p where p.id = board_cards.project_id)`)} billed in another currency than its project's`,
    ],
    [
      'links',
      `${await owned('refs', sql`role = 'made_with'`)} made with a prompt · ${await owned('refs', sql`role = 'attached' and from_type in ('card', 'followup')`)} files on cards and follow-ups`,
    ],
    [
      'clients',
      `${await owned('clients', sql`archived_at is null`)} clients · ${await owned('clients', sql`archived_at is not null`)} archived · ${await owned('board_cards', sql`client_id is not null`)} cards on a client · ${await owned('board_cards', sql`client is not null`)} with a name used once`,
    ],
    [
      'prompts',
      `${await owned('prompt_prompts')} prompts · ${await owned('prompt_slots', sql`prompt_id is null`)} variants in the library · ${await owned('prompt_slots', sql`prompt_id is not null`)} of prompts' own · ${await owned('prompt_slot_options')} options · ${await owned('prompt_examples')} examples (${await owned('prompt_example_picks')} picks)`,
    ],
    [
      'assets',
      `${await owned('asset_assets', sql`status = 'ready'`)} ready · ${await owned('asset_assets', sql`status = 'pending'`)} pending · ${await owned('asset_generation_jobs')} jobs (${storage === 'r2' ? 'in R2' : 'in memory — previews won’t load'})`,
    ],
    [
      'calendar',
      `${await owned('calendar_events')} events · ${await owned('calendar_events', sql`all_day`)} all-day · ${await owned('calendar_events', sql`sync`)} set to sync to Google`,
    ],
    [
      'quotes',
      `${await owned('quote_quotes', sql`status = 'sent'`)} sent · ${await owned('quote_quotes', sql`status = 'draft'`)} draft`,
    ],
    [
      'publish',
      `${await owned('publish_posts', sql`status = 'posted'`)} posted · ${await owned('publish_posts', sql`status = 'scheduled'`)} scheduled · ${await owned('publish_posts', sql`status = 'planned'`)} planned · ${await owned('publish_readings')} readings`,
    ],
    [
      'market',
      `${await owned('market_products')} products · ${await owned('market_listings', sql`status = 'listed'`)} listed · ${await owned('market_listings', sql`status = 'approved'`)} approved · ${await owned('market_listings', sql`status = 'planned'`)} planned · ${await owned('market_sales_events')} money lines · ${await owned('market_payouts')} payouts`,
    ],
    [
      'experiments',
      `${await owned('exp_experiments', sql`status = 'running'`)} running · ${await owned('exp_experiments', sql`status = 'reading'`)} to decide · ${await owned('exp_items')} items · ${await owned('exp_learnings')} learnings`,
    ],
    [
      'story',
      `${await owned('story_scenes')} scenes · ${await owned('story_shots')} shots · ${await owned('asset_generation_jobs', sql`target_type = 'shot' and status = 'awaiting_upload'`)} waiting for a file`,
    ],
    [
      'agents',
      `${await owned('agent_routines', sql`enabled`)} routines on · ${await owned('agent_routines', sql`not enabled`)} off · runs ${await owned('ops_agent_runs', sql`status = 'succeeded'`)} done / ${await owned('ops_agent_runs', sql`status = 'failed'`)} failed / ${await owned('ops_agent_runs', sql`status = 'running'`)} running · ${await owned('agent_proposals', sql`status = 'proposed'`)} proposals · ${await owned('ops_human_requests', sql`status = 'open'`)} requests open`,
    ],
    [
      'cost',
      `${await owned('ops_usage_events')} usage events (generation + agent runs)`,
    ],
  ]
  for (const [label, text] of lines) console.log(`${label.padEnd(12)}${text}`)
}

/* ── Main ────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const url = localUrl()
  const handle: DbHandle = createDbHandle(url, { max: 4 })
  configureOpsDatabase(handle.db)
  const db = handle.db
  const restore = {
    privateProviders: process.env.HQ_RUNTIME_ALLOW_PRIVATE,
  }
  let generator: Generator | null = null
  try {
    const found = await resolveOwner(db)
    console.log(`owner       ${found.email}`)
    const owner = userActor({ id: found.id, role: 'admin' })
    if (flag('reset')) await reset(db, found.id)
    else await assertEmpty(db, found.id)

    const storage = configureStorage()
    console.log(
      storage === 'r2'
        ? `storage     R2 at ${process.env.R2_ENDPOINT ?? 'the configured account'} — previews load`
        : 'storage     memory (R2_* not set) — rows are real, previews won’t load',
    )
    if (!isSealingConfigured()) {
      // Only the stand-in generator's secret is sealed, and it is revoked
      // before this process exits — a key of the process's own is enough.
      process.env.HQ_SEALING_KEY = randomBytes(32).toString('base64')
    }

    const agent = await makeAgent(db, found.id)
    const clock = await readClock(db)
    console.log(
      `today       ${clock.today} (${TZ}) · this week ${clock.weekStart} → ${plusDays(clock.weekStart, 6)}`,
    )
    const p = await makeProjects(owner)

    generator = await startGenerator()
    process.env.HQ_RUNTIME_ALLOW_PRIVATE = '1'
    const connection = await saveProviderConnection(owner, {
      provider: 'openai_compatible',
      label: `${SEED} local generator`,
      secret: 'sk-seed-local',
      config: {
        baseUrl: generator.url,
        currency: 'THB',
        image: {
          model: 'seed-still-1',
          size: '640x400',
          pricePerImage: '1.50',
        },
      },
    })
    const x: Ctx = {
      db,
      owner,
      agent,
      ownerId: found.id,
      clock,
      p,
      generatorId: connection.id,
    }

    await policies(x)
    await seedNotes(x)
    const files = await seedFiles(x)
    const clients = await seedClients(x)
    const cards = await seedBoards(x, clients)
    const prompts = await seedPrompts(x, files)
    await seedCardLinks(x, cards, files)
    // More stills for the channel, straight from the generator.
    await queueGeneration(owner, {
      projectId: p.channel.id,
      provider: 'external:openai_compatible',
      connectionId: connection.id,
      operation: 'generate',
      title: 'Lamp tour · cover options',
      input: {
        medium: 'image',
        prompt: 'A desk lamp at dusk on a walnut desk, warm key light.',
        count: 2,
      },
    })
    await seedCalendar(x)
    await seedQuotes(x, cards, clients)
    const posts = await seedPublish(x, files)
    const market = await seedMarket(x, files)
    await seedExperiments(x, posts, market)
    await seedStory(x, files, prompts)
    await seedAgents(x, prompts, posts, market)

    await revokeProviderConnection(owner, { connectionId: connection.id })
    await generator.stop()
    generator = null

    console.log(
      `projects    ${Object.values(p)
        .map((row) => `${row.name} (${row.kind}, /p/${row.slug}, ${row.color})`)
        .join('\n            ')}`,
    )
    await summary(x, storage)
    console.log(
      `agent       “${SEED} agent” connection · its routine run holds a 1-hour lease`,
    )
  } finally {
    if (restore.privateProviders === undefined)
      delete process.env.HQ_RUNTIME_ALLOW_PRIVATE
    else process.env.HQ_RUNTIME_ALLOW_PRIVATE = restore.privateProviders
    await generator?.stop()
    configureOpsDatabase(null)
    await handle.sql.end({ timeout: 5 })
  }
}

main().catch((error: unknown) => {
  if (error instanceof Refusal) console.error(error.message)
  else {
    const failure = error as {
      code?: string
      message?: string
      fields?: unknown
    }
    console.error(
      `Seeding failed${failure.code ? ` (${failure.code})` : ''}: ${failure.message ?? String(error)}`,
    )
    if (failure.fields) console.error(JSON.stringify(failure.fields))
    if (error instanceof Error && error.stack && !failure.code)
      console.error(error.stack)
  }
  process.exitCode = 1
})
