export type V33Gate = {
  ready: boolean
  environment: string
  blockers: string[]
  warnings: string[]
  evaluatedAt: string
  assessmentId?: string
  candidateSha?: string
  opa?: Record<string, any>
  v32?: Record<string, any>
  attestation?: Record<string, any>
  oci?: Record<string, any>
}

export type V33Assessment = {
  id: string
  releaseId: string
  candidateSha: string
  locks: Record<string, any>
  build: Record<string, any>
  artifactSbom: Record<string, any>
  oci: Record<string, any>
  attestation: Record<string, any>
  opa: Record<string, any>
  policy: Record<string, any>
  gate: Record<string, any>
  createdAt: string
  updatedAt: string
  productionGate?: V33Gate
}

export type V33Overview = {
  version: string
  generatedAt: string
  schema: { current: number; latest: number; pending: number; databaseMode: string }
  policy: Record<string, any>
  activeRelease?: Record<string, any> | null
  latestAssessment?: V33Assessment | null
  productionGate?: V33Gate | null
  assessments: V33Assessment[]
  attestations: Array<Record<string, any>>
  oci: Record<string, any>
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
    throw new Error(detail || 'تعذر تنفيذ عملية Creator V33.')
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error('تعذر تنفيذ عملية Creator V33.')
  }
}

async function request<T>(url: string, body: unknown = {}): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const csrf = csrfToken()
  if (csrf) headers.set('X-MAGHRABI-CSRF', csrf)
  const response = await fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(body) })
  return parse<T>(response)
}

export async function getOverviewV33(): Promise<V33Overview> {
  return parse<V33Overview>(await fetch('/api/video/v33/admin/overview', { credentials: 'include' }))
}

export function runAssessmentV33(releaseId?: string): Promise<V33Assessment> {
  return request('/api/video/v33/admin/assess', releaseId ? { releaseId } : {})
}

export function savePolicyV33(policy: Record<string, any>): Promise<Record<string, any>> {
  return request('/api/video/v33/admin/policy', policy)
}

export function createAttestationV33(payload: {
  releaseId?: string
  environment: 'dev' | 'staging' | 'production'
  subjectName?: string
  digestSha256?: string
}): Promise<Record<string, any>> {
  return request('/api/video/v33/attest', payload)
}

export function verifyOciV33(payload: { releaseId?: string; imageRef: string; digestSha256: string }): Promise<Record<string, any>> {
  return request('/api/video/v33/admin/oci/verify', payload)
}

export function evidenceUrlV33(assessmentId: string) {
  return `/api/video/v33/admin/assessments/${encodeURIComponent(assessmentId)}/evidence`
}
