export type VideoFilter = 'none' | 'warm' | 'cool' | 'cinematic' | 'vivid' | 'mono'
export type OutputSize = '720p' | '1080p' | 'portrait' | 'square'
export type RenderQuality = 'draft' | 'standard' | 'high'

export type VideoClipManifest = {
  fileIndex: number
  start: number
  end: number
  speed: number
  volume: number
  filter: VideoFilter
  text: string
  textSize: number
  textPosition: 'top' | 'center' | 'bottom'
  rotation?: 0 | 90 | 180 | 270
  fit?: 'contain' | 'cover'
}

export type TextTrackManifest = {
  text: string
  startAt: number
  endAt: number
  size: number
  position: 'top' | 'center' | 'bottom'
}

export type AudioTrackManifest = {
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  volume: number
  fadeIn: number
  fadeOut: number
}

export type ImageTrackManifest = {
  fileIndex: number
  startAt: number
  endAt: number
  scale: number
  opacity: number
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center'
}

export type VideoProjectManifest = {
  clips: VideoClipManifest[]
  transition: 'none' | 'fade'
  transitionDuration: number
}

export type VideoProjectManifestV2 = VideoProjectManifest & {
  textTracks: TextTrackManifest[]
  audioTracks: AudioTrackManifest[]
  imageTracks: ImageTrackManifest[]
}

async function responseError(response: Response) {
  try {
    const payload = await response.json()
    return new Error(payload.detail || 'تعذر تنفيذ عملية الفيديو.')
  } catch {
    return new Error('تعذر تنفيذ عملية الفيديو.')
  }
}

export async function renderVideoProject(
  files: File[],
  manifest: VideoProjectManifest,
  outputSize: OutputSize,
  quality: RenderQuality,
) {
  const form = new FormData()
  files.forEach((file) => form.append('files', file))
  form.append('manifest', JSON.stringify(manifest))
  form.append('output_size', outputSize)
  form.append('quality', quality)

  const response = await fetch('/api/video/render', {
    method: 'POST',
    body: form,
    credentials: 'include',
  })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}

export async function renderVideoProjectV2(
  videoFiles: File[],
  audioFiles: File[],
  imageFiles: File[],
  manifest: VideoProjectManifestV2,
  outputSize: OutputSize,
  quality: RenderQuality,
) {
  const form = new FormData()
  videoFiles.forEach((file) => form.append('video_files', file))
  audioFiles.forEach((file) => form.append('audio_files', file))
  imageFiles.forEach((file) => form.append('image_files', file))
  form.append('manifest', JSON.stringify(manifest))
  form.append('output_size', outputSize)
  form.append('quality', quality)

  const response = await fetch('/api/video/v2/render', {
    method: 'POST',
    body: form,
    credentials: 'include',
  })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}
