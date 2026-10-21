import { requireApiUser } from '@theiceji/hq-auth'
import { removeSubscription, saveSubscription } from '@theiceji/hq-push/store'
import { pushSubscriptionSchema } from '@theiceji/hq-push/types'
import { NextResponse } from 'next/server'

/**
 * POST   /api/push/subscribe — store the browser's push subscription.
 * DELETE /api/push/subscribe — drop it (toggle off / unsubscribe).
 *
 * Only a signed-in admin may register a device, and both handlers verify that
 * themselves rather than trusting the proxy's cookie sniff. Bodies are the raw
 * `PushSubscription.toJSON()` shape; the DELETE only needs `endpoint`.
 */

const unauthorized = () =>
  NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

export async function POST(req: Request) {
  if (!(await requireApiUser())) return unauthorized()

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'bad_request' },
      { status: 400 },
    )
  }

  const parsed = pushSubscriptionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'invalid', issues: parsed.error.flatten() },
      { status: 422 },
    )
  }

  try {
    await saveSubscription(parsed.data, req.headers.get('user-agent'))
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[push] subscribe', (e as Error).message)
    return NextResponse.json(
      { ok: false, error: 'store_failed' },
      { status: 502 },
    )
  }
}

export async function DELETE(req: Request) {
  if (!(await requireApiUser())) return unauthorized()

  let endpoint: string | undefined
  try {
    endpoint = (await req.json())?.endpoint
  } catch {
    endpoint = undefined
  }
  if (!endpoint || typeof endpoint !== 'string') {
    return NextResponse.json(
      { ok: false, error: 'bad_request' },
      { status: 400 },
    )
  }

  try {
    await removeSubscription(endpoint)
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[push] unsubscribe', (e as Error).message)
    return NextResponse.json(
      { ok: false, error: 'store_failed' },
      { status: 502 },
    )
  }
}
