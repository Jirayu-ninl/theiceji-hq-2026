#!/usr/bin/env bun
/**
 * stdio smoke: boot the local server through the SDK client, then check the
 * catalog, the session instructions and that an HQ tool answers. Never
 * mutates anything (the child gets no DATABASE_URL, so every tool refuses
 * instead of querying).
 *
 *   bun run --cwd apps/hq-mcp test:smoke
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { catalog } from '@theiceji/mcp-kernel/catalog'
import { MODULE_WORKSPACES } from '../src/modules'

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, '../src/stdio.ts')

type Result = {
  isError?: boolean
  content?: { type: string; text?: string }[]
  structuredContent?: Record<string, unknown>
}

let failures = 0
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

const client = new Client({ name: 'smoke', version: '0.0.0' })
await client.connect(
  new StdioClientTransport({ command: 'bun', args: ['run', entry] }),
)
console.log('connected.\n')

const { tools } = await client.listTools()
const names = tools.map((tool) => tool.name).sort()
const prefixes = MODULE_WORKSPACES.map((workspace) => `${workspace.id}_`)
check(
  `lists all ${catalog(MODULE_WORKSPACES).length} tools`,
  tools.length === catalog(MODULE_WORKSPACES).length,
  `${tools.length} listed`,
)
check(
  'every tool is prefixed by one of this server’s module workspaces',
  names.every((name) => prefixes.some((prefix) => name.startsWith(prefix))),
)

/* The session opens with the Project/Module preamble and each workspace's
   instructions — the brief first, routine work through the agents loop. */
const instructions = client.getInstructions() ?? ''
check(
  'the instructions start agents at hq_get_brief and point routines at agents_claim_task',
  instructions.includes('hq_get_brief') &&
    instructions.includes('agents_claim_task') &&
    MODULE_WORKSPACES.every((workspace) =>
      instructions.includes(`(\`${workspace.id}_*\`)`),
    ),
  `${instructions.length} chars`,
)
check(
  'the instructions name no retired workspace',
  !/creator_|merchant_/i.test(instructions),
)

const answer = (await client.callTool({
  name: 'hq_get_capabilities',
  arguments: {},
})) as Result
check(
  'hq tools answer over stdio (capabilities, or why they cannot)',
  Array.isArray(answer.content) && answer.content.length > 0,
  (answer.content?.[0]?.text ?? '').slice(0, 100),
)

/* No module serves a resource (a routine's playbook comes back from
   agents_claim_task), so the server must not advertise the capability. */
const expectedResources = MODULE_WORKSPACES.flatMap(
  (workspace) => workspace.resources ?? [],
)
const advertised = client.getServerCapabilities()?.resources !== undefined
check(
  `resources advertised only when a workspace serves one (${expectedResources.length})`,
  advertised === expectedResources.length > 0,
)
if (advertised) {
  const { resources } = await client.listResources()
  check(
    `lists all ${expectedResources.length} workspace resource(s)`,
    resources.length === expectedResources.length,
    `${resources.length} listed`,
  )
}

await client.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
