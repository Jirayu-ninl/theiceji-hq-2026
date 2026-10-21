'use client'

import { useRouter } from 'next/navigation'
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  Inspector,
  isThai,
  useNarrow,
  usePageKeys,
} from '@/components/bridge/parts'
import { useAnswer } from '@/components/Inbox'
import { usePinned } from '@/components/shell/inspector'
import { usePageKeyHints } from '@/components/shell/keys'
import type { MapNodeData, ProjectMapData } from '@/lib/project-map'
import { MapInspector } from './MapInspector'
import {
  COL_X,
  fitView,
  NODE_W,
  nearestNode,
  reveal,
  type View,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAt,
} from './map-layout'
import './map.css'

// useLayoutEffect warns on the server; the map only measures in the browser.
const useIsoLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

const STEP = 1.2
const PAN = 80

/**
 * `/p/<slug>` · Map: the
 * kind's pipeline as a three-column ladder of LCD nodes on a well — feeders,
 * the board's lanes stacked, drains — joined by edges counted from `refs`.
 * Pan by dragging, zoom with the wheel or `+ −`, `f` fits, `0` is 100%,
 * `← → ↑ ↓` move between nodes (bringing them into view), `⇧` + arrows pan,
 * `↵` opens the node's page, `Esc` lets go. The inspector reads the selected
 * node; with none it reads the project — on screen only while the owner keeps
 * the inspector open, and only then do its answer keys work.
 *
 * The server lays everything out (`lib/project-map.ts`), so the first frame
 * is the finished drawing; the browser only fits it to the well.
 */
