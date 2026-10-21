// @theiceji/mcp-kernel — everything an MCP server in this monorepo shares:
// the Streamable HTTP surface and its gate, the workspace/tool contract, the
// catalog that builds one McpServer per caller, protected-resource metadata,
// the rate budgets, config parsing and the stdio `.env` loader.
//
// Neutral by construction: it imports no app and no database, and knows no
// scope vocabulary. Each server owns its own `src/workspaces/`, its identity,
// its caller and context types (`toolkit<Context>()`), its token check
// (`looksLikeBearer` + `verify`) and its scopes, and passes them all in.

export {
  bearerChallenge,
  type MetadataConfig,
  metadataPaths,
  metadataUrl,
  protectedResourceMetadata,
} from './auth/metadata'
export {
  createRateLimiter,
  type RateDecision,
  type RateLimiter,
} from './auth/rateLimit'
export {
  type BaseConfig,
  BaseConfigSchema,
  canonicalResource,
  describeConfigLine,
  parseConfig,
  portSchema,
} from './config'
export {
  buildServer,
  type CatalogEntry,
  catalog,
  instructionsFor,
  type ServerIdentity,
} from './core/catalog'
export {
  errorMessage,
  fail,
  failWith,
  type Json,
  ok,
} from './core/results'
export {
  type AnyTool,
  type Caller,
  defineTool,
  defineWorkspace,
  type ScopeOf,
  type ToolContext,
  type ToolDefinition,
  type Toolkit,
  toolkit,
  type Workspace,
  type WorkspaceResource,
} from './core/workspace'
export { loadLocalEnv } from './localEnv'
export { createLogger, type Logger } from './log'
export {
  type AccessCheck,
  type AccessRefusal,
  BUDGETS,
  type ConnectionInfo,
  clientAddress,
  createFetchHandler,
  type HttpConfig,
  type ReadinessCheck,
  type ReadinessReport,
  type ServerDeps,
} from './server'
