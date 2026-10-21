import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  opsAuditEvents,
  opsOutboxEvents,
  opsTasks,
} from '@theiceji/hq-db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { engageKillSwitch, releaseKillSwitch, savePolicy } from '../src/policy'
import { runOperation } from '../src/store'
import {
  cancelTask,
  checkpointRun,
  claimTask,
  createTask,
  finishRun,
  getTaskContext,
  heartbeatRun,
  recoverLapsedLeases,
  reprioritizeTask,
  TASK_ACTION,
} from '../src/tasks'
import {
  connection,
  count,
  failure,
  policyInput,
  setupWorld,
  suite,
  teardown,
  type World,
} from './helpers'

/**
 * The agent side of the ops kernel against Postgres: who may act (the policy
 * gate per project and for no-project work, kill switches), owner isolation,
 * idempotency and audit, and the task queue's leases and fencing.
 */

suite('ops tasks, policy gate and idempotency (Postgres)', () => {
  let w: World
  let projectRevision = 0
  let noProjectRevision = 0

  const task = (title: string, extra: Record<string, unknown> = {}) => ({
    kind: 'other',
    module: 'board',
    title,
    ...extra,
  })

  async function policy(
    projectId: string | null,
    overrides: Record<string, unknown> = {},
    grants?: (string | undefined)[],
  ) {
    const revision = projectId ? projectRevision : noProjectRevision
    const saved = await savePolicy(
      w.owner,
      projectId,
      policyInput(revision, grants ?? [w.agent.grantId], overrides),
    )
    if (projectId) projectRevision = saved.revisionNo
    else noProjectRevision = saved.revisionNo
    return saved
  }

  beforeAll(async () => {
    w = await setupWorld('tasks')
  })

  afterAll(async () => {
    await teardown()
  })

  test('without a policy an agent can read but not write — in a project or in no project — and nothing is left behind', async () => {
    const refused = await failure(
      createTask(w.agent, w.projectId, task('Agent idea')),
    )
    expect(refused.code).toBe('policy_blocked')
    const refusedNone = await failure(
      createTask(w.agent, null, task('Agent idea')),
    )
    expect(refusedNone.code).toBe('policy_blocked')
    expect(
      await count(w.db, sql`select count(*)::int as n from ops_tasks`),
    ).toBe(0)
    expect(
      await count(
        w.db,
        sql`select count(*)::int as n from ops_audit_events where actor_id = ${w.agent.id}`,
      ),
    ).toBe(0)

    // Owner-only: a connection never writes a policy or pulls a switch.
    const policyRefusal = await failure(
      savePolicy(w.agent, w.projectId, policyInput(0, [w.agent.grantId])),
    )
    expect(policyRefusal.code).toBe('forbidden')
    expect(policyRefusal.message).toContain('agents_request_human')
    const switchRefusal = await failure(
      engageKillSwitch(w.agent, null, { scope: 'all', reason: 'agent stop' }),
    )
    expect(switchRefusal.code).toBe('forbidden')
    expect(switchRefusal.message).toContain('agents_request_human')
  })

  test('a policy belongs to one scope: a project policy does not cover no-project work, nor the reverse', async () => {
    const saved = await policy(w.projectId)
    expect(saved.revisionNo).toBe(1)
    expect(saved.projectId).toBe(w.projectId)

    const { task: created } = await createTask(
      w.agent,
      w.projectId,
      task('Draft three hooks'),
    )
    expect(created.createdBy).toBe(w.owner.userId)
    expect(created.ownerId).toBe(w.owner.userId)
    const [event] = await w.db
      .select()
      .from(opsAuditEvents)
      .where(
        and(
          eq(opsAuditEvents.targetId, created.id),
          eq(opsAuditEvents.action, 'task.create'),
        ),
      )
    expect(event?.actorType).toBe('agent')
    expect(event?.actorId).toBe(w.agent.id)
    expect(event?.ownerId).toBe(w.owner.userId)
    const [ready] = await w.db
      .select()
      .from(opsOutboxEvents)
      .where(eq(opsOutboxEvents.subjectId, created.id))
    expect(ready?.type).toBe('task.ready')

    // No inheritance: work in no project needs its own policy.
    expect(
      (await failure(createTask(w.agent, null, task('Loose idea')))).code,
    ).toBe('policy_blocked')
    await policy(null)
    const { task: loose } = await createTask(
      w.agent,
      null,
      task('Loose idea', { module: null }),
    )
    expect(loose.projectId).toBeNull()
    expect(loose.module).toBeNull()
  })

  test('the gate refuses an action the policy lacks, a suspended policy, an uncovered connection and a missing scope', async () => {
    await policy(w.projectId, { allowedActions: ['import'] })
    const noDraft = await failure(
      createTask(w.agent, w.projectId, task('Not allowed')),
    )
    expect(noDraft.code).toBe('policy_blocked')
    expect(noDraft.message).toContain('doesn’t let agents')

    await policy(w.projectId, { status: 'suspended' })
    const suspended = await failure(
      createTask(w.agent, w.projectId, task('Suspended')),
    )
    expect(suspended.code).toBe('policy_blocked')
    expect(suspended.message).toContain('suspended')

    await policy(w.projectId, {}, [w.agent.grantId, w.readOnly.grantId])
    const uncovered = await failure(
      createTask(w.otherAgent, w.projectId, task('Not covered')),
    )
    expect(uncovered.code).toBe('policy_blocked')
    expect(uncovered.message).toContain('doesn’t cover this connection')
    const readOnly = await failure(
      createTask(w.readOnly, w.projectId, task('Read only')),
    )
    expect(readOnly.code).toBe('forbidden')
    expect(readOnly.message).toContain('board:write')
  })

  test('kill switches: all, project and connection stop agent work at the next call; releasing restores it', async () => {
    const connection = await engageKillSwitch(w.owner, null, {
      scope: 'connection',
      target: w.agent.grantId,
      reason: 'Test stop',
    })
    expect(
      (await failure(createTask(w.agent, w.projectId, task('stopped')))).code,
    ).toBe('policy_blocked')
    expect(
      (await failure(createTask(w.agent, null, task('stopped')))).code,
    ).toBe('policy_blocked')
    // The same switch twice is refused.
    expect(
      (
        await failure(
          engageKillSwitch(w.owner, null, {
            scope: 'connection',
            target: w.agent.grantId,
            reason: 'again',
          }),
        )
      ).code,
    ).toBe('conflict')
    await releaseKillSwitch(w.owner, connection.switch.id, {
      reason: 'Test over',
    })
    await createTask(w.agent, w.projectId, task('allowed again'))

    const all = await engageKillSwitch(w.owner, null, {
      scope: 'all',
      reason: 'Everything stops',
    })
    expect(
      (await failure(createTask(w.agent, null, task('stopped')))).code,
    ).toBe('policy_blocked')
    expect((await failure(claimTask(w.agent, w.projectId, {}))).code).toBe(
      'policy_blocked',
    )
    await releaseKillSwitch(w.owner, all.switch.id, { reason: 'Resume' })

    const project = await engageKillSwitch(w.owner, w.projectId, {
      scope: 'project',
      reason: 'This project only',
    })
    expect(
      (await failure(createTask(w.agent, w.projectId, task('stopped')))).code,
    ).toBe('policy_blocked')
    // Work in no project isn't this project's.
    await createTask(w.agent, null, task('elsewhere', { module: null }))
    await releaseKillSwitch(w.owner, project.switch.id, { reason: 'Resume' })
    // A released switch can't be released twice; a stranger can't see it.
    expect(
      (
        await failure(
          releaseKillSwitch(w.owner, project.switch.id, { reason: 'x' }),
        )
      ).code,
    ).toBe('invalid')
    expect(
      (
        await failure(
          releaseKillSwitch(w.stranger, project.switch.id, { reason: 'x' }),
        )
      ).code,
    ).toBe('not_found')
    // `all` names no project; `project` needs one.
    expect(
      (
        await failure(
          engageKillSwitch(w.owner, w.projectId, { scope: 'all', reason: 'x' }),
        )
      ).code,
    ).toBe('invalid')
    expect(
      (
        await failure(
          engageKillSwitch(w.owner, null, { scope: 'project', reason: 'x' }),
        )
      ).code,
    ).toBe('invalid')
  })

  test('idempotency: the same key replays, a different payload conflicts, a concurrent retry runs once', async () => {
    const make = (title: string, key: string) =>
      runOperation(
        w.agent,
        {
          operation: 'agents_create_task',
          key,
          request: { projectId: w.projectId, title },
        },
        () => createTask(w.agent, w.projectId, task(title)),
      )
    const first = await make('Idempotent task', 'key-ops-0001')
    expect(first.kind).toBe('fresh')
    if (first.kind !== 'fresh') throw new Error('not fresh')
    expect(first.auditIds.length).toBe(1)
    expect(first.target?.id).toBe(first.value.task.id)
    await first.complete({ id: first.value.task.id })
    const again = await make('Idempotent task', 'key-ops-0001')
    expect(again.kind).toBe('replay')
    if (again.kind === 'replay')
      expect(again.response).toEqual({ id: first.value.task.id })
    const conflicting = await failure(make('Different title', 'key-ops-0001'))
    expect(conflicting.code).toBe('idempotency_conflict')

    const [a, b] = await Promise.all([
      make('Raced task', 'key-ops-race'),
      make('Raced task', 'key-ops-race'),
    ])
    expect([a.kind, b.kind].sort()).toEqual(['fresh', 'replay'])
    expect(
      await count(
        w.db,
        sql`select count(*)::int as n from ops_tasks where title = 'Raced task'`,
      ),
    ).toBe(1)
    // A refused attempt leaves no key behind: the same key works once allowed.
    const stopped = await engageKillSwitch(w.owner, null, {
      scope: 'all',
      reason: 'Hold',
    })
    expect((await failure(make('After stop', 'key-ops-late'))).code).toBe(
      'policy_blocked',
    )
    await releaseKillSwitch(w.owner, stopped.switch.id, { reason: 'Go' })
    expect((await make('After stop', 'key-ops-late')).kind).toBe('fresh')
  })

  test('owner isolation: another owner’s task, run and project read as not found', async () => {
    const { task: mine } = await createTask(
      w.owner,
      w.projectId,
      task('Mine only'),
    )
    expect((await failure(getTaskContext(w.stranger, mine.id))).code).toBe(
      'not_found',
    )
    expect(
      (
        await failure(
          cancelTask(w.stranger, mine.id, {
            expectedRevision: mine.revision,
            reason: 'x',
          }),
        )
      ).code,
    ).toBe('not_found')
    expect(
      (await failure(createTask(w.stranger, w.projectId, task('x')))).code,
    ).toBe('not_found')
    expect((await failure(claimTask(w.stranger, w.projectId, {}))).code).toBe(
      'not_found',
    )
    // The owner's agent can't reach into the stranger's project either.
    expect(
      (await failure(createTask(w.agent, w.strangerProjectId, task('x')))).code,
    ).toBe('not_found')
    // The owner edits with the revision it read.
    const moved = await reprioritizeTask(w.owner, mine.id, {
      expectedRevision: mine.revision,
      priority: 90,
      priorityReason: 'Due soon',
    })
    expect(moved.priority).toBe(90)
    expect(
      (
        await failure(
          reprioritizeTask(w.owner, mine.id, {
            expectedRevision: mine.revision,
            priority: 10,
            priorityReason: 'stale form',
          }),
        )
      ).code,
    ).toBe('conflict')
    const cancelled = await cancelTask(w.owner, mine.id, {
      expectedRevision: moved.revision,
      reason: 'Not needed',
    })
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.fencingToken).toBe(mine.fencingToken + 1)
  })

  test('claim → heartbeat → checkpoint → finish with fencing; a lapse is recovered and the next claim resumes from the checkpoint', async () => {
    await w.db.execute(
      sql`update ops_tasks set status = 'cancelled', completed_at = now() where status = 'open'`,
    )
    await policy(w.projectId)
    const { task: created } = await createTask(
      w.owner,
      w.projectId,
      task('Find three references', {
        priority: 80,
        triggerKey: 'test:refs:1',
      }),
    )
    const duplicate = await createTask(
      w.owner,
      w.projectId,
      task('Find three references', { triggerKey: 'test:refs:1' }),
    )
    expect(duplicate.deduplicated).toBe(true)
    expect(duplicate.task.id).toBe(created.id)

    const claim = await claimTask(w.agent, w.projectId, { leaseSeconds: 60 })
    if (!claim) throw new Error('no claim')
    expect(claim.task.id).toBe(created.id)
    expect(claim.task.status).toBe('claimed')
    expect(claim.task.fencingToken).toBe(created.fencingToken + 1)
    expect(claim.resumeFrom).toBeNull()
    const token = claim.task.fencingToken
    // The lease is the database's clock plus the lease, not the host's.
    const [lease] = await w.db.execute<{ ok: boolean }>(
      sql`select lease_expires_at between now() + interval '50 seconds' and now() + interval '70 seconds' as ok from ops_tasks where id = ${created.id}`,
    )
    expect(lease?.ok).toBe(true)

    const beat = await heartbeatRun(w.agent, claim.run.id, {
      fencingToken: token,
      leaseSeconds: 120,
    })
    expect(beat.task.leaseExpiresAt?.getTime()).toBeGreaterThan(
      claim.task.leaseExpiresAt?.getTime() ?? 0,
    )
    const first = await checkpointRun(w.agent, claim.run.id, {
      fencingToken: token,
      summary: 'Shortlisted 2 references',
      state: { refIds: ['a', 'b'] },
      nextAction: 'Check licences',
      leaseSeconds: 60,
    })
    expect(first.checkpoint.seq).toBe(1)
    const second = await checkpointRun(w.agent, claim.run.id, {
      fencingToken: token,
      summary: 'Checked one licence',
    })
    expect(second.checkpoint.seq).toBe(2)
    // Someone else's run, or a wrong token, is lease_lost.
    expect(
      (
        await failure(
          checkpointRun(w.otherAgent, claim.run.id, {
            fencingToken: token,
            summary: 'not mine',
          }),
        )
      ).code,
    ).toBe('lease_lost')
    expect(
      (
        await failure(
          heartbeatRun(w.agent, claim.run.id, { fencingToken: token + 5 }),
        )
      ).code,
    ).toBe('lease_lost')

    // The lease lapses (by the database's clock) and the tick reopens it.
    await w.db.execute(
      sql`update ops_tasks set lease_expires_at = now() - interval '1 minute' where id = ${created.id}`,
    )
    expect(
      (
        await failure(
          checkpointRun(w.agent, claim.run.id, {
            fencingToken: token,
            summary: 'late',
          }),
        )
      ).code,
    ).toBe('lease_lost')
    const recovered = await recoverLapsedLeases({ ownerId: w.owner.userId })
    expect(recovered.reopened).toContain(created.id)
    expect(recovered.abandonedRuns).toContain(claim.run.id)
    const [lapseAudit] = await w.db
      .select()
      .from(opsAuditEvents)
      .where(
        and(
          eq(opsAuditEvents.targetId, created.id),
          eq(opsAuditEvents.action, 'task.lease_lapsed'),
        ),
      )
    expect(lapseAudit?.actorId).toBe('ops-scheduler')

    // The old token can't act any more; a fresh claim resumes.
    expect(
      (
        await failure(
          finishRun(w.agent, claim.run.id, {
            fencingToken: token,
            outcome: 'done',
            summary: 'too late',
          }),
        )
      ).code,
    ).toBe('lease_lost')
    const resumed = await claimTask(w.agent, w.projectId, { leaseSeconds: 60 })
    if (!resumed) throw new Error('no resume')
    expect(resumed.task.id).toBe(created.id)
    expect(resumed.task.fencingToken).toBeGreaterThan(token)
    expect(resumed.resumeFrom?.summary).toBe('Checked one licence')
    expect(resumed.previousRuns[0]?.status).toBe('abandoned')

    // `failed` reopens for another attempt; `done` closes.
    const failed = await finishRun(w.agent, resumed.run.id, {
      fencingToken: resumed.task.fencingToken,
      outcome: 'failed',
      summary: 'Provider was down',
      error: 'HTTP 503',
      retryAfterSeconds: 0,
    })
    expect(failed.task.status).toBe('open')
    expect(failed.run.status).toBe('failed')
    const third = await claimTask(w.agent, w.projectId, {
      taskId: created.id,
    })
    if (!third) throw new Error('no third claim')
    const done = await finishRun(w.agent, third.run.id, {
      fencingToken: third.task.fencingToken,
      outcome: 'done',
      summary: 'Recorded the references',
      outputRefs: [{ type: 'card', id: crypto.randomUUID() }],
    })
    expect(done.task.status).toBe('done')
    expect(done.task.leaseActorId).toBeNull()
    const context = await getTaskContext(w.agent, created.id)
    expect(context.runs.length).toBe(3)
    expect(context.checkpoints.length).toBe(2)
  })

  test('two workers race for one task: exactly one wins; kinds the policy or the scopes don’t allow are refused with a reason', async () => {
    const kernelOnly = await connection(
      w.db,
      w.owner.userId,
      'agent',
      ['agents:operate'],
      'Kernel only (test)',
    )
    await policy(w.projectId, {}, [
      w.agent.grantId,
      w.otherAgent.grantId,
      w.readOnly.grantId,
      kernelOnly.grantId,
    ])
    await createTask(
      w.owner,
      w.projectId,
      task('Only one of you', { priority: 95 }),
    )
    const [first, second] = await Promise.all([
      claimTask(w.agent, w.projectId, { kinds: ['other'] }),
      claimTask(w.otherAgent, w.projectId, { kinds: ['other'] }),
    ])
    expect([first, second].filter(Boolean).length).toBe(1)
    expect(TASK_ACTION.publication).toBe('publish')
    const refused = await failure(
      claimTask(w.agent, w.projectId, { kinds: ['publication'] }),
    )
    expect(refused.code).toBe('policy_blocked')
    // Covered, but without agents:operate a connection works no queue at all.
    const reader = await failure(
      claimTask(w.readOnly, w.projectId, { kinds: ['other'] }),
    )
    expect(reader.code).toBe('forbidden')
    expect(reader.message).toContain('agents:operate')
    // agents:operate alone takes kernel work, never a module's.
    const boardWork = await failure(
      claimTask(kernelOnly, w.projectId, { modules: ['board'] }),
    )
    expect(boardWork.code).toBe('policy_blocked')
    expect(boardWork.message).toContain('permissions')
    const { task: kernel } = await createTask(
      w.owner,
      w.projectId,
      task('Kernel chore', { module: null, priority: 1 }),
    )
    const kernelClaim = await claimTask(kernelOnly, w.projectId, {})
    expect(kernelClaim?.task.id).toBe(kernel.id)
    // A kernel task needs agents:operate to create, not a module's write.
    expect(
      (
        await failure(
          createTask(w.readOnly, w.projectId, task('x', { module: null })),
        )
      ).code,
    ).toBe('forbidden')
  })

  test('no-project work has its own queue, claimed under the no-project policy', async () => {
    await w.db.execute(
      sql`update ops_tasks set status = 'cancelled', completed_at = now() where status = 'open' and project_id is null`,
    )
    const { task: loose } = await createTask(
      w.owner,
      null,
      task('Weekly review', { kind: 'follow_up', module: null }),
    )
    const claim = await claimTask(w.agent, null, {})
    expect(claim?.task.id).toBe(loose.id)
    expect(claim?.run.projectId).toBeNull()
    if (!claim) throw new Error('no claim')
    const blocked = await finishRun(w.agent, claim.run.id, {
      fencingToken: claim.task.fencingToken,
      outcome: 'blocked',
      summary: 'Waiting',
      blockedReason: 'Needs the owner',
    })
    expect(blocked.task.status).toBe('blocked')
    const [row] = await w.db
      .select()
      .from(opsTasks)
      .where(eq(opsTasks.id, loose.id))
    expect(row?.blockedReason).toBe('Needs the owner')
  })
})
