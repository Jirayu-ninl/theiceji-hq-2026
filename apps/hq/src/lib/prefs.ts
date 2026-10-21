/**
 * What the browser remembers. Per-device
 * conveniences only — the theme, the rail, the inspector, pane sizes, Home's
 * view — never anything that must survive a cleared browser or reach another
 * device. Every read and write is wrapped: private windows, blocked storage
 * and previews throw, and a missing or unknown value falls back to the
 * default.
 *
 * The same keys are applied to `<html>` before first paint by `BOOT_SCRIPT`
 * (inlined in app/layout.tsx), so the page never flashes the wrong theme,
 * rail, inspector or pane size. Later these can move to user settings without changing a caller.
 */

export const PREFS = {
  'hq.theme': { values: ['system', 'light', 'dark'], fallback: 'system' },
  'hq.rail': { values: ['open', 'hidden'], fallback: 'open' },
  'hq.rail.width': { values: ['wide', 'narrow'], fallback: 'wide' },
  'hq.home.view': {
    values: ['space', 'state', 'time', 'last'],
    fallback: 'space',
  },
  /** The projection Home showed last — what `hq.home.view: last` opens on. */
  'hq.home.last': { values: ['space', 'state', 'time'], fallback: 'space' },
  'hq.state.browser': { values: ['open', 'closed'], fallback: 'open' },
  /**
   * The inspector beside a page: `hidden` shows it
   * only while it holds something — a record you picked, a form you started;
   * `open` keeps it on screen with nothing picked too.
   */
  'hq.inspector': { values: ['open', 'hidden'], fallback: 'hidden' },
} as const

export type HomeProjection = PrefValue<'hq.home.last'>

/** The projection HQ opens on: `hq.home.view`, with `last` resolved. */
export function openingProjection(): HomeProjection {
  const view = readPref('hq.home.view') ?? 'space'
  return view === 'last' ? (readPref('hq.home.last') ?? 'space') : view
}

/**
 * `openingProjection()` as a cookie, so the server knows it too: `proxy.ts`
 * sends a bare `/` opened fresh straight to `/?view=state|time` instead of
 * rendering Space for `HomeView` to replace — one render instead of two.
 * Written whenever the choice changes and on every page load (`BOOT_SCRIPT`).
 */
export const HOME_COOKIE = 'hq.home.open'

function writeHomeCookie(): void {
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: synchronous and everywhere, like BOOT_SCRIPT's; the Cookie Store API is neither
    document.cookie = `${HOME_COOKIE}=${openingProjection()}; path=/; max-age=31536000; samesite=lax`
  } catch {
    // No cookies here; HomeView still moves to the projection after load.
  }
}

export type PrefKey = keyof typeof PREFS
export type PrefValue<K extends PrefKey> = (typeof PREFS)[K]['values'][number]

export function readPref<K extends PrefKey>(key: K): PrefValue<K> | null {
  try {
    const value = window.localStorage.getItem(key)
    return value && (PREFS[key].values as readonly string[]).includes(value)
      ? (value as PrefValue<K>)
      : null
  } catch {
    return null
  }
}

export function writePref<K extends PrefKey>(
  key: K,
  value: PrefValue<K>,
): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage is unavailable; the choice still applies for this page.
  }
  if (key === 'hq.home.view' || key === 'hq.home.last') writeHomeCookie()
}

/**
 * Home's widget list (`hq.home.widgets`): the ids in order,
 * limited to the ones the page offers. `null` when nothing is stored yet, so
 * the caller shows its defaults.
 */
export function readWidgets(offered: readonly string[]): string[] | null {
  try {
    const raw = window.localStorage.getItem('hq.home.widgets')
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value)
      ? value.filter(
          (id): id is string => typeof id === 'string' && offered.includes(id),
        )
      : null
  } catch {
    return null
  }
}

export function writeWidgets(ids: readonly string[]): void {
  try {
    window.localStorage.setItem('hq.home.widgets', JSON.stringify(ids))
  } catch {
    // Storage is unavailable; the change still applies for this page.
  }
}

/**
 * The widget ids as stored, without Home's catalog to check them against —
 * Settings › Appearance shows what this browser remembers. `null` when
 * nothing is stored (Home shows its defaults) or the value isn't a list.
 */
export function readStoredWidgets(): string[] | null {
  try {
    const raw = window.localStorage.getItem('hq.home.widgets')
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string')
      : null
  } catch {
    return null
  }
}

/** Forget the widget list, so Home shows its default widgets again. */
export function clearWidgets(): void {
  try {
    window.localStorage.removeItem('hq.home.widgets')
  } catch {
    // Storage is unavailable; nothing was stored to forget.
  }
}

