import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/lib/md'
import {
  EXCERPT_CHARS,
  EXCERPT_LINES,
  excerpt,
  keepLines,
} from '../src/lib/notes/types'

/** How a note's body reads on its card and in the inspector (NotesPage). */

const LF = '\n'
const html = (body: string) =>
  renderToStaticMarkup(<Markdown source={keepLines(body)} />)

describe('keepLines', () => {
  test('every typed line of prose stays its own line', () => {
    const out = html(['Line one', 'Line two', 'ซื้อเทปกาวสองหน้า'].join(LF))
    expect(out.match(/<p[ >]/g)?.length).toBe(3)
  })

  test('a paragraph then a checklist, as the seed and the screenshot have it', () => {
    const out = html(
      ['ลูกค้าอยากได้โทนสีอบอุ่น', '- [ ] โลโก้', '- [x] ส่งงาน'].join(LF),
    )
    expect(out.match(/<p[ >]/g)?.length).toBe(1)
    expect(out.match(/<li class="task">/g)?.length).toBe(2)
  })

  test('lists, headings and quotes pass through untouched', () => {
    const body = ['# Plan', '- a', '- b', '1. one', '2. two', '> said'].join(
      LF,
    )
    expect(keepLines(body)).toBe(body)
  })

  test('code keeps its own lines, never split into paragraphs', () => {
    const body = ['```', 'const a = 1', 'const b = 2', '```', 'after'].join(LF)
    expect(keepLines(body)).toBe(body)
  })

  test('a blank line stays one break, not two', () => {
    expect(keepLines(['a', '', 'b'].join(LF))).toBe(['a', '', 'b'].join(LF))
    expect(keepLines(['a', 'b'].join(LF))).toBe(['a', '', 'b'].join(LF))
  })

  test('Windows line endings read the same', () => {
    expect(keepLines('a\r\nb')).toBe(['a', '', 'b'].join(LF))
  })
})

describe('excerpt', () => {
  test('a short body is shown whole', () => {
    const body = ['- [x] Seed HQ', '- [ ] Send Kinkaew'].join(LF)
    expect(excerpt(body)).toBe(body)
  })

  test('past the line budget it trails off on the last line it keeps', () => {
    const lines = Array.from({ length: EXCERPT_LINES + 3 }, (_, n) => `- ${n}`)
    const out = excerpt(lines.join(LF))
    expect(out.split(LF)).toHaveLength(EXCERPT_LINES)
    expect(out.endsWith(`- ${EXCERPT_LINES - 1}…`)).toBe(true)
  })

  test('past the character budget it is cut and marked', () => {
    const out = excerpt('x'.repeat(EXCERPT_CHARS + 50))
    expect(out).toHaveLength(EXCERPT_CHARS + 1)
    expect(out.endsWith('…')).toBe(true)
  })

  test('surrounding blank lines are not counted or shown', () => {
    expect(excerpt(`${LF}${LF}hello${LF}`)).toBe('hello')
  })
})
