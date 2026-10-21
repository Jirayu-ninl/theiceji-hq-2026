import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { randomBytes } from 'node:crypto'
import { createDbHandle, type DbHandle } from '@theiceji/hq-db'
import {
  boardBoards,
  boardCards,
  boardLanes,
  clients,
  googleConnections,
  opsAuditEvents,
  providerConnections,
  quoteQuotes,
  users,
} from '@theiceji/hq-db/schema'
import { type Actor, connectionActor, userActor } from '@theiceji/hq-ops/access'
import { configureOpsDatabase } from '@theiceji/hq-ops/db'
import { unseal } from '@theiceji/hq-ops/secrets'
import { withTransaction } from '@theiceji/hq-ops/store'
import { eq, sql } from 'drizzle-orm'
import {
  clientInUse,
  clientUses,
  createClient,
  deleteClient,
  setClientArchived,
} from '../src/clients'
import {
  listProviderConnections,
  revokeProviderConnection,
  saveProviderConnection,
} from '../src/connections'
import {
  connectGoogle,
  disconnectGoogle,
  forgetGoogleTokens,
  GOOGLE_SCOPES,
  getGoogleConnection,
  googleAccessToken,
} from '../src/google'
import {
  createProject,
  deleteProject,
  getProject,
  getProjectBySlug,
  listProjects,
  restoreProject,
  setModule,
  setProjectStatus,
  slugify,
  updateProject,
} from '../src/projects'
import { link, listRefs, unlink } from '../src/refs'

/**
 * Projects, refs and the Google connection against Postgres. Destructive
 * (truncates), so it runs only with CORE_DB_TESTS=1 and a localhost
 * DATABASE_URL — point it at a throwaway database, never HQ's own. Google is
 * a fake `fetch`; nothing leaves the machine.
 */

const url = process.env.DATABASE_URL ?? ''
const enabled =
  process.env.CORE_DB_TESTS === '1' &&
  /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)
const suite = enabled ? describe : describe.skip

type Failure = { code?: string; message: string }

/** `expect(p).rejects` hangs after postgres I/O in bun 1.3.14 — assert with try/catch. */
async function failure(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise
  } catch (error) {
    return error as Failure
  }
  throw new Error('Expected the call to fail.')
}

let handle: DbHandle
let owner: Actor
let other: Actor
let agent: Actor

async function makeUser(email: string) {
  const [row] = await handle.db
    .insert(users)
    .values({ email, passwordHash: 'x', role: 'admin' })
    .returning()
  if (!row) throw new Error('no user')
  return row
}

