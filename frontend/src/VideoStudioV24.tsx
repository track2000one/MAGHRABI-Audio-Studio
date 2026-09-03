import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Database,
  KeyRound,
  Link2,
  Loader2,
  LockKeyhole,
  Mail,
  RefreshCcw,
  ServerCog,
  ShieldCheck,
  Trash2,
  UserCog,
  Users,
} from 'lucide-react'
import {
  addAclV24,
  createInviteV24,
  createResetLinkV24,
  createTeamV24,
  deleteAclV24,
  deleteTeamV24,
  getAdminOverviewV24,
  getInfoV24,
  setUserActiveV24,
  setUserRoleV24,
  V24AdminOverview,
  V24Info,
  V24Permission,
  V24Role,
} from './lib/enterpriseSecurityApi'

const roles: V24Role[] = ['admin', 'producer', 'editor', 'reviewer', 'viewer']
const permissions: V24Permission[] = ['view', 'review', 'edit', 'manage']

function fmtDate(value?: string | null) {
  if (!value) return '—'
  try { return new Date(value).toLocaleString('ar-SA') } catch { return value }
}

export default function VideoStudioV24() {
  const [info, setInfo] = useState<V24Info | null>(null)
  const [data, setData] = useState<V24AdminOverview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [invite, setInvite] = useState({ name: '', email: '', role: 'viewer' as V24Role, sendEmail: true })
  const [shareLink, setShareLink] = useState('')
  const [teamName, setTeamName] = useState('')
  const [teamMembers, setTeamMembers] = useState<string[]>([])
  const [acl, setAcl] = useState({ resourceType: 'v22_room', resourceId: '', principalType: 'user' as 'user' | 'team', principalId: '', permission: 'review' as V24Permission })

  const refresh = async (silent = false) => {
    if (!silent) setBusy('refresh')
    try {
      const [meta, overview] = await Promise.all([getInfoV24(), getAdminOverviewV24()])
      setInfo(meta); setData(overview); setError(null)
      if (!acl.resourceId && overview.resources[0]) setAcl(current => ({ ...current, resourceType: overview.resources[0].type, resourceId: overview.resources[0].id }))
      if (!acl.principalId && overview.users[0]) setAcl(current => ({ ...current, principalId: overview.users[0].id }))
    } catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'تعذر فتح Security Console.') }
    finally { if (!silent) setBusy(null) }
  }

  useEffect(() => { refresh().catch(() => undefined) }, [])

  const mfaPct = useMemo(() => {
    if (!data?.sessions.totalUsers) return 0
    return Math.round((data.sessions.mfaUsers / data.sessions.totalUsers) * 100)
  }, [data])

  const createInvite = async () => {
    if (!invite.name || !invite.email || busy) return
    setBusy('invite'); setError(null)
    try {
      const result = await createInviteV24(invite)
      const link = `${window.location.origin}/${result.shareFragment}`
      setShareLink(link)
      if (navigator.clipboard) await navigator.clipboard.writeText(link)
      setInvite(current => ({ ...current, name: '', email: '' }))
      await refresh(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إنشاء الدعوة.') }
    finally { setBusy(null) }
  }

  const createTeam = async () => {
    if (!teamName.trim() || busy) return
    setBusy('team')
    try { await createTeamV24(teamName.trim(), teamMembers); setTeamName(''); setTeamMembers([]); await refresh(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر إنشاء الفريق.') }
    finally { setBusy(null) }
  }

  const grantAcl = async () => {
    if (!acl.resourceId || !acl.principalId || busy) return
    setBusy('acl')
    try { await addAclV24(acl); await refresh(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر منح الصلاحية.') }
    finally { setBusy(null) }
  }

  if (!data && busy === 'refresh') return <div className="grid min-h-screen place-items-center bg-[#05080d]"><Loader2 className="h-8 w-8 animate-spin text-cyan-300" /></div>

  return <main className="min-h-screen bg-[#05080d] text-slate-100" dir="rtl">
    <header className="border-b border-white/8 bg-[#080d15] px-5 py-4">
      <div className="mx-auto flex max-w-[1750px] flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-black tracking-[.32em] text-cyan-300">MAGHRABI CREATOR V24</p>
          <h1 className="text-xl font-black">Enterprise Security & Infrastructure</h1>
        </div>
        <div className="flex gap-2">
          <a href="#secure" className="rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950">SECURE TEAM PORTAL</a>
          <a href="#video-v23" className="rounded-xl border border-white/10 px-4 py-2 text-xs font-black text-slate-300">V23 FALLBACK</a>
          <button onClick={() => refresh()} className="rounded-xl border border-white/10 p-2"><RefreshCcw className="h-4 w-4"/></button>
        </div>
      </div>
    </header>

    <div className="mx-auto max-w-[1750px] space-y-4 p-4">
      {error && <div className="rounded-2xl border border-rose-300/25 bg-rose-300/10 p-3 text-xs text-rose-200">{error}</div>}
      {info?.dbMode === 'sqlite' && <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs text-amber-100">
        V24 تعمل حاليًا على SQLite fallback. أضف DATABASE_URL من Railway PostgreSQL لتحويل Identity Store إلى PostgreSQL في الـDeployment التالي.
      </div>}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        {[
          [Database, 'IDENTITY DB', info?.dbMode?.toUpperCase() || '—', info?.databaseUrlConfigured ? 'DATABASE_URL configured' : 'fallback mode'],
          [ShieldCheck, 'MFA COVERAGE', `${mfaPct}%`, `${data?.sessions.mfaUsers || 0}/${data?.sessions.totalUsers || 0} users`],
          [ServerCog, 'ACTIVE SESSIONS', data?.sessions.active || 0, 'server-side sessions'],
          [Mail, 'SMTP', data?.email.configured ? 'READY' : 'OFF', 'invite/reset delivery'],
          [LockKeyhole, 'OIDC / SSO', data?.oidc.configured ? 'READY' : 'OFF', data?.oidc.issuer || 'not configured'],
          [Activity, 'AUDIT EVENTS', data?.audit.length || 0, 'latest loaded events'],
        ].map(([Icon, label, value, note]: any) => <div key={label} className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <Icon className="h-4 w-4 text-cyan-300"/><p className="mt-3 text-[8px] font-black tracking-[.16em] text-slate-600">{label}</p><p className="mt-1 text-xl font-black">{value}</p><p className="mt-1 truncate text-[8px] text-slate-600">{note}</p>
        </div>)}
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center gap-2"><UserCog className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">USERS & SESSION SECURITY</h2></div>
          <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[820px] text-right text-[10px]"><thead className="text-slate-600"><tr><th className="p-2">USER</th><th>ROLE</th><th>MFA</th><th>STATUS</th><th>LAST LOGIN</th><th>ACTIONS</th></tr></thead><tbody>
            {data?.users.map(user => <tr key={user.id} className="border-t border-white/5">
              <td className="p-2"><b>{user.name}</b><div className="text-[8px] text-slate-600">{user.email}</div></td>
              <td><select value={user.role} onChange={async e => { setBusy(`role-${user.id}`); try { await setUserRoleV24(user.id, e.target.value as V24Role); await refresh(true) } finally { setBusy(null) } }} className="rounded-lg bg-black/30 p-1.5">{roles.map(role => <option key={role}>{role}</option>)}</select></td>
              <td className={user.mfaEnabled ? 'text-emerald-300' : 'text-amber-300'}>{user.mfaEnabled ? 'ENABLED' : 'OFF'}</td>
              <td>{user.active ? 'ACTIVE' : 'DISABLED'}</td><td>{fmtDate(user.lastLoginAt)}</td>
              <td><div className="flex flex-wrap gap-1">
                <button onClick={async () => { await setUserActiveV24(user.id, !user.active); await refresh(true) }} className="rounded-lg border border-white/10 px-2 py-1">{user.active ? 'DISABLE' : 'ENABLE'}</button>
                <button onClick={async () => { const r = await createResetLinkV24(user.id, false); const link = `${window.location.origin}/${r.shareFragment}`; setShareLink(link); if (navigator.clipboard) await navigator.clipboard.writeText(link) }} className="rounded-lg border border-white/10 px-2 py-1">RESET LINK</button>
              </div></td>
            </tr>)}
          </tbody></table></div>
        </section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-fuchsia-300"/><h2 className="text-xs font-black">SECURE INVITATION</h2></div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2"><input placeholder="الاسم" value={invite.name} onChange={e => setInvite({ ...invite, name: e.target.value })} className="rounded-xl bg-black/30 p-2.5 text-xs"/><input placeholder="email@example.com" value={invite.email} onChange={e => setInvite({ ...invite, email: e.target.value })} className="rounded-xl bg-black/30 p-2.5 text-xs"/></div>
          <div className="mt-2 flex gap-2"><select value={invite.role} onChange={e => setInvite({ ...invite, role: e.target.value as V24Role })} className="flex-1 rounded-xl bg-black/30 p-2.5 text-xs">{roles.map(role => <option key={role}>{role}</option>)}</select><label className="flex items-center gap-2 rounded-xl border border-white/8 px-3 text-[9px]"><input type="checkbox" checked={invite.sendEmail} onChange={e => setInvite({ ...invite, sendEmail: e.target.checked })}/> SEND EMAIL</label></div>
          <button onClick={createInvite} disabled={!!busy} className="mt-3 w-full rounded-xl bg-fuchsia-300 px-3 py-2.5 text-xs font-black text-slate-950">CREATE INVITE</button>
          {shareLink && <div className="mt-3 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-3"><p className="break-all text-[9px] text-cyan-100">{shareLink}</p><button onClick={() => navigator.clipboard?.writeText(shareLink)} className="mt-2 rounded-lg border border-cyan-300/20 px-2 py-1 text-[9px]"><Link2 className="ml-1 inline h-3 w-3"/>COPY</button></div>}
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center gap-2"><Users className="h-4 w-4 text-emerald-300"/><h2 className="text-xs font-black">TEAMS</h2></div>
          <input value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="اسم الفريق" className="mt-3 w-full rounded-xl bg-black/30 p-2.5 text-xs"/>
          <div className="mt-2 max-h-36 overflow-auto rounded-xl border border-white/5 p-2">{data?.users.map(user => <label key={user.id} className="flex items-center gap-2 py-1 text-[9px]"><input type="checkbox" checked={teamMembers.includes(user.id)} onChange={e => setTeamMembers(current => e.target.checked ? [...current, user.id] : current.filter(id => id !== user.id))}/>{user.name} <span className="text-slate-600">{user.role}</span></label>)}</div>
          <button onClick={createTeam} className="mt-2 rounded-xl bg-emerald-300 px-3 py-2 text-[10px] font-black text-slate-950">CREATE TEAM</button>
          <div className="mt-3 space-y-2">{data?.teams.map(team => <div key={team.id} className="flex items-center justify-between rounded-xl border border-white/5 p-2 text-[9px]"><span><b>{team.name}</b> · {team.memberIds?.length || 0} members</span><button onClick={async () => { await deleteTeamV24(team.id); await refresh(true) }}><Trash2 className="h-3.5 w-3.5 text-rose-300"/></button></div>)}</div>
        </section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">PROJECT ACL</h2></div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <select value={`${acl.resourceType}:${acl.resourceId}`} onChange={e => { const [resourceType, resourceId] = e.target.value.split(':'); setAcl({ ...acl, resourceType, resourceId }) }} className="rounded-xl bg-black/30 p-2 text-[9px]">{data?.resources.map(resource => <option key={`${resource.type}:${resource.id}`} value={`${resource.type}:${resource.id}`}>{resource.type} · {resource.name}</option>)}</select>
            <select value={acl.principalType} onChange={e => setAcl({ ...acl, principalType: e.target.value as any, principalId: e.target.value === 'user' ? data?.users[0]?.id || '' : data?.teams[0]?.id || '' })} className="rounded-xl bg-black/30 p-2 text-[9px]"><option value="user">USER</option><option value="team">TEAM</option></select>
            <select value={acl.principalId} onChange={e => setAcl({ ...acl, principalId: e.target.value })} className="rounded-xl bg-black/30 p-2 text-[9px]">{(acl.principalType === 'user' ? data?.users : data?.teams)?.map((item: any) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <select value={acl.permission} onChange={e => setAcl({ ...acl, permission: e.target.value as V24Permission })} className="rounded-xl bg-black/30 p-2 text-[9px]">{permissions.map(permission => <option key={permission}>{permission}</option>)}</select>
          </div>
          <button onClick={grantAcl} className="mt-2 rounded-xl bg-cyan-300 px-3 py-2 text-[10px] font-black text-slate-950">GRANT / REPLACE</button>
          <div className="mt-3 max-h-48 space-y-1 overflow-auto">{data?.acl.map(entry => <div key={entry.id} className="flex items-center justify-between rounded-lg border border-white/5 p-2 text-[8px]"><span>{entry.resourceType} · {entry.permission} · {entry.principalType}:{entry.principalId}</span><button onClick={async () => { await deleteAclV24(entry.id); await refresh(true) }}><Trash2 className="h-3 w-3 text-rose-300"/></button></div>)}</div>
        </section>
      </div>

      <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
        <div className="flex items-center gap-2"><Activity className="h-4 w-4 text-amber-300"/><h2 className="text-xs font-black">AUDIT LOG</h2></div>
        <div className="mt-3 max-h-80 overflow-auto">{data?.audit.map(event => <div key={event.id} className="grid gap-1 border-t border-white/5 py-2 text-[9px] sm:grid-cols-[170px_170px_1fr]"><span className="text-slate-600">{fmtDate(event.createdAt)}</span><span>{event.actorName || 'system'} · {event.actorRole || '—'}</span><span className="font-bold text-slate-300">{event.action}</span></div>)}</div>
      </section>
    </div>
  </main>
}
