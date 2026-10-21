'use client'

import { signOut } from '@theiceji/hq-auth/actions'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { isThai } from '@/components/bridge/parts'
import { useToast } from '@/components/Toast'
import {
  changeEmailAction,
  changePasswordAction,
  removePushDeviceAction,
  revokeSessionAction,
  signOutEverywhereAction,
  signOutOthersAction,
  updateProfileAction,
} from '../actions'
import { Confirm, FieldError, GroupForm } from '../forms'
import { Fld, Group, StateWord } from '../parts'

/**
 * Settings › Account, the client half: the profile, email and password
 * forms, the sessions and push devices with their row actions, and signing
 * out. Every action is the one the old tabs posted to (`../actions`), so the
 * rules hold as before — above all, anything that changes how you sign in
 * asks for the current password.
 */

const withId = (id: string) => {
  const data = new FormData()
  data.set('id', id)
  return data
}

export function ProfileForm({
  name,
  image,
  email,
  facts,
}: {
  name: string | null
  image: string | null
  email: string
  facts: [label: string, value: string][]
}) {
  const initial = (name ?? email).trim().charAt(0).toUpperCase()
  return (
    <GroupForm
      id='profile'
      title='Profile'
      description='How you appear in the top bar and the account menu. One owner; without an avatar HQ shows your initial.'
      action={updateProfileAction}
      submit='Save profile'
      saveKey
    >
      {(errors) => (
        <>
          <Fld label='Name' htmlFor='profile-name'>
            <span className='avatar' aria-hidden='true'>
              {image ? (
                <img src={image} alt='' referrerPolicy='no-referrer' />
              ) : (
                initial
              )}
            </span>
            <input
              id='profile-name'
              name='name'
              type='text'
              maxLength={80}
              autoComplete='name'
              defaultValue={name ?? ''}
              lang={isThai(name) ? 'th' : undefined}
              aria-invalid={Boolean(errors.name) || undefined}
              aria-describedby={errors.name ? 'profile-name-err' : undefined}
            />
            <FieldError id='profile-name-err' error={errors.name} />
          </Fld>
          <Fld
            label='Avatar URL'
            sub='An http(s) image. Empty shows your initial.'
            htmlFor='profile-image'
          >
            <input
              id='profile-image'
              name='image'
              type='url'
              maxLength={1000}
              placeholder='https://…'
              defaultValue={image ?? ''}
              aria-invalid={Boolean(errors.image) || undefined}
              aria-describedby={errors.image ? 'profile-image-err' : undefined}
            />
            <FieldError id='profile-image-err' error={errors.image} />
          </Fld>
          {facts.map(([label, value]) => (
            <Fld key={label} label={label}>
              <span className='mono muted'>{value}</span>
            </Fld>
          ))}
        </>
      )}
    </GroupForm>
  )
}

export function EmailForm({ email }: { email: string }) {
  return (
    <GroupForm
      id='email'
      title='Email'
      description='The address you sign in with. Changing it asks for your current password.'
      action={changeEmailAction}
      submit='Change email'
      idle={`you sign in as ${email}`}
    >
      {(errors) => (
        <>
          <Fld label='Email' htmlFor='email-address'>
            <input
              id='email-address'
              name='email'
              type='email'
              maxLength={200}
              autoComplete='email'
              defaultValue={email}
              aria-invalid={Boolean(errors.email) || undefined}
              aria-describedby={errors.email ? 'email-address-err' : undefined}
            />
            <FieldError id='email-address-err' error={errors.email} />
          </Fld>
          <Fld label='Current password' htmlFor='email-current'>
            <input
              id='email-current'
              name='currentPassword'
              type='password'
              autoComplete='current-password'
              placeholder='required'
              aria-invalid={Boolean(errors.currentPassword) || undefined}
              aria-describedby={
                errors.currentPassword ? 'email-current-err' : undefined
              }
            />
            <FieldError id='email-current-err' error={errors.currentPassword} />
          </Fld>
        </>
      )}
    </GroupForm>
  )
}

