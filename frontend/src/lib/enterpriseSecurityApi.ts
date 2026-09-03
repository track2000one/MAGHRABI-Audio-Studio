export type V24Role = 'admin' | 'producer' | 'editor' | 'reviewer' | 'viewer'
export type V24Permission = 'view' | 'review' | 'edit' | 'manage'

export type V24User = {
  id: string
  name: string
  email: string
  role: V24Role
  status: string
  active: boolean
  mfaEnabled: boolean
  createdAt?: string | null
  lastLoginAt?: string | null
}

export type V24Session = {
  id: string
  createdAt: string
  expiresAt: number
  lastSeenAt: string
  ip?: string | null
  userAgent?: string | null
  revoked: boolean
  current: boolean
}

export type V24Resource = {
  type: 'v21_project' | 'v22_room'
  id: string
  name: string
  status: string
  updatedAt?: string | null
  permission?: V24Permission
}

export type V24Info = {
  version: string
  dbMode: 'postgresql' | 'sqlite'
  databaseUrlConfigured: boolean
  sqlitePath?: string | null
  migration: Record<string, unknown>
  authenticated: boolean
  user?: V24User | null
  legacyAdmin: boolean
  security: {
    csrf: boolean
    serverSessions: boolean
    mfaTotp: boolean
    passwordReset: boolean
    rateLimit: { max: number; windowSeconds: number; blockSeconds: number }
  }
  email: { configured: boolean; host?: string | null; from?: string | null }
  oidc: { configured: boolean; issuer?: string | null; autoProvision: boolean }
}

export type V24Team = {
  id: string
  name: string
  memberIds?: string[]
  created_at?: string
  updated_at?: string
}

export type V24Acl = {
  id: string
  resourceType: 'v21_project' | 'v22_room'
  resourceId: string
  principalType: 'user' | 'team'
  principalId: string
  permission: V24Permission
  ownerUserId?: string | null
  createdAt?: string
}

export type V24AdminOverview = {
  admin: Record<string, unknown>
  dbMode: 'postgresql' | 'sqlite'
  databaseUrlConfigured: boolean
  users: V24User[]
  teams: V24Team[]
  acl: V24Acl[]
  resources: V24Resource[]
  audit: Array<{ id: string; actorName?: string; actorRole?: string; action: string; details?: Record<string, unknown>; createdAt: string }>
  sessions: { active: number; mfaUsers: number; totalUsers: number }
  email: { configured: boolean }
  oidc: { configured: boolean; issuer?: string | null; autoProvision: boolean }
  roles: V24Role[]
  permissions: V24Permission[]
}

function csrfToken() {
  const item = document.cookie.split('; ').find(part => part.startsWith('maghrabi_v24_csrf='))
  return item ? decodeURIComponent(item.slice(item.indexOf('=') + 1)) : ''
}

async function fail(response: Response): Promise<never> {
  try {
    const payload = await response.json()
    throw new Error(payload.detail || payload.message || 'تعذر تنفيذ عملية V24.')
  } catch (error) {
    if (error instanceof Error && error.message !== 'تعذر تنفيذ عملية V24.') throw error
    throw new Error('تعذر تنفيذ عملية V24.')
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) return fail(response)
  return response.json()
}

async function write<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {})
  const token = csrfToken()
  if (token) headers.set('X-MAGHRABI-CSRF', token)
  return json(await fetch(url, { ...options, headers, credentials: 'include' }))
}

export async function getInfoV24(): Promise<V24Info> {
  return json(await fetch('/api/video/v24/info', { credentials: 'include' }))
}

export async function getStatusV24(): Promise<{ authenticated: boolean; user?: V24User | null; sessionId?: string | null }> {
  return json(await fetch('/api/video/v24/auth/status', { credentials: 'include' }))
}

export async function loginV24(email: string, password: string, otp = ''): Promise<{ authenticated: boolean; mfaRequired?: boolean; user?: V24User; csrfToken?: string; message?: string }> {
  return json(await fetch('/api/video/v24/auth/login', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, otp }),
  }))
}

export async function logoutV24(): Promise<void> {
  await write('/api/video/v24/auth/logout', { method: 'POST' })
}

export async function forgotPasswordV24(email: string): Promise<{ ok: boolean; message: string }> {
  return json(await fetch('/api/video/v24/auth/forgot-password', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  }))
}

export async function getResetInfoV24(token: string): Promise<{ email: string; expiresAt: number }> {
  return json(await fetch(`/api/video/v24/reset/${encodeURIComponent(token)}/info`))
}

