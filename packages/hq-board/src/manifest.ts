import { type ModuleManifest, manifestBase } from '@theiceji/hq-core/manifest'

/** Board's manifest: no worker jobs, no settings of its own yet. */
export const manifest: ModuleManifest = {
  ...manifestBase('board'),
}
