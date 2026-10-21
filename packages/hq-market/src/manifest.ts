import { type ModuleManifest, manifestBase } from '@theiceji/hq-core/manifest'

/**
 * Market's manifest. No worker jobs: listings go out by hand
 * or through the Etsy adapter inside HQ, and the ops tick reconciles and
 * syncs.
 */
export const manifest: ModuleManifest = {
  ...manifestBase('market'),
}
