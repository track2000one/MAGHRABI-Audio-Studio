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
}

export type VideoProjectManifest = {
  clips: VideoClipManifest[]
  transition: 'none' | 'fade'
  transitionDuration: number
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
