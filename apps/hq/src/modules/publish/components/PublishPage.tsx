'use client'

import { formatMoney } from '@theiceji/hq-core/money'
import Link from 'next/link'
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from 'react'
import {
  Empty,
  Facts,
  Inspector,
  InspectorHead,
  isThai,
  PaneHead,
  Readout,
  Tag,
  usePageKeys,
} from '@/components/bridge/parts'
import { Confirm } from '@/components/Confirm'
import { usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import type { ActionResult } from '@/lib/actions'
import type { ConnectionOption, FileOption } from '@/lib/module-page'
import type { AgeReadingData } from '@/modules/experiments/data'
import {
  archiveAccountAction,
  clearPostAction,
  deletePostAction,
  dispatchPostAction,
  planPostAction,
  postAction,
  postAgesAction,
  recordPostedAction,
  recordReadingAction,
  removePostAction,
  saveAccountAction,
  unschedulePostAction,
  updatePostAction,
} from '../actions'
import type {
  AccountData,
  PostDetailData,
  PostRowData,
  PublishProject,
  ReadingRowData,
} from '../data'

/**
 * Publish: a
 * channel's accounts and the posts that leave through them — Table +
 * Inspector. A post is planned → scheduled (the owner cleared exactly this
 * payload) → dispatched (sent through an API) → posted (on the record with
 * evidence) → verified (read back); or removed · failed.
 *
 * Clear to post is the one red button: clearing is what lets a post leave
 * HQ. Editing a cleared post takes the clearance back. The instrument is the
 * age ruler — views at 1h · 24h · 72h · 7d, lit where a reading exists near
 * that age, dashed where the age passed without one, dim where it hasn't
 * come — with the post's age now as the playhead. A gap is never a 0.
 */

export type PublishPageProps = {
  project: PublishProject
  accounts: AccountData[]
  posts: PostRowData[]
  detail: PostDetailData | null
  files: FileOption[]
  connections: ConnectionOption[]
  view: 'posts' | 'accounts'
  selectedId: string | null
  creating: boolean
  /** Views at each ruler age, per post: `ages[postId]['72']`. */
  ages: Record<string, Record<string, AgeReadingData>>
  readAt: string
}

type Platform = AccountData['platform']
const PLATFORM: Record<Platform, string> = {
  tiktok: 'TikTok',
  youtube: 'YouTube',
  facebook: 'Facebook',
  manual: 'Other',
}
const EVIDENCE = [
  ['owner_attested', 'I posted it — my word'],
  ['screenshot', 'I have a screenshot'],
  ['platform_export', 'it’s in a platform export'],
] as const
const METRICS = [
  'views',
  'likes',
  'comments',
  'shares',
  'saves',
  'watch_seconds',
  'earnings',
]
const AGES = [
  [1, '1h'],
  [24, '24h'],
  [72, '72h'],
  [168, '7d'],
] as const
const MARK_X = [12.5, 37.5, 62.5, 87.5]
const XS: [number, number][] = [
  [0, 0],
  [1, 12.5],
  [24, 37.5],
  [72, 62.5],
  [168, 87.5],
  [336, 98],
]
const OUT = ['dispatched', 'posted', 'verified']
const CHIPS = ['all', 'planned', 'cleared', 'out', 'failed'] as const
/** A question open in the inspector's action row: its key and its button ask the same thing. */
type Armed = null | 'clear' | 'post' | 'delete'

const xOf = (hours: number) => {
  for (let i = 1; i < XS.length; i++) {
    const [h1, x1] = XS[i] as [number, number]
    if (hours <= h1) {
      const [h0, x0] = XS[i - 1] as [number, number]
      return x0 + ((x1 - x0) * (hours - h0)) / (h1 - h0)
    }
  }
  return 98
}
const hoursBetween = (from: string, to: string) =>
  (Date.parse(to) - Date.parse(from)) / 3_600_000
const spanWord = (h: number) =>
  h < 1
    ? `${Math.max(1, Math.round(h * 60))}m`
    : h < 48
      ? `${Math.round(h)}h`
      : `${Math.round(h / 24)}d`
const ageWord = (h: number) =>
  h < 1
    ? `${Math.max(1, Math.round(h * 60))}m`
    : h < 48
      ? `${Math.round(h)}h`
      : `${Math.floor(h / 24)}d ${Math.floor(h % 24)}h`
const count = (value: string) => Number(value).toLocaleString('en-US')
const compact = (n: number) =>
  n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US')
const nameOf = (post: { title: string | null; caption: string }) =>
  post.title || post.caption.split('\n')[0] || 'Untitled post'
const outAt = (post: PostRowData) => post.postedAt
const isOut = (post: PostRowData) => OUT.includes(post.status)
/** `2026-09-26T14:30` in the browser's own zone, for a datetime-local field. */
const localInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromLocal = (value: string) =>
  value ? new Date(value).toISOString() : undefined

/**
 * Whole days as a reading span, held inside what can have been earned: not
 * before the post went out, not after now.
 */
function daySpan(from: string, to: string, postedAt: string | null) {
  const start = new Date(`${from}T00:00`).getTime()
  const end = new Date(`${to}T23:59:59`).getTime()
  const out = postedAt ? Date.parse(postedAt) : Number.NEGATIVE_INFINITY
  return {
    windowStart: new Date(Math.max(start, out)).toISOString(),
    windowEnd: new Date(Math.min(end, Date.now() - 1000)).toISOString(),
  }
}

function useWhen(timezone: string) {
  return useMemo(() => {
    const full = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    })
    const day = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: timezone,
    })
    return {
      when: (iso: string | null) => (iso ? full.format(new Date(iso)) : '—'),
      day: (iso: string | null) => (iso ? day.format(new Date(iso)) : '—'),
    }
  }, [timezone])
}

function how(account: AccountData) {
  const name = PLATFORM[account.platform]
  if (account.readiness.mode === 'reconnect')
    return {
      mode: 'reconnect' as const,
      word: 'reconnect',
      hint: account.readiness.note,
    }
  if (account.readiness.mode === 'api')
    return {
      mode: 'api' as const,
      word: 'through the API',
      hint: 'Cleared posts go out through the API at their time, and HQ reads them back.',
    }
  return {
    mode: 'hand' as const,
    word: 'by hand',
    hint:
      account.readiness.note ||
      `HQ can’t post to ${name} by itself — post it yourself and record it.`,
  }
}

const Glyph = ({ tone, char }: { tone: string; char: string }) => (
  <>
    <i className={`glyph ${tone}`} aria-hidden='true'>
      {char}
    </i>{' '}
  </>
)

