'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import {
  age,
  bytesLabel,
  Dot,
  durationLabel,
  Empty,
  Inspector,
  InspectorHead,
  isThai,
  Name,
  PaneHead,
  Tag,
  usePageKeys,
} from '@/components/bridge/parts'
import { Confirm } from '@/components/Confirm'
import { usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import { refreshAction } from '@/lib/refresh-action'
import {
  type AssetDetailData,
  accessUrlAction,
  assetDetailAction,
  createCollectionAction,
  deleteAssetAction,
  deleteCollectionAction,
  finalizeUploadAction,
  prepareThumbnailAction,
  prepareUploadAction,
  rejectAssetAction,
  renameCollectionAction,
  setCollectionMemberAction,
  setTagsAction,
  setThumbnailAction,
  setTitleAction,
} from '../actions'
import type { AssetData, CollectionData } from '../data'
import { measure, put } from '../upload'

/**
 * Assets: the files a project keeps,
 * as a Grid, a List or Collections, beside an inspector whose viewer carries
 * the page's one instrument — the timecode · dimensions · bytes strip.
 *
 * Upload is drop (or `u`) → the browser sends the bytes straight to the
 * project's storage with progress → HQ confirms them and the tile becomes
 * ready. A video uploaded to R2 also gets a still grabbed here from its first
 * second. Ready files are frozen: the title (Rename `e`), tags and
 * collections change, the file doesn't — it keeps the name it was uploaded
 * under, which a download saves as. On `/assets` a file needs a project to
 * land in, so the page asks for one before any file is picked.
 *
 * Collections are folders: a click (or `↵`) opens one — the Grid, filtered
 * to it, with `?collection=<id>` in the URL so a reload or a link keeps it.
 * Inside it, with no file picked, the inspector holds the collection.
 *
 * Nothing is picked when the page opens, so the inspector is out of the way
 * until you pick a file.
 *
 * Removing: Delete `⌫` takes an asset's bytes with it, so
 * it asks in place. The collection's panel holds Rename `e` and Delete `⌫` —
 * which removes the grouping and never a file, and asks too. A collection HQ
 * files into says why it stays where those buttons would be.
 */

export type AssetsProject = {
  id: string
  slug: string
  name: string
  color: string
  status: string
}

export type AssetsPageProps = {
  project: AssetsProject | null
  projects: AssetsProject[]
  assets: AssetData[]
  total: number
  collections: CollectionData[]
  previews: Record<string, string>
  view: 'grid' | 'list' | 'collections'
  selectedId: string | null
  /** `?collection=`: in Collections the one selected; in Grid and List the one open. */
  selectedCollectionId: string | null
}

type Upload = {
  id: string
  name: string
  progress: number | null
  error: string | null
}

const KINDS = ['all', 'image', 'video', 'audio', 'doc', 'other'] as const
const ORIGINS = ['upload', 'generated', 'import'] as const
const MAX_SHOWN = 120
/** On `/assets`, before a project is picked: said on the drop tile and when Upload is pressed. */
const CHOOSE = 'Choose a project first — files land in one project’s storage.'
const fileCount = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`

const sizeWord = (asset: AssetData) =>
  asset.kind === 'video' || asset.kind === 'audio'
    ? durationLabel(asset.durationMs)
    : asset.width
      ? `${asset.width}×${asset.height}`
      : '—'

export function AssetsPage(props: AssetsPageProps) {
  const router = useRouter()
  const toast = useToast()
  const [assets, setAssets] = useState(props.assets)
  const [collections, setCollections] = useState(props.collections)
  const [selected, setSelected] = useState<string | null>(props.selectedId)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all')
  const [origin, setOrigin] = useState('all')
  /** The open collection in Grid and List (`?collection=`), `none` for unfiled, else `all`. */
  const [collection, setCollection] = useState(
    props.view === 'collections'
      ? 'all'
      : (props.selectedCollectionId ?? 'all'),
  )
  const [tags, setTags] = useState<string[]>([])
  const [who, setWho] = useState(
    () =>
      (props.view !== 'collections' &&
        props.project === null &&
        props.collections.find(
          (entry) => entry.id === props.selectedCollectionId,
        )?.projectId) ||
      'all',
  )
  const [over, setOver] = useState(false)
  const [shelf, setShelf] = useState<string | null>(
    props.view === 'collections' ? props.selectedCollectionId : null,
  )
  /** Which removal is asking in place — the key and the button open the same question. */
  const [asking, setAsking] = useState<'asset' | 'collection' | null>(null)
  const [renaming, setRenaming] = useState(false)
  /** The asset's Rename form is open (`e`). */
  const [retitling, setRetitling] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const paneRef = useRef<HTMLElement>(null)
  const all = props.project === null
  const view = props.view
  const needsProject = all && who === 'all' && props.projects.length > 0

  useEffect(() => setAssets(props.assets), [props.assets])
  useEffect(() => setCollections(props.collections), [props.collections])
  // Opening a collection is a navigation (`?collection=`); follow it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new URL moves the filter, not a changed list
  useEffect(() => {
    if (props.view === 'collections') return
    const id = props.selectedCollectionId
    setCollection(id ?? 'all')
    const entry = collections.find((other) => other.id === id)
    if (props.project === null && entry) setWho(entry.projectId ?? 'all')
  }, [props.view, props.selectedCollectionId])

  const projectOf = useCallback(
    (id: string | null) =>
      props.projects.find((project) => project.id === id) ?? null,
    [props.projects],
  )
  const base = useMemo(
    () =>
      all
        ? assets.filter((asset) => who === 'all' || asset.projectId === who)
        : assets,
    [all, assets, who],
  )
  const tagOptions = useMemo(() => {
    const count = new Map<string, number>()
    for (const asset of base)
      for (const tag of asset.tags) count.set(tag, (count.get(tag) ?? 0) + 1)
    const top = [...count.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([tag]) => tag)
    return [...new Set([...top, ...tags])]
  }, [base, tags])
  const shown = useMemo(
    () =>
      base.filter(
        (asset) =>
          (kind === 'all' || asset.kind === kind) &&
          (origin === 'all' || asset.origin === origin) &&
          (collection === 'all' ||
            (collection === 'none'
              ? asset.collectionIds.length === 0
              : asset.collectionIds.includes(collection))) &&
          tags.every((tag) => asset.tags.includes(tag)),
      ),
    [base, kind, origin, collection, tags],
  )
  const visible = shown.slice(0, MAX_SHOWN)
  const current = assets.find((asset) => asset.id === selected) ?? null
  const scopeCollections = collections.filter(
    (entry) => !all || who === 'all' || entry.projectId === who,
  )
  const shelved =
    view === 'collections'
      ? (scopeCollections.find((entry) => entry.id === shelf) ?? null)
      : null

  /** The collection open in Grid or List, whose panel the inspector holds when no file is picked. */
  const opened =
    view === 'collections'
      ? null
      : (collections.find((entry) => entry.id === collection) ?? null)

  /** Focus a tile or row by id once it has drawn, and keep it in view. */
  const focusTile = useCallback((id: string) => {
    requestAnimationFrame(() => {
      const element = paneRef.current?.querySelector<HTMLElement>(
        `[data-id="${id}"]`,
      )
      element?.focus({ preventScroll: true })
      element?.scrollIntoView({ block: 'nearest' })
    })
  }, [])

  const select = useCallback(
    (id: string | null, focus = false) => {
      setSelected(id)
      setAsking(null)
      setRetitling(false)
      const url = new URL(window.location.href)
      if (id) url.searchParams.set('asset', id)
      else url.searchParams.delete('asset')
      window.history.replaceState(null, '', url)
      if (focus && id) focusTile(id)
    },
    [focusTile],
  )

  /** Collections: the one the inspector holds (`?collection=`). */
  const selectShelf = useCallback(
    (id: string | null, focus = false) => {
      setShelf(id)
      setAsking(null)
      setRenaming(false)
      const url = new URL(window.location.href)
      if (id) url.searchParams.set('collection', id)
      else url.searchParams.delete('collection')
      window.history.replaceState(null, '', url)
      if (focus && id) focusTile(id)
    },
    [focusTile],
  )

  /** Open a collection: the Grid, filtered to it (and, on `/assets`, to its project), in the URL. */
  const openShelf = (entry: CollectionData) => {
    setCollection(entry.id)
    if (all) setWho(entry.projectId ?? 'all')
    router.push(
      `${window.location.pathname}?collection=${encodeURIComponent(entry.id)}`,
    )
  }

  /** The toolbar's Collection filter; it rides in the URL like an opened collection. */
  const filterCollection = (value: string) => {
    setCollection(value)
    setSelected(null)
    setAsking(null)
    setRetitling(false)
    const url = new URL(window.location.href)
    url.searchParams.delete('asset')
    if (value === 'all') url.searchParams.delete('collection')
    else url.searchParams.set('collection', value)
    window.history.replaceState(null, '', url)
  }

  const replaceShelf = (next: CollectionData) =>
    setCollections((list) =>
      list.map((entry) => (entry.id === next.id ? next : entry)),
    )

  /** The grouping is gone; every file it held stays where it is. */
  const dropShelf = (entry: CollectionData, count: number) => {
    const index = scopeCollections.findIndex((other) => other.id === entry.id)
    const next =
      scopeCollections[index + 1] ?? scopeCollections[index - 1] ?? null
    setCollections((list) => list.filter((other) => other.id !== entry.id))
    setAssets((list) =>
      list.map((asset) =>
        asset.collectionIds.includes(entry.id)
          ? {
              ...asset,
              collectionIds: asset.collectionIds.filter(
                (id) => id !== entry.id,
              ),
            }
          : asset,
      ),
    )
    if (collection === entry.id) filterCollection('all')
    if (view === 'collections') selectShelf(next?.id ?? null, true)
    toast(
      `Deleted collection ${entry.name} — ${count ? `its ${fileCount(count)} stay` : 'it held no files'}`,
    )
  }

  /** `u` and ＋ Upload: the file picker — or, on `/assets` before a project is picked, the project. */
  const startUpload = () => {
    if (needsProject) {
      toast(CHOOSE)
      document.getElementById('assets-project')?.focus()
      return
    }
    fileInput.current?.click()
  }

  const replace = (next: AssetData) =>
    setAssets((list) =>
      list.some((asset) => asset.id === next.id)
        ? list.map((asset) => (asset.id === next.id ? next : asset))
        : [next, ...list],
    )

  /** One file through the three steps; the tile shows each. */
  const uploadOne = async (file: File) => {
    const key = `${file.name}-${file.size}-${Math.random()}`
    const track = (patch: Partial<Upload>) =>
      setUploads((list) =>
        list.map((entry) =>
          entry.id === key ? { ...entry, ...patch } : entry,
        ),
      )
    setUploads((list) => [
      ...list,
      { id: key, name: file.name, progress: 0, error: null },
    ])
    const projectId = props.project?.id ?? (who !== 'all' ? who : null)
    const prepared = await prepareUploadAction({
      projectId,
      name: file.name,
      mime: file.type || 'application/octet-stream',
      bytes: file.size,
      collectionId:
        collection !== 'all' && collection !== 'none' ? collection : undefined,
    })
    if (!prepared.ok) {
      track({ error: prepared.error, progress: null })
      toast(`${file.name}: ${prepared.error}`)
      return
    }
    replace(prepared.data.asset)
    const measured = measure(file)
    try {
      await put(
        prepared.data.upload.url,
        file,
        prepared.data.upload.mode === 'presigned_put'
          ? prepared.data.upload.headers
          : {},
        (level) => track({ progress: level }),
      )
    } catch (error) {
      track({ error: (error as Error).message, progress: null })
      toast(`${file.name}: ${(error as Error).message}`)
      return
    }
    track({ progress: null })
    const dims = await measured
    // Quiet: the batch re-renders once, at the end (`uploadAll`).
    const ready = await finalizeUploadAction(
      {
        assetId: prepared.data.asset.id,
        width: dims.width,
        height: dims.height,
        durationMs: dims.durationMs,
      },
      { quiet: true },
    )
    if (!ready.ok) {
      track({ error: ready.error })
      toast(`${file.name}: ${ready.error}`)
      return
    }
    replace(ready.data)
    setUploads((list) => list.filter((entry) => entry.id !== key))
    if (
      dims.still &&
      ready.data.kind === 'video' &&
      ready.data.storage === 'r2'
    ) {
      const place = await prepareThumbnailAction({
        assetId: ready.data.id,
        bytes: dims.still.size,
      })
      if (place.ok) {
        try {
          await put(place.data.url, dims.still, place.data.headers, () => {})
          const withThumb = await setThumbnailAction(
            { assetId: ready.data.id, key: place.data.key },
            { quiet: true },
          )
          if (withThumb.ok) replace(withThumb.data)
        } catch {
          // No still; the tile says what the file is instead.
        }
      }
    }
    return ready.data
  }

  const uploadAll = async (files: FileList | File[]) => {
    const list = [...files]
    if (list.length === 0) return
    // The drop tile already says so; a drop elsewhere on the pane lands here.
    if (needsProject) {
      toast(CHOOSE)
      return
    }
    const done = await Promise.all(list.map(uploadOne))
    const ok = done.filter(Boolean)
    if (ok.length) {
      toast(`${ok.length} ${ok.length === 1 ? 'file' : 'files'} ready`)
      select(ok[0]?.id ?? null)
      void refreshAction()
    }
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setOver(false)
    if (event.dataTransfer.files.length)
      void uploadAll(event.dataTransfer.files)
  }

  usePageKeyHints(
    view === 'collections'
      ? [
          ['u', 'upload'],
          ['↵', 'open'],
          ...(shelved && !shelved.held
            ? ([
                ['e', 'rename'],
                ['⌫', 'delete'],
              ] as const)
            : []),
          ['↑ ↓', 'collections'],
          ['1 2 3', 'grid · list · collections'],
        ]
      : [
          ['u', 'upload'],
          ['d', 'download'],
          ...(current ? ([['e', 'rename']] as const) : []),
          ['k', 'collection'],
          ['t', 'tag'],
          ...(current?.status === 'pending'
            ? ([['x', 'reject']] as const)
            : []),
          ...(current ? ([['⌫', 'delete']] as const) : []),
          ['↑ ↓', 'assets'],
          ['1 2 3', 'grid · list · collections'],
        ],
  )

  usePageKeys((key, event) => {
    if (key === 'u') {
      startUpload()
      return true
    }
    if (view === 'collections') {
      if (key === 'Escape' && shelved) {
        selectShelf(null)
        return true
      }
      const at = scopeCollections.findIndex((entry) => entry.id === shelf)
      if (['ArrowDown', 'ArrowRight', 'j'].includes(key)) {
        const next =
          scopeCollections[Math.min(scopeCollections.length - 1, at + 1)]
        if (next) selectShelf(next.id, true)
        return Boolean(next)
      }
      if (['ArrowUp', 'ArrowLeft', 'k'].includes(key)) {
        const next = scopeCollections[Math.max(0, at - 1)]
        if (next) selectShelf(next.id, true)
        return Boolean(next)
      }
      if (!shelved) return false
      // ↵ on a focused button or link is that control's own click.
      if (
        key === 'Enter' &&
        !(event.target as HTMLElement | null)?.closest?.('button, a')
      ) {
        openShelf(shelved)
        return true
      }
      if (key === 'e' || key === 'Backspace' || key === 'Delete') {
        if (shelved.held) toast(shelved.held)
        else if (key === 'e') setRenaming(true)
        else setAsking('collection')
        return true
      }
      return false
    }
    if (key === 'Escape' && selected) {
      select(null)
      return true
    }
    const index = visible.findIndex((asset) => asset.id === selected)
    if (key === 'ArrowDown' || key === 'ArrowRight' || key === 'j') {
      const next = visible[Math.min(visible.length - 1, index + 1)]
      if (next) select(next.id, true)
      return Boolean(next)
    }
    if (key === 'ArrowUp' || key === 'ArrowLeft' || key === 'k') {
      if (key === 'k' && current) {
        document.getElementById('asset-collection')?.focus()
        return true
      }
      const next = visible[Math.max(0, index - 1)]
      if (next) select(next.id, true)
      return Boolean(next)
    }
    if (!current) return false
    if (key === 'd' && current.status === 'ready') {
      void accessUrlAction({ assetId: current.id, download: true }).then(
        (result) => {
          if (result.ok) window.location.assign(result.data.url)
          else toast(result.error)
        },
      )
      return true
    }
    if (key === 'e') {
      setRetitling(true)
      return true
    }
    if (key === 't') {
      document.getElementById('asset-tag')?.focus()
      return true
    }
    if (key === 'x' && current.status === 'pending') {
      void rejectAssetAction({ assetId: current.id }).then((result) => {
        if (result.ok) {
          replace(result.data)
          toast(`Rejected: ${current.title}`)
        } else toast(result.error)
      })
      return true
    }
    if (key === 'Backspace' || key === 'Delete') {
      setAsking('asset')
      return true
    }
    return false
  })

  const project = props.project
  const ready = assets.filter((asset) => asset.status === 'ready')
  const readyBytes = ready.reduce((sum, asset) => sum + asset.bytes, 0)
  const pending = assets.filter((asset) => asset.status === 'pending').length

  return (
    <div className='page assetsp'>
      <section
        className={`pane pool-pane${project?.status === 'paused' ? ' paused' : ''}`}
        aria-label='Assets'
        ref={paneRef}
      >
        <PaneHead
          title={
            <>
              {all ? (
                'Assets · all projects'
              ) : (
                <>
                  {project ? <Dot color={project.color} /> : null} Assets ·{' '}
                  <Name text={project?.name ?? ''} />
                </>
              )}
              {opened ? (
                <>
                  {' '}
                  › <Name text={opened.name} />
                </>
              ) : null}
            </>
          }
          meta={`${ready.length} ready · ${bytesLabel(readyBytes)}${pending ? ` · ${pending} pending` : ''}${props.total > assets.length ? ` · showing ${assets.length} of ${props.total}` : ''}`}
        >
          <button
            type='button'
            className='btn btn-sm'
            title={needsProject ? CHOOSE : undefined}
            onClick={startUpload}
          >
            ＋ Upload<kbd>u</kbd>
          </button>
        </PaneHead>
        <input
          ref={fileInput}
          type='file'
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) void uploadAll(event.target.files)
            event.target.value = ''
          }}
        />
        <div className='toolbar'>
          {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons */}
          <span className='seg' role='group' aria-label='Kind'>
            {KINDS.map((entry) => (
              <button
                key={entry}
                type='button'
                aria-pressed={kind === entry}
                onClick={() => setKind(entry)}
              >
                {entry}
              </button>
            ))}
          </span>
          <label className='field'>
            Collection
            <select
              aria-label='Collection'
              value={collection}
              onChange={(event) => filterCollection(event.target.value)}
            >
              <option value='all'>all collections</option>
              {scopeCollections.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                  {all ? ` · ${projectOf(entry.projectId)?.name ?? 'HQ'}` : ''}{' '}
                  ({entry.count})
                </option>
              ))}
              <option value='none'>unfiled</option>
            </select>
          </label>
          <label className='field'>
            Origin
            <select
              aria-label='Origin'
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
            >
              <option value='all'>any origin</option>
              {ORIGINS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          {tagOptions.length ? (
            // biome-ignore lint/a11y/useSemanticElements: tag toggles are a group of buttons
            <span className='tagchips' role='group' aria-label='Tags'>
              {tagOptions.map((tag) => (
                <button
                  key={tag}
                  type='button'
                  className='label-chip'
                  aria-pressed={tags.includes(tag)}
                  onClick={() =>
                    setTags((list) =>
                      list.includes(tag)
                        ? list.filter((entry) => entry !== tag)
                        : [...list, tag],
                    )
                  }
                >
                  {tag}
                </button>
              ))}
            </span>
          ) : null}
          <span className='sp' />
          {all ? (
            <label className='field'>
              Project
              <select
                id='assets-project'
                aria-label='Project'
                value={who}
                onChange={(event) => setWho(event.target.value)}
              >
                <option value='all'>all projects</option>
                {props.projects.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span className='hits'>
            {shown.length === base.length
              ? `${base.length} listed`
              : `${shown.length} of ${base.length} listed`}
          </span>
        </div>
        <div
          className='pane-body'
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return
            event.preventDefault()
            // Without a project nothing lights up; the drop says why.
            setOver(!needsProject)
          }}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setOver(false)
          }}
          onDrop={onDrop}
        >
          {view === 'collections' ? (
            <CollectionsView
              collections={scopeCollections}
              assets={assets}
              previews={props.previews}
              all={all}
              selectedId={shelved?.id ?? null}
              projectOf={projectOf}
              onSelect={(id) => selectShelf(id)}
              onOpen={openShelf}
            />
          ) : view === 'list' ? (
            visible.length === 0 ? (
              <Empty>
                {assets.length > 0
                  ? 'Nothing matches these filters.'
                  : needsProject
                    ? '○ nothing yet — choose a project, then press u or drop files here.'
                    : '○ nothing yet — press u or drop files here.'}
              </Empty>
            ) : (
              <div
                className={`tbl${all ? ' with-project' : ''}`}
                role='listbox'
                aria-label='Assets'
              >
                <div className='tbl-head' aria-hidden='true'>
                  {all ? <span className='hud-label'>project</span> : null}
                  <span className='hud-label'>name</span>
                  <span className='hud-label'>kind</span>
                  <span className='hud-label c-size'>size</span>
                  <span className='hud-label c-bytes num'>bytes</span>
                  <span className='hud-label c-coll'>collection</span>
                  <span className='hud-label'>status</span>
                </div>
                {visible.map((asset) => {
                  const collectionName = collections.find((entry) =>
                    asset.collectionIds.includes(entry.id),
                  )?.name
                  return (
                    <button
                      key={asset.id}
                      type='button'
                      role='option'
                      aria-selected={asset.id === selected}
                      data-id={asset.id}
                      className={`tbl-row ${asset.status}${asset.id === selected ? ' sel' : ''}`}
                      onClick={() => select(asset.id)}
                    >
                      {all ? (
                        <span>
                          <Tag project={projectOf(asset.projectId)} />
                        </span>
                      ) : null}
                      <span
                        className='name'
                        title={asset.path}
                        lang={isThai(asset.title) ? 'th' : undefined}
                      >
                        {asset.title}
                      </span>
                      <span className='c-kind'>{asset.kind}</span>
                      <span className='c-size'>{sizeWord(asset)}</span>
                      <span className='num c-bytes'>
                        {bytesLabel(asset.bytes)}
                      </span>
                      <span className='c-coll'>{collectionName ?? '—'}</span>
                      <span className='c-status'>
                        <StatusWord
                          asset={asset}
                          upload={
                            uploads.find(
                              (entry) => entry.name === asset.name,
                            ) ?? null
                          }
                        />
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          ) : (
            <>
              <div className='pool apool' role='listbox' aria-label='Assets'>
                {needsProject ? (
                  <button
                    type='button'
                    className='mdrop'
                    aria-label={CHOOSE}
                    onClick={startUpload}
                  >
                    <span>Choose a project first</span>
                    <small>files land in one project’s storage</small>
                  </button>
                ) : (
                  <button
                    type='button'
                    className={`mdrop${over ? ' over' : ''}`}
                    aria-label='Upload — drop files here or press u'
                    onClick={startUpload}
                  >
                    <span className='big' aria-hidden='true'>
                      ＋
                    </span>
                    <span>Drop files here</span>
                    <small>
                      or press <kbd>u</kbd>
                    </small>
                  </button>
                )}
                {visible.map((asset) => (
                  <AssetTile
                    key={asset.id}
                    asset={asset}
                    preview={props.previews[asset.id] ?? null}
                    project={all ? projectOf(asset.projectId) : null}
                    selected={asset.id === selected}
                    upload={
                      uploads.find(
                        (entry) =>
                          entry.name === asset.name &&
                          asset.status === 'pending',
                      ) ?? null
                    }
                    onSelect={() => select(asset.id)}
                  />
                ))}
              </div>
              {assets.length === 0 ? (
                <Empty>
                  ○ nothing yet — the first upload lands on the tile.
                </Empty>
              ) : visible.length === 0 ? (
                <Empty>Nothing matches these filters.</Empty>
              ) : shown.length > visible.length ? (
                <Empty>
                  showing {visible.length} of {shown.length} — narrow the
                  filters to see the rest.
                </Empty>
              ) : null}
            </>
          )}
        </div>
      </section>
      <Inspector
        id='assets'
        label={
          view === 'collections'
            ? 'Selected collection'
            : current || !opened
              ? 'Selected asset'
              : 'Open collection'
        }
        empty={!(view === 'collections' ? shelved : current)}
        onClose={() =>
          view === 'collections' ? selectShelf(null) : select(null)
        }
      >
        {view === 'collections' ? (
          shelved ? (
            <CollectionInspector
              key={shelved.id}
              collection={shelved}
              project={projectOf(shelved.projectId) ?? project}
              members={assets.filter((asset) =>
                asset.collectionIds.includes(shelved.id),
              )}
              previews={props.previews}
              renaming={renaming}
              onRenaming={setRenaming}
              deleting={asking === 'collection'}
              onDeleting={(on) => setAsking(on ? 'collection' : null)}
              onClose={() => selectShelf(null)}
              onOpen={() => openShelf(shelved)}
              onRenamed={replaceShelf}
              onDeleted={(count) => dropShelf(shelved, count)}
            />
          ) : (
            <>
              <InspectorHead title='Collection' meta='nothing selected' />
              <div className='insp-body'>
                <Empty>
                  {scopeCollections.length
                    ? 'Click a collection to open its files. To rename or delete one, open it, or pick it with ↑ ↓.'
                    : 'No collections here. Make one from an asset’s Collection menu.'}
                </Empty>
              </div>
            </>
          )
        ) : current ? (
          <AssetInspector
            key={current.id}
            asset={current}
            project={projectOf(current.projectId) ?? project}
            collections={collections.filter(
              (entry) => entry.projectId === current.projectId,
            )}
            preview={props.previews[current.id] ?? null}
            retitling={retitling}
            onRetitling={setRetitling}
            deleting={asking === 'asset'}
            onDeleting={(on) => setAsking(on ? 'asset' : null)}
            onClose={() => select(null)}
            onChanged={(next) => {
              replace(next)
            }}
            onDeleted={() => {
              const index = visible.findIndex(
                (asset) => asset.id === current.id,
              )
              const next = visible[index + 1] ?? visible[index - 1] ?? null
              setAssets((list) =>
                list.filter((asset) => asset.id !== current.id),
              )
              select(next?.id ?? null, Boolean(next))
            }}
            onCollections={(ids) =>
              setAssets((list) =>
                list.map((asset) =>
                  asset.id === current.id
                    ? { ...asset, collectionIds: ids }
                    : asset,
                ),
              )
            }
            onCollectionMade={(made) =>
              setCollections((list) => [...list, made])
            }
          />
        ) : opened ? (
          <CollectionInspector
            key={opened.id}
            collection={opened}
            project={projectOf(opened.projectId) ?? project}
            members={assets.filter((asset) =>
              asset.collectionIds.includes(opened.id),
            )}
            previews={props.previews}
            renaming={renaming}
            onRenaming={setRenaming}
            deleting={asking === 'collection'}
            onDeleting={(on) => setAsking(on ? 'collection' : null)}
            onOpen={null}
            onRenamed={replaceShelf}
            onDeleted={(count) => dropShelf(opened, count)}
          />
        ) : (
          <>
            <InspectorHead title='Asset' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>Select an asset to see it on the viewer.</Empty>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

function StatusWord({
  asset,
  upload,
}: {
  asset: AssetData
  upload: Upload | null
}) {
  if (asset.status === 'rejected')
    return <span className='state-word'>rejected</span>
  if (asset.status === 'ready') return <span className='state-word'>ready</span>
  if (upload?.error)
    return <span className='state-word wait'>◆ {upload.error}</span>
  const level = upload?.progress
  return (
    <>
      <span className='state-word live'>
        ▶{' '}
        {upload
          ? level === null
            ? 'confirming'
            : `uploading · ${level}%`
          : 'waiting for its bytes'}
      </span>
      <span
        className={`prog${level == null ? ' indet' : ''}`}
        aria-hidden='true'
      >
        <i style={{ ['--level' as string]: `${level ?? 100}%` }} />
      </span>
    </>
  )
}

function Thumb({
  asset,
  preview,
  shape,
  tc,
}: {
  asset: AssetData
  preview: string | null
  shape?: string
  tc?: string
}) {
  const [broken, setBroken] = useState(false)
  const real =
    asset.status === 'ready' &&
    (asset.kind === 'image' || asset.kind === 'video')
  return (
    <div
      className={`thumb${real ? ' real' : ''}${shape ? ` ${shape}` : ''}`}
      role='img'
      aria-label={`${asset.kind}${tc ? ` · ${tc}` : ''}`}
      style={preview && !broken ? { padding: 0 } : undefined}
    >
      {asset.status === 'pending' ? (
        <i className='glyph live st' aria-hidden='true'>
          ▶
        </i>
      ) : null}
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
        <span>{asset.kind}</span>
      )}
      {tc ? <span className='tc'>{tc}</span> : null}
    </div>
  )
}

function AssetTile({
  asset,
  preview,
  project,
  selected,
  upload,
  onSelect,
}: {
  asset: AssetData
  preview: string | null
  project: AssetsProject | null
  selected: boolean
  upload: Upload | null
  onSelect: () => void
}) {
  return (
    <div
      className={`pcard acard ${asset.status}${selected ? ' sel' : ''}`}
      role='option'
      aria-selected={selected}
      aria-label={`${asset.title}, ${asset.kind}, ${asset.status}`}
      tabIndex={selected ? 0 : -1}
      data-id={asset.id}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      <Thumb asset={asset} preview={preview} />
      <div
        className='t'
        title={asset.path}
        lang={isThai(asset.title) ? 'th' : undefined}
      >
        {asset.title}
      </div>
      <div className='m'>
        <span>
          {project ? (
            <Tag project={project} />
          ) : (
            `${asset.kind} · ${sizeWord(asset)}`
          )}
        </span>
        <span>
          {asset.status === 'ready' ? (
            bytesLabel(asset.bytes)
          ) : (
            <StatusWord asset={asset} upload={upload} />
          )}
        </span>
      </div>
    </div>
  )
}

/** Four of a collection's files, blank where it has fewer. */
function Quad({
  members,
  previews,
}: {
  members: AssetData[]
  previews: Record<string, string>
}) {
  return (
    <div className='quad'>
      {[0, 1, 2, 3].map((slot) => {
        const member = members[slot]
        return member ? (
          <Thumb
            key={member.id}
            asset={member}
            preview={previews[member.id] ?? null}
          />
        ) : (
          <div
            key={`blank-${slot}`}
            className='thumb blank'
            aria-hidden='true'
          />
        )
      })}
    </div>
  )
}

/** Collections as cards, like folders: a click (or ↵) opens one's files; ↑ ↓ and ␣ pick one for the inspector. */
function CollectionsView({
  collections,
  assets,
  previews,
  all,
  selectedId,
  projectOf,
  onSelect,
  onOpen,
}: {
  collections: CollectionData[]
  assets: AssetData[]
  previews: Record<string, string>
  all: boolean
  selectedId: string | null
  projectOf: (id: string | null) => AssetsProject | null
  onSelect: (id: string) => void
  onOpen: (collection: CollectionData) => void
}) {
  if (collections.length === 0)
    return <Empty>No collections here; every asset is unfiled.</Empty>
  return (
    <div className='pool cpool' role='listbox' aria-label='Collections'>
      {collections.map((entry) => {
        const members = assets
          .filter((asset) => asset.collectionIds.includes(entry.id))
          .slice(0, 4)
        const selected = entry.id === selectedId
        return (
          <div
            key={entry.id}
            className={`pcard ccard${selected ? ' sel' : ''}`}
            role='option'
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-id={entry.id}
            onClick={() => onOpen(entry)}
            onKeyDown={(event) => {
              if (event.key === ' ') {
                event.preventDefault()
                onSelect(entry.id)
              }
            }}
            aria-label={`${entry.name}, ${entry.kind}, ${fileCount(entry.count)}`}
          >
            <Quad members={members} previews={previews} />
            <div className='t' lang={isThai(entry.name) ? 'th' : undefined}>
              {entry.name}
            </div>
            <div className='m'>
              <span>
                {all ? (
                  <Tag project={projectOf(entry.projectId)} />
                ) : (
                  entry.kind
                )}
              </span>
              <span className='n'>{entry.count}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * A collection's panel: its files at a glance, then Open
 * `↵` (while it isn't open yet) · Rename `e` · Delete `⌫`. Rename is a form
 * card; Delete asks in place because it can't come back — and says the files
 * stay. A collection HQ files into keeps its name and stays, and says why
 * where the buttons would be.
 */
function CollectionInspector({
  collection,
  project,
  members,
  previews,
  renaming,
  onRenaming,
  deleting,
  onDeleting,
  onClose,
  onOpen,
  onRenamed,
  onDeleted,
}: {
  collection: CollectionData
  project: AssetsProject | null
  members: AssetData[]
  previews: Record<string, string>
  renaming: boolean
  onRenaming: (renaming: boolean) => void
  deleting: boolean
  onDeleting: (asking: boolean) => void
  /** Without one, ✕ closes the inspector around it. */
  onClose?: () => void
  /** Null once it is open (the Grid shows its files). */
  onOpen: (() => void) | null
  onRenamed: (collection: CollectionData) => void
  onDeleted: (files: number) => void
}) {
  const toast = useToast()
  const [name, setName] = useState(collection.name)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const cancel = () => {
    setName(collection.name)
    setError(null)
    onRenaming(false)
  }
  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const next = name.trim()
    if (!next || next === collection.name) return
    const before = collection.name
    start(async () => {
      const result = await renameCollectionAction({
        collectionId: collection.id,
        expectedRevision: collection.revision,
        name: next,
        count: collection.count,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setError(null)
      onRenaming(false)
      onRenamed(result.data)
      toast(`Renamed ${before} → ${result.data.name}`, {
        undo: async () => {
          const back = await renameCollectionAction({
            collectionId: collection.id,
            expectedRevision: result.data.revision,
            name: before,
            count: result.data.count,
          })
          if (back.ok) {
            onRenamed(back.data)
            setName(back.data.name)
          } else toast(back.error)
        },
      })
    })
  }

  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} />{' '}
            <span style={{ color: 'var(--ink-4)' }}>›</span>{' '}
            <Name text={collection.name} />
          </>
        }
        meta={fileCount(collection.count)}
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <div className='viewer cviewer'>
            <Quad members={members.slice(0, 4)} previews={previews} />
          </div>
          <dl className='facts'>
            <dt>kind</dt>
            <dd>{collection.kind}</dd>
            <dt>files</dt>
            <dd>{collection.count} ready</dd>
            <dt>project</dt>
            <dd>{project?.name ?? 'HQ'}</dd>
          </dl>
        </div>
        <div className='dev-main'>
          <p className='dev-p note'>
            A collection groups files; a file can sit in several. Removing one
            never removes its files.
          </p>
          <div className='dev-acts'>
            {onOpen ? (
              <button
                type='button'
                className='btn btn-sm btn-pri'
                onClick={onOpen}
              >
                Open<kbd>↵</kbd>
              </button>
            ) : null}
            {collection.held ? (
              <p className='why-not'>{collection.held}</p>
            ) : (
              <>
                {renaming ? null : (
                  <button
                    type='button'
                    className='btn btn-sm'
                    onClick={() => onRenaming(true)}
                  >
                    Rename<kbd>e</kbd>
                  </button>
                )}
                <Confirm
                  label='Delete'
                  kbd='⌫'
                  question={`Delete the collection? ${collection.count ? `Its ${fileCount(collection.count)} stay` : 'Nothing is in it'}; only the grouping goes.`}
                  yes='Delete collection'
                  asking={deleting}
                  onAsking={onDeleting}
                  run={async () => {
                    const result = await deleteCollectionAction(collection.id)
                    if (result.ok) onDeleted(result.data.files)
                    else toast(result.error)
                  }}
                />
              </>
            )}
          </div>
          {renaming && !collection.held ? (
            <form
              className='fcard'
              onSubmit={rename}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  cancel()
                }
              }}
            >
              <label>
                Name
                <input
                  // biome-ignore lint/a11y/noAutofocus: the field is what the owner just asked for
                  autoFocus
                  type='text'
                  value={name}
                  maxLength={80}
                  autoComplete='off'
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {error ? <p className='err'>{error}</p> : null}
              <div className='row'>
                <button
                  type='submit'
                  className='btn btn-sm btn-pri'
                  disabled={
                    pending || !name.trim() || name.trim() === collection.name
                  }
                >
                  {pending ? 'Saving…' : 'Save'}
                  <kbd>↵</kbd>
                </button>
                <button type='button' className='btn btn-sm' onClick={cancel}>
                  Cancel<kbd>Esc</kbd>
                </button>
              </div>
              <p className='hint'>
                Files already in it keep the path they were stored under; new
                uploads go under the new name.
              </p>
            </form>
          ) : null}
        </div>
      </div>
    </>
  )
}

const LINK_LABEL: Record<string, string> = {
  card: '▦ card',
  prompt_variant: '✎ prompt',
  prompt: '✎ prompt',
  quote: '▧ quote',
  shot: '▤ shot',
  note: 'note',
}

function AssetInspector({
  asset,
  project,
  collections,
  preview,
  retitling,
  onRetitling,
  deleting,
  onDeleting,
  onClose,
  onChanged,
  onDeleted,
  onCollections,
  onCollectionMade,
}: {
  asset: AssetData
  project: AssetsProject | null
  collections: CollectionData[]
  preview: string | null
  /** The Rename form is open (the button or `e`). */
  retitling: boolean
  onRetitling: (open: boolean) => void
  /** Delete is asking in place (the button or `⌫`). */
  deleting: boolean
  onDeleting: (asking: boolean) => void
  onClose: () => void
  onChanged: (asset: AssetData) => void
  onDeleted: () => void
  onCollections: (ids: string[]) => void
  onCollectionMade: (collection: CollectionData) => void
}) {
  const toast = useToast()
  const [detail, setDetail] = useState<AssetDetailData | null>(null)
  const [tag, setTag] = useState('')
  const [naming, setNaming] = useState(false)
  const [collectionName, setCollectionName] = useState('')
  const [pending, start] = useTransition()
  const [title, setTitle] = useState(asset.titled ? asset.title : '')
  const [titleError, setTitleError] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new revision means new detail to read
  useEffect(() => {
    let alive = true
    assetDetailAction(asset.id).then((result) => {
      if (alive && result.ok) setDetail(result.data)
    })
    return () => {
      alive = false
    }
  }, [asset.id, asset.revision])
  const tc = [
    asset.kind === 'video' || asset.kind === 'audio'
      ? durationLabel(asset.durationMs)
      : null,
    asset.width ? `${asset.width}×${asset.height}` : null,
    bytesLabel(asset.bytes),
  ]
    .filter(Boolean)
    .join(' · ')
  const shape =
    asset.width && asset.height
      ? asset.width < asset.height
        ? 'portrait'
        : asset.width === asset.height
          ? 'square'
          : ''
      : ''
  const inCollections = detail?.collectionIds ?? asset.collectionIds
  const run = (work: () => Promise<void>) => start(work)

  const cancelTitle = () => {
    setTitle(asset.titled ? asset.title : '')
    setTitleError(null)
    onRetitling(false)
  }
  /** A new title; empty puts the file name back. The toast's Undo restores the one before. */
  const saveTitle = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const before = asset.titled ? asset.title : ''
    if (title.trim() === before) {
      cancelTitle()
      return
    }
    run(async () => {
      const result = await setTitleAction({
        assetId: asset.id,
        expectedRevision: asset.revision,
        title,
      })
      if (!result.ok) {
        setTitleError(result.error)
        return
      }
      setTitleError(null)
      onRetitling(false)
      onChanged(result.data)
      toast(
        result.data.titled
          ? `Renamed ${asset.title} → ${result.data.title}`
          : `${result.data.title} shows its file name again`,
        {
          undo: async () => {
            const back = await setTitleAction({
              assetId: asset.id,
              expectedRevision: result.data.revision,
              title: before,
            })
            if (back.ok) {
              onChanged(back.data)
              setTitle(back.data.titled ? back.data.title : '')
            } else toast(back.error)
          },
        },
      )
    })
  }

  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} />{' '}
            <span style={{ color: 'var(--ink-4)' }}>›</span>{' '}
            <Name text={asset.title} />
          </>
        }
        meta={asset.status === 'ready' ? bytesLabel(asset.bytes) : asset.status}
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <div className='viewer'>
            <Thumb
              asset={asset}
              preview={detail?.preview ?? preview}
              shape={shape}
              tc={tc}
            />
          </div>
          <dl className='facts'>
            <dt>file</dt>
            <dd lang={isThai(asset.name) ? 'th' : undefined}>{asset.name}</dd>
            <dt>kind</dt>
            <dd>{asset.kind}</dd>
            <dt>mime</dt>
            <dd>{asset.mime}</dd>
            <dt>bytes</dt>
            <dd>
              {bytesLabel(asset.bytes)} · {asset.bytes.toLocaleString('en')} B
            </dd>
            <dt>dimensions</dt>
            <dd>{asset.width ? `${asset.width} × ${asset.height}` : '—'}</dd>
            <dt>duration</dt>
            <dd>
              {asset.durationMs != null ? durationLabel(asset.durationMs) : '—'}
            </dd>
            <dt>sha256</dt>
            <dd title={asset.sha256 ?? undefined}>
              {asset.sha256
                ? `${asset.sha256.slice(0, 16)}…`
                : (asset.sha256Note ?? '— not yet')}
            </dd>
            <dt>origin</dt>
            <dd>
              {asset.origin} ·{' '}
              {asset.actorType === 'user' ? 'you' : asset.actorType}
            </dd>
            <dt>storage</dt>
            <dd>{asset.storage === 'gdrive' ? 'Google Drive' : 'R2'}</dd>
            <dt>status</dt>
            <dd>{asset.status}</dd>
            <dt>added</dt>
            <dd>{age(asset.createdAt)} ago</dd>
          </dl>
        </div>
        <div className='dev-main'>
          <p className='path'>{asset.path}</p>
          <p className='dev-p note'>
            {asset.status === 'ready'
              ? 'A ready file is frozen: its title, tags and collections change, the file doesn’t — upload a new version for that.'
              : asset.status === 'pending'
                ? 'Waiting for its bytes. Reject discards it.'
                : (asset.problem ?? 'Rejected before it became ready.')}
          </p>
          <div className='dev-acts'>
            {asset.status === 'ready' ? (
              <button
                type='button'
                className='btn btn-sm btn-pri'
                onClick={() =>
                  run(async () => {
                    const result = await accessUrlAction({
                      assetId: asset.id,
                      download: true,
                    })
                    if (result.ok) window.location.assign(result.data.url)
                    else toast(result.error)
                  })
                }
              >
                Download<kbd>d</kbd>
              </button>
            ) : null}
            {asset.status === 'ready' ? (
              <button
                type='button'
                className='btn btn-sm'
                onClick={() =>
                  run(async () => {
                    const result = await accessUrlAction({ assetId: asset.id })
                    if (result.ok)
                      window.open(result.data.url, '_blank', 'noopener')
                    else toast(result.error)
                  })
                }
              >
                Open
              </button>
            ) : null}
            {asset.status === 'pending' ? (
              <button
                type='button'
                className='btn btn-sm'
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    const result = await rejectAssetAction({
                      assetId: asset.id,
                    })
                    if (result.ok) {
                      onChanged(result.data)
                      toast(`Rejected: ${asset.title}`)
                    } else toast(result.error)
                  })
                }
              >
                Reject<kbd>x</kbd>
              </button>
            ) : null}
            {retitling ? null : (
              <button
                type='button'
                className='btn btn-sm'
                onClick={() => onRetitling(true)}
              >
                Rename<kbd>e</kbd>
              </button>
            )}
            <Confirm
              label='Delete'
              kbd='⌫'
              disabled={pending}
              question={
                asset.storage === 'gdrive'
                  ? 'Delete for good? The file goes to your Drive’s trash.'
                  : 'Delete for good? The file goes with it.'
              }
              yes='Delete'
              asking={deleting}
              onAsking={onDeleting}
              run={async () => {
                const result = await deleteAssetAction(asset.id)
                if (result.ok) {
                  toast(
                    `Deleted: ${asset.title}${asset.storage === 'gdrive' ? ' — it is in your Drive’s trash' : ''}`,
                  )
                  onDeleted()
                } else toast(result.error)
              }}
            />
          </div>
          {retitling ? (
            <form
              className='fcard'
              onSubmit={saveTitle}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  cancelTitle()
                }
              }}
            >
              <label>
                Title
                <input
                  // biome-ignore lint/a11y/noAutofocus: the field is what the owner just asked for
                  autoFocus
                  type='text'
                  value={title}
                  placeholder={asset.name}
                  maxLength={200}
                  autoComplete='off'
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              {titleError ? <p className='err'>{titleError}</p> : null}
              <div className='row'>
                <button
                  type='submit'
                  className='btn btn-sm btn-pri'
                  disabled={
                    pending ||
                    title.trim() === (asset.titled ? asset.title : '')
                  }
                >
                  {pending ? 'Saving…' : 'Save'}
                  <kbd>↵</kbd>
                </button>
                <button
                  type='button'
                  className='btn btn-sm'
                  onClick={cancelTitle}
                >
                  Cancel<kbd>Esc</kbd>
                </button>
              </div>
              <p className='hint'>
                The file keeps its name, {asset.name}, and downloads under it.
                Leave this empty to show the file name again.
              </p>
            </form>
          ) : null}
          <form
            className='tagform'
            onSubmit={(event) => {
              event.preventDefault()
              const next = tag.trim()
              if (!next) return
              run(async () => {
                const result = await setTagsAction({
                  assetId: asset.id,
                  expectedRevision: asset.revision,
                  tags: [...asset.tags, next],
                })
                if (result.ok) {
                  setTag('')
                  onChanged(result.data)
                } else toast(result.error)
              })
            }}
          >
            <input
              id='asset-tag'
              value={tag}
              placeholder='new tag…'
              aria-label='New tag'
              maxLength={32}
              onChange={(event) => setTag(event.target.value)}
            />
            <button
              type='submit'
              className='btn btn-sm'
              disabled={pending || !tag.trim()}
            >
              Tag<kbd>t</kbd>
            </button>
          </form>
          {asset.tags.length ? (
            <div className='labels'>
              {asset.tags.map((entry) => (
                <button
                  key={entry}
                  type='button'
                  className='label-chip'
                  title={`Remove ${entry}`}
                  onClick={() =>
                    run(async () => {
                      const result = await setTagsAction({
                        assetId: asset.id,
                        expectedRevision: asset.revision,
                        tags: asset.tags.filter((t) => t !== entry),
                      })
                      if (result.ok) onChanged(result.data)
                      else toast(result.error)
                    })
                  }
                >
                  {entry} ×
                </button>
              ))}
            </div>
          ) : null}
          <label className='field'>
            Collection
            <select
              id='asset-collection'
              value=''
              onChange={(event) => {
                const value = event.target.value
                if (!value) return
                if (value === '__new') {
                  setNaming(true)
                  return
                }
                run(async () => {
                  const member = !inCollections.includes(value)
                  const result = await setCollectionMemberAction({
                    collectionId: value,
                    assetId: asset.id,
                    member,
                  })
                  if (result.ok) {
                    const ids = member
                      ? [...inCollections, value]
                      : inCollections.filter((id) => id !== value)
                    onCollections(ids)
                    setDetail((current) =>
                      current ? { ...current, collectionIds: ids } : current,
                    )
                  } else toast(result.error)
                })
              }}
            >
              <option value=''>
                {inCollections.length
                  ? `in ${collections
                      .filter((entry) => inCollections.includes(entry.id))
                      .map((entry) => entry.name)
                      .join(', ')}`
                  : 'unfiled'}{' '}
                — add or remove…
              </option>
              {collections.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {inCollections.includes(entry.id) ? '✓ ' : ''}
                  {entry.name}
                </option>
              ))}
              <option value='__new'>＋ New collection…</option>
            </select>
          </label>
          {naming ? (
            <form
              className='tagform'
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setNaming(false)
                }
              }}
              onSubmit={(event) => {
                event.preventDefault()
                const name = collectionName.trim()
                if (!name) return
                run(async () => {
                  const made = await createCollectionAction({
                    projectId: asset.projectId,
                    name,
                  })
                  if (!made.ok) {
                    toast(made.error)
                    return
                  }
                  onCollectionMade(made.data)
                  const added = await setCollectionMemberAction({
                    collectionId: made.data.id,
                    assetId: asset.id,
                    member: true,
                  })
                  if (added.ok) {
                    onCollections([...inCollections, made.data.id])
                    setDetail((current) =>
                      current
                        ? {
                            ...current,
                            collectionIds: [...inCollections, made.data.id],
                          }
                        : current,
                    )
                    setNaming(false)
                    setCollectionName('')
                    toast(`Collection ${name} made; ${asset.title} is in it`)
                  } else toast(added.error)
                })
              }}
            >
              <input
                // biome-ignore lint/a11y/noAutofocus: the field is what the owner just asked for
                autoFocus
                value={collectionName}
                placeholder='collection name…'
                aria-label='New collection name'
                maxLength={80}
                onChange={(event) => setCollectionName(event.target.value)}
              />
              <button
                type='submit'
                className='btn btn-sm'
                disabled={pending || !collectionName.trim()}
              >
                Make<kbd>↵</kbd>
              </button>
            </form>
          ) : null}
          {detail && detail.links.length > 0 ? (
            <>
              <div className='dev-h'>
                <span className='hud-label'>Linked from</span>
              </div>
              <div className='refs'>
                {detail.links.map((link) => (
                  <span
                    key={`${link.type}-${link.id}-${link.role}`}
                    className='btn btn-sm'
                    title={link.role}
                  >
                    {LINK_LABEL[link.type] ?? link.type} ·{' '}
                    {link.role.replace('_', ' ')}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className='dev-p note'>
              No prompt, card, quote or shot points at this asset.
            </p>
          )}
          {project ? (
            <div className='insp-links'>
              <Link className='btn btn-sm' href={`/p/${project.slug}`}>
                Project map
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}
