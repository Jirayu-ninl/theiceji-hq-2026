'use server'

import { requireUser } from '@theiceji/hq-auth'
import {
  type ProviderConnectionView,
  revokeProviderConnection,
  type SaveProviderConnectionInput,
  saveProviderConnection,
} from '@theiceji/hq-core/connections'
import { isScope } from '@theiceji/hq-db/scopes'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { type ActionResult as KernelResult, runAction } from '@/lib/actions'
import { createPersonalToken, revokeGrant } from '@/lib/oauth/grants'

/**
 * Server actions carry their own gate — they're routable endpoints reachable
 * without rendering the layout that checked the session.
 */

export type ActionResult = { ok: true } | { ok: false; error: string }
export type CreateTokenResult =
  | { ok: true; token: string; label: string }
  | { ok: false; error: string }

const tokenInput = z.object({
  label: z.string().trim().min(1).max(80),
  scopes: z.array(z.string()).min(1),
  expiresInDays: z.union([
    z.literal(30),
    z.literal(90),
    z.literal(365),
    z.null(),
  ]),
  actorType: z.enum(['agent', 'worker']).default('agent'),
})

export async function createToken(input: unknown): Promise<CreateTokenResult> {
  const user = await requireUser()
  const parsed = tokenInput.safeParse(input)
  const scopes = parsed.success ? parsed.data.scopes.filter(isScope) : []
  if (!parsed.success || scopes.length === 0) {
    return {
      ok: false,
      error: 'Give the token a name and at least one permission.',
    }
  }
  try {
    const { token } = await createPersonalToken({
      userId: user.id,
      label: parsed.data.label,
      scopes,
      expiresInDays: parsed.data.expiresInDays,
      actorType: parsed.data.actorType,
    })
    revalidatePath('/settings/connections')
    return { ok: true, token, label: parsed.data.label }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function revokeConnection(grantId: string): Promise<ActionResult> {
  const user = await requireUser()
  if (!z.uuid().safeParse(grantId).success) {
    return { ok: false, error: 'Unknown connection.' }
  }
  try {
    const revoked = await revokeGrant(grantId, user.id)
    revalidatePath('/settings/connections')
    return revoked
      ? { ok: true }
      : { ok: false, error: 'That connection was already revoked.' }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Add a shop or platform, rename one, or replace its secret — the owner's alone. */
export async function saveProvider(
  input: SaveProviderConnectionInput,
): Promise<KernelResult<Pick<ProviderConnectionView, 'id' | 'label'>>> {
  return runAction(
    async (actor) => {
      const saved = await saveProviderConnection(actor, input)
      return { id: saved.id, label: saved.label }
    },
    { revalidate: ['/settings/connections'] },
  )
}

export async function revokeProvider(
  connectionId: string,
): Promise<KernelResult> {
  return runAction(
    async (actor) => {
      await revokeProviderConnection(actor, { connectionId })
      return null
    },
    { revalidate: ['/settings/connections'] },
  )
}
