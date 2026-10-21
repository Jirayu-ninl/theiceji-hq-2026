import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { verifyAccessToken } from '@theiceji/hq-db/access'
import { like } from 'drizzle-orm'
import { closeDb, getDb } from '../src/db'
import { oauthClients, users } from '../src/db/schema'
import { fetchClientMetadata } from '../src/lib/oauth/cimd'
import {
  createAuthorizationCode,
  createPersonalToken,
  exchangeCode,
} from '../src/lib/oauth/grants'
import { handleRevocation } from '../src/lib/oauth/revoke'

/**
 * Security regressions on HQ's OAuth server:
 *
 * · A client metadata document on a non-public address is refused
 *   before any connection (the transport itself — pinning, DNS changes,
 *   chunked oversize bodies — is covered in packages/net-guard).
 * · A revocation the database couldn't record is a retryable 503, an
 *   unknown token is still 200, and a 200 means the connection is gone.
 * · Replaying a used authorization code only revokes what it created
 *   when the replay is bound to the same client and PKCE verifier.
 *
 * The first two groups need nothing; the database group runs only with
 * HQ_DB_TESTS=1 (or the old CREATOR_DB_TESTS=1) and a localhost DATABASE_URL. All data is synthetic.
 */

const url = process.env.DATABASE_URL ?? ''
const withDatabase =
  (process.env.HQ_DB_TESTS ?? process.env.CREATOR_DB_TESTS) === '1' &&
  /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)

const RESOURCE = 'http://localhost:8991/mcp'

const revokeRequest = (token?: string) =>
  new Request('http://localhost:8990/oauth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: token ? new URLSearchParams({ token }).toString() : '',
  })

describe('S03 — revocation outcomes', () => {
  const quiet = () => {}

  test('a database failure is a retryable 503, never a 200', async () => {
    const response = await handleRevocation(revokeRequest('hq_at_whatever'), {
      ready: () => ({ ok: true }),
      revoke: async () => {
        throw new Error('connection terminated')
      },
      log: quiet,
    })
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(((await response.json()) as { error: string }).error).toBe(
      'temporarily_unavailable',
    )
  })

  test('an HQ without OAuth configured can’t claim to have revoked anything', async () => {
    let called = false
    const response = await handleRevocation(revokeRequest('hq_at_whatever'), {
      ready: () => ({ ok: false }),
      revoke: async () => {
        called = true
      },
      log: quiet,
    })
    expect(response.status).toBe(503)
    expect(called).toBe(false)
  })

  test('a request with no token is invalid_request', async () => {
    const response = await handleRevocation(revokeRequest(), {
      ready: () => ({ ok: true }),
      revoke: async () => {},
      log: quiet,
    })
    expect(response.status).toBe(400)
  })
})

describe('S02 — client metadata documents off the public internet', () => {
  test('a client id resolving to a private address is refused before connecting', async () => {
    let connected = false
    const result = await fetchClientMetadata(
      'https://clients.example.test/hq-private.json',
      {
        skipCache: true,
        resolve: async () => [{ address: '10.0.0.5', family: 4 }],
        allowAddress: (address) => {
          connected = connected || address !== '10.0.0.5'
          return false
        },
      },
    )
    expect(result).toEqual({ ok: false, reason: 'not-public' })
    expect(connected).toBe(false)
  })

  test('one public and one private answer is refused, not raced', async () => {
    const result = await fetchClientMetadata(
      'https://clients.example.test/hq-mixed.json',
      {
        skipCache: true,
        resolve: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ],
      },
    )
    expect(result).toEqual({ ok: false, reason: 'not-public' })
  })
})

const databaseSuite = withDatabase ? describe : describe.skip

databaseSuite('S03/S05 against Postgres', () => {
  const run = Date.now()
  let userId: string

  beforeAll(async () => {
    process.env.MCP_RESOURCE_URLS = RESOURCE
    process.env.OAUTH_ISSUER = 'http://localhost:8990'
    const db = getDb()
    if (!db) throw new Error('DATABASE_URL is required')
    await db.delete(users).where(like(users.email, '%@oauthsec.test'))
    const [user] = await db
      .insert(users)
      .values({
        email: `owner-${run}@oauthsec.test`,
        passwordHash: 'x',
        role: 'admin',
      })
      .returning({ id: users.id })
    if (!user) throw new Error('user not created')
    userId = user.id
  })

  afterAll(async () => {
    const db = getDb()
    if (db) {
      await db.delete(users).where(like(users.email, '%@oauthsec.test'))
      await db.delete(oauthClients).where(like(oauthClients.id, 'hqc_sec_%'))
    }
    await closeDb()
  })

  test('S03 — a 200 means the connection no longer works; an unknown token is still 200', async () => {
    const db = getDb()
    if (!db) throw new Error('no db')
    const { token } = await createPersonalToken({
      userId,
      label: 'Revocation read-back (test)',
      scopes: ['hq:read'],
      expiresInDays: null,
    })
    expect((await verifyAccessToken(db, token, RESOURCE)).ok).toBe(true)
    const revoked = await handleRevocation(revokeRequest(token))
    expect(revoked.status).toBe(200)
    const after = await verifyAccessToken(db, token, RESOURCE)
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.reason).toBe('revoked')

    const unknown = await handleRevocation(
      revokeRequest(`hq_pat_${'z'.repeat(43)}`),
    )
    expect(unknown.status).toBe(200)
  })

  test('S05 — a replay without the client’s binding can’t end the connection; a bound replay does', async () => {
    const db = getDb()
    if (!db) throw new Error('no db')
    const redirectUri = 'http://127.0.0.1:33418/callback'
    const [client, stranger] = await db
      .insert(oauthClients)
      .values([
        {
          id: `hqc_sec_${run}_a`,
          kind: 'dcr',
          name: 'Owner app (test)',
          redirectUris: [redirectUri],
        },
        {
          id: `hqc_sec_${run}_b`,
          kind: 'dcr',
          name: 'Other app (test)',
          redirectUris: [redirectUri],
        },
      ])
      .returning()
    if (!client || !stranger) throw new Error('clients not created')
    const verifier = randomBytes(32).toString('base64url')
    const code = await createAuthorizationCode({
      client,
      userId,
      redirectUri,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      scopes: ['hq:read'],
      resource: RESOURCE,
    })
    const issued = await exchangeCode({
      client,
      code,
      redirectUri,
      verifier,
      resource: null,
    })
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    const accessToken = issued.body.access_token
    expect((await verifyAccessToken(db, accessToken, RESOURCE)).ok).toBe(true)

    // Someone who only saw the code: another client, or no verifier.
    const otherClient = await exchangeCode({
      client: stranger,
      code,
      redirectUri,
      verifier,
      resource: null,
    })
    expect(otherClient.ok).toBe(false)
    const wrongVerifier = await exchangeCode({
      client,
      code,
      redirectUri,
      verifier: randomBytes(32).toString('base64url'),
      resource: null,
    })
    expect(wrongVerifier.ok).toBe(false)
    expect((await verifyAccessToken(db, accessToken, RESOURCE)).ok).toBe(true)

    // The same client with the right verifier presenting it again: the code
    // and its verifier leaked, so the connection ends.
    const bound = await exchangeCode({
      client,
      code,
      redirectUri,
      verifier,
      resource: null,
    })
    expect(bound.ok).toBe(false)
    if (!bound.ok) expect(bound.description).toMatch(/revoked/)
    const after = await verifyAccessToken(db, accessToken, RESOURCE)
    expect(after.ok).toBe(false)
  })
})
