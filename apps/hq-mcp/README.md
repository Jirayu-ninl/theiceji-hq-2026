# apps/hq-mcp — TheIceJi HQ MCP server

HQ is a command center made of **projects** (a channel, a shop, a film, client
work, personal), each running the **modules** it needs — Board, Prompts,
Assets, Story, Calendar, Quotes, Publish, Market, Experiments, Readings — with
Agents working across them. This app is HQ's **MCP face**:
every module's tools, served to Claude, ChatGPT, Hermes Agent, Claude Code,
Cursor, VS Code and any other MCP client — with only the permissions the owner
grants each one.

The transport, the gate in front of it and the tool contract come from
`packages/mcp-kernel`, a neutral library that knows nothing about HQ.
`src/kernel.ts` specialises it once: HQ's caller (user role, agent or worker),
HQ's tool context (`caller`, `db`, `log` — there is no ambient project; a tool
takes `project_id`), and the `defineTool` / `defineWorkspace` every module
here uses — so each tool's scope is checked against HQ's vocabulary at
compile time.

Two entries, one tool catalog (`MODULE_WORKSPACES`, `src/modules/index.ts`):

| Entry | Transport | Auth | Where |
| --- | --- | --- | --- |
| `src/index.ts` | Streamable HTTP (stateless) | OAuth 2.1 bearer, issued by HQ | Railway (`Dockerfile`) |
| `src/stdio.ts` | stdio | none — the local owner gets every scope | your machine |

`apps/agent-runner` runs the same catalog in-process for built-in routines,
and `apps/worker` reaches it over HTTP with a worker token.

## How auth works

HQ (`apps/hq`) is the **authorization server**; this app is its **resource
server**. They share HQ's Postgres (`@theiceji/hq-db`), so a connection revoked
in HQ → Settings → Connections stops on its very next call — tokens are opaque,
stored only as SHA-256, and looked up on every request (never cached).

```
client ──POST /mcp (no token)──────────────▶ apps/hq-mcp
       ◀─401 WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"
client ──GET  protected-resource metadata──▶ apps/hq-mcp → authorization_servers: [HQ]
client ──GET  /.well-known/oauth-authorization-server──▶ apps/hq
client ──register: CIMD (client_id = https URL) or POST /oauth/register (DCR)──▶ apps/hq
owner  ──GET  /oauth/authorize → sign in → consent (tick the scopes)──▶ apps/hq
client ──POST /oauth/token  (PKCE S256 + RFC 8707 resource)──▶ apps/hq → hq_at_… + hq_rt_…
client ──POST /mcp  Authorization: Bearer hq_at_…──▶ apps/hq-mcp → tools for the granted scopes
```

What each client needs, and what HQ does about it:

- **Claude** (claude.ai, Desktop, mobile) — DCR or CIMD, PKCE S256, `resource`,
  `offline_access` in the AS metadata, port-agnostic loopback for Claude Code.
- **ChatGPT** — CIMD or DCR, S256 advertised, RFC 9207 `iss` on the redirect (lets
  it use its shared callback). Its metadata document says `private_key_jwt`; HQ
  treats metadata-document clients as public (PKCE) and ignores the assertion.
- **Hermes Agent** — `auth: oauth` (CIMD, loopback callback, may omit
  `resource` → HQ uses its default) or static `headers` with a personal token.
- **Anything that only sends headers** (n8n, OpenAI Responses API `authorization`,
  scripts) — a personal access token `hq_pat_…`, minted in HQ → Settings → Connections.

## Workspaces, tools, scopes

One MCP workspace per module, plus `hq` for what belongs to no module. Tool
names are `<module>_<action>` (60 tools — at the cap of 60). A
tool is listed only when the connection holds its scope; calling one it
doesn't hold answers `403 insufficient_scope` naming the missing scope, which
makes OAuth clients re-consent (step-up).

