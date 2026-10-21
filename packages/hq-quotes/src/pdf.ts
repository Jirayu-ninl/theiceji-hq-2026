import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatMoney } from '@theiceji/hq-core/money'
import type { QuoteIssuer } from '@theiceji/hq-db/schema'
import PDFDocument from 'pdfkit'
import { bahtText, type QuoteTotals } from './totals'

/**
 * The quote as a PDF: A4, bilingual Thai /
 * English, calm and monochrome, figures right-aligned in the font's tabular
 * digits. Rendered on the server with PDFKit and IBM Plex Sans Thai (OFL,
 * vendored in `fonts/`), embedded so Thai marks stack and never float.
 *
 * **Line breaks in Thai.** Thai writes no spaces between words, and PDFKit's
 * wrapper only breaks at spaces — so it would split a long Thai run anywhere,
 * even between a consonant and its tone mark. Text is wrapped here instead:
 * at spaces, and between two Thai words found by `Intl.Segmenter('th')`. No
 * break character is inserted — a zero-width space draws nothing in this
 * font, but PDFKit maps it to the space glyph, so the PDF's text layer (copy,
 * search) would gain spaces between every Thai word.
 *
 * Every string is drawn at a position computed here, with `lineBreak: false`,
 * so PDFKit never re-wraps or adds a page on its own.
 */

/* ── Fonts ──────────────────────────────────────────────────────────── */

export type QuoteFonts = {
  regular: Uint8Array
  medium: Uint8Array
  semibold: Uint8Array
}

let configured: QuoteFonts | null = null

/**
 * Hand the renderer its fonts as bytes — for a bundle that can't read the
 * package's `fonts/` folder at runtime. Null goes back to reading the files.
 */
export function configureQuoteFonts(fonts: QuoteFonts | null): void {
  configured = fonts
}

const FONT_FILES = {
  regular: 'IBMPlexSansThai-Regular.ttf',
  medium: 'IBMPlexSansThai-Medium.ttf',
  semibold: 'IBMPlexSansThai-SemiBold.ttf',
} as const

/**
 * Where the vendored `fonts/` folder is. Beside this file when the package
 * runs as source (bun: the MCP server, the tests); when a bundler rewrote
 * `import.meta.url` (Next), from the working directory — the app's folder in
 * the monorepo, where the build traces `packages/hq-quotes/fonts` in.
 */
function fontDir(): string {
  const candidates: string[] = []
  // Not `new URL('../fonts/', import.meta.url)`: bundlers read that shape as
  // an asset import and warn on every build when the folder isn't one.
  const here = String(import.meta.url)
  if (here.startsWith('file:'))
    candidates.push(join(dirname(fileURLToPath(here)), '..', 'fonts'))
  const cwd = process.cwd()
  candidates.push(
    join(cwd, '..', '..', 'packages', 'hq-quotes', 'fonts'),
    join(cwd, 'packages', 'hq-quotes', 'fonts'),
    join(cwd, 'node_modules', '@theiceji', 'hq-quotes', 'fonts'),
  )
  const found = candidates.find((dir) =>
    existsSync(join(dir, FONT_FILES.regular)),
  )
  if (!found)
    throw new Error(
      `The quote fonts weren't found (looked in ${candidates.join(', ')}). Call configureQuoteFonts() with their bytes.`,
    )
  return found
}

/** The vendored IBM Plex Sans Thai, read once on first use. */
export function quoteFonts(): QuoteFonts {
  if (!configured) {
    const dir = fontDir()
    configured = {
      regular: readFileSync(join(dir, FONT_FILES.regular)),
      medium: readFileSync(join(dir, FONT_FILES.medium)),
      semibold: readFileSync(join(dir, FONT_FILES.semibold)),
    }
  }
  return configured
}

/* ── Input ──────────────────────────────────────────────────────────── */

export type QuotePdfParty = {
  name: string
  taxId?: string | null
  address?: string | null
  email?: string | null
  phone?: string | null
}

