'use client'

import { jobDue } from '@theiceji/hq-board/due'
import { KIND_LABEL, type ProjectKind } from '@theiceji/hq-core/modules'
import { formatMoney, sumAmounts } from '@theiceji/hq-core/money'
import { slotNames } from '@theiceji/hq-prompts/template'
import Link from 'next/link'
import {
  type DragEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
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
  Readout,
  Tag,
  usePageKeys,
} from '@/components/bridge/parts'
import { type ClientChoice, ClientPicker } from '@/components/ClientPicker'
import { Confirm } from '@/components/Confirm'
import { Swatches } from '@/components/Swatches'
import { type KeyHint, usePageKeyHints } from '@/components/shell/keys'
import { useToast } from '@/components/Toast'
import { Markdown } from '@/lib/md'
import { refreshAction } from '@/lib/refresh-action'
import {
  finalizeUploadAction,
  prepareUploadAction,
} from '@/modules/assets/actions'
import { measure, put } from '@/modules/assets/upload'
import {
  addFollowupAction,
  archiveCardAction,
  attachFileAction,
  type CardHistory,
  cardHistoryAction,
  createCardAction,
  createClientAction,
  createLaneAction,
  createPromptAction,
  deleteCardAction,
  deleteLaneAction,
  followupArchivedAction,
  markPaidAction,
  moveCardAction,
  moveLaneAction,
  type PromptChoice,
  recordPaymentAction,
  renameLaneAction,
  setPromptAction,
  unlinkAction,
  unmarkPaidAction,
  updateCardAction,
  updateFollowupAction,
  voidPaymentAction,
} from '../actions'
import type {
  CardData,
  ClientOption,
  FollowupData,
  LaneData,
  PaymentData,
} from '../data'
import {
  dayLabel,
  type FileLink,
  FilesBlock,
  FollowupForm,
  FollowupItem,
  FollowupMark,
  owedOf,
  PayMeter,
  PaymentsSection,
  PromptBlock,
  type PromptLink,
  type Uploading,
} from './CardParts'
import type { NewPromptFields } from './PromptPicker'

/**
 * Board: a project's cards in its
 * kind's lanes, or one table of every project's cards, beside an inspector
 * for the selected card. Its instrument is the lane footer — an LCD of the
 * lane's price sum; the pinned awaiting-payment lane's footer is money owed.
 *
 * A card holds a whole client job: a colour stripe, its client (a
 * Clients record or a name used once) faint above the title, follow-ups —
 * work that came after its task, whose prices add into its total — the
 * payments that came in (a deposit of any size or none, parts, the rest at
 * Mark paid), the prompt the job ran on and its files. While a card is
 * dragged, a faint dashed slot stands where it will land.
 *
 * The page keeps its own copy of the cards and writes through server
 * actions; each write answers the card as it now is (its revision for the
 * next write), a refusal puts the card back and says why in a toast.
 *
 * Removing: Delete `⌫` sends a card to the Trash and
 * Archive to Archived, both with Undo; the two views list them with Restore
 * `r`. A lane head opens the lane in the inspector — rename, move, delete
 * (asked in place; a lane that can't go says why) — and `＋ Lane` adds one.
 * Only the lanes you work in scroll; Awaiting payment sits beside them,
 * pinned right, never over one.
 */

export type BoardProject = {
  id: string
  slug: string
  name: string
  color: string
  kind: ProjectKind
  status: 'active' | 'paused' | 'archived'
  currency: string
  /** The project's own date, `YYYY-MM-DD` — "due today" is judged by it. */
  today: string
  /** Its enabled modules — files need Assets; a new prompt goes to Prompts when it's on. */
  modules: string[]
}

export type BoardPageProps = {
  /** One project's board, or every project's cards (`null`) on `/board`. */
  project: BoardProject | null
  /** Projects with Board on (the global page's filter and new-card choice). */
  projects: BoardProject[]
  /** Lanes per project id. */
  lanes: Record<string, LaneData[]>
  cards: CardData[]
  /** The live follow-ups of those cards. */
  followups: FollowupData[]
  /** Their payment lines, voids included. */
  payments: PaymentData[]
  /** Prompts and files per card (the tile's ✎ and ▣). */
  links: { cardId: string; prompts: number; files: number }[]
  /** The owner's clients, archived ones too (they still name old cards). */
  clients: ClientOption[]
  /** Archived and Trash hold those cards instead of the live ones. */
  view: 'lanes' | 'table' | 'archived' | 'trash'
  selectedId: string | null
  /** `?newFor=<client>` from Clients: open New card with that client. */
  newFor: string | null
}

type Panel =
  | { kind: 'followup'; id: string | null }
  | { kind: 'payment' }
  | null

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A card's money as the tile reads it: its total (price + follow-ups). */
const money = (card: Pick<CardData, 'total' | 'currency'>) =>
  card.total && card.currency ? formatMoney(card.total, card.currency) : ''

const amount = (value: string | null, currency: string | null) =>
  value && currency ? formatMoney(value, currency) : ''

const positive = (value: string | null) =>
  value !== null && !value.startsWith('-') && /[1-9]/.test(value)

type Shelf = 'archived' | 'trash' | null

/**
 * What keeps a card out of the Trash, in words where Delete would be:
 * its payments are the record of money that came in.
 */
function keptBecause(card: CardData, shelf: Shelf): string | null {
  if (card.paidAt) return 'Marked paid — kept here for the record.'
  if (positive(card.paidTotal))
    return shelf
      ? 'Money came in — kept for the record.'
      : 'Money came in — void its payments to delete it, or archive it.'
  return null
}

/** Why a lane can't be deleted, in words — null when it can. */
function laneKept(
  lane: LaneData,
  lanes: LaneData[],
  liveCards: number,
): string | null {
  if (lane.role === 'awaiting_payment')
    return 'Holds what is owed — rename it instead.'
  if (liveCards > 0)
    return `Move its ${liveCards === 1 ? 'card' : `${liveCards} cards`} first.`
  if (lanes.length <= 1) return 'A board keeps one lane at least.'
  if (
    !lanes.some(
      (other) => other.id !== lane.id && other.role !== 'awaiting_payment',
    )
  )
    return 'The last lane to work in stays.'
  return null
}

