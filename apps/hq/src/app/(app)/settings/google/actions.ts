'use server'

import { disconnectGoogle } from '@theiceji/hq-core/google'
import { type ActionResult, runAction } from '@/lib/actions'

/** Revoke HQ's Google access and forget the token. Files already in Drive stay. */
export async function disconnectGoogleAction(): Promise<ActionResult> {
  return runAction(
    async (actor) => {
      await disconnectGoogle(actor)
      return null
    },
    { revalidate: ['/settings/google'] },
  )
}
