import {
  digitsOf,
  fromMinor,
  mulDivRound,
  parseAmount,
  toMinor,
} from '@theiceji/hq-core/money'
import type { QuoteTotalsSnapshot } from '@theiceji/hq-db/schema'

/**
 * A quote's figures, pure — no database, no clock, no floats.
 *
 * · **A line** is `qty × unit price`, rounded half-up to the currency's
 *   minor units (THB 2, JPY 0).
 * · **Subtotal** is the sum of the lines.
 * · **VAT** (ภาษีมูลค่าเพิ่ม) is `subtotal × vat %`; **WHT** (หัก ณ ที่จ่าย,
 *   withheld by the client on the service fee) is `subtotal × wht %` — both
 *   on the pre-VAT subtotal, each rounded half-up once.
 * · **Total due** (ยอดชำระสุทธิ) is `subtotal + VAT − WHT`.
 *
 * Every amount is a decimal string with exactly the currency's digits; the
 * arithmetic runs on bigint minor units through `@theiceji/hq-core/money`, so
 * a board lane, Home's money strip and a quote all round the same way.
 */

/** Quantities are stored with three decimals (`numeric(12,3)`). */
export const QTY_DIGITS = 3
/** Percentages are stored with two decimals (`numeric(5,2)`). */
const PCT_DIGITS = 2
/** Unit prices are stored with two decimals (`numeric(14,2)`). */
export const PRICE_DIGITS = 2

/** VAT and withholding tax, as the owner switches them on. */
export const VAT_PCT = '7'
export const WHT_PCT = '3'

export type QuoteTotals = QuoteTotalsSnapshot

export type LineFigures = { qty: string; unitPrice: string }

/** `qty × unitPrice`, half-up to the currency's minor units. */
export function lineAmount(
  qty: string,
  unitPrice: string,
  currency: string,
): string {
  const digits = digitsOf(currency)
  return fromMinor(
    mulDivRound(
      toMinor(qty, QTY_DIGITS),
      toMinor(unitPrice, digits),
      QTY_DIGITS,
    ),
    digits,
  )
}

/** `amount × pct / 100`, half-up to the currency's minor units. */
function percentOf(amountMinor: bigint, pct: string): bigint {
  return mulDivRound(amountMinor, toMinor(pct, PCT_DIGITS), PCT_DIGITS + 2)
}

/**
 * Every figure of a quote: each line's amount (in order), and the totals in
 * the shape a sent quote freezes as `totals_snapshot`.
 */
export function quoteTotals(input: {
  currency: string
  vatPct: string
  whtPct: string
  lines: readonly LineFigures[]
}): { lines: string[]; totals: QuoteTotals } {
  const digits = digitsOf(input.currency)
  const amounts = input.lines.map((line) =>
    lineAmount(line.qty, line.unitPrice, input.currency),
  )
  const subtotal = amounts.reduce(
    (sum, amount) => sum + toMinor(amount, digits),
    0n,
  )
  const vat = percentOf(subtotal, input.vatPct)
  const wht = percentOf(subtotal, input.whtPct)
  return {
    lines: amounts,
    totals: {
      currency: input.currency,
      vatPct: formatPct(input.vatPct),
      whtPct: formatPct(input.whtPct),
      subtotal: fromMinor(subtotal, digits),
      vat: fromMinor(vat, digits),
      wht: fromMinor(wht, digits),
      total: fromMinor(subtotal + vat - wht, digits),
    },
  }
}

