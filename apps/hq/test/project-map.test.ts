import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MODULES,
  LANE_PRESETS,
  PROJECT_KINDS,
} from '@theiceji/hq-core/modules'
import { REF_ROLES } from '@theiceji/hq-db/enums'
import {
  attributeRef,
  boundsOf,
  COL_X,
  countLabel,
  edgePath,
  fitView,
  NODE_H,
  NODE_W,
  nearestNode,
  PLACE,
  reveal,
  rowY,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAt,
} from '../src/components/project/map-layout'

/**
 * The project map's pure parts: the kind's ladder, how a
 * `refs` row is counted on an edge, the edge curves, fit and zoom, and where
 * an arrow key lands.
 */

const box = (id: string, col: 0 | 1 | 2, row: number) => ({
  id,
  x: COL_X[col],
  y: rowY(row),
  w: col === 1 ? NODE_W.lane : NODE_W.src,
  h: col === 1 ? NODE_H.lane : NODE_H.src,
})

describe('placement', () => {
  test('every kind has a ladder, and its slots feed lanes the preset has', () => {
    for (const kind of PROJECT_KINDS) {
      const place = PLACE[kind]
      expect(place.src.length).toBeGreaterThan(0)
      const lanes = LANE_PRESETS[kind].length
      for (const [, , to] of [...place.src, ...place.sink])
        if (typeof to === 'number') expect(to).toBeLessThan(lanes)
    }
  })

  test('a kind places its default modules (Notes and Money aside), each once', () => {
    for (const kind of PROJECT_KINDS) {
      const ids = [...PLACE[kind].src, ...PLACE[kind].sink].map(([id]) => id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of DEFAULT_MODULES[kind])
        if (id !== 'board') expect(ids).toContain(id)
    }
  })

  test('a drain that reads another node names a node that sits in the ladder', () => {
    for (const kind of PROJECT_KINDS) {
      const ids = [...PLACE[kind].src, ...PLACE[kind].sink].map(([id]) => id)
      for (const [, , to] of PLACE[kind].sink)
        if (typeof to === 'string') expect(ids).toContain(to as never)
    }
  })
})

describe('edges from refs', () => {
  test('each role the kernel links is counted on one node, in words', () => {
    expect(attributeRef('promoted_to', 'note', 'card')).toEqual({
      node: 'notes',
      word: 'promoted',
    })
    expect(attributeRef('proposed_as', 'proposal', 'card')?.node).toBe('agents')
    expect(attributeRef('quoted_by', 'card', 'quote')?.node).toBe('quotes')
    expect(attributeRef('published_as', 'card', 'post')?.node).toBe('publish')
    expect(attributeRef('listed_as', 'card', 'listing')?.node).toBe('market')
    expect(attributeRef('result_of', 'asset', 'shot')?.node).toBe('assets')
    expect(attributeRef('example_of', 'asset', 'prompt_variant')?.node).toBe(
      'prompts',
    )
    expect(attributeRef('attached', 'post', 'experiment')?.node).toBe(
      'experiments',
    )
    expect(attributeRef('attached', 'quote', 'asset')?.node).toBe('assets')
  })

  test('every role has a place, and an unknown one has none', () => {
    for (const role of REF_ROLES)
      expect(
        attributeRef(role, 'post', role === 'attached' ? 'experiment' : 'card'),
      ).not.toBeNull()
    expect(attributeRef('unheard_of', 'note', 'card')).toBeNull()
    expect(attributeRef('attached', 'note', 'card')).toBeNull()
  })

  test('a label names the two largest counts and never a zero', () => {
    expect(
      countLabel([
        { word: 'promoted', n: 3 },
        { word: 'accepted', n: 0 },
      ]),
    ).toBe('3 promoted')
    expect(
      countLabel([
        { word: 'results', n: 2 },
        { word: 'attached', n: 5 },
        { word: 'examples', n: 1 },
      ]),
    ).toBe('5 attached · 2 results')
    expect(countLabel([])).toBe('')
  })
})

