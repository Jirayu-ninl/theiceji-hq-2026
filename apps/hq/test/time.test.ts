import { describe, expect, test } from 'bun:test'
import {
  drawnSpan,
  isoWeek,
  laneHeight,
  MIN_LANE,
  mondayOf,
  onWeek,
  packLane,
  parseWeek,
  placeOn,
  stateWord,
  type TimelineItem,
  weekKey,
  weekOf,
  weekRangeWords,
} from '../src/components/home/time/model'

/** Home · Time's pure helpers: week keys, the ruler, packing. */

const item = (
  id: string,
  kind: TimelineItem['kind'],
  from: number,
  to?: number,
): TimelineItem => ({
  id,
  module: 'board',
  kind,
  start: '2026-09-21',
  from,
  to,
  state: 'plan',
  label: id,
  when: '',
  href: '/',
  facts: [],
})

describe('weeks', () => {
  test('ISO week numbers and keys', () => {
    expect(isoWeek('2026-09-21')).toEqual({ year: 2026, week: 39 })
    expect(isoWeek('2026-09-27')).toEqual({ year: 2026, week: 39 })
    expect(weekKey('2026-09-24')).toBe('2026-W39')
    // 1 Jan 2027 is a Friday: it belongs to 2026's last week.
    expect(weekKey('2027-01-01')).toBe('2026-W53')
    expect(weekKey('2026-01-01')).toBe('2026-W01')
    expect(weekKey('2024-12-30')).toBe('2025-W01')
  })

  test('the Monday of a day', () => {
    expect(mondayOf('2026-09-27')).toBe('2026-09-21')
    expect(mondayOf('2026-09-21')).toBe('2026-09-21')
    expect(mondayOf('2026-10-01')).toBe('2026-09-28')
  })

  test('?week= takes an ISO week or any day, and nothing else', () => {
    expect(parseWeek('2026-W39')).toBe('2026-09-21')
    expect(parseWeek('2026-w39')).toBe('2026-09-21')
    expect(parseWeek('2026-W1')).toBe('2025-12-29')
    expect(parseWeek('2026-W53')).toBe('2026-12-28')
    expect(parseWeek('2025-W53')).toBeNull()
    expect(parseWeek('2026-09-24')).toBe('2026-09-21')
    expect(parseWeek('2026-02-30')).toBeNull()
    expect(parseWeek('next')).toBeNull()
    expect(parseWeek('')).toBeNull()
    expect(parseWeek(undefined)).toBeNull()
    expect(parseWeek('1999-W10')).toBeNull()
    // Round trip.
    for (const day of ['2026-01-05', '2026-06-15', '2027-01-04'])
      expect(parseWeek(weekKey(day))).toBe(mondayOf(day))
  })

  test('the range in words, across a month too', () => {
    expect(weekRangeWords('2026-09-21')).toBe('Mon 21 – Sun 27 Sep')
    expect(weekRangeWords('2026-09-28')).toBe('Mon 28 Sep – Sun 4 Oct')
    const week = weekOf('2026-09-21', '2026-09-27')
    expect(week.label).toBe('W39')
    expect(week.prev).toBe('2026-W38')
    expect(week.next).toBe('2026-W40')
    expect(week.current).toBe(true)
    expect(week.days.map((day) => day.dow)).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ])
    expect(weekOf('2026-09-28', '2026-09-27').current).toBe(false)
  })
})

describe('the ruler', () => {
  const day = 86_400_000
  const monday = Date.UTC(2026, 8, 20, 17) // Mon 21 Sep 00:00 in Bangkok
  const bounds = Array.from({ length: 8 }, (_, i) => monday + i * day)

  test('an instant is days from Monday 00:00', () => {
    expect(placeOn(monday, bounds)).toBe(0)
    expect(placeOn(monday + day * 2.5, bounds)).toBeCloseTo(2.5)
    expect(placeOn(monday + day * 7, bounds)).toBe(7)
    expect(placeOn(monday - day / 2, bounds)).toBeCloseTo(-0.5)
    expect(placeOn(monday + day * 8, bounds)).toBeCloseTo(8)
  })

  test('a 23-hour day still spans one column', () => {
    const dst = [...bounds]
    for (let i = 3; i < dst.length; i++) dst[i] = (dst[i] as number) - 3_600_000
    // Halfway through the short day (Wed) is 11.5 hours in.
    expect(placeOn((dst[2] as number) + 11.5 * 3_600_000, dst)).toBeCloseTo(2.5)
  })

  test('items off the week are dropped; spans clamp to it', () => {
    expect(onWeek(item('a', 'block', -2, -0.5))).toBe(false)
    expect(onWeek(item('a', 'block', -2, 1))).toBe(true)
    expect(onWeek(item('a', 'mark', 7.2))).toBe(false)
    expect(onWeek(item('a', 'mark', 6.9))).toBe(true)
    expect(drawnSpan(item('a', 'block', -2, 9))).toEqual({ from: 0, to: 7 })
    expect(drawnSpan(item('a', 'mark', 3))).toEqual({ from: 3, to: 3 })
  })
})

describe('packing a lane', () => {
  test('overlapping blocks split into rows; others share one', () => {
    const packed = packLane([
      item('a', 'block', 0.4, 2.6),
      item('b', 'block', 1.8, 2.6),
      item('c', 'block', 3.4, 4.5),
      item('d', 'block', 2.6, 3),
    ])
    expect(packed.rows.get('a')).toBe(0)
    expect(packed.rows.get('b')).toBe(1)
    expect(packed.rows.get('d')).toBe(0)
    expect(packed.rows.get('c')).toBe(0)
    expect(packed.count).toBe(2)
    expect(packed.height).toBe(laneHeight(2))
  })

  test('a mark drops a row only when a block covers it', () => {
    const packed = packLane([
      item('block', 'block', 1, 3),
      item('inside', 'mark', 2),
      item('after', 'mark', 4),
    ])
    expect(packed.rows.get('inside')).toBe(1)
    expect(packed.rows.get('after')).toBe(0)
  })

  test('an empty lane keeps its minimum height', () => {
    expect(packLane([]).count).toBe(0)
    expect(packLane([]).height).toBe(MIN_LANE)
    expect(laneHeight(1)).toBe(MIN_LANE)
  })
})

describe('words', () => {
  test('a state is always a word', () => {
    expect(stateWord({ state: 'done', kind: 'tick' })).toBe('ran')
    expect(stateWord({ state: 'doing', kind: 'block', progress: 40 })).toBe(
      'in progress · 40%',
    )
    expect(stateWord({ state: 'doing', kind: 'block' })).toBe('in progress')
    expect(stateWord({ state: 'wait', kind: 'block' })).toBe('waiting for you')
    expect(stateWord({ state: 'due', kind: 'mark', word: 'overdue' })).toBe(
      'overdue',
    )
  })
})
