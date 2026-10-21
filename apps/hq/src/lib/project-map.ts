import 'server-only'
import { listRuns, type RunItem } from '@theiceji/hq-agents/runs'
import { type BoardView, listBoards, openBoard } from '@theiceji/hq-board/board'
import { weekRange } from '@theiceji/hq-calendar/dates'
import { listEvents } from '@theiceji/hq-calendar/events'
import {
  KIND_LABEL,
  LANE_PRESETS,
  MODULES,
  orderedModules,
} from '@theiceji/hq-core/modules'
import { digitsOf, formatMoney, fromMinor } from '@theiceji/hq-core/money'
import { getDb } from '@theiceji/hq-db'
import {
  type BoardLaneRole,
  PROJECT_COLORS,
  type ProjectColor,
} from '@theiceji/hq-db/enums'
import {
  agentProposals,
  agentRoutines,
  assetAssets,
  boardCards,
  calendarEvents,
  expExperiments,
  marketListings,
  notes as notesTable,
  opsHumanRequests,
  type ProjectRow,
  promptPrompts,
  promptVariants,
  publishPosts,
  quoteQuotes,
  refs,
  storyShots,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { zonedDay } from '@theiceji/hq-ops/time'
import { and, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm'
import type { InboxEntry } from '@/components/Inbox'
import {
  attributeRef,
  type Box,
  boundsOf,
  COL_X,
  countLabel,
  type EdgeTone,
  EXTRA_LANE,
  edgePath,
  type MapEdge,
  type MapModule,
  type MapNode,
  NODE_H,
  NODE_W,
  type NodeKind,
  PLACE,
  READS_FROM_LANE,
  rowY,
} from '@/components/project/map-layout'
import type { ModuleCell, ModuleId } from '@/modules'
import { cellsOf, loadModuleReads, money, safe } from './cells'
import { listNotes } from './notes/store'

/**
 * What the project page's Map view reads: the kind's
 * pipeline as a ladder of nodes — feeders | the board's lanes | drains — with
 * each node's number from the module cells (`lib/cells.ts`, the same numbers
 * the rail, Space and State show), each edge counted from `refs`, and what
 * the inspector needs behind every node: the items waiting there, this
 * week's dated rows and the routine runs.
 *
 * Every number comes from a record. A read that fails leaves its part empty
 * or "not read back" — never a guess — and the rest of the map still draws.
 */

export type ReadoutData = {
  mark: string
  big: string
  unit: string
  sub: string
  tone: '' | 'wait' | 'live' | 'accent' | 'dim'
}

export type MapNodeData = MapNode & {
  /** The inspector's readout and facts for this node. */
  read: ReadoutData
  facts: [string, string][]
  /** One quiet sentence under the title, when the node has one. */
  about: string
  /** Inbox entries (ids) waiting behind this node. */
  waiting: string[]
}

export type WeekRow = {
  id: string
  /** The node it shows under: `lane:2`, `calendar`, `publish`. */
  node: string
  title: string
  when: string
  tone: '' | 'soon' | 'done'
  href: string
}

export type RunRow = {
  id: string
  routine: string
  /** The modules its routine works in — a module node shows the runs that touch it. */
  modules: string[]
  glyph: '▶' | '◆' | '○'
  tone: 'live' | 'problem' | 'off'
  status: string
  when: string
  cost: string
  href: string
}

export type NoteItem = {
  id: string
  title: string
  promoted: boolean
  href: string
}

export type ProjectMapData = {
  project: {
    id: string
    slug: string
    name: string
    kind: ProjectRow['kind']
    kindLabel: string
    color: string
    status: ProjectRow['status']
  }
  /** The well's top-left line: ◆ n waiting · ▶ n running · money. */
  hud: { waiting: number; running: number; money: string }
  bounds: Box
  world: { w: number; h: number }
  nodes: MapNodeData[]
  edges: MapEdge[]
  /** What waits for you on this project, in the Inbox's one markup. */
  entries: InboxEntry[]
  week: WeekRow[]
  runs: RunRow[]
  notes: NoteItem[]
  /** The inspector with nothing selected: the project itself. */
  overview: {
    read: ReadoutData
    facts: [string, string][]
    modules: { id: string; label: string; glyph: string; on: boolean }[]
  }
}

/* ── Words ─────────────────────────────────────────────────────────── */

const n = (value: number) => value.toLocaleString('en-US')
const plural = (count: number, one: string, many = `${one}s`) =>
  count === 1 ? one : many
const hex = (color: string) =>
  PROJECT_COLORS[color as ProjectColor] ?? PROJECT_COLORS.grey

const STATE_WORD: Record<string, string> = {
  wait: 'waiting for you',
  live: 'running',
  due: 'due today',
  unknown: 'not read back',
  new: 'nothing yet',
}

const MARK: Record<string, string> = { wait: '◆', live: '▶', due: '●' }

function dayWords(date: Date, timeZone: string, time = true): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone,
  })
    .format(date)
    .replace(',', '')
}

