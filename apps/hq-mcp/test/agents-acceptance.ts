#!/usr/bin/env bun
/**
 * Acceptance, over MCP: an outside agent runs a routine the
 * way a real client does — Streamable HTTP, a personal token acting as an
 * agent, only the scopes the routine needs.
 *
 *   routine "every day 09:00: review project X's readings, propose three new
 *   prompt variants" → the ops tick queues it → agents_claim_task hands over
 *   the playbook → readings_query, prompts_list → agents_propose ×3 →
 *   agents_record_cost → agents_finish → the owner accepts one → the variant
 *   is in the library, linked `proposal —proposed_as→ variant` → the agent
 *   reads the decision (agents_pull_events). A second run over the budget
 *   gets budget_exceeded and its token dies.
 *
 *   DATABASE_URL=postgres://…localhost…/<throwaway> \
 *   HQ_OWNER_EMAIL=owner@hq.test HQ_PROJECT_SLUG=desk-light \
 *     bun run test/agents-acceptance.ts
 *
 * Uses the owner and the channel project named (made when missing); leaves
 * what it made in place, so the Inbox and /agents can be looked at after.
 * Refuses anything but a localhost database.
 */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import '@theiceji/hq-agents/register'
import { acceptProposal } from '@theiceji/hq-agents/proposals'
import { saveRoutine } from '@theiceji/hq-agents/routines'
import { createProject, getProjectBySlug } from '@theiceji/hq-core/projects'
import { createTarget } from '@theiceji/hq-core/targets'
import { createDbHandle } from '@theiceji/hq-db'
import { hashToken, mintToken, tokenHint } from '@theiceji/hq-db/access'
import {
  agentRoutines,
  oauthGrants,
  oauthTokens,
  promptVariants,
  refs,
  users,
} from '@theiceji/hq-db/schema'
import '@theiceji/hq-prompts/register'
import { userActor } from '@theiceji/hq-ops/access'
import { configureOpsDatabase } from '@theiceji/hq-ops/db'
import { savePolicy } from '@theiceji/hq-ops/policy'
import { currentPolicy } from '@theiceji/hq-ops/policy-gate'
import { runOpsTick } from '@theiceji/hq-ops/runtime'
import { withTransaction } from '@theiceji/hq-ops/store'
import { and, eq, sql } from 'drizzle-orm'

const url = process.env.DATABASE_URL ?? ''
if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
  console.error(
    'Refusing: DATABASE_URL must be a localhost throwaway database.',
  )
  process.exit(1)
}
const email = process.env.HQ_OWNER_EMAIL ?? 'agents-acceptance@hq.test'
const slug = process.env.HQ_PROJECT_SLUG ?? 'desk-light'

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, '../src/index.ts')
const port = 8930 + Math.floor(Math.random() * 30)
const publicUrl = `http://localhost:${port}/mcp`

let failures = 0
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}
const say = (line: string) => console.log(`   ${line}`)

/* ── The owner's side ─────────────────────────────────────────────── */
const handle = createDbHandle(url, { max: 3 })
configureOpsDatabase(handle.db)
let [user] = await handle.db
  .select()
  .from(users)
  .where(eq(users.email, email))
  .limit(1)
if (!user)
  [user] = await handle.db
    .insert(users)
    .values({ email, passwordHash: 'x', role: 'admin', name: 'Owner' })
    .returning()
if (!user) throw new Error('no owner')
const owner = userActor(user)
const project = await getProjectBySlug(owner, slug).catch(() =>
  createProject(owner, { name: 'Desk & Light', kind: 'channel', slug }),
)
say(`project ${project.name} (${project.kind}, ${project.currency})`)

const [existingPrompt] = await handle.db.execute<{ id: string }>(
  sql`select id::text from prompt_prompts where owner_id = ${user.id} and project_id = ${project.id} and title = 'Desk tour hook' limit 1`,
)
const promptId =
  existingPrompt?.id ??
  (
    await withTransaction((tx) =>
      createTarget(
        'prompt',
        {
          title: 'Desk tour hook',
          medium: 'video',
          text: 'A slow push-in on the desk lamp at dusk.',
        },
        { tx, actor: owner, project },
      ),
    )
  ).id

/* The agent's connection: only what the routine needs. */
const scopes = [
  'hq:read',
  'agents:operate',
  'prompts:read',
  'prompts:write',
  'readings:read',
]
const token = mintToken('personalToken')
const [grant] = await handle.db
  .insert(oauthGrants)
  .values({
    userId: user.id,
    kind: 'personal',
    label: 'Hook reviewer (acceptance)',
    scope: scopes.join(' '),
    resource: publicUrl,
    actorType: 'agent',
  })
  .returning()
