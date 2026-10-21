import {
  Bot,
  Cloud,
  Database,
  HardDrive,
  House,
  Inbox,
  LayoutGrid,
  Palette,
  PlugZap,
  Server,
  Settings,
  ShieldCheck,
  StickyNote,
  UserRound,
  Users,
} from 'lucide-react'
import {
  type Destination,
  findDestination,
  isCurrentPath,
  type Workspace,
} from './nav-shape'

/**
 * HQ's own registry. The shape and the path maths live in `nav-shape.ts`;
 * what is listed here is the registry itself.
 */

export {
  covers,
  findDestination,
  group,
  groupOf,
  isCurrentPath,
  pagesOf,
} from './nav-shape'
export type { Destination, Workspace }

export const HOME: Destination = {
  href: '/',
  label: 'Overview',
  description: 'Your personal command center',
  icon: House,
}

/**
 * The scratchpad. It belongs to no project on purpose, so it sits in the
 * rail's top group — and is reachable from every page by the capture overlay,
 * which needs no route at all.
 */
export const NOTES: Destination = {
  href: '/notes',
  label: 'Notes',
  description: 'Ideas parked before they have a home',
  icon: StickyNote,
}

/**
 * Opens Notes with the New note form already up — the link version of `c`,
 * for the places that can only offer an href (the PWA manifest's shortcut).
 */
export const NOTE_CAPTURE_HREF = '/notes?new=1'

/** HQ-wide destinations that belong to no single project. */
export const SYSTEM: Destination[] = [
  {
    href: '/data',
    label: 'Data',
    description: 'Everything you have recorded, out as CSV or JSON',
    icon: Database,
  },
]

/**
 * Account and HQ settings — reached from the gear at the rail's foot and the
 * account menu, and in breadcrumbs and the palette. The tabs are the top
 * bar's views, in this order; System is the
 * readiness view `/api/ready` shares, kept last. The old
 * Profile, Security, Sessions and Notifications tabs live on in Account, and
 * their URLs redirect there.
 */
export const SETTINGS: Destination = {
  href: '/settings',
  label: 'Settings',
  description:
    'Account, appearance, storage, Google, connections, policies and system status',
  icon: Settings,
  children: [
    {
      href: '/settings/account',
      label: 'Account',
      description: 'Profile, email, password, sessions and push devices',
      icon: UserRound,
    },
    {
      href: '/settings/appearance',
      label: 'Appearance',
      description: 'Theme, rail and what Home opens on, in this browser',
      icon: Palette,
    },
    {
      href: '/settings/storage',
      label: 'Storage',
      description: 'Where new files go, and what each project keeps',
      icon: HardDrive,
    },
    {
      href: '/settings/google',
      label: 'Google',
      description: 'The one Google connection: Drive storage and Calendar',
      icon: Cloud,
    },
    {
      href: '/settings/connections',
      label: 'Connections',
      description: 'Apps and agents over MCP, tokens and providers',
      icon: PlugZap,
    },
    {
      href: '/settings/policies',
      label: 'Policies',
      description: 'What agents may do, budgets, releases and kill switches',
      icon: ShieldCheck,
    },
    {
      href: '/settings/system',
      label: 'System',
      description: 'Version, environment and integrations',
      icon: Server,
    },
  ],
}

/** The tabs of `/settings` — its layout, breadcrumbs and the command menu. */
export const SETTINGS_TABS: Destination[] = SETTINGS.children ?? []

/* ── Bridge: one app of projects × modules ──
 *
 * The rail's top group belongs to no project; the middle group is the current
 * project's modules (or the global modules on an all-projects page).
 */

export const INBOX: Destination = {
  href: '/inbox',
  label: 'Inbox',
  description: 'Everything waiting for you: requests, proposals, problems',
  icon: Inbox,
  children: [
    {
      href: '/inbox',
      label: 'All',
      description: 'Everything waiting',
      icon: Inbox,
      exact: true,
    },
    {
      href: '/inbox?kind=requests',
      label: 'Requests',
      description: 'Questions from agents',
      icon: Inbox,
    },
    {
      href: '/inbox?kind=proposals',
      label: 'Proposals',
      description: 'What agents propose',
      icon: Inbox,
    },
    {
      href: '/inbox?kind=problems',
      label: 'Problems',
      description: 'Connections that need you',
      icon: Inbox,
    },
  ],
}

