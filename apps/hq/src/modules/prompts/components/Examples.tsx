'use client'

import Link from 'next/link'
import { useEffect, useState, useTransition } from 'react'
import { durationLabel, Empty } from '@/components/bridge/parts'
import { Confirm } from '@/components/Confirm'
import { Icon } from '@/components/shell/Icon'
import { useToast } from '@/components/Toast'
import type { GeneratorOption } from '@/lib/generators'
import type { AssetData } from '../../assets/data'
import {
  addExampleAction,
  examplePickAction,
  generateExampleAction,
  removeExampleAction,
  setExamplePicksAction,
} from '../actions'
import type { ExampleData, PromptData, SlotData } from '../data'
import { type Mode, optionFor, PreviewThumb, Stars } from './parts'

/**
 * A prompt's examples: every example by default —
 * All, not split by variant — each tagged with the keys it was made with;
 * Matching narrows them to those made with what is picked in the text now.
 * A click on one opens Made with: which option of each variant made it
 * (changeable, or not known), Use these picks, Take off (asked in place).
 * ＋ Attach `a` is the last tile and records the picks of now; Generate
 * with… needs every variant picked and lands with those picks.
 */

/** The example's picks in the order the text writes its variants: [variant, key]. */
function tagsOf(
  example: ExampleData,
  slots: SlotData[],
): [name: string, key: string][] {
  return slots.flatMap((slot) => {
    const option = optionFor(slot, example.picks[slot.name])
    return option ? [[slot.name, option.key] as [string, string]] : []
  })
}

/** Made with every variant picked now (each pick the same option). */
function matches(
  example: ExampleData,
  slots: SlotData[],
  picks: Record<string, string>,
) {
  const picked = slots.filter((slot) => picks[slot.name])
  return (
    picked.length > 0 &&
    picked.every((slot) => {
      const mine = optionFor(slot, example.picks[slot.name])
      return Boolean(mine) && mine?.id === optionFor(slot, picks[slot.name])?.id
    })
  )
}

function MadeWith({
  prompt,
  example,
  onUse,
  onSaved,
  onClose,
}: {
  prompt: PromptData
  example: ExampleData
  onUse: (picks: Record<string, string>) => void
  onSaved: (prompt: PromptData, message?: string) => void
  onClose: () => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState(example.picks)
  const [pending, start] = useTransition()
  const [asking, setAsking] = useState(false)
  useEffect(() => setDraft(example.picks), [example.picks])
  const slots = (prompt.slots ?? []).filter((slot) => slot.inText)
  const changed = JSON.stringify(draft) !== JSON.stringify(example.picks)
  return (
    <div
      className='fcard made'
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !asking) {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className='made-h'>
        <span className='fld-label'>
          Made with · {example.caption || example.title}
        </span>
        <button
          type='button'
          className='iconbtn'
          aria-label='Close'
          onClick={onClose}
        >
          <Icon name='close' size={12} />
        </button>
      </div>
      {slots.length ? (
        slots.map((slot) => (
          <label key={slot.name} className='made-row'>
            <span>{slot.name}</span>
            <select
              value={optionFor(slot, draft[slot.name])?.id ?? ''}
              onChange={(event) =>
                setDraft((all) => {
                  const next = { ...all }
                  if (event.target.value) next[slot.name] = event.target.value
                  else delete next[slot.name]
                  return next
                })
              }
            >
              <option value=''>— not known —</option>
              {slot.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.key}
                </option>
              ))}
            </select>
          </label>
        ))
      ) : (
        <p className='hint'>The text has no variants.</p>
      )}
      <div className='row'>
        <button
          type='button'
          className='btn btn-sm'
          disabled={!Object.keys(example.picks).length}
          title='Pick in the text what this example was made with'
          onClick={() => onUse(example.picks)}
        >
          Use these picks
        </button>
        {changed ? (
          <button
            type='button'
            className='btn btn-sm btn-pri'
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await setExamplePicksAction({
                  promptId: prompt.id,
                  exampleId: example.id,
                  picks: draft,
                })
                if (result.ok)
                  onSaved(result.data, 'Saved what it was made with')
                else toast(result.error)
              })
            }
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        ) : null}
        <span className='sp' />
        {asking ? (
          // No Undo brings an example back: it asks in place.
          <Confirm
            label='Take off'
            question='Take it off?'
            yes='Take off'
            asking
            onAsking={setAsking}
            run={async () => {
              const result = await removeExampleAction({
                promptId: prompt.id,
                exampleId: example.id,
              })
              if (!result.ok) return toast(result.error)
              onSaved(
                result.data,
                'Example removed — the asset stays in Assets',
              )
              onClose()
            }}
          />
        ) : (
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => setAsking(true)}
          >
            Take off
          </button>
        )}
      </div>
    </div>
  )
}

