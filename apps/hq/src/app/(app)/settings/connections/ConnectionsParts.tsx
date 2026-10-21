'use client'

import { MODULES } from '@theiceji/hq-core/modules'
import { SCOPES, type Scope } from '@theiceji/hq-db/scopes'
import { type FormEvent, useState, useTransition } from 'react'
import { useToast } from '@/components/Toast'
import { Confirm, CopyButton } from '../forms'
import { Fld, Group, StateWord } from '../parts'
import { createToken, revokeConnection } from './actions'

/**
 * Settings › Connections, the client half: the MCP endpoint and how each
 * client connects, the apps and personal access tokens that hold a grant
 * (each revocable), and the form that creates a token. The actions are the
 * ones the old tab posted to (`./actions`); a token is shown once, because
 * HQ keeps only its hash.
 */

/** A grant as the page shows it — dates already formatted on the server. */
export type GrantRow = {
  id: string
  kind: 'oauth' | 'personal'
  label: string
  host: string | null
  scopes: string[]
  actorType: 'agent' | 'worker'
  added: string
  lastUsed: string | null
  expires: string | null
  tokenHint: string | null
  expired: boolean
}

function setupGuides(url: string) {
  return [
    {
      id: 'claude',
      name: 'Claude',
      steps: [
        'Settings → Connectors → Add custom connector.',
        'Paste the endpoint URL and connect.',
        'Sign in to HQ and choose what Claude may do.',
      ],
      snippet: null,
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      steps: [
        'Settings → Apps → Advanced settings → turn on Developer mode.',
        'Create an app with the endpoint URL and OAuth authentication.',
        'Sign in to HQ and choose its permissions.',
      ],
      snippet: null,
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      steps: ['Add the server, then run /mcp inside Claude Code to sign in.'],
      snippet: `claude mcp add --transport http theiceji-hq ${url}`,
    },
    {
      id: 'hermes',
      name: 'Hermes Agent',
      steps: [
        'Add it to ~/.hermes/config.yaml — OAuth opens HQ in your browser.',
        'On a headless host, use a personal access token in `headers` instead.',
      ],
      snippet: `mcp_servers:\n  theiceji-hq:\n    url: ${url}\n    auth: oauth`,
    },
  ]
}

/** The MCP endpoint every client points at, and each client's steps. */
export function ConnectApp({ endpoint }: { endpoint: string | null }) {
  const url = endpoint ?? 'https://mcp.example.com/mcp'
  return (
    <Group
      id='connect'
      title='Connect an app'
      description='Claude, ChatGPT, Hermes and other agents reach HQ at this MCP endpoint, with only the permissions you grant.'
      foot={
        <span className='st'>
          any other OAuth-speaking MCP client finds HQ from the URL alone ·
          header-only clients use a personal access token
        </span>
      }
    >
      <Fld
        label='Endpoint'
        sub={
          endpoint
            ? 'The one URL for every client.'
            : 'Set MCP_RESOURCE_URLS on HQ.'
        }
      >
        {endpoint ? (
          <>
            <code className='snippet'>{endpoint}</code>
            <CopyButton value={endpoint} label='Copy URL' />
          </>
        ) : (
          <StateWord tone='wait'>◆ not set</StateWord>
        )}
      </Fld>
      {setupGuides(url).map((guide) => (
        <Fld key={guide.id} label={guide.name}>
          <ol className='steps'>
            {guide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {guide.snippet ? (
            <>
              <pre className='snippet'>{guide.snippet}</pre>
              <CopyButton value={guide.snippet} />
            </>
          ) : null}
        </Fld>
      ))}
    </Group>
  )
}

function useRevoke() {
  const toast = useToast()
  return async (grant: GrantRow) => {
    const result = await revokeConnection(grant.id)
    toast(
      result.ok
        ? `Revoked ${grant.label} — it stops on its next call.`
        : result.error,
    )
  }
}

const usedLine = (grant: GrantRow) =>
  [
    grant.actorType === 'worker' ? 'acts as a worker' : 'acts as an agent',
    `added ${grant.added}`,
    grant.lastUsed ? `last used ${grant.lastUsed}` : 'never used',
  ].join(' · ')

/** Apps connected through OAuth consent. */
export function Apps({ grants }: { grants: GrantRow[] }) {
  const revoke = useRevoke()
  return (
    <Group
      id='apps'
      title='Connected over MCP'
      description={
        <>
          Apps you approved, with what they may do and when they last did it.
          Scopes are{' '}
          <span className='mono'>&lt;module&gt;:read · write · operate</span>{' '}
          plus <span className='mono'>ops:decide</span>. Revoking one stops it
          on its next call.
        </>
      }
    >
      {grants.length === 0 ? (
        <div className='empty'>○ no app connected yet</div>
      ) : (
        <div className='tbl mcp-tbl'>
          <div className='tbl-head' aria-hidden='true'>
            <span className='hud-label'>App</span>
            <span className='hud-label c-hide'>Scopes</span>
            <span className='hud-label c-hide'>Last used</span>
            <span className='sr-only'>Revoke</span>
          </div>
          {grants.map((grant) => (
            <div
              key={grant.id}
              className={`tbl-row${grant.expired ? ' dim' : ''}`}
            >
              <span
                title={`${grant.label} · ${grant.host ?? 'unknown host'} · ${usedLine(grant)}`}
              >
                {grant.label}{' '}
                {grant.expired ? (
                  <StateWord tone='wait'>◆ expired</StateWord>
                ) : null}
                <br />
                <span className='mono'>{grant.host ?? 'unknown host'}</span>
              </span>
              <span className='mono c-hide' title={grant.scopes.join(' · ')}>
                {grant.scopes.join(' · ') || '—'}
              </span>
              <span className='mono c-hide'>{grant.lastUsed ?? 'never'}</span>
              <span className='acts'>
                <Confirm
                  label='Revoke'
                  question={`Revoke ${grant.label}?`}
                  yes='Revoke'
                  run={() => revoke(grant)}
                />
              </span>
            </div>
          ))}
        </div>
      )}
    </Group>
  )
}

/** How a scope group reads: a module's own name, else HQ's words for it. */
const GROUP_LABEL: Record<string, string> = {
  hq: 'HQ',
  ops: 'Decisions',
}
const groupLabel = (id: string) =>
  GROUP_LABEL[id] ??
  (id in MODULES ? MODULES[id as keyof typeof MODULES].label : id)

const SCOPE_GROUPS = [...new Set(SCOPES.map((entry) => entry.workspace))].map(
  (id) => ({
    id,
    label: groupLabel(id),
    scopes: SCOPES.filter((entry) => entry.workspace === id),
  }),
)

const READ_SCOPES: Scope[] = SCOPES.filter(
  (entry) => entry.level === 'read',
).map((entry) => entry.scope)

const EXPIRY: [string, string][] = [
  ['30', '30 days'],
  ['90', '90 days'],
  ['365', '1 year'],
  ['never', 'Never'],
]

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Bangkok',
})

