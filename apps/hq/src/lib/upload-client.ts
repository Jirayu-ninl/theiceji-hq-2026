'use client'

import {
  finalizeUploadAction,
  prepareUploadAction,
} from '@/modules/assets/actions'
import type { AssetData } from '@/modules/assets/data'

/**
 * One file through Assets' three upload steps from any page:
 * a pending asset and a place for its bytes, the browser's PUT straight to
 * storage (never through HQ), then finalize. Story attaches a shot's file
 * with it; the Assets page keeps its own richer version (stills, tiles).
 */

function put(
  url: string,
  file: Blob,
  headers: Record<string, string>,
  onProgress: (level: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    for (const [name, value] of Object.entries(headers))
      xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Storage answered ${xhr.status}.`))
    xhr.onerror = () => reject(new Error('The upload was cut off. Try again.'))
    xhr.send(file)
  })
}

async function measure(
  file: File,
): Promise<{ width?: number; height?: number; durationMs?: number }> {
  const url = URL.createObjectURL(file)
  try {
    if (file.type.startsWith('image/')) {
      const image = new Image()
      image.src = url
      await image.decode()
      return { width: image.naturalWidth, height: image.naturalHeight }
    }
    if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
      const media = document.createElement(
        file.type.startsWith('video/') ? 'video' : 'audio',
      )
      media.preload = 'metadata'
      media.muted = true
      media.src = url
      await new Promise<void>((resolve, reject) => {
        media.onloadedmetadata = () => resolve()
        media.onerror = () => reject(new Error('unreadable'))
      })
      return {
        durationMs: Number.isFinite(media.duration)
          ? Math.round(media.duration * 1000)
          : undefined,
        ...(media instanceof HTMLVideoElement
          ? {
              width: media.videoWidth || undefined,
              height: media.videoHeight || undefined,
            }
          : {}),
      }
    }
    return {}
  } catch {
    return {}
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function uploadFile(
  file: File,
  target: { projectId: string | null; jobId?: string },
  onProgress: (level: number) => void = () => {},
): Promise<{ ok: true; asset: AssetData } | { ok: false; error: string }> {
  const prepared = await prepareUploadAction({
    projectId: target.projectId,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    bytes: file.size,
    ...(target.jobId ? { jobId: target.jobId } : {}),
  })
  if (!prepared.ok) return { ok: false, error: prepared.error }
  const dims = measure(file)
  try {
    await put(
      prepared.data.upload.url,
      file,
      prepared.data.upload.mode === 'presigned_put'
        ? prepared.data.upload.headers
        : {},
      onProgress,
    )
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
  const measured = await dims
  const ready = await finalizeUploadAction({
    assetId: prepared.data.asset.id,
    ...measured,
  })
  if (!ready.ok) return { ok: false, error: ready.error }
  return { ok: true, asset: ready.data }
}
