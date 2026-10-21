// HQ's Postgres handle lives in @theiceji/hq-db, shared with apps/hq-mcp
// (which verifies connected-app tokens against the same tables) and
// apps/agent-runner. HQ owns the migrations. This shim keeps every `@/db` import
// working unchanged.
export {
  closeDb,
  type Db,
  getDb,
  getSql,
  isDbConfigured,
  requireDb,
  schema,
} from '@theiceji/hq-db'
