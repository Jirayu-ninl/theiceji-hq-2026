import type { ModuleId, ProjectKind } from '@theiceji/hq-core/modules'
import type { RefRole, RefType } from '@theiceji/hq-db/enums'

/**
 * The project map's geometry and wiring as plain functions: where each node sits, how an edge bends
 * between two boxes, how a `refs` edge is attributed to a node, the fit and
 * zoom math, and which node an arrow key lands on. No React, no database —
 * the server lays the map out with it and the client pans it with it, so the
 * first frame is drawn from the same numbers the keys move through.
 */

/* ── Shapes ─────────────────────────────────────────────────────────── */

export type Box = { x: number; y: number; w: number; h: number }
export type View = { s: number; tx: number; ty: number }

/** What a node is about: a module, the HQ-wide Notes, or the project's money. */
export type MapModule = ModuleId | 'money'
export type NodeKind = 'src' | 'lane' | 'sink'
export type NodeTone = '' | 'wait' | 'live' | 'money' | 'dim'
export type EdgeTone = '' | 'wait' | 'money' | 'plan'

export type MapNode = Box & {
  id: string
  kind: NodeKind
  module: MapModule
  label: string
  glyph: string
  /** `feeds` · `drains` · `lane 2` · `pinned right`. */
  role: string
  /** The readout: a state glyph (◆ ▶ ●), the figure, its unit. */
  mark: string
  big: string
  unit: string
  tone: NodeTone
  sub: string
  /** The cell state, for the border and the words. */
  state: '' | 'wait' | 'live' | 'due' | 'unknown' | 'new'
  /** ▶ a routine running here, or ◆ what waits. */
  chip: { tone: 'live' | 'wait'; text: string } | null
  off: boolean
  /** Where ↵ goes, and the words on that button. */
  href: string
  open: string
  /** The whole node in words, for its accessible name. */
  aria: string
  /** Lane nodes: the lane's index and every lane's card count, for the bar. */
  lane?: { index: number; counts: number[] }
}

export type MapEdge = {
  id: string
  from: string
  to: string
  d: string
  lx: number
  ly: number
  anchor: 'start' | 'middle'
  label: string
  tone: EdgeTone
  /** The edge in words, for the list a screen reader reads. */
  words: string
}

/* ── Placement ──────────────────────────────────────────────────────── */

/** Three columns — feeders | the lanes stacked | drains. */
export const COL_X = [40, 390, 740] as const
export const ROW_TOP = 50
export const ROW_H = 118
export const NODE_W = { src: 210, lane: 224, sink: 210 } as const
/** Fixed heights, so an edge is known before the browser lays a node out. */
export const NODE_H = { src: 78, lane: 90, sink: 78 } as const

export const rowY = (row: number) => ROW_TOP + row * ROW_H

/** A node's slot: its row, and what its one edge joins (a lane index or a node id). */
export type Slot = readonly [id: MapModule, row: number, to: number | string]

/**
 * The kind's pipeline: which feeder sits in which row
 * and which lane it feeds, which drain takes from which lane. A module that
 * is off is left out; one the owner switched on that isn't here lands in the
 * feeder column below.
 */
export const PLACE: Record<
  ProjectKind,
  { src: readonly Slot[]; sink: readonly Slot[] }
> = {
  channel: {
    src: [
      ['notes', 0, 0],
      ['prompts', 1, 1],
      ['agents', 2, 2],
      ['calendar', 3, 3],
      ['experiments', 4, 4],
    ],
    sink: [
      ['assets', 2, 2],
      ['publish', 3, 3],
      ['readings', 4, 'publish'],
      ['money', 5, 'readings'],
    ],
  },
  digital_assets: {
    src: [
      ['notes', 0, 0],
      ['prompts', 1, 1],
      ['agents', 2, 2],
      ['experiments', 4, 4],
    ],
    sink: [
      ['assets', 2, 2],
      ['market', 3, 3],
      ['readings', 4, 'market'],
      ['money', 5, 'readings'],
    ],
  },
  film: {
    src: [
      ['notes', 0, 0],
      ['story', 1, 1],
      ['prompts', 2, 2],
      ['calendar', 3, 3],
      ['agents', 4, 2],
    ],
    sink: [['assets', 2, 2]],
  },
  freelance: {
    src: [
      ['notes', 0, 0],
      ['quotes', 1, 1],
      ['calendar', 2, 2],
    ],
    sink: [
      ['assets', 2, 2],
      ['money', 4, 4],
    ],
  },
  personal: {
    src: [
      ['notes', 0, 0],
      ['calendar', 1, 1],
    ],
    sink: [['assets', 1, 1]],
  },
}