export function ProjectMap({
  data,
  slug,
}: {
  data: ProjectMapData
  slug: string
}) {
  const router = useRouter()
  const answering = useAnswer()
  const pinned = usePinned()
  const narrow = useNarrow()
  const canvas = useRef<HTMLElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [size, setSize] = useState<{ cw: number; ch: number } | null>(null)
  const viewRef = useRef<View | null>(null)
  viewRef.current = view
  // A refresh (after answering something) brings new data but keeps the view.
  const boundsRef = useRef(data.bounds)
  boundsRef.current = data.bounds

  const nodes = data.nodes
  const node = nodes.find((entry) => entry.id === selected) ?? null
  const byId = new Map(nodes.map((entry) => [entry.id, entry]))

  /* ── fitting ── */
  const measure = useCallback(() => {
    const element = canvas.current
    if (!element) return null
    return { cw: element.clientWidth, ch: element.clientHeight }
  }, [])
  const fit = useCallback(() => {
    const box = measure()
    if (!box?.cw || !box.ch) return
    setSize(box)
    setView(fitView(boundsRef.current, box.cw, box.ch))
  }, [measure])

  // Fit before the first paint after hydration — no animation frame needed.
  useIsoLayoutEffect(() => {
    fit()
  }, [fit])

  // Refit when the well changes size (a window, the rail, the sheet).
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    let last = `${element.clientWidth}x${element.clientHeight}`
    const onResize = () => {
      const next = `${element.clientWidth}x${element.clientHeight}`
      if (next === last) return
      last = next
      fit()
    }
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(onResize)
    observer?.observe(element)
    window.addEventListener('resize', onResize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [fit])

  const current = () => viewRef.current ?? fitView(data.bounds, 1000, 700)
  const zoomBy = (k: number) => {
    const box = measure()
    if (!box) return
    setSize(box)
    setView(zoomAt(current(), k, box.cw / 2, box.ch / 2))
  }
  const zoomTo = (s: number) => zoomBy(s / current().s)
  const panBy = (dx: number, dy: number) => {
    const v = current()
    setView({ ...v, tx: v.tx + dx, ty: v.ty + dy })
  }

  /* ── selecting ── */
  const focusNode = (id: string) =>
    canvas.current
      ?.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: true })
  const select = (id: string | null, focus = false) => {
    setSelected(id)
    setPicked(null)
    if (!id) return
    const target = byId.get(id)
    const box = measure()
    if (target && box) setView(reveal(current(), target, box.cw, box.ch))
    if (focus) focusNode(id)
  }

  /* ── panning and the wheel ── */
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.hud-br, .node, a, button')) return
    const v = current()
    drag.current = {
      x: event.clientX - v.tx,
      y: event.clientY - v.ty,
      moved: false,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // A pointer the browser no longer tracks: the drag still follows moves over the well.
    }
    event.currentTarget.classList.add('drag')
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    const v = current()
    const tx = event.clientX - d.x
    const ty = event.clientY - d.y
    if (!d.moved && Math.abs(tx - v.tx) + Math.abs(ty - v.ty) < 3) return
    d.moved = true
    setView({ ...v, tx, ty })
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    drag.current = null
    event.currentTarget.classList.remove('drag')
    // A click on the empty well lets go of the node.
    if (d && !d.moved) select(null)
  }
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('.hud-br')) return
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      setView((v) =>
        zoomAt(
          v ?? fitView(boundsRef.current, rect.width, rect.height),
          event.deltaY < 0 ? 1.08 : 1 / 1.08,
          event.clientX - rect.left,
          event.clientY - rect.top,
        ),
      )
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  /* ── keys ── */
  // No node: the project's queue, while its overview is on screen (kept open, wide).
  const queue = node
    ? node.waiting
    : pinned && !narrow
      ? data.entries.map((entry) => entry.id)
      : []
  const answerable =
    data.entries.find(
      (entry) =>
        entry.id === (picked && queue.includes(picked) ? picked : queue[0]),
    ) ?? null

  usePageKeyHints([
    ['↵', 'open'],
    ['← → ↑ ↓', 'nodes'],
    ['f', 'fit'],
    ['+ −', 'zoom'],
    ['0', '100%'],
    ['⇧ ← → ↑ ↓', 'pan'],
    ['Esc', 'let go'],
    ...(answerable?.answer?.options.map(
      (option) => [option.hotkey, option.label.toLowerCase()] as const,
    ) ?? []),
  ])

  usePageKeys((key, event) => {
    const arrows: Record<string, [-1 | 0 | 1, -1 | 0 | 1]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }
    const arrow = arrows[key]
    if (arrow) {
      if (event.shiftKey) {
        panBy(-arrow[0] * PAN, -arrow[1] * PAN)
        return true
      }
      const next = nearestNode(nodes, selected, arrow[0], arrow[1])
      if (next) select(next, true)
      return true
    }
    if (key === 'f') {
      fit()
      return true
    }
    if (key === '+' || key === '=') {
      zoomBy(STEP)
      return true
    }
    if (key === '-' || key === '_') {
      zoomBy(1 / STEP)
      return true
    }
    if (key === '0') {
      zoomTo(1)
      return true
    }
    if (key === 'Enter') {
      const active = document.activeElement as HTMLElement | null
      // A focused link or button (other than a node) does its own thing.
      if (active?.closest('a, button') && !active.closest('.node')) return false
      if (!node) return false
      router.push(node.href)
      return true
    }
    if (key === 'Escape') {
      if (!selected) return false
      select(null)
      canvas.current?.focus({ preventScroll: true })
      return true
    }
    const option = answerable?.answer?.options.find(
      (entry) => entry.hotkey === key,
    )
    if (option && answerable) {
      answering.answer(answerable, option.key)
      return true
    }
    return false
  })

  /* ── drawing ── */
  const { project, hud, bounds, world } = data
  const paused = project.status !== 'active'
  const tabStop = selected ?? nodes[0]?.id
  const worldStyle = {
    width: world.w,
    height: world.h,
    '--cx': `${bounds.x + bounds.w / 2}px`,
    '--cy': `${bounds.y + bounds.h / 2}px`,
    '--lx': `${COL_X[1] + NODE_W.lane / 2}px`,
    '--by': `${bounds.y}px`,
    ...(view
      ? { transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }
      : {}),
  } as CSSProperties

  return (
    <div className={`page pmap${paused ? ' paused' : ''}`} data-view='map'>
      <section
        ref={canvas}
        className='well canvas'
        aria-label={`${project.name} — the ${project.kindLabel} pipeline as a map`}
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className='world' style={worldStyle}>
          <svg className='edges' aria-hidden='true'>
            {data.edges.map((edge) => (
              <path
                key={edge.id}
                d={edge.d}
                className={edge.tone || undefined}
              />
            ))}
            {data.edges.map((edge) =>
              edge.label ? (
                <text
                  key={`${edge.id}:label`}
                  x={edge.lx}
                  y={edge.ly}
                  textAnchor={edge.anchor}
                  className={
                    edge.tone === 'wait' || edge.tone === 'money'
                      ? edge.tone
                      : undefined
                  }
                >
                  {edge.label}
                </text>
              ) : null,
            )}
          </svg>
          {/* biome-ignore lint/a11y/useSemanticElements: the map's nodes are a group of buttons, not a form fieldset */}
          <span
            className='nodes'
            role='group'
            aria-label={`Pipeline: ${nodes.length} nodes. Arrow keys move between them, Enter opens one.`}
          >
            {nodes.map((entry) => (
              <NodeButton
                key={entry.id}
                node={entry}
                color={project.color}
                selected={entry.id === selected}
                tabbable={entry.id === tabStop}
                onSelect={() => select(entry.id, true)}
              />
            ))}
          </span>
        </div>
        <div className='hud-tl'>
          <span className='title'>
            Project ·{' '}
            <b lang={isThai(project.name) ? 'th' : undefined}>{project.name}</b>
          </span>
          <span className='kind'>
            {project.kindLabel}
            {paused ? ` · ${project.status}` : ''} ·{' '}
            {hud.waiting ? (
              <span className='wait'>◆ {hud.waiting} waiting</span>
            ) : (
              'nothing waiting'
            )}{' '}
            ·{' '}
            {hud.running ? (
              <span className='live'>▶ {hud.running} running</span>
            ) : (
              '0 running'
            )}{' '}
            · {hud.money}
          </span>
        </div>
        <div className='hud-br'>
          <div className='mini' aria-hidden='true'>
            <svg
              viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`}
              preserveAspectRatio='xMidYMid meet'
            >
              {nodes.map((entry) => (
                <rect
                  key={entry.id}
                  x={entry.x}
                  y={entry.y}
                  width={entry.w}
                  height={entry.h}
                  rx={14}
                  className={
                    entry.state === 'wait'
                      ? 'wait'
                      : entry.kind === 'lane'
                        ? 'lane'
                        : undefined
                  }
                  style={
                    entry.kind === 'lane'
                      ? ({ '--project': project.color } as CSSProperties)
                      : undefined
                  }
                  opacity={entry.off ? 0.25 : 0.7}
                />
              ))}
              {view && size ? (
                <rect
                  className='v'
                  x={-view.tx / view.s}
                  y={-view.ty / view.s}
                  width={size.cw / view.s}
                  height={size.ch / view.s}
                />
              ) : null}
            </svg>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a zoom control is a group of buttons, not a form fieldset */}
          <span className='zoom' role='group' aria-label='Zoom'>
            <button
              type='button'
              title='Zoom out (−)'
              aria-label='Zoom out (−)'
              disabled={view ? view.s <= ZOOM_MIN : false}
              onClick={() => zoomBy(1 / STEP)}
            >
              −
            </button>
            <button
              type='button'
              title='Zoom to 100% (0)'
              aria-label={
                view
                  ? `Zoom to 100% (0), now ${Math.round(view.s * 100)}%`
                  : 'Zoom to 100% (0)'
              }
              onClick={() => zoomTo(1)}
            >
              {view ? `${Math.round(view.s * 100)}%` : '…'}
            </button>
            <button
              type='button'
              title='Zoom in (+)'
              aria-label='Zoom in (+)'
              disabled={view ? view.s >= ZOOM_MAX : false}
              onClick={() => zoomBy(STEP)}
            >
              +
            </button>
            <button
              type='button'
              title='Fit (f)'
              aria-label='Fit the map (f)'
              onClick={fit}
            >
              ⌖
            </button>
          </span>
        </div>
        <span className='legend' aria-hidden='true'>
          <span className='wait'>◆ waits for you</span>
          <span className='live'>▶ running</span>
          <span className='money'>— money</span>
        </span>
        <ul className='sr-only' aria-label='Flows'>
          {data.edges.map((edge) => (
            <li key={edge.id}>{edge.words}</li>
          ))}
        </ul>
      </section>
      {/* At ≤ 1100 the inspector is a sheet that waits for a selection (CSS keeps it
          away until then, so a phone's first paint is the map alone). */}
      <Inspector
        id='map'
        label={node ? `${node.label} — inspector` : 'Inspector'}
        empty={!node}
        onClose={() => select(null)}
      >
        <MapInspector
          data={data}
          slug={slug}
          node={node}
          onClose={() => select(null)}
          picked={picked}
          onPick={setPicked}
          answering={answering}
        />
      </Inspector>
    </div>
  )
}

function NodeButton({
  node,
  color,
  selected,
  tabbable,
  onSelect,
}: {
  node: MapNodeData
  color: string
  selected: boolean
  tabbable: boolean
  onSelect: () => void
}) {
  const cls = [
    'node',
    node.kind,
    node.state === 'wait' ? 'wait' : '',
    node.off ? 'off' : '',
    selected ? 'sel' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button
      type='button'
      className={cls}
      data-node={node.id}
      style={
        {
          left: node.x,
          top: node.y,
          width: node.w,
          height: node.h,
          '--project': color,
        } as CSSProperties
      }
      aria-label={node.aria}
      aria-pressed={selected}
      tabIndex={tabbable ? 0 : -1}
      onClick={onSelect}
    >
      {node.chip ? (
        <span className={`chip ${node.chip.tone}`}>
          <i />
          {node.chip.text}
        </span>
      ) : null}
      <span className='h'>
        <span className='g'>{node.glyph}</span>
        <span className='l' lang={isThai(node.label) ? 'th' : undefined}>
          {node.label}
        </span>
        <span className='role'>{node.role}</span>
      </span>
      <span
        className={`big${node.tone ? ` ${node.tone}` : ''}${node.module === 'money' || node.module === 'readings' ? ' cash' : ''}`}
      >
        {node.mark ? <span className='mk'>{node.mark}</span> : null}
        <span className='fig'>{node.big}</span>
        {node.unit ? <span className='u'>{node.unit}</span> : null}
      </span>
      <span
        className={`sub${node.state === 'wait' ? ' wait' : ''}`}
        lang={isThai(node.sub) ? 'th' : undefined}
      >
        {node.sub}
      </span>
      {node.lane ? (
        <span className='lane-bar' aria-hidden='true'>
          {node.lane.counts.map((_, index) => (
            <i
              key={index}
              className={
                index === node.lane?.index
                  ? node.state === 'wait'
                    ? 'wait'
                    : 'on'
                  : undefined
              }
            />
          ))}
        </span>
      ) : null}
    </button>
  )
}