function StateWord({
  post,
  readAt,
  blocked,
}: {
  post: PostRowData
  readAt: string
  blocked?: boolean
}) {
  if (post.status === 'planned') {
    if (blocked)
      return (
        <span className='state-word problem'>
          <Glyph tone='due' char='◆' />
          planned · can’t go yet
        </span>
      )
    return (
      <span className='state-word'>
        planned
        {post.statusReason?.includes('clear') ? ' · clear it again' : ''}
      </span>
    )
  }
  if (post.status === 'scheduled')
    return (
      <span className='state-word due'>
        cleared
        {post.clearance
          ? ` · expires in ${spanWord(Math.max(0, hoursBetween(readAt, post.clearance.expiresAt)))}`
          : ''}
      </span>
    )
  if (post.status === 'dispatched')
    return (
      <span className='state-word live'>
        <Glyph tone='live' char='▶' />
        sent · reading it back
      </span>
    )
  if (post.status === 'verified')
    return <span className='state-word live'>verified</span>
  if (post.status === 'removed')
    return <span className='state-word off'>removed</span>
  if (post.status === 'failed')
    return (
      <span className='state-word problem' title={post.statusReason ?? ''}>
        <Glyph tone='due' char='◆' />
        failed{post.statusReason ? ` · ${post.statusReason}` : ''}
      </span>
    )
  return <span className='state-word'>{post.status}</span>
}

/** The instrument: views at 1h · 24h · 72h · 7d along an LCD line, the age now as the playhead. */
function Ruler({
  post,
  ages,
  readAt,
  when,
}: {
  post: PostRowData
  ages: Record<string, AgeReadingData> | undefined
  readAt: string
  when: (iso: string | null) => string
}) {
  const t0 = outAt(post)
  const out = Boolean(t0) && post.status !== 'failed'
  const now = t0 ? Math.max(0, hoursBetween(t0, readAt)) : 0
  const removed = post.status === 'removed'
  const marks = AGES.map(([age, label]) => {
    const reading = ages?.[String(age)]
    if (!out || !reading || reading.state === 'not_out')
      return { cls: 'off', value: '—', label }
    if (reading.state === 'known')
      return { cls: 'lit', value: count(reading.value), label }
    if (reading.state === 'too_young')
      return {
        cls: 'soon',
        value: removed
          ? 'removed'
          : `in ${spanWord(hoursBetween(readAt, reading.readyAt))}`,
        label,
      }
    return { cls: 'gap', value: '— not read', label }
  })
  const right =
    post.status === 'failed'
      ? 'never went out'
      : !t0
        ? `not out · ${post.status === 'scheduled' ? 'goes' : 'planned for'} ${post.scheduledFor ? when(post.scheduledFor) : '—'}`
        : removed
          ? 'removed'
          : `age now ${ageWord(now)}`
  const aria = `Views at age. ${marks.map((m) => `${m.label}: ${m.value}`).join('; ')}. ${right}.`
  return (
    <div className='ruler' role='img' aria-label={aria}>
      <div className='ruler-h'>
        <span className='hud-label'>views at age</span>
        <span className={`now${out && !removed ? '' : ' off'}`}>{right}</span>
      </div>
      <div className='ruler-body' aria-hidden='true'>
        <i className='line' />
        {out ? (
          <i
            className='past'
            style={{ ['--x' as string]: `${xOf(now).toFixed(2)}%` }}
          />
        ) : null}
        {marks.map((mark, index) => (
          <div
            key={mark.label}
            className={`mk ${mark.cls}`}
            style={{ ['--x' as string]: `${MARK_X[index]}%` }}
          >
            <b>{mark.value}</b>
            <i className='tk' />
            <span>{mark.label}</span>
          </div>
        ))}
        {out && !removed ? (
          <i
            className='head'
            style={{ ['--x' as string]: `${xOf(now).toFixed(2)}%` }}
          />
        ) : null}
      </div>
    </div>
  )
}

function Blockers({
  title,
  lines,
  children,
}: {
  title?: string
  lines: string[]
  children?: ReactNode
}) {
  return (
    <div className='blockers' role='note'>
      {title ? <span className='hud-label'>{title}</span> : null}
      <ul>
        {lines.map((line) => (
          <li key={line}>
            <i className='glyph due' aria-hidden='true'>
              ◆
            </i>
            <span lang={isThai(line) ? 'th' : undefined}>{line}</span>
          </li>
        ))}
      </ul>
      {children}
    </div>
  )
}

