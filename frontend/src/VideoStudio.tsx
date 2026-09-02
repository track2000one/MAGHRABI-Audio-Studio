import {
  ChangeEvent,
  DragEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Activity,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  Gauge,
  Layers3,
  Pause,
  Play,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  UploadCloud,
  Video,
  Volume2,
  WandSparkles,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import {
  OutputSize,
  RenderQuality,
  renderVideoProject,
  VideoClipManifest,
  VideoFilter,
} from './lib/videoApi'

type Asset = {
  file: File
  url: string
  duration: number
}

type Clip = VideoClipManifest & {
  id: string
}

const filterLabels: Record<VideoFilter, string> = {
  none: 'بدون فلتر',
  warm: 'Warm',
  cool: 'Cool',
  cinematic: 'Cinematic',
  vivid: 'Vivid',
  mono: 'Mono',
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function formatTime(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const mins = Math.floor(safe / 60)
  const secs = safe - mins * 60
  return `${String(mins).padStart(2, '0')}:${secs.toFixed(1).padStart(4, '0')}`
}

function previewFilter(filter: VideoFilter) {
  switch (filter) {
    case 'warm': return 'contrast(1.04) brightness(1.02) saturate(1.12) sepia(.10)'
    case 'cool': return 'contrast(1.03) saturate(1.05) hue-rotate(8deg)'
    case 'cinematic': return 'contrast(1.12) brightness(.97) saturate(.90)'
    case 'vivid': return 'contrast(1.07) saturate(1.35)'
    case 'mono': return 'grayscale(1) contrast(1.08)'
    default: return 'none'
  }
}

function readVideoDuration(file: File) {
  return new Promise<number>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      URL.revokeObjectURL(url)
      resolve(duration)
    }
    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`تعذر قراءة مدة الملف ${file.name}`))
    }
    video.src = url
  })
}

