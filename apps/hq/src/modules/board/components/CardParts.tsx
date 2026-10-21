'use client'

import { formatMoney, sumAmounts } from '@theiceji/hq-core/money'
import Link from 'next/link'
import { type ReactNode, useRef, useState } from 'react'
import { bytesLabel, isThai } from '@/components/bridge/parts'
import { Icon } from '@/components/shell/Icon'
import { Markdown } from '@/lib/md'
import type { CardHistory, PromptChoice } from '../actions'
import type { CardData, FollowupData, PaymentData } from '../data'
import { type NewPromptFields, PromptPicker } from './PromptPicker'

/**
 * The inspector's sections for a card that holds a whole client job:
 * Follow-ups (work that came after
 * the card's task; prices add into its total), Payments (what came in — a
 * deposit of any size or none, parts, the rest at Mark paid), the Prompt the
 * job ran on, and its Files. Each is a HUD label over plain SaaS parts; the
 * one meter is the payments' `.meter` (lit = in, unlit = still owed).
 */

export type PromptLink = CardHistory['prompts'][number]
export type FileLink = CardHistory['files'][number]

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')
const DAYS = 'Sun Mon Tue Wed Thu Fri Sat'.split(' ')
/** `2026-09-24` → `Thu 24 Sep` (a day in the project's calendar, never shifted). */
export function dayLabel(day: string | null): string {
  const m = day ? DAY.exec(day) : null
  if (!m) return ''
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
}

export const money = (amount: string | null, currency: string | null) =>
  amount && currency ? formatMoney(amount, currency) : ''

/** What the card still owes (total − paid); negative is overpaid. Null without a price. */
export function owedOf(
  card: Pick<CardData, 'total' | 'paidTotal' | 'currency'>,
) {
  if (card.total === null || !card.currency) return null
  return sumAmounts([card.total, `-${card.paidTotal}`], card.currency)
}

/** The follow-up mark (↳ has no glyph in Red Hat Mono). */
export function FollowupMark() {
  return (
    <svg className='i fu-i' viewBox='0 0 24 24' aria-hidden='true'>
      <path d='M6 4v8a4 4 0 0 0 4 4h9M15 12l4 4-4 4' />
    </svg>
  )
}

/** Paid so far: lit = in, unlit segments = still owed (never a lit bar for money not in). */
export function PayMeter({
  paid,
  total,
  thin = false,
}: {
  paid: string
  total: string | null
  thin?: boolean
}) {
  const t = Number(total ?? 0)
  const p = Number(paid)
  if (!(t > 0) || !(p > 0)) return null
  return (
    <div
      className={`meter${thin ? ' paymeter' : ''}`}
      role='img'
      aria-label={`${Math.min(100, Math.round((p / t) * 100))}% paid`}
    >
      <span
        style={{ ['--level' as string]: `${Math.min(100, (p / t) * 100)}%` }}
      />
    </div>
  )
}

/* ── Prompt ─────────────────────────────────────────────────────────── */

export function PromptBlock({
  link,
  home,
  compact = false,
  keys = false,
  onPick,
  onCreate,
  onUnlink,
  onCopy,
}: {
  link: PromptLink | null
  /** Where a new prompt is saved, in words. */
  home: string
  compact?: boolean
  /** Print the card's keys (p, y) on its buttons. */
  keys?: boolean
  onPick: (choice: PromptChoice) => void
  onCreate: (fields: NewPromptFields) => Promise<string | null>
  onUnlink: (refId: string) => void
  onCopy: (text: string) => void
}) {
  if (!link)
    return (
      <PromptPicker
        home={home}
        triggerId={keys ? 'card-prompt' : undefined}
        onPick={onPick}
        onCreate={onCreate}
      >
        ✎ Link a prompt{keys ? <kbd>p</kbd> : null}
      </PromptPicker>
    )
  return (
    <div className={`plink${compact ? ' compact' : ''}`}>
      <div className='plink-h'>
        <span className='plink-t' lang={isThai(link.title) ? 'th' : undefined}>
          ✎ {link.title}
        </span>
        <span className='plink-m'>
          {link.projectId ? 'project' : 'library'} · {link.medium}
        </span>
      </div>
      {link.text && !compact ? (
        <p className='quote mono'>
          <span className='hud-label'>prompt</span>
          {link.text}
        </p>
      ) : null}
      <div className='dev-acts'>
        {link.text ? (
          <button
            type='button'
            id={keys ? 'card-prompt-copy' : undefined}
            className='btn btn-sm'
            onClick={() => onCopy(link.text as string)}
          >
            Copy{keys ? <kbd>y</kbd> : null}
          </button>
        ) : null}
        <Link className='btn btn-sm' href={`/prompts?prompt=${link.promptId}`}>
          Open in Prompts
        </Link>
        <PromptPicker
          home={home}
          triggerId={keys ? 'card-prompt' : undefined}
          onPick={onPick}
          onCreate={onCreate}
        >
          Change
        </PromptPicker>
        <button
          type='button'
          className='btn btn-sm'
          onClick={() => onUnlink(link.refId)}
        >
          Unlink
        </button>
      </div>
    </div>
  )
}

