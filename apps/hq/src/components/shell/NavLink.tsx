'use client'

import Link from 'next/link'
import { type ComponentProps, useState } from 'react'

/**
 * A link of the Bridge frame (rail, top bar, bottom bar, menus, footer). Next prefetches every `<Link>` that scrolls into view, and
 * the frame shows twenty-odd at once — each page load fired a burst of
 * prefetches for pages the owner mostly doesn't open next. This one waits
 * for intent: the pointer arriving, focus, or a touch starts the prefetch,
 * still ahead of the click, so the page's `…` comes at once — and only for
 * the page you are about to open (the pattern in Next's prefetching guide).
 */
export function NavLink({
  onMouseEnter,
  onFocus,
  onTouchStart,
  ...props
}: Omit<ComponentProps<typeof Link>, 'prefetch'>) {
  const [wanted, setWanted] = useState(false)
  return (
    <Link
      {...props}
      prefetch={wanted ? null : false}
      onMouseEnter={(event) => {
        setWanted(true)
        onMouseEnter?.(event)
      }}
      onFocus={(event) => {
        setWanted(true)
        onFocus?.(event)
      }}
      onTouchStart={(event) => {
        setWanted(true)
        onTouchStart?.(event)
      }}
    />
  )
}
