import {
  PROJECT_COLOR_NAMES,
  PROJECT_COLORS,
  type ProjectColor,
} from '@theiceji/hq-db/enums'

/**
 * Project identity colours: a fixed swatch list, never a
 * free hex. A project colour only ever appears as a 6px dot and as a `--tint`
 * wash under cells, blocks and chips, and `--ink` must stay ≥ 7:1 on that
 * wash in both themes — `inkOnTint` is how the test proves it for every
 * swatch.
 */

export { PROJECT_COLOR_NAMES, PROJECT_COLORS, type ProjectColor }

export const isProjectColor = (value: unknown): value is ProjectColor =>
  typeof value === 'string' && value in PROJECT_COLORS

export const colorHex = (color: ProjectColor): string => PROJECT_COLORS[color]

/** The first swatch no live project uses yet, or the least-used one. */
export function nextColor(inUse: readonly string[]): ProjectColor {
  const counts = new Map<ProjectColor, number>(
    PROJECT_COLOR_NAMES.map((name) => [name, 0]),
  )
  for (const used of inUse)
    if (isProjectColor(used)) counts.set(used, (counts.get(used) ?? 0) + 1)
  let best = PROJECT_COLOR_NAMES[0] as ProjectColor
  for (const name of PROJECT_COLOR_NAMES)
    if ((counts.get(name) ?? 0) < (counts.get(best) ?? 0)) best = name
  return best
}

/* ── Contrast (WCAG 2.x) ─────────────────────────────────────────────── */

type Rgb = [number, number, number]

function parseHex(hex: string): Rgb {
  const clean = hex.replace('#', '')
  const value = Number.parseInt(clean, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** `color-mix(in srgb, a p%, b)`. */
export function mix(a: string, b: string, percent: number): Rgb {
  const x = parseHex(a)
  const y = parseHex(b)
  const t = percent / 100
  return [0, 1, 2].map((i) =>
    Math.round((x[i] as number) * t + (y[i] as number) * (1 - t)),
  ) as Rgb
}

function luminance([r, g, b]: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ]
  return (hi + 0.05) / (lo + 0.05)
}

/** The Bridge tokens the tint check needs. */
export const TINT_TOKENS = {
  dark: { ink: '#e7e7ec', panel: '#1c1c20', tint: 12 },
  light: { ink: '#1a1d23', panel: '#d3d6dc', tint: 14 },
} as const

/** `--ink` on `color-mix(in srgb, <swatch> var(--tint), var(--panel))`. */
export function inkOnTint(color: ProjectColor, mode: 'dark' | 'light'): number {
  const tokens = TINT_TOKENS[mode]
  return contrast(
    parseHex(tokens.ink),
    mix(PROJECT_COLORS[color], tokens.panel, tokens.tint),
  )
}
