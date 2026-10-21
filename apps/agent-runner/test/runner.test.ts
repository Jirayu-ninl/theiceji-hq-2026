import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { randomBytes } from 'node:crypto'
import { listProposals } from '@theiceji/hq-agents/proposals'
import { runRoutineNow, saveRoutine } from '@theiceji/hq-agents/routines'
import { listRuns } from '@theiceji/hq-agents/runs'
import { saveProviderConnection } from '@theiceji/hq-core/connections'
import { createTarget } from '@theiceji/hq-core/targets'
import { opsAgentRuns, opsTasks, opsUsageEvents } from '@theiceji/hq-db/schema'
import { savePolicy } from '@theiceji/hq-ops/policy'
import { withTransaction } from '@theiceji/hq-ops/store'
import {
  closeTestDb,
  dbTestsEnabled,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import { createLogger } from '@theiceji/mcp-kernel'
import { eq } from 'drizzle-orm'
import type { ToolContext } from 'hq-mcp/src/kernel'
import { costOf, pricingFor } from '../src/llm'
import { runOnce } from '../src/run'
import { toolsFor } from '../src/tools'

/**
 * The builtin runner end to end against Postgres and a fake Messages API on
 * localhost: a routine's run reads the prompt library, proposes three
 * variants, and ends; the next one is stopped by the budget before it
 * spends. Runs only with RUNNER_DB_TESTS=1 and a localhost DATABASE_URL.
 */

const suite = dbTestsEnabled('RUNNER_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'agent_proposals',
  'agent_routines',
  'prompt_examples',
  'prompt_variants',
  'prompt_prompts',
]

type Seen = { headers: Record<string, string>; body: Record<string, unknown> }

test('turn cost: tokens × price, cache reads at a tenth', () => {
  const pricing = pricingFor(
    {
      model: 'claude-opus-5',
      currency: 'THB',
      inputPerMTok: '180',
      outputPerMTok: '900',
    },
    'claude-opus-5',
  )
  if (!pricing) throw new Error('no pricing')
  // 10k in (฿1.80) + 2k out (฿1.80) + 100k cache read (฿1.80) = ฿5.40.
  expect(
    costOf(pricing, {
      input: 10_000,
      output: 2_000,
      cacheWrite: 0,
      cacheRead: 100_000,
    }),
  ).toBe(540)
  // USD list prices when the owner set none.
  expect(
    pricingFor({ model: 'claude-opus-5' }, 'claude-opus-5')?.currency,
  ).toBe('USD')
  expect(pricingFor({ model: 'x', currency: 'THB' }, 'x')).toBeNull()
})

suite('the builtin runner against Postgres', () => {
  let w: World
  let server: ReturnType<typeof Bun.serve>
  let seen: Seen[] = []
  let promptId = ''

  const logger = createLogger('agent-runner-test')

  beforeAll(() => {
    process.env.HQ_SEALING_KEY = randomBytes(32).toString('base64')
    process.env.HQ_RUNTIME_ALLOW_PRIVATE = '1'
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>
        const headers: Record<string, string> = {}
        request.headers.forEach((value, key) => {
          headers[key] = value
        })
        seen.push({ headers, body })
        const turn = seen.length
        const usage = {
          input_tokens: 2_000,
          output_tokens: 400,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }
        const base = {
          id: `msg_${turn}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          stop_sequence: null,
          usage,
        }
        if (turn === 1)
          return Response.json({
            ...base,
            stop_reason: 'tool_use',
            content: [
              { type: 'text', text: 'Reading the prompt library first.' },
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'prompts_list',
                input: { project_id: w.project.id },
              },
            ],
          })
        if (turn === 2)
          return Response.json({
            ...base,
            stop_reason: 'tool_use',
            content: ['Warm', 'Neon', 'Grain'].map((style, index) => ({
              type: 'tool_use',
              id: `toolu_p${index}`,
              name: 'agents_propose',
              input: {
                kind: 'prompt_variant',
                title: `${style} hook`,
                payload: {
                  promptId,
                  text: `${style} light, slow push-in on the lamp.`,
                  style,
                },
                rationale: 'The plain hook read 30% lower at 72h.',
              },
            })),
          })
        return Response.json({
          ...base,
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: 'Proposed three hook variants: Warm, Neon, Grain.',
            },
          ],
        })
      },
    })
  })

  beforeEach(async () => {
    seen = []
    w = await resetWorld(TABLES, { kind: 'channel' })
    const made = await withTransaction((tx) =>
      createTarget(
        'prompt',
        { title: 'Desk tour hook', medium: 'video', text: 'A slow push-in.' },
        { tx, actor: w.owner, project: w.project },
      ),
    )
    promptId = made.id
  })

  afterAll(async () => {
    server.stop(true)
    await closeTestDb(TABLES)
  })

  function context(): ToolContext {
    return {
      caller: {
        via: 'personal',
        userId: w.agent.userId,
        userRole: 'admin',
        grantId: w.agent.grantId as string,
        actorType: 'agent',
        label: 'Runner (test)',
        scopes: w.agent.scopes as Set<never>,
      },
      db: w.db,
      log: logger,
    }
  }

  async function setUp(cashPerDay: string) {
    const key = await saveProviderConnection(w.owner, {
      provider: 'llm:anthropic',
      label: 'Main key',
      secret: 'sk-ant-test-9f2a',
      config: {
        baseUrl: `http://127.0.0.1:${server.port}`,
        model: 'claude-opus-5',
        currency: 'THB',
        inputPerMTok: '180',
        outputPerMTok: '900',
        maxOutputTokens: 2_000,
      },
    })
    await savePolicy(w.owner, w.project.id, {
      expectedRevisionNo: 0,
      status: 'active',
      releaseMode: 'human_required',
      coverage: 'selected',
      grantIds: [w.agent.grantId],
      allowedActions: ['propose', 'draft'],
      cashLimitPerJob: '5.00',
      cashLimitPerDay: cashPerDay,
      cashLimitPerMonth: '100.00',
    })
    const routine = await saveRoutine(w.owner, {
      projectId: w.project.id,
      name: 'Hook review',
      cron: '0 9 * * *',
      playbook:
        'Review the last 7 days of readings, then propose three new hook variants.',
      modules: ['prompts', 'readings'],
      runner: 'builtin',
      llmConnectionId: key.id,
    })
    await runRoutineNow(w.owner, { routineId: routine.id })
    return routine
  }

  test('the model sees the module tools, never the lifecycle or the run', () => {
    const names = toolsFor(['prompts'], new Set(w.agent.scopes)).map(
      (entry) => entry.wireName,
    )
    expect(names).toContain('agents_propose')
    expect(names).toContain('prompts_list')
    expect(names).not.toContain('agents_claim_task')
    expect(names).not.toContain('agents_finish')
    expect(names).not.toContain('board_list_cards')
    const propose = toolsFor(['prompts'], new Set(w.agent.scopes)).find(
      (entry) => entry.wireName === 'agents_propose',
    )
    const properties = propose?.definition.input_schema.properties as Record<
      string,
      unknown
    >
    expect(Object.keys(properties)).not.toContain('run_id')
    expect(Object.keys(properties)).not.toContain('idempotency_key')
  })

  test('a routine run proposes three variants and ends', async () => {
    const routine = await setUp('50.00')
    const report = await runOnce({
      actor: w.agent,
      context: context(),
      log: () => {},
    })
    expect(report).toMatchObject({ ran: true, outcome: 'done', turns: 3 })
    expect(seen[0]?.headers['x-api-key']).toBe('sk-ant-test-9f2a')
    expect(seen[0]?.headers['anthropic-version']).toBeTruthy()
    expect(seen[0]?.body).toMatchObject({
      model: 'claude-opus-5',
      fallbacks: 'default',
    })
    const system = JSON.stringify(seen[0]?.body.system)
    expect(system).toContain('Hook review')
    const proposals = await listProposals(w.owner, { routineId: routine.id })
    expect(proposals).toHaveLength(3)
    expect(
      proposals.every(
        (entry) => entry.proposal.runId === (report.ran ? report.runId : ''),
      ),
    ).toBe(true)
    const [run] = await listRuns(w.owner, { routineId: routine.id })
    // 3 turns × (2,000 in × ฿180 + 400 out × ฿900) per million = ฿2.16.
    expect(run).toMatchObject({ status: 'succeeded', proposals: 3 })
    expect(run?.cost).toEqual([{ currency: 'THB', minor: 216 }])
    expect(run?.tokens).toBe(7_200)
  })

  test('over budget, the run stops before it spends', async () => {
    await setUp('0.10')
    const report = await runOnce({
      actor: w.agent,
      context: context(),
      log: () => {},
    })
    expect(report).toMatchObject({
      ran: true,
      outcome: 'budget_exceeded',
      turns: 1,
    })
    expect(seen).toHaveLength(0)
    const [run] = await w.db.select().from(opsAgentRuns)
    expect(run?.status).toBe('failed')
    expect(run?.error).toContain('budget_exceeded')
    const [task] = await w.db
      .select()
      .from(opsTasks)
      .where(eq(opsTasks.id, run?.taskId as string))
    expect(task?.status).toBe('blocked')
    expect(await w.db.select().from(opsUsageEvents)).toHaveLength(0)
  })
})
