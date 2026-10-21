'use client'

import { type FormEvent, type ReactNode, useState, useTransition } from 'react'
import { useToast } from '@/components/Toast'
import { Confirm } from '../forms'
import { Group, StateWord } from '../parts'
import { revokeProvider, saveProvider } from './actions'

/**
 * Settings › Connections › Providers, the client half: the
 * connections HQ holds a sealed secret for — shops and platforms, generators
 * and LLM keys for HQ's own agent runner — each replaceable and
 * revocable, and the form that adds one. The secret goes one way — HQ seals
 * it on arrival and shows only its last four characters after. A generator's
 * or a key's base URL, models and prices are plain config, shown as they are.
 */

export type ProviderRow = {
  id: string
  provider: string
  label: string
  hint: string | null
  status: string
  problem: string | null
  revision: number
  checked: string | null
  config: Record<string, unknown>
}

export type ProviderGroupId = 'platform' | 'generator' | 'llm'

type Kind = {
  id: string
  name: string
  group: ProviderGroupId
  secret: string
  placeholder: string
}

/** What a person can connect here: shops and platforms, generators, LLM keys. */
const KINDS: Kind[] = [
  {
    id: 'etsy',
    group: 'platform',
    name: 'Etsy',
    secret:
      'JSON from your Etsy app: apiKey and accessToken, plus clientId, refreshToken and expiresAt so HQ can refresh the token itself.',
    placeholder:
      '{"apiKey":"…","clientId":"…","accessToken":"…","refreshToken":"…","expiresAt":"2026-10-01T00:00:00Z"}',
  },
  {
    id: 'facebook',
    group: 'platform',
    name: 'Facebook',
    secret: 'A Page access token.',
    placeholder: 'EAAB…',
  },
  {
    id: 'youtube',
    group: 'platform',
    name: 'YouTube',
    secret: 'An OAuth access token for the channel.',
    placeholder: 'ya29.…',
  },
  {
    id: 'tiktok',
    group: 'platform',
    name: 'TikTok',
    secret: 'An access token for the account.',
    placeholder: 'act.…',
  },
  {
    id: 'openai_compatible',
    group: 'generator',
    name: 'OpenAI-compatible',
    secret: 'The API key HQ sends as a Bearer token.',
    placeholder: 'sk-…',
  },
  {
    id: 'llm:anthropic',
    group: 'llm',
    name: 'Anthropic',
    secret: 'An Anthropic API key for HQ’s own agent runner.',
    placeholder: 'sk-ant-…',
  },
]

/** Each group's copy: title, what it is for, and its key. */
const GROUPS: Record<
  ProviderGroupId,
  { title: string; description: string; key: string; add: string; foot: string }
> = {
  platform: {
    title: 'Providers',
    description:
      'Shops and platforms are the owner’s, not a project’s: Publish and Market name the one an account or shop goes through. Secrets are stored sealed; HQ shows only whether one works.',
    key: 'p',
    add: 'Add provider',
    foot: 'Etsy · Facebook · YouTube · TikTok',
  },
  generator: {
    title: 'Generators',
    description:
      'An OpenAI-compatible endpoint HQ calls itself to make images (and video, when you name a video model). The price is what HQ holds against an agent’s budget before it calls — without one, only you can generate with it. HQ never converts money: price it in your budget’s currency.',
    key: 'g',
    add: 'Add generator',
    foot: 'images through /v1/images/generations · video through /v1/videos',
  },
  llm: {
    title: 'LLM keys',
    description:
      'The key HQ’s own agent runner (apps/agent-runner) uses for routines set to run in HQ. Prices per million tokens, in your budget’s currency, are what each turn is held and charged at.',
    key: 'l',
    add: 'Add LLM key',
    foot: 'Anthropic · the runner runs on your machine, beside the worker',
  },
}

type ConfigField = {
  key: string
  label: string
  placeholder: string
  hint?: string
  mono?: boolean
  optional?: boolean
}

/** The config each kind takes, flat — nested keys use a dot (`image.model`). */
const CONFIG_FIELDS: Record<string, ConfigField[]> = {
  openai_compatible: [
    {
      key: 'baseUrl',
      label: 'Base URL',
      placeholder: 'https://api.openai.com',
      mono: true,
    },
    {
      key: 'currency',
      label: 'Currency',
      placeholder: 'USD',
      mono: true,
      optional: true,
    },
    {
      key: 'image.model',
      label: 'Image model',
      placeholder: 'gpt-image-1',
      mono: true,
      optional: true,
    },
    {
      key: 'image.size',
      label: 'Image size',
      placeholder: '1024x1024',
      mono: true,
      optional: true,
    },
    {
      key: 'image.pricePerImage',
      label: 'Price per image',
      placeholder: '0.04',
      mono: true,
      optional: true,
    },
    {
      key: 'video.model',
      label: 'Video model',
      placeholder: 'sora-2 (leave empty for images only)',
      mono: true,
      optional: true,
    },
    {
      key: 'video.pricePerSecond',
      label: 'Price per second of video',
      placeholder: '0.10',
      mono: true,
      optional: true,
    },
  ],
  'llm:anthropic': [
    { key: 'model', label: 'Model', placeholder: 'claude-opus-5', mono: true },
    {
      key: 'currency',
      label: 'Currency',
      placeholder: 'USD',
      mono: true,
      optional: true,
    },
    {
      key: 'inputPerMTok',
      label: 'Input price per million tokens',
      placeholder: '5',
      mono: true,
      optional: true,
    },
    {
      key: 'outputPerMTok',
      label: 'Output price per million tokens',
      placeholder: '25',
      mono: true,
      optional: true,
    },
    {
      key: 'baseUrl',
      label: 'Base URL',
      placeholder: 'https://api.anthropic.com (default)',
      mono: true,
      optional: true,
    },
  ],
}