export const AGENTS: Destination = {
  href: '/agents',
  label: 'Agents',
  description: 'Routines, runs and what they cost',
  icon: Bot,
}

export const PROJECTS: Destination = {
  href: '/projects',
  label: 'Projects',
  description: 'Every project: create, open, pause, archive',
  icon: LayoutGrid,
  children: [
    {
      href: '/projects',
      label: 'Active',
      description: 'Projects in use',
      icon: LayoutGrid,
      exact: true,
    },
    {
      href: '/projects?view=archived',
      label: 'Archived',
      description: 'Projects put away',
      icon: LayoutGrid,
    },
    {
      href: '/projects?view=trash',
      label: 'Trash',
      description: 'Deleted projects — restore any time',
      icon: LayoutGrid,
    },
  ],
}

/**
 * Who the work is for: one record per client for all of HQ,
 * which Board cards and Quotes both point at — so it belongs to no project.
 */
export const CLIENTS: Destination = {
  href: '/clients',
  label: 'Clients',
  description: 'Who the work is for, across every project',
  icon: Users,
  children: [
    {
      href: '/clients',
      label: 'Active',
      description: 'Clients you work with',
      icon: Users,
      exact: true,
    },
    {
      href: '/clients?view=archived',
      label: 'Archived',
      description: 'Clients put away',
      icon: Users,
    },
  ],
}

export const DATA: Destination = SYSTEM[0] as Destination

/** The rail's top group: pages that belong to no project. */
export const HQ_NAV: Destination[] = [
  { ...HOME, label: 'Home' },
  NOTES,
  INBOX,
  AGENTS,
  PROJECTS,
  CLIENTS,
  DATA,
]

/** The project slug a path is inside (`/p/<slug>/…`), or null on an HQ-wide page. */
export function projectSlugAt(pathname: string): string | null {
  const match = /^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/|$)/.exec(pathname)
  return match?.[1] ?? null
}

/** The module a project path is on (`/p/<slug>/<module>`), if any. */
export function projectModuleAt(pathname: string): string | null {
  return /^\/p\/[a-z0-9-]+\/([a-z_]+)(?:\/|$)/.exec(pathname)?.[1] ?? null
}

type ProjectCrumb = { slug: string; name: string }

/**
 * The page part of the breadcrumb (`HQ / <project ▾> / <page>`): the module
 * or page the path is on, in words.
 */
export function pageLabel(
  pathname: string,
  project: ProjectCrumb | null,
  moduleLabel: (id: string) => string | null,
): string {
  if (project) {
    const module = projectModuleAt(pathname)
    return module ? (moduleLabel(module) ?? 'Module') : 'Project'
  }
  const hq = findDestination([...HQ_NAV, SETTINGS], pathname)
  if (hq === SETTINGS) {
    const tab = findDestination(SETTINGS_TABS, pathname)
    return tab ? `Settings · ${tab.label}` : 'Settings'
  }
  if (hq) return hq.label
  if (isCurrentPath(pathname, '/dashboard')) return 'Readings'
  const module = /^\/([a-z_]+)(?:\/|$)/.exec(pathname)?.[1]
  return (module && moduleLabel(module)) ?? 'HQ'
}

/**
 * The views in the middle of the top bar for a path — real destinations, so
 * a view is a URL and the back button works.
 */
export function viewsFor(pathname: string): Destination[] {
  if (pathname === HOME.href) return HOME_VIEWS
  const project = /^\/p\/([a-z0-9-]+)$/.exec(pathname)
  if (project) return moduleViews(pathname, 'project', false)
  if (isCurrentPath(pathname, SETTINGS.href)) return SETTINGS_TABS
  if (isCurrentPath(pathname, INBOX.href)) return INBOX.children ?? []
  if (isCurrentPath(pathname, PROJECTS.href)) return PROJECTS.children ?? []
  if (isCurrentPath(pathname, CLIENTS.href)) return CLIENTS.children ?? []
  if (isCurrentPath(pathname, NOTES.href))
    return moduleViews('/notes', 'notes', false)
  const inProject = /^\/p\/([a-z0-9-]+)\/([a-z_]+)$/.exec(pathname)
  if (inProject?.[2]) return moduleViews(pathname, inProject[2], false)
  const global = /^\/([a-z_]+)$/.exec(pathname)
  if (global?.[1]) return moduleViews(pathname, global[1], true)
  return []
}

