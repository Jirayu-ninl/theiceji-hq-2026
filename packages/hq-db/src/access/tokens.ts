import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Credential minting and hashing.
 *
 * Everything HQ issues is 256 bits of randomness behind a readable prefix, and
 * everything it stores is a SHA-256 of that string. Not a JWT: a signed token
 * is valid because it verifies, so revoking a connection would leave its
 * tokens working until they expired. A table lookup is the revocation check.
 *
 * The prefixes are not decoration — secret scanners recognise them, a log line
 * says what leaked, and the MCP server refuses a malformed bearer before it
 * costs a query.
 */

export const TOKEN_PREFIX = {
  accessToken: 'hq_at_',
  refreshToken: 'hq_rt_',
  personalToken: 'hq_pat_',
  authorizationCode: 'hq_ac_',
  clientSecret: 'hq_cs_',
  clientId: 'hqc_',
} as const

export type TokenPrefixKind = keyof typeof TOKEN_PREFIX

/** An opaque credential: prefix + 32 random bytes, base64url. */
export function mintToken(kind: TokenPrefixKind): string {
  const bytes = kind === 'clientId' ? 16 : 32
  return `${TOKEN_PREFIX[kind]}${randomBytes(bytes).toString('base64url')}`
}

/** Lowercase hex SHA-256 — the primary key of every stored credential. */
export function hashToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Compare without leaking the first differing byte through timing. Length
 * leaks unavoidably, which is why callers compare fixed-length digests.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** 256 bits in base64url is 43 characters. */
const SECRET_LENGTH = 43

/** Could this string be a bearer HQ issued — an access or personal token? */
export function looksLikeBearer(token: string): boolean {
  return (
    (token.startsWith(TOKEN_PREFIX.accessToken) &&
      token.length === TOKEN_PREFIX.accessToken.length + SECRET_LENGTH) ||
    (token.startsWith(TOKEN_PREFIX.personalToken) &&
      token.length === TOKEN_PREFIX.personalToken.length + SECRET_LENGTH)
  )
}

/** The last four characters — enough to recognise a token, useless to replay. */
export const tokenHint = (token: string): string => token.slice(-4)

/** An hour: short enough that a leaked access token ages out on its own. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000
/** Rolling — every refresh issues a successor with a fresh window. */
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** OAuth 2.1 wants codes short-lived; five minutes covers a slow consent. */
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000
