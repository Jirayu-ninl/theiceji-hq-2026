import {
  GLOBAL_MODULES,
  KIND_LABEL,
  MODULES,
  type ModuleId,
  type ModuleMeta,
  orderedModules,
  type ProjectKind,
} from '@theiceji/hq-core/modules'

/**
 * The app's side of the module registry: each
 * module's metadata from packages/hq-core, plus what only the app knows —
 * where its pages live and, from Phase 2 on, the adapters Home, State and
 * Time read (`cell`, `widgets`, `timeline`). The rail, the breadcrumbs, the
 * palette and navigation.test.ts all read this one list.
 *
 * `ready` says whether the module's pages exist yet. A module that is on but
 * not built shows its rail row and an honest page saying when it lands —
 * never a 404, never a mock.
 */

export type CellState = 'wait' | 'live' | 'due' | 'unknown' | 'new' | ''

export type ModuleCell = {
  value: number | string
  unit?: string
  sub?: string
  state: CellState
}

/** The project fields the app's module adapters need. */
export type ProjectLite = {
  id: string
  slug: string
  name: string
  kind: ProjectKind
  status: 'active' | 'paused' | 'archived'
  color: string
  modules: { enabled: string[] }
}

export type ModuleUi = {
  meta: ModuleMeta
  /** The build phase its pages land in; ready once that phase is done. */
  phase: number
  ready: boolean
  /** One number and one state per project (State matrix, Space moons, rail counts). Phase 2+. */
  cell?: (project: ProjectLite) => Promise<ModuleCell | null>
}

const PHASE: Record<ModuleId, number> = {
  notes: 2,
  board: 2,
  prompts: 2,
  assets: 2,
  calendar: 2,
  quotes: 2,
  publish: 3,
  market: 3,
  experiments: 3,
  readings: 3,
  story: 4,
  agents: 5,
}

/** Modules whose pages exist (every module has them). */
const READY: readonly ModuleId[] = [
  'notes',
  'board',
  'prompts',
  'assets',
  'story',
  'calendar',
  'quotes',
  'publish',
  'market',
  'experiments',
  'readings',
  'agents',
]

export const MODULE_UI: Record<ModuleId, ModuleUi> = Object.fromEntries(
  Object.values(MODULES).map((meta) => [
    meta.id,
    { meta, phase: PHASE[meta.id], ready: READY.includes(meta.id) },
  ]),
) as Record<ModuleId, ModuleUi>

/** `/p/<slug>/<module>` — a module inside one project. */
export const projectModuleHref = (slug: string, module: ModuleId) =>
  `/p/${slug}/${module}`

/** `/<module>` — a global module across every project. */
export const globalModuleHref = (module: ModuleId) => `/${module}`

/** A project's modules in rail order, with their links. */
export function projectModules(project: ProjectLite) {
  return orderedModules(project.kind, project.modules.enabled).map((id) => ({
    id,
    label: MODULES[id].label,
    glyph: MODULES[id].glyph,
    href: projectModuleHref(project.slug, id),
  }))
}

/** The modules with a route across all projects, with their links. */
export function globalModules() {
  return GLOBAL_MODULES.map((id) => ({
    id,
    label: MODULES[id].label,
    glyph: MODULES[id].glyph,
    href: globalModuleHref(id),
  }))
}

export { GLOBAL_MODULES, KIND_LABEL, MODULES, type ModuleId }
