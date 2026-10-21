'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { isThai } from './bridge/parts'
import { Modal } from './Modal'
import { Icon } from './shell/Icon'

/**
 * The Client field: a combobox over HQ's Clients. Typing
 * finds a client by every word; when none is the one, the list offers
 * "New client “…”" (a modal that adds it to Clients) and "Use “…” once" (a
 * name kept on this card only). What was chosen reads under the field in
 * words — from Clients, used once, or none. Leaving the field without a
 * choice puts the chosen name back.
 */

export type ClientChoice = { id: string | null; name: string }
export type ClientPickerOption = { id: string; name: string; archived: boolean }
export type NewClientFields = {
  name: string
  email?: string
  phone?: string
  taxId?: string
  address?: string
}

type Hit =
  | { kind: 'client'; id: string; name: string }
  | { kind: 'new'; name: string }
  | { kind: 'once'; name: string }

export function ClientPicker({
  value,
  clients,
  counts,
  onChange,
  onCreate,
  label = 'Client',
}: {
  value: ClientChoice | null
  clients: ClientPickerOption[]
  /** Cards per client, for the list's hint. */
  counts?: Record<string, number>
  onChange: (next: ClientChoice | null) => void
  /** Adds a client to Clients; answers it, or the refusal in words. */
  onCreate: (
    fields: NewClientFields,
  ) => Promise<
    { ok: true; client: ClientPickerOption } | { ok: false; error: string }
  >
  label?: string
}) {
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [text, setText] = useState(value?.name ?? '')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [creating, setCreating] = useState<string | null>(null)
  useEffect(() => setText(value?.name ?? ''), [value])

  const hits = useMemo<Hit[]>(() => {
    const query = text.trim()
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const found = clients
      .filter((client) => !client.archived)
      .filter((client) =>
        words.every((word) => client.name.toLowerCase().includes(word)),
      )
      .slice(0, 8)
    const exact = found.some(
      (client) => client.name.toLowerCase() === query.toLowerCase(),
    )
    const out: Hit[] = found.map((client) => ({
      kind: 'client',
      id: client.id,
      name: client.name,
    }))
    if (!query) out.push({ kind: 'new', name: '' })
    else if (!exact)
      out.push({ kind: 'new', name: query }, { kind: 'once', name: query })
    return out
  }, [clients, text])

  // The list sits in the top layer, under the field (above it near the bottom).
  useEffect(() => {
    const popover = list.current
    const field = input.current
    if (!popover || !field) return
    if (!open) {
      if (popover.matches(':popover-open')) popover.hidePopover()
      return
    }
    if (!popover.matches(':popover-open')) popover.showPopover()
    const rect = field.getBoundingClientRect()
    const width = Math.max(rect.width, 260)
    popover.style.width = `${width}px`
    popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
    const below =
      rect.bottom + 4 + popover.offsetHeight < window.innerHeight - 8
    popover.style.top = below ? `${rect.bottom + 4}px` : 'auto'
    popover.style.bottom = below
      ? 'auto'
      : `${window.innerHeight - rect.top + 4}px`
  })

  const close = () => {
    setOpen(false)
    setText(value?.name ?? '')
  }
  const pick = (hit: Hit | undefined) => {
    if (!hit) return
    setOpen(false)
    if (hit.kind === 'client') onChange({ id: hit.id, name: hit.name })
    else if (hit.kind === 'once') onChange({ id: null, name: hit.name })
    else {
      setText(value?.name ?? '')
      setCreating(hit.name)
    }
  }
  const at = Math.min(active, Math.max(0, hits.length - 1))
  const note = !value
    ? 'none — type to find a client, or add one'
    : value.id
      ? `from Clients${counts?.[value.id] ? ` · ${counts[value.id]} ${counts[value.id] === 1 ? 'card' : 'cards'}` : ''}`
      : 'used once — kept on this card, not in Clients'

  return (
    <>
      <span className='combo'>
        <input
          ref={input}
          type='text'
          role='combobox'
          aria-label={label}
          aria-autocomplete='list'
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            open && hits.length ? `${listId}-${at}` : undefined
          }
          placeholder='Type a client…'
          value={text}
          maxLength={160}
          lang={isThai(text) ? 'th' : undefined}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(close, 0)}
          onChange={(event) => {
            setText(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              setOpen(true)
              setActive((n) => Math.min(hits.length - 1, n + 1))
            } else if (event.key === 'ArrowUp')
              setActive((n) => Math.max(0, n - 1))
            else if (event.key === 'Enter' && open) pick(hits[at])
            else if (event.key === 'Escape' && open) {
              event.stopPropagation()
              close()
            } else return
            event.preventDefault()
          }}
        />
        {value ? (
          <button
            type='button'
            className='iconbtn combo-x'
            aria-label='Clear client'
            title='Clear'
            onClick={() => {
              onChange(null)
              input.current?.focus()
            }}
          >
            <Icon name='close' size={12} />
          </button>
        ) : (
          <span className='combo-caret' aria-hidden='true'>
            ▾
          </span>
        )}
      </span>
      <span className='combo-note'>{note}</span>
      <div
        ref={list}
        id={listId}
        popover='manual'
        className='popover combo-pop'
        role='listbox'
        aria-label='Clients'
        // Keep the focus in the field while an option is clicked.
        onMouseDown={(event) => event.preventDefault()}
      >
        <div className='menu-list'>
          {hits.map((hit, index) => (
            <button
              key={`${hit.kind}-${'id' in hit ? hit.id : hit.name}`}
              id={`${listId}-${index}`}
              type='button'
              role='option'
              aria-selected={index === at}
              className={`menu-item${hit.kind === 'new' && index > 0 ? ' sep' : ''}`}
              onClick={() => pick(hit)}
            >
              {hit.kind === 'new' ? (
                <Icon name='plus' size={14} />
              ) : hit.kind === 'once' ? (
                <span className='once-g' aria-hidden='true'>
                  ↺
                </span>
              ) : null}
              <span
                className='label'
                lang={isThai(hit.name) ? 'th' : undefined}
              >
                {hit.kind === 'client'
                  ? hit.name
                  : hit.kind === 'new'
                    ? hit.name
                      ? `New client “${hit.name}”…`
                      : 'New client…'
                    : `Use “${hit.name}” once`}
              </span>
              <span className='sub'>
                {hit.kind === 'client'
                  ? `${counts?.[hit.id] ?? 0} ${(counts?.[hit.id] ?? 0) === 1 ? 'card' : 'cards'}`
                  : hit.kind === 'new'
                    ? 'adds to Clients'
                    : 'this card only'}
              </span>
            </button>
          ))}
        </div>
      </div>
      <Modal
        open={creating !== null}
        title='New client'
        onClose={() => {
          setCreating(null)
          input.current?.focus()
        }}
      >
        <NewClientForm
          name={creating ?? ''}
          onCancel={() => {
            setCreating(null)
            input.current?.focus()
          }}
          onCreate={async (fields) => {
            const result = await onCreate(fields)
            if (!result.ok) return result.error
            setCreating(null)
            onChange({ id: result.client.id, name: result.client.name })
            input.current?.focus()
            return null
          }}
        />
      </Modal>
    </>
  )
}