if (!grant) throw new Error('no grant')
await handle.db.insert(oauthTokens).values({
  id: hashToken(token),
  grantId: grant.id,
  kind: 'personal',
  hint: tokenHint(token),
})

/* The policy: propose, with a small daily cash budget in the project's currency. */
const policy = await currentPolicy(handle.db, user.id, project.id)
const grants = new Set([...(policy?.grantIds ?? []), grant.id])
await savePolicy(owner, project.id, {
  expectedRevisionNo: policy?.revisionNo ?? 0,
  status: 'active',
  releaseMode: 'human_required',
  coverage: 'selected',
  grantIds: [...grants],
  allowedActions: [
    ...new Set([...(policy?.allowedActions ?? []), 'propose', 'draft']),
  ],
  cashLimitPerJob: '20.00',
  cashLimitPerDay: '30.00',
  cashLimitPerMonth: '300.00',
})

const [old] = await handle.db
  .select()
  .from(agentRoutines)
  .where(
    and(
      eq(agentRoutines.ownerId, user.id),
      eq(agentRoutines.name, 'Daily hook review'),
    ),
  )
  .limit(1)
const routine = await saveRoutine(owner, {
  ...(old ? { routineId: old.id, expectedRevision: old.revision } : {}),
  projectId: project.id,
  name: 'Daily hook review',
  cron: '0 9 * * *',
  timezone: 'Asia/Bangkok',
  playbook: [
    '1. Read the readings of this project’s posts at 72h (readings_query).',
    '2. Read the hook prompts in the library (prompts_list).',
    '3. Propose three new variants of the weakest hook — different styles, each with one line of why.',
  ].join('\n'),
  modules: ['readings', 'prompts'],
  runner: 'mcp',
})
say(`routine “${routine.name}” · ${routine.cron} ${routine.timezone}`)

/* 09:00 comes: make it due, and let the ops tick queue it. */
async function tickAt0900() {
  await handle.db
    .update(agentRoutines)
    .set({ nextDueAt: sql`now() - interval '1 second'` })
    .where(eq(agentRoutines.id, routine.id))
  const report = await runOpsTick({ deliver: async () => ({ status: 204 }) })
  return report.steps.find((step) => step.name === 'agents.routines')?.result as
    | { queued: number }
    | undefined
}
const ticked = await tickAt0900()
check(
  'the ops tick queues the routine when it falls due',
  ticked?.queued === 1,
  JSON.stringify(ticked),
)

