'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { type HomeProjection, openingProjection, writePref } from '@/lib/prefs'

/**
 * Home's projection handoff. HQ opens on the owner's
 * `hq.home.view`. Usually the proxy has already sent a fresh bare `/` there
 * (the `hq.home.open` cookie, lib/prefs.ts). When it couldn't — the first
 * load before the cookie existed — the boot script marks `data-home-open`
 * before first paint (Space stays hidden under it), and this moves there. Only a document load does that — pressing `1`
 * or following Home in the rail always lands on Space. Every projection
 * remembers itself as `hq.home.last`.
 */
export function HomeView({ view }: { view: HomeProjection }) {
  const router = useRouter()
  useEffect(() => {
    writePref('hq.home.last', view)
    const root = document.documentElement
    const opening = root.dataset.homeOpen
    if (!opening) return
    delete root.dataset.homeOpen
    const target = openingProjection()
    if (view === 'space' && target !== 'space')
      router.replace(`/?view=${target}`)
  }, [router, view])
  return null
}
