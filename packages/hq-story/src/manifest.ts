import { type ModuleManifest, manifestBase } from '@theiceji/hq-core/manifest'

/**
 * Story's manifest: film projects only, on Prompts and
 * Assets. A scene's ZIP is an Assets worker job (`assets.zip`).
 */
export const manifest: ModuleManifest = {
  ...manifestBase('story'),
  jobs: ['assets.zip'],
}
