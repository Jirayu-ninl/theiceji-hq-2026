'use client'

import { useRouter } from 'next/navigation'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import {
  Dot,
  Empty,
  Facts,
  Inspector,
  InspectorHead,
  isThai,
  Name,
  PaneHead,
  Readout,
  usePageKeys,
} from '@/components/bridge/parts'
import { usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import type { ActionResult } from '@/lib/actions'
import type { GeneratorOption } from '@/lib/generators'
import { Markdown } from '@/lib/md'
import type { FileOption } from '@/lib/module-page'
import { uploadFile } from '@/lib/upload-client'
import { accessUrlAction } from '@/modules/assets/actions'
import {
  attachResultAction,
  deleteSceneAction,
  deleteShotAction,
  generateShotAction,
  removeCharacterAction,
  saveCharacterAction,
  saveSceneAction,
  saveScriptAction,
  saveShotAction,
  shotStatusAction,
  storyBoardAction,
  storyPreviewsAction,
  zipSceneAction,
} from '../actions'
import type {
  CharacterData,
  JobData,
  SceneData,
  ShotData,
  StoryBoardData,
  StoryProject,
  VariantOptionData,
} from '../data'

/**
 * Story: a film's script
 * (Editor), characters (Pool) and shot board (Table) beside one inspector.
 * The instrument is the shot thumbnail — pencil-on-paper while a shot is
 * boarded, a real frame with its timecode once it has a result.
 *
 * Generating is by hand in v1: Generate opens a manual job for the shot and
 * its variant, the owner makes the file elsewhere and drops it here — the
 * job is done and the shot becomes generated. A scene's files leave as one
 * ZIP made by the local worker. HQ never edits a film.
 */

export type StoryPageProps = {
  project: StoryProject
  board: StoryBoardData
  variants: VariantOptionData[]
  /** The project's ready media: boards pick images, a shot may take any. */
  files: FileOption[]
  /** The owner's generators; by hand is always there too. */
  generators: GeneratorOption[]
  previews: Record<string, string>
  view: 'script' | 'characters' | 'shots'
  selectedShotId: string | null
  selectedCharacterId: string | null
}

const STATUSES = ['all', 'boarded', 'generated', 'edited', 'done'] as const
type ShotStatus = ShotData['status']

const isGen = (status: ShotStatus) => status !== 'boarded'
const seconds = (value: string | null) => (value ? Number(value) : 0)
/** `1:05` for 65 seconds. */
const clock = (total: number) => {
  const s = Math.round(total)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
/** `00:01:05` — a shot's place in the film. */
const timecode = (value: string) => {
  const s = Math.round(Number(value) || 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}
/** A shot's prompt, by title — a prompt has one text since 2026-09-30. */
const variantLabel = (variant: { promptTitle: string }) => variant.promptTitle
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

function setQuery(values: Record<string, string | null>) {
  const url = new URL(window.location.href)
  for (const [key, value] of Object.entries(values))
    if (value) url.searchParams.set(key, value)
    else url.searchParams.delete(key)
  window.history.replaceState(null, '', url)
}

/** The shot thumbnail: a sketch while boarded, a frame (with its timecode) once there is a result. */
function ShotThumb({
  shot,
  preview,
  label,
  tc,
  shape,
  state,
}: {
  shot: Pick<ShotData, 'code' | 'status'>
  preview: string | null
  label?: string
  tc?: string
  shape?: string
  state?: 'wait' | 'live'
}) {
  const [broken, setBroken] = useState(false)
  const real = isGen(shot.status) || Boolean(preview)
  const image = preview && !broken
  return (
    <div
      className={`thumb ${real ? 'real' : 'sketch'}${shape ? ` ${shape}` : ''}`}
      role='img'
      aria-label={`Shot ${shot.code} ${real ? 'frame' : 'board'}, ${shot.status}`}
      style={image ? { padding: 0 } : undefined}
    >
      {state ? (
        <i className={`glyph ${state} st`} aria-hidden='true'>
          {state === 'live' ? '▶' : '◆'}
        </i>
      ) : null}
      {image ? (
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
        <span>{label ?? (real ? '' : 'board')}</span>
      )}
      {tc && real ? <span className='tc'>{tc}</span> : null}
    </div>
  )
}

function BoardThumb({
  character,
  preview,
}: {
  character: CharacterData
  preview: string | null
}) {
  const [broken, setBroken] = useState(false)
  const image = preview && !broken
  return (
    <div
      className={`thumb square ${image ? 'real' : 'sketch'}`}
      role='img'
      aria-label={`${character.name} — ${character.board?.title ?? character.board?.name ?? 'no board yet'}`}
      style={image ? { padding: 0 } : undefined}
    >
      {image ? (
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
        <span>board</span>
      )}
    </div>
  )
}

/** A shot's newest result of a kind (the still, the motion). */
const newest = (shot: ShotData, kind: string) =>
  [...shot.results].reverse().find((asset) => asset.kind === kind) ?? null
const frameOf = (shot: ShotData) =>
  newest(shot, 'image') ?? newest(shot, 'video') ?? shot.results.at(-1) ?? null

function jobWord(job: JobData | null): ReactNode {
  if (!job) return null
  if (job.state === 'awaiting_upload')
    return <span className='state-word wait'>◆ awaiting your upload</span>
  if (job.state === 'queued')
    return <span className='state-word wait'>◆ queued</span>
  if (job.state === 'running')
    return <span className='state-word live'>▶ running</span>
  if (job.state === 'failed')
    return <span className='state-word wait'>◆ failed</span>
  return null
}

export function StoryPage(props: StoryPageProps) {
  const router = useRouter()
  const toast = useToast()
  const [board, setBoard] = useState(props.board)
  const [previews, setPreviews] = useState(props.previews)
  const [, startTransition] = useTransition()
  const project = props.project
  const view = props.view

  useEffect(() => setBoard(props.board), [props.board])
  useEffect(() => setPreviews(props.previews), [props.previews])

  /** A write answers the whole board; errors are a toast, never a blank page. */
  const apply = useCallback(
    (result: ActionResult<StoryBoardData>, message?: string) => {
      if (!result.ok) {
        toast(result.error)
        return false
      }
      setBoard(result.data)
      if (message) toast(message)
      return true
    },
    [toast],
  )

  // A ZIP in flight: read the board again every few seconds until it settles.
  const zipping = board.scenes.some(
    (scene) => scene.zip?.state === 'queued' || scene.zip?.state === 'running',
  )
  useEffect(() => {
    if (!zipping) return
    const timer = window.setInterval(() => {
      storyBoardAction(project.id).then((result) => {
        if (result.ok) setBoard(result.data)
      })
    }, 4000)
    return () => window.clearInterval(timer)
  }, [zipping, project.id])

  const addPreviews = (ids: string[]) =>
    storyPreviewsAction(ids).then((result) => {
      if (result.ok) setPreviews((current) => ({ ...current, ...result.data }))
    })

  const common = {
    project,
    board,
    previews,
    apply,
    refresh: () => startTransition(() => router.refresh()),
  }

  if (!board.story)
    return (
      <div className='page storyp'>
        <section className='pane main-pane' aria-label='Story'>
          <PaneHead title={`Story · ${project.name}`} meta='○ nothing yet' />
          <div className='pane-body'>
            <Empty>
              ○ nothing yet — the story is made the first time someone who may
              write to it opens this page.
            </Empty>
          </div>
        </section>
      </div>
    )

  if (view === 'characters')
    return (
      <Characters
        {...common}
        files={props.files}
        selectedId={props.selectedCharacterId}
      />
    )
  if (view === 'shots')
    return (
      <Shots
        {...common}
        variants={props.variants}
        files={props.files}
        generators={props.generators}
        selectedId={props.selectedShotId}
        addPreviews={addPreviews}
      />
    )
  return <Script {...common} />
}

type Common = {
  project: StoryProject
  board: StoryBoardData
  previews: Record<string, string>
  apply: (result: ActionResult<StoryBoardData>, message?: string) => boolean
  refresh: () => void
}

const paused = (project: StoryProject) =>
  project.status === 'paused' ? (
    <span className='state-word'> · paused</span>
  ) : null

/** A shot's result files, from a fresh board. */
const shotResults = (board: StoryBoardData, shotId: string) =>
  board.scenes
    .flatMap((scene) => scene.shots)
    .find((shot) => shot.id === shotId)?.results ?? []

const allShots = (board: StoryBoardData) =>
  board.scenes.flatMap((scene) => scene.shots)

/* ── Script (Editor) + Outline ────────────────────────────────────── */

function Script({ project, board, apply }: Common) {
  const router = useRouter()
  const story = board.story as NonNullable<StoryBoardData['story']>
  const [text, setText] = useState(story.script)
  const [title, setTitle] = useState(story.title)
  const [logline, setLogline] = useState(story.logline)
  const [preview, setPreview] = useState(false)
  const [scene, setScene] = useState<string | 'new' | null>(null)
  const [pending, start] = useTransition()
  const dirty =
    text !== story.script || title !== story.title || logline !== story.logline
  const lines = text ? text.split('\n').length : 0
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0
  const shots = allShots(board)
  const generated = shots.filter((shot) => isGen(shot.status)).length

  // Someone else saved (another tab, an agent): take theirs when nothing here is unsaved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the stored story, not the draft
  useEffect(() => {
    if (dirty) return
    setText(story.script)
    setTitle(story.title)
    setLogline(story.logline)
  }, [story.revision])

  const save = () =>
    start(async () => {
      const ok = apply(
        await saveScriptAction({
          projectId: project.id,
          storyId: story.id,
          expectedRevision: story.revision,
          title,
          logline,
          script: text,
        }),
        `Script saved · ${plural(lines, 'line')}`,
      )
      if (!ok) router.refresh()
    })

  usePageKeyHints([
    ['⌘S', 'save'],
    ['↑ ↓', 'scenes'],
    ['c', 'new scene'],
    ['1 2 3', 'script · characters · shots'],
  ])
  usePageKeys((key) => {
    const index = board.scenes.findIndex((entry) => entry.id === scene)
    if (key === 'ArrowDown' || key === 'j') {
      const next = board.scenes[Math.min(board.scenes.length - 1, index + 1)]
      if (next) setScene(next.id)
      return Boolean(next)
    }
    if (key === 'ArrowUp' || key === 'k') {
      const next = board.scenes[Math.max(0, index - 1)]
      if (next) setScene(next.id)
      return Boolean(next)
    }
    if (key === 'c') {
      setScene('new')
      return true
    }
    if (key === 'Escape' && scene) {
      setScene(null)
      return true
    }
    return false
  })

  const selected = board.scenes.find((entry) => entry.id === scene) ?? null

  return (
    <div
      className={`page storyp${project.status === 'paused' ? ' paused' : ''}`}
    >
      <section className='pane main-pane' aria-label='Script'>
        <PaneHead
          title={
            <>
              Script · <Name text={project.name} />
            </>
          }
          meta={
            <>
              {plural(board.scenes.length, 'scene')} · {plural(lines, 'line')} ·{' '}
              {dirty ? 'unsaved' : 'saved'}
              {paused(project)}
            </>
          }
        />
        <div className='toolbar'>
          {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons */}
          <span className='seg' role='group' aria-label='Mode'>
            <button
              type='button'
              aria-pressed={!preview}
              onClick={() => setPreview(false)}
            >
              Edit
            </button>
            <button
              type='button'
              aria-pressed={preview}
              onClick={() => setPreview(true)}
            >
              Preview
            </button>
          </span>
          <span className='sp' />
          <span className='hits'>{plural(words, 'word')}</span>
          <button
            type='button'
            className='btn btn-sm btn-pri'
            disabled={!dirty || pending}
            onClick={save}
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
        {preview ? (
          <div className='pane-body preview'>
            {text.trim() ? (
              <Markdown source={text} />
            ) : (
              <Empty>
                ○ nothing yet — switch to Edit and start the script.
              </Empty>
            )}
          </div>
        ) : (
          <div className='pane-body script'>
            <textarea
              className='editor'
              aria-label='Script (markdown)'
              value={text}
              lang={isThai(text) ? 'th' : undefined}
              placeholder='Start with the script — markdown, one “# Scene 1 · heading” per scene, then action and dialogue. Scenes on the board are listed in the outline.'
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                  event.preventDefault()
                  if (dirty && !pending) save()
                }
              }}
            />
          </div>
        )}
      </section>
      <Inspector
        id='story'
        label='Outline'
        empty={!scene}
        onClose={() => setScene(null)}
      >
        {scene === 'new' || selected ? (
          <SceneForm
            key={selected ? `${selected.id}-${selected.revision}` : 'new'}
            project={project}
            storyId={story.id}
            scene={selected}
            apply={apply}
            onClose={() => setScene(null)}
            onSaved={(id) => setScene(id)}
          />
        ) : (
          <>
            <InspectorHead
              title='Outline'
              meta={plural(board.scenes.length, 'scene')}
            />
            <div className='insp-body'>
              <Readout
                big={
                  shots.length ? (
                    <>
                      {generated}{' '}
                      <span className='u'>/ {shots.length} shots</span>
                    </>
                  ) : (
                    '○ nothing yet'
                  )
                }
                sub={
                  shots.length
                    ? `${clock(Number(board.runtimeS))} runtime · ${shots.length - generated} boarded`
                    : 'no shots on the board'
                }
                tone={shots.length ? '' : 'dim'}
              />
              <div className='fcard'>
                <label>
                  Title
                  <input
                    type='text'
                    value={title}
                    maxLength={200}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <label>
                  Logline
                  <textarea
                    value={logline}
                    rows={2}
                    maxLength={1000}
                    onChange={(event) => setLogline(event.target.value)}
                  />
                </label>
                <p className='hint'>Saved with the script.</p>
              </div>
              <div className='dev-h'>
                <span className='hud-label'>Scenes</span>
                <button
                  type='button'
                  className='btn btn-sm'
                  onClick={() => setScene('new')}
                >
                  ＋ Scene<kbd>c</kbd>
                </button>
              </div>
              {board.scenes.length ? (
                <div className='dev-rows'>
                  {board.scenes.map((entry) => {
                    const done = entry.shots.filter((shot) =>
                      isGen(shot.status),
                    ).length
                    return (
                      <button
                        key={entry.id}
                        type='button'
                        className='dev-row'
                        onClick={() => setScene(entry.id)}
                      >
                        <span className='n'>{entry.number}</span>
                        <span className='t'>
                          <Name text={entry.heading} />
                        </span>
                        <span className='v'>
                          {entry.shots.length
                            ? `${done} / ${entry.shots.length}`
                            : 'no shots'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <Empty>○ no scenes yet — add the first with c.</Empty>
              )}
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

function SceneForm({
  project,
  storyId,
  scene,
  apply,
  onClose,
  onSaved,
}: {
  project: StoryProject
  storyId: string
  scene: SceneData | null
  apply: Common['apply']
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const router = useRouter()
  const [heading, setHeading] = useState(scene?.heading ?? '')
  const [synopsis, setSynopsis] = useState(scene?.synopsis ?? '')
  const [asking, setAsking] = useState(false)
  const [pending, start] = useTransition()
  const save = () =>
    start(async () => {
      const result = await saveSceneAction({
        projectId: project.id,
        storyId,
        ...(scene
          ? { sceneId: scene.id, expectedRevision: scene.revision }
          : {}),
        heading,
        synopsis,
      })
      if (!apply(result, scene ? 'Scene saved' : 'Scene added')) return
      const saved = result.ok
        ? scene
          ? scene.id
          : result.data.scenes.at(-1)?.id
        : null
      if (saved) onSaved(saved)
    })
  const remove = () =>
    start(async () => {
      if (!scene) return
      if (
        apply(
          await deleteSceneAction({ projectId: project.id, sceneId: scene.id }),
          `Deleted scene ${scene.number} and its shots`,
        )
      ) {
        onClose()
      }
    })
  return (
    <>
      <InspectorHead
        title={
          <>
            <Dot color={project.color} />{' '}
            {scene ? `Scene ${scene.number}` : 'New scene'}
          </>
        }
        meta={scene ? plural(scene.shots.length, 'shot') : 'draft'}
        onClose={onClose}
      />
      <div className='insp-body'>
        <form
          className='fcard'
          onSubmit={(event) => {
            event.preventDefault()
            if (heading.trim()) save()
          }}
        >
          <label>
            Heading
            <input
              type='text'
              value={heading}
              maxLength={200}
              placeholder='INT. FERRY HOUSE — MORNING'
              // biome-ignore lint/a11y/noAutofocus: the form opens on purpose
              autoFocus={!scene}
              onChange={(event) => setHeading(event.target.value)}
            />
          </label>
          <label>
            Synopsis
            <textarea
              value={synopsis}
              rows={3}
              maxLength={4000}
              onChange={(event) => setSynopsis(event.target.value)}
            />
          </label>
          <div className='row'>
            <button
              type='submit'
              className='btn btn-pri'
              disabled={pending || !heading.trim()}
            >
              {scene ? 'Save' : 'Add scene'}
            </button>
            <button type='button' className='btn' onClick={onClose}>
              {scene ? 'Back' : 'Cancel'}
            </button>
            {scene ? (
              <a
                className='btn'
                href={`?view=shots&scene=${scene.id}`}
                onClick={(event) => {
                  event.preventDefault()
                  router.push(
                    `/p/${project.slug}/story?view=shots&scene=${scene.id}`,
                  )
                }}
              >
                Open in Shots
              </a>
            ) : null}
          </div>
        </form>
        {scene ? (
          asking ? (
            <p className='why'>
              <b>Delete scene {scene.number}?</b>{' '}
              {scene.shots.length
                ? `Its ${plural(scene.shots.length, 'shot')} go with it; their files stay in Assets.`
                : 'It has no shots.'}{' '}
              <button
                type='button'
                className='btn btn-sm'
                disabled={pending}
                onClick={remove}
              >
                Delete
              </button>{' '}
              <button
                type='button'
                className='btn btn-sm'
                onClick={() => setAsking(false)}
              >
                Keep
              </button>
            </p>
          ) : (
            <div className='dev-acts'>
              <button
                type='button'
                className='btn btn-sm'
                onClick={() => setAsking(true)}
              >
                Delete scene
              </button>
            </div>
          )
        ) : null}
      </div>
    </>
  )
}

/* ── Characters (Pool) ─────────────────────────────────────────────── */

function Characters({
  project,
  board,
  previews,
  apply,
  files,
  selectedId,
}: Common & { files: FileOption[]; selectedId: string | null }) {
  const router = useRouter()
  const [query, setSearch] = useState('')
  const [selected, setSelected] = useState<string | 'new' | null>(
    selectedId ?? null,
  )
  const shots = allShots(board)
  const q = query.trim().toLowerCase()
  const items = q
    ? board.characters.filter((character) =>
        `${character.name} ${character.description}`.toLowerCase().includes(q),
      )
    : board.characters
  const current =
    board.characters.find((character) => character.id === selected) ?? null

  const select = (id: string | 'new' | null) => {
    setSelected(id)
    setQuery({ character: id && id !== 'new' ? id : null })
  }

  usePageKeyHints([
    ['↑ ↓', 'characters'],
    ['c', 'new character'],
    ['Esc', 'clear'],
    ['1 2 3', 'script · characters · shots'],
  ])
  usePageKeys((key) => {
    const index = items.findIndex((character) => character.id === selected)
    if (['ArrowDown', 'ArrowRight', 'j'].includes(key)) {
      const next = items[Math.min(items.length - 1, index + 1)]
      if (next) select(next.id)
      return Boolean(next)
    }
    if (['ArrowUp', 'ArrowLeft', 'k'].includes(key)) {
      const next = items[Math.max(0, index - 1)]
      if (next) select(next.id)
      return Boolean(next)
    }
    if (key === 'c') {
      select('new')
      return true
    }
    if (key === 'Escape' && selected) {
      select(null)
      return true
    }
    return false
  })

  return (
    <div
      className={`page storyp${project.status === 'paused' ? ' paused' : ''}`}
    >
      <section className='pane main-pane' aria-label='Characters'>
        <PaneHead
          title={
            <>
              Characters · <Name text={project.name} />
            </>
          }
          meta={
            <>
              {board.characters.length
                ? plural(board.characters.length, 'character')
                : '○ nothing yet'}
              {paused(project)}
            </>
          }
        />
        <div className='toolbar'>
          <input
            type='search'
            aria-label='Search characters'
            placeholder='Search characters'
            value={query}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className='sp' />
          <span className='hits'>
            {items.length} of {board.characters.length}
          </span>
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => select('new')}
          >
            ＋ Character<kbd>c</kbd>
          </button>
        </div>
        <div className='pane-body'>
          {board.characters.length === 0 ? (
            <Empty>○ nothing yet — press c for the first character.</Empty>
          ) : items.length === 0 ? (
            <Empty>No character matches.</Empty>
          ) : (
            <div className='pool' role='listbox' aria-label='Characters'>
              {items.map((character) => {
                const cast = shots.filter((shot) =>
                  shot.characterIds.includes(character.id),
                )
                const on = character.id === selected
                return (
                  <button
                    key={character.id}
                    type='button'
                    role='option'
                    aria-selected={on}
                    className={`pcard ccard${on ? ' sel' : ''}`}
                    onClick={() => select(character.id)}
                  >
                    <BoardThumb
                      character={character}
                      preview={
                        character.boardAssetId
                          ? (previews[character.boardAssetId] ?? null)
                          : null
                      }
                    />
                    <div className='t'>
                      <Name text={character.name} />
                    </div>
                    <p lang={isThai(character.description) ? 'th' : undefined}>
                      {character.description || '—'}
                    </p>
                    <div className='m'>
                      <span>{plural(cast.length, 'shot')}</span>
                      <span>
                        {cast.filter((shot) => isGen(shot.status)).length}{' '}
                        generated
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </section>
      <Inspector
        id='story'
        label='Character'
        empty={!selected}
        onClose={() => select(null)}
      >
        {selected === 'new' || current ? (
          <CharacterForm
            key={current ? `${current.id}-${current.revision}` : 'new'}
            project={project}
            board={board}
            character={current}
            images={files.filter((file) => file.kind === 'image')}
            preview={
              current?.boardAssetId
                ? (previews[current.boardAssetId] ?? null)
                : null
            }
            apply={apply}
            onClose={() => select(null)}
            onSaved={(id) => {
              select(id)
            }}
            onShot={(id) =>
              router.push(`/p/${project.slug}/story?view=shots&shot=${id}`)
            }
          />
        ) : (
          <>
            <InspectorHead title='Character' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>
                {board.characters.length
                  ? 'Select a character to see the shots they appear in.'
                  : '○ nothing yet — press c for the first character.'}
              </Empty>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

function CharacterForm({
  project,
  board,
  character,
  images,
  preview,
  apply,
  onClose,
  onSaved,
  onShot,
}: {
  project: StoryProject
  board: StoryBoardData
  character: CharacterData | null
  images: FileOption[]
  preview: string | null
  apply: Common['apply']
  onClose: () => void
  onSaved: (id: string) => void
  onShot: (id: string) => void
}) {
  const [name, setName] = useState(character?.name ?? '')
  const [description, setDescription] = useState(character?.description ?? '')
  const [boardId, setBoardId] = useState(character?.boardAssetId ?? '')
  const [asking, setAsking] = useState(false)
  const [pending, start] = useTransition()
  const story = board.story as NonNullable<StoryBoardData['story']>
  const shots = character
    ? allShots(board).filter((shot) => shot.characterIds.includes(character.id))
    : []
  const first = shots[0]
  const dirty =
    !character ||
    name !== character.name ||
    description !== character.description ||
    boardId !== (character.boardAssetId ?? '')

  const save = () =>
    start(async () => {
      const result = await saveCharacterAction({
        projectId: project.id,
        storyId: story.id,
        ...(character
          ? { characterId: character.id, expectedRevision: character.revision }
          : {}),
        name,
        description,
        boardAssetId: boardId || null,
      })
      if (!apply(result, character ? `Saved ${name}` : `Added ${name}`)) return
      const id = character
        ? character.id
        : result.ok
          ? result.data.characters.find((entry) => entry.name === name.trim())
              ?.id
          : null
      if (id) onSaved(id)
    })
  const remove = () =>
    start(async () => {
      if (!character) return
      if (
        apply(
          await removeCharacterAction({
            projectId: project.id,
            characterId: character.id,
          }),
          `Removed ${character.name} — their shots keep their frames`,
        )
      )
        onClose()
    })

  return (
    <>
      <InspectorHead
        title={
          <>
            <Dot color={project.color} /> <Name text={project.name} /> ›{' '}
            {character ? <Name text={character.name} /> : 'New character'}
          </>
        }
        meta='character'
        onClose={onClose}
      />
      <div className='insp-body'>
        {character ? (
          <Readout
            big={
              <>
                {shots.length}{' '}
                <span className='u'>
                  {shots.length === 1 ? 'shot' : 'shots'}
                </span>
              </>
            }
            sub={
              first
                ? `${shots.filter((shot) => isGen(shot.status)).length} generated · first in shot ${first.code}`
                : 'in no shot yet'
            }
            tone={shots.length ? '' : 'dim'}
          />
        ) : null}
        <form
          className='fcard'
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim() && dirty) save()
          }}
        >
          <label>
            Name
            <input
              type='text'
              value={name}
              maxLength={120}
              // biome-ignore lint/a11y/noAutofocus: the form opens on purpose
              autoFocus={!character}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Description
            <textarea
              value={description}
              rows={3}
              maxLength={4000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label>
            Board
            <select
              value={boardId}
              onChange={(event) => setBoardId(event.target.value)}
            >
              <option value=''>— none —</option>
              {images.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.title}
                </option>
              ))}
            </select>
          </label>
          <p className='hint'>
            A board is one of this project’s images in Assets — upload it there
            first.
          </p>
          <div className='row'>
            <button
              type='submit'
              className='btn btn-pri'
              disabled={pending || !name.trim() || !dirty}
            >
              {character ? 'Save' : 'Add character'}
            </button>
            <button type='button' className='btn' onClick={onClose}>
              {character ? 'Back' : 'Cancel'}
            </button>
          </div>
        </form>
        {character ? (
          <>
            {character.boardAssetId ? (
              <div className='board'>
                <BoardThumb character={character} preview={preview} />
              </div>
            ) : null}
            <Facts
              rows={[
                [
                  'board',
                  character.board?.title ?? character.board?.name ?? '—',
                ],
                ['first appears', first ? `shot ${first.code}` : '—'],
              ]}
            />
            <div className='dev-h'>
              <span className='hud-label'>Appears in</span>
            </div>
            {shots.length ? (
              <div className='dev-rows'>
                {shots.map((shot) => (
                  <button
                    key={shot.id}
                    type='button'
                    className='dev-row'
                    onClick={() => onShot(shot.id)}
                  >
                    <span className='n'>{shot.code}</span>
                    <span className='t'>{shot.action}</span>
                    <span className='v'>{shot.status}</span>
                  </button>
                ))}
              </div>
            ) : (
              <Empty>Not cast in any shot yet — cast them from a shot.</Empty>
            )}
            {asking ? (
              <p className='why'>
                <b>Remove {character.name}?</b> They leave every shot’s cast;
                the shots stay.{' '}
                <button
                  type='button'
                  className='btn btn-sm'
                  disabled={pending}
                  onClick={remove}
                >
                  Remove
                </button>{' '}
                <button
                  type='button'
                  className='btn btn-sm'
                  onClick={() => setAsking(false)}
                >
                  Keep
                </button>
              </p>
            ) : (
              <div className='dev-acts'>
                <button
                  type='button'
                  className='btn btn-sm'
                  onClick={() => setAsking(true)}
                >
                  Remove character
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </>
  )
}

/* ── Shots (Table) ─────────────────────────────────────────────────── */

function Shots({
  project,
  board,
  previews,
  apply,
  variants,
  files,
  generators,
  selectedId,
  addPreviews,
}: Common & {
  variants: VariantOptionData[]
  files: FileOption[]
  generators: GeneratorOption[]
  selectedId: string | null
  addPreviews: (ids: string[]) => Promise<void>
}) {
  const toast = useToast()
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all')
  const [sceneFilter, setSceneFilter] = useState<string>(() => {
    if (typeof window === 'undefined') return 'all'
    return new URL(window.location.href).searchParams.get('scene') ?? 'all'
  })
  const [selected, setSelected] = useState<string | null>(selectedId)
  const [adding, setAdding] = useState<string | null>(null)
  const [zipping, startZip] = useTransition()
  const paneRef = useRef<HTMLElement>(null)
  const shots = allShots(board)
  const generated = shots.filter((shot) => isGen(shot.status)).length

  const groups = useMemo(
    () =>
      board.scenes
        .filter((scene) => sceneFilter === 'all' || scene.id === sceneFilter)
        .map((scene) => ({
          scene,
          shots: scene.shots.filter(
            (shot) => status === 'all' || shot.status === status,
          ),
        })),
    [board.scenes, sceneFilter, status],
  )
  const rows = groups.flatMap((group) => group.shots)
  const current = shots.find((shot) => shot.id === selected) ?? null
  const scene = current
    ? (board.scenes.find((entry) => entry.id === current.sceneId) ?? null)
    : null

  const select = (id: string | null, focus = false) => {
    setSelected(id)
    setAdding(null)
    setQuery({ shot: id })
    if (focus && id)
      requestAnimationFrame(() => {
        const row = paneRef.current?.querySelector<HTMLElement>(
          `[data-shot="${CSS.escape(id)}"]`,
        )
        row?.focus({ preventScroll: true })
        row?.scrollIntoView({ block: 'nearest' })
      })
  }

  const zip = (entry: SceneData) =>
    startZip(async () => {
      apply(
        await zipSceneAction({ projectId: project.id, sceneId: entry.id }),
        `Asked the worker for scene ${entry.number}’s ZIP`,
      )
    })
  const download = async (job: JobData) => {
    const asset = job.results[0]
    if (!asset) return
    const result = await accessUrlAction({ assetId: asset.id, download: true })
    if (result.ok) window.open(result.data.url, '_blank', 'noopener')
    else toast(result.error)
  }

  const mark = async (shot: ShotData, next: ShotStatus) => {
    if (!isGen(shot.status)) {
      toast(`Shot ${shot.code} is boarded — attach its result first`)
      return
    }
    if (shot.status === next) return
    const was = shot.status
    const result = await shotStatusAction({
      projectId: project.id,
      shotId: shot.id,
      expectedRevision: shot.revision,
      status: next,
    })
    if (!result.ok) {
      toast(result.error)
      return
    }
    apply(result)
    const saved = result.data.scenes
      .flatMap((entry) => entry.shots)
      .find((entry) => entry.id === shot.id)
    toast(`Marked ${next}: shot ${shot.code}`, {
      undo: async () => {
        if (!saved) return
        apply(
          await shotStatusAction({
            projectId: project.id,
            shotId: shot.id,
            expectedRevision: saved.revision,
            status: was,
          }),
        )
      },
    })
  }

  const generate = async (
    shot: ShotData,
    medium: 'image' | 'video',
    generatorId: string | null,
  ) => {
    const what = medium === 'image' ? 'still' : 'motion'
    const result = await generateShotAction({
      projectId: project.id,
      shotId: shot.id,
      medium,
      generatorId,
    })
    if (!result.ok) {
      toast(result.error)
      return
    }
    apply({ ok: true, data: result.data.board })
    const name = generators.find((entry) => entry.id === generatorId)?.label
    if (!generatorId)
      toast(
        `Shot ${shot.code}: make the ${what} with its prompt, then drop the file here`,
      )
    else if (result.data.state === 'succeeded') {
      toast(`Shot ${shot.code}: ${what} made with ${name}`)
      await addPreviews(
        shotResults(result.data.board, shot.id).map((asset) => asset.id),
      )
    } else if (result.data.state === 'running')
      toast(`Shot ${shot.code}: ${name} is making the ${what} — HQ collects it`)
    else toast(result.data.error ?? `${name} couldn’t make it`)
  }

  usePageKeyHints([
    ['↑ ↓', 'shots'],
    ['c', 'new shot'],
    ['g', 'generate still'],
    ['e d', 'edited · done'],
    ['Esc', 'clear'],
    ['1 2 3', 'script · characters · shots'],
  ])
  usePageKeys((key) => {
    const index = rows.findIndex((shot) => shot.id === selected)
    if (key === 'ArrowDown' || key === 'j') {
      const next = rows[Math.min(rows.length - 1, index + 1)]
      if (next) select(next.id, true)
      return Boolean(next)
    }
    if (key === 'ArrowUp' || key === 'k') {
      const next = rows[Math.max(0, index - 1)]
      if (next) select(next.id, true)
      return Boolean(next)
    }
    if (key === 'Escape') {
      if (adding) {
        setAdding(null)
        return true
      }
      if (selected) {
        select(null)
        paneRef.current?.focus()
        return true
      }
      return false
    }
    if (key === 'c') {
      const target =
        current?.sceneId ??
        (sceneFilter !== 'all' ? sceneFilter : board.scenes.at(-1)?.id)
      if (!target) {
        toast('Add a scene first — in Script, press c')
        return true
      }
      setAdding(target)
      setSelected(null)
      return true
    }
    if (!current) return false
    if (key === 'g') {
      void generate(current, 'image', null)
      return true
    }
    if (key === 'e') {
      void mark(current, 'edited')
      return true
    }
    if (key === 'd') {
      void mark(current, 'done')
      return true
    }
    return false
  })

  const addingScene = board.scenes.find((entry) => entry.id === adding) ?? null

  return (
    <div
      className={`page storyp${project.status === 'paused' ? ' paused' : ''}`}
    >
      <section
        className='pane main-pane'
        aria-label='Shots'
        ref={paneRef}
        tabIndex={-1}
      >
        <PaneHead
          title={
            <>
              Shots · <Name text={project.name} />
            </>
          }
          meta={
            <>
              {shots.length
                ? `${generated} / ${shots.length} generated · ${clock(Number(board.runtimeS))} runtime`
                : '○ nothing yet'}
              {paused(project)}
            </>
          }
        />
        <div className='toolbar'>
          {/* biome-ignore lint/a11y/useSemanticElements: status filters are a group of toggle buttons */}
          <span className='seg' role='group' aria-label='Status'>
            {STATUSES.map((entry) => (
              <button
                key={entry}
                type='button'
                aria-pressed={status === entry}
                onClick={() => setStatus(entry)}
              >
                {entry}
              </button>
            ))}
          </span>
          <select
            aria-label='Scene'
            value={sceneFilter}
            onChange={(event) => {
              setSceneFilter(event.target.value)
              setQuery({
                scene: event.target.value === 'all' ? null : event.target.value,
              })
            }}
          >
            <option value='all'>All scenes</option>
            {board.scenes.map((entry) => (
              <option key={entry.id} value={entry.id}>
                Scene {entry.number} · {entry.heading}
              </option>
            ))}
          </select>
          <span className='sp' />
          <span className='hits'>
            {rows.length} of {shots.length}
          </span>
        </div>
        <div className='pane-body shots'>
          {board.scenes.length === 0 ? (
            <>
              <Empty>○ nothing yet</Empty>
              <div className='tbl'>
                <a className='tbl-row ghost' href={`/p/${project.slug}/story`}>
                  <span className='g'>
                    Start with the script → add the scenes, then their shots
                  </span>
                </a>
              </div>
            </>
          ) : (
            <div className='tbl' role='listbox' aria-label='Shots'>
              <div className='tbl-head' aria-hidden='true'>
                <span className='hud-label'>shot</span>
                <span className='hud-label'>frame</span>
                <span className='hud-label'>action</span>
                <span className='hud-label num'>s</span>
                <span className='hud-label'>still</span>
                <span className='hud-label'>motion</span>
                <span className='hud-label'>result</span>
                <span className='hud-label'>status</span>
              </div>
              {groups.map(({ scene: entry, shots: list }) => {
                const total = entry.shots.length
                const done = entry.shots.filter((shot) =>
                  isGen(shot.status),
                ).length
                const waiting = entry.shots.filter(
                  (shot) => shot.job?.state === 'awaiting_upload',
                ).length
                const withResult = entry.shots.some(
                  (shot) => shot.results.length > 0,
                )
                const zipState = entry.zip?.state
                return (
                  <div key={entry.id} role='presentation' className='scene'>
                    <div className='scene-h' role='presentation'>
                      <span lang={isThai(entry.heading) ? 'th' : undefined}>
                        Scene {entry.number} · {entry.heading}
                      </span>
                      <span className='n'>
                        {done} / {total} generated
                      </span>
                      {waiting ? (
                        <span className='n wait'>
                          ◆ {waiting} awaiting upload
                        </span>
                      ) : null}
                      <span className='sp' />
                      <span className='n'>
                        {list.reduce(
                          (sum, shot) => sum + seconds(shot.durationS),
                          0,
                        )}{' '}
                        s
                      </span>
                      {zipState === 'queued' || zipState === 'running' ? (
                        <span className='state-word live'>
                          ▶ {zipState === 'queued' ? 'ZIP queued' : 'zipping'}
                        </span>
                      ) : zipState === 'succeeded' && entry.zip ? (
                        <button
                          type='button'
                          className='btn btn-sm'
                          onClick={() => download(entry.zip as JobData)}
                          title={entry.zip.results[0]?.name}
                        >
                          ↓ ZIP
                        </button>
                      ) : null}
                      {zipState !== 'queued' && zipState !== 'running' ? (
                        <button
                          type='button'
                          className='btn btn-sm'
                          disabled={!withResult || zipping}
                          title={
                            withResult
                              ? 'The local worker bundles each shot’s newest result'
                              : 'No shot has a result yet'
                          }
                          onClick={() => zip(entry)}
                        >
                          {zipState === 'failed'
                            ? '◆ ZIP failed · again'
                            : zipState === 'succeeded'
                              ? 'ZIP again'
                              : 'ZIP scene'}
                        </button>
                      ) : null}
                      <button
                        type='button'
                        className='btn btn-sm'
                        onClick={() => {
                          setAdding(entry.id)
                          setSelected(null)
                        }}
                      >
                        ＋ Shot
                      </button>
                    </div>
                    {list.length === 0 ? (
                      <div className='tbl-row ghost' role='presentation'>
                        <span className='g'>
                          {total
                            ? `No ${status} shot in this scene.`
                            : '○ no shots yet — ＋ Shot lays out the first.'}
                        </span>
                      </div>
                    ) : (
                      list.map((shot) => {
                        const frame = frameOf(shot)
                        const on = shot.id === selected
                        return (
                          <button
                            key={shot.id}
                            type='button'
                            role='option'
                            aria-selected={on}
                            tabIndex={on ? 0 : -1}
                            data-shot={shot.id}
                            className={`tbl-row${on ? ' sel' : ''}`}
                            onClick={() => select(shot.id)}
                          >
                            <span className='num'>{shot.code}</span>
                            <span>
                              <ShotThumb
                                shot={shot}
                                preview={
                                  frame ? (previews[frame.id] ?? null) : null
                                }
                                tc={timecode(shot.startS)}
                                state={
                                  shot.job?.state === 'awaiting_upload'
                                    ? 'wait'
                                    : undefined
                                }
                              />
                            </span>
                            <span
                              className='act'
                              lang={isThai(shot.action) ? 'th' : undefined}
                            >
                              {shot.action}
                            </span>
                            <span className='meta'>
                              <span className='num'>
                                {shot.durationS
                                  ? `${Number(shot.durationS)} s`
                                  : '—'}
                              </span>
                              <span className='var' data-k='still'>
                                {shot.image ? shot.image.label : '—'}
                              </span>
                              <span className='var' data-k='motion'>
                                {shot.video ? shot.video.label : '—'}
                              </span>
                              <span className={`res${frame ? '' : ' none'}`}>
                                {frame ? (frame.title ?? frame.name) : '—'}
                              </span>
                              <span className='st'>
                                {jobWord(
                                  shot.job?.state === 'awaiting_upload'
                                    ? shot.job
                                    : null,
                                ) ?? (
                                  <span
                                    className={`state-word${isGen(shot.status) ? ' gen' : ''}`}
                                  >
                                    {shot.status}
                                  </span>
                                )}
                              </span>
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>
      <Inspector
        id='story'
        label='Shot'
        empty={!current && !addingScene}
        onClose={() => select(null)}
      >
        {addingScene ? (
          <ShotForm
            key={`new-${addingScene.id}`}
            project={project}
            board={board}
            scene={addingScene}
            shot={null}
            variants={variants}
            apply={apply}
            onClose={() => setAdding(null)}
            onSaved={(id) => select(id, true)}
          />
        ) : current && scene ? (
          <ShotInspector
            key={current.id}
            project={project}
            board={board}
            scene={scene}
            shot={current}
            previews={previews}
            variants={variants}
            files={files}
            apply={apply}
            onClose={() => select(null)}
            generators={generators}
            onGenerate={generate}
            onMark={mark}
            onAttached={addPreviews}
            onDeleted={() => select(null)}
          />
        ) : (
          <>
            <InspectorHead title='Shot' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>
                {shots.length
                  ? 'Select a shot to generate it, pick its variants or attach its result.'
                  : '○ nothing yet — ＋ Shot on a scene lays out the first.'}
              </Empty>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

function ShotForm({
  project,
  board,
  scene,
  shot,
  variants,
  apply,
  onClose,
  onSaved,
  embedded = false,
}: {
  project: StoryProject
  board: StoryBoardData
  scene: SceneData
  shot: ShotData | null
  variants: VariantOptionData[]
  apply: Common['apply']
  onClose: () => void
  onSaved: (id: string) => void
  /** Inside the shot inspector, not a panel of its own. */
  embedded?: boolean
}) {
  const [action, setAction] = useState(shot?.action ?? '')
  const [duration, setDuration] = useState(
    shot?.durationS ? String(Number(shot.durationS)) : '',
  )
  const [imageId, setImageId] = useState(shot?.imageVariantId ?? '')
  const [videoId, setVideoId] = useState(shot?.videoVariantId ?? '')
  const [cast, setCast] = useState<string[]>(shot?.characterIds ?? [])
  const [notes, setNotes] = useState(shot?.notes ?? '')
  const [pending, start] = useTransition()
  const still = variants.filter((variant) => variant.medium === 'image')
  const motion = variants.filter((variant) => variant.medium === 'video')
  const dirty =
    !shot ||
    action !== shot.action ||
    duration !== (shot.durationS ? String(Number(shot.durationS)) : '') ||
    imageId !== (shot.imageVariantId ?? '') ||
    videoId !== (shot.videoVariantId ?? '') ||
    notes !== shot.notes ||
    cast.join() !== shot.characterIds.join()

  const save = () =>
    start(async () => {
      const result = await saveShotAction({
        projectId: project.id,
        sceneId: scene.id,
        ...(shot ? { shotId: shot.id, expectedRevision: shot.revision } : {}),
        action,
        durationS: duration.trim() || null,
        imageVariantId: imageId || null,
        videoVariantId: videoId || null,
        characterIds: cast,
        notes,
      })
      if (!apply(result, shot ? `Saved shot ${shot.code}` : 'Shot added'))
        return
      if (!result.ok) return
      const saved = shot
        ? shot.id
        : result.data.scenes
            .find((entry) => entry.id === scene.id)
            ?.shots.at(-1)?.id
      if (saved) onSaved(saved)
    })

  const form = (
    <form
      className='fcard pickers'
      onSubmit={(event) => {
        event.preventDefault()
        if (action.trim() && dirty) save()
      }}
    >
      <label>
        Action
        <textarea
          value={action}
          rows={2}
          maxLength={2000}
          placeholder='Mara wakes before the ferry horn.'
          // biome-ignore lint/a11y/noAutofocus: the form opens on purpose
          autoFocus={!shot}
          onChange={(event) => setAction(event.target.value)}
        />
      </label>
      <label>
        Seconds
        <input
          type='text'
          inputMode='decimal'
          value={duration}
          placeholder='4'
          onChange={(event) => setDuration(event.target.value)}
        />
      </label>
      <label>
        Still variant
        <select
          value={imageId}
          onChange={(event) => setImageId(event.target.value)}
        >
          <option value=''>— none —</option>
          {still.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {variantLabel(variant)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Motion variant
        <select
          value={videoId}
          onChange={(event) => setVideoId(event.target.value)}
        >
          <option value=''>— none —</option>
          {motion.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {variantLabel(variant)}
            </option>
          ))}
        </select>
      </label>
      {still.length + motion.length === 0 ? (
        <p className='hint'>
          No image or video prompt yet — write one in{' '}
          <a className='lnk' href={`/p/${project.slug}/prompts`}>
            Prompts
          </a>
          ; Generate uses the variants picked here.
        </p>
      ) : (
        <p className='hint'>
          Prompt variants from Prompts. Generate uses the two picked here.
        </p>
      )}
      {board.characters.length ? (
        <fieldset className='cast'>
          <legend className='fld-label'>Cast</legend>
          {board.characters.map((character) => (
            <label key={character.id} className='chk'>
              <input
                type='checkbox'
                checked={cast.includes(character.id)}
                onChange={(event) =>
                  setCast((list) =>
                    event.target.checked
                      ? [...list, character.id]
                      : list.filter((id) => id !== character.id),
                  )
                }
              />
              <Name text={character.name} />
            </label>
          ))}
        </fieldset>
      ) : null}
      <label>
        Notes
        <textarea
          value={notes}
          rows={2}
          maxLength={4000}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <div className='row'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={pending || !action.trim() || !dirty}
        >
          {shot ? 'Save shot' : 'Add shot'}
        </button>
        {shot ? null : (
          <button type='button' className='btn' onClick={onClose}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
  if (embedded) return form
  return (
    <>
      <InspectorHead
        title={
          <>
            <Dot color={project.color} /> Scene {scene.number} › New shot
          </>
        }
        meta='draft'
        onClose={onClose}
      />
      <div className='insp-body'>
        <p className='dev-p'>
          Scene {scene.number} · <Name text={scene.heading} /> — it lands at the
          end as shot {scene.number}.{scene.shots.length + 1}, boarded.
        </p>
        {form}
      </div>
    </>
  )
}

function ShotInspector({
  project,
  board,
  scene,
  shot,
  previews,
  variants,
  files,
  apply,
  onClose,
  generators,
  onGenerate,
  onMark,
  onAttached,
  onDeleted,
}: {
  project: StoryProject
  board: StoryBoardData
  scene: SceneData
  shot: ShotData
  previews: Record<string, string>
  variants: VariantOptionData[]
  files: FileOption[]
  apply: Common['apply']
  onClose: () => void
  generators: GeneratorOption[]
  onGenerate: (
    shot: ShotData,
    medium: 'image' | 'video',
    generatorId: string | null,
  ) => Promise<void>
  onMark: (shot: ShotData, status: ShotStatus) => Promise<void>
  onAttached: (ids: string[]) => Promise<void>
  onDeleted: () => void
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const [level, setLevel] = useState<number | null>(null)
  const [pick, setPick] = useState('')
  const [asking, setAsking] = useState(false)
  /** Generate with: '' is by hand, otherwise a generator connection. */
  const [withId, setWithId] = useState('')
  const using = generators.find((entry) => entry.id === withId) ?? null
  const input = useRef<HTMLInputElement>(null)
  const index = scene.shots.findIndex((entry) => entry.id === shot.id)
  const still = newest(shot, 'image')
  const motion = newest(shot, 'video')
  const waiting = shot.job?.state === 'awaiting_upload' ? shot.job : null
  const waitingVariant = waiting
    ? waiting.variantId === shot.imageVariantId
      ? shot.image
      : waiting.variantId === shot.videoVariantId
        ? shot.video
        : null
    : null
  const cast = shot.characterIds
    .map(
      (id) =>
        board.characters.find((character) => character.id === id)?.name ?? '?',
    )
    .join(' · ')
  const attachable = files.filter(
    (file) => !shot.results.some((asset) => asset.id === file.id),
  )

  const attach = (assetId: string, jobId?: string) =>
    start(async () => {
      const result = await attachResultAction({
        projectId: project.id,
        shotId: shot.id,
        assetId,
        ...(jobId ? { jobId } : {}),
      })
      if (apply(result, `Attached to shot ${shot.code}`)) {
        setPick('')
        await onAttached([assetId])
      }
    })

  const upload = (file: File) =>
    start(async () => {
      setLevel(0)
      const uploaded = await uploadFile(
        file,
        { projectId: project.id, ...(waiting ? { jobId: waiting.id } : {}) },
        setLevel,
      )
      setLevel(null)
      if (!uploaded.ok) {
        toast(uploaded.error)
        return
      }
      const result = await attachResultAction({
        projectId: project.id,
        shotId: shot.id,
        assetId: uploaded.asset.id,
        ...(waiting ? { jobId: waiting.id } : {}),
      })
      if (apply(result, `Shot ${shot.code}: ${file.name} attached`))
        await onAttached([uploaded.asset.id])
    })

  const open = async (assetId: string) => {
    const result = await accessUrlAction({ assetId })
    if (result.ok) window.open(result.data.url, '_blank', 'noopener')
    else toast(result.error)
  }

  const remove = () =>
    start(async () => {
      if (
        apply(
          await deleteShotAction({
            projectId: project.id,
            shotId: shot.id,
            expectedRevision: shot.revision,
          }),
          `Deleted shot ${shot.code} — its files stay in Assets`,
        )
      )
        onDeleted()
    })

  return (
    <>
      <InspectorHead
        title={
          <>
            <Dot color={project.color} /> <Name text={project.name} /> › Shot{' '}
            {shot.code}
          </>
        }
        meta={waiting ? '◆ awaiting upload' : shot.status}
        onClose={onClose}
      />
      <div className='insp-body'>
        <Readout
          big={
            <>
              {shot.durationS ? Number(shot.durationS) : '—'}{' '}
              <span className='u'>s</span>
            </>
          }
          sub={`Scene ${scene.number} · ${scene.heading} · shot ${index + 1} of ${scene.shots.length} · at ${timecode(shot.startS)}`}
          tone={waiting ? 'wait' : isGen(shot.status) ? '' : 'dim'}
        />
        <div className='pair'>
          <figure>
            {still ? (
              <ShotThumb
                shot={shot}
                preview={previews[still.id] ?? null}
                label='still'
                tc={timecode(shot.startS)}
              />
            ) : (
              <ShotThumb
                shot={{ code: shot.code, status: 'boarded' }}
                preview={null}
                label='still'
                state={
                  waiting && waiting.variantId === shot.imageVariantId
                    ? 'wait'
                    : undefined
                }
              />
            )}
            <figcaption>
              <span>still</span>
              <span>{shot.image?.label ?? '—'}</span>
            </figcaption>
          </figure>
          <figure>
            {motion ? (
              <ShotThumb
                shot={shot}
                preview={previews[motion.id] ?? null}
                label='motion'
                tc={timecode(shot.startS)}
              />
            ) : (
              <ShotThumb
                shot={{ code: shot.code, status: 'boarded' }}
                preview={null}
                label='motion'
                state={
                  waiting && waiting.variantId === shot.videoVariantId
                    ? 'wait'
                    : undefined
                }
              />
            )}
            <figcaption>
              <span>motion</span>
              <span>{shot.video?.label ?? '—'}</span>
            </figcaption>
          </figure>
        </div>

        {waiting ? (
          <div className='why gen-wait'>
            <b>Make it elsewhere, then drop the file here.</b>{' '}
            {waitingVariant ? (
              <>
                Prompt: <i>{variantLabel(waitingVariant)}</i>.
              </>
            ) : null}
            {waitingVariant?.text ? (
              <pre className='prompt-text'>{waitingVariant.text}</pre>
            ) : null}
            <div className='dev-acts'>
              {waitingVariant?.text ? (
                <button
                  type='button'
                  className='btn btn-sm'
                  onClick={() =>
                    navigator.clipboard
                      .writeText(waitingVariant.text)
                      .then(() => toast('Prompt copied'))
                      .catch(() => toast('Couldn’t copy — select the text'))
                  }
                >
                  Copy prompt
                </button>
              ) : null}
              <button
                type='button'
                className='btn btn-sm btn-pri'
                disabled={pending}
                onClick={() => input.current?.click()}
              >
                Upload result
              </button>
            </div>
          </div>
        ) : null}
        {level !== null ? (
          <span className='prog' role='progressbar' aria-valuenow={level}>
            <i style={{ ['--level' as string]: `${level}%` }} />
          </span>
        ) : null}
        <input
          ref={input}
          type='file'
          hidden
          accept='image/*,video/*,audio/*'
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) upload(file)
          }}
        />

        {generators.length ? (
          <label className='gen-with'>
            <span className='hud-label'>Generate with</span>
            <select
              value={withId}
              onChange={(event) => setWithId(event.target.value)}
            >
              <option value=''>by hand — you make the file</option>
              {generators.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                  {entry.video ? '' : ' · stills only'}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className='dev-acts'>
          <button
            type='button'
            className='btn btn-pri'
            disabled={
              pending || !shot.imageVariantId || (using ? !using.image : false)
            }
            title={
              shot.imageVariantId
                ? using
                  ? `HQ asks ${using.label} for the still now`
                  : 'Opens a job for the still; you make the file and drop it here'
                : 'Pick a still variant first'
            }
            onClick={() => onGenerate(shot, 'image', withId || null)}
          >
            {still ? 'Regenerate still' : 'Generate still'}
            <kbd>g</kbd>
          </button>
          <button
            type='button'
            className='btn'
            disabled={
              pending || !shot.videoVariantId || (using ? !using.video : false)
            }
            title={
              shot.videoVariantId
                ? using
                  ? using.video
                    ? `HQ asks ${using.label} for the motion; it’s collected when ready`
                    : `${using.label} makes stills only`
                  : 'Opens a job for the motion; you make the file and drop it here'
                : 'Pick a motion variant first'
            }
            onClick={() => onGenerate(shot, 'video', withId || null)}
          >
            {motion ? 'Regenerate motion' : 'Generate motion'}
          </button>
          {waiting ? null : (
            <button
              type='button'
              className='btn'
              disabled={pending}
              onClick={() => input.current?.click()}
            >
              Upload a file
            </button>
          )}
        </div>
        <div className='dev-acts'>
          <button
            type='button'
            className='btn btn-sm'
            disabled={!isGen(shot.status) || shot.status === 'edited'}
            onClick={() => onMark(shot, 'edited')}
          >
            Mark edited<kbd>e</kbd>
          </button>
          <button
            type='button'
            className='btn btn-sm'
            disabled={!isGen(shot.status) || shot.status === 'done'}
            onClick={() => onMark(shot, 'done')}
          >
            Mark done<kbd>d</kbd>
          </button>
        </div>

        <Facts
          rows={[
            [
              'status',
              waiting ? `${shot.status} · awaiting upload` : shot.status,
            ],
            ['timecode', timecode(shot.startS)],
            ['still', shot.image ? variantLabel(shot.image) : '—'],
            ['motion', shot.video ? variantLabel(shot.video) : '—'],
            [
              'results',
              shot.results.length
                ? String(shot.results.length)
                : '○ nothing yet',
            ],
            ['cast', cast || '—'],
          ]}
        />

        {shot.results.length ? (
          <>
            <div className='dev-h'>
              <span className='hud-label'>Results · in Assets</span>
            </div>
            <div className='dev-rows'>
              {[...shot.results].reverse().map((asset) => (
                <button
                  key={asset.id}
                  type='button'
                  className='dev-row'
                  onClick={() => open(asset.id)}
                  title='Open the file'
                >
                  <span className='n'>{asset.kind}</span>
                  <span className='t'>{asset.title ?? asset.name}</span>
                  <span className='v'>open ↗</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
        {attachable.length ? (
          <div className='fcard'>
            <label>
              Attach a file already in Assets
              <select
                value={pick}
                onChange={(event) => setPick(event.target.value)}
              >
                <option value=''>— choose —</option>
                {attachable.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.kind} · {file.title}
                  </option>
                ))}
              </select>
            </label>
            <div className='row'>
              <button
                type='button'
                className='btn btn-sm'
                disabled={!pick || pending}
                onClick={() => attach(pick, waiting?.id)}
              >
                Attach
              </button>
            </div>
          </div>
        ) : null}

        <div className='dev-h'>
          <span className='hud-label'>Shot</span>
        </div>
        <ShotForm
          key={`${shot.id}-${shot.revision}`}
          project={project}
          board={board}
          scene={scene}
          shot={shot}
          variants={variants}
          apply={apply}
          onClose={onClose}
          onSaved={() => {}}
          embedded
        />
        {asking ? (
          <p className='why'>
            <b>Delete shot {shot.code}?</b> The shots after it renumber; its
            files stay in Assets.{' '}
            <button
              type='button'
              className='btn btn-sm'
              disabled={pending}
              onClick={remove}
            >
              Delete
            </button>{' '}
            <button
              type='button'
              className='btn btn-sm'
              onClick={() => setAsking(false)}
            >
              Keep
            </button>
          </p>
        ) : (
          <div className='dev-acts'>
            <button
              type='button'
              className='btn btn-sm'
              onClick={() => setAsking(true)}
            >
              Delete shot
            </button>
          </div>
        )}
      </div>
    </>
  )
}
