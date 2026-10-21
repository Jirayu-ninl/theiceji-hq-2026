'use client'

import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Dot, isThai } from '@/components/bridge/parts'
import { Modal } from '@/components/Modal'
import { Icon } from '@/components/shell/Icon'
import { type PromptChoice, promptChoicesAction } from '../actions'

/**
 * The prompt a job ran on: a popover over every prompt the
 * owner has — this project's, other projects', the library's — found by
 * every word, plus "Write a new prompt…", a modal that saves it to Prompts
 * (this project when it has Prompts on, else the library) and links it.
 */

export type NewPromptFields = {
  title: string
  medium: 'image' | 'video' | 'text' | 'audio'
  text: string
  providerHint?: string
}

export function PromptPicker({
  children,
  className = 'btn btn-sm',
  triggerId,
  home,
  onPick,
  onCreate,
}: {
  children: ReactNode
  className?: string
  /** An id for the button, so a page key can open the picker. */
  triggerId?: string
  /** Where a new prompt is saved, in words ("งานลูกค้า" or "the library"). */
  home: string
  onPick: (choice: PromptChoice) => void
  onCreate: (fields: NewPromptFields) => Promise<string | null>
}) {
  const id = useId()
  const popover = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [choices, setChoices] = useState<PromptChoice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    const timer = setTimeout(
      async () => {
        const result = await promptChoicesAction({ query })
        if (!alive) return
        if (result.ok) {
          setChoices(result.data)
          setError(null)
        } else setError(result.error)
      },
      query ? 200 : 0,
    )
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [open, query])

  const show = () => {
    const panel = popover.current
    const anchor = trigger.current
    if (!panel || !anchor) return
    panel.showPopover()
    const rect = anchor.getBoundingClientRect()
    const width = Math.min(380, window.innerWidth - 16)
    panel.style.width = `${width}px`
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
    if (rect.top > window.innerHeight / 2) {
      panel.style.top = 'auto'
      panel.style.bottom = `${window.innerHeight - rect.top + 6}px`
    } else {
      panel.style.bottom = 'auto'
      panel.style.top = `${rect.bottom + 6}px`
    }
    search.current?.focus()
  }

  return (
    <>
      <button
        ref={trigger}
        id={triggerId}
        type='button'
        className={className}
        aria-haspopup='dialog'
        aria-controls={id}
        onClick={show}
      >
        {children}
      </button>
      <div
        ref={popover}
        id={id}
        popover='auto'
        className='popover picker'
        role='dialog'
        aria-label='Link a prompt'
        onToggle={(event) =>
          setOpen((event as unknown as ToggleEvent).newState === 'open')
        }
      >
        <div className='picker-q'>
          <input
            ref={search}
            type='search'
            placeholder='Find a prompt — every word'
            aria-label='Find a prompt'
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                popover.current
                  ?.querySelector<HTMLElement>('.menu-list .menu-item')
                  ?.focus()
              }
            }}
          />
        </div>
        <div
          className='menu-list'
          role='listbox'
          aria-label='Prompts'
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                '.menu-item',
              ),
            ]
            const at = items.indexOf(document.activeElement as HTMLElement)
            event.preventDefault()
            if (event.key === 'ArrowUp' && at <= 0) search.current?.focus()
            else
              items[
                event.key === 'ArrowDown'
                  ? Math.min(items.length - 1, at + 1)
                  : at - 1
              ]?.focus()
          }}
        >
          {error ? (
            <p className='empty'>{error}</p>
          ) : choices === null ? (
            <p className='empty loading'>…</p>
          ) : choices.length === 0 ? (
            <p className='empty'>
              {query ? `No prompt matches “${query}”.` : '○ no prompts yet'}
            </p>
          ) : (
            choices.map((choice) => (
              <button
                key={choice.promptId}
                type='button'
                role='option'
                aria-selected='false'
                className='menu-item'
                onClick={() => {
                  popover.current?.hidePopover()
                  onPick(choice)
                }}
              >
                {choice.project ? (
                  <Dot color={choice.project.color} />
                ) : (
                  <i className='dot' aria-hidden='true' />
                )}
                <span
                  className='label'
                  lang={isThai(choice.title) ? 'th' : undefined}
                >
                  {choice.title}
                </span>
                <span className='sub'>
                  {choice.medium}
                  {choice.slots.length
                    ? ` · ${choice.slots.length} ${choice.slots.length === 1 ? 'variant' : 'variants'}`
                    : ''}{' '}
                  · {choice.project?.name ?? 'library'}
                </span>
              </button>
            ))
          )}
        </div>
        <div className='picker-foot'>
          <button
            type='button'
            className='menu-item'
            onClick={() => {
              popover.current?.hidePopover()
              setWriting(true)
            }}
          >
            <Icon name='plus' size={14} />
            <span className='label'>Write a new prompt…</span>
            <span className='sub'>{home}</span>
          </button>
        </div>
      </div>
      <Modal
        open={writing}
        title='New prompt'
        onClose={() => {
          setWriting(false)
          trigger.current?.focus()
        }}
      >
        <NewPromptForm
          home={home}
          onCancel={() => {
            setWriting(false)
            trigger.current?.focus()
          }}
          onCreate={async (fields) => {
            const refused = await onCreate(fields)
            if (!refused) setWriting(false)
            return refused
          }}
        />
      </Modal>
    </>
  )
}

function NewPromptForm({
  home,
  onCancel,
  onCreate,
}: {
  home: string
  onCancel: () => void
  onCreate: (fields: NewPromptFields) => Promise<string | null>
}) {
  const [title, setTitle] = useState('')
  const [medium, setMedium] = useState<NewPromptFields['medium']>('image')
  const [hint, setHint] = useState('manual')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  return (
    <form
      className='fcard'
      autoComplete='off'
      onSubmit={async (event) => {
        event.preventDefault()
        event.stopPropagation()
        setPending(true)
        setError(null)
        const refused = await onCreate({
          title: title.trim(),
          medium,
          text: text.trim(),
          providerHint: hint,
        })
        setPending(false)
        if (refused) setError(refused)
      }}
    >
      <label>
        Title
        <input
          type='text'
          required
          maxLength={160}
          // biome-ignore lint/a11y/noAutofocus: the modal opens to name the prompt
          autoFocus
          placeholder='Menu illustration · Thai dessert'
          value={title}
          lang={isThai(title) ? 'th' : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <div className='row'>
        <label style={{ flex: 1 }}>
          Medium
          <select
            value={medium}
            onChange={(event) =>
              setMedium(event.target.value as NewPromptFields['medium'])
            }
          >
            <option value='image'>image</option>
            <option value='video'>video</option>
            <option value='text'>text</option>
            <option value='audio'>audio</option>
          </select>
        </label>
        <label style={{ flex: 1 }}>
          Written for
          <select
            value={hint}
            onChange={(event) => setHint(event.target.value)}
          >
            <option value='manual'>manual</option>
            <option value='external:openai_compatible'>
              external:openai_compatible
            </option>
          </select>
        </label>
      </div>
      <label>
        Prompt · variant A
        <textarea
          className='mono'
          rows={5}
          required
          maxLength={20000}
          placeholder='What you type into the generator…'
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      {error ? (
        <p className='err' role='alert'>
          {error}
        </p>
      ) : null}
      <div className='row'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={pending || !title.trim() || !text.trim()}
        >
          {pending ? 'Saving…' : 'Save and link'}
          <kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
      <p className='hint'>
        Saved to Prompts in {home}, so the next job can reuse it.
      </p>
    </form>
  )
}
