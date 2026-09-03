export type ReviewRoleV22 = 'viewer' | 'commenter' | 'reviewer'
export type ReviewStatusV22 = 'draft' | 'in_review' | 'changes_requested' | 'approved'

export type ReviewSourceV22 = {
  projectId: string
  projectName: string
  itemId: string
  sourceName: string
  childJobId: string
  finishedAt?: string | null
}

export type ReviewVersionV22 = {
  id: string
  number: number
  label: string
  sourceName?: string | null
  createdAt: string
  notes?: string
  fromChildJobId?: string | null
}

export type ReviewMemberV22 = {
  id: string
  name: string
  email?: string
  role: ReviewRoleV22
  active: boolean
  tokenLast4?: string
  createdAt: string
}

export type ReviewCommentV22 = {
  id: string
  versionId: string
  time: number
  text: string
  status: 'open' | 'resolved'
  authorName: string
  authorRole: ReviewRoleV22
  memberId: string
  createdAt: string
  resolvedAt?: string | null
}

export type ReviewDecisionV22 = {
  id: string
  versionId: string
  memberId: string
  memberName: string
  decision: 'approved' | 'changes_requested'
  note?: string
  createdAt: string
}

export type ApprovalV22 = {
  status: ReviewStatusV22
  approvals: number
  changesRequested: number
  openComments: number
  minApprovals: number
  blockOpenComments: boolean
  gatePassed: boolean
}

export type ReviewActivityV22 = {
  id: string
  action: string
  actor: string
  details?: Record<string, unknown>
  createdAt: string
}

export type ReviewRoomV22 = {
  id: string
  name: string
  status: ReviewStatusV22
  archived: boolean
  v21ProjectId: string
  v21ItemId: string
  createdAt: string
  updatedAt: string
  reviewStartedAt?: string | null
  approvedAt?: string | null
  activeVersionId?: string | null
  approvedVersionId?: string | null
  approval: ApprovalV22
  approvalGate: { minApprovals: number; blockOpenComments: boolean }
  versions: ReviewVersionV22[]
  members: ReviewMemberV22[]
  comments: ReviewCommentV22[]
  decisions: ReviewDecisionV22[]
  activity?: ReviewActivityV22[]
  viewer?: ReviewMemberV22
}

async function fail(response: Response): Promise<never> {
  try {
    const payload = await response.json()
    throw new Error(payload.detail || 'تعذر تنفيذ عملية Creator V22.')
  } catch (error) {
    if (error instanceof Error && error.message !== 'تعذر تنفيذ عملية Creator V22.') throw error
    throw new Error('تعذر تنفيذ عملية Creator V22.')
  }
}
async function json<T>(response: Response): Promise<T> {
  if (!response.ok) return fail(response)
  return response.json()
}
async function blob(response: Response): Promise<Blob> {
  if (!response.ok) return fail(response)
  return response.blob()
}

