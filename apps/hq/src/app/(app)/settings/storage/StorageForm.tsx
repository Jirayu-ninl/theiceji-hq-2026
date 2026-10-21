'use client'

import type { StorageProviderId } from '@theiceji/hq-db/enums'
import Link from 'next/link'
import { type FormEvent, useRef, useState, useTransition } from 'react'
import { useToast } from '@/components/Toast'
import { Fld } from '../parts'
import { type StorageDefault, saveStorageDefaultAction } from './actions'

const LABEL: Record<StorageProviderId, string> = {
  r2: 'Cloudflare R2',
  gdrive: 'Google Drive',
}

const clock = () =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date())

/**
 * The default provider and root for new files. Saving writes the owner's
 * settings revision; Undo saves the previous choice back. Google Drive can
 * be picked only while Drive can take files, and the row says why in words
 * when it can't.
 */
export function StorageForm({
  initial,
  driveWhy,
  r2Why,
}: {
  initial: StorageDefault
  /** Why Drive can't take files right now, or null. */
  driveWhy: string | null
  /** Why R2 can't take files on this server, or null. */
  r2Why: string | null
}) {
  const toast = useToast()
  const [saved, setSaved] = useState(initial)
  const [provider, setProvider] = useState<StorageProviderId>(initial.provider)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const rootInput = useRef<HTMLInputElement>(null)
  const revision = useRef(initial.revision)

  // Drive stays choosable while it is already the default, so its root can still change.
  const driveLocked = Boolean(driveWhy) && saved.provider !== 'gdrive'

  const save = (
    next: { provider: StorageProviderId; root: string },
    undoTo?: StorageDefault,
  ) =>
    start(async () => {
      const result = await saveStorageDefaultAction({
        expectedRevision: revision.current,
        ...next,
      })
      if (!result.ok) {
        setError(result.error)
        if (undoTo) toast(result.error)
        return
      }
      const before = saved
      revision.current = result.data.revision
      setSaved(result.data)
      setProvider(result.data.provider)
      if (rootInput.current) rootInput.current.value = result.data.root ?? ''
      setError(null)
      setSavedAt(clock())
      if (undoTo) {
        toast(`Storage default back to ${LABEL[result.data.provider]}`)
        return
      }
      toast(
        `New files go to ${LABEL[result.data.provider]}${result.data.root ? ` · ${result.data.root}` : ''}`,
        {
          undo: () =>
            save(
              { provider: before.provider, root: before.root ?? '' },
              before,
            ),
        },
      )
    })

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    save({ provider, root: rootInput.current?.value ?? '' })
  }

  return (
    <form
      className='group'
      id='default'
      aria-labelledby='default-h'
      onSubmit={onSubmit}
      noValidate
    >
      <header className='group-head'>
        <h2 id='default-h'>Default provider</h2>
        <p>
          Where new files go when a project doesn’t choose its own. Changing it
          never moves a file already stored.
        </p>
      </header>
      <div className='group-body'>
        <Fld label='Provider'>
          {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons, not a fieldset */}
          <span className='seg' role='group' aria-label='Provider'>
            {(['r2', 'gdrive'] as const).map((value) => (
              <button
                key={value}
                type='button'
                aria-pressed={provider === value}
                disabled={value === 'gdrive' && driveLocked}
                onClick={() => setProvider(value)}
              >
                {LABEL[value]}
              </button>
            ))}
          </span>
          {provider === 'gdrive' && driveWhy ? (
            <p className='hint wait'>
              ◆ {driveWhy} Uploads wait until it’s fixed.
            </p>
          ) : null}
          {provider === 'r2' && r2Why ? (
            <p className='hint wait'>◆ {r2Why}</p>
          ) : null}
          {driveLocked ? (
            <p className='hint'>
              Google Drive can’t be chosen: {driveWhy}{' '}
              <Link className='lnk' href='/settings/google'>
                Open Google
              </Link>
            </p>
          ) : null}
        </Fld>
        <Fld
          label='Root'
          sub={
            provider === 'r2'
              ? 'Every key starts <owner>/<root>/<project>/…. Empty leaves the root out.'
              : 'A folder ID in your Drive. Empty is HQ’s own folder, TheIceJi HQ.'
          }
          htmlFor='storage-root'
        >
          <input
            ref={rootInput}
            id='storage-root'
            name='root'
            type='text'
            maxLength={300}
            defaultValue={initial.root ?? ''}
            placeholder={provider === 'r2' ? 'hq' : 'HQ’s folder'}
            spellCheck={false}
          />
        </Fld>
      </div>
      <footer className='group-foot'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={pending}
          data-key='s'
        >
          {pending ? 'Saving…' : 'Save'}
          <kbd>s</kbd>
        </button>
        <span
          className={`st${error ? ' wait' : savedAt ? ' saved' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {error ??
            (savedAt
              ? `saved ${savedAt}`
              : `revision ${saved.revision} · audited`)}
        </span>
      </footer>
    </form>
  )
}
