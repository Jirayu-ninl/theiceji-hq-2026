'use client'

import type { ProjectLite } from '@/modules'
import { isCurrentPath } from '../navigation'
import { Icon } from './Icon'
import { NavLink } from './NavLink'
import { projectColor } from './TopBar'

/**
 * The rail on a phone (≤ 720): five tabs docked to the viewport's bottom —
 * Home · Inbox ◆ · Notes · project ▾ · More. Docked to the bottom edge, so the
 * active marker sits on each tab's top edge.
 */
export function BottomBar({
  pathname,
  project,
  waiting,
}: {
  pathname: string
  project: ProjectLite | null
  waiting: number
}) {
  const current = (href: string) =>
    isCurrentPath(pathname, href, href === '/') ? 'page' : undefined
  return (
    <nav className='bottombar' aria-label='Sections'>
      <NavLink href='/' aria-current={current('/')}>
        <Icon name='home' />
        Home
      </NavLink>
      <NavLink
        href='/inbox'
        aria-current={current('/inbox')}
        aria-label={`Inbox — ${waiting} waiting`}
      >
        <Icon name='inbox' />
        Inbox
        {waiting > 0 ? <span className='n'>◆{waiting}</span> : null}
      </NavLink>
      <NavLink href='/notes' aria-current={current('/notes')}>
        <Icon name='notes' />
        Notes
      </NavLink>
      <button
        type='button'
        popoverTarget='project-menu'
        aria-haspopup='menu'
        aria-current={project ? 'page' : undefined}
      >
        {project ? (
          <i
            className='dot'
            style={{
              ['--project' as string]: projectColor(project.color),
              width: 10,
              height: 10,
            }}
            aria-hidden='true'
          />
        ) : (
          <Icon name='projects' />
        )}
        {project ? 'Project ▾' : 'Projects ▾'}
      </button>
      <button type='button' popoverTarget='more-sheet' aria-haspopup='dialog'>
        <Icon name='menu' />
        More
      </button>
    </nav>
  )
}