suite('hq-core against Postgres', () => {
  beforeAll(async () => {
    process.env.HQ_SEALING_KEY = randomBytes(32).toString('base64')
    process.env.GOOGLE_OAUTH_CLIENT_ID =
      'test-client.apps.googleusercontent.com'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret'
    handle = createDbHandle(url, { max: 2 })
    configureOpsDatabase(handle.db)
  })

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate refs, google_connections, provider_connections, ops_audit_events, ops_idempotency_keys, projects, oauth_grants, sessions, users cascade`,
    )
    forgetGoogleTokens()
    const me = await makeUser('owner@hq.test')
    const them = await makeUser('other@hq.test')
    owner = userActor(me)
    other = userActor(them)
    agent = connectionActor({
      type: 'agent',
      grantId: crypto.randomUUID(),
      userId: me.id,
      role: me.role,
      scopes: ['hq:read', 'board:write'],
      label: 'test agent',
    })
  })

  afterAll(async () => {
    configureOpsDatabase(null)
    await handle?.sql.end({ timeout: 5 })
  })

  test('slugs are ASCII and Thai names fall back', () => {
    expect(slugify('Desk & Light')).toBe('desk-light')
    expect(slugify('งานลูกค้า')).toBe('project')
    expect(slugify('  Café — Nº 1  ')).toBe('cafe-no-1')
  })

  test('a new project gets its kind’s modules, a free slug, a swatch and the next position', async () => {
    const first = await createProject(owner, {
      name: 'Client work',
      kind: 'freelance',
    })
    expect(first.slug).toBe('client-work')
    expect(first.modules.enabled).toEqual([
      'board',
      'calendar',
      'quotes',
      'assets',
    ])
    expect(first.color).toBe('violet')
    expect(first.position).toBe(0)
    const second = await createProject(owner, {
      name: 'Client work',
      kind: 'personal',
    })
    expect(second.slug).toBe('client-work-2')
    expect(second.color).toBe('teal')
    expect(second.position).toBe(1)
    const [audited] = await handle.db
      .select()
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.targetId, first.id))
    expect(audited?.action).toBe('project.create')
    expect(audited?.ownerId).toBe(owner.userId)
  })

  test('the same idempotency key replays the first project', async () => {
    const key = 'create-project-0001'
    const a = await createProject(owner, {
      name: 'Loop',
      kind: 'channel',
      idempotencyKey: key,
    })
    const b = await createProject(owner, {
      name: 'Loop',
      kind: 'channel',
      idempotencyKey: key,
    })
    expect(b.id).toBe(a.id)
    const changed = await failure(
      createProject(owner, {
        name: 'Other',
        kind: 'channel',
        idempotencyKey: key,
      }),
    )
    expect(changed.code).toBe('idempotency_conflict')
  })

  test('another owner’s project is not found, and agents never shape projects', async () => {
    const mine = await createProject(owner, { name: 'Mine', kind: 'personal' })
    expect((await failure(getProjectBySlug(other, 'mine'))).code).toBe(
      'not_found',
    )
    expect(await listProjects(other)).toEqual([])
    expect((await getProjectBySlug(agent, 'mine')).id).toBe(mine.id)
    expect(
      (await failure(createProject(agent, { name: 'x', kind: 'film' }))).code,
    ).toBe('forbidden')
  })

  test('updates are optimistic and modules follow their rules', async () => {
    const film = await createProject(owner, { name: 'Fog Line', kind: 'film' })
    const renamed = await updateProject(owner, {
      projectId: film.id,
      expectedRevision: film.revision,
      name: 'Fog Line II',
      color: 'sky',
    })
    expect(renamed.revision).toBe(film.revision + 1)
    expect(renamed.color).toBe('sky')
    const stale = await failure(
      updateProject(owner, {
        projectId: film.id,
        expectedRevision: film.revision,
        name: 'x',
      }),
    )
    expect(stale.code).toBe('conflict')

    const blocked = await failure(
      setModule(owner, {
        projectId: film.id,
        expectedRevision: renamed.revision,
        module: 'prompts',
        on: false,
      }),
    )
    expect(blocked.message).toBe('Story needs Prompts. Turn it off first.')
    const withAgents = await setModule(owner, {
      projectId: film.id,
      expectedRevision: renamed.revision,
      module: 'agents',
      on: true,
    })
    expect(withAgents.modules.enabled).toEqual([
      'story',
      'prompts',
      'assets',
      'board',
      'calendar',
      'agents',
    ])
  })

  test('archive takes no changes until restored; paused still does', async () => {
    const p = await createProject(owner, { name: 'Shelf', kind: 'personal' })
    const archived = await setProjectStatus(owner, {
      projectId: p.id,
      expectedRevision: p.revision,
      status: 'archived',
    })
    expect(archived.archivedAt).not.toBeNull()
    expect(await listProjects(owner)).toHaveLength(0)
    expect(await listProjects(owner, { includeArchived: true })).toHaveLength(1)
    const refused = await failure(
      updateProject(owner, {
        projectId: p.id,
        expectedRevision: archived.revision,
        name: 'y',
      }),
    )
    expect(refused.message).toContain('archived')
    const restored = await setProjectStatus(owner, {
      projectId: p.id,
      expectedRevision: archived.revision,
      status: 'active',
    })
    expect(restored.archivedAt).toBeNull()
  })

  test('Delete puts a project in the Trash: out of every read but Trash, its slug kept, back archived', async () => {
    const p = await createProject(owner, {
      name: 'Side Job',
      kind: 'freelance',
    })
    const paused = await setProjectStatus(owner, {
      projectId: p.id,
      expectedRevision: p.revision,
      status: 'paused',
    })
    expect(
      (
        await failure(
          deleteProject(agent, {
            projectId: p.id,
            expectedRevision: paused.revision,
          }),
        )
      ).code,
    ).toBe('forbidden')
    expect(
      (
        await failure(
          deleteProject(owner, {
            projectId: p.id,
            expectedRevision: p.revision,
          }),
        )
      ).code,
    ).toBe('conflict')
    const trashed = await deleteProject(owner, {
      projectId: p.id,
      expectedRevision: paused.revision,
    })
    expect(trashed.status).toBe('archived')
    expect(trashed.archivedAt).not.toBeNull()
    expect(trashed.deletedAt).not.toBeNull()
    // Gone from every read but the Trash — even with archived projects.
    expect(await listProjects(owner)).toHaveLength(0)
    expect(await listProjects(owner, { includeArchived: true })).toHaveLength(0)
    expect(
      (
        await listProjects(owner, { includeArchived: true, includeTrash: true })
      ).map((row) => row.id),
    ).toEqual([p.id])
    expect((await failure(getProject(owner, p.id))).code).toBe('not_found')
    expect((await failure(getProjectBySlug(owner, 'side-job'))).code).toBe(
      'not_found',
    )
    expect(
      (
        await failure(
          setProjectStatus(owner, {
            projectId: p.id,
            expectedRevision: trashed.revision,
            status: 'active',
          }),
        )
      ).message,
    ).toContain('Trash')
    // Its address stays taken, and a new project that wants it says why.
    const taken = await failure(
      createProject(owner, { name: 'Side Job', kind: 'freelance' }),
    )
    expect(taken.code).toBe('invalid')
    expect(taken.message).toContain('/p/side-job')
    expect(taken.message).toContain('Trash')
    // Deleting again changes nothing; Restore brings it back archived.
    expect(
      (
        await deleteProject(owner, {
          projectId: p.id,
          expectedRevision: trashed.revision,
        })
      ).revision,
    ).toBe(trashed.revision)
    const back = await restoreProject(owner, {
      projectId: p.id,
      expectedRevision: trashed.revision,
    })
    expect(back).toMatchObject({ status: 'archived', deletedAt: null })
    expect(back.archivedAt).not.toBeNull()
    expect((await getProjectBySlug(owner, 'side-job')).id).toBe(p.id)
    expect(await listProjects(owner, { includeArchived: true })).toHaveLength(1)
    const actions = await handle.db
      .select({ action: opsAuditEvents.action })
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.targetId, p.id))
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(['project.delete', 'project.undelete']),
    )
  })

  test('Delete’s Undo brings a project back as it was', async () => {
    const p = await createProject(owner, { name: 'Undo me', kind: 'personal' })
    const trashed = await deleteProject(owner, {
      projectId: p.id,
      expectedRevision: p.revision,
    })
    const back = await restoreProject(owner, {
      projectId: p.id,
      expectedRevision: trashed.revision,
      status: 'active',
    })
    expect(back).toMatchObject({
      status: 'active',
      archivedAt: null,
      deletedAt: null,
    })
    expect((await listProjects(owner)).map((row) => row.id)).toEqual([p.id])
    expect(
      (
        await failure(
          restoreProject(agent, {
            projectId: p.id,
            expectedRevision: back.revision,
          }),
        )
      ).code,
    ).toBe('forbidden')
  })

  test('a client nothing points at can be deleted; one on a card or a quote says why', async () => {
    const spare = await createClient(owner, { name: 'Typo Co' })
    const onCard = await createClient(owner, { name: 'Card Co' })
    const onQuote = await createClient(owner, { name: 'Quote Co' })
    const [board] = await handle.db
      .insert(boardBoards)
      .values({ ownerId: owner.userId, createdBy: owner.userId, name: 'Jobs' })
      .returning()
    if (!board) throw new Error('no board')
    const [lane] = await handle.db
      .insert(boardLanes)
      .values({
        ownerId: owner.userId,
        boardId: board.id,
        name: 'Done',
        position: 0,
      })
      .returning()
    if (!lane) throw new Error('no lane')
    // Even a card in the Trash still names its client.
    await handle.db.insert(boardCards).values({
      ownerId: owner.userId,
      createdBy: owner.userId,
      boardId: board.id,
      laneId: lane.id,
      title: 'Old job',
      clientId: onCard.id,
      archivedAt: new Date(),
      deletedAt: new Date(),
    })
    await handle.db.insert(quoteQuotes).values({
      ownerId: owner.userId,
      createdBy: owner.userId,
      number: 'Q-2026-001',
      title: 'Logo',
      clientId: onQuote.id,
    })

    const uses = await clientUses(owner)
    expect(uses[spare.id]).toBeUndefined()
    expect(uses[onCard.id]).toEqual({ cards: 1, quotes: 0 })
    expect(uses[onQuote.id]).toEqual({ cards: 0, quotes: 1 })
    expect(clientInUse(uses[onCard.id])).toBe(
      'It’s on 1 card, which keeps naming it — archive it instead.',
    )

    expect(
      (
        await failure(
          deleteClient(agent, {
            clientId: spare.id,
            expectedRevision: spare.revision,
          }),
        )
      ).code,
    ).toBe('forbidden')
    expect(
      (
        await failure(
          deleteClient(other, {
            clientId: spare.id,
            expectedRevision: spare.revision,
          }),
        )
      ).code,
    ).toBe('not_found')
    const cardRefusal = await failure(
      deleteClient(owner, {
        clientId: onCard.id,
        expectedRevision: onCard.revision,
      }),
    )
    expect(cardRefusal.code).toBe('invalid')
    expect(cardRefusal.message).toContain('archive it instead')
    expect(
      (
        await failure(
          deleteClient(owner, {
            clientId: onQuote.id,
            expectedRevision: onQuote.revision,
          }),
        )
      ).message,
    ).toContain('1 quote')

    // An archived client nobody points at goes too.
    const archived = await setClientArchived(owner, {
      clientId: spare.id,
      expectedRevision: spare.revision,
      archived: true,
    })
    expect(
      (
        await failure(
          deleteClient(owner, {
            clientId: spare.id,
            expectedRevision: spare.revision,
          }),
        )
      ).code,
    ).toBe('conflict')
    await deleteClient(owner, {
      clientId: spare.id,
      expectedRevision: archived.revision,
    })
    const left = await handle.db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.ownerId, owner.userId))
    expect(left.map((row) => row.id).sort()).toEqual(
      [onCard.id, onQuote.id].sort(),
    )
    const [event] = await handle.db
      .select()
      .from(opsAuditEvents)
      .where(eq(opsAuditEvents.action, 'client.delete'))
    expect(event?.targetId).toBe(spare.id)
  })

  test('refs link once, read both ways, and unlink', async () => {
    const note = crypto.randomUUID()
    const card = crypto.randomUUID()
    await withTransaction(async (tx) => {
      await link(
        tx,
        owner,
        { type: 'note', id: note },
        { type: 'card', id: card },
        'promoted_to',
      )
      await link(
        tx,
        owner,
        { type: 'note', id: note },
        { type: 'card', id: card },
        'promoted_to',
      )
    })
    const fromNote = await listRefs(owner, { type: 'note', id: note })
    const fromCard = await listRefs(owner, { type: 'card', id: card })
    expect(fromNote).toHaveLength(1)
    expect(fromCard[0]?.id).toBe(fromNote[0]?.id)
    expect(await listRefs(other, { type: 'note', id: note })).toEqual([])
    expect((await failure(unlink(other, fromNote[0]?.id as string))).code).toBe(
      'not_found',
    )
    await unlink(owner, fromNote[0]?.id as string)
    expect(await listRefs(owner, { type: 'note', id: note })).toEqual([])
  })

  describe('Google', () => {
    type Call = { url: string; init?: RequestInit }
    function fakeGoogle(
      options: {
        refreshFails?: boolean
        noRefresh?: boolean
        scopes?: string[]
      } = {},
    ) {
      const calls: Call[] = []
      const http = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = String(input)
        calls.push({ url, init })
        const json = (status: number, body: unknown) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          })
        if (url === 'https://oauth2.googleapis.com/token') {
          const body = new URLSearchParams(String(init?.body))
          if (body.get('grant_type') === 'refresh_token')
            return options.refreshFails
              ? json(400, { error: 'invalid_grant' })
              : json(200, { access_token: 'fresh-access', expires_in: 3600 })
          return json(200, {
            access_token: 'first-access',
            expires_in: 3600,
            ...(options.noRefresh ? {} : { refresh_token: 'refresh-123' }),
            scope: (options.scopes ?? [...GOOGLE_SCOPES]).join(' '),
          })
        }
        if (url.includes('/drive/v3/about'))
          return json(200, { user: { emailAddress: 'owner@example.com' } })
        if (url.includes('/drive/v3/files?q=')) return json(200, { files: [] })
        if (
          url.includes('/drive/v3/files?fields=id') &&
          init?.method === 'POST'
        )
          return json(200, { id: 'folder-1' })
        if (url === 'https://oauth2.googleapis.com/revoke') return json(200, {})
        return json(404, {})
      }) as typeof fetch
      return { http, calls }
    }

    const connect = (http: typeof fetch) =>
      connectGoogle(
        owner,
        {
          code: 'code-1',
          redirectUri: 'http://localhost:8993/api/google/callback',
          verifier: 'v'.repeat(50),
        },
        http,
      )

    test('connecting stores a sealed refresh token, the email and HQ’s folder', async () => {
      const { http, calls } = fakeGoogle()
      const view = await connect(http)
      expect(view).toMatchObject({
        email: 'owner@example.com',
        status: 'connected',
        drive: true,
        calendar: true,
        driveRootId: 'folder-1',
        problem: null,
      })
      const [row] = await handle.db.select().from(googleConnections)
      expect(row?.refreshTokenSealed).not.toBe('refresh-123')
      expect(unseal(row?.refreshTokenSealed as string)).toBe('refresh-123')
      const exchange = new URLSearchParams(String(calls[0]?.init?.body))
      expect(exchange.get('code_verifier')).toBe('v'.repeat(50))
      // The access token from the exchange is cached — no refresh needed yet.
      expect(await googleAccessToken(owner.userId, http)).toBe('first-access')
      expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1)
    })

    test('no refresh token or no Drive scope is refused; missing Calendar is a problem, not a failure', async () => {
      expect(
        (await failure(connect(fakeGoogle({ noRefresh: true }).http))).message,
      ).toContain('long-lived token')
      expect(
        (
          await failure(
            connect(
              fakeGoogle({ scopes: [GOOGLE_SCOPES[1], GOOGLE_SCOPES[2]] }).http,
            ),
          )
        ).message,
      ).toContain('Drive')
      const view = await connect(
        fakeGoogle({ scopes: [GOOGLE_SCOPES[0]] }).http,
      )
      expect(view.calendar).toBe(false)
      expect(view.problem).toContain('Calendar')
    })

    test('a refused refresh marks the connection needs_reauth', async () => {
      await connect(fakeGoogle().http)
      forgetGoogleTokens()
      const refused = await failure(
        googleAccessToken(
          owner.userId,
          fakeGoogle({ refreshFails: true }).http,
        ),
      )
      expect(refused.code).toBe('reauth_required')
      expect((await getGoogleConnection(owner))?.status).toBe('needs_reauth')
      expect(
        (await failure(googleAccessToken(owner.userId, fakeGoogle().http)))
          .code,
      ).toBe('reauth_required')
    })

    test('disconnect revokes at Google and forgets the token; agents can’t connect', async () => {
      const { http, calls } = fakeGoogle()
      await connect(http)
      await disconnectGoogle(owner, http)
      expect(
        calls.some((c) => c.url === 'https://oauth2.googleapis.com/revoke'),
      ).toBe(true)
      const view = await getGoogleConnection(owner)
      expect(view?.status).toBe('revoked')
      expect((await failure(googleAccessToken(owner.userId, http))).code).toBe(
        'reauth_required',
      )
      expect(
        (
          await failure(
            connectGoogle(
              agent,
              { code: 'c', redirectUri: 'x', verifier: 'v' },
              http,
            ),
          )
        ).code,
      ).toBe('forbidden')
    })
  })

  describe('provider connections', () => {
    const etsy = JSON.stringify({
      apiKey: 'keystring-abcd',
      clientId: 'client',
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      expiresAt: '2026-10-01T00:00:00Z',
    })

    test('the owner adds one sealed, sees only its hint, renames and replaces it', async () => {
      const saved = await saveProviderConnection(owner, {
        provider: 'etsy',
        label: 'Shop — main',
        secret: etsy,
      })
      expect([saved.status, saved.secretHint]).toEqual([
        'connected',
        '••••abcd',
      ])
      expect('secretSealed' in saved).toBe(false)
      const [row] = await handle.db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, saved.id))
      expect(row?.secretSealed).not.toContain('keystring')
      expect(JSON.parse(unseal(row?.secretSealed as string)).apiKey).toBe(
        'keystring-abcd',
      )

      const renamed = await saveProviderConnection(owner, {
        connectionId: saved.id,
        expectedRevision: saved.revision,
        provider: 'etsy',
        label: 'Shop',
      })
      expect([renamed.label, renamed.secretHint, renamed.revision]).toEqual([
        'Shop',
        '••••abcd',
        2,
      ])
      // A stale revision is a conflict; a new provider is a new connection.
      expect(
        (
          await failure(
            saveProviderConnection(owner, {
              connectionId: saved.id,
              expectedRevision: 1,
              provider: 'etsy',
              label: 'Shop 2',
            }),
          )
        ).code,
      ).toBe('conflict')
      expect(
        (
          await failure(
            saveProviderConnection(owner, {
              connectionId: saved.id,
              provider: 'youtube',
              label: 'Shop',
            }),
          )
        ).code,
      ).toBe('invalid')

      await handle.db
        .update(providerConnections)
        .set({ status: 'needs_reauth', problem: 'token expired' })
        .where(eq(providerConnections.id, saved.id))
      const replaced = await saveProviderConnection(owner, {
        connectionId: saved.id,
        provider: 'etsy',
        label: 'Shop',
        secret: etsy.replace('token-1', 'token-2'),
      })
      expect([replaced.status, replaced.problem]).toEqual(['connected', null])
      const actions = await handle.db
        .select({
          action: opsAuditEvents.action,
          changes: opsAuditEvents.changes,
        })
        .from(opsAuditEvents)
        .where(eq(opsAuditEvents.targetId, saved.id))
      expect(actions.map((entry) => entry.action).sort()).toEqual([
        'connection.create',
        'connection.update',
        'connection.update',
      ])
      expect(JSON.stringify(actions)).not.toContain('token-2')
    })

    test('Etsy’s secret must be its JSON; a new one needs a secret; names are unique per provider', async () => {
      expect(
        (
          await failure(
            saveProviderConnection(owner, {
              provider: 'etsy',
              label: 'Shop',
              secret: 'not json',
            }),
          )
        ).code,
      ).toBe('invalid')
      expect(
        (
          await failure(
            saveProviderConnection(owner, {
              provider: 'etsy',
              label: 'Shop',
              secret: JSON.stringify({ apiKey: 'k' }),
            }),
          )
        ).code,
      ).toBe('invalid')
      expect(
        (
          await failure(
            saveProviderConnection(owner, { provider: 'youtube', label: 'YT' }),
          )
        ).code,
      ).toBe('invalid')
      await saveProviderConnection(owner, {
        provider: 'youtube',
        label: 'Channel',
        secret: 'ya29.token-wxyz',
      })
      const duplicate = await failure(
        saveProviderConnection(owner, {
          provider: 'youtube',
          label: 'Channel',
          secret: 'ya29.other',
        }),
      )
      expect(duplicate.code).toBe('invalid')
      expect(duplicate.message).toContain('already exists')
      // The same name under another provider is fine.
      await saveProviderConnection(owner, {
        provider: 'tiktok',
        label: 'Channel',
        secret: 'act.token',
      })
    })

    test('revoking drops the secret; agents and other owners can’t touch one', async () => {
      const saved = await saveProviderConnection(owner, {
        provider: 'facebook',
        label: 'Page',
        secret: 'EAAB-token-1234',
      })
      expect(
        (
          await failure(
            saveProviderConnection(agent, {
              provider: 'facebook',
              label: 'Agent page',
              secret: 'x',
            }),
          )
        ).code,
      ).toBe('forbidden')
      expect(
        (
          await failure(
            revokeProviderConnection(agent, { connectionId: saved.id }),
          )
        ).code,
      ).toBe('forbidden')
      expect(
        (
          await failure(
            revokeProviderConnection(other, { connectionId: saved.id }),
          )
        ).code,
      ).toBe('not_found')
      expect(await listProviderConnections(other)).toEqual([])

      await revokeProviderConnection(owner, { connectionId: saved.id })
      const [row] = await handle.db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, saved.id))
      expect([row?.status, row?.secretSealed]).toEqual(['revoked', null])
      expect(await listProviderConnections(owner)).toEqual([])
      // Its name is free again.
      await saveProviderConnection(owner, {
        provider: 'facebook',
        label: 'Page',
        secret: 'EAAB-token-5678',
      })
    })
  })
})
