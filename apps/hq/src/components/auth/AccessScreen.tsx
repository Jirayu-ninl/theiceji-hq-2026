import type { ReactNode } from 'react'
import '@/app/login/login.css'
import { BrandMark } from '../BrandMark'
import { Stamp, ThemeToggle } from './AccessControls'

/**
 * The access screen: outside the shell — the theme toggle, then one card of brand
 * · well · panel, and the LCD strip along the bottom. Sign-in and OAuth
 * consent share it; each supplies its own well and panel.
 */
export function AccessScreen({
  status,
  problem = false,
  host,
  children,
}: {
  /** The strip's state word — the well's first line, in short. */
  status: string
  /** Something went wrong: the strip leads with ◆ in `--lcd-wait`. */
  problem?: boolean
  /** The host this HQ answers on, from the request. */
  host: string | null
  children: ReactNode
}) {
  return (
    <div className='access'>
      <ThemeToggle />
      <main className='access-frame'>
        <div className='access-card'>
          <div className='brand'>
            <BrandMark size={28} />
            <span className='txt'>HQ</span>
          </div>
          {children}
          <p className='access-note small'>
            HQ is an app of its own — its own accounts, database and OAuth
            server.
          </p>
        </div>
      </main>
      <footer className='access-foot'>
        <span className='caret' aria-hidden='true'>
          ›
        </span>
        <span className={problem ? 'state wait' : 'state'}>
          {problem ? '◆ ' : ''}
          {status}
        </span>
        <span className='sp' />
        {host ? <span className='host'>{host}</span> : null}
      </footer>
    </div>
  )
}

/**
 * The well: a black screen stating what is happening. The title is the
 * page's heading; `detail` is the small line under it, in `--lcd-wait` when
 * `problem`.
 */
export function AccessWell({
  label,
  title,
  detail,
  problem = false,
}: {
  label: string
  title: string
  detail: ReactNode
  problem?: boolean
}) {
  return (
    <div className='well access-screen'>
      <span className='l1'>{label}</span>
      <h1 className='l2'>{title}</h1>
      <span className={problem ? 'l3 err' : 'l3'}>
        <span>{detail}</span>
        <Stamp />
      </span>
    </div>
  )
}
