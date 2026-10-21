import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  type OpsPolicyRow,
  opsBudgetReservations,
  opsReleaseAuthorizations,
  type ProjectRow,
  projects,
} from '@theiceji/hq-db/schema'
import { eq, sql } from 'drizzle-orm'
import {
  expireReservations,
  getBudgetStatus,
  recordUsage,
  releaseReservation,
  reserveBudget,
  settleReservation,
} from '../src/budget'
import { latestCapabilities, recordCapabilityCheck } from '../src/capabilities'
import { notFound } from '../src/errors'
import {
  engageKillSwitch,
  registerPolicyExtension,
  releaseKillSwitch,
  savePolicy,
} from '../src/policy'
import { currentPolicy } from '../src/policy-gate'
import {
  checkAuthorizationStillValid,
  consumeAuthorization,
  createAuthorization,
  expireAuthorizations,
  type ReleaseSubjectState,
  registerReleaseEvaluator,
  revokeAuthorization,
} from '../src/release'
import { withTransaction } from '../src/store'
import {
  count,
  failure,
  pgError,
  policyInput,
  setupWorld,
  suite,
  teardown,
  type World,
} from './helpers'

/**
 * Money, releases and capabilities against Postgres: an unknown price is
 * never free and limits count live holds (AO08); a release authorization is
 * a person's approval or a named policy revision, fits one exact payload and
 * is used once (AO06, AO07, AO11); usage and capability checks are
 * append-only.
 */

