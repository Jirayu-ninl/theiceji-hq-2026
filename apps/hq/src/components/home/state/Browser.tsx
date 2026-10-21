'use client'

import Link from 'next/link'
import { type DragEvent, type RefObject, useState } from 'react'
import { projectHex } from '@/components/bridge/parts'
import { Icon } from '@/components/shell/Icon'
import type { StateData, StateNote, StateProject } from '@/lib/state'
import { isThai } from './model'

/**
 * State's browser: Notes — capture, the parked notes with
 * their project tag, drag one onto a cell or select it and press `p` — and
 * Data, which says honestly that HQ has no imports yet. `⇥` hides it.
 */
export function Browser({
  data,
  browserRef,
  tab,
  onTab,
  selected,
  onSelect,
  filedUnder,
  onCapture,
  onPromote,
  onClose,
  onDragStart,
  onDragEnd,
  busy,
}: {
  data: StateData
  browserRef: RefObject<HTMLElement | null>
  tab: 'notes' | 'data'
  onTab: (tab: 'notes' | 'data') => void
  selected: string | null
  onSelect: (id: string) => void
  /** Where a captured note is filed: the selected column's project. */
  filedUnder: StateProject | null
  onCapture: (body: string) => Promise<boolean>
  onPromote: () => void
  onClose: () => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  busy: boolean
}) {
  const [draft, setDraft] = useState('')
  const notes = data.notes
  const open = notes?.filter((note) => !note.promoted).length ?? 0
  const projectOf = (id: string | null) =>
    id ? (data.projects.find((project) => project.id === id) ?? null) : null

  const drag = (event: DragEvent<HTMLButtonElement>, note: StateNote) => {
    if (note.promoted) {
      event.preventDefault()
      return
    }
    event.dataTransfer.setData('text/plain', note.id)
    event.dataTransfer.effectAllowed = 'copy'
    onDragStart(note.id)
  }

  return (
    <aside className='pane browser' aria-label='Notes browser' ref={browserRef}>
      <header className='pane-head browser-tabs' role='tablist'>
        <button
          type='button'
          role='tab'
          id='state-tab-notes'
          aria-selected={tab === 'notes'}
          aria-controls='state-notes-view'
          onClick={() => onTab('notes')}
        >
          Notes <span className='n'>{notes ? notes.length : '—'}</span>
        </button>
        <button
          type='button'
          role='tab'
          id='state-tab-data'
          aria-selected={tab === 'data'}
          aria-controls='state-data-view'
          onClick={() => onTab('data')}
        >
          Data
        </button>
        <button
          type='button'
          className='iconbtn browser-close'
          title='Hide notes (⇥)'
          aria-label='Hide notes'
          onClick={onClose}
        >
          <Icon name='chevron' />
        </button>
      </header>
      <div
        className='pane-body browser-view'
        id='state-notes-view'
        role='tabpanel'
        aria-labelledby='state-tab-notes'
        hidden={tab !== 'notes'}
      >
        <form
          className='capture'
          autoComplete='off'
          onSubmit={async (event) => {
            event.preventDefault()
            const body = draft.trim()
            if (!body || busy) return
            if (await onCapture(body)) setDraft('')
          }}
        >
          <input
            aria-label={
              filedUnder
                ? `Capture a note, filed under ${filedUnder.name}`
                : 'Capture a note'
            }
            placeholder='Capture a thought…'
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.currentTarget.blur()
                setDraft('')
              }
            }}
          />
          <button
            type='submit'
            aria-label='Add note'
            title='Add note'
            disabled={busy}
          >
            ＋
          </button>
        </form>
        <div className='browser-label'>
          <span className='hud-label'>Notes</span>
          <span className='hud-label'>
            {notes ? `${open} open` : 'not read back'}
          </span>
        </div>
        <div className='notes'>
          {notes === null ? (
            <div className='empty unknown'>
              — Notes weren’t read back. Try again in a moment.
            </div>
          ) : notes.length === 0 ? (
            <div className='empty'>No notes yet. Capture one above.</div>
          ) : (
            notes.map((note) => {
              const project = projectOf(note.projectId)
              return (
                <button
                  key={note.id}
                  type='button'
                  className={`note${note.promoted ? ' promoted' : ''}`}
                  draggable={!note.promoted}
                  data-note={note.id}
                  aria-pressed={selected === note.id}
                  aria-label={`${note.text}${project ? `, ${project.name}` : ', HQ'}, ${note.age} ago${note.promoted ? `, promoted to ${note.promoted.label}` : ''}`}
                  title={
                    note.promoted
                      ? 'Already promoted'
                      : 'Drag onto a cell, or select and press p'
                  }
                  style={{
                    ['--project' as string]: project
                      ? projectHex(project.color)
                      : 'var(--ink-3)',
                  }}
                  onClick={() => onSelect(note.id)}
                  onDragStart={(event) => drag(event, note)}
                  onDragEnd={onDragEnd}
                >
                  <span className='who'>
                    <span className='tag'>
                      {project ? (
                        <>
                          <i className='dot' aria-hidden='true' />
                          <span lang={isThai(project.name) ? 'th' : undefined}>
                            {project.name}
                          </span>
                        </>
                      ) : (
                        'HQ'
                      )}
                    </span>
                    <span>{note.age}</span>
                  </span>
                  <p lang={isThai(note.text) ? 'th' : undefined}>{note.text}</p>
                  {note.promoted ? (
                    <span className='to'>↗ {note.promoted.label}</span>
                  ) : null}
                </button>
              )
            })
          )}
        </div>
        <p className='browser-hint'>
          Drag a note onto a cell to promote it, or select one and press{' '}
          <kbd>p</kbd>.
        </p>
      </div>
      <div
        className='pane-body browser-view'
        id='state-data-view'
        role='tabpanel'
        aria-labelledby='state-tab-data'
        hidden={tab !== 'data'}
      >
        <div className='browser-label'>
          <span className='hud-label'>Recent imports</span>
        </div>
        <div className='empty'>No imports. HQ has no importer yet.</div>
        <div>
          <Link className='btn btn-sm' href='/data'>
            Open Data
          </Link>
        </div>
        <p className='browser-hint'>
          Each module records its own readings, sales and payouts, by hand or
          through its connection.
        </p>
      </div>
      <footer className='browser-foot'>
        <span>Notes stay yours.</span>
        <button
          type='button'
          className='btn btn-sm'
          title='Promote the selected note into a cell'
          onClick={onPromote}
          disabled={!notes?.some((note) => !note.promoted)}
        >
          Promote<kbd>p</kbd>
        </button>
      </footer>
    </aside>
  )
}
