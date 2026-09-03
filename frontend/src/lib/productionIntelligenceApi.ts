import { TrackingBoxV17 } from './trackingApi'

export type AdaptiveTrackPointV19 = TrackingBoxV17 & {
  time: number
  confidence: number
  occluded: boolean
}

export type AdaptiveTrackResultV19 = {
  duration: number
  range: { start: number; end: number; anchor: number }
  fps: number
  source: { width: number; height: number }
  points: AdaptiveTrackPointV19[]
  averageConfidence: number
  lowConfidencePoints: number
  occlusionPoints: number
  scaleChange: number
  method: string
}

export type CameraMotionSampleV19 = { time: number; dx: number; dy: number; magnitude: number }
export type CameraMotionResultV19 = {
  duration: number
  samples: CameraMotionSampleV19[]
  meanDx: number
  meanDy: number
  meanMagnitude: number
  jitter: number
  classification: string
  stability: number
}

export type ProductionSceneV19 = {
  index?: number
  start: number
  end: number
  duration: number
  midpoint?: number
  motionScore?: number
  audioScore?: number
  highlightScore?: number
  label?: string
}

export type ProductionAnalysisV19 = {
  duration: number
  sceneCount: number
  analyzedCount: number
  cutList: ProductionSceneV19[]
  highlights: ProductionSceneV19[]
  hasAudio: boolean
}

export type WhisperCapabilityV19 = {
  configured: boolean
  provider: string | null
  recommendedProvider: string
  languageDefault: string
  contract: Record<string, unknown>
}

export type TranscriptSegmentV19 = { start: number; end: number; text: string }
export type TranscriptResultV19 = { text?: string; segments?: TranscriptSegmentV19[]; [key: string]: unknown }

async function responseError(response: Response) {
  try {
    const payload = await response.json()
    return new Error(payload.detail || 'تعذر تنفيذ عملية Creator V19.')
  } catch {
    return new Error('تعذر تنفيذ عملية Creator V19.')
  }
}

export async function adaptiveTrackV19(
  file: File,
  box: TrackingBoxV17,
  start: number,
  end: number,
  anchor: number,
  fps = 5,
  search = .09,
): Promise<AdaptiveTrackResultV19> {
  const form = new FormData()
  form.append('file', file)
  form.append('box', JSON.stringify(box))
  form.append('start', String(start))
  form.append('end', String(end))
  form.append('anchor', String(anchor))
  form.append('fps', String(fps))
  form.append('search', String(search))
  const response = await fetch('/api/video/v19/adaptive-track', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function cameraMotionV19(file: File): Promise<CameraMotionResultV19> {
  const form = new FormData(); form.append('file', file)
  const response = await fetch('/api/video/v19/camera-motion', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function stabilizeV19(file: File, strength = .65): Promise<Blob> {
  const form = new FormData(); form.append('file', file); form.append('strength', String(strength))
  const response = await fetch('/api/video/v19/stabilize', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}

export async function productionAnalysisV19(file: File, threshold = .35): Promise<ProductionAnalysisV19> {
  const form = new FormData(); form.append('file', file); form.append('threshold', String(threshold))
  const response = await fetch('/api/video/v19/production-analysis', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function highlightReelV19(file: File, threshold = .35, maxDuration = 30): Promise<Blob> {
  const form = new FormData()
  form.append('file', file)
  form.append('threshold', String(threshold))
  form.append('max_duration', String(maxDuration))
  const response = await fetch('/api/video/v19/highlight-reel', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}

export async function whisperCapabilityV19(): Promise<WhisperCapabilityV19> {
  const response = await fetch('/api/video/v19/whisper-capability', { credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function transcribeV19(file: File, language = 'ar'): Promise<TranscriptResultV19> {
  const form = new FormData(); form.append('file', file); form.append('language', language)
  const response = await fetch('/api/video/v19/transcribe', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}
