'use client'

import { slotNames, splitSlots } from '@theiceji/hq-prompts/template'
import { useEffect, useRef, useState, useTransition } from 'react'
import { Facts, isThai } from '@/components/bridge/parts'
import { Icon } from '@/components/shell/Icon'
import { menuKeys, usePlacement } from '@/components/shell/Menus'
import { useToast } from '@/components/Toast'
import { savePromptAction } from '../actions'
import type { OptionData, PromptData, SlotData } from '../data'
import { chipMenuId, fillFrom, type Mode, optionFor } from './parts'

/**
 * A prompt's text, where the text is the picker. Each variant sits in the
 * sentence as a chip that shows the value picked (marked) or, until then,
 * its name (dashed); the chip opens its options — key and value, this
 * prompt's and the library's — with ＋ Option for it last. What you read is
 * what Copy puts in, and Copy works only with every variant picked.
 * Edit `e` changes the text, the negative text and the hints; a variant's
 * options are changed from its chip.
 */

const firstLine = (value: string) => {
  const lines = value.split('\n')
  return (lines[0] ?? '') + (lines.length > 1 ? ' …' : '')
}

/** The prompt's own variants as `savePrompt` takes them, the whole set. */
const ownSlots = (prompt: PromptData) =>
  (prompt.slots ?? [])
    .filter((slot) => slot.promptSlotId)
    .map((slot) => ({
      id: slot.promptSlotId as string,
      name: slot.name,
      options: slot.options
        .filter((option) => option.from === 'prompt')
        .map(({ id, key, value }) => ({ id, key, value })),
    }))