export function BoardPage(props: BoardPageProps) {
  const toast = useToast()
  const [cards, setCards] = useState(props.cards)
  const [followups, setFollowups] = useState(props.followups)
  const [payments, setPayments] = useState(props.payments)
  const [clients, setClients] = useState(props.clients)
  const [selected, setSelected] = useState<string | null>(props.selectedId)
  const [label, setLabel] = useState('all')
  const [who, setWho] = useState('all')
  const [creating, setCreating] = useState<{
    laneId: string | null
    projectId: string | null
    client: ClientChoice | null
  } | null>(null)
  const [editing, setEditing] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overLane, setOverLane] = useState<string | null>(null)
  const [slot, setSlot] = useState<{
    laneId: string
    index: number
    height: number
  } | null>(null)
  const dragHeight = useRef(44)
  const [currentLane, setCurrentLane] = useState<string | null>(null)
  /** A lane opened in the inspector from its head; `＋ Lane` opens a new one. */
  const [laneSel, setLaneSel] = useState<string | null>(null)
  const [addingLane, setAddingLane] = useState(false)
  /** Delete lane's question is up — `⌫` and the button ask the same one. */
  const [askingLane, setAskingLane] = useState(false)
  const renameRef = useRef<HTMLInputElement>(null)
  const paneRef = useRef<HTMLElement>(null)
  const runRef = useRef<HTMLDivElement>(null)
  const all = props.project === null
  const view = all && props.view === 'lanes' ? 'table' : props.view
  const shelf: Shelf = view === 'archived' || view === 'trash' ? view : null

  // A fresh server render (after an action revalidated) replaces the local copies.
  useEffect(() => setCards(props.cards), [props.cards])
  useEffect(() => setFollowups(props.followups), [props.followups])
  useEffect(() => setPayments(props.payments), [props.payments])
  useEffect(() => setClients(props.clients), [props.clients])
  // Writes run one after another, each with the revision the last one left —
  // so `]]]` moves a card three lanes instead of tripping over itself.
  const cardsRef = useRef(cards)
  cardsRef.current = cards
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const enqueue = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(work, work)
    queue.current = next.catch(() => {})
    return next
  }
  const latest = (id: string) =>
    cardsRef.current.find((card) => card.id === id) ?? null

  const projectOf = useCallback(
    (id: string | null) =>
      props.projects.find((project) => project.id === id) ?? props.project,
    [props.projects, props.project],
  )
  const lanesOf = useCallback(
    (projectId: string | null) =>
      projectId ? (props.lanes[projectId] ?? []) : [],
    [props.lanes],
  )
  const laneOf = useCallback(
    (card: CardData) =>
      lanesOf(card.projectId).find((lane) => lane.id === card.laneId) ?? null,
    [lanesOf],
  )
  const awaitingLane = (projectId: string | null) =>
    lanesOf(projectId).find((lane) => lane.role === 'awaiting_payment') ?? null

  const followupsOf = useMemo(() => {
    const map = new Map<string, FollowupData[]>()
    for (const entry of followups)
      map.set(entry.cardId, [...(map.get(entry.cardId) ?? []), entry])
    return (cardId: string) => map.get(cardId) ?? []
  }, [followups])
  const paymentsOf = useMemo(() => {
    const map = new Map<string, PaymentData[]>()
    for (const entry of payments)
      map.set(entry.cardId, [...(map.get(entry.cardId) ?? []), entry])
    return (cardId: string) => map.get(cardId) ?? []
  }, [payments])
  const linksOf = useMemo(() => {
    const map = new Map(props.links.map((entry) => [entry.cardId, entry]))
    return (cardId: string) => map.get(cardId) ?? null
  }, [props.links])
  const clientName = useCallback(
    (card: Pick<CardData, 'clientId' | 'client'>) =>
      card.clientId
        ? (clients.find((client) => client.id === card.clientId)?.name ?? null)
        : card.client,
    [clients],
  )

  const live = useMemo(() => cards.filter((card) => !card.archivedAt), [cards])
  // Archived and Trash list their own cards; a card restored or deleted
  // from here leaves the list at once.
  const listed = useMemo(
    () =>
      shelf === 'trash'
        ? cards.filter((card) => card.deletedAt)
        : shelf === 'archived'
          ? cards.filter((card) => card.archivedAt && !card.deletedAt)
          : live,
    [cards, live, shelf],
  )
  const clientCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const card of live)
      if (card.clientId)
        counts[card.clientId] = (counts[card.clientId] ?? 0) + 1
    return counts
  }, [live])
  const scope = useMemo(
    () =>
      all
        ? listed.filter((card) => who === 'all' || card.projectId === who)
        : listed,
    [all, listed, who],
  )
  const labels = useMemo(
    () => [...new Set(scope.flatMap((card) => card.labels))].sort(),
    [scope],
  )
  const activeLabel = label !== 'all' && !labels.includes(label) ? 'all' : label
  const visible = useMemo(() => {
    const shown = scope.filter(
      (card) => activeLabel === 'all' || card.labels.includes(activeLabel),
    )
    // Archived and Trash keep the server's order: newest first.
    if (shelf) return shown
    const order = (card: CardData) => {
      const lane = laneOf(card)
      const projectIndex = props.projects.findIndex(
        (project) => project.id === card.projectId,
      )
      return [projectIndex, lane?.position ?? 0, card.position]
    }
    return [...shown].sort((a, b) => {
      const [pa = 0, la = 0, ca = 0] = order(a)
      const [pb = 0, lb = 0, cb = 0] = order(b)
      return pa - pb || la - lb || ca - cb
    })
  }, [scope, activeLabel, laneOf, props.projects, shelf])

  const current = listed.find((card) => card.id === selected) ?? null
  const project = props.project
  const lanesHere = project ? lanesOf(project.id) : []
  const selectedLane = lanesHere.find((lane) => lane.id === laneSel) ?? null

  const select = useCallback((id: string | null, focus = false) => {
    setSelected(id)
    setCreating(null)
    setEditing(false)
    setPanel(null)
    setLaneSel(null)
    setAddingLane(false)
    setAskingLane(false)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('card', id)
    else url.searchParams.delete('card')
    url.searchParams.delete('newFor')
    window.history.replaceState(null, '', url)
    if (focus && id)
      requestAnimationFrame(() => {
        const element = paneRef.current?.querySelector<HTMLElement>(
          `[data-id="${id}"]`,
        )
        element?.focus({ preventScroll: true })
        element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      })
  }, [])

  /** A lane in the inspector instead of a card; null goes back to the cards. */
  const selectLane = (id: string | null) => {
    setLaneSel(id)
    setAskingLane(false)
    setAddingLane(false)
    setCreating(null)
    setEditing(false)
    setPanel(null)
    if (!id) return
    setSelected(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('card')
    window.history.replaceState(null, '', url)
  }

  const patch = (next: CardData) => {
    // The ref first: the next queued write reads it before React re-renders.
    cardsRef.current = cardsRef.current.map((card) =>
      card.id === next.id ? next : card,
    )
    setCards((list) => list.map((card) => (card.id === next.id ? next : card)))
  }

  /** Run a write; on refusal restore `before` and say why. */
  const write = async <T,>(
    before: CardData[],
    work: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
  ): Promise<T | null> => {
    const result = await work()
    if (!result.ok) {
      setCards(before)
      toast(result.error)
      return null
    }
    return result.data
  }

  const move = (card: CardData, lane: LaneData, index?: number) => {
    const from = laneOf(card)
    if (!from || (from.id === lane.id && index === undefined))
      return Promise.resolve()
    const before = cards
    // Optimistic: the card lands at the end (or the index) of its new lane.
    setCards((list) => {
      const rest = list.filter((entry) => entry.id !== card.id)
      const target = rest
        .filter((entry) => entry.laneId === lane.id && !entry.archivedAt)
        .sort((a, b) => a.position - b.position)
      const at =
        index === undefined ? target.length : Math.min(index, target.length)
      target.splice(at, 0, { ...card, laneId: lane.id })
      const placed = new Map(
        target.map((entry, position) => [entry.id, position]),
      )
      return [
        ...rest.map((entry) =>
          placed.has(entry.id)
            ? { ...entry, position: placed.get(entry.id) ?? 0 }
            : entry,
        ),
        { ...card, laneId: lane.id, position: placed.get(card.id) ?? 0 },
      ]
    })
    return enqueue(async () => {
      const saved = await write(before, () =>
        moveCardAction({
          cardId: card.id,
          expectedRevision: latest(card.id)?.revision ?? card.revision,
          laneId: lane.id,
          position: index,
        }),
      )
      if (!saved) return
      patch(saved)
      if (from.id !== lane.id)
        toast(`Moved to ${lane.name}: ${card.title}`, {
          undo: async () => {
            const back = await moveCardAction({
              cardId: saved.id,
              expectedRevision: saved.revision,
              laneId: from.id,
            })
            if (back.ok) {
              patch(back.data)
            } else toast(back.error)
          },
        })
    })
  }

  const step = (card: CardData, direction: -1 | 1) => {
    const lanes = lanesOf(card.projectId)
    const index = lanes.findIndex((lane) => lane.id === card.laneId)
    const next = lanes[index + direction]
    if (next) void move(card, next)
  }

  const markPaid = async (card: CardData) => {
    const lane = laneOf(card)
    if (lane?.role !== 'awaiting_payment') {
      toast('Only cards in Awaiting payment can be marked paid.')
      return
    }
    const before = cards
    const rest = owedOf(latest(card.id) ?? card)
    const index = visible.findIndex((entry) => entry.id === card.id)
    const next = visible[index + 1] ?? visible[index - 1] ?? null
    setCards((list) =>
      list.map((entry) =>
        entry.id === card.id
          ? { ...entry, archivedAt: new Date().toISOString() }
          : entry,
      ),
    )
    const paid = await enqueue(() =>
      write(before, () =>
        markPaidAction({
          cardId: card.id,
          expectedRevision: latest(card.id)?.revision ?? card.revision,
        }),
      ),
    )
    if (!paid) return
    patch(paid)
    select(next?.id ?? null)
    toast(
      `Paid${positive(rest) ? ` the rest, ${amount(rest, card.currency)}` : ''}: ${card.title}${card.total ? ` — ${money(card)} in all` : ''}, archived`,
      {
        undo: async () => {
          const back = await unmarkPaidAction({
            cardId: paid.id,
            expectedRevision: paid.revision,
          })
          if (back.ok) {
            patch(back.data)
            select(back.data.id)
          } else toast(back.error)
        },
      },
    )
  }

  const archive = async (card: CardData) => {
    const before = cards
    setCards((list) =>
      list.map((entry) =>
        entry.id === card.id
          ? { ...entry, archivedAt: new Date().toISOString() }
          : entry,
      ),
    )
    const done = await enqueue(() =>
      write(before, () =>
        archiveCardAction({
          cardId: card.id,
          expectedRevision: latest(card.id)?.revision ?? card.revision,
          archived: true,
        }),
      ),
    )
    if (!done) return
    patch(done)
    select(null)
    toast(`Archived: ${card.title}`, {
      undo: async () => {
        const back = await archiveCardAction({
          cardId: done.id,
          expectedRevision: done.revision,
          archived: false,
        })
        if (back.ok) {
          patch(back.data)
          select(back.data.id)
        } else toast(back.error)
      },
    })
  }

  /** Delete `⌫`: to the Trash, never asked — Undo and Restore bring it back. */
  const remove = async (card: CardData) => {
    const kept = keptBecause(card, shelf)
    if (kept) {
      toast(kept)
      return
    }
    const before = cards
    const index = visible.findIndex((entry) => entry.id === card.id)
    const next = visible[index + 1] ?? visible[index - 1] ?? null
    const now = new Date().toISOString()
    setCards((list) =>
      list.map((entry) =>
        entry.id === card.id
          ? { ...entry, archivedAt: entry.archivedAt ?? now, deletedAt: now }
          : entry,
      ),
    )
    const done = await enqueue(() =>
      write(before, () =>
        deleteCardAction({
          cardId: card.id,
          expectedRevision: latest(card.id)?.revision ?? card.revision,
          deleted: true,
        }),
      ),
    )
    if (!done) return
    patch(done)
    select(next?.id ?? null)
    toast(`Moved to Trash: ${card.title}`, {
      undo: async () => {
        const back = await deleteCardAction({
          cardId: done.id,
          expectedRevision: done.revision,
          deleted: false,
        })
        if (back.ok) {
          patch(back.data)
          select(back.data.id)
        } else toast(back.error)
      },
    })
  }

  /** Restore `r`: out of the Trash (back where Delete found it) or out of Archived. */
  const restore = async (card: CardData) => {
    const fromTrash = card.deletedAt !== null
    if (!fromTrash && card.paidAt) {
      toast('Marked paid — kept here for the record.')
      return
    }
    const before = cards
    const index = visible.findIndex((entry) => entry.id === card.id)
    const next = visible[index + 1] ?? visible[index - 1] ?? null
    setCards((list) =>
      list.map((entry) =>
        entry.id === card.id
          ? fromTrash
            ? { ...entry, deletedAt: null }
            : { ...entry, archivedAt: null }
          : entry,
      ),
    )
    const done = await enqueue(() =>
      write(before, () => {
        // Read when the write runs: an earlier queued write may have moved it on.
        const expectedRevision = latest(card.id)?.revision ?? card.revision
        return fromTrash
          ? deleteCardAction({
              cardId: card.id,
              expectedRevision,
              deleted: false,
            })
          : archiveCardAction({
              cardId: card.id,
              expectedRevision,
              archived: false,
            })
      }),
    )
    if (!done) return
    patch(done)
    select(next?.id ?? null)
    toast(
      `Restored to ${done.archivedAt ? 'Archived' : (laneOf(done)?.name ?? 'the board')}: ${card.title}`,
      {
        undo: async () => {
          const back = fromTrash
            ? await deleteCardAction({
                cardId: done.id,
                expectedRevision: done.revision,
                deleted: true,
              })
            : await archiveCardAction({
                cardId: done.id,
                expectedRevision: done.revision,
                archived: true,
              })
          if (back.ok) {
            patch(back.data)
            select(back.data.id)
          } else toast(back.error)
        },
      },
    )
  }

  /* ── lanes: the owner's to shape (every lane write re-renders the page) ── */

  const addLane = async (name: string): Promise<string | null> => {
    if (!project) return null
    const result = await createLaneAction({ projectId: project.id, name })
    if (!result.ok) return result.error
    const lane = result.data
    selectLane(lane.id)
    toast(`Lane added: ${lane.name}`, {
      undo: async () => {
        const back = await deleteLaneAction({ laneId: lane.id })
        if (back.ok) setLaneSel((now) => (now === lane.id ? null : now))
        else toast(back.error)
      },
    })
    return null
  }

  const renameLane = async (
    lane: LaneData,
    name: string,
  ): Promise<string | null> => {
    const result = await renameLaneAction({ laneId: lane.id, name })
    if (!result.ok) return result.error
    if (result.data.name === lane.name) return null
    toast(`Renamed lane: ${lane.name} → ${result.data.name}`, {
      undo: async () => {
        const back = await renameLaneAction({
          laneId: lane.id,
          name: lane.name,
        })
        if (!back.ok) toast(back.error)
      },
    })
    return null
  }

  const shiftLane = (lane: LaneData, direction: -1 | 1) =>
    enqueue(async () => {
      const result = await moveLaneAction({ laneId: lane.id, direction })
      if (!result.ok) {
        toast(result.error)
        return
      }
      toast(`Moved lane ${direction < 0 ? 'left' : 'right'}: ${lane.name}`, {
        undo: async () => {
          const back = await moveLaneAction({
            laneId: lane.id,
            direction: direction < 0 ? 1 : -1,
          })
          if (!back.ok) toast(back.error)
        },
      })
    })

  const removeLane = async (lane: LaneData) => {
    const result = await deleteLaneAction({ laneId: lane.id })
    if (!result.ok) {
      toast(result.error)
      return
    }
    selectLane(null)
    const { moved, into } = result.data
    toast(
      `Deleted lane: ${lane.name}${moved && into ? ` — ${plural(moved, 'card')} from Archived and Trash now sit in ${into}` : ''}`,
    )
  }

  const openAddLane = () => {
    select(null)
    setAddingLane(true)
  }

  /** The card's colour, at once, with Undo. */
  const recolor = async (card: CardData, color: string | null) => {
    if ((card.color ?? null) === color) return
    const before = card.color
    const saved = await enqueue(() =>
      write(cards, () =>
        updateCardAction({
          cardId: card.id,
          expectedRevision: latest(card.id)?.revision ?? card.revision,
          color,
        }),
      ),
    )
    if (!saved) return
    patch(saved)
    toast(
      color
        ? `Colour: ${color} — ${card.title}`
        : `Colour cleared — ${card.title}`,
      {
        undo: async () => {
          const back = await updateCardAction({
            cardId: saved.id,
            expectedRevision: saved.revision,
            color: before,
          })
          if (back.ok) {
            patch(back.data)
          } else toast(back.error)
        },
      },
    )
  }

  const openNew = (
    laneId: string | null,
    client: ClientChoice | null = null,
  ) => {
    if (all && props.projects.length === 0) return
    setEditing(false)
    setPanel(null)
    setAddingLane(false)
    setAskingLane(false)
    setCreating({
      laneId,
      client,
      projectId: all
        ? who !== 'all'
          ? who
          : (props.projects[0]?.id ?? null)
        : (props.project?.id ?? null),
    })
  }

  // ?newFor=<client> from Clients: New card with that client, once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival
  useEffect(() => {
    if (!props.newFor) return
    const client = props.clients.find((entry) => entry.id === props.newFor)
    if (client) openNew(null, { id: client.id, name: client.name })
  }, [])

  // #lane-<i> from the project map: bring the lane into view and mark it a moment.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival
  useEffect(() => {
    if (all || !props.project) return
    const match = /^#lane-(\d+)$/.exec(window.location.hash)
    const lane = match ? lanesOf(props.project.id)[Number(match[1])] : null
    if (!lane) return
    setCurrentLane(lane.id)
    paneRef.current
      ?.querySelector(`[data-lane="${lane.id}"]`)
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    const first = live.find((card) => card.laneId === lane.id)
    if (first) setSelected(first.id)
    const timer = setTimeout(() => setCurrentLane(null), 1800)
    return () => clearTimeout(timer)
  }, [])

  // The run's sideways scrollbar takes its height from the run's lanes only;
  // the pinned lane beside the run gives up the same, so every lane footer
  // stays on one line. Zero wherever scrollbars overlay or the run doesn't
  // scroll (≤ 720, where lanes stack).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the run is there in the Lanes view only
  useEffect(() => {
    const run = runRef.current
    if (!run) return
    const sync = () =>
      run.parentElement?.style.setProperty(
        '--run-bar',
        `${run.offsetHeight - run.clientHeight}px`,
      )
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(run)
    return () => observer.disconnect()
  }, [view])

  const awaitingHere = current
    ? laneOf(current)?.role === 'awaiting_payment'
    : false
  // Only the keys that work here: `/board` has no lanes,
  // and the views are its own count — `/board` has no Lanes view.
  const views: KeyHint = [all ? '1–3' : '1–4', 'views']
  const deleteKey = (key: string) => key === 'Backspace' || key === 'Delete'
  const liveIn = (laneId: string) =>
    live.filter((card) => card.laneId === laneId).length
  usePageKeyHints(
    shelf
      ? [
          ['r', 'restore'],
          ...(shelf === 'archived' ? ([['⌫', 'delete']] as const) : []),
          ['↑ ↓', 'cards'],
          views,
        ]
      : selectedLane
        ? [
            ['e', 'rename'],
            ['[ ]', 'move lane'],
            ['⌫', 'delete lane'],
            ['c', 'card here'],
            ['Esc', 'back to cards'],
            views,
          ]
        : [
            ['c', 'new card'],
            ['f', 'follow-up'],
            ['[ ]', 'move'],
            ...(awaitingHere ? ([['m', 'mark paid']] as const) : []),
            ['r', 'payment'],
            ['p', 'prompt'],
            ['y', 'copy prompt'],
            ['u', 'files'],
            ['e', 'edit'],
            ['⌫', 'delete'],
            ['↑ ↓', 'cards'],
            ...(view === 'lanes' ? ([['← →', 'lanes']] as const) : []),
            views,
          ],
  )

  usePageKeys((key) => {
    if (key === 'Escape') {
      if (creating) {
        setCreating(null)
        return true
      }
      if (addingLane) {
        setAddingLane(false)
        return true
      }
      if (laneSel) {
        selectLane(null)
        return true
      }
      if (panel) {
        setPanel(null)
        return true
      }
      if (editing) {
        setEditing(false)
        return true
      }
      if (selected) {
        select(null)
        return true
      }
      return false
    }
    if (!shelf && selectedLane) {
      if (key === 'e') {
        renameRef.current?.focus()
        renameRef.current?.select()
        return true
      }
      if (key === '[' || key === ']') {
        if (selectedLane.role !== 'awaiting_payment')
          void shiftLane(selectedLane, key === '[' ? -1 : 1)
        return true
      }
      if (deleteKey(key)) {
        const kept = laneKept(selectedLane, lanesHere, liveIn(selectedLane.id))
        if (kept) toast(kept)
        else setAskingLane(true)
        return true
      }
      if (key === 'c') {
        openNew(selectedLane.id)
        return true
      }
    }
    if (key === 'c' && !shelf) {
      openNew(current?.laneId ?? null)
      return true
    }
    if (visible.length === 0) return false
    const index = visible.findIndex((card) => card.id === selected)
    if (key === 'ArrowDown' || key === 'j') {
      select(visible[Math.min(visible.length - 1, index + 1)]?.id ?? null, true)
      return true
    }
    if (key === 'ArrowUp' || key === 'k') {
      select(visible[Math.max(0, index - 1)]?.id ?? null, true)
      return true
    }
    if (shelf) {
      if (!current) return false
      if (key === 'r') {
        void restore(current)
        return true
      }
      if (deleteKey(key) && shelf === 'archived') {
        void remove(current)
        return true
      }
      return false
    }
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && view === 'lanes') {
      const base = current ?? visible[0]
      if (!base) return false
      const lanes = lanesOf(base.projectId)
      const at = lanes.findIndex((lane) => lane.id === base.laneId)
      const direction = key === 'ArrowRight' ? 1 : -1
      const row = visible
        .filter((card) => card.laneId === base.laneId)
        .indexOf(base)
      for (let l = at + direction; l >= 0 && l < lanes.length; l += direction) {
        const inLane = visible.filter((card) => card.laneId === lanes[l]?.id)
        if (inLane.length) {
          select(
            inLane[Math.min(Math.max(row, 0), inLane.length - 1)]?.id ?? null,
            true,
          )
          return true
        }
      }
      return true
    }
    if (!current) {
      if (key === 'Enter') {
        select(visible[0]?.id ?? null, true)
        return true
      }
      return false
    }
    if (key === '[') {
      step(current, -1)
      return true
    }
    if (key === ']') {
      step(current, 1)
      return true
    }
    if (key === 'm') {
      void markPaid(current)
      return true
    }
    if (key === 'e') {
      setPanel(null)
      setEditing(true)
      return true
    }
    if (key === 'f') {
      setEditing(false)
      setPanel({ kind: 'followup', id: null })
      return true
    }
    if (key === 'r') {
      setEditing(false)
      setPanel({ kind: 'payment' })
      return true
    }
    if (deleteKey(key)) {
      void remove(current)
      return true
    }
    const click = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) return false
      element.scrollIntoView({ block: 'nearest' })
      element.click()
      return true
    }
    if (key === 'p') return click('#card-prompt')
    if (key === 'y') return click('#card-prompt-copy')
    if (key === 'u') return click('input[data-card-files="card"]')
    return false
  })

  /* ── drag across lanes (the keyboard path is [ and ]) ──
     While dragging, a faint dashed slot stands where the card will land: its
     index comes from the pointer against the other cards' midpoints, so a
     drop in a gap, on a card or under the last one lands where it's drawn. */
  const onDragStart = (event: DragEvent, card: CardData) => {
    setDragId(card.id)
    dragHeight.current = (event.currentTarget as HTMLElement).offsetHeight
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', card.id)
  }
  const endDrag = () => {
    setDragId(null)
    setOverLane(null)
    setSlot(null)
  }
  const onLaneOver = (event: DragEvent<HTMLElement>, lane: LaneData) => {
    if (!dragId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (overLane !== lane.id) setOverLane(lane.id)
    const tiles = [
      ...event.currentTarget.querySelectorAll<HTMLElement>('.bcard'),
    ].filter((tile) => tile.dataset.id !== dragId)
    let index = tiles.length
    for (const [at, tile] of tiles.entries()) {
      const rect = tile.getBoundingClientRect()
      if (event.clientY < rect.top + rect.height / 2) {
        index = at
        break
      }
    }
    if (slot?.laneId !== lane.id || slot.index !== index)
      setSlot({ laneId: lane.id, index, height: dragHeight.current })
  }
  const onDrop = (event: DragEvent, lane: LaneData, shown: CardData[]) => {
    event.preventDefault()
    const card = live.find((entry) => entry.id === dragId)
    const at = slot?.laneId === lane.id ? slot.index : null
    endDrag()
    if (!card) return
    // The slot's index counts the shown cards; the move counts the whole lane.
    const others = live
      .filter((entry) => entry.laneId === lane.id && entry.id !== card.id)
      .sort((a, b) => a.position - b.position)
    const target =
      at === null ? null : shown.filter((entry) => entry.id !== card.id)[at]
    const index = target ? others.indexOf(target) : others.length
    // Dropped back where it was: nothing to write.
    if (card.laneId === lane.id && index === card.position) return
    void move(card, lane, index)
  }

  const awaitingId = project ? awaitingLane(project.id)?.id : null
  const owedCards = awaitingId
    ? live.filter(
        (card) =>
          card.laneId === awaitingId &&
          card.total &&
          card.currency === project?.currency,
      )
    : []
  const owedSum =
    project && owedCards.length
      ? sumAmounts(
          owedCards.map((card) => {
            const owed = owedOf(card)
            return owed && !owed.startsWith('-') ? owed : '0'
          }),
          project.currency,
        )
      : null
  const owedHere =
    project && owedSum && /[1-9]/.test(owedSum)
      ? formatMoney(owedSum, project.currency)
      : null

  const tile = (card: CardData, lane: LaneData) => (
    <CardTile
      key={card.id}
      card={card}
      client={clientName(card)}
      followups={followupsOf(card.id)}
      links={linksOf(card.id)}
      selected={card.id === selected}
      today={projectOf(card.projectId)?.today ?? ''}
      awaiting={lane.role === 'awaiting_payment'}
      dragging={dragId === card.id}
      onSelect={() => select(card.id)}
      onDragStart={(event) => onDragStart(event, card)}
      onDragEnd={endDrag}
    />
  )
  const slotAt = (laneId: string) =>
    slot?.laneId === laneId ? (
      <div
        key='drop-slot'
        className='drop-slot'
        aria-hidden='true'
        style={{ height: slot.height }}
      />
    ) : null

  const laneColumn = (lane: LaneData, currency: string) => {
    const inLane = live
      .filter((card) => card.laneId === lane.id)
      .sort((a, b) => a.position - b.position)
    const shown = inLane.filter(
      (card) => activeLabel === 'all' || card.labels.includes(activeLabel),
    )
    const body: ReactNode[] = []
    let other = 0
    for (const card of shown) {
      if (card.id !== dragId && other === slot?.index)
        body.push(slotAt(lane.id))
      body.push(tile(card, lane))
      if (card.id !== dragId) other++
    }
    if (slot?.laneId === lane.id && slot.index >= other)
      body.push(slotAt(lane.id))
    const count =
      activeLabel !== 'all' && shown.length !== inLane.length
        ? `${shown.length} of ${inLane.length}`
        : String(inLane.length)
    return (
      <section
        key={lane.id}
        data-lane={lane.id}
        className={`lane${lane.role === 'awaiting_payment' ? ' awaiting' : ''}${overLane === lane.id ? ' over' : ''}${currentLane === lane.id ? ' current' : ''}${laneSel === lane.id ? ' sel' : ''}`}
        aria-label={`${lane.name} · ${inLane.length} ${inLane.length === 1 ? 'card' : 'cards'}`}
        onDragOver={(event) => onLaneOver(event, lane)}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setOverLane(null)
            setSlot((now) => (now?.laneId === lane.id ? null : now))
          }
        }}
        onDrop={(event) => onDrop(event, lane, shown)}
      >
        <header className='lane-head'>
          {/* The head opens the lane in the inspector: rename, move, delete. */}
          <button
            type='button'
            className='lane-pick'
            aria-pressed={laneSel === lane.id}
            aria-label={`Lane ${lane.name}, ${count} ${inLane.length === 1 ? 'card' : 'cards'} — open in the inspector`}
            onClick={() => selectLane(laneSel === lane.id ? null : lane.id)}
          >
            <span className='hud-label'>{lane.name}</span>
            <span className='n'>{count}</span>
            {lane.role === 'awaiting_payment' ? (
              <span className='role'>pinned</span>
            ) : null}
          </button>
        </header>
        <div className='lane-body' role='listbox' aria-label={lane.name}>
          {inLane.length === 0 ? (
            <>
              {slot?.laneId === lane.id ? (
                slotAt(lane.id)
              ) : (
                <Empty>○ nothing yet</Empty>
              )}
              <button
                type='button'
                className='ghost'
                onClick={() => openNew(lane.id)}
              >
                ＋ Card here
              </button>
            </>
          ) : shown.length === 0 ? (
            slot?.laneId === lane.id ? (
              slotAt(lane.id)
            ) : (
              <Empty>no “{activeLabel}” here</Empty>
            )
          ) : (
            body
          )}
        </div>
        <footer className='lane-foot'>
          <LaneReadout lane={lane} cards={inLane} currency={currency} />
        </footer>
      </section>
    )
  }

  const shelfWord = shelf === 'trash' ? 'Trash' : 'Archived'

  return (
    <div
      className={`page boardp${project?.status === 'paused' ? ' paused' : ''}`}
    >
      <section
        className='pane board-pane'
        aria-label={all ? 'All cards' : 'Lanes'}
        ref={paneRef}
      >
        <PaneHead
          title={
            all ? (
              `All projects · Board${shelf ? ` · ${shelfWord}` : ''}`
            ) : (
              <>
                {project ? <Dot color={project.color} /> : null} Board
                {shelf ? ` · ${shelfWord}` : ''}
              </>
            )
          }
          meta={
            shelf
              ? `${listed.length} ${shelf === 'trash' ? 'deleted' : 'archived'}`
              : all
                ? `${plural(live.length, 'card')} · ${plural(props.projects.length, 'project')} · table only`
                : `${plural(live.length, 'card')} · ${plural(lanesHere.length, 'lane')}${owedHere ? ` · ${owedHere} awaiting` : ''}${project?.status === 'paused' ? ' · paused' : ''}`
          }
        />
        <div className='toolbar'>
          {all ? (
            // biome-ignore lint/a11y/useSemanticElements: a filter bar is a group of toggle buttons
            <span className='filter' role='group' aria-label='Project'>
              <button
                type='button'
                aria-pressed={who === 'all'}
                onClick={() => setWho('all')}
              >
                All
              </button>
              {props.projects.map((entry) => (
                <button
                  key={entry.id}
                  type='button'
                  aria-pressed={who === entry.id}
                  onClick={() => setWho(entry.id)}
                >
                  <Dot color={entry.color} />
                  <Name text={entry.name} />
                </button>
              ))}
            </span>
          ) : null}
          {labels.length > 0 ? (
            // biome-ignore lint/a11y/useSemanticElements: a filter bar is a group of toggle buttons
            <span className='filter' role='group' aria-label='Label'>
              <button
                type='button'
                aria-pressed={activeLabel === 'all'}
                onClick={() => setLabel('all')}
              >
                All labels
              </button>
              {labels.map((entry) => (
                <button
                  key={entry}
                  type='button'
                  aria-pressed={activeLabel === entry}
                  onClick={() => setLabel(entry)}
                >
                  <span lang={isThai(entry) ? 'th' : undefined}>{entry}</span>
                </button>
              ))}
            </span>
          ) : null}
          <span className='sp' />
          <span className='hits'>
            {visible.length} of {plural(scope.length, 'card')}
          </span>
          {shelf ? null : (
            <button
              type='button'
              className='btn btn-sm'
              onClick={() => openNew(null)}
              disabled={all && props.projects.length === 0}
            >
              ＋ New card<kbd>c</kbd>
            </button>
          )}
        </div>
        {all && !shelf ? (
          <GlobalReadout
            projects={props.projects}
            cards={live}
            lanes={props.lanes}
          />
        ) : null}
        <div className='pane-body'>
          {shelf ? (
            <>
              <p className='shelf-note'>
                {shelf === 'trash'
                  ? 'Deleted cards stay here until you restore them. Their history and payments are kept.'
                  : 'Finished cards, kept for the record.'}
              </p>
              <CardTable
                cards={visible}
                all={all}
                selected={selected}
                projectOf={projectOf}
                laneOf={laneOf}
                clientName={clientName}
                followupsOf={followupsOf}
                onSelect={(id) => select(id)}
                shelved={{
                  label: shelf === 'trash' ? 'deleted' : 'archived',
                  at: (card) =>
                    shelf === 'trash' ? card.deletedAt : card.archivedAt,
                }}
                emptyText={
                  scope.length
                    ? `No “${activeLabel}” cards here.`
                    : '○ nothing here'
                }
              />
            </>
          ) : view === 'table' ? (
            <CardTable
              cards={visible}
              all={all}
              selected={selected}
              projectOf={projectOf}
              laneOf={laneOf}
              clientName={clientName}
              followupsOf={followupsOf}
              onSelect={(id) => select(id)}
              emptyText={
                scope.length
                  ? `No “${activeLabel}” cards here.`
                  : '○ nothing yet — press c for the first card.'
              }
            />
          ) : project ? (
            // The lanes you work in scroll sideways in their own run; the
            // awaiting-payment lane sits beside the run, pinned right, so no
            // lane is ever drawn under it.
            <div className='lanes'>
              <div className='lanes-run' ref={runRef}>
                {lanesHere
                  .filter((lane) => lane.role !== 'awaiting_payment')
                  .map((lane) => laneColumn(lane, project.currency))}
                <button
                  type='button'
                  className={`pcard ghost lane-add${addingLane ? ' sel' : ''}`}
                  onClick={openAddLane}
                >
                  ＋ Lane
                </button>
              </div>
              {lanesHere
                .filter((lane) => lane.role === 'awaiting_payment')
                .map((lane) => laneColumn(lane, project.currency))}
            </div>
          ) : null}
        </div>
      </section>
      <Inspector
        id='board'
        label={
          creating
            ? 'New card'
            : addingLane
              ? 'New lane'
              : selectedLane
                ? 'Selected lane'
                : 'Selected card'
        }
        empty={!current && !creating && !addingLane && !selectedLane}
        onClose={() => select(null)}
      >
        {creating ? (
          <NewCard
            key={`${creating.projectId}-${creating.laneId}-${creating.client?.id ?? ''}`}
            projects={all ? props.projects : project ? [project] : []}
            lanesOf={lanesOf}
            initial={creating}
            clients={clients}
            clientCounts={clientCounts}
            onClientCreated={(client) =>
              setClients((list) => [...list, client])
            }
            onCancel={() => setCreating(null)}
            onCreated={(card) => {
              setCards((list) => [...list, card])
              select(card.id, true)
              const lane = lanesOf(card.projectId).find(
                (entry) => entry.id === card.laneId,
              )
              toast(
                `Card created in ${lane?.name ?? 'the board'}: ${card.title}`,
                {
                  // Undoing a new card deletes it: it wasn't finished work.
                  undo: async () => {
                    const back = await deleteCardAction({
                      cardId: card.id,
                      expectedRevision:
                        latest(card.id)?.revision ?? card.revision,
                      deleted: true,
                    })
                    if (back.ok) {
                      patch(back.data)
                      select(null)
                    } else toast(back.error)
                  },
                },
              )
            }}
          />
        ) : addingLane && project ? (
          <NewLane
            project={project}
            lanes={lanesHere}
            onCancel={() => setAddingLane(false)}
            onCreate={addLane}
          />
        ) : selectedLane && project ? (
          <LaneInspector
            key={selectedLane.id}
            project={project}
            lane={selectedLane}
            lanes={lanesHere}
            cards={live.filter((card) => card.laneId === selectedLane.id)}
            asking={askingLane}
            onAsking={setAskingLane}
            renameRef={renameRef}
            onClose={() => selectLane(null)}
            onRename={(name) => renameLane(selectedLane, name)}
            onMove={(direction) => void shiftLane(selectedLane, direction)}
            onDelete={() => removeLane(selectedLane)}
            onNewCard={() => openNew(selectedLane.id)}
          />
        ) : current && shelf ? (
          <ShelfInspector
            key={current.id}
            card={current}
            shelf={shelf}
            project={projectOf(current.projectId)}
            lanes={lanesOf(current.projectId)}
            client={clientName(current)}
            followups={followupsOf(current.id)}
            onClose={() => select(null)}
            onRestore={() => void restore(current)}
            onDelete={() => void remove(current)}
          />
        ) : current ? (
          <CardInspector
            key={current.id}
            card={current}
            project={projectOf(current.projectId)}
            lanes={lanesOf(current.projectId)}
            client={clientName(current)}
            clientId={current.clientId}
            clients={clients}
            clientCounts={clientCounts}
            followups={followupsOf(current.id)}
            payments={paymentsOf(current.id)}
            editing={editing}
            panel={panel}
            latest={() => latest(current.id) ?? current}
            onClose={() => select(null)}
            onEdit={(on) => {
              setPanel(null)
              setEditing(on)
            }}
            onPanel={setPanel}
            onSaved={(card) => {
              patch(card)
              setEditing(false)
              toast(`Saved: ${card.title}`)
            }}
            onCard={(card) => {
              patch(card)
            }}
            onFollowup={(followup, removed) =>
              setFollowups((list) =>
                removed
                  ? list.filter((entry) => entry.id !== followup.id)
                  : list.some((entry) => entry.id === followup.id)
                    ? list.map((entry) =>
                        entry.id === followup.id ? followup : entry,
                      )
                    : [...list, followup],
              )
            }
            onPayment={(payment) => setPayments((list) => [...list, payment])}
            onClientCreated={(client) =>
              setClients((list) => [...list, client])
            }
            onRecolor={(color) => void recolor(current, color)}
            onStep={(direction) => step(current, direction)}
            onPaid={() => void markPaid(current)}
            onArchive={() => void archive(current)}
            onDelete={() => void remove(current)}
            kept={keptBecause(current, null)}
            onLabel={setLabel}
          />
        ) : (
          <>
            <InspectorHead title='Card' meta='nothing selected' />
            <div className='insp-body'>
              <Empty>
                {shelf
                  ? scope.length
                    ? 'Select a card to see it here.'
                    : '○ nothing here'
                  : scope.length
                    ? 'Select a card to see it here, or press c for a new one.'
                    : 'Press c to add the first card.'}
              </Empty>
            </div>
          </>
        )}
      </Inspector>
    </div>
  )
}

