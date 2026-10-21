import { describe, expect, test } from 'bun:test'
import { PROJECT_COLOR_NAMES } from '@theiceji/hq-db/enums'
import { SCOPES } from '@theiceji/hq-db/scopes'
import { inkOnTint, nextColor } from '../src/colors'
import {
  canDisable,
  canEnable,
  DEFAULT_MODULES,
  GLOBAL_MODULES,
  LANE_PRESETS,
  MODULES,
  orderedModules,
  PROJECT_KINDS,
  PROJECT_MODULES,
} from '../src/modules'

/**
 * The registry is plain data every side of HQ reads, so its rules are
 * checked here once: the swatches keep ink readable, the
 * defaults per kind obey the modules' own kinds and requirements, and every
 * module has the scopes the MCP catalog promises.
 */

describe('project colours', () => {
  for (const color of PROJECT_COLOR_NAMES)
    for (const mode of ['dark', 'light'] as const)
      test(`${color} keeps --ink ≥ 7:1 on its tint (${mode})`, () => {
        expect(inkOnTint(color, mode)).toBeGreaterThanOrEqual(7)
      })

  test('the measured swatches keep --ink ≥ 10.6 on their tint', () => {
    for (const color of ['violet', 'teal', 'blue', 'pink', 'grey'] as const)
      for (const mode of ['dark', 'light'] as const)
        expect(inkOnTint(color, mode)).toBeGreaterThanOrEqual(10.6)
  })

  test('a new project takes an unused swatch, then the least used', () => {
    expect(nextColor([])).toBe('violet')
    expect(nextColor(['violet', 'teal'])).toBe('blue')
    const all = [...PROJECT_COLOR_NAMES]
    expect(nextColor([...all, 'violet'])).toBe('teal')
  })
})

describe('modules', () => {
  test('drawing order is Board … Agents, and Notes is HQ-wide', () => {
    expect(PROJECT_MODULES).toEqual([
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
    ])
    expect(GLOBAL_MODULES).toEqual([
      'board',
      'prompts',
      'assets',
      'calendar',
      'quotes',
    ])
    expect(MODULES.notes.hqWide).toBe(true)
  })

  for (const kind of PROJECT_KINDS)
    test(`${kind} defaults can all be on together`, () => {
      const defaults = DEFAULT_MODULES[kind]
      for (const id of defaults) {
        const others = defaults.filter((other) => other !== id)
        expect(canEnable(kind, others, id)).toEqual({ ok: true })
      }
    })

  test('Story is film-only and needs Prompts and Assets', () => {
    expect(canEnable('channel', ['prompts', 'assets'], 'story').ok).toBe(false)
    expect(canEnable('film', ['assets'], 'story')).toEqual({
      ok: false,
      reason: 'Story needs Prompts on first.',
    })
    expect(canEnable('film', ['assets', 'prompts'], 'story').ok).toBe(true)
  })

  test('a module another one needs can’t be turned off first', () => {
    expect(canDisable(['story', 'prompts', 'assets'], 'assets')).toEqual({
      ok: false,
      reason: 'Story needs Assets. Turn it off first.',
    })
    expect(canDisable(['board', 'assets'], 'assets').ok).toBe(true)
    expect(canEnable('personal', [], 'notes').ok).toBe(false)
  })

  test('rail order: the kind’s defaults first, extras after in drawing order', () => {
    expect(
      orderedModules('film', ['agents', 'board', 'story', 'assets', 'prompts']),
    ).toEqual(['story', 'prompts', 'assets', 'board', 'agents'])
    expect(orderedModules('personal', ['assets', 'quotes', 'nope'])).toEqual([
      'assets',
      'quotes',
    ])
  })

  test('awaiting payment is freelance’s last lane, and only there', () => {
    for (const kind of PROJECT_KINDS) {
      const roles = LANE_PRESETS[kind].map((lane) => lane.role)
      const awaiting = roles.filter((role) => role === 'awaiting_payment')
      if (kind === 'freelance') {
        expect(awaiting).toHaveLength(1)
        expect(roles.at(-1)).toBe('awaiting_payment')
      } else expect(awaiting).toHaveLength(0)
    }
  })

  test('every module has the scopes the catalog lists, and nothing else sneaks in', () => {
    const byArea = new Map<string, string[]>()
    for (const { scope } of SCOPES) {
      const [area, capability] = scope.split(':') as [string, string]
      byArea.set(area, [...(byArea.get(area) ?? []), capability])
    }
    expect(byArea.get('hq')).toEqual(['read'])
    expect(byArea.get('ops')).toEqual(['decide'])
    expect(byArea.get('readings')).toEqual(['read'])
    expect(byArea.get('agents')).toEqual(['operate'])
    for (const id of ['assets', 'publish', 'market'])
      expect(byArea.get(id)).toEqual(['read', 'write', 'operate'])
    for (const id of [
      'notes',
      'board',
      'prompts',
      'story',
      'calendar',
      'quotes',
      'experiments',
    ])
      expect(byArea.get(id)).toEqual(['read', 'write'])
  })
})
