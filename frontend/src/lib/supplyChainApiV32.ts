export type V32Gate = {
  ready: boolean
  environment: string
  blockers: string[]
  warnings: string[]
  evaluatedAt: string
  scanId?: string
  candidateSha?: string
}

export type V32Scan = {
  id: string
  releaseId: string
  repository: string
  candidateSha: string
  status: string
  createdAt: string
  updatedAt: string
  sbom: Record<string, any>
  vulnerabilities: Record<string, any>
  signatures: Record<string, any>
  rules: Record<string, any>
  drift: Record<string, any>
  licenses: Record<string, any>
  artifact: Record<string, any>
  provenance: Record<string, any>
  policy: Record<string, any>
  gate: V32Gate
  gates?: Record<string, V32Gate>
}

export type V32Overview = {
  version: string
  generatedAt: string
  schema: { current: number; latest: number; pending: number; databaseMode: string }
  policy: Record<string, any>
  activeRelease?: Record<string, any> | null
  latestScan?: V32Scan | null
  gates?: Record<string, V32Gate> | null
  scans: V32Scan[]
  baselines: Array<Record<string, any>>
  artifacts: Array<Record<string, any>>
  events: Array<Record<string, any>>
  capabilities: Record<string, any>
}

function csrfToken() {
  const item = document.cookie.split('; ').find(part => part.startsWith('maghrabi_v24_csrf='))
  return item ? decodeURIComponent(item.slice(item.indexOf('=') + 1)) : ''
}

async function parse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') || ''
  if (response.ok) {
    if (contentType.includes('application/json')) return response.json() as Promise<T>
    return response as unknown as T
  }
  try {
    const payload = await response.json()
    const detail = typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail || payload)
    throw new Error(detail || 'تعذر تنفيذ عملية Creator V32.')
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error('تعذر تنفيذ عملية Creator V32.')
  }
}

async function request<T>(url: string, body: unknown = {}): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const csrf = csrfToken()
  if (csrf) headers.set('X-MAGHRABI-CSRF', csrf)
  const response = await fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(body) })
  return parse<T>(response)
}

export async function getOverviewV32(): Promise<V32Overview> {
  return parse<V32Overview>(await fetch('/api/video/v32/admin/overview', { credentials: 'include' }))
}

export function runScanV32(releaseId?: string): Promise<V32Scan> {
  return request('/api/video/v32/admin/scan', releaseId ? { releaseId } : {})
}

export function savePolicyV32(policy: Record<string, any>): Promise<Record<string, any>> {
  return request('/api/video/v32/admin/policy', policy)
}

export function captureBaselineV32(environment: 'dev' | 'staging' | 'production'): Promise<Record<string, any>> {
  return request('/api/video/v32/admin/config-baseline', { environment })
}

export function attestArtifactV32(payload: {
  releaseId?: string
  environment: 'dev' | 'staging' | 'production'
  name: string
  digestSha256: string
  sizeBytes?: number
  source?: string
  metadata?: Record<string, any>
}): Promise<Record<string, any>> {
  return request('/api/video/v32/attest/artifact', payload)
}

export function evidenceUrlV32(scanId: string) {
  return `/api/video/v32/admin/scans/${encodeURIComponent(scanId)}/evidence`
}