/** A variant in the sentence: its value (or name) and the menu of its options. */
function Chip({
  name,
  slot,
  picks,
  live,
  menu,
  onPick,
  onAdd,
}: {
  name: string
  slot: SlotData | undefined
  picks: Record<string, string>
  live: boolean
  /** The first chip of a name holds its menu; a second one opens the same. */
  menu: boolean
  onPick: (name: string, id: string | null) => void
  onAdd: (name: string) => void
}) {
  const id = chipMenuId(name)
  const ref = usePlacement(id, `[popovertarget="${id}"]`)
  const picked = optionFor(slot, picks[name])
  const own = slot?.options.filter((option) => option.from === 'prompt') ?? []
  const library =
    slot?.options.filter((option) => option.from === 'library') ?? []
  const item = (option: OptionData) => (
    <button
      key={option.id}
      type='button'
      role='menuitemradio'
      aria-checked={picked?.id === option.id}
      aria-current={picked?.id === option.id ? 'true' : undefined}
      className='menu-item vopt'
      onClick={() => {
        ref.current?.hidePopover()
        onPick(name, option.id)
      }}
    >
      <span className='vopt-key'>{option.key}</span>
      <span className='sub vopt-val'>{firstLine(option.value) || '∅'}</span>
    </button>
  )
  return (
    <>
      <button
        type='button'
        className={`vchip${picked ? '' : ' open'}${picked?.value.includes('\n') ? ' block' : ''}`}
        popoverTarget={id}
        aria-haspopup='menu'
        title={picked ? `${name} · ${picked.key}` : `Pick ${name}`}
      >
        {picked ? picked.value : name}
        <span className='vcaret' aria-hidden='true'>
          ▾
        </span>
      </button>
      {menu ? (
        <div
          ref={ref}
          id={id}
          popover='auto'
          className='popover vmenu'
          role='menu'
          aria-label={name}
          onKeyDown={menuKeys}
        >
          <div className='vmenu-head'>
            <span className='hud-label'>{name}</span>
            {slot?.note ? <span className='sub'>{slot.note}</span> : null}
          </div>
          <div className='menu-list'>
            {own.length ? (
              <>
                <span className='vmenu-group'>this prompt</span>
                {own.map(item)}
              </>
            ) : null}
            {library.length ? (
              <>
                <span className='vmenu-group'>library</span>
                {library.map(item)}
              </>
            ) : null}
            {!own.length && !library.length ? (
              <span className='vmenu-group'>no options yet</span>
            ) : null}
            {live ? (
              <button
                type='button'
                role='menuitem'
                className='menu-item sep'
                onClick={() => {
                  ref.current?.hidePopover()
                  onAdd(name)
                }}
              >
                <span className='label'>＋ Option for {name}…</span>
              </button>
            ) : null}
            {picked ? (
              <button
                type='button'
                role='menuitem'
                className='menu-item'
                onClick={() => {
                  ref.current?.hidePopover()
                  onPick(name, null)
                }}
              >
                <span className='label'>Clear</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  )
}

type Part = { text: string } | { slot: string; menu: boolean }

/**
 * The texts in parts, each variant marked with whether its chip holds the
 * menu: the first of a name across all of them does (one popover per id).
 * Worked out before rendering, so a render run twice gives the same answer.
 */
function partsOf(...texts: string[]): Part[][] {
  const seen = new Set<string>()
  return texts.map((text) =>
    splitSlots(text).map((part) => {
      if ('text' in part) return part
      const menu = !seen.has(part.slot)
      seen.add(part.slot)
      return { slot: part.slot, menu }
    }),
  )
}

/** A text with its variants as chips. */
function Sentence({
  text,
  parts,
  slots,
  className,
  ...chip
}: {
  text: string
  parts: Part[]
  slots: SlotData[]
  className: string
  picks: Record<string, string>
  live: boolean
  onPick: (name: string, id: string | null) => void
  onAdd: (name: string) => void
}) {
  return (
    <div className={className} lang={isThai(text) ? 'th' : undefined}>
      {parts.map((part, index) =>
        'text' in part ? (
          <span key={index}>{part.text}</span>
        ) : (
          <Chip
            key={index}
            name={part.slot}
            slot={slots.find((slot) => slot.name === part.slot)}
            menu={part.menu}
            {...chip}
          />
        ),
      )}
    </div>
  )
}

/** A variant's own options in a form card — what its chip's ＋ Option opens. */
function OptionsForm({
  prompt,
  name,
  onCancel,
  onSaved,
}: {
  prompt: PromptData
  name: string
  onCancel: () => void
  onSaved: (prompt: PromptData, message?: string) => void
}) {
  const slot = prompt.slots?.find((entry) => entry.name === name)
  const [rows, setRows] = useState<
    { id?: string; key: string; value: string }[]
  >(() => [
    ...(slot?.options
      .filter((option) => option.from === 'prompt')
      .map(({ id, key, value }) => ({ id, key, value })) ?? []),
    { key: '', value: '' },
  ])
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const first = useRef<HTMLFormElement>(null)
  // Opens on the empty row: ＋ Option is what was asked for.
  useEffect(() => {
    const keys = first.current?.querySelectorAll<HTMLInputElement>(
      'input[aria-label="Key"]',
    )
    keys?.[keys.length - 1]?.focus()
  }, [])
  const shared = slot?.options.filter((option) => option.from === 'library')
  const change = (index: number, patch: { key?: string; value?: string }) =>
    setRows((all) =>
      all.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)),
    )
  return (
    <form
      ref={first}
      className='fcard optform'
      aria-label={`${name} — this prompt’s options`}
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
          const mine = rows.filter((row) => row.key.trim())
          const result = await savePromptAction({
            promptId: prompt.id,
            expectedRevision: prompt.revision,
            title: prompt.title,
            medium: prompt.medium,
            slots: [
              ...ownSlots(prompt).filter((entry) => entry.name !== name),
              ...(mine.length
                ? [
                    {
                      ...(slot?.promptSlotId ? { id: slot.promptSlotId } : {}),
                      name,
                      options: mine,
                    },
                  ]
                : []),
            ],
          })
          if (result.ok) onSaved(result.data, `Saved ${name}’s options`)
          else setError(result.error)
        })
      }}
    >
      <span className='fld-label'>{name} · this prompt’s options</span>
      {shared?.length ? (
        <p className='hint'>
          library: {shared.map((option) => option.key).join(', ')} — the same
          key here replaces it for this prompt
        </p>
      ) : null}
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
        <button type='submit' className='btn btn-pri' disabled={pending}>
          {pending ? 'Saving…' : 'Save options'}
          <kbd>⌘↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </form>
  )
}