export type QuotePdfLine = {
  description: string
  /** As stored: `"1.000"`, `"0.333"`. */
  qty: string
  unit: string
  unitPrice: string
  amount: string
}

export type QuotePdfInput = {
  number: string
  title: string
  /** A preview of an unsent draft: marked so it can't pass for the real one. */
  draft: boolean
  /** `YYYY-MM-DD`. */
  issuedOn: string
  validUntil: string
  currency: string
  /** Null prints a clear "Issuer not set" — only a preview can have none. */
  issuer: QuoteIssuer | null
  client: QuotePdfParty | null
  lines: readonly QuotePdfLine[]
  totals: QuoteTotals
  notes: string
}

/** The file name a quote's PDF is stored and downloaded under. */
export const quotePdfName = (number: string) => `${number}.pdf`

/* ── Wrapping ───────────────────────────────────────────────────────── */

const THAI = /\p{Script=Thai}/u
const SPACE_END = /\s$/u
const SPACE_START = /^\s/u
const words = new Intl.Segmenter('th', { granularity: 'word' })
const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' })

/**
 * Where a line may break: after a run of spaces, and between two Thai
 * words. Each unit keeps its trailing spaces; nothing is added or removed,
 * so the units always join back into the text.
 */
export function breakUnits(text: string): string[] {
  const units: string[] = []
  let current = ''
  for (const { segment } of words.segment(text)) {
    const before = current.at(-1) ?? ''
    const after = segment[0] ?? ''
    const breakHere =
      current !== '' &&
      ((SPACE_END.test(current) && !SPACE_START.test(segment)) ||
        (THAI.test(before) && THAI.test(after)))
    if (breakHere) {
      units.push(current)
      current = ''
    }
    current += segment
  }
  if (current) units.push(current)
  return units
}

/* ── Drawing ────────────────────────────────────────────────────────── */

type Doc = PDFKit.PDFDocument
type Weight = 'regular' | 'medium' | 'semibold'
type Style = { weight: Weight; size: number; color: string }
type Align = 'left' | 'right'

const INK = '#161616'
const MUTED = '#5c5c5c'
const FAINT = '#8a8a8a'
const RULE = '#cfcfcf'
const HAIRLINE = '#e4e4e4'

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN = 56
const LEFT = MARGIN
const RIGHT = PAGE_WIDTH - MARGIN
const TOP = MARGIN
const BOTTOM = PAGE_HEIGHT - 70
const FOOTER = PAGE_HEIGHT - 34
/** IBM Plex Sans Thai's ascender, in ems: PDFKit places text by its top. */
const ASCENT = 1.116

const s = (weight: Weight, size: number, color = INK): Style => ({
  weight,
  size,
  color,
})

const STYLE = {
  title: s('semibold', 20),
  titleEn: s('regular', 10, MUTED),
  name: s('semibold', 12),
  party: s('medium', 10.5),
  body: s('regular', 9),
  small: s('regular', 8.5, MUTED),
  labelTh: s('medium', 7.5, MUTED),
  labelEn: s('regular', 7, FAINT),
  headTh: s('medium', 8),
  headEn: s('regular', 7, FAINT),
  value: s('regular', 9),
  totalLabel: s('semibold', 10.5),
  total: s('semibold', 13),
}

