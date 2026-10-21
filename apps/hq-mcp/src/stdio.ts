#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createDbHandle } from '@theiceji/hq-db'
import { ALL_SCOPES } from '@theiceji/hq-db/access'
import type { UserRole } from '@theiceji/hq-db/enums'
import { users } from '@theiceji/hq-db/schema'
import { configureOpsDatabase } from '@theiceji/hq-ops/db'
import {
  buildServer,
  catalog,
  createLogger,
  loadLocalEnv,
} from '@theiceji/mcp-kernel'
import { eq } from 'drizzle-orm'
import { IDENTITY } from './identity'
import type { HqCaller } from './kernel'
import { MODULE_WORKSPACES } from './modules'

/**
 * Local stdio entry — for Claude Code / Claude Desktop on this machine.
 *
 *   bun run apps/hq-mcp/src/stdio.ts
 *
 * No network, no OAuth: whoever can launch this process already holds the
 * credentials in apps/hq-mcp/.env, so the caller gets every scope. Anything
 * reachable from outside this machine goes through `src/index.ts` instead.
 */
loadLocalEnv(new URL('../.env', import.meta.url))
const log = createLogger('hq-mcp', { stdio: true })

// postgres.js connects lazily, so this costs nothing until a tool queries.
const handle = process.env.DATABASE_URL
  ? createDbHandle(process.env.DATABASE_URL, { max: 2 })
  : null
const db = handle?.db ?? null
if (db) configureOpsDatabase(db)

/*
 * HQ's tools act as an HQ user. Locally that is whoever HQ_LOCAL_USER_EMAIL
 * names — the person who owns this machine's credentials anyway. Without it,
 * every tool answers that no user is configured.
 */
let localUser: { id: string; role: UserRole } | null = null
const email = process.env.HQ_LOCAL_USER_EMAIL?.trim().toLowerCase()
if (db && email) {
  const [row] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  localUser = row ?? null
  if (!localUser) log.warn(`HQ_LOCAL_USER_EMAIL ${email} matches no HQ user`)
}

const caller: HqCaller = {
  via: 'local',
  userId: localUser?.id ?? null,
  userRole: localUser?.role ?? null,
  grantId: null,
  actorType: 'user',
  label: 'local stdio',
  scopes: new Set(ALL_SCOPES),
}

const server = buildServer({
  context: { caller, db, log },
  workspaces: MODULE_WORKSPACES,
  identity: IDENTITY,
})

try {
  await server.connect(new StdioServerTransport())
  log.info(
    `ready on stdio — ${catalog(MODULE_WORKSPACES).length} tools across ${MODULE_WORKSPACES.map((w) => w.id).join(', ')}`,
  )
} catch (error) {
  log.error(`fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