/* ── Files ──────────────────────────────────────────────────────────── */

export type Uploading = {
  key: string
  name: string
  progress: number | null
  error: string | null
}

export function FilesBlock({
  files,
  uploading,
  offReason,
  keys = false,
  onFiles,
  onUnlink,
}: {
  files: FileLink[]
  uploading: Uploading[]
  /** Why files can't be added here (Assets off), or null. */
  offReason: string | null
  keys?: boolean
  onFiles: (files: File[]) => void
  onUnlink: (refId: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div className='files'>
      {files.map((file) => {
        const ext = (file.name.split('.').pop() ?? '').toUpperCase()
        // What HQ calls it; the extension above stays the file's.
        const title = file.title ?? file.name
        return (
          <figure key={file.refId} className='ftile'>
            <Link
              className='thumb'
              href={`/assets?asset=${file.assetId}`}
              title={`${title} — open in Assets`}
            >
              {file.preview && file.kind === 'image' ? (
                <img src={file.preview} alt='' />
              ) : (
                <span>
                  {file.status === 'ready' ? ext.slice(0, 4) : file.status}
                </span>
              )}
            </Link>
            <figcaption title={title}>
              <span className='fn'>{title}</span>
              <span className='fs'>{bytesLabel(file.bytes)}</span>
            </figcaption>
            <button
              type='button'
              className='iconbtn fx'
              aria-label={`Unlink ${title} — it stays in Assets`}
              title='Unlink (the file stays in Assets)'
              onClick={() => onUnlink(file.refId)}
            >
              <Icon name='close' size={12} />
            </button>
          </figure>
        )
      })}
      {uploading.map((entry) => (
        <figure key={entry.key} className='ftile'>
          <div className='thumb'>
            <span>
              {entry.error
                ? '◆'
                : entry.progress === null
                  ? '…'
                  : `${entry.progress}%`}
            </span>
          </div>
          <figcaption title={entry.error ?? entry.name}>
            <span className='fn'>{entry.name}</span>
            <span className='fs'>{entry.error ?? 'uploading'}</span>
          </figcaption>
        </figure>
      ))}
      {offReason ? (
        <p className='dev-p fdrop-off'>{offReason}</p>
      ) : (
        <button
          type='button'
          className={`mdrop fdrop${over ? ' over' : ''}`}
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault()
            setOver(false)
            if (event.dataTransfer.files.length)
              onFiles([...event.dataTransfer.files])
          }}
        >
          ＋ Drop files{keys ? <kbd>u</kbd> : null}
          <small>kept in Assets</small>
          <input
            ref={input}
            type='file'
            multiple
            hidden
            data-card-files={keys ? 'card' : undefined}
            onChange={(event) => {
              const list = [...(event.target.files ?? [])]
              event.target.value = ''
              if (list.length) onFiles(list)
            }}
          />
        </button>
      )}
    </div>
  )
}

/* ── Follow-ups ─────────────────────────────────────────────────────── */

export type FollowupFields = {
  title: string
  body: string
  price: string
  dueOn: string
}

export function FollowupForm({
  initial,
  currency,
  awaiting,
  onCancel,
  onSave,
}: {
  initial: FollowupData | null
  currency: string
  awaiting: boolean
  onCancel: () => void
  onSave: (fields: FollowupFields) => Promise<string | null>
}) {
  const [fields, setFields] = useState<FollowupFields>({
    title: initial?.title ?? '',
    body: initial?.body ?? '',
    price: initial?.price ?? '',
    dueOn: initial?.dueOn ?? '',
  })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const set =
    (key: keyof FollowupFields) => (event: { target: { value: string } }) =>
      setFields((now) => ({ ...now, [key]: event.target.value }))
  return (
    <form
      className='fcard fu-form'
      autoComplete='off'
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault()
        setPending(true)
        setError(null)
        const refused = await onSave(fields)
        setPending(false)
        if (refused) setError(refused)
      }}
    >
      <span className='hud-label'>
        {initial ? 'Edit follow-up' : 'New follow-up'}
      </span>
      <label>
        What
        <input
          type='text'
          required
          maxLength={200}
          // biome-ignore lint/a11y/noAutofocus: the form opens to type what came after
          autoFocus
          placeholder='Round 2 · wordmark spacing'
          value={fields.title}
          lang={isThai(fields.title) ? 'th' : undefined}
          onChange={set('title')}
        />
      </label>
      <label>
        Details · markdown
        <textarea
          rows={3}
          maxLength={20000}
          placeholder='What was asked, what was sent, the client’s words…'
          value={fields.body}
          onChange={set('body')}
        />
      </label>
      <div className='row'>
        <label style={{ flex: 1 }}>
          Price · {currency}
          <input
            type='text'
            inputMode='decimal'
            placeholder='—'
            value={fields.price}
            onChange={set('price')}
          />
        </label>
        <label style={{ flex: 1 }}>
          Due
          <input type='date' value={fields.dueOn} onChange={set('dueOn')} />
        </label>
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
          disabled={pending || !fields.title.trim()}
        >
          {pending ? 'Saving…' : initial ? 'Save' : 'Add follow-up'}
          <kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
      <p className='hint'>
        Its price adds into the card’s total — the tile, the lane footer
        {awaiting ? ', what is owed' : ''} and Mark paid read the total. The
        prompt and files go on it once it’s saved.
      </p>
    </form>
  )
}

