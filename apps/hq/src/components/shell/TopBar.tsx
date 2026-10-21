'use client'

import { PROJECT_COLORS, type ProjectColor } from '@theiceji/hq-db/enums'
import { useSearchParams } from 'next/navigation'
import { MODULES, type ProjectLite } from '@/modules'
import { BrandMark } from '../BrandMark'
import { type Destination, pageLabel } from '../navigation'
import { Icon } from './Icon'
import type { InspectorControl } from './inspector'
import { NavLink } from './NavLink'
import type { ShellUser } from './Shell'

const moduleLabel = (id: string) =>
  id in MODULES ? MODULES[id as keyof typeof MODULES].label : null

export const projectColor = (color: string) =>
  PROJECT_COLORS[color as ProjectColor] ?? PROJECT_COLORS.grey

/** Whether a view (a real URL, maybe with a query) is the one on screen. */
function isView(view: Destination, pathname: string, search: URLSearchParams) {
  const [path, query = ''] = view.href.split('?')
  if (path !== pathname && !pathname.startsWith(`${path}/`)) return false
  const wanted = new URLSearchParams(query)
  if ([...wanted.keys()].length === 0)
    return view.exact
      ? pathname === path && !search.get('kind') && !search.get('view')
      : true
  return [...wanted.entries()].every(
    ([key, value]) => search.get(key) === value,
  )
}

/**
 * The top bar: brand · `HQ / <project ▾> / <page>` · Go
 * anywhere, then the current surface's views in the middle, then the account,
 * `◆ n`, the inspector's show/hide (⇧I) and the rail toggle. The project
 * crumb is the switcher (⌘P).
 */
export function TopBar({
  user,
  project,
  pathname,
  views,
  waiting,
  onSearch,
  onToggleRail,
  inspector,
}: {
  user: ShellUser
  project: ProjectLite | null
  pathname: string
  views: Destination[]
  waiting: number
  onSearch: () => void
  onToggleRail: () => void
  inspector: InspectorControl
}) {
  const search = useSearchParams()
  const page = pageLabel(pathname, project, moduleLabel)
  const initial = (user.name ?? user.email).trim().charAt(0).toUpperCase()
  return (
    <header className='top'>
      <div className='top-start'>
        <NavLink className='brand' href='/' aria-label='HQ home'>
          <BrandMark />
          <span className='txt'>HQ</span>
        </NavLink>
        <nav className='crumb' aria-label='Breadcrumb'>
          <span className='crumb-sep' aria-hidden='true'>
            /
          </span>
          <button
            type='button'
            className='crumb-proj'
            popoverTarget='project-menu'
            aria-haspopup='menu'
            title='Switch project (⌘P)'
          >
            {project ? (
              <i
                className='dot'
                style={{ ['--project' as string]: projectColor(project.color) }}
                aria-hidden='true'
              />
            ) : null}
            <span
              className='txt'
              lang={
                /\p{Script=Thai}/u.test(project?.name ?? '') ? 'th' : undefined
              }
            >
              {project ? project.name : 'All projects'}
            </span>
            <span className='caret' aria-hidden='true'>
              ▾
            </span>
            <kbd>⌘P</kbd>
          </button>
          <span className='crumb-sep' aria-hidden='true'>
            /
          </span>
          <span className='crumb-page' aria-current='page'>
            {page}
          </span>
        </nav>
        <button type='button' className='search' onClick={onSearch}>
          <Icon name='search' size={15} />
          <span>Go anywhere</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
      {views.length > 0 ? (
        <nav className='views' aria-label='Views'>
          {views.map((view, index) => (
            <NavLink
              key={view.href}
              href={view.href}
              aria-current={isView(view, pathname, search) ? 'page' : undefined}
            >
              <kbd>{index + 1}</kbd>
              {view.label}
            </NavLink>
          ))}
        </nav>
      ) : (
        // Holds the middle column on a wide bar; gone at ≤ 720, where the bar is two columns.
        <span className='views-gap' />
      )}
      <div className='top-end'>
        <button
          type='button'
          className='avatar'
          popoverTarget='account-menu'
          aria-haspopup='menu'
          aria-label={`Account — ${user.name ?? user.email}`}
        >
          {user.image ? (
            <img src={user.image} alt='' referrerPolicy='no-referrer' />
          ) : (
            initial
          )}
        </button>
        <NavLink
          className={`noti${waiting === 0 ? ' zero' : ''}`}
          href='/inbox'
          aria-label={
            waiting === 0
              ? 'Nothing waits for you'
              : `${waiting} waiting for you`
          }
          title='Waiting for you (i)'
        >
          <i
            className={`glyph${waiting > 0 ? ' wait' : ''}`}
            aria-hidden='true'
          >
            ◆
          </i>
          {waiting > 0 ? (
            <span className='n' aria-live='polite'>
              {waiting}
            </span>
          ) : null}
        </NavLink>
        <button
          type='button'
          className='iconbtn insp-toggle'
          aria-pressed={inspector.shown}
          disabled={!inspector.present}
          aria-label={
            inspector.present
              ? `${inspector.shown ? 'Hide' : 'Show'} the inspector (⇧I)`
              : 'This page has no inspector'
          }
          title={
            inspector.present
              ? `${inspector.shown ? 'Hide' : 'Show'} the inspector (⇧I)`
              : 'This page has no inspector'
          }
          onClick={inspector.toggle}
        >
          <Icon name='inspector' />
        </button>
        <button
          type='button'
          className='iconbtn rail-menu'
          aria-label='Show or hide the rail (\)'
          title='Show or hide the rail (\)'
          onClick={onToggleRail}
        >
          <Icon name='menu' />
        </button>
      </div>
    </header>
  )
}
