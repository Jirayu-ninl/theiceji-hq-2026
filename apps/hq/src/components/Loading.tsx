/**
 * Something loading: `…`, all at once, no shimmer — then
 * everything appears at once. The label is for screen readers only.
 */
export function Loading({ label }: { label: string }) {
  return (
    <div className='empty loading' aria-busy='true'>
      <span className='sr-only' role='status'>
        {label}
      </span>
      …
    </div>
  )
}