export function FollowupItem({
  followup,
  currency,
  today,
  prompt,
  files,
  onEdit,
  onRemove,
}: {
  followup: FollowupData
  currency: string
  today: string
  prompt: ReactNode
  files: ReactNode
  onEdit: () => void
  onRemove: () => void
}) {
  const due =
    followup.dueOn === today
      ? 'today'
      : followup.dueOn && followup.dueOn < today
        ? 'late'
        : null
  return (
    <article className='fu' aria-label={followup.title}>
      <div className='fu-top'>
        <span className='fu-g'>
          <FollowupMark />
        </span>
        <span className='fu-t' lang={isThai(followup.title) ? 'th' : undefined}>
          {followup.title}
        </span>
        <span className='fu-v'>
          {followup.price ? money(followup.price, currency) : '—'}
        </span>
      </div>
      {followup.body ? <Markdown source={followup.body} /> : null}
      {followup.dueOn ? (
        <div className='fu-m'>
          {due === 'today' ? (
            <span className='state-word due'>● due today</span>
          ) : (
            `due ${dayLabel(followup.dueOn)}${due === 'late' ? ' · passed' : ''}`
          )}
        </div>
      ) : null}
      {prompt}
      {files}
      <div className='fu-acts'>
        <button type='button' className='btn btn-sm' onClick={onEdit}>
          Edit
        </button>
        <button type='button' className='btn btn-sm' onClick={onRemove}>
          Remove
        </button>
      </div>
    </article>
  )
}

/* ── Payments ───────────────────────────────────────────────────────── */

export type PaymentFields = {
  amount: string
  kind: 'deposit' | 'part'
  receivedOn: string
  note: string
}

const KIND: Record<PaymentData['kind'], string> = {
  deposit: 'deposit',
  part: 'part payment',
  final: 'the rest, at Mark paid',
  void: 'void',
}

