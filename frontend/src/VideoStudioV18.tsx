import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, Download, Eye, Film, Loader2, ScanSearch, Sparkles, Subtitles, UploadCloud, Users, WandSparkles } from 'lucide-react'
import { getAuthStatus } from './lib/api'
import { inspectSourceV15, SourceInspectionV15 } from './lib/advancedFinishingApi'
import { getVideoRenderResultV12, listVideoRenderJobsV12 } from './lib/videoApi'
import { TrackingBoxV17, TrackingResultV17 } from './lib/trackingApi'
import {
  DetectionCandidateV18,
  motionCandidatesV18,
  MultiTrackResultV18,
  multiBlurV18,
  multiReframeV18,
  multiTrackV18,
  SttCapabilityV18,
  SttResultV18,
  sttCapabilityV18,
  transcribeV18,
} from './lib/intelligenceApi'

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)) }
function timeLabel(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const minutes = Math.floor(safe / 60)
  return `${String(minutes).padStart(2, '0')}:${(safe - minutes * 60).toFixed(2).padStart(5, '0')}`
}
function srtTime(seconds: number) {
  const safe = Math.max(0, seconds)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = Math.floor(safe % 60)
  const ms = Math.round((safe - Math.floor(safe)) * 1000)
  return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')},${String(ms).padStart(3,'0')}`
}