function pen(doc: Doc) {
  const use = (style: Style) =>
    doc.font(style.weight).fontSize(style.size).fillColor(style.color)
  const measure = (style: Style, text: string) => {
    use(style)
    return doc.widthOfString(text)
  }
  /** Draws one line with its baseline at `baseline`; `x` is the right edge when aligned right. */
  const put = (
    style: Style,
    text: string,
    x: number,
    baseline: number,
    align: Align = 'left',
  ) => {
    if (!text) return 0
    const width = measure(style, text)
    doc.text(
      text,
      align === 'right' ? x - width : x,
      baseline - ASCENT * style.size,
      { lineBreak: false },
    )
    return width
  }
  /** Lines that fit `width`, broken at spaces and between Thai words. */
  const wrap = (style: Style, text: string, width: number): string[] => {
    const out: string[] = []
    const fits = (candidate: string) =>
      measure(style, candidate.trimEnd()) <= width
    for (const paragraph of text.split(/\r?\n/)) {
      let line = ''
      for (const unit of breakUnits(paragraph)) {
        if (fits(line + unit)) {
          line += unit
          continue
        }
        if (line.trim()) out.push(line.trimEnd())
        line = ''
        if (fits(unit)) {
          line = unit
          continue
        }
        // Longer than a whole line: break between clusters, never inside one.
        for (const { segment } of graphemes.segment(unit)) {
          if (line && !fits(line + segment)) {
            out.push(line.trimEnd())
            line = ''
          }
          line += segment
        }
      }
      out.push(line.trimEnd())
    }
    return out
  }
  /** A Thai label with its English beside it, lighter: `เลขที่  No.` */
  const label = (
    th: string,
    en: string,
    x: number,
    baseline: number,
    align: Align = 'left',
    styles: [Style, Style] = [STYLE.labelTh, STYLE.labelEn],
  ) => {
    const gap = 4
    const width = measure(styles[0], th) + gap + measure(styles[1], en)
    const start = align === 'right' ? x - width : x
    const thWidth = put(styles[0], th, start, baseline)
    put(styles[1], en, start + thWidth + gap, baseline)
    return width
  }
  const rule = (
    y: number,
    x1: number,
    x2: number,
    color = RULE,
    width = 0.6,
  ) => {
    doc.moveTo(x1, y).lineTo(x2, y).lineWidth(width).strokeColor(color).stroke()
  }
  return { put, wrap, label, rule, measure }
}

/* ── Formatting ─────────────────────────────────────────────────────── */

const TH_MONTHS = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
]
const EN_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function dayParts(day: string): { d: number; m: number; y: number } {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number)
  return { d, m, y }
}

