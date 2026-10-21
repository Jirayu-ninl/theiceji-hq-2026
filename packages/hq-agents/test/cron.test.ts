import { describe, expect, test } from 'bun:test'
import { CronError, describeCron, nextRun, parseCron } from '../src/cron'

const at = (iso: string) => new Date(iso)

describe('cron', () => {
  test('daily 09:00 in Bangkok is 02:00 UTC', () => {
    expect(
      nextRun('0 9 * * *', 'Asia/Bangkok', at('2026-09-26T01:00:00Z')),
    ).toEqual(at('2026-09-26T02:00:00Z'))
    // Strictly after: at 09:00 exactly, the next one is tomorrow.
    expect(
      nextRun('0 9 * * *', 'Asia/Bangkok', at('2026-09-26T02:00:00Z')),
    ).toEqual(at('2026-09-27T02:00:00Z'))
  })

  test('steps, ranges, lists and names', () => {
    expect(nextRun('*/15 * * * *', 'UTC', at('2026-09-26T10:07:30Z'))).toEqual(
      at('2026-09-26T10:15:00Z'),
    )
    // Sat 26 Sep 2026 → the next weekday is Monday 28.
    expect(
      nextRun('30 8 * * mon-fri', 'UTC', at('2026-09-26T09:00:00Z')),
    ).toEqual(at('2026-09-28T08:30:00Z'))
    expect(
      nextRun('0 0 1 jan,jul *', 'UTC', at('2026-09-26T00:00:00Z')),
    ).toEqual(at('2027-01-01T00:00:00Z'))
    // Sunday is 0 and 7.
    expect(nextRun('0 12 * * 7', 'UTC', at('2026-09-26T00:00:00Z'))).toEqual(
      at('2026-09-27T12:00:00Z'),
    )
  })

  test('day-of-month or day-of-week when both are set', () => {
    // The 1st, or any Monday — whichever comes first after Sat 26 Sep.
    expect(nextRun('0 6 1 * 1', 'UTC', at('2026-09-26T00:00:00Z'))).toEqual(
      at('2026-09-28T06:00:00Z'),
    )
  })

  test('a schedule that never fires', () => {
    expect(nextRun('0 0 30 2 *', 'UTC', at('2026-01-01T00:00:00Z'))).toBeNull()
  })

  test('DST: a wall time that does not exist is skipped', () => {
    // New York springs forward 2027-03-14 02:00 → 03:00.
    expect(
      nextRun('30 2 * * *', 'America/New_York', at('2027-03-13T12:00:00Z')),
    ).toEqual(at('2027-03-15T06:30:00Z'))
  })

  test('bad schedules explain themselves', () => {
    expect(() => parseCron('0 9 * *')).toThrow(CronError)
    expect(() => parseCron('61 9 * * *')).toThrow('outside minute')
    expect(() => parseCron('*/0 * * * *')).toThrow('step')
  })

  test('schedules in words', () => {
    expect(describeCron('0 9 * * *')).toBe('daily 09:00')
    expect(describeCron('30 8 * * 1-5')).toBe('Mon–Fri 08:30')
    expect(describeCron('*/15 * * * *')).toBe('every 15 min')
    expect(describeCron('5 * * * *')).toBe('hourly at :05')
    expect(describeCron('0 10 1 * *')).toBe('monthly on the 1st 10:00')
    expect(describeCron('0 18 * * sat,sun')).toBe('weekends 18:00')
    expect(describeCron('0 9 * 1 *')).toBe('0 9 * 1 *')
  })
})