/** The lane a module switched on outside its kind's pipeline would feed, were it in it. */
export const EXTRA_LANE: Partial<Record<MapModule, number>> = {
  prompts: 1,
  story: 1,
  quotes: 1,
  calendar: 2,
  agents: 2,
  assets: 2,
  publish: 3,
  market: 3,
  experiments: 4,
  readings: 4,
}

/** Experiments reads what the last lanes produced: its edge runs lane → Experiments. */
export const READS_FROM_LANE: ReadonlySet<MapModule> = new Set(['experiments'])

/* ── Edges from `refs` ──────────────────────────────────────────────── */

/**
 * Which node's edge a `refs` row flows along, and the word it is counted
 * under. Each edge is counted once, on the module that made it: a promote on
 * Notes, an accepted proposal on Agents, a card quoted on Quotes, a shot's
 * result on Assets. Null when the role has no place on the map.
 */
export function attributeRef(
  role: RefRole | string,
  from: RefType | string,
  to: RefType | string,
): { node: MapModule; word: string } | null {
  switch (role) {
    case 'promoted_to':
      return { node: 'notes', word: 'promoted' }
    case 'proposed_as':
      return { node: 'agents', word: 'accepted' }
    case 'produced_by':
      return { node: 'agents', word: 'produced' }
    case 'quoted_by':
      return { node: 'quotes', word: 'quoted' }
    case 'published_as':
      return { node: 'publish', word: 'published' }
    case 'listed_as':
      return { node: 'market', word: 'listed' }
    case 'scheduled_as':
      return { node: 'calendar', word: 'scheduled' }
    case 'example_of':
      return { node: 'prompts', word: 'examples' }
    // A card or follow-up —made_with→ the prompt its job ran on.
    case 'made_with':
      return { node: 'prompts', word: 'made with' }
    case 'result_of':
      return { node: 'assets', word: 'results' }
    case 'attached':
      if (to === 'experiment' || from === 'experiment')
        return { node: 'experiments', word: 'in tests' }
      if (to === 'asset' || from === 'asset')
        return { node: 'assets', word: 'attached' }
      return null
    default:
      return null
  }
}

/** The words that are nouns, for a count of one. */
const ONE: Record<string, string> = { examples: 'example', results: 'result' }

/** `3 promoted · 1 example` — the two largest counts, in words. */
export function countLabel(parts: { word: string; n: number }[]): string {
  return [...parts]
    .filter((part) => part.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 2)
    .map(
      (part) =>
        `${part.n} ${part.n === 1 ? (ONE[part.word] ?? part.word) : part.word}`,
    )
    .join(' · ')
}

/* ── Geometry ───────────────────────────────────────────────────────── */

const r1 = (n: number) => Math.round(n * 10) / 10

/**
 * The curve between two boxes: straight down a
 * column, or an S from one column's edge to the next. A diagonal keeps its
 * label near its source, so it never sits on another edge's label.
 */
export function edgePath(
  a: Box,
  b: Box,
): { d: string; lx: number; ly: number; anchor: 'start' | 'middle' } {
  if (Math.abs(b.x - a.x) < 60) {
    const down = b.y > a.y
    const x = a.x + a.w / 2
    const y1 = down ? a.y + a.h : a.y
    const y2 = down ? b.y : b.y + b.h
    const dy = (y2 - y1) / 2
    return {
      d: `M${r1(x)} ${r1(y1)} C${r1(x)} ${r1(y1 + dy)} ${r1(x)} ${r1(y2 - dy)} ${r1(x)} ${r1(y2)}`,
      lx: r1(x + 8),
      ly: r1((y1 + y2) / 2 + 3),
      anchor: 'start',
    }
  }
  const ltr = b.x > a.x
  const x1 = ltr ? a.x + a.w : a.x
  const y1 = a.y + a.h / 2
  const x2 = ltr ? b.x : b.x + b.w
  const y2 = b.y + b.h / 2
  const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (ltr ? 1 : -1)
  const diagonal = Math.abs(y2 - y1) > 60
  return {
    d: `M${r1(x1)} ${r1(y1)} C${r1(x1 + dx)} ${r1(y1)} ${r1(x2 - dx)} ${r1(y2)} ${r1(x2)} ${r1(y2)}`,
    lx: r1(diagonal ? x1 + (x2 - x1) * 0.18 : (x1 + x2) / 2),
    ly: r1(diagonal ? y1 - 8 : (y1 + y2) / 2 - 8),
    anchor: 'middle',
  }
}

