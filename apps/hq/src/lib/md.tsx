import { Fragment, type ReactNode } from 'react'

/**
 * The one small markdown renderer: card bodies, notes,
 * scripts and prompt intents all go through it. It builds React elements —
 * never HTML strings — so nothing a note or an agent wrote can inject markup.
 *
 * Covers what people actually type: `#`–`###` headings, paragraphs, `-`/`*`
 * and `1.` lists (a numbered list counts on from the number its first item
 * was typed with, so `2.` after a paragraph stays 2), `- [ ]` / `- [x]`
 * tasks, `>` quotes, ``` fences, and inline
 * `code`, **bold**, *italic* and [links](https://…). Links go only to http(s),
 * mailto or an HQ path; anything else stays text.
 */

const SAFE_LINK = /^(https?:\/\/|mailto:|\/(?!\/))/i

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let n = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const token = match[0]
    const k = `${key}-${n++}`
    if (token.startsWith('`'))
      out.push(<code key={k}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**'))
      out.push(<b key={k}>{token.slice(2, -2)}</b>)
    else if (token.startsWith('*'))
      out.push(<i key={k}>{token.slice(1, -1)}</i>)
    else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      const label = link?.[1] ?? token
      const href = link?.[2] ?? ''
      out.push(
        SAFE_LINK.test(href) ? (
          <a
            key={k}
            href={href}
            target={href.startsWith('/') ? undefined : '_blank'}
            rel='noreferrer'
          >
            {label}
          </a>
        ) : (
          <Fragment key={k}>{token}</Fragment>
        ),
      )
    }
    last = at + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const isThai = (text: string) => /\p{Script=Thai}/u.test(text)

type Item = { text: string; task: boolean | null }

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: 1 | 2 | 3; text: string }
  | { kind: 'ul'; items: Item[] }
  | { kind: 'ol'; start: number; items: Item[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'pre'; text: string }

function blocks(source: string): Block[] {
  const out: Block[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  const last = () => out[out.length - 1]
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (/^```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i] ?? ''))
        body.push(lines[i++] ?? '')
      i++
      out.push({ kind: 'pre', text: body.join('\n') })
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      out.push({
        kind: 'h',
        level: heading[1]?.length as 1 | 2 | 3,
        text: heading[2] ?? '',
      })
      i++
      continue
    }
    const bullet = /^\s*[-*]\s+(\[( |x|X)\]\s+)?(.*)$/.exec(line)
    const numbered = /^\s*(\d{1,9})[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const prev = last()
      if (bullet) {
        const item = {
          text: bullet[3] ?? '',
          task: bullet[1] ? bullet[2]?.toLowerCase() === 'x' : null,
        }
        if (prev?.kind === 'ul') prev.items.push(item)
        else out.push({ kind: 'ul', items: [item] })
      } else {
        const item = { text: numbered?.[2] ?? '', task: null }
        if (prev?.kind === 'ol') prev.items.push(item)
        else
          out.push({
            kind: 'ol',
            start: Number(numbered?.[1] ?? 1),
            items: [item],
          })
      }
      i++
      continue
    }
    if (/^>\s?/.test(line)) {
      const prev = last()
      const text = line.replace(/^>\s?/, '')
      if (prev?.kind === 'quote') prev.lines.push(text)
      else out.push({ kind: 'quote', lines: [text] })
      i++
      continue
    }
    if (!line.trim()) {
      i++
      out.push({ kind: 'p', lines: [] })
      continue
    }
    const prev = last()
    if (prev?.kind === 'p' && prev.lines.length > 0)
      prev.lines.push(line.trim())
    else out.push({ kind: 'p', lines: [line.trim()] })
    i++
  }
  return out.filter((block) => block.kind !== 'p' || block.lines.length > 0)
}

/** Markdown as React elements inside `.md`. Empty source renders nothing. */
export function Markdown({
  source,
  className,
}: {
  source: string | null | undefined
  className?: string
}) {
  const text = source?.trim() ?? ''
  if (!text) return null
  return (
    <div className={`md${className ? ` ${className}` : ''}`}>
      {blocks(text).map((block, index) => {
        const key = `b${index}`
        switch (block.kind) {
          case 'h': {
            const Tag = `h${block.level}` as const
            return (
              <Tag key={key} lang={isThai(block.text) ? 'th' : undefined}>
                {inline(block.text, key)}
              </Tag>
            )
          }
          case 'ul':
          case 'ol': {
            const items = block.items.map((item, n) => (
              <li
                key={`${key}-${n}`}
                className={item.task === null ? undefined : 'task'}
              >
                {item.task === null ? null : (
                  <span role='img' aria-label={item.task ? 'done' : 'not done'}>
                    {item.task ? '☑' : '☐'}
                  </span>
                )}
                <span lang={isThai(item.text) ? 'th' : undefined}>
                  {inline(item.text, `${key}-${n}`)}
                </span>
              </li>
            ))
            return block.kind === 'ol' ? (
              <ol key={key} start={block.start === 1 ? undefined : block.start}>
                {items}
              </ol>
            ) : (
              <ul key={key}>{items}</ul>
            )
          }
          case 'quote':
            return (
              <blockquote key={key}>
                {inline(block.lines.join(' '), key)}
              </blockquote>
            )
          case 'pre':
            return <pre key={key}>{block.text}</pre>
          default: {
            const joined = block.lines.join(' ')
            return (
              <p key={key} lang={isThai(joined) ? 'th' : undefined}>
                {inline(joined, key)}
              </p>
            )
          }
        }
      })}
    </div>
  )
}
