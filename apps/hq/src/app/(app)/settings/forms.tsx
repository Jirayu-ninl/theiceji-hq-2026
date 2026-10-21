'use client'

import {
  type FormEvent,
  type ReactNode,
  useRef,
  useState,
  useTransition,
} from 'react'
import { SETTINGS_TABS } from '@/components/navigation'
import { type KeyHint, usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import type { FormResult } from './parts'

/**
 * The client half of Settings: a group card that is itself a form, the
 * inline "are you sure" every irreversible row action asks, the tab's keys
 * and a copy button. Every form ends in the footer bar: the action, then a
 * status line that says what happened in words.
 */

const clock = () =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date())

/**
 * A group card that posts its fields to a Settings action. Field errors come
 * back by input name; the children render them where they belong.
 */
export function GroupForm({
  id,
  title,
  description,
  action,
  submit,
  saveKey = false,
  resetOnSuccess = false,
  idle = 'unsaved changes are kept until you save',
  children,
}: {
  id: string
  title: ReactNode
  description?: ReactNode
  action: (data: FormData) => Promise<FormResult>
  submit: string
  /** Print and answer `s` — one form per tab carries it. */
  saveKey?: boolean
  resetOnSuccess?: boolean
  /** The status line before anything was saved. */
  idle?: string
  children: (errors: Record<string, string>) => ReactNode
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<string | null>(null)

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    start(async () => {
      const result = await action(data)
      if (!result.ok) {
        setError(result.error)
        setErrors(result.fields ?? {})
        return
      }
      setError(null)
      setErrors({})
      if (result.redirect) {
        window.location.assign(result.redirect)
        return
      }
      if (resetOnSuccess) form.reset()
      setSaved(clock())
      toast(result.message ?? 'Saved.')
    })
  }

  return (
    <form
      className='group'
      id={id}
      aria-labelledby={`${id}-h`}
      onSubmit={onSubmit}
      noValidate
    >
      <header className='group-head'>
        <h2 id={`${id}-h`}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </header>
      <div className='group-body'>{children(errors)}</div>
      <footer className='group-foot'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={pending}
          data-key={saveKey ? 's' : undefined}
        >
          {pending ? 'Saving…' : submit}
          {saveKey ? <kbd>s</kbd> : null}
        </button>
        <span
          className={`st${error ? ' wait' : saved ? ' saved' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {error ?? (saved ? `saved ${saved}` : idle)}
        </span>
      </footer>
    </form>
  )
}

/** The error for one field, under its input. */
export function FieldError({ id, error }: { id: string; error?: string }) {
  return error ? (
    <p className='hint wait' id={id}>
      {error}
    </p>
  ) : null
}

/** A row action that can't be undone asks once, in place — the one shared `Confirm`. */
export { Confirm } from '@/components/Confirm'

/**
 * The tab's keys in the footer and under `?`. The digits
 * are the shell's — it maps them to the top bar's views — and SettingsBody
 * answers a tab's own key by pressing the element that prints it.
 */
export function TabKeys({ keys = [] }: { keys?: KeyHint[] }) {
  usePageKeyHints([[`1–${SETTINGS_TABS.length}`, 'tabs'], ...keys])
  return null
}

/** Copies a value; the value stays on screen when the clipboard is blocked. */
export function CopyButton({
  value,
  label = 'Copy',
}: {
  value: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  return (
    <button
      type='button'
      className='btn btn-sm'
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1600)
        } catch {
          // Clipboard blocked (insecure origin, permissions) — the value is on screen.
        }
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  )
}