export default function VideoStudio() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const dragIndex = useRef<number | null>(null)
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const [clips, setClips] = useState<Clip[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [previewTime, setPreviewTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [transition, setTransition] = useState<'none' | 'fade'>('fade')
  const [transitionDuration, setTransitionDuration] = useState(0.45)
  const [outputSize, setOutputSize] = useState<OutputSize>('720p')
  const [quality, setQuality] = useState<RenderQuality>('standard')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)

  useEffect(() => {
    getAuthStatus()
      .then((status) => setAuthorized(status.authenticated))
      .catch(() => setAuthorized(false))
  }, [])

  useEffect(() => () => {
    assets.forEach((asset) => URL.revokeObjectURL(asset.url))
    if (resultUrl) URL.revokeObjectURL(resultUrl)
  }, [])

  const activeIndex = useMemo(() => clips.findIndex((clip) => clip.id === activeId), [clips, activeId])
  const activeClip = activeIndex >= 0 ? clips[activeIndex] : null
  const activeAsset = activeClip ? assets[activeClip.fileIndex] : null

  const projectDuration = useMemo(() => {
    if (!clips.length) return 0
    const raw = clips.reduce((sum, clip) => sum + (clip.end - clip.start) / clip.speed, 0)
    if (transition !== 'fade' || clips.length < 2) return raw
    return Math.max(0, raw - transitionDuration * (clips.length - 1))
  }, [clips, transition, transitionDuration])

  const updateClip = (id: string, changes: Partial<Clip>) => {
    setClips((current) => current.map((clip) => clip.id === id ? { ...clip, ...changes } : clip))
  }

  const chooseFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []).slice(0, Math.max(0, 10 - assets.length))
    if (!selected.length) return
    setError(null)
    try {
      const durations = await Promise.all(selected.map(readVideoDuration))
      const baseIndex = assets.length
      const newAssets = selected.map((file, index) => ({
        file,
        url: URL.createObjectURL(file),
        duration: durations[index],
      }))
      const newClips: Clip[] = newAssets.map((asset, index) => ({
        id: uid(),
        fileIndex: baseIndex + index,
        start: 0,
        end: asset.duration,
        speed: 1,
        volume: 1,
        filter: 'none',
        text: '',
        textSize: 48,
        textPosition: 'bottom',
      }))
      setAssets((current) => [...current, ...newAssets])
      setClips((current) => [...current, ...newClips])
      if (!activeId && newClips[0]) setActiveId(newClips[0].id)
      event.target.value = ''
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'تعذر قراءة ملفات الفيديو.')
    }
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video || !activeClip || !activeAsset) return
    video.pause()
    setPlaying(false)
    const seek = () => {
      try {
        video.currentTime = activeClip.start
        video.playbackRate = activeClip.speed
        video.volume = clamp(activeClip.volume, 0, 1)
        setPreviewTime(activeClip.start)
      } catch {
        // Browser may not allow seek until metadata is ready.
      }
    }
    if (video.readyState >= 1) seek()
    else video.addEventListener('loadedmetadata', seek, { once: true })
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [activeId, activeClip?.start, activeClip?.speed, activeAsset?.url])

  const togglePlay = async () => {
    const video = videoRef.current
    if (!video || !activeClip) return
    if (video.paused) {
      if (video.currentTime < activeClip.start || video.currentTime >= activeClip.end) {
        video.currentTime = activeClip.start
      }
      video.playbackRate = activeClip.speed
      await video.play().catch(() => undefined)
    } else {
      video.pause()
    }
  }

  const onTimeUpdate = () => {
    const video = videoRef.current
    if (!video || !activeClip) return
    setPreviewTime(video.currentTime)
    if (video.currentTime >= activeClip.end - 0.015) {
      video.pause()
      video.currentTime = activeClip.start
      setPreviewTime(activeClip.start)
    }
  }

  const splitClip = () => {
    if (!activeClip) return
    const splitAt = clamp(previewTime, activeClip.start, activeClip.end)
    if (splitAt - activeClip.start < 0.12 || activeClip.end - splitAt < 0.12) {
      setError('حرّك مؤشر التشغيل داخل المقطع ثم اضغط Split. يجب ترك جزء قبل وبعد نقطة القص.')
      return
    }
    const left: Clip = { ...activeClip, id: uid(), end: splitAt }
    const right: Clip = { ...activeClip, id: uid(), start: splitAt }
    setClips((current) => current.flatMap((clip) => clip.id === activeClip.id ? [left, right] : [clip]))
    setActiveId(right.id)
    setError(null)
  }

  const deleteClip = (id: string) => {
    setClips((current) => {
      const index = current.findIndex((clip) => clip.id === id)
      const next = current.filter((clip) => clip.id !== id)
      if (activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id || null)
      return next
    })
  }

  const moveClip = (index: number, direction: -1 | 1) => {
    setClips((current) => {
      const target = index + direction
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const onDragStart = (index: number) => {
    dragIndex.current = index
  }

  const onDrop = (event: DragEvent<HTMLButtonElement>, target: number) => {
    event.preventDefault()
    const source = dragIndex.current
    dragIndex.current = null
    if (source === null || source === target) return
    setClips((current) => {
      const next = [...current]
      const [moved] = next.splice(source, 1)
      next.splice(target, 0, moved)
      return next
    })
  }

  const exportProject = async () => {
    if (!clips.length || !assets.length) return
    setBusy(true)
    setError(null)
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    setResultUrl(null)
    try {
      const blob = await renderVideoProject(
        assets.map((asset) => asset.file),
        {
          clips: clips.map(({ id: _id, ...clip }) => clip),
          transition,
          transitionDuration,
        },
        outputSize,
        quality,
      )
      setResultUrl(URL.createObjectURL(blob))
    } catch (renderError) {
      setError(renderError instanceof Error ? renderError.message : 'تعذر تصدير الفيديو.')
    } finally {
      setBusy(false)
    }
  }

  if (authorized === null) {
    return <div className="grid min-h-screen place-items-center bg-[#050811] text-slate-400"><Activity className="h-7 w-7 animate-spin text-cyan-300" /></div>
  }

  if (!authorized) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#050811] px-5 text-white">
        <div className="max-w-md rounded-3xl border border-white/10 bg-white/[.035] p-8 text-center">
          <Video className="mx-auto h-10 w-10 text-cyan-300" />
          <h1 className="mt-5 text-xl font-black">يلزم تسجيل الدخول</h1>
          <p className="mt-2 text-sm leading-7 text-slate-500">Video Studio محمي بنفس جلسة MAGHRABI Audio Studio.</p>
          <a href="#" className="mt-6 inline-flex rounded-xl bg-white px-5 py-3 text-sm font-black text-slate-950">العودة لتسجيل الدخول</a>
        </div>
      </main>
    )
  }

  const previewAspect = outputSize === 'portrait' ? '9 / 16' : outputSize === 'square' ? '1 / 1' : '16 / 9'

  return (
    <main className="min-h-screen bg-[#050811] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_78%_8%,rgba(79,70,229,.22),transparent_30%),radial-gradient(circle_at_12%_85%,rgba(6,182,212,.10),transparent_32%)]" />
      <div className="relative mx-auto max-w-[1700px] px-4 py-5 md:px-6">
        <header className="flex flex-col gap-4 border-b border-white/10 pb-5 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl border border-violet-300/20 bg-gradient-to-br from-violet-500/25 to-cyan-400/15"><Film className="h-6 w-6 text-violet-200" /></div>
            <div>
              <div className="flex items-center gap-2"><h1 className="text-xl font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-cyan-300/15 bg-cyan-300/[.05] px-2 py-1 text-[9px] font-black text-cyan-200">V1</span></div>
              <p className="mt-1 text-xs text-slate-500">Timeline Editor · FFmpeg Render Engine</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a href="#tools" className="rounded-xl border border-white/10 bg-white/[.03] px-4 py-2.5 text-xs font-bold text-slate-300">أدوات الصوت</a>
            <a href="#" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.03] px-4 py-2.5 text-xs font-bold text-slate-300"><ArrowLeft className="h-4 w-4" /> الاستوديو الرئيسي</a>
          </div>
        </header>

        <section className="mt-5 grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_310px]">
          <aside className="rounded-3xl border border-white/10 bg-[#0a0f1b]/90 p-4">
            <div className="flex items-center justify-between"><div><p className="text-xs font-black text-slate-200">MEDIA</p><p className="mt-1 text-[10px] text-slate-600">مكتبة المشروع</p></div><Layers3 className="h-4 w-4 text-slate-600" /></div>
            <label className="mt-4 flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-cyan-300/20 bg-cyan-300/[.04] px-4 py-4 text-xs font-black text-cyan-100 transition hover:bg-cyan-300/[.08]">
              <UploadCloud className="h-4 w-4" /> إضافة فيديو
              <input type="file" multiple accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi" className="hidden" onChange={chooseFiles} />
            </label>
            <div className="mt-4 space-y-2">
              {!assets.length && <div className="rounded-2xl border border-white/5 bg-black/15 p-4 text-center text-[11px] leading-6 text-slate-600">ارفع ملفات الفيديو لبدء المشروع.</div>}
              {assets.map((asset, index) => (
                <div key={`${asset.file.name}-${index}`} className="rounded-2xl border border-white/8 bg-white/[.025] p-3">
                  <div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-violet-300/[.07]"><Video className="h-4 w-4 text-violet-200" /></div><div className="min-w-0"><p className="truncate text-xs font-bold text-slate-300">{asset.file.name}</p><p className="mt-1 text-[10px] text-slate-600">{formatTime(asset.duration)} · {(asset.file.size / 1024 / 1024).toFixed(1)} MB</p></div></div>
                </div>
              ))}
            </div>
          </aside>

          <div className="min-w-0 space-y-4">
            <div className="rounded-3xl border border-white/10 bg-[#080d17]/95 p-4 sm:p-5">
              <div className="mb-4 flex items-center justify-between"><div><p className="text-xs font-black">PREVIEW</p><p className="mt-1 text-[10px] text-slate-600">معاينة المقطع المحدد</p></div><span className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-[10px] tabular-nums text-slate-400">{formatTime(previewTime)}</span></div>
              <div className="mx-auto flex max-h-[64vh] w-full items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-black" style={{ aspectRatio: previewAspect }}>
                {activeAsset && activeClip ? (
                  <div className="relative h-full w-full">
                    <video
                      ref={videoRef}
                      src={activeAsset.url}
                      className="h-full w-full object-contain"
                      style={{ filter: previewFilter(activeClip.filter) }}
                      onTimeUpdate={onTimeUpdate}
                      onPlay={() => setPlaying(true)}
                      onPause={() => setPlaying(false)}
                      playsInline
                    />
                    {activeClip.text && (
                      <div className={`pointer-events-none absolute left-5 right-5 text-center font-black text-white drop-shadow-[0_2px_8px_rgba(0,0,0,.9)] ${activeClip.textPosition === 'top' ? 'top-[8%]' : activeClip.textPosition === 'center' ? 'top-1/2 -translate-y-1/2' : 'bottom-[8%]'}`} style={{ fontSize: `${clamp(activeClip.textSize / 2, 14, 48)}px` }}>
                        <span className="rounded-lg bg-black/45 px-3 py-1.5">{activeClip.text}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center"><Film className="mx-auto h-12 w-12 text-slate-800" /><p className="mt-4 text-sm font-bold text-slate-600">أضف فيديو إلى Timeline</p></div>
                )}
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <button onClick={togglePlay} disabled={!activeClip} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-xs font-black text-slate-950 disabled:opacity-30">{playing ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="h-4 w-4" fill="currentColor" />}{playing ? 'إيقاف' : 'تشغيل'}</button>
                <button onClick={splitClip} disabled={!activeClip} className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] px-4 py-2.5 text-xs font-black text-cyan-100 disabled:opacity-30"><Scissors className="h-4 w-4" /> Split عند المؤشر</button>
                {activeClip && <button onClick={() => deleteClip(activeClip.id)} className="inline-flex items-center gap-2 rounded-xl border border-rose-300/15 bg-rose-400/[.05] px-4 py-2.5 text-xs font-bold text-rose-200"><Trash2 className="h-4 w-4" /> حذف المقطع</button>}
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-[#080d17]/95 p-4">
              <div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-black">TIMELINE</p><p className="mt-1 text-[10px] text-slate-600">اسحب المقاطع لإعادة الترتيب · المدة {formatTime(projectDuration)}</p></div><Scissors className="h-4 w-4 text-slate-600" /></div>
              <div className="overflow-x-auto pb-2">
                <div className="flex min-w-max items-stretch gap-2">
                  {clips.map((clip, index) => {
                    const asset = assets[clip.fileIndex]
                    const seconds = (clip.end - clip.start) / clip.speed
                    const width = clamp(seconds * 7, 150, 360)
                    const selected = clip.id === activeId
                    return (
                      <button
                        key={clip.id}
                        draggable
                        onDragStart={() => onDragStart(index)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => onDrop(event, index)}
                        onClick={() => setActiveId(clip.id)}
                        className={`relative overflow-hidden rounded-2xl border p-3 text-right transition ${selected ? 'border-cyan-300/45 bg-cyan-300/[.08]' : 'border-white/10 bg-white/[.03] hover:border-white/20'}`}
                        style={{ width }}
                      >
                        <div className="absolute inset-x-0 bottom-0 h-1 bg-gradient-to-r from-violet-500 via-cyan-400 to-indigo-500 opacity-70" />
                        <div className="flex items-center justify-between gap-2"><span className="rounded-md bg-black/30 px-2 py-1 text-[9px] font-black text-slate-400">CLIP {index + 1}</span><span className="text-[9px] tabular-nums text-cyan-200">{formatTime(seconds)}</span></div>
                        <p className="mt-3 truncate text-xs font-black text-slate-200">{asset?.file.name || 'Video'}</p>
                        <p className="mt-1 text-[9px] text-slate-600">{formatTime(clip.start)} → {formatTime(clip.end)} · {clip.speed.toFixed(2)}x</p>
                        {clip.text && <p className="mt-2 truncate rounded-lg bg-black/20 px-2 py-1 text-[9px] text-slate-500">T: {clip.text}</p>}
                      </button>
                    )
                  })}
                  {!clips.length && <div className="grid h-28 w-[540px] place-items-center rounded-2xl border border-dashed border-white/10 text-xs text-slate-700">Timeline فارغ</div>}
                </div>
              </div>
              {activeIndex >= 0 && (
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={() => moveClip(activeIndex, -1)} className="rounded-lg border border-white/10 p-2 text-slate-400 disabled:opacity-20" disabled={activeIndex === 0}><ChevronRight className="h-4 w-4" /></button>
                  <button onClick={() => moveClip(activeIndex, 1)} className="rounded-lg border border-white/10 p-2 text-slate-400 disabled:opacity-20" disabled={activeIndex === clips.length - 1}><ChevronLeft className="h-4 w-4" /></button>
                  <span className="text-[10px] text-slate-600">تحريك المقطع المحدد داخل Timeline</span>
                </div>
              )}
            </div>

            {resultUrl && (
              <div className="rounded-3xl border border-emerald-300/15 bg-emerald-300/[.035] p-5">
                <div className="flex items-center justify-between"><div><p className="text-sm font-black text-emerald-100">اكتمل Render بنجاح</p><p className="mt-1 text-xs text-slate-500">MAGHRABI-video.mp4</p></div><Sparkles className="h-5 w-5 text-emerald-300" /></div>
                <video controls src={resultUrl} className="mt-4 max-h-[480px] w-full rounded-2xl bg-black" />
                <a href={resultUrl} download="MAGHRABI-video.mp4" className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-5 py-3.5 text-sm font-black text-slate-950"><Download className="h-4 w-4" /> تنزيل الفيديو</a>
              </div>
            )}
          </div>

          <aside className="rounded-3xl border border-white/10 bg-[#0a0f1b]/90 p-4">
            <div className="flex items-center justify-between"><div><p className="text-xs font-black">INSPECTOR</p><p className="mt-1 text-[10px] text-slate-600">خصائص المقطع والتصدير</p></div><WandSparkles className="h-4 w-4 text-violet-300" /></div>

            {activeClip && activeAsset ? (
              <div className="mt-5 space-y-5">
                <div>
                  <div className="mb-2 flex items-center gap-2 text-[11px] font-black text-slate-400"><Scissors className="h-3.5 w-3.5" /> Trim</div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[10px] text-slate-600">START<input type="number" step="0.05" min="0" max={activeClip.end - 0.05} value={Number(activeClip.start.toFixed(2))} onChange={(event) => updateClip(activeClip.id, { start: clamp(Number(event.target.value), 0, activeClip.end - 0.05) })} className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white outline-none" /></label>
                    <label className="text-[10px] text-slate-600">END<input type="number" step="0.05" min={activeClip.start + 0.05} max={activeAsset.duration} value={Number(activeClip.end.toFixed(2))} onChange={(event) => updateClip(activeClip.id, { end: clamp(Number(event.target.value), activeClip.start + 0.05, activeAsset.duration) })} className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white outline-none" /></label>
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between text-[11px] font-black text-slate-400"><span className="flex items-center gap-2"><Gauge className="h-3.5 w-3.5" /> السرعة</span><span className="text-cyan-200">{activeClip.speed.toFixed(2)}x</span></div>
                  <input type="range" min="0.25" max="4" step="0.05" value={activeClip.speed} onChange={(event) => updateClip(activeClip.id, { speed: Number(event.target.value) })} className="w-full accent-cyan-300" />
                  <div className="mt-1 flex justify-between text-[9px] text-slate-700"><span>0.25x</span><span>1x</span><span>4x</span></div>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between text-[11px] font-black text-slate-400"><span className="flex items-center gap-2"><Volume2 className="h-3.5 w-3.5" /> الصوت</span><span>{Math.round(activeClip.volume * 100)}%</span></div>
                  <input type="range" min="0" max="2" step="0.05" value={activeClip.volume} onChange={(event) => updateClip(activeClip.id, { volume: Number(event.target.value) })} className="w-full accent-violet-300" />
                </div>

                <label className="block"><span className="mb-2 block text-[11px] font-black text-slate-400">فلتر الصورة</span><select value={activeClip.filter} onChange={(event) => updateClip(activeClip.id, { filter: event.target.value as VideoFilter })} className="w-full rounded-xl border border-white/10 bg-[#0c1321] px-3 py-2.5 text-xs outline-none">{(Object.keys(filterLabels) as VideoFilter[]).map((filter) => <option key={filter} value={filter}>{filterLabels[filter]}</option>)}</select></label>

                <div>
                  <div className="mb-2 flex items-center gap-2 text-[11px] font-black text-slate-400"><Type className="h-3.5 w-3.5" /> النص</div>
                  <textarea value={activeClip.text} onChange={(event) => updateClip(activeClip.id, { text: event.target.value })} rows={3} maxLength={500} placeholder="اكتب النص الذي سيظهر فوق الفيديو..." className="w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-xs outline-none placeholder:text-slate-700" />
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <select value={activeClip.textPosition} onChange={(event) => updateClip(activeClip.id, { textPosition: event.target.value as Clip['textPosition'] })} className="rounded-xl border border-white/10 bg-[#0c1321] px-3 py-2 text-xs"><option value="top">أعلى</option><option value="center">المنتصف</option><option value="bottom">أسفل</option></select>
                    <input type="number" min="24" max="96" value={activeClip.textSize} onChange={(event) => updateClip(activeClip.id, { textSize: clamp(Number(event.target.value), 24, 96) })} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none" />
                  </div>
                </div>
              </div>
            ) : <div className="mt-5 rounded-2xl border border-dashed border-white/10 p-5 text-center text-[11px] leading-6 text-slate-600">اختر مقطعًا من Timeline لتعديل خصائصه.</div>}

            <div className="my-5 border-t border-white/10" />
            <div className="space-y-3">
              <label className="block"><span className="mb-2 block text-[11px] font-black text-slate-400">Transition</span><div className="grid grid-cols-2 gap-2"><button onClick={() => setTransition('none')} className={`rounded-xl border px-3 py-2 text-xs font-bold ${transition === 'none' ? 'border-cyan-300/35 bg-cyan-300/[.07] text-cyan-100' : 'border-white/10 text-slate-500'}`}>بدون</button><button onClick={() => setTransition('fade')} className={`rounded-xl border px-3 py-2 text-xs font-bold ${transition === 'fade' ? 'border-cyan-300/35 bg-cyan-300/[.07] text-cyan-100' : 'border-white/10 text-slate-500'}`}>Fade</button></div></label>
              {transition === 'fade' && <label className="block"><span className="mb-2 flex justify-between text-[10px] text-slate-600"><span>مدة الانتقال</span><span>{transitionDuration.toFixed(2)}s</span></span><input type="range" min="0.15" max="1.5" step="0.05" value={transitionDuration} onChange={(event) => setTransitionDuration(Number(event.target.value))} className="w-full accent-cyan-300" /></label>}
              <label className="block"><span className="mb-2 block text-[11px] font-black text-slate-400">مقاس الإخراج</span><select value={outputSize} onChange={(event) => setOutputSize(event.target.value as OutputSize)} className="w-full rounded-xl border border-white/10 bg-[#0c1321] px-3 py-2.5 text-xs"><option value="720p">16:9 · 720p</option><option value="1080p">16:9 · 1080p</option><option value="portrait">9:16 · Vertical</option><option value="square">1:1 · Square</option></select></label>
              <label className="block"><span className="mb-2 block text-[11px] font-black text-slate-400">الجودة</span><select value={quality} onChange={(event) => setQuality(event.target.value as RenderQuality)} className="w-full rounded-xl border border-white/10 bg-[#0c1321] px-3 py-2.5 text-xs"><option value="draft">Draft · سريع</option><option value="standard">Standard · متوازن</option><option value="high">High · جودة أعلى</option></select></label>
            </div>

            {error && <div className="mt-4 rounded-2xl border border-rose-300/15 bg-rose-400/[.06] px-4 py-3 text-xs leading-6 text-rose-200">{error}</div>}

            <button onClick={exportProject} disabled={busy || !clips.length} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-l from-violet-500 to-cyan-500 px-4 py-4 text-sm font-black shadow-xl shadow-indigo-950/40 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35">
              {busy ? <Activity className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {busy ? 'جاري Render الفيديو...' : 'Export MP4'}
            </button>
            <p className="mt-3 text-center text-[9px] leading-5 text-slate-700">Render يتم على Railway CPU. المشاريع الطويلة أو 1080p High قد تحتاج وقتًا أطول.</p>
          </aside>
        </section>
      </div>
    </main>
  )
}
