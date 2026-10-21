'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

/** How long an `again` question waits for its second press. */
const AGAIN_MS = 5000

/**
 * A removal that can't come back asks once, in place: the
 * button becomes the question's two answers. Nothing here is red — nothing
 * leaves HQ. Controlled (`asking` + `onAsking`) when a key opens the
 * question too, so the key and the button take the same path; the answer
 * then has focus, ↵ gives it and Esc keeps the record.
 *
 * The same question guards what leaves HQ: with `again`
 * the button's own key answers as well, so one press asks and the second
 * press does it. Such a question closes on Esc, when focus leaves it, and
 * after a few seconds without an answer (held while the pointer is on it),
 * so a stray key later never sends anything. `tone='release'` keeps the red
 * of the one button that lets something out, on the button and its answer.
 */
export function Confirm({
  label,
  question,
  yes,
  no = 'Keep',
  run,
  small = true,
  kbd,
  tone,
  again = false,
  disabled,
  asking: askingProp,
  onAsking,
}: {
  label: string
  question: string
  yes: string
  /** The answer that changes nothing. */
  no?: string
  run: () => Promise<void>
  small?: boolean
  /** The key printed on the button (`⌫`). */
  kbd?: string
  /** `release`: the red button that lets something leave HQ. */
  tone?: 'release'
  /** The key on the button answers too — pressed twice, it does it. */
  again?: boolean
  disabled?: boolean
  asking?: boolean
  onAsking?: (asking: boolean) => void
}) {
  const [own, setOwn] = useState(false)
  const asking = askingProp ?? own
  const setAsking = (next: boolean) => {
    if (askingProp === undefined) setOwn(next)
    onAsking?.(next)
  }
  const close = useRef(setAsking)
  close.current = setAsking
  const [pending, start] = useTransition()
  const busy = useRef(false)
  busy.current = pending
  const [held, setHeld] = useState(false)
  const answer = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (asking) answer.current?.focus({ preventScroll: true })
    else setHeld(false)
  }, [asking])
  // An unanswered second press lapses: the button comes back as it was.
  useEffect(() => {
    if (!asking || !again || pending || held) return
    const timer = setTimeout(() => close.current(false), AGAIN_MS)
    return () => clearTimeout(timer)
  }, [asking, again, pending, held])
  const cls = `btn${small ? ' btn-sm' : ''}${tone === 'release' ? ' btn-release' : ''}`
  const give = () =>
    start(async () => {
      await run()
      close.current(false)
    })
  if (!asking)
    return (
      <button
        type='button'
        className={cls}
        disabled={disabled}
        onClick={() => setAsking(true)}
      >
        {label}
        {kbd ? <kbd>{kbd}</kbd> : null}
      </button>
    )
  return (
    // biome-ignore lint/a11y/useSemanticElements: two answers to one question, not a form fieldset
    <span
      className='confirm'
      role='group'
      aria-label={question}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          setAsking(false)
          return
        }
        // ↵ and space belong to the focused answer (the browser clicks it);
        // a page key on them would close the question before that click.
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation()
          return
        }
        if (
          again &&
          kbd &&
          event.key === kbd &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          // The second press: the page's own key handler never sees it.
          event.preventDefault()
          event.stopPropagation()
          if (!pending) give()
        }
      }}
      onBlur={(event) => {
        if (!again || busy.current) return
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return
        setAsking(false)
      }}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
    >
      <span className='q'>{question}</span>
      <button
        ref={answer}
        type='button'
        className={cls}
        disabled={pending}
        onClick={give}
      >
        {pending ? 'Working…' : yes}
        {again && kbd && !pending ? <kbd>{kbd}</kbd> : null}
      </button>
      <button
        type='button'
        className={`btn${small ? ' btn-sm' : ''}`}
        disabled={pending}
        onClick={() => setAsking(false)}
      >
        {no}
        {again ? <kbd>Esc</kbd> : null}
      </button>
    </span>
  )
}
