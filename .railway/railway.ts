/**
 * TheIceJi HQ's Railway project, as Infrastructure as Code.
 *
 * Railway deprecated Config as Code (`apps/<service>/railway.toml`): services
 * that had never used a toml were locked out of it on 2026-08-28, so this
 * project — whose first service is newer than that — is configured here. One
 * authoring file per project, applied by the CLI, NOT read on every git push:
 *
 *   bun install                 # the `railway` devDependency must be present
 *   railway link                # pick the project and environment
 *   railway config plan         # print the diff, apply nothing
 *   railway config apply        # after reading the diff
 *
 * `source` is deliberately omitted: connect the GitHub repo (branch, root
 * directory `/`) in the Railway dashboard once, and let this file own the
 * build/deploy settings. Service variables (DATABASE_URL, MCP_PUBLIC_URL, …)
 * live in the dashboard too — see apps/hq-mcp/.env.example.
 *
 * Vercel hosts apps/hq; Railway runs the long-lived Bun process, hq-mcp.
 */

import { defineRailway, project, service } from 'railway/iac'

/** Root manifests every service watches: a lockfile or workspace change can alter the image. */
const ROOT_WATCH = [
  'package.json',
  'bun.lock',
  'turbo.json',
  'tsconfig.base.json',
  '.dockerignore',
]

/**
 * Closest Railway region to Bangkok. If a server's Postgres lives far from
 * Singapore, move it next to that database instead — every tool call does a
 * token lookup before anything else.
 */
const REGION = 'asia-southeast1-eqsg3a'

export default defineRailway(() =>
  project('TheIceJi-HQ', {
    resources: [
      /**
       * apps/hq-mcp — HQ's MCP server: every module's tools
       * (Streamable HTTP, stateless) and the ops tick.
       *
       * Watch patterns are the `turbo prune hq-mcp` closure — the kernel, the
       * HQ data layer (hq-db, hq-ops, hq-core, hq-storage), each module's
       * service package and net-guard — plus root manifests, so a commit
       * touching only apps/hq doesn't redeploy it.
       *
       * Drain 15 s: SIGTERM → stop accepting, finish in-flight tool calls,
       * close the pool, exit. The process hard-exits at 10 s
       * (`DRAIN_HARD_EXIT_MS` in apps/hq-mcp/src/index.ts) — inside this
       * window on purpose, so its own exit lands before SIGKILL.
       *
       * Stateless (no Mcp-Session-Id), so replicas can rise without a code
       * change; the per-token rate window is per replica, which is accepted.
       */
      service('hq-mcp', {
        build: {
          builder: 'DOCKERFILE',
          dockerfilePath: 'apps/hq-mcp/Dockerfile',
          watchPatterns: [
            'apps/hq-mcp/**',
            'packages/mcp-kernel/**',
            'packages/hq-db/**',
            'packages/hq-ops/**',
            'packages/hq-core/**',
            'packages/hq-storage/**',
            'packages/hq-agents/**',
            'packages/hq-assets/**',
            'packages/hq-board/**',
            'packages/hq-calendar/**',
            'packages/hq-experiments/**',
            'packages/hq-market/**',
            'packages/hq-prompts/**',
            'packages/hq-publish/**',
            'packages/hq-quotes/**',
            'packages/hq-readings/**',
            'packages/hq-story/**',
            'packages/net-guard/**',
            ...ROOT_WATCH,
          ],
        },
        deploy: {
          healthcheckPath: '/healthz',
          healthcheckTimeout: 120,
          restartPolicyType: 'ON_FAILURE',
          restartPolicyMaxRetries: 10,
          drainingSeconds: 15,
          multiRegionConfig: { [REGION]: { numReplicas: 1 } },
        },
      }),
    ],
  }),
)