/** The form that mints a personal access token, and the one look at it after. */
function TokenForm({
  disabled,
  onClose,
}: {
  disabled: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState<Scope[]>(['hq:read'])
  const [expiry, setExpiry] = useState('90')
  const [actorType, setActorType] = useState<'agent' | 'worker'>('agent')
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{
    token: string
    label: string
  } | null>(null)

  const toggle = (scope: Scope) =>
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((entry) => entry !== scope)
        : [...current, scope],
    )
  const setGroup = (group: readonly Scope[], on: boolean) =>
    setScopes((current) => [
      ...current.filter((entry) => !group.includes(entry)),
      ...(on ? group : []),
    ])
  const granted = SCOPES.filter((entry) => scopes.includes(entry.scope))
  const operates = granted.some((entry) => entry.level === 'publish')

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    start(async () => {
      const result = await createToken({
        label,
        scopes,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
        actorType,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setCreated({ token: result.token, label: result.label })
      setLabel('')
      toast(`Token created: ${result.label} — copy it now`)
    })
  }

  if (created)
    return (
      <div className='fcard' role='status'>
        <p className='why ok' style={{ margin: 0 }}>
          <b>{created.label}</b> — copy it now. HQ keeps only a hash, so it
          can’t be shown again.
        </p>
        <div className='row'>
          <code className='snippet'>{created.token}</code>
          <CopyButton value={created.token} />
        </div>
        <div className='row'>
          <pre className='snippet'>{`Authorization: Bearer ${created.token}`}</pre>
          <CopyButton value={`Authorization: Bearer ${created.token}`} />
        </div>
        <div className='row'>
          <button type='button' className='btn' onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    )

  return (
    <form
      className='fcard'
      onSubmit={submit}
      aria-label='Create a personal access token'
    >
      <label>
        Name
        <input
          type='text'
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder='Hermes on my server'
          maxLength={80}
          // biome-ignore lint/a11y/noAutofocus: the form opens on purpose, from Create token
          autoFocus
        />
      </label>
      <div className='row'>
        <span className='fld-label'>Acts as</span>
        {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons, not a fieldset */}
        <span className='seg' role='group' aria-label='Acts as'>
          {(
            [
              ['agent', 'Agent'],
              ['worker', 'Worker'],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type='button'
              aria-pressed={actorType === value}
              onClick={() => setActorType(value)}
            >
              {text}
            </button>
          ))}
        </span>
        <span className='fld-label'>Expires</span>
        {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons, not a fieldset */}
        <span className='seg' role='group' aria-label='Expires'>
          {EXPIRY.map(([value, text]) => (
            <button
              key={value}
              type='button'
              aria-pressed={expiry === value}
              onClick={() => setExpiry(value)}
            >
              {text}
            </button>
          ))}
        </span>
      </div>
      <p className='hint'>
        {actorType === 'worker'
          ? 'A worker claims and runs production jobs.'
          : 'An agent plans, researches and operates within your operating policy.'}{' '}
        {expiry === 'never'
          ? 'Never expires — revoke it when you’re done.'
          : // The form only opens in the browser, so the clock here is the owner's, never the server's.
            `Expires ${dayFormat.format(new Date(Date.now() + Number(expiry) * 86_400_000))}.`}
      </p>
      <div className='row'>
        <span className='fld-label'>
          Permissions · {granted.length} of {SCOPES.length}
        </span>
        <button
          type='button'
          className='btn btn-sm'
          onClick={() => setScopes(READ_SCOPES)}
        >
          Read only
        </button>
        <button
          type='button'
          className='btn btn-sm'
          disabled={scopes.length === 0}
          onClick={() => setScopes([])}
        >
          Clear
        </button>
      </div>
      <div className='scope-groups'>
        {SCOPE_GROUPS.map((group) => {
          const ids = group.scopes.map((entry) => entry.scope)
          const held = ids.filter((scope) => scopes.includes(scope))
          const all = held.length === ids.length
          return (
            <fieldset key={group.id}>
              <legend className='sr-only'>{group.label} permissions</legend>
              <div className='scope-head'>
                <span className='hud-label' aria-hidden='true'>
                  {group.label}
                </span>
                <span className='n' aria-hidden='true'>
                  {held.length}/{ids.length}
                </span>
                <button
                  type='button'
                  className='btn btn-sm'
                  onClick={() => setGroup(ids, !all)}
                  aria-label={`${all ? 'Clear' : 'Select all'} ${group.label} permissions`}
                >
                  {all ? 'Clear' : 'All'}
                </button>
              </div>
              {group.scopes.map((entry) => (
                <label
                  key={entry.scope}
                  className='scope-row'
                  title={entry.description}
                >
                  <input
                    type='checkbox'
                    checked={scopes.includes(entry.scope)}
                    onChange={() => toggle(entry.scope)}
                  />
                  <span>
                    {entry.label}
                    <small className='mono'>{entry.scope}</small>
                  </span>
                  <span className='lvl'>{entry.level}</span>
                </label>
              ))}
            </fieldset>
          )
        })}
      </div>
      {operates ? (
        <p className='hint'>
          Includes permissions that may spend or let something leave HQ — only
          inside your operating policy.
        </p>
      ) : null}
      {error ? (
        <p className='err' role='alert'>
          {error}
        </p>
      ) : null}
      <div className='row'>
        <button
          type='submit'
          className='btn btn-pri'
          disabled={disabled || pending || !label.trim() || scopes.length === 0}
        >
          {pending ? 'Creating…' : 'Create token'}
        </button>
        <button type='button' className='btn' onClick={onClose}>
          Cancel
        </button>
        <span className='hint'>Shown once — HQ keeps only a hash.</span>
      </div>
    </form>
  )
}

/** Personal access tokens: for agents and scripts that can only send a header. */
export function Tokens({
  grants,
  disabled,
}: {
  grants: GrantRow[]
  disabled: string | null
}) {
  const revoke = useRevoke()
  const [open, setOpen] = useState(false)
  return (
    <Group
      id='tokens'
      title='Personal access tokens'
      description={
        <>
          For the worker and scripts that can only send{' '}
          <span className='mono'>Authorization: Bearer hq_pat_…</span>. A token
          is shown once, when it is created.
        </>
      }
      foot={
        <>
          {open ? null : (
            <button
              type='button'
              className='btn'
              disabled={Boolean(disabled)}
              data-key='c'
              onClick={() => setOpen(true)}
            >
              Create token <kbd>c</kbd>
            </button>
          )}
          <span className={`st${disabled ? ' wait' : ''}`}>
            {disabled ?? 'HQ keeps only a hash'}
          </span>
        </>
      }
    >
      {grants.length === 0 ? (
        <div className='empty'>○ no tokens</div>
      ) : (
        <div className='dev-rows'>
          {grants.map((grant) => (
            <div key={grant.id} className='dev-row'>
              <span className='t' title={grant.scopes.join(' · ')}>
                {grant.label}{' '}
                <span className='mono muted'>••••{grant.tokenHint ?? ''}</span>{' '}
                {grant.expired ? (
                  <StateWord tone='wait'>◆ expired</StateWord>
                ) : null}
              </span>
              <span className='v'>
                {usedLine(grant)} ·{' '}
                {grant.expires ? `until ${grant.expires}` : 'no expiry'}
              </span>
              <Confirm
                label='Revoke'
                question={`Revoke ${grant.label}?`}
                yes='Revoke'
                run={() => revoke(grant)}
              />
            </div>
          ))}
        </div>
      )}
      {open ? (
        <TokenForm
          disabled={Boolean(disabled)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Group>
  )
}
