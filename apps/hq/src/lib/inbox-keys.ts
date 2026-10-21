/**
 * Keys an answer never takes, because the pages that print answers already
 * use them: `j` `k` move through the list on `/inbox` and
 * Home, and the shell keeps `i` inbox, `n` note and `c` new. Digits are the
 * views and `?` the key list, so an answer's key is always a letter.
 */
export const TAKEN_KEYS: readonly string[] = ['c', 'i', 'j', 'k', 'n']
const LETTERS = [...'abcdefghijklmnopqrstuvwxyz']

/**
 * A key for each answer button of one item (lib/inbox.ts): the first letter
 * of its label not taken yet, else the first free letter — a Thai label has
 * none of its own.
 */
export function keysFor<T extends { key: string; label: string }>(
  options: readonly T[],
): (T & { hotkey: string })[] {
  const used = new Set<string>(TAKEN_KEYS)
  return options.map((option) => {
    const free = (ch: string) => /[a-z]/.test(ch) && !used.has(ch)
    const letter =
      [...option.label.toLowerCase()].find(free) ?? LETTERS.find(free) ?? ''
    used.add(letter)
    return { ...option, hotkey: letter }
  })
}
