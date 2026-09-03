export type V25Alert = {
  key: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  message: string
  details: Record<string, unknown>
  acknowledged: boolean
  acknowledgedAt?: string | null
  acknowledgedBy?: string | null
}

export type V25Backup = {
  id: string
  label: string
  sizeBytes: number
  createdAt: string
  actorName?: string | null
  status: string
  fileExists: boolean
  manifest: Record<string, unknown>
}

export type V25CategoryStorage = {
  name: string
  path: string
  bytes: number
  quotaBytes?: number | null
  quotaPercent?: number | null
  overQuota: boolean
}

export type V25Event = {
  id: string
  createdAt: string
  level: string
  category: string
  message: string
  requestId?: string | null
  actorId?: string | null
  route?: string | null
  method?: string | null
  statusCode?: number | null
  durationMs?: number | null
  details: Record<string, unknown>
}

export type V25Overview = {
  version: string
  generatedAt: string
  serviceUptimeSeconds: number
  systemUptimeSeconds?: number | null
  python: string
  platform: string
  loadAverage: number[]
  memory: { totalBytes: number; availableBytes: number; usedBytes: number; usedPercent?: number | null }
  database: { ok: boolean; mode: 'postgresql' | 'sqlite'; databaseUrlConfigured: boolean; latencyMs: number; error?: string }
  schema: { current: number; latest: number; pending: number; applied: Array<Record<string, unknown>>; databaseMode: string }
  storage: {
    disk: { totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number }
    mount: { path: string; dedicatedMount: boolean; source?: string | null; filesystem?: string | null }
    categories: V25CategoryStorage[]
  }
  jobs: {
    counts: Record<string, Record<string, number>>
    recentFailures24h: Array<{ category: string; id: string; message: string; at: string }>
    averageRecordedDurationSeconds?: number | null
    recordedDurationSamples: number
  }
  ffmpeg: {
    active: number
    processes: Array<{ pid: number; kind: string; elapsedSeconds: number; cpuSeconds: number; rssBytes: number; command: string }>
  }
  settings: Record<string, string | number | boolean>
  alerts: V25Alert[]
  backups: V25Backup[]
  metricHistory: Array<{ createdAt: string; payload: Record<string, any> }>
}

function csrfToken() {
  const item = document.cookie.split('; ').find(part => part.startsWith('maghrabi_v24_csrf='))
  return item ? decodeURIComponent(item.slice(item.indexOf('=') + 1)) : ''
}

async function fail(response: Response): Promise<never> {
  try {
    const payload = await response.json()
    throw new Error(payload.detail || payload.message || 'تعذر تنفيذ عملية Creator V25.')
  } catch (error) {
    if (error instanceof Error && error.message !== 'تعذر تنفيذ عملية Creator V25.') throw error
    throw new Error('تعذر تنفيذ عملية Creator V25.')
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

export async function getOverviewV25(): Promise<V25Overview> {
  return json(await fetch('/api/video/v25/overview', { credentials: 'include' }))
}

export async function getEventsV25(options: { level?: string; category?: string; limit?: number } = {}): Promise<{ events: V25Event[] }> {
  const query = new URLSearchParams()
  if (options.level) query.set('level', options.level)
  if (options.category) query.set('category', options.category)
  query.set('limit', String(options.limit || 200))
  return json(await fetch(`/api/video/v25/events?${query}`, { credentials: 'include' }))
}

export async function getRetentionPreviewV25(): Promise<any> {
  return json(await fetch('/api/video/v25/retention/preview', { credentials: 'include' }))
}

export async function runRetentionV25(): Promise<any> {
  return write('/api/video/v25/retention/run', { method: 'POST' })
}

export async function updateSettingsV25(payload: Record<string, string | number | boolean>): Promise<Record<string, any>> {
  return write('/api/video/v25/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
}

export async function acknowledgeAlertV25(key: string, acknowledged: boolean): Promise<any> {
  return write(`/api/video/v25/alerts/${encodeURIComponent(key)}/ack`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acknowledged }),
  })
}

export async function runDiagnosticsV25(): Promise<any> {
  return write('/api/video/v25/diagnostics/run', { method: 'POST' })
}

export async function applySchemaV25(): Promise<any> {
  return write('/api/video/v25/schema/apply', { method: 'POST' })
}

export async function createBackupV25(label: string): Promise<V25Backup> {
  return write('/api/video/v25/backups', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
  })
}

export async function downloadBackupV25(id: string): Promise<Blob> {
  const response = await fetch(`/api/video/v25/backups/${id}/download`, { credentials: 'include' })
  if (!response.ok) return fail(response)
  return response.blob()
}

export async function restoreBackupV25(id: string): Promise<any> {
  return write(`/api/video/v25/backups/${id}/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'RESTORE' }),
  })
}

export async function deleteBackupV25(id: string): Promise<void> {
  await write(`/api/video/v25/backups/${id}`, { method: 'DELETE' })
}
