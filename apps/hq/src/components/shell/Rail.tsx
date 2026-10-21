'use client'

import { applySize, writePref } from '@/lib/prefs'
import type { ShellData } from '@/lib/shell'
import { globalModules, type ModuleId, projectModules } from '@/modules'
import { HQ_NAV, isCurrentPath, SETTINGS } from '../navigation'
import { Icon, type IconName, isIconName } from './Icon'
import { NavLink } from './NavLink'
import { Splitter, storedSize } from './Splitter'
import { projectColor } from './TopBar'

const isThai = (text: string) => /\p{Script=Thai}/u.test(text)

/** The rail's drag: wide 160–360; under 120 it snaps to narrow (48, icons only). */
const RAIL = { narrow: 48, min: 160, max: 360, snap: 120 }

function railWidth(width: 'wide' | 'narrow', done: boolean) {
  const root = document.documentElement
  root.dataset.railWidth = width
  if (done) writePref('hq.rail.width', width)
}

/**
 * The rail edge's size: snap to narrow below 120, else wide at that width.
 * A key step can't cross the gap between 48 and 160 one 16px step at a
 * time, so from narrow it opens wide where it was, and under 160 it closes.
 */
function sizeRail(
  px: number | null,
  done: boolean,
  key = false,
): number | null | undefined {
  if (px === null) {
    railWidth('wide', done)
    applySize('rail', null)
    return null
  }
  if (key) {
    const narrow = document.documentElement.dataset.railWidth === 'narrow'
    if (narrow && px > RAIL.narrow) px = storedSize('rail') ?? 200
    else if (!narrow && px < RAIL.min) px = RAIL.narrow
  }
  if (px < RAIL.snap) {
    railWidth('narrow', done)
    // The wide size stays what it was, for the next time it is wide.
    applySize('rail', storedSize('rail'))
    return undefined
  }
  const size = Math.round(Math.min(Math.max(px, RAIL.min), RAIL.max))
  railWidth('wide', done)
  applySize('rail', size)
  return size
}

const measureRail = () =>
  document.querySelector('.rail')?.getBoundingClientRect().width ?? RAIL.min
const railMax = () => RAIL.max

/** The icon for an HQ-wide page (`/` → home, `/notes` → notes …). */
export function iconFor(href: string): IconName {
  const name = href === '/' ? 'home' : (href.slice(1).split('/')[0] ?? '')
  return isIconName(name) ? name : 'projects'
}

/**
 * The rail: the pages that belong to no project, then the
 * current project with its modules in its kind's order (the global modules
 * when no project is open). Settings and the wide/narrow chevron sit at the foot. The current row
 * carries a `::before` marker — never a one-sided border. Its end edge drags:
 * wide from 160 to 360, and under 120 it snaps to narrow.
 *
 * A module row carries its count from the project's cell (lib/cells.ts):
 * ◆ n when something waits for you there, ▶ when it runs, else its number.
 * On an all-projects page a global module counts what waits across them.
 */
