'use client'

import {
  canDisable,
  canEnable,
  DEFAULT_MODULES,
  KIND_LABEL,
  MODULES,
  type ModuleId,
  orderedModules,
  PROJECT_KINDS,
  PROJECT_MODULES,
  type ProjectKind,
} from '@theiceji/hq-core/modules'
import {
  PROJECT_COLOR_NAMES,
  PROJECT_COLORS,
  type ProjectColor,
} from '@theiceji/hq-db/enums'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import {
  createProjectAction,
  deleteProjectAction,
  restoreProjectAction,
  setModuleAction,
  setProjectStatusAction,
  updateProjectAction,
} from '@/app/(app)/projects/actions'
import type { ActionResult } from '@/lib/actions'
import { Inspector, usePageKeys } from '../bridge/parts'
import { Icon } from '../shell/Icon'
import { usePageKeyHints } from '../shell/keys'
import { useToast } from '../Toast'

export type ProjectsViewName = 'active' | 'archived' | 'trash'

export type ProjectRowView = {
  id: string
  slug: string
  name: string
  kind: ProjectKind
  status: 'active' | 'paused' | 'archived'
  color: string
  revision: number
  enabled: string[]
  storageProvider: 'r2' | 'gdrive' | null
  storageRoot: string | null
  timezone: string
  currency: string
  waiting: number
  /** In the Trash since (ISO); null for a project that isn't. */
  deletedAt: string | null
}

type Status = ProjectRowView['status']

const isThai = (text: string) => /\p{Script=Thai}/u.test(text)
const hex = (color: string) =>
  PROJECT_COLORS[color as ProjectColor] ?? PROJECT_COLORS.grey
const short = (name: string) =>
  name.length > 40 ? `${name.slice(0, 39)}…` : name

function Dot({ color }: { color: string }) {
  return (
    <i
      className='dot'
      style={{ ['--project' as string]: hex(color) }}
      aria-hidden='true'
    />
  )
}

function Name({ name }: { name: string }) {
  return <span lang={isThai(name) ? 'th' : undefined}>{name}</span>
}

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')

