import 'server-only'
import { searchHq, searchTypes } from '@theiceji/hq-core/search'
import type { Actor } from '@theiceji/hq-ops/access'
import '@/modules/register'
import { isConfigured, searchNotes } from './notes/store'
import { fallbackTitle } from './notes/types'

/**
 * What the footer prompt finds as you type (its data owner is hq-core
 * `search.ts`): notes, and every record a module registered a search provider
 * for — cards, prompts, assets, events, quotes, tasks — with a page to open.
 * Projects and waiting items come from the shell's own data, so they aren't
 * listed twice.
 *
 * Served by `POST /api/palette` rather than server actions: Next runs a
 * page's actions one at a time, so two per keystroke queued behind each
 * other — and in front of any real action — while a plain request runs at
 * once and is cancelled when the next keystroke makes it moot.
 */

export type PaletteHit = {
  id: string
  /** The group it shows under: the provider's label (Cards, Prompts, …). */
  group: string
  title: string
  detail: string | null
  projectId: string | null
  href: string
}

export type PaletteNote = { id: string; title: string; labels: string[] }

export type PaletteResult = { notes: PaletteNote[]; hits: PaletteHit[] }

/** Types the palette already lists from the shell's own data. */
const SHOWN_ELSEWHERE = new Set(['project', 'human_request'])

/** A failure is an empty list, never an error in the palette. */
async function notesFor(ownerId: string, text: string): Promise<PaletteNote[]> {
  if (!isConfigured()) return []
  try {
    const found = await searchNotes(ownerId, text)
    return found.slice(0, 6).map((note) => ({
      id: note.id,
      title: note.title?.trim() || fallbackTitle(note.body),
      labels: note.labels,
    }))
  } catch {
    return []
  }
}

async function recordsFor(actor: Actor, text: string): Promise<PaletteHit[]> {
  try {
    const labels = new Map(
      searchTypes().map((entry) => [entry.type, entry.label]),
    )
    const hits = await searchHq(actor, { query: text, limit: 24 })
    return hits
      .filter(
        (hit): hit is typeof hit & { href: string } =>
          Boolean(hit.href) && !SHOWN_ELSEWHERE.has(hit.type),
      )
      .slice(0, 10)
      .map((hit) => ({
        id: `${hit.type}-${hit.id}`,
        group: labels.get(hit.type) ?? hit.type,
        title: hit.title,
        detail: hit.detail ?? null,
        projectId: hit.projectId,
        href: hit.href,
      }))
  } catch {
    return []
  }
}

/** The owner's notes and records matching `query` (two characters or more). */
export async function searchPalette(
  actor: Actor,
  query: string,
): Promise<PaletteResult> {
  const text = query.trim().slice(0, 120)
  if (text.length < 2) return { notes: [], hits: [] }
  const [notes, hits] = await Promise.all([
    notesFor(actor.userId, text),
    recordsFor(actor, text),
  ])
  return { notes, hits }
}