export function Rail({
  pathname,
  project,
  waiting,
  waitingByModule,
  running,
  onToggleWidth,
}: {
  pathname: string
  project: ShellData['projects'][number] | null
  waiting: number
  waitingByModule: ShellData['waiting']['byModule']
  running: number
  onToggleWidth: () => void
}) {
  const current = (href: string, exact?: boolean) =>
    isCurrentPath(pathname, href, exact) ? 'page' : undefined
  const modules = project ? projectModules(project) : globalModules()
  return (
    <nav className='rail' aria-label='Sections'>
      <div className='rail-scroll'>
        <div className='rail-group'>
          {HQ_NAV.map((item) => {
            const count =
              item.href === '/inbox' && waiting > 0
                ? { text: `◆ ${waiting}`, tone: 'wait' }
                : item.href === '/agents' && running > 0
                  ? { text: `▶ ${running}`, tone: 'live' }
                  : null
            return (
              <NavLink
                key={item.href}
                href={item.href}
                aria-current={current(item.href, item.href === '/')}
                title={item.label}
              >
                <Icon name={iconFor(item.href)} />
                <span className='label'>{item.label}</span>
                {count ? (
                  <>
                    <span className={`count ${count.tone}`}>{count.text}</span>
                    <i className={`badge ${count.tone}`} aria-hidden='true' />
                  </>
                ) : null}
              </NavLink>
            )
          })}
        </div>
        <div className='rail-group'>
          {project ? (
            <NavLink
              className='rail-label'
              href={`/p/${project.slug}`}
              aria-current={
                pathname === `/p/${project.slug}` ? 'page' : undefined
              }
              title={`${project.name} — project page`}
            >
              <i
                className='dot'
                style={{ ['--project' as string]: projectColor(project.color) }}
                aria-hidden='true'
              />
              <span
                className='name'
                lang={isThai(project.name) ? 'th' : undefined}
              >
                {project.name}
              </span>
            </NavLink>
          ) : (
            <div className='rail-label'>
              <span className='name'>All projects</span>
            </div>
          )}
          {modules.map((module) => {
            const count = moduleCount(project, module.id, waitingByModule)
            return (
              <NavLink
                key={module.id}
                href={module.href}
                aria-current={current(module.href)}
                title={
                  count?.title
                    ? `${module.label} — ${count.title}`
                    : module.label
                }
              >
                <Icon name={isIconName(module.id) ? module.id : 'projects'} />
                <span className='label'>{module.label}</span>
                {count ? (
                  <>
                    <span className={`count ${count.tone}`}>{count.text}</span>
                    {count.tone ? (
                      <i className={`badge ${count.tone}`} aria-hidden='true' />
                    ) : null}
                  </>
                ) : null}
              </NavLink>
            )
          })}
        </div>
      </div>
      <div className='rail-foot'>
        <NavLink
          className='settings'
          href={SETTINGS.href}
          aria-current={current(SETTINGS.href)}
          title='Settings'
        >
          <Icon name='settings' />
          <span className='label'>Settings</span>
        </NavLink>
        <button
          type='button'
          className='iconbtn rail-toggle'
          aria-label='Wide or narrow rail (⇧\)'
          title='Wide or narrow rail (⇧\)'
          onClick={onToggleWidth}
        >
          <Icon name='chevron' />
        </button>
      </div>
      <Splitter
        id='rail'
        label='Resize the rail'
        edge='end'
        measure={measureRail}
        min={RAIL.narrow}
        max={railMax}
        onSize={sizeRail}
      />
    </nav>
  )
}

/** A module row's count: ◆ n waiting, ▶ running, or the cell's number. */
function moduleCount(
  project: ShellData['projects'][number] | null,
  id: ModuleId,
  waitingByModule: ShellData['waiting']['byModule'],
): { text: string; tone: '' | 'wait' | 'live'; title: string } | null {
  if (!project) {
    const n = waitingByModule[id] ?? 0
    return n ? { text: `◆ ${n}`, tone: 'wait', title: `${n} waiting` } : null
  }
  const cell = project.cells[id]
  if (!cell) return null
  if (cell.state === 'wait' && cell.unit === 'connection')
    return { text: '◆', tone: 'wait', title: cell.sub ?? 'reconnect' }
  if (cell.state === 'wait') {
    const n = Math.max(1, project.waitingBy[id] ?? 0)
    return { text: `◆ ${n}`, tone: 'wait', title: `${n} waiting for you` }
  }
  if (cell.state === 'live') {
    const n = typeof cell.value === 'number' && cell.value > 0 ? cell.value : 1
    return {
      text: `▶ ${n}`,
      tone: 'live',
      title: `${n} ${cell.unit ?? 'running'}`,
    }
  }
  if (typeof cell.value !== 'number') return null
  return {
    text: String(cell.value),
    tone: '',
    title: `${cell.value} ${cell.unit ?? ''}`.trim(),
  }
}
