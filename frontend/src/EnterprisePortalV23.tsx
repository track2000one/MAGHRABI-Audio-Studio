import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, DoorOpen, Film, Loader2, LogIn, MessageSquare, RefreshCcw, ShieldCheck, ThumbsDown, ThumbsUp, Users } from 'lucide-react'
import {
  enterpriseStatusV23, loginV23, logoutV23, workspaceCommentV23, workspaceDecisionV23, workspaceRoomV23,
  workspaceRoomVideoV23, workspaceV23, V23Resource, V23Room, V23User,
} from './lib/enterpriseIdentityApi'

function clock(value:number) { const s=Math.max(0,Math.floor(value)); return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}` }

export default function EnterprisePortalV23() {
  const [user,setUser]=useState<V23User|null>(null)
  const [resources,setResources]=useState<V23Resource[]>([])
  const [email,setEmail]=useState('')
  const [password,setPassword]=useState('')
  const [busy,setBusy]=useState(true)
  const [error,setError]=useState<string|null>(null)
  const [room,setRoom]=useState<V23Room|null>(null)
  const [selectedRoomId,setSelectedRoomId]=useState<string|null>(null)
  const [versionId,setVersionId]=useState<string>('')
  const [videoUrl,setVideoUrl]=useState<string|null>(null)
  const [comment,setComment]=useState('')
  const [note,setNote]=useState('')
  const videoRef=useRef<HTMLVideoElement|null>(null)

  const refresh=async()=>{
    const status=await enterpriseStatusV23()
    if(!status.authenticated||!status.user){setUser(null);setResources([]);return}
    const data=await workspaceV23(); setUser(data.user);setResources(data.resources)
  }
  useEffect(()=>{refresh().catch(()=>undefined).finally(()=>setBusy(false))},[])
  useEffect(()=>()=>{if(videoUrl)URL.revokeObjectURL(videoUrl)},[videoUrl])

  const openRoom=async(id:string)=>{
    setBusy(true);setError(null)
    try{const next=await workspaceRoomV23(id);setRoom(next);setSelectedRoomId(id);setVersionId(next.activeVersionId||next.versions.at(-1)?.id||'')}
    catch(e){setError(e instanceof Error?e.message:'تعذر فتح Review Room.')}
    finally{setBusy(false)}
  }
  useEffect(()=>{
    if(!selectedRoomId||!versionId)return
    workspaceRoomVideoV23(selectedRoomId,versionId).then(blob=>{if(videoUrl)URL.revokeObjectURL(videoUrl);setVideoUrl(URL.createObjectURL(blob))}).catch(e=>setError(e instanceof Error?e.message:'تعذر فتح الفيديو.'))
  },[selectedRoomId,versionId])

  const login=async()=>{setBusy(true);setError(null);try{const data=await loginV23(email,password);setUser(data.user);await refresh()}catch(e){setError(e instanceof Error?e.message:'تعذر تسجيل الدخول.')}finally{setBusy(false)}}
  const logout=async()=>{await logoutV23().catch(()=>undefined);setUser(null);setResources([]);setRoom(null);setSelectedRoomId(null);if(videoUrl)URL.revokeObjectURL(videoUrl);setVideoUrl(null)}
  const refreshRoom=async()=>{if(selectedRoomId){const next=await workspaceRoomV23(selectedRoomId);setRoom(next)}}
  const addComment=async()=>{if(!room||!versionId||!comment.trim())return;setBusy(true);setError(null);try{await workspaceCommentV23(room.id,{versionId,time:videoRef.current?.currentTime||0,text:comment});setComment('');await refreshRoom()}catch(e){setError(e instanceof Error?e.message:'تعذر إضافة التعليق.')}finally{setBusy(false)}}
  const decide=async(decision:'approved'|'changes_requested')=>{if(!room||!versionId)return;setBusy(true);setError(null);try{await workspaceDecisionV23(room.id,{versionId,decision,note});setNote('');await refreshRoom()}catch(e){setError(e instanceof Error?e.message:'تعذر حفظ القرار.')}finally{setBusy(false)}}

  const rooms=useMemo(()=>resources.filter(r=>r.type==='v22_room'),[resources])
  const projects=useMemo(()=>resources.filter(r=>r.type==='v21_project'),[resources])

  if(busy&&!user)return <main className="grid min-h-screen place-items-center bg-[#05080d]"><Loader2 className="h-8 w-8 animate-spin text-cyan-300"/></main>
  if(!user)return <main className="grid min-h-screen place-items-center bg-[#05080d] p-5 text-slate-100" dir="rtl"><section className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0a1019] p-6"><div className="flex items-center gap-3"><Users className="h-7 w-7 text-cyan-300"/><div><p className="text-[10px] font-black tracking-[.3em] text-cyan-300">MAGHRABI CREATOR V23</p><h1 className="text-xl font-black">Team Workspace</h1></div></div><label className="mt-6 block text-xs font-black text-slate-400">البريد الإلكتروني<input value={email} onChange={e=>setEmail(e.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 p-3"/></label><label className="mt-3 block text-xs font-black text-slate-400">كلمة المرور<input type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')login()}} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 p-3"/></label><button onClick={login} disabled={busy||!email||!password} className="mt-5 w-full rounded-xl bg-cyan-300 p-3 text-xs font-black text-slate-950"><LogIn className="ml-1 inline h-4 w-4"/>تسجيل الدخول</button>{error&&<div className="mt-4 rounded-xl border border-rose-300/20 bg-rose-300/5 p-3 text-xs text-rose-200">{error}</div>}<a href="#video" className="mt-5 block text-center text-[10px] font-black text-slate-500">ADMIN / IDENTITY CONSOLE</a></section></main>

  return <main className="min-h-screen bg-[#05080d] text-slate-100" dir="rtl">
    <header className="border-b border-white/8 bg-[#080d15] px-5 py-4"><div className="mx-auto flex max-w-[1700px] flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><ShieldCheck className="h-7 w-7 text-cyan-300"/><div><p className="text-[10px] font-black tracking-[.3em] text-cyan-300">MAGHRABI ENTERPRISE</p><h1 className="text-lg font-black">{user.name} · {user.role.toUpperCase()}</h1></div></div><div className="flex gap-2"><button onClick={()=>refresh().catch(()=>undefined)} className="rounded-xl border border-white/10 px-3 py-2 text-xs"><RefreshCcw className="ml-1 inline h-4 w-4"/>REFRESH</button><button onClick={logout} className="rounded-xl border border-rose-300/20 px-3 py-2 text-xs text-rose-200"><DoorOpen className="ml-1 inline h-4 w-4"/>LOGOUT</button></div></div></header>
    <div className="mx-auto grid max-w-[1700px] gap-4 p-4 xl:grid-cols-[310px_minmax(0,1fr)_360px]">
      <aside className="space-y-4"><section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><h2 className="text-xs font-black">REVIEW ROOMS · {rooms.length}</h2><div className="mt-3 space-y-2">{rooms.map(item=><button key={item.id} onClick={()=>openRoom(item.id)} className={`w-full rounded-xl border p-3 text-right ${selectedRoomId===item.id?'border-cyan-300/40 bg-cyan-300/10':'border-white/7 bg-black/20'}`}><div className="text-[11px] font-black">{item.name}</div><div className="mt-1 flex justify-between text-[9px] text-slate-500"><span>{item.status}</span><span>{item.permission}</span></div></button>)}</div></section><section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><h2 className="text-xs font-black">PRODUCTION PROJECTS · {projects.length}</h2><div className="mt-3 space-y-2">{projects.map(item=><div key={item.id} className="rounded-xl border border-white/7 bg-black/20 p-3"><div className="text-[10px] font-black">{item.name}</div><div className="mt-1 text-[9px] text-slate-500">{item.status} · {item.permission}</div></div>)}</div></section></aside>
      <section className="rounded-3xl border border-white/8 bg-[#080d15] p-4"><div className="flex items-center justify-between"><div><p className="text-[9px] text-cyan-300">PROGRAM REVIEW</p><h2 className="font-black">{room?.name||'اختر Review Room'}</h2></div>{room&&<select value={versionId} onChange={e=>setVersionId(e.target.value)} className="rounded-xl border border-white/10 bg-black/30 p-2 text-xs">{room.versions.map(v=><option key={v.id} value={v.id}>V{v.number} · {v.label}</option>)}</select>}</div><div className="mt-4 aspect-video overflow-hidden rounded-2xl bg-black">{videoUrl?<video ref={videoRef} src={videoUrl} controls className="h-full w-full object-contain"/>:<div className="grid h-full place-items-center text-xs text-slate-600"><Film className="mb-2 h-8 w-8"/>No review media</div>}</div>{room&&<div className="mt-4 grid grid-cols-3 gap-2 text-center text-[10px]"><div className="rounded-xl bg-black/20 p-2">STATUS<br/><b>{room.status}</b></div><div className="rounded-xl bg-black/20 p-2">COMMENTS<br/><b>{room.comments.length}</b></div><div className="rounded-xl bg-black/20 p-2">ACCESS<br/><b>{room.permission}</b></div></div>}</section>
      <aside className="space-y-4"><section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center gap-2"><MessageSquare className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">TIMECODE COMMENTS</h2></div><textarea value={comment} onChange={e=>setComment(e.target.value)} placeholder="اكتب ملاحظة عند موضع التشغيل الحالي…" className="mt-3 min-h-24 w-full rounded-xl border border-white/10 bg-black/30 p-3 text-xs"/><button onClick={addComment} disabled={!room||busy||!comment.trim()||room.permission==='view'} className="mt-2 w-full rounded-xl bg-cyan-300 p-2.5 text-xs font-black text-slate-950 disabled:opacity-30">ADD @ {clock(videoRef.current?.currentTime||0)}</button><div className="mt-4 max-h-64 space-y-2 overflow-auto">{room?.comments.filter(c=>c.versionId===versionId).map(c=><button key={c.id} onClick={()=>{if(videoRef.current)videoRef.current.currentTime=c.time}} className="w-full rounded-xl border border-white/7 bg-black/20 p-3 text-right"><div className="flex justify-between text-[9px]"><b className="text-cyan-300">{clock(c.time)}</b><span className={c.status==='open'?'text-amber-300':'text-emerald-300'}>{c.status}</span></div><p className="mt-1 text-[10px] text-slate-300">{c.text}</p><p className="mt-1 text-[8px] text-slate-600">{c.authorName}</p></button>)}</div></section>
      {room&&['admin','producer','reviewer'].includes(user.role)&&room.permission!=='view'&&<section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><h2 className="text-xs font-black">REVIEW DECISION</h2><textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="ملاحظة القرار…" className="mt-3 min-h-20 w-full rounded-xl border border-white/10 bg-black/30 p-3 text-xs"/><div className="mt-2 grid grid-cols-2 gap-2"><button onClick={()=>decide('approved')} className="rounded-xl bg-emerald-300 p-2.5 text-xs font-black text-slate-950"><ThumbsUp className="ml-1 inline h-4 w-4"/>APPROVE</button><button onClick={()=>decide('changes_requested')} className="rounded-xl bg-rose-300 p-2.5 text-xs font-black text-slate-950"><ThumbsDown className="ml-1 inline h-4 w-4"/>CHANGES</button></div></section>}
      {error&&<div className="rounded-xl border border-rose-300/20 bg-rose-300/5 p-3 text-xs text-rose-200">{error}</div>}</aside>
    </div>
  </main>
}
