import { type ModuleManifest, manifestBase } from '@theiceji/hq-core/manifest'

/**
 * Quotes' manifest: no worker jobs — the PDF renders on the
 * server that sends it — and no per-project settings yet. Its one clock
 * duty, `quotes.expire`, is a tick step (./register.ts).
 */
export const manifest: ModuleManifest = {
  ...manifestBase('quotes'),
}
