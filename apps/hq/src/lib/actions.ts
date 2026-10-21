import 'server-only'
import { requireUser } from '@theiceji/hq-auth'
import { type Actor, userActor } from '@theiceji/hq-ops/access'
import { OpsError } from '@theiceji/hq-ops/errors'
import { revalidatePath } from 'next/cache'

/**
 * The one shape every Bridge server action answers in:
 * each action checks the session itself — actions are routable endpoints,
 * reachable without the layout that checked it — and returns a value the view
 * can show or roll back on, never a thrown error that would blank the page.
 *
 * A kernel error is already a sentence a person can act on; anything else is
 * a bug, logged here and shown as a plain "try again".
 */

export type ActionResult<T = null> =
  | { ok: true; data: T }
  | { ok: false; error: string; fields?: Record<string, string> }

/** The signed-in owner as the kernel's actor. */
export async function currentActor(): Promise<Actor> {
  const user = await requireUser()
  return userActor({ id: user.id, role: user.role })
}

/**
 * A change answers with the page already re-rendered: `revalidatePath` makes
 * Next render the current route again inside the action's own response and
 * drop every other page the browser kept (`staleTimes` in next.config.ts). So a
 * view never follows an action with `router.refresh()` — that is a second
 * full render of the same thing.
 *
 * · `read` — the action changes nothing, so nothing is re-rendered.
 * · `quiet` — a write that is one step of a batch (each file of an upload):
 *   it re-renders nothing, and the caller ends the batch with
 *   `refreshAction()`, one render for the lot.
 */
export async function runAction<T>(
  work: (actor: Actor) => Promise<T>,
  options: { revalidate?: string[]; read?: boolean; quiet?: boolean } = {},
): Promise<ActionResult<T>> {
  const actor = await currentActor()
  try {
    const data = await work(actor)
    // The shell's counts and the rail live in the layout, which a client
    // navigation doesn't re-render — so a change refreshes it too. A read
    // changes nothing and refreshes nothing.
    if (!options.read && !options.quiet) revalidatePath('/', 'layout')
    for (const path of options.revalidate ?? []) revalidatePath(path)
    return { ok: true, data }
  } catch (error) {
    if (error instanceof OpsError)
      return {
        ok: false,
        error: error.message,
        ...(Object.keys(error.fields).length > 0
          ? { fields: error.fields }
          : {}),
      }
    console.error('action failed', error)
    return { ok: false, error: 'Something went wrong. Try again in a moment.' }
  }
}
