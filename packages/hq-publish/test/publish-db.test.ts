import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { moneySources, subjectProvider } from '@theiceji/hq-core/readings'
import {
  assetAssets,
  opsReleaseAuthorizations,
  providerConnections,
  publishReadings,
  refs,
} from '@theiceji/hq-db/schema'
import { savePolicy } from '@theiceji/hq-ops/policy'
import { seal } from '@theiceji/hq-ops/secrets'
import {
  closeTestDb,
  dbTestsEnabled,
  failure,
  pgError,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import { and, eq, sql } from 'drizzle-orm'
import {
  type PublishAdapter,
  RemoteUnknown,
  registerPublishAdapter,
  resetPublishAdapters,
} from '../src/adapters'
import {
  authorizePost,
  deletePost,
  dispatchPost,
  getPost,
  listAccounts,
  listPosts,
  markRemoved,
  planPost,
  publishSummaries,
  reconcilePublishing,
  recordManualPost,
  saveAccount,
  unschedulePost,
  updatePost,
} from '../src/publish'
import { recordReading } from '../src/readings'
import '../src/register'

/**
 * Publish against Postgres. Destructive (truncates), so it runs only with
 * PUBLISH_DB_TESTS=1 and a localhost DATABASE_URL — a throwaway database.
 */

const suite = dbTestsEnabled('PUBLISH_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'publish_readings',
  'publish_intents',
  'publish_posts',
  'publish_accounts',
  'asset_assets',
]

process.env.HQ_SEALING_KEY ??= Buffer.alloc(32, 7).toString('base64')

const HOUR = 3_600_000

suite('hq-publish against Postgres', () => {
  let w: World

  beforeEach(async () => {
    w = await resetWorld(TABLES, { kind: 'channel' })
  })
  afterEach(() => resetPublishAdapters())
  afterAll(() => closeTestDb(TABLES))

  async function file(
    name = 'hook.mp4',
    origin: 'upload' | 'generated' = 'upload',
  ) {
    const [row] = await w.db
      .insert(assetAssets)
      .values({
        ownerId: w.owner.userId,
        createdBy: w.owner.userId,
        projectId: w.project.id,
        storageProvider: 'r2',
        storageKey: `k/${crypto.randomUUID()}`,
        path: `pilot/${name}`,
        name,
        kind: 'video',
        mime: 'video/mp4',
        bytes: 2048,
        sha256: 'a'.repeat(64),
        origin,
        status: 'ready',
        readyAt: sql`now()`,
        actorType: 'user',
        actorId: w.owner.userId,
      })
      .returning()
    if (!row) throw new Error('no asset')
    return row
  }

  const account = (platform: 'tiktok' | 'youtube' | 'manual' = 'tiktok') =>
    saveAccount(w.owner, {
      projectId: w.project.id,
      platform,
      handle: platform === 'youtube' ? 'Desk Channel' : '@deskhooks',
    })

  test('accounts are the owner’s; readiness says how posts get out', async () => {
    const tiktok = await account()
    const error = await failure(
      saveAccount(w.agent, {
        projectId: w.project.id,
        platform: 'youtube',
        handle: 'Other',
      }),
    )
    expect(error.code).toBe('forbidden')
    const [view] = await listAccounts(w.owner, { projectId: w.project.id })
    expect(view?.id).toBe(tiktok.id)
    expect(view?.readiness.mode).toBe('manual')
    expect(view?.readiness.note).toContain('by hand')
  })

  test('plan → clear → record by hand, with evidence; planned is never posted', async () => {
    const tiktok = await account()
    const other = await account('youtube')
    const video = await file()
    // Publishing names the accounts it may post to — here only the other one.
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['draft', 'publish'],
      allowedAccountIds: [other.id],
    })
    const post = await planPost(w.agent, {
      projectId: w.project.id,
      accountId: tiktok.id,
      assetId: video.id,
      caption: 'Wrist pain at work? #desk',
      idempotencyKey: 'plan-post-0001',
    })
    expect(post.status).toBe('planned')
    // Same key, same request → the same post.
    const again = await planPost(w.agent, {
      projectId: w.project.id,
      accountId: tiktok.id,
      assetId: video.id,
      caption: 'Wrist pain at work? #desk',
      idempotencyKey: 'plan-post-0001',
    })
    expect(again.id).toBe(post.id)

    // An agent posts only where the policy says, and only what was cleared.
    const cleared0 = await authorizePost(w.owner, { postId: post.id })
    const elsewhere = await failure(
      recordManualPost(w.agent, {
        postId: post.id,
        url: 'https://www.tiktok.com/@deskhooks/video/1',
      }),
    )
    expect(elsewhere.message).toContain('doesn’t allow posting to @deskhooks')
    await unschedulePost(w.owner, {
      postId: post.id,
      expectedRevision: cleared0.post.revision,
    })
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 1,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['draft', 'publish'],
      allowedAccountIds: [tiktok.id, other.id],
    })
    const blocked = await failure(
      recordManualPost(w.agent, {
        postId: post.id,
        url: 'https://www.tiktok.com/@deskhooks/video/1',
      }),
    )
    expect(blocked.code).toBe('policy_blocked')

    // The policy doesn't let agents release: an agent can't clear it.
    const byPolicy = await failure(authorizePost(w.agent, { postId: post.id }))
    expect(byPolicy.code).toBe('policy_blocked')

    const cleared = await authorizePost(w.owner, { postId: post.id })
    expect(cleared.blockers).toEqual([])
    expect(cleared.post.status).toBe('scheduled')
    expect(cleared.authorization?.approvedBy).toBe(w.owner.userId)

    const out = await recordManualPost(w.agent, {
      postId: post.id,
      url: 'https://www.tiktok.com/@deskhooks/video/1',
      idempotencyKey: 'record-0001',
    })
    expect(out.status).toBe('posted')
    expect(out.evidenceLevel).toBe('agent_attested')
    expect(out.postedAt).not.toBeNull()
    const auths = await w.db
      .select()
      .from(opsReleaseAuthorizations)
      .where(eq(opsReleaseAuthorizations.subjectId, post.id))
    // The first was taken back; the second was used up by the record.
    expect(auths.map((row) => row.status).sort()).toEqual([
      'consumed',
      'revoked',
    ])

    const rows = await listPosts(w.owner, { projectId: w.project.id })
    expect(rows[0]?.status).toBe('posted')
    expect(rows[0]?.clearance).toBeNull()
    const [summary] = await publishSummaries(w.owner)
    expect(summary?.posted7d).toBe(1)
  })

  test('the platform’s rules and the file block a clearance, in words', async () => {
    const youtube = await account('youtube')
    const generated = await file('gen.mp4', 'generated')
    const post = await planPost(w.owner, {
      projectId: w.project.id,
      accountId: youtube.id,
      assetId: generated.id,
      caption: 'x',
      disclosure: { aiGenerated: false },
    })
    const outcome = await authorizePost(w.owner, { postId: post.id })
    expect(outcome.authorization).toBeNull()
    expect(outcome.blockers.map((entry) => entry.key).sort()).toEqual([
      'disclosure_ai',
      'title_missing',
    ])
    // A generated file carries the AI disclosure by default.
    const fresh = await planPost(w.owner, {
      projectId: w.project.id,
      accountId: youtube.id,
      assetId: generated.id,
      title: 'Desk setup in 30s',
    })
    expect(fresh.disclosure.aiGenerated).toBe(true)
  })

  test('editing a cleared post revokes the clearance and says why', async () => {
    const tiktok = await account()
    const video = await file()
    const post = await planPost(w.owner, {
      projectId: w.project.id,
      accountId: tiktok.id,
      assetId: video.id,
      caption: 'v1',
    })
    const cleared = await authorizePost(w.owner, { postId: post.id })
    // Only the time changes — the clearance still fits.
    const moved = await updatePost(w.owner, {
      postId: post.id,
      expectedRevision: cleared.post.revision,
      scheduledFor: '2026-12-01T10:00',
    })
    expect(moved.status).toBe('scheduled')
    const edited = await updatePost(w.owner, {
      postId: post.id,
      expectedRevision: moved.revision,
      caption: 'v2',
    })
    expect(edited.status).toBe('planned')
    expect(edited.statusReason).toContain('Changed after it was cleared')
    const auths = await w.db
      .select()
      .from(opsReleaseAuthorizations)
      .where(eq(opsReleaseAuthorizations.subjectId, post.id))
    expect(auths.map((row) => row.status)).toEqual(['revoked'])
    // Take back and delete are the owner's plan tools.
    const again = await authorizePost(w.owner, { postId: post.id })
    const back = await unschedulePost(w.owner, {
      postId: post.id,
      expectedRevision: again.post.revision,
    })
    expect(back.status).toBe('planned')
    const refused = await failure(
      deletePost(w.agent, { postId: post.id, expectedRevision: back.revision }),
    )
    expect(refused.code).toBe('forbidden')
    await deletePost(w.owner, {
      postId: post.id,
      expectedRevision: back.revision,
    })
    expect(await listPosts(w.owner, { projectId: w.project.id })).toHaveLength(
      0,
    )
  })

  test('a card becomes a post through refs', async () => {
    const tiktok = await account()
    const card = crypto.randomUUID()
    const post = await planPost(w.owner, {
      projectId: w.project.id,
      accountId: tiktok.id,
      caption: 'from a card',
      fromCardId: card,
    })
    const edges = await w.db
      .select()
      .from(refs)
      .where(and(eq(refs.toType, 'post'), eq(refs.toId, post.id)))
    expect(
      edges.map((edge) => [edge.fromType, edge.fromId, edge.role]),
    ).toEqual([['card', card, 'published_as']])
  })

  async function postedHoursAgo(hours: number, caption = 'out') {
    const tiktok =
      (await listAccounts(w.owner, { projectId: w.project.id }))[0] ??
      (await account())
    const post = await planPost(w.owner, {
      projectId: w.project.id,
      accountId: tiktok.id,
      caption,
    })
    return recordManualPost(w.owner, {
      postId: post.id,
      url: `https://www.tiktok.com/@deskhooks/video/${crypto.randomUUID()}`,
      postedAt: new Date(Date.now() - hours * HOUR),
    })
  }

  test('readings: at an age, too young, not read — and corrections supersede', async () => {
    const post = await postedHoursAgo(100)
    const postedAt = post.postedAt as Date
    const early = await recordReading(w.owner, {
      postId: post.id,
      metric: 'views',
      value: 120,
      asOf: new Date(postedAt.getTime() + 1 * HOUR),
    })
    const provider = subjectProvider('post')
    if (!provider) throw new Error('no post provider')
    let read = await provider.atAge(
      w.db,
      w.owner.userId,
      [post.id],
      'views',
      72,
      new Date(),
    )
    expect(read.get(post.id)?.state).toBe('not_read')
    const at72 = await recordReading(w.owner, {
      postId: post.id,
      metric: 'views',
      value: '1,250',
      asOf: new Date(postedAt.getTime() + 71 * HOUR),
    })
    read = await provider.atAge(
      w.db,
      w.owner.userId,
      [post.id],
      'views',
      72,
      new Date(),
    )
    expect(read.get(post.id)).toMatchObject({
      state: 'known',
      value: '1250.0000',
    })
    read = await provider.atAge(
      w.db,
      w.owner.userId,
      [post.id],
      'views',
      500,
      new Date(),
    )
    expect(read.get(post.id)?.state).toBe('too_young')

    const fixed = await recordReading(w.owner, {
      postId: post.id,
      metric: 'views',
      value: 1300,
      asOf: new Date(postedAt.getTime() + 71 * HOUR),
      supersedesId: at72.id,
      correctionReason: 'Read the wrong row off the export.',
    })
    expect(fixed.supersedesId).toBe(at72.id)
    read = await provider.atAge(
      w.db,
      w.owner.userId,
      [post.id],
      'views',
      72,
      new Date(),
    )
    expect(read.get(post.id)).toMatchObject({
      state: 'known',
      value: '1300.0000',
    })
    const twice = await failure(
      recordReading(w.owner, {
        postId: post.id,
        metric: 'views',
        value: 1,
        asOf: new Date(),
        supersedesId: at72.id,
        correctionReason: 'again',
      }),
    )
    expect(twice.message).toContain('already corrected')

    // History is append-only in the database itself.
    const locked = await failure(
      w.db
        .update(publishReadings)
        .set({ value: '1' })
        .where(eq(publishReadings.id, early.id)),
    )
    expect(pgError(locked).code).toBe('23001')

    const detail = await getPost(w.owner, post.id)
    expect(detail.latest.views?.value).toBe('1300.0000')
    expect(
      detail.readings.find((row) => row.id === at72.id)?.supersededBy,
    ).toBe(fixed.id)
  })

  test('money readings are spans, never overlap, and count as earnings', async () => {
    const post = await postedHoursAgo(200)
    const start = new Date((post.postedAt as Date).getTime() + HOUR)
    const end = new Date(start.getTime() + 48 * HOUR)
    await recordReading(w.owner, {
      postId: post.id,
      metric: 'earnings',
      value: '350.50',
      currency: 'THB',
      windowStart: start,
      windowEnd: end,
    })
    const overlap = await failure(
      recordReading(w.owner, {
        postId: post.id,
        metric: 'earnings',
        value: '10',
        currency: 'THB',
        windowStart: new Date(start.getTime() + HOUR),
        windowEnd: new Date(end.getTime() + HOUR),
      }),
    )
    expect(overlap.message).toContain('overlaps')
    const lifetimeMoney = await failure(
      recordReading(w.owner, {
        postId: post.id,
        metric: 'earnings',
        value: '1',
        currency: 'THB',
      }),
    )
    expect(lifetimeMoney.message).toContain('span')
    const source = moneySources().find((entry) => entry.module === 'publish')
    const lines = await source?.lines(w.db, w.owner.userId, {
      from: new Date(Date.now() - 400 * HOUR),
      to: new Date(),
      projectId: null,
    })
    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'earnings',
        amount: '350.5000',
        currency: 'THB',
      }),
    ])
  })

  test('a reading of a plan is refused; removal is on the record', async () => {
    const tiktok = await account()
    const post = await planPost(w.owner, {
      projectId: w.project.id,
      accountId: tiktok.id,
      caption: 'plan',
    })
    const error = await failure(
      recordReading(w.owner, { postId: post.id, metric: 'views', value: 1 }),
    )
    expect(error.message).toContain('hasn’t gone out')
    const out = await postedHoursAgo(5)
    const gone = await markRemoved(w.owner, {
      postId: out.id,
      expectedRevision: out.revision,
      reason: 'Muted for music',
    })
    expect(gone.status).toBe('removed')
    expect(gone.removedAt).not.toBeNull()
  })

  test('API dispatch: none without an adapter; verified, or unknown then reconciled', async () => {
    const tiktok = await account()
    const video = await file()
    const post = await planPost(w.owner, {
      projectId: w.project.id,
      accountId: tiktok.id,
      assetId: video.id,
      caption: 'API',
    })
    await authorizePost(w.owner, { postId: post.id })
    const none = await failure(
      dispatchPost(w.owner, {
        postId: post.id,
        idempotencyKey: 'dispatch-0001',
      }),
    )
    expect(none.code).toBe('capability_unavailable')

    let answer: 'ok' | 'timeout' = 'timeout'
    const fake: PublishAdapter = {
      platform: 'tiktok',
      label: 'Fake TikTok',
      async submit(payload, context) {
        expect(context.connection.secret).toBe('token-123')
        expect(payload.asset?.sha256).toBe('a'.repeat(64))
        if (answer === 'timeout') throw new RemoteUnknown('no answer')
        return {
          remotePostId: '777',
          remoteUrl: 'https://www.tiktok.com/@deskhooks/video/777',
          publishedAt: new Date(),
          verified: true,
        }
      },
      async lookup() {
        return {
          state: 'found',
          remotePostId: '778',
          remoteUrl: 'https://www.tiktok.com/@deskhooks/video/778',
          publishedAt: new Date(),
          fields: { caption: 'API' },
        }
      },
    }
    registerPublishAdapter(fake)
    const noConnection = await failure(
      dispatchPost(w.owner, {
        postId: post.id,
        idempotencyKey: 'dispatch-0002',
      }),
    )
    expect(noConnection.code).toBe('capability_unavailable')
    const [connection] = await w.db
      .insert(providerConnections)
      .values({
        ownerId: w.owner.userId,
        createdBy: w.owner.userId,
        provider: 'tiktok',
        label: 'TikTok (test)',
        secretSealed: seal('token-123'),
        status: 'connected',
      })
      .returning()
    const current = (await getPost(w.owner, post.id)).account
    await saveAccount(w.owner, {
      projectId: w.project.id,
      accountId: current.id,
      expectedRevision: current.revision,
      platform: 'tiktok',
      handle: current.handle,
      connectionId: connection?.id,
    })
    expect(
      (await listAccounts(w.owner, { projectId: w.project.id }))[0]?.readiness
        .mode,
    ).toBe('api')

    const sent = await dispatchPost(w.owner, {
      postId: post.id,
      idempotencyKey: 'dispatch-0003',
    })
    expect(sent.result).toBe('unknown')
    expect(sent.post.status).toBe('dispatched')
    // The clearance was used; nothing sends it twice.
    const twice = await failure(
      dispatchPost(w.owner, {
        postId: post.id,
        idempotencyKey: 'dispatch-0004',
      }),
    )
    expect(twice.message).toContain('dispatched')

    await w.db.execute(
      sql`update publish_intents set next_attempt_at = now() - interval '1 second'`,
    )
    const tally = await reconcilePublishing({ ownerId: w.owner.userId })
    expect(tally.verified).toBe(1)
    const detail = await getPost(w.owner, post.id)
    expect(detail.post.status).toBe('verified')
    expect(detail.post.evidenceLevel).toBe('provider_verified')
    expect(detail.post.externalId).toBe('778')
    expect(detail.intents[0]?.status).toBe('verified')

    // And a second post goes straight to verified.
    answer = 'ok'
    const next = await planPost(w.owner, {
      projectId: w.project.id,
      accountId: tiktok.id,
      assetId: video.id,
      caption: 'API 2',
    })
    await authorizePost(w.owner, { postId: next.id })
    const live = await dispatchPost(w.owner, {
      postId: next.id,
      idempotencyKey: 'dispatch-0005',
    })
    expect(live.result).toBe('verified')
    expect(live.post.url).toContain('/777')
  })

  test('someone else’s post reads as not found; a lapsed clearance returns to planned', async () => {
    const tiktok = await account('manual')
    const post = await planPost(w.owner, {
      projectId: w.project.id,
      accountId: tiktok.id,
      caption: 'mine',
    })
    expect((await failure(getPost(w.stranger, post.id))).code).toBe('not_found')
    await authorizePost(w.owner, { postId: post.id })
    await w.db.execute(
      sql`update ops_release_authorizations set status = 'expired', status_reason = 'test'`,
    )
    const tally = await reconcilePublishing({ ownerId: w.owner.userId })
    expect(tally.lapsed).toBe(1)
    const detail = await getPost(w.owner, post.id)
    expect(detail.post.status).toBe('planned')
    expect(detail.post.statusReason).toContain('expired')
  })
})
