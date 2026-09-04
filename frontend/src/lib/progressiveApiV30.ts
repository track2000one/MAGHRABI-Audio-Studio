export type V30Cohort = {
  samples: number
  errors5xx: number
  error5xxPct?: number | null
  p50Ms?: number | null
  p95Ms?: number | null
  p99Ms?: number | null
}

export type V30Evaluation = {
  decision: 'hold' | 'promote' | 'rollback' | string
  blockers: string[]
  warnings: string[]
  evaluatedAt: string
  metrics: {
    cohorts: { current: V30Cohort; candidate: V30Cohort; p95RegressionPct?: number | null; error5xxDeltaPct?: number | null; since?: string }
    v29Gate: { state: string; score?: number }
    burnRate1h?: number | null
    holdRemainingSeconds?: number
    enoughSamples?: boolean
    traffic?: Record<string, any>
  }
}

export type V30Release = {
  id: string
  name: string
  currentVersion: string
  candidateVersion: string
  state: string
  stageIndex: number
  desiredPercent: number
  appliedPercent: number
  autoPromote: boolean
  autoRollback: boolean
  createdAt: string
  updatedAt: string
  startedAt?: string | null
  finishedAt?: string | null
  lastEvaluatedAt?: string | null
  manifest: Record<string, any>
  blockers: string[]
  warnings: string[]
  metrics: Record<string, any>
  evaluation?: V30Evaluation
  events?: Array<Record<string, any>>
}

export type V30Flag = {
  key: string
  name: string
  description: string
  enabled: boolean
  rolloutPercent: number
  variantOn: string
  variantOff: string
  updatedAt: string
  actorId?: string | null
}

export type V30Overview = {
  version: string
  generatedAt: string
  schema: { current: number; latest: number; pending: number; databaseMode: string }
  traffic: { mode: string; configured: boolean; urlConfigured: boolean; note: string }
  activeRelease?: V30Release | null
  releases: V30Release[]
  flags: V30Flag[]
  v29: {
    releaseGate: { state: string; score: number; blockers?: string[]; warnings?: string[] }
    capacity: Record<string, any>
    forecast: Record<string, any>
  }
}

function csrfToken() {
  const item = document.cookie.split('; ').find(part => part.startsWith('maghrabi_v24_csrf='))
  return item ? decodeURIComponent(item.slice(item.indexOf('=') + 1)) : ''
}

async function parse<T>(response: Response): Promise<T> {
  if (response.ok) {
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) return response.json()
    return response as unknown as T
  }
  try {
    const payload = await response.json()
    throw new Error(payload.detail || payload.message || 'تعذر تنفيذ عملية Creator V30.')
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error('تعذر تنفيذ عملية Creator V30.')
  }
}

async function request<T>(url: string, method: 'POST' | 'DELETE', body?: unknown): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const csrf = csrfToken()
  if (csrf) headers.set('X-MAGHRABI-CSRF', csrf)
  return parse(await fetch(url, {
    method, headers, credentials: 'include', body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  }))
}

export async function getOverviewV30(): Promise<V30Overview> {
  return parse(await fetch('/api/video/v30/admin/overview', { credentials: 'include' }))
}

export async function createReleaseV30(payload: Record<string, any>): Promise<V30Release> {
  return request('/api/video/v30/admin/releases', 'POST', payload)
}

export async function startReleaseV30(id: string): Promise<V30Release> {
  return request(`/api/video/v30/admin/releases/${encodeURIComponent(id)}/start`, 'POST')
}

export async function evaluateReleaseV30(id: string): Promise<V30Release> {
  return request(`/api/video/v30/admin/releases/${encodeURIComponent(id)}/evaluate`, 'POST')
}

export async function promoteReleaseV30(id: string): Promise<V30Release> {
  return request(`/api/video/v30/admin/releases/${encodeURIComponent(id)}/promote`, 'POST')
}

export async function rollbackReleaseV30(id: string, reason = 'Manual rollback'): Promise<V30Release> {
  return request(`/api/video/v30/admin/releases/${encodeURIComponent(id)}/rollback`, 'POST', { reason })
}

export async function pauseReleaseV30(id: string): Promise<V30Release> {
  return request(`/api/video/v30/admin/releases/${encodeURIComponent(id)}/pause`, 'POST')
}

export async function saveFlagV30(payload: Partial<V30Flag> & { key: string }): Promise<V30Flag> {
  return request('/api/video/v30/admin/flags', 'POST', payload)
}

export async function deleteFlagV30(key: string): Promise<{ ok: boolean; key: string }> {
  return request(`/api/video/v30/admin/flags/${encodeURIComponent(key)}`, 'DELETE')
}

export function evidenceUrlV30(id: string) {
  return `/api/video/v30/admin/releases/${encodeURIComponent(id)}/evidence`
}
