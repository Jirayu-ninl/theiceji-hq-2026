# TheIceJi HQ

A self-hosted personal command center. HQ is made of **projects** — a channel,
a shop, a film, client work, your own life — and each project runs the
**modules** it needs. AI agents work across them under rules you set, and an
OAuth-protected **MCP server** lets Claude, ChatGPT and other MCP clients use
HQ with only the permissions you grant.

It is built for one owner: your own accounts, your own Postgres, your own
OAuth server. Nothing leaves HQ without the owner's say-so — a post, a
listing, a quote, a payment.

## Modules

| Module | What it does |
| --- | --- |
| Notes | A pinboard of notes; promote one to a card on a project's board |
| Board | Kanban per project — clients, follow-ups, deposits and part payments, and what is still owed |
| Clients | HQ-wide client records that cards and quotes point at |
| Prompts | Prompt templates whose `<VARIANTS>` are filled from options, with examples |
| Assets | Files on Cloudflare R2 (or any S3-compatible store) or Google Drive, plus generation jobs |
| Story | Script, characters, scenes and shots for a film |
| Calendar | Events, with two-way Google Calendar sync |
| Quotes | Thai/English quotations with VAT and withholding tax, rendered to PDF |
| Publish | Plan, clear and record posts, with their readings (views, likes, earnings) |
| Market | Products, listings (an Etsy adapter, or by hand), sales, fees and payouts |
| Experiments | A question, its variants, the readings, a decision and what was learned |
| Readings | The numbers across posts, listings and the board |
| Agents | Routines, runs, budgets, proposals and requests that wait in the owner's Inbox |

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/hq` | The Next.js app: every screen, server actions, and the OAuth 2.1 authorization server (port 8990) |
| `apps/hq-mcp` | The MCP server — Streamable HTTP and stdio (port 8991). See [its README](apps/hq-mcp/README.md) |
| `apps/agent-runner` | The built-in agent runner: runs routines with Claude and the owner's API key, on your own machine |
| `apps/worker` | A local worker that makes the files HQ asks for. See [its README](apps/worker/README.md) |
| `packages/hq-db` | The Postgres schema (Drizzle) and the access-token primitives |
| `packages/hq-ops` | The agent-operations kernel: actors and scopes, idempotency, audit, policies, leases, budgets, the ops tick |
| `packages/hq-core` | Projects, the module registry, links between modules, provider connections |
| `packages/hq-<module>` | Each module's services, shared by the app, the MCP server and the agents |
| `packages/hq-auth` · `hq-push` · `hq-storage` | Sign-in, Web Push, object storage |
| `packages/mcp-kernel` | A neutral MCP server kernel (transport, gate, tool contract) |
| `packages/net-guard` | Outbound fetches of user-supplied URLs, limited to public addresses |

## Requirements

- [Bun](https://bun.sh) 1.3.14 (pinned in `packageManager`)
- PostgreSQL 13 or later
- Optional: an R2 bucket or a Google Cloud OAuth client (Drive and Calendar)
  for files, VAPID keys for Web Push, an Anthropic API key for the built-in
  agent runner. Each is explained in [`apps/hq/.env.example`](apps/hq/.env.example);
  HQ runs without them and says what is missing.

## Quick start

```bash
bun install
cp apps/hq/.env.example apps/hq/.env.local
```

In `apps/hq/.env.local`, set `DATABASE_URL` to an empty database and
`HQ_SEALING_KEY` to 32 random bytes (`openssl rand -base64 32`). Then:

```bash
cd apps/hq
bun run db:migrate
bun run user:create -- --email you@example.com --name 'Your Name'
bun run dev
```

Open <http://localhost:8990> and sign in. There is no sign-up screen;
accounts are made with `bun run user:create`.

### Demo data

`bun run db:seed` fills a local database with five projects and something in
every module. Everything in it is fictional. It refuses a database that is
not on localhost, and one that already has projects (unless `--reset`).

Files need storage. The repo has a small S3 stand-in for local use:

```bash
bun run packages/hq-storage/test/fake-s3.ts
```

It listens on port 9901 and keeps files in memory (set `FAKE_S3_DIR` to keep
them on disk). Add these to `apps/hq/.env.local`, then run the seed from
`apps/hq`:

```dotenv
R2_ENDPOINT=http://localhost:9901
R2_BUCKET=hq-local
R2_ACCESS_KEY_ID=local
R2_SECRET_ACCESS_KEY=local
R2_ACCOUNT_ID=
```

```bash
bun run db:seed
```

### The MCP server

```bash
cp apps/hq-mcp/.env.example apps/hq-mcp/.env
```

Point its `DATABASE_URL` at the same database. The defaults
(`MCP_PUBLIC_URL=http://localhost:8991/mcp`,
`MCP_AUTHORIZATION_SERVER=http://localhost:8990`) suit local use. In
`apps/hq/.env.local`, set `OAUTH_ISSUER=http://localhost:8990` and
`MCP_RESOURCE_URLS=http://localhost:8991/mcp`. Then, from the repo root:

