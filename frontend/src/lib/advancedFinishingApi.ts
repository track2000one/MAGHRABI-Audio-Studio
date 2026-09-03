import { AudioMasterSettingsV14, ExportPresetV14, GradeSettingsV14 } from './finishingApi'

export type ColorModeV15 = 'auto' | 'rec709' | 'hdr_to_sdr'
export type SelectiveFamilyV15 = 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas' | 'neutrals'

export type SecondaryColorV15 = {
  enabled: boolean
  family: SelectiveFamilyV15
  cyan: number
  magenta: number
  yellow: number
  black: number
}

export type PowerWindowV15 = {
  enabled: boolean
  x: number
  y: number
  width: number
  height: number
  brightness: number
  contrast: number
  saturation: number
}

export type AudioRepairV15 = {
  noiseReduction: boolean
  noiseStrength: number
  deesser: boolean
  deesserIntensity: number
  stereoWidth: number
}

export type SourceInspectionV15 = {
  duration: number
  hasAudio: boolean
  color: {
    colorSpace?: string | null
    transfer?: string | null
    primaries?: string | null
    pixelFormat?: string | null
    width?: number | null
    height?: number | null
    frameRate?: string | null
    isHdr?: boolean
  }
  filters: Record<string, boolean>
}

export type QCIssueV15 = {
  type: 'black' | 'freeze' | 'silence'
  start: number
  end: number
  severity: 'warning' | 'info'
}

export type QCResultV15 = {
  duration: number
  hasAudio: boolean
  color: SourceInspectionV15['color']
  issues: QCIssueV15[]
  summary: { black: number; freeze: number; silence: number }
}

export type ShotMatchResultV15 = {
  targetRgb: { r: number; g: number; b: number }
  referenceRgb: { r: number; g: number; b: number }
  suggestion: {
    brightness: number
    saturation: number
    gammaWheel: { r: number; g: number; b: number }
  }
  note: string
}

async function errorFrom(response: Response) {
  try {
    const payload = await response.json()
    return new Error(payload.detail || 'تعذر تنفيذ عملية V15.')
  } catch {
    return new Error('تعذر تنفيذ عملية V15.')
  }
}

export async function inspectSourceV15(file: File): Promise<SourceInspectionV15> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch('/api/video/v15/inspect-source', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await errorFrom(response)
  return response.json()
}

export async function runQCV15(file: File): Promise<QCResultV15> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch('/api/video/v15/qc', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await errorFrom(response)
  return response.json()
}

export async function shotMatchV15(targetFile: File, referenceFile: File, targetTime = 0, referenceTime = 0): Promise<ShotMatchResultV15> {
  const form = new FormData()
  form.append('target_file', targetFile)
  form.append('reference_file', referenceFile)
  form.append('target_time', String(targetTime))
  form.append('reference_time', String(referenceTime))
  const response = await fetch('/api/video/v15/shot-match', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await errorFrom(response)
  return response.json()
}

function buildMasterForm(
  file: File,
  grade: GradeSettingsV14,
  audio: AudioMasterSettingsV14,
  secondary: SecondaryColorV15,
  windowSettings: PowerWindowV15,
  repair: AudioRepairV15,
  colorMode: ColorModeV15,
) {
  const form = new FormData()
  form.append('file', file)
  form.append('grade', JSON.stringify(grade))
  form.append('audio', JSON.stringify(audio))
  form.append('secondary', JSON.stringify(secondary))
  form.append('window', JSON.stringify(windowSettings))
  form.append('repair', JSON.stringify(repair))
  form.append('color_mode', colorMode)
  return form
}

export async function masterVideoV15(
  file: File,
  grade: GradeSettingsV14,
  audio: AudioMasterSettingsV14,
  secondary: SecondaryColorV15,
  windowSettings: PowerWindowV15,
  repair: AudioRepairV15,
  colorMode: ColorModeV15,
  preset: ExportPresetV14,
) {
  const form = buildMasterForm(file, grade, audio, secondary, windowSettings, repair, colorMode)
  form.append('preset', preset)
  const response = await fetch('/api/video/v15/master', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await errorFrom(response)
  return response.blob()
}

export async function batchMasterV15(
  file: File,
  grade: GradeSettingsV14,
  audio: AudioMasterSettingsV14,
  secondary: SecondaryColorV15,
  windowSettings: PowerWindowV15,
  repair: AudioRepairV15,
  colorMode: ColorModeV15,
  presets: ExportPresetV14[],
) {
  const form = buildMasterForm(file, grade, audio, secondary, windowSettings, repair, colorMode)
  form.append('presets', JSON.stringify(presets))
  const response = await fetch('/api/video/v15/batch-master', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await errorFrom(response)
  return response.blob()
}
