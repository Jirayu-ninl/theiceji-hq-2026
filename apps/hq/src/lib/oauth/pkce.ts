import { createHash } from 'node:crypto'
import { constantTimeEqual } from '@theiceji/hq-db/access'

/**
 * PKCE, S256 only (RFC 7636). `plain` would put the verifier on the wire in
 * the authorization request — exactly the interception PKCE exists to stop.
 */

/** 43–128 characters of `[A-Za-z0-9-._~]` — both verifier and challenge. */
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/

export const isPkceValue = (value: string): boolean => PKCE_VALUE.test(value)

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!isPkceValue(verifier)) return false
  const computed = createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url')
  return constantTimeEqual(computed, challenge)
}
