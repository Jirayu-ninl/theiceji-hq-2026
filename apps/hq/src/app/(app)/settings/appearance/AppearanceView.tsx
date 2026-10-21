'use client'

import { useEffect, useState } from 'react'
import { setPinned } from '@/components/shell/inspector'
import { useToast } from '@/components/Toast'
import {
  clearSizes,
  clearWidgets,
  type PrefValue,
  readPref,
  readSizes,
  readStoredWidgets,
  writePref,
  writeSize,
  writeWidgets,
} from '@/lib/prefs'
import { Bar, Fld, Group, StateWord } from '../parts'

/**
 * Settings › Appearance: the `hq.*` preferences the
 * shell reads, written through `lib/prefs.ts` and applied to `<html>` at once
 * — the same attributes the boot script sets before paint, so a reload shows
 * the same thing. Per browser, never per account.
 *
 * The page watches `<html>` too: `\`, `⇧\`, `⇧I`, a dragged pane edge or
 * the account menu's theme change the same attributes, and the controls here
 * follow them.
 */

type Theme = PrefValue<'hq.theme'>
type Rail = PrefValue<'hq.rail'>
type Width = PrefValue<'hq.rail.width'>
type Inspect = PrefValue<'hq.inspector'>
type HomeView = PrefValue<'hq.home.view'>

type Now = {
  theme: Theme
  rail: Rail
  width: Width
  inspector: Inspect
  /** How many panes were dragged away from their default size. */
  sizes: number
  home: HomeView
  widgets: string[] | null
}

/** What `<html>` and storage say right now. */
function read(): Now {
  const root = document.documentElement
  return {
    theme: readPref('hq.theme') ?? 'system',
    rail: root.dataset.rail === 'hidden' ? 'hidden' : 'open',
    width: root.dataset.railWidth === 'narrow' ? 'narrow' : 'wide',
    inspector: root.dataset.inspector === 'open' ? 'open' : 'hidden',
    sizes: Object.keys(readSizes()).length,
    home: readPref('hq.home.view') ?? 'space',
    widgets: readStoredWidgets(),
  }
}

const HOME_VIEWS: [HomeView, string, boolean][] = [
  ['space', 'Space — projects in orbit', true],
  ['state', 'State — the matrix', true],
  ['time', 'Time — this week', true],
  ['last', 'Last used', true],
]

/** A segmented control: a group of toggle buttons, one pressed. */
function Seg<T extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string
  value: T | null
  options: [T, string][]
  onPick: (value: T) => void
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons, not a fieldset
    <span className='seg' role='group' aria-label={label}>
      {options.map(([option, text]) => (
        <button
          key={option}
          type='button'
          aria-pressed={value === option}
          onClick={() => onPick(option)}
        >
          {text}
        </button>
      ))}
    </span>
  )
}

