import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Crosshair,
  Download,
  Film,
  Focus,
  Loader2,
  ScanSearch,
  Sparkles,
  Subtitles,
  UploadCloud,
  WandSparkles,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import { AudioMasterSettingsV14, ExportPresetV14, GradeSettingsV14 } from './lib/finishingApi'
import { inspectSourceV15, masterVideoV15, SourceInspectionV15 } from './lib/advancedFinishingApi'
import { getVideoRenderResultV12, listVideoRenderJobsV12 } from './lib/videoApi'
import {
  burnCaptionsV17,
  CaptionSegmentV17,
  captionSegmentsV17,
  dynamicReframeV17,
  renderTrackedEffectV17,
  TrackingBoxV17,
  TrackingPointV17,
  TrackingResultV17,
  trackRegionV17,
} from './lib/trackingApi'

const neutralRgb = { r: 0, g: 0, b: 0 }
const neutralBand = { shadows: 0, mids: 0, highlights: 0 }
const neutralGrade: GradeSettingsV14 = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  gamma: 0,
  lift: { ...neutralRgb },
  gammaWheel: { ...neutralRgb },
  gain: { ...neutralRgb },
  curves: { r: { ...neutralBand }, g: { ...neutralBand }, b: { ...neutralBand } },
}
const neutralAudio: AudioMasterSettingsV14 = {
  low: 0,
  mid: 0,
  high: 0,
  compressor: true,
  thresholdDb: -18,
  ratio: 3,
  attack: 20,
  release: 250,
  limiter: true,
  ceilingDb: -1,
  normalize: true,
  targetLufs: -14,
}
const secondaryOff = { enabled: false, family: 'reds' as const, cyan: 0, magenta: 0, yellow: 0, black: 0 }
const windowOff = { enabled: false, x: .2, y: .2, width: .5, height: .5, brightness: 0, contrast: 1, saturation: 1 }
const repairOff = { noiseReduction: false, noiseStrength: .35, deesser: false, deesserIntensity: .35, stereoWidth: 1 }

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
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

function interpolate(points: TrackingPointV17[] | undefined, time: number, fallback: TrackingBoxV17): TrackingBoxV17 {
  if (!points?.length) return fallback
  if (time <= points[0].time) return points[0]
  if (time >= points[points.length - 1].time) return points[points.length - 1]
  let right = 1
  while (right < points.length && points[right].time < time) right += 1
  const a = points[Math.max(0, right - 1)]
  const b = points[Math.min(points.length - 1, right)]
  const ratio = clamp((time - a.time) / Math.max(.001, b.time - a.time), 0, 1)
  return {
    x: a.x + (b.x - a.x) * ratio,
    y: a.y + (b.y - a.y) * ratio,
    width: a.width + (b.width - a.width) * ratio,
    height: a.height + (b.height - a.height) * ratio,
  }
}

function distributeTranscript(text: string, segments: CaptionSegmentV17[]): CaptionSegmentV17[] {
  const words = text.trim().split(/\s+/u).filter(Boolean)
  if (!segments.length || !words.length) return segments.map((segment) => ({ ...segment }))
  let cursor = 0
  return segments.map((segment, index) => {
    const remainingSegments = segments.length - index
    const remainingWords = words.length - cursor
    const take = index === segments.length - 1 ? remainingWords : Math.max(1, Math.ceil(remainingWords / remainingSegments))
    const value = words.slice(cursor, cursor + take).join(' ')
    cursor += take
    return { ...segment, text: value }
  })
}

function confidenceClass(value: number) {
  if (value >= .62) return 'bg-emerald-300'
  if (value >= .38) return 'bg-amber-300'
  return 'bg-rose-400'
}

