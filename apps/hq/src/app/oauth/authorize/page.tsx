import { requireUser } from '@theiceji/hq-auth'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { ConsentScreen } from '@/components/oauth/ConsentScreen'
import { parseAuthorizationRequest } from '@/lib/oauth/authorize'
import { AUTHORIZE_PATH } from '@/lib/oauth/config'

/**
 * GET /oauth/authorize — the authorization endpoint HQ advertises.
 *
 * Outside the (app) shell on purpose: a popup from Claude or ChatGPT should
 * show one decision, not HQ's rail. Not public in proxy.ts, so a signed-out
 * owner goes to /login and comes straight back here with every parameter.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Connect an app — HQ',
  robots: { index: false, follow: false },
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(await searchParams)) {
    const first = Array.isArray(value) ? value[0] : value
    if (first !== undefined) params.set(key, first)
  }

  const user = await requireUser(`${AUTHORIZE_PATH}?${params.toString()}`)
  const parsed = await parseAuthorizationRequest(params)
  const person = { email: user.email, name: user.name }
  const host = (await headers()).get('host')

  if (!parsed.ok) {
    if (parsed.kind === 'redirect') redirect(parsed.location)
    return (
      <ConsentScreen
        user={person}
        host={host}
        error={{ title: parsed.title, message: parsed.message }}
      />
    )
  }

  return <ConsentScreen user={person} host={host} request={parsed.request} />
}
