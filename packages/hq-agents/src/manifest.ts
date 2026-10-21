import { type ModuleManifest, manifestBase } from '@theiceji/hq-core/manifest'

/**
 * Agents' manifest: any project kind, and HQ-wide routines
 * in no project. Its one scope is the kernel's `agents:operate` — claiming,
 * proposing, reporting cost; routines themselves are the owner's.
 */
export const manifest: ModuleManifest = {
  ...manifestBase('agents'),
}
