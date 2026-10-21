import {
  addDays,
  isValidTimeZone,
  localToInstant,
  toLocalInput,
  zonedDay,
} from '@theiceji/hq-ops/time'

/**
 * Five-field cron (`minute hour day-of-month month day-of-week`), read in a
 * routine's own timezone — "every day at 09:00" means 09:00 where the owner
 * is, whatever the server's clock says. Supports `*`, lists, ranges, steps
 * (`*\/15`, `1-5/2`) and names (`mon`, `jan`). When both day fields are
 * restricted a day matches either, as in every cron.
 *
 * Pure: no database, no clock of its own — the caller passes "after".
 */

export type Cron = {
  minutes: number[]
  hours: number[]
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** Both day fields restricted → a day matches either. */
  either: boolean
  domAny: boolean
  dowAny: boolean
  source: string
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export class CronError extends Error {}

function value(raw: string, names: string[] | null, offset: number): number {
  const lower = raw.toLowerCase()
  if (names) {
    const index = names.indexOf(lower)
    if (index >= 0) return index + offset
  }
  if (!/^\d+$/.test(raw)) throw new CronError(`“${raw}” isn’t a number.`)
  return Number(raw)
}

function field(
  raw: string,
  min: number,
  max: number,
  label: string,
  names: string[] | null = null,
  nameOffset = 0,
): { values: number[]; any: boolean } {
  const out = new Set<number>()
  const any = raw === '*' || raw === '?'
  for (const part of raw.split(',')) {
    const [range = '', stepRaw] = part.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1)
      throw new CronError(`The step in “${part}” (${label}) must be 1 or more.`)
    let lo: number
    let hi: number
    if (range === '*' || range === '?') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-')
      lo = value(a, names, nameOffset)
      hi = value(b, names, nameOffset)
    } else {
      lo = value(range, names, nameOffset)
      hi = stepRaw === undefined ? lo : max
    }
    if (lo < min || hi > max || lo > hi)
      throw new CronError(`“${part}” is outside ${label} ${min}–${max}.`)
    for (let n = lo; n <= hi; n += step) out.add(n)
  }
  return { values: [...out].sort((a, b) => a - b), any }
}

/** Parses a five-field cron, or throws `CronError` with a sentence. */
export function parseCron(source: string): Cron {
  const parts = source.trim().split(/\s+/)
  if (parts.length !== 5)
    throw new CronError(
      'A schedule is five fields: minute hour day-of-month month day-of-week (e.g. 0 9 * * *).',
    )
  const [mi = '', ho = '', dm = '', mo = '', dw = ''] = parts
  const minutes = field(mi, 0, 59, 'minute')
  const hours = field(ho, 0, 23, 'hour')
  const dom = field(dm, 1, 31, 'day of month')
  const month = field(mo, 1, 12, 'month', MONTHS, 1)
  const dow = field(dw, 0, 7, 'day of week', WEEKDAYS, 0)
  const weekdays = new Set(dow.values.map((day) => (day === 7 ? 0 : day)))
  return {
    minutes: minutes.values,
    hours: hours.values,
    days: new Set(dom.values),
    months: new Set(month.values),
    weekdays,
    either: !dom.any && !dow.any,
    domAny: dom.any,
    dowAny: dow.any,
    source: parts.join(' '),
  }
}

export function isCron(source: string): boolean {
  try {
    parseCron(source)
    return true
  } catch {
    return false
  }
}

function dayMatches(cron: Cron, day: string): boolean {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  if (!cron.months.has(m)) return false
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  const byDom = cron.days.has(d)
  const byDow = cron.weekdays.has(weekday)
  if (cron.either) return byDom || byDow
  return (cron.domAny || byDom) && (cron.dowAny || byDow)
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The first time strictly after `after` that the schedule fires, in
 * `timeZone`. Wall-clock times that don't exist (a DST gap) are skipped.
 * Looks five years ahead — `0 0 30 2 *` never fires and returns null.
 */
export function nextRun(
  cron: Cron | string,
  timeZone: string,
  after: Date,
): Date | null {
  const schedule = typeof cron === 'string' ? parseCron(cron) : cron
  if (!isValidTimeZone(timeZone))
    throw new CronError(`“${timeZone}” isn’t a timezone.`)
  const start = zonedDay(after, timeZone)
  const startLocal = toLocalInput(after, timeZone)
  for (let offset = 0; offset < 366 * 5; offset += 1) {
    const day = addDays(start, offset)
    if (!dayMatches(schedule, day)) continue
    for (const hour of schedule.hours)
      for (const minute of schedule.minutes) {
        const local = `${day}T${pad(hour)}:${pad(minute)}`
        if (offset === 0 && local < startLocal) continue
        const at = localToInstant(local, timeZone)
        if (at && at.getTime() > after.getTime()) return at
      }
  }
  return null
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/**
 * The schedule in words for a list row: "daily 09:00", "Mon–Fri 09:00",
 * "every 15 min", "monthly on the 1st 08:30". Anything unusual reads as its
 * cron.
 */
export function describeCron(source: string): string {
  let cron: Cron
  try {
    cron = parseCron(source)
  } catch {
    return source
  }
  const [mi = '', ho = '', dm = '', mo = '', dw = ''] = cron.source.split(' ')
  const everyMonth = mo === '*'
  const step = /^\*\/(\d+)$/
  if (dm === '*' && dw === '*' && everyMonth) {
    if (step.test(mi) && ho === '*') return `every ${mi.slice(2)} min`
    if (mi === '*' && ho === '*') return 'every minute'
    if (/^\d+$/.test(mi) && ho === '*') return `hourly at :${pad(Number(mi))}`
    if (/^\d+$/.test(mi) && step.test(ho))
      return `every ${ho.slice(2)} h at :${pad(Number(mi))}`
  }
  const single = /^\d+$/.test(mi) && /^\d+$/.test(ho)
  if (!single || !everyMonth) return cron.source
  const time = `${pad(Number(ho))}:${pad(Number(mi))}`
  if (dm === '*' && dw === '*') return `daily ${time}`
  if (dm === '*') {
    const days = [...cron.weekdays].sort((a, b) => a - b)
    if (days.join() === '1,2,3,4,5') return `Mon–Fri ${time}`
    if (days.join() === '0,6') return `weekends ${time}`
    return `${days.map((day) => DAY_NAMES[day]).join(' · ')} ${time}`
  }
  if (dw === '*' && /^\d+$/.test(dm))
    return `monthly on the ${ordinal(Number(dm))} ${time}`
  return cron.source
}