/** `3 Sep 2026` — spelled here, so the server and the browser agree. */
function dayLabel(iso: string): string {
  const date = new Date(iso)
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

/** What each view is, in one quiet sentence. */
const VIEW_NOTE: Record<ProjectsViewName, string | null> = {
  active: null,
  archived:
    'Put away: off the rail and Home, every record kept. Restore brings one back.',
  trash:
    'Deleted: off every list, picker and total, every record kept. Restore brings one back archived.',
}

/**
 * Projects:
 * Table + Inspector, like the Inbox. The table is the owner's order; the
 * inspector creates a project or shapes the selected one — status, modules as
 * switches that say in words why one can't move, storage, name and colour.
 * Delete (`⌫`) puts a project in the Trash with Undo; nothing it holds is
 * removed, and Restore (`r`) brings it back.
 * Keys: c new · ↑ ↓ j k rows · ↵ open · p pause · ⌫ delete · r restore ·
 * Esc close.
 *
 * The selected row (`?id=`), the new-project form (`?new=1`) and the notice
 * after a stale link (`?missing=1`) are this view's own state in the URL:
 * moving through the rows never asks the server for the page again. Only
 * Active · Archived · Trash (`?view=`) reads different rows.
 */
export function ProjectsView({
  projects,
  counts,
  view,
}: {
  projects: ProjectRowView[]
  counts: Record<ProjectsViewName, number>
  view: ProjectsViewName
}) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const toast = useToast()
  const creating = search.get('new') === '1'
  const selectedId = search.get('id')
  const missing = search.get('missing') === '1'
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  // The revision each write answered with: a key pressed before the page's
  // own re-render lands still writes at the project's latest revision.
  const [written, setWritten] = useState<Record<string, number>>({})
  const shown = useMemo(
    () =>
      projects.filter(
        (project) =>
          !filter || project.name.toLowerCase().includes(filter.toLowerCase()),
      ),
    [projects, filter],
  )

  // Nothing is chosen until you pick (or a link names a row).
  const selected = shown.find((project) => project.id === selectedId) ?? null

  // A new selection starts without the last one's refusal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection is the trigger
  useEffect(() => setError(null), [selected?.id])

  const go = (params: Record<string, string | null>) => {
    const next = new URLSearchParams()
    if (view !== 'active') next.set('view', view)
    for (const [key, value] of Object.entries(params))
      if (value !== null) next.set(key, value)
    const query = next.toString()
    window.history.replaceState(
      null,
      '',
      query ? `${pathname}?${query}` : pathname,
    )
  }

  const revisionOf = (project: ProjectRowView) =>
    Math.max(project.revision, written[project.id] ?? 0)
  const wrote = (id: string, revision: number) =>
    setWritten((map) => ({ ...map, [id]: revision }))

  /** One write with its toast; a refusal shows in the inspector. */
  const run = <T extends { revision: number }>(
    project: ProjectRowView,
    work: (revision: number) => Promise<ActionResult<T>>,
    after: (data: T) => void,
  ) => {
    setError(null)
    start(async () => {
      const result = await work(revisionOf(project))
      if (!result.ok) {
        setError(result.error)
        return
      }
      wrote(project.id, result.data.revision)
      after(result.data)
    })
  }

  /** The inverse write behind a toast's Undo. */
  const undoWith =
    (
      project: ProjectRowView,
      inverse: (
        revision: number,
      ) => Promise<ActionResult<{ revision: number }>>,
      revision: number,
      then?: () => void,
    ) =>
    async () => {
      const back = await inverse(revision)
      if (!back.ok) {
        // After the Undo toast closes, so the refusal stays on screen.
        setTimeout(() => toast(back.error))
        return
      }
      wrote(project.id, back.data.revision)
      then?.()
    }

  /** The row to select once this one leaves the view. */
  const neighbour = (project: ProjectRowView) => {
    const index = shown.findIndex((entry) => entry.id === project.id)
    return shown[index + 1]?.id ?? shown[index - 1]?.id ?? null
  }

  const setStatus = (
    project: ProjectRowView,
    status: Status,
    revision: number,
  ) =>
    setProjectStatusAction({
      projectId: project.id,
      expectedRevision: revision,
      status,
    })

  const pauseResume = (project: ProjectRowView) => {
    if (project.status === 'archived') return
    const next: Status = project.status === 'paused' ? 'active' : 'paused'
    run(
      project,
      (revision) => setStatus(project, next, revision),
      (data) =>
        toast(
          next === 'paused'
            ? `Paused: ${short(project.name)} — dimmed on Home, still working`
            : `Resumed: ${short(project.name)}`,
          {
            undo: undoWith(
              project,
              (revision) => setStatus(project, project.status, revision),
              data.revision,
            ),
          },
        ),
    )
  }

  const archive = (project: ProjectRowView) => {
    const after = neighbour(project)
    run(
      project,
      (revision) => setStatus(project, 'archived', revision),
      (data) => {
        go({ id: after })
        toast(
          `Archived: ${short(project.name)} — off the rail and Home, every record kept`,
          {
            undo: undoWith(
              project,
              (revision) => setStatus(project, project.status, revision),
              data.revision,
              () => go({ id: project.id }),
            ),
          },
        )
      },
    )
  }

  /** Delete: to the Trash, with Undo — nothing it holds is removed. */
  const remove = (project: ProjectRowView) => {
    if (project.deletedAt) return
    const after = neighbour(project)
    run(
      project,
      (revision) =>
        deleteProjectAction({
          projectId: project.id,
          expectedRevision: revision,
        }),
      (data) => {
        go({ id: after })
        toast(
          `Deleted: ${short(project.name)} — in the Trash, every record kept`,
          {
            undo: undoWith(
              project,
              (revision) =>
                restoreProjectAction({
                  projectId: project.id,
                  expectedRevision: revision,
                  status: project.status,
                }),
              data.revision,
              () => go({ id: project.id }),
            ),
          },
        )
      },
    )
  }

  /** Restore: out of Archived to active, or out of the Trash to Archived. */
  const restore = (project: ProjectRowView) => {
    const after = neighbour(project)
    if (project.deletedAt)
      run(
        project,
        (revision) =>
          restoreProjectAction({
            projectId: project.id,
            expectedRevision: revision,
          }),
        (data) => {
          go({ id: after })
          toast(`Restored: ${short(project.name)} — back in Archived`, {
            undo: undoWith(
              project,
              (revision) =>
                deleteProjectAction({
                  projectId: project.id,
                  expectedRevision: revision,
                }),
              data.revision,
              () => go({ id: project.id }),
            ),
          })
        },
      )
    else if (project.status === 'archived')
      run(
        project,
        (revision) => setStatus(project, 'active', revision),
        (data) => {
          go({ id: after })
          toast(`Restored: ${short(project.name)} — back on the rail`, {
            undo: undoWith(
              project,
              (revision) => setStatus(project, 'archived', revision),
              data.revision,
              () => go({ id: project.id }),
            ),
          })
        },
      )
  }

  const switchModule = (project: ProjectRowView, id: ModuleId, on: boolean) =>
    run(
      project,
      (revision) =>
        setModuleAction({
          projectId: project.id,
          expectedRevision: revision,
          module: id,
          on,
        }),
      (data) =>
        toast(
          on
            ? `${MODULES[id].label} on for ${short(project.name)}`
            : `${MODULES[id].label} off for ${short(project.name)} — its records stay`,
          {
            undo: undoWith(
              project,
              (revision) =>
                setModuleAction({
                  projectId: project.id,
                  expectedRevision: revision,
                  module: id,
                  on: !on,
                }),
              data.revision,
            ),
          },
        ),
    )

  const update = (
    project: ProjectRowView,
    change: {
      name?: string
      color?: string
      storageProvider?: 'r2' | 'gdrive' | null
    },
    message: string,
  ) =>
    run(
      project,
      (revision) =>
        updateProjectAction({
          projectId: project.id,
          expectedRevision: revision,
          ...change,
        }),
      () => toast(message),
    )

  usePageKeyHints(
    view === 'trash'
      ? [
          ['r', 'restore'],
          ['↑ ↓ j k', 'projects'],
          ['c', 'new project'],
          ['Esc', 'close'],
        ]
      : view === 'archived'
        ? [
            ['r', 'restore'],
            ['↵', 'open'],
            ['⌫', 'delete'],
            ['↑ ↓ j k', 'projects'],
            ['c', 'new project'],
            ['Esc', 'close'],
          ]
        : [
            ['c', 'new project'],
            ['↵', 'open'],
            ['p', 'pause · resume'],
            ['⌫', 'delete'],
            ['↑ ↓ j k', 'projects'],
            ['Esc', 'close'],
          ],
  )

  usePageKeys((key, event) => {
    // ↵ on a focused inspector button presses that button (Delete, Archive…),
    // never Open.
    if (
      key === 'Enter' &&
      (event.target as HTMLElement | null)?.closest?.('.inspector')
    )
      return false
    if (key === 'Escape') {
      if (creating || selected) {
        go({})
        return true
      }
      return false
    }
    if (key === 'c') {
      go({ new: '1' })
      return true
    }
    const index = shown.findIndex((project) => project.id === selected?.id)
    if (key === 'ArrowDown' || key === 'j') {
      const next = shown[Math.min(shown.length - 1, index + 1)]
      if (next) go({ id: next.id })
      return Boolean(next)
    }
    if (key === 'ArrowUp' || key === 'k') {
      const next = shown[Math.max(0, index - 1)]
      if (next) go({ id: next.id })
      return Boolean(next)
    }
    if (!selected || creating || pending) return false
    if (key === 'Enter' && view !== 'trash') {
      router.push(`/p/${selected.slug}`)
      return true
    }
    if (key === 'p' && view === 'active') {
      pauseResume(selected)
      return true
    }
    if ((key === 'Backspace' || key === 'Delete') && view !== 'trash') {
      remove(selected)
      return true
    }
    if (key === 'r' && view !== 'active') {
      restore(selected)
      return true
    }
    return false
  })

  return (
    <div className='page projectsp'>
      <section className='pane list-pane' aria-label='Projects'>
        <header className='pane-head'>
          <span className='hud-label'>
            {view === 'trash'
              ? 'Projects · Trash'
              : view === 'archived'
                ? 'Projects · Archived'
                : 'Projects'}
          </span>
          <span className='dim'>
            {view === 'trash'
              ? `${counts.trash} deleted · restore any time`
              : view === 'archived'
                ? `${counts.archived} archived`
                : `${counts.active} · in your order`}
          </span>
        </header>
        {missing ? (
          <p className='notice-missing' role='status'>
            That project isn’t here — it may be in the Trash, or the link is
            old.
            {counts.trash > 0 && view !== 'trash' ? (
              <>
                {' '}
                <Link href='/projects?view=trash'>Open the Trash</Link>
              </>
            ) : null}
          </p>
        ) : null}
        <div className='toolbar'>
          <input
            type='search'
            placeholder='Filter projects'
            aria-label='Filter projects'
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <span className='sp' />
          <span className='hits'>
            {shown.length} of {projects.length}
          </span>
          <button
            type='button'
            className='btn btn-pri'
            onClick={() => go({ new: '1' })}
          >
            New project<kbd>c</kbd>
          </button>
        </div>
        {VIEW_NOTE[view] ? (
          <p className='view-note'>{VIEW_NOTE[view]}</p>
        ) : null}
        <div className='pane-body'>
          {shown.length === 0 ? (
            <div className='empty'>
              {filter
                ? `○ nothing matches “${filter}”`
                : view !== 'active'
                  ? '○ nothing here'
                  : '○ no projects yet — press c to start one'}
            </div>
          ) : (
            // A list of buttons laid out as a table; each button reads as one sentence.
            <div className='tbl proj-tbl'>
              <div className='tbl-head' aria-hidden='true'>
                <span>Project</span>
                <span className='c-hide'>Kind</span>
                <span className='c-hide'>Modules</span>
                <span>Status</span>
                <span className='num'>◆</span>
              </div>
              {shown.map((project) => {
                const modules = orderedModules(project.kind, project.enabled)
                const current = project.id === selected?.id && !creating
                const state = project.deletedAt ? 'deleted' : project.status
                return (
                  <button
                    key={project.id}
                    type='button'
                    className={`tbl-row${current ? ' sel' : ''}${project.status === 'paused' ? ' dim' : ''}`}
                    aria-pressed={current}
                    aria-label={`${project.name}, ${KIND_LABEL[project.kind]}, ${state}, ${project.waiting} waiting — select to shape it${project.deletedAt ? '' : '; double-click to open'}`}
                    onClick={() => go({ id: project.id })}
                    onDoubleClick={() => {
                      if (!project.deletedAt) router.push(`/p/${project.slug}`)
                    }}
                  >
                    <span className='nm'>
                      <Dot color={project.color} />
                      <Name name={project.name} />
                      <span className='slug'>/p/{project.slug}</span>
                    </span>
                    <span className='c-hide'>{KIND_LABEL[project.kind]}</span>
                    <span
                      className='glyphs c-hide'
                      title={modules.map((id) => MODULES[id].label).join(' · ')}
                    >
                      {modules.map((id) => MODULES[id].glyph).join('')}
                    </span>
                    <span
                      className={`state-word${project.status === 'active' ? ' live' : ''}`}
                    >
                      {state}
                    </span>
                    <span
                      className={`num${project.waiting > 0 ? ' wait' : ''}`}
                    >
                      {project.waiting > 0 ? `◆ ${project.waiting}` : '0'}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </section>
      <Inspector
        id='projects'
        label={creating ? 'New project' : 'Selected project'}
        empty={!creating && !selected}
        onClose={() => go({})}
      >
        {creating ? (
          <NewProject
            onClose={() => go({})}
            onCreated={(slug, name) => {
              toast(`Created: ${short(name)} — /p/${slug}`)
              router.push(`/p/${slug}`)
            }}
          />
        ) : selected ? (
          <ProjectInspector
            key={`${selected.id}:${selected.revision}`}
            project={selected}
            pending={pending}
            error={error}
            onClose={() => go({})}
            onPause={() => pauseResume(selected)}
            onArchive={() => archive(selected)}
            onDelete={() => remove(selected)}
            onRestore={() => restore(selected)}
            onModule={(id, on) => switchModule(selected, id, on)}
            onUpdate={(change, message) => update(selected, change, message)}
          />
        ) : (
          <>
            <header className='pane-head'>
              <span className='hud-label'>Project</span>
              <span className='dim'>nothing selected</span>
            </header>
            <div className='insp-body'>
              <div className='empty'>
                {view === 'active'
                  ? 'Select a project to shape it here.'
                  : 'Select a project to restore it.'}
              </div>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

function InspectorHead({
  title,
  meta,
  onClose,
  close,
}: {
  title: React.ReactNode
  meta: string
  onClose: () => void
  close: boolean
}) {
  return (
    <header className='pane-head'>
      <span className='hud-label'>{title}</span>
      <span className='dim'>{meta}</span>
      {close ? (
        <button
          type='button'
          className='iconbtn'
          style={{ width: 22, height: 22 }}
          aria-label='Close (Esc)'
          title='Close (Esc)'
          onClick={onClose}
        >
          <Icon name='close' size={14} />
        </button>
      ) : null}
    </header>
  )
}

function NewProject({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (slug: string, name: string) => void
}) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ProjectKind>('freelance')
  const [color, setColor] = useState<ProjectColor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const defaults = DEFAULT_MODULES[kind]
  return (
    <>
      <InspectorHead title='New project' meta='c' onClose={onClose} close />
      <div className='insp-body'>
        <div className='dev-read'>
          <div className='readout'>
            <div className='big dim'>{name.trim() || 'untitled'}</div>
            <div className='sub'>
              {KIND_LABEL[kind]} · starts with {defaults.length} modules
            </div>
          </div>
        </div>
        <div className='dev-main'>
          <form
            className='fcard'
            onSubmit={(event) => {
              event.preventDefault()
              setError(null)
              start(async () => {
                const result = await createProjectAction({ name, kind, color })
                if (result.ok) onCreated(result.data.slug, name.trim())
                else setError(result.error)
              })
            }}
          >
            <label>
              Name
              <input
                ref={input}
                type='text'
                value={name}
                autoComplete='off'
                required
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              Kind
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as ProjectKind)}
              >
                {PROJECT_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {KIND_LABEL[value]}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span className='fld-label'>Colour</span>
              {/* biome-ignore lint/a11y/useSemanticElements: a swatch picker is a group of toggle buttons, not a fieldset */}
              <div className='swatches' role='group' aria-label='Colour'>
                {PROJECT_COLOR_NAMES.map((value) => (
                  <button
                    key={value}
                    type='button'
                    aria-pressed={color === value}
                    aria-label={`Colour ${value}`}
                    title={value}
                    style={{ ['--project' as string]: hex(value) }}
                    onClick={() => setColor(value)}
                  >
                    <i className='dot' />
                  </button>
                ))}
              </div>
            </div>
            <p className='hint'>
              It starts with{' '}
              {defaults.map((id) => MODULES[id].label).join(' · ')}.
              {color
                ? ''
                : ' It takes the next unused colour unless you pick one.'}{' '}
              Change them any time.
            </p>
            {error ? (
              <p className='err' role='alert'>
                {error}
              </p>
            ) : null}
            <div className='row'>
              <button
                type='submit'
                className='btn btn-pri'
                disabled={pending || !name.trim()}
              >
                {pending ? 'Creating…' : 'Create'}
                <kbd>↵</kbd>
              </button>
              <button type='button' className='btn' onClick={onClose}>
                Cancel<kbd>Esc</kbd>
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}

function ProjectInspector({
  project,
  pending,
  error,
  onClose,
  onPause,
  onArchive,
  onDelete,
  onRestore,
  onModule,
  onUpdate,
}: {
  project: ProjectRowView
  pending: boolean
  error: string | null
  onClose: () => void
  onPause: () => void
  onArchive: () => void
  onDelete: () => void
  onRestore: () => void
  onModule: (id: ModuleId, on: boolean) => void
  onUpdate: (
    change: {
      name?: string
      color?: string
      storageProvider?: 'r2' | 'gdrive' | null
    },
    message: string,
  ) => void
}) {
  // What the page re-renders with after each write; these only hold the
  // owner's choice until it does.
  const [name, setName] = useState(project.name)
  const [color, setColor] = useState(project.color)
  const [storage, setStorage] = useState<'default' | 'r2' | 'gdrive'>(
    project.storageProvider ?? 'default',
  )
  const enabled = project.enabled
  const trashed = Boolean(project.deletedAt)
  const archived = project.status === 'archived'

  const storageLabel =
    project.storageProvider === 'gdrive'
      ? 'Google Drive'
      : project.storageProvider === 'r2'
        ? 'R2'
        : 'default · R2'

  return (
    <>
      <InspectorHead
        title={
          <span className='tag'>
            <Dot color={project.color} />
            <Name name={project.name} />
          </span>
        }
        meta={KIND_LABEL[project.kind]}
        onClose={onClose}
        close
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <div className='readout'>
            <div className={`big ${project.waiting > 0 ? 'wait' : 'dim'}`}>
              {project.waiting > 0 ? `◆ ${project.waiting}` : '0'}
            </div>
            <div className='sub'>
              {project.waiting > 0 ? 'waiting for you' : 'nothing waiting'}
            </div>
          </div>
          <dl className='facts'>
            <dt>address</dt>
            <dd>/p/{project.slug}</dd>
            <dt>modules</dt>
            <dd>{enabled.length}</dd>
            <dt>status</dt>
            <dd>
              {project.deletedAt
                ? `in the Trash since ${dayLabel(project.deletedAt)}`
                : project.status}
            </dd>
            <dt>storage</dt>
            <dd>{storageLabel}</dd>
            <dt>clock</dt>
            <dd>
              {project.timezone} · {project.currency}
            </dd>
          </dl>
        </div>
        <div className='dev-main'>
          <div className='dev-acts'>
            {trashed ? (
              <button
                type='button'
                className='btn btn-pri'
                disabled={pending}
                onClick={onRestore}
              >
                Restore<kbd>r</kbd>
              </button>
            ) : (
              <>
                <Link className='btn btn-pri' href={`/p/${project.slug}`}>
                  Open<kbd>↵</kbd>
                </Link>
                {archived ? (
                  <button
                    type='button'
                    className='btn'
                    disabled={pending}
                    onClick={onRestore}
                  >
                    Restore<kbd>r</kbd>
                  </button>
                ) : (
                  <>
                    <button
                      type='button'
                      className='btn'
                      disabled={pending}
                      onClick={onPause}
                    >
                      {project.status === 'paused' ? 'Resume' : 'Pause'}
                      <kbd>p</kbd>
                    </button>
                    <button
                      type='button'
                      className='btn'
                      disabled={pending}
                      onClick={onArchive}
                    >
                      Archive
                    </button>
                  </>
                )}
                <button
                  type='button'
                  className='btn'
                  disabled={pending}
                  onClick={onDelete}
                >
                  Delete<kbd>⌫</kbd>
                </button>
              </>
            )}
          </div>
          <p className='hint'>
            {trashed
              ? 'In the Trash: off every list, picker and total, and /p/ doesn’t open it. Every card, file and money record is kept. Restore brings it back archived; its address waits for it.'
              : 'Delete moves it to the Trash, off every list and picker. Every card, file and money record is kept, and Restore brings it back.'}
          </p>
          {error ? (
            <p className='why' role='alert'>
              <b>Didn’t change:</b> {error}
            </p>
          ) : null}
          <div className='fcard'>
            <span className='fld-label'>Modules</span>
            <div className='mod-list'>
              {PROJECT_MODULES.map((id: ModuleId) => {
                const on = enabled.includes(id)
                const check = on
                  ? canDisable(enabled, id)
                  : canEnable(project.kind, enabled, id)
                const why = check.ok ? null : check.reason
                return (
                  <div key={id} className={`mod-row${on ? '' : ' off'}`}>
                    <span className='g' aria-hidden='true'>
                      {MODULES[id].glyph}
                    </span>
                    <span className='n'>{MODULES[id].label}</span>
                    <button
                      type='button'
                      className='switch'
                      aria-pressed={on}
                      aria-label={`${MODULES[id].label} ${on ? 'on' : 'off'}`}
                      disabled={Boolean(why) || pending || archived}
                      onClick={() => onModule(id, !on)}
                    />
                    {why ? <p className='why-not'>{why}</p> : null}
                  </div>
                )
              })}
            </div>
            <p className='hint'>
              Off keeps every record; the module just stops showing.
            </p>
          </div>
          <div className='fcard'>
            <span className='fld-label'>Storage</span>
            {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons, not a fieldset */}
            <span className='seg' role='group' aria-label='Storage'>
              {(
                [
                  ['default', 'Default'],
                  ['r2', 'R2'],
                  ['gdrive', 'Google Drive'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type='button'
                  aria-pressed={storage === value}
                  disabled={pending || archived}
                  onClick={() => {
                    setStorage(value)
                    onUpdate(
                      { storageProvider: value === 'default' ? null : value },
                      `Storage for ${short(project.name)}: ${value === 'default' ? 'the default' : label} — old files stay where they are`,
                    )
                  }}
                >
                  {label}
                </button>
              ))}
            </span>
            <p className='hint'>
              Changing it doesn’t move old files — each asset remembers where it
              lives.
            </p>
          </div>
          <form
            className='fcard'
            onSubmit={(event) => {
              event.preventDefault()
              onUpdate(
                { name, color },
                `Saved: ${short(name.trim() || project.name)}`,
              )
            }}
          >
            <label>
              Name
              <input
                type='text'
                value={name}
                maxLength={120}
                disabled={archived}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div>
              <span className='fld-label'>Colour</span>
              {/* biome-ignore lint/a11y/useSemanticElements: a swatch picker is a group of toggle buttons, not a fieldset */}
              <div className='swatches' role='group' aria-label='Colour'>
                {PROJECT_COLOR_NAMES.map((value) => (
                  <button
                    key={value}
                    type='button'
                    aria-pressed={color === value}
                    aria-label={`Colour ${value}`}
                    title={value}
                    style={{ ['--project' as string]: hex(value) }}
                    disabled={archived}
                    onClick={() => setColor(value)}
                  >
                    <i className='dot' />
                  </button>
                ))}
              </div>
            </div>
            <div className='row'>
              <button
                type='submit'
                className='btn'
                disabled={
                  pending ||
                  archived ||
                  (name === project.name && color === project.color)
                }
              >
                Save<kbd>↵</kbd>
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
