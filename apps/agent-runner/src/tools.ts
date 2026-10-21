import type Anthropic from '@anthropic-ai/sdk'
import type { ModuleId } from '@theiceji/hq-db/enums'
import type { AnyTool, ToolContext, Workspace } from 'hq-mcp/src/kernel'
import { MODULE_WORKSPACES } from 'hq-mcp/src/modules'
import { z } from 'zod'

/**
 * The runner's tools are the MCP server's tools (the same tool
 * set, in-process) — the same definitions, the same services, the same
 * scope on every call, the same refusals. Only the plumbing an LLM shouldn't
 * see is taken off:
 *
 * · **The lifecycle is the runner's** — claiming, heartbeats, checkpoints,
 *   cost and finishing are done around the model, not by it.
 * · **The run is injected** — `run_id`, `fencing_token` and an
 *   `idempotency_key` per tool call are filled in by the runner and removed
 *   from the schemas the model sees, so a proposal is always inside the run
 *   that holds the lease.
 * · **Bytes stay out** — upload tools need a client that sends bytes; the
 *   model can queue a generation instead.
 */

/** Workspace tools the model never gets. */
const HIDDEN = new Set([
  'agents_claim_task',
  'agents_heartbeat',
  'agents_checkpoint',
  'agents_finish',
  'agents_record_cost',
  'agents_pull_events',
  'agents_ack_events',
  'assets_prepare_upload',
  'assets_finalize',
  'assets_record_generated',
  'assets_get_access',
])

/** Arguments the runner fills in. */
const INJECTED = ['run_id', 'fencing_token', 'idempotency_key'] as const

export type RunTool = {
  wireName: string
  tool: AnyTool
  definition: Anthropic.Tool
}

export type RunScope = {
  runId: string
  fencingToken: number
}

function schemaFor(tool: AnyTool): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(tool.input, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>
  delete json.$schema
  const properties = { ...((json.properties as Record<string, unknown>) ?? {}) }
  for (const key of INJECTED) delete properties[key]
  const required = ((json.required as string[] | undefined) ?? []).filter(
    (key) => !(INJECTED as readonly string[]).includes(key),
  )
  return {
    ...json,
    type: 'object',
    properties,
    ...(required.length ? { required } : { required: undefined }),
  } as Anthropic.Tool.InputSchema
}

/**
 * The tools a routine's run may use: HQ's own (`hq_*`), the modules it names,
 * and from Agents only what a run does in its middle — propose, ask the owner,
 * read their answers. A tool whose scope the connection lacks is left out,
 * so the model never plans around a call that will be refused.
 */
export function toolsFor(
  modules: readonly ModuleId[],
  scopes: ReadonlySet<string>,
  workspaces: readonly Workspace[] = MODULE_WORKSPACES,
): RunTool[] {
  const wanted = new Set<string>(['hq', 'agents', ...modules])
  const out: RunTool[] = []
  for (const workspace of workspaces) {
    if (!wanted.has(workspace.id)) continue
    for (const tool of workspace.tools) {
      const wireName = `${workspace.id}_${tool.name}`
      if (HIDDEN.has(wireName) || !scopes.has(tool.scope)) continue
      out.push({
        wireName,
        tool,
        definition: {
          name: wireName,
          description: tool.description,
          input_schema: schemaFor(tool),
        },
      })
    }
  }
  return out
}

export type ToolOutcome = { text: string; isError: boolean }

const MAX_RESULT_CHARS = 24_000

/** Runs one tool call the model asked for, as the connection, inside the run. */
export async function callTool(
  entry: RunTool,
  raw: unknown,
  context: ToolContext,
  run: RunScope,
  callId: string,
): Promise<ToolOutcome> {
  const shape = entry.tool.input.shape as Record<string, unknown>
  const args: Record<string, unknown> = {
    ...((raw ?? {}) as Record<string, unknown>),
  }
  if ('run_id' in shape) args.run_id = run.runId
  if ('fencing_token' in shape) args.fencing_token = run.fencingToken
  if ('idempotency_key' in shape)
    args.idempotency_key = `${run.runId}:${callId}`
  const parsed = entry.tool.input.safeParse(args)
  if (!parsed.success)
    return {
      text: `Invalid input: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('; ')}`,
      isError: true,
    }
  if (!context.caller.scopes.has(entry.tool.scope))
    return {
      text: `This connection doesn’t have ${entry.tool.scope}.`,
      isError: true,
    }
  try {
    const result = await entry.tool.run(parsed.data, context)
    const prose = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
    const data = result.structuredContent
      ? `\n${JSON.stringify(result.structuredContent)}`
      : ''
    const text = `${prose}${data}`
    return {
      text:
        text.length > MAX_RESULT_CHARS
          ? `${text.slice(0, MAX_RESULT_CHARS)}… (cut — ask for less)`
          : text,
      isError: Boolean(result.isError),
    }
  } catch (error) {
    return {
      text: `The tool failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    }
  }
}
