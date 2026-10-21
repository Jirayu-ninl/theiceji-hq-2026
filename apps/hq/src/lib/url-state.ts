import type { MouseEvent } from 'react'

/**
 * View state that lives in the URL but not on the server: a selection, a
 * filter over rows the page already has. It is written with
 * `history.replaceState` / `pushState`, which Next folds into its router —
 * `useSearchParams` and `usePathname` follow, Back works — without asking
 * the server to render the page again. A `router.replace` of the same URL
 * re-renders the page, and the layout's shell with it after any action, for
 * a change nothing on the server depends on.
 */

/**
 * A left click with no modifier: the view may handle it itself. Anything
 * else (a new tab, a new window, a download) follows the link's `href`.
 */
export function isPlainClick(event: MouseEvent<HTMLElement>): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  )
}
