export type V31Approval = {
  id: string
  environment: string
  actorId: string
  actorName?: string | null
  actorRole?: string | null
  decision: string
  reason: string
  createdAt: string
  signature: string
  signatureValid?: boolean
}

export type V31Release = {
  id: string
  name: string
  repository: string
  candidateRef: string
  candidateSha: string
  baseSha?: string | null
  tagName?: string | null
  state: string
  environment: string
  createdAt: string
  updatedAt: string
  preparedAt?: string | null
  finishedAt?: string | null
  manifest: Record<string, any>
  github: Record<string, any>
  notes: Array<Record<string, any>>
  deployment: Record<string, any>
  rollbackSha?: string | null
  blockers: string[]
  warnings: string[]
  goNoGo?: {
    ready: boolean
    environment: string
    blockers: string[]
    warnings: string[]
    approvals: { required: number; approved: number; rejected: number; satisfied: boolean; items: V31Approval[] }
    activeFreezes: V31Freeze[]
    v29Gate: { state: string; score?: number }
  }
  approvals?: V31Approval[]
  deployments?: Array<Record<string, any>>
  events?: Array<Record<string, any>>
}

export type V31Freeze = {
  id: string
  name: string
  startAt: string
  endAt: string
  reason: string
  active: boolean
  createdAt: string
}

export type V31Overview = {
  version: string
  generatedAt: string
  schema: { current: number; latest: number; pending: number; databaseMode: string }
  github: { repository: string; tokenConfigured: boolean; mode: string }
  deploymentAdapter: { configured: boolean; mode: string; urlConfigured: boolean; note: string }
  activeRelease?: V31Release | null
  releases: V31Release[]
  freezes: V31Freeze[]
  v30: { traffic: Record<string, any>; activeRelease?: Record<string, any> | null }
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
    throw new Error(payload.detail || payload.message || 'تعذر تنفيذ عملية Creator V31.')
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error('تعذر تنفيذ عملية Creator V31.')
  }
}

async function request<T>(url: string, method: 'POST' | 'DELETE', body?: unknown): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const csrf = csrfToken()
  if (csrf) headers.set('X-MAGHRABI-CSRF', csrf)
  return parse<T>(await fetch(url, {
    method,
    headers,
    credentials: 'include',
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  }))
}

export async function getOverviewV31(): Promise<V31Overview> {
  return parse<V31Overview>(await fetch('/api/video/v31/admin/overview', { credentials: 'include' }))
}

export function createReleaseV31(payload: Record<string, any>): Promise<V31Release> {
  return request<V31Release>('/api/video/v31/admin/releases', 'POST', payload)
}

export function prepareReleaseV31(id: string): Promise<V31Release> {
  return request<V31Release>(`/api/video/v31/admin/releases/${encodeURIComponent(id)}/prepare`, 'POST')
}

export function approveReleaseV31(id: string, environment: string, decision: 'approve' | 'reject', reason = ''): Promise<Record<string, any>> {
  return request<Record<string, any>>(`/api/video/v31/admin/releases/${encodeURIComponent(id)}/approve`, 'POST', { environment, decision, reason })
}

export function promoteReleaseV31(id: string, overrideFreeze = false, overrideReason = ''): Promise<V31Release> {
  return request<V31Release>(`/api/video/v31/admin/releases/${encodeURIComponent(id)}/promote`, 'POST', { overrideFreeze, overrideReason })
}

export function rollbackReleaseV31(id: string, targetSha?: string, environment?: string): Promise<V31Release> {
  return request<V31Release>(`/api/video/v31/admin/releases/${encodeURIComponent(id)}/rollback`, 'POST', { targetSha, environment })
}

export function createFreezeV31(payload: { name: string; startAt: string; endAt: string; reason: string }): Promise<V31Freeze> {
  return request<V31Freeze>('/api/video/v31/admin/freezes', 'POST', payload)
}

export function deleteFreezeV31(id: string): Promise<{ ok: boolean; id: string }> {
  return request<{ ok: boolean; id: string }>(`/api/video/v31/admin/freezes/${encodeURIComponent(id)}`, 'DELETE')
}

export function evidenceUrlV31(id: string) {
  return `/api/video/v31/admin/releases/${encodeURIComponent(id)}/evidence`
}
