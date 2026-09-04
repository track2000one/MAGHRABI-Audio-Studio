export type V40Step = {
  name?: string
  status?: string
  conclusion?: string | null
  number?: number
}

export type V40Job = {
  name: string
  label: string
  status?: string
  conclusion?: string | null
  startedAt?: string | null
  completedAt?: string | null
  htmlUrl?: string | null
  steps: V40Step[]
}

export type V40Pipeline = {
  available: boolean
  success: boolean
  runId?: number | null
  runUrl?: string | null
  status?: string | null
  conclusion?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  jobs: Record<string, V40Job>
  finalArtifact?: {
    id?: number | null
    name?: string | null
    sizeBytes?: number | null
    archiveDigest?: string | null
    expired?: boolean | null
  } | null
  imageDigestSha256?: string | null
  imageRef?: string | null
  immutableImage?: string | null
  reason?: string | null
  error?: string | null
}

export type V40Readiness = {
  ready: boolean
  version: string
  releaseId?: string | null
  releaseName?: string | null
  repository?: string | null
  candidateSha?: string | null
  evaluatedAt: string
  blockers: Array<{ code: string; message: string }>
  warnings: string[]
  pipeline: V40Pipeline
  attestation: {
    available: boolean
    present: boolean
    count?: number
    subjectDigest?: string
    reason?: string
    error?: string
  }
  policy: {
    waiversAllowed: boolean
    immutableImageRequired: boolean
    allStagesRequired: string[]
    productionPromotionBlockedOnFailure: boolean
  }
}

export type V40Overview = {
  version: string
  generatedAt: string
  activeRelease: Record<string, any> | null
  readiness: V40Readiness | null
  stages: Record<string, string>
}

async function apiError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({ detail: fallback }))
  return new Error(payload.detail || fallback)
}

export async function getOverviewV40() {
  const response = await fetch('/api/video/v40/admin/overview', { credentials: 'include' })
  if (!response.ok) throw await apiError(response, 'تعذر تحميل حالة Production Readiness.')
  return response.json() as Promise<V40Overview>
}
