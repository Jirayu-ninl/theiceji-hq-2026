import { requireApiUser } from '@theiceji/hq-auth'
import { isScope } from '@theiceji/hq-db/access'
import {
  authorizationResponse,
  parseAuthorizationRequest,
} from '@/lib/oauth/authorize'
import { AUTHORIZE_PATH, issuer } from '@/lib/oauth/config'
import { createAuthorizationCode } from '@/lib/oauth/grants'

/**
 * POST /api/oauth/authorize — the consent screen's decision.
 *
 * Cookie-bound and same-origin only: the session cookie is SameSite=Lax (a
 * cross-site POST doesn't carry it) and the Origin header must be HQ's own, so
 * no other site can submit "Allow" on the owner's behalf. Every hidden field is
 * re-validated from scratch — they're client input like anything else.
 */
export const dynamic = 'force-dynamic'

const FIELDS = [
  'client_id',
  'redirect_uri',
  'state',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'resource',
] as const

const seeOther = (location: string): Response =>
  new Response(null, {
    status: 303,
    headers: { location, 'cache-control': 'no-store' },
  })

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] as string,
  )

/**
 * A refusal outside any page (a bad or cross-site consent post), so it can't
 * use the app's stylesheet: the Bridge access screen's look, in its token
 * values for both schemes, written inline.
 */
const REFUSAL_STYLE = `:root{--frame:#131316;--panel:#1c1c20;--line:#2a2a31;--ink:#e7e7ec;--ink-2:#a3a3ad;--accent:#e4a53f;color-scheme:dark}@media (prefers-color-scheme:light){:root{--frame:#b4b8c0;--panel:#d3d6dc;--line:rgba(0,0,0,.14);--ink:#1a1d23;--ink-2:#4b515d;--accent:#9c5f0c;color-scheme:light}}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--frame);color:var(--ink);font:13px/1.5 system-ui,sans-serif}main{width:min(380px,calc(100vw - 32px));padding:18px 20px;background:var(--panel);border:1px solid var(--line);border-radius:6px}h1{margin:0 0 6px;font-size:17px;font-weight:500}p{margin:0 0 12px;color:var(--ink-2)}a{color:var(--accent)}a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`

function refusalPage(title: string, message: string, status = 400): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — HQ</title><style>${REFUSAL_STYLE}</style><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/settings/connections">Open Connections</a></p></main></body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  )
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin')
  const sameOrigin =
    origin !== null &&
    (origin === new URL(request.url).origin || origin === issuer())
  if (!sameOrigin) {
    return refusalPage(
      'Request refused',
      'A connection can only be approved from HQ’s own consent screen.',
      403,
    )
  }

  const form = await request.formData()
  const params = new URLSearchParams()
  for (const field of FIELDS) {
    const value = form.get(field)
    if (typeof value === 'string' && value) params.set(field, value)
  }
  const requested = form.get('requested_scope')
  if (typeof requested === 'string') params.set('scope', requested)

  const user = await requireApiUser()
  if (!user) {
    return seeOther(
      `/login?next=${encodeURIComponent(`${AUTHORIZE_PATH}?${params.toString()}`)}`,
    )
  }

  const parsed = await parseAuthorizationRequest(params)
  if (!parsed.ok) {
    return parsed.kind === 'redirect'
      ? seeOther(parsed.location)
      : refusalPage(parsed.title, parsed.message)
  }
  const authorization = parsed.request

  if (form.get('decision') !== 'allow') {
    return seeOther(
      authorizationResponse(authorization.redirectUri, {
        error: 'access_denied',
        error_description: 'The owner declined the connection.',
        state: authorization.state,
      }),
    )
  }

  // Only what the app asked for AND the owner left ticked.
  const granted = form
    .getAll('scope')
    .filter((value): value is string => typeof value === 'string')
    .filter(isScope)
    .filter((scope) => authorization.requestedScopes.includes(scope))
  if (granted.length === 0) {
    return seeOther(
      authorizationResponse(authorization.redirectUri, {
        error: 'access_denied',
        error_description: 'No permissions were granted.',
        state: authorization.state,
      }),
    )
  }

  try {
    const code = await createAuthorizationCode({
      client: authorization.client,
      userId: user.id,
      redirectUri: authorization.redirectUri,
      codeChallenge: authorization.codeChallenge,
      scopes: granted,
      resource: authorization.resource,
    })
    return seeOther(
      authorizationResponse(authorization.redirectUri, {
        code,
        state: authorization.state,
      }),
    )
  } catch (error) {
    console.error('[oauth] consent', (error as Error).message)
    return seeOther(
      authorizationResponse(authorization.redirectUri, {
        error: 'server_error',
        error_description: 'HQ could not record the approval. Try again.',
        state: authorization.state,
      }),
    )
  }
}