export default function VideoStudioV17() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const monitorRef = useRef<HTMLDivElement>(null)
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [inspection, setInspection] = useState<SourceInspectionV15 | null>(null)
  const [sourceLabel, setSourceLabel] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [box, setBox] = useState<TrackingBoxV17>({ x: .34, y: .22, width: .25, height: .32 })
  const [trackStart, setTrackStart] = useState(0)
  const [trackEnd, setTrackEnd] = useState(30)
  const [anchor, setAnchor] = useState(0)
  const [trackFps, setTrackFps] = useState(5)
  const [searchRadius, setSearchRadius] = useState(.09)
  const [track, setTrack] = useState<TrackingResultV17 | null>(null)
  const [manualCorrection, setManualCorrection] = useState(false)
  const [effect, setEffect] = useState<'blur' | 'mosaic' | 'spotlight'>('blur')
  const [intensity, setIntensity] = useState(.65)
  const [captions, setCaptions] = useState<CaptionSegmentV17[]>([])
  const [transcript, setTranscript] = useState('')
  const [captionThreshold, setCaptionThreshold] = useState(-35)
  const [captionSilence, setCaptionSilence] = useState(.45)
  const [preset, setPreset] = useState<ExportPresetV14>('youtube_1080')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resultBlob, setResultBlob] = useState<Blob | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultName, setResultName] = useState('MAGHRABI-v17-result.mp4')

  useEffect(() => { getAuthStatus().then((status) => setAuthorized(status.authenticated)).catch(() => setAuthorized(false)) }, [])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); if (resultUrl) URL.revokeObjectURL(resultUrl) }, [url, resultUrl])

  const duration = inspection?.duration || 0
  const displayedBox = useMemo(
    () => manualCorrection ? box : interpolate(track?.points, currentTime, box),
    [manualCorrection, box, track, currentTime],
  )
  const aspectRatio = inspection?.color.width && inspection?.color.height
    ? `${inspection.color.width} / ${inspection.color.height}`
    : '16 / 9'

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
    setCaptions([])
    setTranscript('')
    setCurrentTime(0)
    setAnchor(0)
    setTrackStart(0)
    setError(null)
    setResultBlob(null)
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    setResultUrl(null)
    setBusy('inspect')
    try {
      const info = await inspectSourceV15(next)
      setInspection(info)
      setTrackEnd(Math.min(30, info.duration))
    } catch (e) {
      setInspection(null)
      setError(e instanceof Error ? e.message : 'تعذر فحص المصدر.')
    } finally { setBusy(null) }
  }

  const onUpload = (event: ChangeEvent<HTMLInputElement>) => {
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
      await useSource(new File([blob], `V16-edit-${job.id.slice(0, 8)}.mp4`, { type: 'video/mp4' }), `Latest Edit · ${job.name}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل آخر Render.') }
    finally { setBusy(null) }
  }

  const seek = (time: number) => {
    const value = clamp(time, 0, duration || time)
    if (videoRef.current) videoRef.current.currentTime = value
    setCurrentTime(value)
  }

  const beginBox = (event: ReactPointerEvent<HTMLDivElement>, mode: 'move' | 'resize') => {
    if (!monitorRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const rect = monitorRef.current.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    const initial = { ...displayedBox }
    if (!manualCorrection) {
      setManualCorrection(true)
      setBox(initial)
    }
    const move = (pointer: PointerEvent) => {
      const dx = (pointer.clientX - startX) / Math.max(1, rect.width)
      const dy = (pointer.clientY - startY) / Math.max(1, rect.height)
      if (mode === 'move') {
        setBox({
          ...initial,
          x: clamp(initial.x + dx, 0, 1 - initial.width),
          y: clamp(initial.y + dy, 0, 1 - initial.height),
        })
      } else {
        setBox({
          ...initial,
          width: clamp(initial.width + dx, .04, 1 - initial.x),
          height: clamp(initial.height + dy, .04, 1 - initial.y),
        })
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const runTracking = async () => {
    if (!file || busy) return
    setBusy('track'); setError(null)
    try {
      const end = Math.min(duration, Math.max(trackStart + .2, trackEnd))
      const result = await trackRegionV17(file, box, trackStart, end, clamp(anchor, trackStart, end), trackFps, searchRadius)
      setTrack(result)
      setManualCorrection(false)
      setBox(interpolate(result.points, anchor, box))
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تنفيذ Motion Tracking.') }
    finally { setBusy(null) }
  }

  const saveCorrection = () => {
    if (!track) return
    const points = [...track.points]
    let nearest = 0
    let distance = Number.POSITIVE_INFINITY
    points.forEach((point, index) => {
      const delta = Math.abs(point.time - currentTime)
      if (delta < distance) { distance = delta; nearest = index }
    })
    const corrected: TrackingPointV17 = { ...box, time: currentTime, confidence: 1 }
    if (distance <= 1 / Math.max(2, track.fps)) points[nearest] = corrected
    else points.push(corrected)
    points.sort((a, b) => a.time - b.time)
    const averageConfidence = points.reduce((sum, point) => sum + point.confidence, 0) / points.length
    setTrack({ ...track, points, averageConfidence, lowConfidencePoints: points.filter((point) => point.confidence < .38).length })
    setManualCorrection(false)
  }

  const renderEffect = async () => {
    if (!file || !track || busy) return
    setBusy('effect'); setError(null)
    try { setResult(await renderTrackedEffectV17(file, track, effect, intensity), `MAGHRABI-v17-${effect}.mp4`) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تصدير Tracking Effect.') }
    finally { setBusy(null) }
  }

  const reframe = async (target: 'portrait' | 'square') => {
    if (!file || !track || busy) return
    setBusy(`reframe-${target}`); setError(null)
    try {
      setResult(await dynamicReframeV17(file, track, target), `MAGHRABI-v17-${target}.mp4`)
      setPreset(target === 'portrait' ? 'instagram_reel' : 'instagram_square')
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر Dynamic Reframe.') }
    finally { setBusy(null) }
  }

  const useResult = async () => {
    if (!resultBlob) return
    await useSource(new File([resultBlob], resultName, { type: 'video/mp4' }), `${sourceLabel || resultName} · Applied`)
  }

  const analyzeCaptions = async () => {
    if (!file || busy) return
    setBusy('captions'); setError(null)
    try {
      const analysis = await captionSegmentsV17(file, captionThreshold, captionSilence)
      setCaptions(analysis.segments)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحليل Caption Segments.') }
    finally { setBusy(null) }
  }

  const applyTranscript = () => setCaptions((current) => distributeTranscript(transcript, current))

  const downloadSrt = () => {
    const filled = captions.filter((item) => item.text.trim())
    if (!filled.length) return
    const body = filled.map((item, index) => `${index + 1}\n${srtTime(item.start)} --> ${srtTime(item.end)}\n${item.text.trim()}\n`).join('\n')
    const blob = new Blob([body], { type: 'application/x-subrip;charset=utf-8' })
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = 'MAGHRABI-v17-captions.srt'
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  }

  const burnCaptions = async () => {
    if (!file || busy) return
    setBusy('burn'); setError(null)
    try { setResult(await burnCaptionsV17(file, captions), 'MAGHRABI-v17-captioned.mp4') }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر Burn Captions.') }
    finally { setBusy(null) }
  }

  const finalMaster = async () => {
    if (!file || busy) return
    setBusy('master'); setError(null)
    try {
      const audio = { ...neutralAudio, targetLufs: preset === 'broadcast_1080p25' ? -23 : -14 }
      const blob = await masterVideoV15(file, neutralGrade, audio, secondaryOff, windowOff, repairOff, 'auto', preset)
      setResult(blob, `MAGHRABI-v17-master-${preset}.mp4`)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر Final Master.') }
    finally { setBusy(null) }
  }

  if (authorized === false) return <div className="min-h-screen bg-[#05080d] p-8 text-center text-sm text-slate-400">سجّل الدخول أولًا للوصول إلى Creator V17.</div>

  return <main className="min-h-screen bg-[#05080d] text-slate-100">
    <div className="mx-auto max-w-[1680px] p-4 lg:p-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-cyan-300/10 bg-[#0b111b] p-4 shadow-2xl shadow-black/30">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-cyan-300/10 p-3"><Crosshair className="h-6 w-6 text-cyan-300"/></div>
          <div><p className="text-[9px] font-black tracking-[.32em] text-cyan-300">CREATOR V17 · TRACKING & CONTENT INTELLIGENCE</p><h1 className="text-xl font-black">MAGHRABI Tracking Room</h1><p className="mt-1 text-[9px] text-slate-500">Motion Tracking · Dynamic Reframe · Privacy/Power Tracking · Caption Assist</p></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="cursor-pointer rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[9px] font-black hover:bg-white/10"><UploadCloud className="mr-1 inline h-3.5 w-3.5"/>OPEN VIDEO<input type="file" accept="video/*" className="hidden" onChange={onUpload}/></label>
          <button onClick={loadLatest} disabled={!!busy} className="rounded-xl border border-violet-300/20 bg-violet-300/5 px-3 py-2 text-[9px] font-black text-violet-200 disabled:opacity-40">LOAD LATEST EDIT</button>
          <a href="#video-v16" className="rounded-xl border border-white/10 px-3 py-2 text-[9px] font-black text-slate-400 hover:text-white">V16 SMART ASSIST</a>
        </div>
      </header>

      {error && <div className="mb-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 p-3 text-xs text-rose-200">{error}</div>}

      <div className="grid gap-4 xl:grid-cols-[1.55fr_.9fr]">
        <section className="space-y-4">
          <div className="rounded-3xl border border-white/8 bg-[#0b111b] p-4">
            <div className="mb-3 flex items-center justify-between"><div><p className="text-[8px] font-black tracking-widest text-slate-500">TRACK MONITOR</p><p className="text-xs font-bold text-slate-300">{sourceLabel || 'No source loaded'}</p></div><div className="font-mono text-sm text-cyan-200">{timeLabel(currentTime)}</div></div>
            <div ref={monitorRef} className="relative mx-auto max-h-[68vh] max-w-full overflow-hidden rounded-2xl bg-black" style={{ aspectRatio }}>
              {url ? <video ref={videoRef} src={url} controls className="h-full w-full object-fill" onTimeUpdate={(e)=>setCurrentTime(e.currentTarget.currentTime)} onSeeked={(e)=>setCurrentTime(e.currentTarget.currentTime)}/> : <div className="flex h-full min-h-[360px] items-center justify-center text-xs text-slate-700"><Film className="mr-2 h-5 w-5"/>Open a video or load latest edit</div>}
              {url && <div
                onPointerDown={(event)=>beginBox(event,'move')}
                className={`absolute cursor-move border-2 ${manualCorrection ? 'border-amber-300 bg-amber-300/8' : 'border-cyan-300 bg-cyan-300/5'} shadow-[0_0_0_1px_rgba(0,0,0,.5)]`}
                style={{ left:`${displayedBox.x*100}%`, top:`${displayedBox.y*100}%`, width:`${displayedBox.width*100}%`, height:`${displayedBox.height*100}%` }}
              >
                <div className="absolute -left-px -top-5 rounded-t bg-black/80 px-1.5 py-1 text-[7px] font-black text-cyan-200">{manualCorrection?'MANUAL':'TRACK'}</div>
                <div onPointerDown={(event)=>beginBox(event,'resize')} className="absolute -bottom-2 -right-2 h-5 w-5 cursor-nwse-resize rounded-full border-2 border-black bg-cyan-300"/>
              </div>}
            </div>
            {track?.points.length ? <div className="mt-3 rounded-2xl border border-white/8 bg-black/20 p-3">
              <div className="mb-2 flex items-center justify-between text-[8px] font-black text-slate-500"><span>TRACK CONFIDENCE · {Math.round(track.averageConfidence*100)}%</span><span>{track.lowConfidencePoints} LOW POINTS</span></div>
              <div className="flex h-12 items-end gap-px overflow-hidden">{track.points.slice(0,180).map((point,index)=><button key={`${point.time}-${index}`} onClick={()=>seek(point.time)} className={`min-w-[2px] flex-1 rounded-t ${confidenceClass(point.confidence)}`} style={{height:`${Math.max(8,point.confidence*100)}%`}} title={`${timeLabel(point.time)} · ${Math.round(point.confidence*100)}%`}/>)}</div>
            </div> : null}
          </div>

          <div className="rounded-3xl border border-white/8 bg-[#0b111b] p-4">
            <div className="mb-3 flex items-center gap-2"><Focus className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">MOTION TRACKER</h2></div>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-[8px] font-black text-slate-500">START<input type="number" min="0" max={duration} step=".1" value={trackStart} onChange={e=>setTrackStart(clamp(Number(e.target.value),0,duration))} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"/></label>
              <label className="text-[8px] font-black text-slate-500">END · MAX 120s<input type="number" min=".2" max={duration} step=".1" value={trackEnd} onChange={e=>setTrackEnd(clamp(Number(e.target.value),0,duration))} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"/></label>
              <label className="text-[8px] font-black text-slate-500">ANCHOR<input type="number" min={trackStart} max={trackEnd} step=".1" value={anchor} onChange={e=>setAnchor(Number(e.target.value))} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"/></label>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
              <label className="text-[8px] font-black text-slate-500">TRACK FPS · {trackFps}<input type="range" min="2" max="8" step="1" value={trackFps} onChange={e=>setTrackFps(Number(e.target.value))} className="mt-2 w-full accent-cyan-300"/></label>
              <label className="text-[8px] font-black text-slate-500">SEARCH RADIUS · {Math.round(searchRadius*100)}%<input type="range" min=".03" max=".18" step=".01" value={searchRadius} onChange={e=>setSearchRadius(Number(e.target.value))} className="mt-2 w-full accent-cyan-300"/></label>
              <button onClick={()=>{setAnchor(currentTime);setTrackStart(Math.min(trackStart,currentTime));setTrackEnd(Math.max(trackEnd,currentTime))}} className="self-end rounded-xl border border-white/10 px-3 py-2 text-[8px] font-black text-slate-300">ANCHOR = PLAYHEAD</button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={runTracking} disabled={!file||!!busy} className="rounded-xl bg-cyan-300 px-4 py-2 text-[9px] font-black text-black disabled:opacity-40">{busy==='track'?<Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin"/>:<ScanSearch className="mr-1 inline h-3.5 w-3.5"/>}TRACK REGION</button>
              {track && <button onClick={()=>{setBox(displayedBox);setManualCorrection(true)}} className="rounded-xl border border-amber-300/20 bg-amber-300/5 px-3 py-2 text-[8px] font-black text-amber-200">MANUAL CORRECTION</button>}
              {track&&manualCorrection&&<button onClick={saveCorrection} className="rounded-xl bg-amber-300 px-3 py-2 text-[8px] font-black text-black">SAVE POINT @ {timeLabel(currentTime)}</button>}
            </div>
            {track && <p className="mt-3 text-[8px] leading-5 text-slate-500">{track.note}</p>}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-3xl border border-white/8 bg-[#0b111b] p-4">
              <div className="mb-3 flex items-center gap-2"><WandSparkles className="h-4 w-4 text-violet-300"/><h2 className="text-xs font-black">TRACKED EFFECT</h2></div>
              <div className="grid grid-cols-3 gap-2">{(['blur','mosaic','spotlight'] as const).map(item=><button key={item} onClick={()=>setEffect(item)} className={`rounded-xl border px-2 py-2 text-[8px] font-black uppercase ${effect===item?'border-violet-300/40 bg-violet-300/10 text-violet-200':'border-white/8 text-slate-500'}`}>{item}</button>)}</div>
              <label className="mt-3 block text-[8px] font-black text-slate-500">INTENSITY · {Math.round(intensity*100)}%<input type="range" min="0" max="1" step=".05" value={intensity} onChange={e=>setIntensity(Number(e.target.value))} className="mt-2 w-full accent-violet-300"/></label>
              <button onClick={renderEffect} disabled={!track||!!busy} className="mt-3 w-full rounded-xl bg-violet-300 px-3 py-2 text-[9px] font-black text-black disabled:opacity-40">RENDER TRACKED {effect.toUpperCase()}</button>
            </div>

            <div className="rounded-3xl border border-white/8 bg-[#0b111b] p-4">
              <div className="mb-3 flex items-center gap-2"><Sparkles className="h-4 w-4 text-fuchsia-300"/><h2 className="text-xs font-black">DYNAMIC REFRAME</h2></div>
              <p className="text-[8px] leading-5 text-slate-500">يستخدم نفس مسار Tracking لتحريك الكادر عبر الزمن بدل Crop ثابت.</p>
              <div className="mt-4 grid grid-cols-2 gap-2"><button onClick={()=>reframe('portrait')} disabled={!track||!!busy} className="rounded-xl border border-fuchsia-300/20 bg-fuchsia-300/5 px-3 py-3 text-[9px] font-black text-fuchsia-200 disabled:opacity-40">9:16 PORTRAIT</button><button onClick={()=>reframe('square')} disabled={!track||!!busy} className="rounded-xl border border-fuchsia-300/20 bg-fuchsia-300/5 px-3 py-3 text-[9px] font-black text-fuchsia-200 disabled:opacity-40">1:1 SQUARE</button></div>
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-3xl border border-white/8 bg-[#0b111b] p-4">
            <div className="flex items-center gap-2"><Subtitles className="h-4 w-4 text-emerald-300"/><h2 className="text-xs font-black">CAPTION ASSIST</h2></div>
            <p className="mt-2 text-[8px] leading-5 text-slate-500">V17 يكتشف مناطق الكلام زمنيًا. لا يقوم بتحويل الكلام إلى نص تلقائيًا؛ الصق Transcript ثم وزّعه على المقاطع أو عدّلها يدويًا.</p>
            <div className="mt-3 grid grid-cols-2 gap-2"><label className="text-[7px] font-black text-slate-600">SILENCE dB<input type="number" min="-60" max="-18" value={captionThreshold} onChange={e=>setCaptionThreshold(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-white/8 bg-black/30 p-2 font-mono text-xs text-white"/></label><label className="text-[7px] font-black text-slate-600">MIN SILENCE<input type="number" min=".2" max="3" step=".05" value={captionSilence} onChange={e=>setCaptionSilence(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-white/8 bg-black/30 p-2 font-mono text-xs text-white"/></label></div>
            <button onClick={analyzeCaptions} disabled={!file||!!busy} className="mt-2 w-full rounded-xl border border-emerald-300/20 bg-emerald-300/5 px-3 py-2 text-[8px] font-black text-emerald-200 disabled:opacity-40">DETECT SPEECH SEGMENTS</button>
            <textarea value={transcript} onChange={e=>setTranscript(e.target.value)} placeholder="الصق Transcript هنا..." className="mt-3 min-h-28 w-full resize-y rounded-xl border border-white/8 bg-black/30 p-3 text-xs text-slate-200 outline-none focus:border-emerald-300/30"/>
            <button onClick={applyTranscript} disabled={!captions.length||!transcript.trim()} className="mt-2 w-full rounded-xl border border-white/10 px-3 py-2 text-[8px] font-black text-slate-300 disabled:opacity-30">DISTRIBUTE TRANSCRIPT</button>
            <div className="mt-3 max-h-72 space-y-2 overflow-auto pr-1">{captions.map((caption,index)=><div key={`${caption.start}-${index}`} className="rounded-xl border border-white/8 bg-black/20 p-2"><div className="mb-1 flex justify-between font-mono text-[7px] text-slate-600"><button onClick={()=>seek(caption.start)} className="hover:text-white">{timeLabel(caption.start)}</button><span>→</span><span>{timeLabel(caption.end)}</span></div><textarea value={caption.text} onChange={e=>setCaptions(current=>current.map((item,i)=>i===index?{...item,text:e.target.value}:item))} className="min-h-14 w-full resize-none rounded-lg border border-white/5 bg-black/30 p-2 text-[10px] text-white"/></div>)}</div>
            {!!captions.length && <div className="mt-3 grid grid-cols-2 gap-2"><button onClick={downloadSrt} className="rounded-xl border border-white/10 px-3 py-2 text-[8px] font-black text-slate-300"><Download className="mr-1 inline h-3 w-3"/>SRT</button><button onClick={burnCaptions} disabled={!!busy} className="rounded-xl bg-emerald-300 px-3 py-2 text-[8px] font-black text-black disabled:opacity-40">BURN CAPTIONS</button></div>}
          </div>

          <div className="rounded-3xl border border-white/8 bg-[#0b111b] p-4">
            <h2 className="text-xs font-black">SOURCE / TRACK DATA</h2>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[8px]">{[
              ['SIZE', inspection?.color.width&&inspection?.color.height?`${inspection.color.width}×${inspection.color.height}`:'—'],
              ['DURATION', duration?`${duration.toFixed(1)}s`:'—'],
              ['HDR', inspection?.color.isHdr?'YES':'NO'],
              ['POINTS', track?.points.length??0],
              ['CONF.', track?`${Math.round(track.averageConfidence*100)}%`:'—'],
              ['METHOD', track?.method||'—'],
            ].map(([label,value])=><div key={label} className="rounded-xl border border-white/6 bg-black/20 p-2"><p className="text-[6px] font-black tracking-widest text-slate-600">{label}</p><p className="mt-1 truncate font-mono text-[9px] text-slate-300">{String(value)}</p></div>)}</div>
          </div>

          {resultUrl && <div className="rounded-3xl border border-cyan-300/15 bg-cyan-300/5 p-4"><h2 className="text-xs font-black text-cyan-200">RESULT READY</h2><video src={resultUrl} controls className="mt-3 w-full rounded-xl bg-black"/><div className="mt-3 grid grid-cols-2 gap-2"><a href={resultUrl} download={resultName} className="rounded-xl border border-cyan-300/20 px-3 py-2 text-center text-[8px] font-black text-cyan-200">DOWNLOAD</a><button onClick={useResult} className="rounded-xl bg-cyan-300 px-3 py-2 text-[8px] font-black text-black">USE RESULT</button></div></div>}

          <div className="rounded-3xl border border-white/8 bg-[#0b111b] p-4">
            <h2 className="text-xs font-black">FINAL DELIVERY</h2>
            <select value={preset} onChange={e=>setPreset(e.target.value as ExportPresetV14)} className="mt-3 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-white">
              <option value="youtube_1080">YouTube 1080p</option><option value="tiktok">TikTok 9:16</option><option value="instagram_reel">Instagram Reels</option><option value="instagram_square">Instagram Square</option><option value="broadcast_1080p25">Broadcast 1080p25</option><option value="master_1080">Master 1080p</option>
            </select>
            <button onClick={finalMaster} disabled={!file||!!busy} className="mt-3 w-full rounded-xl bg-white px-3 py-2 text-[9px] font-black text-black disabled:opacity-40">{busy==='master'?<Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin"/>:null}MASTER CURRENT SOURCE</button>
          </div>
        </aside>
      </div>
    </div>
  </main>
}