describe('geometry', () => {
  test('down a column the edge runs bottom to top, its label to the side', () => {
    const a = box('a', 1, 0)
    const b = box('b', 1, 1)
    const path = edgePath(a, b)
    expect(path.d.startsWith(`M${a.x + a.w / 2} ${a.y + a.h}`)).toBe(true)
    expect(path.d.endsWith(`${b.x + b.w / 2} ${b.y}`)).toBe(true)
    expect(path.anchor).toBe('start')
  })

  test('across columns it leaves one side and enters the other', () => {
    const a = box('a', 0, 0)
    const b = box('b', 1, 0)
    const right = edgePath(a, b)
    expect(right.d.startsWith(`M${a.x + a.w} ${a.y + a.h / 2}`)).toBe(true)
    expect(right.anchor).toBe('middle')
    const left = edgePath(b, a)
    expect(left.d.startsWith(`M${b.x} ${b.y + b.h / 2}`)).toBe(true)
    // A diagonal keeps its label near its source.
    const diagonal = edgePath(a, box('c', 1, 3))
    expect(diagonal.lx).toBeLessThan((a.x + a.w + COL_X[1]) / 2)
  })

  test('bounds leave room for chips above and labels around', () => {
    const b = boundsOf([box('a', 0, 0), box('b', 2, 4)])
    expect(b.x).toBe(COL_X[0] - 24)
    expect(b.y).toBe(rowY(0) - 30)
    expect(b.x + b.w).toBe(COL_X[2] + NODE_W.src + 24)
  })

  test('fit puts the whole ladder in the well, at most 115%', () => {
    const b = boundsOf([box('a', 0, 0), box('b', 2, 5)])
    const view = fitView(b, 900, 800)
    expect(view.s).toBeLessThanOrEqual(1.15)
    expect(b.x * view.s + view.tx).toBeGreaterThanOrEqual(0)
    expect((b.x + b.w) * view.s + view.tx).toBeLessThanOrEqual(900.5)
    expect((b.y + b.h) * view.s + view.ty).toBeLessThanOrEqual(800)
    expect(fitView(b, 4000, 3000).s).toBe(1.15)
  })

  test('on a phone the fit stays readable and centres the lanes', () => {
    const b = boundsOf([box('a', 0, 0), box('b', 2, 5)])
    const view = fitView(b, 400, 700)
    expect(view.s).toBe(0.7)
    const laneCentre = (COL_X[1] + NODE_W.lane / 2) * view.s + view.tx
    expect(Math.abs(laneCentre - 200)).toBeLessThan(1)
  })

  test('zoom keeps the point under the pointer and stays in range', () => {
    const view = { s: 1, tx: 10, ty: 20 }
    const zoomed = zoomAt(view, 1.5, 300, 200)
    expect((300 - zoomed.tx) / zoomed.s).toBeCloseTo((300 - view.tx) / view.s)
    expect(zoomAt(view, 100, 0, 0).s).toBe(ZOOM_MAX)
    expect(zoomAt(view, 0.001, 0, 0).s).toBe(ZOOM_MIN)
  })

  test('reveal pans just enough to bring a node inside the well', () => {
    const view = { s: 1, tx: 0, ty: 0 }
    const far = box('far', 2, 8)
    const next = reveal(view, far, 800, 600)
    expect((far.y + far.h) * next.s + next.ty).toBeLessThanOrEqual(600 - 24)
    const near = box('near', 0, 0)
    expect(reveal(view, near, 800, 600)).toBe(view)
  })
})

describe('keys', () => {
  const nodes = [
    box('notes', 0, 0),
    box('prompts', 0, 1),
    box('lane:0', 1, 0),
    box('lane:1', 1, 1),
    box('assets', 2, 1),
  ]

  test('an arrow lands on the nearest node that way, within a row or column', () => {
    expect(nearestNode(nodes, 'notes', 1, 0)).toBe('lane:0')
    expect(nearestNode(nodes, 'lane:1', 1, 0)).toBe('assets')
    expect(nearestNode(nodes, 'lane:0', 0, 1)).toBe('lane:1')
    expect(nearestNode(nodes, 'prompts', 0, -1)).toBe('notes')
    expect(nearestNode(nodes, 'notes', -1, 0)).toBeNull()
  })

  test('with nothing selected the first key picks the first node', () => {
    expect(nearestNode(nodes, null, 0, 1)).toBe('notes')
    expect(nearestNode([], null, 1, 0)).toBeNull()
  })
})
