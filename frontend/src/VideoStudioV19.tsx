import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Camera, Crosshair, Download, Film, Highlighter, Loader2, Save, Subtitles, Trash2, UploadCloud } from 'lucide-react'
import { getAuthStatus } from './lib/api'
import { inspectSourceV15, SourceInspectionV15 } from './lib/advancedFinishingApi'
import { getVideoRenderResultV12, listVideoRenderJobsV12 } from './lib/videoApi'
import { TrackingBoxV17 } from './lib/trackingApi'
import {
  AdaptiveTrackResultV19,
  adaptiveTrackV19,
  CameraMotionResultV19,
  cameraMotionV19,
  highlightReelV19,
  ProductionAnalysisV19,
  productionAnalysisV19,
  stabilizeV19,
  TranscriptResultV19,
  transcribeV19,
  WhisperCapabilityV19,
  whisperCapabilityV19,
} from './lib/productionIntelligenceApi'

type TrackAsset = {
  id: string
  name: string
  color: string
  sourceLabel: string
  createdAt: string
  track: AdaptiveTrackResultV19
}

const ASSET_KEY = 'maghrabi-v19-track-assets'
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const timeLabel = (seconds: number) => {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const minutes = Math.floor(safe / 60)
  return `${String(minutes).padStart(2, '0')}:${(safe - minutes * 60).toFixed(2).padStart(5, '0')}`
}
const srtTime = (seconds: number) => {
  const safe = Math.max(0, seconds)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = Math.floor(safe % 60)
  const ms = Math.round((safe - Math.floor(safe)) * 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

function interpolateTrack(track: AdaptiveTrackResultV19 | null, time: number, fallback: TrackingBoxV17): TrackingBoxV17 {
  const points = track?.points || []
  if (!points.length) return fallback
  if (time <= points[0].time) return points[0]
  if (time >= points[points.length - 1].time) return points[points.length - 1]
  let right = 1
  while (right < points.length && points[right].time < time) right += 1
  const a = points[right - 1]
  const b = points[right]
  const ratio = clamp((time - a.time) / Math.max(.001, b.time - a.time), 0, 1)
  return {
    x: a.x + (b.x - a.x) * ratio,
    y: a.y + (b.y - a.y) * ratio,
    width: a.width + (b.width - a.width) * ratio,
    height: a.height + (b.height - a.height) * ratio,
  }
}

export default function VideoStudioV19() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [sourceLabel, setSourceLabel] = useState('')
  const [inspection, setInspection] = useState<SourceInspectionV15 | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [box, setBox] = useState<TrackingBoxV17>({ x: .34, y: .2, width: .24, height: .34 })
  const [trackStart, setTrackStart] = useState(0)
  const [trackEnd, setTrackEnd] = useState(30)
  const [trackFps, setTrackFps] = useState(5)
  const [searchRadius, setSearchRadius] = useState(.09)
  const [track, setTrack] = useState<AdaptiveTrackResultV19 | null>(null)
  const [assetName, setAssetName] = useState('Subject 1')
  const [assetColor, setAssetColor] = useState('#22d3ee')
  const [assets, setAssets] = useState<TrackAsset[]>([])
  const [camera, setCamera] = useState<CameraMotionResultV19 | null>(null)
  const [stabilizeStrength, setStabilizeStrength] = useState(.65)
  const [analysis, setAnalysis] = useState<ProductionAnalysisV19 | null>(null)
  const [sceneThreshold, setSceneThreshold] = useState(.35)
  const [highlightDuration, setHighlightDuration] = useState(30)
  const [whisper, setWhisper] = useState<WhisperCapabilityV19 | null>(null)
  const [transcript, setTranscript] = useState<TranscriptResultV19 | null>(null)
  const [language, setLanguage] = useState('ar')
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultBlob, setResultBlob] = useState<Blob | null>(null)
  const [resultName, setResultName] = useState('MAGHRABI-v19-result.mp4')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getAuthStatus().then(status => setAuthorized(status.authenticated)).catch(() => setAuthorized(false))
    whisperCapabilityV19().then(setWhisper).catch(() => setWhisper(null))
    try {
      const saved = JSON.parse(localStorage.getItem(ASSET_KEY) || '[]')
      if (Array.isArray(saved)) setAssets(saved.slice(0, 16))
    } catch { setAssets([]) }
  }, [])

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url)
    if (resultUrl) URL.revokeObjectURL(resultUrl)
  }, [url, resultUrl])

  const duration = inspection?.duration || 0
  const displayedBox = useMemo(() => interpolateTrack(track, currentTime, box), [track, currentTime, box])
  const aspectRatio = inspection?.color.width && inspection?.color.height ? `${inspection.color.width} / ${inspection.color.height}` : '16 / 9'
  const isHdr = Boolean(inspection?.color.isHdr)

  const persistAssets = (next: TrackAsset[]) => {
    setAssets(next)
    try { localStorage.setItem(ASSET_KEY, JSON.stringify(next.slice(0, 16))) } catch { /* quota is non-fatal */ }
  }

  const setResult = (blob: Blob, name: string) => {
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    setResultBlob(blob)
    setResultUrl(URL.createObjectURL(blob))
    setResultName(name)
  }

  const useSource = async (next: File, label?: string) => {
    if (url) URL.revokeObjectURL(url)
    const nextUrl = URL.createObjectURL(next)
    setFile(next)
    setUrl(nextUrl)
    setSourceLabel(label || next.name)
    setTrack(null)
    setCamera(null)
    setAnalysis(null)
    setTranscript(null)
    setCurrentTime(0)
    setError(null)
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    setResultUrl(null)
    setResultBlob(null)
    setBusy('inspect')
    try {
      const info = await inspectSourceV15(next)
      setInspection(info)
      setTrackStart(0)
      setTrackEnd(Math.min(30, info.duration))
    } catch (e) {
      setInspection(null)
      setError(e instanceof Error ? e.message : 'تعذر فحص المصدر.')
    } finally { setBusy(null) }
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
      const job = jobs.find(item => item.status === 'done' && item.resultReady)
      if (!job) throw new Error('لا توجد نتيجة Render مكتملة في Server Queue.')
      const blob = await getVideoRenderResultV12(job.id)
      await useSource(new File([blob], `V18-edit-${job.id.slice(0, 8)}.mp4`, { type: 'video/mp4' }), `Latest Edit · ${job.name}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل آخر Render.') }
    finally { setBusy(null) }
  }

  const runTrack = async () => {
    if (!file || busy) return
    setBusy('track'); setError(null)
    try {
      const end = Math.min(duration, Math.max(trackStart + .2, trackEnd))
      const result = await adaptiveTrackV19(file, box, trackStart, end, clamp(currentTime, trackStart, end), trackFps, searchRadius)
      setTrack(result)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر Scale-Adaptive Tracking.') }
    finally { setBusy(null) }
  }

  const saveAsset = () => {
    if (!track) return
    const next: TrackAsset = {
      id: crypto.randomUUID(),
      name: assetName.trim() || `Track ${assets.length + 1}`,
      color: assetColor,
      sourceLabel,
      createdAt: new Date().toISOString(),
      track,
    }
    persistAssets([next, ...assets].slice(0, 16))
  }

  const analyzeCamera = async () => {
    if (!file || busy) return
    setBusy('camera'); setError(null)
    try { setCamera(await cameraMotionV19(file)) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحليل حركة الكاميرا.') }
    finally { setBusy(null) }
  }

  const stabilize = async () => {
    if (!file || busy || isHdr) return
    setBusy('stabilize'); setError(null)
    try { setResult(await stabilizeV19(file, stabilizeStrength), 'MAGHRABI-v19-stabilized.mp4') }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر Stabilization.') }
    finally { setBusy(null) }
  }

  const analyzeProduction = async () => {
    if (!file || busy) return
    setBusy('production'); setError(null)
    try { setAnalysis(await productionAnalysisV19(file, sceneThreshold)) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر Production Analysis.') }
    finally { setBusy(null) }
  }

  const makeHighlight = async () => {
    if (!file || busy || isHdr) return
    setBusy('highlight'); setError(null)
    try { setResult(await highlightReelV19(file, sceneThreshold, highlightDuration), 'MAGHRABI-v19-highlight-reel.mp4') }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر إنشاء Highlight Reel.') }
    finally { setBusy(null) }
  }

  const runTranscribe = async () => {
    if (!file || !whisper?.configured || busy) return
    setBusy('stt'); setError(null)
    try { setTranscript(await transcribeV19(file, language)) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر Faster-Whisper Worker.') }
    finally { setBusy(null) }
  }

  const downloadSrt = () => {
    const segments = transcript?.segments || []
    if (!segments.length) return
    const text = segments.map((item, index) => `${index + 1}\n${srtTime(item.start)} --> ${srtTime(item.end)}\n${item.text}\n`).join('\n')
    const href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = href
    link.download = 'MAGHRABI-v19-arabic-captions.srt'
    link.click()
    URL.revokeObjectURL(href)
  }

  const slider = (label: string, key: keyof TrackingBoxV17, max: number) => (
    <label className="block text-[8px] font-black text-slate-500">
      <span className="flex justify-between"><span>{label}</span><span className="font-mono text-slate-300">{box[key].toFixed(2)}</span></span>
      <input type="range" min="0" max={max} step=".01" value={box[key]} onChange={event => { setTrack(null); setBox(current => ({ ...current, [key]: Number(event.target.value) })) }} className="mt-1 w-full accent-cyan-300"/>
    </label>
  )

  if (authorized === false) return <div className="min-h-screen bg-[#05080d] p-10 text-center text-slate-300">سجّل الدخول أولًا لفتح Creator V19.</div>
  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#05080d]"><Loader2 className="h-8 w-8 animate-spin text-cyan-300"/></div>

  return <main className="min-h-screen bg-[#05080d] text-slate-100" dir="rtl">
    <header className="border-b border-white/8 bg-[#080d15] px-5 py-4">
      <div className="mx-auto flex max-w-[1750px] flex-wrap items-center justify-between gap-3">
        <div><p className="text-[10px] font-black tracking-[.35em] text-cyan-300">MAGHRABI CREATOR V19</p><h1 className="text-xl font-black">Production Intelligence · Adaptive Tracking · Auto Cut</h1></div>
        <div className="flex gap-2"><a href="#video-v18" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold text-slate-300">V18 DETECTION</a><label className="cursor-pointer rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950"><UploadCloud className="ml-1 inline h-4 w-4"/>OPEN VIDEO<input type="file" accept="video/*" className="hidden" onChange={upload}/></label><button onClick={loadLatest} className="rounded-xl border border-cyan-300/30 px-4 py-2 text-xs font-black text-cyan-200">LOAD LATEST EDIT</button></div>
      </div>
    </header>

    <div className="mx-auto grid max-w-[1750px] gap-4 p-4 xl:grid-cols-[350px_minmax(0,1fr)_390px]">
      <aside className="space-y-4">
        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center gap-2"><Crosshair className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">SCALE‑ADAPTIVE TRACKER</h2></div>
          <p className="mt-2 text-[9px] leading-5 text-slate-500">V19 يتعامل مع تغيّر حجم الهدف ويستخدم Occlusion Recovery عند انخفاض الثقة. اضبط الصندوق من Position/Size أو اختر الهدف أولًا في V18.</p>
          <div className="mt-3 grid grid-cols-2 gap-3">{slider('X','x',Math.max(0,1-box.width))}{slider('Y','y',Math.max(0,1-box.height))}{slider('WIDTH','width',Math.max(.04,1-box.x))}{slider('HEIGHT','height',Math.max(.04,1-box.y))}</div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[9px]"><label>START<input type="number" step=".1" value={trackStart} onChange={e=>setTrackStart(Number(e.target.value))} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label><label>END<input type="number" step=".1" value={trackEnd} onChange={e=>setTrackEnd(Number(e.target.value))} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label><label>FPS<input type="number" min="2" max="8" value={trackFps} onChange={e=>setTrackFps(Number(e.target.value))} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label><label>SEARCH<input type="number" min=".03" max=".2" step=".01" value={searchRadius} onChange={e=>setSearchRadius(Number(e.target.value))} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label></div>
          <button disabled={!file||!!busy} onClick={runTrack} className="mt-3 w-full rounded-xl bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950">{busy==='track'?'TRACKING…':'ADAPTIVE TRACK'}</button>
          {track&&<div className="mt-3 rounded-xl bg-black/25 p-3 text-[9px]"><p>Confidence <b>{Math.round(track.averageConfidence*100)}%</b> · Low <b>{track.lowConfidencePoints}</b></p><p className="mt-1">Occlusion <b>{track.occlusionPoints}</b> · Scale range <b>{track.scaleChange.toFixed(2)}×</b></p><div className="mt-2 flex h-3 overflow-hidden rounded bg-white/5">{track.points.slice(0,150).map((point,index)=><div key={index} className={point.occluded?'bg-rose-400':point.confidence<.38?'bg-amber-300':'bg-emerald-300'} style={{flex:1}} title={`${timeLabel(point.time)} · ${Math.round(point.confidence*100)}%`}/>)}</div></div>}
        </section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center gap-2"><Save className="h-4 w-4 text-fuchsia-300"/><h2 className="text-xs font-black">TRACKING ASSETS</h2></div>
          <div className="mt-3 grid grid-cols-[1fr_48px] gap-2"><input value={assetName} onChange={e=>setAssetName(e.target.value)} className="rounded-lg bg-black/30 p-2 text-[10px]"/><input type="color" value={assetColor} onChange={e=>setAssetColor(e.target.value)} className="h-9 w-full rounded-lg bg-black/30 p-1"/></div>
          <button disabled={!track} onClick={saveAsset} className="mt-2 w-full rounded-xl border border-fuchsia-300/30 px-3 py-2 text-[10px] font-black text-fuchsia-200">SAVE TRACK ASSET</button>
          <div className="mt-3 max-h-56 space-y-2 overflow-auto">{assets.map(asset=><div key={asset.id} className="flex items-center gap-2 rounded-xl border border-white/8 bg-black/20 p-2"><span className="h-3 w-3 rounded-full" style={{background:asset.color}}/><button onClick={()=>{setTrack(asset.track);setBox(asset.track.points[0]||box);setAssetName(asset.name);setAssetColor(asset.color)}} className="min-w-0 flex-1 text-right"><p className="truncate text-[9px] font-black">{asset.name}</p><p className="truncate text-[8px] text-slate-600">{Math.round(asset.track.averageConfidence*100)}% · {asset.track.occlusionPoints} occlusion</p></button><button onClick={()=>persistAssets(assets.filter(item=>item.id!==asset.id))} className="rounded-lg p-1 text-rose-300"><Trash2 className="h-3.5 w-3.5"/></button></div>)}{!assets.length&&<p className="text-[9px] text-slate-600">لا توجد Tracking Assets محفوظة.</p>}</div>
        </section>
      </aside>

      <section className="space-y-4">
        <div className="rounded-3xl border border-white/8 bg-[#070b11] p-4">
          <div className="mb-3 flex items-center justify-between text-[10px]"><span className="font-black text-slate-400">PRODUCTION MONITOR</span><span className="font-mono text-cyan-200">{timeLabel(currentTime)} / {timeLabel(duration)}</span></div>
          <div className="relative mx-auto max-h-[70vh] overflow-hidden rounded-2xl bg-black" style={{aspectRatio}}>{url?<video ref={videoRef} src={url} controls className="h-full w-full object-contain" onTimeUpdate={e=>setCurrentTime(e.currentTarget.currentTime)}/>:<div className="grid h-full min-h-[430px] place-items-center text-center text-slate-600"><div><Film className="mx-auto h-12 w-12"/><p className="mt-3 text-sm font-bold">افتح فيديو أو Latest Edit</p></div></div>}{file&&<div className="pointer-events-none absolute border-2 border-cyan-300 bg-cyan-300/5" style={{left:`${displayedBox.x*100}%`,top:`${displayedBox.y*100}%`,width:`${displayedBox.width*100}%`,height:`${displayedBox.height*100}%`}}><span className="absolute -top-5 right-0 rounded bg-cyan-300 px-1.5 py-.5 text-[8px] font-black text-slate-950">ADAPTIVE TARGET</span></div>}</div>
          <div className="mt-3 flex flex-wrap gap-2 text-[9px] text-slate-500"><span>{sourceLabel||'No source'}</span>{inspection&&<><span>· {inspection.color.width}×{inspection.color.height}</span><span>· {inspection.hasAudio?'AUDIO':'NO AUDIO'}</span><span className={isHdr?'text-amber-300':''}>· {isHdr?'HDR — V15 first':'SDR'}</span></>}</div>
        </div>

        {analysis&&<div className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center justify-between"><h3 className="text-xs font-black">AUTO CUT MAP</h3><span className="text-[9px] text-slate-500">{analysis.sceneCount} scenes · {analysis.analyzedCount} scored</span></div><div className="mt-3 flex h-12 overflow-hidden rounded-xl border border-white/8 bg-black/30">{analysis.cutList.map((scene,index)=><button key={index} onClick={()=>{if(videoRef.current)videoRef.current.currentTime=scene.start}} className="border-l border-black/40 bg-slate-700/70 text-[7px] font-black hover:bg-cyan-300 hover:text-slate-950" style={{flex:Math.max(.25,scene.duration)}}>{index+1}</button>)}</div><div className="mt-4 grid gap-2 md:grid-cols-4">{analysis.highlights.slice(0,8).map((scene,index)=><button key={index} onClick={()=>{if(videoRef.current)videoRef.current.currentTime=scene.start}} className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-2 text-right"><p className="text-[8px] font-black text-amber-200">HIGHLIGHT {index+1} · {Math.round((scene.highlightScore||0)*100)}%</p><p className="mt-1 text-[8px] text-slate-500">{timeLabel(scene.start)} · {scene.duration.toFixed(1)}s</p></button>)}</div></div>}

        {resultUrl&&<div className="rounded-3xl border border-cyan-300/20 bg-[#08131a] p-4"><div className="flex items-center justify-between"><h3 className="text-xs font-black text-cyan-200">V19 RESULT</h3><div className="flex gap-2"><button onClick={()=>resultBlob&&useSource(new File([resultBlob],resultName,{type:'video/mp4'}),`${resultName} · Working Source`)} className="rounded-lg bg-cyan-300 px-3 py-1.5 text-[9px] font-black text-slate-950">USE RESULT</button><a href={resultUrl} download={resultName} className="rounded-lg border border-cyan-300/30 px-3 py-1.5 text-[9px] font-black text-cyan-200"><Download className="ml-1 inline h-3 w-3"/>DOWNLOAD</a></div></div><video src={resultUrl} controls className="mt-3 max-h-[420px] w-full rounded-xl bg-black"/></div>}
      </section>

      <aside className="space-y-4">
        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center gap-2"><Camera className="h-4 w-4 text-emerald-300"/><h2 className="text-xs font-black">CAMERA MOTION</h2></div><button disabled={!file||!!busy} onClick={analyzeCamera} className="mt-3 w-full rounded-xl border border-emerald-300/30 px-3 py-2 text-[10px] font-black text-emerald-200">{busy==='camera'?'ANALYZING…':'ANALYZE CAMERA MOTION'}</button>{camera&&<div className="mt-3 rounded-xl bg-black/25 p-3 text-[9px]"><p className="font-black text-emerald-200">{camera.classification.toUpperCase()}</p><p className="mt-1">Stability <b>{Math.round(camera.stability*100)}%</b> · Jitter <b>{camera.jitter.toFixed(4)}</b></p><div className="mt-2 flex h-14 items-end gap-px overflow-hidden">{camera.samples.slice(0,90).map((sample,index)=><div key={index} className="flex-1 bg-emerald-300/60" style={{height:`${clamp(sample.magnitude*900,2,100)}%`}}/>)}</div></div>}<label className="mt-3 block text-[9px]">STABILIZE <span className="float-left">{Math.round(stabilizeStrength*100)}%</span><input type="range" min=".1" max="1" step=".05" value={stabilizeStrength} onChange={e=>setStabilizeStrength(Number(e.target.value))} className="mt-1 w-full accent-emerald-300"/></label><button disabled={!file||!!busy||isHdr} onClick={stabilize} className="mt-2 w-full rounded-xl bg-emerald-300 px-3 py-2 text-xs font-black text-slate-950">STABILIZE VIDEO</button>{isHdr&&<p className="mt-2 text-[8px] text-amber-300">HDR: عالج Color Management في V15 أولًا.</p>}</section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center gap-2"><Highlighter className="h-4 w-4 text-amber-300"/><h2 className="text-xs font-black">AUTO CUT / HIGHLIGHTS</h2></div><label className="mt-3 block text-[9px]">SCENE THRESHOLD <span className="float-left">{sceneThreshold.toFixed(2)}</span><input type="range" min=".12" max=".7" step=".01" value={sceneThreshold} onChange={e=>setSceneThreshold(Number(e.target.value))} className="mt-1 w-full accent-amber-300"/></label><button disabled={!file||!!busy} onClick={analyzeProduction} className="mt-2 w-full rounded-xl border border-amber-300/30 px-3 py-2 text-[10px] font-black text-amber-200">{busy==='production'?'SCORING…':'ANALYZE CUTS + HIGHLIGHTS'}</button><label className="mt-3 block text-[9px]">REEL MAX <span className="float-left">{highlightDuration}s</span><input type="range" min="10" max="90" step="5" value={highlightDuration} onChange={e=>setHighlightDuration(Number(e.target.value))} className="mt-1 w-full accent-amber-300"/></label><button disabled={!analysis||!!busy||isHdr} onClick={makeHighlight} className="mt-2 w-full rounded-xl bg-amber-300 px-3 py-2 text-xs font-black text-slate-950">{busy==='highlight'?'RENDERING…':'BUILD HIGHLIGHT REEL'}</button></section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center gap-2"><Subtitles className="h-4 w-4 text-fuchsia-300"/><h2 className="text-xs font-black">FASTER‑WHISPER WORKER</h2></div><div className={`mt-3 rounded-xl border p-3 text-[9px] ${whisper?.configured?'border-emerald-300/20 bg-emerald-300/5 text-emerald-200':'border-amber-300/20 bg-amber-300/5 text-amber-200'}`}>{whisper?.configured?'STT_WORKER_URL configured':'أضف STT_WORKER_URL لخدمة Faster‑Whisper مستقلة.'}</div><label className="mt-3 block text-[9px]">LANGUAGE<input value={language} onChange={e=>setLanguage(e.target.value)} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label><button disabled={!file||!whisper?.configured||!!busy} onClick={runTranscribe} className="mt-2 w-full rounded-xl bg-fuchsia-300 px-3 py-2 text-xs font-black text-slate-950">{busy==='stt'?'TRANSCRIBING…':'AUTO TRANSCRIBE'}</button>{transcript&&<div className="mt-3 rounded-xl bg-black/25 p-3 text-[9px]"><p className="max-h-24 overflow-auto text-slate-300">{String(transcript.text||'')||`${transcript.segments?.length||0} timed segments`}</p>{transcript.segments?.length?<button onClick={downloadSrt} className="mt-2 rounded-lg border border-fuchsia-300/30 px-2 py-1 text-fuchsia-200">DOWNLOAD ARABIC SRT</button>:null}</div>}</section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4"><div className="flex items-center gap-2"><Activity className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">PRODUCTION PIPELINE</h2></div><p className="mt-3 text-[9px] leading-5 text-slate-500">V18 Detection → V19 Adaptive Track / Camera Analysis / Auto Cut → Faster‑Whisper → V15 Final Master.</p><div className="mt-3 grid grid-cols-2 gap-2"><a href="#video-v18" className="rounded-xl border border-white/10 px-2 py-2 text-center text-[9px] font-black">V18 DETECT</a><a href="#video-v15" className="rounded-xl border border-white/10 px-2 py-2 text-center text-[9px] font-black">V15 MASTER</a></div></section>
      </aside>
    </div>

    {busy&&<div className="pointer-events-none fixed left-5 top-5 z-50 flex items-center gap-2 rounded-xl border border-cyan-300/20 bg-[#07121a]/95 px-3 py-2 text-[10px] font-black text-cyan-200"><Loader2 className="h-3.5 w-3.5 animate-spin"/>{busy.toUpperCase()}</div>}
    {error&&<div className="fixed bottom-5 left-1/2 z-50 max-w-xl -translate-x-1/2 rounded-2xl border border-rose-300/30 bg-[#2a0d14]/95 px-5 py-3 text-xs font-bold text-rose-100 shadow-2xl">{error}</div>}
  </main>
}
