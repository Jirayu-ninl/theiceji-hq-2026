import { type ModuleManifest, manifestBase } from '@theiceji/hq-core/manifest'

/**
 * Readings' manifest. It has no tables (`readings_` is never
 * used) — it reads the other modules through the hq-core registry.
 */
export const manifest: ModuleManifest = {
  ...manifestBase('readings'),
}