export function PasswordForm({ min }: { min: number }) {
  return (
    <GroupForm
      id='password'
      title='Password'
      description='Anything that changes how you sign in asks for the current password. Changing it signs out every other browser; this one stays in.'
      action={changePasswordAction}
      submit='Change password'
      resetOnSuccess
      idle={`${min} characters or more`}
    >
      {(errors) => (
        <>
          <Fld label='Current password' htmlFor='password-current'>
            <input
              id='password-current'
              name='currentPassword'
              type='password'
              autoComplete='current-password'
              placeholder='required'
              aria-invalid={Boolean(errors.currentPassword) || undefined}
              aria-describedby={
                errors.currentPassword ? 'password-current-err' : undefined
              }
            />
            <FieldError
              id='password-current-err'
              error={errors.currentPassword}
            />
          </Fld>
          <Fld
            label='New password'
            sub={`${min} characters or more.`}
            htmlFor='password-new'
          >
            <input
              id='password-new'
              name='newPassword'
              type='password'
              autoComplete='new-password'
              aria-invalid={Boolean(errors.newPassword) || undefined}
              aria-describedby={
                errors.newPassword ? 'password-new-err' : undefined
              }
            />
            <input
              name='confirmPassword'
              type='password'
              autoComplete='new-password'
              placeholder='repeat'
              aria-label='Repeat new password'
              aria-invalid={Boolean(errors.confirmPassword) || undefined}
              aria-describedby={
                errors.confirmPassword ? 'password-new-err' : undefined
              }
            />
            <FieldError
              id='password-new-err'
              error={errors.newPassword ?? errors.confirmPassword}
            />
          </Fld>
        </>
      )}
    </GroupForm>
  )
}

export type SessionRow = {
  id: string
  device: string
  where: string
  since: string
  expires: string
  current: boolean
}

/** Every browser signed in; any but this one can be signed out. */
export function Sessions({ rows }: { rows: SessionRow[] | null }) {
  const toast = useToast()
  const others = rows?.filter((row) => !row.current).length ?? 0
  const done = (
    result: { ok: boolean; message?: string; error?: string },
    fallback: string,
  ) => {
    toast(
      result.ok ? (result.message ?? fallback) : (result.error ?? 'Try again.'),
    )
  }
  return (
    <Group
      id='sessions'
      title='Sessions'
      description='Every browser signed in to HQ. Sign out any you don’t recognise; it has to sign in again.'
      foot={
        <>
          {others > 0 ? (
            <Confirm
              label='Sign out other sessions'
              question={`Sign out ${others} other session${others === 1 ? '' : 's'}?`}
              yes='Sign them out'
              small={false}
              run={async () => done(await signOutOthersAction(), 'Signed out.')}
            />
          ) : null}
          <span className='st'>
            {rows === null
              ? 'not read back'
              : others > 0
                ? `${rows.length} active`
                : 'only this browser is signed in'}
          </span>
        </>
      }
    >
      {rows === null ? (
        <div className='empty unknown'>— sessions not read back</div>
      ) : (
        <div className='dev-rows'>
          {rows.map((row) => (
            <div key={row.id} className='dev-row'>
              <span className='t'>
                {row.device}{' '}
                {row.current ? (
                  <StateWord tone='live'>this browser</StateWord>
                ) : null}
              </span>
              <span className='v'>
                {row.where} · since {row.since} · until {row.expires}
              </span>
              {row.current ? null : (
                <Confirm
                  label='Sign out'
                  question={`Sign out ${row.device}?`}
                  yes='Sign out'
                  run={async () =>
                    done(
                      await revokeSessionAction(withId(row.id)),
                      `Signed out ${row.device}.`,
                    )
                  }
                />
              )}
            </div>
          ))}
        </div>
      )}
    </Group>
  )
}

type PushState = 'unknown' | 'unsupported' | 'denied' | 'off' | 'on' | 'busy'

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ''

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

const pushSupported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window

/**
 * Web Push for this browser, as a switch. It reads the browser's own
 * subscription on mount, so the word is honest after a reload; turning it on
 * registers the service worker, asks permission, subscribes with the VAPID
 * key and posts the subscription to `/api/push/subscribe` — the same steps
 * the old Notifications tab took. The device list follows through a refresh.
 */
