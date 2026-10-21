import { currencyDigits } from '@theiceji/hq-ops/values'

/**
 * Money for every module: amounts travel as
 * decimal strings (`"36000.00"`, what a Postgres `numeric` reads back as) and
 * any arithmetic runs on integers — minor units as `bigint` — never on
 * floats. A board lane's sum, a quote's VAT and a Home money strip all come
 * out of the same few functions, so they round the same way.
 */

const AMOUNT = /^(\d{1,13})(?:\.(\d+))?$/

/** How many minor units a currency has (THB 2, JPY 0); 2 for an unknown code. */
export const digitsOf = (currency: string): number => currencyDigits(currency)

/**
 * `"45,000.5"` or `45000.5` → `{ ok: "45000.50" }` in THB. Commas and spaces
 * are ignored; more decimals than the currency has is an error in words.
 */
export function parseAmount(
  raw: string | number,
  currency: string,
): { ok: string } | { error: string } {
  const text = String(raw).replace(/[,\s]/g, '')
  const m = AMOUNT.exec(text)
  if (!m) return { error: 'Enter an amount such as 45000 or 45,000.50.' }
  const digits = digitsOf(currency)
  const fraction = m[2] ?? ''
  if (fraction.replace(/0+$/, '').length > digits)
    return {
      error:
        digits === 0
          ? `${currency} has no minor units.`
          : `${currency} allows ${digits} decimal places.`,
    }
  const whole = m[1]?.replace(/^0+(?=\d)/, '') ?? '0'
  return {
    ok:
      digits > 0
        ? `${whole}.${fraction.slice(0, digits).padEnd(digits, '0')}`
        : whole,
  }
}

/** A decimal string → integer minor units at `digits` places (half-up past them). */
export function toMinor(amount: string, digits: number): bigint {
  const negative = amount.startsWith('-')
  const m = AMOUNT.exec(negative ? amount.slice(1) : amount)
  if (!m) throw new Error(`Not an amount: ${amount}`)
  const fraction = m[2] ?? ''
  let minor = BigInt(`${m[1]}${fraction.slice(0, digits).padEnd(digits, '0')}`)
  // Round half-up on the first dropped digit.
  if (fraction.length > digits && Number(fraction[digits]) >= 5) minor += 1n
  return negative ? -minor : minor
}

/** Integer minor units → a decimal string with exactly `digits` places. */
export function fromMinor(minor: bigint, digits: number): string {
  const negative = minor < 0n
  const text = (negative ? -minor : minor).toString().padStart(digits + 1, '0')
  const whole = text.slice(0, text.length - digits) || '0'
  const fraction = digits > 0 ? `.${text.slice(-digits)}` : ''
  return `${negative ? '-' : ''}${whole}${fraction}`
}

/** The sum of decimal strings in one currency, as a decimal string. */
export function sumAmounts(
  amounts: readonly string[],
  currency: string,
): string {
  const digits = digitsOf(currency)
  return fromMinor(
    amounts.reduce((total, amount) => total + toMinor(amount, digits), 0n),
    digits,
  )
}

/**
 * `a × b / 10^scale`, rounded half-up, for integers — the one rounding rule
 * every multiplication (qty × price, subtotal × VAT %) goes through.
 */
export function mulDivRound(a: bigint, b: bigint, scale: number): bigint {
  const divisor = 10n ** BigInt(scale)
  const product = a * b
  const negative = product < 0n
  const absolute = negative ? -product : product
  const rounded = (absolute + divisor / 2n) / divisor
  return negative ? -rounded : rounded
}

/**
 * `36000.00` THB → `฿36,000` or `฿36,000.50`, and `1200` USD → `$1,200`:
 * grouped, the currency's symbol, trailing `.00` dropped. For a readout that
 * must show every digit, pass `{ exact: true }`.
 */
export function formatMoney(
  amount: string,
  currency: string,
  options: { exact?: boolean; symbol?: boolean } = {},
): string {
  const digits = digitsOf(currency)
  const minor = toMinor(amount, digits)
  const text = fromMinor(minor, digits)
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const keepFraction = options.exact || /[1-9]/.test(fraction)
  const body = `${grouped}${keepFraction && fraction ? `.${fraction}` : ''}`
  const sign = minor < 0n ? '−' : ''
  if (options.symbol === false) return `${sign}${body}`
  const symbol = currencySymbol(currency)
  return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${currency}`
}

const SYMBOLS: Record<string, string> = {
  THB: '฿',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
}

export const currencySymbol = (currency: string): string | null =>
  SYMBOLS[currency] ?? null
