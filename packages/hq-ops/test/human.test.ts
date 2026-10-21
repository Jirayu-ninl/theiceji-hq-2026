import { afterAll, beforeAll, expect, test } from 'bun:test'
import { opsOutboxEvents, opsTasks } from '@theiceji/hq-db/schema'
import { and, eq, sql } from 'drizzle-orm'
import {
  claimUrgentForNotification,
  countOpenHumanRequests,
  expireHumanRequests,
  getHumanRequest,
  listHumanRequests,
  registerManualStepTarget,
  requestHumanAction,
  respondToHumanRequest,
  withdrawHumanRequest,
} from '../src/human'
import { savePolicy } from '../src/policy'
import { claimTask, createTask, finishRun } from '../src/tasks'
import {
  failure,
  pgError,
  policyInput,
  setupWorld,
  suite,
  teardown,
  type World,
} from './helpers'

/**
 * The owner's inbox: an agent asks, the same
 * question isn't asked twice, only the owner answers — once, for the
 * revision asked — and the answer reopens exactly the task that waited on it.
 * What `/inbox` lists and shows is what these services return.
 */

suite('ops human requests (Postgres)', () => {
  let w: World

  const ask = (extra: Record<string, unknown> = {}) => ({
    kind: 'sign_in',
    title: 'Sign in to the shop account',
    reason: 'The session expired.',
    requestedAction: { action: 'sign_in', account: '@test' },
    options: [{ key: 'done', label: 'Signed in' }],
    ...extra,
  })

  beforeAll(async () => {
    w = await setupWorld('human')
    await savePolicy(
      w.owner,
      w.projectId,
      policyInput(0, [w.agent.grantId], { status: 'suspended' }),
    )
  })

  afterAll(async () => {
    await teardown()
  })

  test('an agent can ask even under a suspended policy; the same dedupe key returns the open request; an uncovered connection can’t ask', async () => {
    const { request, deduplicated } = await requestHumanAction(
      w.agent,
      w.projectId,
      ask({ dedupeKey: 'signin-shop', module: 'market' }),
    )
    expect(deduplicated).toBe(false)
    expect(request.status).toBe('open')
    expect(request.ownerId).toBe(w.owner.userId)
    expect(request.module).toBe('market')
    expect(request.actorId).toBe(w.agent.id)
    const again = await requestHumanAction(
      w.agent,
      w.projectId,
      ask({ dedupeKey: 'signin-shop', title: 'Sign in again' }),
    )
    expect(again.deduplicated).toBe(true)
    expect(again.request.id).toBe(request.id)
    // Dedupe is per owner, across projects: the fact is the same question.
    const elsewhere = await requestHumanAction(
      w.owner,
      null,
      ask({ dedupeKey: 'signin-shop' }),
    )
    expect(elsewhere.request.id).toBe(request.id)

    expect(
      (await failure(requestHumanAction(w.otherAgent, w.projectId, ask())))
        .code,
    ).toBe('policy_blocked')
    // No policy at all for work in no project: the agent can't ask there.
    expect((await failure(requestHumanAction(w.agent, null, ask()))).code).toBe(
      'policy_blocked',
    )
    expect(
      (await failure(requestHumanAction(w.stranger, w.projectId, ask()))).code,
    ).toBe('not_found')
    // Asking is agents:operate; a read-only connection can't, but can read.
    const reader = await failure(
      requestHumanAction(w.readOnly, w.projectId, ask()),
    )
    expect(reader.code).toBe('forbidden')
    expect(reader.message).toContain('agents:operate')
    expect((await listHumanRequests(w.readOnly)).length).toBe(1)
  })

  test('only the owner answers, for the revision asked; the answer reopens exactly the waiting task and announces itself', async () => {
    await savePolicy(w.owner, w.projectId, policyInput(1, [w.agent.grantId]))
    const { task } = await createTask(w.owner, w.projectId, {
      kind: 'follow_up',
      title: 'Wait for sign-in',
      priority: 10,
    })
    const { task: unrelated } = await createTask(w.owner, w.projectId, {
      kind: 'follow_up',
      title: 'Unrelated',
      priority: 5,
    })
    const claim = await claimTask(w.agent, w.projectId, { taskId: task.id })
    if (!claim) throw new Error('no claim')
    const { request } = await requestHumanAction(
      w.agent,
      w.projectId,
      ask({ taskId: task.id, dedupeKey: 'signin-2', urgency: 'urgent' }),
    )
    await finishRun(w.agent, claim.run.id, {
      fencingToken: claim.task.fencingToken,
      outcome: 'blocked',
      summary: 'Waiting for the owner',
      blockedReason: 'Needs sign-in',
      waitingOnRequestId: request.id,
    })

    const agentAnswer = await failure(
      respondToHumanRequest(w.agent, request.id, {
        expectedRevision: request.revision,
        choice: 'done',
      }),
    )
    expect(agentAnswer.code).toBe('forbidden')
    expect(
      (
        await failure(
          respondToHumanRequest(w.stranger, request.id, {
            expectedRevision: request.revision,
            choice: 'done',
          }),
        )
      ).code,
    ).toBe('not_found')
    expect(
      (
        await failure(
          respondToHumanRequest(w.owner, request.id, {
            expectedRevision: request.revision + 7,
            choice: 'done',
          }),
        )
      ).code,
    ).toBe('conflict')
    expect(
      (
        await failure(
          respondToHumanRequest(w.owner, request.id, {
            expectedRevision: request.revision,
            choice: 'nonsense',
          }),
        )
      ).code,
    ).toBe('invalid')

    const answered = await respondToHumanRequest(w.owner, request.id, {
      expectedRevision: request.revision,
      choice: 'done',
      note: 'Signed in on my phone',
    })
    expect(answered.request.status).toBe('answered')
    expect(answered.response.requestRevision).toBe(request.revision)
    expect(answered.response.respondedBy).toBe(w.owner.userId)
    expect(answered.unblockedTasks).toEqual([task.id])
    const [other] = await w.db
      .select()
      .from(opsTasks)
      .where(eq(opsTasks.id, unrelated.id))
    expect(other?.status).toBe('open')
    const [reopened] = await w.db
      .select()
      .from(opsTasks)
      .where(eq(opsTasks.id, task.id))
    expect(reopened?.status).toBe('open')
    expect(reopened?.waitingOnRequestId).toBeNull()
    const [responded] = await w.db
      .select()
      .from(opsOutboxEvents)
      .where(
        and(
          eq(opsOutboxEvents.subjectId, request.id),
          eq(opsOutboxEvents.type, 'human.responded'),
        ),
      )
    expect(responded?.payload.choice).toBe('done')
    // Answered once; a second answer is refused.
    expect(
      (
        await failure(
          respondToHumanRequest(w.owner, request.id, {
            expectedRevision: answered.request.revision,
            choice: 'done',
          }),
        )
      ).code,
    ).toBe('invalid')
  })

  test('a response is append-only: the migration’s trigger refuses an UPDATE and a DELETE', async () => {
    const update = pgError(
      await failure(
        w.db.execute(sql`update ops_human_responses set choice = 'deny'`),
      ),
    )
    expect(update.code).toBe('23001')
    expect(update.message).toContain('append-only')
    const remove = pgError(
      await failure(w.db.execute(sql`delete from ops_human_responses`)),
    )
    expect(remove.code).toBe('23001')
    expect(remove.message).toContain('append-only')
    const [answer] = await w.db.execute<{ choice: string }>(
      sql`select choice from ops_human_responses limit 1`,
    )
    expect(answer?.choice).toBe('done')
  })

  test('an expired request can’t be answered, and the task waiting on it says why', async () => {
    const { task } = await createTask(w.owner, w.projectId, {
      kind: 'follow_up',
      title: 'Wait for consent',
      priority: 99,
    })
    const claim = await claimTask(w.agent, w.projectId, { taskId: task.id })
    if (!claim) throw new Error('no claim')
    const { request: stale } = await requestHumanAction(
      w.agent,
      w.projectId,
      ask({
        kind: 'consent',
        title: 'Old question',
        options: [],
        expiresInHours: 1,
        taskId: task.id,
      }),
    )
    await finishRun(w.agent, claim.run.id, {
      fencingToken: claim.task.fencingToken,
      outcome: 'blocked',
      summary: 'Waiting',
      blockedReason: 'Needs consent',
      waitingOnRequestId: stale.id,
    })
    // Past its expiry by the database's clock, not yet swept by the tick.
    await w.db.execute(
      sql`update ops_human_requests set expires_at = now() - interval '1 minute' where id = ${stale.id}`,
    )
    expect(
      (
        await failure(
          respondToHumanRequest(w.owner, stale.id, {
            expectedRevision: stale.revision,
            choice: 'yes',
          }),
        )
      ).code,
    ).toBe('invalid')
    const item = await getHumanRequest(w.owner, stale.id)
    expect(item.answerable).toBe(false)
    const expired = await expireHumanRequests({ ownerId: w.owner.userId })
    expect(expired).toContain(stale.id)
    const [waiting] = await w.db
      .select()
      .from(opsTasks)
      .where(eq(opsTasks.id, task.id))
    expect(waiting?.status).toBe('blocked')
    expect(waiting?.blockedReason).toContain('expired unanswered')
    expect((await getHumanRequest(w.owner, stale.id)).request.status).toBe(
      'expired',
    )
  })

  test('the inbox lists by status, project and module, with each answer; another owner sees none of it', async () => {
    await requestHumanAction(
      w.owner,
      null,
      ask({ kind: 'information', title: 'No-project question', options: [] }),
    )
    const all = await listHumanRequests(w.owner)
    expect(all.length).toBeGreaterThanOrEqual(4)
    // Open ones first.
    const firstClosed = all.findIndex((item) => item.request.status !== 'open')
    const lastOpen = all.map((item) => item.request.status).lastIndexOf('open')
    expect(firstClosed === -1 || lastOpen < firstClosed).toBe(true)

    const answered = await listHumanRequests(w.owner, { status: 'answered' })
    expect(answered.length).toBe(1)
    expect(answered[0]?.response?.choice).toBe('done')
    expect(answered[0]?.project?.id).toBe(w.projectId)
    expect(answered[0]?.answerable).toBe(false)

    const loose = await listHumanRequests(w.owner, { projectId: 'none' })
    expect(loose.every((item) => item.request.projectId === null)).toBe(true)
    expect(
      loose.some((item) => item.request.title === 'No-project question'),
    ).toBe(true)
    expect(loose.every((item) => item.project === null)).toBe(true)
    const inProject = await listHumanRequests(w.owner, {
      projectId: w.projectId,
    })
    expect(
      inProject.every((item) => item.request.projectId === w.projectId),
    ).toBe(true)
    const market = await listHumanRequests(w.owner, { module: 'market' })
    expect(market.length).toBe(1)
    expect(market[0]?.request.module).toBe('market')

    const counts = await countOpenHumanRequests(w.owner)
    expect(counts.open).toBeGreaterThanOrEqual(2)

    expect(await listHumanRequests(w.stranger)).toEqual([])
    expect(
      (await failure(listHumanRequests(w.stranger, { projectId: w.projectId })))
        .code,
    ).toBe('not_found')
    expect(
      (await failure(getHumanRequest(w.stranger, all[0]?.request.id ?? '')))
        .code,
    ).toBe('not_found')
    expect(
      (await failure(listHumanRequests(w.owner, { status: 'nope' }))).code,
    ).toBe('invalid')
  })

  test('the asking connection or the owner can withdraw; another connection can’t', async () => {
    await savePolicy(
      w.owner,
      w.projectId,
      policyInput(2, [w.agent.grantId, w.otherAgent.grantId]),
    )
    const { request } = await requestHumanAction(
      w.agent,
      w.projectId,
      ask({ title: 'Withdraw me', dedupeKey: 'withdraw-1' }),
    )
    expect(
      (
        await failure(
          withdrawHumanRequest(w.otherAgent, request.id, {
            expectedRevision: request.revision,
            reason: 'not mine',
          }),
        )
      ).code,
    ).toBe('forbidden')
    const withdrawn = await withdrawHumanRequest(w.agent, request.id, {
      expectedRevision: request.revision,
      reason: 'Solved it another way',
    })
    expect(withdrawn.status).toBe('withdrawn')
    // The dedupe key is free again once the request isn't open.
    const fresh = await requestHumanAction(
      w.agent,
      w.projectId,
      ask({ title: 'Ask again', dedupeKey: 'withdraw-1' }),
    )
    expect(fresh.deduplicated).toBe(false)
  })

  test('urgent requests are claimed for a push exactly once', async () => {
    const first = await claimUrgentForNotification({
      ownerId: w.owner.userId,
    })
    const second = await claimUrgentForNotification({
      ownerId: w.owner.userId,
    })
    expect(second).toEqual([])
    expect(first.every((row) => row.urgency === 'urgent')).toBe(true)
    await requestHumanAction(
      w.agent,
      w.projectId,
      ask({ title: 'Urgent one', urgency: 'urgent', dedupeKey: 'urgent-1' }),
    )
    const third = await claimUrgentForNotification({
      ownerId: w.owner.userId,
    })
    expect(third.map((row) => row.title)).toEqual(['Urgent one'])
    expect(third[0]?.notifiedAt).toBeInstanceOf(Date)
  })

  test('a manual step a module records elsewhere is refused as an answer', async () => {
    registerManualStepTarget(
      'generation_job',
      'Record the result on the generation job (its outputs and cost), not as an answer.',
    )
    const { request } = await requestHumanAction(
      w.agent,
      w.projectId,
      ask({
        kind: 'manual_step',
        title: 'Render it by hand',
        options: [],
        targetType: 'generation_job',
        targetId: crypto.randomUUID(),
        module: 'assets',
      }),
    )
    const refused = await failure(
      respondToHumanRequest(w.owner, request.id, {
        expectedRevision: request.revision,
        choice: 'done',
      }),
    )
    expect(refused.code).toBe('invalid')
    expect(refused.message).toContain('generation job')
  })
})
