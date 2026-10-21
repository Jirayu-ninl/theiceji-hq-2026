'use client'

import {
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { isThai, projectHex } from '@/components/bridge/parts'
import type { InboxEntry } from '@/components/Inbox'
import type { HomeModule, HomeProject } from '@/lib/home'

/**
 * Space's orbit: projects as
 * planets on a tilted plane, you at the core. Angle is identity — each project
 * keeps a fixed angle in the owner's order. Radius is need: ring 1 something
 * waits for you, ring 2 something is running or due today, ring 3 idle. A
 * reticle round each planet carries one slot per module: a tick where the
 * module is on, a moon where it has a state (◆ waiting · ▶ running · ● due).
 *
 * Nothing orbits. The only motion is idle (ring dashes, the core breathing,
 * the sweep, dust) and a planet sliding along its spoke when its state
 * changes. Labels, moons and the core are real links laid over the SVG.
 * The first frame is drawn on the server; the well's shape only refines the
 * tilt once it is measured.
 */

const CX = 500
/** Radius of ring 1 (needs you), 2 (active) and 3 (idle). */
const ringRadius = (ring: number) => (ring === 1 ? 188 : ring === 2 ? 300 : 410)
const FLOAT = 28
const RET = 30
const D2R = Math.PI / 180
const RINGS = ['needs you', 'active', 'idle'] as const
const GLYPH = {
  wait: '◆',
  live: '▶',
  due: '●',
  new: '○',
  unknown: '—',
} as const
const WORD = {
  wait: 'waiting for you',
  live: 'running',
  due: 'due today',
  new: 'nothing yet',
  unknown: 'not read back',
} as const

type MoonState = keyof typeof GLYPH

// Trig rounded to 1e-6: the server and the browser disagree in the last
// digit of Math.sin/cos, which would otherwise fail hydration.
const sin = (a: number) => Math.round(Math.sin(a) * 1e6) / 1e6
const cos = (a: number) => Math.round(Math.cos(a) * 1e6) / 1e6
const angleOf = (i: number, n: number) =>
  (18 + (i * 360) / Math.max(1, n)) * D2R
const depth = (a: number) => (1 - cos(a)) / 2
const shade = (hex: string, f: number) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgb(${[n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f)).join(',')})`
}

function geometry(well: HTMLElement | null) {
  if (!well) return { h: 820, k: 0.5 }
  const aspect = (well.clientHeight - 96) / Math.max(1, well.clientWidth - 24)
  // Tall wells (both side columns open) tilt the plane toward you.
  const h = Math.round(Math.min(1200, Math.max(760, 1000 * aspect)) / 20) * 20
  return {
    h,
    k: Math.min(0.68, Math.max(0.46, 0.5 + ((h - 820) / 1000) * 0.55)),
  }
}

type ProjectState = { wait: number; live: number; due: number; ring: 1 | 2 | 3 }

function stateOf(project: HomeProject): ProjectState {
  let wait = 0
  let live = 0
  let due = 0
  for (const module of project.modules) {
    if (module.cell?.state === 'wait') wait++
    else if (module.cell?.state === 'live') live++
    else if (module.cell?.state === 'due') due++
  }
  // Waiting items count once, whether or not they belong to a module.
  wait = Math.max(wait, project.waiting)
  const ring =
    project.status === 'paused' ? 3 : wait > 0 ? 1 : live > 0 || due > 0 ? 2 : 3
  return { wait, live, due, ring }
}

function moonOf(project: HomeProject, module: HomeModule): MoonState | null {
  if (!module.cell) return null
  if (project.fresh) return 'new'
  const state = module.cell.state
  return state === 'wait' ||
    state === 'live' ||
    state === 'due' ||
    state === 'unknown'
    ? state
    : null
}

const moneyText = (project: HomeProject) =>
  project.pending.length
    ? `(${project.pending.map((entry) => entry.label).join(' + ')})`
    : ''

function sayState(state: ProjectState) {
  const bits = []
  if (state.wait) bits.push(`${state.wait} waiting for you`)
  if (state.live) bits.push(`${state.live} running`)
  if (state.due) bits.push(`${state.due} due today`)
  return bits.join(', ') || 'idle'
}

/** One line under a planet's name: the loudest state, then money. */
function Readout({
  project,
  state,
}: {
  project: HomeProject
  state: ProjectState
}) {
  if (project.fresh) return <span>○ nothing yet</span>
  const parts: React.ReactNode[] = []
  const liveCell = project.modules.find(
    (module) => module.cell?.state === 'live',
  )
  const dueCell = project.modules.find((module) => module.cell?.state === 'due')
  if (state.wait)
    parts.push(
      <span key='w' className='w'>
        ◆ {state.wait} waiting
      </span>,
    )
  else if (liveCell?.cell)
    parts.push(
      <span key='l' className='l'>
        ▶ {liveCell.cell.sub ?? liveCell.cell.unit}
      </span>,
    )
  else if (dueCell?.cell)
    parts.push(
      <span key='d' className='d'>
        ●{' '}
        {dueCell.cell.sub ?? `${dueCell.cell.value} ${dueCell.cell.unit ?? ''}`}{' '}
        today
      </span>,
    )
  const money = moneyText(project)
  if (money) parts.push(<span key='m'>{money}</span>)
  if (!parts.length) return <span>{state.ring === 3 ? 'idle' : ''}</span>
  return (
    <>
      {parts.flatMap((part, index) =>
        index ? [<span key={`s${index}`}> · </span>, part] : [part],
      )}
    </>
  )
}

export type OrbitProps = {
  projects: HomeProject[]
  entries: InboxEntry[]
  slots: number
  week: { label: string; range: string }
  timezone: string
  locked: string | null
  onLock: (slug: string) => void
  /** A moon with a waiting item behind it selects that item in the dock. */
  onWaiting: (entryId: string) => void
  /** The core: open what waits. */
  onCore: (event: MouseEvent<HTMLAnchorElement>) => void
}

export function Orbit({
  projects,
  entries,
  slots,
  week,
  timezone,
  locked,
  onLock,
  onWaiting,
  onCore,
}: OrbitProps) {
  const well = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const [geo, setGeo] = useState({ h: 820, k: 0.5 })
  const [hot, setHot] = useState<string | null>(null)
  const { h: H, k: K } = geo
  const CY = Math.round(H * 0.535)
  const plane = (r: number, a: number): [number, number] => [
    CX + r * sin(a),
    CY - r * cos(a) * K,
  ]
  const pct = (x: number, y: number) => ({
    left: `${(x / 10).toFixed(3)}%`,
    top: `${((y / H) * 100).toFixed(3)}%`,
  })
  const slotAngle = (slot: number) => ((slot * 360) / slots) * D2R

  // The well's shape sets the tilt; `--u` is one viewBox unit in pixels.
  useEffect(() => {
    const w = well.current
    const f = frame.current
    if (!w || !f) return
    const sync = () => {
      const next = geometry(w)
      setGeo((prev) =>
        Math.abs(prev.h - next.h) < 20 && prev.k === next.k ? prev : next,
      )
      f.style.setProperty('--u', `${f.clientWidth / 1000}px`)
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(w)
    observer.observe(f)
    return () => observer.disconnect()
  }, [])

  // Keep every label inside the well: narrow wells push side labels past the edge.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the drawing changes
  useLayoutEffect(() => {
    const w = well.current
    const l = layer.current
    if (!w || !l) return
    const clamp = () => {
      const bounds = w.getBoundingClientRect()
      const margin = 10
      for (const label of l.querySelectorAll<HTMLElement>('.pl')) {
        label.style.marginLeft = ''
        label.style.marginTop = ''
        const r = label.getBoundingClientRect()
        const dx =
          r.left < bounds.left + margin
            ? bounds.left + margin - r.left
            : r.right > bounds.right - margin
              ? bounds.right - margin - r.right
              : 0
        const dy =
          r.top < bounds.top + margin
            ? bounds.top + margin - r.top
            : r.bottom > bounds.bottom - margin
              ? bounds.bottom - margin - r.bottom
              : 0
        if (dx) label.style.marginLeft = `${dx.toFixed(0)}px`
        if (dy) label.style.marginTop = `${dy.toFixed(0)}px`
      }
    }
    clamp()
    const observer = new ResizeObserver(clamp)
    observer.observe(w)
    document.fonts?.ready.then(clamp)
    return () => observer.disconnect()
  }, [projects, locked, H])

  const n = projects.length
  const states = useMemo(
    () => new Map(projects.map((project) => [project.slug, stateOf(project)])),
    [projects],
  )
  const counts: [string[], string[], string[]] = [[], [], []]
  for (const project of projects)
    counts[(states.get(project.slug)?.ring ?? 3) - 1]?.push(project.name)
  const waitingTotal = entries.length
  const target = projects.find((project) => project.slug === locked) ?? null

  // Ring captions sit in the widest gap between planets, nearest 9 o'clock.
  const captionAngle = useMemo(() => {
    const angles = projects
      .map((_, i) => (((angleOf(i, n) / D2R) % 360) + 360) % 360)
      .sort((a, b) => a - b)
    let best: { size: number; mid: number; pull: number } | null = null
    angles.forEach((d, i) => {
      const next =
        i === angles.length - 1 ? (angles[0] ?? 0) + 360 : (angles[i + 1] ?? d)
      const mid = (d + (next - d) / 2) % 360
      const size = next - d
      const pull = Math.abs(((mid - 270 + 540) % 360) - 180)
      if (
        !best ||
        size > best.size + 0.5 ||
        (Math.abs(size - best.size) <= 0.5 && pull < best.pull)
      )
        best = { size, mid, pull }
    })
    return (best as { mid: number } | null)?.mid ?? 270
  }, [projects, n])

  const stage = useMemo(() => {
    let seed = 11
    const rnd = () => {
      seed = (seed * 9301 + 49297) % 233280
      return seed / 233280
    }
    const dust = Array.from({ length: 38 }, () => ({
      cx: (60 + rnd() * 880).toFixed(1),
      cy: (110 + rnd() * (H - 160)).toFixed(1),
      r: (0.7 + rnd() * 1.1).toFixed(2),
      style: {
        ['--d' as string]: `${(9 + rnd() * 9).toFixed(1)}s`,
        ['--dl' as string]: `${(-rnd() * 12).toFixed(1)}s`,
        ['--o' as string]: (0.08 + rnd() * 0.22).toFixed(2),
        ['--dx' as string]: `${(rnd() * 10 - 5).toFixed(1)}px`,
      },
    }))
    const w = -30 * D2R
    return (
      <>
        <defs>
          <linearGradient
            id='sweepG'
            gradientUnits='userSpaceOnUse'
            x1='0'
            y1='0'
            x2='0'
            y2='-240'
          >
            <stop
              offset='0'
              style={{ stopColor: 'var(--lcd-ink)' }}
              stopOpacity='.1'
            />
            <stop
              offset='1'
              style={{ stopColor: 'var(--lcd-ink)' }}
              stopOpacity='0'
            />
          </linearGradient>
          <linearGradient id='beamG' x1='0' y1='1' x2='0' y2='0'>
            <stop
              offset='0'
              style={{ stopColor: 'var(--lcd-accent)' }}
              stopOpacity='0'
            />
            <stop
              offset='.5'
              style={{ stopColor: 'var(--lcd-accent)' }}
              stopOpacity='.55'
            />
            <stop
              offset='1'
              style={{ stopColor: 'var(--lcd-accent)' }}
              stopOpacity='.1'
            />
          </linearGradient>
          <radialGradient id='coreGlow'>
            <stop
              offset='0'
              style={{ stopColor: 'var(--lcd-accent)' }}
              stopOpacity='.32'
            />
            <stop
              offset='.55'
              style={{ stopColor: 'var(--lcd-accent)' }}
              stopOpacity='.07'
            />
            <stop
              offset='1'
              style={{ stopColor: 'var(--lcd-accent)' }}
              stopOpacity='0'
            />
          </radialGradient>
          <radialGradient id='coreBody' cx='.38' cy='.32' r='.8'>
            <stop offset='0' stopColor='#3a3222' />
            <stop offset='.6' stopColor='#15130f' />
            <stop offset='1' stopColor='#0b0b0d' />
          </radialGradient>
          <radialGradient id='padG'>
            <stop
              offset='0'
              style={{ stopColor: 'var(--lcd-accent)' }}
              stopOpacity='.16'
            />
            <stop
              offset='1'
              style={{ stopColor: 'var(--lcd-accent)' }}
              stopOpacity='0'
            />
          </radialGradient>
        </defs>
        <g transform={`translate(${CX} ${CY}) scale(1 ${K})`}>
          <circle className='o-grid' r={470} />
          <circle className='o-grid faint' r={60} />
          {Array.from({ length: 12 }, (_, i) => {
            const a = i * 30 * D2R
            return (
              <line
                key={`s${i}`}
                className='o-grid faint'
                x1={64 * sin(a)}
                y1={-64 * cos(a)}
                x2={466 * sin(a)}
                y2={-466 * cos(a)}
              />
            )
          })}
          {Array.from({ length: 72 }, (_, i) => {
            const d = i * 5
            const a = d * D2R
            const major = d % 30 === 0
            const r2 = major ? 488 : d % 10 === 0 ? 480 : 476
            return (
              <line
                key={`t${d}`}
                className={`o-tick${major ? ' maj' : ''}`}
                x1={470 * sin(a)}
                y1={-470 * cos(a)}
                x2={r2 * sin(a)}
                y2={-r2 * cos(a)}
              />
            )
          })}
          <g className='o-sweep'>
            <path
              d={`M0 0 L466 0 A466 466 0 0 0 ${466 * cos(w)} ${466 * sin(w)} Z`}
              fill='url(#sweepG)'
            />
            <line className='o-sweep-edge' x1={0} y1={0} x2={466} y2={0} />
          </g>
        </g>
        {(
          [
            [0, '000'],
            [90, '090'],
            [180, '180'],
            [270, '270'],
          ] as const
        ).map(([d, text]) => {
          const [x, y] = [CX + 504 * sin(d * D2R), CY - 504 * cos(d * D2R) * K]
          return (
            <text
              key={text}
              className='o-deg'
              x={x}
              y={y + (d === 0 ? -6 : d === 180 ? 14 : 4)}
              textAnchor={d === 90 ? 'start' : d === 270 ? 'end' : 'middle'}
            >
              {text}
            </text>
          )
        })}
        <g>
          {[1, 2, 3].map((i) => (
            <ellipse
              key={i}
              className={`o-ring r${i}`}
              cx={CX}
              cy={CY}
              rx={ringRadius(i)}
              ry={ringRadius(i) * K}
            />
          ))}
        </g>
        <g className='o-dust'>
          {dust.map((d) => (
            <circle
              key={`${d.cx}-${d.cy}`}
              cx={d.cx}
              cy={d.cy}
              r={d.r}
              style={d.style}
            />
          ))}
        </g>
        <g>
          <ellipse cx={CX} cy={CY} rx={70} ry={35} fill='url(#padG)' />
          <ellipse className='o-core-pad' cx={CX} cy={CY} rx={58} ry={29} />
          <line className='o-beam' x1={CX} y1={CY} x2={CX} y2={CY - 34} />
          <circle
            className='o-core-glow'
            cx={CX}
            cy={CY - 34}
            r={78}
            fill='url(#coreGlow)'
          />
          <circle
            className='o-core-body'
            cx={CX}
            cy={CY - 34}
            r={40}
            fill='url(#coreBody)'
          />
          <circle className='o-core-rim' cx={CX} cy={CY - 34} r={47} />
        </g>
      </>
    )
  }, [H, K, CY])

  const waitingFor = (project: HomeProject, module?: HomeModule) =>
    entries.filter(
      (entry) =>
        entry.project?.slug === project.slug &&
        (!module || entry.module === module.id),
    )

  const onPlanet = (event: MouseEvent<HTMLAnchorElement>, slug: string) => {
    if (locked === slug) return // the second click opens the project
    event.preventDefault()
    onLock(slug)
  }

  return (
    <section className='pane orbit-panel' aria-label='Projects in orbit'>
      <div className='well orbit' ref={well}>
        <div className='hud tl'>
          <span className='ttl'>SPACE</span>
          <span className='hud-label'>
            {n} projects · angle fixed · distance = need
          </span>
          <span className='rings'>
            {RINGS.map((label, i) => (
              <span key={label} className={`r${i + 1}`}>
                <i />
                <b>{counts[i]?.length ?? 0}</b>
                {label}
              </span>
            ))}
          </span>
        </div>
        <div className='hud tr'>
          {target ? (
            <TargetHud
              project={target}
              state={states.get(target.slug) ?? stateOf(target)}
            />
          ) : (
            <>
              <span className='hud-label'>TARGET</span>
              <span className='tname none'>none locked</span>
              <span className='hud-label'>←→ to lock a planet</span>
            </>
          )}
        </div>
        <div
          className='orbit-frame'
          ref={frame}
          style={{
            aspectRatio: `1000 / ${H}`,
            width: `min(100cqw - 24px, (100cqh - 96px) * ${(1000 / H).toFixed(4)})`,
          }}
        >
          <svg
            className='scene'
            viewBox={`0 0 1000 ${H}`}
            role='img'
            aria-labelledby='orbit-title orbit-desc'
          >
            <title id='orbit-title'>Projects by how much they need you</title>
            <desc id='orbit-desc'>
              {`${waitingTotal} waiting for you. Needs you: ${counts[0].join(', ') || 'none'}. Active: ${counts[1].join(', ') || 'none'}. Idle: ${counts[2].join(', ') || 'none'}.`}
            </desc>
            {stage}
            <g>
              {RINGS.map((label, i) => {
                const [x, y] = plane(ringRadius(i + 1), captionAngle * D2R)
                return (
                  <text
                    key={label}
                    className={`o-ringlbl r${i + 1}`}
                    x={x}
                    y={y - 7}
                    textAnchor='middle'
                  >
                    {`0${i + 1} ${label.toUpperCase()}`}
                  </text>
                )
              })}
            </g>
            <g>
              {projects.map((project, i) => {
                const a = angleOf(i, n)
                const state = states.get(project.slug) ?? stateOf(project)
                const [x, y] = plane(ringRadius(state.ring), a)
                return (
                  <Planet
                    key={project.slug}
                    project={project}
                    angle={a}
                    x={x}
                    y={y}
                    current={project.slug === locked}
                    hot={project.slug === hot}
                    slotAngle={slotAngle}
                  />
                )
              })}
            </g>
          </svg>
          <div
            className={`o-layer${n > 8 ? ' dense' : ''}`}
            ref={layer}
            onPointerLeave={() => setHot(null)}
          >
            {projects.map((project, i) => {
              const a = angleOf(i, n)
              const state = states.get(project.slug) ?? stateOf(project)
              const [x, y] = plane(ringRadius(state.ring), a)
              const s = 0.86 + 0.28 * depth(a)
              const side =
                state.ring === 1 && Math.abs(cos(a)) < 0.66
                  ? sin(a) > 0
                    ? 'side-r'
                    : 'side-l'
                  : ''
              const below = !side && cos(a) < -0.05
              const gap = (RET + 10) * s
              const current = project.slug === locked
              const paused = project.status === 'paused'
              const kind = paused
                ? 'paused'
                : project.fresh
                  ? `new · ${project.kindLabel}`
                  : project.kindLabel
              const R = RET * s
              return (
                <span key={project.slug} style={{ display: 'contents' }}>
                  <a
                    className={[
                      'pl',
                      side,
                      below ? 'below' : '',
                      current ? 'current' : '',
                      paused ? 'paused' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    href={`/p/${project.slug}`}
                    data-planet={project.slug}
                    style={{
                      ...pct(x, y - FLOAT),
                      ['--gap' as string]: `calc(var(--u, 1px) * ${gap.toFixed(1)})`,
                    }}
                    aria-label={`${project.name}, ${project.kindLabel}${paused ? ', paused' : ''}: ${sayState(state)}. Ring ${state.ring} of 3, ${RINGS[state.ring - 1]}.${current ? ' Locked — press again to open the project.' : ' Click to lock.'}`}
                    onClick={(event) => onPlanet(event, project.slug)}
                    onPointerEnter={() => setHot(project.slug)}
                  >
                    <span className='pl-nm'>
                      <i
                        className='dot'
                        style={{
                          ['--project' as string]: projectHex(project.color),
                        }}
                      />
                      <span lang={isThai(project.name) ? 'th' : undefined}>
                        {project.name}
                      </span>
                    </span>
                    <span className='pl-kind'>{kind}</span>
                    <span className='pl-read'>
                      <Readout project={project} state={state} />
                    </span>
                  </a>
                  {project.modules.map((module) => {
                    const moon = moonOf(project, module)
                    if (!moon) return null
                    const sa = slotAngle(module.slot)
                    const mx = x + R * sin(sa)
                    const my = y - FLOAT - R * cos(sa)
                    const value = module.cell
                      ? `${module.cell.value} ${module.cell.unit ?? ''}`.trim()
                      : 'nothing yet'
                    const waiting =
                      moon === 'wait'
                        ? waitingFor(project, module)[0]
                        : undefined
                    return (
                      <a
                        key={module.id}
                        className={`moon ${moon}`}
                        href={module.href}
                        style={pct(mx, my)}
                        data-tip={`${GLYPH[moon]} ${module.label.toUpperCase()} · ${value}`}
                        aria-label={`${project.name} › ${module.label}: ${value}, ${WORD[moon]}`}
                        onClick={(event) => {
                          if (!waiting) return
                          event.preventDefault()
                          onWaiting(waiting.id)
                        }}
                      >
                        <i />
                      </a>
                    )
                  })}
                </span>
              )
            })}
            <a
              className={`core${waitingTotal ? '' : ' clear'}`}
              href='/inbox'
              style={pct(CX, CY - 34)}
              aria-label={
                waitingTotal
                  ? `${waitingTotal} waiting for you — open`
                  : 'Nothing waiting for you'
              }
              onClick={onCore}
            >
              <b>{waitingTotal}</b>
              <span>{waitingTotal ? 'WAITING' : 'ALL CLEAR'}</span>
            </a>
          </div>
        </div>
        <div className='hud bl'>
          <span className='legend'>
            <span className='w'>◆ waiting</span>
            <span className='l'>▶ running</span>
            <span className='d'>● due today</span>
            <span>
              <i className='t' />
              module on
            </span>
          </span>
          <span className='hud-label'>←→ lock planet · ↵ open · i inbox</span>
        </div>
        <div className='hud br'>
          <Clock timezone={timezone} />
          <span className='hud-label'>
            {week.label} · {week.range}
          </span>
        </div>
      </div>
    </section>
  )
}

function TargetHud({
  project,
  state,
}: {
  project: HomeProject
  state: ProjectState
}) {
  const money = project.pending.length
    ? `${project.pending.map((entry) => entry.label).join(' + ')} pending`
    : 'nothing pending'
  return (
    <>
      <span className='hud-label'>TARGET · RING 0{state.ring}</span>
      <a
        className='tname'
        href={`/p/${project.slug}`}
        title={`Open ${project.name} — project page`}
        lang={isThai(project.name) ? 'th' : undefined}
      >
        {project.name}
      </a>
      <span className='hud-label'>
        {project.kindLabel} · {project.modules.length} modules
        {project.status === 'paused' ? ' · paused' : ''}
      </span>
      <span className='lock-read'>
        <span className='w'>◆ {state.wait}</span>
        <span className='l'>▶ {state.live}</span>
        <span className='d'>● {state.due}</span>
      </span>
      <span className='hud-label'>{money}</span>
    </>
  )
}

function Planet({
  project,
  angle,
  x,
  y,
  current,
  hot,
  slotAngle,
}: {
  project: HomeProject
  angle: number
  x: number
  y: number
  current: boolean
  hot: boolean
  slotAngle: (slot: number) => number
}) {
  const s = 0.86 + 0.28 * depth(angle)
  const hex = projectHex(project.color)
  const id = `pg-${project.slug}`
  const R = RET * s
  const L = (RET + 8) * s
  const cls = [
    'planet',
    current ? 'current' : '',
    hot ? 'hot' : '',
    project.status === 'paused' ? 'paused' : '',
    project.fresh ? 'new' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <g
      className={cls}
      style={{
        ['--project' as string]: hex,
        transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`,
      }}
    >
      <defs>
        <radialGradient id={id} cx='.36' cy='.3' r='.8'>
          <stop offset='0' stopColor='#ffffff' stopOpacity='.85' />
          <stop offset='.28' stopColor={hex} />
          <stop offset='1' stopColor={shade(hex, 0.32)} />
        </radialGradient>
      </defs>
      <ellipse className='pad' cx={0} cy={0} rx={15 * s} ry={7.5 * s} />
      <line className='drop' x1={0} y1={0} x2={0} y2={-FLOAT + 11 * s} />
      <circle className='halo' cx={0} cy={-FLOAT} r={21 * s} />
      <circle
        className='body'
        cx={0}
        cy={-FLOAT}
        r={11.5 * s}
        fill={`url(#${id})`}
      />
      <circle className='reticle' cx={0} cy={-FLOAT} r={R} />
      <g className='slots'>
        {project.modules
          .filter((module) => !moonOf(project, module))
          .map((module) => {
            const sa = slotAngle(module.slot)
            return (
              <line
                key={module.id}
                className='slot'
                x1={(R - 3) * sin(sa)}
                y1={-FLOAT - (R - 3) * cos(sa)}
                x2={(R + 3) * sin(sa)}
                y2={-FLOAT - (R + 3) * cos(sa)}
              />
            )
          })}
      </g>
      <path
        className='lock'
        d={`M${-L} ${-FLOAT - L + 7}V${-FLOAT - L}H${-L + 7}M${L - 7} ${-FLOAT - L}H${L}V${-FLOAT - L + 7}M${L} ${-FLOAT + L - 7}V${-FLOAT + L}H${L - 7}M${-L + 7} ${-FLOAT + L}H${-L}V${-FLOAT + L - 7}`}
      />
    </g>
  )
}

/** Day · time · zone, ticking each half minute from the browser's clock. */
function Clock({ timezone }: { timezone: string }) {
  const read = () => {
    const now = new Date()
    const day = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: timezone,
    }).format(now)
    const time = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(now)
    const zone =
      timezone === 'Asia/Bangkok'
        ? 'BKK'
        : (timezone.split('/').pop() ?? timezone).slice(0, 3).toUpperCase()
    return `${day.replace(',', '').toUpperCase()} · ${time} · ${zone}`
  }
  const [text, setText] = useState(read)
  useEffect(() => {
    const id = window.setInterval(() => setText(read()), 30_000)
    return () => window.clearInterval(id)
  })
  return (
    <span className='ttl' suppressHydrationWarning>
      {text}
    </span>
  )
}
