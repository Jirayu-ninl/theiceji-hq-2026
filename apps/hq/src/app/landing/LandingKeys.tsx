'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/**
 * `↵` on the landing opens sign-in — the key printed on its link. A focused
 * link, button or field keeps its own Enter, and a modified Enter is left to
 * the browser.
 */
export function LandingKeys({ href }: { href: string }) {
  const router = useRouter()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing)
        return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return
      const target = event.target instanceof Element ? event.target : null
      if (
        target?.closest(
          'a, button, input, textarea, select, [contenteditable="true"]',
        )
      )
        return
      event.preventDefault()
      router.push(href)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [router, href])
  return null
}