function CardTile({
  card,
  client,
  followups,
  links,
  selected,
  today,
  awaiting,
  dragging,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  card: CardData
  client: string | null
  followups: FollowupData[]
  links: { prompts: number; files: number } | null
  selected: boolean
  today: string
  awaiting: boolean
  dragging: boolean
  onSelect: () => void
  onDragStart: (event: DragEvent) => void
  onDragEnd: () => void
}) {
  const due = jobDue(
    card.dueOn,
    followups.map((entry) => entry.dueOn),
    today,
  )
  const value = card.total ? (
    <span className='v price mono'>{money(card)}</span>
  ) : due.state === 'today' ? (
    <span className='state-word due'>● today</span>
  ) : due.state === 'late' ? (
    <span className='state-word due'>● late · {dayLabel(due.day)}</span>
  ) : due.day ? (
    <span className='state-word'>{dayLabel(due.day)}</span>
  ) : null
  const bits = [
    followups.length ? (
      <span key='f' title={plural(followups.length, 'follow-up')}>
        <FollowupMark />
        {followups.length}
      </span>
    ) : null,
    links?.prompts ? (
      <span key='p' title='Linked to a prompt'>
        ✎
      </span>
    ) : null,
    links?.files ? (
      <span key='u' title={plural(links.files, 'file')}>
        ▣{links.files}
      </span>
    ) : null,
  ].filter(Boolean)
  const label = `${client ? `${client}: ` : ''}${card.title}${awaiting ? ', awaiting payment' : ''}${due.state === 'today' ? ', due today' : due.day ? `, due ${dayLabel(due.day)}` : ''}${card.total ? `, ${money(card)}` : ''}${followups.length ? `, ${plural(followups.length, 'follow-up')}` : ''}${/[1-9]/.test(card.paidTotal) ? `, ${amount(card.paidTotal, card.currency)} paid` : ''}`
  return (
    <div
      className={`pcard bcard${selected ? ' sel' : ''}${dragging ? ' dragging' : ''}`}
      draggable
      role='option'
      aria-selected={selected}
      aria-label={label}
      tabIndex={selected ? 0 : -1}
      data-id={card.id}
      data-color={card.color ?? undefined}
      style={
        card.color
          ? { ['--card' as string]: projectHex(card.color) }
          : undefined
      }
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {client ? (
        <div className='who' lang={isThai(client) ? 'th' : undefined}>
          {client}
        </div>
      ) : null}
      <div className='t' lang={isThai(card.title) ? 'th' : undefined}>
        {card.title}
      </div>
      <div className='m'>
        <span className='labels'>
          {card.labels.map((entry) => (
            <span key={entry} className='label-chip'>
              {entry}
            </span>
          ))}
        </span>
        {bits.length ? <span className='bits'>{bits}</span> : null}
        {value}
      </div>
      <PayMeter paid={card.paidTotal} total={card.total} thin />
    </div>
  )
}

