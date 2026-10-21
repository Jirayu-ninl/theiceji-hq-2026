import type { LucideIcon } from 'lucide-react'

/**
 * The shape of HQ's navigation, and the path maths every surface does on it.
 *
 * The registry itself lives in `navigation.ts`, but the sidebar, breadcrumbs,
 * tabs and the command menu all ask the same questions of it, and they must
 * answer the same way wherever they are built.
 */

export type Destination = {
  href: string
  label: string
  description: string
  icon: LucideIcon
  /** Active only on this exact path — for a workspace's own landing page. */
  exact?: boolean
  /**
   * Sub-pages. Under a workspace they make the entry a group: the sidebar
   * shows one row that opens the first child, and the children are the tabs
   * across the top of each of them. Under Settings they are its tabs. Either
   * way they are listed in breadcrumbs and the command menu.
   */
  children?: Destination[]
}

export type Workspace = {
  id: string
  label: string
  description: string
  /** Small caps label on the overview card. */
  kind: string
  /** Second line on the overview card. */
  tagline: string
  icon: LucideIcon
  href: string
  /** The sidebar list, in order: pages, and groups of pages. */
  items: Destination[]
  /**
   * The workspace's own settings — the quiet last row of its sidebar list. A
   * group: the current project's settings, then every project.
   */
  settings?: Destination
}

/** A sidebar row over several pages. It opens the first one. */
export function group(
  entry: Omit<Destination, 'href' | 'children'> & {
    children: [Destination, Destination, ...Destination[]]
  },
): Destination {
  return { ...entry, href: entry.children[0].href }
}

export function isCurrentPath(pathname: string, href: string, exact = false) {
  return href === '/' || exact
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`)
}

/** Every page of a workspace: groups opened into their pages, settings last. */
export function pagesOf(workspace: Workspace): Destination[] {
  return [
    ...workspace.items.flatMap((item) => item.children ?? [item]),
    ...(workspace.settings
      ? (workspace.settings.children ?? [workspace.settings])
      : []),
  ]
}

/**
 * How closely the path sits inside a destination: the length of the href it
 * matches through, or -1. A group matches through its pages.
 */
function depth(pathname: string, destination: Destination): number {
  const own = isCurrentPath(pathname, destination.href, destination.exact)
    ? destination.href.length
    : -1
  const inner = (destination.children ?? []).map((child) =>
    depth(pathname, child),
  )
  return Math.max(own, ...inner)
}

/** Whether the path is on a destination or one of its pages. */
export function covers(pathname: string, destination: Destination): boolean {
  return depth(pathname, destination) >= 0
}

/** The most specific destination the path is inside of. */
export function findDestination(
  items: readonly Destination[],
  pathname: string,
): Destination | undefined {
  let found: Destination | undefined
  let best = -1
  for (const item of items) {
    const match = depth(pathname, item)
    if (match > best) {
      best = match
      found = item
    }
  }
  return found
}

/** The group a path is in, when that group has tabs to show. */
export function groupOf(
  workspace: Workspace | undefined,
  pathname: string,
): Destination | undefined {
  if (!workspace) return undefined
  const rows = workspace.settings
    ? [...workspace.items, workspace.settings]
    : workspace.items
  return rows.find(
    (item) => (item.children?.length ?? 0) > 1 && covers(pathname, item),
  )
}
