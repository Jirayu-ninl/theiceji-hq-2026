'use client'

import { formatMoney, sumAmounts } from '@theiceji/hq-core/money'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  type FormEvent,
  type ReactNode,
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
  useNarrow,
  usePageKeys,
} from '@/components/bridge/parts'
import { Confirm } from '@/components/Confirm'
import { usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import type { ActionResult } from '@/lib/actions'
import { Markdown } from '@/lib/md'
import type { ConnectionOption, FileOption } from '@/lib/module-page'
import {
  approveListingAction,
  archiveMarketplaceAction,
  confirmPayoutAction,
  deleteListingAction,
  dispatchListingAction,
  inactiveListingAction,
  listingAction,
  planListingAction,
  recordListedAction,
  recordPayoutAction,
  recordSaleAction,
  saveMarketplaceAction,
  saveProductAction,
  syncMarketplaceAction,
  unapproveListingAction,
  updateListingAction,
} from '../actions'
import type {
  ListingDetailData,
  ListingRowData,
  MarketProject,
  MarketplaceData,
  PayoutData,
  ProductData,
  SaleData,
} from '../data'

/**
 * Market: digital
 * assets for sale. Listings = Table + Inspector — a product on one
 * marketplace: planned → approved → dispatched → listed → verified ·
 * inactive · failed. Products = Pool + Inspector — files from Assets
 * (deliverable · preview), tags ≤ 13, List on… Money = the append-only lines
 * beside Payouts (expected until the owner confirms the bank showed it).
 *
 * The instrument is the net tape: price · each fee from the owner's fee
 * sheet · what reaches you (an estimate), with the recorded 7-day truth
 * under a rule. Approve is the one red button. Money is never converted.
 */

export type MarketPageProps = {
  project: MarketProject
  marketplaces: MarketplaceData[]
  products: ProductData[]
  listings: ListingRowData[]
  sales: SaleData[]
  payouts: PayoutData[]
  detail: ListingDetailData | null
  files: FileOption[]
  connections: ConnectionOption[]
  previews: Record<string, string>
  readAt: string
  view: 'listings' | 'products' | 'money'
  selectedListingId: string | null
  selectedProductId: string | null
}

type Kind = MarketplaceData['kind']
const KIND_LABEL: Record<Kind, string> = {
  etsy: 'Etsy',
  pod: 'Print on demand',
  gumroad: 'Gumroad',
  manual: 'Other shop',
}
const RULES: Record<
  Kind,
  { titleMax: number; tagMax: number; tagLength: number }
> = {
  etsy: { titleMax: 140, tagMax: 13, tagLength: 20 },
  pod: { titleMax: 200, tagMax: 13, tagLength: 40 },
  gumroad: { titleMax: 200, tagMax: 13, tagLength: 40 },
  manual: { titleMax: 200, tagMax: 13, tagLength: 40 },
}
const EVIDENCE: Record<string, string> = {
  owner_attested: 'you attested',
  screenshot: 'screenshot',
  platform_export: 'export from the shop',
  agent_attested: 'an agent attested',
  provider_verified: 'read back by the shop',
}
const STATUSES = [
  'all',
  'planned',
  'approved',
  'live',
  'inactive',
  'failed',
] as const
const LIVE = ['dispatched', 'listed', 'verified']
const HOLDS = (listing: ListingRowData) =>
  !['inactive', 'failed'].includes(listing.status)
const ORDER: Record<string, number> = {
  approved: 0,
  planned: 1,
  failed: 2,
  dispatched: 3,
  listed: 4,
  verified: 4,
  inactive: 6,
}
const SALE_KINDS = ['sale', 'refund', 'fee', 'adjustment'] as const

const money = (amount: string | number, currency: string) =>
  formatMoney(typeof amount === 'number' ? amount.toFixed(2) : amount, currency)
const shopName = (shop: MarketplaceData) =>
  shop.kind === 'manual' ? shop.shop : `${KIND_LABEL[shop.kind]} · ${shop.shop}`
const hoursBetween = (from: string, to: string) =>
  (Date.parse(to) - Date.parse(from)) / 3_600_000
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`
const localInput = (iso: string) => {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromLocal = (value: string) =>
  value ? new Date(value).toISOString() : undefined
const cleanAmount = (value: string) => value.replace(/[,\s]/g, '')
const tagsOf = (value: string) =>
  value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)

/** One sale at this price, estimated from the owner's fee sheet (never money until a line says so). */
function estimate(
  price: number,
  sheet: MarketplaceData['feeSheet'],
  currency: string,
) {
  const rows: { label: string; amount: number }[] = []
  const listing = Number(sheet.listingFee ?? 0)
  const transaction = Number(sheet.transactionPct ?? 0)
  const processingPct = Number(sheet.processingPct ?? 0)
  const processingFixed = Number(sheet.processingFixed ?? 0)
  const r2 = (n: number) => Math.round(n * 100) / 100
  if (listing) rows.push({ label: 'listing', amount: listing })
  if (transaction)
    rows.push({
      label: `transaction ${transaction}%`,
      amount: r2((price * transaction) / 100),
    })
  if (processingPct || processingFixed)
    rows.push({
      label: `processing ${[processingPct ? `${processingPct}%` : '', processingFixed ? money(processingFixed, currency) : ''].filter(Boolean).join(' + ')}`,
      amount: r2((price * processingPct) / 100 + processingFixed),
    })
  const kept = r2(rows.reduce((sum, row) => sum + row.amount, 0))
  return { rows, net: r2(price - kept) }
}

function useDates(timezone: string) {
  return useMemo(() => {
    const dayTime = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    })
    const day = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: timezone,
    })
    return {
      dayTime: (iso: string | null) =>
        iso ? dayTime.format(new Date(iso)) : '—',
      day: (iso: string | null) =>
        iso
          ? day.format(new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso))
          : '—',
    }
  }, [timezone])
}

function StatusWord({
  listing,
  readAt,
}: {
  listing: ListingRowData
  readAt: string
}) {
  switch (listing.status) {
    case 'planned':
      return <span className='state-word'>planned</span>
    case 'approved': {
      const left = listing.clearance
        ? Math.floor(hoursBetween(readAt, listing.clearance.expiresAt))
        : 0
      return (
        <span className='state-word due'>
          approved ·{' '}
          {left > 0 ? `expires in ${left}h` : 'expired — approve it again'}
        </span>
      )
    }
    case 'dispatched':
      return (
        <span className='state-word live'>
          <i className='glyph live' aria-hidden='true'>
            ▶
          </i>{' '}
          sent · reading back
        </span>
      )
    case 'verified':
      return (
        <span className='state-word' title='read back as active'>
          verified
        </span>
      )
    case 'inactive':
      return <span className='state-word off'>inactive</span>
    case 'failed':
      return (
        <span className='state-word due' title={listing.statusReason ?? ''}>
          <i className='glyph due' aria-hidden='true'>
            ◆
          </i>{' '}
          failed
        </span>
      )
    default:
      return <span className='state-word'>{listing.status}</span>
  }
}

function ShopChips({
  shops,
  onPick,
}: {
  shops: MarketplaceData[]
  onPick: (id: string | 'new') => void
}) {
  const live = shops.filter((shop) => !shop.archived)
  return (
    <div className='shops'>
      {live.map((shop) =>
        shop.readiness.mode === 'reconnect' ? (
          <Link
            key={shop.id}
            className='mkt-shop problem'
            href='/settings/connections'
            title={`${shop.readiness.note} Reconnect at Settings › Connections`}
          >
            <i />◆ {KIND_LABEL[shop.kind]} · reconnect
          </Link>
        ) : (
          <button
            key={shop.id}
            type='button'
            className={`mkt-shop${shop.readiness.mode === 'api' ? '' : ' hand'}`}
            title={`${shop.url ?? shop.shop} · ${shop.currency} · ${shop.readiness.note}`}
            onClick={() => onPick(shop.id)}
          >
            <i />
            {shopName(shop)} ·{' '}
            {shop.readiness.mode === 'api'
              ? shop.syncProblem
                ? '◆ sync problem'
                : `synced ${shop.syncedAt ? new Date(shop.syncedAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'}`
              : 'by hand'}
          </button>
        ),
      )}
      <button
        type='button'
        className='mkt-shop hand'
        onClick={() => onPick('new')}
      >
        ＋ shop
      </button>
    </div>
  )
}

/** A question open in the listing's action row: its key and its button ask the same thing. */
type Armed = null | 'approve' | 'send' | 'delete'

