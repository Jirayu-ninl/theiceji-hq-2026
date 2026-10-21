'use client'

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'

/**
 * Toast + Undo: every action on a record ends in one line,
 * centred above the footer, for six seconds — with Undo when the action has
 * an inverse. Undo runs the inverse action (move back, unmark paid,
 * restore); it never pretends the first action didn't happen.
 *
 * One toast at a time: a new one replaces the last. `role="status"` so a
 * screen reader hears it without the focus moving.
 */

type ToastInput = {
  message: string
  /** The inverse action; the toast shows Undo while it waits. */
  undo?: () => void | Promise<void>
}

type ToastApi = (
  message: string,
  options?: { undo?: ToastInput['undo'] },
) => void

const ToastContext = createContext<ToastApi>(() => {})

export const useToast = () => useContext(ToastContext)

const SHOW_MS = 6000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastInput & { id: number }) | null>(null)
  const [undoing, setUndoing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const serial = useRef(0)

  const show = useCallback<ToastApi>((message, options = {}) => {
    if (timer.current) clearTimeout(timer.current)
    const id = ++serial.current
    setUndoing(false)
    setToast({ id, message, undo: options.undo })
    timer.current = setTimeout(() => {
      setToast((current) => (current?.id === id ? null : current))
    }, SHOW_MS)
  }, [])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const undo = async () => {
    if (!toast?.undo || undoing) return
    const { id } = toast
    setUndoing(true)
    try {
      await toast.undo()
      // Only this toast goes: one the inverse raised (its error, its own
      // "Restored") stays up.
      setToast((current) => (current?.id === id ? null : current))
    } finally {
      setUndoing(false)
    }
  }

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className='toast' role='status' aria-live='polite' hidden={!toast}>
        {toast ? (
          <>
            <span
              lang={/\p{Script=Thai}/u.test(toast.message) ? 'th' : undefined}
            >
              {toast.message}
            </span>
            {toast.undo ? (
              <button
                type='button'
                className='undo'
                onClick={undo}
                disabled={undoing}
              >
                {undoing ? 'Undoing…' : 'Undo'}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </ToastContext.Provider>
  )
}