```bash
bun run dev:hq-mcp
```

Connect an MCP client to `http://localhost:8991/mcp`; it signs in through HQ.
For a local stdio server, set `HQ_LOCAL_USER_EMAIL` in `apps/hq-mcp/.env` and
run `bun run hq-mcp:stdio`. Client setup, scopes and the tool list are in
[`apps/hq-mcp/README.md`](apps/hq-mcp/README.md).

## Tests

Each package runs its own checks:

```bash
cd packages/hq-board
bun test test
bunx biome ci .
bunx tsc --noEmit
```

Suites that need Postgres are skipped unless you opt in. Give them a
throwaway database on localhost, migrated first. They truncate tables, so
run one package at a time:

```bash
cd apps/hq && DATABASE_URL=postgres://user:pass@localhost:5432/hq_test bun run db:migrate
cd packages/hq-board && BOARD_DB_TESTS=1 DATABASE_URL=postgres://user:pass@localhost:5432/hq_test bun test test
```

The flags are `AGENTS_`, `ASSETS_`, `BOARD_`, `CALENDAR_`, `CORE_`, `DATA_`,
`EXPERIMENTS_`, `HQ_`, `MARKET_`, `NOTES_`, `OPS_`, `PROMPTS_`, `PUBLISH_`,
`QUOTES_`, `READINGS_`, `RUNNER_`, `STORY_` and `WORKER_DB_TESTS`. The MCP
server's acceptance scripts are listed in its README.

## Deploying

- **`apps/hq`** suits Vercel: set the project's root directory to `apps/hq`.
  `vercel.json` schedules two daily crons (database keep-alive and an ops-tick
  backstop), which need `CRON_SECRET`.
- **`apps/hq-mcp`** is a long-lived Bun process. Build its image from
  `apps/hq-mcp/Dockerfile` with the repo root as the build context.
  `.railway/railway.ts` is a ready Railway configuration.
- **`apps/agent-runner`** and **`apps/worker`** run on your own machine. A run
  can outlast a serverless function.

Run `bun run db:migrate` against the production database before you deploy a
version that adds migrations.

## Security

- Provider credentials, the Google refresh token and LLM keys are sealed with
  `HQ_SEALING_KEY` (AES-256-GCM). `apps/hq`, `apps/hq-mcp` and
  `apps/agent-runner` must share the same value.
- MCP access tokens are opaque, stored only as SHA-256 hashes, and checked on
  every call, so revoking a connection in HQ takes effect at once.
- `.env` files are git-ignored. Keep them that way.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

HQ is released under the [MIT License](LICENSE). Copyright (c) 2026 TheIceJi.

The IBM Plex Sans Thai fonts bundled for quote PDFs
(`packages/hq-quotes/fonts`) keep their own license, the SIL Open Font
License 1.1, in [`OFL.txt`](packages/hq-quotes/fonts/OFL.txt).
