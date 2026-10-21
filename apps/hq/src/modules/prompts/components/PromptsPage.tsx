'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { MoreMenu } from '@/components/bridge/MoreMenu'
import {
  age,
  Dot,
  Empty,
  Inspector,
  InspectorHead,
  isThai,
  PaneHead,
  Tag,
  usePageKeys,
} from '@/components/bridge/parts'
import { Modal } from '@/components/Modal'
import { usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import type { GeneratorOption } from '@/lib/generators'
import {
  archivePromptAction,
  deletePromptAction,
  editPromptDetailsAction,
  promptAction,
  savePromptAction,
} from '../actions'
import type { LibrarySlotData, PromptData, PromptProject } from '../data'
import { Examples } from './Examples'
import { LibraryPage } from './LibraryPage'
import { PromptText, TextForm } from './PromptText'
import { chipMenuId, fillFrom, type Mode, PreviewThumb } from './parts'

/**
 * Prompts: a project's prompts as a
 * Grid or a List, beside a viewer/editor.
 *
 * A prompt has one text, a template (2026-09-30): `<HAIR_COLOR>` is a
 * variant, and its options — a short key picked by name, the value that goes
 * into the text — are the prompt's own and the library's. Copy `y` puts the
 * text in with every variant picked; an example keeps the picks it was made
 * with. Copy and Edit `e` sit on the text's head, ＋ Attach `a` as the
 * examples' last tile; the prompt's ⋯ on the inspector head holds Edit
 * details `d`, Archive, then Delete `⌫` (each with Undo).
 * Keys are in each button's tooltip, the menus, the footer and `?`, not on
 * the buttons. New prompt `c` — the Grid's dashed first tile, or the toolbar
 * — is a modal, as Notes' New note is. Examples are square, the result
 * cropped to fill. Archived and Trash list what was put away or deleted,
 * with Restore `r`. Taking an example off can't be undone, so it asks in
 * place.
 *
 * The text is the picker: each variant is a chip in the sentence that opens its
 * options (`PromptText`). Examples show All by default, each tagged with its
 * keys; Matching narrows them to the picks of now (`Examples`). The library
 * of variants is its own view, Variants (`LibraryPage`).
 */

type Bucket = 'live' | 'archived' | 'trash'

export type PromptsPageProps = {
  project: PromptProject | null
  projects: PromptProject[]
  prompts: PromptData[]
  total: number
  collections: { name: string; count: number }[]
  view: 'grid' | 'list' | 'library' | 'archived' | 'trash'
  /** The library of variants, on the Variants view. */
  library: LibrarySlotData[]
  selectedId: string | null
  /** The selected prompt, read whole on the server. */
  full: PromptData | null
  creating: boolean
  /** The owner's generators, for Generate with… */
  generators: GeneratorOption[]
}

const MEDIA = ['image', 'video', 'text', 'audio'] as const
const LIMIT = 60

export function PromptsPage(props: PromptsPageProps) {
  if (props.view === 'library') return <LibraryPage slots={props.library} />
  return <PromptsPool {...props} />
}

function PromptsPool(props: PromptsPageProps) {
  const toast = useToast()
  const [prompts, setPrompts] = useState(props.prompts)
  const [selected, setSelected] = useState<string | null>(props.selectedId)
  const [full, setFull] = useState<PromptData | null>(props.full)
  /** What's picked for each prompt's variants, kept while you move between prompts. */
  const [picksOf, setPicksOf] = useState<
    Record<string, Record<string, string>>
  >({})
  const [query, setQuery] = useState('')
  const [medium, setMedium] = useState<'all' | (typeof MEDIA)[number]>('all')
  const [collection, setCollection] = useState('all')
  const [who, setWho] = useState('all')
  const [mode, setMode] = useState<Mode>('read')
  const [writing, setWriting] = useState(false)
  const [busy, start] = useTransition()
  const paneRef = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const all = props.project === null
  const bucket: Bucket =
    props.view === 'archived' || props.view === 'trash' ? props.view : 'live'
  const live = bucket === 'live'

  useEffect(() => setPrompts(props.prompts), [props.prompts])

  // `?new=1` opens New prompt as `c` would, and the flag leaves the URL at
  // once (no history entry), so a reload doesn't open it again.
  useEffect(() => {
    if (!props.creating) return
    const url = new URL(window.location.href)
    url.searchParams.delete('new')
    window.history.replaceState(null, '', url)
    setWriting(true)
  }, [props.creating])

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase()
    return prompts.filter(
      (prompt) =>
        (!all ||
          who === 'all' ||
          (who === 'hq' ? !prompt.projectId : prompt.projectId === who)) &&
        (medium === 'all' || prompt.medium === medium) &&
        (collection === 'all' ||
          (collection === 'unsorted'
            ? !prompt.collection
            : prompt.collection === collection)) &&
        (!words ||
          `${prompt.title} ${prompt.tags.join(' ')} ${prompt.intent}`
            .toLowerCase()
            .includes(words)),
    )
  }, [prompts, all, who, medium, collection, query])
  const visible = shown.slice(0, LIMIT)
  const row = prompts.find((prompt) => prompt.id === selected) ?? null

  // The viewer reads the whole prompt (every variant, every example) on selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch on a new selection only — `full` is what it fills
  useEffect(() => {
    if (!selected) {
      setFull(null)
      return
    }
    if (full?.id === selected) return
    let alive = true
    promptAction(selected).then((result) => {
      if (!alive) return
      if (result.ok) setFull(result.data)
      else toast(result.error)
    })
    return () => {
      alive = false
    }
  }, [selected, toast])

  const prompt = full && full.id === selected ? full : null
  const picks = (selected && picksOf[selected]) || {}
  const pick = (name: string, optionId: string | null) => {
    if (!selected) return
    setPicksOf((all) => {
      const next = { ...all[selected] }
      if (optionId) next[name] = optionId
      else delete next[name]
      return { ...all, [selected]: next }
    })
  }

  const select = useCallback((id: string | null, focus = false) => {
    setSelected(id)
    setMode('read')
    const url = new URL(window.location.href)
    url.searchParams.delete('new')
    if (id) url.searchParams.set('prompt', id)
    else url.searchParams.delete('prompt')
    window.history.replaceState(null, '', url)
    if (focus && id)
      requestAnimationFrame(() => {
        const element = paneRef.current?.querySelector<HTMLElement>(
          `[data-id="${id}"]`,
        )
        element?.focus({ preventScroll: true })
        element?.scrollIntoView({ block: 'nearest' })
      })
  }, [])

  /** A saved prompt replaces its row and the viewer's copy. */
  const saved = (next: PromptData, message?: string) => {
    setFull(next)
    setPrompts((list) => {
      const row = { ...next, text: null, slots: null }
      return list.some((entry) => entry.id === next.id)
        ? list.map((entry) => (entry.id === next.id ? row : entry))
        : [row, ...list]
    })
    if (message) toast(message)
  }

  /** Copy `y`: the text with every variant picked — never with a `<NAME>` left in it. */
  const copy = async () => {
    if (!prompt?.text) return
    const filled = fillFrom(prompt, picks)
    if (filled.missing.length) {
      // The first variant still to pick takes the focus: ↵ opens its options.
      document
        .querySelector<HTMLElement>(
          `[popovertarget="${chipMenuId(filled.missing[0] as string)}"]`,
        )
        ?.focus()
      return toast(`Pick ${filled.missing.join(', ')} first`)
    }
    try {
      await navigator.clipboard.writeText(filled.text)
      toast(
        `Copied${filled.keys.length ? ` · ${filled.keys.join(' · ')}` : ''} · ${filled.text.length} chars`,
      )
    } catch {
      toast('The browser didn’t allow copying. Select the text instead.')
    }
  }

  /** A prompt leaves this view; its neighbour is selected. */
  const drop = (id: string) => {
    const index = visible.findIndex((entry) => entry.id === id)
    const next = visible[index + 1] ?? visible[index - 1] ?? null
    setPrompts((list) => list.filter((entry) => entry.id !== id))
    select(next && next.id !== id ? next.id : null)
  }
  /** Undo puts it back where it was. */
  const bringBack = (next: PromptData) => {
    saved(next)
    select(next.id)
  }
  const short = (entry: PromptData) => entry.title.slice(0, 40)

  const archive = (entry: PromptData) =>
    start(async () => {
      const result = await archivePromptAction({
        promptId: entry.id,
        expectedRevision: entry.revision,
        archived: true,
      })
      if (!result.ok) return toast(result.error)
      drop(entry.id)
      toast(`Archived: ${short(entry)}`, {
        undo: async () => {
          const back = await archivePromptAction({
            promptId: entry.id,
            expectedRevision: result.data.revision,
            archived: false,
          })
          if (back.ok) bringBack(back.data)
          else toast(back.error)
        },
      })
    })

  /** Delete `⌫` goes to the Trash, from the library or Archived; Undo puts it back there. */
  const remove = (entry: PromptData) =>
    start(async () => {
      const from = bucket
      const result = await deletePromptAction({
        promptId: entry.id,
        expectedRevision: entry.revision,
        deleted: true,
      })
      if (!result.ok) return toast(result.error)
      drop(entry.id)
      toast(`Deleted: ${short(entry)}`, {
        undo: async () => {
          const back = await deletePromptAction({
            promptId: entry.id,
            expectedRevision: result.data.revision,
            deleted: false,
            archived: from === 'archived',
          })
          if (back.ok) bringBack(back.data)
          else toast(back.error)
        },
      })
    })

  /** Restore `r`: from Archived or the Trash, back into the library. */
  const restore = (entry: PromptData) =>
    start(async () => {
      const result =
        bucket === 'trash'
          ? await deletePromptAction({
              promptId: entry.id,
              expectedRevision: entry.revision,
              deleted: false,
            })
          : await archivePromptAction({
              promptId: entry.id,
              expectedRevision: entry.revision,
              archived: false,
            })
      if (!result.ok) return toast(result.error)
      drop(entry.id)
      toast(`Restored: ${short(entry)} — back in the library`)
    })

  const collections = useMemo(
    () =>
      [
        ...new Set(
          prompts
            .filter((entry) => !all || who === 'all' || entry.projectId === who)
            .map((entry) => entry.collection)
            .filter(Boolean) as string[],
        ),
      ].sort(),
    [prompts, all, who],
  )
  const newThisWeek = prompts.filter(
    (entry) => Date.now() - Date.parse(entry.createdAt) < 7 * 86400_000,
  ).length

  usePageKeyHints(
    live
      ? [
          ['y', 'copy'],
          ['a', 'attach result'],
          ['e', 'edit text'],
          ['d', 'edit details'],
          ['⌫', 'delete'],
          ['c', 'new prompt'],
          ['/', 'search'],
          ['1–5', 'views'],
        ]
      : [
          ['r', 'restore'],
          ...(bucket === 'archived'
            ? ([['⌫', 'delete']] as [string, string][])
            : []),
          ['↑ ↓', 'prompts'],
          ['/', 'search'],
          ['1–5', 'views'],
        ],
  )

  usePageKeys((key) => {
    if (key === '/') {
      search.current?.focus()
      search.current?.select()
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
    // `n` stays the shell's (a note); a new prompt is `c`, as on every page.
    if (key === 'c' && live) {
      setWriting(true)
      return true
    }
    const index = visible.findIndex((entry) => entry.id === selected)
    if (['ArrowRight', 'ArrowDown', 'j'].includes(key)) {
      const next = visible[Math.min(visible.length - 1, index + 1)]
      if (next) select(next.id, true)
      return Boolean(next)
    }
    if (['ArrowLeft', 'ArrowUp', 'k'].includes(key)) {
      const next = visible[Math.max(0, index - 1)]
      if (next) select(next.id, true)
      return Boolean(next)
    }
    if (!row || busy) return false
    if (key === 'r' && !live) {
      restore(row)
      return true
    }
    if ((key === 'Backspace' || key === 'Delete') && bucket !== 'trash') {
      remove(row)
      return true
    }
    if (key === 'd' && live) {
      setMode('details')
      return true
    }
    if (!prompt?.text || !live) return false
    if (key === 'y') {
      void copy()
      return true
    }
    if (key === 'e') {
      setMode('edit')
      return true
    }
    if (key === 'a') {
      setMode('attach')
      return true
    }
    return false
  })

  const project = props.project
  const paused = project?.status === 'paused'
  /** The Grid's first place (and an empty library's only one): New prompt. */
  const newTile =
    live && (props.view === 'grid' || prompts.length === 0) ? (
      <button
        type='button'
        className='pcard ghost'
        onClick={() => setWriting(true)}
      >
        <span>
          ＋ New prompt<kbd>c</kbd>
        </span>
      </button>
    ) : null

  return (
    <div className='page promptsp'>
      <section className='pane pool-pane' aria-label='Prompts' ref={paneRef}>
        <PaneHead
          title={
            <>
              {all ? (
                'Prompts · all projects'
              ) : (
                <>{project ? <Dot color={project.color} /> : null} Prompts</>
              )}
              {bucket === 'archived'
                ? ' · Archived'
                : bucket === 'trash'
                  ? ' · Trash'
                  : ''}
            </>
          }
          meta={
            bucket === 'archived'
              ? `${prompts.length} archived · done, kept for the record`
              : bucket === 'trash'
                ? `${prompts.length} deleted · off every list until restored`
                : all
                  ? `${prompts.length} prompts · ${new Set(prompts.filter((entry) => entry.projectId).map((entry) => entry.projectId)).size} projects · ${prompts.filter((entry) => !entry.projectId).length} floating`
                  : `${prompts.length} prompts · ${collections.length} ${collections.length === 1 ? 'collection' : 'collections'}${newThisWeek ? ` · ${newThisWeek} new this week` : ''}${props.total > prompts.length ? ` · showing ${prompts.length} of ${props.total}` : ''}${paused ? ' · paused' : ''}`
          }
        />
        <div className='toolbar'>
          <input
            ref={search}
            type='search'
            aria-label='Search prompts by title or tag'
            placeholder='Search title or tag… (/)'
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
          {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons */}
          <span className='seg' role='group' aria-label='Medium'>
            {(['all', ...MEDIA] as const).map((entry) => (
              <button
                key={entry}
                type='button'
                aria-pressed={medium === entry}
                onClick={() => setMedium(entry)}
              >
                {entry}
              </button>
            ))}
          </span>
          <select
            aria-label='Collection'
            value={collection}
            onChange={(event) => setCollection(event.target.value)}
          >
            <option value='all'>All collections</option>
            {collections.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
            <option value='unsorted'>Unsorted</option>
          </select>
          {all ? (
            <select
              aria-label='Project'
              value={who}
              onChange={(event) => setWho(event.target.value)}
            >
              <option value='all'>All projects</option>
              {props.projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
              <option value='hq'>Floating (no project)</option>
            </select>
          ) : null}
          <span className='sp' />
          <span className='hits'>
            {shown.length} of {prompts.length}
          </span>
          {live ? (
            <button
              type='button'
              className='btn btn-sm'
              onClick={() => setWriting(true)}
            >
              ＋ New prompt<kbd>c</kbd>
            </button>
          ) : null}
        </div>
        <div className={`pane-body${paused ? ' paused' : ''}`}>
          {prompts.length === 0 && !live ? (
            <Empty>○ nothing here</Empty>
          ) : visible.length === 0 ? (
            <>
              {newTile ? <div className='pool'>{newTile}</div> : null}
              <Empty>
                {prompts.length === 0
                  ? '○ nothing yet — the first prompt starts this pool.'
                  : 'No prompts match this filter.'}
              </Empty>
            </>
          ) : props.view !== 'grid' ? (
            <div
              className={`tbl${all ? ' global' : ''}`}
              role='listbox'
              aria-label='Prompts'
            >
              <div className='tbl-head' aria-hidden='true'>
                {all ? <span className='hud-label'>project</span> : null}
                <span className='hud-label'>prompt</span>
                <span className='hud-label nn'>medium</span>
                <span className='hud-label nn'>collection</span>
                <span className='hud-label nn'>variants</span>
                <span className='hud-label'>
                  {bucket === 'trash'
                    ? 'deleted'
                    : bucket === 'archived'
                      ? 'archived'
                      : 'updated'}
                </span>
              </div>
              {visible.map((entry) => (
                <button
                  key={entry.id}
                  type='button'
                  role='option'
                  aria-selected={entry.id === selected}
                  data-id={entry.id}
                  className={`tbl-row${entry.id === selected ? ' sel' : ''}`}
                  onClick={() => select(entry.id)}
                >
                  {all ? (
                    <span>
                      {entry.project ? (
                        <Tag project={entry.project} />
                      ) : (
                        <span className='dim'>floating</span>
                      )}
                    </span>
                  ) : null}
                  <span
                    className='t'
                    lang={isThai(entry.title) ? 'th' : undefined}
                  >
                    {entry.title}
                  </span>
                  <span className='dim nn'>{entry.medium}</span>
                  <span className='dim nn'>{entry.collection ?? '—'}</span>
                  <span className='dim nn'>{entry.slotNames.length}</span>
                  <span className='dim'>
                    {age(
                      (bucket === 'trash'
                        ? entry.deletedAt
                        : bucket === 'archived'
                          ? entry.archivedAt
                          : null) ?? entry.updatedAt,
                    )}{' '}
                    ago
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className='pool' role='listbox' aria-label='Prompts'>
              {newTile}
              {visible.map((entry) => {
                const sample = entry.previews[0]
                return (
                  <div
                    key={entry.id}
                    className={`pcard prcard${entry.id === selected ? ' sel' : ''}`}
                    role='option'
                    aria-selected={entry.id === selected}
                    tabIndex={entry.id === selected ? 0 : -1}
                    data-id={entry.id}
                    onClick={() => select(entry.id)}
                    onKeyDown={(event) => {
                      if (event.key === ' ') {
                        event.preventDefault()
                        select(entry.id)
                      }
                    }}
                  >
                    <PreviewThumb
                      kind={sample ? sample.kind : 'no sample yet'}
                      preview={sample?.preview ?? null}
                      label={sample ? 'sample' : 'no sample yet'}
                    />
                    <div
                      className='t'
                      lang={isThai(entry.title) ? 'th' : undefined}
                    >
                      {entry.title}
                    </div>
                    <div className='m'>
                      <span>
                        {entry.medium}
                        {entry.slotNames.length
                          ? ` · ${entry.slotNames.length} ${entry.slotNames.length === 1 ? 'variant' : 'variants'}`
                          : ''}
                        {Date.now() - Date.parse(entry.createdAt) <
                        7 * 86400_000 ? (
                          <>
                            {' · '}
                            <span className='new'>new</span>
                          </>
                        ) : null}
                      </span>
                      <span>
                        {all ? (
                          entry.project ? (
                            <Tag project={entry.project} />
                          ) : (
                            'floating'
                          )
                        ) : (
                          (entry.collection ?? '')
                        )}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>
      <Inspector
        id='prompts'
        label='Prompt'
        empty={!selected}
        onClose={() => select(null)}
      >
        {!row ? (
          <>
            <InspectorHead title='Prompt' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>
                {!live
                  ? prompts.length
                    ? 'Select a prompt to read or restore it.'
                    : '○ nothing here'
                  : prompts.length
                    ? 'Select a prompt to read, copy or attach a result.'
                    : '○ nothing yet — New prompt (c) starts the library.'}
              </Empty>
            </div>
          </>
        ) : (
          <>
            <InspectorHead
              title='Prompt'
              meta={`${
                bucket === 'trash'
                  ? `deleted ${age(row.deletedAt)}`
                  : bucket === 'archived'
                    ? `archived ${age(row.archivedAt)}`
                    : age(row.updatedAt)
              } ago${all && row.project ? ` · ${row.project.name}` : ''}`}
              onClose={() => select(null)}
            >
              {live ? (
                // The prompt's own actions: Delete last.
                <MoreMenu
                  id='prompt-more'
                  label='Prompt — more'
                  items={[
                    {
                      label: 'Edit details',
                      kbd: 'd',
                      onSelect: () => setMode('details'),
                    },
                    {
                      label: 'Archive',
                      disabled: busy,
                      onSelect: () => archive(row),
                    },
                    {
                      label: 'Delete',
                      kbd: '⌫',
                      disabled: busy,
                      onSelect: () => remove(row),
                    },
                  ]}
                />
              ) : null}
            </InspectorHead>
            <div className='insp-body'>
              <div className='dev-read'>
                <div className='readout'>
                  <div
                    className='big note'
                    lang={isThai(row.title) ? 'th' : undefined}
                  >
                    {row.title}
                  </div>
                  <div className='sub'>
                    {row.medium} · {row.collection ?? 'unsorted'} ·{' '}
                    {row.slotNames.length}{' '}
                    {row.slotNames.length === 1 ? 'variant' : 'variants'}
                  </div>
                </div>
              </div>
              <div className='dev-main'>
                {mode === 'details' && live ? (
                  <DetailsForm
                    key={row.id}
                    prompt={row}
                    onCancel={() => setMode('read')}
                    onSaved={(next) => {
                      saved(next, `Saved: ${short(next)}`)
                      setMode('read')
                    }}
                  />
                ) : (
                  <>
                    {row.intent ? (
                      <p
                        className='dev-p'
                        lang={isThai(row.intent) ? 'th' : undefined}
                      >
                        {row.intent}
                      </p>
                    ) : null}
                    <div className='tags'>
                      {row.project ? (
                        <Tag project={row.project} />
                      ) : (
                        <span className='tag'>floating · no project</span>
                      )}
                      {row.tags.map((tag) => (
                        <span key={tag} className='label-chip'>
                          {tag}
                        </span>
                      ))}
                    </div>
                  </>
                )}
                {!prompt ? (
                  <Empty>…</Empty>
                ) : (
                  <PromptBody
                    prompt={prompt}
                    picks={picks}
                    generators={props.generators}
                    mode={mode}
                    bucket={bucket}
                    busy={busy}
                    onPick={pick}
                    onPicks={(next) =>
                      selected &&
                      setPicksOf((all) => ({ ...all, [selected]: next }))
                    }
                    onMode={setMode}
                    onSaved={saved}
                    onCopy={() => void copy()}
                    onDelete={() => remove(row)}
                    onRestore={() => restore(row)}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </Inspector>
      <Modal
        open={writing}
        title='New prompt'
        onClose={() => setWriting(false)}
      >
        <NewPromptForm
          projects={all ? props.projects : project ? [project] : []}
          defaultProjectId={
            all
              ? who !== 'all' && who !== 'hq'
                ? who
                : null
              : (project?.id ?? null)
          }
          onCancel={() => setWriting(false)}
          onCreated={(next) => {
            setWriting(false)
            saved(next, `Prompt saved: ${next.title}`)
            select(next.id, true)
          }}
        />
      </Modal>
    </div>
  )
}

/**
 * The selected prompt's text and its examples: the
 * text with its variants as chips to pick (`PromptText`), then the
 * examples (`Examples`). Archived and Trash end with
 * Restore — and Delete from Archived.
 */
function PromptBody({
  prompt,
  picks,
  generators,
  mode,
  bucket,
  busy,
  onPick,
  onPicks,
  onMode,
  onSaved,
  onCopy,
  onDelete,
  onRestore,
}: {
  prompt: PromptData
  picks: Record<string, string>
  generators: GeneratorOption[]
  mode: Mode
  bucket: Bucket
  /** A removal or restore is on its way. */
  busy: boolean
  onPick: (name: string, optionId: string | null) => void
  onPicks: (picks: Record<string, string>) => void
  onMode: (mode: Mode) => void
  onSaved: (prompt: PromptData, message?: string) => void
  onCopy: () => void
  onDelete: () => void
  onRestore: () => void
}) {
  const live = bucket === 'live'
  const putAway = live ? null : (
    <div className='dev-acts'>
      <button
        type='button'
        className='btn btn-pri'
        title='Restore (r)'
        aria-keyshortcuts='r'
        disabled={busy}
        onClick={onRestore}
      >
        Restore
      </button>
      {bucket === 'archived' ? (
        <button
          type='button'
          className='btn'
          title='Delete (⌫)'
          aria-keyshortcuts='Backspace'
          disabled={busy}
          onClick={onDelete}
        >
          Delete
        </button>
      ) : null}
    </div>
  )
  if (!prompt.text)
    return (
      <>
        {live ? (
          <>
            <Empty>No text yet — write what a generator will run.</Empty>
            <TextForm
              prompt={prompt}
              onCancel={() => onMode('read')}
              onSaved={(next) => onSaved(next, 'Text saved')}
            />
          </>
        ) : (
          <Empty>No text.</Empty>
        )}
        {putAway}
      </>
    )
  return (
    <>
      <PromptText
        prompt={prompt}
        picks={picks}
        mode={mode}
        live={live}
        onPick={onPick}
        onMode={onMode}
        onSaved={onSaved}
        onCopy={onCopy}
      />
      {live && mode === 'edit' ? null : (
        <Examples
          key={prompt.id}
          prompt={prompt}
          picks={picks}
          generators={generators}
          live={live}
          mode={mode}
          onMode={onMode}
          onPicks={onPicks}
          onSaved={onSaved}
        />
      )}
      {putAway}
    </>
  )
}

/**
 * Edit details `d`: what the prompt is — title, what it's for, collection,
 * tags — in one form card; its variants stay as they are. The medium and the
 * project stay too: shots and examples were checked against them.
 */
function DetailsForm({
  prompt,
  onCancel,
  onSaved,
}: {
  prompt: PromptData
  onCancel: () => void
  onSaved: (prompt: PromptData) => void
}) {
  const [title, setTitle] = useState(prompt.title)
  const [intent, setIntent] = useState(prompt.intent)
  const [collection, setCollection] = useState(prompt.collection ?? '')
  const [tags, setTags] = useState(prompt.tags.join(', '))
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  return (
    <form
      className='fcard'
      aria-label='Edit details'
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
          const result = await editPromptDetailsAction({
            promptId: prompt.id,
            expectedRevision: prompt.revision,
            title,
            intent,
            collection: collection.trim() || null,
            tags: tags
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean),
          })
          if (result.ok) onSaved(result.data)
          else setError(result.error)
        })
      }}
    >
      <label>
        Title
        <input
          ref={first}
          type='text'
          required
          maxLength={160}
          value={title}
          lang={isThai(title) ? 'th' : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        What it’s for
        <input
          type='text'
          maxLength={2000}
          value={intent}
          placeholder='A still for the listing cover'
          lang={isThai(intent) ? 'th' : undefined}
          onChange={(event) => setIntent(event.target.value)}
        />
      </label>
      <div className='row'>
        <label style={{ flex: 1 }}>
          Collection
          <input
            type='text'
            maxLength={80}
            value={collection}
            placeholder='Covers'
            onChange={(event) => setCollection(event.target.value)}
          />
        </label>
        <label style={{ flex: 1 }}>
          Tags
          <input
            type='text'
            value={tags}
            placeholder='cover, etsy'
            onChange={(event) => setTags(event.target.value)}
          />
        </label>
      </div>
      <p className='hint'>
        {prompt.medium} · {prompt.project?.name ?? 'floating'} — a prompt keeps
        its medium and project.
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
          disabled={pending || !title.trim()}
        >
          {pending ? 'Saving…' : 'Save details'}
          <kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </form>
  )
}

/**
 * New prompt, in the modal's form card: title,
 * medium, what it's for, the text (mono, as in the Board's New prompt),
 * collection and — where there is a choice — the project. The modal opens
 * on the title and closes on Esc or ✕; ↵ saves, ⌘↵ from the text too.
 */
function NewPromptForm({
  projects,
  defaultProjectId,
  onCancel,
  onCreated,
}: {
  projects: PromptProject[]
  defaultProjectId: string | null
  onCancel: () => void
  onCreated: (prompt: PromptData) => void
}) {
  const [title, setTitle] = useState('')
  const [medium, setMedium] = useState<(typeof MEDIA)[number]>('image')
  const [text, setText] = useState('')
  const [intent, setIntent] = useState('')
  const [collection, setCollection] = useState('')
  const [projectId, setProjectId] = useState(defaultProjectId ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
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
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        start(async () => {
          const result = await savePromptAction({
            projectId: projectId || null,
            title,
            intent,
            medium,
            collection: collection || null,
            text: text.trim() ? text : undefined,
          })
          if (result.ok) onCreated(result.data)
          else setError(result.error)
        })
      }}
    >
      <label>
        Title
        <input
          type='text'
          required
          maxLength={160}
          value={title}
          lang={isThai(title) ? 'th' : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons */}
      <span className='seg' role='group' aria-label='Medium'>
        {MEDIA.map((entry) => (
          <button
            key={entry}
            type='button'
            aria-pressed={medium === entry}
            onClick={() => setMedium(entry)}
          >
            {entry}
          </button>
        ))}
      </span>
      <label>
        What it’s for
        <input
          type='text'
          maxLength={2000}
          value={intent}
          placeholder='A still for the listing cover'
          lang={isThai(intent) ? 'th' : undefined}
          onChange={(event) => setIntent(event.target.value)}
        />
      </label>
      <label>
        Text · a variant is &lt;NAME&gt;, its options set after saving
        <textarea
          className='mono'
          rows={6}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className='row'>
        <label style={{ flex: 1 }}>
          Collection
          <input
            type='text'
            maxLength={80}
            value={collection}
            placeholder='Covers'
            onChange={(event) => setCollection(event.target.value)}
          />
        </label>
        {projects.length > 1 || defaultProjectId === null ? (
          <label style={{ flex: 1 }}>
            Project
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value=''>Floating — no project</option>
              {projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
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
          disabled={pending || !title.trim()}
        >
          {pending ? 'Saving…' : 'Save prompt'}
          <kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </form>
  )
}