/**
 * The lane's instrument: an LCD of its sum, or its count when nothing is
 * priced. Every lane sums what its cards are worth (their totals); the
 * awaiting-payment lane sums what is still owed — total less what came in.
 */
function LaneReadout({
  lane,
  cards,
  currency,
}: {
  lane: LaneData
  cards: CardData[]
  currency: string
}) {
  const awaiting = lane.role === 'awaiting_payment'
  const priced = cards.filter(
    (card) => card.total && card.currency === currency,
  )
  const others = cards.filter(
    (card) => card.total && card.currency !== currency,
  ).length
  const sum = priced.length
    ? sumAmounts(
        priced.map((card) => {
          if (!awaiting) return card.total as string
          const owed = owedOf(card)
          return owed && !owed.startsWith('-') ? owed : '0'
        }),
        currency,
      )
    : null
  const already = awaiting
    ? sumAmounts(
        priced.map((card) => card.paidTotal),
        currency,
      )
    : '0'
  const n = `${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`
  return (
    <Readout
      label={`${lane.name} lane: ${sum ? `${formatMoney(sum, currency)} ${awaiting ? 'owed' : ''} across ` : ''}${n}`}
      tone={awaiting && sum && /[1-9]/.test(sum) ? 'accent' : ''}
      big={
        sum ? (
          formatMoney(sum, currency)
        ) : (
          <>
            {cards.length}{' '}
            <span className='u'>{cards.length === 1 ? 'card' : 'cards'}</span>
          </>
        )
      }
      sub={
        sum
          ? `${n} · ${awaiting ? 'owed' : currency}${awaiting && /[1-9]/.test(already) ? ` · ${formatMoney(already, currency)} already in` : ''}${others ? ` · +${others} in other currencies` : ''}`
          : awaiting
            ? 'awaiting payment'
            : 'sum'
      }
    />
  )
}

