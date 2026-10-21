'use client'

import { fillSlots } from '@theiceji/hq-prompts/template'
import { useState } from 'react'
import type { PromptData, SlotData } from '../data'

/** Small parts the Prompts page, its text and its examples share. */

/** What the inspector is doing: reading, or one form open. */
export type Mode = 'read' | 'edit' | 'attach' | 'details'

export function Stars({ rating }: { rating: number | null }) {
  if (rating == null) return <span className='rate none'>— unrated</span>
  return (
    <span className='rate' role='img' aria-label={`${rating} of 5`}>
      {'★'.repeat(rating)}
      {'☆'.repeat(5 - rating)}
    </span>
  )
}

export function PreviewThumb({
  kind,
  preview,
  label,
  tc,
}: {
  kind: string
  preview: string | null
  label: string
  tc?: string
}) {
  const [broken, setBroken] = useState(false)
  return (
    <div
      className={`thumb${preview ? ' real' : ''}`}
      role='img'
      aria-label={label}
      style={preview && !broken ? { padding: 0 } : undefined}
    >
      {preview && !broken ? (
        <img
          src={preview}
          alt=''
          loading='lazy'
          onError={() => setBroken(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      ) : (
        <span>{kind}</span>
      )}
      {tc ? <span className='tc'>{tc}</span> : null}
    </div>
  )
}

/** The option a pick names — by id, or the library id a prompt option replaces. */
export const optionFor = (
  slot: SlotData | undefined,
  id: string | undefined,
) =>
  id
    ? (slot?.options.find(
        (option) => option.id === id || option.replaces === id,
      ) ?? null)
    : null

/** The text filled from the picks; `missing` names the variants still to pick. */
export function fillFrom(
  prompt: Pick<PromptData, 'text' | 'slots'>,
  picks: Record<string, string>,
): { text: string; missing: string[]; keys: string[] } {
  const values: Record<string, string> = {}
  const keys: string[] = []
  for (const slot of prompt.slots ?? []) {
    const option = optionFor(slot, picks[slot.name])
    if (!option) continue
    values[slot.name] = option.value
    if (slot.inText) keys.push(option.key)
  }
  return {
    text: fillSlots(prompt.text?.text ?? '', values),
    missing: (prompt.slots ?? [])
      .filter((slot) => slot.inText && !Object.hasOwn(values, slot.name))
      .map((slot) => slot.name),
    keys,
  }
}

/** The DOM id of a variant's chip menu — `y` and Copy focus the first one missing. */
export const chipMenuId = (name: string) => `variant-${name}`
