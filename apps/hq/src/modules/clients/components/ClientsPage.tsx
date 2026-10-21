'use client'

import { formatMoney, sumAmounts } from '@theiceji/hq-core/money'
import { PROJECT_COLORS } from '@theiceji/hq-db/enums'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  type CSSProperties,
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
  Tag,
  usePageKeys,
} from '@/components/bridge/parts'
import { Confirm } from '@/components/Confirm'
import { usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import { FollowupMark } from '@/modules/board/components/CardParts'
import {
  adoptNameAction,
  archiveClientAction,
  clientDetailAction,
  deleteClientAction,
  saveClientAction,
  undoAdoptAction,
} from '../actions'
import type {
  ClientCardData,
  ClientData,
  ClientDetailData,
  ClientProject,
  ClientUseData,
  LedgerData,
  Money,
  OnceNameData,
} from '../data'

/**
 * Clients: who the work is
 * for, across every project — Table + Inspector, the Projects page's
 * grammar. The inspector reads first (the ledger strip, the client's cards,
 * their quotes), then edits (`e`). Money is counted once, by Board's
 * `clientLedger`: a card is its price + follow-ups; what came in is paid,
 * what is left is awaiting or on the board; quotes stay out.
 *
 * Delete (`⌫`) is for a client nothing points at, and can't come back, so
 * it asks in place; a client on a card or a quote says why where the button
 * would be — archive it instead.
 *
 * Keys: c new client · e edit · b card for this client · ⌫ delete ·
 * r restore (archived) · ↑ ↓ j k rows · 1 2 active · archived (the top
 * bar's views) · Esc close.
 */

export type ClientsPageProps = {
  clients: ClientData[]
  ledger: Record<string, LedgerData>
  projects: ClientProject[]
  once: OnceNameData[]
  /** What points at each client; a client missing here may be deleted. */
  uses: Record<string, ClientUseData>
  view: 'active' | 'archived'
  /** This year, as the ledger counts it. */
  year: string
  selectedId: string | null
  /** The first selection's cards and quotes, read on the server. */
  detail: ClientDetailData | null
}

const EMPTY: LedgerData = {
  cards: 0,
  projectIds: [],
  onBoard: [],
  awaiting: [],
  paid: [],
}
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

const zero = (sum: string) => !/[1-9]/.test(sum)
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`
const byName = (a: ClientData, b: ClientData) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase())

/** The currency a strip is drawn in: THB when there is any, else the first one seen. */
function mainCurrency(...lists: Money[][]): string | null {
  const all = lists.flat()
  if (all.some((entry) => entry.currency === 'THB')) return 'THB'
  return all[0]?.currency ?? null
}
const amountIn = (list: Money[], currency: string | null) =>
  list.find((entry) => entry.currency === currency)?.sum ?? '0'
/** `฿24,000 · $300`, or null when there is nothing. */
function moneyText(list: Money[], except?: string | null): string | null {
  const parts = list
    .filter((entry) => entry.currency !== except && !zero(entry.sum))
    .map((entry) => formatMoney(entry.sum, entry.currency))
  return parts.length ? parts.join(' · ') : null
}
/** Per-currency lists added up, never converted. */
function combine(lists: Money[][]): Money[] {
  const out = new Map<string, string>()
  for (const entry of lists.flat())
    out.set(
      entry.currency,
      sumAmounts([out.get(entry.currency) ?? '0', entry.sum], entry.currency),
    )
  return [...out].map(([currency, sum]) => ({ currency, sum }))
}
/** `Sep 2026` from an ISO instant — the same on the server and in the browser. */
function monthLabel(iso: string): string {
  const date = new Date(iso)
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}
/** Why a client can't be deleted, in words — or null when nothing points at it. */
function whyNotDelete(
  client: ClientData,
  use: ClientUseData | undefined,
): string | null {
  if (!use || use.cards + use.quotes === 0) return null
  const what = [
    use.cards ? plural(use.cards, 'card') : null,
    use.quotes ? plural(use.quotes, 'quote') : null,
  ]
    .filter(Boolean)
    .join(' and ')
  const keeps = use.cards + use.quotes === 1 ? 'keeps' : 'keep'
  return `Can’t delete: it’s on ${what}, which ${keeps} naming it.${client.archived ? '' : ' Archive it instead.'}`
}

/** `Aug 21` from a `YYYY-MM-DD` day. */
function dayLabel(day: string | null): string {
  const m = day ? /^\d{4}-(\d{2})-(\d{2})$/.exec(day) : null
  return m ? `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}` : '—'
}

export function ClientsPage(props: ClientsPageProps) {
  const router = useRouter()
  const toast = useToast()
  const [clients, setClients] = useState(props.clients)
  const [details, setDetails] = useState<Record<string, ClientDetailData>>(
    () => (props.detail ? { [props.detail.clientId]: props.detail } : {}),
  )
  const [selId, setSelId] = useState<string | null>(props.selectedId)
  const [mode, setMode] = useState<'read' | 'new' | 'edit'>('read')
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Delete for good asks in place; ⌫ opens the same question as the button.
  const [asking, setAsking] = useState(false)
  // Names just added, hidden until the server's list catches up.
  const [adopted, setAdopted] = useState<string[]>([])
  const paneRef = useRef<HTMLElement>(null)

  useEffect(() => setClients(props.clients), [props.clients])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new list from the server is the trigger — it already leaves out the names just added
  useEffect(() => setAdopted([]), [props.once])
  useEffect(() => {
    setDetails(props.detail ? { [props.detail.clientId]: props.detail } : {})
  }, [props.detail])

  const archivedView = props.view === 'archived'
  const projectById = useMemo(
    () => new Map(props.projects.map((project) => [project.id, project])),
    [props.projects],
  )
  const ledgerOf = (id: string) => props.ledger[id] ?? EMPTY
  const projectsOf = (id: string) =>
    ledgerOf(id)
      .projectIds.map((projectId) => projectById.get(projectId))
      .filter((project): project is ClientProject => Boolean(project))

  const inView = clients.filter((client) => client.archived === archivedView)
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? inView.filter((client) => client.name.toLowerCase().includes(needle))
    : inView
  const once = archivedView
    ? []
    : props.once.filter(
        (entry) =>
          !adopted.includes(entry.name.toLowerCase()) &&
          (!needle || entry.name.toLowerCase().includes(needle)),
      )
  // Nothing is chosen until you pick (or `?client=` names one).
  const selected =
    mode === 'new'
      ? null
      : (shown.find((client) => client.id === selId) ?? null)
  const selectedId = selected?.id ?? null
  const detail = selectedId ? (details[selectedId] ?? null) : null

  const select = useCallback((id: string | null) => {
    setSelId(id)
    setMode('read')
    setError(null)
    setAsking(false)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('client', id)
    else url.searchParams.delete('client')
    window.history.replaceState(null, '', url)
  }, [])

  const replace = useCallback((row: ClientData) => {
    setClients((list) =>
      list.some((entry) => entry.id === row.id)
        ? list.map((entry) => (entry.id === row.id ? row : entry))
        : [...list, row].sort(byName),
    )
  }, [])

  // A new selection reads its cards and quotes; the first one came with the page.
  useEffect(() => {
    if (!selectedId || details[selectedId]) return
    let alive = true
    clientDetailAction(selectedId).then((result) => {
      if (!alive) return
      if (result.ok)
        setDetails((map) => ({ ...map, [selectedId]: result.data }))
      else toast(result.error)
    })
    return () => {
      alive = false
    }
  }, [selectedId, details, toast])

  useEffect(() => {
    if (!selectedId) return
    paneRef.current
      ?.querySelector(`[data-client="${selectedId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  /** Where "＋ Card for this client" starts: the one project with Board the client works in, else every board. */
  const newCardHref = (client: ClientData) => {
    const boards = projectsOf(client.id).filter((project) => project.board)
    const only = boards.length === 1 ? boards[0] : null
    return only
      ? `/p/${only.slug}/board?newFor=${client.id}`
      : `/board?newFor=${client.id}`
  }

  const startNew = () => {
    setMode('new')
    setError(null)
  }

  usePageKeyHints(
    archivedView
      ? [
          ['r', 'restore'],
          ['e', 'edit'],
          ['⌫', 'delete'],
          ['↑ ↓ j k', 'clients'],
          ['c', 'new client'],
          ['1 2', 'active · archived'],
        ]
      : [
          ['c', 'new client'],
          ['e', 'edit'],
          ['b', 'card for client'],
          ['⌫', 'delete'],
          ['↑ ↓ j k', 'clients'],
          ['1 2', 'active · archived'],
        ],
  )

  usePageKeys((key) => {
    // While Delete asks, its two answers have the keys: ↵ gives the one
    // with focus, Esc keeps the client.
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
    if (key === 'c') {
      startNew()
      return true
    }
    const index = shown.findIndex((client) => client.id === selectedId)
    if (['ArrowDown', 'j', 'ArrowUp', 'k'].includes(key)) {
      const down = key === 'ArrowDown' || key === 'j'
      const next =
        shown[
          down ? Math.min(shown.length - 1, index + 1) : Math.max(0, index - 1)
        ]
      if (next) select(next.id)
      return Boolean(next)
    }
    if (!selected || mode !== 'read') return false
    if (key === 'e') {
      setMode('edit')
      return true
    }
    if (key === 'b' && !selected.archived) {
      router.push(newCardHref(selected))
      return true
    }
    if (key === 'r' && selected.archived) {
      if (!busy) archive(selected)
      return true
    }
    if (key === 'Backspace' || key === 'Delete') {
      const why = whyNotDelete(selected, props.uses[selected.id])
      if (why) toast(`${selected.name}: ${why}`)
      else setAsking(true)
      return true
    }
    return false
  })

  /** "Add as client": the name becomes a record and its cards point at it. */
  const adopt = (entry: OnceNameData) => {
    setBusy(true)
    adoptNameAction({
      name: entry.name,
      clientId: entry.match?.id ?? null,
      cards: entry.cards.map((card) => ({
        id: card.id,
        revision: card.revision,
      })),
    }).then((result) => {
      setBusy(false)
      if (!result.ok) {
        toast(result.error)
        return
      }
      const { client, created, cards, skipped } = result.data
      const key = entry.name.toLowerCase()
      setAdopted((list) => [...list, key])
      replace(client)
      setDetails((map) => {
        const next = { ...map }
        delete next[client.id]
        return next
      })
      select(client.id)
      toast(
        `${created ? `Added ${client.name} to Clients` : `Linked to ${client.name}`} — ${plural(cards.length, 'card')} now ${cards.length === 1 ? 'points' : 'point'} at it${skipped ? `; ${plural(skipped, 'card')} changed meanwhile and kept the name` : ''}`,
        {
          undo: async () => {
            const back = await undoAdoptAction({
              name: entry.name,
              client: { id: client.id, revision: client.revision },
              created,
              cards,
            })
            if (!back.ok) {
              toast(back.error)
              return
            }
            setAdopted((list) => list.filter((name) => name !== key))
            if (created) select(null)
          },
        },
      )
    })
  }

  /** Archive or restore — the owner's, with Undo. */
  const archive = (client: ClientData) => {
    setBusy(true)
    setError(null)
    archiveClientAction({
      clientId: client.id,
      expectedRevision: client.revision,
      archived: !client.archived,
    }).then((result) => {
      setBusy(false)
      if (!result.ok) {
        setError(result.error)
        return
      }
      const saved = result.data
      const live = ledgerOf(saved.id).cards
      replace(saved)
      toast(
        saved.archived
          ? `Archived: ${saved.name}${live ? ` — ${plural(live, 'card')} keep the name; new work can’t pick it` : ''}`
          : `Restored: ${saved.name}`,
        {
          undo: async () => {
            const back = await archiveClientAction({
              clientId: saved.id,
              expectedRevision: saved.revision,
              archived: !saved.archived,
            })
            if (!back.ok) {
              toast(back.error)
              return
            }
            replace(back.data)
            select(back.data.id)
          },
        },
      )
    })
  }

  /** Delete for good — asked first, in place; nothing to undo. */
  const remove = async (client: ClientData) => {
    const index = shown.findIndex((entry) => entry.id === client.id)
    const next = shown[index + 1]?.id ?? shown[index - 1]?.id ?? null
    setError(null)
    const result = await deleteClientAction({
      clientId: client.id,
      expectedRevision: client.revision,
    })
    if (!result.ok) {
      setError(result.error)
      return
    }
    setClients((list) => list.filter((entry) => entry.id !== client.id))
    select(next)
    toast(`Deleted for good: ${client.name}`)
  }

  /** A form's answer: the row, a toast, and Undo as the inverse write. */
  const saved = (row: ClientData, before: ClientData | null) => {
    replace(row)
    select(row.id)
    toast(before ? `Saved: ${row.name}` : `Client added: ${row.name}`, {
      undo: async () => {
        const back = before
          ? await saveClientAction({
              clientId: row.id,
              expectedRevision: row.revision,
              name: before.name,
              taxId: before.taxId ?? '',
              address: before.address,
              email: before.email ?? '',
              phone: before.phone ?? '',
            })
          : await archiveClientAction({
              clientId: row.id,
              expectedRevision: row.revision,
              archived: true,
            })
        if (!back.ok) {
          toast(back.error)
          return
        }
        replace(back.data)
        if (!before) select(null)
      },
    })
  }

  // The readout above the table: what every active client owes, from the same ledger.
  const activeLedgers = clients
    .filter((client) => !client.archived)
    .map((client) => ledgerOf(client.id))
  const owedAll = combine(activeLedgers.map((ledger) => ledger.awaiting))
  const owing = activeLedgers.filter((ledger) =>
    ledger.awaiting.some((entry) => !zero(entry.sum)),
  ).length
  const owedCurrency = mainCurrency(owedAll)
  const owedMain = amountIn(owedAll, owedCurrency)
  const owedOthers = moneyText(owedAll, owedCurrency)
  const activeCount = clients.filter((client) => !client.archived).length

  return (
    <div className='page clientsp'>
      <section className='pane list-pane' aria-label='Clients' ref={paneRef}>
        <PaneHead title='Clients' meta={`${activeCount} · every project`} />
        <div className='toolbar'>
          <input
            type='search'
            placeholder='Filter clients'
            aria-label='Filter clients'
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <span className='sp' />
          <span className='hits'>
            {shown.length} of {inView.length}
          </span>
          <button type='button' className='btn btn-sm' onClick={startNew}>
            ＋ New client<kbd>c</kbd>
          </button>
        </div>
        {archivedView ? null : (
          <div className='client-read'>
            <Readout
              tone={owedCurrency && !zero(owedMain) ? 'accent' : 'dim'}
              big={
                owedCurrency && !zero(owedMain)
                  ? formatMoney(owedMain, owedCurrency)
                  : '0'
              }
              sub={`awaiting payment · ${plural(owing, 'client')} · counted from Board${owedOthers ? ` · also ${owedOthers}` : ''}`}
            />
          </div>
        )}
        <div className='pane-body'>
          {shown.length === 0 && once.length === 0 ? (
            <Empty>
              {needle
                ? `○ nothing matches “${filter.trim()}”`
                : archivedView
                  ? '○ nothing archived'
                  : '○ no clients yet — press c, or add one from a card’s Client field.'}
            </Empty>
          ) : (
            // A list of buttons laid out as a table; each button reads as one sentence.
            <div className='tbl client-tbl'>
              <div className='tbl-head' aria-hidden='true'>
                <span className='hud-label'>client</span>
                <span className='hud-label c-hide'>projects</span>
                <span className='hud-label num c-hide'>cards</span>
                <span className='hud-label num c-hide'>on the board</span>
                <span className='hud-label num'>awaiting</span>
                <span className='hud-label num c-hide'>
                  paid · {props.year}
                </span>
              </div>
              {shown.map((client) => {
                const ledger = ledgerOf(client.id)
                const projects = projectsOf(client.id)
                const onBoard = moneyText(ledger.onBoard)
                const awaiting = moneyText(ledger.awaiting)
                const paid = moneyText(ledger.paid)
                const current = client.id === selectedId
                const contact = [client.email, client.phone]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <button
                    key={client.id}
                    type='button'
                    data-client={client.id}
                    className={`tbl-row${current ? ' sel' : ''}`}
                    aria-pressed={current}
                    aria-label={`${client.name} — ${awaiting ? `${awaiting} awaiting payment` : 'nothing awaiting payment'}, ${onBoard ?? 'nothing'} on the board, ${paid ?? 'nothing'} paid in ${props.year}`}
                    onClick={() => select(client.id)}
                  >
                    <span className='nm'>
                      <span
                        className='n1'
                        lang={isThai(client.name) ? 'th' : undefined}
                      >
                        {client.name}
                      </span>
                      <span className='n2'>{contact || 'no contact yet'}</span>
                    </span>
                    <span
                      className='dots c-hide'
                      title={projects
                        .map((project) => project.name)
                        .join(' · ')}
                    >
                      {projects.length ? (
                        projects.map((project) => (
                          <Dot key={project.id} color={project.color} />
                        ))
                      ) : (
                        <span className='dim'>—</span>
                      )}
                    </span>
                    <span className='num c-hide'>{ledger.cards}</span>
                    <span
                      className={`num c-hide${onBoard ? '' : ' dim'}`}
                      title={onBoard ?? undefined}
                    >
                      {onBoard ?? '—'}
                    </span>
                    <span
                      className={`num ${awaiting ? 'accent' : 'dim'}`}
                      title={awaiting ?? undefined}
                    >
                      {awaiting ?? '—'}
                    </span>
                    <span
                      className={`num c-hide${paid ? '' : ' dim'}`}
                      title={paid ?? undefined}
                    >
                      {paid ?? '—'}
                    </span>
                  </button>
                )
              })}
              {once.length ? (
                <>
                  <div className='once-head'>
                    <span className='hud-label'>
                      Used once on a card · not in Clients
                    </span>
                  </div>
                  {once.map((entry) => (
                    <div key={entry.name} className='tbl-row once-row'>
                      <span className='nm'>
                        <span
                          className='n1'
                          lang={isThai(entry.name) ? 'th' : undefined}
                        >
                          {entry.name}
                        </span>
                        <span className='n2'>
                          {plural(entry.cards.length, 'card')} ·{' '}
                          {entry.cards
                            .slice(0, 2)
                            .map((card) => card.title)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className='c-hide' />
                      <span className='c-hide' />
                      <span className='c-hide' />
                      <span className='act'>
                        <button
                          type='button'
                          className='btn btn-sm'
                          disabled={busy}
                          title={
                            entry.match
                              ? `You already have ${entry.match.name} — point these cards at it`
                              : 'Make a client of this name, and point these cards at it'
                          }
                          onClick={() => adopt(entry)}
                        >
                          {entry.match ? 'Link to client' : 'Add as client'}
                        </button>
                      </span>
                      <span className='c-hide' />
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          )}
        </div>
      </section>
      <Inspector
        id='clients'
        label={mode === 'new' ? 'New client' : 'Selected client'}
        empty={mode === 'read' && !selected}
        onClose={() => select(null)}
      >
        {mode === 'new' ? (
          <>
            <InspectorHead
              title='Clients › new'
              meta='not saved yet'
              onClose={() => setMode('read')}
            />
            <div className='insp-body'>
              <div className='dev-read'>
                <Readout
                  big='New client'
                  sub='one record for every project'
                  tone='dim'
                />
              </div>
              <div className='dev-main'>
                <ClientForm
                  client={null}
                  onCancel={() => setMode('read')}
                  onSaved={saved}
                />
              </div>
            </div>
          </>
        ) : selected ? (
          <ClientInspector
            key={selected.id}
            client={selected}
            ledger={ledgerOf(selected.id)}
            projects={projectsOf(selected.id)}
            detail={detail}
            year={props.year}
            editing={mode === 'edit'}
            busy={busy}
            error={error}
            newCardHref={newCardHref(selected)}
            onClose={() => select(null)}
            onEdit={() => setMode('edit')}
            onCancel={() => setMode('read')}
            onSaved={saved}
            onArchive={() => archive(selected)}
            whyNot={whyNotDelete(selected, props.uses[selected.id])}
            asking={asking}
            onAsking={setAsking}
            onDelete={() => remove(selected)}
          />
        ) : (
          <>
            <InspectorHead title='Client' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>Select a client, or press c for a new one.</Empty>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

function ClientInspector({
  client,
  ledger,
  projects,
  detail,
  year,
  editing,
  busy,
  error,
  newCardHref,
  onClose,
  onEdit,
  onCancel,
  onSaved,
  onArchive,
  whyNot,
  asking,
  onAsking,
  onDelete,
}: {
  client: ClientData
  ledger: LedgerData
  projects: ClientProject[]
  detail: ClientDetailData | null
  year: string
  editing: boolean
  busy: boolean
  error: string | null
  newCardHref: string
  onClose: (() => void) | null
  onEdit: () => void
  onCancel: () => void
  onSaved: (row: ClientData, before: ClientData | null) => void
  onArchive: () => void
  /** Why Delete isn't offered, in words; null when nothing points at the client. */
  whyNot: string | null
  asking: boolean
  onAsking: (asking: boolean) => void
  onDelete: () => Promise<void>
}) {
  const cards = detail?.cards ?? []
  const owedCards = cards.filter((card) => !card.archived && card.awaiting)
  const boardCards = cards.filter((card) => !card.archived && !card.awaiting)
  const paidCards = cards
    .filter((card) => card.paidThisYear)
    .sort((a, b) => (b.lastPaidOn ?? '').localeCompare(a.lastPaidOn ?? ''))
  const currency = mainCurrency(ledger.awaiting, ledger.onBoard, ledger.paid)
  const owed = amountIn(ledger.awaiting, currency)
  const owedOthers = moneyText(ledger.awaiting, currency)
  const thai = isThai(client.name) ? 'th' : undefined

  const read =
    currency && !zero(owed) ? (
      <Readout
        tone='accent'
        big={
          <>
            {formatMoney(owed, currency)} <span className='u'>{currency}</span>
          </>
        }
        sub={`awaiting payment · ${detail ? plural(owedCards.length, 'card') : '…'}${owedOthers ? ` · also ${owedOthers}` : ''}`}
      />
    ) : (
      <Readout
        tone='dim'
        big='nothing owed'
        sub={`${moneyText(ledger.paid) ?? '—'} paid in ${year}`}
      />
    )

  return (
    <>
      <InspectorHead
        title={
          <>
            Clients › <Name text={client.name} />
          </>
        }
        meta={
          editing
            ? 'editing'
            : client.archived
              ? 'archived'
              : plural(projects.length, 'project')
        }
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          {read}
          <Facts
            rows={[
              ['tax id', client.taxId ?? '—'],
              ['email', client.email ?? '—'],
              ['phone', client.phone ?? '—'],
              [
                'address',
                client.address ? (
                  <Name key='address' text={client.address} />
                ) : (
                  '—'
                ),
              ],
              ['client since', monthLabel(client.since)],
            ]}
          />
        </div>
        <div className='dev-main'>
          {editing ? (
            <ClientForm client={client} onCancel={onCancel} onSaved={onSaved} />
          ) : (
            <>
              <h2 className='dev-title' lang={thai}>
                {client.name}
              </h2>
              <LedgerStrip
                ledger={ledger}
                year={year}
                counts={
                  detail
                    ? {
                        paid: paidCards.length,
                        owed: owedCards.length,
                        board: boardCards.length,
                      }
                    : null
                }
              />
              <div className='dev-acts'>
                <button type='button' className='btn btn-sm' onClick={onEdit}>
                  Edit<kbd>e</kbd>
                </button>
                {client.archived ? (
                  <>
                    <button
                      type='button'
                      className='btn btn-sm'
                      disabled
                      title='Restore the client to start new work for it'
                    >
                      ＋ Card for this client<kbd>b</kbd>
                    </button>
                    <button
                      type='button'
                      className='btn btn-sm'
                      disabled
                      title='Restore the client to start new work for it'
                    >
                      ＋ Quote
                    </button>
                  </>
                ) : (
                  <>
                    <Link className='btn btn-sm' href={newCardHref}>
                      ＋ Card for this client<kbd>b</kbd>
                    </Link>
                    <Link
                      className='btn btn-sm'
                      href={`/quotes?new=1&client=${client.id}`}
                    >
                      ＋ Quote
                    </Link>
                  </>
                )}
                <button
                  type='button'
                  className='btn btn-sm'
                  disabled={busy}
                  onClick={onArchive}
                >
                  {client.archived ? (
                    <>
                      Restore<kbd>r</kbd>
                    </>
                  ) : (
                    'Archive'
                  )}
                </button>
                {whyNot ? (
                  <span className='cant'>{whyNot}</span>
                ) : (
                  <Confirm
                    label='Delete'
                    kbd='⌫'
                    question={`Delete ${client.name} for good?`}
                    yes='Delete for good'
                    run={onDelete}
                    disabled={busy}
                    asking={asking}
                    onAsking={onAsking}
                  />
                )}
              </div>
              {error ? (
                <p className='why' role='alert'>
                  <b>Didn’t change:</b> {error}
                </p>
              ) : null}
              {!detail ? (
                <Empty>…</Empty>
              ) : owedCards.length || boardCards.length || paidCards.length ? (
                <div className='crows'>
                  {owedCards.length ? (
                    <CardGroup
                      label='Awaiting payment'
                      sum={moneyText(ledger.awaiting)}
                    >
                      {owedCards.map((card) => (
                        <CardRow key={card.id} card={card} />
                      ))}
                    </CardGroup>
                  ) : null}
                  {boardCards.length ? (
                    <CardGroup
                      label='On the board'
                      sum={moneyText(ledger.onBoard)}
                    >
                      {boardCards.map((card) => (
                        <CardRow key={card.id} card={card} />
                      ))}
                    </CardGroup>
                  ) : null}
                  {paidCards.length ? (
                    <CardGroup
                      label={`Paid · ${year}`}
                      sum={moneyText(ledger.paid)}
                    >
                      {paidCards.map((card) => (
                        <PaidRow key={card.id} card={card} />
                      ))}
                    </CardGroup>
                  ) : null}
                </div>
              ) : (
                <Empty>
                  {client.archived
                    ? '○ no cards'
                    : '○ no cards yet — press b to start one on a board.'}
                </Empty>
              )}
              {detail?.quotes.length ? (
                <>
                  <div className='dev-h'>
                    <span className='hud-label'>Quotes</span>
                  </div>
                  <div className='dev-rows'>
                    {detail.quotes.map((quote) => (
                      <Link
                        key={quote.id}
                        className='dev-row'
                        href={quote.href}
                      >
                        <span
                          className='t'
                          lang={isThai(quote.title) ? 'th' : undefined}
                        >
                          <span className='mono'>{quote.number}</span> ·{' '}
                          {quote.title}
                        </span>
                        <span className='v'>
                          {quote.status} ·{' '}
                          {formatMoney(quote.total, quote.currency)}
                        </span>
                      </Link>
                    ))}
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * The instrument: one bar on one scale — paid lit, awaiting as
 * unlit segments under a dashed accent cap (pending money is never a lit
 * bar), on the board as a dashed outline — then a line for each with its
 * count and amount. Other currencies are named under it, never converted.
 */
function LedgerStrip({
  ledger,
  year,
  counts,
}: {
  ledger: LedgerData
  year: string
  counts: { paid: number; owed: number; board: number } | null
}) {
  const currency = mainCurrency(ledger.paid, ledger.awaiting, ledger.onBoard)
  const paid = amountIn(ledger.paid, currency)
  const owed = amountIn(ledger.awaiting, currency)
  const board = amountIn(ledger.onBoard, currency)
  // Proportions only; every figure shown is the decimal string itself.
  const max = Math.max(1, Number(paid) + Number(owed) + Number(board))
  const width = (sum: string) => ({
    width: `${((Number(sum) / max) * 100).toFixed(2)}%`,
  })
  const text = (sum: string) =>
    currency && !zero(sum) ? formatMoney(sum, currency) : '—'
  const count = (n: number | undefined, one: string) =>
    n === undefined ? '…' : plural(n, one)
  const others = [
    ...new Set(
      [...ledger.paid, ...ledger.awaiting, ...ledger.onBoard]
        .map((entry) => entry.currency)
        .filter((code) => code !== currency),
    ),
  ].map((code) => {
    const part = (list: Money[], label: string) =>
      zero(amountIn(list, code))
        ? null
        : `${label} ${formatMoney(amountIn(list, code), code)}`
    return `Also in ${code}: ${[
      part(ledger.paid, 'paid'),
      part(ledger.awaiting, 'awaiting'),
      part(ledger.onBoard, 'on the board'),
    ]
      .filter(Boolean)
      .join(' · ')}.`
  })
  return (
    <div
      className='ledger'
      role='img'
      aria-label={`Paid ${text(paid)} in ${year}, ${text(owed)} awaiting payment, ${text(board)} on the board`}
    >
      <div className='bar' aria-hidden='true'>
        {zero(paid) ? null : <i className='paid' style={width(paid)} />}
        {zero(owed) ? null : <i className='owed' style={width(owed)} />}
        {zero(board) ? null : <i className='board' style={width(board)} />}
      </div>
      <div className='ln'>
        <i className='k paid' />
        <span>paid · {year}</span>
        <span className='n'>{count(counts?.paid, 'line')}</span>
        <b>{text(paid)}</b>
      </div>
      <div className='ln owed'>
        <i className='k owed' />
        <span>awaiting payment</span>
        <span className='n'>{count(counts?.owed, 'card')}</span>
        <b>{text(owed)}</b>
      </div>
      <div className='ln'>
        <i className='k board' />
        <span>on the board</span>
        <span className='n'>{count(counts?.board, 'card')}</span>
        <b>{text(board)}</b>
      </div>
      <div className='rule' />
      <div className='ledger-note'>
        Each baht once: a card is its price + follow-ups; what came in is paid,
        what is left is awaiting or on the board. Quotes stay out — a quoted
        card holds that money.
        {others.length ? ` ${others.join(' ')}` : ''}
      </div>
    </div>
  )
}

function CardGroup({
  label,
  sum,
  children,
}: {
  label: string
  sum: string | null
  children: ReactNode
}) {
  return (
    <div className='cgroup'>
      <span className='hud-label'>
        {label} <span>{sum ?? '—'}</span>
      </span>
      {children}
    </div>
  )
}

/** The card's colour swatch as its stripe, never its background. */
const stripe = (card: ClientCardData) =>
  card.color
    ? {
        'data-color': card.color,
        style: {
          ['--card' as string]: PROJECT_COLORS[card.color],
        } as CSSProperties,
      }
    : {}

function CardRow({ card }: { card: ClientCardData }) {
  return (
    <Link className='crow' href={card.href} {...stripe(card)}>
      <span className='t' lang={isThai(card.title) ? 'th' : undefined}>
        {card.title}
      </span>
      <span className='v'>
        {card.total && card.currency
          ? formatMoney(card.total, card.currency)
          : '—'}
      </span>
      <span className='m'>
        <Tag project={card.project} />
        <span lang={isThai(card.laneName) ? 'th' : undefined}>
          › {card.laneName}
        </span>
        {card.followups ? (
          <span className='fu-n'>
            · <FollowupMark />
            {plural(card.followups, 'follow-up')}
          </span>
        ) : null}
      </span>
    </Link>
  )
}

/** Money that came in this year on one card: paid in full, or a deposit on a card still on the board. */
function PaidRow({ card }: { card: ClientCardData }) {
  const when = card.paidAt
    ? `paid ${dayLabel(card.lastPaidOn)}`
    : card.archived
      ? `${plural(card.paymentsThisYear, 'payment')} · archived`
      : `${plural(card.paymentsThisYear, 'payment')} so far · still on the board`
  return (
    <div className='crow paid' {...stripe(card)}>
      <span className='t' lang={isThai(card.title) ? 'th' : undefined}>
        {card.title}
      </span>
      <span className='v'>
        {card.paidThisYear && card.currency
          ? formatMoney(card.paidThisYear, card.currency)
          : (card.paidThisYear ?? '—')}
      </span>
      <span className='m'>
        <Tag project={card.project} />
        <span>· {when}</span>
      </span>
    </div>
  )
}

/** New client, or the selected one's details — Save ↵ · Cancel Esc. */
function ClientForm({
  client,
  onCancel,
  onSaved,
}: {
  client: ClientData | null
  onCancel: () => void
  onSaved: (row: ClientData, before: ClientData | null) => void
}) {
  const [name, setName] = useState(client?.name ?? '')
  const [email, setEmail] = useState(client?.email ?? '')
  const [phone, setPhone] = useState(client?.phone ?? '')
  const [taxId, setTaxId] = useState(client?.taxId ?? '')
  const [address, setAddress] = useState(client?.address ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  return (
    <form
      className='fcard'
      autoComplete='off'
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        start(async () => {
          const result = await saveClientAction({
            clientId: client?.id,
            expectedRevision: client?.revision,
            name,
            email,
            phone,
            taxId,
            address,
          })
          if (result.ok) onSaved(result.data, client)
          else setError(result.error)
        })
      }}
    >
      <span className='hud-label'>{client ? 'Edit client' : 'New client'}</span>
      <label>
        Name
        <input
          ref={first}
          type='text'
          required
          maxLength={160}
          value={name}
          lang={isThai(name) ? 'th' : undefined}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className='row'>
        <label style={{ flex: 1 }}>
          Email
          <input
            type='text'
            inputMode='email'
            maxLength={200}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label style={{ flex: 1 }}>
          Phone
          <input
            type='text'
            inputMode='tel'
            maxLength={60}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </label>
      </div>
      <label>
        Tax ID
        <input
          type='text'
          className='mono'
          maxLength={40}
          placeholder='13 digits for a Thai company'
          value={taxId}
          onChange={(event) => setTaxId(event.target.value)}
        />
      </label>
      <label>
        Address · for quotes
        <textarea
          rows={2}
          maxLength={600}
          value={address}
          lang={isThai(address) ? 'th' : undefined}
          onChange={(event) => setAddress(event.target.value)}
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
          disabled={pending || !name.trim()}
        >
          {pending ? 'Saving…' : client ? 'Save' : 'Add client'}
          <kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
      <p className='hint'>
        {client
          ? 'A new name shows on every card and quote that points here; a sent quote keeps the name it was sent with.'
          : 'Board’s Client field and Quotes pick it by name.'}
      </p>
    </form>
  )
}