/** `"7.00"` → `"7"`, `"3.50"` → `"3.5"` — a percentage as printed. */
export function formatPct(pct: string): string {
  const text = fromMinor(toMinor(pct, PCT_DIGITS), PCT_DIGITS)
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/**
 * A quantity as typed (`2`, `"1,5"` is not one, `"0.333"`) → its stored form,
 * or an error in words. More than zero, at most three decimals and nine
 * whole digits.
 */
export function parseQty(
  raw: string | number,
): { ok: string } | { error: string } {
  const text = String(raw).replace(/[,\s]/g, '')
  const m = /^(\d{1,9})(?:\.(\d+))?$/.exec(text)
  if (!m) return { error: 'Enter a quantity such as 1, 2.5 or 0.333.' }
  const fraction = (m[2] ?? '').replace(/0+$/, '')
  if (fraction.length > QTY_DIGITS)
    return { error: 'A quantity can have at most 3 decimal places.' }
  const whole = m[1]?.replace(/^0+(?=\d)/, '') ?? '0'
  const qty = fraction ? `${whole}.${fraction}` : whole
  if (toMinor(qty, QTY_DIGITS) <= 0n)
    return { error: 'A quantity must be more than zero.' }
  return { ok: qty }
}

/**
 * A unit price in a currency → its stored form, or an error in words: no
 * more decimals than the currency has (JPY none), and never more than the
 * two the column keeps.
 */
export function parseUnitPrice(
  raw: string | number,
  currency: string,
): { ok: string } | { error: string } {
  const parsed = parseAmount(raw, currency)
  if ('error' in parsed) return parsed
  const [whole = '0', fraction = ''] = parsed.ok.split('.')
  if (whole.length > 12) return { error: 'That price is too large.' }
  if (fraction.replace(/0+$/, '').length > PRICE_DIGITS)
    return {
      error: `A unit price can have at most ${PRICE_DIGITS} decimal places.`,
    }
  return { ok: parsed.ok }
}

/* ── The amount in Thai words (บาทถ้วน) ──────────────────────────────── */

const DIGIT_WORDS = [
  'ศูนย์',
  'หนึ่ง',
  'สอง',
  'สาม',
  'สี่',
  'ห้า',
  'หก',
  'เจ็ด',
  'แปด',
  'เก้า',
]
const PLACE_WORDS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน']

/**
 * Up to six digits (no leading zeros). A one in the units place reads เอ็ด
 * whenever any higher place — here or in a higher million — is not zero;
 * a one in the tens place is just สิบ, a two is ยี่สิบ.
 */
function readGroup(digits: string, higher: boolean): string {
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    const digit = Number(digits[i])
    const place = digits.length - 1 - i
    if (digit === 0) continue
    if (place === 1) {
      out +=
        digit === 1 ? 'สิบ' : digit === 2 ? 'ยี่สิบ' : `${DIGIT_WORDS[digit]}สิบ`
    } else if (place === 0 && digit === 1 && (higher || digits.length > 1)) {
      out += 'เอ็ด'
    } else {
      out += `${DIGIT_WORDS[digit]}${PLACE_WORDS[place]}`
    }
  }
  return out
}

/** A whole number in words, ล้าน by ล้าน; empty for zero. */
function readInteger(raw: string): string {
  const digits = raw.replace(/^0+/, '')
  if (!digits) return ''
  if (digits.length <= 6) return readGroup(digits, false)
  const low = digits.slice(-6).replace(/^0+/, '')
  return `${readInteger(digits.slice(0, -6))}ล้าน${low ? readGroup(low, true) : ''}`
}

/**
 * The amount in Thai words, as a THB quote prints it under the total:
 * `36000.00` → `สามหมื่นหกพันบาทถ้วน`, `1234.50` →
 * `หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์`, `0.25` → `ยี่สิบห้าสตางค์`.
 * Satang past two places round half-up.
 */
export function bahtText(amount: string): string {
  const minor = toMinor(amount.replace(/[,\s]/g, ''), 2)
  const negative = minor < 0n
  const absolute = negative ? -minor : minor
  const baht = (absolute / 100n).toString()
  const satang = (absolute % 100n).toString()
  const sign = negative ? 'ลบ' : ''
  if (absolute === 0n) return 'ศูนย์บาทถ้วน'
  const bahtWords = baht === '0' ? '' : `${readInteger(baht)}บาท`
  if (satang === '0') return `${sign}${bahtWords}ถ้วน`
  return `${sign}${bahtWords}${readInteger(satang)}สตางค์`
}
