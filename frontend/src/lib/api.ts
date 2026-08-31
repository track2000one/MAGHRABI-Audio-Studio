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

export interface AuthStatus {
  configured: boolean
  authenticated: boolean
  username?: string | null
}

async function apiError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({ detail: fallback }))
  return new Error(payload.detail || fallback)
}

function userFacingJobError(error?: string | null) {
  if (!error) return 'تعذرت معالجة الملف الصوتي. يرجى المحاولة مرة أخرى.'
  const normalized = error.toLowerCase()

  if (normalized.includes('torchcodec')) {
    return 'اكتمل تحليل الصوت، لكن تعذر حفظ المسارات النهائية. تم تحديث محرك التصدير، أعد المحاولة بعد اكتمال نشر النسخة الجديدة.'
  }
  if (normalized.includes('out of memory') || normalized.includes('killed')) {
    return 'توقفت المعالجة بسبب عدم كفاية الذاكرة المتاحة. جرّب ملفاً أقصر أو وضع Vocal + Music.'
  }
  if (normalized.includes('ffmpeg')) {
    return 'تعذر قراءة أو تصدير الملف الصوتي. تأكد من أن الملف سليم ثم حاول مرة أخرى.'
  }

  return 'تعذرت معالجة الملف الصوتي. راجع سجل Railway للتفاصيل التقنية ثم حاول مرة أخرى.'
}

export async function getAuthStatus() {
  const response = await fetch('/api/auth/status', { credentials: 'include' })
  if (!response.ok) throw await apiError(response, 'تعذر التحقق من جلسة الدخول.')
  return response.json() as Promise<AuthStatus>
}

export async function login(username: string, password: string) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!response.ok) throw await apiError(response, 'تعذر تسجيل الدخول.')
  return response.json() as Promise<{ authenticated: true; username: string }>
}

export async function logout() {
  const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
  if (!response.ok) throw await apiError(response, 'تعذر تسجيل الخروج.')
}

export async function createSeparationJob(file: File, mode: '2stems' | '4stems') {
  const body = new FormData()
  body.append('file', file)
  body.append('mode', mode)
  const response = await fetch('/api/jobs', { method: 'POST', body, credentials: 'include' })
  if (!response.ok) throw await apiError(response, 'تعذر رفع الملف.')
  return response.json() as Promise<JobResponse>
}

export async function getJob(jobId: string) {
  const response = await fetch(`/api/jobs/${jobId}`, { credentials: 'include' })
  if (!response.ok) throw await apiError(response, 'تعذر قراءة حالة المعالجة.')
  const job = (await response.json()) as JobResponse
  if (job.status === 'failed') job.error = userFacingJobError(job.error)
  return job
}
