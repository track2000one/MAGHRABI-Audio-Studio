export type SceneV16 = { index: number; start: number; end: number; duration: number; midpoint: number }
export type SceneDetectionV16 = { duration: number; threshold: number; scenes: SceneV16[] }

export type AutoColorResultV16 = {
  sampleCount: number
  averageRgb: { r: number; g: number; b: number }
  averageLuma: number
  lumaStd: number
  confidence: number
  suggestion: {
    brightness: number
    contrast: number
    saturation: number
    gammaWheel: { r: number; g: number; b: number }
  }
  color?: Record<string, unknown>
  note: string
}

export type ShotAnalysisV16 = {
  duration: number
  sceneCount: number
  analyzedCount: number
  medianLuma: number
  shots: Array<SceneV16 & {
    rgb: { r: number; g: number; b: number }
    luma: number
    brightnessOffset: number
  }>
}

async function responseError(response: Response) {
  try {
    const payload = await response.json()
    return new Error(payload.detail || 'تعذر تنفيذ Smart Assist V16.')
  } catch {
    return new Error('تعذر تنفيذ Smart Assist V16.')
  }
}

export async function detectScenesV16(file: File, threshold = .35): Promise<SceneDetectionV16> {
  const form = new FormData()
  form.append('file', file)
  form.append('threshold', String(threshold))
  const response = await fetch('/api/video/v16/scenes', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function autoColorV16(file: File): Promise<AutoColorResultV16> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch('/api/video/v16/auto-color', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function analyzeShotsV16(file: File, threshold = .35): Promise<ShotAnalysisV16> {
  const form = new FormData()
  form.append('file', file)
  form.append('threshold', String(threshold))
  const response = await fetch('/api/video/v16/shot-analysis', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function cleanDialogueV16(file: File) {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch('/api/video/v16/dialogue-clean', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}

export async function smartReframeV16(file: File, target: 'portrait' | 'square') {
  const form = new FormData()
  form.append('file', file)
  form.append('target', target)
  const response = await fetch('/api/video/v16/smart-reframe', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}
