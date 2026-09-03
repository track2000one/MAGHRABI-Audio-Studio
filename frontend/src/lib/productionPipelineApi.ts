export type PipelinePresetV20 = {
  id: string
  label: string
  description: string
  delivery: string
  productionAnalysis: boolean
  highlight: boolean
  stabilize: 'auto' | 'off'
  dialogue: boolean
  transcribe: boolean
  burnCaptions: boolean
  reframe: 'portrait' | 'square' | null
  highlightDuration: number
}

export type PipelineStepV20 = {
  id: string
  label: string
  status: 'pending' | 'running' | 'done' | 'skipped' | 'warning' | 'failed'
  startedAt?: string | null
  finishedAt?: string | null
  message?: string | null
  details?: Record<string, unknown>
}

export type PipelineJobV20 = {
  id: string
  name: string
  preset: string
  presetLabel: string
  status: 'queued' | 'processing' | 'done' | 'failed'
  stage: string
  progress: number
  message?: string | null
  error?: string | null
  createdAt: string
  startedAt?: string | null
  finishedAt?: string | null
  resultReady: boolean
  reportReady: boolean
  captionsReady: boolean
  steps: PipelineStepV20[]
  source?: Record<string, unknown> | null
  output?: Record<string, unknown> | null
}

export type PipelineInfoV20 = {
  presets: PipelinePresetV20[]
  stt: { configured: boolean; provider?: string | null }
  storage: string
}

async function responseError(response: Response) {
  try {
    const payload = await response.json()
    return new Error(payload.detail || 'تعذر تنفيذ عملية Creator V20.')
  } catch {
    return new Error('تعذر تنفيذ عملية Creator V20.')
  }
}

export async function getPipelineInfoV20(): Promise<PipelineInfoV20> {
  const response = await fetch('/api/video/v20/presets', { credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function queuePipelineV20(
  file: File,
  preset: string,
  options?: { name?: string; language?: string; sceneThreshold?: number; highlightDuration?: number },
): Promise<PipelineJobV20> {
  const form = new FormData()
  form.append('file', file)
  form.append('preset', preset)
  form.append('name', options?.name || `MAGHRABI ${preset}`)
  form.append('language', options?.language || 'ar')
  form.append('scene_threshold', String(options?.sceneThreshold ?? .35))
  if (options?.highlightDuration != null) form.append('highlight_duration', String(options.highlightDuration))
  const response = await fetch('/api/video/v20/queue', { method: 'POST', body: form, credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function listPipelineJobsV20(): Promise<PipelineJobV20[]> {
  const response = await fetch('/api/video/v20/jobs', { credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  const payload = await response.json()
  return payload.jobs || []
}

export async function retryPipelineJobV20(id: string): Promise<PipelineJobV20> {
  const response = await fetch(`/api/video/v20/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export async function deletePipelineJobV20(id: string): Promise<void> {
  const response = await fetch(`/api/video/v20/jobs/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' })
  if (!response.ok) throw await responseError(response)
}

async function fetchBlob(path: string) {
  const response = await fetch(path, { credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return response.blob()
}

export function getPipelineResultV20(id: string) {
  return fetchBlob(`/api/video/v20/jobs/${encodeURIComponent(id)}/result`)
}

export function getPipelineReportV20(id: string) {
  return fetchBlob(`/api/video/v20/jobs/${encodeURIComponent(id)}/report`)
}

export function getPipelineCaptionsV20(id: string) {
  return fetchBlob(`/api/video/v20/jobs/${encodeURIComponent(id)}/captions`)
}
