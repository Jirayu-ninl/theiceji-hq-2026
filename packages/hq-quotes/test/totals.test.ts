import { describe, expect, test } from 'bun:test'
import {
  bahtText,
  formatPct,
  lineAmount,
  parseQty,
  parseUnitPrice,
  quoteTotals,
} from '../src/totals'

/** Pure figures: every VAT/WHT combination, rounding edges, currencies, words. */

const one = (unitPrice: string, qty = '1') => [{ qty, unitPrice }]

describe('quote totals', () => {
  const combos = [
    {
      vat: '0',
      wht: '0',
      expect: { vat: '0.00', wht: '0.00', total: '36000.00' },
    },
    {
      vat: '7',
      wht: '0',
      expect: { vat: '2520.00', wht: '0.00', total: '38520.00' },
    },
    {
      vat: '0',
      wht: '3',
      expect: { vat: '0.00', wht: '1080.00', total: '34920.00' },
    },
    {
      vat: '7',
      wht: '3',
      expect: { vat: '2520.00', wht: '1080.00', total: '37440.00' },
    },
  ]
  for (const combo of combos) {
    test(`VAT ${combo.vat} % · WHT ${combo.wht} %`, () => {
      const { totals } = quoteTotals({
        currency: 'THB',
        vatPct: combo.vat,
        whtPct: combo.wht,
        lines: [
          { qty: '1', unitPrice: '30000.00' },
          { qty: '2', unitPrice: '3000.00' },
        ],
      })
      expect(totals).toEqual({
        currency: 'THB',
        vatPct: combo.vat,
        whtPct: combo.wht,
        subtotal: '36000.00',
        ...combo.expect,
      })
    })
  }

  test('percentages as stored (numeric(5,2)) print short', () => {
    const { totals } = quoteTotals({
      currency: 'THB',
      vatPct: '7.00',
      whtPct: '3.00',
      lines: one('1000.00'),
    })
    expect(totals.vatPct).toBe('7')
    expect(totals.whtPct).toBe('3')
    expect(formatPct('3.50')).toBe('3.5')
    expect(formatPct('0.00')).toBe('0')
  })

  test('a line rounds half-up to the currency, once', () => {
    expect(lineAmount('0.333', '100.00', 'THB')).toBe('33.30')
    expect(lineAmount('0.333', '100.01', 'THB')).toBe('33.30') // 33.30333
    expect(lineAmount('0.335', '1.00', 'THB')).toBe('0.34') // 0.335 → up
    expect(lineAmount('0.334', '1.00', 'THB')).toBe('0.33')
    expect(lineAmount('1.5', '0.01', 'THB')).toBe('0.02') // 0.015 → up
    expect(lineAmount('3', '0.10', 'THB')).toBe('0.30') // never 0.30000000000000004
    expect(lineAmount('999999999.999', '999999999999.99', 'THB')).toBe(
      '999999999998990000000.00',
    )
  })

  test('the subtotal sums rounded lines; VAT and WHT round on the subtotal', () => {
    const { lines, totals } = quoteTotals({
      currency: 'THB',
      vatPct: '7',
      whtPct: '3',
      lines: [
        { qty: '0.333', unitPrice: '100.00' },
        { qty: '0.333', unitPrice: '100.00' },
        { qty: '0.333', unitPrice: '100.00' },
      ],
    })
    expect(lines).toEqual(['33.30', '33.30', '33.30'])
    expect(totals.subtotal).toBe('99.90')
    expect(totals.vat).toBe('6.99') // 6.993
    expect(totals.wht).toBe('3.00') // 2.997
    expect(totals.total).toBe('103.89')
  })

  test('tax half-up edges', () => {
    const at = (price: string) =>
      quoteTotals({
        currency: 'THB',
        vatPct: '7',
        whtPct: '3',
        lines: one(price),
      }).totals
    expect(at('0.07').vat).toBe('0.00') // 0.0049
    expect(at('0.08').vat).toBe('0.01') // 0.0056
    expect(at('100.50').wht).toBe('3.02') // 3.015
    expect(at('0.50').wht).toBe('0.02') // 0.015
    expect(at('0.00').total).toBe('0.00')
  })

  test('no lines is all zeros', () => {
    const { lines, totals } = quoteTotals({
      currency: 'THB',
      vatPct: '7',
      whtPct: '3',
      lines: [],
    })
    expect(lines).toEqual([])
    expect([totals.subtotal, totals.vat, totals.wht, totals.total]).toEqual([
      '0.00',
      '0.00',
      '0.00',
      '0.00',
    ])
  })

  test('currencies keep their own digits', () => {
    const yen = quoteTotals({
      currency: 'JPY',
      vatPct: '7',
      whtPct: '3',
      lines: [{ qty: '1.5', unitPrice: '101' }],
    })
    expect(yen.lines).toEqual(['152']) // 151.5 → 152
    expect(yen.totals).toMatchObject({
      subtotal: '152',
      vat: '11',
      wht: '5',
      total: '158',
    })
    const usd = quoteTotals({
      currency: 'USD',
      vatPct: '0',
      whtPct: '0',
      lines: [{ qty: '2', unitPrice: '1250.50' }],
    })
    expect(usd.totals.total).toBe('2501.00')
    const dinar = quoteTotals({
      currency: 'KWD',
      vatPct: '0',
      whtPct: '0',
      lines: [{ qty: '1.001', unitPrice: '1.25' }],
    })
    expect(dinar.totals.total).toBe('1.251') // 1.25125 at three digits
  })
})

