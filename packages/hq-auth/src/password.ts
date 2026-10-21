import {
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

/**
 * Password hashing on `node:crypto` alone — no native module, nothing to
 * rebuild per platform, nothing to keep patched.
 *
 * Digests are self-describing: `scrypt$N$r$p$salt$hash`, both tails base64url.
 * Because the cost parameters travel with the digest, raising them later only
 * affects newly written passwords; existing ones keep verifying.
 *
 * N=16384, r=16, p=1 costs ~64 MB and ~100 ms per attempt — the same working
 * set Lucia settled on, and well past what a login form needs.
 */

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

const N = 16384
const R = 16
const P = 1
const KEYLEN = 64
const SALT_BYTES = 16
/** Node caps scrypt memory at 32 MB by default; 128·N·r needs 64 MB here. */
const MAXMEM = 128 * N * R * 2

/** NFKC so the same typed password matches across keyboards and platforms. */
const normalize = (password: string) => password.normalize('NFKC')

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const derived = await scrypt(normalize(password), salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  })
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

export async function verifyPassword(
  password: string,
  digest: string,
): Promise<boolean> {
  const [scheme, nRaw, rRaw, pRaw, saltRaw, hashRaw] = digest.split('$')
  if (scheme !== 'scrypt' || !nRaw || !rRaw || !pRaw || !saltRaw || !hashRaw) {
    return false
  }

  const n = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)
  if (!(n > 0 && r > 0 && p > 0)) return false

  const salt = Buffer.from(saltRaw, 'base64url')
  const expected = Buffer.from(hashRaw, 'base64url')
  if (salt.length === 0 || expected.length === 0) return false

  try {
    const actual = await scrypt(normalize(password), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: Math.max(MAXMEM, 128 * n * r * 2),
    })
    return timingSafeEqual(actual, expected)
  } catch {
    // Absurd stored parameters (a corrupted row) blow past maxmem — a failed
    // verification, not a crash.
    return false
  }
}

/**
 * A digest of a throwaway password, so a login attempt for an address that
 * doesn't exist still burns one scrypt round. Without it, response time alone
 * tells an attacker which emails are real.
 */
let dummy: Promise<string> | null = null
export function dummyDigest(): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString('base64url'))
  return dummy
}
