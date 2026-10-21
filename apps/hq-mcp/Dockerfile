# TheIceJi HQ MCP server — lean production image via `turbo prune`.
#
# Build context is the REPO ROOT. Workspace packages are consumed as raw TS
# source and Bun runs them directly, so there is no build step:
#
#   docker build -f apps/hq-mcp/Dockerfile -t theiceji-hq-mcp .
#
# `turbo prune hq-mcp --docker` carves out a minimal monorepo holding only
# `hq-mcp` and its workspace deps (@theiceji/mcp-kernel, @theiceji/hq-db,
# @theiceji/hq-ops, @theiceji/hq-core, @theiceji/hq-storage, each module's
# @theiceji/hq-<module>, @theiceji/net-guard) plus a PRUNED bun.lock, so
# `--frozen-lockfile` matches exactly and the other apps' dependencies never
# land in the image.
#
# Railway: root directory `/`, Dockerfile path `apps/hq-mcp/Dockerfile`,
# healthcheck `/healthz` — see .railway/railway.ts.
#
# Nothing copies a `.env` into the image (.dockerignore drops them): the service
# reads its configuration from the platform's environment only.
#
# The base image carries a digest so production runs the exact Bun that
# `packageManager` (bun@1.3.14) and local dev use. Bumping Bun is two edits in
# one commit: `packageManager` in package.json and both FROM lines below.

# ── Stage 1: prune the monorepo down to the hq-mcp subgraph ──────────────────
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS pruner
WORKDIR /app
COPY . .
RUN bunx turbo@2.9.18 prune hq-mcp --docker \
  && find out/full -name '*.test.ts' -delete

# ── Stage 2: install pruned deps, then copy pruned source ────────────────────
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /app

# Manifests + pruned lockfile first, so the install layer stays cached until a
# package.json or the lockfile actually changes.
COPY --from=pruner /app/out/json/ ./
RUN bun install --frozen-lockfile --production

# Then the source (raw TS — no build).
COPY --from=pruner /app/out/full/ ./

WORKDIR /app/apps/hq-mcp

# Nothing here needs root: the install ran above, the source is world-readable,
# and the process only listens.
USER bun

ENV NODE_ENV=production
# Railway injects PORT; 8991 is the local default.
EXPOSE 8991

CMD ["bun", "run", "src/index.ts"]