export function MarketPage(props: MarketPageProps) {
  const router = useRouter()
  const toast = useToast()
  const narrow = useNarrow()
  const { dayTime, day } = useDates(props.project.timezone)
  const [listings, setListings] = useState(props.listings)
  const [selected, setSelected] = useState<string | null>(
    props.selectedListingId,
  )
  const [detail, setDetail] = useState<ListingDetailData | null>(props.detail)
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all')
  const [shopFilter, setShopFilter] = useState('all')
  const [form, setForm] = useState<
    null | 'listed' | 'sale' | 'edit' | 'list' | 'inactive' | 'shop'
  >(null)
  const [shop, setShop] = useState<string | 'new' | null>(null)
  const [armed, setArmed] = useState<Armed>(null)
  const project = props.project
  const shopOf = (id: string) =>
    props.marketplaces.find((entry) => entry.id === id) ?? null

  useEffect(() => setListings(props.listings), [props.listings])

  const salesNow = props.sales.filter((line) => !line.supersededBy)
  const since = (days: number) =>
    new Date(Date.parse(props.readAt) - days * 86_400_000).toISOString()
  /** Per currency — never summed across currencies. */
  const totals = (days: number) => {
    const from = since(days)
    const out = new Map<
      string,
      { net: string[]; sold: number; orders: number }
    >()
    for (const line of salesNow) {
      if (line.occurredAt < from) continue
      const entry = out.get(line.currency) ?? { net: [], sold: 0, orders: 0 }
      entry.net.push(line.net)
      if (line.kind === 'sale') {
        entry.sold += line.quantity
        entry.orders += 1
      }
      out.set(line.currency, entry)
    }
    return [...out.entries()].map(([currency, entry]) => ({
      currency,
      net: sumAmounts(entry.net, currency),
      sold: entry.sold,
      orders: entry.orders,
    }))
  }
  const recorded = (listing: ListingRowData) => {
    const from = since(7)
    const lines = salesNow.filter(
      (line) => line.listingId === listing.id && line.occurredAt >= from,
    )
    return {
      units: lines
        .filter((line) => line.kind === 'sale')
        .reduce((n, line) => n + line.quantity, 0),
      refunded: lines
        .filter((line) => line.kind === 'refund')
        .reduce((n, line) => n + line.quantity, 0),
      net: sumAmounts(
        lines.map((line) => line.net),
        listing.currency,
      ),
    }
  }

  const visible = listings
    .filter(
      (listing) =>
        (status === 'all' ||
          (status === 'live'
            ? LIVE.includes(listing.status)
            : listing.status === status)) &&
        (shopFilter === 'all' || listing.marketplaceId === shopFilter),
    )
    .sort(
      (a, b) =>
        (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) ||
        a.title.localeCompare(b.title) ||
        a.marketplace.localeCompare(b.marketplace),
    )

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch on a new selection only
  useEffect(() => {
    if (!selected || detail?.id === selected) return
    let alive = true
    listingAction(selected).then((result) => {
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
    setForm(null)
    setShop(null)
    setArmed(null)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('listing', id)
    else url.searchParams.delete('listing')
    window.history.replaceState(null, '', url)
  }
  const saved = (next: ListingDetailData, message?: string) => {
    setArmed(null)
    setDetail(next)
    setSelected(next.id)
    setListings((list) => {
      const row: ListingRowData = { ...next }
      return list.some((entry) => entry.id === next.id)
        ? list.map((entry) => (entry.id === next.id ? row : entry))
        : [row, ...list]
    })
    setForm(null)
    if (message) toast(message)
  }
  const answer = (
    result: ActionResult<ListingDetailData>,
    message?: string,
  ) => {
    if (!result.ok) {
      toast(result.error)
      return false
    }
    saved(result.data, message)
    return true
  }

  const current = detail && detail.id === selected ? detail : null
  const currentShop = current ? shopOf(current.marketplaceId) : null

  const approve = async () => {
    if (!current) return
    const result = await approveListingAction({
      listingId: current.id,
      expectedRevision: current.revision,
    })
    if (!result.ok) {
      toast(result.error)
      return
    }
    saved(
      result.data.detail,
      result.data.blockers.length
        ? `Can’t approve yet — ${result.data.blockers[0]?.message}`
        : 'Approved — exactly this listing may leave HQ for 24 hours',
    )
  }
  const takeBack = async () => {
    if (!current) return
    answer(
      await unapproveListingAction({
        listingId: current.id,
        expectedRevision: current.revision,
      }),
      'Approval taken back — planned again',
    )
  }
  const send = async () => {
    if (!current || !currentShop) return
    if (currentShop.readiness.mode !== 'api') {
      toast(currentShop.readiness.note)
      return
    }
    const result = await dispatchListingAction({ listingId: current.id })
    if (!result.ok) {
      toast(result.error)
      return
    }
    saved(result.data.detail, result.data.message)
  }

  const viewKeys: Record<MarketPageProps['view'], [string, string][]> = {
    listings: [
      ['l', 'list a product'],
      ['a', 'approve'],
      ['r', 'record listed'],
      ['s', 'record sale'],
      ['e', 'edit'],
      ['u', 'take back'],
      ['p', 'send'],
      ['⌫', 'delete'],
      ['↑ ↓', 'listings'],
      ['1 2 3', 'listings · products · money'],
    ],
    products: [
      ['c', 'new product'],
      ['l', 'list on…'],
      ['← → ↑ ↓', 'products'],
      ['1 2 3', 'listings · products · money'],
    ],
    money: [
      ['s', 'record a line'],
      ['1 2 3', 'listings · products · money'],
    ],
  }
  usePageKeyHints(viewKeys[props.view])
  usePageKeys((key) => {
    if (props.view !== 'listings') return false
    // A question in the action row answers its own keys while it has focus;
    // any key that reaches the page instead closes it.
    if (armed && key !== 'Shift') {
      setArmed(null)
      if (key === 'Escape') return true
    }
    if (key === 'Escape') {
      if (form || shop) {
        setForm(null)
        setShop(null)
        return true
      }
      if (selected) {
        select(null)
        return true
      }
      return false
    }
    if (key === 'l') {
      if (current?.status === 'inactive') setForm('list')
      else {
        setSelected(null)
        setForm('list')
      }
      return true
    }
    const index = visible.findIndex((listing) => listing.id === selected)
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
    // A question opens only where its button is: not behind a form.
    const asks = !form
    // Approving lets the listing out, so the key asks first — as the button does.
    if (key === 'a' && current.status === 'planned' && asks) {
      if (current.blockers.length)
        toast(current.blockers[0]?.message ?? 'Blocked')
      else setArmed('approve')
      return true
    }
    if (
      (key === 'Backspace' || key === 'Delete') &&
      current.status === 'planned' &&
      asks
    ) {
      setArmed('delete')
      return true
    }
    if (key === 'e' && ['planned', 'failed'].includes(current.status)) {
      setForm('edit')
      return true
    }
    if (current.status === 'approved') {
      if (key === 'r') {
        setForm('listed')
        return true
      }
      if (key === 'p' && asks) {
        if (currentShop?.readiness.mode === 'api') setArmed('send')
        else
          toast(currentShop?.readiness.note ?? 'This listing’s shop is gone.')
        return true
      }
      if (key === 'u') {
        void takeBack()
        return true
      }
    }
    if (key === 's' && ['listed', 'verified'].includes(current.status)) {
      setForm('sale')
      return true
    }
    return false
  })

  const pickShop = (id: string | 'new') => {
    setShop(id)
    setForm('shop')
  }
  const closeShop = () => {
    setShop(null)
    setForm(null)
  }

  if (props.view === 'products')
    return (
      <Products
        {...props}
        listings={listings}
        pickShop={pickShop}
        closeShop={closeShop}
        shopForm={
          shop ? (
            <ShopForm
              key={shop}
              project={project}
              shop={shop === 'new' ? null : shopOf(shop)}
              connections={props.connections}
              onClose={() => setShop(null)}
              onSaved={() => {
                setShop(null)
              }}
            />
          ) : null
        }
        onListed={(next) => {
          saved(next, 'Planned — nothing leaves HQ until you approve it')
          router.push(`/p/${project.slug}/market?listing=${next.id}`)
        }}
      />
    )
  if (props.view === 'money')
    return (
      <Money
        {...props}
        narrow={narrow}
        salesNow={salesNow}
        totals={totals}
        dayTime={dayTime}
        day={day}
        pickShop={pickShop}
      />
    )

  const week = totals(7)
  const live = listings.filter((listing) =>
    LIVE.includes(listing.status),
  ).length
  const approved = listings.filter(
    (listing) => listing.status === 'approved',
  ).length
  const problem = props.marketplaces.find(
    (entry) => !entry.archived && entry.readiness.mode === 'reconnect',
  )

  return (
    <div className='page marketp'>
      <section className='pane list-pane' aria-label='Listings'>
        <PaneHead
          title='Market · listings'
          meta={`${plural(listings.length, 'listing')} · ${live} live · ${approved} approved${project.status === 'paused' ? ' · paused' : ''}`}
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
            aria-label='Marketplace'
            value={shopFilter}
            onChange={(event) => setShopFilter(event.target.value)}
          >
            <option value='all'>all shops</option>
            {props.marketplaces.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {shopName(entry)}
              </option>
            ))}
          </select>
          <span className='sp' />
          <span className='hits'>
            {visible.length} of {listings.length}
          </span>
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => {
              setSelected(null)
              setForm('list')
            }}
          >
            ＋ List a product<kbd>l</kbd>
          </button>
        </div>
        <div className='mkt-scope'>
          {week.length ? (
            week.map((entry) => (
              <Readout
                key={entry.currency}
                big={`${entry.sold} sold · ${money(entry.net, entry.currency)} net`}
                sub={`7d · ${entry.currency} · recorded lines, not estimates`}
              />
            ))
          ) : (
            <Readout
              big={`0 sold · ${money('0', project.currency)} net`}
              sub='7d · recorded lines, not estimates'
            />
          )}
          <span className='sp' />
          <ShopChips shops={props.marketplaces} onPick={pickShop} />
        </div>
        {problem ? (
          <p className='why mkt-banner'>
            <b>{KIND_LABEL[problem.kind]} sync is paused:</b>{' '}
            {problem.readiness.note} Listings stay as they were and orders catch
            up after you{' '}
            <Link href='/settings/connections'>
              reconnect at Settings › Connections
            </Link>
            .
          </p>
        ) : null}
        <div
          className={`pane-body${project.status === 'paused' ? ' paused' : ''}`}
        >
          {listings.length === 0 ? (
            <Empty>
              ○ no listings yet —{' '}
              {props.marketplaces.length
                ? 'press l to list a product.'
                : 'add a shop (＋ shop above), make a product, then list it.'}
            </Empty>
          ) : visible.length === 0 ? (
            <Empty>No listings match this filter.</Empty>
          ) : (
            <div className='tbl lst-tbl' role='listbox'>
              <div className='tbl-head' aria-hidden='true'>
                <span className='hud-label'>product</span>
                <span className='hud-label c-shop'>marketplace</span>
                <span className='hud-label num'>price</span>
                <span className='hud-label c-st'>status</span>
                <span className='hud-label c-at'>listed</span>
                <span className='hud-label num c-7d'>7d sales</span>
              </div>
              {visible.map((listing) => {
                const r = recorded(listing)
                const on = listing.id === selected
                return (
                  <button
                    key={listing.id}
                    type='button'
                    role='option'
                    aria-selected={on}
                    className={`tbl-row${on ? ' sel' : ''}`}
                    onClick={() => select(listing.id)}
                  >
                    <span className='prod'>
                      <span lang={isThai(listing.title) ? 'th' : undefined}>
                        {listing.title}
                      </span>
                      <span className='mk-sm'>{KIND_LABEL[listing.kind]}</span>
                    </span>
                    <span className='c-shop'>{listing.marketplace}</span>
                    <span className='num'>
                      {money(listing.price, listing.currency)}
                    </span>
                    <span className='c-st'>
                      <StatusWord listing={listing} readAt={props.readAt} />
                    </span>
                    <span className='c-at mono'>
                      {listing.listedAt ? day(listing.listedAt) : '—'}
                    </span>
                    <span className='num c-7d'>
                      {listing.listedAt
                        ? `${r.units} · ${money(r.net, listing.currency)}`
                        : '—'}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </section>
      <Inspector
        id='market'
        label='Selected listing'
        empty={!current && !form && !shop}
        onClose={() => select(null)}
      >
        {shop ? (
          <ShopForm
            key={shop}
            project={project}
            shop={shop === 'new' ? null : shopOf(shop)}
            connections={props.connections}
            onClose={closeShop}
            onSaved={closeShop}
          />
        ) : form === 'list' && current?.status !== 'inactive' ? (
          <ListForm
            project={project}
            products={props.products}
            marketplaces={props.marketplaces}
            listings={listings}
            productId={null}
            onClose={() => setForm(null)}
            onPlanned={(next) =>
              saved(next, 'Planned — nothing leaves HQ until you approve it')
            }
          />
        ) : !current ? (
          <>
            <InspectorHead
              title='Listing'
              meta={selected ? '…' : 'nothing selected'}
            />
            <div className='insp-body'>
              <Empty>
                {selected
                  ? '…'
                  : listings.length
                    ? 'Select a listing, or press l to list a product.'
                    : '○ no listings yet — press l to list a product.'}
              </Empty>
            </div>
          </>
        ) : (
          <ListingInspector
            project={project}
            listing={current}
            shop={currentShop}
            product={
              props.products.find((entry) => entry.id === current.productId) ??
              null
            }
            products={props.products}
            marketplaces={props.marketplaces}
            listings={listings}
            recorded={recorded(current)}
            readAt={props.readAt}
            dayTime={dayTime}
            form={form}
            setForm={setForm}
            onClose={() => select(null)}
            onApprove={approve}
            onTakeBack={takeBack}
            onSend={send}
            armed={armed}
            onArm={setArmed}
            onDeleted={() => {
              setListings((list) =>
                list.filter((entry) => entry.id !== current.id),
              )
              select(null)
              toast('Deleted the planned listing')
            }}
            answer={answer}
            saved={saved}
          />
        )}
      </Inspector>
    </div>
  )
}

/* ── Listing inspector ─────────────────────────────────────────────── */

function NetTape({
  listing,
  shop,
  recorded,
}: {
  listing: ListingRowData
  shop: MarketplaceData | null
  recorded: { units: number; refunded: number; net: string }
}) {
  const price = Number(listing.price) || 0
  const e = estimate(price, shop?.feeSheet ?? {}, listing.currency)
  return (
    // biome-ignore lint/a11y/useSemanticElements: the tape is a labelled group of figures, not a form fieldset
    <div
      className='nettape'
      role='group'
      aria-label='Net tape — one sale at this price, estimated from your fee sheet'
    >
      <div className='hd'>
        <span>
          net tape · {shop ? KIND_LABEL[shop.kind] : 'shop'} ·{' '}
          {listing.currency}
        </span>
        <span>one sale</span>
      </div>
      <div className='ln'>
        <span>price</span>
        <b>{money(price, listing.currency)}</b>
      </div>
      {e.rows.length ? (
        e.rows.map((row) => (
          <div key={row.label} className='ln fee'>
            <span>{row.label}</span>
            <b>{money(-row.amount, listing.currency)}</b>
          </div>
        ))
      ) : (
        <div className='ln off'>
          <span>fees</span>
          <b>none on your sheet</b>
        </div>
      )}
      <div className='rule' />
      <div className='due'>
        <span className='hud-label'>what reaches you</span>
        <b className='est' title='an estimate, not money'>
          {money(e.net, listing.currency)}
        </b>
      </div>
      <div className='note'>estimate from your fee sheet</div>
      <div className='rec'>
        <span className='hud-label'>recorded · 7d</span>
        {!listing.listedAt && !recorded.units ? (
          <b className='dim'>not listed yet · nothing recorded</b>
        ) : (
          <b>
            {recorded.units} sold
            {recorded.refunded ? ` · ${recorded.refunded} refunded` : ''} ·{' '}
            {money(recorded.net, listing.currency)} net
          </b>
        )}
      </div>
    </div>
  )
}

function TagChips({ tags, kind }: { tags: string[]; kind: Kind | null }) {
  const rule = kind ? RULES[kind] : null
  if (!tags.length) return <span className='muted'>no tags</span>
  return (
    <>
      {tags.map((tag) => {
        const over = rule ? tag.length > rule.tagLength : false
        return (
          <span
            key={tag}
            className={`label-chip${over ? ' over' : ''}`}
            lang={isThai(tag) ? 'th' : undefined}
            title={`${tag.length} characters${over && kind ? ` — ${KIND_LABEL[kind]} takes ${rule?.tagLength}` : ''}`}
          >
            {over ? '◆ ' : ''}
            {tag}
          </span>
        )
      })}
    </>
  )
}

function ListingInspector({
  project,
  listing,
  shop,
  product,
  products,
  marketplaces,
  listings,
  recorded,
  readAt,
  dayTime,
  form,
  setForm,
  onClose,
  onApprove,
  onTakeBack,
  onSend,
  armed,
  onArm,
  onDeleted,
  answer,
  saved,
}: {
  project: MarketProject
  listing: ListingDetailData
  shop: MarketplaceData | null
  product: ProductData | null
  products: ProductData[]
  marketplaces: MarketplaceData[]
  listings: ListingRowData[]
  recorded: { units: number; refunded: number; net: string }
  readAt: string
  dayTime: (iso: string | null) => string
  form: null | 'listed' | 'sale' | 'edit' | 'list' | 'inactive' | 'shop'
  setForm: (
    form: null | 'listed' | 'sale' | 'edit' | 'list' | 'inactive' | 'shop',
  ) => void
  onClose: () => void
  onApprove: () => Promise<void>
  onTakeBack: () => Promise<void>
  onSend: () => Promise<void>
  /** The question open in the action row — the page's keys open the same ones. */
  armed: Armed
  onArm: (armed: Armed) => void
  onDeleted: () => void
  answer: (result: ActionResult<ListingDetailData>, message?: string) => boolean
  saved: (next: ListingDetailData, message?: string) => void
}) {
  const toast = useToast()
  const router = useRouter()
  const [pending, start] = useTransition()
  const arm = (which: Exclude<Armed, null>) => (on: boolean) =>
    onArm(on ? which : null)
  const remove = async () => {
    const result = await deleteListingAction({
      listingId: listing.id,
      expectedRevision: listing.revision,
    })
    if (!result.ok) toast(result.error)
    else onDeleted()
  }
  const blockers = ['planned', 'approved', 'failed'].includes(listing.status)
    ? listing.blockers.map((b) => b.message)
    : []
  const deliverable = listing.files.filter(
    (file) => file.role === 'deliverable',
  ).length
  const rule = RULES[listing.kind]
  const api = shop?.readiness.mode === 'api'
  const where = listing.url
    ? listing.url
    : listing.externalId
      ? `#${listing.externalId}`
      : '—'
  const facts: [string, ReactNode][] = [
    [
      'marketplace',
      shop ? `${shopName(shop)} · ${shop.currency}` : listing.marketplace,
    ],
    ['status', <StatusWord key='s' listing={listing} readAt={readAt} />],
    ['listed at', listing.listedAt ? dayTime(listing.listedAt) : '—'],
    ['URL / ID', where],
    [
      'evidence',
      listing.evidenceLevel
        ? (EVIDENCE[listing.evidenceLevel] ?? listing.evidenceLevel)
        : '—',
    ],
    [
      'approval',
      listing.clearance
        ? `expires ${dayTime(listing.clearance.expiresAt)}`
        : listing.status === 'planned' || listing.status === 'failed'
          ? 'not approved'
          : '—',
    ],
  ]
  const note =
    listing.status === 'planned'
      ? blockers.length
        ? 'Approve lets exactly this listing leave HQ, once nothing above blocks it.'
        : 'Approve lets exactly this listing leave HQ; the approval lasts 24 hours.'
      : listing.status === 'approved'
        ? shop?.readiness.mode === 'reconnect'
          ? `${KIND_LABEL[listing.kind]} is disconnected — reconnect at Settings › Connections to send, or put it up by hand and record it.`
          : api
            ? `Send hands it to ${KIND_LABEL[listing.kind]}; it counts as verified once the shop reads it back.`
            : `${shop ? shopName(shop) : 'This shop'} is by hand — put it up yourself, then record it here.`
        : listing.status === 'dispatched'
          ? 'Sent — the shop reads it back on the next sync.'
          : listing.status === 'failed'
            ? 'Fix it, then approve it again — a failed listing doesn’t hold the shop.'
            : listing.status === 'inactive'
              ? `Taken down${listing.statusReason ? ` — ${listing.statusReason}` : ''}.`
              : listing.status === 'listed' && !api
                ? 'This shop can’t be read back, so this stays listed on your word.'
                : ''

  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} /> <span className='crumb-sep'>›</span>{' '}
            Listing
          </>
        }
        meta={listing.status}
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <NetTape listing={listing} shop={shop} recorded={recorded} />
          <Facts rows={facts} />
        </div>
        <div className='dev-main'>
          <h2
            className='dev-title'
            lang={isThai(listing.title) ? 'th' : undefined}
          >
            {listing.title}
          </h2>
          {listing.status === 'failed' ? (
            <div className='why'>
              <b>Why it failed:</b> {listing.statusReason ?? 'no reason given'}
              {blockers.length ? (
                <>
                  <br />
                  <b>Still in the way:</b>
                  <ul>
                    {blockers.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : blockers.length ? (
            <div className='why'>
              <b>Why it can’t go yet:</b>
              <ul>
                {blockers.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : listing.status === 'planned' ? (
            <p className='dev-p ok'>Nothing blocks it.</p>
          ) : null}

          {form === 'listed' ? (
            <ListedForm
              listing={listing}
              shop={shop}
              onCancel={() => setForm(null)}
              answer={answer}
            />
          ) : form === 'sale' ? (
            <LineForm
              marketplaces={marketplaces}
              listings={listings}
              listingId={listing.id}
              readAt={readAt}
              onCancel={() => setForm(null)}
              onSaved={() => {
                setForm(null)
                toast(
                  'Recorded — lines never change; a mistake gets a correction',
                )
              }}
            />
          ) : form === 'edit' ? (
            <EditListingForm
              listing={listing}
              onCancel={() => setForm(null)}
              answer={answer}
            />
          ) : form === 'inactive' ? (
            <InactiveForm
              listing={listing}
              onCancel={() => setForm(null)}
              answer={answer}
            />
          ) : form === 'list' && listing.status === 'inactive' ? (
            <ListForm
              project={project}
              products={products}
              marketplaces={marketplaces}
              listings={listings}
              productId={listing.productId}
              marketplaceId={listing.marketplaceId}
              embedded
              onClose={() => setForm(null)}
              onPlanned={(next) => saved(next, 'Listed again — planned')}
            />
          ) : (
            <div className='dev-acts'>
              {listing.status === 'planned' ? (
                <>
                  {blockers.length ? (
                    <button
                      type='button'
                      className='btn btn-release'
                      disabled
                      title='Clear what blocks it first'
                    >
                      Approve<kbd>a</kbd>
                    </button>
                  ) : (
                    <Confirm
                      label='Approve'
                      kbd='a'
                      tone='release'
                      small={false}
                      again
                      question='Let exactly this listing leave HQ, for 24 hours?'
                      yes='Approve'
                      no='Not now'
                      asking={armed === 'approve'}
                      onAsking={arm('approve')}
                      run={onApprove}
                    />
                  )}
                  <button
                    type='button'
                    className='btn'
                    onClick={() => setForm('edit')}
                  >
                    Edit<kbd>e</kbd>
                  </button>
                  <Confirm
                    label='Delete'
                    kbd='⌫'
                    small={false}
                    question='Delete this listing?'
                    yes='Delete'
                    asking={armed === 'delete'}
                    onAsking={arm('delete')}
                    run={remove}
                  />
                </>
              ) : listing.status === 'approved' ? (
                <>
                  <button
                    type='button'
                    className='btn btn-pri'
                    onClick={() => setForm('listed')}
                  >
                    Record as listed<kbd>r</kbd>
                  </button>
                  {api ? (
                    <Confirm
                      label={`Send to ${KIND_LABEL[listing.kind]}`}
                      kbd='p'
                      small={false}
                      again
                      question={`Send it to ${KIND_LABEL[listing.kind]} now?`}
                      yes={`Send to ${KIND_LABEL[listing.kind]}`}
                      no='Not now'
                      disabled={pending}
                      asking={armed === 'send'}
                      onAsking={arm('send')}
                      run={onSend}
                    />
                  ) : (
                    <button
                      type='button'
                      className='btn'
                      disabled
                      title={shop?.readiness.note}
                    >
                      Send to {KIND_LABEL[listing.kind]}
                      <kbd>p</kbd>
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
                </>
              ) : listing.status === 'listed' ||
                listing.status === 'verified' ? (
                <>
                  <button
                    type='button'
                    className='btn btn-pri'
                    onClick={() => setForm('sale')}
                  >
                    Record sale<kbd>s</kbd>
                  </button>
                  <button
                    type='button'
                    className='btn'
                    onClick={() => setForm('inactive')}
                  >
                    Mark inactive
                  </button>
                </>
              ) : listing.status === 'failed' ? (
                <button
                  type='button'
                  className='btn'
                  onClick={() => setForm('edit')}
                >
                  Edit<kbd>e</kbd>
                </button>
              ) : listing.status === 'inactive' ? (
                <button
                  type='button'
                  className='btn'
                  onClick={() => setForm('list')}
                >
                  List again<kbd>l</kbd>
                </button>
              ) : null}
            </div>
          )}
          {note ? <p className='dev-p note'>{note}</p> : null}

          <div className='dev-h'>
            <span className='hud-label'>Files · from the product</span>
            <span className='state-word'>
              {deliverable} deliverable · {listing.files.length - deliverable}{' '}
              preview
            </span>
          </div>
          {listing.files.length ? (
            <div className='dev-rows'>
              {listing.files.map((file) => (
                <div key={file.id} className='dev-row file'>
                  <span className='role'>{file.role}</span>
                  <span className='t mono' title={file.title}>
                    {file.title}
                  </span>
                  <span
                    className={`v${file.status === 'pending' ? ' live' : ''}`}
                  >
                    {file.status === 'pending' ? '▶ pending' : file.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className='dev-p muted'>
              No files yet — add them on the product.
            </p>
          )}
          <div className='dev-h'>
            <span className='hud-label'>Description</span>
          </div>
          {listing.description ? (
            <Markdown source={listing.description} />
          ) : (
            <p className='dev-p muted'>No description.</p>
          )}
          <div className='dev-h'>
            <span className='hud-label'>Tags</span>
            <span className='state-word'>
              {listing.tags.length} / {rule.tagMax}
            </span>
          </div>
          <div className='tags'>
            <TagChips tags={listing.tags} kind={listing.kind} />
          </div>
          <div className='insp-links'>
            {product ? (
              <button
                type='button'
                className='btn btn-sm'
                onClick={() =>
                  router.push(
                    `/p/${project.slug}/market?view=products&product=${product.id}`,
                  )
                }
              >
                ◈ Product
              </button>
            ) : null}
            <Link className='btn btn-sm' href={`/p/${project.slug}/assets`}>
              ▣ Files in Assets
            </Link>
          </div>
        </div>
      </div>
    </>
  )
}

function ListedForm({
  listing,
  shop,
  onCancel,
  answer,
}: {
  listing: ListingDetailData
  shop: MarketplaceData | null
  onCancel: () => void
  answer: (result: ActionResult<ListingDetailData>, message?: string) => boolean
}) {
  const [where, setWhere] = useState('')
  const [at, setAt] = useState(localInput(new Date().toISOString()))
  const [evidence, setEvidence] = useState<
    'owner_attested' | 'screenshot' | 'platform_export'
  >('owner_attested')
  const [pending, start] = useTransition()
  return (
    <form
      className='fcard'
      onSubmit={(event) => {
        event.preventDefault()
        start(async () => {
          const isUrl = /^https?:\/\//i.test(where.trim())
          answer(
            await recordListedAction({
              listingId: listing.id,
              expectedRevision: listing.revision,
              ...(isUrl ? { url: where.trim() } : { externalId: where.trim() }),
              listedAt: fromLocal(at),
              evidenceLevel: evidence,
            }),
            'On the record as listed',
          )
        })
      }}
    >
      <span className='fld-label'>
        Record as listed · {shop ? shopName(shop) : listing.marketplace}
      </span>
      <label>
        URL or listing ID
        <input
          value={where}
          required
          placeholder={`${shop?.url ?? 'https://…'}/…`}
          autoComplete='off'
          // biome-ignore lint/a11y/noAutofocus: the form opens on purpose
          autoFocus
          onChange={(event) => setWhere(event.target.value)}
        />
      </label>
      <div className='row'>
        <label className='grow'>
          Listed at
          <input
            type='datetime-local'
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
        </label>
        <label className='grow'>
          Evidence
          <select
            value={evidence}
            onChange={(event) =>
              setEvidence(event.target.value as typeof evidence)
            }
          >
            <option value='owner_attested'>you attested</option>
            <option value='screenshot'>screenshot</option>
            <option value='platform_export'>export from the shop</option>
          </select>
        </label>
      </div>
      <div className='row'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={!where.trim() || pending}
        >
          Record<kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </form>
  )
}

function EditListingForm({
  listing,
  onCancel,
  answer,
}: {
  listing: ListingDetailData
  onCancel: () => void
  answer: (result: ActionResult<ListingDetailData>, message?: string) => boolean
}) {
  const [title, setTitle] = useState(listing.title)
  const [price, setPrice] = useState(listing.price)
  const [tags, setTags] = useState(listing.tags.join(', '))
  const [description, setDescription] = useState(listing.description)
  const [pending, start] = useTransition()
  return (
    <form
      className='fcard'
      onSubmit={(event) => {
        event.preventDefault()
        start(async () => {
          answer(
            await updateListingAction({
              listingId: listing.id,
              expectedRevision: listing.revision,
              title,
              price: cleanAmount(price),
              tags: tagsOf(tags),
              description,
            }),
            listing.status === 'failed' ? 'Saved — planned again' : 'Saved',
          )
        })
      }}
    >
      <span className='fld-label'>Edit · {listing.marketplace}</span>
      <label>
        Title
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <div className='row'>
        <label className='grow'>
          Price · {listing.currency}
          <input
            className='num'
            inputMode='decimal'
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
        </label>
      </div>
      <label>
        Tags · comma between
        <input value={tags} onChange={(event) => setTags(event.target.value)} />
      </label>
      <label>
        Description
        <textarea
          rows={4}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <p className='hint'>
        {listing.status === 'failed'
          ? 'Saving puts it back to planned; approve it again when nothing blocks it.'
          : 'Saving keeps it planned.'}
      </p>
      <div className='row'>
        <button type='submit' className='btn btn-pri' disabled={pending}>
          Save<kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </form>
  )
}

function InactiveForm({
  listing,
  onCancel,
  answer,
}: {
  listing: ListingDetailData
  onCancel: () => void
  answer: (result: ActionResult<ListingDetailData>, message?: string) => boolean
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
            await inactiveListingAction({
              listingId: listing.id,
              expectedRevision: listing.revision,
              reason,
            }),
            'Marked inactive — the shop is free for this product again',
          )
        })
      }}
    >
      <span className='fld-label'>Mark inactive</span>
      <label>
        Why
        <input
          value={reason}
          required
          placeholder='Taken down · expired · sold out'
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
          Mark inactive
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </form>
  )
}

function ListForm({
  project,
  products,
  marketplaces,
  listings,
  productId,
  marketplaceId,
  embedded = false,
  onClose,
  onPlanned,
}: {
  project: MarketProject
  products: ProductData[]
  marketplaces: MarketplaceData[]
  listings: ListingRowData[]
  productId: string | null
  marketplaceId?: string
  embedded?: boolean
  onClose: () => void
  onPlanned: (next: ListingDetailData) => void
}) {
  const toast = useToast()
  const usable = products.filter((product) => product.status !== 'retired')
  const shops = marketplaces.filter((shop) => !shop.archived)
  const [pid, setPid] = useState(productId ?? usable[0]?.id ?? '')
  const product = usable.find((entry) => entry.id === pid) ?? null
  const taken = (shopId: string) =>
    listings.some(
      (listing) =>
        listing.productId === pid &&
        listing.marketplaceId === shopId &&
        HOLDS(listing),
    )
  const free = shops.filter((shop) => !taken(shop.id))
  const [mid, setMid] = useState(
    marketplaceId && free.some((shop) => shop.id === marketplaceId)
      ? marketplaceId
      : (free[0]?.id ?? ''),
  )
  const shop = shops.find((entry) => entry.id === mid) ?? null
  const [price, setPrice] = useState(product?.price ?? '')
  const [pending, start] = useTransition()

  const body = !usable.length ? (
    <div className='fcard'>
      <p className='hint'>
        ○ no products yet — make one in Products (2, then c).
      </p>
      <div className='row'>
        <button type='button' className='btn' onClick={onClose}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </div>
  ) : !shops.length ? (
    <div className='fcard'>
      <p className='hint'>
        ○ no shop yet — add one with ＋ shop in the row above.
      </p>
      <div className='row'>
        <button type='button' className='btn' onClick={onClose}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </div>
  ) : (
    <form
      className='fcard'
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        start(async () => {
          const result = await planListingAction({
            productId: pid,
            marketplaceId: mid,
            price: price ? cleanAmount(price) : undefined,
          })
          if (!result.ok) {
            toast(result.error)
            return
          }
          onPlanned(result.data)
        })
      }}
    >
      {productId ? (
        <span className='fld-label'>List on…</span>
      ) : (
        <label>
          Product
          <select
            value={pid}
            onChange={(event) => {
              setPid(event.target.value)
              setPrice(
                usable.find((entry) => entry.id === event.target.value)
                  ?.price ?? '',
              )
            }}
          >
            {usable.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Marketplace
        <select value={mid} onChange={(event) => setMid(event.target.value)}>
          {shops.map((entry) => (
            <option key={entry.id} value={entry.id} disabled={taken(entry.id)}>
              {shopName(entry)}
              {taken(entry.id) ? ' — listed there' : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        Price{shop ? ` · ${shop.currency}` : ''}
        <input
          className='num'
          inputMode='decimal'
          value={price}
          placeholder='0.00'
          onChange={(event) => setPrice(event.target.value)}
        />
      </label>
      <p className='hint'>
        {shop
          ? 'It starts planned — nothing leaves HQ until you approve it.'
          : 'Listed on every shop — take one down first.'}
      </p>
      <div className='row'>
        {shop ? (
          <button
            type='submit'
            className='btn btn-pri'
            disabled={pending || !pid}
          >
            Plan listing<kbd>↵</kbd>
          </button>
        ) : null}
        <button type='button' className='btn' onClick={onClose}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </form>
  )
  if (embedded) return body
  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} /> <span className='crumb-sep'>›</span> New
            listing
          </>
        }
        meta='planned once saved'
        onClose={onClose}
      />
      <div className='insp-body'>
        <Readout
          big='planned'
          sub='a product on one marketplace · once each at a time'
          tone='dim'
        />
        {body}
      </div>
    </>
  )
}

/** A money line: a sale, a refund, a fee or an adjustment — never edited; a mistake gets a correction. */
function LineForm({
  marketplaces,
  listings,
  listingId,
  correcting,
  readAt,
  onCancel,
  onSaved,
}: {
  marketplaces: MarketplaceData[]
  listings: ListingRowData[]
  listingId: string | null
  correcting?: SaleData | null
  readAt: string
  onCancel: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const shops = marketplaces.filter((shop) => !shop.archived)
  const listed = listings.filter((listing) => listing.listedAt)
  const start0 = listingId
    ? listingId
    : correcting?.listingId
      ? correcting.listingId
      : `shop:${shops[0]?.id ?? ''}`
  const [target, setTarget] = useState(start0)
  const listing = target.startsWith('shop:')
    ? null
    : (listings.find((entry) => entry.id === target) ?? null)
  const shop = listing
    ? (marketplaces.find((entry) => entry.id === listing.marketplaceId) ?? null)
    : (marketplaces.find((entry) => `shop:${entry.id}` === target) ?? null)
  const currency = listing?.currency ?? shop?.currency ?? 'USD'
  const price = listing ? Number(listing.price) : 0
  const sheetFees =
    listing && shop
      ? Number(
          (price - estimate(price, shop.feeSheet, currency).net).toFixed(2),
        )
      : 0
  const [kind, setKind] = useState<(typeof SALE_KINDS)[number]>(
    (correcting?.kind as (typeof SALE_KINDS)[number]) ?? 'sale',
  )
  const [quantity, setQuantity] = useState(String(correcting?.quantity ?? 1))
  const [amount, setAmount] = useState(
    correcting
      ? correcting.gross.replace('-', '')
      : price
        ? price.toFixed(2)
        : '',
  )
  const [fees, setFees] = useState(
    correcting
      ? correcting.fees.replace('-', '')
      : sheetFees
        ? sheetFees.toFixed(2)
        : '',
  )
  const [orderRef, setOrderRef] = useState(correcting?.orderRef ?? '')
  const [at, setAt] = useState(localInput(correcting?.occurredAt ?? readAt))
  const [reason, setReason] = useState('')
  const [pending, start] = useTransition()
  const net =
    (Number(cleanAmount(amount)) || 0) - (Number(cleanAmount(fees)) || 0)

  return (
    <form
      className='fcard'
      onSubmit={(event) => {
        event.preventDefault()
        if (!shop) return
        start(async () => {
          const result = await recordSaleAction({
            marketplaceId: shop.id,
            listingId: listing?.id,
            kind,
            amount: cleanAmount(kind === 'fee' ? fees || amount : amount),
            fees:
              kind === 'sale' || kind === 'refund'
                ? cleanAmount(fees) || undefined
                : undefined,
            quantity:
              kind === 'sale' || kind === 'refund' ? Number(quantity) || 0 : 0,
            occurredAt: fromLocal(at),
            orderRef: orderRef || undefined,
            ...(correcting
              ? { supersedesId: correcting.id, correctionReason: reason }
              : {}),
          })
          if (!result.ok) {
            toast(result.error)
            return
          }
          onSaved()
        })
      }}
    >
      <span className='fld-label'>
        {correcting
          ? 'Correct a line'
          : listingId
            ? `Record sale · ${listing?.marketplace ?? ''}`
            : 'Record a line'}
      </span>
      {listingId ? null : (
        <label>
          Listing
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            {listed.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title} · {entry.marketplace}
              </option>
            ))}
            {shops.map((entry) => (
              <option key={entry.id} value={`shop:${entry.id}`}>
                — shop line · {shopName(entry)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className='row'>
        <label className='grow'>
          Kind
          <select
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as (typeof SALE_KINDS)[number])
            }
          >
            {SALE_KINDS.map((entry) => (
              <option key={entry}>{entry}</option>
            ))}
          </select>
        </label>
        {kind === 'sale' || kind === 'refund' ? (
          <label className='qty'>
            Quantity
            <input
              className='num'
              type='number'
              min={0}
              step={1}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </label>
        ) : null}
      </div>
      <div className='row'>
        {kind === 'fee' ? null : (
          <label className='grow'>
            {kind === 'adjustment'
              ? `Amount · ${currency} (signed)`
              : `Gross · ${currency}`}
            <input
              className='num'
              inputMode='decimal'
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
        )}
        {kind === 'adjustment' ? null : (
          <label className='grow'>
            {kind === 'fee' ? `Fee · ${currency}` : 'Fees'}
            <input
              className='num'
              inputMode='decimal'
              value={fees}
              onChange={(event) => setFees(event.target.value)}
            />
          </label>
        )}
        {kind === 'sale' || kind === 'refund' ? (
          <span className='netcalc'>
            net <b>{money(kind === 'refund' ? -net : net, currency)}</b>
          </span>
        ) : null}
      </div>
      <div className='row'>
        <label className='grow'>
          Order ref
          <input
            value={orderRef}
            placeholder={shop?.kind === 'etsy' ? '#2234' : 'PF-1044'}
            autoComplete='off'
            onChange={(event) => setOrderRef(event.target.value)}
          />
        </label>
        <label className='grow'>
          When
          <input
            type='datetime-local'
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
        </label>
      </div>
      {correcting ? (
        <label>
          Why the correction
          <input
            value={reason}
            required
            placeholder='Typed the wrong amount'
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      ) : null}
      <p className='hint'>
        Fees start from your fee sheet — type what the shop reported. Lines
        never change; a mistake gets a correction.
      </p>
      <div className='row'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={pending || !shop || (correcting ? !reason.trim() : false)}
        >
          Record<kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
    </form>
  )
}

/* ── Shops ─────────────────────────────────────────────────────────── */

function ShopForm({
  project,
  shop,
  connections,
  onClose,
  onSaved,
}: {
  project: MarketProject
  shop: MarketplaceData | null
  connections: ConnectionOption[]
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [kind, setKind] = useState<Kind>(shop?.kind ?? 'etsy')
  const [name, setName] = useState(shop?.shop ?? '')
  const [url, setUrl] = useState(shop?.url ?? '')
  const [externalShopId, setExternalShopId] = useState(
    shop?.externalShopId ?? '',
  )
  const [connectionId, setConnectionId] = useState(shop?.connectionId ?? '')
  const [currency, setCurrency] = useState(shop?.currency ?? 'USD')
  const [listingFee, setListingFee] = useState(shop?.feeSheet.listingFee ?? '')
  const [transactionPct, setTransactionPct] = useState(
    shop?.feeSheet.transactionPct ?? '',
  )
  const [processingPct, setProcessingPct] = useState(
    shop?.feeSheet.processingPct ?? '',
  )
  const [processingFixed, setProcessingFixed] = useState(
    shop?.feeSheet.processingFixed ?? '',
  )
  const [pending, start] = useTransition()
  const options = connections.filter(
    (connection) => connection.provider === kind,
  )

  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} /> <span className='crumb-sep'>›</span>{' '}
            {shop ? shopName(shop) : 'New shop'}
          </>
        }
        meta={shop ? shop.readiness.mode : 'new'}
        onClose={onClose}
      />
      <div className='insp-body'>
        {shop ? (
          <Facts
            rows={[
              ['how it sells', shop.readiness.note],
              ['listings', String(shop.listings)],
              [
                'synced',
                shop.syncedAt
                  ? new Date(shop.syncedAt).toLocaleString('en-GB')
                  : '—',
              ],
              ['sync problem', shop.syncProblem ?? '—'],
            ]}
          />
        ) : null}
        <form
          className='fcard'
          onSubmit={(event) => {
            event.preventDefault()
            start(async () => {
              const result = await saveMarketplaceAction({
                projectId: project.id,
                ...(shop
                  ? { marketplaceId: shop.id, expectedRevision: shop.revision }
                  : {}),
                kind,
                shop: name,
                url,
                externalShopId,
                connectionId: connectionId || null,
                currency,
                feeSheet: {
                  listingFee: cleanAmount(listingFee) || undefined,
                  transactionPct: cleanAmount(transactionPct) || undefined,
                  processingPct: cleanAmount(processingPct) || undefined,
                  processingFixed: cleanAmount(processingFixed) || undefined,
                },
              })
              if (!result.ok) {
                toast(result.error)
                return
              }
              toast(
                shop ? `Saved ${name}` : `Added ${KIND_LABEL[kind]} · ${name}`,
              )
              onSaved()
            })
          }}
        >
          <span className='fld-label'>{shop ? 'Shop' : 'New shop'}</span>
          <div className='row'>
            <label className='grow'>
              Marketplace
              <select
                value={kind}
                disabled={Boolean(shop)}
                onChange={(event) => {
                  setKind(event.target.value as Kind)
                  setConnectionId('')
                }}
              >
                {(Object.keys(KIND_LABEL) as Kind[]).map((key) => (
                  <option key={key} value={key}>
                    {KIND_LABEL[key]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Currency
              <select
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
              >
                {['USD', 'THB', 'EUR', 'GBP'].map((code) => (
                  <option key={code}>{code}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Shop name
            <input
              value={name}
              required
              placeholder='DeskAndLight'
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Shop URL
            <input
              type='url'
              value={url}
              placeholder='https://www.etsy.com/shop/…'
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          {kind === 'etsy' ? (
            <>
              <label>
                Etsy shop ID
                <input
                  value={externalShopId}
                  placeholder='12345678'
                  onChange={(event) => setExternalShopId(event.target.value)}
                />
              </label>
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
            </>
          ) : null}
          <span className='fld-label'>
            Fee sheet · for the net tape’s estimate
          </span>
          <div className='row'>
            <label className='grow'>
              Listing fee
              <input
                className='num'
                inputMode='decimal'
                value={listingFee}
                placeholder='0.20'
                onChange={(event) => setListingFee(event.target.value)}
              />
            </label>
            <label className='grow'>
              Transaction %
              <input
                className='num'
                inputMode='decimal'
                value={transactionPct}
                placeholder='6.5'
                onChange={(event) => setTransactionPct(event.target.value)}
              />
            </label>
          </div>
          <div className='row'>
            <label className='grow'>
              Processing %
              <input
                className='num'
                inputMode='decimal'
                value={processingPct}
                placeholder='3'
                onChange={(event) => setProcessingPct(event.target.value)}
              />
            </label>
            <label className='grow'>
              Processing fixed
              <input
                className='num'
                inputMode='decimal'
                value={processingFixed}
                placeholder='0.25'
                onChange={(event) => setProcessingFixed(event.target.value)}
              />
            </label>
          </div>
          <p className='hint'>
            {kind === 'etsy'
              ? options.length
                ? 'With a connection HQ sends approved listings and reads orders back.'
                : 'No Etsy connection yet — add one at Settings › Connections, or sell by hand and record it.'
              : 'HQ doesn’t talk to this shop — put listings up yourself and record them.'}
          </p>
          <div className='row'>
            <button
              type='submit'
              className='btn btn-pri'
              disabled={!name.trim() || pending}
            >
              {shop ? 'Save' : 'Add shop'}
              <kbd>↵</kbd>
            </button>
            {shop && shop.readiness.mode === 'api' ? (
              <button
                type='button'
                className='btn'
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const result = await syncMarketplaceAction({
                      marketplaceId: shop.id,
                    })
                    if (!result.ok) {
                      toast(result.error)
                      return
                    }
                    toast(
                      `Synced — ${result.data.sales} sales · ${result.data.fees} fees · ${result.data.refunds} refunds · ${result.data.payouts} payouts${result.data.unmatched ? ` · ${result.data.unmatched} not matched to a listing` : ''}`,
                    )
                    onSaved()
                  })
                }
              >
                Sync now
              </button>
            ) : null}
            {shop ? (
              <button
                type='button'
                className='btn'
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const result = await archiveMarketplaceAction({
                      marketplaceId: shop.id,
                      expectedRevision: shop.revision,
                      archived: !shop.archived,
                    })
                    if (!result.ok) toast(result.error)
                    else {
                      toast(
                        shop.archived
                          ? 'Unarchived'
                          : 'Archived — its lines stay on the record',
                      )
                      onSaved()
                    }
                  })
                }
              >
                {shop.archived ? 'Unarchive' : 'Archive'}
              </button>
            ) : (
              <button type='button' className='btn' onClick={onClose}>
                Cancel<kbd>Esc</kbd>
              </button>
            )}
          </div>
        </form>
      </div>
    </>
  )
}

/* ── Products (Pool + Inspector) ───────────────────────────────────── */

function Products({
  project,
  products,
  marketplaces,
  listings,
  files,
  previews,
  selectedProductId,
  pickShop,
  closeShop,
  shopForm,
  onListed,
}: MarketPageProps & {
  listings: ListingRowData[]
  pickShop: (id: string | 'new') => void
  closeShop: () => void
  shopForm: ReactNode
  onListed: (next: ListingDetailData) => void
}) {
  const router = useRouter()
  const [status, setStatus] = useState<'all' | 'draft' | 'ready' | 'retired'>(
    'all',
  )
  const [selected, setSelected] = useState<string | 'new' | null>(
    selectedProductId,
  )
  const items = products.filter(
    (product) => status === 'all' || product.status === status,
  )
  const current = products.find((product) => product.id === selected) ?? null

  const select = (id: string | 'new' | null) => {
    setSelected(id)
    const url = new URL(window.location.href)
    if (id && id !== 'new') url.searchParams.set('product', id)
    else url.searchParams.delete('product')
    window.history.replaceState(null, '', url)
  }

  usePageKeys((key) => {
    if (key === 'c') {
      select('new')
      return true
    }
    if (key === 'Escape' && selected) {
      select(null)
      return true
    }
    const index = items.findIndex((product) => product.id === selected)
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
    return false
  })

  const ready = products.filter((product) => product.status === 'ready').length
  const draft = products.filter((product) => product.status === 'draft').length

  return (
    <div className='page marketp'>
      <section className='pane list-pane' aria-label='Products'>
        <PaneHead
          title='Market · products'
          meta={`${plural(products.length, 'product')} · ${ready} ready · ${draft} draft`}
        />
        <div className='toolbar'>
          {/* biome-ignore lint/a11y/useSemanticElements: status filters are a group of toggle buttons */}
          <span className='seg' role='group' aria-label='Status'>
            {(['all', 'draft', 'ready', 'retired'] as const).map((entry) => (
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
            {items.length} of {products.length}
          </span>
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => select('new')}
          >
            ＋ New product<kbd>c</kbd>
          </button>
        </div>
        <div className='mkt-scope'>
          <div className='shops left'>
            <ShopChips shops={marketplaces} onPick={pickShop} />
          </div>
        </div>
        <div className='pane-body'>
          {products.length === 0 ? (
            <Empty>○ no products yet — press c to make one.</Empty>
          ) : items.length === 0 ? (
            <Empty>No products match this filter.</Empty>
          ) : (
            <div className='pool ppool' role='listbox' aria-label='Products'>
              {items.map((product) => {
                const preview = product.files.find(
                  (file) => file.role === 'preview',
                )
                const url = preview ? previews[preview.id] : null
                const on = product.id === selected
                const holding = listings.filter(
                  (listing) =>
                    listing.productId === product.id &&
                    listing.status !== 'inactive',
                ).length
                return (
                  <button
                    key={product.id}
                    type='button'
                    role='option'
                    aria-selected={on}
                    className={`pcard prod ${product.status}${on ? ' sel' : ''}`}
                    onClick={() => select(product.id)}
                  >
                    <div
                      className={`thumb${url ? ' real' : ''}`}
                      role='img'
                      aria-label={
                        preview
                          ? `preview · ${preview.title}`
                          : 'no preview yet'
                      }
                      style={url ? { padding: 0 } : undefined}
                    >
                      {url ? (
                        <img
                          src={url}
                          alt=''
                          loading='lazy'
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            display: 'block',
                          }}
                        />
                      ) : (
                        <span>{preview ? 'preview' : 'no preview'}</span>
                      )}
                    </div>
                    <div
                      className='t'
                      lang={isThai(product.title) ? 'th' : undefined}
                      title={product.title}
                    >
                      {product.title}
                    </div>
                    <div className='m'>
                      <span className='pr'>
                        {product.price && product.currency
                          ? money(product.price, product.currency)
                          : '—'}
                      </span>
                      <span
                        className={`state-word${product.status === 'retired' ? ' off' : ''}`}
                      >
                        {product.status}
                      </span>
                    </div>
                    <div className='m'>
                      <span>{plural(product.files.length, 'file')}</span>
                      <span>{plural(holding, 'listing')}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </section>
      <Inspector
        id='market'
        label='Product'
        empty={!selected && !shopForm}
        onClose={() => {
          closeShop()
          select(null)
        }}
      >
        {shopForm ? (
          shopForm
        ) : selected === 'new' || current ? (
          <ProductInspector
            key={current ? `${current.id}-${current.revision}` : 'new'}
            project={project}
            product={current}
            files={files}
            marketplaces={marketplaces}
            listings={listings}
            products={products}
            onClose={() => select(null)}
            onSaved={(id) => {
              select(id)
            }}
            onGoListing={(id) =>
              router.push(`/p/${project.slug}/market?listing=${id}`)
            }
            onListed={onListed}
          />
        ) : (
          <>
            <InspectorHead title='Product' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>
                {products.length
                  ? 'Select a product, or press c for a new one.'
                  : '○ no products yet — press c to make one.'}
              </Empty>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

function ProductInspector({
  project,
  product,
  files,
  marketplaces,
  listings,
  products,
  onClose,
  onSaved,
  onGoListing,
  onListed,
}: {
  project: MarketProject
  product: ProductData | null
  files: FileOption[]
  marketplaces: MarketplaceData[]
  listings: ListingRowData[]
  products: ProductData[]
  onClose: () => void
  onSaved: (id: string) => void
  onGoListing: (id: string) => void
  onListed: (next: ListingDetailData) => void
}) {
  const toast = useToast()
  const [title, setTitle] = useState(product?.title ?? '')
  const [price, setPrice] = useState(product?.price ?? '')
  const [currency, setCurrency] = useState(
    product?.currency ?? project.currency,
  )
  const [tags, setTags] = useState(product?.tags.join(', ') ?? '')
  const [description, setDescription] = useState(product?.description ?? '')
  const [picked, setPicked] = useState<
    { assetId: string; role: 'deliverable' | 'preview' }[]
  >(product?.files.map((file) => ({ assetId: file.id, role: file.role })) ?? [])
  const [listing, setListing] = useState(false)
  const [pending, start] = useTransition()
  const mine = product
    ? listings.filter((entry) => entry.productId === product.id)
    : []
  const free = marketplaces.filter(
    (shop) =>
      !shop.archived &&
      !mine.some((entry) => entry.marketplaceId === shop.id && HOLDS(entry)),
  )
  const guess = (file: FileOption): 'deliverable' | 'preview' =>
    file.kind === 'image' ? 'preview' : 'deliverable'
  const tagList = tagsOf(tags)
  const dirty =
    !product ||
    title !== product.title ||
    price !== (product.price ?? '') ||
    currency !== (product.currency ?? project.currency) ||
    tags !== product.tags.join(', ') ||
    description !== product.description ||
    JSON.stringify(picked) !==
      JSON.stringify(
        product.files.map((file) => ({ assetId: file.id, role: file.role })),
      )

  const save = (status?: 'draft' | 'ready' | 'retired') =>
    start(async () => {
      const result = await saveProductAction({
        projectId: project.id,
        ...(product
          ? { productId: product.id, expectedRevision: product.revision }
          : {}),
        title,
        description,
        price: price ? cleanAmount(price) : null,
        currency,
        tags: tagList,
        files: picked,
        ...(status ? { status } : {}),
      })
      if (!result.ok) {
        toast(result.error)
        return
      }
      toast(
        status === 'retired'
          ? 'Retired — its listings stay on the record'
          : product
            ? 'Saved'
            : 'Product made — a draft until it has a file to download',
      )
      onSaved(result.data.id)
    })

  const deliverable = picked.filter(
    (file) => file.role === 'deliverable',
  ).length

  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} /> <span className='crumb-sep'>›</span>{' '}
            {product ? 'Product' : 'New product'}
          </>
        }
        meta={product ? product.status : 'draft once saved'}
        onClose={onClose}
      />
      <div className='insp-body'>
        {product ? (
          <div className='dev-read'>
            <Readout
              big={
                product.price && product.currency
                  ? money(product.price, product.currency)
                  : '—'
              }
              sub={`${product.currency ?? currency} · the price listings start from`}
            />
            <Facts
              rows={[
                ['status', product.status],
                ['tags', `${product.tags.length} / 13`],
                [
                  'files',
                  `${deliverable} deliverable · ${picked.length - deliverable} preview`,
                ],
                [
                  'listings',
                  `${mine.filter((entry) => entry.status !== 'inactive').length} · ${mine.filter((entry) => LIVE.includes(entry.status)).length} live`,
                ],
              ]}
            />
          </div>
        ) : null}
        {product ? (
          listing ? (
            <ListForm
              project={project}
              products={products}
              marketplaces={marketplaces}
              listings={listings}
              productId={product.id}
              embedded
              onClose={() => setListing(false)}
              onPlanned={onListed}
            />
          ) : (
            <div className='dev-acts'>
              <button
                type='button'
                className='btn btn-pri'
                disabled={product.status === 'retired' || free.length === 0}
                title={
                  product.status === 'retired'
                    ? 'The product is retired'
                    : free.length
                      ? undefined
                      : 'Listed on every shop — take one down first'
                }
                onClick={() => setListing(true)}
              >
                List on…<kbd>l</kbd>
              </button>
              <button
                type='button'
                className='btn'
                disabled={pending}
                onClick={() =>
                  save(product.status === 'retired' ? 'draft' : 'retired')
                }
              >
                {product.status === 'retired' ? 'Bring back' : 'Retire'}
              </button>
              {product.status === 'draft' && deliverable > 0 ? (
                <button
                  type='button'
                  className='btn'
                  disabled={pending}
                  onClick={() => save('ready')}
                >
                  Mark ready
                </button>
              ) : null}
            </div>
          )
        ) : null}
        <form
          className='fcard'
          onSubmit={(event) => {
            event.preventDefault()
            if (title.trim() && dirty) save()
          }}
        >
          <label>
            Title
            <input
              value={title}
              placeholder='What the buyer gets'
              autoComplete='off'
              // biome-ignore lint/a11y/noAutofocus: the form opens on purpose
              autoFocus={!product}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className='row'>
            <label className='grow'>
              Price
              <input
                className='num'
                inputMode='decimal'
                value={price}
                placeholder='0.00'
                onChange={(event) => setPrice(event.target.value)}
              />
            </label>
            <label>
              Currency
              <select
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
              >
                {['USD', 'THB', 'EUR', 'GBP'].map((code) => (
                  <option key={code}>{code}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Tags · comma between, up to 13
            <input
              value={tags}
              placeholder='printable, a4, calendar'
              autoComplete='off'
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          {tagList.length > 13 ? (
            <p className='hint err'>
              That’s {tagList.length} tags — shops take 13.
            </p>
          ) : null}
          <label>
            Description
            <textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <span className='fld-label'>Files from Assets</span>
          {files.length ? (
            <div className='pick-files'>
              {files.map((file) => {
                const on = picked.find((entry) => entry.assetId === file.id)
                return (
                  <div key={file.id} className='pick'>
                    <input
                      type='checkbox'
                      id={`pf-${file.id}`}
                      checked={Boolean(on)}
                      onChange={(event) =>
                        setPicked((list) =>
                          event.target.checked
                            ? [...list, { assetId: file.id, role: guess(file) }]
                            : list.filter((entry) => entry.assetId !== file.id),
                        )
                      }
                    />
                    <label htmlFor={`pf-${file.id}`}>{file.title}</label>
                    <span className='v'>{file.kind}</span>
                    <select
                      aria-label={`Role of ${file.title}`}
                      value={on?.role ?? guess(file)}
                      disabled={!on}
                      onChange={(event) =>
                        setPicked((list) =>
                          list.map((entry) =>
                            entry.assetId === file.id
                              ? {
                                  ...entry,
                                  role: event.target.value as
                                    | 'deliverable'
                                    | 'preview',
                                }
                              : entry,
                          ),
                        )
                      }
                    >
                      <option>deliverable</option>
                      <option>preview</option>
                    </select>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className='hint'>
              No ready files in this project yet — upload them in{' '}
              <Link className='lnk' href={`/p/${project.slug}/assets`}>
                Assets
              </Link>
              .
            </p>
          )}
          <p className='hint'>
            {product
              ? 'Changing its files after a listing was approved takes that approval back.'
              : 'It starts as a draft — list it once it has a file to download.'}
          </p>
          <div className='row'>
            <button
              type='submit'
              className='btn btn-pri'
              disabled={!title.trim() || !dirty || pending}
            >
              {product ? 'Save' : 'Create'}
              <kbd>↵</kbd>
            </button>
            <button type='button' className='btn' onClick={onClose}>
              {product ? 'Back' : 'Cancel'}
              <kbd>Esc</kbd>
            </button>
          </div>
        </form>
        {product ? (
          <>
            <div className='dev-h'>
              <span className='hud-label'>On marketplaces</span>
            </div>
            {mine.length ? (
              <div className='dev-rows'>
                {mine.map((entry) => (
                  <button
                    key={entry.id}
                    type='button'
                    className='dev-row golink'
                    onClick={() => onGoListing(entry.id)}
                  >
                    <span className='t'>{entry.marketplace}</span>
                    <span className='v'>{entry.status}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className='dev-p muted'>Not listed anywhere yet.</p>
            )}
          </>
        ) : null}
      </div>
    </>
  )
}

/* ── Money: lines + payouts ────────────────────────────────────────── */

function Money({
  project,
  marketplaces,
  listings,
  sales,
  payouts,
  readAt,
  salesNow,
  totals,
  dayTime,
  day,
  pickShop,
}: MarketPageProps & {
  narrow: boolean
  salesNow: SaleData[]
  totals: (
    days: number,
  ) => { currency: string; net: string; sold: number; orders: number }[]
  dayTime: (iso: string | null) => string
  day: (iso: string | null) => string
  pickShop: (id: string | 'new') => void
}) {
  const toast = useToast()
  const [period, setPeriod] = useState<7 | 30>(7)
  const [kind, setKind] = useState<'all' | (typeof SALE_KINDS)[number]>('all')
  const [lineForm, setLineForm] = useState<null | 'new' | SaleData>(null)
  const [selectedPayout, setSelectedPayout] = useState<string | null>(null)
  const [payoutForm, setPayoutForm] = useState(false)
  const [pending, start] = useTransition()
  const from = new Date(Date.parse(readAt) - period * 86_400_000).toISOString()
  const inWindow = sales.filter((line) => line.occurredAt >= from)
  const rows = inWindow.filter((line) => kind === 'all' || line.kind === kind)
  const week = totals(7)
  const month = totals(30)
  const currencies = [
    ...new Set([...week, ...month].map((entry) => entry.currency)),
  ]
  const expected = payouts.filter((payout) => payout.status === 'expected')
  const listingTitle = (line: SaleData) =>
    line.listingTitle ?? `${line.marketplaceShop} · ${line.note ?? 'shop line'}`

  usePageKeys((key) => {
    if (key === 's') {
      setLineForm('new')
      return true
    }
    if (key === 'Escape' && (lineForm || payoutForm)) {
      setLineForm(null)
      setPayoutForm(false)
      return true
    }
    return false
  })

  // Per currency: confirmed in 30 days, and what's expected.
  const byCurrency = new Map<
    string,
    { confirmed: string[]; expected: string[] }
  >()
  const thirty = new Date(Date.parse(readAt) - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10)
  for (const payout of payouts) {
    const entry = byCurrency.get(payout.currency) ?? {
      confirmed: [],
      expected: [],
    }
    if (payout.status === 'expected') entry.expected.push(payout.amount)
    else if ((payout.paidOn ?? '') >= thirty)
      entry.confirmed.push(payout.amount)
    byCurrency.set(payout.currency, entry)
  }

  return (
    <div className='page marketp money'>
      <section className='pane list-pane' aria-label='Money lines'>
        <PaneHead
          title='Market · money'
          meta={`${plural(salesNow.length, 'line')} · append-only · never converted`}
        />
        <div className='toolbar'>
          {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons */}
          <span className='seg' role='group' aria-label='Period'>
            {([7, 30] as const).map((days) => (
              <button
                key={days}
                type='button'
                aria-pressed={period === days}
                onClick={() => setPeriod(days)}
              >
                {days}d
              </button>
            ))}
          </span>
          <select
            aria-label='Kind'
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value='all'>every kind</option>
            {SALE_KINDS.map((entry) => (
              <option key={entry}>{entry}</option>
            ))}
          </select>
          <span className='sp' />
          <span className='hits'>
            {rows.length} of {inWindow.length} lines
          </span>
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => setLineForm('new')}
          >
            ＋ Record a line<kbd>s</kbd>
          </button>
        </div>
        <div className='mkt-scope'>
          {currencies.length ? (
            currencies.map((currency) => {
              const w = week.find((entry) => entry.currency === currency)
              const m = month.find((entry) => entry.currency === currency)
              return (
                <span key={currency} style={{ display: 'contents' }}>
                  <Readout
                    big={money(w?.net ?? '0', currency)}
                    sub={`7d net · ${currency} · ${w?.sold ?? 0} sold`}
                  />
                  <Readout
                    big={money(m?.net ?? '0', currency)}
                    sub={`30d net · ${currency} · ${plural(m?.orders ?? 0, 'order')}`}
                  />
                </span>
              )
            })
          ) : (
            <Readout
              big={money('0', project.currency)}
              sub='7d net · nothing recorded'
            />
          )}
          <span className='sp' />
          <ShopChips shops={marketplaces} onPick={pickShop} />
        </div>
        <div className='pane-body'>
          {lineForm ? (
            <div className='line-form'>
              <LineForm
                key={lineForm === 'new' ? 'new' : lineForm.id}
                marketplaces={marketplaces}
                listings={listings}
                listingId={null}
                correcting={lineForm === 'new' ? null : lineForm}
                readAt={readAt}
                onCancel={() => setLineForm(null)}
                onSaved={() => {
                  setLineForm(null)
                  toast(
                    lineForm === 'new'
                      ? 'Recorded — lines never change; a mistake gets a correction'
                      : 'Corrected — the old line stays, struck',
                  )
                }}
              />
            </div>
          ) : null}
          {sales.length === 0 ? (
            <Empty>
              ○ no money lines yet —{' '}
              {marketplaces.length
                ? 'press s to record one.'
                : 'add a shop (＋ shop above) first.'}
            </Empty>
          ) : rows.length === 0 ? (
            <Empty>
              Nothing recorded in the last {period} days
              {kind === 'all' ? '' : ` of kind ${kind}`}.
            </Empty>
          ) : (
            <div className='tbl line-tbl'>
              <div className='tbl-head'>
                <span className='hud-label'>when</span>
                <span className='hud-label c-kind'>kind</span>
                <span className='hud-label'>listing</span>
                <span className='hud-label num c-g'>gross</span>
                <span className='hud-label num c-f'>fees</span>
                <span className='hud-label num'>net</span>
                <span className='hud-label c-ref'>order</span>
                <span className='hud-label c-src'>source</span>
              </div>
              {rows.map((line) => (
                <div
                  key={line.id}
                  className={`tbl-row k-${line.kind}${line.supersededBy ? ' struck' : ''}`}
                  title={[
                    line.note,
                    line.supersededBy ? 'superseded by a correction' : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                >
                  <span className='c-when mono'>
                    {dayTime(line.occurredAt)}
                  </span>
                  <span className='c-kind'>
                    <span className='kind'>{line.kind}</span>
                  </span>
                  <span lang={isThai(listingTitle(line)) ? 'th' : undefined}>
                    <span className='k-sm'>{line.kind} · </span>
                    {listingTitle(line)}
                  </span>
                  <span className='num c-g'>
                    {formatMoney(line.gross, line.currency, {
                      exact: true,
                      symbol: false,
                    })}
                  </span>
                  <span className='num c-f'>
                    {formatMoney(line.fees, line.currency, {
                      exact: true,
                      symbol: false,
                    })}
                  </span>
                  <span className='num'>{money(line.net, line.currency)}</span>
                  <span className='c-ref mono'>{line.orderRef ?? '—'}</span>
                  <span className='c-src'>
                    {line.supersededBy ? (
                      <span className='state-word'>corrected</span>
                    ) : (
                      <>
                        {line.supersedesId
                          ? 'correction'
                          : line.source === 'provider'
                            ? 'shop sync'
                            : line.source}
                        {' · '}
                        <button
                          type='button'
                          className='linkish'
                          onClick={() => setLineForm(line)}
                          title='Record a correction for this line'
                        >
                          correct
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
      <section className='pane pay-pane' aria-label='Payouts'>
        <PaneHead
          title='Payouts'
          meta={`${expected.length} expected · ${payouts.length - expected.length} confirmed`}
        />
        {byCurrency.size ? (
          <div className='pay-read'>
            {[...byCurrency.entries()].map(([currency, entry]) => (
              <Readout
                key={currency}
                big={money(sumAmounts(entry.confirmed, currency), currency)}
                sub={`${currency} · confirmed · 30d · ${entry.expected.length ? `${money(sumAmounts(entry.expected, currency), currency)} expected` : 'nothing expected'}`}
              />
            ))}
          </div>
        ) : null}
        <div className='pane-body'>
          <div className='pay-list' role='listbox' aria-label='Payouts'>
            {payoutForm ? (
              <PayoutForm
                marketplaces={marketplaces}
                onCancel={() => setPayoutForm(false)}
                onSaved={() => {
                  setPayoutForm(false)
                  toast(
                    'Expected payout recorded — it counts once you confirm it arrived',
                  )
                }}
              />
            ) : (
              <button
                type='button'
                className='btn btn-sm'
                style={{ justifySelf: 'start' }}
                disabled={!marketplaces.length}
                onClick={() => setPayoutForm(true)}
              >
                ＋ Expected payout
              </button>
            )}
            {payouts.length === 0 ? (
              <Empty>○ no payouts yet</Empty>
            ) : (
              [...payouts]
                .sort((a, b) =>
                  a.status === b.status
                    ? (b.expectedOn ?? b.paidOn ?? '').localeCompare(
                        a.expectedOn ?? a.paidOn ?? '',
                      )
                    : a.status === 'expected'
                      ? -1
                      : 1,
                )
                .map((payout) => (
                  <PayoutCard
                    key={payout.id}
                    payout={payout}
                    selected={payout.id === selectedPayout}
                    day={day}
                    pending={pending}
                    onSelect={() => setSelectedPayout(payout.id)}
                    onConfirm={(paidOn) =>
                      start(async () => {
                        const result = await confirmPayoutAction({
                          payoutId: payout.id,
                          expectedRevision: payout.revision,
                          paidOn,
                        })
                        if (!result.ok) toast(result.error)
                        else {
                          toast(
                            `Confirmed — ${money(payout.amount, payout.currency)} arrived`,
                          )
                        }
                      })
                    }
                  />
                ))
            )}
          </div>
          <p className='dev-p note pay-note'>
            A payout counts once you confirm the bank showed it. Amounts stay in
            the bank’s currency.
          </p>
        </div>
      </section>
    </div>
  )
}

function PayoutCard({
  payout,
  selected,
  day,
  pending,
  onSelect,
  onConfirm,
}: {
  payout: PayoutData
  selected: boolean
  day: (iso: string | null) => string
  pending: boolean
  onSelect: () => void
  onConfirm: (paidOn: string) => void
}) {
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10))
  return (
    <div
      className={`pay ${payout.status}${selected ? ' sel' : ''}`}
      role='option'
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget)
          onSelect()
      }}
    >
      <div className='ph'>
        <b className='amt'>{money(payout.amount, payout.currency)}</b>
        <span className='ccy'>{payout.currency}</span>
        <span className='sp' />
        <span className='state-word'>{payout.status}</span>
      </div>
      <div className='pm'>
        {payout.marketplaceShop} payout · {payout.currency} ·{' '}
        {payout.reference ?? 'no reference'}
      </div>
      <Facts
        rows={[
          ['expected on', payout.expectedOn ? day(payout.expectedOn) : '—'],
          ['paid on', payout.paidOn ? day(payout.paidOn) : '—'],
        ]}
      />
      {payout.status === 'expected' ? (
        <form
          className='pay-form'
          onSubmit={(event) => {
            event.preventDefault()
            onConfirm(paidOn)
          }}
        >
          <label>
            Paid on
            <input
              type='date'
              value={paidOn}
              onChange={(event) => setPaidOn(event.target.value)}
            />
          </label>
          <button type='submit' className='btn btn-pri' disabled={pending}>
            Confirm it arrived
          </button>
        </form>
      ) : null}
    </div>
  )
}

function PayoutForm({
  marketplaces,
  onCancel,
  onSaved,
}: {
  marketplaces: MarketplaceData[]
  onCancel: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const shops = marketplaces.filter((shop) => !shop.archived)
  const [mid, setMid] = useState(shops[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [expectedOn, setExpectedOn] = useState('')
  const [reference, setReference] = useState('')
  const [pending, start] = useTransition()
  const shop = shops.find((entry) => entry.id === mid)
  return (
    <form
      className='fcard'
      onSubmit={(event) => {
        event.preventDefault()
        start(async () => {
          const result = await recordPayoutAction({
            marketplaceId: mid,
            amount: cleanAmount(amount),
            expectedOn: expectedOn || undefined,
            reference: reference || undefined,
          })
          if (!result.ok) toast(result.error)
          else onSaved()
        })
      }}
    >
      <span className='fld-label'>Expected payout</span>
      <label>
        Shop
        <select value={mid} onChange={(event) => setMid(event.target.value)}>
          {shops.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {shopName(entry)}
            </option>
          ))}
        </select>
      </label>
      <div className='row'>
        <label className='grow'>
          Amount{shop ? ` · ${shop.currency}` : ''}
          <input
            className='num'
            inputMode='decimal'
            value={amount}
            required
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className='grow'>
          Expected on
          <input
            type='date'
            value={expectedOn}
            onChange={(event) => setExpectedOn(event.target.value)}
          />
        </label>
      </div>
      <label>
        Reference
        <input
          value={reference}
          placeholder='Etsy deposit #'
          onChange={(event) => setReference(event.target.value)}
        />
      </label>
      <div className='row'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={!amount.trim() || !mid || pending}
        >
          Record
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