/** `2026-09-26` → `26 ก.ย. 2569` (Buddhist era). */
export function thaiDate(day: string): string {
  const { d, m, y } = dayParts(day)
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`
}

/** `2026-09-26` → `26 Sep 2026`. */
export function englishDate(day: string): string {
  const { d, m, y } = dayParts(day)
  return `${d} ${EN_MONTHS[m - 1]} ${y}`
}

/** `"1.000"` → `1`, `"1500.500"` → `1,500.5`. */
function qtyText(qty: string): string {
  const [whole = '0', fraction = ''] = qty.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return trimmed ? `${grouped}.${trimmed}` : grouped
}

/* ── The document ───────────────────────────────────────────────────── */

/**
 * The quote as PDF bytes. Pure apart from reading the fonts: the caller
 * passes the dates, totals and issuer it wants printed (a draft preview uses
 * today's date; a sent quote its own).
 */
export async function renderQuotePdf(
  input: QuotePdfInput,
  options: { fonts?: QuoteFonts } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const fonts = options.fonts ?? quoteFonts()
  return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: TOP, bottom: 20, left: LEFT, right: MARGIN },
      bufferPages: true,
      // The first font is ours, so PDFKit never loads its Helvetica metrics
      // from disk (a bundle often doesn't ship them).
      font: fonts.regular as unknown as string,
      lang: 'th-TH',
      displayTitle: true,
      info: {
        Title: `ใบเสนอราคา ${input.number} · Quotation`,
        Subject: input.title,
        Author: input.issuer?.name ?? '',
        Creator: 'TheIceJi HQ',
        Producer: 'TheIceJi HQ',
      },
    })
    const chunks: Uint8Array[] = []
    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => {
      const out = new Uint8Array(
        chunks.reduce((total, chunk) => total + chunk.length, 0),
      )
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      resolve(out)
    })
    doc.registerFont('regular', fonts.regular)
    doc.registerFont('medium', fonts.medium)
    doc.registerFont('semibold', fonts.semibold)
    draw(doc, input)
    doc.end()
  })
}

function draw(doc: Doc, input: QuotePdfInput): void {
  const p = pen(doc)
  const money = (amount: string) =>
    formatMoney(amount, input.currency, { exact: true, symbol: false })
  let y = TOP

  const newPage = () => {
    doc.addPage()
    y = TOP
  }
  const ensure = (height: number) => {
    if (y + height > BOTTOM) newPage()
  }

  /* Header: the issuer on the left, the document on the right. */
  const issuerWidth = 232
  let left = y + 14
  if (input.issuer) {
    const issuer = input.issuer
    for (const line of p.wrap(STYLE.name, issuer.name, issuerWidth)) {
      p.put(STYLE.name, line, LEFT, left)
      left += 17
    }
    left += 1
    for (const line of p.wrap(STYLE.small, issuer.address ?? '', issuerWidth)) {
      if (!line) continue
      p.put(STYLE.small, line, LEFT, left)
      left += 13
    }
    if (issuer.taxId) {
      const width = p.label('เลขประจำตัวผู้เสียภาษี', 'Tax ID', LEFT, left)
      p.put(STYLE.small, issuer.taxId, LEFT + width + 6, left)
      left += 13
    }
    const contact = [issuer.email, issuer.phone].filter(Boolean).join('  ·  ')
    if (contact) {
      p.put(STYLE.small, contact, LEFT, left)
      left += 13
    }
  } else {
    p.put(s('medium', 11, MUTED), 'Issuer not set · ยังไม่ได้ตั้งผู้ออก', LEFT, left)
    left += 15
    for (const line of p.wrap(
      s('regular', 8, FAINT),
      'Set your name, address, tax ID and bank details in HQ → Settings before sending. ตั้งชื่อ ที่อยู่ เลขผู้เสียภาษี และบัญชีรับเงินก่อนส่ง',
      issuerWidth,
    )) {
      p.put(s('regular', 8, FAINT), line, LEFT, left)
      left += 12
    }
  }

  let right = y + 16
  p.put(STYLE.title, 'ใบเสนอราคา', RIGHT, right, 'right')
  right += 16
  p.put(STYLE.titleEn, 'Quotation', RIGHT, right, 'right')
  if (input.draft) {
    right += 14
    p.label('ร่าง — ยังไม่ได้ส่ง', 'Draft · not sent', RIGHT, right, 'right', [
      s('medium', 8, MUTED),
      s('regular', 8, FAINT),
    ])
  }
  right += 22
  const metaLabel = RIGHT - 236
  const meta: [string, string, string, string | null][] = [
    ['เลขที่', 'No.', input.number, null],
    ['วันที่', 'Date', thaiDate(input.issuedOn), englishDate(input.issuedOn)],
    [
      'ยืนราคาถึง',
      'Valid until',
      thaiDate(input.validUntil),
      englishDate(input.validUntil),
    ],
  ]
  for (const [th, en, value, alt] of meta) {
    p.label(th, en, metaLabel, right)
    if (alt) {
      const altWidth = p.put(STYLE.labelEn, alt, RIGHT, right, 'right')
      p.put(STYLE.value, value, RIGHT - altWidth - 6, right, 'right')
    } else {
      p.put(s('medium', 9), value, RIGHT, right, 'right')
    }
    right += 15
  }

  y = Math.max(left, right) + 8
  p.rule(y, LEFT, RIGHT)
  y += 22

  /* The client, and what the quote is for. */
  const partyWidth = 250
  const subjectX = LEFT + 280
  let client = y
  p.label('ลูกค้า', 'Client', LEFT, client)
  client += 16
  if (input.client) {
    const c = input.client
    for (const line of p.wrap(STYLE.party, c.name, partyWidth)) {
      p.put(STYLE.party, line, LEFT, client)
      client += 15
    }
    for (const line of p.wrap(STYLE.small, c.address ?? '', partyWidth)) {
      if (!line) continue
      p.put(STYLE.small, line, LEFT, client)
      client += 13
    }
    if (c.taxId) {
      const width = p.label('เลขประจำตัวผู้เสียภาษี', 'Tax ID', LEFT, client)
      p.put(STYLE.small, c.taxId, LEFT + width + 6, client)
      client += 13
    }
    const contact = [c.email, c.phone].filter(Boolean).join('  ·  ')
    if (contact) {
      p.put(STYLE.small, contact, LEFT, client)
      client += 13
    }
  } else {
    p.put(
      s('medium', 10, FAINT),
      'Client not chosen · ยังไม่ได้เลือกลูกค้า',
      LEFT,
      client,
    )
    client += 15
  }
  let subject = y
  p.label('เรื่อง', 'Subject', subjectX, subject)
  subject += 16
  for (const line of p.wrap(STYLE.party, input.title, RIGHT - subjectX)) {
    p.put(STYLE.party, line, subjectX, subject)
    subject += 15
  }
  y = Math.max(client, subject) + 14

  /* The lines. */
  const amountRight = RIGHT
  const priceRight = RIGHT - 92
  const unitX = RIGHT - 214
  const qtyRight = RIGHT - 224
  const descX = LEFT + 22
  const descWidth = qtyRight - 40 - 12 - descX

  const tableHead = () => {
    const th = y + 9
    const en = y + 19
    const heads: [string, string, number, Align][] = [
      ['#', '', LEFT, 'left'],
      ['รายการ', 'Description', descX, 'left'],
      ['จำนวน', 'Qty', qtyRight, 'right'],
      ['หน่วย', 'Unit', unitX, 'left'],
      ['ราคาต่อหน่วย', 'Unit price', priceRight, 'right'],
      ['จำนวนเงิน', `Amount (${input.currency})`, amountRight, 'right'],
    ]
    for (const [thai, english, x, align] of heads) {
      p.put(STYLE.headTh, thai, x, th, align)
      p.put(STYLE.headEn, english, x, en, align)
    }
    y += 26
    p.rule(y, LEFT, RIGHT, INK, 0.8)
    y += 2
  }

  ensure(26 + 34)
  tableHead()
  const leading = 14
  input.lines.forEach((line, index) => {
    const rows = p.wrap(STYLE.body, line.description, descWidth)
    if (y + rows.length * leading + 10 > BOTTOM) {
      newPage()
      tableHead()
    }
    const first = y + 14
    p.put(s('regular', 8, FAINT), String(index + 1), LEFT, first)
    p.put(STYLE.value, qtyText(line.qty), qtyRight, first, 'right')
    p.put(STYLE.body, line.unit, unitX, first)
    p.put(STYLE.value, money(line.unitPrice), priceRight, first, 'right')
    p.put(STYLE.value, money(line.amount), amountRight, first, 'right')
    let baseline = first
    for (const row of rows) {
      // A description longer than a page continues on the next one.
      if (baseline + 5 > BOTTOM) {
        newPage()
        tableHead()
        baseline = y + 14
      }
      p.put(STYLE.body, row, descX, baseline)
      baseline += leading
    }
    y = baseline - leading + 10
    const last = index === input.lines.length - 1
    p.rule(y, LEFT, RIGHT, last ? INK : HAIRLINE, last ? 0.8 : 0.5)
  })
  if (input.lines.length === 0) {
    p.put(s('regular', 9, FAINT), 'No lines yet · ยังไม่มีรายการ', descX, y + 14)
    y += 24
    p.rule(y, LEFT, RIGHT, INK, 0.8)
  }
  y += 18

  /* Totals on the right; notes and payment beside them. */
  const t = input.totals
  const totalsLeft = RIGHT - 250
  const rows: [string, string, string][] = [
    ['รวม', 'Subtotal', money(t.subtotal)],
  ]
  if (Number(t.vatPct) !== 0)
    rows.push([`ภาษีมูลค่าเพิ่ม ${t.vatPct}%`, `VAT ${t.vatPct}%`, money(t.vat)])
  if (Number(t.whtPct) !== 0)
    rows.push([
      `หัก ณ ที่จ่าย ${t.whtPct}%`,
      `Withholding tax ${t.whtPct}%`,
      `−${money(t.wht)}`,
    ])
  const inWords =
    input.currency === 'THB'
      ? p.wrap(s('regular', 8.5, MUTED), `(${bahtText(t.total)})`, 250)
      : []
  const totalsHeight = rows.length * 18 + 34 + inWords.length * 14
  ensure(totalsHeight)
  const totalsPage = doc.bufferedPageRange().count
  let ty = y
  for (const [th, en, value] of rows) {
    ty += 12
    p.label(th, en, totalsLeft, ty, 'left', [
      s('medium', 8.5),
      s('regular', 8, FAINT),
    ])
    p.put(STYLE.value, value, RIGHT, ty, 'right')
    ty += 6
  }
  ty += 6
  p.rule(ty, totalsLeft, RIGHT, INK, 0.8)
  ty += 20
  p.label('ยอดชำระสุทธิ', 'Total due', totalsLeft, ty, 'left', [
    STYLE.totalLabel,
    s('regular', 9, MUTED),
  ])
  const totalWidth = p.put(STYLE.total, money(t.total), RIGHT, ty, 'right')
  p.put(
    s('regular', 9, MUTED),
    input.currency,
    RIGHT - totalWidth - 5,
    ty,
    'right',
  )
  for (const line of inWords) {
    ty += 14
    p.put(s('regular', 8.5, MUTED), line, RIGHT, ty, 'right')
  }
  ty += 8

  // Notes and payment details flow down the left column, onto a new page
  // if they must.
  const noteWidth = totalsLeft - 24 - LEFT
  let ny = y
  let notesPage = totalsPage
  const block = (th: string, en: string, text: string) => {
    if (!text.trim()) return
    if (ny + 30 > BOTTOM) {
      newPage()
      ny = y
      notesPage += 1
    }
    ny += 12
    p.label(th, en, LEFT, ny)
    ny += 3
    for (const line of p.wrap(STYLE.small, text, noteWidth)) {
      ny += 13
      if (ny + 4 > BOTTOM) {
        newPage()
        ny = y + 13
        notesPage += 1
      }
      p.put(STYLE.small, line, LEFT, ny)
    }
    ny += 10
  }
  block('หมายเหตุ', 'Notes', input.notes)
  block('การชำระเงิน', 'Payment', input.issuer?.bank ?? '')
  y = notesPage > totalsPage ? ny : Math.max(ty, ny)

  /* Signatures: the issuer's and the client's, at the foot of the last page. */
  const signHeight = 86
  if (y + 28 + signHeight > BOTTOM) newPage()
  const signTop = Math.max(y + 28, BOTTOM - signHeight)
  const signWidth = 190
  const signature = (
    x: number,
    th: string,
    en: string,
    name: string | null,
  ) => {
    const line = signTop + 40
    p.rule(line, x, x + signWidth, INK, 0.6)
    p.label(th, en, x, line + 14)
    if (name) {
      for (const [i, row] of p
        .wrap(STYLE.small, name, signWidth)
        .slice(0, 2)
        .entries())
        p.put(STYLE.small, row, x, line + 28 + i * 12)
    }
    p.label('วันที่', 'Date', x, line + 56)
    p.rule(line + 58, x + 44, x + signWidth, RULE, 0.5)
  }
  signature(LEFT, 'ผู้เสนอราคา', 'Quoted by', input.issuer?.name ?? null)
  signature(
    RIGHT - signWidth,
    'ผู้อนุมัติ',
    'Accepted by',
    input.client?.name ?? null,
  )

  /* Footer on every page. */
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    p.label('ใบเสนอราคา', input.number, LEFT, FOOTER, 'left', [
      s('regular', 7, FAINT),
      s('regular', 7, FAINT),
    ])
    p.label(
      `หน้า ${i + 1}/${range.count}`,
      `Page ${i + 1} of ${range.count}`,
      RIGHT,
      FOOTER,
      'right',
      [s('regular', 7, FAINT), s('regular', 7, FAINT)],
    )
  }
}