| Workspace | Scope | Tools |
| --- | --- | --- |
| `hq` | `hq:read` · `board:write` | `get_brief` · `get_capabilities` · `list_projects` · `get_project` · `search` · `list_clients` (HQ-wide clients that cards and quotes point at) · `create_client` (`board:write`; archiving is the owner's) |
| `board` | `board:read` · `board:write` | `list_cards` (`card_id` for one card with its follow-ups and payments) · `create_card` · `update_card` · `move_card` · `add_followup` · `update_followup` (recording payments, marking paid and removing a follow-up are the owner's) |
| `prompts` | `prompts:read` · `prompts:write` | `list` · `get` · `save` (prompt + variants) · `add_example` |
| `assets` | `assets:read` · `assets:write` · `assets:operate` | `list` · `get_access` · `get_job` · `prepare_upload` · `finalize` · `record_generated` · `queue_generation` |
| `story` | `story:read` · `story:write` | `get` · `save_script` · `save_shots` |
| `calendar` | `calendar:read` · `calendar:write` | `list_events` · `create_event` |
| `quotes` | `quotes:read` · `quotes:write` | `list` · `draft` (drafts only — sending is the owner's) |
| `publish` | `publish:read` · `publish:write` · `publish:operate` | `list_posts` · `prepare` · `record_reading` · `cancel` · `dispatch` · `record_manual` |
| `market` | `market:read` · `market:write` · `market:operate` | `list_listings` · `prepare` · `record_sale` · `record_payout` · `dispatch` · `record_manual` |
| `experiments` | `experiments:read` · `experiments:write` · `ops:decide` | `list` · `search_learnings` · `save` · `transition` · `record_learning` · `record_decision` (`ops:decide`) |
| `readings` | `readings:read` | `query` |
| `agents` | `agents:operate` | `claim_task` · `heartbeat` · `checkpoint` · `propose` · `request_human` · `list_human_responses` · `pull_events` · `ack_events` · `record_cost` · `finish` |

Every tool runs the same `@theiceji/hq-<module>` / `@theiceji/hq-core` /
`@theiceji/hq-ops` services as HQ's screens (`src/modules/support.ts` is the
glue): the actor comes from the grant (agent or worker, set when the token is
made), a tool that works inside a project takes `project_id` and the service
checks the owner, every write takes an `idempotency_key` (updates also
`expected_revision`, lease work the `fencing_token`), and refusals are typed —
`{ ok: false, error: { code, retryable } }` with `policy_blocked`,
`budget_exceeded`, `reauth_required`, `capability_unavailable`,
`unknown_remote_outcome`, `revision_conflict`, `lease_lost`. Each project's
operating policy (HQ → Settings → Policies) decides what a connection may
actually do there. Sending, publishing, paying, marking paid and changing policy,
budgets or credentials are the owner's and have no tool.

### The agent loop

1. Start every session with `hq_get_brief` (what waits, what runs, blockers)
   and `hq_get_capabilities` (your scopes, and whether a policy is in force
   for you in each project).
2. Routine work comes from `agents_claim_task` — a routine's run returns with
   its playbook, the modules it may use and its project, under a lease and a
   fencing token. `agents_heartbeat` every third of the lease;
   `agents_checkpoint` as you go; `lease_lost` means stop.
3. What you find becomes proposals (`agents_propose`) for the owner's Inbox —
   never a direct change they didn't ask for. Ask them with
   `agents_request_human`; read their answers with `agents_pull_events` /
   `agents_list_human_responses`.
4. Report spend with `agents_record_cost` (`budget_exceeded` ends the run),
   then `agents_finish`.

### Adding a module

1. Its service package `packages/hq-<m>` (framework-free), its tables in
   `packages/hq-db/src/schema/<m>.ts`, its id in `MODULE_IDS`
   (`packages/hq-core/src/modules.ts`), and its scopes in `SCOPES`
   (`packages/hq-db/src/access/scopes.ts` — HQ's consent screen and
   Connections page pick them up).
2. `src/modules/<m>/index.ts` here: `defineWorkspace({ id: '<m>', label,
   description, instructions, tools })` with tools from `defineTool` in
   `src/kernel.ts` (not the kernel package — those are untyped for HQ), and
   `import '@theiceji/hq-<m>/register'` so its targets and tick steps exist in
   this process.
3. Append it to `MODULE_WORKSPACES` in `src/modules/index.ts`, in the module
   order.

## Connect a client

The endpoint is `MCP_PUBLIC_URL`, e.g. `https://mcp.example.com/mcp`. HQ →
Connections shows it with copyable setup for each client.

- **Claude** — Settings → Connectors → Add custom connector → paste the URL.
- **ChatGPT** — Settings → Apps → Advanced settings → Developer mode, then create
  an app with the URL and OAuth.
- **Claude Code** — `claude mcp add --transport http theiceji-hq https://mcp.example.com/mcp`, then `/mcp` to sign in.
  With a personal token instead: add `--header "Authorization: Bearer hq_pat_…"`.
- **Hermes Agent** — `~/.hermes/config.yaml`:

  ```yaml
  mcp_servers:
    theiceji-hq:
      url: https://mcp.example.com/mcp
      auth: oauth            # or, headless:
      # headers:
      #   Authorization: "Bearer ${HQ_MCP_TOKEN}"
  ```
- **MCP Inspector / browser clients** — add their hostname to
  `MCP_ALLOWED_ORIGIN_HOSTS`, or requests carrying an `Origin` get 403.

**Local stdio (no network, no OAuth)** — the repo's `.mcp.json` registers it for
Claude Code:

```bash
claude mcp add theiceji-hq -- bun run ./apps/hq-mcp/src/stdio.ts
```

It reads `apps/hq-mcp/.env` itself. Every tool acts as the HQ user named by
`HQ_LOCAL_USER_EMAIL`.

## Develop

```bash
cp apps/hq-mcp/.env.example apps/hq-mcp/.env   # fill DATABASE_URL
bun run dev:hq-mcp                             # HTTP on :8991, --watch
bun run hq-mcp:stdio                           # stdio
```

For the OAuth flow locally, run HQ with `OAUTH_ISSUER=http://localhost:8990` and
`MCP_RESOURCE_URLS=http://localhost:8991/mcp`, and apply HQ's migrations to the
same database.

## Test

```bash
bun run --cwd apps/hq-mcp test:http     # the HTTP gate: scopes, step-up, retry-safe writes, rate budgets, CORS, /readyz — no DB, no writes
bun run --cwd apps/hq-mcp test:smoke    # stdio: the module catalog, the session instructions, an hq answer — no DB, no writes
bun run --cwd apps/hq-mcp check         # tsc
```

Against a **throwaway localhost** Postgres (each refuses any other; they seed
and truncate):

```bash
DATABASE_URL=postgres://…localhost…/<throwaway> bun run --cwd apps/hq-mcp test:hq      # every module over stdio (seeds), then hq:read over HTTP
DATABASE_URL=postgres://…localhost…/<throwaway> bun run --cwd apps/hq-mcp test:agents  # a routine run end to end over HTTP
```

`test/oauth-e2e.ts` drives the whole journey — discovery, DCR, consent, PKCE,
token exchange, scope-filtered tools (`market:read market:write` granted,
`market:operate` withheld), refresh rotation, code replay revoking the
connection, a real CIMD client (Claude Code's metadata document), and RFC 7009
revocation — against a running HQ + MCP on a **local** database (it refuses any
other). Usage is in its header.

## Health, limits and the ops tick

- `GET /healthz` — liveness: the process answers. Never rate-limited, never
  touches the database.
- `GET /readyz` — readiness: database writable, every table/column/constraint
  the schema declares, the history-table guards, and read/write grants
  (`@theiceji/hq-db/readiness`), plus which optional capabilities are blocked
  (sealing key, R2, the ops tick). 503 with the failing check names when not
  ready; details go to the log.
- **Rate budgets**, all spent before a token lookup: credential-less requests
  per address; lookups of tokens that haven't verified recently, per address
  and process-wide (a stream of fabricated tokens can't buy a query each); and
  every lookup per address and per token. The address is the socket's unless
  `MCP_TRUSTED_PROXY_HOPS` says how many proxies append to `X-Forwarded-For`.
- **Browser clients** from `MCP_ALLOWED_ORIGIN_HOSTS` get CORS on every answer
  (preflight, 401 challenge with `WWW-Authenticate` exposed, 403, 429, results).
- **Ops tick** — every `HQ_SCHEDULER_SECONDS` (60; `0` turns it off here) this
  process runs `@theiceji/hq-ops`' tick: lapsed leases, expiries, stalled runs,
  every module's registered steps (due routines, publish/market reconcile,
  calendar sync, asset checks, …) and event delivery. A lease row keeps it to
  one runner across replicas and HQ's cron route (`/api/cron/ops-tick`). The
  legacy name `CREATOR_SCHEDULER_SECONDS` is still read when
  `HQ_SCHEDULER_SECONDS` is unset.

## Configuration

See `.env.example`. Required over HTTP: `DATABASE_URL`, `MCP_PUBLIC_URL`,
`MCP_AUTHORIZATION_SERVER`. Optional: `HQ_SCHEDULER_SECONDS`, `HQ_SEALING_KEY`
(the same value as apps/hq; the legacy name `CREATOR_SEALING_KEY` is read when
it is unset), `R2_*` for asset uploads, `HQ_LOCAL_USER_EMAIL` for stdio. The
shared part of the schema lives in `packages/mcp-kernel/src/config.ts`;
`src/config.ts` adds HQ's own. The boot line names what the process will talk
to; config errors list every bad variable at once.

## Deploy

Railway, from `apps/hq-mcp/Dockerfile` (build context = repo root,
`turbo prune`, pinned Bun image, non-root). Settings live in
`.railway/railway.ts`. Full steps, variables and the HQ side are in
[DEPLOY.md](../../DEPLOY.md#appshq-mcp--railway).

Logging goes to stdout/stderr only; over stdio, stdout is reserved for the protocol.
