import type { ModuleId, RefType } from '@theiceji/hq-db/enums'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import type { Tx } from '@theiceji/hq-ops/db'
import { invalid } from '@theiceji/hq-ops/errors'
import { parseInput } from '@theiceji/hq-ops/schemas'
import type { z } from 'zod'

/**
 * The target registry: everything that can be *made from*
 * something else — a note promoted into a card, an agent's proposal accepted
 * as a prompt variant. Promote and proposals share it, so a module adds a
 * target once and both paths get it.
 *
 * A module registers its adapters when its package loads; nothing here
 * imports a module. `create` runs inside the caller's transaction, so the new
 * record, the `refs` edge and the note or proposal it came from change
 * together or not at all.
 */

export type TargetType = Extract<
  RefType,
  | 'card'
  | 'prompt'
  | 'prompt_variant'
  | 'shot'
  | 'note'
  | 'experiment'
  | 'event'
>

export type TargetContext = {
  tx: Tx
  actor: Actor
  /** Null for a target that belongs to no project (a floating prompt). */
  project: ProjectRow | null
}

export type CreatedTarget = { type: TargetType; id: string; href: string }

export type TargetAdapter<P = unknown> = {
  type: TargetType
  /** The module that owns what it creates — it must be on for the project. */
  module: ModuleId
  /** How the promote menu names it: `Board · card`. */
  label: string
  /** Whether it can live outside a project. */
  projectOptional?: boolean
  schema: z.ZodType<P>
  create(payload: P, context: TargetContext): Promise<CreatedTarget>
}

const adapters = new Map<TargetType, TargetAdapter>()

export function registerTarget<P>(adapter: TargetAdapter<P>): void {
  adapters.set(adapter.type, adapter as TargetAdapter)
}

export function targetFor(type: string): TargetAdapter | null {
  return adapters.get(type as TargetType) ?? null
}

/** Registered targets, optionally only those a project can take right now. */
export function listTargets(project?: ProjectRow | null): TargetAdapter[] {
  const all = [...adapters.values()]
  if (project === undefined) return all
  if (project === null) return all.filter((adapter) => adapter.projectOptional)
  return all.filter((adapter) => isOn(project, adapter.module))
}

/** Notes is HQ-wide — never a project's module row, so always "on". */
function isOn(project: ProjectRow, module: ModuleId): boolean {
  return module === 'notes' || project.modules.enabled.includes(module)
}

/**
 * Validate a payload with the adapter's schema and create the target. Throws
 * `invalid` for an unknown target, a module that is off, or a payload that
 * doesn't fit.
 */
export async function createTarget(
  type: string,
  payload: unknown,
  context: TargetContext,
): Promise<CreatedTarget> {
  const adapter = targetFor(type)
  if (!adapter) throw invalid(`Nothing can be made as “${type}” yet.`)
  if (!context.project && !adapter.projectOptional)
    throw invalid(`A ${adapter.label} belongs to a project. Choose one.`)
  if (context.project && !isOn(context.project, adapter.module))
    throw invalid(
      `${adapter.label} isn’t on for ${context.project.name}. Turn it on in the project’s settings first.`,
    )
  const parsed = parseInput(adapter.schema, payload)
  return adapter.create(parsed, context)
}

/** For tests: forget every registered adapter. */
export function resetTargets(): void {
  adapters.clear()
}
