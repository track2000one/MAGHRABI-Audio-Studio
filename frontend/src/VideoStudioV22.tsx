import { ChangeEvent, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  CheckCircle2,
  Clipboard,
  Download,
  Eye,
  FileVideo2,
  History,
  Link2,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  UploadCloud,
  UserPlus,
  Users,
  XCircle,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import {
  addReviewMemberV22,
  addReviewVersionFromV21,
  archiveReviewRoomV22,
  createReviewRoomV22,
  deleteReviewRoomV22,
  getApprovedDeliveryV22,
  getReviewVideoV22,
  listReviewRoomsV22,
  listReviewSourcesV22,
  resolveReviewCommentV22,
  ReviewRoleV22,
  ReviewRoomV22,
  ReviewSourceV22,
  rotateReviewLinkV22,
  setActiveReviewVersionV22,
  setApprovalGateV22,
  setReviewMemberActiveV22,
  startReviewV22,
  uploadReviewVersionV22,
} from './lib/reviewWorkflowApi'

function fmtDate(value?: string | null) {
  if (!value) return '—'
  try { return new Date(value).toLocaleString('ar-SA') } catch { return value }
}
function fmtTime(value: number) {
  const safe = Math.max(0, value || 0)
  const m = Math.floor(safe / 60)
  const s = Math.floor(safe % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1200)
}
const statusTone: Record<string, string> = {
  draft: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
  in_review: 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200',
  changes_requested: 'border-amber-300/30 bg-amber-300/10 text-amber-200',
  approved: 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200',
}

export default function VideoStudioV22() {
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [sources, setSources] = useState<ReviewSourceV22[]>([])
  const [rooms, setRooms] = useState<ReviewRoomV22[]>([])
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null)
  const [sourceKey, setSourceKey] = useState('')
  const [roomName, setRoomName] = useState('MAGHRABI Review Room')
  const [minApprovals, setMinApprovals] = useState(1)
  const [blockOpenComments, setBlockOpenComments] = useState(false)
  const [memberName, setMemberName] = useState('')
  const [memberEmail, setMemberEmail] = useState('')
  const [memberRole, setMemberRole] = useState<ReviewRoleV22>('reviewer')
  const [shareLink, setShareLink] = useState('')
  const [versionLabel, setVersionLabel] = useState('')
  const [versionNotes, setVersionNotes] = useState('')
  const [compareA, setCompareA] = useState<string | null>(null)
  const [compareB, setCompareB] = useState<string | null>(null)
  const [videoA, setVideoA] = useState<string | null>(null)
  const [videoB, setVideoB] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (silent = false) => {
    if (!silent) setBusy('refresh')
    try {
      const [nextSources, nextRooms] = await Promise.all([listReviewSourcesV22(), listReviewRoomsV22(showArchived)])
      setSources(nextSources); setRooms(nextRooms)
      if (!selectedRoomId && nextRooms[0]) setSelectedRoomId(nextRooms[0].id)
    } catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'تعذر تحديث V22.') }
    finally { if (!silent) setBusy(null) }
  }

  useEffect(() => {
    getAuthStatus().then(s => setAuthorized(s.authenticated)).catch(() => setAuthorized(false))
    refresh(true).catch(() => undefined)
  }, [])
  useEffect(() => { refresh(true).catch(() => undefined) }, [showArchived])

  const room = useMemo(() => rooms.find(item => item.id === selectedRoomId) || null, [rooms, selectedRoomId])
  const selectedSource = useMemo(() => sources.find(item => `${item.projectId}:${item.itemId}` === sourceKey), [sources, sourceKey])

  useEffect(() => {
    if (!room) return
    setMinApprovals(room.approvalGate.minApprovals)
    setBlockOpenComments(room.approvalGate.blockOpenComments)
    const versions = room.versions
    if (!compareA || !versions.some(v => v.id === compareA)) setCompareA(room.activeVersionId || versions.at(-1)?.id || null)
    if (!compareB || !versions.some(v => v.id === compareB)) setCompareB(versions.length > 1 ? versions[versions.length - 2].id : room.activeVersionId || versions[0]?.id || null)
  }, [room?.id, room?.updatedAt])

  useEffect(() => {
    let cancelled = false
    const load = async (versionId: string | null, setter: (value: string | null) => void) => {
      if (!room || !versionId) { setter(null); return }
      try {
        const blob = await getReviewVideoV22(room.id, versionId)
        if (!cancelled) setter(URL.createObjectURL(blob))
      } catch { if (!cancelled) setter(null) }
    }
    if (videoA) URL.revokeObjectURL(videoA)
    if (videoB) URL.revokeObjectURL(videoB)
    load(compareA, setVideoA); load(compareB, setVideoB)
    return () => { cancelled = true }
  }, [room?.id, compareA, compareB])

  useEffect(() => () => {
    if (videoA) URL.revokeObjectURL(videoA)
    if (videoB) URL.revokeObjectURL(videoB)
  }, [videoA, videoB])

  const createRoom = async () => {
    if (!selectedSource || busy) return
    setBusy('create'); setError(null)
    try {
      const created = await createReviewRoomV22(selectedSource, { name: roomName, minApprovals, blockOpenComments })
      setSelectedRoomId(created.id); await refresh(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إنشاء Review Room.') }
    finally { setBusy(null) }
  }

  const addMember = async () => {
    if (!room || !memberName.trim() || busy) return
    setBusy('member'); setError(null)
    try {
      const data = await addReviewMemberV22(room.id, { name: memberName, email: memberEmail, role: memberRole })
      const full = `${window.location.origin}/${data.shareFragment}`
      setShareLink(full); setMemberName(''); setMemberEmail(''); await refresh(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة المراجع.') }
    finally { setBusy(null) }
  }

  const rotate = async (memberId: string) => {
    if (!room || busy) return
    setBusy(`rotate-${memberId}`)
    try {
      const data = await rotateReviewLinkV22(room.id, memberId)
      setShareLink(`${window.location.origin}/${data.shareFragment}`); await refresh(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تدوير رابط المراجعة.') }
    finally { setBusy(null) }
  }

  const copyShare = async () => {
    if (!shareLink) return
    try { await navigator.clipboard.writeText(shareLink) } catch { /* browser may deny clipboard */ }
  }

  const addFromV21 = async () => {
    if (!room || busy) return
    setBusy('version')
    try { await addReviewVersionFromV21(room.id, versionLabel, versionNotes); setVersionLabel(''); setVersionNotes(''); await refresh(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة Version من V21.') }
    finally { setBusy(null) }
  }

  const uploadVersion = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!room || !file || busy) return
    setBusy('upload-version')
    try { await uploadReviewVersionV22(room.id, file, versionLabel, versionNotes); setVersionLabel(''); setVersionNotes(''); await refresh(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر رفع Version.') }
    finally { setBusy(null) }
  }

  if (authorized === false) return <div className="min-h-screen bg-[#05080d] p-10 text-center text-slate-300">سجّل الدخول أولًا لفتح Creator V22.</div>
  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#05080d]"><Loader2 className="h-8 w-8 animate-spin text-cyan-300"/></div>

  return <main className="min-h-screen bg-[#05080d] text-slate-100" dir="rtl">
    <header className="border-b border-white/8 bg-[#080d15] px-5 py-4">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3">
        <div><p className="text-[10px] font-black tracking-[.32em] text-cyan-300">MAGHRABI CREATOR V22</p><h1 className="text-xl font-black">Team Review · Approval Workflow</h1></div>
        <div className="flex gap-2"><a href="#video-v21" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-black text-slate-300">V21 ORCHESTRATOR</a><button onClick={() => refresh()} className="rounded-xl border border-cyan-300/25 px-3 py-2 text-xs font-black text-cyan-200"><RefreshCcw className="ml-1 inline h-4 w-4"/>REFRESH</button></div>
      </div>
    </header>

    <div className="mx-auto grid max-w-[1800px] gap-4 p-4 xl:grid-cols-[330px_minmax(0,1fr)_390px]">
      <aside className="space-y-4">
        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <h2 className="text-xs font-black"><Plus className="ml-1 inline h-4 w-4 text-cyan-300"/>NEW REVIEW ROOM</h2>
          <select value={sourceKey} onChange={e => setSourceKey(e.target.value)} className="mt-3 w-full rounded-xl border border-white/8 bg-black/30 p-2.5 text-xs">
            <option value="">اختر نتيجة مكتملة من V21</option>
            {sources.map(s => <option key={`${s.projectId}:${s.itemId}`} value={`${s.projectId}:${s.itemId}`}>{s.projectName} · {s.sourceName}</option>)}
          </select>
          <input value={roomName} onChange={e => setRoomName(e.target.value)} className="mt-2 w-full rounded-xl border border-white/8 bg-black/30 p-2.5 text-xs" placeholder="Review Room name"/>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[9px]"><label>MIN APPROVALS<input type="number" min="1" max="20" value={minApprovals} onChange={e => setMinApprovals(Number(e.target.value))} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label><label className="flex items-end gap-2 rounded-lg bg-black/20 p-2"><input type="checkbox" checked={blockOpenComments} onChange={e => setBlockOpenComments(e.target.checked)}/> Block open comments</label></div>
          <button disabled={!selectedSource || !!busy} onClick={createRoom} className="mt-3 w-full rounded-xl bg-cyan-300 px-3 py-2.5 text-xs font-black text-slate-950">CREATE REVIEW ROOM</button>
        </section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center justify-between"><h2 className="text-xs font-black">REVIEW ROOMS</h2><label className="text-[9px] text-slate-500"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="ml-1"/>ARCHIVED</label></div>
          <div className="mt-3 space-y-2">{rooms.map(r => <button key={r.id} onClick={() => setSelectedRoomId(r.id)} className={`w-full rounded-2xl border p-3 text-right ${selectedRoomId === r.id ? 'border-cyan-300/40 bg-cyan-300/8' : 'border-white/7 bg-black/20'}`}><div className="flex items-center justify-between gap-2"><span className="truncate text-[11px] font-black">{r.name}</span><span className={`rounded-full border px-2 py-1 text-[8px] font-black ${statusTone[r.status]}`}>{r.status}</span></div><p className="mt-1 text-[9px] text-slate-600">V{r.versions.length} · {r.approval.approvals}/{r.approval.minApprovals} approvals · {r.approval.openComments} open</p></button>)}</div>
        </section>
      </aside>

      <section className="space-y-4">
        {error && <div className="rounded-2xl border border-rose-300/20 bg-rose-300/8 p-3 text-xs text-rose-200">{error}</div>}
        {!room ? <div className="grid min-h-[520px] place-items-center rounded-3xl border border-white/8 bg-[#0a1019] text-slate-600">اختر Review Room أو أنشئ واحدة.</div> : <>
          <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[9px] text-slate-500">REVIEW ROOM</p><h2 className="text-lg font-black">{room.name}</h2><p className="mt-1 text-[9px] text-slate-600">Updated {fmtDate(room.updatedAt)}</p></div><div className="flex flex-wrap gap-2"><span className={`rounded-xl border px-3 py-2 text-[10px] font-black ${statusTone[room.status]}`}>{room.status.toUpperCase()}</span><button onClick={async()=>{await startReviewV22(room.id); await refresh(true)}} className="rounded-xl border border-cyan-300/25 px-3 py-2 text-[10px] font-black text-cyan-200"><Eye className="ml-1 inline h-4 w-4"/>START REVIEW</button>{room.approval.gatePassed && <button onClick={async()=>downloadBlob(await getApprovedDeliveryV22(room.id), `MAGHRABI-APPROVED-${room.id.slice(0,8)}.mp4`)} className="rounded-xl bg-emerald-300 px-3 py-2 text-[10px] font-black text-slate-950"><Download className="ml-1 inline h-4 w-4"/>APPROVED DELIVERY</button>}</div></div>
            <div className="mt-4 grid gap-2 sm:grid-cols-4">{[['Approvals',`${room.approval.approvals}/${room.approval.minApprovals}`],['Changes',room.approval.changesRequested],['Open comments',room.approval.openComments],['Versions',room.versions.length]].map(([a,b])=><div key={String(a)} className="rounded-2xl bg-black/25 p-3"><p className="text-[8px] text-slate-600">{a}</p><p className="mt-1 text-lg font-black">{b}</p></div>)}</div>
          </section>

          <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex items-center gap-2"><FileVideo2 className="h-4 w-4 text-fuchsia-300"/><h2 className="text-xs font-black">VERSION COMPARISON</h2></div>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <div><select value={compareA || ''} onChange={e => setCompareA(e.target.value)} className="mb-2 w-full rounded-xl bg-black/30 p-2 text-xs">{room.versions.map(v=><option key={v.id} value={v.id}>A · V{v.number} · {v.label}</option>)}</select><div className="aspect-video overflow-hidden rounded-2xl bg-black">{videoA && <video src={videoA} controls className="h-full w-full object-contain"/>}</div></div>
              <div><select value={compareB || ''} onChange={e => setCompareB(e.target.value)} className="mb-2 w-full rounded-xl bg-black/30 p-2 text-xs">{room.versions.map(v=><option key={v.id} value={v.id}>B · V{v.number} · {v.label}</option>)}</select><div className="aspect-video overflow-hidden rounded-2xl bg-black">{videoB && <video src={videoB} controls className="h-full w-full object-contain"/>}</div></div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">{room.versions.map(v=><button key={v.id} onClick={async()=>{await setActiveReviewVersionV22(room.id,v.id);await refresh(true)}} className={`rounded-xl border px-3 py-2 text-[9px] font-black ${room.activeVersionId===v.id?'border-cyan-300/40 bg-cyan-300/10 text-cyan-200':'border-white/8 text-slate-400'}`}>V{v.number} {room.activeVersionId===v.id?'· ACTIVE':''}</button>)}</div>
            <div className="mt-4 grid gap-2 md:grid-cols-[1fr_1fr_auto_auto]"><input value={versionLabel} onChange={e=>setVersionLabel(e.target.value)} placeholder="Version label" className="rounded-xl bg-black/30 p-2 text-xs"/><input value={versionNotes} onChange={e=>setVersionNotes(e.target.value)} placeholder="Notes" className="rounded-xl bg-black/30 p-2 text-xs"/><button onClick={addFromV21} disabled={!!busy} className="rounded-xl border border-fuchsia-300/25 px-3 py-2 text-[9px] font-black text-fuchsia-200">SNAPSHOT LATEST V21</button><label className="cursor-pointer rounded-xl border border-white/10 px-3 py-2 text-center text-[9px] font-black"><UploadCloud className="ml-1 inline h-4 w-4"/>UPLOAD VERSION<input type="file" accept="video/*" onChange={uploadVersion} className="hidden"/></label></div>
          </section>

          <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex items-center gap-2"><MessageSquare className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">TIMECODE COMMENTS</h2></div>
            <div className="mt-3 space-y-2">{room.comments.slice().reverse().map(c=><div key={c.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/7 bg-black/20 p-3"><span className="rounded-lg bg-black/40 px-2 py-1 font-mono text-[10px] text-cyan-200">{fmtTime(c.time)}</span><div className="min-w-0 flex-1"><p className="text-[10px] font-bold">{c.text}</p><p className="mt-1 text-[8px] text-slate-600">{c.authorName} · {fmtDate(c.createdAt)} · {c.status}</p></div><button onClick={async()=>{await resolveReviewCommentV22(room.id,c.id,c.status==='open');await refresh(true)}} className="rounded-lg border border-white/8 px-2 py-1 text-[8px] font-black">{c.status==='open'?'RESOLVE':'REOPEN'}</button></div>)}</div>
          </section>
        </>}
      </section>

      <aside className="space-y-4">
        {room && <>
          <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-300"/><h2 className="text-xs font-black">APPROVAL GATE</h2></div>
            <label className="mt-3 block text-[9px]">MIN APPROVALS<input type="number" min="1" max="20" value={minApprovals} onChange={e=>setMinApprovals(Number(e.target.value))} className="mt-1 w-full rounded-xl bg-black/30 p-2"/></label>
            <label className="mt-2 flex gap-2 rounded-xl bg-black/20 p-2 text-[9px]"><input type="checkbox" checked={blockOpenComments} onChange={e=>setBlockOpenComments(e.target.checked)}/> منع Final Delivery عند وجود Comments مفتوحة</label>
            <button onClick={async()=>{await setApprovalGateV22(room.id,minApprovals,blockOpenComments);await refresh(true)}} className="mt-3 w-full rounded-xl border border-emerald-300/25 px-3 py-2 text-[9px] font-black text-emerald-200">SAVE APPROVAL GATE</button>
          </section>

          <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex items-center gap-2"><Users className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">REVIEW MEMBERS</h2></div>
            <div className="mt-3 grid gap-2"><input value={memberName} onChange={e=>setMemberName(e.target.value)} placeholder="Name" className="rounded-xl bg-black/30 p-2 text-xs"/><input value={memberEmail} onChange={e=>setMemberEmail(e.target.value)} placeholder="Email / note (optional)" className="rounded-xl bg-black/30 p-2 text-xs"/><select value={memberRole} onChange={e=>setMemberRole(e.target.value as ReviewRoleV22)} className="rounded-xl bg-black/30 p-2 text-xs"><option value="reviewer">Reviewer · comment + decision</option><option value="commenter">Commenter · comment only</option><option value="viewer">Viewer · view only</option></select><button onClick={addMember} className="rounded-xl bg-cyan-300 px-3 py-2 text-[9px] font-black text-slate-950"><UserPlus className="ml-1 inline h-4 w-4"/>ADD + CREATE LINK</button></div>
            {shareLink && <div className="mt-3 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-2"><p className="break-all text-[8px] text-cyan-100">{shareLink}</p><button onClick={copyShare} className="mt-2 rounded-lg border border-cyan-300/25 px-2 py-1 text-[8px] font-black"><Clipboard className="ml-1 inline h-3 w-3"/>COPY LINK</button></div>}
            <div className="mt-3 space-y-2">{room.members.map(m=><div key={m.id} className="rounded-xl border border-white/7 bg-black/20 p-2"><div className="flex items-center justify-between gap-2"><div><p className="text-[10px] font-black">{m.name}</p><p className="text-[8px] text-slate-600">{m.role} · link ••••{m.tokenLast4}</p></div><div className="flex gap-1"><button onClick={()=>rotate(m.id)} title="Rotate link" className="rounded-lg border border-white/8 p-1.5"><RotateCcw className="h-3 w-3"/></button><button onClick={async()=>{await setReviewMemberActiveV22(room.id,m.id,!m.active);await refresh(true)}} title="Toggle access" className="rounded-lg border border-white/8 p-1.5">{m.active?<CheckCircle2 className="h-3 w-3 text-emerald-300"/>:<XCircle className="h-3 w-3 text-rose-300"/>}</button></div></div></div>)}</div>
          </section>

          <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex items-center gap-2"><History className="h-4 w-4 text-slate-400"/><h2 className="text-xs font-black">ACTIVITY LOG</h2></div>
            <div className="mt-3 max-h-72 space-y-2 overflow-auto">{room.activity?.map(a=><div key={a.id} className="border-r border-white/10 pr-2 text-[8px]"><p className="font-black text-slate-300">{a.action}</p><p className="text-slate-600">{a.actor} · {fmtDate(a.createdAt)}</p></div>)}</div>
          </section>

          <section className="flex gap-2"><button onClick={async()=>{await archiveReviewRoomV22(room.id,!room.archived);await refresh(true)}} className="flex-1 rounded-xl border border-amber-300/20 px-3 py-2 text-[9px] font-black text-amber-200"><Archive className="ml-1 inline h-4 w-4"/>{room.archived?'RESTORE':'ARCHIVE'}</button><button onClick={async()=>{if(confirm('Delete Review Room?')){await deleteReviewRoomV22(room.id);setSelectedRoomId(null);await refresh(true)}}} className="rounded-xl border border-rose-300/20 px-3 py-2 text-[9px] font-black text-rose-200">DELETE</button></section>
        </>}
      </aside>
    </div>
  </main>
}
