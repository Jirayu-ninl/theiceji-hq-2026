# apps/worker — HQ local worker

Runs on the owner's own machine and makes the files HQ asks for. It holds no
database or storage credentials: everything goes through HQ's MCP server with
a **worker** token, and files move through the short-lived URLs HQ signs.

## The job queue

Jobs come from the modules' manifests — a Story scene's ZIP today
(`assets.zip`). Each job sits on an ops task; the worker claims it with a
lease and a fencing token, and HQ refuses a write from a worker that lost the
lease.

```
agents_claim_task (generation · assets — lease + fencing token)
  → agents_heartbeat every third of the lease
  → assets_get_job (operation + input ids)
  → assets_get_access per input → download (SHA-256 checked)
  → make the file (a ZIP of the scene's shots, named by shot code)
  → assets_prepare_upload (job_id) → PUT → assets_finalize (HQ re-hashes)
  → assets_record_generated (fencing token) → agents_finish
```

A job the worker can't make yet is answered with a failed job and a reason;
any other failure finishes the run `failed` so the task can be tried again
(HQ fails the job once its attempts are spent). A lease that moved to another
worker stops this one before it writes anything.

## Set up

1. **Token** — HQ → Settings → Connections → Personal access token:
   *Acts as: Worker*, permissions `agents:operate`, `assets:read`,
   `assets:write`, `assets:operate`.
2. **Policy** — HQ → Settings → Policies: the project's operating policy
   covers that connection and allows `generate` and `draft`.

```bash
HQ_MCP_URL=https://mcp.example.com/mcp \
HQ_WORKER_TOKEN=hq_pat_… \
bun run apps/worker/src/index.ts          # --once to take a single job
```

| Variable | Default | |
| --- | --- | --- |
| `HQ_MCP_URL` · `HQ_WORKER_TOKEN` | — | required |
| `WORKER_PROJECT_ID` | any project | limit claims to one project |
| `WORKER_POLL_SECONDS` | 30 | wait when the queue is empty |
| `WORKER_LEASE_SECONDS` | 600 | heartbeats every third of it |
| `WORKER_GIT_COMMIT` | `git rev-parse HEAD` | the commit named on the boot line |

## Test

`test/plan13.test.ts` runs a scene's ZIP end to end against HQ's real MCP
server (the `apps/hq-mcp` module catalog, in-process over HTTP) with an S3
stand-in it starts itself. It truncates what it seeds, so it only runs with
`WORKER_DB_TESTS=1` and a **localhost** `DATABASE_URL`:

```bash
cd apps/worker
WORKER_DB_TESTS=1 DATABASE_URL=postgres://…localhost…/<throwaway> bun test test
```