/** Everything drawn, with room for the chips above and the labels around. */
export function boundsOf(boxes: readonly Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, w: 1000, h: 600 }
  let x1 = Number.POSITIVE_INFINITY
  let y1 = Number.POSITIVE_INFINITY
  let x2 = Number.NEGATIVE_INFINITY
  let y2 = Number.NEGATIVE_INFINITY
  for (const box of boxes) {
    x1 = Math.min(x1, box.x)
    y1 = Math.min(y1, box.y)
    x2 = Math.max(x2, box.x + box.w)
    y2 = Math.max(y2, box.y + box.h)
  }
  return { x: x1 - 24, y: y1 - 30, w: x2 - x1 + 48, h: y2 - y1 + 60 }
}

export const ZOOM_MIN = 0.35
export const ZOOM_MAX = 2
const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n))

/**
 * Fit (`f`): the whole ladder in the well, at most 115%. Below 600px wide it
 * stays readable at 70%, centred on the lanes, and the rest is a pan away.
 */
export function fitView(bounds: Box, cw: number, ch: number): View {
  const h = ch - 30
  if (cw < 600) {
    const s = 0.7
    return {
      s,
      tx: r1(cw / 2 - (COL_X[1] + NODE_W.lane / 2) * s),
      ty: r1(40 - bounds.y * s),
    }
  }
  const s = clamp(Math.min(cw / bounds.w, h / bounds.h), ZOOM_MIN, 1.15)
  return {
    s,
    tx: r1((cw - bounds.w * s) / 2 - bounds.x * s),
    ty: r1(24 + (h - bounds.h * s) / 2 - bounds.y * s),
  }
}

/** Zoom by `k` about a point of the well (the pointer, or the well's centre). */
export function zoomAt(view: View, k: number, cx: number, cy: number): View {
  const s = clamp(view.s * k, ZOOM_MIN, ZOOM_MAX)
  return {
    s,
    tx: cx - (cx - view.tx) * (s / view.s),
    ty: cy - (cy - view.ty) * (s / view.s),
  }
}

/** Pan just enough that a box sits inside the well — how the keys bring a node into view. */
export function reveal(
  view: View,
  box: Box,
  cw: number,
  ch: number,
  pad = 24,
): View {
  const left = box.x * view.s + view.tx
  const top = box.y * view.s + view.ty
  const right = left + box.w * view.s
  const bottom = top + box.h * view.s
  let { tx, ty } = view
  if (right > cw - pad) tx -= right - (cw - pad)
  if (left + (tx - view.tx) < pad) tx += pad - (left + (tx - view.tx))
  if (bottom > ch - pad) ty -= bottom - (ch - pad)
  if (top + (ty - view.ty) < pad + 16) ty += pad + 16 - (top + (ty - view.ty))
  return tx === view.tx && ty === view.ty ? view : { s: view.s, tx, ty }
}

/**
 * The node an arrow key lands on: the nearest one in
 * that direction, staying within about a row (or a column) of the current.
 */
export function nearestNode(
  nodes: readonly (Box & { id: string })[],
  currentId: string | null,
  dx: -1 | 0 | 1,
  dy: -1 | 0 | 1,
): string | null {
  const current = nodes.find((node) => node.id === currentId)
  if (!current) return nodes[0]?.id ?? null
  let best: string | null = null
  let distance = Number.POSITIVE_INFINITY
  for (const node of nodes) {
    if (node === current) continue
    const ddx = node.x - current.x
    const ddy = node.y - current.y
    if (dx && Math.sign(ddx) !== dx) continue
    if (dy && Math.sign(ddy) !== dy) continue
    if (dx && Math.abs(ddy) > 140) continue
    if (dy && Math.abs(ddx) > 140) continue
    const d = Math.abs(ddx) + Math.abs(ddy)
    if (d < distance) {
      distance = d
      best = node.id
    }
  }
  return best
}