export default function VideoStudioV18() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [inspection, setInspection] = useState<SourceInspectionV15 | null>(null)
  const [sourceLabel, setSourceLabel] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [candidates, setCandidates] = useState<DetectionCandidateV18[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [trackStart, setTrackStart] = useState(0)
  const [trackEnd, setTrackEnd] = useState(30)
  const [trackFps, setTrackFps] = useState(5)
  const [searchRadius, setSearchRadius] = useState(.09)
  const [multiTrack, setMultiTrack] = useState<MultiTrackResultV18 | null>(null)
  const [blurIntensity, setBlurIntensity] = useState(.72)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultBlob, setResultBlob] = useState<Blob | null>(null)
  const [resultName, setResultName] = useState('MAGHRABI-v18-result.mp4')
  const [stt, setStt] = useState<SttCapabilityV18 | null>(null)
  const [sttResult, setSttResult] = useState<SttResultV18 | null>(null)
  const [language, setLanguage] = useState('ar')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getAuthStatus().then((status) => setAuthorized(status.authenticated)).catch(() => setAuthorized(false))
    sttCapabilityV18().then(setStt).catch(() => setStt({ configured: false, provider: null }))
  }, [])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); if (resultUrl) URL.revokeObjectURL(resultUrl) }, [url, resultUrl])

  const duration = inspection?.duration || 0
  const aspectRatio = inspection?.color.width && inspection?.color.height ? `${inspection.color.width} / ${inspection.color.height}` : '16 / 9'
  const selectedCandidates = useMemo(() => selected.map((index) => candidates[index]).filter(Boolean).slice(0, 4), [selected, candidates])

  const useSource = async (next: File, label?: string) => {
    if (url) URL.revokeObjectURL(url)
    const objectUrl = URL.createObjectURL(next)
    setFile(next); setUrl(objectUrl); setSourceLabel(label || next.name); setCandidates([]); setSelected([]); setMultiTrack(null); setSttResult(null); setCurrentTime(0); setError(null)
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    setResultUrl(null); setResultBlob(null); setBusy('inspect')
    try {
      const info = await inspectSourceV15(next)
      setInspection(info)
      setTrackStart(0)
      setTrackEnd(Math.min(30, info.duration))
    } catch (e) { setInspection(null); setError(e instanceof Error ? e.message : 'تعذر فحص المصدر.') }
    finally { setBusy(null) }
  }

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0]
    if (next) useSource(next).catch(() => undefined)
    event.target.value = ''
  }

  const loadLatest = async () => {
    if (busy) return
    setBusy('latest'); setError(null)
    try {
      const jobs = await listVideoRenderJobsV12()
      const job = jobs.find((item) => item.status === 'done' && item.resultReady)
      if (!job) throw new Error('لا توجد نتيجة Render مكتملة في Server Queue.')
      const blob = await getVideoRenderResultV12(job.id)
      await useSource(new File([blob], `V17-edit-${job.id.slice(0,8)}.mp4`, { type: 'video/mp4' }), `Latest Edit · ${job.name}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل آخر Render.') }
    finally { setBusy(null) }
  }

  const detectFaces = async () => {
    if (!videoRef.current || !inspection?.color.width || !inspection.color.height || busy) return
    setError(null)
    const FaceDetectorCtor = (window as unknown as { FaceDetector?: new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => { detect: (source: CanvasImageSource) => Promise<Array<{ boundingBox: DOMRectReadOnly }>> } }).FaceDetector
    if (!FaceDetectorCtor) {
      setError('FaceDetector غير مدعوم في هذا المتصفح. استخدم MOTION DETECT أو افتح المنصة في Chrome/Edge بإصدار يدعم Shape Detection.')
      return
    }
    setBusy('faces')
    try {
      const detector = new FaceDetectorCtor({ fastMode: true, maxDetectedFaces: 8 })
      const detections = await detector.detect(videoRef.current)
      const vw = Math.max(1, videoRef.current.videoWidth)
      const vh = Math.max(1, videoRef.current.videoHeight)
      const next = detections.slice(0, 8).map((item, index): DetectionCandidateV18 => {
        const padX = item.boundingBox.width * .28
        const padY = item.boundingBox.height * .45
        const x = clamp((item.boundingBox.x - padX) / vw, 0, .97)
        const y = clamp((item.boundingBox.y - padY) / vh, 0, .97)
        const width = clamp((item.boundingBox.width + padX * 2) / vw, .04, 1 - x)
        const height = clamp((item.boundingBox.height + padY * 2) / vh, .04, 1 - y)
        return { x, y, width, height, confidence: 1, kind: 'face', label: `FACE ${index + 1}` }
      })
      setCandidates(next); setSelected(next.map((_, index) => index).slice(0, 4)); setMultiTrack(null)
      if (!next.length) setError('لم يتم اكتشاف وجه واضح في الفريم الحالي.')
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تشغيل Face Detection.') }
    finally { setBusy(null) }
  }

  const detectMotion = async () => {
    if (!file || busy) return
    setBusy('motion'); setError(null)
    try {
      const result = await motionCandidatesV18(file, currentTime)
      setCandidates(result.candidates.map((item, index) => ({ ...item, label: `MOTION ${index + 1}` })))
      setSelected(result.candidates.map((_, index) => index).slice(0, 4)); setMultiTrack(null)
      if (!result.candidates.length) setError('لم تظهر حركة كافية لاستخراج Targets في هذا الموضع.')
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر اكتشاف Motion Targets.') }
    finally { setBusy(null) }
  }

  const toggleCandidate = (index: number) => {
    setSelected((current) => current.includes(index) ? current.filter((item) => item !== index) : current.length >= 4 ? current : [...current, index])
    setMultiTrack(null)
  }

  const runMultiTrack = async () => {
    if (!file || !selectedCandidates.length || busy) return
    setBusy('track'); setError(null)
    try {
      const boxes: TrackingBoxV17[] = selectedCandidates.map(({ x, y, width, height }) => ({ x, y, width, height }))
      const result = await multiTrackV18(file, boxes, trackStart, Math.min(duration, Math.max(trackStart + .2, trackEnd)), currentTime, trackFps, searchRadius)
      setMultiTrack(result)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر Multi-Target Tracking.') }
    finally { setBusy(null) }
  }

  const setResult = (blob: Blob, name: string) => {
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    setResultBlob(blob); setResultUrl(URL.createObjectURL(blob)); setResultName(name)
  }

  const applyMultiBlur = async () => {
    if (!file || !multiTrack || busy) return
    setBusy('blur'); setError(null)
    try {
      const blob = await multiBlurV18(file, multiTrack.tracks as TrackingResultV17[], blurIntensity)
      setResult(blob, 'MAGHRABI-v18-auto-face-multi-blur.mp4')
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر Auto Multi Blur.') }
    finally { setBusy(null) }
  }

  const reframe = async (target: 'portrait' | 'square') => {
    if (!file || !multiTrack || busy) return
    setBusy(`reframe-${target}`); setError(null)
    try {
      const blob = await multiReframeV18(file, multiTrack.tracks as TrackingResultV17[], target)
      setResult(blob, `MAGHRABI-v18-multi-subject-${target}.mp4`)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر Multi-Subject Reframe.') }
    finally { setBusy(null) }
  }

  const transcribe = async () => {
    if (!file || !stt?.configured || busy) return
    setBusy('stt'); setError(null)
    try { setSttResult(await transcribeV18(file, language)) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر Speech-to-Text.') }
    finally { setBusy(null) }
  }

  const downloadSrt = () => {
    const segments = sttResult?.segments || []
    if (!segments.length) return
    const text = segments.map((item, index) => `${index+1}\n${srtTime(item.start)} --> ${srtTime(item.end)}\n${item.text}\n`).join('\n')
    const href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a'); anchor.href = href; anchor.download = 'MAGHRABI-v18-transcript.srt'; anchor.click(); URL.revokeObjectURL(href)
  }

  if (authorized === false) return <div className="min-h-screen bg-[#05080d] p-10 text-center text-slate-300">سجّل الدخول أولًا لفتح Creator V18.</div>
  if (authorized === null) return <div className="min-h-screen bg-[#05080d] grid place-items-center"><Loader2 className="h-8 w-8 animate-spin text-cyan-300"/></div>

  return <main className="min-h-screen bg-[#05080d] text-slate-100" dir="rtl">
    <header className="border-b border-white/8 bg-[#080d15] px-5 py-4">
      <div className="mx-auto flex max-w-[1700px] flex-wrap items-center justify-between gap-3">
        <div><p className="text-[10px] font-black tracking-[.35em] text-cyan-300">MAGHRABI CREATOR V18</p><h1 className="text-xl font-black">Detection · Multi‑Target Tracking · Speech Intelligence</h1></div>
        <div className="flex gap-2"><a href="#video-v17" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold text-slate-300">V17 TRACK EDITOR</a><label className="cursor-pointer rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950"><UploadCloud className="ml-1 inline h-4 w-4"/>OPEN VIDEO<input type="file" accept="video/*" className="hidden" onChange={upload}/></label><button onClick={loadLatest} className="rounded-xl border border-cyan-300/30 px-4 py-2 text-xs font-black text-cyan-200">LOAD LATEST EDIT</button></div>
      </div>
    </header>

    <div className="mx-auto grid max-w-[1700px] gap-4 p-4 xl:grid-cols-[330px_minmax(0,1fr)_360px]">
      <aside className="space-y-4">
        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center gap-2"><ScanSearch className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">AUTO DETECTION</h2></div><p className="mt-2 text-[10px] leading-5 text-slate-500">FaceDetector يعمل من المتصفح عند توفره. Motion Detection يعمل من السيرفر كخيار بديل.</p><div className="mt-3 grid grid-cols-2 gap-2"><button disabled={!file||!!busy} onClick={detectFaces} className="rounded-xl bg-cyan-300 px-2 py-2 text-[10px] font-black text-slate-950">{busy==='faces'?'DETECTING…':'FACE DETECT'}</button><button disabled={!file||!!busy} onClick={detectMotion} className="rounded-xl border border-fuchsia-300/30 px-2 py-2 text-[10px] font-black text-fuchsia-200">{busy==='motion'?'ANALYZING…':'MOTION DETECT'}</button></div><p className="mt-3 text-[9px] text-slate-500">حدد حتى 4 Targets بالنقر على الصناديق داخل الشاشة.</p></section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center gap-2"><Crosshair className="h-4 w-4 text-emerald-300"/><h2 className="text-xs font-black">MULTI TRACK</h2></div><div className="mt-3 grid grid-cols-2 gap-2 text-[9px]"><label>START<input type="number" step=".1" value={trackStart} onChange={e=>setTrackStart(Number(e.target.value))} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label><label>END<input type="number" step=".1" value={trackEnd} onChange={e=>setTrackEnd(Number(e.target.value))} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label><label>FPS<input type="number" min="2" max="8" value={trackFps} onChange={e=>setTrackFps(Number(e.target.value))} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label><label>SEARCH<input type="number" min=".03" max=".18" step=".01" value={searchRadius} onChange={e=>setSearchRadius(Number(e.target.value))} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label></div><button disabled={!selectedCandidates.length||!!busy} onClick={runMultiTrack} className="mt-3 w-full rounded-xl bg-emerald-300 px-3 py-2 text-xs font-black text-slate-950">{busy==='track'?'TRACKING…':`TRACK ${selectedCandidates.length} TARGET${selectedCandidates.length===1?'':'S'}`}</button>{multiTrack&&<div className="mt-3 rounded-xl bg-black/25 p-3 text-[9px]"><p>Targets: <b>{multiTrack.targetCount}</b> · Avg confidence: <b>{Math.round(multiTrack.averageConfidence*100)}%</b></p>{multiTrack.tracks.map((track,index)=><div key={index} className="mt-2"><div className="flex justify-between"><span>T{index+1}</span><span>{Math.round(track.averageConfidence*100)}% · Low {track.lowConfidencePoints}</span></div><div className="mt-1 h-1.5 overflow-hidden rounded bg-white/5"><div className="h-full bg-emerald-300" style={{width:`${clamp(track.averageConfidence*100,0,100)}%`}}/></div></div>)}</div>}</section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center gap-2"><Eye className="h-4 w-4 text-rose-300"/><h2 className="text-xs font-black">AUTO PRIVACY / REFRAME</h2></div><label className="mt-3 block text-[9px]">BLUR INTENSITY <span className="float-left font-mono">{Math.round(blurIntensity*100)}%</span><input className="mt-1 w-full accent-rose-300" type="range" min="0" max="1" step=".02" value={blurIntensity} onChange={e=>setBlurIntensity(Number(e.target.value))}/></label><button disabled={!multiTrack||!!busy} onClick={applyMultiBlur} className="mt-3 w-full rounded-xl bg-rose-300 px-3 py-2 text-xs font-black text-slate-950">AUTO MULTI BLUR</button><div className="mt-2 grid grid-cols-2 gap-2"><button disabled={!multiTrack||!!busy} onClick={()=>reframe('portrait')} className="rounded-xl border border-cyan-300/30 px-2 py-2 text-[9px] font-black text-cyan-200">MULTI 9:16</button><button disabled={!multiTrack||!!busy} onClick={()=>reframe('square')} className="rounded-xl border border-cyan-300/30 px-2 py-2 text-[9px] font-black text-cyan-200">MULTI 1:1</button></div></section>
      </aside>

      <section className="space-y-4">
        <div className="rounded-3xl border border-white/8 bg-[#070b11] p-4"><div className="mb-3 flex items-center justify-between text-[10px]"><span className="font-black text-slate-400">PROGRAM / DETECTION MONITOR</span><span className="font-mono text-cyan-200">{timeLabel(currentTime)} / {timeLabel(duration)}</span></div><div className="relative mx-auto max-h-[70vh] overflow-hidden rounded-2xl bg-black" style={{aspectRatio}}>{url?<video ref={videoRef} src={url} controls className="h-full w-full object-contain" onTimeUpdate={e=>setCurrentTime(e.currentTarget.currentTime)}/>:<div className="grid h-full min-h-[420px] place-items-center text-center text-slate-600"><div><Film className="mx-auto h-12 w-12"/><p className="mt-3 text-sm font-bold">افتح فيديو أو Latest Edit</p></div></div>}{candidates.map((candidate,index)=>{const active=selected.includes(index);return <button key={index} onClick={()=>toggleCandidate(index)} title={candidate.label} className={`absolute border-2 ${active?'border-cyan-300 bg-cyan-300/10':'border-white/40 bg-black/5'}`} style={{left:`${candidate.x*100}%`,top:`${candidate.y*100}%`,width:`${candidate.width*100}%`,height:`${candidate.height*100}%`}}><span className={`absolute -top-5 right-0 rounded px-1.5 py-0.5 text-[8px] font-black ${active?'bg-cyan-300 text-slate-950':'bg-slate-700 text-white'}`}>{candidate.label || candidate.kind.toUpperCase()} {Math.round(candidate.confidence*100)}%</span></button>})}</div><div className="mt-3 flex flex-wrap gap-2 text-[9px] text-slate-500"><span>{sourceLabel||'No source'}</span>{inspection&&<><span>· {inspection.color.width}×{inspection.color.height}</span><span>· {inspection.hasAudio?'AUDIO':'NO AUDIO'}</span><span>· {inspection.color.isHdr?'HDR':'SDR'}</span></>}</div></div>

        {resultUrl&&<div className="rounded-3xl border border-cyan-300/20 bg-[#08131a] p-4"><div className="flex items-center justify-between"><h3 className="text-xs font-black text-cyan-200">V18 RESULT</h3><div className="flex gap-2"><button onClick={()=>resultBlob&&useSource(new File([resultBlob],resultName,{type:'video/mp4'}),`${resultName} · Working Source`)} className="rounded-lg bg-cyan-300 px-3 py-1.5 text-[9px] font-black text-slate-950">USE RESULT</button><a href={resultUrl} download={resultName} className="rounded-lg border border-cyan-300/30 px-3 py-1.5 text-[9px] font-black text-cyan-200"><Download className="ml-1 inline h-3 w-3"/>DOWNLOAD</a></div></div><video src={resultUrl} controls className="mt-3 max-h-[420px] w-full rounded-xl bg-black"/></div>}
      </section>

      <aside className="space-y-4">
        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center gap-2"><Users className="h-4 w-4 text-fuchsia-300"/><h2 className="text-xs font-black">TARGETS</h2></div><div className="mt-3 space-y-2">{candidates.length?candidates.map((item,index)=><button key={index} onClick={()=>toggleCandidate(index)} className={`flex w-full items-center justify-between rounded-xl border p-2 text-[9px] ${selected.includes(index)?'border-cyan-300/50 bg-cyan-300/10':'border-white/8 bg-black/20'}`}><span>{item.label || item.kind}</span><span>{selected.includes(index)?'SELECTED':'SELECT'} · {Math.round(item.confidence*100)}%</span></button>):<p className="text-[10px] text-slate-600">شغّل Face Detect أو Motion Detect.</p>}</div><p className="mt-3 text-[9px] text-slate-600">للتصحيح اليدوي الدقيق لنقطة Tracking واحدة استخدم V17 Track Editor.</p></section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center gap-2"><Subtitles className="h-4 w-4 text-amber-300"/><h2 className="text-xs font-black">SPEECH‑TO‑TEXT WORKER</h2></div><div className={`mt-3 rounded-xl border p-3 text-[9px] ${stt?.configured?'border-emerald-300/20 bg-emerald-300/5 text-emerald-200':'border-amber-300/20 bg-amber-300/5 text-amber-200'}`}>{stt?.configured?'External STT Worker configured':'STT Worker غير مهيأ بعد — أضف STT_WORKER_URL في Railway.'}</div><label className="mt-3 block text-[9px]">LANGUAGE<input value={language} onChange={e=>setLanguage(e.target.value)} className="mt-1 w-full rounded-lg bg-black/30 p-2" placeholder="ar"/></label><button disabled={!file||!stt?.configured||!!busy} onClick={transcribe} className="mt-3 w-full rounded-xl bg-amber-300 px-3 py-2 text-xs font-black text-slate-950">{busy==='stt'?'TRANSCRIBING…':'TRANSCRIBE'}</button>{sttResult&&<div className="mt-3 rounded-xl bg-black/25 p-3 text-[9px]"><p className="font-bold text-slate-300">{String(sttResult.text || '') || `${sttResult.segments?.length || 0} timed segments`}</p>{sttResult.segments?.length?<button onClick={downloadSrt} className="mt-2 rounded-lg border border-amber-300/30 px-2 py-1 text-amber-200">DOWNLOAD SRT</button>:null}</div>}</section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">V18 WORKFLOW</h2></div><ol className="mt-3 space-y-2 text-[9px] leading-5 text-slate-500"><li>1. Detect faces أو motion targets.</li><li>2. اختر حتى 4 Targets.</li><li>3. شغّل Multi Track وراجع Confidence.</li><li>4. Auto Multi Blur أو Multi Subject Reframe.</li><li>5. استخدم النتيجة كمصدر جديد ثم أكمل في V17/V16/V15.</li></ol><a href="#video-v17" className="mt-3 flex items-center justify-center rounded-xl border border-white/10 px-3 py-2 text-[9px] font-black text-slate-300"><WandSparkles className="ml-1 h-3 w-3"/>OPEN V17 FOR MANUAL CORRECTION</a></section>
      </aside>
    </div>
    {error&&<div className="fixed bottom-5 left-1/2 z-50 max-w-xl -translate-x-1/2 rounded-2xl border border-rose-300/30 bg-[#2a0d14]/95 px-5 py-3 text-xs font-bold text-rose-100 shadow-2xl">{error}</div>}
  </main>
}
