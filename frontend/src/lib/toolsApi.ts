export type OutputFormat = 'mp3' | 'wav' | 'm4a' | 'flac'
export type EnhanceProfile = 'voice' | 'music' | 'clean'

async function blobResponse(response: Response, fallback: string) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: fallback }))
    throw new Error(payload.detail || fallback)
  }
  return response.blob()
}

export async function trimAudio(options: {
  file: File
  startSeconds: number
  endSeconds: number
  fadeIn: number
  fadeOut: number
  outputFormat: OutputFormat
}) {
  const body = new FormData()
  body.append('file', options.file)
  body.append('start_seconds', String(options.startSeconds))
  body.append('end_seconds', String(options.endSeconds))
  body.append('fade_in', String(options.fadeIn))
  body.append('fade_out', String(options.fadeOut))
  body.append('output_format', options.outputFormat)
  const response = await fetch('/api/tools/trim', { method: 'POST', body, credentials: 'include' })
  return blobResponse(response, 'تعذر قص الملف الصوتي.')
}

export async function mergeAudio(files: File[], outputFormat: OutputFormat) {
  const body = new FormData()
  files.forEach((file) => body.append('files', file))
  body.append('output_format', outputFormat)
  const response = await fetch('/api/tools/merge', { method: 'POST', body, credentials: 'include' })
  return blobResponse(response, 'تعذر دمج الملفات الصوتية.')
}

export async function enhanceAudio(options: {
  file: File
  profile: EnhanceProfile
  normalize: boolean
  fadeIn: number
  fadeOut: number
  outputFormat: OutputFormat
}) {
  const body = new FormData()
  body.append('file', options.file)
  body.append('profile', options.profile)
  body.append('normalize', String(options.normalize))
  body.append('fade_in', String(options.fadeIn))
  body.append('fade_out', String(options.fadeOut))
  body.append('output_format', options.outputFormat)
  const response = await fetch('/api/tools/enhance', { method: 'POST', body, credentials: 'include' })
  return blobResponse(response, 'تعذر تحسين الملف الصوتي.')
}

export async function convertAudio(file: File, outputFormat: OutputFormat) {
  const body = new FormData()
  body.append('file', file)
  body.append('output_format', outputFormat)
  const response = await fetch('/api/tools/convert', { method: 'POST', body, credentials: 'include' })
  return blobResponse(response, 'تعذر تحويل الملف الصوتي.')
}
