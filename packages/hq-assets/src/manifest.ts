import { type ModuleManifest, manifestBase } from '@theiceji/hq-core/manifest'

/**
 * Assets' manifest. `assets.thumbnail` is the worker's job
 * for a video with no still yet; it runs once apps/worker moves onto the
 * module tools — until then HQ's upload page grabs the
 * still in the browser.
 */
export const manifest: ModuleManifest = {
  ...manifestBase('assets'),
  jobs: ['assets.thumbnail'],
}