/**
 * Pane sizes the owner dragged (`hq.sizes`): px by pane id —
 * `rail`, `console`, `insp-<page>`, `list-<page>` — each applied as
 * `--size-<id>` on `<html>`, which the pane's own CSS reads with its default
 * as the fallback. A pane never dragged has no entry and keeps its default.
 */
const SIZES_KEY = 'hq.sizes'
const SIZE_ID = /^[a-z][a-z0-9-]{0,40}$/
const sizeOk = (id: string, px: unknown): px is number =>
  SIZE_ID.test(id) && typeof px === 'number' && px > 0 && px < 4000

export function readSizes(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(SIZES_KEY) ?? '{}',
    )
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(([id, px]) => sizeOk(id, px)),
    ) as Record<string, number>
  } catch {
    return {}
  }
}

/** Show a size now (`null` = the pane's default); nothing is stored. */
export function applySize(
  id: string,
  px: number | null,
  root: HTMLElement = document.documentElement,
): void {
  if (px === null) root.style.removeProperty(`--size-${id}`)
  else root.style.setProperty(`--size-${id}`, `${Math.round(px)}px`)
}

/** Remember a pane's size (`null` forgets it), and show it. */
export function writeSize(id: string, px: number | null): void {
  applySize(id, px)
  try {
    const sizes = readSizes()
    if (px === null) delete sizes[id]
    else if (sizeOk(id, px)) sizes[id] = Math.round(px)
    window.localStorage.setItem(SIZES_KEY, JSON.stringify(sizes))
  } catch {
    // Storage is unavailable; the size still applies for this page.
  }
}

/** Forget every dragged size, so each pane is back at its default. */
export function clearSizes(): void {
  for (const id of Object.keys(readSizes())) applySize(id, null)
  try {
    window.localStorage.removeItem(SIZES_KEY)
  } catch {
    // Storage is unavailable; nothing was stored to forget.
  }
}

/** The attribute each pref drives on `<html>`, and how. */
export function applyPrefs(root: HTMLElement = document.documentElement): void {
  const theme = readPref('hq.theme') ?? 'system'
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
  const narrowScreen = window.matchMedia('(max-width: 720px)').matches
  const midScreen = window.matchMedia('(max-width: 1100px)').matches
  root.dataset.rail = readPref('hq.rail') ?? (narrowScreen ? 'hidden' : 'open')
  root.dataset.railWidth =
    readPref('hq.rail.width') ?? (midScreen ? 'narrow' : 'wide')
  root.dataset.inspector = readPref('hq.inspector') ?? 'hidden'
  // Drop what is no longer stored (another tab reset it), then apply the rest.
  for (const name of [...root.style])
    if (name.startsWith('--size-')) root.style.removeProperty(name)
  for (const [id, px] of Object.entries(readSizes())) applySize(id, px, root)
}

/**
 * The same as `applyPrefs`, as a string for an inline `<script>` in the
 * document head — it runs before the first paint, before React. Kept in step
 * with `applyPrefs` by hand. It also marks `data-home-open` when HQ opens
 * on a bare `/` whose `hq.home.view` is State or Time, so Space stays
 * hidden until components/home/HomeView.tsx moves to that projection, and
 * writes `HOME_COOKIE` on every load, so the next fresh `/` is redirected by
 * the proxy instead (and a choice made before the cookie existed gets one).
 */
export const BOOT_SCRIPT = `(function(){try{var r=document.documentElement,g=function(k,v){try{var x=localStorage.getItem(k);return v.indexOf(x)>=0?x:null}catch(e){return null}},m=function(q){return window.matchMedia(q).matches};var t=g('hq.theme',['system','light','dark'])||'system';if(t!=='system')r.dataset.theme=t;r.dataset.rail=g('hq.rail',['open','hidden'])||(m('(max-width: 720px)')?'hidden':'open');r.dataset.railWidth=g('hq.rail.width',['wide','narrow'])||(m('(max-width: 1100px)')?'narrow':'wide');r.dataset.inspector=g('hq.inspector',['open','hidden'])||'hidden';try{var s=JSON.parse(localStorage.getItem('hq.sizes')||'{}');for(var k in s){var v=s[k];if(/^[a-z][a-z0-9-]{0,40}$/.test(k)&&typeof v==='number'&&v>0&&v<4000)r.style.setProperty('--size-'+k,Math.round(v)+'px')}}catch(e){}var h=g('hq.home.view',['space','state','time','last']);if(h==='last')h=g('hq.home.last',['space','state','time']);if(h!=='state'&&h!=='time')h='space';document.cookie='${HOME_COOKIE}='+h+'; path=/; max-age=31536000; samesite=lax';if(h!=='space'&&location.pathname==='/'&&!/[?&]view=/.test(location.search))r.dataset.homeOpen=h}catch(e){}})()`
