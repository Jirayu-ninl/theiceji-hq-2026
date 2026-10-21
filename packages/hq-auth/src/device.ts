/**
 * A readable name for a stored user-agent — "Chrome on Windows" — so a
 * session or push device can be recognised at a glance. Deliberately small:
 * the order of the checks matters (Edge and Opera also say "Chrome", every
 * Chromium says "Safari"), and anything unrecognised says so.
 */

export type DeviceKind = 'desktop' | 'mobile' | 'tablet' | 'unknown'
export type Device = { label: string; kind: DeviceKind }

const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
]

const SYSTEMS: readonly [RegExp, string][] = [
  [/\biPad\b/, 'iPadOS'],
  [/\b(?:iPhone|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
]

const pick = (ua: string, table: readonly [RegExp, string][]) =>
  table.find(([pattern]) => pattern.test(ua))?.[1] ?? null

export function describeDevice(userAgent: string | null | undefined): Device {
  const ua = userAgent?.trim() ?? ''
  if (!ua) return { label: 'Unknown device', kind: 'unknown' }

  const browser = pick(ua, BROWSERS)
  const system = pick(ua, SYSTEMS)
  const kind: DeviceKind =
    system === 'iPadOS' || (system === 'Android' && !/\bMobile\b/.test(ua))
      ? 'tablet'
      : system === 'iOS' || system === 'Android' || /\bMobile\b/.test(ua)
        ? 'mobile'
        : system
          ? 'desktop'
          : 'unknown'

  const label =
    browser && system
      ? `${browser} on ${system}`
      : (browser ?? system ?? 'Unknown device')
  return { label, kind }
}
