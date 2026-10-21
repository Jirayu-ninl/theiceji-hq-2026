import { createHash, randomBytes } from 'node:crypto'
import type { GoogleConnectionStatus } from '@theiceji/hq-db/enums'
import {
  type GoogleConnectionRow,
  googleConnections,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { database } from '@theiceji/hq-ops/db'
import {
  capabilityUnavailable,
  invalid,
  OpsError,
  reauthRequired,
} from '@theiceji/hq-ops/errors'
import { isSealingConfigured, seal, unseal } from '@theiceji/hq-ops/secrets'
import {
  audit,
  authorize,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { eq, sql } from 'drizzle-orm'

/**
 * The owner's one Google connection: Drive for asset storage
 * and Calendar for events, on a single consent.
 *
 * · **Scopes are the narrowest that work.** `drive.file` sees only files HQ
 *   created (its own folder and what it uploads), never the rest of the
 *   owner's Drive; `calendar.events` + `calendar.readonly` read and write
 *   events. The account's address comes from Drive's `about`, so no identity
 *   scope is asked for.
 * · **The refresh token is sealed** (hq-ops/secrets) and never leaves the
 *   server. Access tokens are minted from it on demand and kept in memory
 *   only, per process, until a minute before they expire.
 * · **A refused refresh is the owner's to fix.** `invalid_grant` (revoked in
 *   Google, password changed, consent expired) marks the connection
 *   `needs_reauth` with the reason, and every caller gets `reauth_required`
 *   until the owner reconnects in Settings › Google.
 *
 * The OAuth client (a Web application in the owner's Google Cloud project)
 * comes from `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`; the
 * owner creates it. Every Google call takes an injectable
 * `fetch` so tests never reach Google.
 */

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
] as const

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const DRIVE = 'https://www.googleapis.com/drive/v3'

/** The folder HQ keeps its files in, at the top of the owner's Drive. */
export const DRIVE_ROOT_NAME = 'TheIceJi HQ'

export type Http = typeof fetch

export type GoogleClient = { clientId: string; clientSecret: string }

export function googleClient(
  env: Record<string, string | undefined> = process.env,
): GoogleClient | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim()
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/** What stops Google from working on this server, or null when nothing does. */
export function googleBlocker(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!googleClient(env))
    return 'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET on the server.'
  if (!isSealingConfigured())
    return 'Set HQ_SEALING_KEY on the server so the Google token can be stored sealed.'
  return null
}

function requireClient(): GoogleClient {
  const blocker = googleBlocker()
  if (blocker) throw capabilityUnavailable(`Google isn’t set up. ${blocker}`)
  return googleClient() as GoogleClient
}

/* ── Authorization request (PKCE) ──────────────────────────────────── */

const b64url = (buffer: Buffer) => buffer.toString('base64url')

export type PkcePair = { state: string; verifier: string; challenge: string }

/** A fresh `state` and PKCE verifier/challenge for one consent round-trip. */
export function newPkce(): PkcePair {
  const verifier = b64url(randomBytes(48))
  return {
    state: b64url(randomBytes(24)),
    verifier,
    challenge: b64url(createHash('sha256').update(verifier).digest()),
  }
}

/**
 * Google's consent URL. `access_type=offline` + `prompt=consent` is what
 * makes Google return a refresh token on every connect, not just the first.
 */
export function authorizationUrl(input: {
  redirectUri: string
  state: string
  challenge: string
  loginHint?: string | null
}): string {
  const client = requireClient()
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
  })
  if (input.loginHint) params.set('login_hint', input.loginHint)
  return `${AUTH_URL}?${params.toString()}`
}

/* ── Talking to Google ─────────────────────────────────────────────── */

type TokenResponse = {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
}

async function tokenRequest(
  http: Http,
  body: Record<string, string>,
): Promise<
  | { ok: true; token: TokenResponse }
  | { ok: false; status: number; error: string }
