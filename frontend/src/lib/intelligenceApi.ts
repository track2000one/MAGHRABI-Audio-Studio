import { TrackingBoxV17, TrackingResultV17 } from './trackingApi'

export type DetectionCandidateV18 = TrackingBoxV17 & {
  confidence: number
  kind: 'face' | 'motion'
  label?: string
}

export type MotionCandidatesV18 = {
  duration: number
  at: number
  candidates: DetectionCandidateV18[]
  method: string
}

export type MultiTrackResultV18 = {
  tracks: Array<TrackingResultV17 & { targetId: number }>
  averageConfidence: number
  targetCount: number
}

export type SttCapabilityV18 = {
  configured: boolean
  provider: string | null
}

export type SttSegmentV18 = {
  start: number
  end: number
  text: string
}

export type SttResultV18 = {
  text?: string
  language?: string
  segments?: SttSegmentV18[]
  [key: string]: unknown
}

async function apiError(response: Response) {
  try {
    const payload = await response.json()
    return new Error(payload.detail || 'تعذر تنفيذ عملية Creator V18.')
  } catch {
    return new Error('تعذر تنفيذ عملية Creator V18.')
  }
}

export async function motionCandidatesV18(file: File, at: number): Promise<MotionCandidatesV18> {
  const form = new FormData()
  form.append('file', file)
  form.append('at', String(at))
  const response = await fetch('/api/video/v18/motion-candidates', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await apiError(response)
  return response.json()
}

export async function multiTrackV18(
  file: File,
  boxes: TrackingBoxV17[],
  start: number,
  end: number,
  anchor: number,
  fps: number,
  search: number,
): Promise<MultiTrackResultV18> {
  const form = new FormData()
  form.append('file', file)
  form.append('boxes', JSON.stringify(boxes))
  form.append('start', String(start))
  form.append('end', String(end))
  form.append('anchor', String(anchor))
  form.append('fps', String(fps))
  form.append('search', String(search))
  const response = await fetch('/api/video/v18/multi-track', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await apiError(response)
  return response.json()
}

export async function multiBlurV18(file: File, tracks: TrackingResultV17[], intensity = .7) {
  const form = new FormData()
  form.append('file', file)
  form.append('tracks', JSON.stringify(tracks))
  form.append('intensity', String(intensity))
  const response = await fetch('/api/video/v18/multi-blur', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await apiError(response)
  return response.blob()
}

export async function multiReframeV18(file: File, tracks: TrackingResultV17[], target: 'portrait' | 'square') {
  const form = new FormData()
  form.append('file', file)
  form.append('tracks', JSON.stringify(tracks))
  form.append('target', target)
  const response = await fetch('/api/video/v18/multi-reframe', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await apiError(response)
  return response.blob()
}

export async function sttCapabilityV18(): Promise<SttCapabilityV18> {
  const response = await fetch('/api/video/v18/stt-capability', { credentials: 'include' })
  if (!response.ok) throw await apiError(response)
  return response.json()
}

export async function transcribeV18(file: File, language = 'ar'): Promise<SttResultV18> {
  const form = new FormData()
  form.append('file', file)
  form.append('language', language)
  const response = await fetch('/api/video/v18/transcribe', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await apiError(response)
  return response.json()
}
