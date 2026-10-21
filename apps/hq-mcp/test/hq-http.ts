#!/usr/bin/env bun
/**
 * Acceptance, HTTP half: boots the real server
 * (src/index.ts) on a free local port against a throwaway database, mints a
 * personal token holding only `hq:read`, and calls `hq_get_brief` through
 * the Streamable HTTP client the way a connector does. Also checks that the
 * same token can't reach a tool it has no scope for.
 *
 * Run hq-stdio.ts first (it seeds the database), then:
 *   DATABASE_URL=postgres://…localhost…/<throwaway> bun run test/hq-http.ts
 */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { createDbHandle } from '@theiceji/hq-db'
import { hashToken, mintToken, tokenHint } from '@theiceji/hq-db/access'
import { oauthGrants, oauthTokens, users } from '@theiceji/hq-db/schema'
import { eq } from 'drizzle-orm'

const url = process.env.DATABASE_URL ?? ''
if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
  console.error(
    'Refusing: DATABASE_URL must be a localhost throwaway database.',
  )
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, '../src/index.ts')
const port = 8960 + Math.floor(Math.random() * 30)
const publicUrl = `http://localhost:${port}/mcp`

let failures = 0
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

/* A personal token for the seeded user, `hq:read` only, bound to this URL. */
const handle = createDbHandle(url, { max: 1 })
const [user] = await handle.db
  .select()
  .from(users)
  .where(eq(users.email, 'stdio-smoke@hq.test'))
  .limit(1)
if (!user) {
  console.error('Seed first: run test/hq-stdio.ts against the same database.')
  process.exit(1)
}
const token = mintToken('personalToken')
const [grant] = await handle.db
  .insert(oauthGrants)
  .values({
    userId: user.id,
    kind: 'personal',
    label: 'hq-http acceptance',
    scope: 'hq:read',
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

const server = spawn('bun', ['run', entry], {
  env: {
    PATH: process.env.PATH ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
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

try {
  for (let i = 0; i < 60 && !logs.includes('listening on'); i++)
    await new Promise((done) => setTimeout(done, 250))
  check(
    'the HTTP server boots',
    logs.includes('listening on'),
    logs
      .split('\n')
      .find((line) => line.includes('listening on'))
      ?.trim(),
  )

  const client = new Client({ name: 'hq-http', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(publicUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  const { tools } = await client.listTools()
  const names = tools.map((tool) => tool.name).sort()
  check(
    'an hq:read token sees exactly the hq:read tools',
    names.every((name) => name.startsWith('hq_')) &&
      names.length === 6 &&
      !names.includes('hq_create_client'),
    names.join(', '),
  )

  const brief = (await client.callTool({
    name: 'hq_get_brief',
    arguments: {},
  })) as {
    isError?: boolean
    content?: { text?: string }[]
    structuredContent?: {
      ok?: boolean
      you?: { type: string; scopes: string[] }
      projects?: unknown[]
    }
  }
  console.log(`   hq_get_brief → ${brief.content?.[0]?.text}`)
  check(
    'hq_get_brief answers over HTTP',
    !brief.isError && brief.structuredContent?.ok === true,
  )
  check(
    'it answers as the agent, with only hq:read',
    brief.structuredContent?.you?.type === 'agent' &&
      brief.structuredContent?.you?.scopes.join() === 'hq:read',
  )
  // One blocker per seeded project — none has a policy for this agent yet.
  const seeded = brief.structuredContent?.projects?.length ?? 0
  check(
    'an agent is told the policy isn’t in force',
    seeded > 0 &&
      (brief.structuredContent as { blockers?: string[] })?.blockers?.length ===
        seeded,
    `${seeded} project(s)`,
  )

  await client.close()

  const stepUp = await fetch(publicUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'board_list_cards', arguments: {} },
    }),
  })
  check(
    'a tool outside the grant (board_list_cards) is a 403 step-up for board:read',
    stepUp.status === 403 &&
      (stepUp.headers.get('www-authenticate') ?? '').includes('board:read'),
    `${stepUp.status} ${stepUp.headers.get('www-authenticate') ?? ''}`,
  )
} finally {
  server.kill()
  await handle.db.delete(oauthGrants).where(eq(oauthGrants.id, grant.id))
  await handle.sql.end({ timeout: 5 })
}
console.log(failures === 0 ? '\nall good.' : `\n${failures} failed.\n${logs}`)
process.exit(failures === 0 ? 0 : 1)