export async function completeResetV24(token: string, password: string): Promise<void> {
  await json(await fetch(`/api/video/v24/reset/${encodeURIComponent(token)}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  }))
}

export async function getMeV24(): Promise<{ user: V24User; sessions: V24Session[] }> {
  return json(await fetch('/api/video/v24/me', { credentials: 'include' }))
}

export async function getResourcesV24(): Promise<{ resources: V24Resource[] }> {
  return json(await fetch('/api/video/v24/me/resources', { credentials: 'include' }))
}

export async function revokeSessionV24(id: string): Promise<void> {
  await write(`/api/video/v24/me/sessions/${id}/revoke`, { method: 'POST' })
}

export async function revokeOtherSessionsV24(): Promise<void> {
  await write('/api/video/v24/me/sessions/revoke-others', { method: 'POST' })
}

export async function setupMfaV24(): Promise<{ secret: string; otpauthUri: string }> {
  return write('/api/video/v24/me/mfa/setup', { method: 'POST' })
}

export async function confirmMfaV24(code: string): Promise<{ enabled: boolean }> {
  return write('/api/video/v24/me/mfa/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
}

export async function disableMfaV24(password: string, code: string): Promise<{ enabled: boolean }> {
  return write('/api/video/v24/me/mfa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, code }) })
}

export async function getReviewRoomV24(roomId: string): Promise<any> {
  return json(await fetch(`/api/video/v24/me/review/${roomId}`, { credentials: 'include' }))
}

export async function getReviewVideoV24(roomId: string, versionId?: string): Promise<Blob> {
  const query = versionId ? `?version_id=${encodeURIComponent(versionId)}` : ''
  const response = await fetch(`/api/video/v24/me/review/${roomId}/video${query}`, { credentials: 'include' })
  if (!response.ok) return fail(response)
  return response.blob()
}

export async function addReviewCommentV24(roomId: string, payload: { versionId?: string; time: number; text: string }): Promise<any> {
  return write(`/api/video/v24/me/review/${roomId}/comment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
}

export async function reviewDecisionV24(roomId: string, payload: { versionId?: string; decision: 'approved' | 'changes_requested'; note?: string }): Promise<any> {
  return write(`/api/video/v24/me/review/${roomId}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
}

export async function getAdminOverviewV24(): Promise<V24AdminOverview> {
  return json(await fetch('/api/video/v24/admin/overview', { credentials: 'include' }))
}

export async function createInviteV24(payload: { name: string; email: string; role: V24Role; sendEmail: boolean }): Promise<any> {
  return write('/api/video/v24/admin/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
}

export async function getInviteInfoV24(token: string): Promise<{ name: string; email: string; role: V24Role; expiresAt: number }> {
  return json(await fetch(`/api/video/v24/invite/${encodeURIComponent(token)}/info`))
}

export async function acceptInviteV24(token: string, password: string): Promise<any> {
  return json(await fetch(`/api/video/v24/invite/${encodeURIComponent(token)}/accept`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  }))
}

export async function setUserActiveV24(id: string, active: boolean): Promise<V24User> {
  const form = new FormData(); form.append('active', String(active))
  return write(`/api/video/v24/admin/users/${id}/active`, { method: 'POST', body: form })
}

export async function setUserRoleV24(id: string, role: V24Role): Promise<V24User> {
  const form = new FormData(); form.append('role', role)
  return write(`/api/video/v24/admin/users/${id}/role`, { method: 'POST', body: form })
}

export async function createResetLinkV24(id: string, sendEmail: boolean): Promise<any> {
  return write(`/api/video/v24/admin/users/${id}/reset-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sendEmail }) })
}

export async function revokeUserSessionsV24(id: string): Promise<void> {
  await write(`/api/video/v24/admin/users/${id}/sessions/revoke`, { method: 'POST' })
}

export async function createTeamV24(name: string, memberIds: string[]): Promise<any> {
  return write('/api/video/v24/admin/teams', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, memberIds }) })
}

export async function updateTeamV24(id: string, payload: { name?: string; memberIds?: string[] }): Promise<any> {
  return write(`/api/video/v24/admin/teams/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
}

export async function deleteTeamV24(id: string): Promise<void> {
  await write(`/api/video/v24/admin/teams/${id}`, { method: 'DELETE' })
}

export async function addAclV24(payload: { resourceType: string; resourceId: string; principalType: 'user' | 'team'; principalId: string; permission: V24Permission; ownerUserId?: string | null }): Promise<any> {
  return write('/api/video/v24/admin/acl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
}

export async function deleteAclV24(id: string): Promise<void> {
  await write(`/api/video/v24/admin/acl/${id}`, { method: 'DELETE' })
}

export async function getOidcInfoV24(): Promise<{ configured: boolean; issuer?: string | null; autoProvision: boolean }> {
  return json(await fetch('/api/video/v24/oidc/info'))
}
