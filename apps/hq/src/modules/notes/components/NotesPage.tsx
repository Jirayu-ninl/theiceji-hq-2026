'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import {
  age,
  Dot,
  Empty,
  Facts,
  Inspector,
  InspectorHead,
  isThai,
  Name,
  PaneHead,
  projectHex,
  Tag,
  usePageKeys,
} from '@/components/bridge/parts'
import { Confirm } from '@/components/Confirm'
import { Modal } from '@/components/Modal'
import { usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import { Markdown } from '@/lib/md'
import {
  BODY_MAX,
  excerpt,
  fallbackTitle,
  keepLines,
  type Note,
  TITLE_MAX,
  viewOf,
} from '@/lib/notes/types'
import {
  archiveNoteAction,
  captureNoteAction,
  editNoteAction,
  emptyTrashAction,
  promoteNoteAction,
  purgeNoteAction,
  trashNoteAction,
  unlinkNoteAction,
} from '../actions'

/**
 * Notes on Bridge: parked thoughts as
 * a Board (a pool of cards) or a List, beside an inspector that promotes a
 * note into a card, a prompt or an event through the target registry. The
 * note stays, linked to its new home. Plain on purpose: no instrument.
 *
 * Capture with ↵ (filed under the project the filter shows), or write a
 * whole note — title, body, project — in the New note modal that the Board's
 * dashed first tile and `c` open, the way Keep's "Take a note" does. A card
 * shows the title on its own line over the body as markdown, every typed
 * line kept. `p` promote · `e` edit · `⌫` delete (Undo brings it back).
 * Archive and Trash are the same list over the notes put away, each with
 * Restore; the trash empties itself after 30 days. In the Trash a note can
 * also be deleted for good (`⌫`), or the whole trash emptied — both ask
 * first, in place, because neither comes back.
 */

export type NotesProject = {
  id: string
  slug: string
  name: string
  color: string
  kind: string
}
export type TargetOption = { type: string; label: string }

export type NotesPageProps = {
  notes: Note[]
  projects: NotesProject[]
  /** What each project can take (`null` = no project). */
  targets: { projectId: string | null; targets: TargetOption[] }[]
  view: 'board' | 'list' | 'archive' | 'trash'
  selectedId: string | null
  /** `?new=1` (the "Jot a note" shortcut): open New note at once. */
  startNew?: boolean
}

type Promoted = {
  type?: string
  id?: string
  href?: string
  projectId?: string | null
  label?: string
}

type NewNote = { title: string | null; body: string; projectId: string | null }

const titleOf = (note: Note) =>
  note.title?.trim() || fallbackTitle(note.body) || 'Untitled note'

export function NotesPage(props: NotesPageProps) {
  const router = useRouter()
  const toast = useToast()
  const [notes, setNotes] = useState(props.notes)
  const [who, setWho] = useState<string>('all')
  const [selected, setSelected] = useState<string | null>(props.selectedId)
  const [mode, setMode] = useState<'read' | 'edit' | 'promote'>('read')
  const [capture, setCapture] = useState('')
  const [writing, setWriting] = useState(false)
  // Delete for good asks in place; ⌫ in the Trash opens the same question.
  const [asking, setAsking] = useState(false)
  const [pending, start] = useTransition()
  const paneRef = useRef<HTMLElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => setNotes(props.notes), [props.notes])

  // The "Jot a note" shortcut lands on `?new=1`: New note opens as `c`
  // would, and the flag leaves the URL at once (no history entry), so a
  // reload doesn't open it again.
  useEffect(() => {
    if (!props.startNew) return
    const url = new URL(window.location.href)
    url.searchParams.delete('new')
    window.history.replaceState(null, '', url)
    if (props.view !== 'archive' && props.view !== 'trash') setWriting(true)
  }, [props.startNew, props.view])

  const bucket =
    props.view === 'archive' || props.view === 'trash' ? props.view : 'active'
  const parked = bucket === 'active'
  const projectOf = (id: string | null | undefined) =>
    props.projects.find((project) => project.id === id) ?? null
  const inBucket = useMemo(
    () => notes.filter((note) => viewOf(note) === bucket),
    [notes, bucket],
  )
  const shown = useMemo(
    () =>
      inBucket.filter(
        (note) =>
          who === 'all' ||
          (who === 'hq' ? !note.projectId : note.projectId === who),
      ),
    [inBucket, who],
  )
  const current = inBucket.find((note) => note.id === selected) ?? null
  const withNotes = props.projects.filter((project) =>
    inBucket.some((note) => note.projectId === project.id),
  )

  const select = (id: string | null, focus = false) => {
    setSelected(id)
    setMode('read')
    setAsking(false)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('note', id)
    else url.searchParams.delete('note')
    window.history.replaceState(null, '', url)
    if (focus && id)
      requestAnimationFrame(() =>
        paneRef.current
          ?.querySelector<HTMLElement>(`[data-id="${id}"]`)
          ?.focus({ preventScroll: true }),
      )
  }

  const replace = (next: Note) =>
    setNotes((list) =>
      list.some((note) => note.id === next.id)
        ? list.map((note) => (note.id === next.id ? next : note))
        : [next, ...list],
    )

  const remove = (note: Note) =>
    start(async () => {
      const index = shown.findIndex((entry) => entry.id === note.id)
      const result = await trashNoteAction({ noteId: note.id, deleted: true })
      if (!result.ok) {
        toast(result.error)
        return
      }
      replace(result.data)
      select(shown[index + 1]?.id ?? shown[index - 1]?.id ?? null)
      toast(`Deleted: ${titleOf(note).slice(0, 40)}`, {
        undo: async () => {
          const back = await trashNoteAction({
            noteId: note.id,
            deleted: false,
          })
          if (back.ok) {
            replace(back.data)
            select(back.data.id)
          } else toast(back.error)
        },
      })
    })

  const restore = (note: Note) =>
    start(async () => {
      const index = shown.findIndex((entry) => entry.id === note.id)
      const result =
        bucket === 'trash'
          ? await trashNoteAction({ noteId: note.id, deleted: false })
          : await archiveNoteAction({ noteId: note.id, archived: false })
      if (!result.ok) {
        toast(result.error)
        return
      }
      replace(result.data)
      select(shown[index + 1]?.id ?? shown[index - 1]?.id ?? null)
      toast(`Restored: ${titleOf(note).slice(0, 40)}`)
    })

  const archive = (note: Note) =>
    start(async () => {
      const index = shown.findIndex((entry) => entry.id === note.id)
      const result = await archiveNoteAction({
        noteId: note.id,
        archived: true,
      })
      if (!result.ok) {
        toast(result.error)
        return
      }
      replace(result.data)
      select(shown[index + 1]?.id ?? shown[index - 1]?.id ?? null)
      toast(`Archived: ${titleOf(note).slice(0, 40)}`, {
        undo: async () => {
          const back = await archiveNoteAction({
            noteId: note.id,
            archived: false,
          })
          if (back.ok) {
            replace(back.data)
            select(back.data.id)
          } else toast(back.error)
        },
      })
    })

  /** Gone for good, from the Trash — asked first, in place. */
  const purgeNote = async (note: Note) => {
    const index = shown.findIndex((entry) => entry.id === note.id)
    const result = await purgeNoteAction(note.id)
    if (!result.ok) {
      toast(result.error)
      return
    }
    setNotes((list) => list.filter((entry) => entry.id !== note.id))
    select(shown[index + 1]?.id ?? shown[index - 1]?.id ?? null)
    toast(`Deleted for good: ${titleOf(note).slice(0, 40)}`)
  }

  /** Every note in the Trash, gone for good — asked first, in place. */
  const empty = async () => {
    const result = await emptyTrashAction()
    if (!result.ok) {
      toast(result.error)
      return
    }
    setNotes((list) => list.filter((note) => viewOf(note) !== 'trash'))
    select(null)
    const n = result.data.removed
    toast(`Trash emptied — ${n} ${n === 1 ? 'note' : 'notes'} deleted for good`)
  }

  /** Capture and New note both land here; answers the refusal, if any. */
  const park = async (fields: NewNote): Promise<string | null> => {
    const result = await captureNoteAction(fields)
    if (!result.ok) return result.error
    const project = projectOf(fields.projectId)
    replace(result.data)
    select(result.data.id)
    toast(
      `Parked${project ? ` under ${project.name}` : ''}: ${titleOf(result.data).slice(0, 40)}`,
      {
        undo: async () => {
          const back = await trashNoteAction({
            noteId: result.data.id,
            deleted: true,
          })
          if (back.ok) {
            replace(back.data)
            select(null)
          }
        },
      },
    )
    return null
  }

  usePageKeyHints(
    parked
      ? [
          ['↵', 'capture'],
          ['c', 'new note'],
          ['p', 'promote'],
          ['e', 'edit'],
          ['⌫', 'delete'],
          ['↑ ↓', 'notes'],
          ['1–4', 'views'],
        ]
      : bucket === 'trash'
        ? [
            ['r', 'restore'],
            ['⌫', 'delete for good'],
            ['↑ ↓', 'notes'],
            ['1–4', 'views'],
          ]
        : [
            ['r', 'restore'],
            ['↑ ↓', 'notes'],
            ['1–4', 'views'],
          ],
  )

  usePageKeys((key) => {
    // While Delete for good asks, its two answers have the keys: ↵ gives
    // the one with focus, Esc keeps the note.
    if (asking) {
      if (key !== 'Escape') return false
      setAsking(false)
      return true
    }
    if (key === 'Escape') {
      if (mode !== 'read') {
        setMode('read')
        return true
      }
      if (selected) {
        select(null)
        return true
      }
      return false
    }
    if (key === '/') {
      input.current?.focus()
      return true
    }
    if (key === 'c' && parked) {
      setWriting(true)
      return true
    }
    const index = shown.findIndex((note) => note.id === selected)
    if (['ArrowDown', 'ArrowRight', 'j'].includes(key)) {
      const next = shown[Math.min(shown.length - 1, index + 1)]
      if (next) select(next.id, true)
      return Boolean(next)
    }
    if (['ArrowUp', 'ArrowLeft', 'k'].includes(key)) {
      const next = shown[Math.max(0, index - 1)]
      if (next) select(next.id, true)
      return Boolean(next)
    }
    if (!current) return false
    if (!parked) {
      if (key === 'r') {
        restore(current)
        return true
      }
      if (bucket === 'trash' && (key === 'Backspace' || key === 'Delete')) {
        setAsking(true)
        return true
      }
      return false
    }
    if (key === 'p') {
      if (current.promotedTo) toast('Already promoted — unlink it first')
      else setMode('promote')
      return true
    }
    if (key === 'e') {
      setMode('edit')
      return true
    }
    if (key === 'Backspace' || key === 'Delete') {
      remove(current)
      return true
    }
    if (key === 'Enter') {
      const to = current.promotedTo as Promoted | null
      if (to?.href) router.push(to.href)
      else setMode('promote')
      return true
    }
    return false
  })

  const filedUnder = who !== 'all' && who !== 'hq' ? projectOf(who) : null
  /** The Board's first place: Keep's "Take a note", opening New note. */
  const newTile =
    parked && props.view === 'board' ? (
      <button
        type='button'
        className='pcard ghost'
        onClick={() => setWriting(true)}
      >
        <span>
          ＋ New note<kbd>c</kbd>
        </span>
      </button>
    ) : null

  return (
    <div className='page notesp'>
      <section className='pane notes-pane' aria-label='Notes' ref={paneRef}>
        <PaneHead
          title={
            bucket === 'trash'
              ? 'Notes · Trash'
              : bucket === 'archive'
                ? 'Notes · Archive'
                : 'Notes'
          }
          meta={
            bucket === 'trash'
              ? `${inBucket.length} deleted · gone after 30 days`
              : bucket === 'archive'
                ? `${inBucket.length} archived`
                : `${inBucket.length} parked · ${inBucket.filter((note) => note.promotedTo).length} promoted`
          }
        />
        <div className='toolbar'>
          {parked ? (
            <form
              className='capture'
              autoComplete='off'
              onSubmit={(event) => {
                event.preventDefault()
                const body = capture.trim()
                if (!body) return
                start(async () => {
                  const refused = await park({
                    title: null,
                    body,
                    projectId: filedUnder?.id ?? null,
                  })
                  if (refused) toast(refused)
                  else setCapture('')
                })
              }}
            >
              <input
                ref={input}
                aria-label='Capture a note'
                placeholder={`Capture a thought… (↵ parks it${filedUnder ? ` under ${filedUnder.name}` : ''})`}
                value={capture}
                lang={isThai(capture) ? 'th' : undefined}
                onChange={(event) => setCapture(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    event.currentTarget.blur()
                  }
                }}
              />
              <button
                type='submit'
                aria-label='Add note'
                title='Add note'
                disabled={pending}
              >
                ＋
              </button>
            </form>
          ) : null}
          {/* biome-ignore lint/a11y/useSemanticElements: the filter is a group of toggle buttons */}
          <span className='who-filter' role='group' aria-label='Project'>
            <button
              type='button'
              aria-pressed={who === 'all'}
              onClick={() => setWho('all')}
            >
              All
            </button>
            {withNotes.map((project) => (
              <button
                key={project.id}
                type='button'
                aria-pressed={who === project.id}
                onClick={() => setWho(project.id)}
              >
                <Dot color={project.color} />
                <Name text={project.name} />
              </button>
            ))}
            <button
              type='button'
              aria-pressed={who === 'hq'}
              onClick={() => setWho('hq')}
            >
              Unfiled
            </button>
          </span>
          <span className='hits'>
            {shown.length} of {inBucket.length}
          </span>
          {bucket === 'trash' && inBucket.length > 0 ? (
            <Confirm
              label='Empty trash'
              question={`Delete all ${inBucket.length} ${inBucket.length === 1 ? 'note' : 'notes'} in the trash for good?`}
              yes='Empty trash'
              run={empty}
              disabled={pending}
            />
          ) : null}
        </div>
        <div className='pane-body'>
          {shown.length === 0 ? (
            <>
              {newTile ? <div className='pool'>{newTile}</div> : null}
              <Empty>
                {inBucket.length
                  ? 'No notes in this filter.'
                  : bucket === 'trash'
                    ? 'The trash is empty. Deleted notes wait here for 30 days.'
                    : bucket === 'archive'
                      ? 'Nothing archived.'
                      : 'Nothing parked. Notes stay yours; nothing here is read by an agent unless you promote it.'}
              </Empty>
            </>
          ) : props.view !== 'board' ? (
            <div className='tbl' role='listbox' aria-label='Notes'>
              <div className='tbl-head' aria-hidden='true'>
                <span className='hud-label'>note</span>
                <span className='hud-label'>project</span>
                <span className='hud-label'>
                  {bucket === 'trash'
                    ? 'deleted'
                    : bucket === 'archive'
                      ? 'archived'
                      : 'captured'}
                </span>
                <span className='hud-label'>promoted</span>
              </div>
              {shown.map((note) => {
                const to = note.promotedTo as Promoted | null
                return (
                  <button
                    key={note.id}
                    type='button'
                    role='option'
                    aria-selected={note.id === selected}
                    data-id={note.id}
                    className={`tbl-row${note.id === selected ? ' sel' : ''}${to ? ' promoted' : ''}`}
                    onClick={() => select(note.id)}
                  >
                    <span
                      className='txt'
                      lang={isThai(titleOf(note)) ? 'th' : undefined}
                    >
                      {titleOf(note)}
                    </span>
                    <span>
                      {note.projectId ? (
                        <Tag project={projectOf(note.projectId)} />
                      ) : (
                        '—'
                      )}
                    </span>
                    <span className='dim'>
                      {age(
                        (bucket === 'trash'
                          ? note.deletedAt
                          : bucket === 'archive'
                            ? note.archivedAt
                            : null) ?? note.createdAt,
                      )}{' '}
                      ago
                    </span>
                    <span className='to'>{to ? `→ ${to.type}` : ''}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className='pool' role='listbox' aria-label='Notes'>
              {newTile}
              {shown.map((note) => {
                const project = projectOf(note.projectId)
                const to = note.promotedTo as Promoted | null
                return (
                  <div
                    key={note.id}
                    className={`pcard ncard${note.id === selected ? ' sel' : ''}${to ? ' promoted' : ''}`}
                    role='option'
                    aria-selected={note.id === selected}
                    tabIndex={note.id === selected ? 0 : -1}
                    data-id={note.id}
                    style={
                      project
                        ? { ['--project' as string]: projectHex(project.color) }
                        : undefined
                    }
                    onClick={() => select(note.id)}
                    onKeyDown={(event) => {
                      if (event.key === ' ') {
                        event.preventDefault()
                        select(note.id)
                      }
                    }}
                  >
                    <div className='who'>
                      {project ? (
                        <Tag project={project} />
                      ) : (
                        <span className='tag'>HQ</span>
                      )}
                      <span>
                        {note.pinned ? '◆ pinned · ' : ''}
                        {age(note.createdAt)}
                      </span>
                    </div>
                    {note.title ? (
                      <div
                        className='t'
                        lang={isThai(note.title) ? 'th' : undefined}
                      >
                        {note.title}
                      </div>
                    ) : null}
                    <Markdown source={keepLines(excerpt(note.body))} />
                    {to ? (
                      <span className='to'>
                        → {to.type} · {to.label}
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>
      <Inspector
        id='notes'
        label='Note'
        empty={!current}
        onClose={() => select(null)}
      >
        {current ? (
          <NoteInspector
            key={`${current.id}-${current.updatedAt}`}
            note={current}
            mode={mode}
            projects={props.projects}
            targets={props.targets}
            busy={pending}
            bucket={bucket}
            onClose={() => select(null)}
            onMode={setMode}
            onChanged={(next, message) => {
              replace(next)
              setMode('read')
              if (message) toast(message)
            }}
            onDelete={() => remove(current)}
            onArchive={() => archive(current)}
            onRestore={() => restore(current)}
            asking={asking}
            onAsking={setAsking}
            onPurge={() => purgeNote(current)}
          />
        ) : (
          <>
            <InspectorHead title='Note' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>
                {parked
                  ? 'Select a note to promote, edit or delete it.'
                  : 'Select a note to read or restore it.'}
              </Empty>
            </div>
          </>
        )}
      </Inspector>
      <Modal open={writing} title='New note' onClose={() => setWriting(false)}>
        <NewNoteForm
          projects={props.projects}
          filedUnder={filedUnder?.id ?? null}
          onCancel={() => setWriting(false)}
          onCreate={async (fields) => {
            const refused = await park(fields)
            if (!refused) setWriting(false)
            return refused
          }}
        />
      </Modal>
    </div>
  )
}

/**
 * Keep's "Take a note", in the modal's form card: an optional title, the
 * note as markdown (every line stays a line), and the project it is filed
 * under — the one the filter shows, to begin with. ⌘↵ saves; ↵ in the title
 * moves on to the note.
 */
function NewNoteForm({
  projects,
  filedUnder,
  onCancel,
  onCreate,
}: {
  projects: NotesProject[]
  filedUnder: string | null
  onCancel: () => void
  onCreate: (fields: NewNote) => Promise<string | null>
}) {
  const note = useRef<HTMLTextAreaElement>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [filed, setFiled] = useState(filedUnder ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const blank = !title.trim() && !body.trim()
  return (
    <form
      className='fcard'
      autoComplete='off'
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          event.currentTarget.requestSubmit()
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault()
        if (blank || pending) return
        setPending(true)
        setError(null)
        const refused = await onCreate({
          title: title.trim() || null,
          body: body.trim(),
          projectId: filed || null,
        })
        setPending(false)
        if (refused) setError(refused)
      }}
    >
      <label>
        Title · optional
        <input
          type='text'
          maxLength={TITLE_MAX}
          placeholder='Title'
          value={title}
          lang={isThai(title) ? 'th' : undefined}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
              event.preventDefault()
              note.current?.focus()
            }
          }}
        />
      </label>
      <label>
        Note · markdown
        <textarea
          ref={note}
          data-autofocus
          rows={7}
          maxLength={BODY_MAX}
          placeholder='Take a note…'
          value={body}
          lang={isThai(body) ? 'th' : undefined}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <label>
        Filed under
        <select
          value={filed}
          onChange={(event) => setFiled(event.target.value)}
        >
          <option value=''>No project</option>
          {projects.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
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
          disabled={pending || blank}
        >
          {pending ? 'Saving…' : 'Save'}
          <kbd>⌘↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
      <p className='hint'>
        Every line stays a line; “- [ ]” starts a checklist.
      </p>
    </form>
  )
}

function NoteInspector({
  note,
  mode,
  projects,
  targets,
  busy,
  bucket,
  onClose,
  onMode,
  onChanged,
  onDelete,
  onArchive,
  onRestore,
  asking,
  onAsking,
  onPurge,
}: {
  note: Note
  mode: 'read' | 'edit' | 'promote'
  projects: NotesProject[]
  targets: NotesPageProps['targets']
  busy: boolean
  bucket: 'active' | 'archive' | 'trash'
  onClose: () => void
  onMode: (mode: 'read' | 'edit' | 'promote') => void
  onChanged: (note: Note, message?: string) => void
  onDelete: () => void
  onArchive: () => void
  onRestore: () => void
  /** Delete for good is asking (Trash only). */
  asking: boolean
  onAsking: (asking: boolean) => void
  onPurge: () => Promise<void>
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const project = projects.find((entry) => entry.id === note.projectId) ?? null
  const to = note.promotedTo as Promoted | null
  const [projectId, setProjectId] = useState(
    note.projectId ?? projects[0]?.id ?? '',
  )
  const options =
    targets.find((entry) => entry.projectId === (projectId || null))?.targets ??
    []
  const [target, setTarget] = useState(options[0]?.type ?? '')
  const activeTarget =
    options.find((entry) => entry.type === target)?.type ??
    options[0]?.type ??
    ''
  const [title, setTitle] = useState(note.title ?? '')
  const [body, setBody] = useState(note.body)
  const [filed, setFiled] = useState(note.projectId ?? '')
  const promotedProject =
    projects.find((entry) => entry.id === to?.projectId) ?? null

  return (
    <>
      <InspectorHead
        title='Note'
        meta={`${age(note.createdAt)} ago`}
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <div className='readout'>
            <div
              className='big note-text'
              lang={isThai(titleOf(note)) ? 'th' : undefined}
            >
              {titleOf(note)}
            </div>
            <div className='sub'>
              {project ? project.name : 'unfiled'}
              {to ? ' · promoted' : ''}
              {bucket === 'trash'
                ? ' · in the trash'
                : bucket === 'archive'
                  ? ' · archived'
                  : ''}
            </div>
          </div>
          <Facts
            rows={[
              [
                'captured',
                new Date(note.createdAt).toLocaleString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              ],
              ['project', project?.name ?? '—'],
              [
                'promoted',
                to
                  ? `${to.type} · ${promotedProject?.name ?? 'no project'}`
                  : '—',
              ],
            ]}
          />
        </div>
        <div className='dev-main'>
          {mode === 'edit' ? (
            <form
              className='fcard'
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  onMode('read')
                } else if (
                  event.key === 'Enter' &&
                  (event.metaKey || event.ctrlKey)
                ) {
                  event.preventDefault()
                  event.currentTarget.requestSubmit()
                }
              }}
              onSubmit={(event) => {
                event.preventDefault()
                start(async () => {
                  const result = await editNoteAction({
                    noteId: note.id,
                    title: title || null,
                    body,
                    projectId: filed || null,
                  })
                  if (result.ok) onChanged(result.data, 'Note saved')
                  else toast(result.error)
                })
              }}
            >
              <label>
                Title · optional
                <input
                  type='text'
                  maxLength={200}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                Note · markdown
                <textarea
                  // biome-ignore lint/a11y/noAutofocus: editing is what was just asked for
                  autoFocus
                  rows={7}
                  value={body}
                  lang={isThai(body) ? 'th' : undefined}
                  onChange={(event) => setBody(event.target.value)}
                />
              </label>
              <label>
                Filed under
                <select
                  value={filed}
                  onChange={(event) => setFiled(event.target.value)}
                >
                  <option value=''>No project</option>
                  {projects.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className='row'>
                <button
                  type='submit'
                  className='btn btn-pri'
                  disabled={pending}
                >
                  Save<kbd>⌘↵</kbd>
                </button>
                <button
                  type='button'
                  className='btn'
                  onClick={() => onMode('read')}
                >
                  Cancel<kbd>Esc</kbd>
                </button>
              </div>
            </form>
          ) : (
            <Markdown source={keepLines(note.body)} />
          )}
          {note.labels.length ? (
            <div className='labels'>
              {note.labels.map((label) => (
                <span key={label} className='label-chip'>
                  {label}
                </span>
              ))}
            </div>
          ) : null}
          {to ? (
            <div className='promote'>
              <span className='hud-label'>Promoted</span>
              <p className='hint'>
                This note became a <b>{to.type}</b>
                {promotedProject ? ` in ${promotedProject.name}` : ''}. It stays
                here, linked.
              </p>
              <div className='row'>
                {to.href ? (
                  <Link className='btn btn-sm' href={to.href}>
                    Open<kbd>↵</kbd>
                  </Link>
                ) : null}
                <button
                  type='button'
                  className='btn btn-sm'
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const result = await unlinkNoteAction(note.id)
                      if (result.ok)
                        onChanged(
                          result.data,
                          'Unlinked — the note and what it became both stay',
                        )
                      else toast(result.error)
                    })
                  }
                >
                  Unlink
                </button>
              </div>
            </div>
          ) : mode === 'promote' ? (
            <form
              className='promote'
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  onMode('read')
                }
              }}
              onSubmit={(event) => {
                event.preventDefault()
                if (!activeTarget) return
                start(async () => {
                  const result = await promoteNoteAction({
                    noteId: note.id,
                    projectId: projectId || null,
                    target: activeTarget,
                  })
                  if (result.ok) {
                    const label =
                      options.find((entry) => entry.type === activeTarget)
                        ?.label ?? activeTarget
                    onChanged(
                      result.data.note,
                      `Promoted to ${label}${projectId ? ` in ${projects.find((entry) => entry.id === projectId)?.name ?? ''}` : ''}`,
                    )
                  } else toast(result.error)
                })
              }}
            >
              <span className='hud-label'>Promote →</span>
              <label>
                Project
                <select
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  {projects.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                  <option value=''>No project (floating)</option>
                </select>
              </label>
              <label>
                Target
                <select
                  // biome-ignore lint/a11y/noAutofocus: choosing the target is the next step
                  autoFocus
                  value={activeTarget}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  {options.map((entry) => (
                    <option key={entry.type} value={entry.type}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              {options.length === 0 ? (
                <p className='hint'>
                  Nothing in this project can take a note — turn on Board,
                  Prompts or Calendar for it.
                </p>
              ) : null}
              <div className='row'>
                <button
                  type='submit'
                  className='btn btn-pri'
                  disabled={pending || !activeTarget}
                >
                  {pending ? 'Promoting…' : 'Promote'}
                  <kbd>↵</kbd>
                </button>
                <button
                  type='button'
                  className='btn'
                  onClick={() => onMode('read')}
                >
                  Cancel<kbd>Esc</kbd>
                </button>
              </div>
              <p className='hint'>
                The note stays here, linked to what it becomes.
              </p>
            </form>
          ) : null}
          {bucket !== 'active' ? (
            <div className='dev-acts'>
              <button
                type='button'
                className='btn btn-pri'
                disabled={busy}
                onClick={onRestore}
              >
                Restore<kbd>r</kbd>
              </button>
              {bucket === 'trash' ? (
                <Confirm
                  label='Delete for good'
                  kbd='⌫'
                  question='Delete this note for good?'
                  yes='Delete for good'
                  run={onPurge}
                  small={false}
                  disabled={busy}
                  asking={asking}
                  onAsking={onAsking}
                />
              ) : null}
            </div>
          ) : (
            <div className='dev-acts'>
              {!to && mode !== 'promote' ? (
                <button
                  type='button'
                  className='btn btn-pri'
                  onClick={() => onMode('promote')}
                >
                  Promote<kbd>p</kbd>
                </button>
              ) : null}
              {mode !== 'edit' ? (
                <button
                  type='button'
                  className='btn'
                  onClick={() => onMode('edit')}
                >
                  Edit<kbd>e</kbd>
                </button>
              ) : null}
              <button
                type='button'
                className='btn'
                disabled={busy}
                onClick={onArchive}
              >
                Archive
              </button>
              <button
                type='button'
                className='btn'
                disabled={busy}
                onClick={onDelete}
              >
                Delete<kbd>⌫</kbd>
              </button>
            </div>
          )}
          {project ? (
            <div className='insp-links'>
              <Link className='btn btn-sm' href={`/p/${project.slug}`}>
                <Tag project={project} />
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}
