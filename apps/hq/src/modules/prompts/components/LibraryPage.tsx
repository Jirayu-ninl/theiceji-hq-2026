'use client'

import { slotName } from '@theiceji/hq-prompts/template'
import { useEffect, useRef, useState, useTransition } from 'react'
import { MoreMenu } from '@/components/bridge/MoreMenu'
import {
  Empty,
  Inspector,
  InspectorHead,
  isThai,
  PaneHead,
  usePageKeys,
} from '@/components/bridge/parts'
import { Confirm } from '@/components/Confirm'
import { Icon } from '@/components/shell/Icon'
import { usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import { deleteLibrarySlotAction, saveLibrarySlotAction } from '../actions'
import type { LibrarySlotData } from '../data'

/**
 * Prompts › Variants — the library: a variant here is
 * HQ-wide, and every prompt that writes `<NAME>` offers its options (a
 * prompt may add its own, or replace one by key). The pool is a table —
 * name, the keys, how many prompts write it; the inspector reads one and
 * edits it in one form card (`e`). New variant `c`. Delete `⌫` asks in
 * place: the options go, and examples lose the picks of them.
 */

export function LibraryPage({ slots: first }: { slots: LibrarySlotData[] }) {
  const toast = useToast()
  const [slots, setSlots] = useState(first)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null)
  const [asking, setAsking] = useState(false)
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const row = slots.find((slot) => slot.id === selected) ?? null
  const words = query.trim().toLowerCase()
  const shown = slots.filter((slot) =>
    `${slot.name} ${slot.note} ${slot.options.map((option) => option.key).join(' ')}`
      .toLowerCase()
      .includes(words),
  )
  const pick = (id: string | null) => {
    setSelected(id)
    setEditing(null)
    setAsking(false)
  }
  const saved = (next: LibrarySlotData, made: boolean) => {
    setSlots((all) =>
      all.some((slot) => slot.id === next.id)
        ? all.map((slot) => (slot.id === next.id ? next : slot))
        : [...all, next],
    )
    pick(next.id)
    toast(
      made
        ? `${next.name} is in the library`
        : `Saved ${next.name} in the library`,
    )
  }

  usePageKeyHints([
    ['c', 'new variant'],
    ['e', 'edit'],
    ['⌫', 'delete'],
    ['↑ ↓', 'variants'],
    ['/', 'search'],
    ['1–5', 'views'],
  ])
  usePageKeys((key) => {
    if (key === '/') {
      search.current?.focus()
      search.current?.select()
      return true
    }
    if (key === 'Escape') {
      if (editing || asking) {
        setEditing(null)
        setAsking(false)
        return true
      }
      if (selected) {
        pick(null)
        return true
      }
      return false
    }
    if (key === 'c') {
      pick(null)
      setEditing('new')
      return true
    }
    const index = shown.findIndex((slot) => slot.id === selected)
    if (['ArrowDown', 'j'].includes(key)) {
      const next = shown[Math.min(shown.length - 1, index + 1)]
      if (next) pick(next.id)
      return Boolean(next)
    }
    if (['ArrowUp', 'k'].includes(key)) {
      const next = shown[Math.max(0, index - 1)]
      if (next) pick(next.id)
      return Boolean(next)
    }
    if (!row) return false
    if (key === 'e') {
      setEditing('edit')
      return true
    }
    if (key === 'Backspace' || key === 'Delete') {
      setAsking(true)
      return true
    }
    return false
  })

  return (
    <div className='page promptsp'>
      <section className='pane pool-pane' aria-label='Variants'>
        <PaneHead
          title='Prompts · Variants'
          meta={`${slots.length} in the library · every prompt that writes <NAME> offers its options`}
        />
        <div className='toolbar'>
          <input
            ref={search}
            type='search'
            aria-label='Search variants by name or key'
            placeholder='Search name or key… (/)'
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                if (query) setQuery('')
                else event.currentTarget.blur()
              }
            }}
          />
          <span className='sp' />
          <span className='hits'>
            {shown.length} of {slots.length}
          </span>
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => {
              pick(null)
              setEditing('new')
            }}
          >
            ＋ New variant<kbd>c</kbd>
          </button>
        </div>
        <div className='pane-body'>
          {slots.length === 0 ? (
            <Empty>
              ○ nothing in the library yet — a variant here is offered by every
              prompt that writes its name. New variant (c).
            </Empty>
          ) : shown.length === 0 ? (
            <Empty>No variant matches.</Empty>
          ) : (
            <div className='tbl libtbl' role='listbox' aria-label='Variants'>
              <div className='tbl-head' aria-hidden='true'>
                <span className='hud-label'>variant</span>
                <span className='hud-label'>options</span>
                <span className='hud-label nn'>used by</span>
              </div>
              {shown.map((slot) => (
                <button
                  key={slot.id}
                  type='button'
                  role='option'
                  aria-selected={slot.id === selected}
                  data-id={slot.id}
                  className={`tbl-row${slot.id === selected ? ' sel' : ''}`}
                  onClick={() => pick(slot.id)}
                >
                  <span className='t libname'>&lt;{slot.name}&gt;</span>
                  <span className='dim'>
                    {slot.options.map((option) => option.key).join(' · ') ||
                      '—'}
                  </span>
                  <span className='dim nn'>
                    {slot.usedBy} {slot.usedBy === 1 ? 'prompt' : 'prompts'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
      <Inspector
        id='prompts'
        label='Variant'
        empty={!row && editing !== 'new'}
        onClose={() => pick(null)}
      >
        {editing === 'new' ? (
          <>
            <InspectorHead
              title='New variant'
              meta='library'
              onClose={() => setEditing(null)}
            />
            <div className='insp-body'>
              <SlotForm
                slot={null}
                onCancel={() => setEditing(null)}
                onSaved={(next) => saved(next, true)}
              />
            </div>
          </>
        ) : !row ? (
          <>
            <InspectorHead title='Variant' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>
                {slots.length
                  ? 'Select a variant to read or change its options.'
                  : 'New variant (c) puts one in the library.'}
              </Empty>
            </div>
          </>
        ) : (
          <>
            <InspectorHead
              title='Variant'
              meta={`library · ${row.usedBy} ${row.usedBy === 1 ? 'prompt' : 'prompts'}`}
              onClose={() => pick(null)}
            >
              <MoreMenu
                id='library-more'
                label={`${row.name} — more`}
                items={[
                  {
                    label: 'Edit',
                    kbd: 'e',
                    onSelect: () => setEditing('edit'),
                  },
                  {
                    label: 'Delete from the library…',
                    kbd: '⌫',
                    onSelect: () => setAsking(true),
                  },
                ]}
              />
            </InspectorHead>
            <div className='insp-body'>
              <div className='dev-read'>
                <div className='readout'>
                  <div className='big note'>&lt;{row.name}&gt;</div>
                  <div className='sub'>
                    {row.options.length}{' '}
                    {row.options.length === 1 ? 'option' : 'options'} · written
                    by {row.usedBy} {row.usedBy === 1 ? 'prompt' : 'prompts'}
                  </div>
                </div>
              </div>
              <div className='dev-main'>
                {asking ? (
                  // Its options can't come back: it asks in place.
                  <Confirm
                    label='Delete'
                    question={`Delete ${row.name} from the library? ${row.usedBy === 0 ? 'No prompt writes it.' : `${row.usedBy === 1 ? 'The prompt that writes it keeps' : `The ${row.usedBy} prompts that write it keep`} only their own options; examples lose these picks.`}`}
                    yes='Delete'
                    asking
                    onAsking={setAsking}
                    run={async () => {
                      const result = await deleteLibrarySlotAction({
                        slotId: row.id,
                        expectedRevision: row.revision,
                      })
                      if (!result.ok) return toast(result.error)
                      setSlots((all) =>
                        all.filter((slot) => slot.id !== row.id),
                      )
                      pick(null)
                      toast(`Deleted ${row.name} from the library`)
                    }}
                  />
                ) : null}
                {editing === 'edit' ? (
                  <SlotForm
                    key={row.id}
                    slot={row}
                    onCancel={() => setEditing(null)}
                    onSaved={(next) => saved(next, false)}
                  />
                ) : (
                  <>
                    {row.note ? (
                      <p
                        className='dev-p'
                        lang={isThai(row.note) ? 'th' : undefined}
                      >
                        {row.note}
                      </p>
                    ) : null}
                    <section className='sect' aria-label='Options'>
                      <div className='dev-h'>
                        <span className='hud-label'>
                          Options · {row.options.length}
                        </span>
                        <button
                          type='button'
                          className='btn btn-sm'
                          title='Edit (e)'
                          aria-keyshortcuts='e'
                          onClick={() => setEditing('edit')}
                        >
                          Edit
                        </button>
                      </div>
                      {row.options.length ? (
                        <div className='vlist'>
                          {row.options.map((option) => (
                            <div key={option.id} className='vrow'>
                              <span className='vrow-key'>{option.key}</span>
                              <span
                                className='vrow-val'
                                lang={isThai(option.value) ? 'th' : undefined}
                              >
                                {option.value || '∅ nothing'}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Empty>No options yet — Edit adds them.</Empty>
                      )}
                    </section>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

/** A library variant in one form card: its name, what it's for, its options (the whole set). */
function SlotForm({
  slot,
  onCancel,
  onSaved,
}: {
  slot: LibrarySlotData | null
  onCancel: () => void
  onSaved: (slot: LibrarySlotData) => void
}) {
  const [name, setName] = useState(slot?.name ?? '')
  const [note, setNote] = useState(slot?.note ?? '')
  const [rows, setRows] = useState<
    { id?: string; key: string; value: string }[]
  >(slot?.options.length ? slot.options : [{ key: '', value: '' }])
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  const change = (index: number, patch: { key?: string; value?: string }) =>
    setRows((all) =>
      all.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)),
    )
  return (
    <form
      className='fcard optform'
      aria-label={slot ? `Edit ${slot.name}` : 'New variant'}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          event.currentTarget.requestSubmit()
        }
      }}
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        start(async () => {
          const result = await saveLibrarySlotAction({
            ...(slot ? { id: slot.id, expectedRevision: slot.revision } : {}),
            name: slotName(name),
            note,
            options: rows
              .filter((row) => row.key.trim())
              .map((row) =>
                row.id
                  ? { id: row.id, key: row.key, value: row.value }
                  : { key: row.key, value: row.value },
              ),
          })
          if (result.ok) onSaved(result.data)
          else setError(result.error)
        })
      }}
    >
      <label>
        Name — written in a text as &lt;{slotName(name) || 'NAME'}&gt;
        <input
          type='text'
          required
          maxLength={40}
          value={name}
          placeholder='HAIR_COLOR'
          ref={first}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {slot && slotName(name) !== slot.name ? (
        <p className='hint'>
          Prompts that write &lt;{slot.name}&gt; stop offering these options
          until their text says &lt;{slotName(name) || 'NAME'}&gt;.
        </p>
      ) : null}
      <label>
        What it’s for
        <input
          type='text'
          maxLength={300}
          value={note}
          placeholder='A character’s hair, for every character sheet'
          lang={isThai(note) ? 'th' : undefined}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <span className='fld-label'>Options · key → what goes into the text</span>
      {rows.map((row, index) => (
        <div key={row.id ?? `new-${index}`} className='optrow'>
          <input
            type='text'
            aria-label='Key'
            placeholder='key'
            maxLength={40}
            value={row.key}
            onChange={(event) => change(index, { key: event.target.value })}
          />
          <textarea
            aria-label='Value'
            placeholder='what goes into the text'
            rows={Math.min(5, Math.max(1, row.value.split('\n').length))}
            value={row.value}
            lang={isThai(row.value) ? 'th' : undefined}
            onChange={(event) => change(index, { value: event.target.value })}
          />
          <button
            type='button'
            className='iconbtn'
            aria-label={`Take ${row.key || 'this option'} off`}
            onClick={() =>
              setRows((all) => all.filter((_, at) => at !== index))
            }
          >
            <Icon name='close' size={12} />
          </button>
        </div>
      ))}
      <div className='row'>
        <button
          type='button'
          className='btn btn-sm'
          onClick={() => setRows((all) => [...all, { key: '', value: '' }])}
        >
          ＋ Option
        </button>
      </div>
      {error ? (
        <p className='err' role='alert'>
          {error}
        </p>
      ) : null}
      <div className='row'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={pending || !slotName(name)}
        >
          {pending ? 'Saving…' : slot ? 'Save' : 'Put in the library'}
          <kbd>⌘↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </form>
  )
}
