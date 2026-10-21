import { requireUser } from '@theiceji/hq-auth'
import {
  listProviderConnections,
  type ProviderConnectionView,
} from '@theiceji/hq-core/connections'
import { isSealingConfigured } from '@theiceji/hq-ops/secrets'
import type { Metadata } from 'next'
import Link from 'next/link'
import { isDbConfigured } from '@/db'
import { currentActor } from '@/lib/actions'
import { defaultResource, oauthReadiness } from '@/lib/oauth/config'
import { type Connection, listConnections } from '@/lib/oauth/grants'
import { TabKeys } from '../forms'
import { Bar, when } from '../parts'
import { Apps, ConnectApp, type GrantRow, Tokens } from './ConnectionsParts'
import { type ProviderRow, Providers } from './ProvidersPart'

export const metadata: Metadata = { title: 'Connections — Settings — HQ' }
export const dynamic = 'force-dynamic'

/**
 * Settings › Connections: the MCP
 * endpoint and how each client connects; the apps and personal access tokens
 * that hold a grant, each revocable; and the providers HQ holds a sealed
 * secret for — shops and platforms added, replaced and revoked here,
 * their state and last four characters only, never a secret —
 * and the generators HQ calls itself and the LLM keys its
 * own agent runner uses, with their models and prices.
 */
export default async function ConnectionsSettingsPage() {
  const user = await requireUser('/settings/connections')
  const readiness = oauthReadiness()
  const endpoint = defaultResource()
  const missing = readiness.ok ? [] : readiness.missing

  let connections: Connection[] = []
  let loadError: string | null = null
  if (isDbConfigured()) {
    try {
      connections = await listConnections(user.id)
    } catch (e) {
      loadError = `Couldn’t load connections — has \`bun run db:migrate\` been run? (${(e as Error).message})`
    }
  }
  const providers: ProviderConnectionView[] | null =
    await listProviderConnections(await currentActor()).catch(() => null)
  const providerRows: ProviderRow[] = (providers ?? []).map((provider) => ({
    id: provider.id,
    provider: provider.provider,
    label: provider.label,
    hint: provider.secretHint,
    status: provider.status,
    problem: provider.problem,
    revision: provider.revision,
    checked: provider.lastCheckedAt ? when(provider.lastCheckedAt) : null,
    config: provider.config,
  }))
  const platformRows = providerRows.filter(
    (row) =>
      row.provider !== 'openai_compatible' && !row.provider.startsWith('llm:'),
  )
  const generatorRows = providerRows.filter(
    (row) => row.provider === 'openai_compatible',
  )
  const llmRows = providerRows.filter((row) => row.provider.startsWith('llm:'))

  const rows: GrantRow[] = connections.map((connection) => ({
    id: connection.id,
    kind: connection.kind,
    label: connection.label,
    host: connection.host,
    scopes: connection.scopes,
    actorType: connection.actorType,
    added: when(connection.createdAt),
    lastUsed: connection.lastUsedAt ? when(connection.lastUsedAt) : null,
    expires: connection.expiresAt ? when(connection.expiresAt) : null,
    tokenHint: connection.tokenHint,
    expired: connection.expired,
  }))
  const apps = rows.filter((row) => row.kind === 'oauth')
  const tokens = rows.filter((row) => row.kind === 'personal')
  const expired = rows.filter((row) => row.expired).length
  const providerProblems =
    providers?.filter((provider) =>
      ['needs_reauth', 'error'].includes(provider.status),
    ).length ?? 0

  return (
    <>
      <TabKeys
        keys={[
          ['c', 'create a token'],
          ['p', 'add a provider'],
          ['g', 'add a generator'],
          ['l', 'add an LLM key'],
        ]}
      />
      <Bar
        items={[
          [
            'endpoint',
            endpoint ? 'set' : '◆ not set',
            endpoint ? 'live' : 'wait',
          ],
          ['apps', apps.length],
          ['tokens', tokens.length],
          ['expired', expired, expired > 0 ? 'accent' : ''],
          [
            'providers',
            providers === null
              ? 'not read back'
              : providerProblems > 0
                ? `◆ ${providerProblems} to fix`
                : providers.filter(
                    (provider) => provider.status === 'connected',
                  ).length,
            providerProblems > 0 ? 'wait' : '',
          ],
        ]}
      />
      {missing.length > 0 ? (
        <p className='why' role='alert'>
          <b>Connections aren’t configured yet.</b> Set {missing.join(', ')} on
          HQ.
        </p>
      ) : null}
      {loadError ? (
        <p className='why' role='alert'>
          {loadError}
        </p>
      ) : null}
      <ConnectApp endpoint={endpoint} />
      <Apps grants={apps} />
      <Tokens
        grants={tokens}
        disabled={
          !endpoint || missing.length > 0
            ? 'set up the MCP endpoint first — see the notice above'
            : null
        }
      />
      <Providers
        rows={platformRows}
        unread={providers === null}
        sealing={isSealingConfigured()}
      >
        <div className='dev-rows'>
          <div className='dev-row'>
            <span className='t'>
              Google — Drive and Calendar on one connection — lives under{' '}
              <Link className='lnk' href='/settings/google'>
                Google
              </Link>
              .
            </span>
          </div>
        </div>
      </Providers>
      <Providers
        group='generator'
        rows={generatorRows}
        unread={providers === null}
        sealing={isSealingConfigured()}
      />
      <Providers
        group='llm'
        rows={llmRows}
        unread={providers === null}
        sealing={isSealingConfigured()}
      />
    </>
  )
}
