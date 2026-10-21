/**
 * Login attempt throttle.
 *
 * In-memory and therefore per-instance: on a serverless host each lambda keeps
 * its own tally, so this raises the cost of guessing rather than capping it
 * absolutely. That is the right trade for an admin app with a handful of operators —
 * the real defence is a long password behind a 64 MB scrypt. Move the counter
 * into Postgres if HQ ever opens up beyond the team.
 */

const WINDOW_MS = 10 * 60 * 1000
const MAX_FAILURES = 8

type Entry = { count: number; first: number }
const attempts = new Map<string, Entry>()

function prune(now: number) {
  if (attempts.size < 512) return
  for (const [key, entry] of attempts) {
    if (now - entry.first > WINDOW_MS) attempts.delete(key)
  }
}

function live(key: string, now: number): Entry | null {
  const entry = attempts.get(key)
  if (!entry) return null
  if (now - entry.first > WINDOW_MS) {
    attempts.delete(key)
    return null
  }
  return entry
}

export function isThrottled(key: string): boolean {
  return (live(key, Date.now())?.count ?? 0) >= MAX_FAILURES
}

/** Minutes the caller must wait, for the message shown on the form. */
export function cooldownMinutes(key: string): number {
  const entry = live(key, Date.now())
  if (!entry) return 0
  return Math.max(
    1,
    Math.ceil((WINDOW_MS - (Date.now() - entry.first)) / 60000),
  )
}

export function recordFailure(key: string): void {
  const now = Date.now()
  prune(now)
  const entry = live(key, now)
  if (entry) entry.count += 1
  else attempts.set(key, { count: 1, first: now })
}

export function clearFailures(key: string): void {
  attempts.delete(key)
}
