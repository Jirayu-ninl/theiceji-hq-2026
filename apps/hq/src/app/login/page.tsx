import { getCurrentUser } from '@theiceji/hq-auth'
import { internalPath } from '@theiceji/hq-auth/paths'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { LoginForm } from '@/components/auth/LoginForm'

export const metadata: Metadata = { title: 'Sign in — HQ' }

/** Only same-origin paths survive the round trip through the query string. */
function safeNext(value: string | string[] | undefined): string {
  return internalPath(Array.isArray(value) ? value[0] : value, '/')
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>
}) {
  const next = safeNext((await searchParams).next)

  // Already signed in — don't make them look at a form they don't need.
  if (await getCurrentUser()) redirect(next)

  // Outside the shell: the access screen is the whole page.
  return <LoginForm next={next} host={(await headers()).get('host')} />
}
