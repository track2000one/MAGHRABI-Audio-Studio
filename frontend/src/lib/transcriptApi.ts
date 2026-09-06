export type TranscriptApiWord = {
  id: string
  text: string
  start: number
  end: number
  speaker?: string | null
}

export type TranscriptApiSegment = {
  id: string
  text: string
  start: number
  end: number
  speaker?: string | null
}

export type TranscriptResult = {
  text: string
  language?: string | null
  duration: number
  words: TranscriptApiWord[]
  segments: TranscriptApiSegment[]
  provider: string
  wordModel: string
  diarizeModel?: string | null
  diarized: boolean
  sourceStart: number
  sourceEnd?: number | null
}

export type TranscriptStatus = {
  configured: boolean
  provider: string
  wordModel: string
  diarizeModel: string
  supportsWordTimestamps: boolean
  supportsSpeakerLabels: boolean
}

async function apiError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({ detail: fallback }))
  return new Error(typeof payload?.detail === 'string' ? payload.detail : fallback)
}

export async function getTranscriptStatus() {
  const response = await fetch('/api/transcript/status', { credentials: 'include' })
  if (!response.ok) throw await apiError(response, 'تعذر قراءة حالة محرك Transcript.')
  return response.json() as Promise<TranscriptStatus>
}

export async function transcribeAudioTrack(
  file: File,
  options: {
    sourceStart: number
    sourceEnd: number
    language?: string
    prompt?: string
    diarize?: boolean
  },
) {
  const body = new FormData()
  body.append('file', file)
  body.append('source_start', String(Math.max(0, options.sourceStart || 0)))
  body.append('source_end', String(Math.max(options.sourceStart + .02, options.sourceEnd || options.sourceStart + .02)))
  if (options.language && !['auto', 'detect'].includes(options.language)) body.append('language', options.language)
  if (options.prompt?.trim()) body.append('prompt', options.prompt.trim())
  body.append('diarize', options.diarize ? 'true' : 'false')

  const response = await fetch('/api/transcript/transcribe', {
    method: 'POST',
    credentials: 'include',
    body,
  })
  if (!response.ok) throw await apiError(response, 'تعذر تحويل الصوت إلى Transcript.')
  return response.json() as Promise<TranscriptResult>
}
