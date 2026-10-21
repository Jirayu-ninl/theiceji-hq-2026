/**
 * Small pure helpers the kernel services share: how a value is written into
 * an audit event, and money in minor units. Ported from Creator's rules.ts —
 * only the parts that are about the kernel, not about content.
 */

/* ── Audit values ───────────────────────────────────────────────────── */

const MAX_AUDIT_TEXT = 400

/** Dates as ISO strings, long text cut short: an audit row is a record, not a copy. */
function auditValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && value.length > MAX_AUDIT_TEXT)
    return `${value.slice(0, MAX_AUDIT_TEXT)}… (${value.length} chars)`
  return value ?? null
}

/** `{ field: { from, to } }` for the fields that actually changed. */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of Object.keys(after)) {
    const from = auditValue(before[key])
    const to = auditValue(after[key])
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to }
  }
  return changes
}

/** A value for an audit event describing a newly created record. */
export function auditSnapshot(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    out[key] = auditValue(value)
  }
  return out
}

/* ── Money ──────────────────────────────────────────────────────────── */

export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    )
  } catch {
    return 2
  }
}

/** `"45,000.50"` in THB → `4500050`. Exact string arithmetic; never floats. */
export function toMinorUnits(
  raw: string,
  currency: string,
): { minor: number | null; error: string | null } {
  const text = raw.replace(/[,\s]/g, '')
  const digits = currencyDigits(currency)
  const m = /^(\d{1,13})(?:\.(\d+))?$/.exec(text)
  if (!m)
    return { minor: null, error: 'Enter an amount such as 45000 or 45,000.50.' }
  const fraction = m[2] ?? ''
  if (fraction.length > digits)
    return {
      minor: null,
      error:
        digits === 0
          ? `${currency} has no minor units.`
          : `${currency} allows ${digits} decimal places.`,
    }
  const minor = BigInt(`${m[1]}${fraction.padEnd(digits, '0')}`)
  if (minor > BigInt(Number.MAX_SAFE_INTEGER))
    return { minor: null, error: 'That amount is too large.' }
  return { minor: Number(minor), error: null }
}

/** `4500050` THB → `"45,000.50"`, without a currency symbol. */
export function formatMinorUnits(minor: number, currency: string): string {
  const digits = currencyDigits(currency)
  const negative = minor < 0
  const text = String(Math.abs(minor)).padStart(digits + 1, '0')
  const whole = text.slice(0, text.length - digits) || '0'
  const fraction = digits > 0 ? text.slice(-digits) : ''
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`
}
