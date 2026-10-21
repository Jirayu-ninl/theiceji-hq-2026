import { SCOPES } from '@theiceji/hq-db/scopes'
import Link from 'next/link'
import { AccessScreen, AccessWell } from '@/components/auth/AccessScreen'
import type { AuthorizationRequest } from '@/lib/oauth/authorize'
import { clientHost } from '@/lib/oauth/clients'
import { CONSENT_PATH } from '@/lib/oauth/config'
import { redirectLabel } from '@/lib/oauth/redirect'

type Person = { email: string; name: string | null }

/**
 * The consent screen, on the access screen: the well names the app, and the panel shows who it will act as,
 * where it sends you back, which HQ server, and exactly which permissions —
 * each one a checkbox, so an app can be granted less than it asked for.
 *
 * The form is a plain post, no client JavaScript: it works in the smallest
 * OAuth popup and can't be driven by script from another page. For the same
 * reason there is no page-wide `↵` → Allow; Enter only presses the button
 * that has focus.
 */
export function ConsentScreen({
  user,
  host,
  request,
  error,
}: {
  user: Person
  host: string | null
  request?: AuthorizationRequest
  error?: { title: string; message: string }
}) {
  if (request) {
    const { client } = request
    return (
      <AccessScreen status='oauth · consent' host={host}>
        <AccessWell
          label='oauth · consent'
          title={client.name}
          detail={`${clientHost(client)}${client.kind === 'cimd' ? ' · verified metadata' : ''}`}
        />
        <ConsentForm user={user} request={request} />
      </AccessScreen>
    )
  }
  return (
    <AccessScreen status='oauth · can’t connect' problem host={host}>
      <AccessWell
        label='oauth · can’t connect'
        title={error?.title ?? 'Something went wrong'}
        detail='nothing was connected'
        problem
      />
      <section className='panel access-form' aria-label='What to do'>
        <p className='access-p'>
          {error?.message ?? 'Start the connection again from the app.'}
        </p>
        <div className='acts'>
          <Link href='/settings/connections' className='btn'>
            Open Connections
          </Link>
        </div>
      </section>
    </AccessScreen>
  )
}

function ConsentForm({
  user,
  request,
}: {
  user: Person
  request: AuthorizationRequest
}) {
  const { client } = request
  const requested = SCOPES.filter((definition) =>
    request.requestedScopes.includes(definition.scope),
  )
  const operates = requested.some(
    (definition) => definition.level === 'publish',
  )
  const returnsTo = redirectLabel(request.redirectUri)
  return (
    <form
      method='post'
      action={CONSENT_PATH}
      className='panel access-form consent'
      aria-labelledby='consent-h'
    >
      <input type='hidden' name='client_id' value={client.id} />
      <input type='hidden' name='redirect_uri' value={request.redirectUri} />
      {request.state !== null && (
        <input type='hidden' name='state' value={request.state} />
      )}
      <input type='hidden' name='response_type' value='code' />
      <input
        type='hidden'
        name='code_challenge'
        value={request.codeChallenge}
      />
      <input type='hidden' name='code_challenge_method' value='S256' />
      <input type='hidden' name='resource' value={request.resource} />
      <input
        type='hidden'
        name='requested_scope'
        value={request.requestedScopes.join(' ')}
      />

      <h2 id='consent-h'>{client.name} asks to connect</h2>
      <p className='access-p'>
        It will act as <b>{user.email}</b> inside the permissions you leave
        ticked, until you revoke it under Settings › Connections.
      </p>
      <dl className='facts'>
        <dt>App</dt>
        <dd>
          {clientHost(client)}
          {client.kind === 'cimd' ? ' · verified metadata' : ''}
        </dd>
        <dt>Returns to</dt>
        <dd>{returnsTo}</dd>
        <dt>Server</dt>
        <dd>{request.resource}</dd>
      </dl>

      <fieldset>
        <legend className='hud-label'>Allow it to</legend>
        <ul className='scopes'>
          {requested.map((definition) => (
            <li key={definition.scope}>
              <label className='scope' data-level={definition.level}>
                <input
                  type='checkbox'
                  name='scope'
                  value={definition.scope}
                  defaultChecked
                />
                <span className='mono'>{definition.scope}</span>
                <span className='t'>{definition.label}</span>
                <small>{definition.description}</small>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {operates ? (
        <p className='hint'>
          Includes permissions that may spend or let something leave HQ — only
          inside your operating policy.
        </p>
      ) : null}

      {/* Allow first in the DOM: it is the default the eye lands on. */}
      <div className='acts'>
        <button
          type='submit'
          name='decision'
          value='allow'
          className='btn btn-pri'
        >
          Allow
        </button>
        <button type='submit' name='decision' value='deny' className='btn'>
          Deny
        </button>
      </div>
      <p className='access-note'>
        Allow returns you to {returnsTo} with a one-time code; Deny sends back a
        refusal.
      </p>
    </form>
  )
}