function GlobalReadout({
  projects,
  cards,
  lanes,
}: {
  projects: BoardProject[]
  cards: CardData[]
  lanes: Record<string, LaneData[]>
}) {
  const awaiting = new Set(
    Object.values(lanes)
      .flat()
      .filter((lane) => lane.role === 'awaiting_payment')
      .map((lane) => lane.id),
  )
  const owed = cards.filter(
    (card) => awaiting.has(card.laneId) && card.total && card.currency,
  )
  const byCurrency = new Map<string, string[]>()
  for (const card of owed) {
    const left = owedOf(card)
    byCurrency.set(card.currency as string, [
      ...(byCurrency.get(card.currency as string) ?? []),
      left && !left.startsWith('-') ? left : '0',
    ])
  }
  const withOwed = new Set(owed.map((card) => card.projectId)).size
  const [first, ...rest] = [...byCurrency.entries()].map(
    ([currency, amounts]) =>
      formatMoney(sumAmounts(amounts, currency), currency),
  )
  return (
    <div className='global-read'>
      <Readout
        tone={first ? 'accent' : 'dim'}
        big={first ?? '0'}
        sub={`awaiting payment · all projects · ${owed.length} ${owed.length === 1 ? 'card' : 'cards'} · ${withOwed} ${withOwed === 1 ? 'project' : 'projects'}${rest.length ? ` · also ${rest.join(' · ')}` : ''}`}
        label={`Awaiting payment across ${projects.length} projects`}
      />
    </div>
  )
}

