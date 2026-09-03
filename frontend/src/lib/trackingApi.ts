export type TrackingBoxV17 = { x: number; y: number; width: number; height: number }

export type TrackingPointV17 = TrackingBoxV17 & {
  time: number
  confidence: number
}

export type TrackingResultV17 = {
  duration: number
  range: { start: number; end: number; anchor: number }
  fps: number
  source: { width: number; height: number }
  box: TrackingBoxV17
  points: TrackingPointV17[]
  averageConfidence: number
  lowConfidencePoints: number
  method: string
  note: string
}

export type CaptionSegmentV17 = { start: number; end: number; text: string }
export type CaptionAnalysisV17 = {
  duration: number
  thresholdDb: number
  minSilence: number
  segments: CaptionSegmentV17[]
}

async function responseError(response: Response) {
  try {
    const payload = await response.json()
    return new Error(payload.detail || 'تعذر تنفيذ عملية Creator V17.')
  } catch {
    return new Error('تعذر تنفيذ عملية Creator V17.')
  }
}

export async function trackRegionV17(
  file: File,
  box: TrackingBoxV17,
  start: number,
  end: number,
  anchor: number,
  fps = 5,
  search = .09,
): Promise<TrackingResultV17> {
  const form = new FormData()
  form.append('file', file)
  form.append('box', JSON.stringify(box))
  form.append('start', String(start))
  form.append('end', String(end))
  form.append('anchor', String(anchor))
  form.append('fps', String(fps))
  form.append('search', String(search))
  const response = await fetch('/api/video/v17/track', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function renderTrackedEffectV17(
  file: File,
  track: TrackingResultV17,
  effect: 'blur' | 'mosaic' | 'spotlight',
  intensity: number,
) {
  const form = new FormData()
  form.append('file', file)
  form.append('track', JSON.stringify(track))
  form.append('effect', effect)
  form.append('intensity', String(intensity))
  const response = await fetch('/api/video/v17/tracked-effect', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}

export async function dynamicReframeV17(file: File, track: TrackingResultV17, target: 'portrait' | 'square') {
  const form = new FormData()
  form.append('file', file)
  form.append('track', JSON.stringify(track))
  form.append('target', target)
  const response = await fetch('/api/video/v17/dynamic-reframe', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}

export async function captionSegmentsV17(file: File, thresholdDb = -35, minSilence = .45): Promise<CaptionAnalysisV17> {
  const form = new FormData()
  form.append('file', file)
  form.append('threshold_db', String(thresholdDb))
  form.append('min_silence', String(minSilence))
  const response = await fetch('/api/video/v17/caption-segments', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function burnCaptionsV17(file: File, captions: CaptionSegmentV17[]) {
  const form = new FormData()
  form.append('file', file)
  form.append('captions', JSON.stringify(captions))
  const response = await fetch('/api/video/v17/burn-captions', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}