function flatten(config: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value && typeof value === 'object')
      for (const [inner, innerValue] of Object.entries(value))
        out[`${key}.${inner}`] = String(innerValue ?? '')
    else if (value !== undefined && value !== null) out[key] = String(value)
  }
  return out
}

function nest(values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, Record<string, unknown> | string> = {}
  for (const [key, raw] of Object.entries(values)) {
    const value = raw.trim()
    if (!value) continue
    const [head, inner] = key.split('.') as [string, string | undefined]
    if (inner) {
      const branch = (out[head] ?? {}) as Record<string, unknown>
      branch[inner] = value
      out[head] = branch
    } else out[head] = value
  }
  return out
}

/** A generator's or a key's config in one line: models and prices, never a secret. */
function describeConfig(row: ProviderRow): string {
  const config = row.config ?? {}
  const currency = typeof config.currency === 'string' ? config.currency : 'USD'
  if (row.provider === 'openai_compatible') {
    const image = config.image as Record<string, string> | undefined
    const video = config.video as Record<string, string> | undefined
    return [
      image?.model
        ? ` · ${image.model}${image.pricePerImage ? ` ${image.pricePerImage} ${currency}/image` : ' · no price'}`
        : '',
      video?.model
        ? ` · ${video.model}${video.pricePerSecond ? ` ${video.pricePerSecond} ${currency}/s` : ''}`
        : ' · images only',
    ].join('')
  }
  if (row.provider.startsWith('llm:'))
    return ` · ${String(config.model ?? '')}${config.inputPerMTok ? ` ${config.inputPerMTok}/${config.outputPerMTok} ${currency} per MTok` : ''}`
  return ''
}

const kindName = (id: string) =>
  KINDS.find((kind) => kind.id === id)?.name ?? id

/** A provider's status in words, coloured only by what it asks of you. */
const STATE: Record<string, { word: string; tone: 'live' | 'wait' | '' }> = {
  connected: { word: 'ok · secret sealed', tone: 'live' },
  needs_reauth: { word: '◆ reconnect', tone: 'wait' },
  error: { word: '◆ error', tone: 'wait' },
  not_connected: { word: 'not connected', tone: '' },
}

