/**
 * A prompt's text is a template (2026-09-30): `<HAIR_COLOR>` marks a slot —
 * what the owner calls a variant — and each slot has options, a short key
 * picked by name ("punk") and the value that goes into the text ("black punk
 * style with red highlight"). A value may be a whole block of lines, so a
 * slot on its own line swaps a block:
 *
 *   prompt header
 *   <STYLE>
 *   prompt ending
 *
 * A slot is `<` + an upper-case name + `>` — letters, digits and `_`, first a
 * letter — so `<lora:name:0.8>` and other angle brackets stay text. A value is
 * put in as written: a `<NAME>` inside a value is not filled again.
 *
 * Pure — no database, no framework — so the page and the services read the
 * same rules.
 */

export const SLOT_NAME = /^[A-Z][A-Z0-9_]{0,39}$/
const SLOT = /<([A-Z][A-Z0-9_]{0,39})>/g

/** The slot names in the texts, each once, in the order they first appear. */
export function slotNames(...texts: (string | null | undefined)[]): string[] {
  const out: string[] = []
  for (const text of texts)
    for (const match of (text ?? '').matchAll(SLOT)) {
      const name = match[1] as string
      if (!out.includes(name)) out.push(name)
    }
  return out
}

/** The text with each named slot filled; a slot with no value stays as written. */
export function fillSlots(
  text: string,
  values: Readonly<Record<string, string>>,
): string {
  return text.replace(SLOT, (whole, name: string) =>
    Object.hasOwn(values, name) ? (values[name] as string) : whole,
  )
}

/** The text in pieces — literal text and slots — for a reader that marks the slots. */
export function splitSlots(
  text: string,
): ({ text: string } | { slot: string })[] {
  const parts: ({ text: string } | { slot: string })[] = []
  let at = 0
  for (const match of text.matchAll(SLOT)) {
    const index = match.index ?? 0
    if (index > at) parts.push({ text: text.slice(at, index) })
    parts.push({ slot: match[1] as string })
    at = index + match[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}

/** An upper-case slot name from what someone typed: `hair color` → `HAIR_COLOR`. */
export function slotName(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^[^A-Z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 40)
}