function PushSwitch() {
  const router = useRouter()
  const toast = useToast()
  const [state, setState] = useState<PushState>('unknown')

  useEffect(() => {
    let active = true
    ;(async () => {
      if (!pushSupported() || !VAPID_PUBLIC_KEY) {
        if (active) setState('unsupported')
        return
      }
      if (Notification.permission === 'denied') {
        if (active) setState('denied')
        return
      }
      try {
        const registration = await navigator.serviceWorker.getRegistration()
        const subscription = await registration?.pushManager.getSubscription()
        if (active) setState(subscription ? 'on' : 'off')
      } catch {
        if (active) setState('off')
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const enable = async () => {
    setState('busy')
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off')
        return
      }
      const registration = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
      const response = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      })
      if (!response.ok) throw new Error('subscribe failed')
      setState('on')
      toast('Push is on for this browser.')
      router.refresh()
    } catch (error) {
      console.error('[push] enable', error)
      setState('off')
      toast('Couldn’t turn push on. Try again.')
    }
  }

  const disable = async () => {
    setState('busy')
    try {
      const registration = await navigator.serviceWorker.getRegistration()
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => {})
        await subscription.unsubscribe().catch(() => {})
      }
      setState('off')
      toast('Push is off for this browser.')
      router.refresh()
    } catch (error) {
      console.error('[push] disable', error)
      setState('off')
    }
  }

  const word: Record<PushState, string> = {
    unknown: '…',
    unsupported: VAPID_PUBLIC_KEY
      ? 'not supported in this browser'
      : 'not configured on this deployment',
    denied: 'blocked in this browser’s settings',
    off: 'off',
    on: 'on',
    busy: 'working…',
  }
  const on = state === 'on'
  return (
    <>
      <button
        type='button'
        className='switch'
        aria-pressed={on}
        aria-label='Push to this browser'
        disabled={state !== 'on' && state !== 'off'}
        onClick={on ? disable : enable}
      />
      <StateWord tone={on ? 'live' : ''}>{word[state]}</StateWord>
    </>
  )
}

export type DeviceRow = { id: string; device: string; added: string }

/** Push: this browser's switch, then every device that gets pushes. */
export function Push({
  devices,
  missing,
}: {
  devices: DeviceRow[] | null
  missing: string | null
}) {
  const toast = useToast()
  return (
    <Group
      id='push'
      title='Notifications'
      description='A push goes out when an urgent request waits for you (◆). Nothing else. It is turned on per browser.'
      foot={<span className='st'>applies at once</span>}
    >
      <Fld
        label='This browser'
        sub='Asks the browser for permission the first time.'
      >
        <PushSwitch />
        {missing ? (
          <p className='hint wait'>
            Web Push isn’t configured on this deployment. Set{' '}
            <span className='mono'>{missing}</span> to send pushes.
          </p>
        ) : null}
      </Fld>
      <Fld
        label='Devices'
        sub='Removing one stops its pushes until it turns them back on.'
      >
        {devices === null ? (
          <span className='unknown'>— not read back</span>
        ) : devices.length === 0 ? (
          <span className='muted'>○ no device gets pushes yet</span>
        ) : (
          <div className='dev-rows'>
            {devices.map((device) => (
              <div key={device.id} className='dev-row'>
                <span className='t'>{device.device}</span>
                <span className='v'>added {device.added}</span>
                <Confirm
                  label='Remove'
                  question={`Stop pushes on ${device.device}?`}
                  yes='Remove'
                  run={async () => {
                    const result = await removePushDeviceAction(
                      withId(device.id),
                    )
                    toast(
                      result.ok
                        ? `Pushes stopped on ${device.device}.`
                        : result.error,
                    )
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </Fld>
    </Group>
  )
}

/** Signing out: this browser, or every browser at once. */
export function SignOut() {
  const toast = useToast()
  return (
    <Group
      id='sign-out'
      title='Sign out'
      description='Connected apps and personal access tokens keep working after you sign out; revoke those under Connections.'
    >
      <Fld label='This browser'>
        <form action={signOut}>
          <button type='submit' className='btn'>
            Sign out
          </button>
        </form>
      </Fld>
      <Fld label='Every browser' sub='Ends every session, this one included.'>
        <Confirm
          label='Sign out everywhere'
          question='Sign out of HQ on every browser, this one included?'
          yes='Sign out everywhere'
          small={false}
          run={async () => {
            const result = await signOutEverywhereAction()
            if (result.ok) window.location.assign(result.redirect ?? '/login')
            else toast(result.error)
          }}
        />
      </Fld>
    </Group>
  )
}
