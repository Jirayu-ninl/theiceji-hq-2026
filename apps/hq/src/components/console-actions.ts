'use server'

import { type ActionResult, runAction } from '@/lib/actions'
import { type ConsoleData, readConsole } from '@/lib/console'

/**
 * The console's one read: Log and Runs for the signed-in
 * owner, fetched when the console opens and again each time it reopens.
 * A read changes nothing, so it refreshes nothing.
 */
export async function readConsoleAction(): Promise<ActionResult<ConsoleData>> {
  return runAction((actor) => readConsole(actor), { read: true })
}
