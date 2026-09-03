export type V21Priority = 'low' | 'normal' | 'high' | 'urgent'

export type PipelineConfigV21 = {
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

export type TemplateV21 = {
  id: string
  name: string
  basePreset: string
  language: string
  sceneThreshold: number
  config: PipelineConfigV21
  createdAt: string
  updatedAt: string
}

export type PresetV21 = PipelineConfigV21 & { id: string }

export type ItemV21 = {
  id: string
  sourceName: string
  sizeBytes: number
  status: 'queued' | 'processing' | 'done' | 'failed' | 'cancelled'
  attempts: number
  error?: string | null
  createdAt?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  childJobId?: string | null
  resultReady: boolean
  reportReady: boolean
  captionsReady: boolean
  progress: number
  stage?: string | null
  message?: string | null
}

export type ProjectStatsV21 = {
  total: number
  queued: number
  processing: number
  done: number
  failed: number
  cancelled: number
  progress: number
}

export type ProjectV21 = {
  id: string
  name: string
  status: 'queued' | 'processing' | 'pausing' | 'paused' | 'done' | 'partial' | 'failed'
  priority: V21Priority
  pauseRequested: boolean
  preset: string
  presetLabel: string
  templateId?: string | null
  templateName?: string | null
  createdAt: string
  updatedAt: string
  startedAt?: string | null
  finishedAt?: string | null
  settings: { language: string; sceneThreshold: number; highlightDuration: number }
  stats: ProjectStatsV21
  items: ItemV21[]
}

export type OverviewV21 = {
  projects: number
  queued: number
  processing: number
  paused: number
  done: number
  partial: number
  failed: number
  legacy: { v20Jobs: number; v12RenderJobs: number }
  storage: string
  pauseSemantics: string
}

export type InfoV21 = {
  presets: PresetV21[]
  templates: TemplateV21[]
  priorities: V21Priority[]
  deliveries: string[]
  overview: OverviewV21
}

async function fail(response: Response): Promise<never> {
  try {
    const payload = await response.json()
    throw new Error(payload.detail || 'تعذر تنفيذ عملية Creator V21.')
  } catch (error) {
    if (error instanceof Error && error.message !== 'تعذر تنفيذ عملية Creator V21.') throw error
    throw new Error('تعذر تنفيذ عملية Creator V21.')
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) return fail(response)
  return response.json()
}

async function blob(response: Response): Promise<Blob> {
  if (!response.ok) return fail(response)
  return response.blob()
}

export async function getInfoV21(): Promise<InfoV21> {
  return json(await fetch('/api/video/v21/info', { credentials: 'include' }))
}

export async function listProjectsV21(): Promise<{ projects: ProjectV21[]; overview: OverviewV21 }> {
  return json(await fetch('/api/video/v21/projects', { credentials: 'include' }))
}

export async function createTemplateV21(payload: Partial<TemplateV21> & { name: string; basePreset: string }): Promise<TemplateV21> {
  return json(await fetch('/api/video/v21/templates', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }))
}

export async function updateTemplateV21(id: string, payload: Partial<TemplateV21>): Promise<TemplateV21> {
  return json(await fetch(`/api/video/v21/templates/${id}`, {
    method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }))
}

export async function deleteTemplateV21(id: string): Promise<void> {
  await json(await fetch(`/api/video/v21/templates/${id}`, { method: 'DELETE', credentials: 'include' }))
}

export async function createProjectV21(
  files: File[],
  options: {
    projectName: string
    preset: string
    templateId?: string | null
    priority: V21Priority
    language: string
    sceneThreshold: number
    highlightDuration: number
  },
): Promise<ProjectV21> {
  const form = new FormData()
  files.forEach(file => form.append('files', file))
  form.append('project_name', options.projectName)
  form.append('preset', options.preset)
  if (options.templateId) form.append('template_id', options.templateId)
  form.append('priority', options.priority)
  form.append('language', options.language)
  form.append('scene_threshold', String(options.sceneThreshold))
  form.append('highlight_duration', String(options.highlightDuration))
  return json(await fetch('/api/video/v21/projects', { method: 'POST', body: form, credentials: 'include' }))
}

export async function pauseProjectV21(id: string): Promise<ProjectV21> {
  return json(await fetch(`/api/video/v21/projects/${id}/pause`, { method: 'POST', credentials: 'include' }))
}

export async function resumeProjectV21(id: string): Promise<ProjectV21> {
  return json(await fetch(`/api/video/v21/projects/${id}/resume`, { method: 'POST', credentials: 'include' }))
}

export async function setPriorityV21(id: string, priority: V21Priority): Promise<ProjectV21> {
  const form = new FormData(); form.append('priority', priority)
  return json(await fetch(`/api/video/v21/projects/${id}/priority`, { method: 'POST', body: form, credentials: 'include' }))
}

export async function retryItemV21(projectId: string, itemId: string): Promise<ProjectV21> {
  return json(await fetch(`/api/video/v21/projects/${projectId}/items/${itemId}/retry`, { method: 'POST', credentials: 'include' }))
}

export async function deleteProjectV21(id: string): Promise<void> {
  await json(await fetch(`/api/video/v21/projects/${id}`, { method: 'DELETE', credentials: 'include' }))
}

export async function sourceItemV21(projectId: string, itemId: string): Promise<Blob> {
  return blob(await fetch(`/api/video/v21/projects/${projectId}/items/${itemId}/source`, { credentials: 'include' }))
}

export async function resultItemV21(projectId: string, itemId: string): Promise<Blob> {
  return blob(await fetch(`/api/video/v21/projects/${projectId}/items/${itemId}/result`, { credentials: 'include' }))
}

export async function reportItemV21(projectId: string, itemId: string): Promise<Blob> {
  return blob(await fetch(`/api/video/v21/projects/${projectId}/items/${itemId}/report`, { credentials: 'include' }))
}

export async function captionsItemV21(projectId: string, itemId: string): Promise<Blob> {
  return blob(await fetch(`/api/video/v21/projects/${projectId}/items/${itemId}/captions`, { credentials: 'include' }))
}
