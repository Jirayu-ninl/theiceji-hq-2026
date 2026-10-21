'use client'

import { type LoginState, signIn } from '@theiceji/hq-auth/actions'
import { SESSION_TTL_MS } from '@theiceji/hq-auth/constants'
import { useActionState } from 'react'
import { AccessScreen, AccessWell } from './AccessScreen'

const initial: LoginState = { error: null }

const SESSION_DAYS = Math.round(SESSION_TTL_MS / 86_400_000)

type Refusal = { kind: 'refused' | 'locked' | 'failed'; message: string }

/**
 * Which of the screen's states the sign-in action's answer is. The action
 * decides everything and says it in words; this only picks how the well
 * reads. A message it doesn't recognise still shows, word for word.
 */
function refusal(error: string | null): Refusal | null {
  if (!error) return null
  if (error.startsWith('Too many attempts')) {
    const rest = error.replace(/^Too many attempts\.\s*/, '')
    return { kind: 'locked', message: rest || error }
  }
  if (error === 'Email or password is incorrect.') {
    return { kind: 'refused', message: error }
  }
  return { kind: 'failed', message: error }
}

const WELL = {
  refused: { label: 'not signed in', title: 'Try again' },
  locked: { label: 'locked', title: 'Too many attempts' },
  failed: { label: 'sign in · failed', title: 'Not signed in' },
} as const

/**
 * Sign in: email and password, `↵`
 * submits. The existing hq-auth server action does the work — throttle,
 * lockout, session cookie and the `next` redirect, which is checked again
 * on the server. There is no passkey button: hq-auth has no passkeys yet.
 */
export function LoginForm({
  next,
  host,
}: {
  next: string
  host: string | null
}) {
  const [state, formAction, pending] = useActionState(signIn, initial)
  const failure = pending ? null : refusal(state.error)
  const well = failure ? WELL[failure.kind] : null
  return (
    <AccessScreen
      status={pending ? 'signing in…' : (well?.label ?? 'sign in')}
      problem={!!failure}
      host={host}
    >
      <AccessWell
        label={well?.label ?? 'bridge · access'}
        title={pending ? 'Signing in…' : (well?.title ?? 'Sign in to continue')}
        detail={
          failure ? (
            <span id='access-error' role='alert'>
              {failure.message}
            </span>
          ) : (
            `sessions stay ${SESSION_DAYS} days`
          )
        }
        problem={!!failure}
      />
      <form
        action={formAction}
        className='panel access-form'
        aria-label='Sign in'
      >
        <input type='hidden' name='next' value={next} />
        <label>
          Email
          <input
            type='email'
            name='email'
            autoComplete='username'
            required
            aria-invalid={failure?.kind === 'refused' ? true : undefined}
            aria-describedby={failure ? 'access-error' : undefined}
          />
        </label>
        <label>
          Password
          <input
            type='password'
            name='password'
            autoComplete='current-password'
            placeholder='••••••••••••'
            required
            aria-invalid={failure?.kind === 'refused' ? true : undefined}
            aria-describedby={failure ? 'access-error' : undefined}
          />
        </label>
        <div className='acts'>
          <button type='submit' className='btn btn-pri' disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
            <kbd>↵</kbd>
          </button>
        </div>
        <p className='access-note'>
          Forgot the password? Reset it from the server console; there is no
          reset email.
        </p>
      </form>
    </AccessScreen>
  )
}
