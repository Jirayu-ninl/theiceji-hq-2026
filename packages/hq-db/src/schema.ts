/**
 * The HQ database — plain Postgres, owned by apps/hq (it writes the
 * migrations) and read by apps/hq-mcp (it verifies bearer tokens) and the
 * worker. One file per module under ./schema; this barrel is
 * what drizzle-kit, `drizzle(sql, { schema })` and readiness see.
 *
 * · auth      users, sessions, push, HQ's OAuth 2.1 authorization server
 * · notes     the Notes board
 * · core      projects, Google and provider connections, `refs`
 * · ops       the one agent-operations kernel, `ops_*`
 * · board · assets · prompts · calendar · quotes
 *             the active-work modules
 * · publish · market · experiments
 *             the passive-income modules
 * · story     a film's script, characters, scenes and shots
 * · agents    routines and the proposals their runs leave
 *
 * Change a column here, then `bun run db:generate` → `bun run db:migrate`
 * from apps/hq.
 */

export * from './schema/agents'
export * from './schema/assets'
export * from './schema/auth'
export * from './schema/board'
export * from './schema/calendar'
export * from './schema/core'
export * from './schema/experiments'
export * from './schema/market'
export * from './schema/notes'
export * from './schema/ops'
export * from './schema/prompts'
export * from './schema/publish'
export * from './schema/quotes'
export * from './schema/story'
