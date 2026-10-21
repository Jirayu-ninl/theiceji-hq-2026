import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_MODULES, PROJECT_MODULES } from '@theiceji/hq-core/modules'
import {
  HQ_NAV,
  NOTE_CAPTURE_HREF,
  NOTES,
  pageLabel,
  projectModuleAt,
  projectSlugAt,
  SETTINGS_TABS,
  viewsFor,
} from '../src/components/navigation'
import {
  globalModules,
  MODULE_UI,
  type ProjectLite,
  projectModules,
} from '../src/modules'

/**
 * HQ's navigation after the cutover: the rail's
 * HQ-wide rows, a project's modules in its kind's order, the global module
 * routes, breadcrumbs and the top bar's views — and nothing left of the
 * Creator and Merchant workspaces but redirects.
 */

const APP = join(import.meta.dir, '../src/app/(app)')
const SRC = join(import.meta.dir, '../src')

const freelance: ProjectLite = {
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'client-work',
  name: 'Client work',
  kind: 'freelance',
  status: 'active',
  color: 'pink',
  modules: { enabled: [...DEFAULT_MODULES.freelance] },
}

describe('HQ-wide rows', () => {
  test('every HQ row and every Settings tab has a page behind it', () => {
    for (const entry of [...HQ_NAV, ...SETTINGS_TABS]) {
      const path = entry.href.split('?')[0] ?? ''
      const file =
        path === '/' ? join(APP, 'page.tsx') : join(APP, path, 'page.tsx')
      expect(existsSync(file), entry.href).toBeTrue()
    }
  })

  test('the rail’s top group is Home · Notes · Inbox · Agents · Projects · Clients · Data', () => {
    expect(HQ_NAV.map((entry) => entry.label)).toEqual([
      'Home',
      'Notes',
      'Inbox',
      'Agents',
      'Projects',
      'Clients',
      'Data',
    ])
    expect(HQ_NAV).toContain(NOTES)
  })

  // A client is one record for all of HQ, so Clients is a
  // top-group page of its own. Quotes' old Clients view linked out of the
  // project (pressing 2 left it), so since 2026-09-29 Quotes has no views.
  test('Clients has Active · Archived, and Quotes has no view that leaves it', () => {
    expect(viewsFor('/clients').map((view) => view.href)).toEqual([
      '/clients',
      '/clients?view=archived',
    ])
    expect(viewsFor('/quotes')).toEqual([])
    expect(viewsFor('/p/client-work/quotes')).toEqual([])
    expect(pageLabel('/clients', null, () => null)).toBe('Clients')
  })

  // Archived and Trash are a page's last views.
  test('Archived and Trash come last where a page has them', () => {
    expect(viewsFor('/p/client-work/board').map((view) => view.href)).toEqual([
      '/p/client-work/board',
      '/p/client-work/board?view=table',
      '/p/client-work/board?view=archived',
      '/p/client-work/board?view=trash',
    ])
    // Lanes need one project; the all-projects board starts on its table,
    // which is the page itself.
    expect(viewsFor('/board').map((view) => view.href)).toEqual([
      '/board',
      '/board?view=archived',
      '/board?view=trash',
    ])
    // Variants is the library of variants, before what was put away.
    expect(viewsFor('/prompts').map((view) => view.label)).toEqual([
      'Grid',
      'List',
      'Variants',
      'Archived',
      'Trash',
    ])
    expect(viewsFor('/notes').map((view) => view.label)).toEqual([
      'Board',
      'List',
      'Archived',
      'Trash',
    ])
  })

  test('the capture link opens the board with a blank note', () => {
    expect(NOTE_CAPTURE_HREF.startsWith(`${NOTES.href}?`)).toBeTrue()
    // The board reads `?new=1`; it is the whole contract between them.
    expect(new URL(NOTE_CAPTURE_HREF, 'http://x').searchParams.get('new')).toBe(
      '1',
    )
    const manifest = readFileSync(
      join(import.meta.dir, '../public/manifest.webmanifest'),
      'utf8',
    )
    expect(manifest).toContain(`"url": "${NOTE_CAPTURE_HREF}"`)
  })
})

