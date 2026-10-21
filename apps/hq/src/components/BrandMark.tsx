/**
 * HQ's mark: the Viewfinder. It uses the four corner marks
 * of a Bridge screen, framing one amber core, "you are here". Drawn on the
 * icon set's 24 grid so it sits beside the rail's icons. The ink is
 * `currentColor` and the core is `--accent`, so it follows either mode.
 * The owner picked it on 2026-09-27. The app icons,
 * favicon and link preview come from the same masters.
 */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      className='brand-mark'
      viewBox='0 0 24 24'
      width={size}
      height={size}
      aria-hidden='true'
      focusable='false'
    >
      <path d='M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5' />
      <circle className='brand-core' cx='12' cy='12' r='3.2' />
    </svg>
  )
}
