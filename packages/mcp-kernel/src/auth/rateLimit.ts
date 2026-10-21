/**
 * A fixed-window counter per key, in process memory.
 *
 * It runs BEFORE the token lookup, so a flood of junk bearers costs a map
 * entry each rather than a database query. Per replica by construction: with
 * two replicas the budget doubles, which is accepted for a personal server.
 */

export type RateDecision =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number }

export type RateLimiter = {
  /** Counts one event against the key and says whether it was within budget. */
  take: (key: string, now?: number) => RateDecision
  /** Whether the key still has budget, without spending any. */
  check: (key: string, now?: number) => RateDecision
}

export function createRateLimiter(options: {
  limit: number
  windowMs: number
}): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>()

  const prune = (now: number) => {
    if (windows.size < 5_000) return
    for (const [key, entry] of windows) {
      if (now - entry.start >= options.windowMs) windows.delete(key)
    }
  }

  const refusal = (start: number, now: number): RateDecision => ({
    ok: false,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((start + options.windowMs - now) / 1000),
    ),
  })

  return {
    check(key, now = Date.now()) {
      const entry = windows.get(key)
      if (!entry || now - entry.start >= options.windowMs) return { ok: true }
      return entry.count < options.limit
        ? { ok: true }
        : refusal(entry.start, now)
    },
    take(key, now = Date.now()) {
      prune(now)
      const entry = windows.get(key)
      if (!entry || now - entry.start >= options.windowMs) {
        windows.set(key, { start: now, count: 1 })
        return { ok: true }
      }
      entry.count += 1
      if (entry.count <= options.limit) return { ok: true }
      return refusal(entry.start, now)
    },
  }
}
