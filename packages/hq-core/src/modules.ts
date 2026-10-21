import {
  type BoardLaneRole,
  MODULE_IDS,
  type ModuleId,
  PROJECT_KINDS,
  type ProjectKind,
} from '@theiceji/hq-db/enums'

/**
 * The module registry every side of HQ reads: the app's nav,
 * rail and Home, the MCP server's workspaces, and the services that decide
 * whether a module may be turned on. One list, in one order.
 *
 * Plain data on purpose — no database, no React — so a client component, a
 * test and the MCP server can all import it.
 */

export {
  type BoardLaneRole,
  MODULE_IDS,
  type ModuleId,
  PROJECT_KINDS,
  type ProjectKind,
}

export type ModuleMeta = {
  id: ModuleId
  label: string
  /** The module's glyph — modules are glyphs, never hues. */
  glyph: string
  /** Has a route across every project (`/board`), not just `/p/<slug>/board`. */
  global: boolean
  /** The project kinds that may turn it on. */
  kinds: readonly ProjectKind[] | '*'
  /** Modules that must be on first — Story needs Prompts and Assets. */
  requires: readonly ModuleId[]
  /** HQ-wide (Notes): never a project module, never a matrix row. */
  hqWide?: boolean
}

/** In the one order the app draws modules in. */
export const MODULES: Record<ModuleId, ModuleMeta> = {
  board: {
    id: 'board',
    label: 'Board',
    glyph: '▦',
    global: true,
    kinds: '*',
    requires: [],
  },
  prompts: {
    id: 'prompts',
    label: 'Prompts',
    glyph: '✎',
    global: true,
    kinds: '*',
    requires: [],
  },
  assets: {
    id: 'assets',
    label: 'Assets',
    glyph: '▣',
    global: true,
    kinds: '*',
    requires: [],
  },
  story: {
    id: 'story',
    label: 'Story',
    glyph: '▤',
    global: false,
    kinds: ['film'],
    requires: ['prompts', 'assets'],
  },
  calendar: {
    id: 'calendar',
    label: 'Calendar',
    glyph: '▥',
    global: true,
    kinds: '*',
    requires: [],
  },
  quotes: {
    id: 'quotes',
    label: 'Quotes',
    glyph: '▧',
    global: true,
    kinds: '*',
    requires: [],
  },
  publish: {
    id: 'publish',
    label: 'Publish',
    glyph: '▲',
    global: false,
    kinds: '*',
    requires: ['assets'],
  },
  market: {
    id: 'market',
    label: 'Market',
    glyph: '◈',
    global: false,
    kinds: '*',
    requires: ['assets'],
  },
  experiments: {
    id: 'experiments',
    label: 'Experiments',
    glyph: '◬',
    global: false,
    kinds: '*',
    requires: [],
  },
  readings: {
    id: 'readings',
    label: 'Readings',
    glyph: '◉',
    global: false,
    kinds: '*',
    requires: [],
  },
  agents: {
    id: 'agents',
    label: 'Agents',
    glyph: '◍',
    global: false,
    kinds: '*',
    requires: [],
  },
  // HQ-wide rows are drawn with the rail's icons, not a module glyph.
  notes: {
    id: 'notes',
    label: 'Notes',
    glyph: '',
    global: true,
    kinds: '*',
    requires: [],
    hqWide: true,
  },
}

/** Project modules — every module but the HQ-wide ones — in drawing order. */
export const PROJECT_MODULES: readonly ModuleId[] = MODULE_IDS.filter(
  (id) => !MODULES[id].hqWide,
)

/** Modules with a route across all projects, in drawing order. */
export const GLOBAL_MODULES: readonly ModuleId[] = PROJECT_MODULES.filter(
  (id) => MODULES[id].global,
)

export const KIND_LABEL: Record<ProjectKind, string> = {
  channel: 'channel',
  digital_assets: 'digital assets',
  film: 'film',
  freelance: 'freelance',
  personal: 'personal',
}

/**
 * What a new project starts with, in the order its rail lists
 * them. A project's own `modules.enabled` is what it has now.
 */
