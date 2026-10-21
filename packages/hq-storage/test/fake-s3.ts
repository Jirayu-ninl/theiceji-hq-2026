/**
 * A stand-in for R2's S3 API on this machine — for tests and local previews,
 * never for anything real. Path-style (`/<bucket>/<key>`), PUT · GET · HEAD ·
 * DELETE and CORS for a browser upload; signatures are not checked, so any
 * key and any presigned URL work.
 *
 *   bun run packages/hq-storage/test/fake-s3.ts            # :9901
 *   R2_ENDPOINT=http://localhost:9901 R2_BUCKET=hq-local \
 *   R2_ACCESS_KEY_ID=local R2_SECRET_ACCESS_KEY=local …    # point HQ at it
 *
 * Objects live in memory and vanish when it stops. With `FAKE_S3_DIR` set
 * (or a `dir` passed), every PUT is also written there and read back after a
 * restart — so a seeded local database keeps its previews.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

type StoredObject = {
  bytes: Uint8Array
  type: string
  meta: Record<string, string>
  modified: Date
}

export type FakeS3 = {
  origin: string
  objects: Map<string, StoredObject>
  stop: () => void
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, HEAD, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Type',
}

async function etagOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as BufferSource),
  )
  return `"${[...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}"`
}

/** One object on disk: its bytes, and a sidecar with its type and metadata. */
function diskFiles(dir: string, path: string) {
  const name = createHash('sha256').update(path).digest('hex')
  return { bytes: join(dir, name), meta: join(dir, `${name}.json`) }
}

async function readDisk(
  dir: string,
  path: string,
): Promise<StoredObject | undefined> {
  const files = diskFiles(dir, path)
  const meta = Bun.file(files.meta)
  if (!(await meta.exists())) return undefined
  const saved = (await meta.json()) as {
    type: string
    meta: Record<string, string>
    modified: string
  }
  return {
    bytes: new Uint8Array(await Bun.file(files.bytes).arrayBuffer()),
    type: saved.type,
    meta: saved.meta,
    modified: new Date(saved.modified),
  }
}

export function startFakeS3(port = 0, dir?: string): FakeS3 {
  const objects = new Map<string, StoredObject>()
  if (dir) mkdirSync(dir, { recursive: true })
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      const path = decodeURIComponent(url.pathname)
      if (request.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: CORS })
      if (request.method === 'PUT') {
        const bytes = new Uint8Array(await request.arrayBuffer())
        const meta: Record<string, string> = {}
        request.headers.forEach((value, name) => {
          if (name.startsWith('x-amz-meta-')) meta[name] = value
        })
        const stored: StoredObject = {
          bytes,
          type:
            request.headers.get('content-type') ?? 'application/octet-stream',
          meta,
          modified: new Date(),
        }
        objects.set(path, stored)
        if (dir) {
          const files = diskFiles(dir, path)
          await Bun.write(files.bytes, bytes)
          await Bun.write(
            files.meta,
            JSON.stringify({
              path,
              type: stored.type,
              meta,
              modified: stored.modified,
            }),
          )
        }
        return new Response(null, {
          status: 200,
          headers: { ...CORS, ETag: await etagOf(bytes) },
        })
      }
      if (request.method === 'DELETE') {
        objects.delete(path)
        if (dir) {
          const files = diskFiles(dir, path)
          rmSync(files.bytes, { force: true })
          rmSync(files.meta, { force: true })
        }
        return new Response(null, { status: 204, headers: CORS })
      }
      let object = objects.get(path)
      if (!object && dir) {
        object = await readDisk(dir, path)
        if (object) objects.set(path, object)
      }
      if (!object)
        return new Response(request.method === 'HEAD' ? null : 'NoSuchKey', {
          status: 404,
          headers: CORS,
        })
      const headers = {
        ...CORS,
        ...object.meta,
        'Content-Type': object.type,
        'Content-Length': String(object.bytes.byteLength),
        'Last-Modified': object.modified.toUTCString(),
        ETag: await etagOf(object.bytes),
      }
      if (request.method === 'HEAD')
        return new Response(null, { status: 200, headers })
      return new Response(object.bytes as BodyInit, { status: 200, headers })
    },
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    objects,
    stop: () => server.stop(true),
  }
}

if (import.meta.main) {
  const dir = process.env.FAKE_S3_DIR || undefined
  const s3 = startFakeS3(Number(process.env.PORT ?? 9901), dir)
  console.log(
    `fake S3 on ${s3.origin} — local tests and previews only · ${dir ? `kept in ${dir}` : 'in memory'}`,
  )
}
