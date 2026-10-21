import { describe, expect, test } from 'bun:test'
import {
  breakUnits,
  englishDate,
  quotePdfName,
  renderQuotePdf,
  thaiDate,
} from '../src/pdf'
import { quoteTotals } from '../src/totals'

/** The PDF, without a database: it renders, embeds the Thai font, and wraps Thai at word boundaries. */

describe('line breaks', () => {
  test('Thai runs break between words; nothing is added or lost', () => {
    const text = 'ออกแบบเว็บไซต์และระบบจัดการเนื้อหา'
    const units = breakUnits(text)
    expect(units.length).toBeGreaterThan(3)
    expect(units.join('')).toBe(text)
    expect(units[0]).toBe('ออกแบบ')
  })

  test('spaces stay with the word before them; punctuation stays attached', () => {
    const text = 'Brand deck (Phase 2) สำหรับ บริษัท กิ่งแก้ว'
    const units = breakUnits(text)
    expect(units.join('')).toBe(text)
    expect(units).toContain('(Phase ')
    expect(units).toContain('2) ')
    expect(units.every((unit) => !/^\s/u.test(unit))).toBe(true)
  })
})

test('dates print in both calendars', () => {
  expect(thaiDate('2026-09-26')).toBe('26 ก.ย. 2569')
  expect(englishDate('2026-01-05')).toBe('5 Jan 2026')
  expect(quotePdfName('Q-2026-014')).toBe('Q-2026-014.pdf')
})

test('a quote renders as a PDF with IBM Plex Sans Thai embedded', async () => {
  const lines = [
    {
      description:
        'ออกแบบอัตลักษณ์แบรนด์และระบบภาพสำหรับแคมเปญเปิดตัวผลิตภัณฑ์ใหม่ ประกอบด้วยโลโก้ ชุดสี และแนวทางการใช้งาน',
      qty: '1.000',
      unit: 'งาน',
      unitPrice: '36000.00',
    },
  ]
  const figures = quoteTotals({
    currency: 'THB',
    vatPct: '7',
    whtPct: '3',
    lines,
  })
  const bytes = await renderQuotePdf({
    number: 'Q-2026-001',
    title: 'ออกแบบแบรนด์',
    draft: true,
    issuedOn: '2026-09-26',
    validUntil: '2026-10-26',
    currency: 'THB',
    issuer: null,
    client: { name: 'บริษัท กิ่งแก้ว ปั่นป่วน จำกัด' },
    lines: lines.map((line, i) => ({
      ...line,
      amount: figures.lines[i] ?? '',
    })),
    totals: figures.totals,
    notes: '',
  })
  const text = new TextDecoder('latin1').decode(bytes)
  expect(text.startsWith('%PDF-')).toBe(true)
  expect(text).toContain('/FontFile2')
  expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+IBMPlexSansThai-Regular/)
  expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+IBMPlexSansThai-SemiBold/)
  expect(text).not.toContain('/Helvetica')
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
})
