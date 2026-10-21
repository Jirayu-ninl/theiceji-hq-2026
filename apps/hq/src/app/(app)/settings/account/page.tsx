import { requireUser } from '@theiceji/hq-auth'
import { getAccount } from '@theiceji/hq-auth/account'
import { MIN_PASSWORD_LENGTH } from '@theiceji/hq-auth/constants'
import { readSessionCookie } from '@theiceji/hq-auth/cookie'
import { describeDevice } from '@theiceji/hq-auth/device'
import { listUserSessions, sessionId } from '@theiceji/hq-auth/session'
import { listDevices } from '@theiceji/hq-push/store'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { integrations } from '@/lib/integrations'
import { TabKeys } from '../forms'
import { Bar, thai, when } from '../parts'
import {
  type DeviceRow,
  EmailForm,
  PasswordForm,
  ProfileForm,
  Push,
  type SessionRow,
  Sessions,
  SignOut,
} from './AccountForms'

export const metadata: Metadata = { title: 'Account — Settings — HQ' }
export const dynamic = 'force-dynamic'

/**
 * Settings › Account: the
 * profile, the email and password you sign in with, every browser signed in,
 * the devices that get pushes, and signing out. What the old Profile,
 * Security, Sessions and Notifications tabs did, in one document; passkeys
 * are left out because HQ's sign-in has none yet. Dates and device names are
 * formatted here, on the server, so the client never re-spells them.
 */
export default async function AccountSettingsPage() {
  const user = await requireUser('/settings/account')
  const account = await getAccount(user.id)
  if (!account) redirect('/login')
  const token = await readSessionCookie()
  const current = token ? sessionId(token) : null
  const [sessions, devices] = await Promise.all([
    listUserSessions(user.id).catch(() => null),
    listDevices().catch(() => null),
  ])
  const push = integrations().find((integration) => integration.id === 'push')

  const sessionRows: SessionRow[] | null =
    sessions?.map((session) => ({
      id: session.id,
      device: describeDevice(session.userAgent).label,
      where: session.ip ?? 'IP not recorded',
      since: when(session.createdAt),
      expires: when(session.expiresAt),
      current: session.id === current,
    })) ?? null
  const deviceRows: DeviceRow[] | null =
    devices?.map((device) => ({
      id: device.id,
      device: describeDevice(device.userAgent).label,
      added: when(device.createdAt),
    })) ?? null

  return (
    <>
      <TabKeys keys={[['s', 'save profile']]} />
      <Bar
        items={[
          ['account', account.role],
          [
            'name',
            account.name ? (
              <span key='name' lang={thai(account.name)}>
                {account.name}
              </span>
            ) : (
              '—'
            ),
          ],
          ['email', account.email],
          ['sessions', sessionRows ? sessionRows.length : '— not read back'],
          ['push devices', deviceRows ? deviceRows.length : '— not read back'],
        ]}
      />
      <ProfileForm
        name={account.name}
        image={account.image}
        email={account.email}
        facts={[
          ['Role', account.role],
          ['Member since', when(account.createdAt)],
          ['Last sign-in', when(account.lastLoginAt)],
        ]}
      />
      {/* Keyed by the address, so a saved change remounts with it and an empty password. */}
      <EmailForm key={account.email} email={account.email} />
      <PasswordForm min={MIN_PASSWORD_LENGTH} />
      <Sessions rows={sessionRows} />
      <Push devices={deviceRows} missing={push && !push.ok ? push.env : null} />
      <SignOut />
    </>
  )
}