export function PublishPage(props: PublishPageProps) {
  const toast = useToast()
  const { when, day } = useWhen(props.project.timezone)
  const [posts, setPosts] = useState(props.posts)
  const [ages, setAges] = useState(props.ages)
  const [selected, setSelected] = useState<string | null>(props.selectedId)
  const [detail, setDetail] = useState<PostDetailData | null>(props.detail)
  const [status, setStatus] = useState<(typeof CHIPS)[number]>('all')
  const [accountFilter, setAccountFilter] = useState('all')
  const [mode, setMode] = useState<
    null | 'new' | 'edit' | 'record' | 'reading' | 'remove'
  >(props.creating ? 'new' : null)
  const [selectedAccount, setSelectedAccount] = useState<string | 'new' | null>(
    null,
  )
  const [armed, setArmed] = useState<Armed>(null)
  const project = props.project
  const accountOf = useCallback(
    (id: string) => props.accounts.find((account) => account.id === id) ?? null,
    [props.accounts],
  )

  useEffect(() => setPosts(props.posts), [props.posts])
  useEffect(() => setAges(props.ages), [props.ages])

  const pass = (post: PostRowData) =>
    status === 'all' ||
    (status === 'planned' && post.status === 'planned') ||
    (status === 'cleared' && post.status === 'scheduled') ||
    (status === 'out' && isOut(post)) ||
    (status === 'failed' && post.status === 'failed')
  const visible = posts.filter(
    (post) =>
      (accountFilter === 'all' || post.accountId === accountFilter) &&
      pass(post),
  )
  const out7 = posts.filter(
    (post) =>
      isOut(post) &&
      post.postedAt &&
      hoursBetween(post.postedAt, props.readAt) <= 168,
  )
  const cleared = posts.filter((post) => post.status === 'scheduled')

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch on a new selection only
  useEffect(() => {
    if (!selected || detail?.id === selected) return
    let alive = true
    postAction(selected).then((result) => {
      if (!alive) return
      if (result.ok) setDetail(result.data)
      else toast(result.error)
    })
    return () => {
      alive = false
    }
  }, [selected, toast])

  const select = (id: string | null) => {
    setSelected(id)
    setMode(null)
    setArmed(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('new')
    if (id) url.searchParams.set('post', id)
    else url.searchParams.delete('post')
    window.history.replaceState(null, '', url)
  }

  /** A write answers the post as it now is: the row, the inspector and the ruler follow. */
  const saved = (next: PostDetailData, message?: string) => {
    setArmed(null)
    setDetail(next)
    setSelected(next.id)
    setPosts((list) => {
      const row: PostRowData = { ...next }
      return list.some((entry) => entry.id === next.id)
        ? list.map((entry) => (entry.id === next.id ? row : entry))
        : [row, ...list]
    })
    postAgesAction(next.id).then((result) => {
      if (result.ok)
        setAges((current) => ({ ...current, [next.id]: result.data }))
    })
    if (message) toast(message)
  }
  const answer = (result: ActionResult<PostDetailData>, message?: string) => {
    if (!result.ok) {
      toast(result.error)
      return false
    }
    saved(result.data, message)
    setMode(null)
    return true
  }

  const current = detail && detail.id === selected ? detail : null
  const currentAccount = current ? accountOf(current.accountId) : null

  const clear = async () => {
    if (!current) return
    const result = await clearPostAction({
      postId: current.id,
      expectedRevision: current.revision,
    })
    if (!result.ok) {
      toast(result.error)
      return
    }
    saved(
      result.data.detail,
      result.data.blockers.length
        ? `Can’t clear yet — ${result.data.blockers[0]?.message}`
        : 'Cleared — exactly this post may leave HQ for 24 hours',
    )
  }
  const takeBack = async () => {
    if (!current) return
    answer(
      await unschedulePostAction({
        postId: current.id,
        expectedRevision: current.revision,
      }),
      'Clearance taken back — it’s planned again',
    )
  }
  const postNow = async () => {
    if (!current) return
    if (currentAccount && how(currentAccount).mode !== 'api') {
      toast(how(currentAccount).hint)
      return
    }
    const result = await dispatchPostAction({ postId: current.id })
    if (!result.ok) {
      toast(result.error)
      return
    }
    saved(result.data.detail, result.data.message)
  }
  const remove = async () => {
    if (!current) return
    const result = await deletePostAction({
      postId: current.id,
      expectedRevision: current.revision,
    })
    if (!result.ok) {
      toast(result.error)
      return
    }
    setPosts((list) => list.filter((post) => post.id !== current.id))
    select(null)
    toast('Deleted the planned post')
  }

  const keys: [string, string][] =
    props.view === 'accounts'
      ? [
          ['c', 'new account'],
          ['↑ ↓', 'accounts'],
          ['1 2', 'posts · accounts'],
        ]
      : [
          ['c', 'new post'],
          ...((current?.status === 'planned'
            ? [
                ['a', 'clear to post'],
                ['e', 'edit'],
                ['⌫', 'delete'],
              ]
            : current?.status === 'scheduled'
              ? [
                  ['r', 'record as posted'],
                  ['p', 'post now'],
                  ['u', 'take back'],
                  ['e', 'edit'],
                ]
              : current && ['posted', 'verified'].includes(current.status)
                ? [
                    ['v', 'record reading'],
                    ['x', 'mark removed'],
                  ]
                : current?.status === 'failed'
                  ? [['e', 'edit']]
                  : []) as [string, string][]),
          ['↑ ↓', 'posts'],
          ['1 2', 'posts · accounts'],
        ]
  usePageKeyHints(keys)
  usePageKeys((key) => {
    // A question in the action row answers its own keys while it has focus;
    // any key that reaches the page instead closes it.
    if (armed && key !== 'Shift') {
      setArmed(null)
      if (key === 'Escape') return true
    }
    if (key === 'Escape') {
      if (mode) {
        setMode(null)
        return true
      }
      if (selected || selectedAccount) {
        select(null)
        setSelectedAccount(null)
        return true
      }
      return false
    }
    if (props.view === 'accounts') {
      if (key === 'c') {
        setSelectedAccount('new')
        return true
      }
      const list = props.accounts
      const index = list.findIndex((account) => account.id === selectedAccount)
      if (
        key === 'ArrowDown' ||
        key === 'j' ||
        key === 'ArrowUp' ||
        key === 'k'
      ) {
        const next =
          list[
            key === 'ArrowDown' || key === 'j'
              ? Math.min(list.length - 1, index + 1)
              : Math.max(0, index - 1)
          ]
        if (next) setSelectedAccount(next.id)
        return Boolean(next)
      }
      return false
    }
    if (key === 'c') {
      setSelected(null)
      setMode('new')
      return true
    }
    const index = visible.findIndex((post) => post.id === selected)
    if (key === 'ArrowDown' || key === 'j') {
      const next = visible[Math.min(visible.length - 1, index + 1)]
      if (next) select(next.id)
      return Boolean(next)
    }
    if (key === 'ArrowUp' || key === 'k') {
      const next = visible[Math.max(0, index - 1)]
      if (next) select(next.id)
      return Boolean(next)
    }
    if (!current) return false
    // A question opens only where its button is: not behind the edit form.
    const asks = mode !== 'edit'
    if (current.status === 'planned') {
      // Clearing lets the post out, so the key asks first — as the button does.
      if (key === 'a' && asks) {
        if (current.blockers.length)
          toast(current.blockers[0]?.message ?? 'Blocked')
        else setArmed('clear')
        return true
      }
      if (key === 'e') {
        setMode('edit')
        return true
      }
      if ((key === 'Backspace' || key === 'Delete') && asks) {
        setArmed('delete')
        return true
      }
    }
    if (current.status === 'scheduled') {
      if (key === 'r') {
        setMode('record')
        return true
      }
      if (key === 'p' && asks) {
        const h = currentAccount ? how(currentAccount) : null
        if (h?.mode === 'api') setArmed('post')
        else toast(h?.hint ?? 'This post’s account is gone.')
        return true
      }
      if (key === 'u') {
        void takeBack()
        return true
      }
      if (key === 'e') {
        setMode('edit')
        return true
      }
    }
    if (current.status === 'failed' && key === 'e') {
      setMode('edit')
      return true
    }
    if (['posted', 'verified'].includes(current.status)) {
      if (key === 'v') {
        setMode('reading')
        return true
      }
      if (key === 'x') {
        setMode('remove')
        return true
      }
    }
    return false
  })

  if (props.view === 'accounts')
    return (
      <Accounts
        {...props}
        posts={posts}
        selected={selectedAccount}
        setSelected={setSelectedAccount}
      />
    )

  // The 72h readout: the middle of what was read at that age, never a latest.
  const at72 = posts
    .map((post) => ages[post.id]?.['72'])
    .filter(
      (reading): reading is Extract<AgeReadingData, { state: 'known' }> =>
        reading?.state === 'known',
    )
    .map((reading) => Number(reading.value))
    .sort((a, b) => a - b)
  const old = posts.filter(
    (post) =>
      post.postedAt &&
      post.status !== 'failed' &&
      hoursBetween(post.postedAt, props.readAt) >= 72,
  ).length
  const median = at72.length
    ? at72.length % 2
      ? (at72[(at72.length - 1) / 2] as number)
      : ((at72[at72.length / 2 - 1] as number) +
          (at72[at72.length / 2] as number)) /
        2
    : null
  const nextGoes = cleared
    .map((post) => post.scheduledFor)
    .filter(Boolean)
    .sort()[0] as string | undefined

  return (
    <div className='page pubp'>
      <section className='pane pub-pane' aria-label='Posts'>
        <PaneHead
          title='Publish · posts'
          meta={`${posts.length} ${posts.length === 1 ? 'post' : 'posts'} · ${cleared.length} cleared · ${out7.length} out in 7 days`}
        />
        <div className='toolbar'>
          {/* biome-ignore lint/a11y/useSemanticElements: status filters are a group of toggle buttons */}
          <span className='seg' role='group' aria-label='Status'>
            {CHIPS.map((chip) => (
              <button
                key={chip}
                type='button'
                aria-pressed={status === chip}
                onClick={() => setStatus(chip)}
              >
                {chip}
              </button>
            ))}
          </span>
          <select
            aria-label='Account'
            value={accountFilter}
            onChange={(event) => setAccountFilter(event.target.value)}
          >
            <option value='all'>all accounts</option>
            {props.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {PLATFORM[account.platform]} · {account.handle}
              </option>
            ))}
          </select>
          <span className='sp' />
          <span className='hits'>
            {visible.length} of {posts.length}
          </span>
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => {
              setSelected(null)
              setMode('new')
            }}
          >
            ＋ New post<kbd>c</kbd>
          </button>
        </div>
        <div className='pub-read'>
          <Readout
            big={
              <>
                {out7.length} <span className='u'>out in 7 days</span>
              </>
            }
            sub={`${cleared.length} cleared${nextGoes ? ` · next goes ${when(nextGoes)}` : ''}`}
          />
          {median === null ? (
            <Readout
              big='—'
              sub={
                old
                  ? `views at 72h · none of ${old} read at that age`
                  : 'views at 72h · nothing old enough yet'
              }
              tone='dim'
            />
          ) : (
            <Readout
              big={
                <>
                  {compact(median)} <span className='u'>views at 72h</span>
                </>
              }
              sub={`median · ${at72.length} of ${old} read at that age`}
            />
          )}
        </div>
        <div className='pane-body'>
          <div className='tbl post-tbl' role='listbox'>
            <div className='tbl-head' aria-hidden='true'>
              <span className='hud-label'>account</span>
              <span className='hud-label'>post</span>
              <span className='hud-label'>status</span>
              <span className='hud-label c-hide c-when'>when</span>
              <span className='hud-label num c-hide'>views · 72h</span>
              <span className='hud-label c-hide c-file'>file</span>
            </div>
            {posts.length === 0 ? (
              <Empty>
                ○ no posts yet — plan one with <kbd>c</kbd>
                {props.accounts.length
                  ? ''
                  : ' (add an account first, in Accounts)'}
              </Empty>
            ) : visible.length === 0 ? (
              <Empty>○ nothing here</Empty>
            ) : (
              visible.map((post) => {
                const on = post.id === selected && mode !== 'new'
                const reading = ages[post.id]?.['72']
                const title = nameOf(post)
                return (
                  <button
                    key={post.id}
                    type='button'
                    role='option'
                    aria-selected={on}
                    className={`tbl-row${on ? ' sel' : ''}`}
                    onClick={() => select(post.id)}
                  >
                    <span>
                      <span className='plat'>{PLATFORM[post.platform]}</span>
                      <span className='hdl'>{post.handle}</span>
                    </span>
                    <span lang={isThai(title) ? 'th' : undefined}>{title}</span>
                    <span>
                      <StateWord
                        post={post}
                        readAt={props.readAt}
                        blocked={
                          current?.id === post.id
                            ? current.blockers.length > 0
                            : false
                        }
                      />
                    </span>
                    <span className='when c-hide c-when'>
                      {when(post.postedAt ?? post.scheduledFor)}
                    </span>
                    {!post.postedAt || post.status === 'failed' ? (
                      <span className='num c-hide' />
                    ) : reading?.state === 'known' ? (
                      <span className='num c-hide'>{count(reading.value)}</span>
                    ) : (
                      <span className='num dim c-hide'>
                        {reading?.state === 'too_young'
                          ? `too young · in ${spanWord(hoursBetween(props.readAt, reading.readyAt))}`
                          : '— not read'}
                      </span>
                    )}
                    <span className='file c-hide c-file'>
                      {post.asset?.title ?? '—'}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </section>
      <Inspector
        id='publish'
        label='Selected post'
        empty={!current && mode !== 'new'}
        onClose={() => select(null)}
      >
        {mode === 'new' || (mode === 'edit' && current) ? (
          <PostForm
            key={
              mode === 'edit' && current
                ? `${current.id}-${current.revision}`
                : 'new'
            }
            project={project}
            post={mode === 'edit' ? current : null}
            accounts={props.accounts}
            files={props.files}
            onClose={() => setMode(null)}
            onSaved={(next, message) => {
              saved(next, message)
              setMode(null)
              select(next.id)
            }}
          />
        ) : !current ? (
          <>
            <InspectorHead
              title='Post'
              meta={selected ? '…' : 'nothing selected'}
            />
            <div className='insp-body'>
              <Empty>
                {selected
                  ? '…'
                  : posts.length
                    ? 'Select a post, or press c to plan one.'
                    : '○ no posts yet — plan one with c'}
              </Empty>
            </div>
          </>
        ) : (
          <PostInspector
            project={project}
            post={current}
            account={currentAccount}
            ages={ages[current.id]}
            readAt={props.readAt}
            when={when}
            day={day}
            mode={mode}
            setMode={setMode}
            onClose={() => select(null)}
            onClear={clear}
            onTakeBack={takeBack}
            onPostNow={postNow}
            onDelete={remove}
            armed={armed}
            onArm={setArmed}
            answer={answer}
          />
        )}
      </Inspector>
    </div>
  )
}

/* ── Inspector: a post ─────────────────────────────────────────────── */

function PostInspector({
  project,
  post,
  account,
  ages,
  readAt,
  when,
  day,
  mode,
  setMode,
  onClose,
  onClear,
  onTakeBack,
  onPostNow,
  onDelete,
  armed,
  onArm,
  answer,
}: {
  project: PublishProject
  post: PostDetailData
  account: AccountData | null
  ages: Record<string, AgeReadingData> | undefined
  readAt: string
  when: (iso: string | null) => string
  day: (iso: string | null) => string
  mode: null | 'new' | 'edit' | 'record' | 'reading' | 'remove'
  setMode: (
    mode: null | 'new' | 'edit' | 'record' | 'reading' | 'remove',
  ) => void
  onClose: () => void
  onClear: () => Promise<void>
  onTakeBack: () => Promise<void>
  onPostNow: () => Promise<void>
  onDelete: () => Promise<void>
  /** The question open in the action row — the page's keys open the same ones. */
  armed: Armed
  onArm: (armed: Armed) => void
  answer: (result: ActionResult<PostDetailData>, message?: string) => boolean
}) {
  const [pending, start] = useTransition()
  const arm = (which: Exclude<Armed, null>) => (on: boolean) =>
    onArm(on ? which : null)
  const name = PLATFORM[post.platform]
  const h = account ? how(account) : null
  const title = nameOf(post)
  const blockers = post.blockers.map((blocker) => blocker.message)
  const disclosure = [
    post.disclosure.aiGenerated ? 'made with AI' : '',
    post.disclosure.affiliate ? 'paid / affiliate' : '',
  ].filter(Boolean)
  const facts: [string, ReactNode][] = [
    ['account', `${name} · ${post.handle}`],
    ['status', post.status === 'scheduled' ? 'cleared' : post.status],
    ['file', post.asset ? post.asset.title : 'none'],
    ['scheduled', post.scheduledFor ? when(post.scheduledFor) : '—'],
    ['posted', post.postedAt ? when(post.postedAt) : '—'],
    ...(post.url ? [['url / post id', post.url] as [string, ReactNode]] : []),
    ['evidence', post.evidenceLevel ?? '—'],
    [
      'clearance',
      post.clearance
        ? `expires in ${spanWord(Math.max(0, hoursBetween(readAt, post.clearance.expiresAt)))}`
        : 'none',
    ],
  ]
  const links = post.links.filter((link) =>
    ['card', 'experiment'].includes(link.type),
  )

  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} />{' '}
            <span style={{ color: 'var(--ink-4)' }}>›</span> Post
          </>
        }
        meta={post.status === 'scheduled' ? 'cleared' : post.status}
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <Ruler post={post} ages={ages} readAt={readAt} when={when} />
          <Facts rows={facts} />
        </div>
        <div className='dev-main'>
          <h2 className='dev-title' lang={isThai(title) ? 'th' : undefined}>
            {title}
          </h2>
          <blockquote className='quote cap'>
            <span className='hud-label'>caption · {name}</span>
            {post.caption ? (
              <span lang={isThai(post.caption) ? 'th' : undefined}>
                “{post.caption}”
              </span>
            ) : (
              <span className='muted'>no caption</span>
            )}
          </blockquote>
          <p className='dev-p disc'>
            <span className='hud-label'>disclosure</span>
            <span>{disclosure.length ? disclosure.join(' · ') : 'none'}</span>
          </p>

          {post.status === 'planned' ? (
            <>
              {post.statusReason ? (
                <p className='changed'>{post.statusReason}</p>
              ) : null}
              {blockers.length ? (
                <Blockers title='Why it can’t go yet' lines={blockers} />
              ) : null}
              <div className='dev-acts'>
                {blockers.length ? (
                  <button type='button' className='btn btn-release' disabled>
                    Clear to post<kbd>a</kbd>
                  </button>
                ) : (
                  <Confirm
                    label='Clear to post'
                    kbd='a'
                    tone='release'
                    small={false}
                    again
                    question='Let exactly this post leave HQ, for 24 hours?'
                    yes='Clear to post'
                    no='Not now'
                    asking={armed === 'clear'}
                    onAsking={arm('clear')}
                    run={onClear}
                  />
                )}
                <button
                  type='button'
                  className='btn'
                  onClick={() => setMode('edit')}
                >
                  Edit<kbd>e</kbd>
                </button>
                <Confirm
                  label='Delete'
                  kbd='⌫'
                  small={false}
                  question='Delete this post?'
                  yes='Delete'
                  asking={armed === 'delete'}
                  onAsking={arm('delete')}
                  run={onDelete}
                />
              </div>
              <p className='dev-p'>
                {blockers.length
                  ? 'Clearing waits until the list above is empty.'
                  : `Clearing lets exactly this post leave HQ, for 24 hours.${h?.mode === 'api' ? '' : ' Then post it yourself and record it.'}`}
              </p>
            </>
          ) : null}

          {post.status === 'scheduled' ? (
            <>
              <div className='dev-acts'>
                <button
                  type='button'
                  className='btn btn-pri'
                  onClick={() => setMode('record')}
                >
                  Record as posted<kbd>r</kbd>
                </button>
                {h?.mode === 'api' ? (
                  <Confirm
                    label='Post now'
                    kbd='p'
                    small={false}
                    again
                    question={`Post it to ${name} now?`}
                    yes='Post now'
                    no='Not now'
                    disabled={pending}
                    asking={armed === 'post'}
                    onAsking={arm('post')}
                    run={onPostNow}
                  />
                ) : (
                  <button
                    type='button'
                    className='btn'
                    disabled
                    aria-describedby='why-hand'
                  >
                    Post now<kbd>p</kbd>
                  </button>
                )}
                <button
                  type='button'
                  className='btn'
                  disabled={pending}
                  onClick={() => start(onTakeBack)}
                >
                  Take back<kbd>u</kbd>
                </button>
                <button
                  type='button'
                  className='btn'
                  onClick={() => setMode('edit')}
                >
                  Edit<kbd>e</kbd>
                </button>
              </div>
              {h && h.mode !== 'api' ? (
                <p className='dev-p' id='why-hand'>
                  {h.hint}
                </p>
              ) : null}
              {mode === 'record' ? (
                <RecordForm
                  post={post}
                  onCancel={() => setMode(null)}
                  answer={answer}
                />
              ) : (
                <p className='dev-p muted'>Editing takes the clearance back.</p>
              )}
            </>
          ) : null}

          {post.status === 'dispatched' ? (
            <>
              <p className='live-line'>
                <Glyph tone='live' char='▶' />
                sent · reading it back
              </p>
              {h?.mode === 'reconnect' ? (
                <Blockers lines={[h.hint]}>
                  <Link className='btn btn-sm' href='/settings/connections'>
                    Settings › Connections
                  </Link>
                </Blockers>
              ) : null}
            </>
          ) : null}

          {post.status === 'posted' || post.status === 'verified' ? (
            <>
              <div className='dev-acts'>
                <button
                  type='button'
                  className='btn btn-pri'
                  onClick={() => setMode('reading')}
                >
                  Record reading<kbd>v</kbd>
                </button>
                <button
                  type='button'
                  className='btn'
                  onClick={() => setMode('remove')}
                >
                  Mark removed<kbd>x</kbd>
                </button>
              </div>
              {mode === 'reading' ? (
                <ReadingForm
                  post={post}
                  onCancel={() => setMode(null)}
                  answer={answer}
                />
              ) : null}
              {mode === 'remove' ? (
                <RemoveForm
                  post={post}
                  onCancel={() => setMode(null)}
                  answer={answer}
                />
              ) : null}
              <Readings post={post} when={when} day={day} />
            </>
          ) : null}

          {post.status === 'removed' ? (
            <>
              <p className='dev-p'>
                Removed{post.statusReason ? ` — ${post.statusReason}` : ''}.
                Readings stop here.
              </p>
              <Readings post={post} when={when} day={day} />
            </>
          ) : null}

          {post.status === 'failed' ? (
            <>
              <Blockers
                title='Why it failed'
                lines={[post.statusReason || 'no reason given']}
              />
              <div className='dev-acts'>
                <button
                  type='button'
                  className='btn'
                  onClick={() => setMode('edit')}
                >
                  Edit<kbd>e</kbd>
                </button>
              </div>
              <p className='dev-p'>Edit returns it to planned.</p>
            </>
          ) : null}

          {links.length || post.asset ? (
            <div className='insp-links'>
              {links.map((link) => (
                <Link
                  key={`${link.type}-${link.id}`}
                  className='btn btn-sm'
                  href={
                    link.type === 'card'
                      ? `/p/${project.slug}/board?card=${link.id}`
                      : `/p/${project.slug}/experiments?experiment=${link.id}`
                  }
                >
                  {link.type === 'card' ? '▦ Card' : '◬ Experiment'}
                </Link>
              ))}
              {post.asset ? (
                <Link
                  className='btn btn-sm'
                  href={`/p/${project.slug}/assets?asset=${post.asset.id}`}
                >
                  ▣ {post.asset.title}
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

function Readings({
  post,
  when,
  day,
}: {
  post: PostDetailData
  when: (iso: string | null) => string
  day: (iso: string | null) => string
}) {
  const rows = [...post.readings].sort(
    (a, b) =>
      Number(a.metric === 'earnings') - Number(b.metric === 'earnings') ||
      String(a.asOf ?? a.windowEnd).localeCompare(
        String(b.asOf ?? b.windowEnd),
      ),
  )
  const current = rows.filter((row) => !row.supersededBy)
  const was = (row: ReadingRowData) =>
    row.supersedesId
      ? rows.find((entry) => entry.id === row.supersedesId)
      : null
  return (
    <div className='rd-wrap'>
      <span className='hud-label'>Readings</span>
      {current.length === 0 ? (
        <Empty>○ nothing read yet — the first reading is due at 1h</Empty>
      ) : (
        <div className='tbl rd-tbl'>
          <div className='tbl-head'>
            <span className='hud-label'>metric</span>
            <span className='hud-label'>value</span>
            <span className='hud-label'>as of (age)</span>
            <span className='hud-label'>source</span>
          </div>
          {current.map((row) => {
            const earlier = was(row)
            return (
              <div key={row.id} className='tbl-row'>
                <span>{row.metric}</span>
                <span className='mono'>
                  {row.currency
                    ? formatMoney(row.value, row.currency)
                    : count(row.value)}
                  {earlier ? (
                    <small className='fix'>
                      <s title={`was ${earlier.value}`}>
                        {earlier.currency
                          ? formatMoney(earlier.value, earlier.currency)
                          : count(earlier.value)}
                      </s>
                    </small>
                  ) : null}
                </span>
                <span className='mono'>
                  {row.window === 'interval'
                    ? `${day(row.windowStart)} – ${day(row.windowEnd)}`
                    : when(row.asOf)}
                  {row.window !== 'interval' && row.asOf && post.postedAt ? (
                    <small>
                      {' '}
                      ({spanWord(hoursBetween(post.postedAt, row.asOf))})
                    </small>
                  ) : null}
                </span>
                <span className='src'>
                  {row.source}
                  {earlier ? (
                    <>
                      {' · '}
                      <span
                        className='fixw'
                        title={row.correctionReason ?? undefined}
                      >
                        corrected
                      </span>
                    </>
                  ) : null}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RecordForm({
  post,
  onCancel,
  answer,
}: {
  post: PostDetailData
  onCancel: () => void
  answer: (result: ActionResult<PostDetailData>, message?: string) => boolean
}) {
  const [url, setUrl] = useState('')
  const [postedAt, setPostedAt] = useState(localInput(new Date().toISOString()))
  const [evidence, setEvidence] =
    useState<(typeof EVIDENCE)[number][0]>('owner_attested')
  const [pending, start] = useTransition()
  const placeholder =
    post.platform === 'tiktok'
      ? 'tiktok.com/@…/video/…'
      : post.platform === 'youtube'
        ? 'youtu.be/…'
        : post.platform === 'facebook'
          ? 'facebook.com/…/posts/…'
          : 'https://…'
  const submit = (event: FormEvent) => {
    event.preventDefault()
    start(async () => {
      const isUrl = /^https?:\/\//i.test(url.trim())
      answer(
        await recordPostedAction({
          postId: post.id,
          expectedRevision: post.revision,
          ...(isUrl ? { url: url.trim() } : { externalId: url.trim() }),
          postedAt: fromLocal(postedAt),
          evidenceLevel: evidence,
        }),
        'On the record as posted — verified once the platform reads it back',
      )
    })
  }
  return (
    <form className='fcard' autoComplete='off' onSubmit={submit}>
      <span className='hud-label'>Record as posted</span>
      <label>
        URL or post ID
        <input
          value={url}
          required
          placeholder={placeholder}
          // biome-ignore lint/a11y/noAutofocus: the form opens on purpose
          autoFocus
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <label>
        Posted at
        <input
          type='datetime-local'
          value={postedAt}
          onChange={(event) => setPostedAt(event.target.value)}
        />
      </label>
      <label>
        How you know
        <select
          value={evidence}
          onChange={(event) =>
            setEvidence(event.target.value as (typeof EVIDENCE)[number][0])
          }
        >
          {EVIDENCE.map(([value, words]) => (
            <option key={value} value={value}>
              {value} — {words}
            </option>
          ))}
        </select>
      </label>
      <div className='row'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={!url.trim() || pending}
        >
          Record it<kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
      <p className='hint'>
        It goes on the record as posted. It turns verified only when the
        platform reads it back.
      </p>
    </form>
  )
}

function ReadingForm({
  post,
  onCancel,
  answer,
}: {
  post: PostDetailData
  onCancel: () => void
  answer: (result: ActionResult<PostDetailData>, message?: string) => boolean
}) {
  const [metric, setMetric] = useState('views')
  const [value, setValue] = useState('')
  const [asOf, setAsOf] = useState(localInput(new Date().toISOString()))
  const [from, setFrom] = useState(localInput(post.postedAt).slice(0, 10))
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10))
  const [currency, setCurrency] = useState('THB')
  const [pending, start] = useTransition()
  const earnings = metric === 'earnings'
  const submit = (event: FormEvent) => {
    event.preventDefault()
    start(async () => {
      answer(
        await recordReadingAction({
          postId: post.id,
          metric,
          value: value.replace(/[,\s]/g, ''),
          ...(earnings
            ? {
                currency,
                ...daySpan(from, to, post.postedAt),
              }
            : { asOf: fromLocal(asOf) }),
        }),
        `Recorded ${metric}`,
      )
    })
  }
  return (
    <form className='fcard' autoComplete='off' onSubmit={submit}>
      <span className='hud-label'>Record reading</span>
      <div className='row'>
        <label className='grow'>
          Metric
          <select
            value={metric}
            onChange={(event) => setMetric(event.target.value)}
          >
            {METRICS.map((entry) => (
              <option key={entry}>{entry}</option>
            ))}
          </select>
        </label>
        <label className='grow'>
          {earnings ? 'Amount' : 'Value'}
          <input
            inputMode='decimal'
            required
            value={value}
            placeholder={earnings ? '350.50' : '12,400'}
            // biome-ignore lint/a11y/noAutofocus: the form opens on purpose
            autoFocus
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
      </div>
      {earnings ? (
        <div className='row'>
          <label className='grow'>
            From
            <input
              type='date'
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className='grow'>
            To
            <input
              type='date'
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <label>
            Currency
            <select
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              <option>THB</option>
              <option>USD</option>
            </select>
          </label>
        </div>
      ) : (
        <label>
          As of
          <input
            type='datetime-local'
            value={asOf}
            onChange={(event) => setAsOf(event.target.value)}
          />
        </label>
      )}
      <div className='row'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={!value.trim() || pending}
        >
          Record<kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
      <p className='hint'>
        {earnings
          ? 'Money is a span: what the platform paid for those days.'
          : 'A lifetime count as of that moment. A new value for the same moment corrects the old one.'}
      </p>
    </form>
  )
}

function RemoveForm({
  post,
  onCancel,
  answer,
}: {
  post: PostDetailData
  onCancel: () => void
  answer: (result: ActionResult<PostDetailData>, message?: string) => boolean
}) {
  const [reason, setReason] = useState('')
  const [pending, start] = useTransition()
  return (
    <form
      className='fcard'
      onSubmit={(event) => {
        event.preventDefault()
        start(async () => {
          answer(
            await removePostAction({
              postId: post.id,
              expectedRevision: post.revision,
              reason,
            }),
            'Marked removed — readings stop here',
          )
        })
      }}
    >
      <span className='hud-label'>Mark removed</span>
      <label>
        Why
        <input
          value={reason}
          required
          placeholder='Taken down by me · removed by the platform'
          // biome-ignore lint/a11y/noAutofocus: the form opens on purpose
          autoFocus
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div className='row'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={!reason.trim() || pending}
        >
          Mark removed
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </form>
  )
}

/* ── Inspector: new / edit a post ──────────────────────────────────── */

function PostForm({
  project,
  post,
  accounts,
  files,
  onClose,
  onSaved,
}: {
  project: PublishProject
  post: PostDetailData | null
  accounts: AccountData[]
  files: FileOption[]
  onClose: () => void
  onSaved: (next: PostDetailData, message: string) => void
}) {
  const toast = useToast()
  const usable = accounts.filter(
    (account) => !account.archived || account.id === post?.accountId,
  )
  const [accountId, setAccountId] = useState(
    post?.accountId ?? usable[0]?.id ?? '',
  )
  const [assetId, setAssetId] = useState(post?.asset?.id ?? '')
  const [title, setTitle] = useState(post?.title ?? '')
  const [caption, setCaption] = useState(post?.caption ?? '')
  const [ai, setAi] = useState(post?.disclosure.aiGenerated ?? false)
  const [paid, setPaid] = useState(post?.disclosure.affiliate ?? false)
  const [scheduledFor, setScheduledFor] = useState(
    localInput(post?.scheduledFor ?? null),
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const account = usable.find((entry) => entry.id === accountId) ?? null
  const youtube = account?.platform === 'youtube'
  const file = files.find((entry) => entry.id === assetId) ?? null
  const list = files.slice(0, 12)
  if (post?.asset && !list.some((entry) => entry.id === post.asset?.id))
    list.unshift({
      id: post.asset.id,
      name: post.asset.name,
      title: post.asset.title,
      kind: post.asset.kind,
      origin: 'upload',
      mime: '',
    })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    start(async () => {
      const fields = {
        accountId,
        assetId: assetId || null,
        title: youtube ? title : title || null,
        caption,
        aiGenerated: ai,
        affiliate: paid,
        scheduledFor: fromLocal(scheduledFor) ?? null,
      }
      const result = post
        ? await updatePostAction({
            postId: post.id,
            expectedRevision: post.revision,
            ...fields,
          })
        : await planPostAction({ projectId: project.id, ...fields })
      if (!result.ok) {
        setError(result.error)
        toast(result.error)
        return
      }
      onSaved(
        result.data,
        post
          ? post.status === 'scheduled'
            ? 'Saved — the clearance was taken back; clear it again'
            : 'Saved'
          : 'Planned — it waits here until you clear it',
      )
    })
  }

  if (usable.length === 0)
    return (
      <>
        <InspectorHead title='New post' meta='planned' onClose={onClose} />
        <div className='insp-body'>
          <Empty>
            ○ no account yet — add one in Accounts (2), then plan the post.
          </Empty>
        </div>
      </>
    )

  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} />{' '}
            <span style={{ color: 'var(--ink-4)' }}>›</span>{' '}
            {post ? 'Post' : 'New post'}
          </>
        }
        meta={post ? 'editing' : 'planned'}
        onClose={onClose}
      />
      <div className='insp-body'>
        <form className='fcard' autoComplete='off' onSubmit={submit}>
          <span className='hud-label'>{post ? 'Edit post' : 'New post'}</span>
          <label>
            Account
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              {usable.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {PLATFORM[entry.platform]} · {entry.handle} —{' '}
                  {how(entry).word}
                </option>
              ))}
            </select>
          </label>
          <span className='fld-label'>File from Assets</span>
          <div className='picker' role='radiogroup' aria-label='File'>
            {[
              {
                id: '',
                name: 'no file',
                title: 'no file',
                kind: 'text only',
                origin: '',
                mime: '',
              },
              ...list,
            ].map((entry) => (
              // biome-ignore lint/a11y/useSemanticElements: a file picker styled as a radio group of buttons
              <button
                key={entry.id || 'none'}
                type='button'
                className='pk'
                role='radio'
                aria-checked={assetId === entry.id}
                onClick={() => {
                  setAssetId(entry.id)
                  if (entry.origin === 'generated') setAi(true)
                }}
              >
                <span className='t'>{entry.title}</span>
                <span className='v'>
                  {entry.id ? `${entry.kind} · ${entry.origin}` : entry.kind}
                </span>
              </button>
            ))}
          </div>
          {youtube || title ? (
            <label>
              Title
              <input
                value={title}
                maxLength={100}
                placeholder={youtube ? 'YouTube needs one' : ''}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          ) : null}
          <label>
            Caption
            <textarea
              rows={3}
              value={caption}
              lang={isThai(caption) ? 'th' : undefined}
              onChange={(event) => setCaption(event.target.value)}
            />
          </label>
          <span className='fld-label'>Disclosure</span>
          <div className='pub-sw'>
            <div className='srow'>
              <button
                type='button'
                className='switch'
                aria-pressed={ai}
                aria-label='Made with AI'
                onClick={() => setAi((value) => !value)}
              />
              Made with AI
              <span className='sub'>
                {file?.origin === 'generated'
                  ? 'the file was generated'
                  : ai
                    ? 'on'
                    : 'off'}
              </span>
            </div>
            <div className='srow'>
              <button
                type='button'
                className='switch'
                aria-pressed={paid}
                aria-label='Paid / affiliate'
                onClick={() => setPaid((value) => !value)}
              />
              Paid / affiliate<span className='sub'>{paid ? 'on' : 'off'}</span>
            </div>
          </div>
          <label>
            Scheduled for
            <input
              type='datetime-local'
              value={scheduledFor}
              onChange={(event) => setScheduledFor(event.target.value)}
            />
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
              disabled={pending || !accountId}
            >
              {post ? 'Save' : 'Plan it'}
              <kbd>↵</kbd>
            </button>
            <button type='button' className='btn' onClick={onClose}>
              Cancel<kbd>Esc</kbd>
            </button>
          </div>
          <p className='hint'>
            {post?.status === 'scheduled'
              ? 'Saving takes the clearance back — you clear it again.'
              : post?.status === 'failed'
                ? 'Saving returns it to planned.'
                : 'Planning sends nothing. It waits here until you clear it.'}
          </p>
        </form>
      </div>
    </>
  )
}

/* ── Accounts ──────────────────────────────────────────────────────── */

function Accounts({
  project,
  accounts,
  posts,
  connections,
  selected,
  setSelected,
}: PublishPageProps & {
  posts: PostRowData[]
  selected: string | 'new' | null
  setSelected: (id: string | 'new' | null) => void
}) {
  const reconnect = accounts.filter(
    (account) => how(account).mode === 'reconnect',
  ).length
  const current = accounts.find((account) => account.id === selected) ?? null
  return (
    <div className='page pubp'>
      <section className='pane pub-pane' aria-label='Accounts'>
        <PaneHead
          title='Publish · accounts'
          meta={`${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}${reconnect ? ` · ${reconnect} to reconnect` : ''}`}
        />
        <div className='toolbar'>
          <span className='sp' />
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => setSelected('new')}
          >
            ＋ New account<kbd>c</kbd>
          </button>
        </div>
        <div className='pane-body'>
          <div className='tbl acct-tbl' role='listbox'>
            <div className='tbl-head' aria-hidden='true'>
              <span className='hud-label'>platform</span>
              <span className='hud-label'>handle</span>
              <span className='hud-label'>how it posts</span>
              <span className='hud-label num c-hide'>posts</span>
              <span className='hud-label c-hide'>archived</span>
            </div>
            {accounts.length === 0 ? (
              <Empty>
                ○ no accounts yet — add one with <kbd>c</kbd>
              </Empty>
            ) : (
              accounts.map((account) => {
                const h = how(account)
                return (
                  <button
                    key={account.id}
                    type='button'
                    role='option'
                    aria-selected={account.id === selected}
                    className={`tbl-row${account.id === selected ? ' sel' : ''}${account.archived ? ' arch' : ''}`}
                    onClick={() => setSelected(account.id)}
                  >
                    <span className='plat'>{PLATFORM[account.platform]}</span>
                    <span lang={isThai(account.handle) ? 'th' : undefined}>
                      {account.handle}
                    </span>
                    <span>
                      {h.mode === 'reconnect' ? (
                        <span className='state-word problem'>
                          <Glyph tone='due' char='◆' />
                          reconnect
                        </span>
                      ) : (
                        <span
                          className={`state-word${h.mode === 'api' ? ' live' : ''}`}
                        >
                          {h.word}
                        </span>
                      )}
                    </span>
                    <span className='num c-hide'>
                      {
                        posts.filter((post) => post.accountId === account.id)
                          .length
                      }
                    </span>
                    <span className='c-hide'>
                      {account.archived ? (
                        <span className='state-word off'>archived</span>
                      ) : (
                        <span className='state-word'>no</span>
                      )}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </section>
      <Inspector
        id='publish'
        label='Selected account'
        empty={!selected}
        onClose={() => setSelected(null)}
      >
        {selected === 'new' || current ? (
          <AccountForm
            key={current ? `${current.id}-${current.revision}` : 'new'}
            project={project}
            account={current}
            posts={posts}
            connections={connections}
            onClose={() => setSelected(null)}
            onSaved={(id) => setSelected(id)}
          />
        ) : (
          <>
            <InspectorHead title='Account' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>
                {accounts.length
                  ? 'Select an account.'
                  : '○ no accounts yet — add one with c'}
              </Empty>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

function AccountForm({
  project,
  account,
  posts,
  connections,
  onClose,
  onSaved,
}: {
  project: PublishProject
  account: AccountData | null
  posts: PostRowData[]
  connections: ConnectionOption[]
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const toast = useToast()
  const [platform, setPlatform] = useState<Platform>(
    account?.platform ?? 'tiktok',
  )
  const [handle, setHandle] = useState(account?.handle ?? '')
  const [profileUrl, setProfileUrl] = useState(account?.profileUrl ?? '')
  const [connectionId, setConnectionId] = useState(account?.connectionId ?? '')
  const [notes, setNotes] = useState(account?.notes ?? '')
  const [pending, start] = useTransition()
  const mine = account
    ? posts.filter((post) => post.accountId === account.id)
    : []
  const options = connections.filter(
    (connection) => connection.provider === platform,
  )
  const h = account ? how(account) : null

  const save = (event: FormEvent) => {
    event.preventDefault()
    start(async () => {
      const result = await saveAccountAction({
        projectId: project.id,
        ...(account
          ? { accountId: account.id, expectedRevision: account.revision }
          : {}),
        platform,
        handle,
        profileUrl,
        connectionId: connectionId || null,
        notes,
      })
      if (!result.ok) {
        toast(result.error)
        return
      }
      toast(
        account ? `Saved ${handle}` : `Added ${PLATFORM[platform]} · ${handle}`,
      )
      onSaved(result.data.id)
    })
  }
  const archive = () =>
    start(async () => {
      if (!account) return
      const result = await archiveAccountAction({
        accountId: account.id,
        expectedRevision: account.revision,
        archived: !account.archived,
      })
      if (!result.ok) {
        toast(result.error)
        return
      }
      toast(
        account.archived
          ? 'Unarchived'
          : 'Archived — its posts stay on the record',
      )
    })

  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} />{' '}
            <span style={{ color: 'var(--ink-4)' }}>›</span>{' '}
            {account ? 'Account' : 'New account'}
          </>
        }
        meta={account ? (account.archived ? 'archived' : h?.word) : 'new'}
        onClose={onClose}
      />
      <div className='insp-body'>
        {account ? (
          <div className='dev-read'>
            <Readout
              big={
                <>
                  {mine.length}{' '}
                  <span className='u'>
                    {mine.length === 1 ? 'post' : 'posts'}
                  </span>
                </>
              }
              sub={`${mine.filter(isOut).length} out · ${mine.filter((post) => post.status === 'planned' || post.status === 'scheduled').length} to go`}
            />
            <Facts
              rows={[
                ['platform', PLATFORM[account.platform]],
                ['handle', account.handle],
                ['connection', account.connection?.label ?? 'none'],
                ['how it posts', h?.word ?? '—'],
                ['archived', account.archived ? 'yes' : 'no'],
              ]}
            />
          </div>
        ) : null}
        {h?.mode === 'reconnect' ? (
          <Blockers lines={[h.hint]}>
            <Link className='btn btn-sm' href='/settings/connections'>
              Settings › Connections
            </Link>
          </Blockers>
        ) : null}
        <form className='fcard' autoComplete='off' onSubmit={save}>
          <span className='hud-label'>
            {account ? 'Account' : 'New account'}
          </span>
          <label>
            Platform
            <select
              value={platform}
              disabled={Boolean(account)}
              onChange={(event) => {
                setPlatform(event.target.value as Platform)
                setConnectionId('')
              }}
            >
              {(Object.keys(PLATFORM) as Platform[]).map((key) => (
                <option key={key} value={key}>
                  {PLATFORM[key]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Handle
            <input
              value={handle}
              required
              placeholder={platform === 'manual' ? 'site or name' : '@handle'}
              onChange={(event) => setHandle(event.target.value)}
            />
          </label>
          <label>
            Profile URL
            <input
              type='url'
              value={profileUrl}
              placeholder='https://…'
              onChange={(event) => setProfileUrl(event.target.value)}
            />
          </label>
          {platform === 'manual' ? null : (
            <label>
              Connection
              <select
                value={connectionId}
                onChange={(event) => setConnectionId(event.target.value)}
              >
                {options.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.label}
                    {connection.status === 'connected'
                      ? ''
                      : ` · ${connection.status}`}
                  </option>
                ))}
                <option value=''>none — by hand</option>
              </select>
            </label>
          )}
          <label>
            Notes
            <textarea
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
          <p className='hint'>
            {platform === 'manual'
              ? 'HQ never posts to other sites — post it yourself and record it.'
              : options.length
                ? 'With a connection HQ can read posts back; posting through the API needs HQ’s adapter for this platform.'
                : 'No connection for this platform yet — add one at Settings › Connections, or post by hand and record it.'}
          </p>
          <div className='row'>
            <button
              type='submit'
              className='btn btn-pri'
              disabled={!handle.trim() || pending}
            >
              {account ? 'Save' : 'Add account'}
              <kbd>↵</kbd>
            </button>
            {account ? (
              <button
                type='button'
                className='btn'
                disabled={pending}
                onClick={archive}
              >
                {account.archived ? 'Unarchive' : 'Archive'}
              </button>
            ) : (
              <button type='button' className='btn' onClick={onClose}>
                Cancel<kbd>Esc</kbd>
              </button>
            )}
          </div>
          <p className='hint'>
            Adding or changing an account is yours; agents only read it.
          </p>
        </form>
      </div>
    </>
  )
}
