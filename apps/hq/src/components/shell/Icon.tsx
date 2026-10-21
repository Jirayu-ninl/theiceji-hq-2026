/**
 * The shell's icons — Bridge's own set (24 viewBox,
 * stroke), drawn by `svg.i` in globals.css so they take the text colour. One
 * per HQ page and per module; modules keep their glyphs (▦ ✎ ▣ …) for the matrix, moons and
 * palette.
 */
const PATHS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  notes: 'M5 4h14v10l-6 6H5zM13 20v-6h6',
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z',
  agents: 'M12 3v3M5 8h14v9H5zM9 12h.01M15 12h.01M9 17v3M15 17v3',
  projects: 'M3 6h6l2 2h10v11H3z',
  clients:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.2a6.5 6.5 0 0 1 3.5 5.8',
  data: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  board: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z',
  prompts: 'M4 6l6 6-6 6M12 18h8',
  assets: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4',
  story: 'M4 4h16v16H4zM4 9h16M9 9v11',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  quotes: 'M6 3h9l4 4v14H6zM9 12h6M9 16h6M15 3v4h4',
  publish: 'M12 19V6M6 12l6-6 6 6',
  market: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  experiments: 'M9 3h6M10 3v6L4 20h16l-6-11V3',
  readings: 'M4 19h16M6 15l4-5 3 3 5-7',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  inspector: 'M4 5h16v14H4zM15 5v14',
  chevron: 'M14 6l-6 6 6 6',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  more: 'M4 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M18 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
} as const

export type IconName = keyof typeof PATHS

export const isIconName = (name: string): name is IconName => name in PATHS

export function Icon({ name, size }: { name: IconName; size?: number }) {
  return (
    <svg
      className='i'
      viewBox='0 0 24 24'
      aria-hidden='true'
      style={size ? { width: size, height: size } : undefined}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
