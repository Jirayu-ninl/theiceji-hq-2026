/**
 * A job's due day: the nearest due still ahead among the card
 * and its follow-ups — so a card whose own task is done isn't "late" while a
 * follow-up still has a date — and "late" only once every date has passed.
 * Pure (no database), for the page and for tests; `boardSummaries` counts the
 * same rule in SQL. Days are `YYYY-MM-DD` in the project's own calendar.
 */
export type JobDue = {
  /** The day that counts, or null when nothing has a date. */
  day: string | null
  state: 'today' | 'ahead' | 'late' | null
  /** Whether that day is the card's own or a follow-up's. */
  from: 'card' | 'followup' | null
}

export function jobDue(
  cardDue: string | null,
  followupDues: readonly (string | null)[],
  today: string,
): JobDue {
  const dues = [
    ...(cardDue ? [{ day: cardDue, from: 'card' as const }] : []),
    ...followupDues
      .filter((day): day is string => Boolean(day))
      .map((day) => ({ day, from: 'followup' as const })),
  ]
  if (dues.length === 0) return { day: null, state: null, from: null }
  const ahead = dues
    .filter((due) => due.day >= today)
    .sort((a, b) => a.day.localeCompare(b.day))[0]
  if (ahead)
    return {
      day: ahead.day,
      state: ahead.day === today ? 'today' : 'ahead',
      from: ahead.from,
    }
  const last = dues.sort((a, b) => b.day.localeCompare(a.day))[0] as {
    day: string
    from: 'card' | 'followup'
  }
  return { day: last.day, state: 'late', from: last.from }
}
