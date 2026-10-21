import { requireUser } from '@theiceji/hq-auth'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createNote, isConfigured } from '@/lib/notes/store'
import { isBlank, TITLE_MAX } from '@/lib/notes/types'

export const dynamic = 'force-dynamic'

/**
 * The PWA share target. Android's share sheet opens this URL when HQ is
 * picked, so a link or a scrap of text becomes a note without the board ever
 * being visited — the phone's answer to the `n` shortcut.
 *
 * It is a GET that writes, which the Web Share Target spec asks for. Nothing
 * links here, so nothing prefetches it, and the layout's `requireUser()` has
 * already run: a signed-out share bounces to /login and comes back with its
 * query intact.
 */

type Param = string | string[] | undefined

const first = (value: Param): string =>
  (Array.isArray(value) ? value[0] : value)?.trim() ?? ''

/**
 * One body out of the pieces the sheet sends. Android usually puts the link
 * inside `text` as well as in `url`, so it is only appended when it is not
 * already there.
 */
function compose(text: string, url: string): string {
  const parts: string[] = []
  if (text) parts.push(text)
  if (url && !text.includes(url)) parts.push(url)
  return parts.join('\n\n')
}

export default async function ShareToNotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, Param>>
}) {
  const user = await requireUser()
  const params = await searchParams
  const title = first(params.title).slice(0, TITLE_MAX) || null
  const shared = first(params.text)
  const url = first(params.url)
  // The sheet often sends the page title twice; one copy is enough.
  const body = compose(shared === title ? '' : shared, url)

  let id: string | null = null
  let failed = false
  if (isConfigured() && !isBlank({ title, body })) {
    try {
      id = (await createNote(user.id, { title, body })).id
    } catch {
      failed = true
    }
  }

  // Nothing worth keeping arrived — open the board rather than an empty row.
  if (!failed) redirect(id ? `/notes?open=${id}` : '/notes')

  // The write failed, so the shared text only exists on this page. Show it
  // rather than dropping it on the way to a board that would not have it —
  // in a read-only field, so it copies in one go.
  const text = [title, body].filter(Boolean).join('\n\n')
  const again = new URLSearchParams()
  if (title) again.set('title', title)
  if (shared) again.set('text', shared)
  if (url) again.set('url', url)
  return (
    <div className='page'>
      <section className='pane' aria-labelledby='share-h'>
        <header className='pane-head'>
          <span className='hud-label'>Share to Notes</span>
        </header>
        <div className='pane-body'>
          <div className='off-state' role='alert'>
            <h2 id='share-h'>The note could not be saved</h2>
            <p>
              Here is what was shared, so it isn’t lost. Copy it, or try again.
            </p>
            <textarea
              readOnly
              rows={Math.min(14, Math.max(4, text.split('\n').length + 1))}
              aria-label='What was shared'
              lang={/\p{Script=Thai}/u.test(text) ? 'th' : undefined}
              value={text}
            />
            <div className='picks'>
              <a className='btn' href={`/notes/share?${again}`}>
                Try again
              </a>
              <Link className='btn' href='/notes'>
                Open Notes
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
