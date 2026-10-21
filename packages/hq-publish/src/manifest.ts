import { type ModuleManifest, manifestBase } from '@theiceji/hq-core/manifest'

/**
 * Publish's manifest. No worker jobs: posts go out by hand or
 * through a platform adapter inside HQ, and the ops tick reconciles.
 */
export const manifest: ModuleManifest = {
  ...manifestBase('publish'),
}
