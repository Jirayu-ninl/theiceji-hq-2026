import '@theiceji/hq-agents/register'
import { propose } from '@theiceji/hq-agents/proposals'
import { routineForTask } from '@theiceji/hq-agents/routines'
import { recordRunCost } from '@theiceji/hq-agents/runs'
import {
  AGENT_PROPOSAL_KINDS,
  MODULE_IDS,
  OPS_HUMAN_REQUEST_KINDS,
  OPS_HUMAN_REQUEST_STATUSES,
  OPS_TASK_KINDS,
} from '@theiceji/hq-db/enums'
import type { OpsTaskRow } from '@theiceji/hq-db/schema'
import { database } from '@theiceji/hq-ops/db'
import { listHumanRequests, requestHumanAction } from '@theiceji/hq-ops/human'
import { acknowledgeEvents, pullEvents } from '@theiceji/hq-ops/runtime'
import {
  checkpointRun,
  claimNextTask,
  claimTask,
  finishRun,
  heartbeatRun,
} from '@theiceji/hq-ops/tasks'
import { z } from 'zod'
import { defineTool, defineWorkspace } from '../../kernel'
import {
  defined,
  idArg,
  idempotencyKeyArg,
  plain,
  projectIdArg,
  READ,
  readTool,
  WRITE,
  writeTool,
} from '../support'

/**
 * `agents` — the kernel's work lifecycle and the agent loop: claim a
 * task with a lease and a fencing token, keep the lease
 * alive, leave checkpoints, propose, ask the owner, report cost, finish.
 * Every write a task causes is checked against the token, so a worker or
 * agent whose lease lapsed learns it before it changes anything.
 *
 * A routine's run comes back from `agents_claim_task` with the routine —
 * its playbook, the modules it may use, its project — so an agent needs no
 * second call to know what the owner asked of it.
 */

function taskOut(task: OpsTaskRow) {
  return {
    id: task.id,
    project_id: task.projectId,
    kind: task.kind,
    module: task.module,
    title: task.title,
    detail: task.detail,
    payload: task.payload,
    priority: task.priority,
    attempts: task.attempts,
    max_attempts: task.maxAttempts,
    fencing_token: task.fencingToken,
    lease_expires_at: task.leaseExpiresAt,
    target: task.targetId ? { type: task.targetType, id: task.targetId } : null,
  }
}

export const claimTaskTool = defineTool({
  name: 'claim_task',
  title: 'Claim a task',
  description:
    'Claim the most urgent task you may work — in one project, or (without project_id) in whichever of the owner’s projects has one — with a lease. Returns the task (its payload holds IDs, e.g. job_id), the run, the fencing token every later write needs, and where a previous run stopped. null when there is nothing; `skipped` names projects whose policy doesn’t cover you.',
  scope: 'agents:operate',
  input: z.object({
    project_id: projectIdArg.optional(),
    task_id: idArg('Task').optional(),
    kinds: z.array(z.enum(OPS_TASK_KINDS)).optional(),
    modules: z.array(z.enum(MODULE_IDS)).optional(),
    lease_seconds: z.number().int().min(30).max(3600).optional(),
  }),
  annotations: { ...WRITE, idempotentHint: false },
  run: (args, context) =>
    writeTool(
      context,
      async (actor) => {
        const raw = defined({
          taskId: args.task_id,
          kinds: args.kinds,
          modules: args.modules,
          leaseSeconds: args.lease_seconds,
        })
        const outcome =
          args.project_id || args.task_id
            ? {
                claim: await claimTask(actor, args.project_id ?? null, raw),
                skipped: [],
              }
            : await claimNextTask(actor, raw)
        const routine = outcome.claim
          ? await routineForTask(database(), outcome.claim.task)
          : null
        return { ...outcome, routine }
      },
      ({ claim, skipped, routine }) => ({
        text: claim
          ? `Claimed “${claim.task.title}” (token ${claim.task.fencingToken}, lease until ${claim.task.leaseExpiresAt?.toISOString()}).${routine ? ` Routine “${routine.name}” — follow its playbook; leave what you find as proposals (agents_propose).` : ''}`
          : `Nothing to claim.${skipped.length ? ` ${skipped.length} project(s) skipped: ${skipped.map((entry) => entry.reason).join(' ')}` : ''}`,
        data: {
          task: claim ? taskOut(claim.task) : null,
          routine: routine
            ? {
                id: routine.id,
                name: routine.name,
                project: routine.project
                  ? {
                      id: routine.project.id,
                      slug: routine.project.slug,
                      name: routine.project.name,
                    }
                  : null,
                modules: routine.modules,
                playbook: routine.playbook,
                auto_accept: routine.autoAccept,
              }
            : null,
          run: claim
            ? { id: claim.run.id, fencing_token: claim.run.fencingToken }
            : null,
          resume_from: claim?.resumeFrom ?? null,
          previous_runs: claim?.previousRuns ?? [],
          skipped: skipped.map((entry) => ({
            project_id: entry.projectId,
            reason: entry.reason,
          })),
        },
      }),
    ),
})

