import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createTarget, targetFor } from '@theiceji/hq-core/targets'
import { AGENT_PROPOSAL_KINDS } from '@theiceji/hq-db/enums'
import {
  agentRoutines,
  notes,
  opsAgentRuns,
  opsTasks,
  opsUsageEvents,
  promptVariants,
  refs,
} from '@theiceji/hq-db/schema'
import { savePolicy } from '@theiceji/hq-ops/policy'
import { pullEvents } from '@theiceji/hq-ops/runtime'
import { withTransaction } from '@theiceji/hq-ops/store'
import { claimTask, finishRun } from '@theiceji/hq-ops/tasks'
import {
  closeTestDb,
  dbTestsEnabled,
  failure,
  pgError,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import { and, eq, sql } from 'drizzle-orm'
import '@theiceji/hq-board/register'
import '@theiceji/hq-calendar/register'
import '@theiceji/hq-experiments/register'
import '@theiceji/hq-prompts/register'
import '@theiceji/hq-story/register'
import '../src/register'
import {
  acceptProposal,
  expireProposals,
  holdProposal,
  listProposals,
  propose,
  rejectProposal,
} from '../src/proposals'
import {
  archiveRoutine,
  deleteRoutine,
  getRoutine,
  listRoutines,
  queueDueRoutines,
  restoreRoutine,
  routineSummaries,
  runRoutineNow,
  saveRoutine,
  setRoutineEnabled,
} from '../src/routines'
import { listRuns, recordRunCost } from '../src/runs'

/**
 * Agents against Postgres: routines queued by the tick, claimed by the right
 * claimant, proposals validated by their targets, accepted by the owner (or
 * a routine, for notes and prompt variants only), and a run stopped by the
 * budget. Destructive (truncates), so it runs only with AGENTS_DB_TESTS=1 and
 * a localhost DATABASE_URL.
 */

const suite = dbTestsEnabled('AGENTS_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'agent_proposals',
  'agent_routines',
  'notes',
  'exp_variants',
  'exp_experiments',
  'story_shots',
  'story_scenes',
  'story_characters',
  'story_stories',
  'calendar_events',
  'board_card_events',
  'board_cards',
  'board_lanes',
  'board_boards',
  'prompt_examples',
  'prompt_variants',
  'prompt_prompts',
]

const PLAYBOOK =
  'Read the last 7 days of readings, then propose three new hook variants.'

suite('hq-agents against Postgres', () => {
  let w: World

  beforeEach(async () => {
    w = await resetWorld(TABLES, { kind: 'channel' })
  })
  afterAll(() => closeTestDb(TABLES))

  async function routine(extra: Record<string, unknown> = {}) {
    return saveRoutine(w.owner, {
      projectId: w.project.id,
      name: 'Hook review',
      cron: '0 9 * * *',
      playbook: PLAYBOOK,
      modules: ['readings', 'prompts'],
      runner: 'mcp',
      ...extra,
    })
  }

  async function prompt() {
    return withTransaction((tx) =>
      createTarget(
        'prompt',
        { title: 'Desk tour hook', medium: 'video', text: 'A slow push-in.' },
        { tx, actor: w.owner, project: w.project },
      ),
    )
  }

  async function makeDue(routineId: string) {
    await w.db
      .update(agentRoutines)
      .set({ nextDueAt: sql`now() - interval '1 minute'` })
      .where(eq(agentRoutines.id, routineId))
  }

  async function claimRoutine() {
    const claim = await claimTask(w.agent, w.project.id, { kinds: ['routine'] })
    if (!claim) throw new Error('nothing to claim')
    return claim
  }

  test('every proposal kind the database allows has a target adapter', () => {
    for (const kind of AGENT_PROPOSAL_KINDS)
      expect(targetFor(kind)?.type).toBe(kind)
  })

  test('routines are the owner’s: an agent can’t schedule itself', async () => {
    const saved = await routine()
    expect(saved.nextDueAt).not.toBeNull()
    expect(saved.cron).toBe('0 9 * * *')
    const refused = await failure(
      saveRoutine(w.agent, {
        projectId: w.project.id,
        name: 'Rogue',
        cron: '* * * * *',
        playbook: '',
        runner: 'mcp',
      }),
    )
    expect(refused.code).toBe('forbidden')
    const bad = await failure(
      saveRoutine(w.owner, {
        name: 'Bad',
        cron: '0 25 * * *',
        playbook: '',
        runner: 'mcp',
      }),
    )
    expect(bad.code).toBe('invalid')
    // The builtin runner needs an LLM key.
    const keyless = await failure(routine({ name: 'Built', runner: 'builtin' }))
    expect(keyless.message).toContain('LLM key')
  })

  test('the database refuses auto-accept beyond notes and prompt variants', async () => {
    const saved = await routine({ autoAccept: ['note', 'prompt_variant'] })
    expect(saved.autoAccept).toEqual(['note', 'prompt_variant'])
    const refused = await failure(
      routine({ name: 'Cards', autoAccept: ['card'] }),
    )
    expect(refused.code).toBe('invalid')
    const direct = await failure(
      w.db
        .update(agentRoutines)
        .set({ autoAccept: ['card'] })
        .where(eq(agentRoutines.id, saved.id)),
    )
    expect(pgError(direct).message).toContain(
      'agent_routines_auto_accept_check',
    )
  })

  test('the tick queues one run when due, and never piles up', async () => {
    const saved = await routine()
    expect((await queueDueRoutines()).queued).toBe(0)
    await makeDue(saved.id)
    const first = await queueDueRoutines()
    expect(first.queued).toBe(1)
    const [row] = await w.db
      .select()
      .from(agentRoutines)
      .where(eq(agentRoutines.id, saved.id))
    expect(row?.nextDueAt?.getTime()).toBeGreaterThan(Date.now())
    await makeDue(saved.id)
    const second = await queueDueRoutines()
    expect(second).toMatchObject({ queued: 0, waiting: 1 })
    const tasks = await w.db
      .select()
      .from(opsTasks)
      .where(eq(opsTasks.targetId, saved.id))
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      kind: 'routine',
      module: 'agents',
      claimant: 'agent',
      targetType: 'agent_routine',
    })
    // Paused: nothing is due.
    await setRoutineEnabled(w.owner, { routineId: saved.id, enabled: false })
    const [paused] = await w.db
      .select()
      .from(agentRoutines)
      .where(eq(agentRoutines.id, saved.id))
    expect(paused?.nextDueAt).toBeNull()
  })

  test('delete sends a routine to the Trash, stopped; restore brings it back off, and a taken name says so', async () => {
    const saved = await routine()
    const { task } = await runRoutineNow(w.owner, { routineId: saved.id })
    const refused = await failure(
      deleteRoutine(w.agent, { routineId: saved.id }),
    )
    expect(refused.code).toBe('forbidden')
    const deleted = await deleteRoutine(w.owner, { routineId: saved.id })
    expect(deleted).toMatchObject({ enabled: false, nextDueAt: null })
    expect(deleted.archivedAt).not.toBeNull()
    expect(deleted.deletedAt).not.toBeNull()
    const [cancelled] = await w.db
      .select()
      .from(opsTasks)
      .where(eq(opsTasks.id, task.id))
    expect(cancelled?.status).toBe('cancelled')
    // One archived before the Trash existed is in the Trash too.
    const older = await routine({ name: 'Weekly recap', cron: '0 18 * * 5' })
    await archiveRoutine(w.owner, { routineId: older.id })
    expect(await listRoutines(w.owner)).toEqual([])
    expect(await routineSummaries(w.owner)).toEqual([])
    expect(
      (await listRoutines(w.owner, { trash: true })).map((row) => row.name),
    ).toEqual(['Weekly recap', 'Hook review'])
    expect((await failure(listRoutines(w.agent, { trash: true }))).code).toBe(
      'forbidden',
    )
    // A live routine took the name meanwhile: say so, in words.
    const again = await routine()
    const clash = await failure(
      restoreRoutine(w.owner, { routineId: saved.id }),
    )
    expect(clash.code).toBe('invalid')
    expect(clash.message).toContain('Another routine here is called')
    await deleteRoutine(w.owner, { routineId: again.id })
    const back = await restoreRoutine(w.owner, { routineId: saved.id })
    expect(back).toMatchObject({
      enabled: false,
      nextDueAt: null,
      archivedAt: null,
      deletedAt: null,
    })
    const restoredOlder = await restoreRoutine(w.owner, {
      routineId: older.id,
    })
    expect(restoredOlder.archivedAt).toBeNull()
    expect(
      (await listRoutines(w.owner, { projectId: w.project.id })).map((row) => [
        row.name,
        row.enabled,
      ]),
    ).toEqual([
      ['Hook review', false],
      ['Weekly recap', false],
    ])
    // Switched off until the owner turns it on; nothing falls due meanwhile.
    expect((await queueDueRoutines()).queued).toBe(0)
    const on = await setRoutineEnabled(w.owner, {
      routineId: saved.id,
      enabled: true,
    })
    expect(on.nextDueAt).not.toBeNull()
  })

  test('claims go to the claimant the routine names', async () => {
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['propose', 'draft'],
    })
    const saved = await routine()
    // A task only the builtin runner may take.
    await w.db
      .update(agentRoutines)
      .set({ runner: 'builtin' })
      .where(eq(agentRoutines.id, saved.id))
    await withTransaction(async (tx) => {
      await tx.insert(opsTasks).values({
        ownerId: w.owner.userId,
        createdBy: w.owner.userId,
        projectId: w.project.id,
        kind: 'routine',
        module: 'agents',
        title: 'built',
        targetType: 'agent_routine',
        targetId: saved.id,
        claimant: 'builtin',
      })
    })
    expect(
      await claimTask(w.agent, w.project.id, { kinds: ['routine'] }),
    ).toBeNull()
    const claim = await claimTask(w.agent, w.project.id, {
      kinds: ['routine'],
      claimant: 'builtin',
    })
    expect(claim?.task.claimant).toBe('builtin')
  })

  test('summaries count routines, the run working now and the next due time', async () => {
    expect(await routineSummaries(w.owner)).toEqual([])
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['propose'],
    })
    const saved = await routine()
    const off = await routine({ name: 'Weekly recap', cron: '0 18 * * 5' })
    await setRoutineEnabled(w.owner, { routineId: off.id, enabled: false })
    // A routine in no project is HQ-wide and in no project's row.
    await saveRoutine(w.owner, {
      projectId: null,
      name: 'Inbox sweep',
      cron: '0 8 * * *',
      playbook: PLAYBOOK,
      modules: ['notes'],
      runner: 'mcp',
    })
    const [idle] = await routineSummaries(w.owner)
    expect(idle).toMatchObject({
      projectId: w.project.id,
      routines: 2,
      enabled: 1,
      running: 0,
      runningName: null,
      failed7d: 0,
    })
    expect(idle?.nextDueAt?.getTime()).toBeGreaterThan(Date.now() - 60_000)

    await runRoutineNow(w.owner, { routineId: saved.id })
    const claim = await claimRoutine()
    const [busy] = await routineSummaries(w.owner)
    expect(busy).toMatchObject({ running: 1, runningName: 'Hook review' })

    await finishRun(w.agent, claim.run.id, {
      fencingToken: claim.task.fencingToken,
      outcome: 'failed',
      summary: 'The readings were not there.',
      error: 'readings_query returned nothing.',
    })
    const [after] = await routineSummaries(w.owner)
    expect(after).toMatchObject({ running: 0, failed7d: 1 })
  })

  test('a run proposes; the owner accepts; the record links back', async () => {
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['propose'],
    })
    const made = await prompt()
    const saved = await routine()
    await runRoutineNow(w.owner, { routineId: saved.id })
    const claim = await claimRoutine()
    const context = {
      runId: claim.run.id,
      fencingToken: claim.task.fencingToken,
    }

    // The target's own schema, at propose time.
    const bad = await failure(
      propose(w.agent, {
        ...context,
        kind: 'prompt_variant',
        title: 'No text',
        payload: { promptId: made.id },
      }),
    )
    expect(bad.code).toBe('invalid')

    const outcomes = []
    for (const style of ['Warm', 'Neon', 'Grain'])
      outcomes.push(
        await propose(w.agent, {
          ...context,
          kind: 'prompt_variant',
          title: `${style} hook`,
          payload: {
            promptId: made.id,
            text: `${style} light, slow push-in.`,
            style,
          },
          rationale: 'Views at 72h fell 30 % on the plain hook.',
          idempotencyKey: `variant-${style}-${claim.run.id}`,
        }),
      )
    expect(outcomes.every((entry) => entry.accepted === null)).toBe(true)
    // Retrying with the same key returns the first one.
    const again = await propose(w.agent, {
      ...context,
      kind: 'prompt_variant',
      title: 'Warm hook',
      payload: {
        promptId: made.id,
        text: 'Warm light, slow push-in.',
        style: 'Warm',
      },
      rationale: 'Views at 72h fell 30 % on the plain hook.',
      idempotencyKey: `variant-Warm-${claim.run.id}`,
    })
    expect(again.proposal.id).toBe(outcomes[0]?.proposal.id as string)

    // An agent can't decide.
    const self = await failure(
      acceptProposal(w.agent, {
        proposalId: outcomes[0]?.proposal.id as string,
      }),
    )
    expect(self.code).toBe('forbidden')

    const waiting = await listProposals(w.owner, { status: 'proposed' })
    expect(waiting).toHaveLength(3)
    expect(waiting[0]?.routine?.name).toBe('Hook review')
    expect(waiting[0]?.label).toBe('Prompts · variant')

    const accepted = await acceptProposal(w.owner, {
      proposalId: outcomes[1]?.proposal.id as string,
    })
    expect(accepted.created.type).toBe('prompt_variant')
    const [variant] = await w.db
      .select()
      .from(promptVariants)
      .where(eq(promptVariants.id, accepted.created.id))
    expect(variant?.text).toBe('Neon light, slow push-in.')
    const [edge] = await w.db
      .select()
      .from(refs)
      .where(
        and(
          eq(refs.fromType, 'proposal'),
          eq(refs.fromId, outcomes[1]?.proposal.id as string),
        ),
      )
    expect(edge).toMatchObject({
      toType: 'prompt_variant',
      toId: accepted.created.id,
      role: 'proposed_as',
    })
    const twice = await failure(
      acceptProposal(w.owner, {
        proposalId: outcomes[1]?.proposal.id as string,
      }),
    )
    expect(twice.message).toContain('already accepted')

    const held = await holdProposal(w.owner, {
      proposalId: outcomes[2]?.proposal.id as string,
    })
    expect(held.heldAt).not.toBeNull()
    await rejectProposal(w.owner, {
      proposalId: outcomes[0]?.proposal.id as string,
      note: 'Too warm for this channel.',
    })
    const open = await listProposals(w.owner, { status: 'proposed' })
    expect(open.map((entry) => entry.proposal.id)).toEqual([
      outcomes[2]?.proposal.id as string,
    ])

    // The agent reads the decisions back as events.
    const { events } = await pullEvents(w.agent, { projectId: w.project.id })
    const decided = events.filter((event) => event.type === 'proposal.decided')
    expect(decided.map((event) => event.payload.status).sort()).toEqual([
      'accepted',
      'rejected',
    ])

    await finishRun(w.agent, claim.run.id, {
      fencingToken: claim.task.fencingToken,
      outcome: 'done',
      summary: 'Proposed three hook variants.',
    })
    const detail = await getRoutine(w.owner, saved.id)
    expect(detail.runs[0]).toMatchObject({ status: 'succeeded', proposals: 3 })
    expect(detail.pendingProposals).toBe(1)
    const [view] = await listRoutines(w.owner, { projectId: w.project.id })
    expect(view?.lastRun?.summary).toBe('Proposed three hook variants.')
  })

  test('auto-accept lands notes and variants, never cards', async () => {
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['propose', 'draft'],
    })
    const saved = await routine({ autoAccept: ['note'] })
    await runRoutineNow(w.owner, { routineId: saved.id })
    const claim = await claimRoutine()
    const context = {
      runId: claim.run.id,
      fencingToken: claim.task.fencingToken,
    }
    const note = await propose(w.agent, {
      ...context,
      kind: 'note',
      title: 'Idea',
      payload: { body: 'Try a 3-second cold open.' },
    })
    expect(note.accepted?.type).toBe('note')
    expect(note.proposal.status).toBe('accepted')
    const [row] = await w.db
      .select()
      .from(notes)
      .where(eq(notes.id, note.accepted?.id as string))
    expect(row?.projectId).toBe(w.project.id)
    const card = await propose(w.agent, {
      ...context,
      kind: 'card',
      title: 'Film the lamp tour',
      payload: { title: 'Film the lamp tour' },
    })
    expect(card.accepted).toBeNull()
    expect(card.proposal.status).toBe('proposed')
  })

  test('a lost lease can’t propose', async () => {
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['propose'],
    })
    const saved = await routine()
    await runRoutineNow(w.owner, { routineId: saved.id })
    const claim = await claimRoutine()
    const stale = await failure(
      propose(w.agent, {
        runId: claim.run.id,
        fencingToken: claim.task.fencingToken + 1,
        kind: 'note',
        title: 'x',
        payload: { body: 'x' },
      }),
    )
    expect(stale.code).toBe('lease_lost')
  })

  test('over budget, the run stops and the spend stays on record', async () => {
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['propose'],
      cashLimitPerJob: '30.00',
      cashLimitPerDay: '50.00',
      cashLimitPerMonth: '500.00',
    })
    const saved = await routine()
    await runRoutineNow(w.owner, { routineId: saved.id })
    const claim = await claimRoutine()
    const run = { runId: claim.run.id, fencingToken: claim.task.fencingToken }
    await recordRunCost(w.agent, {
      ...run,
      provider: 'anthropic',
      costMinor: 2_500,
      currency: w.project.currency,
      tokens: 12_000,
    })
    const over = await failure(
      recordRunCost(w.agent, {
        ...run,
        provider: 'anthropic',
        costMinor: 2_900,
        currency: w.project.currency,
        tokens: 14_000,
      }),
    )
    expect(over.code).toBe('budget_exceeded')
    const [stopped] = await w.db
      .select()
      .from(opsAgentRuns)
      .where(eq(opsAgentRuns.id, claim.run.id))
    expect(stopped?.status).toBe('failed')
    expect(stopped?.error).toContain('budget_exceeded')
    const [task] = await w.db
      .select()
      .from(opsTasks)
      .where(eq(opsTasks.id, claim.task.id))
    expect(task?.status).toBe('blocked')
    const usage = await w.db
      .select()
      .from(opsUsageEvents)
      .where(eq(opsUsageEvents.subjectId, claim.run.id))
    expect(usage.map((line) => line.costMinor).sort()).toEqual([2_500, 2_900])
    // The stopped run's token is dead.
    const after = await failure(
      propose(w.agent, {
        ...run,
        kind: 'note',
        title: 'x',
        payload: { body: 'x' },
      }),
    )
    expect(after.code).toBe('lease_lost')
    const [summary] = await listRuns(w.owner, { routineId: saved.id })
    expect(summary?.cost).toEqual([
      { currency: w.project.currency, minor: 5_400 },
    ])
    expect(summary?.tokens).toBe(26_000)
  })

  test('undecided proposals expire', async () => {
    const outcome = await propose(w.owner, {
      projectId: w.project.id,
      kind: 'note',
      title: 'Later',
      payload: { body: 'Maybe.' },
    })
    await w.db.execute(
      sql`update agent_proposals set expires_at = now() - interval '1 minute' where id = ${outcome.proposal.id}`,
    )
    expect(await expireProposals()).toBe(1)
    const [row] = await listProposals(w.owner, { status: 'expired' })
    expect(row?.proposal.id).toBe(outcome.proposal.id)
  })
})