> {
  const response = await http(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >
  if (!response.ok || typeof json.access_token !== 'string')
    return {
      ok: false,
      status: response.status,
      error: typeof json.error === 'string' ? json.error : 'unknown_error',
    }
  return { ok: true, token: json as unknown as TokenResponse }
}

async function driveJson<T>(
  http: Http,
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await http(`${DRIVE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  if (response.status === 401)
    throw reauthRequired(
      'Google refused HQ’s token. Reconnect Google in Settings › Google.',
    )
  if (!response.ok)
    throw new OpsError(
      'provider_unavailable',
      `Google Drive answered ${response.status}. Try again in a minute.`,
    )
  return (await response.json()) as T
}

/** HQ's folder in the owner's Drive: the one it made before, or a new one. */
async function ensureDriveRoot(
  http: Http,
  accessToken: string,
  known: string | null,
): Promise<string> {
  if (known) {
    const response = await http(
      `${DRIVE}/files/${encodeURIComponent(known)}?fields=id,trashed`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    )
    if (response.ok) {
      const file = (await response.json()) as { id: string; trashed?: boolean }
      if (!file.trashed) return file.id
    }
  }
  const query = `name = '${DRIVE_ROOT_NAME}' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`
  const found = await driveJson<{ files: { id: string }[] }>(
    http,
    accessToken,
    `/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`,
  )
  if (found.files[0]) return found.files[0].id
  const created = await driveJson<{ id: string }>(
    http,
    accessToken,
    '/files?fields=id',
    {
      method: 'POST',
      body: JSON.stringify({
        name: DRIVE_ROOT_NAME,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
      }),
    },
  )
  return created.id
}

/* ── Access tokens (memory only) ───────────────────────────────────── */

const tokens = new Map<string, { token: string; expiresAt: number }>()

/** For tests and disconnect: forget cached access tokens. */
export function forgetGoogleTokens(ownerId?: string): void {
  if (ownerId) tokens.delete(ownerId)
  else tokens.clear()
}

async function markProblem(
  ownerId: string,
  status: GoogleConnectionStatus,
  problem: string,
): Promise<void> {
  await database()
    .update(googleConnections)
    .set({ status, problem, updatedAt: sql`now()` })
    .where(eq(googleConnections.ownerId, ownerId))
}

/**
 * A live access token for the owner's Google connection — for server-side
 * work (Drive uploads, the calendar sync step of the ops tick). Throws
 * `reauth_required` when there is no usable connection.
 */
export async function googleAccessToken(
  ownerId: string,
  http: Http = fetch,
): Promise<string> {
  const cached = tokens.get(ownerId)
  // A process-local cache compared with the process clock; nothing stored
  // or shared reads it.
  if (cached && cached.expiresAt > Date.now()) return cached.token
  const client = requireClient()
  const [row] = await database()
    .select()
    .from(googleConnections)
    .where(eq(googleConnections.ownerId, ownerId))
    .limit(1)
  if (row?.status !== 'connected' || !row.refreshTokenSealed)
    throw reauthRequired(
      row?.status === 'needs_reauth'
        ? `Google needs you to sign in again: ${row.problem ?? 'the connection was refused'}. Reconnect in Settings › Google.`
        : 'Google isn’t connected. Connect it in Settings › Google.',
    )
  const result = await tokenRequest(http, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: unseal(row.refreshTokenSealed),
  })
  if (!result.ok) {
    if (result.error === 'invalid_grant') {
      const problem =
        'Google no longer accepts HQ’s access (it was revoked or expired).'
      await markProblem(ownerId, 'needs_reauth', problem)
      throw reauthRequired(`${problem} Reconnect in Settings › Google.`)
    }
    throw new OpsError(
      'provider_unavailable',
      `Google’s token service answered ${result.status}. Try again in a minute.`,
    )
  }
  tokens.set(ownerId, {
    token: result.token.access_token,
    expiresAt: Date.now() + Math.max(0, result.token.expires_in - 60) * 1000,
  })
  return result.token.access_token
}

/* ── The connection, as the owner sees it ──────────────────────────── */

export type GoogleConnectionView = {
  email: string
  status: GoogleConnectionStatus
  problem: string | null
  scopes: string[]
  drive: boolean
  calendar: boolean
  driveRootId: string | null
  calendarId: string | null
  connectedAt: Date
  revokedAt: Date | null
}

function view(row: GoogleConnectionRow): GoogleConnectionView {
  return {
    email: row.email,
    status: row.status,
    problem: row.problem,
    scopes: row.scopes,
    drive: row.scopes.includes(GOOGLE_SCOPES[0]),
    calendar:
      row.scopes.includes(GOOGLE_SCOPES[1]) &&
      row.scopes.includes(GOOGLE_SCOPES[2]),
    driveRootId: row.driveRootId,
    calendarId: row.calendarId,
    connectedAt: row.connectedAt,
    revokedAt: row.revokedAt,
  }
}

export async function getGoogleConnection(
  actor: Actor,
): Promise<GoogleConnectionView | null> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'hq', 'read')
    const [row] = await db
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.ownerId, actor.userId))
      .limit(1)
    return row ? view(row) : null
  })
}

/**
 * Finish the consent round-trip: trade the code for tokens, find (or make)
 * HQ's Drive folder, and store the sealed refresh token. The owner's own act
 * — `manage`, which no connection holds.
 */
export async function connectGoogle(
  actor: Actor,
  input: { code: string; redirectUri: string; verifier: string },
  http: Http = fetch,
): Promise<GoogleConnectionView> {
  await withReader((db) => authorize(db, actor, null, 'hq', 'manage'))
  const client = requireClient()
  if (!input.code)
    throw invalid('Google didn’t send a code back. Try connecting again.')
  const exchanged = await tokenRequest(http, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: input.verifier,
  })
  if (!exchanged.ok)
    throw invalid(
      exchanged.error === 'invalid_grant'
        ? 'That sign-in expired before HQ could use it. Connect again.'
        : `Google refused the sign-in (${exchanged.error}). Connect again.`,
    )
  const { token } = exchanged
  if (!token.refresh_token)
    throw invalid(
      'Google didn’t hand HQ a long-lived token. Remove HQ under “Third-party access” in your Google account, then connect again.',
    )
  const granted = (token.scope ?? '').split(/\s+/).filter(Boolean)
  if (!granted.includes(GOOGLE_SCOPES[0]))
    throw invalid(
      'HQ needs access to the files it creates in your Drive. Connect again and leave “See, edit, create and delete only the specific Google Drive files you use with this app” ticked.',
    )
  const about = await driveJson<{ user?: { emailAddress?: string } }>(
    http,
    token.access_token,
    '/about?fields=user(emailAddress)',
  )
  const email = about.user?.emailAddress
  if (!email)
    throw invalid('Google didn’t say which account this is. Connect again.')

  const [existing] = await database()
    .select({ driveRootId: googleConnections.driveRootId })
    .from(googleConnections)
    .where(eq(googleConnections.ownerId, actor.userId))
    .limit(1)
  const driveRootId = await ensureDriveRoot(
    http,
    token.access_token,
    existing?.driveRootId ?? null,
  )
  const calendarMissing = !(
    granted.includes(GOOGLE_SCOPES[1]) && granted.includes(GOOGLE_SCOPES[2])
  )
  const sealed = seal(token.refresh_token)

  const row = await withTransaction(async (tx) => {
    const values = {
      email,
      scopes: granted,
      refreshTokenSealed: sealed,
      driveRootId,
      calendarId: 'primary',
      status: 'connected' as const,
      problem: calendarMissing
        ? 'Calendar wasn’t granted, so events won’t sync. Connect again and allow Calendar.'
        : null,
      revokedAt: null,
    }
    const [saved] = await tx
      .insert(googleConnections)
      .values({ ownerId: actor.userId, ...values })
      .onConflictDoUpdate({
        target: googleConnections.ownerId,
        set: { ...values, connectedAt: sql`now()`, updatedAt: sql`now()` },
      })
      .returning()
    if (!saved) throw new Error('The write returned no row.')
    await audit(tx, actor, {
      projectId: null,
      action: 'google.connect',
      targetType: 'google_connection',
      targetId: saved.id,
      changes: { email, scopes: granted },
    })
    return saved
  })
  tokens.set(actor.userId, {
    token: token.access_token,
    expiresAt: Date.now() + Math.max(0, token.expires_in - 60) * 1000,
  })
  return view(row)
}

/**
 * Disconnect: revoke HQ's token at Google (best effort — the owner can also
 * remove HQ in their Google account) and forget it here. Files HQ put in
 * Drive stay there, and so does the folder ID, so reconnecting finds them.
 */
export async function disconnectGoogle(
  actor: Actor,
  http: Http = fetch,
): Promise<void> {
  const row = await withTransaction(async (tx) => {
    await authorize(tx, actor, null, 'hq', 'manage')
    const [current] = await tx
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.ownerId, actor.userId))
      .limit(1)
    if (!current || current.status === 'revoked') return null
    await tx
      .update(googleConnections)
      .set({
        status: 'revoked',
        revokedAt: sql`now()`,
        refreshTokenSealed: null,
        problem: null,
        updatedAt: sql`now()`,
      })
      .where(eq(googleConnections.id, current.id))
    await audit(tx, actor, {
      projectId: null,
      action: 'google.disconnect',
      targetType: 'google_connection',
      targetId: current.id,
      changes: { email: current.email },
    })
    return current
  })
  forgetGoogleTokens(actor.userId)
  if (row?.refreshTokenSealed) {
    try {
      await http(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: unseal(row.refreshTokenSealed),
        }).toString(),
      })
    } catch {
      // Already forgotten here; the owner can remove HQ in their Google account.
    }
  }
}
