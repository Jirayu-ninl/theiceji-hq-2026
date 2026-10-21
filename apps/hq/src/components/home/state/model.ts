import { canEnable, MODULES, type ModuleId } from '@theiceji/hq-core/modules'
import type { InboxEntry } from '@/components/Inbox'
import type { StateData, StateProject } from '@/lib/state'
import type { ModuleCell } from '@/modules'

/**
 * Home · State's pure parts: the words for a state, what a
 * cell says, which cells take a note, what waits behind a cell and what the
 * filter matches. No React, so the matrix, the device pane and the keys all
 * read the same answers.
 */

/** The record a note becomes in each module that takes notes. */
export const TARGETS: Partial<Record<ModuleId, string>> = {
  board: 'card',
  prompts: 'prompt',
  story: 'shot',
  calendar: 'event',
}

export const stateWord = (state: string) =>
  state === 'wait'
    ? 'waiting for you'
    : state === 'live'
      ? 'running'
      : state === 'due'
        ? 'due today'
        : state === 'unknown'
          ? 'not read back'
          : ''

export const stateGlyph = (state: string) =>
  state === 'wait' ? '◆' : state === 'live' ? '▶' : state === 'due' ? '●' : ''

/** `1,204` for numbers; strings pass through (`฿1,200`, `3 / 8`, `—`). */
export const valueText = (value: number | string) =>
  typeof value === 'number'
    ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : value

export const isZero = (cell: ModuleCell) =>
  cell.value === 0 || cell.value === '0 / 0'

/** What a cell draws: off, nothing yet, or its reading. */
export type CellView =
  | { kind: 'off' }
  | { kind: 'none' }
  | { kind: 'cell'; cell: ModuleCell }

export function viewOf(
  data: StateData,
  column: number,
  module: ModuleId,
): CellView {
  const project = data.projects[column]
  if (!project) return { kind: 'cell', cell: data.master[module] }
  if (!project.enabled.includes(module)) return { kind: 'off' }
  const cell = project.cells[module]
  // A fresh project has recorded nothing anywhere: every cell says so,
  // rather than a row of zeros that look like readings.
  if (!cell || (project.fresh && cell.state !== 'wait')) return { kind: 'none' }
  return { kind: 'cell', cell }
}

/** Words for a screen reader, and the filter's haystack. */
export function cellWords(
  data: StateData,
  column: number,
  module: ModuleId,
): string {
  const project = data.projects[column]
  const who = project ? project.name : 'All projects'
  const label = MODULES[module].label
  const view = viewOf(data, column, module)
  if (view.kind === 'off') return `${who}, ${label}: module off`
  if (view.kind === 'none') return `${who}, ${label}: nothing yet`
  const { cell } = view
  const value = valueText(cell.value)
  const word = stateWord(cell.state)
  return `${who}, ${label}: ${value === '—' ? '' : `${value} `}${cell.unit ?? ''}${word ? `, ${word}` : ''}${cell.sub ? `, ${cell.sub}` : ''}`
    .replace(/\s+,/g, ',')
    .trim()
}

/** Whether a note can be promoted into this cell (turning the module on if it may). */
export function accepts(project: StateProject | undefined, module: ModuleId) {
  if (!project || !TARGETS[module]) return false
  if (module === 'story' && project.kind !== 'film') return false
  if (project.status === 'archived') return false
  return (
    project.enabled.includes(module) ||
    canEnable(project.kind, project.enabled, module).ok
  )
}

/**
 * What waits behind a cell: its own requests and proposals. The Calendar
 * row also carries the Google connection when it needs signing in again —
 * calendar sync is what waits on it.
 */
export function waitingBehind(
  entries: InboxEntry[],
  project: StateProject | undefined,
  module: ModuleId,
): InboxEntry[] {
  const own = entries.filter(
    (entry) =>
      entry.module === module &&
      (!project || entry.project?.slug === project.slug),
  )
  if (own.length || module !== 'calendar') return own
  return entries.filter(
    (entry) => entry.kind === 'problem' && entry.id.startsWith('google-'),
  )
}

/** Every word of the filter must be somewhere in the cell's words. */
export function matches(filter: string, haystack: string) {
  if (!filter) return true
  const text = haystack.toLowerCase()
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word))
}

export const isThai = (text: string | null | undefined) =>
  Boolean(text && /\p{Script=Thai}/u.test(text))

export const moneyText = (list: { label: string }[]) =>
  list.map((entry) => entry.label).join(' + ')