export const heartbeatTool = defineTool({
  name: 'heartbeat',
  title: 'Keep a lease alive',
  description:
    'Extend the lease on a run you hold, every third of its length. lease_lost means someone else holds the task now — stop without writing anything.',
  scope: 'agents:operate',
  input: z.object({
    run_id: idArg('Run'),
    fencing_token: z.number().int().min(1),
    lease_seconds: z.number().int().min(30).max(3600).optional(),
  }),
  annotations: { ...WRITE, idempotentHint: true },
  run: (args, context) =>
    readTool(
      context,
      (actor) =>
        heartbeatRun(
          actor,
          args.run_id,
          defined({
            fencingToken: args.fencing_token,
            leaseSeconds: args.lease_seconds,
          }),
        ),
      ({ task }) => ({
        text: `Lease until ${task.leaseExpiresAt?.toISOString()}.`,
        data: { lease_expires_at: task.leaseExpiresAt },
      }),
    ),
})

export const finishTool = defineTool({
  name: 'finish',
  title: 'Finish a run',
  description:
    'End a run you hold: done closes the task; failed reopens it for another attempt (or fails it when attempts are spent) — say what went wrong; blocked parks it; released hands it back untouched. Record a job’s files (assets_record_generated) before finishing it done.',
  scope: 'agents:operate',
  input: z.object({
    run_id: idArg('Run'),
    fencing_token: z.number().int().min(1),
    outcome: z.enum(['done', 'failed', 'blocked', 'released']),
    summary: z.string().min(1).max(4000),
    error: z.string().max(2000).optional(),
    next_action: z.string().max(1000).optional(),
    blocked_reason: z.string().max(1000).optional(),
    retry_after_seconds: z.number().int().min(0).max(604800).optional(),
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        finishRun(
          actor,
          args.run_id,
          defined({
            fencingToken: args.fencing_token,
            outcome: args.outcome,
            summary: args.summary,
            error: args.error,
            nextAction: args.next_action,
            blockedReason: args.blocked_reason,
            retryAfterSeconds: args.retry_after_seconds,
          }),
        ),
      ({ run, task }) => ({
        text: `Run ${run.status}; the task is ${task.status}.`,
        data: { run: { id: run.id, status: run.status }, task: taskOut(task) },
      }),
    ),
})

export const checkpointTool = defineTool({
  name: 'checkpoint',
  title: 'Leave a checkpoint',
  description:
    'Record where a run you hold stands — a summary, small state (IDs, not copies; under 32 KB) and the next action — and extend the lease. The next claim of the task gets the last checkpoint back, so a new session resumes instead of starting over.',
  scope: 'agents:operate',
  input: z.object({
    run_id: idArg('Run'),
    fencing_token: z.number().int().min(1),
    summary: z.string().min(1).max(2000),
    state: z.record(z.string(), z.unknown()).optional(),
    next_action: z.string().max(1000).optional(),
    lease_seconds: z.number().int().min(30).max(3600).optional(),
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        checkpointRun(
          actor,
          args.run_id,
          defined({
            fencingToken: args.fencing_token,
            summary: args.summary,
            state: args.state,
            nextAction: args.next_action,
            leaseSeconds: args.lease_seconds,
          }),
        ),
      ({ checkpoint, run }) => ({
        text: `Checkpoint ${checkpoint.seq} saved; lease until ${run.leaseExpiresAt.toISOString()}.`,
        data: { seq: checkpoint.seq, lease_expires_at: run.leaseExpiresAt },
      }),
    ),
})

export const proposeTool = defineTool({
  name: 'propose',
  title: 'Propose something to the owner',
  description:
    'Leave a proposal in the owner’s Inbox: a note, a prompt, a prompt variant, a board card, a shot, a calendar event or a draft experiment. `payload` is exactly what that record takes (the same fields notes_promote and each module’s tools use — e.g. prompt_variant: { promptId, text, style?, model?, negativeText? }; card: { title, body?, price?, labels? }; shot: { action, scene?, durationS? }; note: { body, title? }; experiment: { question, subjectType, metric, variants? }); it is validated now. Inside a routine run pass run_id + fencing_token — the proposal lands in the routine’s project. The owner accepts or rejects it; you read the decision with agents_pull_events (proposal.decided). A routine may accept notes and prompt variants on its own; nothing else lands without the owner.',
  scope: 'agents:operate',
  input: z.object({
    kind: z.enum(AGENT_PROPOSAL_KINDS),
    title: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'What the owner reads in the Inbox, e.g. “Warmer hook for the desk tour”.',
      ),
    payload: z.record(z.string(), z.unknown()),
    rationale: z
      .string()
      .max(4000)
      .optional()
      .describe('Why — the readings or facts behind it, in a sentence or two.'),
    project_id: projectIdArg.optional(),
    run_id: idArg('Run').optional(),
    fencing_token: z.number().int().min(1).optional(),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        propose(actor, {
          kind: args.kind,
          title: args.title,
          payload: args.payload,
          ...defined({
            rationale: args.rationale,
            projectId: args.project_id,
            runId: args.run_id,
            fencingToken: args.fencing_token,
            idempotencyKey: args.idempotency_key,
          }),
        }),
      ({ proposal, accepted }) => ({
        text: accepted
          ? `Accepted on the owner’s behalf (the routine allows ${proposal.kind}): ${accepted.href}`
          : `Proposed “${proposal.title}” — it waits in the owner’s Inbox.`,
        data: {
          proposal: {
            id: proposal.id,
            kind: proposal.kind,
            status: proposal.status,
            project_id: proposal.projectId,
            expires_at: proposal.expiresAt,
          },
          accepted_as: accepted,
        },
      }),
    ),
})

export const requestHumanTool = defineTool({
  name: 'request_human',
  title: 'Ask the owner',
  description:
    'Ask the owner for something only they can do or decide — an approval, a choice, a sign-in, consent, a spend scope, a manual step, information. Say the exact action as data (requested_action), why, and what happens meanwhile. To wait for the answer, finish your run `blocked` with waiting_on_request_id — the task reopens when the owner answers. Repeated asks with the same dedupe_key return the open one.',
  scope: 'agents:operate',
  input: z.object({
    project_id: projectIdArg.optional(),
    module: z.enum(MODULE_IDS).optional(),
    kind: z.enum(OPS_HUMAN_REQUEST_KINDS),
    title: z.string().min(1).max(200),
    reason: z.string().min(1).max(2000),
    requested_action: z.record(z.string(), z.unknown()),
    impact: z.string().max(2000).optional(),
    meanwhile: z.string().max(2000).optional(),
    options: z
      .array(
        z.object({
          key: z.string().min(1).max(40),
          label: z.string().min(1).max(80),
        }),
      )
      .max(10)
      .optional(),
    urgency: z.enum(['digest', 'urgent']).optional(),
    expires_in_hours: z.number().int().min(1).max(720).optional(),
    dedupe_key: z.string().min(1).max(200).optional(),
    task_id: idArg('Task').optional(),
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        requestHumanAction(
          actor,
          args.project_id ?? null,
          defined({
            module: args.module,
            kind: args.kind,
            title: args.title,
            reason: args.reason,
            requestedAction: args.requested_action,
            impact: args.impact,
            meanwhile: args.meanwhile,
            options: args.options,
            urgency: args.urgency,
            expiresInHours: args.expires_in_hours,
            dedupeKey: args.dedupe_key,
            taskId: args.task_id,
          }),
        ),
      ({ request, deduplicated }) => ({
        text: deduplicated
          ? `That request is already open (${request.id}).`
          : `Asked the owner: “${request.title}”. It expires ${request.expiresAt.toISOString()}.`,
        data: {
          request: {
            id: request.id,
            status: request.status,
            revision: request.revision,
            expires_at: request.expiresAt,
          },
          deduplicated,
        },
      }),
    ),
})

export const listHumanResponsesTool = defineTool({
  name: 'list_human_responses',
  title: 'Read the owner’s answers',
  description:
    'Your requests to the owner and their answers — answered by default, or open / expired / withdrawn. `since` (ISO) narrows to what changed after your last look.',
  scope: 'agents:operate',
  input: z.object({
    status: z.enum(OPS_HUMAN_REQUEST_STATUSES).optional(),
    project_id: projectIdArg.optional(),
    since: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      (actor) =>
        listHumanRequests(
          actor,
          defined({
            status: args.status ?? 'answered',
            projectId: args.project_id,
            since: args.since,
            limit: args.limit,
          }),
        ),
      (items) => ({
        text: `${items.length} request(s).`,
        data: {
          requests: items.map(({ request, response }) => ({
            id: request.id,
            title: request.title,
            status: request.status,
            project_id: request.projectId,
            task_id: request.taskId,
            answer: response
              ? {
                  choice: response.choice,
                  note: response.note,
                  at: response.respondedAt,
                }
              : null,
          })),
        },
      }),
    ),
})

export const pullEventsTool = defineTool({
  name: 'pull_events',
  title: 'Pull what happened',
  description:
    'Events for your connection, oldest first after `after` (a cursor from the last pull): task.ready, human.responded, proposal.decided (accepted / rejected / expired), job.finished, run.stalled, budget.warning … Pulling doesn’t acknowledge — call agents_ack_events once you’ve taken them, or they come back.',
  scope: 'agents:operate',
  input: z.object({
    project_id: projectIdArg.optional(),
    after: z.string().max(400).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      (actor) =>
        pullEvents(
          actor,
          defined({
            projectId: args.project_id,
            after: args.after,
            limit: args.limit,
          }),
        ),
      ({ events, nextCursor }) => ({
        text: `${events.length} event(s).`,
        data: { events: plain(events), next_cursor: nextCursor },
      }),
    ),
})

export const ackEventsTool = defineTool({
  name: 'ack_events',
  title: 'Acknowledge events',
  description: 'Mark events you have taken, so they stop coming back.',
  scope: 'agents:operate',
  input: z.object({ event_ids: z.array(idArg('Event')).min(1).max(100) }),
  annotations: { ...WRITE, idempotentHint: true },
  run: (args, context) =>
    writeTool(
      context,
      (actor) => acknowledgeEvents(actor, { eventIds: args.event_ids }),
      ({ acknowledged, unknown }) => ({
        text: `${acknowledged.length} acknowledged${unknown.length ? `, ${unknown.length} unknown` : ''}.`,
        data: { acknowledged, unknown },
      }),
    ),
})

export const recordCostTool = defineTool({
  name: 'record_cost',
  title: 'Report what a run spent',
  description:
    'Report what the run you hold spent — LLM tokens, a paid API — in minor units (satang, cents) of its currency, with tokens when you know them. Known cost is charged against the owner’s budget for the project; past it you get budget_exceeded and the run is stopped (its token dies): stop and finish nothing more. Unknown cost: omit cost_minor — it is counted, never guessed.',
  scope: 'agents:operate',
  input: z.object({
    run_id: idArg('Run'),
    fencing_token: z.number().int().min(1),
    provider: z.string().min(1).max(60),
    cost_minor: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    tokens: z.number().int().min(0).optional(),
    unit: z.string().max(40).optional(),
    quantity: z.number().int().min(0).optional(),
    reconciled: z.boolean().optional(),
    note: z.string().max(500).optional(),
  }),
  annotations: { ...WRITE, idempotentHint: false },
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        recordRunCost(actor, {
          runId: args.run_id,
          fencingToken: args.fencing_token,
          provider: args.provider,
          ...defined({
            costMinor: args.cost_minor,
            currency: args.currency,
            tokens: args.tokens,
            unit: args.unit,
            quantity: args.quantity,
            reconciled: args.reconciled,
            note: args.note,
          }),
        }),
      () => ({ text: 'Recorded.', data: {} }),
    ),
})

export const agents = defineWorkspace({
  id: 'agents',
  label: 'Agents',
  description:
    'The agent loop: claim a task (a routine’s run comes with its playbook), keep the lease, checkpoint, propose to the owner, ask them, report cost, finish.',
  instructions:
    'Claim with agents_claim_task (kinds ["routine"] for a routine’s run — it returns the playbook), heartbeat every third of the lease, checkpoint as you go, finish with agents_finish. Every write for a task passes its fencing token; lease_lost means stop. What you find becomes proposals (agents_propose) for the owner — never a direct change they didn’t ask for. Report spend with agents_record_cost; budget_exceeded means the run is over. Read decisions and answers with agents_pull_events.',
  tools: [
    claimTaskTool,
    heartbeatTool,
    checkpointTool,
    proposeTool,
    requestHumanTool,
    listHumanResponsesTool,
    pullEventsTool,
    ackEventsTool,
    recordCostTool,
    finishTool,
  ],
})