/** Attach `a`: a ready asset becomes an example, made with the variants picked now. */
function AttachPicker({
  prompt,
  picks,
  onCancel,
  onAttached,
}: {
  prompt: PromptData
  picks: Record<string, string>
  onCancel: () => void
  onAttached: (prompt: PromptData) => void
}) {
  const toast = useToast()
  const [assets, setAssets] = useState<AssetData[] | null>(null)
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [rating, setRating] = useState<number | null>(null)
  const [pending, start] = useTransition()
  useEffect(() => {
    let alive = true
    examplePickAction(prompt.projectId).then((result) => {
      if (!alive) return
      if (result.ok) {
        setAssets(result.data.assets)
        setPreviews(result.data.previews)
      } else toast(result.error)
    })
    return () => {
      alive = false
    }
  }, [prompt.projectId, toast])
  const taken = new Set(
    (prompt.text?.examples ?? []).map((example) => example.assetId),
  )
  const made = (prompt.slots ?? []).flatMap((slot) => {
    const option = optionFor(slot, picks[slot.name])
    return option ? [option.key] : []
  })
  const choices = (assets ?? []).filter((asset) => !taken.has(asset.id))
  return (
    <div
      className='fcard'
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <span className='fld-label'>
        Attach a result
        {made.length ? ` · made with ${made.join(' · ')}` : ''}
      </span>
      {/* biome-ignore lint/a11y/useSemanticElements: rating toggles are a group of buttons */}
      <span className='seg' role='group' aria-label='Rating'>
        {[null, 1, 2, 3, 4, 5].map((value) => (
          <button
            key={String(value)}
            type='button'
            aria-pressed={rating === value}
            onClick={() => setRating(value)}
          >
            {value === null ? 'unrated' : '★'.repeat(value)}
          </button>
        ))}
      </span>
      {assets === null ? (
        <Empty>…</Empty>
      ) : choices.length === 0 ? (
        <p className='hint'>
          No ready image, video or audio{' '}
          {prompt.project ? `in ${prompt.project.name}` : 'without a project'}{' '}
          yet — upload the result in{' '}
          <Link
            href={
              prompt.project ? `/p/${prompt.project.slug}/assets` : '/assets'
            }
          >
            Assets
          </Link>{' '}
          first.
        </p>
      ) : (
        <div className='examples'>
          {choices.map((asset) => (
            <button
              key={asset.id}
              type='button'
              className='ex'
              style={{ border: 0, padding: 0, textAlign: 'left' }}
              disabled={pending}
              aria-label={`Attach ${asset.title}`}
              onClick={() =>
                start(async () => {
                  const result = await addExampleAction({
                    promptId: prompt.id,
                    assetId: asset.id,
                    picks,
                    rating,
                  })
                  if (result.ok) onAttached(result.data)
                  else toast(result.error)
                })
              }
            >
              <PreviewThumb
                kind={asset.kind}
                preview={previews[asset.id] ?? null}
                label={asset.title}
              />
              <span className='cap' style={{ fontSize: 11 }}>
                {asset.title}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className='row'>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </div>
  )
}

export function Examples({
  prompt,
  picks,
  generators,
  live,
  mode,
  onMode,
  onPicks,
  onSaved,
}: {
  prompt: PromptData
  picks: Record<string, string>
  generators: GeneratorOption[]
  live: boolean
  mode: Mode
  onMode: (mode: Mode) => void
  onPicks: (picks: Record<string, string>) => void
  onSaved: (prompt: PromptData, message?: string) => void
}) {
  const toast = useToast()
  const [only, setOnly] = useState<'all' | 'matching'>('all')
  const [open, setOpen] = useState<string | null>(null)
  const examples = prompt.text?.examples ?? []
  const slots = (prompt.slots ?? []).filter((slot) => slot.inText)
  const picked = slots.some((slot) => picks[slot.name])
  const matching = examples.filter((example) => matches(example, slots, picks))
  const shown = only === 'matching' && picked ? matching : examples
  const opened = examples.find((example) => example.id === open) ?? null
  const missing = slots
    .filter((slot) => !optionFor(slot, picks[slot.name]))
    .map((slot) => slot.name)
  const usable = generators.filter((entry) =>
    prompt.medium === 'video'
      ? entry.video
      : prompt.medium === 'image' && entry.image,
  )
  const [withId, setWithId] = useState(usable[0]?.id ?? '')
  const [generating, startGenerating] = useTransition()
  return (
    <section className='sect' aria-label='Examples'>
      <div className='dev-h'>
        <span className='vlabel'>
          <span className='hud-label'>Examples</span>
          {slots.length && examples.length ? (
            // biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons
            <span className='seg ex-only' role='group' aria-label='Show'>
              <button
                type='button'
                aria-pressed={only === 'all' || !picked}
                onClick={() => setOnly('all')}
              >
                All {examples.length}
              </button>
              <button
                type='button'
                aria-pressed={only === 'matching' && picked}
                disabled={!picked}
                title={
                  picked
                    ? 'Only those made with what is picked in the text'
                    : 'Pick a variant in the text first'
                }
                onClick={() => setOnly('matching')}
              >
                Matching {picked ? matching.length : '–'}
              </button>
            </span>
          ) : (
            <span className='hud-label'>· {examples.length}</span>
          )}
        </span>
        <Link
          className='sect-m'
          href={prompt.project ? `/p/${prompt.project.slug}/assets` : '/assets'}
        >
          Assets ›
        </Link>
      </div>
      <div className='examples'>
        {shown.map((example) => {
          const tags = tagsOf(example, slots)
          return (
            <figure
              key={example.id}
              className={`ex${open === example.id ? ' open' : ''}`}
            >
              <button
                type='button'
                className='ex-hit'
                aria-label={`${example.caption || example.title} — what it was made with`}
                aria-expanded={open === example.id}
                onClick={() => setOpen(open === example.id ? null : example.id)}
              >
                <PreviewThumb
                  kind={example.kind}
                  preview={example.preview}
                  label={`${example.kind} · ${example.caption || example.title}`}
                  tc={
                    example.durationMs
                      ? durationLabel(example.durationMs).replace(/^00:/, '')
                      : undefined
                  }
                />
              </button>
              <figcaption>
                <span className='cap'>{example.caption || example.title}</span>
                {slots.length ? (
                  <span className='ex-tags'>
                    {tags.length ? (
                      tags.map(([name, key]) => (
                        <span
                          key={name}
                          className='ex-tag'
                          title={`${name}: ${key}`}
                        >
                          {key}
                        </span>
                      ))
                    ) : (
                      <span className='ex-tag none'>not known</span>
                    )}
                  </span>
                ) : null}
                <Stars rating={example.rating} />
              </figcaption>
            </figure>
          )
        })}
        {only === 'matching' && picked && !matching.length ? (
          <Empty>None made with these picks yet.</Empty>
        ) : null}
        {live ? (
          <button
            type='button'
            className='pcard ghost ex-add'
            aria-pressed={mode === 'attach'}
            aria-keyshortcuts='a'
            title='Attach a result from Assets, made with the picks of now (a)'
            onClick={() => onMode('attach')}
          >
            <span>＋ Attach</span>
          </button>
        ) : examples.length === 0 ? (
          <Empty>No examples.</Empty>
        ) : null}
      </div>
      {opened && live ? (
        <MadeWith
          key={opened.id}
          prompt={prompt}
          example={opened}
          onUse={(next) => {
            onPicks(next)
            toast('Picked what it was made with')
          }}
          onSaved={onSaved}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {live && mode === 'attach' ? (
        <AttachPicker
          prompt={prompt}
          picks={picks}
          onCancel={() => onMode('read')}
          onAttached={(next) => {
            onSaved(next, 'Attached')
            onMode('read')
          }}
        />
      ) : null}
      {live && usable.length ? (
        <div className='gen-with'>
          <span className='hud-label'>Generate with</span>
          <select
            value={withId}
            onChange={(event) => setWithId(event.target.value)}
            aria-label='Generator'
          >
            {usable.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
          <button
            type='button'
            className='btn btn-sm'
            disabled={generating || !withId || missing.length > 0}
            title={missing.length ? `Pick ${missing.join(', ')} first` : ''}
            onClick={() =>
              startGenerating(async () => {
                const result = await generateExampleAction({
                  promptId: prompt.id,
                  connectionId: withId,
                  picks,
                })
                if (!result.ok) return toast(result.error)
                const name = usable.find((entry) => entry.id === withId)?.label
                onSaved(
                  result.data.prompt,
                  result.data.state === 'succeeded'
                    ? `${name} made an example`
                    : result.data.state === 'running'
                      ? `${name} is making it — it lands here when ready`
                      : (result.data.error ?? `${name} couldn’t make it`),
                )
              })
            }
          >
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>
      ) : null}
    </section>
  )
}
