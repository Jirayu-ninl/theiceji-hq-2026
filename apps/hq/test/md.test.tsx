import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/lib/md'

/** The one markdown renderer: numbered lists keep their numbers. */

const html = (source: string) =>
  renderToStaticMarkup(<Markdown source={source} />)

describe('numbered lists', () => {
  test('a list split by paragraphs counts on from each typed number', () => {
    const out = html('1. Import\nfirst note\n2. Document\nsecond note\n3. Video')
    expect(out).toContain('<ol><li>')
    expect(out).toContain('<ol start="2">')
    expect(out).toContain('<ol start="3">')
  })

  test('consecutive items stay one list, numbered from the first', () => {
    const out = html('3. c\n4. d\n9. e')
    expect(out.match(/<ol/g)?.length).toBe(1)
    expect(out).toContain('<ol start="3">')
    expect(out.match(/<li>/g)?.length).toBe(3)
  })

  test('`1)` and a bullet list are unchanged', () => {
    expect(html('1) a\n2) b')).toContain('<ol><li>')
    expect(html('- a\n- [x] b')).toContain('<ul><li>')
  })
})
