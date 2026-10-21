# @theiceji/mcp-kernel

Everything the MCP servers in this repo share, so none of them owns a copy of
the part that must not drift: the gate in front of the protocol.

- `server.ts` — the Streamable HTTP surface and everything that happens before
  a body reaches the SDK: origin allowlist, method and content type, the bearer
  shape, the rate budgets, the token→caller lookup, scope step-up, dispatch.
  Also the contract a server's token check answers in (`AccessCheck`) and the
  `/readyz` report shape (`ReadinessReport`).
- `core/workspace.ts` — the workspace and tool contract: the base `Caller` and
  `ToolContext`, `ScopeOf`, and `toolkit<Context>()` for a server's own
  context-typed `defineTool` / `defineWorkspace`.
- `core/catalog.ts` — the wire names, and one `McpServer` per caller holding
  only the tools that caller's scopes reach.
- `core/results.ts` — `ok` / `fail` / `failWith` and `errorMessage`.
- `auth/metadata.ts` — RFC 9728 protected-resource metadata and the
  `WWW-Authenticate` challenges.
- `auth/rateLimit.ts` — the per-key fixed windows the budgets are made of.
- `config.ts` — the config every server shares (`BaseConfigSchema`), plus
  `parseConfig`, `portSchema`, `canonicalResource` and the boot line.
- `log.ts`, `localEnv.ts` — the stream-aware logger and the stdio `.env` loader.

## Neutral by construction

The kernel imports no app and no database, and knows no scope vocabulary.
Whatever is specific to a server — its workspaces, its identity, what it knows
about a caller, what its tools are handed, how its tokens look and where they
are checked, its scopes — the server brings and passes in. Servers built on it
are otherwise unrelated: they share this code, never a runtime.

A server widens the base types once, in its own `src/kernel.ts`:

```ts
import { type Caller, type Logger, toolkit } from '@theiceji/mcp-kernel'
import type { Scope } from './scopes' // the server's own vocabulary

export type MyCaller = Caller<Scope> & { /* what else it knows */ }
export type ToolContext = { caller: MyCaller; log: Logger; /* db, … */ }
export const { defineTool, defineWorkspace } = toolkit<ToolContext>()
```

Its tools then receive exactly that context, and `scope:` must be one of its
`Scope`s — a typo is a compile error, not a tool nobody can ever see.

## Serving over HTTP

```ts
const service = createFetchHandler({
  config,                 // <server>ConfigSchema, extended from BaseConfigSchema
  identity: IDENTITY,     // name · version · preamble · resourceName · connectPrompt
  scopes: ALL_SCOPES,     // the whole vocabulary, canonical order
  looksLikeBearer,        // the token shape — cheap, no database
  verify: async (token) => toAccessCheck(await lookUp(token)),
  context: (caller) => ({ caller, log }),
  ready,                  // optional: () => Promise<ReadinessReport>
  touch,                  // optional: best-effort "last used" per grant
  workspaces: WORKSPACES,
  log,
})
```

- `scopes` is used to format every `scope=` the gate writes and
  `scopes_supported`: known scopes only, in this order.
- `verify` answers `{ ok: true, caller, clientId, expiresAt }` or
  `{ ok: false, reason }` (`unknown` · `expired` · `revoked` ·
  `wrong-resource`). It runs on every request and is never cached — it is the
  revocation check.
- User-facing refusals are phrased from `identity.resourceName`
  (`That is not a <resourceName> access token.`), so nothing here names a
  product.

Over stdio there is no gate: build the context by hand and call
`buildServer({ context, workspaces, identity })`.

Consumers: the MCP servers under `apps/*-mcp`. Each has its own README.