function NewClientForm({
  name,
  onCancel,
  onCreate,
}: {
  name: string
  onCancel: () => void
  onCreate: (fields: NewClientFields) => Promise<string | null>
}) {
  const [fields, setFields] = useState<NewClientFields>({ name })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const set =
    (key: keyof NewClientFields) => (event: { target: { value: string } }) =>
      setFields((now) => ({ ...now, [key]: event.target.value }))
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
          name: fields.name.trim(),
          email: fields.email?.trim() || undefined,
          phone: fields.phone?.trim() || undefined,
          taxId: fields.taxId?.trim() || undefined,
          address: fields.address?.trim() || undefined,
        })
        setPending(false)
        if (refused) setError(refused)
      }}
    >
      <label>
        Name
        <input
          type='text'
          required
          maxLength={160}
          // biome-ignore lint/a11y/noAutofocus: the modal opens to type the name
          autoFocus
          value={fields.name}
          lang={isThai(fields.name) ? 'th' : undefined}
          onChange={set('name')}
        />
      </label>
      <div className='row'>
        <label style={{ flex: 1 }}>
          Email · optional
          <input
            type='email'
            maxLength={200}
            value={fields.email ?? ''}
            onChange={set('email')}
          />
        </label>
        <label style={{ flex: 1 }}>
          Phone · optional
          <input
            type='text'
            maxLength={60}
            value={fields.phone ?? ''}
            onChange={set('phone')}
          />
        </label>
      </div>
      <label>
        Tax ID · optional
        <input
          type='text'
          className='mono'
          maxLength={40}
          placeholder='13 digits for a Thai company'
          value={fields.taxId ?? ''}
          onChange={set('taxId')}
        />
      </label>
      <label>
        Address · optional
        <textarea
          rows={2}
          maxLength={600}
          value={fields.address ?? ''}
          onChange={set('address')}
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
          disabled={pending || !fields.name.trim()}
        >
          {pending ? 'Adding…' : 'Add client'}
          <kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
      <p className='hint'>
        One record for every project: Board and Quotes pick it by name, and
        Clients adds up what it owes.
      </p>
    </form>
  )
}
