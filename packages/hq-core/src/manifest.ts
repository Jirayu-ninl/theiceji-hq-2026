import type { ModuleId, ProjectKind } from '@theiceji/hq-db/enums'
import type { ReadinessCheck } from '@theiceji/hq-db/readiness'
import { SCOPES, type Scope } from '@theiceji/hq-db/scopes'
import type { z } from 'zod'
import { MODULES } from './modules'
import type { TargetAdapter } from './targets'

/**
 * What a module package declares about itself — everything
 * but its UI. Each `packages/hq-<m>` exports one from `src/manifest.ts`; the
 * app composes them with its own nav and adapters into `ModuleUi`
 * (apps/hq/src/modules/index.ts), and the MCP server into its workspaces.
 *
 * `label`, `kinds`, `requires` and `global` repeat `MODULES[id]` from
 * ./modules.ts, which stays the single source: a manifest is built with
 * `manifestBase(id)` and adds only what the module owns.
 */
export type ModuleManifest = {
  id: ModuleId
  label: string
  /** Every table of the module starts with it (`board_`). */
  tablePrefix: string
  kinds: readonly ProjectKind[] | '*'
  global: boolean
  requires: readonly ModuleId[]
  /** `<id>:read` · `<id>:write` · `<id>:operate` — rows in hq-db's scope catalog. */
  scopes: readonly Scope[]
  targets?: readonly TargetAdapter[]
  /** Job kinds apps/worker takes for this module (`assets.thumbnail`). */
  jobs?: readonly string[]
  readiness?: () => Promise<ReadinessCheck>
  /** Validates `projects.modules.settings[id]`. */
  settingsSchema?: z.ZodType
}

/**
 * The fields a manifest repeats from the registry, plus the module's scopes
 * from hq-db's catalog — so a module's manifest can never disagree with
 * `MODULES[id]` or with what a connection can be granted.
 */
export function manifestBase(
  id: ModuleId,
): Pick<
  ModuleManifest,
  'id' | 'label' | 'kinds' | 'global' | 'requires' | 'scopes' | 'tablePrefix'
> {
  const meta = MODULES[id]
  return {
    id,
    label: meta.label,
    kinds: meta.kinds,
    global: meta.global,
    requires: meta.requires,
    tablePrefix: TABLE_PREFIX[id],
    scopes: SCOPES.filter((entry) => entry.workspace === id).map(
      (entry) => entry.scope,
    ),
  }
}

/** Every table of a module starts with it. */
export const TABLE_PREFIX: Record<ModuleId, string> = {
  board: 'board_',
  prompts: 'prompt_',
  assets: 'asset_',
  story: 'story_',
  calendar: 'calendar_',
  quotes: 'quote_',
  publish: 'publish_',
  market: 'market_',
  experiments: 'exp_',
  readings: 'readings_',
  agents: 'agent_',
  notes: 'notes',
}
