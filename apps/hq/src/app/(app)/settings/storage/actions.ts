'use server'

import { getGoogleConnection } from '@theiceji/hq-core/google'
import { getOwnerSettings, setStorageDefault } from '@theiceji/hq-core/settings'
import type { StorageProviderId } from '@theiceji/hq-db/enums'
import { invalid } from '@theiceji/hq-ops/errors'
import { type ActionResult, runAction } from '@/lib/actions'
import { driveUnavailable } from './drive'

export type StorageDefault = {
  provider: StorageProviderId
  root: string | null
  revision: number
}

/**
 * Settings › Storage: the owner's default provider and root for new files
 * (hq-core `setStorageDefault`, revision-checked and audited). Switching the
 * default to Google Drive is refused while Drive can't take files — the
 * picker says so too, but the server doesn't trust the picker. Keeping Drive
 * as it is (a new root, say) stays allowed; uploads wait until Google is back.
 */
export async function saveStorageDefaultAction(input: {
  expectedRevision: number
  provider: string
  root: string
}): Promise<ActionResult<StorageDefault>> {
  return runAction(
    async (actor) => {
      if (input.provider === 'gdrive') {
        const current = await getOwnerSettings(actor)
        if (current.storageProvider !== 'gdrive') {
          const why = driveUnavailable(
            await getGoogleConnection(actor).catch(() => undefined),
          )
          if (why) throw invalid(why, { provider: why })
        }
      }
      const saved = await setStorageDefault(actor, input)
      return {
        provider: saved.storageProvider,
        root: saved.storageRoot,
        revision: saved.revision,
      }
    },
    { revalidate: ['/settings/storage'] },
  )
}
