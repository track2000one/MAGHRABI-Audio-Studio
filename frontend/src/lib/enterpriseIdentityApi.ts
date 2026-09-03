export type V23Role = 'admin' | 'producer' | 'editor' | 'reviewer' | 'viewer'
export type V23Permission = 'view' | 'review' | 'edit' | 'manage'
export type V23User = { id: string; name: string; email?: string | null; role: V23Role; status: string; active: boolean; createdAt?: string; lastLoginAt?: string | null; authVersion?: number }
export type V23Team = { id: string; name: string; memberIds: string[]; createdAt: string; updatedAt: string }
export type V23Resource = { type: 'v21_project' | 'v22_room'; id: string; name: string; status?: string; updatedAt?: string; permission?: V23Permission }
export type V23Acl = { id: string; resourceType: 'v21_project' | 'v22_room'; resourceId: string; principalType: 'user' | 'team'; principalId: string; permission: V23Permission; ownerUserId?: string | null; createdAt: string }
export type V23Audit = { id: string; actorId?: string; actorName?: string; actorRole?: string; action: string; details?: Record<string, unknown>; createdAt: string }
export type V23Room = { id: string; name: string; status: string; activeVersionId?: string | null; approval: Record<string, unknown>; versions: Array<{id:string; number:number; label:string; sourceName?:string; createdAt:string; notes?:string}>; comments: Array<{id:string; versionId:string; time:number; text:string; status:string; authorName:string; createdAt:string}>; decisions: Array<Record<string, unknown>>; permission?: V23Permission }

async function fail(response: Response): Promise<never> {
  try { const body = await response.json(); throw new Error(body.detail || 'تعذر تنفيذ عملية Creator V23.') }
  catch (error) { if (error instanceof Error) throw error; throw new Error('تعذر تنفيذ عملية Creator V23.') }
}
async function json<T>(response: Response): Promise<T> { if (!response.ok) return fail(response); return response.json() }
async function blob(response: Response): Promise<Blob> { if (!response.ok) return fail(response); return response.blob() }

export async function enterpriseStatusV23(): Promise<{authenticated:boolean; user:V23User|null; legacyAdmin:boolean; roles:V23Role[]}> {
  return json(await fetch('/api/video/v23/auth/status', { credentials: 'include' }))
}
export async function loginV23(email:string,password:string) { return json<{authenticated:boolean;user:V23User}>(await fetch('/api/video/v23/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})})) }
export async function logoutV23() { return json(await fetch('/api/video/v23/auth/logout',{method:'POST',credentials:'include'})) }
export async function inviteInfoV23(token:string) { return json<{name:string;email:string;role:V23Role;expiresAt:number}>(await fetch(`/api/video/v23/invite/${encodeURIComponent(token)}/info`)) }
export async function acceptInviteV23(token:string,password:string) { return json(await fetch(`/api/video/v23/invite/${encodeURIComponent(token)}/accept`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})})) }

export async function adminOverviewV23(): Promise<{users:V23User[];teams:V23Team[];acl:V23Acl[];resources:V23Resource[];audit:V23Audit[];roles:V23Role[];permissions:V23Permission[]}> {
  return json(await fetch('/api/video/v23/admin/overview',{credentials:'include'}))
}
export async function createInviteV23(payload:{name:string;email:string;role:V23Role}) { return json<{token:string;shareFragment:string;invite:Record<string,unknown>}>(await fetch('/api/video/v23/admin/invites',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})) }
export async function setUserRoleV23(id:string,role:V23Role) { const form=new FormData();form.append('role',role);return json<V23User>(await fetch(`/api/video/v23/admin/users/${id}/role`,{method:'POST',credentials:'include',body:form})) }
export async function setUserActiveV23(id:string,active:boolean) { const form=new FormData();form.append('active',String(active));return json<V23User>(await fetch(`/api/video/v23/admin/users/${id}/active`,{method:'POST',credentials:'include',body:form})) }
export async function createTeamV23(name:string,memberIds:string[]) { return json<V23Team>(await fetch('/api/video/v23/admin/teams',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,memberIds})})) }
export async function updateTeamV23(id:string,payload:{name?:string;memberIds?:string[]}) { return json<V23Team>(await fetch(`/api/video/v23/admin/teams/${id}`,{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})) }
export async function deleteTeamV23(id:string) { return json(await fetch(`/api/video/v23/admin/teams/${id}`,{method:'DELETE',credentials:'include'})) }
export async function addAclV23(payload:{resourceType:string;resourceId:string;principalType:'user'|'team';principalId:string;permission:V23Permission}) { return json<V23Acl>(await fetch('/api/video/v23/admin/acl',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})) }
export async function setOwnerV23(resourceType:string,resourceId:string,ownerUserId:string) { return json<V23Acl>(await fetch('/api/video/v23/admin/ownership',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({resourceType,resourceId,ownerUserId})})) }
export async function deleteAclV23(id:string) { return json(await fetch(`/api/video/v23/admin/acl/${id}`,{method:'DELETE',credentials:'include'})) }

export async function workspaceV23(): Promise<{user:V23User;resources:V23Resource[]}> { return json(await fetch('/api/video/v23/workspace',{credentials:'include'})) }
export async function workspaceRoomV23(id:string): Promise<V23Room> { return json(await fetch(`/api/video/v23/workspace/rooms/${id}`,{credentials:'include'})) }
export async function workspaceRoomVideoV23(roomId:string,versionId:string): Promise<Blob> { return blob(await fetch(`/api/video/v23/workspace/rooms/${roomId}/versions/${versionId}/video`,{credentials:'include'})) }
export async function workspaceCommentV23(roomId:string,payload:{versionId:string;time:number;text:string}) { return json(await fetch(`/api/video/v23/workspace/rooms/${roomId}/comments`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})) }
export async function workspaceDecisionV23(roomId:string,payload:{versionId:string;decision:'approved'|'changes_requested';note?:string}) { return json(await fetch(`/api/video/v23/workspace/rooms/${roomId}/decision`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})) }
