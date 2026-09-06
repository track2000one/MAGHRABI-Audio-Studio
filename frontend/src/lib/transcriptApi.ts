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

export type TranscriptTranslationCueInput = {
  id: string
  text: string
}

export type TranscriptTranslationItem = {
  id: string
  text: string
}

export type TranscriptTranslationResult = {
  provider: string
  model: string
  sourceLanguage?: string | null
  targetLanguage: string
  translations: TranscriptTranslationItem[]
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

export async function translateTranscriptCaptions(
  cues: TranscriptTranslationCueInput[],
  options: { targetLanguage: string; sourceLanguage?: string | null },
) {
  const clean = cues.filter((cue) => cue.id && cue.text.trim())
  if (!clean.length) throw new Error('لا توجد Captions صالحة للترجمة.')

  const translations: TranscriptTranslationItem[] = []
  let provider = 'openai-compatible'
  let model = ''
  const batchSize = 60

  for (let index = 0; index < clean.length; index += batchSize) {
    const batch = clean.slice(index, index + batchSize)
    const response = await fetch('/api/transcript/translate', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceLanguage: options.sourceLanguage || '',
        targetLanguage: options.targetLanguage,
        cues: batch,
      }),
    })
    if (!response.ok) throw await apiError(response, 'تعذر ترجمة Captions.')
    const payload = await response.json() as TranscriptTranslationResult
    if (!Array.isArray(payload.translations) || payload.translations.length !== batch.length) {
      throw new Error('وصلت نتيجة ترجمة ناقصة؛ لم يتم حفظها.')
    }
    provider = payload.provider || provider
    model = payload.model || model
    translations.push(...payload.translations)
  }

  const byId = new Map(translations.map((item) => [item.id, item.text]))
  const ordered = clean.map((cue) => ({ id: cue.id, text: byId.get(cue.id) || '' }))
  if (ordered.some((item) => !item.text.trim())) throw new Error('وصلت نتيجة ترجمة غير مكتملة؛ لم يتم حفظها.')
  return {
    provider,
    model,
    sourceLanguage: options.sourceLanguage || null,
    targetLanguage: options.targetLanguage,
    translations: ordered,
  } satisfies TranscriptTranslationResult
}