export function AppearanceView() {
  const toast = useToast()
  // The server can't know this browser's prefs: `…` until it hydrates, then everything at once.
  const [now, setNow] = useState<Now | null>(null)

  useEffect(() => {
    setNow(read())
    const observer = new MutationObserver(() => setNow(read()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        'data-theme',
        'data-rail',
        'data-rail-width',
        'data-inspector',
        'style',
      ],
    })
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith('hq.')) setNow(read())
    }
    window.addEventListener('storage', onStorage)
    return () => {
      observer.disconnect()
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const root = () => document.documentElement

  const setTheme = (theme: Theme) => {
    if (theme === 'system') delete root().dataset.theme
    else root().dataset.theme = theme
    writePref('hq.theme', theme)
    setNow(read())
  }
  const setRail = (rail: Rail) => {
    root().dataset.rail = rail
    writePref('hq.rail', rail)
    setNow(read())
  }
  const setWidth = (width: Width) => {
    root().dataset.railWidth = width
    writePref('hq.rail.width', width)
    setNow(read())
  }
  const setInspector = (inspector: Inspect) => {
    setPinned(inspector === 'open')
    setNow(read())
  }
  const resetSizes = () => {
    const before = readSizes()
    if (Object.keys(before).length === 0) return
    clearSizes()
    setNow(read())
    toast('Every pane is back at its default size', {
      undo: () => {
        for (const [id, px] of Object.entries(before)) writeSize(id, px)
        setNow(read())
      },
    })
  }
  const setHome = (home: HomeView) => {
    writePref('hq.home.view', home)
    setNow(read())
    toast(`Home opens on ${home}`)
  }
  const resetWidgets = () => {
    const before = readStoredWidgets()
    if (!before) return
    clearWidgets()
    setNow(read())
    toast('Widgets reset to Home’s default', {
      undo: () => {
        writeWidgets(before)
        setNow(read())
      },
    })
  }

  const dots = '…'
  return (
    <>
      <Bar
        items={[
          ['appearance', 'applies at once'],
          ['theme', now?.theme ?? dots],
          ['rail', now ? `${now.rail} · ${now.width}` : dots],
          ['inspector', now?.inspector ?? dots],
          [
            'sizes',
            now ? (now.sizes ? `${now.sizes} dragged` : 'default') : dots,
          ],
          ['home', now?.home ?? dots],
          [
            'widgets',
            now ? (now.widgets ? now.widgets.length : 'default') : dots,
          ],
        ]}
      />
      <Group
        id='theme'
        title='Theme'
        description='Two modes, one material: light is a grey instrument body with black screens set into it; dark makes the whole frame a screen.'
        foot={<span className='st'>applies at once · hq.theme</span>}
      >
        <Fld
          label='Mode'
          sub='System follows the operating system. Also in the account menu.'
        >
          <Seg
            label='Theme'
            value={now?.theme ?? null}
            options={[
              ['system', 'System'],
              ['light', 'Light'],
              ['dark', 'Dark'],
            ]}
            onPick={setTheme}
          />
        </Fld>
      </Group>
      <Group
        id='rail'
        title='Rail'
        description='The left rail lists HQ’s pages and the current project’s modules. At 720px and under it becomes the bottom bar.'
        foot={
          <span className='st'>applies at once · hq.rail · hq.rail.width</span>
        }
      >
        <Fld
          label='Show'
          sub={
            <>
              Also <kbd>\</kbd>.
            </>
          }
        >
          <Seg
            label='Rail'
            value={now?.rail ?? null}
            options={[
              ['open', 'Open'],
              ['hidden', 'Hidden'],
            ]}
            onPick={setRail}
          />
        </Fld>
        <Fld
          label='Width'
          sub={
            <>
              Also <kbd>⇧\</kbd>. Narrow keeps the icons and a dot for ◆ and ▶.
            </>
          }
        >
          <Seg
            label='Rail width'
            value={now?.width ?? null}
            options={[
              ['wide', 'Wide'],
              ['narrow', 'Narrow'],
            ]}
            onPick={setWidth}
          />
        </Fld>
      </Group>
      <Group
        id='layout'
        title='Inspector and pane sizes'
        description='The inspector is the panel on the right of a page that holds what you picked. Every pane edge — the rail’s, an inspector’s, a list’s, the console’s — drags; double-click one for its default.'
        foot={
          <span className='st'>applies at once · hq.inspector · hq.sizes</span>
        }
      >
        <Fld
          label='Inspector'
          sub={
            <>
              Also <kbd>⇧I</kbd> and the top bar’s button. “When I pick” opens
              it for a record you pick, and ✕ or Esc closes it; “Always” keeps
              it on screen with nothing picked.
            </>
          }
        >
          <Seg
            label='Inspector'
            value={now?.inspector ?? null}
            options={[
              ['hidden', 'When I pick'],
              ['open', 'Always'],
            ]}
            onPick={setInspector}
          />
        </Fld>
        <Fld
          label='Pane sizes'
          sub='What this browser remembers of your drags.'
        >
          {now === null ? (
            <span className='loading'>…</span>
          ) : (
            <StateWord>
              {now.sizes
                ? `${now.sizes} ${now.sizes === 1 ? 'pane' : 'panes'} dragged`
                : 'every pane at its default'}
            </StateWord>
          )}
          <button
            type='button'
            className='btn btn-sm'
            disabled={!now?.sizes}
            onClick={resetSizes}
          >
            Reset to default
          </button>
        </Fld>
      </Group>
      <Group
        id='home'
        title='Home'
        description='Home is one overview with three projections: Space, State and Time. HQ opens on the one chosen here; 1 2 3 switch between them.'
        foot={
          <span className='st'>
            applies at once · hq.home.view · hq.home.widgets
          </span>
        }
      >
        <Fld label='Opens on' htmlFor='home-view'>
          <select
            id='home-view'
            value={now?.home ?? 'space'}
            disabled={!now}
            onChange={(event) => setHome(event.target.value as HomeView)}
          >
            {HOME_VIEWS.map(([value, label, built]) => (
              <option key={value} value={value} disabled={!built}>
                {label}
              </option>
            ))}
          </select>
        </Fld>
        <Fld label='Widgets' sub='Add and remove them on Space with ＋ and ×.'>
          {now === null ? (
            <span className='loading'>…</span>
          ) : now.widgets === null ? (
            <StateWord>Home’s default widgets</StateWord>
          ) : now.widgets.length === 0 ? (
            <StateWord>○ none</StateWord>
          ) : (
            <span className='mods'>
              {now.widgets.map((id) => (
                <span key={id} className='chip'>
                  {id.replace('.', ' · ')}
                </span>
              ))}
            </span>
          )}
          <button
            type='button'
            className='btn btn-sm'
            disabled={!now?.widgets}
            onClick={resetWidgets}
          >
            Reset to default
          </button>
        </Fld>
      </Group>
      <Group id='motion' title='Motion and density'>
        <Fld
          label='Motion'
          sub='Follows the system’s reduce-motion setting; there is no separate switch.'
        >
          <StateWord>system</StateWord>
        </Fld>
        <Fld
          label='Density'
          sub='Fixed: 13px text, rows 28–32px, 44px targets on touch.'
        >
          <StateWord>13px</StateWord>
        </Fld>
      </Group>
    </>
  )
}
