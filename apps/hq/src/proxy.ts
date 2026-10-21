import { SESSION_COOKIE } from '@theiceji/hq-auth/constants'
import { type NextRequest, NextResponse } from 'next/server'
import { HOME_COOKIE } from '@/lib/prefs'

// Next.js 16 proxy convention (formerly `middleware.ts`).
//
// This is a fast bounce, **not** the gate. It only asks whether a session
// cookie is present: the edge runtime has no database connection, and
// middleware is the wrong place to hang authorisation anyway — CVE-2025-29927
// let a crafted header skip Next middleware outright. Every protected surface
// re-checks the session against Postgres via `requireUser()`.

/** Fetched without our cookie by the browser's PWA machinery. */
const PUBLIC_FILES = new Set(['/sw.js', '/manifest.webmanifest'])

/**
 * `/api/inbox` (website ingest) and `/api/cron` (Vercel Cron) guard themselves
 * with a shared secret; `/api/ready` answers anonymous monitors with `{ ok }`
 * only; `/api/assets/content` serves
 * a Drive file only for a sealed, short-lived token HQ issued. The OAuth metadata,
 * registration, token and revocation endpoints are called by other people's
 * software with no HQ cookie and carry their own checks. `/oauth/authorize` is
 * deliberately NOT here: it needs the owner signed in, so it bounces to
 * /login and comes back.
 */
const PUBLIC_PREFIXES = [
  '/login',
  '/api/inbox',
  '/api/cron',
  '/api/ready',
  '/api/assets/content',
  '/.well-known',
  '/oauth/register',
  '/oauth/token',
  '/oauth/revoke',
]

/**
 * A bare `/` opened fresh goes to the Home projection this browser opens on
 * (`HOME_COOKIE`, lib/prefs.ts) before anything renders — otherwise HQ would
 * render Space only for `HomeView` to replace it with State or Time. Only a
 * document load: a client navigation to `/` is Home › Space, as pressing `1`
 * or following Home in the rail always is. Next strips its
 * own `RSC` header before the proxy runs, so the browser's `Sec-Fetch-Dest`
 * tells the two apart; without it nothing is redirected and `HomeView`
 * still moves there after load.
 */
function openingHome(request: NextRequest): URL | null {
  if (request.nextUrl.pathname !== '/' || request.nextUrl.search !== '')
    return null
  if (request.method !== 'GET') return null
  if (request.headers.get('sec-fetch-dest') !== 'document') return null
  const view = request.cookies.get(HOME_COOKIE)?.value
  if (view !== 'state' && view !== 'time') return null
  const url = request.nextUrl.clone()
  url.search = `?view=${view}`
  return url
}

/** Where the landing's page lives; never an address of its own. */
const LANDING = '/landing'

/**
 * The landing: a bare `/` asked for with no session cookie is
 * served `app/landing` in place, so the address stays `/` and signing in from
 * it lands on Home at the same address. Only a GET or HEAD of `/` itself — a
 * view (`/?view=state`) or any other page still goes to sign in and comes back
 * to it.
 */
function landing(request: NextRequest): URL | null {
  if (request.nextUrl.pathname !== '/' || request.nextUrl.search !== '')
    return null
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const url = request.nextUrl.clone()
  url.pathname = LANDING
  return url
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // One page, one address: whoever types `/landing` gets `/` — the landing
  // when signed out, Home when signed in. (A rewrite doesn't run the proxy
  // again, so serving the landing never meets this.)
  if (pathname === LANDING) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    url.search = ''
    return NextResponse.redirect(url)
  }

  if (PUBLIC_FILES.has(pathname)) return NextResponse.next()
  if (
    PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return NextResponse.next()
  }

  if (request.cookies.get(SESSION_COOKIE)?.value) {
    const home = openingHome(request)
    return home ? NextResponse.redirect(home) : NextResponse.next()
  }

  const front = landing(request)
  if (front) return NextResponse.rewrite(front)

  // A fetch() deserves a status it can read, not a login page.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 },
    )
  }

  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  const next = `${pathname}${request.nextUrl.search}`
  if (next !== '/') url.searchParams.set('next', next)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
