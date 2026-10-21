import { expect, test } from 'bun:test'
import { jobDue } from '../src/due'

test('a job is due by its nearest date ahead, the card’s or a follow-up’s', () => {
  const today = '2026-09-27'
  expect(jobDue(null, [], today)).toEqual({
    day: null,
    state: null,
    from: null,
  })
  expect(jobDue('2026-09-25', ['2026-09-30', '2026-09-28'], today)).toEqual({
    day: '2026-09-28',
    state: 'ahead',
    from: 'followup',
  })
  expect(jobDue('2026-09-27', ['2026-09-30'], today).state).toBe('today')
  expect(jobDue('2026-09-20', ['2026-09-26', null], today)).toEqual({
    day: '2026-09-26',
    state: 'late',
    from: 'followup',
  })
  expect(jobDue('2026-10-01', [], today)).toEqual({
    day: '2026-10-01',
    state: 'ahead',
    from: 'card',
  })
})
