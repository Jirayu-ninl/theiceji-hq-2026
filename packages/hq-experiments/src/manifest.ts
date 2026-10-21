import { type ModuleManifest, manifestBase } from '@theiceji/hq-core/manifest'

/** Experiments' manifest: no worker jobs, no settings of its own. */
export const manifest: ModuleManifest = {
  ...manifestBase('experiments'),
}