/**
 * Edit `e`: the text, the negative text and style · provider hint · model.
 * A new `<NAME>` shows as a chip once saved; its options come from the chip.
 */
export function TextForm({
  prompt,
  onCancel,
  onSaved,
}: {
  prompt: PromptData
  onCancel: () => void
  onSaved: (prompt: PromptData) => void
}) {
  const current = prompt.text
  const [text, setText] = useState(current?.text ?? '')
  const [negative, setNegative] = useState(current?.negativeText ?? '')
  const [style, setStyle] = useState(current?.style ?? '')
  const [hint, setHint] = useState(current?.providerHint ?? '')
  const [model, setModel] = useState(current?.model ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => area.current?.focus(), [])
  const written = slotNames(text, negative)
  const submit = () =>
    start(async () => {
      setError(null)
      const result = await savePromptAction({
        promptId: prompt.id,
        expectedRevision: prompt.revision,
        title: prompt.title,
        medium: prompt.medium,
        text,
        negativeText: negative,
        style,
        providerHint: hint || null,
        model: model || null,
      })
      if (result.ok) onSaved(result.data)
      else setError(result.error)
    })
  return (
    <form
      className='pedit'
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          submit()
        }
      }}
    >
      <textarea
        ref={area}
        className='editor'
        aria-label='Text'
        placeholder='Generate a character with <HAIR_COLOR> hair'
        value={text}
        lang={isThai(text) ? 'th' : undefined}
        onChange={(event) => setText(event.target.value)}
      />
      <p className='hint'>
        A variant is a name in &lt; &gt;, upper case — &lt;HAIR_COLOR&gt;. Its
        options are picked and added from its chip in the text.
        {written.length ? ` In this text: ${written.join(', ')}.` : ''}
      </p>
      <span className='hud-label'>Negative</span>
      <textarea
        className='editor neg'
        aria-label='Negative text'
        placeholder='nothing excluded'
        value={negative}
        onChange={(event) => setNegative(event.target.value)}
      />
      <div className='fcard'>
        <div className='row'>
          <label style={{ flex: 1 }}>
            Style
            <input
              type='text'
              value={style}
              maxLength={200}
              onChange={(event) => setStyle(event.target.value)}
            />
          </label>
          <label style={{ flex: 1 }}>
            Provider hint
            <input
              type='text'
              value={hint}
              maxLength={80}
              placeholder='manual'
              onChange={(event) => setHint(event.target.value)}
            />
          </label>
          <label style={{ flex: 1 }}>
            Model
            <input
              type='text'
              value={model}
              maxLength={120}
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
        </div>
      </div>
      {error ? (
        <p className='err' role='alert'>
          {error}
        </p>
      ) : null}
      <div className='dev-acts'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={pending || !text.trim()}
        >
          {pending ? 'Saving…' : current ? 'Save' : 'Save text'}
          <kbd>⌘↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </form>
  )
}

