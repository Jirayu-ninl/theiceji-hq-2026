'use client'

import { formatMoney, sumAmounts } from '@theiceji/hq-core/money'
import type { QuoteIssuer } from '@theiceji/hq-db/schema'
import {
  bahtText,
  parseQty,
  parseUnitPrice,
  quoteTotals,
} from '@theiceji/hq-quotes/totals'
import Link from 'next/link'
import {
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
  PaneHead,
  Readout,
  Tag,
  usePageKeys,
} from '@/components/bridge/parts'
import { Confirm } from '@/components/Confirm'
import { usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import {
  createDraftAction,
  decideQuoteAction,
  deleteDraftAction,
  type LineInput,
  quoteAction,
  reviseQuoteAction,
  saveIssuerAction,
  sendQuoteAction,
  updateDraftAction,
} from '../actions'
import type {
  ClientData,
  QuoteDetailData,
  QuoteProject,
  QuoteRowData,
} from '../data'

/**
 * Quotes:
 * quotations `Q-YYYY-NNN` beside an inspector that edits a draft or reads a
 * sent one. The instrument is the totals tape — an LCD of subtotal · VAT ·
 * withholding · total due, with the amount in Thai words for THB.
 *
 * Mark sent is the one red button: it freezes the lines, the totals and the
 * PDF. HQ never emails a client; the owner downloads the PDF and sends it.
 * Mark sent, Accepted and Declined can't be taken back, so each asks once —
 * its key pressed again, or the answer clicked, does it.
 *
 * Clients are HQ-wide: they live on `/clients`, and the
 * client select reads the same records.
 */

export type QuotesPageProps = {
  project: QuoteProject | null
  projects: QuoteProject[]
  quotes: QuoteRowData[]
  clients: ClientData[]
  issuer: QuoteIssuer | null
  view: 'quotes'
  selectedId: string | null
  /** The selected quote, read on the server. */
  detail: QuoteDetailData | null
  creating: boolean
  fromCard: {
    id: string
    title: string
    price: string | null
    client: string | null
    /** The card's client in Clients, when it points at one. */
    clientId: string | null
    projectId: string | null
  } | null
  /** `?new=1&client=<id>` — a new quote for this client (Clients' ＋ Quote). */
  newClientId: string | null
}

const STATUSES = [
  'all',
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
] as const
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
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
const dayLabel = (day: string | null) => {
  const m = day ? DAY.exec(day) : null
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '—'
}
const exact = (amount: string, currency: string) =>
  formatMoney(amount, currency, { exact: true, symbol: false })

function Tape({
  totals,
  words,
}: {
  totals: QuoteDetailData['totals']
  words: boolean
}) {
  const vatOn = Number(totals.vatPct) > 0
  const whtOn = Number(totals.whtPct) > 0
  const thai =
    words && totals.currency === 'THB' ? bahtText(totals.total) : null
  return (
    // biome-ignore lint/a11y/useSemanticElements: the tape is a labelled group of figures, not a form fieldset
    <div className='tape' role='group' aria-label='Totals'>
      <div className='ln'>
        <span>subtotal</span>
        <b>{exact(totals.subtotal, totals.currency)}</b>
      </div>
      <div className={`ln${vatOn ? '' : ' off'}`}>
        <span>VAT {vatOn ? `${totals.vatPct}%` : ''}</span>
        <b>{vatOn ? exact(totals.vat, totals.currency) : 'off'}</b>
      </div>
      <div className={`ln${whtOn ? '' : ' off'}`}>
        <span>withholding {whtOn ? `${totals.whtPct}%` : ''}</span>
        <b>{whtOn ? `−${exact(totals.wht, totals.currency)}` : 'off'}</b>
      </div>
      <div className='rule' />
      <div className='due'>
        <span className='hud-label'>total due · {totals.currency}</span>
        <b>{exact(totals.total, totals.currency)}</b>
      </div>
      {thai ? (
        <div className='words' lang='th'>
          ({thai})
        </div>
      ) : null}
    </div>
  )
}

function StatusWord({ quote }: { quote: QuoteRowData }) {
  if (quote.status === 'accepted')
    return <span className='state-word live'>accepted</span>
  if (quote.status === 'sent')
    return (
      <span className='state-word due'>
        sent · until {dayLabel(quote.validUntil)}
      </span>
    )
  return <span className='state-word'>{quote.status}</span>
}

export function QuotesPage(props: QuotesPageProps) {
  const toast = useToast()
  const [quotes, setQuotes] = useState(props.quotes)
  const clients = props.clients
  const [issuer, setIssuer] = useState(props.issuer)
  const [selected, setSelected] = useState<string | null>(props.selectedId)
  const [detail, setDetail] = useState<QuoteDetailData | null>(props.detail)
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all')
  const [mode, setMode] = useState<'read' | 'new' | 'issuer'>(
    props.creating ? 'new' : 'read',
  )
  const paneRef = useRef<HTMLElement>(null)
  const all = props.project === null

  useEffect(() => setQuotes(props.quotes), [props.quotes])

  const shown = useMemo(
    () => quotes.filter((quote) => status === 'all' || quote.status === status),
    [quotes, status],
  )
  const open = quotes.filter((quote) => quote.status === 'sent')
  const pendingByCurrency = new Map<string, string[]>()
  for (const quote of open)
    pendingByCurrency.set(quote.currency, [
      ...(pendingByCurrency.get(quote.currency) ?? []),
      quote.totals.total,
    ])
  const pendingLabels = [...pendingByCurrency.entries()].map(
    ([currency, amounts]) =>
      formatMoney(sumAmounts(amounts, currency), currency),
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch on a new selection only — `detail` is what it fills
  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    if (detail?.id === selected) return
    let alive = true
    quoteAction(selected).then((result) => {
      if (!alive) return
      if (result.ok) setDetail(result.data)
      else toast(result.error)
    })
    return () => {
      alive = false
    }
  }, [selected, toast])

  const select = useCallback((id: string | null) => {
    setSelected(id)
    setMode('read')
    const url = new URL(window.location.href)
    url.searchParams.delete('new')
    url.searchParams.delete('card')
    if (id) url.searchParams.set('quote', id)
    else url.searchParams.delete('quote')
    window.history.replaceState(null, '', url)
  }, [])

  /** A write's answer replaces the row and the inspector's copy. */
  const saved = (next: QuoteDetailData, message?: string) => {
    setDetail(next)
    setQuotes((list) => {
      const row: QuoteRowData = { ...next }
      return list.some((entry) => entry.id === next.id)
        ? list.map((entry) => (entry.id === next.id ? row : entry))
        : [row, ...list]
    })
    if (message) toast(message)
  }

  usePageKeyHints([
    ['c', 'new quote'],
    ['p', 'preview pdf'],
    ...(detail?.status === 'draft'
      ? ([
          ['s', 'mark sent'],
          ['⌫', 'delete'],
        ] as const)
      : []),
    ...(detail?.status === 'sent'
      ? ([
          ['a', 'accepted'],
          ['x', 'declined'],
        ] as const)
      : []),
    ...(detail?.status === 'sent' || detail?.status === 'expired'
      ? ([['r', 'revise']] as const)
      : []),
    ...(detail && detail.status !== 'draft' && detail.hasPdf
      ? ([['d', 'download pdf']] as const)
      : []),
    ['↑ ↓', 'quotes'],
  ])

  usePageKeys((key) => {
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
      setSelected(null)
      setMode('new')
      return true
    }
    const index = shown.findIndex((quote) => quote.id === selected)
    if (key === 'ArrowDown' || key === 'j') {
      const next = shown[Math.min(shown.length - 1, index + 1)]
      if (next) select(next.id)
      return Boolean(next)
    }
    if (key === 'ArrowUp' || key === 'k') {
      const next = shown[Math.max(0, index - 1)]
      if (next) select(next.id)
      return Boolean(next)
    }
    if (!detail) return false
    if (key === 'p') {
      window.open(`/api/quotes/${detail.id}/pdf`, '_blank', 'noopener')
      return true
    }
    return false
  })

  const project = props.project

  return (
    <div className='page quotesp'>
      <section className='pane list-pane' aria-label='Quotes' ref={paneRef}>
        <PaneHead
          title={
            all ? (
              'All projects · Quotes'
            ) : (
              <>{project ? <Dot color={project.color} /> : null} Quotes</>
            )
          }
          meta={`${quotes.length} ${quotes.length === 1 ? 'quote' : 'quotes'} · ${open.length} open${pendingLabels.length ? ` · ${pendingLabels.join(' · ')} pending` : ''}`}
        />
        <div className='toolbar'>
          {/* biome-ignore lint/a11y/useSemanticElements: status filters are a group of toggle buttons */}
          <span className='status-chips' role='group' aria-label='Status'>
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
          <span className='sp' />
          <span className='hits'>
            {shown.length} of {quotes.length}
          </span>
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => {
              setSelected(null)
              setMode('new')
            }}
          >
            ＋ New quote<kbd>c</kbd>
          </button>
        </div>
        <div className='pending-read'>
          <Readout
            tone={pendingLabels.length ? 'accent' : 'dim'}
            big={pendingLabels[0] ?? '0'}
            sub={`sent and open · ${open.length} ${open.length === 1 ? 'quote' : 'quotes'} · not income until paid${pendingLabels.length > 1 ? ` · also ${pendingLabels.slice(1).join(' · ')}` : ''}`}
          />
        </div>
        <div className='pane-body'>
          {shown.length === 0 ? (
            <Empty>
              {quotes.length === 0
                ? '○ nothing yet — press c for the first quote, or quote a card from the Board.'
                : `No ${status} quotes.`}
            </Empty>
          ) : (
            <div
              className={`tbl quote-tbl${all ? ' global' : ''}`}
              role='listbox'
              aria-label='Quotes'
            >
              <div className='tbl-head' aria-hidden='true'>
                {all ? <span className='hud-label'>project</span> : null}
                <span className='hud-label'>no.</span>
                <span className='hud-label'>title</span>
                <span className='hud-label c-hide'>client</span>
                <span className='hud-label c-hide'>status</span>
                <span className='hud-label num'>total</span>
                <span className='hud-label c-hide'>valid until</span>
              </div>
              {shown.map((quote) => (
                <button
                  key={quote.id}
                  type='button'
                  role='option'
                  aria-selected={quote.id === selected}
                  className={`tbl-row${quote.id === selected ? ' sel' : ''}`}
                  onClick={() => select(quote.id)}
                >
                  {all ? (
                    <span>
                      {quote.project ? <Tag project={quote.project} /> : 'HQ'}
                    </span>
                  ) : null}
                  <span className='no'>{quote.number}</span>
                  <span lang={isThai(quote.title) ? 'th' : undefined}>
                    {quote.title}
                  </span>
                  <span
                    className='c-hide'
                    lang={isThai(quote.client?.name) ? 'th' : undefined}
                  >
                    {quote.client?.name ?? '—'}
                  </span>
                  <span className='c-hide'>
                    <StatusWord quote={quote} />
                  </span>
                  <span className='num'>
                    {formatMoney(quote.totals.total, quote.currency)}
                  </span>
                  <span className='c-hide mono'>
                    {quote.validUntil ? dayLabel(quote.validUntil) : '—'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
      <Inspector
        id='quotes'
        label='Quote'
        empty={!selected && mode === 'read'}
        onClose={() => select(null)}
      >
        {mode === 'issuer' ? (
          <IssuerForm
            issuer={issuer}
            onClose={() => setMode('read')}
            onSaved={(next) => {
              setIssuer(next)
              setMode('read')
              toast('Issuer saved — it prints on every quote')
              if (selected)
                quoteAction(selected).then(
                  (result) => result.ok && setDetail(result.data),
                )
            }}
          />
        ) : mode === 'new' ? (
          <NewQuote
            projects={all ? props.projects : project ? [project] : []}
            clients={clients.filter((client) => !client.archived)}
            fromCard={props.fromCard}
            clientId={props.newClientId}
            onCancel={() => setMode('read')}
            onCreated={(quote) => {
              saved(quote, `Draft ${quote.number} made`)
              select(quote.id)
            }}
          />
        ) : !detail || detail.id !== selected ? (
          <>
            <InspectorHead
              title='Quote'
              meta={selected ? '…' : 'nothing selected'}
            />
            <div className='insp-body'>
              <Empty>
                {selected ? '…' : 'Select a quote, or press c for a new one.'}
              </Empty>
            </div>
          </>
        ) : detail.status === 'draft' ? (
          <DraftEditor
            key={`${detail.id}-${detail.revision}`}
            quote={detail}
            clients={clients.filter((client) => !client.archived)}
            issuer={issuer}
            onClose={() => select(null)}
            onSaved={saved}
            onIssuer={() => setMode('issuer')}
            onDeleted={() => {
              setQuotes((list) =>
                list.filter((entry) => entry.id !== detail.id),
              )
              select(null)
              toast(`Deleted draft ${detail.number}`)
            }}
          />
        ) : (
          <SentQuote
            key={`${detail.id}-${detail.revision}`}
            quote={detail}
            onClose={() => select(null)}
            onSaved={saved}
          />
        )}
      </Inspector>
    </div>
  )
}

type LineDraft = LineInput & { key: string }

let lineSerial = 0
/** `1.000` → `1`, `0.500` → `0.5`: a quantity as people write it. */
const trimQty = (qty: string) =>
  qty.includes('.') ? qty.replace(/\.?0+$/, '') : qty
const blankLine = (): LineDraft => ({
  key: `l${++lineSerial}`,
  description: '',
  qty: '1',
  unit: '',
  unitPrice: '',
})

function DraftEditor({
  quote,
  clients,
  issuer,
  onClose,
  onSaved,
  onIssuer,
  onDeleted,
}: {
  quote: QuoteDetailData
  clients: ClientData[]
  issuer: QuoteIssuer | null
  onClose: () => void
  onSaved: (quote: QuoteDetailData, message?: string) => void
  onIssuer: () => void
  onDeleted: () => void
}) {
  const toast = useToast()
  const [title, setTitle] = useState(quote.title)
  const [clientId, setClientId] = useState(quote.clientId ?? '')
  const [newClient, setNewClient] = useState('')
  const [vat, setVat] = useState(Number(quote.vatPct) > 0)
  const [wht, setWht] = useState(Number(quote.whtPct) > 0)
  const [validDays, setValidDays] = useState(String(quote.validDays))
  const [notes, setNotes] = useState(quote.notes)
  const [lines, setLines] = useState<LineDraft[]>(
    quote.lines.length
      ? quote.lines.map((line) => ({
          key: `l${++lineSerial}`,
          description: line.description,
          qty: trimQty(line.qty),
          unit: line.unit,
          unitPrice: line.unitPrice,
        }))
      : [blankLine()],
  )
  const [error, setError] = useState<string | null>(null)
  /** The question open in the action row; its key opens the same one. */
  const [armed, setArmed] = useState<null | 'send' | 'delete'>(null)
  const arm = (which: 'send' | 'delete') => (on: boolean) =>
    setArmed(on ? which : null)
  const [pending, start] = useTransition()

  // The tape follows the form as it is typed: the same arithmetic the server runs.
  const live = useMemo(() => {
    const usable = lines
      .map((line) => ({
        qty: parseQty(line.qty || '0'),
        price: parseUnitPrice(line.unitPrice || '0', quote.currency),
      }))
      .filter((line) => 'ok' in line.qty && 'ok' in line.price)
      .map((line) => ({
        qty: (line.qty as { ok: string }).ok,
        unitPrice: (line.price as { ok: string }).ok,
      }))
    return quoteTotals({
      currency: quote.currency,
      vatPct: vat ? '7' : '0',
      whtPct: wht ? '3' : '0',
      lines: usable,
    }).totals
  }, [lines, vat, wht, quote.currency])

  const dirty =
    title !== quote.title ||
    clientId !== (quote.clientId ?? '') ||
    vat !== Number(quote.vatPct) > 0 ||
    wht !== Number(quote.whtPct) > 0 ||
    validDays !== String(quote.validDays) ||
    notes !== quote.notes ||
    newClient.trim() !== '' ||
    JSON.stringify(lines.map(({ key: _key, ...line }) => line)) !==
      JSON.stringify(
        quote.lines.map(({ amount: _amount, ...line }) => ({
          ...line,
          qty: trimQty(line.qty),
        })),
      )

  /** Writes the form as it stands: the saved draft, or null with the error shown. */
  const persist = async () => {
    setError(null)
    const filled = lines.filter(
      (line) => line.description.trim() || line.unitPrice.trim(),
    )
    const result = await updateDraftAction({
      quoteId: quote.id,
      expectedRevision: quote.revision,
      title,
      ...(newClient.trim()
        ? { client: { name: newClient.trim() } }
        : { clientId: clientId || null }),
      vat,
      wht,
      validDays: Number(validDays) || 30,
      notes,
      lines: filled.map(({ key: _key, ...line }) => ({
        ...line,
        qty: line.qty || '1',
        unitPrice: line.unitPrice || '0',
      })),
    })
    if (!result.ok) {
      setError(result.error)
      return null
    }
    return result.data
  }
  const save = () =>
    start(async () => {
      const next = await persist()
      if (next) onSaved(next, `Saved ${next.number}`)
    })

  /** Unsaved edits are saved first, so what freezes is what the form shows. */
  const send = async () => {
    setError(null)
    const current = dirty ? await persist() : quote
    if (!current) return
    const result = await sendQuoteAction({
      quoteId: current.id,
      expectedRevision: current.revision,
    })
    if (result.ok)
      onSaved(
        result.data,
        `Sent ${result.data.number} — the PDF is frozen in Assets. Download it and send it to the client.`,
      )
    else setError(result.error)
  }
  const remove = async () => {
    const result = await deleteDraftAction({
      quoteId: quote.id,
      expectedRevision: quote.revision,
    })
    if (result.ok) onDeleted()
    else toast(result.error)
  }

  usePageKeys((key) => {
    // A question in the action row answers its own keys while it has focus;
    // any key that reaches the page instead closes it.
    if (armed && key !== 'Shift') {
      setArmed(null)
      if (key === 'Escape') return true
    }
    // Mark sent freezes the quote, so the key asks first — as the button does.
    if (key === 's') {
      if (issuer) setArmed('send')
      else toast('Set who issues your quotes first.')
      return true
    }
    if (key === 'Backspace' || key === 'Delete') {
      setArmed('delete')
      return true
    }
    return false
  })

  const setLine = (index: number, patch: Partial<LineDraft>) =>
    setLines((list) =>
      list.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    )
  const missing = quote.missing.filter(
    (entry) => !(issuer && /issuer/i.test(entry)),
  )

  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={quote.project} />{' '}
            <span style={{ color: 'var(--ink-4)' }}>›</span> {quote.number}
          </>
        }
        meta={dirty ? 'draft · not saved' : 'draft'}
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <Tape totals={live} words />
          <Facts
            rows={[
              ['number', quote.number],
              ['currency', quote.currency],
              ['valid', `${validDays || 30} days once sent`],
            ]}
          />
        </div>
        <div className='dev-main'>
          <form
            className='fcard'
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                save()
              }
            }}
          >
            <label>
              Title
              <input
                type='text'
                value={title}
                maxLength={200}
                required
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              Client
              <select
                value={clientId}
                disabled={Boolean(newClient.trim())}
                onChange={(event) => setClientId(event.target.value)}
              >
                <option value=''>choose a client…</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Or a new client · name
              <input
                type='text'
                maxLength={160}
                value={newClient}
                placeholder='added to Clients when you save'
                lang={isThai(newClient) ? 'th' : undefined}
                onChange={(event) => setNewClient(event.target.value)}
              />
            </label>
            <span className='fld-label'>Lines</span>
            <div className='line-head' aria-hidden='true'>
              <span>description</span>
              <span className='r'>qty</span>
              <span>unit</span>
              <span className='r'>price</span>
              <span />
            </div>
            <div className='lines'>
              {lines.map((line, index) => (
                <div key={line.key} className='line'>
                  <textarea
                    rows={1}
                    aria-label={`Line ${index + 1} description`}
                    value={line.description}
                    lang={isThai(line.description) ? 'th' : undefined}
                    onChange={(event) =>
                      setLine(index, { description: event.target.value })
                    }
                  />
                  <input
                    className='num'
                    inputMode='decimal'
                    aria-label={`Line ${index + 1} quantity`}
                    value={line.qty}
                    onChange={(event) =>
                      setLine(index, { qty: event.target.value })
                    }
                  />
                  <input
                    aria-label={`Line ${index + 1} unit`}
                    value={line.unit}
                    maxLength={24}
                    onChange={(event) =>
                      setLine(index, { unit: event.target.value })
                    }
                  />
                  <input
                    className='num'
                    inputMode='decimal'
                    aria-label={`Line ${index + 1} unit price`}
                    value={line.unitPrice}
                    onChange={(event) =>
                      setLine(index, { unitPrice: event.target.value })
                    }
                  />
                  <button
                    type='button'
                    className='rm'
                    aria-label={`Remove line ${index + 1}`}
                    onClick={() =>
                      setLines((list) =>
                        list.length > 1
                          ? list.filter((_, i) => i !== index)
                          : [blankLine()],
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className='row'>
              <button
                type='button'
                className='btn btn-sm'
                onClick={() => setLines((list) => [...list, blankLine()])}
              >
                ＋ Line
              </button>
            </div>
            <div className='switches'>
              <div className='srow'>
                <button
                  type='button'
                  className='switch'
                  aria-pressed={vat}
                  aria-label='VAT 7%'
                  onClick={() => setVat((on) => !on)}
                />
                VAT 7%
                <span className='sub'>
                  {vat ? exact(live.vat, quote.currency) : 'off'}
                </span>
              </div>
              <div className='srow'>
                <button
                  type='button'
                  className='switch'
                  aria-pressed={wht}
                  aria-label='Withholding 3%'
                  onClick={() => setWht((on) => !on)}
                />
                <span lang='th'>หัก ณ ที่จ่าย 3%</span>
                <span className='sub'>
                  {wht ? `−${exact(live.wht, quote.currency)}` : 'off'}
                </span>
              </div>
            </div>
            <div className='row'>
              <label style={{ width: 120 }}>
                Valid · days
                <input
                  type='text'
                  inputMode='numeric'
                  value={validDays}
                  onChange={(event) =>
                    setValidDays(
                      event.target.value.replace(/\D/g, '').slice(0, 3),
                    )
                  }
                />
              </label>
            </div>
            <label>
              Notes
              <textarea
                rows={2}
                value={notes}
                maxLength={4000}
                lang={isThai(notes) ? 'th' : undefined}
                onChange={(event) => setNotes(event.target.value)}
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
                disabled={pending || !dirty}
              >
                {pending ? 'Saving…' : 'Save draft'}
                <kbd>⌘↵</kbd>
              </button>
            </div>
          </form>
          {!issuer ? (
            <p className='issuer-note'>
              To send it, set who issues your quotes.{' '}
              <button type='button' className='btn btn-sm' onClick={onIssuer}>
                Set issuer
              </button>
            </p>
          ) : missing.length ? (
            <p className='issuer-note'>To send it: {missing.join(' · ')}</p>
          ) : null}
          <div className='dev-acts'>
            <a
              className='btn'
              href={`/api/quotes/${quote.id}/pdf`}
              target='_blank'
              rel='noreferrer'
            >
              Preview PDF<kbd>p</kbd>
            </a>
            {issuer ? (
              <Confirm
                label='Mark sent'
                kbd='s'
                tone='release'
                small={false}
                again
                question={`${dirty ? 'Save and mark' : 'Mark'} ${quote.number} sent? Its lines, totals and PDF freeze.`}
                yes='Mark sent'
                no='Not now'
                disabled={pending}
                asking={armed === 'send'}
                onAsking={arm('send')}
                run={send}
              />
            ) : (
              <button type='button' className='btn btn-release' disabled>
                Mark sent<kbd>s</kbd>
              </button>
            )}
            <Confirm
              label='Delete'
              kbd='⌫'
              small={false}
              question={`Delete draft ${quote.number}?`}
              yes='Delete'
              disabled={pending}
              asking={armed === 'delete'}
              onAsking={arm('delete')}
              run={remove}
            />
          </div>
          <p className='dev-p'>
            Mark sent freezes the lines, totals and PDF. HQ never emails the
            client — download the PDF and send it yourself.
          </p>
          <div className='insp-links'>
            {quote.project && quote.cardIds[0] ? (
              <Link
                className='btn btn-sm'
                href={`/p/${quote.project.slug}/board?card=${quote.cardIds[0]}`}
              >
                ▦ Card
              </Link>
            ) : null}
            <button type='button' className='btn btn-sm' onClick={onIssuer}>
              Issuer
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function SentQuote({
  quote,
  onClose,
  onSaved,
}: {
  quote: QuoteDetailData
  onClose: () => void
  onSaved: (quote: QuoteDetailData, message?: string) => void
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  /** The client's answer is final, so each asks once; its key opens the same question. */
  const [armed, setArmed] = useState<null | 'accepted' | 'declined'>(null)
  const arm = (which: 'accepted' | 'declined') => (on: boolean) =>
    setArmed(on ? which : null)
  const decide = async (decision: 'accepted' | 'declined') => {
    const result = await decideQuoteAction({
      quoteId: quote.id,
      expectedRevision: quote.revision,
      decision,
    })
    if (result.ok) onSaved(result.data, `${result.data.number} ${decision}`)
    else toast(result.error)
  }
  const revise = () =>
    start(async () => {
      const result = await reviseQuoteAction({
        quoteId: quote.id,
        expectedRevision: quote.revision,
      })
      if (result.ok)
        onSaved(
          result.data,
          `${result.data.number} is a draft again — the PDF that went out stays in Assets`,
        )
      else toast(result.error)
    })

  usePageKeys((key) => {
    // A question in the action row answers its own keys while it has focus;
    // any key that reaches the page instead closes it.
    if (armed && key !== 'Shift') {
      setArmed(null)
      if (key === 'Escape') return true
    }
    if (
      quote.status !== 'sent' &&
      !(quote.status === 'expired' && key === 'r')
    ) {
      if (key === 'd' && quote.hasPdf) {
        window.location.assign(`/api/quotes/${quote.id}/pdf?download=1`)
        return true
      }
      return false
    }
    if (key === 'a') setArmed('accepted')
    else if (key === 'x') setArmed('declined')
    else if (key === 'r') revise()
    else if (key === 'd')
      window.location.assign(`/api/quotes/${quote.id}/pdf?download=1`)
    else return false
    return true
  })

  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={quote.project} />{' '}
            <span style={{ color: 'var(--ink-4)' }}>›</span> {quote.number}
          </>
        }
        meta={quote.status}
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <Tape totals={quote.totals} words />
          <Facts
            rows={[
              ['client', quote.client?.name ?? '—'],
              ['issued', dayLabel(quote.issuedOn)],
              ['valid until', dayLabel(quote.validUntil)],
              ['status', quote.status],
              ['pdf', quote.hasPdf ? `${quote.number}.pdf · frozen` : '—'],
            ]}
          />
        </div>
        <div className='dev-main'>
          <h2
            className='dev-title'
            lang={isThai(quote.title) ? 'th' : undefined}
          >
            {quote.title}
          </h2>
          <div className='readlines'>
            {quote.lines.map((line, index) => (
              <div key={`${index}-${line.description}`} className='rl'>
                <span lang={isThai(line.description) ? 'th' : undefined}>
                  {line.description}
                  <br />
                  <span className='q'>
                    {trimQty(line.qty)} {line.unit} ×{' '}
                    {exact(line.unitPrice, quote.currency)}
                  </span>
                </span>
                <b>{exact(line.amount, quote.currency)}</b>
              </div>
            ))}
          </div>
          {quote.notes ? (
            <p className='dev-p' lang={isThai(quote.notes) ? 'th' : undefined}>
              {quote.notes}
            </p>
          ) : null}
          <div className='dev-acts'>
            {quote.hasPdf ? (
              <a
                className='btn btn-pri'
                href={`/api/quotes/${quote.id}/pdf?download=1`}
              >
                Download PDF<kbd>d</kbd>
              </a>
            ) : null}
            {quote.status === 'sent' ? (
              <>
                <Confirm
                  label='Accepted'
                  kbd='a'
                  small={false}
                  again
                  question={`Record ${quote.number} as accepted? It can’t change after.`}
                  yes='Accepted'
                  no='Not now'
                  disabled={pending}
                  asking={armed === 'accepted'}
                  onAsking={arm('accepted')}
                  run={() => decide('accepted')}
                />
                <Confirm
                  label='Declined'
                  kbd='x'
                  small={false}
                  again
                  question={`Record ${quote.number} as declined? It can’t change after.`}
                  yes='Declined'
                  no='Not now'
                  disabled={pending}
                  asking={armed === 'declined'}
                  onAsking={arm('declined')}
                  run={() => decide('declined')}
                />
              </>
            ) : null}
            {quote.status === 'sent' || quote.status === 'expired' ? (
              <button
                type='button'
                className='btn'
                disabled={pending}
                onClick={revise}
              >
                Revise<kbd>r</kbd>
              </button>
            ) : null}
          </div>
          <div className='insp-links'>
            {quote.project && quote.cardIds[0] ? (
              <Link
                className='btn btn-sm'
                href={`/p/${quote.project.slug}/board?card=${quote.cardIds[0]}`}
              >
                ▦ Card
              </Link>
            ) : null}
            {quote.project ? (
              <Link
                className='btn btn-sm'
                href={`/p/${quote.project.slug}/assets`}
              >
                ▣ PDF in Assets
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}

function NewQuote({
  projects,
  clients,
  fromCard,
  clientId: forClient,
  onCancel,
  onCreated,
}: {
  projects: QuoteProject[]
  clients: ClientData[]
  fromCard: QuotesPageProps['fromCard']
  /** A client chosen before the form opened (Clients' ＋ Quote). */
  clientId: string | null
  onCancel: () => void
  onCreated: (quote: QuoteDetailData) => void
}) {
  const [projectId, setProjectId] = useState(
    fromCard?.projectId ?? projects[0]?.id ?? '',
  )
  const [title, setTitle] = useState(fromCard?.title ?? '')
  // The card's client record, else a client with the name the card carries once.
  const known = fromCard
    ? clients.find(
        (client) =>
          client.id === fromCard.clientId ||
          (Boolean(fromCard.client) &&
            client.name.toLowerCase() === fromCard.client?.toLowerCase()),
      )
    : clients.find((client) => client.id === forClient)
  const [clientId, setClientId] = useState(known?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  return (
    <>
      <InspectorHead
        title='New quote'
        meta='not saved yet'
        onClose={onCancel}
      />
      <div className='insp-body'>
        <form
          className='fcard'
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
              const result = await createDraftAction({
                projectId: projectId || null,
                title: title || undefined,
                clientId: clientId || null,
                fromCard: fromCard
                  ? {
                      id: fromCard.id,
                      title: fromCard.title,
                      price: fromCard.price,
                    }
                  : undefined,
              })
              if (result.ok) onCreated(result.data)
              else setError(result.error)
            })
          }}
        >
          <span className='hud-label'>
            {fromCard ? 'Quote a card' : 'New quote'}
          </span>
          {fromCard ? (
            <p className='hint'>
              From the card “{fromCard.title}”
              {fromCard.price
                ? ` — one line at its price, ${fromCard.price}`
                : ''}
              . The card and the quote stay linked.
            </p>
          ) : null}
          <label>
            Title
            <input
              ref={first}
              type='text'
              maxLength={200}
              required={!fromCard}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {projects.length > 1 ? (
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
              </select>
            </label>
          ) : null}
          <label>
            Client
            <select
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            >
              <option value=''>later</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          {fromCard?.client && !known ? (
            <p className='hint'>
              The card names “{fromCard.client}”, who isn’t a client yet — add
              them under Clients.
            </p>
          ) : null}
          {error ? (
            <p className='err' role='alert'>
              {error}
            </p>
          ) : null}
          <div className='row'>
            <button
              type='submit'
              className='btn btn-pri'
              disabled={pending || (!title.trim() && !fromCard)}
            >
              {pending ? 'Making…' : 'Make draft'}
              <kbd>↵</kbd>
            </button>
            <button type='button' className='btn' onClick={onCancel}>
              Cancel<kbd>Esc</kbd>
            </button>
          </div>
          <p className='hint'>
            It takes the next number and your project’s currency; nothing leaves
            HQ until you mark it sent.
          </p>
        </form>
      </div>
    </>
  )
}

function IssuerForm({
  issuer,
  onClose,
  onSaved,
}: {
  issuer: QuoteIssuer | null
  onClose: () => void
  onSaved: (issuer: QuoteIssuer | null) => void
}) {
  const [fields, setFields] = useState<QuoteIssuer>(issuer ?? { name: '' })
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const field = (
    key: keyof QuoteIssuer,
    label: string,
    max: number,
    multiline = false,
  ) => (
    <label>
      {label}
      {multiline ? (
        <textarea
          rows={2}
          maxLength={max}
          value={fields[key] ?? ''}
          onChange={(event) =>
            setFields((current) => ({ ...current, [key]: event.target.value }))
          }
        />
      ) : (
        <input
          type='text'
          maxLength={max}
          value={fields[key] ?? ''}
          onChange={(event) =>
            setFields((current) => ({ ...current, [key]: event.target.value }))
          }
        />
      )}
    </label>
  )
  return (
    <>
      <InspectorHead
        title='Issuer'
        meta='prints on every quote'
        onClose={onClose}
      />
      <div className='insp-body'>
        <form
          className='fcard'
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              onClose()
            }
          }}
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            start(async () => {
              const result = await saveIssuerAction(fields)
              if (result.ok) onSaved(result.data)
              else setError(result.error)
            })
          }}
        >
          {field('name', 'Name · you or your company', 160)}
          {field('taxId', 'Tax ID · เลขประจำตัวผู้เสียภาษี', 40)}
          {field('address', 'Address', 600, true)}
          <div className='row'>
            <div style={{ flex: 1 }}>{field('email', 'Email', 200)}</div>
            <div style={{ flex: 1 }}>{field('phone', 'Phone', 60)}</div>
          </div>
          {field('bank', 'Payment · bank, account name, number', 300)}
          {error ? (
            <p className='err' role='alert'>
              {error}
            </p>
          ) : null}
          <div className='row'>
            <button
              type='submit'
              className='btn btn-pri'
              disabled={pending || !fields.name.trim()}
            >
              {pending ? 'Saving…' : 'Save issuer'}
              <kbd>↵</kbd>
            </button>
            <button type='button' className='btn' onClick={onClose}>
              Cancel<kbd>Esc</kbd>
            </button>
          </div>
          <p className='hint'>
            A quote already sent keeps the issuer it was sent with — its PDF is
            frozen.
          </p>
        </form>
      </div>
    </>
  )
}