/**
 * A module page's own views, first one the default. The
 * all-projects board is a table only: lanes need one project. A view with
 * its own `href` is a link to another page. Archived and Trash come last
 * wherever a module has them: what was put away, and what
 * was deleted and can still be restored.
 */
const MODULE_VIEWS: Record<
  string,
  { key: string; label: string; global?: boolean; href?: string }[]
> = {
  board: [
    { key: '', label: 'Lanes', global: false },
    { key: 'table', label: 'Table' },
    { key: 'archived', label: 'Archived' },
    { key: 'trash', label: 'Trash' },
  ],
  prompts: [
    { key: '', label: 'Grid' },
    { key: 'list', label: 'List' },
    // The library of variants: HQ-wide, the same on every project.
    { key: 'library', label: 'Variants' },
    { key: 'archived', label: 'Archived' },
    { key: 'trash', label: 'Trash' },
  ],
  assets: [
    { key: '', label: 'Grid' },
    { key: 'list', label: 'List' },
    { key: 'collections', label: 'Collections' },
  ],
  calendar: [
    { key: '', label: 'Week' },
    { key: 'month', label: 'Month' },
  ],
  // Clients is its own page in the rail; a Quotes view that left the
  // project for it was a trap (pressing 2 jumped out of the project).
  quotes: [{ key: '', label: 'Quotes' }],
  story: [
    { key: '', label: 'Script' },
    { key: 'characters', label: 'Characters' },
    { key: 'shots', label: 'Shots' },
  ],
  publish: [
    { key: '', label: 'Posts' },
    { key: 'accounts', label: 'Accounts' },
  ],
  market: [
    { key: '', label: 'Listings' },
    { key: 'products', label: 'Products' },
    { key: 'money', label: 'Money' },
  ],
  experiments: [
    { key: '', label: 'Experiments' },
    { key: 'learnings', label: 'Learnings' },
  ],
  readings: [
    { key: '', label: 'Money' },
    { key: 'items', label: 'Posts & listings' },
  ],
  agents: [
    { key: '', label: 'Routines' },
    { key: 'runs', label: 'Runs' },
    { key: 'trash', label: 'Trash' },
  ],
  dashboard: [
    { key: '', label: 'Money' },
    { key: 'items', label: 'Posts & listings' },
  ],
  notes: [
    { key: '', label: 'Board' },
    { key: 'list', label: 'List' },
    { key: 'archive', label: 'Archived' },
    { key: 'trash', label: 'Trash' },
  ],
  // `/p/<slug>` itself: the pipeline map, or the table.
  project: [
    { key: '', label: 'Map' },
    { key: 'modules', label: 'Modules' },
  ],
}

/**
 * Home's three projections: one overview, three questions —
 * what is where, what state everything is in, when things happen. `/` with
 * no view opens on the owner's `hq.home.view` (components/home/HomeView.tsx).
 */
export const HOME_VIEWS: Destination[] = [
  {
    href: '/',
    label: 'Space',
    description: 'What is where, and what needs you',
    icon: House,
    exact: true,
  },
  {
    href: '/?view=state',
    label: 'State',
    description: 'Every project by every module',
    icon: LayoutGrid,
  },
  {
    href: '/?view=time',
    label: 'Time',
    description: 'This week: what happens, what moves, what is late',
    icon: LayoutGrid,
  },
]

function moduleViews(
  base: string,
  module: string,
  global: boolean,
): Destination[] {
  const views = (MODULE_VIEWS[module] ?? []).filter(
    (view) => !global || view.global !== false,
  )
  if (views.length < 2) return []
  return views.map((view, index) => ({
    // The first view is the page itself: `/board` opens on its table, so its
    // Table view is `/board`, never `/board?view=table`.
    href:
      view.href ?? (index > 0 && view.key ? `${base}?view=${view.key}` : base),
    label: view.label,
    description: `${view.label} view`,
    icon: LayoutGrid,
    ...(index === 0 ? { exact: true } : {}),
  }))
}
