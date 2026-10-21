/**
 * Checklists are not a second kind of note — they are `- [ ]` lines inside the
 * one markdown body. These pure helpers let a card render and tick them
 * without the editor ever being open, and are shared by both sides.
 */

/** `- [ ] buy milk`, `* [x] done`, `+ [X] done` — the marker plus its text. */
const ITEM = /^(\s*)([-*+])\s+\[([ xX])\]\s?(.*)$/

export type ChecklistItem = {
  /** Index into the body's lines — what `toggleItem` takes back. */
  line: number
  checked: boolean
  text: string
}

export function parseChecklist(body: string): ChecklistItem[] {
  const items: ChecklistItem[] = []
  body.split('\n').forEach((raw, line) => {
    const m = ITEM.exec(raw)
    if (m)
      items.push({ line, checked: m[3] !== ' ', text: (m[4] ?? '').trim() })
  })
  return items
}

/**
 * Flip one checklist item and hand back the whole body. Returns the body
 * unchanged when that line is not a checklist item, so a stale card click
 * after an edit is a no-op rather than a corruption.
 */
export function toggleItem(body: string, line: number): string {
  const lines = body.split('\n')
  const raw = lines[line]
  if (raw === undefined) return body
  const m = ITEM.exec(raw)
  if (!m) return body
  const [, indent = '', bullet = '-', box = ' ', text = ''] = m
  lines[line] = `${indent}${bullet} [${box === ' ' ? 'x' : ' '}] ${text}`
  return lines.join('\n')
}

/** `2/5` for the card's footer, or null when a note has no checklist. */
export function checklistProgress(
  body: string,
): { done: number; total: number } | null {
  const items = parseChecklist(body)
  if (items.length === 0) return null
  return { done: items.filter((i) => i.checked).length, total: items.length }
}

/** The body with every checklist line removed — what a card shows as prose. */
export function stripChecklist(body: string): string {
  return body
    .split('\n')
    .filter((raw) => !ITEM.test(raw))
    .join('\n')
    .trim()
}
