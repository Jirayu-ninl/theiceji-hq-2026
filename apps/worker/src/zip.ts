import { deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * A minimal ZIP (PKWARE APPNOTE 6.3) writer and reader — enough for a
 * digital-download bundle, and nothing a marketplace or an OS unzipper would
 * trip over: no ZIP64 (the package cap is far below 4 GB), no extra fields,
 * no encryption, no directories, flat names only.
 *
 * Writing is deterministic: every entry carries the same fixed DOS timestamp
 * (1980-01-01 00:00, the format's epoch) and no host attributes, so the same
 * inputs make the same archive — and nothing about the machine that built it
 * (clock, user, path) ends up inside the file a customer downloads.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (ISO-HDLC), as ZIP uses it. */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export type ZipInput = { name: string; bytes: Uint8Array }

export type ZipEntry = {
  name: string
  method: 'store' | 'deflate'
  crc32: number
  compressedSize: number
  size: number
  bytes: Uint8Array
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

const DOS_DATE = (0 << 9) | (1 << 5) | 1 // 1980-01-01
const DOS_TIME = 0
const UTF8_FLAG = 1 << 11
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Path separators and characters Windows refuses in a file name. */
const FORBIDDEN_NAME_CHARS = String.raw`\/:*?"<>|`

/** Flat, portable entry names: no directories, drive letters or dot files. */
export function isSafeEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    ![...name].some(
      (ch) => ch.charCodeAt(0) < 32 || FORBIDDEN_NAME_CHARS.includes(ch),
    ) &&
    !name.startsWith('.') &&
    name.trim() === name
  )
}

export function writeZip(files: ZipInput[]): Uint8Array {
  const seen = new Set<string>()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    if (!isSafeEntryName(file.name))
      throw new ZipError(`Unsafe entry name: ${JSON.stringify(file.name)}`)
    const key = file.name.toLowerCase()
    if (seen.has(key)) throw new ZipError(`Duplicate entry: ${file.name}`)
    seen.add(key)
    const name = encoder.encode(file.name)
    const crc = crc32(file.bytes)
    // Deflate only when it pays: PNGs are already compressed and storing
    // them keeps the archive fast to open and byte-for-byte predictable.
    const deflated = deflateRawSync(file.bytes, { level: 9 })
    const useDeflate = deflated.byteLength < file.bytes.byteLength - 64
    const body = useDeflate ? new Uint8Array(deflated) : file.bytes
    const method = useDeflate ? 8 : 0
    const flags = /^[\x20-\x7e]*$/.test(file.name) ? 0 : UTF8_FLAG

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, flags, true)
    lv.setUint16(8, method, true)
    lv.setUint16(10, DOS_TIME, true)
    lv.setUint16(12, DOS_DATE, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.byteLength, true)
    lv.setUint32(22, file.bytes.byteLength, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // made by: MS-DOS / FAT — no Unix modes to leak
    cv.setUint16(6, 20, true)
    cv.setUint16(8, flags, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, DOS_TIME, true)
    cv.setUint16(14, DOS_DATE, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.byteLength, true)
    cv.setUint32(24, file.bytes.byteLength, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)

    locals.push(local, body)
    centrals.push(central)
    offset += local.byteLength + body.byteLength
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.byteLength, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, centrals.length, true)
  ev.setUint16(10, centrals.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + centralSize + end.byteLength)
  let at = 0
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

/**
 * Parse an archive from its central directory, cross-check every local
 * header, decompress every entry and verify its size and CRC-32. Anything
 * that doesn't add up throws — a package that can't be re-opened here is not
 * one to sell.
 */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 22 - 65535);
    i--
  )
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new ZipError('No end-of-central-directory record.')
  const count = view.getUint16(eocd + 10, true)
  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (cdOffset + cdSize > eocd)
    throw new ZipError('Central directory out of range.')
  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50)
      throw new ZipError(`Bad central header #${n}.`)
    const flags = view.getUint16(p + 8, true)
    const method = view.getUint16(p + 10, true)
    const crc = view.getUint32(p + 16, true)
    const compressedSize = view.getUint32(p + 20, true)
    const size = view.getUint32(p + 24, true)
    const nameLength = view.getUint16(p + 28, true)
    const extraLength = view.getUint16(p + 30, true)
    const commentLength = view.getUint16(p + 32, true)
    const localOffset = view.getUint32(p + 42, true)
    if (flags & 1) throw new ZipError('Encrypted entries are not allowed.')
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength))
    p += 46 + nameLength + extraLength + commentLength

    if (view.getUint32(localOffset, true) !== 0x04034b50)
      throw new ZipError(`Bad local header for ${name}.`)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtra = view.getUint16(localOffset + 28, true)
    const localName = decoder.decode(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    )
    if (localName !== name)
      throw new ZipError(`Header names disagree for ${name}.`)
    const start = localOffset + 30 + localNameLength + localExtra
    if (start + compressedSize > cdOffset)
      throw new ZipError(`Entry ${name} overruns the archive.`)
    const raw = bytes.subarray(start, start + compressedSize)
    let data: Uint8Array
    if (method === 0) data = raw
    else if (method === 8) {
      try {
        data = new Uint8Array(inflateRawSync(raw))
      } catch {
        throw new ZipError(`Entry ${name} doesn’t inflate.`)
      }
    } else
      throw new ZipError(
        `Unsupported compression method ${method} for ${name}.`,
      )
    if (data.byteLength !== size)
      throw new ZipError(`Size mismatch for ${name}.`)
    if (crc32(data) !== crc) throw new ZipError(`CRC mismatch for ${name}.`)
    entries.push({
      name,
      method: method === 8 ? 'deflate' : 'store',
      crc32: crc,
      compressedSize,
      size,
      bytes: data,
    })
  }
  return entries
}
