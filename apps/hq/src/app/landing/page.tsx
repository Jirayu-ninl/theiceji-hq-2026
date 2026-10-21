import {
  KIND_LABEL,
  MODULES,
  PROJECT_KINDS,
  PROJECT_MODULES,
} from '@theiceji/hq-core/modules'
import { headers } from 'next/headers'
import Link from 'next/link'
import { type CSSProperties, Fragment } from 'react'
import { Stamp, ThemeToggle } from '@/components/auth/AccessControls'
import { BrandMark } from '@/components/BrandMark'
import { LandingKeys } from './LandingKeys'
import './landing.css'

/**
 * The landing: what `/` shows someone who isn't signed in. `src/proxy.ts`
 * serves it in place, so the address stays `/`; `/landing` itself redirects
 * to `/`. Outside the shell, like the access screen: one LCD for the whole
 * viewport, reading HQ out line by line and ending at `› sign in ↵`, with a
 * link to HQ's source beside it.
 *
 * It never reads the database. The owner's own figures (what waits, what
 * runs, what came in) are not for strangers, and a fixed sample figure would
 * be a number that comes from no record, so each readout is
 * a fact about HQ itself — its kinds and modules from the hq-core registry —
 * or a state glyph with its rule in words.
 */

const KINDS = PROJECT_KINDS.map((kind) => KIND_LABEL[kind])
const MODULE_LIST = PROJECT_MODULES.map((id) => MODULES[id])

/** A list's `·` keeps to the word before it and a glyph to its label, so a
 *  narrow line never starts with a dot or ends on a lone glyph. */
const NBSP = ' '
const SEP = `${NBSP}· `

/** Each line appears in turn (landing.css); `--i` is its place. */
const at = (i: number) => ({ '--i': i }) as CSSProperties

function Caret() {
  return (
    <i className='c' aria-hidden='true'>
      ›
    </i>
  )
}

export default async function LandingPage() {
  const host = (await headers()).get('host')
  return (
    <main className='well landing' aria-labelledby='landing-title'>
      <LandingKeys href='/login' />
      <header className='landing-head'>
        <span className='brand'>
          <BrandMark size={40} />
          <span className='txt'>HQ</span>
        </span>
        <span className='hud-label'>bridge · public</span>
        <ThemeToggle />
      </header>

      <div className='lines'>
        <div className='ln' style={at(0)}>
          <Caret />
          <h1 id='landing-title'>Personal command center</h1>
        </div>
        <p className='ln' style={at(1)}>
          <Caret />
          <span className='rule'>
            one app of projects × modules · agents propose · the owner decides
          </span>
        </p>
        <p className='ln gap' style={at(2)}>
          <Caret />
        </p>

        <p className='ln has-kv' style={at(3)}>
          <Caret />
          <span className='kv'>
            <span className='k'>kinds</span>
            <span className='v'>{KINDS.length}</span>
          </span>
          <span className='d'>{KINDS.join(SEP)}</span>
        </p>
        <p className='ln has-kv' style={at(4)}>
          <Caret />
          <span className='kv'>
            <span className='k'>modules</span>
            <span className='v'>{MODULE_LIST.length}</span>
          </span>
          <span className='d'>
            {MODULE_LIST.map((module, index) => (
              <Fragment key={module.id}>
                {index ? SEP : ''}
                <span className='g' aria-hidden='true'>
                  {module.glyph}
                </span>
                {NBSP}
                {module.label}
              </Fragment>
            ))}
          </span>
        </p>
        <p className='ln has-kv' style={at(5)}>
          <Caret />
          <span className='kv'>
            <span className='k'>waiting</span>
            <span className='v wait' aria-hidden='true'>
              ◆
            </span>
          </span>
          <span className='d'>
            for the owner · each one says why it stopped
          </span>
        </p>
        <p className='ln has-kv' style={at(6)}>
          <Caret />
          <span className='kv'>
            <span className='k'>running</span>
            <span className='v live' aria-hidden='true'>
              ▶
            </span>
          </span>
          <span className='d'>
            agents on a schedule · a budget per job, day and month
          </span>
        </p>
        <p className='ln has-kv' style={at(7)}>
          <Caret />
          <span className='kv'>
            <span className='k'>money</span>
            <span className='v accent' aria-hidden='true'>
              ฿ $
            </span>
          </span>
          <span className='d'>
            counts once the bank or the platform reads it back · never converted
          </span>
        </p>
        <p className='ln gap' style={at(8)}>
          <Caret />
        </p>

        <p className='ln' style={at(9)}>
          <Caret />
          <span className='rule'>
            <b>numbers come only from records</b> — not known is written as
            words, a real zero stays a zero
          </span>
        </p>
        <p className='ln' style={at(10)}>
          <Caret />
          <span className='rule'>
            <b>nothing leaves without the owner’s red button</b> — a post, a
            listing, a quote, a payment
          </span>
        </p>
        <p className='ln' style={at(11)}>
          <Caret />
          <span className='rule'>
            <b>one owner</b> · own accounts · own database · own OAuth server
            for the agents that connect
          </span>
        </p>
        <p className='ln gap' style={at(12)}>
          <Caret />
        </p>

        <p className='ln' style={at(13)}>
          <Caret />
          <span className='act'>
            <Link className='go' href='/login'>
              sign in<kbd>↵</kbd>
            </Link>
            <span className='cursor' aria-hidden='true' />
            <a
              className='alt'
              href='https://github.com/Jirayu-ninl/theiceji-hq-2026'
            >
              source <span aria-hidden='true'>↗</span>
            </a>
          </span>
        </p>
      </div>

      <footer className='strip'>
        {host ? <span className='host'>{host}</span> : null}
        <span className='sp' />
        <Stamp />
      </footer>
    </main>
  )
}
