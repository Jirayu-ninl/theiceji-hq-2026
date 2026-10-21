/**
 * Preflight for HQ's R2 storage.
 *
 *   bun run r2:check
 *
 * Proves the whole path in one pass: env is complete, the credentials sign,
 * the bucket answers, and an object survives put → head → get → presigned GET
 * → presigned PUT → delete. Then the things that otherwise only fail later, in
 * a browser: whether a presigned PUT really pins its type and size, whether
 * R2_PUBLIC_URL serves the bucket, and whether CORS lets HQ's origin upload.
 *
 * Writes two probe objects under `.hq-check/` and deletes them again.
 */
import { storageConfig, storageReadiness } from '@theiceji/hq-storage/config'
import {
  deleteObject,
  getObject,
  headObject,
  listObjects,
  presignDownload,
  presignUpload,
  publicUrl,
  putObject,
  StorageError,
} from '@theiceji/hq-storage/r2'

const HINTS: Record<string, string> = {
  InvalidAccessKeyId: 'R2_ACCESS_KEY_ID is wrong, or its token was deleted.',
  SignatureDoesNotMatch:
    'R2_SECRET_ACCESS_KEY does not belong to R2_ACCESS_KEY_ID.',
  NoSuchBucket:
    'No bucket by that name — check R2_BUCKET, and R2_ENDPOINT for an EU or FedRAMP bucket.',
  AccessDenied:
    'The token may not do this — give it Object Read & Write on this bucket.',
  Unauthorized:
    'Credentials rejected — check R2_ACCOUNT_ID and the token key pair.',
}

function explain(error: unknown): string {
  if (error instanceof StorageError) {
    const hint = error.code ? HINTS[error.code] : undefined
    return hint ? `${error.message}\n          → ${hint}` : error.message
  }
  const cause = (error as { cause?: { code?: string } }).cause?.code
  return `${(error as Error).message}${cause ? ` (${cause})` : ''}`
}

let failed = false

async function step(
  label: string,
  run: () => Promise<string | undefined>,
  { required = true } = {},
): Promise<boolean> {
  try {
    const note = await run()
    console.log(`  ok      ${label}${note ? `  ${note}` : ''}`)
    return true
  } catch (error) {
    if (required) failed = true
    console.log(`  ${required ? 'FAILED' : 'WARN  '}  ${label}`)
    console.log(`          ${explain(error)}`)
    return false
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

/** Reads the body only on failure, so a passing response stays unread. */
async function expectOk(res: Response): Promise<void> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
}

const readiness = storageReadiness()
const config = storageConfig()
if (!readiness.ok || !config) {
  const missing = readiness.ok ? [] : readiness.missing
  console.error(
    `R2 is not configured — unset or invalid: ${missing.join(', ')}.\nSee apps/hq/.env.example.`,
  )
  process.exit(1)
}

console.log(`endpoint  ${config.endpoint}`)
console.log(`bucket    ${config.bucket}`)
console.log(`key id    ${config.accessKeyId.slice(0, 6)}…`)
console.log(
  `public    ${config.publicUrl ?? '(unset — private bucket, presigned reads only)'}`,
)
console.log('')

const reachable = await step('list bucket', async () => {
  const page = await listObjects({ limit: 1 })
  return page.objects.length === 0 ? 'empty' : undefined
})
if (!reachable) process.exit(1)

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const probe = `.hq-check/${stamp} probe+1.txt`
const direct = `.hq-check/${stamp}-presigned.txt`
const text = `hq r2 check ${stamp} — ตรวจ`
const bytes = new TextEncoder().encode(text)

try {
  await step('put', async () => {
    const put = await putObject(probe, text, {
      contentType: 'text/plain; charset=utf-8',
      metadata: { source: 'r2-check' },
    })
    return `etag ${put.etag}`
  })

  await step('head', async () => {
    const info = await headObject(probe)
    expect(info !== null, 'object not found after put')
    expect(info?.size === bytes.length, `size ${info?.size} ≠ ${bytes.length}`)
    expect(info?.metadata.source === 'r2-check', 'metadata did not round-trip')
    return `${info?.size} bytes, ${info?.contentType}`
  })

  await step('get', async () => {
    const res = await getObject(probe)
    expect((await res?.text()) === text, 'body differs from what was put')
    return undefined
  })

  await step('presigned GET', async () => {
    const url = await presignDownload(probe, { filename: 'รายงาน (v2).txt' })
    const res = await fetch(url)
    await expectOk(res)
    expect((await res.text()) === text, 'body differs from what was put')
    const disposition = res.headers.get('Content-Disposition') ?? ''
    expect(disposition.startsWith('attachment'), 'filename was not applied')
    return undefined
  })

  await step('presigned PUT', async () => {
    const upload = await presignUpload(direct, {
      contentType: 'text/plain',
      size: bytes.length,
    })
    const res = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: bytes,
    })
    await expectOk(res)
    const info = await headObject(direct)
    expect(info?.size === bytes.length, 'uploaded object has the wrong size')
    return undefined
  })

  await step(
    'presigned PUT refuses another type or size',
    async () => {
      const upload = await presignUpload(direct, {
        contentType: 'text/plain',
        size: bytes.length,
      })
      const wrongType = await fetch(upload.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/html' },
        body: bytes,
      })
      const wrongSize = await fetch(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: new Uint8Array(bytes.length + 64),
      })
      expect(!wrongType.ok, 'a different Content-Type was accepted')
      expect(!wrongSize.ok, 'a different size was accepted')
      return `${wrongType.status} / ${wrongSize.status}`
    },
    { required: false },
  )

  if (config.publicUrl) {
    await step('public URL serves the bucket', async () => {
      const res = await fetch(publicUrl(probe) as string)
      expect(res.ok, `${res.status} from ${config.publicUrl}`)
      expect((await res.text()) === text, 'public body differs')
      return undefined
    })
  }

  const origins = [
    ...new Set(
      [process.env.OAUTH_ISSUER?.trim(), 'http://localhost:8990'].filter(
        (origin): origin is string => Boolean(origin),
      ),
    ),
  ]
  const upload = await presignUpload(direct, { contentType: 'image/png' })
  for (const origin of origins) {
    await step(
      `CORS lets ${origin} upload`,
      async () => {
        const res = await fetch(upload.url, {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'PUT',
            'Access-Control-Request-Headers': 'content-type',
          },
        })
        const allowed = res.headers.get('Access-Control-Allow-Origin')
        expect(
          res.ok && (allowed === origin || allowed === '*'),
          `preflight ${res.status}, allow-origin ${allowed ?? 'none'} — browser uploads stay blocked until the bucket has a CORS rule (DEPLOY.md)`,
        )
        return undefined
      },
      { required: false },
    )
  }
} finally {
  await step('delete probes', async () => {
    await deleteObject(probe)
    await deleteObject(direct)
    expect((await headObject(probe)) === null, 'probe still exists')
    expect((await headObject(direct)) === null, 'presigned probe still exists')
    return undefined
  })
}

console.log('')
console.log(failed ? 'R2 check failed.' : 'R2 is ready.')
process.exit(failed ? 1 : 0)
