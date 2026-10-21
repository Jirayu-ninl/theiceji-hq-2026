'use client'

import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './shell/Icon'

/**
 * A modal: a native `<dialog>` for a
 * small record made without leaving the form you are in — New client from a
 * card's Client field, New prompt from its prompt picker — and the pool's
 * dashed first tile: Notes' New note, Prompts' New prompt. It is never a
 * substitute for the inspector: a page's own forms stay in form cards.
 *
 * The popover material (panel, `--line-2` edge, `--r4`, the one shadow),
 * centred over a dimmed page; at ≤ 720 it is a sheet from the bottom. The
 * browser gives Esc, the focus trap and focus return; while it is open the
 * page's own keys are off (`typing` sees the open dialog). It renders into
 * `body`, so its form never sits inside the form that opened it; events
 * still reach React parents, so its submit and keys stop here.
 *
 * It opens on the form's field, not on ✕: React's `autoFocus` runs while the
 * dialog is still closed, so once it is open the field marked
 * `data-autofocus` takes focus, else the form's first field.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => setHost(document.body), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dialog exists only once the portal has its host
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      const field =
        dialog.querySelector<HTMLElement>('[data-autofocus]') ??
        dialog.querySelector<HTMLElement>('input, textarea, select')
      field?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open, host])
  if (!host) return null
  return createPortal(
    <dialog
      ref={ref}
      className='modal'
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onSubmit={(event) => event.stopPropagation()}
    >
      <header className='pane-head'>
        <span className='hud-label'>{title}</span>
        <button
          type='button'
          className='iconbtn'
          aria-label='Close (Esc)'
          title='Close (Esc)'
          onClick={onClose}
        >
          <Icon name='close' size={14} />
        </button>
      </header>
      {open ? children : null}
    </dialog>,
    host,
  )
}