export const DEFAULT_MODULES: Record<ProjectKind, readonly ModuleId[]> = {
  channel: [
    'board',
    'prompts',
    'assets',
    'publish',
    'experiments',
    'readings',
    'agents',
    'calendar',
  ],
  digital_assets: [
    'board',
    'prompts',
    'assets',
    'market',
    'experiments',
    'readings',
    'agents',
  ],
  film: ['story', 'prompts', 'assets', 'board', 'calendar'],
  freelance: ['board', 'calendar', 'quotes', 'assets'],
  personal: ['board', 'calendar', 'assets'],
}

/**
 * Board lanes a new project's first board gets. The
 * awaiting-payment lane is pinned right and is the only one of its kind.
 */
export const LANE_PRESETS: Record<
  ProjectKind,
  readonly { name: string; role: BoardLaneRole }[]
> = {
  channel: [
    { name: 'Idea', role: 'normal' },
    { name: 'Prompted', role: 'normal' },
    { name: 'Generated', role: 'normal' },
    { name: 'Posted', role: 'normal' },
    { name: 'Reviewed', role: 'done' },
  ],
  digital_assets: [
    { name: 'Idea', role: 'normal' },
    { name: 'Prompted', role: 'normal' },
    { name: 'Rendered', role: 'normal' },
    { name: 'Listed', role: 'normal' },
    { name: 'Reviewed', role: 'done' },
  ],
  film: [
    { name: 'Script', role: 'normal' },
    { name: 'Boarded', role: 'normal' },
    { name: 'Generated', role: 'normal' },
    { name: 'Edited', role: 'normal' },
    { name: 'Done', role: 'done' },
  ],
  freelance: [
    { name: 'Backlog', role: 'normal' },
    { name: 'Quoted', role: 'normal' },
    { name: 'Doing', role: 'normal' },
    { name: 'Review', role: 'normal' },
    { name: 'Awaiting payment', role: 'awaiting_payment' },
  ],
  personal: [
    { name: 'Backlog', role: 'normal' },
    { name: 'Doing', role: 'normal' },
    { name: 'Done', role: 'done' },
  ],
}

export const isModuleId = (value: unknown): value is ModuleId =>
  typeof value === 'string' && (MODULE_IDS as readonly string[]).includes(value)

export const isProjectKind = (value: unknown): value is ProjectKind =>
  typeof value === 'string' &&
  (PROJECT_KINDS as readonly string[]).includes(value)

/**
 * A project's modules in the order its rail lists them: the kind's defaults
 * first in their order, then anything added later in drawing order. Unknown
 * or HQ-wide ids are dropped.
 */
export function orderedModules(
  kind: ProjectKind,
  enabled: readonly string[],
): ModuleId[] {
  const on = new Set(enabled.filter(isModuleId))
  const defaults = DEFAULT_MODULES[kind].filter((id) => on.has(id))
  const extras = PROJECT_MODULES.filter(
    (id) => on.has(id) && !defaults.includes(id),
  )
  return [...defaults, ...extras]
}

export type ModuleChange = { ok: true } | { ok: false; reason: string }

/** Whether a module may be turned on for a project of this kind with these modules on. */
export function canEnable(
  kind: ProjectKind,
  enabled: readonly string[],
  module: ModuleId,
): ModuleChange {
  const meta = MODULES[module]
  if (meta.hqWide)
    return {
      ok: false,
      reason: `${meta.label} belongs to all of HQ, not to one project.`,
    }
  if (meta.kinds !== '*' && !meta.kinds.includes(kind))
    return {
      ok: false,
      reason: `${meta.label} is for ${meta.kinds.map((k) => KIND_LABEL[k]).join(' or ')} projects.`,
    }
  const missing = meta.requires.filter((id) => !enabled.includes(id))
  if (missing.length > 0)
    return {
      ok: false,
      reason: `${meta.label} needs ${missing.map((id) => MODULES[id].label).join(' and ')} on first.`,
    }
  return { ok: true }
}

/** Whether a module may be turned off: nothing still on may require it. */
export function canDisable(
  enabled: readonly string[],
  module: ModuleId,
): ModuleChange {
  const dependants = enabled
    .filter(isModuleId)
    .filter((id) => MODULES[id].requires.includes(module))
  if (dependants.length > 0)
    return {
      ok: false,
      reason: `${dependants.map((id) => MODULES[id].label).join(' and ')} need${dependants.length === 1 ? 's' : ''} ${MODULES[module].label}. Turn ${dependants.length === 1 ? 'it' : 'them'} off first.`,
    }
  return { ok: true }
}