const weekday = (day: string) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`))

const figureOf = (cell: ModuleCell) =>
  `${typeof cell.value === 'number' ? n(cell.value) : String(cell.value)}${cell.unit ? ` ${cell.unit}` : ''}`

/**
 * A module cell as a node readout, read the way the
 * rail reads it: `◆ n waiting` when something waits there (its own figure
 * moves to the line under it), `▶` and the figure while it runs, else the
 * figure.
 */
function fromCell(
  cell: ModuleCell | null | undefined,
  waiting: number,
): Pick<MapNode, 'mark' | 'big' | 'unit' | 'tone' | 'sub' | 'state'> {
  if (cell?.state === 'wait')
    return {
      mark: '◆',
      big: n(Math.max(1, waiting)),
      unit: 'waiting',
      tone: 'wait',
      sub: figureOf(cell),
      state: 'wait',
    }
  if (!cell)
    return {
      mark: '',
      big: '○ nothing yet',
      unit: '',
      tone: 'dim',
      sub: 'no record',
      state: 'new',
    }
  if (cell.state === 'unknown')
    return {
      mark: '',
      big: '— not read back',
      unit: '',
      tone: 'dim',
      sub: cell.sub ?? '',
      state: 'unknown',
    }
  return {
    mark: MARK[cell.state] ?? '',
    big: typeof cell.value === 'number' ? n(cell.value) : String(cell.value),
    unit: cell.unit ?? '',
    tone: cell.state === 'live' ? 'live' : '',
    sub: cell.sub ?? '',
    state: cell.state,
  }
}

const readOf = (node: MapNode): ReadoutData => ({
  mark: node.mark,
  big: node.big,
  unit: node.unit,
  sub: node.sub,
  tone:
    node.tone === 'money'
      ? 'accent'
      : node.tone === 'wait'
        ? 'wait'
        : node.tone,
})

/* ── Reads ─────────────────────────────────────────────────────────── */

type Lane = {
  name: string
  role: BoardLaneRole
  count: number
  sum: string | null
  currency: string | null
  other: number
  wip: number | null
  due: number
}

/** The project's board, read — never made here; a board is made on its first open. */
async function readBoard(
  actor: Actor,
  project: ProjectRow,
): Promise<BoardView | null> {
  if (!project.modules.enabled.includes('board')) return null
  const boards = await listBoards(actor)
  if (!boards.some((entry) => entry.projectId === project.id)) return null
  return openBoard(actor, project.id)
}

/**
 * `refs` edges touching this project's records, counted per (from, to,
 * role). A record is the project's when its row carries the project's id;
 * a prompt variant through its prompt. Always filtered by owner. A record in
 * the Trash draws no edge.
 */
async function refCounts(
  ownerId: string,
  projectId: string,
): Promise<{ from: string; to: string; role: string; n: number }[]> {
  const db = getDb()
  if (!db) return []
  const records = (
    type: string,
    table: typeof notesTable | typeof boardCards,
  ) =>
    sql`select ${type}::text as type, ${table.id} as id from ${table} where ${table.ownerId} = ${ownerId} and ${table.projectId} = ${projectId} and ${table.deletedAt} is null`
  const rows = await db.execute<{
    from_type: string
    to_type: string
    role: string
    n: number
  }>(sql`
    with recs as (
      ${records('note', notesTable)}
      union all ${sql`select 'prompt'::text, ${promptPrompts.id} from ${promptPrompts} where ${promptPrompts.ownerId} = ${ownerId} and ${promptPrompts.projectId} = ${projectId} and ${promptPrompts.deletedAt} is null`}
      union all ${sql`select 'prompt_variant'::text, ${promptVariants.id} from ${promptVariants} inner join ${promptPrompts} on ${promptPrompts.id} = ${promptVariants.promptId} where ${promptPrompts.ownerId} = ${ownerId} and ${promptPrompts.projectId} = ${projectId} and ${promptPrompts.deletedAt} is null`}
      union all ${records('card', boardCards)}
      union all ${sql`select 'asset'::text, ${assetAssets.id} from ${assetAssets} where ${assetAssets.ownerId} = ${ownerId} and ${assetAssets.projectId} = ${projectId}`}
      union all ${sql`select 'shot'::text, ${storyShots.id} from ${storyShots} where ${storyShots.ownerId} = ${ownerId} and ${storyShots.projectId} = ${projectId}`}
      union all ${sql`select 'event'::text, ${calendarEvents.id} from ${calendarEvents} where ${calendarEvents.ownerId} = ${ownerId} and ${calendarEvents.projectId} = ${projectId} and ${calendarEvents.deletedAt} is null`}
      union all ${sql`select 'quote'::text, ${quoteQuotes.id} from ${quoteQuotes} where ${quoteQuotes.ownerId} = ${ownerId} and ${quoteQuotes.projectId} = ${projectId}`}
      union all ${sql`select 'post'::text, ${publishPosts.id} from ${publishPosts} where ${publishPosts.ownerId} = ${ownerId} and ${publishPosts.projectId} = ${projectId}`}
      union all ${sql`select 'listing'::text, ${marketListings.id} from ${marketListings} where ${marketListings.ownerId} = ${ownerId} and ${marketListings.projectId} = ${projectId}`}
      union all ${sql`select 'experiment'::text, ${expExperiments.id} from ${expExperiments} where ${expExperiments.ownerId} = ${ownerId} and ${expExperiments.projectId} = ${projectId}`}
      union all ${sql`select 'proposal'::text, ${agentProposals.id} from ${agentProposals} where ${agentProposals.ownerId} = ${ownerId} and ${agentProposals.projectId} = ${projectId}`}
    )
    select ${refs.fromType} as from_type, ${refs.toType} as to_type, ${refs.role} as role, count(*)::int as n
    from ${refs}
    where ${refs.ownerId} = ${ownerId}
      and (
        exists (select 1 from recs where recs.type = ${refs.fromType} and recs.id = ${refs.fromId})
        or exists (select 1 from recs where recs.type = ${refs.toType} and recs.id = ${refs.toId})
      )
    group by 1, 2, 3`)
  return [...rows].map((row) => ({
    from: row.from_type,
    to: row.to_type,
    role: row.role,
    n: Number(row.n),
  }))
}

/** Open requests about a card of this project, and the card's lane — so a lane can say ◆. */
async function requestLanes(
  ownerId: string,
  projectId: string,
): Promise<Map<string, string>> {
  const db = getDb()
  if (!db) return new Map()
  const rows = await db
    .select({ id: opsHumanRequests.id, laneId: boardCards.laneId })
    .from(opsHumanRequests)
    .innerJoin(
      boardCards,
      and(
        eq(boardCards.id, opsHumanRequests.targetId),
        eq(boardCards.ownerId, opsHumanRequests.ownerId),
      ),
    )
    .where(
      and(
        eq(opsHumanRequests.ownerId, ownerId),
        eq(opsHumanRequests.projectId, projectId),
        eq(opsHumanRequests.status, 'open'),
        eq(opsHumanRequests.targetType, 'card'),
      ),
    )
  return new Map(rows.map((row) => [row.id, row.laneId]))
}

/** Posts going out or gone out this week. */
async function postsThisWeek(
  ownerId: string,
  projectId: string,
  span: { start: Date; end: Date },
) {
  const db = getDb()
  if (!db) return []
  return db
    .select({
      id: publishPosts.id,
      title: publishPosts.title,
      caption: publishPosts.caption,
      status: publishPosts.status,
      scheduledFor: publishPosts.scheduledFor,
      postedAt: publishPosts.postedAt,
    })
    .from(publishPosts)
    .where(
      and(
        eq(publishPosts.ownerId, ownerId),
        eq(publishPosts.projectId, projectId),
        isNull(publishPosts.removedAt),
        or(
          and(
            gte(publishPosts.scheduledFor, span.start),
            lt(publishPosts.scheduledFor, span.end),
          ),
          and(
            gte(publishPosts.postedAt, span.start),
            lt(publishPosts.postedAt, span.end),
          ),
        ),
      ),
    )
    .orderBy(
      sql`coalesce(${publishPosts.postedAt}, ${publishPosts.scheduledFor})`,
    )
    .limit(8)
}

async function routinesOf(ownerId: string, projectId: string) {
  const db = getDb()
  if (!db) return []
  return db
    .select({
      id: agentRoutines.id,
      name: agentRoutines.name,
      modules: agentRoutines.modules,
      enabled: agentRoutines.enabled,
    })
    .from(agentRoutines)
    .where(
      and(
        eq(agentRoutines.ownerId, ownerId),
        eq(agentRoutines.projectId, projectId),
        isNull(agentRoutines.archivedAt),
      ),
    )
    .orderBy(desc(agentRoutines.enabled), agentRoutines.name)
}

/* ── The map ───────────────────────────────────────────────────────── */

export async function loadProjectMap(
  actor: Actor,
  project: ProjectRow,
): Promise<ProjectMapData> {
  const on = (id: string) => project.modules.enabled.includes(id)
  const tz = project.timezone
  const today = zonedDay(new Date(), tz)
  const week = weekRange(today, tz)
  const ownerId = actor.userId

  const [
    reads,
    board,
    counts,
    lanesOfRequests,
    filed,
    events,
    posts,
    runs,
    routines,
  ] = await Promise.all([
    safe(loadModuleReads(actor)),
    safe(readBoard(actor, project)),
    safe(refCounts(ownerId, project.id)),
    safe(requestLanes(ownerId, project.id)),
    safe(listNotes(ownerId, { projectId: project.id })),
    on('calendar')
      ? safe(
          listEvents(actor, {
            projectId: project.id,
            from: week.from,
            to: week.to,
          }),
        )
      : Promise.resolve(null),
    on('publish')
      ? safe(postsThisWeek(ownerId, project.id, week))
      : Promise.resolve(null),
    on('agents')
      ? safe(listRuns(actor, { projectId: project.id, limit: 30 }))
      : Promise.resolve(null),
    on('agents')
      ? safe(routinesOf(ownerId, project.id))
      : Promise.resolve(null),
  ])

  const cells = reads ? cellsOf(reads, project) : {}
  const entries = (reads?.entries ?? []).filter(
    (entry) => entry.project?.slug === project.slug,
  )
  const kindLabel = KIND_LABEL[project.kind]
  const slug = project.slug

  /* lanes: the board's own, or its kind's preset until the board is made */
  const boardOn = on('board')
  const lanes: Lane[] = board
    ? board.lanes.map((lane) => ({
        name: lane.name,
        role: lane.role,
        count: lane.count,
        sum: lane.sum,
        currency: lane.currency,
        other: lane.otherCurrencies,
        wip: lane.wipLimit,
        due: board.cards.filter(
          (card) =>
            card.laneId === lane.id && card.dueOn && card.dueOn <= today,
        ).length,
      }))
    : LANE_PRESETS[project.kind].map((lane) => ({
        name: lane.name,
        role: lane.role,
        count: 0,
        sum: null,
        currency: null,
        other: 0,
        wip: null,
        due: 0,
      }))
  const laneIndexById = new Map(
    (board?.lanes ?? []).map((lane, index) => [lane.id, index]),
  )
  const counts0 = lanes.map((lane) => lane.count)

  /* what waits, per node */
  const waitingAt = new Map<string, string[]>()
  const place = (node: string, id: string) =>
    waitingAt.set(node, [...(waitingAt.get(node) ?? []), id])
  for (const entry of entries) {
    if (entry.module === 'board') {
      const laneId = lanesOfRequests?.get(entry.id)
      const index = laneId ? laneIndexById.get(laneId) : undefined
      // A proposed card lands in the first lane when it's accepted.
      if (index !== undefined) place(`lane:${index}`, entry.id)
      else if (entry.kind === 'proposal') place('lane:0', entry.id)
    } else if (entry.module) place(entry.module, entry.id)
  }

  /*
   * Running routines: a ▶ chip on Agents and on each module a routine works
   * in (lanes excepted — a routine works on the board, not in one lane).
   * Only routine runs, the ones the Agents cell counts.
   */
  const routineById = new Map((routines ?? []).map((row) => [row.id, row]))
  const liveChips = new Map<string, string>()
  for (const run of runs ?? []) {
    const routine = run.routineId ? routineById.get(run.routineId) : undefined
    if (run.status !== 'running' || !routine) continue
    const text = `▶ ${routine.name}`
    if (!liveChips.has('agents')) liveChips.set('agents', text)
    for (const module of routine.modules)
      if (module !== 'board' && !liveChips.has(module))
        liveChips.set(module, text)
  }

  /* money: readings net 7d, or what sits awaiting payment */
  const summary = reads?.boards?.find((row) => row.projectId === project.id)
  const pending = money(
    (summary?.awaiting ?? []).map((row) => ({
      currency: row.currency,
      amount: row.sum,
    })),
  )
  const pendingLabel = pending.map((entry) => entry.label).join(' + ')
  const readings = on('readings') ? cells.readings : undefined
  const moneyNonZero =
    readings != null && readings.state !== 'unknown' && readings.value !== 0

  /* ── nodes ── */
  const nodes: MapNodeData[] = []
  const nodeBase = (
    id: string,
    kind: NodeKind,
    module: MapModule,
    col: 0 | 1 | 2,
    row: number,
  ) => ({
    id,
    kind,
    module,
    x: COL_X[col],
    y: rowY(row),
    w: NODE_W[kind],
    h: NODE_H[kind],
  })
  const finish = (
    node: Omit<MapNode, 'aria' | 'chip'> & { chip?: MapNode['chip'] },
    extra: Partial<Pick<MapNodeData, 'facts' | 'about'>> = {},
  ): MapNodeData => {
    const waiting = waitingAt.get(node.id) ?? []
    const live = liveChips.get(node.module)
    const chip: MapNode['chip'] =
      node.chip ??
      (live && !node.off
        ? { tone: 'live', text: live }
        : node.state === 'wait'
          ? { tone: 'wait', text: 'waits for you' }
          : null)
    const figure = node.off
      ? 'off'
      : `${node.mark ? `${node.mark} ` : ''}${node.big}${node.unit ? ` ${node.unit}` : ''}`
    // In words: no glyphs, and nothing said twice.
    const plain = (text: string) => text.replace(/[◆▶●]\s*/g, '').trim()
    const said = plain(figure)
    const aria = [
      node.label,
      said,
      plain(node.sub) === said ? '' : plain(node.sub),
      node.state && node.state !== 'wait' && STATE_WORD[node.state]
        ? STATE_WORD[node.state]
        : node.state === 'wait' && !`${said} ${node.sub}`.includes('waiting')
          ? 'waiting for you'
          : '',
      chip?.tone === 'live' ? `${plain(chip.text)} running` : '',
    ]
      .filter(Boolean)
      .join(', ')
    const full: MapNode = { ...node, chip, aria }
    return {
      ...full,
      read: readOf(full),
      facts: extra.facts ?? [],
      about: extra.about ?? '',
      waiting,
    }
  }

  const moduleNode = (
    id: ModuleId,
    kind: NodeKind,
    col: 0 | 1 | 2,
    row: number,
  ): MapNodeData => {
    const cell = fromCell(cells[id], waitingAt.get(id)?.length ?? 0)
    const meta = MODULES[id]
    return finish(
      {
        ...nodeBase(id, kind, id, col, row),
        label: meta.label,
        glyph: meta.glyph,
        role: kind === 'src' ? 'feeds' : 'drains',
        ...cell,
        off: false,
        href: `/p/${slug}/${id}`,
        open: `Open ${meta.label}`,
      },
      {
        facts: [
          ['module', `${meta.glyph} ${meta.label}`],
          ['kind', kindLabel],
          ['state', STATE_WORD[cell.state] ?? 'idle'],
        ],
      },
    )
  }

  const notesNode = (row: number): MapNodeData | null => {
    const list = filed ?? []
    const promoted = list.filter((note) => note.promotedTo).length
    const promotes = (counts ?? [])
      .filter((row) => row.role === 'promoted_to')
      .reduce((sum, row) => sum + row.n, 0)
    const waits = waitingAt.get('notes')?.length ?? 0
    if (!list.length && !promotes && !waits) return null
    const parked = list.length - promoted
    return finish(
      {
        ...nodeBase('notes', 'src', 'notes', 0, row),
        label: 'Notes',
        glyph: '▢',
        role: 'feeds',
        mark: waits ? '◆' : '',
        big: waits ? n(waits) : filed ? n(list.length) : '—',
        unit: waits
          ? 'waiting'
          : filed
            ? plural(list.length, 'note')
            : 'not read back',
        tone: waits ? 'wait' : list.length ? '' : 'dim',
        sub: waits
          ? `${list.length} ${plural(list.length, 'note')} filed here`
          : !filed
            ? ''
            : parked
              ? `${parked} parked · ${promoted} promoted`
              : list.length
                ? `${promoted} promoted`
                : 'nothing parked here',
        state: waits ? 'wait' : '',
        off: false,
        href: '/notes',
        open: 'Open Notes',
      },
      {
        facts: [
          ['filed here', filed ? String(list.length) : '—'],
          ['parked', filed ? String(parked) : '—'],
          ['promoted', filed ? String(promoted) : '—'],
        ],
      },
    )
  }

  const moneyNode = (row: number): MapNodeData | null => {
    if (project.kind === 'freelance') {
      const awaitingIndex = lanes.findIndex(
        (lane) => lane.role === 'awaiting_payment',
      )
      return finish(
        {
          ...nodeBase('money', 'sink', 'money', 2, row),
          label: 'Money',
          glyph: '฿',
          role: 'drains',
          mark: '',
          big: pendingLabel ? `(${pendingLabel})` : '0',
          unit: 'awaiting',
          tone: 'dim',
          sub: pendingLabel
            ? 'counted once it is marked paid'
            : 'nothing awaiting payment',
          state: '',
          off: false,
          href: `/p/${slug}/board${awaitingIndex >= 0 ? `#lane-${awaitingIndex}` : ''}`,
          open: 'Open Awaiting payment',
        },
        {
          facts: [
            ['awaiting', pendingLabel || '0'],
            [
              'cards',
              String(summary?.awaiting.reduce((s, r) => s + r.cards, 0) ?? 0),
            ],
          ],
          about:
            'Awaiting payment is not income until the card is marked paid.',
        },
      )
    }
    if (!readings) return null
    const unknown = readings.state === 'unknown'
    return finish(
      {
        ...nodeBase('money', 'sink', 'money', 2, row),
        label: 'Money · 7d',
        glyph: '฿',
        role: 'drains',
        mark: '',
        big: unknown ? '— not read back' : String(readings.value),
        unit: unknown ? '' : '7d',
        tone: unknown ? 'dim' : moneyNonZero ? 'money' : 'dim',
        sub: unknown
          ? 'readings not read back'
          : moneyNonZero
            ? 'net, read back from readings'
            : 'nothing recorded in 7 days',
        state: unknown ? 'unknown' : '',
        off: false,
        href: `/p/${slug}/readings`,
        open: 'Open Readings',
      },
      {
        facts: [
          ['net 7d', unknown ? '—' : String(readings.value)],
          ['source', 'readings'],
        ],
        about: 'Money is what was read back, never what was promised.',
      },
    )
  }

  const place0 = PLACE[project.kind]
  const used = new Set<string>(['board'])
  const slotOf = new Map<string, number | string>()
  const add = (
    id: MapModule,
    kind: 'src' | 'sink',
    row: number,
    to: number | string,
  ) => {
    const col = kind === 'src' ? 0 : 2
    const node =
      id === 'notes'
        ? notesNode(row)
        : id === 'money'
          ? moneyNode(row)
          : on(id)
            ? moduleNode(id, kind, col, row)
            : null
    if (!node) return
    nodes.push(node)
    used.add(id)
    slotOf.set(node.id, to)
  }
  for (const [id, row, to] of place0.src) add(id, 'src', row, to)

  // The lanes, stacked in the middle column.
  lanes.forEach((lane, index) => {
    const awaiting = lane.role === 'awaiting_payment'
    const waits = waitingAt.get(`lane:${index}`)?.length ?? 0
    const sum =
      lane.sum && lane.currency ? formatMoney(lane.sum, lane.currency) : null
    const extraCurrencies = lane.other
      ? ` + ${lane.other} in ${plural(lane.other, 'another currency', 'other currencies')}`
      : ''
    const sub = !boardOn
      ? 'Board is off'
      : !board
        ? 'no board yet'
        : waits
          ? `◆ ${waits} waiting`
          : awaiting
            ? sum
              ? `(${sum}) awaiting${extraCurrencies}`
              : 'nothing awaiting'
            : [
                sum ? `${sum}${extraCurrencies}` : '',
                lane.due ? `● ${lane.due} due` : '',
              ]
                .filter(Boolean)
                .join(' · ') ||
              (lane.count
                ? `${lane.count} ${plural(lane.count, 'card')}`
                : 'empty')
    nodes.push(
      finish(
        {
          ...nodeBase(`lane:${index}`, 'lane', 'board', 1, index),
          label: lane.name,
          glyph: '▦',
          role: awaiting ? 'pinned right' : `lane ${index + 1}`,
          // A lane's figure is its cards (they add up to the Board cell); what waits is under it.
          mark: '',
          big: boardOn ? n(lane.count) : 'off',
          unit: boardOn ? plural(lane.count, 'card') : '',
          tone: waits ? 'wait' : lane.count ? '' : 'dim',
          sub,
          state: waits ? 'wait' : '',
          off: !boardOn,
          href: `/p/${slug}/board#lane-${index}`,
          open: 'Open in Board',
          lane: { index, counts: counts0 },
        },
        {
          facts: [
            ['lane', `${lane.name} · ${index + 1} of ${lanes.length}`],
            [
              'role',
              awaiting
                ? 'awaiting payment'
                : lane.role === 'done'
                  ? 'done'
                  : 'normal',
            ],
            ['cards', String(lane.count)],
            ['sum', sum ? `${sum}${extraCurrencies}` : '—'],
            ['wip limit', lane.wip ? String(lane.wip) : 'none'],
          ],
          about: awaiting
            ? 'Pinned right on the board. Its sum is owed, not income, until a card is marked paid.'
            : `Lane ${index + 1} of the ${kindLabel} board.`,
        },
      ),
    )
  })

  for (const [id, row, to] of place0.sink) add(id, 'sink', row, to)

  // Any other module the owner switched on joins the feeders, below the rest.
  let extraRow = Math.max(
    lanes.length,
    ...nodes.map(
      (node) => Math.round((node.y - rowY(0)) / (rowY(1) - rowY(0))) + 1,
    ),
  )
  for (const id of orderedModules(project.kind, project.modules.enabled)) {
    if (used.has(id)) continue
    const node = moduleNode(id, 'src', 0, extraRow++)
    nodes.push(node)
    used.add(id)
    slotOf.set(node.id, -1)
  }

  /* ── edges ── */
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const flows = new Map<string, { word: string; n: number }[]>()
  for (const row of counts ?? []) {
    const at = attributeRef(row.role, row.from, row.to)
    if (!at) continue
    const parts = flows.get(at.node) ?? []
    const same = parts.find((part) => part.word === at.word)
    if (same) same.n += row.n
    else parts.push({ word: at.word, n: row.n })
    flows.set(at.node, parts)
  }
  const edges: MapEdge[] = []
  const edge = (
    from: string,
    to: string,
    label: string,
    tone: EdgeTone,
    words?: string,
  ) => {
    const a = byId.get(from)
    const b = byId.get(to)
    if (!a || !b) return
    edges.push({
      id: `${from}>${to}`,
      from,
      to,
      ...edgePath(a, b),
      label,
      tone,
      words:
        words ??
        `${a.label} to ${b.label}${label ? `: ${label}` : ', nothing yet'}`,
    })
  }
  const laneAt = (index: number) =>
    `lane:${Math.max(0, Math.min(lanes.length - 1, index))}`

  // The board's own order: lane to lane, lit where the next lane holds cards.
  for (let index = 1; index < lanes.length; index++)
    edge(
      `lane:${index - 1}`,
      `lane:${index}`,
      '',
      (lanes[index]?.count ?? 0) > 0 ? '' : 'plan',
      `${lanes[index - 1]?.name} then ${lanes[index]?.name}, on the board`,
    )

  for (const node of nodes) {
    if (node.kind === 'lane') continue
    const to = slotOf.get(node.id)
    const parts = flows.get(node.module) ?? []
    const total = parts.reduce((sum, part) => sum + part.n, 0)
    const waits = node.state === 'wait'
    const label = total
      ? countLabel(parts)
      : waits
        ? `◆ ${Math.max(1, node.waiting.length)} waiting`
        : ''
    const tone: EdgeTone = waits ? 'wait' : total ? '' : 'plan'

    if (node.module === 'money') {
      if (project.kind === 'freelance')
        edge(
          laneAt(typeof to === 'number' ? to : lanes.length - 1),
          'money',
          pendingLabel ? `(${pendingLabel}) awaiting` : '',
          'plan',
        )
      else
        edge(
          String(to),
          'money',
          readings?.state === 'unknown'
            ? '— not read back'
            : moneyNonZero
              ? String(readings?.value)
              : '',
          moneyNonZero ? 'money' : 'plan',
        )
      continue
    }
    if (node.module === 'readings' && typeof to === 'string') {
      const feed = cells[to as ModuleId]
      const value = typeof feed?.value === 'number' ? feed.value : 0
      edge(
        to,
        'readings',
        feed && value ? `${n(value)} ${feed.unit ?? ''}`.trim() : '',
        waits ? 'wait' : value ? '' : 'plan',
      )
      continue
    }
    if (to === -1) {
      // An extra module draws its edge only when something flowed or waits.
      if (!total && !waits) continue
      const lane = laneAt(EXTRA_LANE[node.module] ?? 0)
      edge(node.id, lane, label, tone)
      continue
    }
    if (typeof to === 'number') {
      const lane = laneAt(to)
      if (node.kind === 'sink' || READS_FROM_LANE.has(node.module))
        edge(lane, node.id, label, tone)
      else edge(node.id, lane, label, tone)
    } else if (typeof to === 'string') edge(to, node.id, label, tone)
  }

  /* ── the inspector's rows ── */
  const weekRows: WeekRow[] = []
  if (board)
    for (const card of board.cards) {
      if (!card.dueOn || card.dueOn > week.to) continue
      const index = laneIndexById.get(card.laneId)
      if (index === undefined) continue
      const overdue = card.dueOn < today
      if (overdue && lanes[index]?.role === 'done') continue
      weekRows.push({
        id: card.id,
        node: `lane:${index}`,
        title: card.title,
        when: overdue
          ? `overdue · ${weekday(card.dueOn)}`
          : card.dueOn === today
            ? '● due today'
            : `due ${weekday(card.dueOn)}`,
        tone: card.dueOn <= today ? 'soon' : '',
        href: `/p/${slug}/board?card=${card.id}`,
      })
    }
  for (const event of events?.events ?? [])
    weekRows.push({
      id: event.id,
      node: 'calendar',
      title: event.title,
      when: event.dates
        ? `${weekday(event.dates.first)} · all day`
        : dayWords(event.startsAt, tz),
      tone:
        (event.dates ? event.dates.first : zonedDay(event.startsAt, tz)) ===
        today
          ? 'soon'
          : '',
      href: `/p/${slug}/calendar?event=${event.id}`,
    })
  for (const post of posts ?? []) {
    const at = post.postedAt ?? post.scheduledFor
    const title =
      post.title?.trim() ||
      post.caption.split('\n')[0]?.trim().slice(0, 80) ||
      'Untitled post'
    weekRows.push({
      id: post.id,
      node: 'publish',
      title,
      when: post.postedAt
        ? `posted ${dayWords(post.postedAt, tz, false)}`
        : at
          ? `${post.status} · ${dayWords(at, tz)}`
          : post.status,
      tone: post.postedAt ? 'done' : '',
      href: `/p/${slug}/publish?post=${post.id}`,
    })
  }

  const runRows: RunRow[] = (runs ?? []).slice(0, 8).map((run: RunItem) => {
    const routine = run.routineId ? routineById.get(run.routineId) : undefined
    const known = run.cost
      .filter((line) => line.minor > 0)
      .map((line) =>
        formatMoney(
          fromMinor(BigInt(line.minor), digitsOf(line.currency)),
          line.currency,
        ),
      )
    const status =
      run.status === 'running'
        ? 'running'
        : run.status === 'succeeded'
          ? 'done'
          : run.status === 'abandoned'
            ? 'abandoned · lease lapsed'
            : run.status
    return {
      id: run.id,
      routine: routine?.name ?? 'An agent, on its own',
      modules: routine?.modules ?? [],
      glyph:
        run.status === 'running'
          ? '▶'
          : run.status === 'failed' || run.status === 'abandoned'
            ? '◆'
            : '○',
      tone:
        run.status === 'running'
          ? 'live'
          : run.status === 'failed' || run.status === 'abandoned'
            ? 'problem'
            : 'off',
      status,
      when: dayWords(run.startedAt, tz),
      cost: known.length
        ? `${known.join(' + ')}${run.unknownCosts ? ' + —' : ''}`
        : run.unknownCosts
          ? '—'
          : '0',
      href: routine
        ? `/p/${slug}/agents?routine=${routine.id}`
        : `/p/${slug}/agents?view=runs`,
    }
  })

  const noteItems: NoteItem[] = (filed ?? []).slice(0, 12).map((note) => ({
    id: note.id,
    title:
      note.title?.trim() ||
      note.body
        .split('\n')
        .find((line) => line.trim())
        ?.replace(/^[#\-*\s[\]x]+/, '')
        .slice(0, 80) ||
      'Untitled note',
    promoted: Boolean(note.promotedTo),
    href: `/notes?note=${note.id}`,
  }))

  /* ── the project itself ── */
  // The Agents cell's number, so the well agrees with the rail.
  const running =
    typeof cells.agents?.value === 'number' ? cells.agents.value : 0
  const eventsToday =
    typeof cells.calendar?.value === 'number' ? cells.calendar.value : 0
  const cardsDue = (summary?.dueToday ?? 0) + (summary?.overdue ?? 0)
  const weekAgo = Date.now() - 7 * 86_400_000
  const recent = (runs ?? []).filter(
    (run) => run.startedAt.getTime() >= weekAgo,
  )
  const spend = new Map<string, number>()
  let unknownSpend = 0
  for (const run of recent) {
    unknownSpend += run.unknownCosts
    for (const line of run.cost)
      spend.set(line.currency, (spend.get(line.currency) ?? 0) + line.minor)
  }
  const spent = [...spend.entries()]
    .filter(([, minor]) => minor > 0)
    .map(([currency, minor]) =>
      formatMoney(fromMinor(BigInt(minor), digitsOf(currency)), currency),
    )
  const cost7d = !on('agents')
    ? '—'
    : !runs
      ? '— not read back'
      : spent.length
        ? `${spent.join(' + ')}${unknownSpend ? ` + ${unknownSpend} not known` : ''}`
        : unknownSpend
          ? `${unknownSpend} not known`
          : '0'
  const enabledRoutines = (routines ?? []).filter((row) => row.enabled).length

  const read: ReadoutData = readings
    ? readings.state === 'unknown'
      ? {
          mark: '',
          big: '— not read back',
          unit: '',
          sub: readings.sub ?? '',
          tone: 'dim',
        }
      : {
          mark: '',
          big: String(readings.value),
          unit: '7d',
          sub: readings.sub ?? '',
          tone: moneyNonZero ? 'accent' : '',
        }
    : pendingLabel
      ? {
          mark: '',
          big: `(${pendingLabel})`,
          unit: 'awaiting',
          sub: 'not counted until it is marked paid',
          tone: 'dim',
        }
      : {
          mark: '',
          big: 'no money module',
          unit: '',
          sub: `${kindLabel} project`,
          tone: 'dim',
        }

  const hudMoney = readings
    ? readings.state === 'unknown'
      ? '— not read back'
      : moneyNonZero
        ? `${readings.value} 7d`
        : 'nothing recorded 7d'
    : pendingLabel
      ? `(${pendingLabel}) awaiting`
      : 'no money module'

  const bounds = boundsOf(nodes)
  return {
    project: {
      id: project.id,
      slug,
      name: project.name,
      kind: project.kind,
      kindLabel,
      color: hex(project.color),
      status: project.status,
    },
    hud: { waiting: entries.length, running, money: hudMoney },
    bounds,
    world: {
      w: Math.max(1600, bounds.x + bounds.w + 40),
      h: Math.max(900, bounds.y + bounds.h + 40),
    },
    nodes,
    edges,
    entries,
    week: weekRows,
    runs: runRows,
    notes: noteItems,
    overview: {
      read,
      facts: [
        ['waiting', entries.length ? `◆ ${entries.length}` : 'nothing'],
        ['running', running ? `▶ ${running}` : '0'],
        [
          'due today',
          `${cardsDue} ${plural(cardsDue, 'card')} · ${eventsToday} ${plural(eventsToday, 'event')}`,
        ],
        [
          'routines',
          !on('agents')
            ? 'Agents is off'
            : routines
              ? routines.length
                ? `${enabledRoutines} of ${routines.length} on`
                : 'none'
              : '—',
        ],
        ['cost 7d', cost7d],
        ['lanes', lanes.map((lane) => lane.name).join(' · ')],
      ],
      modules: Object.values(MODULES)
        .filter((meta) => !meta.hqWide)
        .map((meta) => ({
          id: meta.id,
          label: meta.label,
          glyph: meta.glyph,
          on: on(meta.id),
        })),
    },
  }
}
