export type V29Percentiles = {
  samples: number
  p50Seconds?: number | null
  p95Seconds?: number | null
  p99Seconds?: number | null
}

export type V29LoadTest = {
  id: string
  kind: 'load' | 'soak' | string
  state: string
  startedAt: string
  finishedAt?: string | null
  durationSeconds: number
  concurrency: number
  operations: number
  errors: number
  p50Ms?: number | null
  p95Ms?: number | null
  p99Ms?: number | null
  opsPerSecond?: number | null
  details: Record<string, any>
}

export type V29Gate = {
  id?: string
  createdAt?: string
  evaluatedAt?: string
  versionLabel: string
  state: 'pass' | 'warn' | 'block' | string
  score: number
  blockers: string[]
  warnings: string[]
  metrics: Record<string, any>
}

export type V29Overview = {
  version: string
  generatedAt: string
  schema: { current: number; latest: number; pending: number; databaseMode: string }
  settings: Record<string, any>
  jobs: {
    windowHours: number
    samples: number
    terminalSamples: number
    successes: number
    failures: number
    successPct?: number | null
    queue: V29Percentiles
    execution: V29Percentiles
    renderP95Seconds?: number | null
    renderSamples: number
    pipelineP95Seconds?: number | null
    pipelineSamples: number
    perPreset: Array<{
      category: string
      preset: string
      samples: number
      computeSeconds: number
      p50Seconds?: number | null
      p95Seconds?: number | null
      realTimeFactor?: number | null
      estimatedUsd?: number | null
    }>
    computeUsdPerHourConfigured?: number | null
  }
  errorBudget: {
    targetPct: number
    window: { hours: number; samples: number; errors5xx: number; errors4xx: number; availabilityPct?: number | null; requestSuccessPct?: number | null; p50Ms?: number | null; p95Ms?: number | null; p99Ms?: number | null }
    allowedErrorsEquivalent: number
    remainingErrorsEquivalent: number
    remainingBudgetPct?: number | null
    burnRate1h?: number | null
    burnRate6h?: number | null
  }
  capacity: {
    replicaCount: number
    ffmpegActive: number
    activeLeases: number
    queuedJobs: number
    activeJobs: number
    load1?: number | null
    cpuCount: number
    memoryPercent?: number | null
    diskPercent?: number | null
    saturationPercent: number
  }
  capacityForecast: {
    measurementHours: number
    arrivals: number
    completions: number
    arrivalPerHour: number
    completionPerHour: number
    currentBacklog: number
    forecastBacklog1h: number
    currentReplicas: number
    recommendedReplicas: number
    recommendation: string
    note: string
  }
  capacityHistory: Array<Record<string, any>>
  loadTests: V29LoadTest[]
  releaseGate: V29Gate
  releaseHistory: V29Gate[]
  v28: { ready: boolean; replicaCount: number; distributedSafe: boolean }
  costModel: { rateUsdPerComputeHour?: number | null; isEstimate: boolean; note: string }
}

function csrfToken() {
  const item = document.cookie.split('; ').find(part => part.startsWith('maghrabi_v24_csrf='))
  return item ? decodeURIComponent(item.slice(item.indexOf('=') + 1)) : ''
}

async function parse<T>(response: Response): Promise<T> {
  if (response.ok) return response.json()
  try {
    const payload = await response.json()
    throw new Error(payload.detail || payload.message || 'تعذر تنفيذ عملية Creator V29.')
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error('تعذر تنفيذ عملية Creator V29.')
  }
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const csrf = csrfToken()
  if (csrf) headers.set('X-MAGHRABI-CSRF', csrf)
  return parse(await fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(body || {}) }))
}

export async function getOverviewV29(): Promise<V29Overview> {
  return parse(await fetch('/api/video/v29/admin/overview', { credentials: 'include' }))
}

export async function saveSettingsV29(settings: Record<string, any>): Promise<Record<string, any>> {
  return post('/api/video/v29/admin/settings', { settings })
}

export async function runReleaseGateV29(versionLabel = 'Creator V29'): Promise<V29Gate> {
  return post('/api/video/v29/admin/release-gate', { versionLabel })
}

export async function captureCapacityV29(): Promise<Record<string, any>> {
  return post('/api/video/v29/admin/capacity-snapshot')
}

export async function runLoadTestV29(kind: 'load' | 'soak', durationSeconds: number, concurrency: number): Promise<V29LoadTest> {
  return post('/api/video/v29/admin/load-test', { kind, durationSeconds, concurrency })
}
