import { describe, expect, test } from 'bun:test'
import { describeDevice } from '@theiceji/hq-auth/device'

describe('describeDevice', () => {
  test.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
      'Chrome on Windows',
      'desktop',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
      'Edge on Windows',
      'desktop',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
      'Safari on macOS',
      'desktop',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
      'mobile',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/139.0.0.0 Mobile/15E148 Safari/604.1',
      'Chrome on iOS',
      'mobile',
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
      'mobile',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Safari/537.36',
      'Samsung Internet on Android',
      'tablet',
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
      'Firefox on Linux',
      'desktop',
    ],
  ])('%s', (ua, label, kind) => {
    expect(describeDevice(ua)).toEqual({ label, kind })
  })

  test('says so when there is nothing to go on', () => {
    expect(describeDevice(null)).toEqual({
      label: 'Unknown device',
      kind: 'unknown',
    })
    expect(describeDevice('curl/8.9.1')).toEqual({
      label: 'Unknown device',
      kind: 'unknown',
    })
  })
})