function CardTable({
  cards,
  all,
  selected,
  projectOf,
  laneOf,
  clientName,
  followupsOf,
  onSelect,
  shelved,
  emptyText,
}: {
  cards: CardData[]
  all: boolean
  selected: string | null
  projectOf: (id: string | null) => BoardProject | null
  laneOf: (card: CardData) => LaneData | null
  clientName: (card: CardData) => string | null
  followupsOf: (cardId: string) => FollowupData[]
  onSelect: (id: string) => void
  /** Archived and Trash: when each card was put there, in the due column's place. */
  shelved?: { label: string; at: (card: CardData) => string | null }
  emptyText: string
}) {
  if (cards.length === 0) return <Empty>{emptyText}</Empty>
  return (
    <div
      className={`tbl${all ? ' global' : ''}`}
      role='listbox'
      aria-label='Cards'
    >
      <div className='tbl-head' aria-hidden='true'>
        {all ? <span className='hud-label'>project</span> : null}
        <span className='hud-label'>card</span>
        <span className='hud-label c-lane'>lane</span>
        <span className='hud-label c-labels'>labels</span>
        <span className='hud-label num'>price</span>
        <span className='hud-label c-due'>{shelved?.label ?? 'due'}</span>
        {all ? null : <span className='hud-label c-client'>client</span>}
      </div>
      {cards.map((card) => {
        const project = projectOf(card.projectId)
        const lane = laneOf(card)
        const fus = followupsOf(card.id)
        const due = jobDue(
          card.dueOn,
          fus.map((entry) => entry.dueOn),
          project?.today ?? '',
        )
        const client = clientName(card)
        return (
          <button
            key={card.id}
            type='button'
            role='option'
            aria-selected={card.id === selected}
            data-id={card.id}
            className={`tbl-row${card.id === selected ? ' sel' : ''}${project?.status === 'paused' ? ' paused' : ''}`}
            onClick={() => onSelect(card.id)}
          >
            {all ? (
              <span>
                <Tag project={project} />
              </span>
            ) : null}
            <span className='c-title'>
              {card.color ? (
                <i
                  className='cdot'
                  aria-hidden='true'
                  style={{ ['--card' as string]: projectHex(card.color) }}
                />
              ) : null}
              <span lang={isThai(card.title) ? 'th' : undefined}>
                {card.title}
              </span>
              {fus.length ? (
                <span className='fu-n' title={plural(fus.length, 'follow-up')}>
                  <FollowupMark />
                  {fus.length}
                </span>
              ) : null}
            </span>
            <span className='lane-name c-lane'>
              {lane?.name ?? '—'}
              {lane?.role === 'awaiting_payment' ? ' · pinned' : ''}
            </span>
            <span className='labels c-labels'>
              {card.labels.map((entry) => (
                <span key={entry} className='label-chip'>
                  {entry}
                </span>
              ))}
            </span>
            <span className='num'>{money(card)}</span>
            <span className='c-due'>
              {shelved ? (
                shelved.at(card) ? (
                  `${age(shelved.at(card))} ago`
                ) : (
                  '—'
                )
              ) : due.state === 'today' ? (
                <span className='state-word due'>● today</span>
              ) : (
                dayLabel(due.day)
              )}
            </span>
            {all ? null : (
              <span
                className='c-client'
                lang={isThai(client) ? 'th' : undefined}
              >
                {client ?? ''}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function CardInspector({
  card,
  project,
  lanes,
  client,
  clientId,
  clients,
  clientCounts,
  followups,
  payments,
  editing,
  panel,
  latest,
  onClose,
  onEdit,
  onPanel,
  onSaved,
  onCard,
  onFollowup,
  onPayment,
  onClientCreated,
  onRecolor,
  onStep,
  onPaid,
  onArchive,
  onDelete,
  kept,
  onLabel,
}: {
  card: CardData
  project: BoardProject | null
  lanes: LaneData[]
  client: string | null
  clientId: string | null
  clients: ClientOption[]
  clientCounts: Record<string, number>
  followups: FollowupData[]
  payments: PaymentData[]
  editing: boolean
  panel: Panel
  /** The card as the last write left it (its revision for the next one). */
  latest: () => CardData
  onClose: () => void
  onEdit: (on: boolean) => void
  onPanel: (panel: Panel) => void
  onSaved: (card: CardData) => void
  onCard: (card: CardData) => void
  onFollowup: (followup: FollowupData, removed?: boolean) => void
  onPayment: (payment: PaymentData) => void
  onClientCreated: (client: ClientOption) => void
  onRecolor: (color: string | null) => void
  onStep: (direction: -1 | 1) => void
  onPaid: () => void
  onArchive: () => void
  /** Delete `⌫` — to the Trash. */
  onDelete: () => void
  /** Why this card can't be deleted, said where Delete would be. */
  kept: string | null
  onLabel: (label: string) => void
}) {
  const toast = useToast()
  const [history, setHistory] = useState<CardHistory | null>(null)
  const [nonce, setNonce] = useState(0)
  const [uploading, setUploading] = useState<Uploading[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new revision (or a link) means new history to read
  useEffect(() => {
    let alive = true
    cardHistoryAction(card.id).then((result) => {
      if (alive && result.ok) setHistory(result.data)
    })
    return () => {
      alive = false
    }
  }, [card.id, card.revision, nonce])
  // The write already re-rendered the page; the card's history is read here.
  const reread = () => setNonce((n) => n + 1)
  const index = lanes.findIndex((lane) => lane.id === card.laneId)
  const lane = lanes[index]
  const awaiting = lane?.role === 'awaiting_payment'
  const today = project?.today ?? ''
  const due = jobDue(
    card.dueOn,
    followups.map((entry) => entry.dueOn),
    today,
  )
  const currency = card.currency ?? project?.currency ?? 'THB'
  const quote = history?.links.find((entry) => entry.type === 'quote')
  const note = history?.links.find((entry) => entry.type === 'note')
  const promptOf = (followupId: string | null): PromptLink | null =>
    history?.prompts.find((entry) =>
      followupId
        ? entry.holder.type === 'followup' && entry.holder.id === followupId
        : entry.holder.type === 'card',
    ) ?? null
  const filesOf = (followupId: string | null): FileLink[] =>
    history?.files.filter((entry) =>
      followupId
        ? entry.holder.type === 'followup' && entry.holder.id === followupId
        : entry.holder.type === 'card',
    ) ?? []
  const fuSum = followups.length
    ? sumAmounts(
        followups.map((entry) => entry.price ?? '0'),
        currency,
      )
    : '0'
  const owed = owedOf(card)
  const paid = /[1-9]/.test(card.paidTotal)
  const promptsHome = project?.modules.includes('prompts')
    ? project.name
    : 'the library'
  const assetsOff =
    project && !project.modules.includes('assets')
      ? `Assets is off for ${project.name} — turn it on in Projects to keep files here.`
      : null

  /* the prompt, for the card or one follow-up */
  const pickPrompt = async (
    followupId: string | null,
    choice: PromptChoice,
  ) => {
    const result = await setPromptAction({
      cardId: card.id,
      followupId: followupId ?? undefined,
      promptId: choice.promptId,
      variantId: choice.variantId,
    })
    if (!result.ok) return toast(result.error)
    toast(`Linked prompt: ${choice.title}`)
    reread()
  }
  const createPrompt = async (
    followupId: string | null,
    fields: NewPromptFields,
  ): Promise<string | null> => {
    const result = await createPromptAction({
      cardId: card.id,
      followupId: followupId ?? undefined,
      projectId: project?.modules.includes('prompts') ? project.id : null,
      ...fields,
    })
    if (!result.ok) return result.error
    toast(`Saved to Prompts and linked: ${result.data.title}`)
    reread()
    return null
  }
  const unlink = async (refId: string, what: string) => {
    const result = await unlinkAction({ cardId: card.id, refId })
    if (!result.ok) return toast(result.error)
    toast(`Unlinked — the ${what} stays where it lives`)
    reread()
  }
  const copy = async (text: string) => {
    // A template's variants are picked in Prompts; a card doesn't pick them.
    const open = slotNames(text)
    if (open.length)
      return toast(
        `Pick ${open.join(', ')} in Prompts, and copy it there — Open in Prompts.`,
      )
    try {
      await navigator.clipboard.writeText(text)
      toast('Copied the prompt')
    } catch {
      toast('Couldn’t copy — select the text instead.')
    }
  }
  const promptBlock = (followupId: string | null) => (
    <PromptBlock
      link={promptOf(followupId)}
      home={promptsHome}
      compact={followupId !== null}
      keys={followupId === null}
      onPick={(choice) => void pickPrompt(followupId, choice)}
      onCreate={(fields) => createPrompt(followupId, fields)}
      onUnlink={(refId) => void unlink(refId, 'prompt')}
      onCopy={(text) => void copy(text)}
    />
  )

  /* files: the same three steps as Assets, then attached to the card or a follow-up */
  const upload = async (followupId: string | null, list: File[]) => {
    if (!project) return
    for (const file of list) {
      const key = `${file.name}-${file.size}-${Math.random()}`
      const track = (next: Partial<Uploading>) =>
        setUploading((now) =>
          now.map((entry) =>
            entry.key === key ? { ...entry, ...next } : entry,
          ),
        )
      setUploading((now) => [
        ...now,
        { key, name: file.name, progress: 0, error: null },
      ])
      const prepared = await prepareUploadAction({
        projectId: project.id,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        bytes: file.size,
      })
      if (!prepared.ok) {
        track({ error: prepared.error, progress: null })
        toast(`${file.name}: ${prepared.error}`)
        continue
      }
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
        continue
      }
      track({ progress: null })
      const dims = await measured
      // Quiet: linking it to the card next re-renders the page for both.
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
        continue
      }
      const attached = await attachFileAction({
        cardId: card.id,
        followupId: followupId ?? undefined,
        assetId: ready.data.id,
      })
      if (!attached.ok) {
        track({ error: attached.error })
        toast(`${file.name}: ${attached.error}`)
        // The file landed in Assets all the same: show it there.
        void refreshAction()
        continue
      }
      setUploading((now) => now.filter((entry) => entry.key !== key))
      toast(`Uploaded ${file.name} to ${project.name} › Assets and linked it`)
      reread()
    }
  }
  const filesBlock = (followupId: string | null) => (
    <FilesBlock
      files={filesOf(followupId)}
      uploading={followupId === null ? uploading : []}
      offReason={assetsOff}
      keys={followupId === null}
      onFiles={(list) => void upload(followupId, list)}
      onUnlink={(refId) => void unlink(refId, 'file')}
    />
  )

  /* follow-ups */
  const saveFollowup = async (
    followup: FollowupData | null,
    fields: { title: string; body: string; price: string; dueOn: string },
  ): Promise<string | null> => {
    const base = latest()
    const input = {
      cardId: card.id,
      expectedRevision: base.revision,
      title: fields.title.trim(),
      body: fields.body,
      price: fields.price.trim() || null,
      dueOn: fields.dueOn || null,
    }
    const result = followup
      ? await updateFollowupAction({ ...input, followupId: followup.id })
      : await addFollowupAction(input)
    if (!result.ok) return result.error
    onCard(result.data.card)
    onFollowup(result.data.followup)
    onPanel(null)
    const total = result.data.card.total
      ? ` · total ${formatMoney(result.data.card.total, result.data.card.currency ?? currency)}`
      : ''
    if (followup) toast(`Saved: ${result.data.followup.title}${total}`)
    else
      toast(`Follow-up added: ${result.data.followup.title}${total}`, {
        undo: async () => {
          const back = await followupArchivedAction({
            cardId: card.id,
            expectedRevision: latest().revision,
            followupId: result.data.followup.id,
            archived: true,
          })
          if (back.ok) {
            onCard(back.data.card)
            onFollowup(back.data.followup, true)
          } else toast(back.error)
        },
      })
    return null
  }
  const removeFollowup = async (followup: FollowupData) => {
    const result = await followupArchivedAction({
      cardId: card.id,
      expectedRevision: latest().revision,
      followupId: followup.id,
      archived: true,
    })
    if (!result.ok) return toast(result.error)
    onCard(result.data.card)
    onFollowup(result.data.followup, true)
    toast(`Removed follow-up: ${followup.title}`, {
      undo: async () => {
        const back = await followupArchivedAction({
          cardId: card.id,
          expectedRevision: latest().revision,
          followupId: followup.id,
          archived: false,
        })
        if (back.ok) {
          onCard(back.data.card)
          onFollowup(back.data.followup)
        } else toast(back.error)
      },
    })
  }

  /* payments — the owner's */
  const recordPayment = async (fields: {
    amount: string
    kind: 'deposit' | 'part'
    receivedOn: string
    note: string
  }): Promise<string | null> => {
    const result = await recordPaymentAction({
      cardId: card.id,
      expectedRevision: latest().revision,
      amount: fields.amount,
      kind: fields.kind,
      receivedOn: fields.receivedOn || null,
      note: fields.note.trim() || undefined,
    })
    if (!result.ok) return result.error
    onCard(result.data.card)
    onPayment(result.data.payment)
    onPanel(null)
    const left = owedOf(result.data.card)
    const word = fields.kind === 'deposit' ? 'deposit' : 'part payment'
    toast(
      `Recorded ${formatMoney(result.data.payment.amount, result.data.payment.currency)} ${word}: ${card.title}${
        left === null
          ? ''
          : left.startsWith('-')
            ? ` — overpaid ${formatMoney(left.slice(1), result.data.payment.currency)}`
            : /[1-9]/.test(left)
              ? ` — ${formatMoney(left, result.data.payment.currency)} left`
              : ' — paid in full; Mark paid archives it'
      }`,
      {
        undo: async () => {
          const back = await voidPaymentAction({
            cardId: card.id,
            expectedRevision: latest().revision,
            paymentId: result.data.payment.id,
            reason: 'undone',
          })
          if (back.ok) {
            onCard(back.data.card)
            onPayment(back.data.payment)
          } else toast(back.error)
        },
      },
    )
    return null
  }
  const voidPayment = async (payment: PaymentData) => {
    const result = await voidPaymentAction({
      cardId: card.id,
      expectedRevision: latest().revision,
      paymentId: payment.id,
    })
    if (!result.ok) return toast(result.error)
    onCard(result.data.card)
    onPayment(result.data.payment)
    toast(
      `Voided ${formatMoney(payment.amount, payment.currency)} — it stays in the history, struck`,
    )
  }

  const read = card.total ? (
    <Readout
      tone={awaiting ? 'accent' : ''}
      big={
        <>
          {money(card)} <span className='u'>{card.currency}</span>
        </>
      }
      sub={`${followups.length && /[1-9]/.test(fuSum) ? `card ${amount(card.price ?? '0', currency)} + ${plural(followups.length, 'follow-up')} ${amount(fuSum, currency)}` : (lane?.name ?? '')}${
        paid
          ? ` · ${amount(card.paidTotal, currency)} in · ${owed?.startsWith('-') ? `overpaid ${amount(owed.slice(1), currency)}` : `${amount(owed, currency) || formatMoney('0', currency)} left`}`
          : awaiting
            ? ' · not income until paid'
            : ''
      }`}
    />
  ) : due.state === 'today' ? (
    <Readout tone='accent' big='● due today' sub={lane?.name} />
  ) : (
    <Readout
      tone='dim'
      big={lane?.name ?? '—'}
      sub={`lane ${index + 1} of ${lanes.length}`}
    />
  )
  const facts: [string, ReactNode][] = [
    ['lane', `${lane?.name ?? '—'} · ${index + 1} of ${lanes.length}`],
    ['price', card.price ? amount(card.price, currency) : '—'],
  ]
  if (followups.length)
    facts.push(
      [
        'follow-ups',
        `${followups.length}${/[1-9]/.test(fuSum) ? ` · ${amount(fuSum, currency)}` : ''}`,
      ],
      ['total', card.total ? <b key='t'>{money(card)}</b> : '—'],
    )
  if (paid)
    facts.push(
      ['paid', amount(card.paidTotal, currency)],
      [
        owed?.startsWith('-') ? 'overpaid' : 'left',
        <b key='l'>
          {owed?.startsWith('-')
            ? amount(owed.slice(1), currency)
            : amount(owed, currency) || formatMoney('0', currency)}
        </b>,
      ],
    )
  facts.push(
    [
      'due',
      due.day
        ? `${due.state === 'today' ? 'today' : dayLabel(due.day)}${due.from === 'followup' ? ' · a follow-up' : ''}${due.state === 'late' ? ' · passed' : ''}`
        : '—',
    ],
    [
      'client',
      client ? (
        clientId ? (
          <Link
            key='c'
            href={`/clients?client=${clientId}`}
            lang={isThai(client) ? 'th' : undefined}
          >
            {client}
          </Link>
        ) : (
          <span key='c' lang={isThai(client) ? 'th' : undefined}>
            {client} <span className='once'>· once</span>
          </span>
        )
      ) : (
        '—'
      ),
    ],
    ['revision', String(card.revision)],
  )
  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} />{' '}
            <span style={{ color: 'var(--ink-4)' }}>›</span> {lane?.name}
          </>
        }
        meta={
          editing
            ? 'editing'
            : awaiting
              ? 'awaiting payment'
              : due.state === 'today'
                ? '● due today'
                : ''
        }
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          {read}
          <Facts rows={facts} />
        </div>
        <div className='dev-main'>
          {editing ? (
            <EditCard
              card={card}
              clientValue={client ? { id: clientId, name: client } : null}
              clients={clients}
              clientCounts={clientCounts}
              onClientCreated={onClientCreated}
              onCancel={() => onEdit(false)}
              onSaved={onSaved}
            />
          ) : (
            <>
              {client ? (
                <div
                  className='dev-who'
                  lang={isThai(client) ? 'th' : undefined}
                >
                  {client}
                  {clientId ? null : <span className='once'> · once</span>}
                </div>
              ) : null}
              <h2
                className='dev-title'
                lang={isThai(card.title) ? 'th' : undefined}
              >
                {card.title}
              </h2>
              <Markdown source={card.body} />
              {card.labels.length ? (
                <div className='labels'>
                  {card.labels.map((entry) => (
                    <button
                      key={entry}
                      type='button'
                      className='label-chip'
                      title={`Filter by ${entry}`}
                      onClick={() => onLabel(entry)}
                    >
                      {entry}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className='dev-acts'>
                <button
                  type='button'
                  className='btn btn-sm'
                  disabled={index <= 0}
                  onClick={() => onStep(-1)}
                >
                  ← {lanes[index - 1]?.name ?? ''}
                  <kbd>[</kbd>
                </button>
                <button
                  type='button'
                  className='btn btn-sm'
                  disabled={index >= lanes.length - 1}
                  onClick={() => onStep(1)}
                >
                  {lanes[index + 1]?.name ?? ''} →<kbd>]</kbd>
                </button>
                {awaiting ? (
                  <button
                    type='button'
                    className='btn btn-sm btn-pri'
                    onClick={onPaid}
                  >
                    Mark paid
                    {paid && owed && positive(owed)
                      ? ` · ${amount(owed, currency)} left`
                      : ''}
                    <kbd>m</kbd>
                  </button>
                ) : null}
                <button
                  type='button'
                  className='btn btn-sm'
                  onClick={() => onEdit(true)}
                >
                  Edit<kbd>e</kbd>
                </button>
                <button
                  type='button'
                  className='btn btn-sm'
                  onClick={onArchive}
                >
                  Archive
                </button>
                {kept ? (
                  <span className='kept'>{kept}</span>
                ) : (
                  <button
                    type='button'
                    className='btn btn-sm'
                    onClick={onDelete}
                  >
                    Delete<kbd>⌫</kbd>
                  </button>
                )}
              </div>
              <section className='sect' aria-label='Follow-ups'>
                <div className='dev-h'>
                  <span className='hud-label'>
                    Follow-ups{followups.length ? ` · ${followups.length}` : ''}
                  </span>
                  <span className='sect-m'>
                    {/[1-9]/.test(fuSum) ? `+ ${amount(fuSum, currency)}` : ''}
                  </span>
                </div>
                {followups.length || panel?.kind === 'followup' ? (
                  <div className='fu-list'>
                    {followups.map((followup) =>
                      panel?.kind === 'followup' && panel.id === followup.id ? (
                        <FollowupForm
                          key={followup.id}
                          initial={followup}
                          currency={currency}
                          awaiting={awaiting}
                          onCancel={() => onPanel(null)}
                          onSave={(fields) => saveFollowup(followup, fields)}
                        />
                      ) : (
                        <FollowupItem
                          key={followup.id}
                          followup={followup}
                          currency={currency}
                          today={today}
                          prompt={promptBlock(followup.id)}
                          files={filesBlock(followup.id)}
                          onEdit={() =>
                            onPanel({ kind: 'followup', id: followup.id })
                          }
                          onRemove={() => void removeFollowup(followup)}
                        />
                      ),
                    )}
                    {panel?.kind === 'followup' && panel.id === null ? (
                      <FollowupForm
                        initial={null}
                        currency={currency}
                        awaiting={awaiting}
                        onCancel={() => onPanel(null)}
                        onSave={(fields) => saveFollowup(null, fields)}
                      />
                    ) : null}
                  </div>
                ) : (
                  <p className='dev-p'>
                    Work that came after this card’s task — a revision round, an
                    add-on, a note from the client. Its price adds to the card.
                  </p>
                )}
                {panel?.kind === 'followup' && panel.id === null ? null : (
                  <button
                    type='button'
                    className='btn btn-sm'
                    onClick={() => onPanel({ kind: 'followup', id: null })}
                  >
                    ＋ Follow-up<kbd>f</kbd>
                  </button>
                )}
              </section>
              <PaymentsSection
                card={card}
                payments={payments}
                awaiting={awaiting}
                today={today}
                open={panel?.kind === 'payment'}
                onOpen={() => onPanel({ kind: 'payment' })}
                onCancel={() => onPanel(null)}
                onRecord={recordPayment}
                onVoid={(payment) => void voidPayment(payment)}
              />
              <section className='sect' aria-label='Prompt'>
                <div className='dev-h'>
                  <span className='hud-label'>Prompt</span>
                </div>
                {history ? promptBlock(null) : <p className='dev-p'>…</p>}
              </section>
              <section className='sect' aria-label='Files'>
                <div className='dev-h'>
                  <span className='hud-label'>
                    Files
                    {filesOf(null).length ? ` · ${filesOf(null).length}` : ''}
                  </span>
                  <span className='sect-m'>
                    {project ? (
                      <>
                        <Tag project={project} /> › Assets
                      </>
                    ) : null}
                  </span>
                </div>
                {history ? filesBlock(null) : <p className='dev-p'>…</p>}
              </section>
              <section className='sect sect-row' aria-label='Colour'>
                <span className='hud-label'>Colour</span>
                <Swatches
                  value={card.color}
                  allowNone
                  label='Card colour'
                  onChange={onRecolor}
                />
              </section>
              <div className='insp-links'>
                {quote ? (
                  <Link
                    className='btn btn-sm'
                    href={
                      project
                        ? `/p/${project.slug}/quotes?quote=${quote.id}`
                        : `/quotes?quote=${quote.id}`
                    }
                  >
                    Quote
                  </Link>
                ) : project?.modules.includes('quotes') ? (
                  // Only where Quotes is on: the link would land on an off page.
                  <Link
                    className='btn btn-sm'
                    href={`/p/${project.slug}/quotes?new=1&card=${card.id}`}
                  >
                    Quote this card
                  </Link>
                ) : null}
                {note ? (
                  <Link className='btn btn-sm' href={`/notes?open=${note.id}`}>
                    From a note
                  </Link>
                ) : null}
                {project ? (
                  <Link className='btn btn-sm' href={`/p/${project.slug}`}>
                    Project map
                  </Link>
                ) : null}
              </div>
              {history && history.events.length > 0 ? (
                <div className='dev-rows'>
                  <span className='hud-label'>History</span>
                  {history.events.slice(0, 8).map((event) => (
                    <div key={event.id} className='dev-row'>
                      <span className='t'>{eventWords(event)}</span>
                      <span className='v'>
                        {event.actor} ·{' '}
                        {new Date(event.at).toLocaleString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  )
}

/** A history row in words. */
function eventWords(event: CardHistory['events'][number]): string {
  const cash =
    event.amount && event.currency
      ? formatMoney(event.amount, event.currency)
      : ''
  switch (event.kind) {
    case 'moved':
      return `moved ${event.from ?? ''} → ${event.to ?? ''}`
    case 'paid':
      return `marked paid${cash ? ` · ${cash}` : ''}`
    case 'priced':
      return `priced${cash ? ` ${cash}` : ' — cleared'}`
    case 'followup_added':
      return `follow-up added${cash ? ` · ${cash}` : ''}`
    case 'followup_edited':
      return `follow-up edited${cash ? ` · ${cash}` : ''}`
    case 'followup_removed':
      return `follow-up removed${cash ? ` · ${cash}` : ''}`
    case 'payment_recorded':
      return `payment in${cash ? ` · ${cash}` : ''}`
    case 'payment_voided':
      return `payment voided${cash ? ` · ${cash}` : ''}`
    case 'restored':
      return 'restored from Archived'
    case 'deleted':
      return 'moved to Trash'
    case 'undeleted':
      return 'restored from Trash'
    default:
      return event.kind
  }
}

function EditCard({
  card,
  clientValue,
  clients,
  clientCounts,
  onClientCreated,
  onCancel,
  onSaved,
}: {
  card: CardData
  clientValue: ClientChoice | null
  clients: ClientOption[]
  clientCounts: Record<string, number>
  onClientCreated: (client: ClientOption) => void
  onCancel: () => void
  onSaved: (card: CardData) => void
}) {
  const [title, setTitle] = useState(card.title)
  const [body, setBody] = useState(card.body)
  const [labels, setLabels] = useState(card.labels.join(', '))
  const [price, setPrice] = useState(card.price ?? '')
  const [dueOn, setDueOn] = useState(card.dueOn ?? '')
  const [client, setClient] = useState<ClientChoice | null>(clientValue)
  const [color, setColor] = useState<string | null>(card.color)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  return (
    <form
      className='fcard'
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        start(async () => {
          const result = await updateCardAction({
            cardId: card.id,
            expectedRevision: card.revision,
            title,
            body,
            labels: labels
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean),
            price: price.trim() ? price.trim() : null,
            dueOn: dueOn || null,
            ...(client?.id
              ? { clientId: client.id, client: null }
              : { clientId: null, client: client?.name ?? null }),
            color,
          })
          if (result.ok) onSaved(result.data)
          else setError(result.error)
        })
      }}
    >
      <span className='hud-label'>Edit card</span>
      <label>
        Title
        <input
          ref={first}
          type='text'
          value={title}
          maxLength={200}
          required
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        Body · markdown
        <textarea
          rows={6}
          value={body}
          maxLength={20000}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <label>
        Labels
        <input
          type='text'
          value={labels}
          placeholder='client, deck'
          onChange={(event) => setLabels(event.target.value)}
        />
      </label>
      <div className='row'>
        <label style={{ flex: 1 }}>
          Price · {card.currency ?? 'project currency'}
          <input
            type='text'
            inputMode='decimal'
            value={price}
            placeholder='—'
            onChange={(event) => setPrice(event.target.value)}
          />
        </label>
        <label style={{ flex: 1 }}>
          Due
          <input
            type='date'
            value={dueOn}
            onChange={(event) => setDueOn(event.target.value)}
          />
        </label>
      </div>
      <div className='fcard-field'>
        <span className='fld-label'>Client</span>
        <ClientPicker
          value={client}
          clients={clients}
          counts={clientCounts}
          onChange={setClient}
          onCreate={async (fields) => {
            const result = await createClientAction(fields)
            if (!result.ok) return { ok: false, error: result.error }
            onClientCreated(result.data)
            return { ok: true, client: result.data }
          }}
        />
      </div>
      <div>
        <span className='fld-label'>Colour</span>
        <Swatches
          value={color}
          allowNone
          label='Card colour'
          onChange={setColor}
        />
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
          {pending ? 'Saving…' : 'Save'}
          <kbd>↵</kbd>
        </button>
        <button type='button' className='btn' onClick={onCancel}>
          Cancel<kbd>Esc</kbd>
        </button>
      </div>
      <p className='hint'>
        Price here is the card’s own; follow-ups add to it. A stale revision is
        refused rather than overwritten — reload and try again if someone else
        changed it.
      </p>
    </form>
  )
}

function NewCard({
  projects,
  lanesOf,
  initial,
  clients,
  clientCounts,
  onClientCreated,
  onCancel,
  onCreated,
}: {
  projects: BoardProject[]
  lanesOf: (projectId: string | null) => LaneData[]
  initial: {
    laneId: string | null
    projectId: string | null
    client: ClientChoice | null
  }
  clients: ClientOption[]
  clientCounts: Record<string, number>
  onClientCreated: (client: ClientOption) => void
  onCancel: () => void
  onCreated: (card: CardData) => void
}) {
  const [projectId, setProjectId] = useState(
    initial.projectId ?? projects[0]?.id ?? '',
  )
  const lanes = lanesOf(projectId)
  const [laneId, setLaneId] = useState(initial.laneId ?? lanes[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [price, setPrice] = useState('')
  const [client, setClient] = useState<ClientChoice | null>(initial.client)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const project = projects.find((entry) => entry.id === projectId) ?? null
  const lane = lanes.find((entry) => entry.id === laneId) ?? lanes[0]
  const laneIndex = lane ? lanes.indexOf(lane) : 0
  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} />{' '}
            <span style={{ color: 'var(--ink-4)' }}>›</span> new card
          </>
        }
        meta='not saved yet'
        onClose={onCancel}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <Readout
            tone='dim'
            big={lane?.name ?? '—'}
            sub={
              lanes.length
                ? `lane ${laneIndex + 1} of ${lanes.length}`
                : 'the board is made on the first card'
            }
          />
        </div>
        <div className='dev-main'>
          <form
            className='fcard'
            autoComplete='off'
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.defaultPrevented) {
                event.preventDefault()
                event.stopPropagation()
                onCancel()
              }
            }}
            onSubmit={(event) => {
              event.preventDefault()
              setError(null)
              start(async () => {
                const result = await createCardAction({
                  projectId,
                  laneId: lane?.id,
                  title,
                  price: price.trim() || null,
                  ...(client?.id
                    ? { clientId: client.id }
                    : client
                      ? { client: client.name }
                      : {}),
                })
                if (result.ok) onCreated(result.data)
                else setError(result.error)
              })
            }}
          >
            <span className='hud-label'>New card</span>
            <label>
              Title
              <input
                ref={input}
                type='text'
                required
                maxLength={200}
                placeholder='What is it?'
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            {projects.length > 1 ? (
              <label>
                Project
                <select
                  value={projectId}
                  onChange={(event) => {
                    setProjectId(event.target.value)
                    setLaneId(lanesOf(event.target.value)[0]?.id ?? '')
                  }}
                >
                  {projects.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {lanes.length ? (
              <label>
                Lane
                <select
                  value={lane?.id ?? ''}
                  onChange={(event) => setLaneId(event.target.value)}
                >
                  {lanes.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              Price · optional
              <input
                type='text'
                inputMode='decimal'
                placeholder={project ? `in ${project.currency}` : ''}
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
            </label>
            <div className='fcard-field'>
              <span className='fld-label'>Client · optional</span>
              <ClientPicker
                value={client}
                clients={clients}
                counts={clientCounts}
                onChange={setClient}
                onCreate={async (fields) => {
                  const result = await createClientAction(fields)
                  if (!result.ok) return { ok: false, error: result.error }
                  onClientCreated(result.data)
                  return { ok: true, client: result.data }
                }}
              />
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
                disabled={pending || !title.trim() || !projectId}
              >
                {pending ? 'Creating…' : 'Create card'}
                <kbd>↵</kbd>
              </button>
              <button type='button' className='btn' onClick={onCancel}>
                Cancel<kbd>Esc</kbd>
              </button>
            </div>
            <p className='hint'>
              Lands in {project?.name ?? 'the project'} ›{' '}
              {lane?.name ?? 'the first lane'}
              {project ? ` (${KIND_LABEL[project.kind]})` : ''}; the lane count
              and the rail follow.
            </p>
          </form>
        </div>
      </div>
    </>
  )
}

/**
 * A card in Archived or the Trash: what it was — its money,
 * lane, client, body and history — and one way back, Restore `r`. Archived
 * also offers Delete `⌫`. Nothing here edits: a card off the board is
 * frozen until it is back.
 */
function ShelfInspector({
  card,
  shelf,
  project,
  lanes,
  client,
  followups,
  onClose,
  onRestore,
  onDelete,
}: {
  card: CardData
  shelf: 'archived' | 'trash'
  project: BoardProject | null
  lanes: LaneData[]
  client: string | null
  followups: FollowupData[]
  onClose: () => void
  onRestore: () => void
  onDelete: () => void
}) {
  const [history, setHistory] = useState<CardHistory | null>(null)
  useEffect(() => {
    let alive = true
    cardHistoryAction(card.id).then((result) => {
      if (alive && result.ok) setHistory(result.data)
    })
    return () => {
      alive = false
    }
  }, [card.id])
  const lane = lanes.find((entry) => entry.id === card.laneId) ?? null
  const at = shelf === 'trash' ? card.deletedAt : card.archivedAt
  const when = at ? `${age(at)} ago` : '—'
  const currency = card.currency ?? project?.currency ?? 'THB'
  const paid = positive(card.paidTotal)
  const kept = keptBecause(card, shelf)
  const facts: [string, ReactNode][] = [
    ['lane', lane?.name ?? '—'],
    ['total', card.total ? money(card) : '—'],
  ]
  if (paid) facts.push(['paid', amount(card.paidTotal, currency)])
  if (followups.length) facts.push(['follow-ups', String(followups.length)])
  facts.push(
    [
      'client',
      client ? (
        <span key='c' lang={isThai(client) ? 'th' : undefined}>
          {client}
        </span>
      ) : (
        '—'
      ),
    ],
    [shelf === 'trash' ? 'deleted' : 'archived', when],
  )
  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} />{' '}
            <span style={{ color: 'var(--ink-4)' }}>›</span>{' '}
            {shelf === 'trash' ? 'Trash' : 'Archived'}
          </>
        }
        meta={card.paidAt ? 'paid' : shelf === 'trash' ? 'deleted' : 'archived'}
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <Readout
            tone='dim'
            big={
              card.total ? (
                <>
                  {money(card)} <span className='u'>{card.currency}</span>
                </>
              ) : (
                (lane?.name ?? '—')
              )
            }
            sub={`${card.paidAt ? 'marked paid · ' : ''}${shelf === 'trash' ? 'in Trash' : 'archived'} ${when}`}
          />
          <Facts rows={facts} />
        </div>
        <div className='dev-main'>
          {client ? (
            <div className='dev-who' lang={isThai(client) ? 'th' : undefined}>
              {client}
            </div>
          ) : null}
          <h2
            className='dev-title'
            lang={isThai(card.title) ? 'th' : undefined}
          >
            {card.title}
          </h2>
          <Markdown source={card.body} />
          {card.labels.length ? (
            <div className='labels'>
              {card.labels.map((entry) => (
                <span key={entry} className='label-chip'>
                  {entry}
                </span>
              ))}
            </div>
          ) : null}
          <div className='dev-acts'>
            {card.paidAt ? (
              <span className='kept'>{kept}</span>
            ) : (
              <>
                <button
                  type='button'
                  className='btn btn-sm btn-pri'
                  onClick={onRestore}
                >
                  Restore<kbd>r</kbd>
                </button>
                {shelf === 'archived' ? (
                  kept ? (
                    <span className='kept'>{kept}</span>
                  ) : (
                    <button
                      type='button'
                      className='btn btn-sm'
                      onClick={onDelete}
                    >
                      Delete<kbd>⌫</kbd>
                    </button>
                  )
                ) : null}
              </>
            )}
          </div>
          {history && history.events.length > 0 ? (
            <div className='dev-rows'>
              <span className='hud-label'>History</span>
              {history.events.slice(0, 8).map((event) => (
                <div key={event.id} className='dev-row'>
                  <span className='t'>{eventWords(event)}</span>
                  <span className='v'>
                    {event.actor} ·{' '}
                    {new Date(event.at).toLocaleString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

/**
 * A lane opened from its head: its readout (the lane footer's LCD), then
 * the owner's moves — ← → among the lanes you work in, a card here, Delete
 * lane (asked in place; where a lane can't go, the reason stands in its
 * place) — and Rename as a form card. Awaiting payment doesn't move: it
 * holds what is owed and stays pinned right.
 */
function LaneInspector({
  project,
  lane,
  lanes,
  cards,
  asking,
  onAsking,
  renameRef,
  onClose,
  onRename,
  onMove,
  onDelete,
  onNewCard,
}: {
  project: BoardProject
  lane: LaneData
  lanes: LaneData[]
  /** The lane's live cards. */
  cards: CardData[]
  asking: boolean
  onAsking: (asking: boolean) => void
  renameRef: RefObject<HTMLInputElement | null>
  onClose: () => void
  onRename: (name: string) => Promise<string | null>
  onMove: (direction: -1 | 1) => void
  onDelete: () => Promise<void>
  onNewCard: () => void
}) {
  const pinned = lane.role === 'awaiting_payment'
  const index = lanes.findIndex((entry) => entry.id === lane.id)
  const run = lanes.filter((entry) => entry.role !== 'awaiting_payment')
  const at = run.findIndex((entry) => entry.id === lane.id)
  const canLeft = !pinned && at > 0
  const canRight = !pinned && at >= 0 && at < run.length - 1
  const kept = laneKept(lane, lanes, cards.length)
  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} />{' '}
            <span style={{ color: 'var(--ink-4)' }}>›</span> lane
          </>
        }
        meta={pinned ? 'pinned right' : `${index + 1} of ${lanes.length}`}
        onClose={onClose}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <LaneReadout lane={lane} cards={cards} currency={project.currency} />
          <Facts
            rows={[
              ['cards', String(cards.length)],
              [
                'place',
                pinned
                  ? 'last · pinned right'
                  : `${index + 1} of ${lanes.length}`,
              ],
              [
                'holds',
                pinned
                  ? 'money owed'
                  : lane.role === 'done'
                    ? 'finished work'
                    : 'work',
              ],
            ]}
          />
        </div>
        <div className='dev-main'>
          <h2 className='dev-title' lang={isThai(lane.name) ? 'th' : undefined}>
            {lane.name}
          </h2>
          {pinned ? (
            <p className='dev-p'>
              What sits here is owed, not income until it is marked paid. It
              stays pinned right, after every lane.
            </p>
          ) : null}
          <div className='dev-acts'>
            {pinned ? null : (
              <>
                <button
                  type='button'
                  className='btn btn-sm'
                  disabled={!canLeft}
                  onClick={() => onMove(-1)}
                >
                  ← Move left<kbd>[</kbd>
                </button>
                <button
                  type='button'
                  className='btn btn-sm'
                  disabled={!canRight}
                  title={
                    canRight
                      ? undefined
                      : 'The last lane before Awaiting payment'
                  }
                  onClick={() => onMove(1)}
                >
                  Move right →<kbd>]</kbd>
                </button>
              </>
            )}
            <button type='button' className='btn btn-sm' onClick={onNewCard}>
              ＋ Card here<kbd>c</kbd>
            </button>
            {kept ? (
              <span className='kept'>{kept}</span>
            ) : (
              <Confirm
                label='Delete lane'
                kbd='⌫'
                question={`Delete “${lane.name}”?`}
                yes='Delete lane'
                run={onDelete}
                asking={asking}
                onAsking={onAsking}
              />
            )}
          </div>
          <RenameLane
            key={`${lane.id}-${lane.name}`}
            lane={lane}
            inputRef={renameRef}
            onRename={onRename}
          />
        </div>
      </div>
    </>
  )
}

function RenameLane({
  lane,
  inputRef,
  onRename,
}: {
  lane: LaneData
  inputRef: RefObject<HTMLInputElement | null>
  onRename: (name: string) => Promise<string | null>
}) {
  const [name, setName] = useState(lane.name)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const next = name.trim()
  return (
    <form
      className='fcard'
      autoComplete='off'
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        start(async () => {
          const refused = await onRename(next)
          if (refused) setError(refused)
        })
      }}
    >
      <span className='hud-label'>Rename</span>
      <label>
        Name
        <input
          ref={inputRef}
          type='text'
          required
          maxLength={60}
          value={name}
          lang={isThai(name) ? 'th' : undefined}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            // Esc puts the name back and leaves the field; the next Esc
            // closes the lane.
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            setName(lane.name)
            setError(null)
            event.currentTarget.blur()
          }}
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
          disabled={pending || !next || next === lane.name}
        >
          {pending ? 'Saving…' : 'Rename'}
          <kbd>↵</kbd>
        </button>
      </div>
      <p className='hint'>
        Only the name changes; its cards stay where they are.
      </p>
    </form>
  )
}

/** `＋ Lane`: a name, and it lands after the lanes you work in. */
function NewLane({
  project,
  lanes,
  onCancel,
  onCreate,
}: {
  project: BoardProject
  lanes: LaneData[]
  onCancel: () => void
  onCreate: (name: string) => Promise<string | null>
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const run = lanes.filter((lane) => lane.role !== 'awaiting_payment')
  const after = run.at(-1)
  const pinned = lanes.some((lane) => lane.role === 'awaiting_payment')
  return (
    <>
      <InspectorHead
        title={
          <>
            <Tag project={project} />{' '}
            <span style={{ color: 'var(--ink-4)' }}>›</span> new lane
          </>
        }
        meta='not saved yet'
        onClose={onCancel}
      />
      <div className='insp-body'>
        <div className='dev-read'>
          <Readout
            tone='dim'
            big={name.trim() || '—'}
            sub={`lane ${run.length + 1} of ${lanes.length + 1}`}
          />
        </div>
        <div className='dev-main'>
          <form
            className='fcard'
            autoComplete='off'
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.defaultPrevented) {
                event.preventDefault()
                event.stopPropagation()
                onCancel()
              }
            }}
            onSubmit={(event) => {
              event.preventDefault()
              setError(null)
              start(async () => {
                const refused = await onCreate(name.trim())
                if (refused) setError(refused)
              })
            }}
          >
            <span className='hud-label'>New lane</span>
            <label>
              Name
              <input
                ref={input}
                type='text'
                required
                maxLength={60}
                placeholder='e.g. Shipping'
                value={name}
                lang={isThai(name) ? 'th' : undefined}
                onChange={(event) => setName(event.target.value)}
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
                {pending ? 'Adding…' : 'Add lane'}
                <kbd>↵</kbd>
              </button>
              <button type='button' className='btn' onClick={onCancel}>
                Cancel<kbd>Esc</kbd>
              </button>
            </div>
            <p className='hint'>
              Lands after {after?.name ?? 'the last lane'}
              {pinned ? '; Awaiting payment stays pinned right' : ''}. Open its
              head to move or rename it.
            </p>
          </form>
        </div>
      </div>
    </>
  )
}
