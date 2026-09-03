import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock3, Loader2, MessageSquare, Send, ShieldCheck, XCircle } from 'lucide-react'
import {
  addPublicReviewCommentV22,
  getPublicReviewV22,
  getPublicReviewVideoV22,
  ReviewRoomV22,
  submitPublicReviewDecisionV22,
} from './lib/reviewWorkflowApi'

function fmtTime(value: number) {
  const safe = Math.max(0, value || 0)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = Math.floor(safe % 60)
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`
}
function fmtDate(value?: string | null) {
  if (!value) return '—'
  try { return new Date(value).toLocaleString('ar-SA') } catch { return value }
}

export default function ReviewPortalV22({ roomId, token }: { roomId: string; token: string }) {
  const [room, setRoom] = useState<ReviewRoomV22 | null>(null)
  const [versionId, setVersionId] = useState('')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [decisionNote, setDecisionNote] = useState('')
  const [busy, setBusy] = useState<string | null>('loading')
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const refresh = async () => {
    const data = await getPublicReviewV22(roomId, token)
    setRoom(data)
    setVersionId(current => data.versions.some(v => v.id === current) ? current : data.activeVersionId || data.versions.at(-1)?.id || '')
    return data
  }

  useEffect(() => {
    setBusy('loading'); setError(null)
    refresh().catch(e => setError(e instanceof Error ? e.message : 'تعذر فتح رابط المراجعة.')).finally(() => setBusy(null))
  }, [roomId, token])

  useEffect(() => {
    let cancelled = false
    if (!versionId) { setVideoUrl(null); return }
    getPublicReviewVideoV22(roomId, versionId, token).then(blob => {
      if (cancelled) return
      setVideoUrl(previous => { if (previous) URL.revokeObjectURL(previous); return URL.createObjectURL(blob) })
    }).catch(e => setError(e instanceof Error ? e.message : 'تعذر تحميل الفيديو.'))
    return () => { cancelled = true }
  }, [roomId, token, versionId])

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl) }, [videoUrl])

  const sendComment = async () => {
    if (!room || !versionId || !comment.trim() || busy) return
    const time = videoRef.current?.currentTime || 0
    setBusy('comment'); setError(null)
    try {
      await addPublicReviewCommentV22(roomId, token, { versionId, time, text: comment })
      setComment(''); await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة التعليق.') }
    finally { setBusy(null) }
  }

  const decide = async (decision: 'approved' | 'changes_requested') => {
    if (!room || !versionId || busy) return
    setBusy(decision); setError(null)
    try {
      await submitPublicReviewDecisionV22(roomId, token, { versionId, decision, note: decisionNote })
      setDecisionNote(''); await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إرسال قرار المراجعة.') }
    finally { setBusy(null) }
  }

  if (busy === 'loading' && !room) return <div className="grid min-h-screen place-items-center bg-[#05080d]"><Loader2 className="h-8 w-8 animate-spin text-cyan-300"/></div>
  if (!room) return <div className="grid min-h-screen place-items-center bg-[#05080d] p-6 text-center text-rose-200">{error || 'رابط المراجعة غير صالح.'}</div>

  const viewer = room.viewer
  const canComment = viewer?.role === 'commenter' || viewer?.role === 'reviewer'
  const canDecide = viewer?.role === 'reviewer'
  const versionComments = room.comments.filter(item => item.versionId === versionId)
  const versionDecisions = room.decisions.filter(item => item.versionId === versionId)

  return <main className="min-h-screen bg-[#05080d] text-slate-100" dir="rtl">
    <header className="border-b border-white/8 bg-[#080d15] px-5 py-4">
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3">
        <div><p className="text-[10px] font-black tracking-[.3em] text-cyan-300">MAGHRABI REVIEW PORTAL</p><h1 className="text-xl font-black">{room.name}</h1></div>
        <div className="text-left"><p className="text-[10px] font-black text-slate-300">{viewer?.name}</p><p className="text-[9px] text-slate-600">Role · {viewer?.role}</p></div>
      </div>
    </header>

    <div className="mx-auto grid max-w-[1500px] gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_390px]">
      <section className="space-y-4">
        {error && <div className="rounded-2xl border border-rose-300/20 bg-rose-300/8 p-3 text-xs text-rose-200">{error}</div>}
        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><select value={versionId} onChange={e=>setVersionId(e.target.value)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs">{room.versions.map(v=><option key={v.id} value={v.id}>Version {v.number} · {v.label}{room.activeVersionId===v.id?' · ACTIVE':''}</option>)}</select><div className={`rounded-xl border px-3 py-2 text-[10px] font-black ${room.status==='approved'?'border-emerald-300/30 bg-emerald-300/10 text-emerald-200':room.status==='changes_requested'?'border-amber-300/30 bg-amber-300/10 text-amber-200':'border-cyan-300/25 bg-cyan-300/8 text-cyan-200'}`}>{room.status.toUpperCase()}</div></div>
          <div className="mt-4 aspect-video overflow-hidden rounded-2xl bg-black">{videoUrl && <video ref={videoRef} src={videoUrl} controls className="h-full w-full object-contain"/>}</div>
          <p className="mt-2 text-[9px] text-slate-600">ضع رأس التشغيل عند اللحظة المطلوبة ثم أضف Comment؛ سيُحفظ الـTimecode تلقائيًا.</p>
        </section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center gap-2"><MessageSquare className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">TIMECODE COMMENTS</h2></div>
          {canComment ? <div className="mt-3 flex gap-2"><input value={comment} onChange={e=>setComment(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')sendComment()}} placeholder="اكتب ملاحظتك عند الـTimecode الحالي..." className="min-w-0 flex-1 rounded-xl border border-white/8 bg-black/30 p-3 text-xs"/><button disabled={!!busy || !comment.trim()} onClick={sendComment} className="rounded-xl bg-cyan-300 px-4 text-slate-950"><Send className="h-4 w-4"/></button></div> : <div className="mt-3 rounded-xl border border-white/8 bg-black/20 p-3 text-[10px] text-slate-500">صلاحيتك Viewer فقط؛ يمكنك المشاهدة دون إضافة Comments.</div>}
          <div className="mt-4 space-y-2">{versionComments.slice().reverse().map(c=><button key={c.id} onClick={()=>{if(videoRef.current){videoRef.current.currentTime=c.time;videoRef.current.play().catch(()=>undefined)}}} className="flex w-full items-start gap-3 rounded-2xl border border-white/7 bg-black/20 p-3 text-right"><span className="rounded-lg bg-cyan-300/10 px-2 py-1 font-mono text-[10px] text-cyan-200"><Clock3 className="ml-1 inline h-3 w-3"/>{fmtTime(c.time)}</span><div className="min-w-0 flex-1"><p className="text-[11px] font-bold text-slate-200">{c.text}</p><p className="mt-1 text-[8px] text-slate-600">{c.authorName} · {fmtDate(c.createdAt)} · {c.status}</p></div></button>)}</div>
        </section>
      </section>

      <aside className="space-y-4">
        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-300"/><h2 className="text-xs font-black">APPROVAL STATUS</h2></div>
          <div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-xl bg-black/25 p-3"><p className="text-[8px] text-slate-600">APPROVALS</p><p className="text-xl font-black">{room.approval.approvals}/{room.approval.minApprovals}</p></div><div className="rounded-xl bg-black/25 p-3"><p className="text-[8px] text-slate-600">OPEN COMMENTS</p><p className="text-xl font-black">{room.approval.openComments}</p></div></div>
          {canDecide ? <><textarea value={decisionNote} onChange={e=>setDecisionNote(e.target.value)} placeholder="Decision note (optional)" className="mt-3 min-h-20 w-full rounded-xl border border-white/8 bg-black/30 p-3 text-xs"/><div className="mt-2 grid grid-cols-2 gap-2"><button disabled={!!busy} onClick={()=>decide('approved')} className="rounded-xl bg-emerald-300 px-3 py-3 text-[10px] font-black text-slate-950"><CheckCircle2 className="ml-1 inline h-4 w-4"/>APPROVE</button><button disabled={!!busy} onClick={()=>decide('changes_requested')} className="rounded-xl bg-amber-300 px-3 py-3 text-[10px] font-black text-slate-950"><XCircle className="ml-1 inline h-4 w-4"/>REQUEST CHANGES</button></div></> : <p className="mt-3 text-[9px] leading-5 text-slate-500">قرار الاعتماد متاح فقط لمن يحمل Role = Reviewer.</p>}
        </section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <h2 className="text-xs font-black">REVIEW DECISIONS</h2><div className="mt-3 space-y-2">{versionDecisions.map(d=><div key={d.id} className={`rounded-xl border p-3 ${d.decision==='approved'?'border-emerald-300/20 bg-emerald-300/5':'border-amber-300/20 bg-amber-300/5'}`}><p className="text-[10px] font-black">{d.memberName} · {d.decision}</p>{d.note && <p className="mt-1 text-[9px] text-slate-400">{d.note}</p>}<p className="mt-1 text-[8px] text-slate-600">{fmtDate(d.createdAt)}</p></div>)}</div>
        </section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4 text-[9px] leading-5 text-slate-500"><p className="font-black text-slate-300">Approval Gate</p><p>Minimum approvals: {room.approval.minApprovals}</p><p>Block on open comments: {room.approval.blockOpenComments ? 'Yes' : 'No'}</p><p className="mt-2">Final Delivery يبقى تحت تحكم مالك المشروع داخل Creator V22 بعد اجتياز Approval Gate.</p></section>
      </aside>
    </div>
  </main>
}