describe('Bridge navigation', () => {
  // Settings is one Bridge document per tab, in the designed
  // order with System kept last; the tabs it replaced still answer, as
  // redirects into Account, so old links and bookmarks keep working.
  test('Settings has the Bridge tabs in order, and the old tabs redirect', () => {
    expect(SETTINGS_TABS.map((tab) => tab.label)).toEqual([
      'Account',
      'Appearance',
      'Storage',
      'Google',
      'Connections',
      'Policies',
      'System',
    ])
    const settings = (...path: string[]) =>
      readFileSync(join(APP, 'settings', ...path), 'utf8')
    expect(settings('page.tsx')).toContain("redirect('/settings/account')")
    for (const old of ['profile', 'security', 'sessions', 'notifications'])
      expect(settings(old, 'page.tsx'), old).toContain(
        "permanentRedirect('/settings/account",
      )
    expect(settings('SettingsBody.tsx')).not.toContain('legacy')
  })

  test('every project module has a rail row, and every global module a route', () => {
    for (const id of PROJECT_MODULES) {
      const project = { ...freelance, modules: { enabled: [id] } }
      const rows = projectModules(project)
      expect(rows.map((row) => row.href)).toEqual([`/p/client-work/${id}`])
    }
    expect(existsSync(join(APP, 'p/[project]/[module]/page.tsx'))).toBeTrue()
    expect(existsSync(join(APP, '[module]/page.tsx'))).toBeTrue()
    expect(globalModules().map((row) => row.href)).toEqual([
      '/board',
      '/prompts',
      '/assets',
      '/calendar',
      '/quotes',
    ])
  })

  // Every module is built: none is a "arrives with Phase n"
  // placeholder any more, and each has its own page inside a project.
  test('every module is built and has its own project page', () => {
    for (const id of PROJECT_MODULES) {
      expect(MODULE_UI[id].ready, id).toBeTrue()
      expect(
        existsSync(join(APP, 'p/[project]', id, 'page.tsx')),
        id,
      ).toBeTrue()
    }
    for (const row of globalModules())
      expect(existsSync(join(APP, row.href, 'page.tsx')), row.href).toBeTrue()
    expect(existsSync(join(APP, 'agents/page.tsx'))).toBeTrue()
    expect(existsSync(join(APP, 'dashboard/page.tsx'))).toBeTrue()
  })

  test('a module that is off never shows in the rail', () => {
    const rows = projectModules(freelance).map((row) => row.id)
    expect(rows).toEqual(['board', 'calendar', 'quotes', 'assets'])
    expect(rows).not.toContain('publish')
    expect(rows).not.toContain('story')
  })

  test('no href appears twice across the rail, settings and the palette', () => {
    const hrefs = [
      ...HQ_NAV.map((entry) => entry.href),
      ...SETTINGS_TABS.map((entry) => entry.href),
      ...projectModules(freelance).map((entry) => entry.href),
      ...globalModules().map((entry) => entry.href),
    ]
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  test('breadcrumbs for /p/<slug>/… name the project and the page', () => {
    expect(projectSlugAt('/p/client-work')).toBe('client-work')
    expect(projectSlugAt('/p/client-work/board')).toBe('client-work')
    expect(projectSlugAt('/projects')).toBeNull()
    expect(projectSlugAt('/p/Bad_Slug')).toBeNull()
    expect(projectModuleAt('/p/client-work/quotes')).toBe('quotes')
    const label = (id: string) =>
      id === 'quotes' ? 'Quotes' : id === 'agents' ? 'Agents' : null
    expect(pageLabel('/p/client-work', freelance, label)).toBe('Project')
    expect(pageLabel('/p/client-work/quotes', freelance, label)).toBe('Quotes')
    expect(pageLabel('/p/client-work/agents', freelance, label)).toBe('Agents')
    expect(pageLabel('/inbox', null, label)).toBe('Inbox')
    expect(pageLabel('/agents', null, label)).toBe('Agents')
    expect(pageLabel('/data', null, label)).toBe('Data')
    expect(pageLabel('/settings/google', null, label)).toBe('Settings · Google')
    expect(pageLabel('/settings/policies', null, label)).toBe(
      'Settings · Policies',
    )
    expect(pageLabel('/', null, label)).toBe('Home')
  })

  test('views are real URLs for the surfaces that have them', () => {
    expect(viewsFor('/inbox').map((view) => view.href)).toEqual([
      '/inbox',
      '/inbox?kind=requests',
      '/inbox?kind=proposals',
      '/inbox?kind=problems',
    ])
    expect(viewsFor('/settings/google')).toBe(SETTINGS_TABS)
    expect(viewsFor('/settings/account')).toBe(SETTINGS_TABS)
    expect(viewsFor('/projects').map((view) => view.href)).toEqual([
      '/projects',
      '/projects?view=archived',
      '/projects?view=trash',
    ])
    expect(viewsFor('/agents').map((view) => view.href)).toEqual([
      '/agents',
      '/agents?view=runs',
      '/agents?view=trash',
    ])
    expect(viewsFor('/p/client-work/agents').map((view) => view.label)).toEqual(
      ['Routines', 'Runs', 'Trash'],
    )
    expect(viewsFor('/p/client-work').map((view) => view.href)).toEqual([
      '/p/client-work',
      '/p/client-work?view=modules',
    ])
    expect(viewsFor('/').map((view) => view.href)).toEqual([
      '/',
      '/?view=state',
      '/?view=time',
    ])
    expect(viewsFor('/').map((view) => view.label)).toEqual([
      'Space',
      'State',
      'Time',
    ])
  })
})

describe('the cutover', () => {
  test('the Creator and Merchant pages are gone, and their URLs go to /projects', () => {
    for (const legacy of ['creator', 'merchant']) {
      expect(existsSync(join(APP, legacy)), legacy).toBeFalse()
      expect(existsSync(join(SRC, 'app/api', legacy)), legacy).toBeFalse()
    }
    const config = readFileSync(
      join(import.meta.dir, '../next.config.ts'),
      'utf8',
    )
    for (const source of [
      '/creator',
      '/creator/:path*',
      '/merchant',
      '/merchant/:path*',
    ])
      expect(config, source).toContain(
        `{ source: '${source}', destination: '/projects', permanent: true }`,
      )
  })

  test('nothing in the app imports the retired packages', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(name)) {
          const text = readFileSync(path, 'utf8')
          if (/@theiceji\/(creator|merchant)\b/.test(text)) offenders.push(path)
        }
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })
})