suite('ops budget, release authorizations and capabilities (Postgres)', () => {
  let w: World
  let project: ProjectRow
  let revision = 0
  const accountId = crypto.randomUUID()
  const subjects = new Map<string, ReleaseSubjectState & { ownerId: string }>()

  async function policy(overrides: Record<string, unknown> = {}) {
    const saved = await savePolicy(
      w.owner,
      w.projectId,
      policyInput(revision, [w.agent.grantId], {
        allowedActions: ['draft', 'generate', 'import'],
        cashLimitPerJob: '50',
        cashLimitPerDay: '80',
        cashLimitPerMonth: '1,000',
        unitLimits: {
          'agent:fal:credits': { perJob: 10, perDay: 15, perMonth: 100 },
        },
        ...overrides,
      }),
    )
    revision = saved.revisionNo
    return saved
  }

  const reserve = (
    current: OpsPolicyRow,
    amount: number | null,
    extra: Record<string, unknown> = {},
  ) =>
    withTransaction((tx) =>
      reserveBudget(tx, w.agent, project, current, {
        spend: { kind: 'cash', unit: 'THB', amount },
        provider: 'agent:fal',
        purpose: 'image render',
        ...extra,
      }),
    )

  function subject(state: Partial<ReleaseSubjectState> = {}): {
    id: string
    hash: string
  } {
    const id = crypto.randomUUID()
    const hash = `hash-${id.slice(0, 8)}`
    subjects.set(id, {
      ownerId: w.owner.userId,
      payloadHash: hash,
      asset: { id: crypto.randomUUID(), sha256: 'a'.repeat(64) },
      targetRef: accountId,
      qualityCheckIds: [],
      blockers: [],
      ...state,
    })
    return { id, hash }
  }

  const authorization = (
    id: string,
    hash: string,
    mode: 'human_approval' | 'policy_gated',
  ) => ({
    module: 'publish',
    subjectType: 'post',
    subjectId: id,
    payloadHash: hash,
    mode,
  })

  beforeAll(async () => {
    w = await setupWorld('money')
    const [row] = await w.db
      .select()
      .from(projects)
      .where(eq(projects.id, w.projectId))
    if (!row) throw new Error('no project')
    project = row
    registerReleaseEvaluator('publish', 'post', async (_reader, actor, ref) => {
      const state = subjects.get(ref.id)
      if (!state || state.ownerId !== actor.userId) throw notFound('Post')
      const { ownerId: _owner, ...rest } = state
      return rest
    })
  })

  afterAll(async () => {
    await teardown()
  })

  test('an unknown price is never free; per-job, daily and missing limits stop spend before anything is held', async () => {
    const current = await policy()
    const unknown = await failure(reserve(current, null))
    expect(unknown.code).toBe('budget_exceeded')
    expect(unknown.details?.reason).toBe('unknown_price')
    expect(unknown.message).toContain('agents_request_human')
    const tooBig = await failure(reserve(current, 6000))
    expect(tooBig.details?.reason).toBe('per-job_limit')
    const otherUnit = await failure(
      withTransaction((tx) =>
        reserveBudget(tx, w.agent, project, current, {
          spend: { kind: 'credits', unit: 'agent:other:credits', amount: 1 },
          provider: 'agent:other',
          purpose: 'render',
        }),
      ),
    )
    expect(otherUnit.details?.reason).toBe('no_limit')
    expect(
      await count(
        w.db,
        sql`select count(*)::int as n from ops_budget_reservations`,
      ),
    ).toBe(0)

    const first = await reserve(current, 4000)
    expect(first.status).toBe('reserved')
    expect(first.policyId).toBe(current.id)
    const second = await reserve(current, 4000)
    const third = await failure(reserve(current, 1000))
    expect(third.code).toBe('budget_exceeded')
    expect(third.details?.reason).toBe('daily_limit')
    expect(third.details?.committed).toBe(8000)

    // Settled at what it cost; the other hold released: room again.
    await withTransaction((tx) =>
      settleReservation(tx, w.agent, first.id, 3000, 'Provider charged 30'),
    )
    expect(
      (
        await failure(
          withTransaction((tx) =>
            settleReservation(tx, w.agent, first.id, 3000, 'again'),
          ),
        )
      ).code,
    ).toBe('conflict')
    const released = await withTransaction((tx) =>
      releaseReservation(tx, w.agent, second.id, 'Cancelled before submit'),
    )
    expect(released?.status).toBe('released')
    const fourth = await reserve(current, 5000)
    expect(fourth.amount).toBe(5000)
    expect((await failure(reserve(current, 1))).details?.reason).toBe(
      'daily_limit',
    )
    // Credits count against their own unit limit.
    const credits = (amount: number) =>
      withTransaction((tx) =>
        reserveBudget(tx, w.agent, project, current, {
          spend: { kind: 'credits', unit: 'agent:fal:credits', amount },
          provider: 'agent:fal',
          purpose: 'render',
          ttlSeconds: 60,
        }),
      )
    const held = await credits(10)
    expect((await failure(credits(6))).details?.reason).toBe('daily_limit')

    // A hold past its expiry stops counting once the tick expires it.
    await w.db.execute(
      sql`update ops_budget_reservations set expires_at = now() - interval '1 minute' where id = ${held.id}`,
    )
    const expired = await expireReservations({ ownerId: w.owner.userId })
    expect(expired).toContain(held.id)
    expect((await credits(6)).status).toBe('reserved')

    const status = await getBudgetStatus(w.owner, w.projectId)
    const cash = status.lines.find((line) => line.kind === 'cash')
    expect(cash?.day.committed).toBe(8000)
    expect(cash?.day.available).toBe(0)
    expect(status.policyRevision).toBe(current.revisionNo)
    expect((await failure(getBudgetStatus(w.stranger, w.projectId))).code).toBe(
      'not_found',
    )
  })

  test('no-project work spends under the owner’s no-project policy; a policy of another scope is refused', async () => {
    const loose = await savePolicy(
      w.owner,
      null,
      policyInput(0, [w.agent.grantId], { allowedActions: ['generate'] }),
    )
    expect(loose.currency).toBe('THB')
    const none = await failure(
      withTransaction((tx) =>
        reserveBudget(tx, w.agent, null, loose, {
          spend: { kind: 'cash', unit: 'THB', amount: 100 },
          provider: 'agent:fal',
          purpose: 'render',
        }),
      ),
    )
    expect(none.details?.reason).toBe('per-job_limit')
    const free = await withTransaction((tx) =>
      reserveBudget(tx, w.agent, null, loose, {
        spend: { kind: 'cash', unit: 'THB', amount: 0 },
        provider: 'agent:fal',
        purpose: 'free render',
      }),
    )
    expect(free.projectId).toBeNull()
    const current = await withTransaction((tx) =>
      currentPolicy(tx, w.owner.userId, w.projectId),
    )
    if (!current) throw new Error('no policy')
    expect(
      (
        await failure(
          withTransaction((tx) =>
            reserveBudget(tx, w.agent, null, current, {
              spend: { kind: 'cash', unit: 'THB', amount: 0 },
              provider: 'agent:fal',
              purpose: 'x',
            }),
          ),
        )
      ).code,
    ).toBe('invalid')
  })

  test('usage is append-only and records tokens; an unknown cost has no amount', async () => {
    const usage = await withTransaction((tx) =>
      recordUsage(tx, w.agent, project, {
        subjectType: 'agent_run',
        subjectId: crypto.randomUUID(),
        provider: 'llm:anthropic',
        kind: 'credits',
        unit: 'llm:anthropic:tokens',
        quantity: 1,
        costMinor: 120,
        currency: 'THB',
        costStatus: 'estimated',
        tokens: 12_345,
      }),
    )
    expect(usage.tokens).toBe(12_345)
    expect(usage.ownerId).toBe(w.owner.userId)
    expect(
      (
        await failure(
          withTransaction((tx) =>
            recordUsage(tx, w.agent, project, {
              subjectType: 'agent_run',
              subjectId: crypto.randomUUID(),
              provider: 'x',
              kind: 'cash',
              unit: 'THB',
              costMinor: 5,
              currency: 'THB',
              costStatus: 'unknown',
            }),
          ),
        )
      ).code,
    ).toBe('invalid')
    const update = pgError(
      await failure(
        w.db.execute(sql`update ops_usage_events set cost_minor = 0`),
      ),
    )
    expect(update.code).toBe('23001')
    expect(update.message).toContain('append-only')
  })

  test('a human release is the owner’s approval of one exact payload; an agent can’t give one', async () => {
    const post = subject()
    const agentTry = await failure(
      createAuthorization(
        w.agent,
        w.projectId,
        authorization(post.id, post.hash, 'human_approval'),
      ),
    )
    expect(agentTry.code).toBe('forbidden')
    expect(agentTry.message).toContain('agents_request_human')

    const drifted = await createAuthorization(
      w.owner,
      w.projectId,
      authorization(post.id, 'hash-prepared-earlier', 'human_approval'),
    )
    expect(drifted.ok).toBe(false)
    expect(drifted.blockers.map((entry) => entry.key)).toContain(
      'payload_changed',
    )
    const blockedPost = subject({
      blockers: [{ key: 'qa:claims', message: 'An unsupported claim.' }],
    })
    const qa = await createAuthorization(
      w.owner,
      w.projectId,
      authorization(blockedPost.id, blockedPost.hash, 'human_approval'),
    )
    expect(qa.blockers.map((entry) => entry.key)).toEqual(['qa:claims'])

    const issued = await createAuthorization(
      w.owner,
      w.projectId,
      authorization(post.id, post.hash, 'human_approval'),
    )
    if (!issued.ok) throw new Error(JSON.stringify(issued.blockers))
    expect(issued.authorization.mode).toBe('human_approval')
    expect(issued.authorization.approvedBy).toBe(w.owner.userId)
    expect(issued.authorization.policyId).toBeNull()
    expect(issued.authorization.targetRef).toBe(accountId)

    // A second authorization supersedes the first.
    const again = await createAuthorization(
      w.owner,
      w.projectId,
      authorization(post.id, post.hash, 'human_approval'),
    )
    if (!again.ok) throw new Error('not issued')
    const [first] = await w.db
      .select()
      .from(opsReleaseAuthorizations)
      .where(eq(opsReleaseAuthorizations.id, issued.authorization.id))
    expect(first?.status).toBe('revoked')

    // Consumed once, for exactly the payload and bytes authorized.
    const consume = (extra: Record<string, unknown>) =>
      withTransaction((tx) =>
        consumeAuthorization(tx, w.owner, {
          authorizationId: again.authorization.id,
          payloadHash: post.hash,
          ...extra,
        }),
      )
    const wrongHash = await failure(consume({ payloadHash: 'hash-other' }))
    expect(wrongHash.code).toBe('policy_blocked')
    const mismatch = (wrongHash.details?.blockers ?? []) as { key: string }[]
    expect(mismatch.map((entry) => entry.key)).toContain(
      'authorization_payload_mismatch',
    )
    expect((await failure(consume({ assetSha256: 'b'.repeat(64) }))).code).toBe(
      'policy_blocked',
    )
    const consumed = await consume({ assetSha256: 'a'.repeat(64) })
    expect(consumed.status).toBe('consumed')
    expect(consumed.consumedAt).toBeInstanceOf(Date)
    const twice = await failure(consume({}))
    expect(twice.code).toBe('policy_blocked')
    expect(twice.message).toContain('consumed')

    // The guard: only the state moves, and never back.
    const retarget = pgError(
      await failure(
        w.db.execute(
          sql`update ops_release_authorizations set target_ref = 'elsewhere' where id = ${again.authorization.id}`,
        ),
      ),
    )
    expect(retarget.code).toBe('23001')
    expect(retarget.message).toContain('final')
    const other = subject()
    const live = await createAuthorization(
      w.owner,
      w.projectId,
      authorization(other.id, other.hash, 'human_approval'),
    )
    if (!live.ok) throw new Error('not issued')
    const moved = pgError(
      await failure(
        w.db.execute(
          sql`update ops_release_authorizations set payload_hash = 'swapped' where id = ${live.authorization.id}`,
        ),
      ),
    )
    expect(moved.code).toBe('23001')
    expect(moved.message).toContain('only the state')
    const removed = pgError(
      await failure(
        w.db.execute(
          sql`delete from ops_release_authorizations where id = ${live.authorization.id}`,
        ),
      ),
    )
    expect(removed.code).toBe('23001')

    const revoked = await revokeAuthorization(w.owner, live.authorization.id, {
      reason: 'Changed my mind',
    })
    expect(revoked.status).toBe('revoked')
    expect(
      (
        await failure(
          revokeAuthorization(w.owner, live.authorization.id, { reason: 'x' }),
        )
      ).code,
    ).toBe('invalid')
    expect(
      (
        await failure(
          createAuthorization(
            w.stranger,
            w.projectId,
            authorization(post.id, post.hash, 'human_approval'),
          ),
        )
      ).code,
    ).toBe('not_found')
  })

  test('a policy-gated release needs policy_gated mode, authorize_release and the target in the policy; it names the revision', async () => {
    const post = subject()
    const request = authorization(post.id, post.hash, 'policy_gated')
    // No authorize_release: refused at the gate, before anything is evaluated.
    expect(
      (await failure(createAuthorization(w.agent, w.projectId, request))).code,
    ).toBe('policy_blocked')
    await policy({
      allowedActions: ['draft', 'generate', 'import', 'authorize_release'],
      allowedAccountIds: [accountId],
    })
    const humanMode = await createAuthorization(w.agent, w.projectId, request)
    expect(humanMode.blockers.map((entry) => entry.key)).toContain(
      'human_approval_required',
    )
    const gated = await policy({
      releaseMode: 'policy_gated',
      allowedActions: ['draft', 'generate', 'import', 'authorize_release'],
      allowedAccountIds: [accountId],
    })
    const elsewhere = subject({ targetRef: crypto.randomUUID() })
    const notAllowed = await createAuthorization(
      w.agent,
      w.projectId,
      authorization(elsewhere.id, elsewhere.hash, 'policy_gated'),
    )
    expect(notAllowed.blockers.map((entry) => entry.key)).toContain(
      'target_not_allowed',
    )
    const issued = await createAuthorization(w.agent, w.projectId, request)
    if (!issued.ok) throw new Error(JSON.stringify(issued.blockers))
    expect(issued.authorization.mode).toBe('policy_gated')
    expect(issued.authorization.policyId).toBe(gated.id)
    expect(issued.authorization.approvedBy).toBeNull()
    expect(issued.authorization.actorId).toBe(w.agent.id)

    // A new policy revision voids what the old one authorized.
    await policy({
      releaseMode: 'policy_gated',
      allowedActions: ['draft', 'generate', 'import', 'authorize_release'],
      allowedAccountIds: [accountId],
      note: 'tweaked',
    })
    const stale = await withTransaction((tx) =>
      checkAuthorizationStillValid(tx, issued.authorization, {
        payloadHash: post.hash,
      }),
    )
    expect(stale.map((entry) => entry.key)).toEqual(['policy_changed'])
    expect(
      (
        await failure(
          withTransaction((tx) =>
            consumeAuthorization(tx, w.agent, {
              authorizationId: issued.authorization.id,
              payloadHash: post.hash,
            }),
          ),
        )
      ).code,
    ).toBe('policy_blocked')
  })

  test('a kill switch revokes live authorizations in its scope; the tick expires unused ones', async () => {
    const post = subject()
    const issued = await createAuthorization(
      w.owner,
      w.projectId,
      authorization(post.id, post.hash, 'human_approval'),
    )
    if (!issued.ok) throw new Error('not issued')
    const account = await engageKillSwitch(w.owner, w.projectId, {
      scope: 'account',
      target: accountId,
      reason: 'Account under review',
    })
    expect(account.revokedAuthorizations).toContain(issued.authorization.id)
    // While it is engaged, the same target can't be authorized again.
    const blocked = await createAuthorization(
      w.owner,
      w.projectId,
      authorization(post.id, post.hash, 'human_approval'),
    )
    expect(blocked.blockers.map((entry) => entry.key)).toContain('kill_switch')
    await releaseKillSwitch(w.owner, account.switch.id, { reason: 'Cleared' })

    const [old] = await w.db
      .insert(opsReleaseAuthorizations)
      .values({
        ownerId: w.owner.userId,
        projectId: w.projectId,
        module: 'publish',
        subjectType: 'post',
        subjectId: crypto.randomUUID(),
        payloadHash: 'hash-old',
        mode: 'human_approval',
        approvedBy: w.owner.userId,
        expiresAt: sql`now() - interval '1 hour'`,
        actorType: 'user',
        actorId: w.owner.id,
        createdBy: w.owner.userId,
      })
      .returning()
    if (!old) throw new Error('not inserted')
    const expired = await expireAuthorizations({ ownerId: w.owner.userId })
    expect(expired).toContain(old.id)
    const reservations = await w.db
      .select()
      .from(opsBudgetReservations)
      .where(eq(opsBudgetReservations.ownerId, w.stranger.userId))
    expect(reservations).toEqual([])
  })

  test('module policy settings go through the module’s parser; an unregistered module’s are refused', async () => {
    registerPolicyExtension('market', (raw) => {
      const value = raw as { maxListingsPerDay?: unknown }
      if (typeof value.maxListingsPerDay !== 'number')
        throw new Error('maxListingsPerDay must be a number')
      return { maxListingsPerDay: value.maxListingsPerDay }
    })
    const saved = await policy({
      extensions: { market: { maxListingsPerDay: 3, extra: 'dropped' } },
    })
    expect(saved.extensions).toEqual({ market: { maxListingsPerDay: 3 } })
    const kept = await policy()
    expect(kept.extensions).toEqual({ market: { maxListingsPerDay: 3 } })
    expect(
      (
        await failure(
          savePolicy(
            w.owner,
            w.projectId,
            policyInput(revision, [w.agent.grantId], {
              extensions: { market: { maxListingsPerDay: 'lots' } },
            }),
          ),
        )
      ).code,
    ).toBe('invalid')
    expect(
      (
        await failure(
          savePolicy(
            w.owner,
            w.projectId,
            policyInput(revision, [w.agent.grantId], {
              extensions: { quotes: { vat: 7 } },
            }),
          ),
        )
      ).code,
    ).toBe('invalid')
    const cleared = await policy({ extensions: { market: null } })
    expect(cleared.extensions).toEqual({})
    // A stale form can't overwrite a newer revision.
    expect(
      (
        await failure(
          savePolicy(
            w.owner,
            w.projectId,
            policyInput(revision - 1, [w.agent.grantId]),
          ),
        )
      ).code,
    ).toBe('conflict')
    const history = pgError(
      await failure(
        w.db.execute(sql`update ops_policies set note = 'rewritten'`),
      ),
    )
    expect(history.code).toBe('23001')
  })

  test('capability checks: append-only, the newest holds, and a stale “yes” reads as expired', async () => {
    await policy({ allowedActions: ['draft', 'import'] })
    const tested = await recordCapabilityCheck(w.agent, w.projectId, {
      module: 'publish',
      provider: 'tiktok',
      targetRef: accountId,
      capability: 'post_video',
      state: 'tested',
      evidence: 'Posted a private test clip and read it back.',
    })
    expect(tested.checkedAt).toBeInstanceOf(Date)
    const threeDaysAgo = new Date(
      tested.checkedAt.getTime() - 3 * 86_400_000,
    ).toISOString()
    await recordCapabilityCheck(w.agent, w.projectId, {
      module: 'publish',
      provider: 'tiktok',
      targetRef: accountId,
      capability: 'read_insights',
      state: 'declared',
      evidence: 'The API docs list it.',
      checkedAt: threeDaysAgo,
      expiresInHours: 24,
    })
    let lines = await latestCapabilities(w.owner, { provider: 'tiktok' })
    const byCapability = new Map(
      lines.map((line) => [line.capability, line.state]),
    )
    expect(byCapability.get('post_video')).toBe('tested')
    expect(byCapability.get('read_insights')).toBe('expired')

    await recordCapabilityCheck(w.agent, w.projectId, {
      module: 'publish',
      provider: 'tiktok',
      targetRef: accountId,
      capability: 'post_video',
      state: 'unavailable',
      evidence: 'The account lost posting rights.',
    })
    lines = await latestCapabilities(w.owner, {
      provider: 'tiktok',
      projectId: w.projectId,
    })
    expect(lines.find((line) => line.capability === 'post_video')?.state).toBe(
      'unavailable',
    )
    expect(lines.length).toBe(2)

    expect(
      (
        await failure(
          recordCapabilityCheck(w.agent, w.projectId, {
            module: 'publish',
            provider: 'tiktok',
            capability: 'post_video',
            state: 'tested',
            evidence: 'From the future.',
            checkedAt: new Date(
              tested.checkedAt.getTime() + 86_400_000,
            ).toISOString(),
          }),
        )
      ).code,
    ).toBe('invalid')
    expect(
      (
        await failure(
          recordCapabilityCheck(w.readOnly, w.projectId, {
            module: 'publish',
            provider: 'tiktok',
            capability: 'x',
            state: 'declared',
            evidence: 'x',
          }),
        )
      ).code,
    ).toBe('forbidden')
    expect(await latestCapabilities(w.stranger, {})).toEqual([])
    const rewrite = pgError(
      await failure(
        w.db.execute(sql`update ops_capability_checks set state = 'tested'`),
      ),
    )
    expect(rewrite.code).toBe('23001')
  })
})
