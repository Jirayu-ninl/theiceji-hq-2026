import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { OpsError } from './errors'

/**
 * Sealing for credentials HQ must be able to use again — the Google refresh
 * token, provider keys, and the secret a runtime's deliveries are signed
 * with. AES-256-GCM under `HQ_SEALING_KEY` (32 random bytes, base64), which
 * lives in the deployment's environment and never in the database or its
 * backups: a leaked dump holds ciphertext only.
 *
 * `CREATOR_SEALING_KEY` is read when `HQ_SEALING_KEY` isn't set: it is the same key under its first name, so production keeps one
 * secret and every value sealed before the rename still opens.
 *
 * Sealed values are `v1.<iv>.<tag>.<ciphertext>`, base64url. Nothing here is
 * ever returned by a tool or written to a log.
 */

const VERSION = 'v1'

function sealingKey(): Buffer {
  const raw = (
    process.env.HQ_SEALING_KEY ?? process.env.CREATOR_SEALING_KEY
  )?.trim()
  if (!raw)
    throw new OpsError(
      'capability_unavailable',
      'Credential storage isn’t configured: set HQ_SEALING_KEY (32 random bytes, base64) on the server.',
    )
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32)
    throw new OpsError(
      'capability_unavailable',
      'HQ_SEALING_KEY must decode to exactly 32 bytes.',
    )
  return key
}

export function isSealingConfigured(): boolean {
  try {
    sealingKey()
    return true
  } catch {
    return false
  }
}

export function seal(plaintext: string): string {
  const key = sealingKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.')
}

export function unseal(sealed: string): string {
  const [version, iv, tag, body] = sealed.split('.')
  if (version !== VERSION || !iv || !tag || body === undefined)
    throw new Error('Unrecognised sealed value.')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    sealingKey(),
    Buffer.from(iv, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/** The last four characters — enough to recognise a credential, useless to replay. */
export const secretHint = (value: string): string =>
  value.length <= 8 ? '••••' : `••••${value.slice(-4)}`

/** A fresh signing secret for event delivery, in the Standard Webhooks `whsec_` form. */
export const mintSigningSecret = (): string =>
  `whsec_${randomBytes(32).toString('base64')}`

/** The HMAC key a `whsec_` secret stands for: the base64-decoded bytes after the prefix. */
function signingKey(secret: string): Buffer {
  return Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
}

export type SignedMessage = { id: string; timestamp: number; body: string }

/**
 * Standard Webhooks (https://www.standardwebhooks.com): HMAC-SHA256, keyed
 * with the decoded secret, over `<id>.<timestamp>.<body>`, base64-encoded. A
 * runtime can verify it with any off-the-shelf Standard Webhooks library; the
 * header carries it as `v1,<signature>`.
 */
export function signPayload(secret: string, message: SignedMessage): string {
  return createHmac('sha256', signingKey(secret))
    .update(`${message.id}.${message.timestamp}.${message.body}`)
    .digest('base64')
}

/**
 * Checks a `webhook-signature` header, which may list several space-separated
 * `v1,<signature>` entries (a sender rotating secrets); any one matching is
 * enough. Constant-time per candidate.
 */
export function verifySignature(
  secret: string,
  message: SignedMessage,
  header: string,
): boolean {
  const expected = Buffer.from(signPayload(secret, message))
  return header
    .split(' ')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('v1,'))
    .some((entry) => {
      const given = Buffer.from(entry.slice(3))
      return (
        expected.length === given.length && timingSafeEqual(expected, given)
      )
    })
}