export async function listReviewSourcesV22(): Promise<ReviewSourceV22[]> {
  const data = await json<{ sources: ReviewSourceV22[] }>(await fetch('/api/video/v22/sources', { credentials: 'include' }))
  return data.sources
}
export async function listReviewRoomsV22(includeArchived = false): Promise<ReviewRoomV22[]> {
  const data = await json<{ rooms: ReviewRoomV22[] }>(await fetch(`/api/video/v22/rooms?include_archived=${includeArchived ? 'true' : 'false'}`, { credentials: 'include' }))
  return data.rooms
}
export async function createReviewRoomV22(source: ReviewSourceV22, options: { name: string; minApprovals: number; blockOpenComments: boolean }): Promise<ReviewRoomV22> {
  const form = new FormData()
  form.append('project_id', source.projectId)
  form.append('item_id', source.itemId)
  form.append('name', options.name)
  form.append('min_approvals', String(options.minApprovals))
  form.append('block_open_comments', String(options.blockOpenComments))
  return json(await fetch('/api/video/v22/rooms', { method: 'POST', body: form, credentials: 'include' }))
}
export async function addReviewVersionFromV21(roomId: string, label = '', notes = ''): Promise<ReviewRoomV22> {
  const form = new FormData(); form.append('label', label); form.append('notes', notes)
  return json(await fetch(`/api/video/v22/rooms/${roomId}/versions/from-v21`, { method: 'POST', body: form, credentials: 'include' }))
}
export async function uploadReviewVersionV22(roomId: string, file: File, label = '', notes = ''): Promise<ReviewRoomV22> {
  const form = new FormData(); form.append('file', file); form.append('label', label); form.append('notes', notes)
  return json(await fetch(`/api/video/v22/rooms/${roomId}/versions/upload`, { method: 'POST', body: form, credentials: 'include' }))
}
export async function setActiveReviewVersionV22(roomId: string, versionId: string): Promise<ReviewRoomV22> {
  const form = new FormData(); form.append('version_id', versionId)
  return json(await fetch(`/api/video/v22/rooms/${roomId}/active-version`, { method: 'POST', body: form, credentials: 'include' }))
}
export async function getReviewVideoV22(roomId: string, versionId: string): Promise<Blob> {
  return blob(await fetch(`/api/video/v22/rooms/${roomId}/versions/${versionId}/video`, { credentials: 'include' }))
}
export async function addReviewMemberV22(roomId: string, payload: { name: string; email?: string; role: ReviewRoleV22 }): Promise<{ room: ReviewRoomV22; member: ReviewMemberV22; reviewToken: string; shareFragment: string }> {
  return json(await fetch(`/api/video/v22/rooms/${roomId}/members`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }))
}
export async function rotateReviewLinkV22(roomId: string, memberId: string): Promise<{ member: ReviewMemberV22; reviewToken: string; shareFragment: string }> {
  return json(await fetch(`/api/video/v22/rooms/${roomId}/members/${memberId}/rotate`, { method: 'POST', credentials: 'include' }))
}
export async function setReviewMemberActiveV22(roomId: string, memberId: string, active: boolean): Promise<ReviewRoomV22> {
  const form = new FormData(); form.append('active', String(active))
  return json(await fetch(`/api/video/v22/rooms/${roomId}/members/${memberId}/active`, { method: 'POST', body: form, credentials: 'include' }))
}
export async function setApprovalGateV22(roomId: string, minApprovals: number, blockOpenComments: boolean): Promise<ReviewRoomV22> {
  return json(await fetch(`/api/video/v22/rooms/${roomId}/approval-gate`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minApprovals, blockOpenComments }) }))
}
export async function startReviewV22(roomId: string): Promise<ReviewRoomV22> {
  return json(await fetch(`/api/video/v22/rooms/${roomId}/start-review`, { method: 'POST', credentials: 'include' }))
}
export async function resolveReviewCommentV22(roomId: string, commentId: string, resolved = true): Promise<ReviewRoomV22> {
  const form = new FormData(); form.append('resolved', String(resolved))
  return json(await fetch(`/api/video/v22/rooms/${roomId}/comments/${commentId}/resolve`, { method: 'POST', body: form, credentials: 'include' }))
}
export async function getApprovedDeliveryV22(roomId: string): Promise<Blob> {
  return blob(await fetch(`/api/video/v22/rooms/${roomId}/approved-delivery`, { credentials: 'include' }))
}
export async function archiveReviewRoomV22(roomId: string, archived: boolean): Promise<ReviewRoomV22> {
  const form = new FormData(); form.append('archived', String(archived))
  return json(await fetch(`/api/video/v22/rooms/${roomId}/archive`, { method: 'POST', body: form, credentials: 'include' }))
}
export async function deleteReviewRoomV22(roomId: string): Promise<void> {
  await json(await fetch(`/api/video/v22/rooms/${roomId}`, { method: 'DELETE', credentials: 'include' }))
}

function publicHeaders(token: string) { return { 'X-MAGHRABI-Review-Token': token } }
export async function getPublicReviewV22(roomId: string, token: string): Promise<ReviewRoomV22> {
  return json(await fetch(`/api/video/v22/review/${roomId}`, { headers: publicHeaders(token) }))
}
export async function getPublicReviewVideoV22(roomId: string, versionId: string, token: string): Promise<Blob> {
  return blob(await fetch(`/api/video/v22/review/${roomId}/versions/${versionId}/video`, { headers: publicHeaders(token) }))
}
export async function addPublicReviewCommentV22(roomId: string, token: string, payload: { versionId: string; time: number; text: string }): Promise<{ comment: ReviewCommentV22; approval: ApprovalV22 }> {
  return json(await fetch(`/api/video/v22/review/${roomId}/comments`, { method: 'POST', headers: { ...publicHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }))
}
export async function submitPublicReviewDecisionV22(roomId: string, token: string, payload: { versionId: string; decision: 'approved' | 'changes_requested'; note?: string }): Promise<{ decision: ReviewDecisionV22; approval: ApprovalV22; status: ReviewStatusV22 }> {
  return json(await fetch(`/api/video/v22/review/${roomId}/decision`, { method: 'POST', headers: { ...publicHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }))
}
