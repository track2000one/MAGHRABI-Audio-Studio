export type V27Integration = {
  id: string
  label: string
  total: number
  managed: number
  activeUnmanaged: number
  projects?: number
  states: Record<string, number>
}

export type V27Circuit = {
  name: string
  state: string
  failureCount: number
  successCount: number
  openedAt?: string | null
  retryAt?: number | null
  lastFailure?: string | null
  updatedAt?: string | null
}

export type V27Overview = {
  version: string
  generatedAt: string
  nodeId: string
  managedReady: boolean
  v26Readiness: {
    ready: boolean
    database: { ok: boolean; mode: string; error?: string | null }
    distributedSafe: boolean
    dataWritable: boolean
    maintenance: { enabled: boolean; reason: string; draining: boolean }
  }
  coverage: {
    integrations: V27Integration[]
    totalJobs: number
    managedJobs: number
    coveragePercent: number
    activeUnmanaged: number
  }
  managedLeaseCounts: Record<string, Record<string, number>>
  circuits: V27Circuit[]
  lastReconcile: Record<string, any>
  chaosHistory: Array<{ id: string; createdAt: string; severity: string; details: Record<string, any> }>
  semantics: Record<string, string>
}

function csrfToken() {
  const item = document.cookie.split('; ').find(part => part.startsWith('maghrabi_v24_csrf='))
  return item ? decodeURIComponent(item.slice(item.indexOf('=') + 1)) : ''
}

async function json<T>(response: Response): Promise<T> {
  if (response.ok) return response.json()
  try {
    const payload = await response.json()
    throw new Error(payload.detail || payload.message || 'تعذر تنفيذ عملية Creator V27.')
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error('تعذر تنفيذ عملية Creator V27.')
  }
}

async function write<T>(url: string, body?: unknown): Promise<T> {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  const csrf = csrfToken()
  if (csrf) headers.set('X-MAGHRABI-CSRF', csrf)
  return json(await fetch(url, {
    method: 'POST', headers, credentials: 'include', body: JSON.stringify(body || {}),
  }))
}

export async function getOverviewV27(): Promise<V27Overview> {
  return json(await fetch('/api/video/v27/admin/overview', { credentials: 'include' }))
}

export async function reconcileV27(): Promise<Record<string, any>> {
  return write('/api/video/v27/admin/reconcile')
}

export async function chaosDrillV27(mode: 'retry' | 'dlq'): Promise<Record<string, any>> {
  return write('/api/video/v27/admin/chaos-drill', { mode })
}
