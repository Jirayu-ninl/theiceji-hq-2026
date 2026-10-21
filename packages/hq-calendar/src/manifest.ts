import { type ModuleManifest, manifestBase } from '@theiceji/hq-core/manifest'

/**
 * Calendar's manifest: no worker jobs — the Google sync runs
 * on the ops tick (register.ts) — and no settings of its own yet.
 */
export const manifest: ModuleManifest = {
  ...manifestBase('calendar'),
}