describe('inputs', () => {
  test('quantities', () => {
    expect(parseQty('1')).toEqual({ ok: '1' })
    expect(parseQty(2.5)).toEqual({ ok: '2.5' })
    expect(parseQty('0.3330')).toEqual({ ok: '0.333' })
    expect(parseQty('007')).toEqual({ ok: '7' })
    expect(parseQty('0')).toEqual({
      error: 'A quantity must be more than zero.',
    })
    expect(parseQty('0.0004')).toEqual({
      error: 'A quantity can have at most 3 decimal places.',
    })
    expect('error' in parseQty('-1')).toBe(true)
    expect('error' in parseQty('1e3')).toBe(true)
    expect('error' in parseQty('1234567890')).toBe(true)
  })

  test('unit prices follow the currency and the column', () => {
    expect(parseUnitPrice('36,000', 'THB')).toEqual({ ok: '36000.00' })
    expect(parseUnitPrice(0.1, 'THB')).toEqual({ ok: '0.10' })
    expect(parseUnitPrice('100.00', 'JPY')).toEqual({ ok: '100' })
    expect(parseUnitPrice('100.5', 'JPY')).toEqual({
      error: 'JPY has no minor units.',
    })
    expect(parseUnitPrice('1.234', 'KWD')).toEqual({
      error: 'A unit price can have at most 2 decimal places.',
    })
    expect(parseUnitPrice('1.235', 'THB')).toEqual({
      error: 'THB allows 2 decimal places.',
    })
    expect('error' in parseUnitPrice('1234567890123', 'THB')).toBe(true)
  })
})

describe('bahtText', () => {
  const cases: [string, string][] = [
    ['36000.00', 'สามหมื่นหกพันบาทถ้วน'],
    ['1234.50', 'หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์'],
    ['0', 'ศูนย์บาทถ้วน'],
    ['0.25', 'ยี่สิบห้าสตางค์'],
    ['0.01', 'หนึ่งสตางค์'],
    ['1', 'หนึ่งบาทถ้วน'],
    ['10', 'สิบบาทถ้วน'],
    ['11', 'สิบเอ็ดบาทถ้วน'],
    ['20', 'ยี่สิบบาทถ้วน'],
    ['21', 'ยี่สิบเอ็ดบาทถ้วน'],
    ['101', 'หนึ่งร้อยเอ็ดบาทถ้วน'],
    ['111', 'หนึ่งร้อยสิบเอ็ดบาทถ้วน'],
    ['120', 'หนึ่งร้อยยี่สิบบาทถ้วน'],
    ['1001', 'หนึ่งพันเอ็ดบาทถ้วน'],
    ['37440.00', 'สามหมื่นเจ็ดพันสี่ร้อยสี่สิบบาทถ้วน'],
    ['100000', 'หนึ่งแสนบาทถ้วน'],
    ['1000000', 'หนึ่งล้านบาทถ้วน'],
    ['1000001', 'หนึ่งล้านเอ็ดบาทถ้วน'],
    ['2500000.01', 'สองล้านห้าแสนบาทหนึ่งสตางค์'],
    ['11000000', 'สิบเอ็ดล้านบาทถ้วน'],
    ['21000021.21', 'ยี่สิบเอ็ดล้านยี่สิบเอ็ดบาทยี่สิบเอ็ดสตางค์'],
    ['101000000', 'หนึ่งร้อยเอ็ดล้านบาทถ้วน'],
    ['1000000000000', 'หนึ่งล้านล้านบาทถ้วน'],
    ['1,234,567.89', 'หนึ่งล้านสองแสนสามหมื่นสี่พันห้าร้อยหกสิบเจ็ดบาทแปดสิบเก้าสตางค์'],
    ['12.345', 'สิบสองบาทสามสิบห้าสตางค์'],
    ['99.995', 'หนึ่งร้อยบาทถ้วน'],
    ['-5', 'ลบห้าบาทถ้วน'],
  ]
  for (const [amount, words] of cases) {
    test(`${amount} → ${words}`, () => {
      expect(bahtText(amount)).toBe(words)
    })
  }
})
