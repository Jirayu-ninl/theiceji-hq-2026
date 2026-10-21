import { describe, expect, test } from 'bun:test'
import { keysFor, TAKEN_KEYS } from '@/lib/inbox-keys'

describe('keysFor — an answer’s key', () => {
  test('is the first free letter of its label, one per answer', () => {
    const keys = keysFor([
      { key: 'approve', label: 'Approve' },
      { key: 'again', label: 'Ask again' },
      { key: 'done', label: 'Done' },
    ]).map((option) => option.hotkey)
    expect(keys).toEqual(['a', 's', 'd'])
  })

  test('never takes a key the list or the shell uses', () => {
    // Every letter of these labels is j, k, i, n or c.
    const keys = keysFor([
      { key: 'one', label: 'Jink' },
      { key: 'two', label: 'Kin' },
      { key: 'three', label: 'Nick' },
    ]).map((option) => option.hotkey)
    for (const key of keys) expect(TAKEN_KEYS).not.toContain(key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('is a letter, never a digit (digits are the views)', () => {
    const keys = keysFor([
      { key: 'yes', label: 'อนุมัติ' },
      { key: 'no', label: 'ไม่' },
      { key: 'later', label: '2' },
    ]).map((option) => option.hotkey)
    expect(keys).toEqual(['a', 'b', 'd'])
    for (const key of keys) expect(key).toMatch(/^[a-z]$/)
  })
})
