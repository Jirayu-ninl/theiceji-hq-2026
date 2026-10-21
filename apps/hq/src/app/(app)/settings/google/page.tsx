import {
  GOOGLE_SCOPES,
  getGoogleConnection,
  googleBlocker,
  googleClient,
} from '@theiceji/hq-core/google'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { currentActor } from '@/lib/actions'
import {
  GOOGLE_ERRORS,
  type GoogleErrorCode,
  googleRedirectUri,
} from '@/lib/google'
import { TabKeys } from '../forms'
import { DisconnectGoogle } from './DisconnectGoogle'

export const metadata: Metadata = { title: 'Google — Settings — HQ' }
export const dynamic = 'force-dynamic'

const SCOPE_WORDS: Record<string, string> = {
  [GOOGLE_SCOPES[0]]: 'drive.file',
  [GOOGLE_SCOPES[1]]: 'calendar.events',
  [GOOGLE_SCOPES[2]]: 'calendar.readonly',
}

const when = (date: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  }).format(date)

/**
 * Settings › Google: the one
 * connection that serves Drive and Calendar, the OAuth client
 * it runs on, and what syncs. Plain group cards; the only LCD is the readout
 * bar. Nothing here lets anything leave HQ, so no button is red.
 */
export default async function GoogleSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>
}) {
  const params = await searchParams
  const actor = await currentActor()
  const [connection, host] = await Promise.all([
    getGoogleConnection(actor),
    headers(),
  ])
  const blocker = googleBlocker()
  const client = googleClient()
  const origin = `${host.get('x-forwarded-proto') ?? 'http'}://${host.get('host') ?? 'localhost'}`
  const live = connection?.status === 'connected'
  const problem =
    connection &&
    connection.status !== 'connected' &&
    connection.status !== 'revoked'
  const error =
    params.error && params.error in GOOGLE_ERRORS
      ? GOOGLE_ERRORS[params.error as GoogleErrorCode]
      : null

  return (
    <>
      <TabKeys
        keys={
          blocker ? [] : [['g', live ? 'reconnect Google' : 'connect Google']]
        }
      />
      <div className='readout' role='status'>
        <span>
          <span className='k'>google</span>
          <span className={`v ${live ? 'live' : problem ? 'wait' : ''}`}>
            {live ? 'connected' : problem ? '◆ reconnect' : 'not connected'}
          </span>
        </span>
        <span>
          <span className='k'>scopes</span>
          <span className='v'>
            {connection && connection.status !== 'revoked'
              ? connection.scopes.length
              : 0}
          </span>
        </span>
        <span>
          <span className='k'>calendar</span>
          <span className={`v ${live && connection?.calendar ? '' : 'wait'}`}>
            {live ? (connection?.calendar ? 'allowed' : '◆ not allowed') : '—'}
          </span>
        </span>
      </div>

      {params.connected === '1' && live ? (
        <p className='why ok' role='status'>
          <b>Connected.</b> HQ can now keep files in Drive for projects set to
          Google Drive, and sync events you mark to sync.
        </p>
      ) : null}
      {error ? (
        <p className='why' role='alert'>
          <b>Didn’t connect:</b> {error}
        </p>
      ) : null}

      <section
        className={`group${problem ? ' problem' : ''}`}
        aria-labelledby='g-conn-h'
      >
        <header className='group-head'>
          <h2 id='g-conn-h'>
            Connection{' '}
            <span
              className={`state-word ${live ? 'live' : problem ? 'wait' : ''}`}
            >
              {live
                ? 'connected'
                : problem
                  ? '◆ needs you'
                  : connection?.status === 'revoked'
                    ? 'disconnected'
                    : 'not connected'}
            </span>
          </h2>
          <p>
            One connection per owner serves Drive and Calendar. HQ asks for no
            wider access than the three scopes below.
          </p>
        </header>
        <div className='group-body'>
          {connection && connection.status !== 'revoked' ? (
            <>
              <div className='dev-read' style={{ padding: '2px 8px 6px' }}>
                <dl className='facts'>
                  <dt>account</dt>
                  <dd>{connection.email}</dd>
                  <dt>scopes</dt>
                  <dd>
                    {connection.scopes
                      .map((scope) => SCOPE_WORDS[scope] ?? scope)
                      .join(' · ') || '—'}
                  </dd>
                  <dt>Drive folder</dt>
                  <dd>
                    {connection.driveRootId
                      ? `TheIceJi HQ · ${connection.driveRootId.slice(0, 6)}…`
                      : '—'}
                  </dd>
                  <dt>calendar</dt>
                  <dd>{connection.calendarId ?? '—'}</dd>
                  <dt>connected</dt>
                  <dd>{when(connection.connectedAt)}</dd>
                </dl>
              </div>
              {problem ? (
                <p className='why' style={{ margin: '0 8px' }}>
                  <b>Why it stopped:</b>{' '}
                  {connection.problem ?? 'Google refused HQ’s access.'} Drive
                  uploads and calendar sync wait until you reconnect. HQ never
                  re-authorizes on your behalf.
                </p>
              ) : connection.problem ? (
                <p className='why info' style={{ margin: '0 8px' }}>
                  <b>Note:</b> {connection.problem}
                </p>
              ) : (
                <p className='why ok' style={{ margin: '0 8px' }}>
                  <b>What it does:</b> Drive storage for projects set to Google
                  Drive, and calendar sync both ways for events you mark to
                  sync.
                </p>
              )}
            </>
          ) : (
            <div className='empty'>
              {connection?.status === 'revoked'
                ? `Disconnected ${connection.revokedAt ? when(connection.revokedAt) : ''}. Files HQ put in Drive are still there.`
                : '○ not connected yet'}
            </div>
          )}
        </div>
        <footer className='group-foot'>
          {blocker ? (
            <span className='st wait'>◆ {blocker}</span>
          ) : (
            <>
              <a
                className={`btn${live ? '' : ' btn-pri'}`}
                href='/api/google/connect'
                data-key='g'
              >
                {live
                  ? 'Reconnect'
                  : problem
                    ? 'Reconnect Google'
                    : 'Connect Google'}
                <kbd>g</kbd>
              </a>
              {connection && connection.status !== 'revoked' ? (
                <DisconnectGoogle />
              ) : null}
              <span className='st'>consent opens in Google</span>
            </>
          )}
        </footer>
      </section>

      <section className='group' aria-labelledby='g-client-h'>
        <header className='group-head'>
          <h2 id='g-client-h'>OAuth client</h2>
          <p>
            You create it in Google Cloud yourself; HQ reads the ID and secret
            from the environment.
          </p>
        </header>
        <div className='group-body'>
          <dl className='facts oauth-facts'>
            <dt>client id</dt>
            <dd>{client ? `…${client.clientId.slice(-28)}` : '— not set'}</dd>
            <dt>redirect</dt>
            <dd>{googleRedirectUri(origin)}</dd>
            <dt>APIs</dt>
            <dd>Drive API · Calendar API</dd>
            <dt>env</dt>
            <dd>
              GOOGLE_OAUTH_CLIENT_ID · GOOGLE_OAUTH_CLIENT_SECRET ·{' '}
              <span className={`state-word ${client ? 'live' : 'wait'}`}>
                {client ? 'set' : '◆ not set'}
              </span>
            </dd>
          </dl>
        </div>
      </section>

      <section className='group' aria-labelledby='g-sync-h'>
        <header className='group-head'>
          <h2 id='g-sync-h'>What syncs</h2>
        </header>
        <div className='group-body'>
          <div className='dev-rows'>
            <div className='dev-row'>
              <span className='t'>
                Drive: files land in{' '}
                <span className='mono'>TheIceJi HQ/&lt;project&gt;/…</span> for
                projects whose storage is Google Drive.
              </span>
            </div>
            <div className='dev-row'>
              <span className='t'>
                Calendar, Google → HQ: read on the ops tick (polling; no webhook
                in v1). Arrives with Calendar.
              </span>
            </div>
            <div className='dev-row'>
              <span className='t'>
                Calendar, HQ → Google: only events you mark to sync. Card due
                dates never sync.
              </span>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
