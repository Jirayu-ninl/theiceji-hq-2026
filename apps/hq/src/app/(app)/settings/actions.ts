'use server'

import { requireUser } from '@theiceji/hq-auth'
import {
  emailInUse,
  updateEmail,
  updatePassword,
  updateProfile,
  verifyUserPassword,
} from '@theiceji/hq-auth/account'
import { MIN_PASSWORD_LENGTH } from '@theiceji/hq-auth/constants'
import { clearSessionCookie, readSessionCookie } from '@theiceji/hq-auth/cookie'
import {
  invalidateOtherSessions,
  invalidateUserSession,
  invalidateUserSessions,
  sessionId,
} from '@theiceji/hq-auth/session'
import {
  clearFailures,
  cooldownMinutes,
  isThrottled,
  recordFailure,
} from '@theiceji/hq-auth/throttle'
import { removeDevice } from '@theiceji/hq-push/store'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { FormResult } from './parts'

/**
 * Settings › Account actions. Each carries its own gate — a server action is a routable
 * endpoint that doesn't pass through the layout that checked the session.
 * Anything that changes how you sign in asks for the current password, so a
 * browser left open isn't enough to take the account over.
 */

const text = (data: FormData, name: string) => {
  const value = data.get(name)
  return typeof value === 'string' ? value : ''
}

const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? '' : 's'}`

/** Revalidates the whole shell — the top bar shows the name and avatar. */
const refreshShell = () => revalidatePath('/', 'layout')
/** Every Settings tab, whichever one the form was posted from. */
const refreshSettings = () => revalidatePath('/settings', 'layout')

function failure(e: unknown): FormResult {
  console.error('[settings]', (e as Error).message)
  return { ok: false, error: 'Couldn’t save that right now. Try again.' }
}

/** Same throttle as the sign-in form, keyed to the account. */
async function checkCurrentPassword(
  userId: string,
  password: string,
): Promise<FormResult | null> {
  const key = `settings|${userId}`
  if (isThrottled(key)) {
    return {
      ok: false,
      error: `Too many attempts. Try again in ${cooldownMinutes(key)} minutes.`,
    }
  }
  if (!(await verifyUserPassword(userId, password))) {
    recordFailure(key)
    const error = 'Your current password is incorrect.'
    return { ok: false, error, fields: { currentPassword: error } }
  }
  clearFailures(key)
  return null
}

const profileInput = z.object({
  name: z
    .string()
    .trim()
    .max(80, 'Keep the name under 80 characters.')
    .transform((value) => value || null),
  image: z
    .string()
    .trim()
    .max(1000, 'That avatar URL is too long.')
    .refine(
      (value) => value === '' || /^https?:\/\/\S+$/i.test(value),
      'The avatar must be an http(s) URL.',
    )
    .transform((value) => value || null),
})

export async function updateProfileAction(data: FormData): Promise<FormResult> {
  const user = await requireUser()
  const parsed = profileInput.safeParse({
    name: text(data, 'name'),
    image: text(data, 'image'),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      error: issue?.message ?? 'Check the highlighted fields.',
      fields: issue ? { [String(issue.path[0])]: issue.message } : undefined,
    }
  }
  try {
    await updateProfile(user.id, parsed.data)
  } catch (e) {
    return failure(e)
  }
  refreshShell()
  return { ok: true, message: 'Profile saved.' }
}

export async function changeEmailAction(data: FormData): Promise<FormResult> {
  const user = await requireUser()
  const email = text(data, 'email').trim().toLowerCase()
  if (!z.email().max(200).safeParse(email).success) {
    const error = 'Enter a valid email address.'
    return { ok: false, error, fields: { email: error } }
  }
  if (email === user.email.toLowerCase()) {
    return { ok: false, error: 'That is already your email.' }
  }
  try {
    const wrong = await checkCurrentPassword(
      user.id,
      text(data, 'currentPassword'),
    )
    if (wrong) return wrong
    if (await emailInUse(email, user.id)) {
      const error = 'Another account already uses that email.'
      return { ok: false, error, fields: { email: error } }
    }
    await updateEmail(user.id, email)
  } catch (e) {
    return failure(e)
  }
  refreshShell()
  return { ok: true, message: `You now sign in as ${email}.` }
}

export async function changePasswordAction(
  data: FormData,
): Promise<FormResult> {
  const user = await requireUser()
  const current = text(data, 'currentPassword')
  const next = text(data, 'newPassword')
  if (next.length < MIN_PASSWORD_LENGTH || next.length > 400) {
    const error = `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`
    return { ok: false, error, fields: { newPassword: error } }
  }
  if (next !== text(data, 'confirmPassword')) {
    const error = 'The two new passwords don’t match.'
    return { ok: false, error, fields: { confirmPassword: error } }
  }
  if (next === current) {
    return { ok: false, error: 'Choose a password you aren’t using now.' }
  }
  const token = await readSessionCookie()
  let signedOut = 0
  try {
    const wrong = await checkCurrentPassword(user.id, current)
    if (wrong) return wrong
    await updatePassword(user.id, next)
    // Whoever else knew the old password is out; this browser stays in.
    if (token) signedOut = await invalidateOtherSessions(user.id, token)
  } catch (e) {
    return failure(e)
  }
  refreshSettings()
  return {
    ok: true,
    message:
      signedOut > 0
        ? `Password changed. ${plural(signedOut, 'other session')} signed out.`
        : 'Password changed.',
  }
}

export async function revokeSessionAction(data: FormData): Promise<FormResult> {
  const user = await requireUser()
  const id = text(data, 'id')
  if (!/^[0-9a-f]{64}$/.test(id)) {
    return { ok: false, error: 'Unknown session.' }
  }
  const token = await readSessionCookie()
  if (token && sessionId(token) === id) {
    return {
      ok: false,
      error: 'That’s this browser — sign out from the account menu instead.',
    }
  }
  try {
    const revoked = await invalidateUserSession(user.id, id)
    if (!revoked) return { ok: false, error: 'That session already ended.' }
  } catch (e) {
    return failure(e)
  }
  refreshSettings()
  return { ok: true }
}

export async function signOutOthersAction(): Promise<FormResult> {
  const user = await requireUser()
  const token = await readSessionCookie()
  if (!token) return { ok: false, error: 'This device has no session.' }
  let count: number
  try {
    count = await invalidateOtherSessions(user.id, token)
  } catch (e) {
    return failure(e)
  }
  refreshSettings()
  return { ok: true, message: `${plural(count, 'session')} signed out.` }
}

export async function signOutEverywhereAction(): Promise<FormResult> {
  const user = await requireUser()
  try {
    await invalidateUserSessions(user.id)
  } catch (e) {
    return failure(e)
  }
  await clearSessionCookie()
  return { ok: true, redirect: '/login' }
}

export async function removePushDeviceAction(
  data: FormData,
): Promise<FormResult> {
  await requireUser()
  const id = text(data, 'id')
  if (!z.uuid().safeParse(id).success) {
    return { ok: false, error: 'Unknown device.' }
  }
  try {
    const removed = await removeDevice(id)
    if (!removed)
      return { ok: false, error: 'That device was already removed.' }
  } catch (e) {
    return failure(e)
  }
  refreshSettings()
  return { ok: true }
}
