'use client'

import { useState, useTransition } from 'react'
import { disconnectGoogleAction } from './actions'

/**
 * Disconnect asks once, in words, before it acts: it stops Drive storage and
 * calendar sync for every project that uses them.
 */
export function DisconnectGoogle() {
  const [pending, start] = useTransition()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!confirming)
    return (
      <button type='button' className='btn' onClick={() => setConfirming(true)}>
        Disconnect
      </button>
    )
  return (
    <>
      <button
        type='button'
        className='btn'
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await disconnectGoogleAction()
            if (!result.ok) setError(result.error)
          })
        }
      >
        {pending ? 'Disconnecting…' : 'Yes, disconnect'}
      </button>
      <button
        type='button'
        className='btn'
        onClick={() => setConfirming(false)}
      >
        Keep it
      </button>
      <span className='st wait' role='status'>
        {error ?? 'Drive storage and calendar sync stop for every project.'}
      </span>
    </>
  )
}
