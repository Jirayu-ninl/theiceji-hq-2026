import type { ReactNode } from 'react'

/**
 * The parts every Settings tab is made of: one readout bar stating the tab's real values, then
 * group cards — title, description, `fld` rows, a footer bar. Plain SaaS;
 * the bar is the tab's only LCD. No hooks here, so a server page and a
 * client form render the same markup.
 */

/** What a Settings form action answers: plain data that crosses to the client. */
export type FormResult =
  | { ok: true; message?: string; redirect?: string }
  | { ok: false; error: string; fields?: Record<string, string> }

type Tone = 'wait' | 'live' | 'accent' | ''

/** The readout bar: `key value` pairs, figures from records only. */
export function Bar({
  items,
}: {
  items: [key: string, value: ReactNode, tone?: Tone][]
}) {
  return (
    <div className='readout' role='status'>
      {items.map(([key, value, tone]) => (
        <span key={key}>
          <span className='k'>{key}</span>
          <span className={`v${tone ? ` ${tone}` : ''}`}>{value}</span>
        </span>
      ))}
    </div>
  )
}

/** A group card. `id` is its anchor (`/settings/account#password`). */
export function Group({
  id,
  title,
  description,
  problem = false,
  foot,
  children,
}: {
  id: string
  title: ReactNode
  description?: ReactNode
  problem?: boolean
  foot?: ReactNode
  children?: ReactNode
}) {
  return (
    <section
      className={`group${problem ? ' problem' : ''}`}
      id={id}
      aria-labelledby={`${id}-h`}
    >
      <header className='group-head'>
        <h2 id={`${id}-h`}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </header>
      {children ? <div className='group-body'>{children}</div> : null}
      {foot ? <footer className='group-foot'>{foot}</footer> : null}
    </section>
  )
}

/** One row of a group: the label (and a small line under it), then the control. */
export function Fld({
  label,
  sub,
  htmlFor,
  locked = false,
  children,
}: {
  label: ReactNode
  sub?: ReactNode
  /** The input the label names, so clicking it focuses the field. */
  htmlFor?: string
  locked?: boolean
  children?: ReactNode
}) {
  return (
    <div className={`fld${locked ? ' locked' : ''}`}>
      <div className='k'>
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}
        {sub ? <small>{sub}</small> : null}
      </div>
      <div className='c'>{children}</div>
    </div>
  )
}

/** A state as a word, coloured only by what it means. */
export function StateWord({
  tone = '',
  children,
}: {
  tone?: Tone | 'due'
  children: ReactNode
}) {
  return (
    <span className={`state-word${tone ? ` ${tone}` : ''}`}>{children}</span>
  )
}

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Bangkok',
})

/**
 * A moment in Bangkok time, as HQ's other screens read it. Format on the
 * server and pass the string down: two runtimes can spell a month
 * differently, and a client format would then disagree with the server's.
 */
export const when = (date: Date | string | null | undefined): string =>
  date
    ? DATE_TIME.format(typeof date === 'string' ? new Date(date) : date)
    : '—'

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/**
 * `1.2 MB`, `640 KB` — decimal units, the way storage bills them. The same
 * rule as the shared `bytesLabel`, which a server page can't call.
 */
export function bytesText(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`
}

/**
 * `lang="th"` for Thai text. The shared `isThai` lives in a
 * client module, which a server page can render from but not call.
 */
export const thai = (text: string | null | undefined) =>
  text && /\p{Script=Thai}/u.test(text) ? 'th' : undefined
