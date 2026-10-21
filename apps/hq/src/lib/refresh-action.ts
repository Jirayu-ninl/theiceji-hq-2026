'use server'

import { type ActionResult, runAction } from './actions'

/**
 * The end of a batch of `quiet` writes (lib/actions.ts): re-render the page
 * and the shell once, for everything the batch changed, and drop the pages
 * the browser kept — what each step would otherwise have done on its own.
 */
export async function refreshAction(): Promise<ActionResult<null>> {
  return runAction(async () => null)
}