/* ── The agent's side, over HTTP ──────────────────────────────────── */
const server = spawn('bun', ['run', entry], {
  env: {
    PATH: process.env.PATH ?? '',
    DATABASE_URL: url,
    PORT: String(port),
    MCP_PUBLIC_URL: publicUrl,
    MCP_AUTHORIZATION_SERVER: 'http://localhost:8990',
    HQ_SCHEDULER_SECONDS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
server.stdout.on('data', (chunk) => (logs += chunk))
server.stderr.on('data', (chunk) => (logs += chunk))

type Result = {
  isError?: boolean
  content?: { text?: string }[]
  structuredContent?: Record<string, unknown>
}

try {
  for (let i = 0; i < 80 && !logs.includes('listening on'); i++)
    await new Promise((done) => setTimeout(done, 250))
  const client = new Client({ name: 'hook-reviewer', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(publicUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as Result
    say(
      `→ ${name} ${result.isError ? '✗' : '✓'} ${result.content?.[0]?.text?.slice(0, 140) ?? ''}`,
    )
    return result
  }
  const { tools } = await client.listTools()
  const names = tools.map((tool) => tool.name)
  check(
    'the agent sees the agent loop and only its modules',
    [
      'agents_claim_task',
      'agents_propose',
      'agents_record_cost',
      'agents_finish',
      'prompts_list',
      'readings_query',
    ].every((name) => names.includes(name)) &&
      !names.some((name) => name.startsWith('board_')),
    `${names.length} tools`,
  )

  const claimed = await call('agents_claim_task', { kinds: ['routine'] })
  const task = claimed.structuredContent?.task as {
    id: string
    fencing_token: number
  } | null
  const run = claimed.structuredContent?.run as { id: string } | null
  const playbook =
    (claimed.structuredContent?.routine as { playbook?: string } | null)
      ?.playbook ?? ''
  check(
    'the claim hands over the routine’s playbook',
    Boolean(task && run && playbook.includes('three new variants')),
  )
  if (!task || !run) throw new Error('nothing claimed')
  const fenced = { run_id: run.id, fencing_token: task.fencing_token }

  const readings = await call('readings_query', {
    project_id: project.id,
    subject_type: 'post',
    metrics: ['views'],
    age_hours: 72,
  })
  check('readings_query answers', !readings.isError)
  const library = await call('prompts_list', { project_id: project.id })
  check('prompts_list answers', !library.isError)

  const ids: string[] = []
  for (const style of ['Warm tungsten', 'Blue hour', 'Film grain']) {
    const proposed = await call('agents_propose', {
      ...fenced,
      kind: 'prompt_variant',
      title: `${style} — desk tour hook`,
      payload: {
        promptId,
        text: `${style}: a slow push-in on the desk lamp, the room waking up around it.`,
        style,
      },
      rationale:
        'The plain hook reads lowest at 72h; a stronger first frame is the cheapest thing to try.',
      idempotency_key: `acceptance-${run.id}-${style}`,
    })
    const proposal = proposed.structuredContent?.proposal as
      | { id: string }
      | undefined
    if (proposal) ids.push(proposal.id)
  }
  check('three proposals wait in the Inbox', ids.length === 3)

  const cost = await call('agents_record_cost', {
    ...fenced,
    provider: 'anthropic',
    cost_minor: 1_250,
    currency: project.currency,
    tokens: 18_400,
  })
  check('the run’s cost is charged', !cost.isError)
  const done = await call('agents_finish', {
    ...fenced,
    outcome: 'done',
    summary:
      'Read the 72h readings and the hook library; proposed three variants (warm, blue hour, grain).',
  })
  check('the run finishes', !done.isError)

  /* The owner accepts one. */
  const accepted = await acceptProposal(owner, { proposalId: ids[1] as string })
  const [variant] = await handle.db
    .select()
    .from(promptVariants)
    .where(eq(promptVariants.id, accepted.created.id))
  const [edge] = await handle.db
    .select()
    .from(refs)
    .where(
      and(eq(refs.fromType, 'proposal'), eq(refs.fromId, ids[1] as string)),
    )
  check(
    'accepting puts the variant in the library, linked proposed_as',
    variant?.style === 'Blue hour' &&
      edge?.role === 'proposed_as' &&
      edge.toId === variant.id,
    accepted.created.href,
  )

  const events = await call('agents_pull_events', { project_id: project.id })
  const decided = (
    events.structuredContent?.events as
      | { type: string; payload: { status?: string } }[]
      | undefined
  )?.find((event) => event.type === 'proposal.decided')
  check('the agent reads the decision', decided?.payload.status === 'accepted')

  /* Tomorrow's run spends past the daily budget. */
  await tickAt0900()
  const second = await call('agents_claim_task', { kinds: ['routine'] })
  const task2 = second.structuredContent?.task as {
    fencing_token: number
  } | null
  const run2 = second.structuredContent?.run as { id: string } | null
  if (!task2 || !run2) throw new Error('second run not claimed')
  const fenced2 = { run_id: run2.id, fencing_token: task2.fencing_token }
  const over = await call('agents_record_cost', {
    ...fenced2,
    provider: 'anthropic',
    cost_minor: 1_900,
    currency: project.currency,
    tokens: 27_000,
  })
  const code = (over.structuredContent?.error as { code?: string } | undefined)
    ?.code
  check(
    'over the daily budget: budget_exceeded',
    over.isError === true && code === 'budget_exceeded',
    over.content?.[0]?.text,
  )
  const after = await call('agents_propose', {
    ...fenced2,
    kind: 'note',
    title: 'x',
    payload: { body: 'x' },
    idempotency_key: `acceptance-after-${run2.id}`,
  })
  check(
    'and the run is over — its token is dead',
    (after.structuredContent?.error as { code?: string } | undefined)?.code ===
      'lease_lost',
  )
  await client.close()
} catch (error) {
  console.error(error)
  failures++
} finally {
  server.kill()
  await handle.sql.end({ timeout: 5 })
}
console.log(
  failures === 0
    ? '\nall good.'
    : `\n${failures} failed.\n${logs.slice(-2000)}`,
)
process.exit(failures === 0 ? 0 : 1)
