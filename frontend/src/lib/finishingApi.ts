export type RGBBalance = { r: number; g: number; b: number }
export type CurveBand = { shadows: number; mids: number; highlights: number }
export type GradeSettingsV14 = {
  brightness: number
  contrast: number
  saturation: number
  gamma: number
  lift: RGBBalance
  gammaWheel: RGBBalance
  gain: RGBBalance
  curves: { r: CurveBand; g: CurveBand; b: CurveBand }
}

export type AudioMasterSettingsV14 = {
  low: number
  mid: number
  high: number
  compressor: boolean
  thresholdDb: number
  ratio: number
  attack: number
  release: number
  limiter: boolean
  ceilingDb: number
  normalize: boolean
  targetLufs: number
}

export type ExportPresetV14 =
  | 'youtube_1080'
  | 'tiktok'
  | 'instagram_reel'
  | 'instagram_square'
  | 'broadcast_1080p25'
  | 'master_1080'

export type LoudnessAnalysisV14 = {
  integratedLufs: number | null
  lra: number | null
  truePeakDbfs: number | null
  duration: number
}

async function responseError(response: Response) {
  try {
    const payload = await response.json()
    return new Error(payload.detail || 'تعذر تنفيذ عملية Finishing.')
  } catch {
    return new Error('تعذر تنفيذ عملية Finishing.')
  }
}

export async function analyzeAudioV14(file: File): Promise<LoudnessAnalysisV14> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch('/api/video/v14/analyze-audio', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function masterVideoV14(
  file: File,
  grade: GradeSettingsV14,
  audio: AudioMasterSettingsV14,
  preset: ExportPresetV14,
) {
  const form = new FormData()
  form.append('file', file)
  form.append('grade', JSON.stringify(grade))
  form.append('audio', JSON.stringify(audio))
  form.append('preset', preset)
  const response = await fetch('/api/video/v14/master', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}
