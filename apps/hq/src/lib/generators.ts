import 'server-only'
import { generatorMedia } from '@theiceji/hq-assets/generate'
import { listProviderConnections } from '@theiceji/hq-core/connections'
import type { Actor } from '@theiceji/hq-ops/access'

/**
 * The owner's generators, for a "Generate with…" choice:
 * each OpenAI-compatible connection that works, and what it can make — an
 * image model, a video model, both. "By hand" (`manual`) is always there;
 * the page adds it.
 */
export type GeneratorOption = {
  id: string
  label: string
  image: boolean
  video: boolean
}

export async function generatorOptions(
  actor: Actor,
): Promise<GeneratorOption[]> {
  const connections = await listProviderConnections(actor).catch(() => [])
  return connections
    .filter(
      (connection) =>
        connection.provider === 'openai_compatible' &&
        connection.status !== 'revoked',
    )
    .map((connection) => ({
      id: connection.id,
      label: connection.label,
      ...generatorMedia(connection.config),
    }))
    .filter((option) => option.image || option.video)
}