/** The text section: head (Copy · Edit), the sentence with its chips, a variant's options form. */
export function PromptText({
  prompt,
  picks,
  mode,
  live,
  onPick,
  onMode,
  onSaved,
  onCopy,
}: {
  prompt: PromptData
  picks: Record<string, string>
  mode: Mode
  live: boolean
  onPick: (name: string, id: string | null) => void
  onMode: (mode: Mode) => void
  onSaved: (prompt: PromptData, message?: string) => void
  onCopy: () => void
}) {
  const toast = useToast()
  const [adding, setAdding] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const text = prompt.text
  if (!text) return null
  const slots = prompt.slots ?? []
  const written = slots.filter((slot) => slot.inText)
  // A variant the text no longer writes keeps its own options until they go.
  const orphans = slots.filter((slot) => !slot.inText && slot.promptSlotId)
  const { missing } = fillFrom(prompt, picks)
  const editing = live && mode === 'edit'
  const params = Object.entries(text.params)
  const [textParts = [], negativeParts = []] = partsOf(
    text.text,
    text.negativeText,
  )
  const add = (name: string) => {
    onMode('read')
    setAdding(name)
  }
  return (
    <section className='vsect' aria-label='Text'>
      <div className='dev-h vhead'>
        <span className='vlabel'>
          <span className='hud-label'>{editing ? 'Edit text' : 'Text'}</span>
          {!editing && (text.style || text.model) ? (
            <span className='state-word'>
              {[text.style, text.model].filter(Boolean).join(' · ')}
            </span>
          ) : null}
        </span>
        {live && !editing ? (
          <span className='vacts'>
            {missing.length ? (
              <span className='vneed'>pick {missing.length}</span>
            ) : null}
            <button
              type='button'
              className='btn btn-sm btn-pri'
              aria-disabled={missing.length > 0}
              title={
                missing.length
                  ? `Pick ${missing.join(', ')} first (y)`
                  : 'Copy the text, every variant filled (y)'
              }
              aria-keyshortcuts='y'
              onClick={onCopy}
            >
              Copy
            </button>
            <button
              type='button'
              className='btn btn-sm'
              title='Edit the text (e)'
              aria-keyshortcuts='e'
              onClick={() => {
                setAdding(null)
                onMode('edit')
              }}
            >
              Edit
            </button>
          </span>
        ) : null}
      </div>
      {editing ? (
        <TextForm
          prompt={prompt}
          onCancel={() => onMode('read')}
          onSaved={(next) => {
            onSaved(next, 'Text saved')
            onMode('read')
          }}
        />
      ) : (
        <>
          <Sentence
            className='ptext fill'
            text={text.text}
            parts={textParts}
            slots={written}
            picks={picks}
            live={live}
            onPick={onPick}
            onAdd={add}
          />
          {written.length ? (
            <p className='vlegend'>
              {written.length} {written.length === 1 ? 'variant' : 'variants'} ·{' '}
              {missing.length
                ? `${missing.join(', ')} to pick`
                : 'all picked — Copy puts in what you read'}
            </p>
          ) : null}
          {live && orphans.length ? (
            <p className='vlegend'>
              Not in the text any more:{' '}
              {orphans.map((slot) => (
                <button
                  key={slot.name}
                  type='button'
                  className='btn btn-sm'
                  disabled={pending}
                  title={`Take ${slot.name}’s own options off this prompt`}
                  onClick={() =>
                    start(async () => {
                      const result = await savePromptAction({
                        promptId: prompt.id,
                        expectedRevision: prompt.revision,
                        title: prompt.title,
                        medium: prompt.medium,
                        slots: ownSlots(prompt).filter(
                          (entry) => entry.name !== slot.name,
                        ),
                      })
                      if (result.ok)
                        onSaved(result.data, `Took ${slot.name} off`)
                      else toast(result.error)
                    })
                  }
                >
                  {slot.name} · take off
                </button>
              ))}
            </p>
          ) : null}
          {live && adding ? (
            <OptionsForm
              key={adding}
              prompt={prompt}
              name={adding}
              onCancel={() => setAdding(null)}
              onSaved={(next, message) => {
                onSaved(next, message)
                setAdding(null)
              }}
            />
          ) : null}
        </>
      )}
      {params.length && !editing ? (
        <Facts
          rows={params.map(([key, value]) => [
            key.replace(/_/g, ' '),
            String(value),
          ])}
        />
      ) : null}
      {text.negativeText && !editing ? (
        <>
          <span className='hud-label'>Negative</span>
          <Sentence
            className='ptext neg fill'
            text={text.negativeText}
            parts={negativeParts}
            slots={written}
            picks={picks}
            live={live}
            onPick={onPick}
            onAdd={add}
          />
        </>
      ) : null}
    </section>
  )
}
