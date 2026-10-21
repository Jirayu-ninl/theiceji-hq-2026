import { NOTE_COLORS, type NoteColor } from '@/db/enums'

/**
 * Notes domain — the note shape plus the pure helpers both sides need.
 *
 * Deliberately dependency-free so client components can import it: the colour
 * set comes from `@/db/enums`, which the Drizzle schema also reads, so the
 * TypeScript union and the table's CHECK constraint can never drift apart.
 */

export type { NoteColor }
export { NOTE_COLORS }

/** Which bucket the board is showing. One note is in exactly one. */
export const NOTE_VIEWS = ['active', 'archive', 'trash'] as const
export type NoteView = (typeof NOTE_VIEWS)[number]

export const VIEW_LABEL: Record<NoteView, string> = {
  active: 'Notes',
  archive: 'Archive',
  trash: 'Trash',
}

/** Days a note sits in the trash before the board's own load sweeps it. */
export const TRASH_DAYS = 30

/**
 * Days without an edit after which the Overview counts a note as forgotten.
 * Nothing acts on it — a backlog is allowed to be old. It is only surfaced,
 * because an idea nobody has looked at in a month is the one worth a glance.
 */
export const STALE_DAYS = 30

export const TITLE_MAX = 200
export const BODY_MAX = 20000
export const LABEL_MAX = 40
export const LABELS_MAX = 12

export type Note = {
  id: string
  createdAt: string
  updatedAt: string
  title: string | null
  body: string
  color: NoteColor
  pinned: boolean
  labels: string[]
  position: number
  promotedTo: Record<string, unknown> | null
  /** The project it is filed under, if any. */
  projectId: string | null
  archivedAt: string | null
  deletedAt: string | null
}

/** Everything a note's own editor can change. Every field is optional. */
export type NotePatch = {
  title?: string | null
  body?: string
  color?: NoteColor
  pinned?: boolean
  labels?: string[]
  /** File it under a project; null takes it out. */
  projectId?: string | null
}

export function isNoteColor(value: string): value is NoteColor {
  return (NOTE_COLORS as readonly string[]).includes(value)
}

/**
 * Which bucket a note is actually in. The board knows this from the view it
 * loaded, but an editor opened from anywhere else in HQ — the command menu,
 * a share — has only the note, and its tools have to match.
 */
export function viewOf(note: Note): NoteView {
  if (note.deletedAt) return 'trash'
  if (note.archivedAt) return 'archive'
  return 'active'
}

export function isNoteView(
  value: string | null | undefined,
): value is NoteView {
  return (NOTE_VIEWS as readonly string[]).includes(value ?? '')
}

/**
 * Labels are free-form, the same convention as the website's project tags:
 * trimmed, case-preserved, de-duplicated case-insensitively, and capped so one
 * runaway paste cannot fill the card.
 */
export function normalizeLabels(input: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    const label = raw.trim().replace(/\s+/g, ' ').slice(0, LABEL_MAX)
    if (!label) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label)
    if (out.length >= LABELS_MAX) break
  }
  return out
}

/** A note with no title, no body and no labels is not worth a row. */
export function isBlank(patch: NotePatch): boolean {
  return (
    !patch.title?.trim() &&
    !patch.body?.trim() &&
    (patch.labels ?? []).length === 0
  )
}

/**
 * The line the card shows when a note has no title — its first non-empty line,
 * with any checklist or list marker stripped.
 */
export function fallbackTitle(body: string): string {
  for (const line of body.split('\n')) {
    const text = line.replace(/^\s*(?:[-*+]\s*(?:\[[ xX]\])?|#+)\s*/, '').trim()
    if (text) return text
  }
  return ''
}

/** A line the shared markdown reads as its own block, not as prose. */
const BLOCK_LINE = /^(?:#{1,3}\s|\s*[-*]\s|\s*\d+[.)]\s|>)/

/**
 * A note reads the way it was typed, as Keep reads it: every line break
 * stays one. The shared markdown (`lib/md.tsx`) joins a paragraph's lines
 * into one, the CommonMark rule, so a break between two lines of prose
 * becomes a paragraph break here. Lists, quotes, headings and code fences
 * already keep their lines and pass through untouched.
 */
export function keepLines(body: string): string {
  const out: string[] = []
  let fenced = false
  let prose = false
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^```/.test(line)) {
      fenced = !fenced
      prose = false
    } else if (fenced) {
      prose = false
    } else {
      const isProse = line.trim() !== '' && !BLOCK_LINE.test(line)
      if (isProse && prose) out.push('')
      prose = isProse
    }
    out.push(line)
  }
  return out.join('\n')
}

/** How much of a body a Board card shows before it trails off with "…". */
export const EXCERPT_LINES = 8
export const EXCERPT_CHARS = 280

/** A card's share of a body: its first lines, cut short with "…". */
export function excerpt(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').trim().split('\n')
  let text = lines.slice(0, EXCERPT_LINES).join('\n')
  let cut = lines.length > EXCERPT_LINES
  if (text.length > EXCERPT_CHARS) {
    text = text.slice(0, EXCERPT_CHARS)
    cut = true
  }
  return cut ? `${text.trimEnd()}…` : text
}