/** Add a connection, or rename one and (optionally) replace its secret. */
function ProviderForm({
  editing,
  group,
  onClose,
}: {
  editing: ProviderRow | null
  group: ProviderGroupId
  onClose: () => void
}) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const kinds = KINDS.filter((entry) => entry.group === group)
  const [provider, setProvider] = useState(
    editing?.provider ?? kinds[0]?.id ?? 'etsy',
  )
  const [config, setConfig] = useState<Record<string, string>>(() =>
    flatten(editing?.config ?? {}),
  )
  const configFields = CONFIG_FIELDS[provider] ?? []
  const [label, setLabel] = useState(editing?.label ?? '')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const kind = kinds.find((entry) => entry.id === provider) ?? kinds[0]

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setFields({})
    start(async () => {
      const result = await saveProvider({
        ...(editing
          ? { connectionId: editing.id, expectedRevision: editing.revision }
          : {}),
        provider: provider as 'etsy',
        label,
        ...(secret.trim() ? { secret } : {}),
        ...(configFields.length ? { config: nest(config) } : {}),
      })
      if (!result.ok) {
        setError(result.error)
        setFields(result.fields ?? {})
        return
      }
      setSecret('')
      toast(
        editing
          ? `Saved ${result.data.label}${secret.trim() ? ' — new secret sealed' : ''}`
          : `Connected ${result.data.label} — secret sealed`,
      )
      onClose()
    })
  }

  return (
    <form
      className='fcard'
      onSubmit={submit}
      aria-label={editing ? `Edit ${editing.label}` : 'Add a provider'}
    >
      <div className='row'>
        <span className='fld-label'>Provider</span>
        {/* biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons, not a fieldset */}
        <span className='seg' role='group' aria-label='Provider'>
          {kinds.map((entry) => (
            <button
              key={entry.id}
              type='button'
              aria-pressed={provider === entry.id}
              disabled={Boolean(editing) && provider !== entry.id}
              onClick={() => setProvider(entry.id)}
            >
              {entry.name}
            </button>
          ))}
        </span>
      </div>
      <label>
        Name
        <input
          type='text'
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={`${kind?.name ?? 'Shop'} — main`}
          maxLength={80}
          aria-invalid={Boolean(fields.label)}
          // biome-ignore lint/a11y/noAutofocus: the form opens on purpose, from Add provider
          autoFocus
        />
      </label>
      {configFields.map((field) => (
        <label key={field.key}>
          {field.label}
          {field.optional ? <span className='dim'> · optional</span> : null}
          <input
            type='text'
            value={config[field.key] ?? ''}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                [field.key]: event.target.value,
              }))
            }
            placeholder={field.placeholder}
            className={field.mono ? 'mono' : undefined}
            spellCheck={false}
            aria-invalid={Boolean(
              fields[`config.${field.key}`] ??
                fields[field.key.split('.').pop() as string],
            )}
          />
        </label>
      ))}
      <label>
        {editing ? 'Replace the secret (leave empty to keep it)' : 'Secret'}
        <textarea
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={kind?.placeholder}
          rows={provider === 'etsy' ? 4 : 2}
          spellCheck={false}
          autoComplete='off'
          aria-invalid={Boolean(fields.secret)}
          className='mono'
        />
      </label>
      <p className='hint'>
        {kind?.secret} Sealed the moment it arrives; HQ shows only its last four
        characters after.
      </p>
      {fields.secret ? (
        <p className='err' role='alert'>
          {fields.secret}
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
          disabled={
            pending || !label.trim() || (!editing && secret.trim() === '')
          }
        >
          {pending ? 'Sealing…' : editing ? 'Save' : 'Connect'}
        </button>
        <button type='button' className='btn' onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}

export function Providers({
  group = 'platform',
  rows,
  unread,
  sealing,
  children,
}: {
  group?: ProviderGroupId
  rows: ProviderRow[]
  /** The list couldn't be read back — show that, not "none". */
  unread: boolean
  /** Whether the server can seal a secret at all (HQ_SEALING_KEY). */
  sealing: boolean
  children?: ReactNode
}) {
  const toast = useToast()
  const [form, setForm] = useState<'new' | string | null>(null)
  const problems = rows.filter((row) => STATE[row.status]?.tone === 'wait')
  const editing = rows.find((row) => row.id === form) ?? null

  const revoke = async (row: ProviderRow) => {
    const result = await revokeProvider(row.id)
    toast(
      result.ok
        ? `Revoked ${row.label} — its secret is gone; accounts that used it fall back to by hand.`
        : result.error,
    )
  }

  const copy = GROUPS[group]
  return (
    <Group
      id={group === 'platform' ? 'providers' : `${group}s`}
      title={copy.title}
      description={copy.description}
      problem={problems.length > 0}
      foot={
        <>
          {form ? null : (
            <button
              type='button'
              className='btn'
              disabled={!sealing}
              data-key={copy.key}
              onClick={() => setForm('new')}
            >
              {copy.add} <kbd>{copy.key}</kbd>
            </button>
          )}
          <span className={`st${sealing ? '' : ' wait'}`}>
            {sealing
              ? copy.foot
              : '◆ set HQ_SEALING_KEY on HQ before adding a secret'}
          </span>
        </>
      }
    >
      {unread ? (
        <div className='empty unknown'>— providers not read back</div>
      ) : rows.length === 0 ? (
        <div className='empty'>○ no {copy.title.toLowerCase()} yet</div>
      ) : (
        <div className='tbl conn-tbl prov-tbl'>
          <div className='tbl-head' aria-hidden='true'>
            <span className='hud-label'>Provider</span>
            <span className='hud-label c-hide'>Secret · problem</span>
            <span className='hud-label'>State</span>
            <span className='sr-only'>Actions</span>
          </div>
          {rows.map((row) => {
            const state = STATE[row.status] ?? {
              word: row.status,
              tone: '' as const,
            }
            return (
              <div key={row.id} className='tbl-row'>
                <span>
                  {row.label}{' '}
                  <span className='mono'>{kindName(row.provider)}</span>
                </span>
                <span className='c-hide' title={row.problem ?? undefined}>
                  <span className='mono'>{row.hint ?? '—'}</span>
                  {describeConfig(row)}
                  {row.problem ? ` · ${row.problem}` : null}
                </span>
                <span>
                  <StateWord tone={state.tone}>{state.word}</StateWord>
                </span>
                <span className='acts'>
                  <button
                    type='button'
                    className='btn btn-sm'
                    disabled={!sealing}
                    onClick={() => setForm(row.id)}
                  >
                    {state.tone === 'wait' ? 'Reconnect' : 'Edit'}
                  </button>
                  <Confirm
                    label='Revoke'
                    question={`Revoke ${row.label}?`}
                    yes='Revoke'
                    run={() => revoke(row)}
                  />
                </span>
              </div>
            )
          })}
        </div>
      )}
      {form ? (
        <ProviderForm
          key={form}
          group={group}
          editing={editing}
          onClose={() => setForm(null)}
        />
      ) : null}
      {children}
    </Group>
  )
}
