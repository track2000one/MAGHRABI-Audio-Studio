export type StemName = 'vocals' | 'drums' | 'bass' | 'other' | 'instrumental'

export interface JobResponse {
  id: string
  original_name: string
  mode: '2stems' | '4stems'
  status: 'queued' | 'processing' | 'completed' | 'failed'
  progress: number
  stage: 'queued' | 'loading_model' | 'separating' | 'finalizing' | 'completed' | 'failed' | string
  message: string
  elapsed_seconds: number
  stems: Partial<Record<StemName, string>>
  error?: string | null
}

export async function createSeparationJob(file: File, mode: '2stems' | '4stems') {
  const body = new FormData()
  body.append('file', file)
  body.append('mode', mode)
  const response = await fetch('/api/jobs', { method: 'POST', body })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: 'تعذر رفع الملف.' }))
    throw new Error(payload.detail || 'تعذر رفع الملف.')
  }
  return response.json() as Promise<JobResponse>
}

export async function getJob(jobId: string) {
  const response = await fetch(`/api/jobs/${jobId}`)
  if (!response.ok) throw new Error('تعذر قراءة حالة المعالجة.')
  return response.json() as Promise<JobResponse>
}