export function PaymentsSection({
  card,
  payments,
  awaiting,
  today,
  open,
  onOpen,
  onCancel,
  onRecord,
  onVoid,
}: {
  card: CardData
  payments: PaymentData[]
  awaiting: boolean
  today: string
  open: boolean
  onOpen: () => void
  onCancel: () => void
  onRecord: (fields: PaymentFields) => Promise<string | null>
  onVoid: (payment: PaymentData) => void
}) {
  const currency = card.currency ?? 'THB'
  const struck = new Set(payments.map((entry) => entry.voidsId).filter(Boolean))
  const lines = payments.filter((entry) => entry.kind !== 'void')
  const counting = lines.filter((entry) => !struck.has(entry.id))
  const owed = owedOf(card)
  const paid = card.paidTotal
  return (
    <section className='sect' aria-label='Payments'>
      <div className='dev-h'>
        <span className='hud-label'>
          Payments{counting.length ? ` · ${counting.length}` : ''}
        </span>
        <span className='sect-m'>
          {card.total
            ? `${money(paid, currency) || formatMoney('0', currency)} of ${money(card.total, currency)}`
            : 'no price yet'}
        </span>
      </div>
      <PayMeter paid={paid} total={card.total} />
      {lines.length ? (
        <div className='pays'>
          {lines.map((line) => {
            const isVoid = struck.has(line.id)
            return (
              <div key={line.id} className={`pay${isVoid ? ' void' : ''}`}>
                <span className='pay-k'>{KIND[line.kind]}</span>
                <span className='pay-d'>
                  {dayLabel(line.receivedOn)}
                  {isVoid ? ' · voided' : ''}
                </span>
                <span className='pay-v'>
                  {money(line.amount, line.currency)}
                </span>
                {isVoid || card.archivedAt ? (
                  <span />
                ) : (
                  <button
                    type='button'
                    className='btn btn-sm pay-x'
                    title='Strike it — it stays in the history'
                    onClick={() => onVoid(line)}
                  >
                    Void
                  </button>
                )}
                {line.note ? (
                  <span
                    className='pay-n'
                    lang={isThai(line.note) ? 'th' : undefined}
                  >
                    {line.note}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : open ? null : (
        <p className='dev-p'>
          Nothing in yet. A deposit is any amount, or none; part payments go
          here as they come, and Mark paid records what is left.
        </p>
      )}
      {open ? (
        <PaymentForm
          card={card}
          awaiting={awaiting}
          today={today}
          firstKind={counting.length || awaiting ? 'part' : 'deposit'}
          onCancel={onCancel}
          onRecord={onRecord}
        />
      ) : card.archivedAt ? null : (
        <button type='button' className='btn btn-sm' onClick={onOpen}>
          ＋ Record payment<kbd>r</kbd>
        </button>
      )}
      {owed?.startsWith('-') ? (
        <p className='dev-p warn'>
          ◆ Paid {money(owed.slice(1), currency)} more than the card’s total —
          check the amounts, or add the follow-up it was for.
        </p>
      ) : null}
    </section>
  )
}

function PaymentForm({
  card,
  awaiting,
  today,
  firstKind,
  onCancel,
  onRecord,
}: {
  card: CardData
  awaiting: boolean
  today: string
  firstKind: 'deposit' | 'part'
  onCancel: () => void
  onRecord: (fields: PaymentFields) => Promise<string | null>
}) {
  const currency = card.currency ?? 'THB'
  const [fields, setFields] = useState<PaymentFields>({
    amount: '',
    kind: firstKind,
    receivedOn: today,
    note: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const owed = owedOf(card)
  const share = (pct: number) =>
    card.total ? (Math.round(Number(card.total) * pct) / 100).toFixed(2) : null
  const fill = (amount: string | null) =>
    amount && setFields((now) => ({ ...now, amount }))
  return (
    <form
      className='fcard pay-form'
      autoComplete='off'
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault()
        setPending(true)
        setError(null)
        const refused = await onRecord(fields)
        setPending(false)
        if (refused) setError(refused)
      }}
    >
      <span className='hud-label'>Record a payment</span>
      <label>
        Amount · {currency}
        <input
          type='text'
          inputMode='decimal'
          required
          // biome-ignore lint/a11y/noAutofocus: the form opens to type the amount
          autoFocus
          placeholder='4,000'
          value={fields.amount}
          onChange={(event) =>
            setFields((now) => ({ ...now, amount: event.target.value }))
          }
        />
      </label>
      {card.total ? (
        // biome-ignore lint/a11y/useSemanticElements: a row of fill-in buttons, not a fieldset
        <span
          className='seg pay-chips'
          role='group'
          aria-label='Fill the amount'
        >
          {[30, 50].map((pct) => (
            <button key={pct} type='button' onClick={() => fill(share(pct))}>
              {pct}% · {money(share(pct), currency)}
            </button>
          ))}
          {owed && Number(owed) > 0 ? (
            <button type='button' onClick={() => fill(owed)}>
              the rest · {money(owed, currency)}
            </button>
          ) : null}
        </span>
      ) : null}
      <div className='row'>
        <label style={{ flex: 1 }}>
          Received
          <input
            type='date'
            required
            max={today}
            value={fields.receivedOn}
            onChange={(event) =>
              setFields((now) => ({ ...now, receivedOn: event.target.value }))
            }
          />
        </label>
        <div style={{ flex: 1 }}>
          <span className='fld-label'>Kind</span>
          {/* biome-ignore lint/a11y/useSemanticElements: a two-way toggle, like every .seg */}
          <span className='seg' role='group' aria-label='Kind'>
            {(['deposit', 'part'] as const).map((kind) => (
              <button
                key={kind}
                type='button'
                aria-pressed={fields.kind === kind}
                onClick={() => setFields((now) => ({ ...now, kind }))}
              >
                {kind === 'deposit' ? 'Deposit' : 'Part payment'}
              </button>
            ))}
          </span>
        </div>
      </div>
      <label>
        Note · optional
        <input
          type='text'
          maxLength={200}
          placeholder='มัดจำ 30% · transfer ref …'
          value={fields.note}
          lang={isThai(fields.note) ? 'th' : undefined}
          onChange={(event) =>
            setFields((now) => ({ ...now, note: event.target.value }))
          }
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
          disabled={pending || !fields.amount.trim()}
        >
          {pending ? 'Recording…' : 'Record received'}
          <kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
      <p className='hint'>
        Record it once the bank shows it — it counts as money in on that day
        {awaiting ? '' : ', even before the card reaches Awaiting payment'}.
        Only you can record money.
      </p>
    </form>
  )
}
