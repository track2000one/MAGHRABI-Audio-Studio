export type V26Node = {
  id: string
  hostname: string
  instanceId?: string | null
  deploymentId?: string | null
  state: string
  startedAt: string
  heartbeatAt: string
  stoppedAt?: string | null
  metadata: Record<string, unknown>
}

export type V26Lease = {
  jobKey: string
  category: string
  jobId: string
  state: string
  ownerNodeId?: string | null
  acquiredAt?: string | null
  heartbeatAt?: string | null
  expiresAt?: number | null
  attempt: number
  maxAttempts: number
  nextRetryAt?: number | null
  idempotencyKey?: string | null
  payloadChecksum?: string | null
  resultChecksum?: string | null
  lastError?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type V26DeadLetter = {
  id: string
  jobKey: string
  category: string
  jobId: string
  attempts: number
  payload: Record<string, unknown>
  error: string
  firstFailedAt: string
  lastFailedAt: string
  resolvedAt?: string | null
  resolution?: string | null
}

export type V26Circuit = {
  name: string
  state: 'closed' | 'open' | 'half_open' | string
  failureCount: number
  successCount: number
  openedAt?: string | null
  retryAt?: number | null
  lastFailure?: string | null
  updatedAt?: string | null
}

export type V26Checksum = {
  id: string
  path: string
  sizeBytes: number
  sha256: string
  status: string
  createdAt?: string | null
  verifiedAt?: string | null
}

export type V26BackupVerification = {
  id: string
  backupId: string
  checkedAt: string
  ok: boolean
  manifestHash?: string | null
  decryptedBytes?: number | null
  details: Record<string, unknown>
}

export type V26Readiness = {
  ready: boolean
  version: string
  nodeId: string
  maintenance: { enabled: boolean; reason: string; draining: boolean }
  database: { ok: boolean; mode: string; error?: string | null }
  schema: { current: number; latest: number; pending: number; databaseMode: string; distributedLocks: boolean }
  dataWritable: boolean
  distributedSafe: boolean
  requirePostgresForReady: boolean
}

export type V26Overview = {
  version: string
  generatedAt: string
  nodeId: string
  schema: { current: number; latest: number; pending: number; databaseMode: string; distributedLocks: boolean; applied: Array<Record<string, unknown>> }
  settings: Record<string, string | number | boolean>
  maintenance: { enabled: boolean; reason: string; draining: boolean }
  readiness: V26Readiness
  pitr: Record<string, any>
  nodes: V26Node[]
  leases: V26Lease[]
  deadLetters: V26DeadLetter[]
  circuits: V26Circuit[]
  legacy: { counts: Record<string, { total: number; managed: number; legacy: number }>; legacySamples: Array<Record<string, any>> }
  checksums: V26Checksum[]
  backupVerifications: V26BackupVerification[]
  idempotencyActive: number
  workerTokenConfigured: boolean
}

export type V26Event = {
  id: string
  createdAt: string
  eventType: string
  jobKey?: string | null
  nodeId?: string | null
  severity: string
  details: Record<string, unknown>
}

function csrfToken() {
  const item = document.cookie.split('; ').find(part => part.startsWith('maghrabi_v24_csrf='))
  return item ? decodeURIComponent(item.slice(item.indexOf('=') + 1)) : ''
}

async function fail(response: Response): Promise<never> {
  try {
    const payload = await response.json()
    throw new Error(payload.detail || payload.message || 'تعذر تنفيذ عملية Creator V26.')
  } catch (error) {
    if (error instanceof Error && error.message !== 'تعذر تنفيذ عملية Creator V26.') throw error
    throw new Error('تعذر تنفيذ عملية Creator V26.')
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) return fail(response)
  return response.json()
}

async function write<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {})
  const csrf = csrfToken()
  if (csrf) headers.set('X-MAGHRABI-CSRF', csrf)
  return json(await fetch(url, { ...options, headers, credentials: 'include' }))
}

export async function getOverviewV26(): Promise<V26Overview> {
  return json(await fetch('/api/video/v26/admin/overview', { credentials: 'include' }))
}

export async function getReadinessV26(): Promise<V26Readiness> {
  const response = await fetch('/api/video/v26/health/ready')
  const payload = await response.json()
  return payload as V26Readiness
}

export async function getEventsV26(severity = '', limit = 250): Promise<{ events: V26Event[] }> {
  const query = new URLSearchParams({ limit: String(limit) })
  if (severity) query.set('severity', severity)
  return json(await fetch(`/api/video/v26/admin/events?${query}`, { credentials: 'include' }))
}

export async function updateSettingsV26(settings: Record<string, string | number | boolean>) {
  return write<{ settings: Record<string, string | number | boolean> }>('/api/video/v26/admin/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }),
  })
}

export async function setMaintenanceV26(enabled: boolean, reason: string) {
  return write<{ enabled: boolean; reason: string; draining: boolean }>('/api/video/v26/admin/maintenance', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, reason }),
  })
}

export async function reconcileV26() {
  return write<any>('/api/video/v26/admin/reconcile', { method: 'POST' })
}

export async function resetCircuitV26(name: string) {
  return write<V26Circuit>(`/api/video/v26/admin/circuits/${encodeURIComponent(name)}/reset`, { method: 'POST' })
}

export async function openCircuitV26(name: string, cooldownSeconds = 120) {
  return write<V26Circuit>(`/api/video/v26/admin/circuits/${encodeURIComponent(name)}/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cooldownSeconds }),
  })
}

export async function retryDlqV26(id: string) {
  return write<any>(`/api/video/v26/admin/dlq/${encodeURIComponent(id)}/retry`, { method: 'POST' })
}

export async function resolveDlqV26(id: string, resolution = 'manually_resolved') {
  return write<any>(`/api/video/v26/admin/dlq/${encodeURIComponent(id)}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution }),
  })
}

export async function scanMediaV26(scope: string, limit = 25) {
  return write<{ scope: string; scanned: Array<Record<string, any>>; skipped: number }>('/api/video/v26/admin/media/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, limit }),
  })
}

export async function verifyMediaV26(id: string) {
  return write<any>(`/api/video/v26/admin/media/${encodeURIComponent(id)}/verify`, { method: 'POST' })
}

export async function verifyBackupV26(id: string) {
  return write<V26BackupVerification>(`/api/video/v26/admin/backups/${encodeURIComponent(id)}/verify`, { method: 'POST' })
}

export async function getPitrReadinessV26() {
  return json(await fetch('/api/video/v26/admin/pitr-readiness', { credentials: 'include' }))
}
