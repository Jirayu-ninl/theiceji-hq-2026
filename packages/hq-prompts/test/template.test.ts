import { describe, expect, test } from 'bun:test'
import { fillSlots, slotName, slotNames, splitSlots } from '../src/template'

describe('prompt templates', () => {
  test('a slot is <NAME> in upper case; other angle brackets stay text', () => {
    expect(
      slotNames(
        'Generate a character with <HAIR_COLOR> hair, and <SHIRT_COLOR> shirt. <HAIR_COLOR> again, <lora:film:0.8>, <b>, <1X>, a < b > c',
      ),
    ).toEqual(['HAIR_COLOR', 'SHIRT_COLOR'])
    expect(slotNames('text <A>', null, 'neg <B> <A>', undefined)).toEqual([
      'A',
      'B',
    ])
    expect(slotNames('')).toEqual([])
  })

  test('filling puts each value in as written, blocks included', () => {
    expect(
      fillSlots('Generate a character with <HAIR_COLOR> hair.', {
        HAIR_COLOR: 'black punk style with red highlight',
      }),
    ).toBe(
      'Generate a character with black punk style with red highlight hair.',
    )
    expect(
      fillSlots('prompt header\n<STYLE>\nprompt ending', {
        STYLE: 'line one\nline two',
      }),
    ).toBe('prompt header\nline one\nline two\nprompt ending')
    // A value is not filled again; a slot with no value stays; `$&` is literal.
    expect(fillSlots('<A> <B> <C>', { A: '<B>', C: '$& $1' })).toBe(
      '<B> <B> $& $1',
    )
    // An empty value is a value.
    expect(fillSlots('a<X>b', { X: '' })).toBe('ab')
  })

  test('the text splits into text and slots for a reader that marks them', () => {
    expect(splitSlots('with <HAIR> hair<END>')).toEqual([
      { text: 'with ' },
      { slot: 'HAIR' },
      { text: ' hair' },
      { slot: 'END' },
    ])
    expect(splitSlots('plain')).toEqual([{ text: 'plain' }])
  })

  test('a typed name becomes a slot name', () => {
    expect(slotName('hair color')).toBe('HAIR_COLOR')
    expect(slotName('  2nd shirt-colour! ')).toBe('ND_SHIRT_COLOUR')
    expect(slotName('<style>')).toBe('STYLE')
    expect(slotName('###')).toBe('')
  })
})
