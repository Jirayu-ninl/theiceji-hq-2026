'use client'

import { PROJECT_COLOR_NAMES, PROJECT_COLORS } from '@theiceji/hq-db/enums'

/**
 * The fixed swatch list as a picker: each swatch on its own
 * tint, the chosen one ringed in accent. A card's colour uses it with "no
 * colour" first; a project's colour picks from the same list.
 */
export function Swatches({
  value,
  onChange,
  label,
  allowNone = false,
}: {
  value: string | null
  onChange: (next: string | null) => void
  label: string
  allowNone?: boolean
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a swatch picker is a group of toggle buttons, not a fieldset
    <div className='swatches' role='group' aria-label={label}>
      {allowNone ? (
        <button
          type='button'
          className='none'
          aria-pressed={value === null}
          aria-label='No colour'
          title='No colour'
          onClick={() => onChange(null)}
        />
      ) : null}
      {PROJECT_COLOR_NAMES.map((name) => (
        <button
          key={name}
          type='button'
          aria-pressed={value === name}
          aria-label={`Colour ${name}`}
          title={name}
          style={{ ['--project' as string]: PROJECT_COLORS[name] }}
          onClick={() => onChange(name)}
        >
          <i className='dot' />
        </button>
      ))}
    </div>
  )
}
