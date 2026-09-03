import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  MessageSquare,
  MonitorSmartphone,
  RefreshCcw,
  ShieldCheck,
  UserRoundCheck,
  XCircle,
} from 'lucide-react'
import {
  addReviewCommentV24,
  confirmMfaV24,
  disableMfaV24,
  forgotPasswordV24,
  getInfoV24,
  getMeV24,
  getResourcesV24,
  getReviewRoomV24,
  getReviewVideoV24,
  getStatusV24,
  loginV24,
  logoutV24,
  reviewDecisionV24,
  revokeOtherSessionsV24,
  revokeSessionV24,
  setupMfaV24,
  V24Info,
  V24Resource,
  V24Session,
  V24User,
} from './lib/enterpriseSecurityApi'

function fmtDate(value?: string | null) {
  if (!value) return '—'
  try { return new Date(value).toLocaleString('ar-SA') } catch { return value }
}

export default function SecurePortalV24() {
  const [info, setInfo] = useState<V24Info | null>(null)
  const [user, setUser] = useState<V24User | null>(null)
  const [sessions, setSessions] = useState<V24Session[]>([])
  const [resources, setResources] = useState<V24Resource[]>([])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [mfaRequired, setMfaRequired] = useState(false)
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; otpauthUri: string } | null>(null)
  const [mfaCode, setMfaCode] = useState('')
  const [disablePassword, setDisablePassword] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [busy, setBusy] = useState<string | null>('boot')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [room, setRoom] = useState<any>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [reviewNote, setReviewNote] = useState('')
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const refresh = async () => {
    const status = await getStatusV24()
    setUser(status.user || null)
    if (status.authenticated) {
      const [me, access] = await Promise.all([getMeV24(), getResourcesV24()])
      setSessions(me.sessions); setResources(access.resources)
    } else {
      setSessions([]); setResources([]); setRoom(null)
    }
  }

  useEffect(() => {
    Promise.all([getInfoV24(), refresh()]).then(([meta]) => setInfo(meta)).catch(e => setError(e instanceof Error ? e.message : 'تعذر فتح Secure Portal.')).finally(() => setBusy(null))
    return () => { if (videoUrl) URL.revokeObjectURL(videoUrl) }
  }, [])

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl) }, [videoUrl])

  const roomResources = useMemo(() => resources.filter(item => item.type === 'v22_room'), [resources])

  const login = async () => {
    if (!email || !password || busy) return
    setBusy('login'); setError(null); setNotice(null)
    try {
      const result = await loginV24(email, password, otp)
      if (result.mfaRequired) { setMfaRequired(true); setNotice(result.message || 'أدخل رمز MFA.') }
      else { setMfaRequired(false); setOtp(''); setPassword(''); await refresh() }
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تسجيل الدخول.') }
    finally { setBusy(null) }
  }

  const openRoom = async (resource: V24Resource) => {
    setBusy(`room-${resource.id}`); setError(null)
    try {
      const meta = await getReviewRoomV24(resource.id)
      const blob = await getReviewVideoV24(resource.id, meta.activeVersionId)
      if (videoUrl) URL.revokeObjectURL(videoUrl)
      setVideoUrl(URL.createObjectURL(blob)); setRoom(meta)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر فتح Review Room.') }
    finally { setBusy(null) }
  }

  if (busy === 'boot') return <div className="grid min-h-screen place-items-center bg-[#05080d]"><Loader2 className="h-8 w-8 animate-spin text-cyan-300"/></div>

  if (!user) return <main className="grid min-h-screen place-items-center bg-[#05080d] p-5 text-slate-100" dir="rtl">
    <section className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0a1019] p-6 shadow-2xl">
      <p className="text-[10px] font-black tracking-[.3em] text-cyan-300">MAGHRABI V24</p>
      <h1 className="mt-2 text-2xl font-black">Secure Team Portal</h1>
      <p className="mt-2 text-xs leading-6 text-slate-500">جلسات server-side، MFA، CSRF وACL مؤسسية.</p>
      {error && <div className="mt-4 rounded-xl border border-rose-300/20 bg-rose-300/10 p-3 text-xs text-rose-200">{error}</div>}
      {notice && <div className="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-300/10 p-3 text-xs text-cyan-100">{notice}</div>}
      <input value={email} onChange={e => setEmail(e.target.value)} placeholder="البريد الإلكتروني" className="mt-5 w-full rounded-xl bg-black/30 p-3 text-sm"/>
      <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="كلمة المرور" className="mt-2 w-full rounded-xl bg-black/30 p-3 text-sm"/>
      {mfaRequired && <input inputMode="numeric" maxLength={6} value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ''))} placeholder="رمز Authenticator" className="mt-2 w-full rounded-xl border border-cyan-300/20 bg-black/30 p-3 text-center text-lg tracking-[.35em]"/>}
      <button onClick={login} disabled={!!busy} className="mt-3 w-full rounded-xl bg-cyan-300 p-3 text-xs font-black text-slate-950"><LogIn className="ml-1 inline h-4 w-4"/>SIGN IN</button>
      <div className="mt-3 flex items-center justify-between gap-2 text-[10px]">
        <button onClick={async () => { if (!email) return; const r = await forgotPasswordV24(email); setNotice(r.message) }} className="text-slate-400 hover:text-slate-200">نسيت كلمة المرور؟</button>
        {info?.oidc.configured && <button onClick={() => { window.location.href = '/api/video/v24/oidc/start' }} className="rounded-lg border border-white/10 px-2 py-1.5 text-cyan-200">SSO / OIDC</button>}
      </div>
      <a href="#video" className="mt-5 block text-center text-[9px] text-slate-600">Security Console</a>
    </section>
  </main>

  return <main className="min-h-screen bg-[#05080d] text-slate-100" dir="rtl">
    <header className="border-b border-white/8 bg-[#080d15] px-5 py-4">
      <div className="mx-auto flex max-w-[1650px] flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] font-black tracking-[.3em] text-cyan-300">SECURE TEAM PORTAL</p><h1 className="text-xl font-black">{user.name} · {user.role.toUpperCase()}</h1></div><div className="flex gap-2"><button onClick={() => refresh()} className="rounded-xl border border-white/10 p-2"><RefreshCcw className="h-4 w-4"/></button><button onClick={async () => { await logoutV24(); setUser(null) }} className="rounded-xl border border-rose-300/20 px-3 py-2 text-xs text-rose-200"><LogOut className="ml-1 inline h-4 w-4"/>LOGOUT</button></div></div>
    </header>
    <div className="mx-auto grid max-w-[1650px] gap-4 p-4 xl:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="space-y-4">
        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">ACCOUNT SECURITY</h2></div>
          <div className="mt-3 rounded-xl border border-white/5 p-3 text-[10px]"><b>{user.email}</b><p className="mt-1 text-slate-600">MFA: <span className={user.mfaEnabled ? 'text-emerald-300' : 'text-amber-300'}>{user.mfaEnabled ? 'ENABLED' : 'OFF'}</span></p></div>
          {!user.mfaEnabled && !mfaSetup && <button onClick={async () => setMfaSetup(await setupMfaV24())} className="mt-2 w-full rounded-xl bg-cyan-300 px-3 py-2 text-[10px] font-black text-slate-950"><KeyRound className="ml-1 inline h-3.5 w-3.5"/>SETUP MFA</button>}
          {mfaSetup && <div className="mt-3 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-3 text-[9px]"><p className="break-all font-mono text-cyan-100">{mfaSetup.secret}</p><p className="mt-2 break-all text-[8px] text-slate-500">{mfaSetup.otpauthUri}</p><input value={mfaCode} onChange={e => setMfaCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" className="mt-2 w-full rounded-lg bg-black/30 p-2 text-center"/><button onClick={async () => { await confirmMfaV24(mfaCode); setMfaSetup(null); setMfaCode(''); await refresh() }} className="mt-2 w-full rounded-lg bg-emerald-300 p-2 font-black text-slate-950">CONFIRM MFA</button></div>}
          {user.mfaEnabled && <details className="mt-3"><summary className="cursor-pointer text-[9px] text-slate-500">تعطيل MFA</summary><input type="password" value={disablePassword} onChange={e => setDisablePassword(e.target.value)} placeholder="كلمة المرور" className="mt-2 w-full rounded-lg bg-black/30 p-2 text-[9px]"/><input value={disableCode} onChange={e => setDisableCode(e.target.value)} placeholder="رمز MFA" className="mt-1 w-full rounded-lg bg-black/30 p-2 text-[9px]"/><button onClick={async () => { await disableMfaV24(disablePassword, disableCode); setDisablePassword(''); setDisableCode(''); await refresh() }} className="mt-2 rounded-lg border border-rose-300/20 px-2 py-1.5 text-[9px] text-rose-200">DISABLE MFA</button></details>}
        </section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center gap-2"><MonitorSmartphone className="h-4 w-4 text-fuchsia-300"/><h2 className="text-xs font-black">SESSIONS</h2></div>
          <button onClick={async () => { await revokeOtherSessionsV24(); await refresh() }} className="mt-2 rounded-lg border border-white/10 px-2 py-1.5 text-[9px]">REVOKE OTHER SESSIONS</button>
          <div className="mt-3 space-y-2">{sessions.map(session => <div key={session.id} className="rounded-xl border border-white/5 p-2 text-[8px]"><div className="flex items-center justify-between"><b>{session.current ? 'CURRENT DEVICE' : session.ip || 'SESSION'}</b>{!session.revoked && <button onClick={async () => { await revokeSessionV24(session.id); await refresh() }} className="text-rose-300">REVOKE</button>}</div><p className="mt-1 truncate text-slate-600">{session.userAgent}</p><p className="text-slate-700">{fmtDate(session.lastSeenAt)}</p></div>)}</div>
        </section>
      </aside>

      <section className="space-y-4">
        {error && <div className="rounded-xl border border-rose-300/20 bg-rose-300/10 p-3 text-xs text-rose-200">{error}</div>}
        <div className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center gap-2"><UserRoundCheck className="h-4 w-4 text-emerald-300"/><h2 className="text-xs font-black">AUTHORIZED RESOURCES</h2></div><div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{resources.map(resource => <button key={`${resource.type}:${resource.id}`} onClick={() => resource.type === 'v22_room' ? openRoom(resource) : undefined} className="rounded-2xl border border-white/7 bg-black/20 p-3 text-right"><p className="text-[8px] font-black text-cyan-300">{resource.type} · {resource.permission}</p><p className="mt-1 text-xs font-bold">{resource.name}</p><p className="mt-1 text-[8px] text-slate-600">{resource.status}</p></button>)}</div>{!resources.length && <p className="mt-4 text-xs text-slate-600">لا توجد موارد ممنوحة لهذا الحساب حتى الآن.</p>}</div>

        {room && <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center justify-between"><h2 className="text-xs font-black">{room.name}</h2><span className="rounded-lg border border-white/10 px-2 py-1 text-[8px]">{room.permission} · {room.status}</span></div>{videoUrl && <video ref={videoRef} src={videoUrl} controls className="mt-3 aspect-video w-full rounded-2xl bg-black"/>}<div className="mt-3 flex gap-2"><input value={comment} onChange={e => setComment(e.target.value)} placeholder="تعليق عند الـTimecode الحالي" className="flex-1 rounded-xl bg-black/30 p-2.5 text-xs"/><button onClick={async () => { if (!comment.trim()) return; await addReviewCommentV24(room.id, { versionId: room.activeVersionId, time: videoRef.current?.currentTime || 0, text: comment }); setComment(''); setRoom(await getReviewRoomV24(room.id)) }} className="rounded-xl bg-cyan-300 px-3 text-[10px] font-black text-slate-950"><MessageSquare className="ml-1 inline h-3.5 w-3.5"/>COMMENT</button></div></section>
          <aside className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><p className="text-[9px] font-black text-slate-500">APPROVAL</p><div className="mt-2 grid grid-cols-3 gap-2 text-center text-[9px]"><div className="rounded-xl bg-black/25 p-2">{room.approval.approvals}<br/><span className="text-slate-600">APPROVE</span></div><div className="rounded-xl bg-black/25 p-2">{room.approval.changesRequested}<br/><span className="text-slate-600">CHANGES</span></div><div className="rounded-xl bg-black/25 p-2">{room.approval.openComments}<br/><span className="text-slate-600">OPEN</span></div></div><textarea value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder="ملاحظة القرار" className="mt-3 h-20 w-full rounded-xl bg-black/30 p-2 text-[10px]"/>{['admin','producer','reviewer'].includes(user.role) && <div className="mt-2 grid grid-cols-2 gap-2"><button onClick={async () => { await reviewDecisionV24(room.id, { versionId: room.activeVersionId, decision: 'approved', note: reviewNote }); setRoom(await getReviewRoomV24(room.id)) }} className="rounded-xl bg-emerald-300 p-2 text-[9px] font-black text-slate-950"><CheckCircle2 className="ml-1 inline h-3.5 w-3.5"/>APPROVE</button><button onClick={async () => { await reviewDecisionV24(room.id, { versionId: room.activeVersionId, decision: 'changes_requested', note: reviewNote }); setRoom(await getReviewRoomV24(room.id)) }} className="rounded-xl bg-rose-300 p-2 text-[9px] font-black text-slate-950"><XCircle className="ml-1 inline h-3.5 w-3.5"/>CHANGES</button></div>}<div className="mt-4 max-h-60 space-y-2 overflow-auto">{room.comments?.map((item: any) => <div key={item.id} className="rounded-xl border border-white/5 p-2 text-[9px]"><b>{item.authorName}</b> · {Number(item.time || 0).toFixed(1)}s<p className="mt-1 text-slate-400">{item.text}</p></div>)}</div></aside>
        </div>}
      </section>
    </div>
  </main>
}
