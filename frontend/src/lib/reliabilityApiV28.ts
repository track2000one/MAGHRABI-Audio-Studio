export type V28Node = {
  id: string
  state: string
  heartbeatAt?: string | null
  deploymentId?: string | null
  instanceId?: string | null
  hostname?: string | null
}

export type V28Drill = {
  id: string
  kind: string
  state: string
  nodeId: string
  jobKey?: string | null
  startedAt: string
  finishedAt?: string | null
  primaryPid?: number | null
  replacementPid?: number | null
  killedAt?: string | null
  takeoverAt?: string | null
  completedAt?: string | null
  rtoMs?: number | null
  recoveryMs?: number | null
  duplicateCount: number
  leaseAttempt: number
  error?: string | null
  details: Record<string, any>
}

export type V28DrainCheck = {
  id: string
  nodeId: string
  state: string
  startedAt: string
  finishedAt?: string | null
  activeBefore: number
  activeAfter?: number | null
  durationMs?: number | null
  details: Record<string, any>
}

export type V28Overview = {
  version: string
  generatedAt: string
  nodeId: string
  ready: boolean
  databaseMode: string
  distributedSafe: boolean
  multiReplicaObserved: boolean
  replicaCount: number
  nodes: V28Node[]
  leader: {
    scope: string
    nodeId?: string | null
    epoch: number
    acquiredAt?: string | null
    heartbeatAt?: string | null
    expiresAt?: number | null
    isLeader: boolean
  }
  schema: { current: number; latest: number; pending: number; databaseMode: string; distributedSafe: boolean }
  v27: {
    managedReady: boolean
    coverage?: { coveragePercent?: number; activeUnmanaged?: number; totalJobs?: number; managedJobs?: number }
  }
  drills: V28Drill[]
  lastRtoMs?: number | null
  drainChecks: V28DrainCheck[]
  capabilities: {
    realWorkerSigkill: boolean
    duplicateProcessContest: boolean
    leaderElection: boolean
    multiReplicaValidation: boolean
    drainSimulation: boolean
  }
  targets: { rtoMs: number; duplicateCommits: number; leaderTtlSeconds: number }
}

function csrfToken() {
  const item = document.cookie.split('; ').find(part => part.startsWith('maghrabi_v24_csrf='))
  return item ? decodeURIComponent(item.slice(item.indexOf('=') + 1)) : ''
}

async function json<T>(response: Response): Promise<T> {
  if (response.ok) return response.json()
  try {
    const payload = await response.json()
    throw new Error(payload.detail || payload.message || 'تعذر تنفيذ عملية Creator V28.')
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error('تعذر تنفيذ عملية Creator V28.')
  }
}

async function write<T>(url: string, body?: unknown): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const csrf = csrfToken()
  if (csrf) headers.set('X-MAGHRABI-CSRF', csrf)
  return json(await fetch(url, {
    method: 'POST', headers, credentials: 'include', body: JSON.stringify(body || {}),
  }))
}

export async function getOverviewV28(): Promise<V28Overview> {
  return json(await fetch('/api/video/v28/admin/overview', { credentials: 'include' }))
}

export async function runWorkerKillV28(fast = false): Promise<V28Drill> {
  return write('/api/video/v28/admin/worker-kill-drill', { fast })
}

export async function runDuplicateContestV28(contenders = 4): Promise<V28Drill> {
  return write('/api/video/v28/admin/duplicate-contest', { contenders })
}

export async function runDrainSimulationV28(seconds = 10): Promise<V28DrainCheck> {
  return write('/api/video/v28/admin/drain-simulation', { seconds })
}
