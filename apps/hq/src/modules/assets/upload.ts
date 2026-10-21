/**
 * The browser side of an upload (Assets, and Board's files):
 * PUT the bytes to the place `prepareUploadAction` gave, with progress, and
 * measure what the browser can before `finalizeUploadAction` records it.
 */

/** PUT the bytes to where HQ said, with progress (fetch can't report upload progress). */
export function put(
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

/** What the browser can measure: an image's size, a video's size and length, and a still of it. */
export async function measure(file: File): Promise<{
  width?: number
  height?: number
  durationMs?: number
  still?: Blob
}> {
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
      const durationMs = Number.isFinite(media.duration)
        ? Math.round(media.duration * 1000)
        : undefined
      if (!(media instanceof HTMLVideoElement)) return { durationMs }
      const out = {
        width: media.videoWidth || undefined,
        height: media.videoHeight || undefined,
        durationMs,
      }
      // A still from the first second, for the grid.
      media.currentTime = Math.min(1, (media.duration || 2) / 2)
      await new Promise<void>((resolve) => {
        media.onseeked = () => resolve()
        setTimeout(resolve, 3000)
      })
      const canvas = document.createElement('canvas')
      const scale = Math.min(
        1,
        640 / Math.max(media.videoWidth || 1, media.videoHeight || 1),
      )
      canvas.width = Math.max(1, Math.round((media.videoWidth || 1) * scale))
      canvas.height = Math.max(1, Math.round((media.videoHeight || 1) * scale))
      canvas
        .getContext('2d')
        ?.drawImage(media, 0, 0, canvas.width, canvas.height)
      const still = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.8),
      )
      return { ...out, still: still ?? undefined }
    }
  } catch {
    // Not measurable here; storage may still say.
  } finally {
    URL.revokeObjectURL(url)
  }
  return {}
}
