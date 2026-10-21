import { requireUser } from '@theiceji/hq-auth'
import type { Metadata } from 'next'
import { integrations } from '@/lib/integrations'
import pkg from '../../../../../package.json'
import { TabKeys } from '../forms'
import { Bar, Fld, Group, StateWord } from '../parts'

export const metadata: Metadata = { title: 'System — Settings — HQ' }
export const dynamic = 'force-dynamic'

/**
 * Settings › System: what is running and what this deployment is wired to.
 * The list is `lib/integrations.ts`, the same one `/api/ready` reports from,
 * so the two can't disagree. Names of environment variables
 * only, never a value. Kept as the last tab until the owner decides where
 * readiness lives.
 */
export default async function SystemSettingsPage() {
  await requireUser('/settings/system')
  const wiring = integrations()
  const configured = wiring.filter((integration) => integration.ok).length
  const missing = wiring.length - configured
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null
  const environment =
    process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown'

  return (
    <>
      <TabKeys />
      <Bar
        items={[
          ['version', pkg.version],
          ['environment', environment],
          ['commit', commit ?? 'not recorded'],
          [
            'integrations',
            `${configured}/${wiring.length}`,
            missing > 0 ? 'wait' : 'live',
          ],
        ]}
      />
      <Group id='build' title='Build' description='What is running right now.'>
        <Fld label='Version'>
          <span className='mono'>{pkg.version}</span>
        </Fld>
        <Fld label='Environment'>
          <span className='mono'>{environment}</span>
        </Fld>
        <Fld label='Commit'>
          {commit ? (
            <span className='mono'>{commit}</span>
          ) : (
            <StateWord>not recorded</StateWord>
          )}
        </Fld>
      </Group>
      <Group
        id='integrations'
        title='Integrations'
        description='What this deployment is wired to. Only the names of environment variables are shown, never their values.'
        problem={missing > 0}
        foot={
          <>
            <a className='btn' href='/api/ready' target='_blank' rel='noopener'>
              Readiness report ↗
            </a>
            <span className='st'>migrations, grants and history guards</span>
          </>
        }
      >
        <div className='tbl sys-tbl'>
          <div className='tbl-head' aria-hidden='true'>
            <span className='hud-label'>Integration</span>
            <span className='hud-label c-hide'>Powers · env</span>
            <span className='hud-label'>State</span>
          </div>
          {wiring.map((integration) => (
            <div key={integration.id} className='tbl-row'>
              <span>{integration.label}</span>
              <span
                className='c-hide'
                title={`${integration.purpose} · ${integration.env}`}
              >
                {integration.purpose}{' '}
                <span className='mono'>· {integration.env}</span>
              </span>
              <span>
                <StateWord tone={integration.ok ? 'live' : 'wait'}>
                  {integration.ok ? 'configured' : '◆ not set'}
                </StateWord>
              </span>
            </div>
          ))}
        </div>
      </Group>
    </>
  )
}
