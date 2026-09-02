import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  Download,
  Film,
  Image as ImageIcon,
  Music2,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCw,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  UploadCloud,
  Video,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import {
  AudioTrackManifest,
  ImageTrackManifest,
  OutputSize,
  RenderQuality,
  renderVideoProjectV2,
  TextTrackManifest,
  VideoClipManifest,
  VideoFilter,
} from './lib/videoApi'

type VideoAsset = { file: File; url: string; duration: number }
type AudioAsset = { file: File; duration: number }
type ImageAsset = { file: File; url: string }
type Clip = VideoClipManifest & { id: string }
type TextTrack = TextTrackManifest & { id: string }
type AudioTrack = AudioTrackManifest & { id: string }
type ImageTrack = ImageTrackManifest & { id: string }
type ProjectState = {
  clips: Clip[]
  textTracks: TextTrack[]
  audioTracks: AudioTrack[]
  imageTracks: ImageTrack[]
  transition: 'none' | 'fade'
  transitionDuration: number
}
type History = { past: ProjectState[]; present: ProjectState; future: ProjectState[] }
type Selection = { kind: 'clip' | 'text' | 'audio' | 'image'; id: string } | null

const initialProject: ProjectState = {
  clips: [], textTracks: [], audioTracks: [], imageTracks: [], transition: 'fade', transitionDuration: .45,
}

const filters: Array<{ value: VideoFilter; label: string }> = [
  { value: 'none', label: 'Normal' }, { value: 'warm', label: 'Warm' }, { value: 'cool', label: 'Cool' },
  { value: 'cinematic', label: 'Cinematic' }, { value: 'vivid', label: 'Vivid' }, { value: 'mono', label: 'Mono' },
]

function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}` }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)) }
function fmt(sec: number) {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}
function previewFilter(filter: VideoFilter) {
  if (filter === 'warm') return 'contrast(1.04) brightness(1.02) saturate(1.12) sepia(.10)'
  if (filter === 'cool') return 'contrast(1.03) saturate(1.05) hue-rotate(8deg)'
  if (filter === 'cinematic') return 'contrast(1.12) brightness(.97) saturate(.90)'
  if (filter === 'vivid') return 'contrast(1.07) saturate(1.35)'
  if (filter === 'mono') return 'grayscale(1) contrast(1.08)'
  return 'none'
}
function mediaDuration(file: File, kind: 'video' | 'audio') {
  return new Promise<number>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const element = document.createElement(kind)
    element.preload = 'metadata'
    element.onloadedmetadata = () => { const d = Number.isFinite(element.duration) ? element.duration : 0; URL.revokeObjectURL(url); resolve(d) }
    element.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`تعذر قراءة مدة ${file.name}`)) }
    element.src = url
  })
}

export default function VideoStudioPro() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [videos, setVideos] = useState<VideoAsset[]>([])
  const [audios, setAudios] = useState<AudioAsset[]>([])
  const [images, setImages] = useState<ImageAsset[]>([])
  const [history, setHistory] = useState<History>({ past: [], present: initialProject, future: [] })
  const [selection, setSelection] = useState<Selection>(null)
  const [previewTime, setPreviewTime] = useState(0)
  const [projectTime, setProjectTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [zoom, setZoom] = useState(6)
  const [outputSize, setOutputSize] = useState<OutputSize>('720p')
  const [quality, setQuality] = useState<RenderQuality>('standard')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)

  const project = history.present
  const commit = (updater: (state: ProjectState) => ProjectState) => {
    setHistory((h) => ({ past: [...h.past, h.present].slice(-60), present: updater(h.present), future: [] }))
  }
  const undo = () => setHistory((h) => h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h)
  const redo = () => setHistory((h) => h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h)

  useEffect(() => { getAuthStatus().then(s => setAuthorized(s.authenticated)).catch(() => setAuthorized(false)) }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
      if (event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  useEffect(() => () => {
    videos.forEach(v => URL.revokeObjectURL(v.url)); images.forEach(i => URL.revokeObjectURL(i.url)); if (resultUrl) URL.revokeObjectURL(resultUrl)
  }, [])

  const clipOffsets = useMemo(() => {
    let cursor = 0
    return project.clips.map((clip, index) => {
      const duration = (clip.end - clip.start) / clip.speed
      const start = cursor
      cursor += duration
      if (project.transition === 'fade' && index < project.clips.length - 1) cursor -= Math.min(project.transitionDuration, duration / 3)
      return { start, end: start + duration, duration }
    })
  }, [project.clips, project.transition, project.transitionDuration])
  const projectDuration = clipOffsets.at(-1)?.end || 0
  const selectedClipIndex = selection?.kind === 'clip' ? project.clips.findIndex(c => c.id === selection.id) : -1
  const selectedClip = selectedClipIndex >= 0 ? project.clips[selectedClipIndex] : null
  const selectedVideo = selectedClip ? videos[selectedClip.fileIndex] : null

  const addVideos = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).slice(0, 10 - videos.length)
    if (!files.length) return
    setError(null)
    try {
      const durations = await Promise.all(files.map(f => mediaDuration(f, 'video')))
      const base = videos.length
      const nextAssets = files.map((file, i) => ({ file, url: URL.createObjectURL(file), duration: durations[i] }))
      const nextClips: Clip[] = nextAssets.map((asset, i) => ({
        id: uid(), fileIndex: base + i, start: 0, end: asset.duration, speed: 1, volume: 1,
        filter: 'none', text: '', textSize: 48, textPosition: 'bottom', rotation: 0, fit: 'contain',
      }))
      setVideos(v => [...v, ...nextAssets])
      commit(p => ({ ...p, clips: [...p.clips, ...nextClips] }))
      if (nextClips[0]) setSelection({ kind: 'clip', id: nextClips[0].id })
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الفيديو.') }
    event.target.value = ''
  }

  const addAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    try {
      const duration = await mediaDuration(file, 'audio')
      const index = audios.length
      setAudios(a => [...a, { file, duration }])
      const track: AudioTrack = { id: uid(), fileIndex: index, startAt: 0, sourceStart: 0, sourceEnd: duration, volume: .65, fadeIn: .3, fadeOut: .5 }
      commit(p => ({ ...p, audioTracks: [...p.audioTracks, track] })); setSelection({ kind: 'audio', id: track.id })
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الصوت.') }
    event.target.value = ''
  }

  const addImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    const index = images.length
    setImages(v => [...v, { file, url: URL.createObjectURL(file) }])
    const track: ImageTrack = { id: uid(), fileIndex: index, startAt: 0, endAt: Math.max(3, projectDuration || 5), scale: .22, opacity: 1, position: 'bottom-right' }
    commit(p => ({ ...p, imageTracks: [...p.imageTracks, track] })); setSelection({ kind: 'image', id: track.id }); event.target.value = ''
  }

  const addText = () => {
    const track: TextTrack = { id: uid(), text: 'عنوان جديد', startAt: projectTime, endAt: Math.min(projectDuration || projectTime + 4, projectTime + 4), size: 52, position: 'bottom' }
    if (track.endAt <= track.startAt) track.endAt = track.startAt + 2
    commit(p => ({ ...p, textTracks: [...p.textTracks, track] })); setSelection({ kind: 'text', id: track.id })
  }

  const updateClip = (id: string, changes: Partial<Clip>) => commit(p => ({ ...p, clips: p.clips.map(c => c.id === id ? { ...c, ...changes } : c) }))
  const updateText = (id: string, changes: Partial<TextTrack>) => commit(p => ({ ...p, textTracks: p.textTracks.map(t => t.id === id ? { ...t, ...changes } : t) }))
  const updateAudio = (id: string, changes: Partial<AudioTrack>) => commit(p => ({ ...p, audioTracks: p.audioTracks.map(t => t.id === id ? { ...t, ...changes } : t) }))
  const updateImage = (id: string, changes: Partial<ImageTrack>) => commit(p => ({ ...p, imageTracks: p.imageTracks.map(t => t.id === id ? { ...t, ...changes } : t) }))

  const deleteSelection = () => {
    if (!selection) return
    commit(p => ({ ...p,
      clips: selection.kind === 'clip' ? p.clips.filter(x => x.id !== selection.id) : p.clips,
      textTracks: selection.kind === 'text' ? p.textTracks.filter(x => x.id !== selection.id) : p.textTracks,
      audioTracks: selection.kind === 'audio' ? p.audioTracks.filter(x => x.id !== selection.id) : p.audioTracks,
      imageTracks: selection.kind === 'image' ? p.imageTracks.filter(x => x.id !== selection.id) : p.imageTracks,
    })); setSelection(null)
  }

  const splitClip = () => {
    if (!selectedClip) return
    const at = clamp(previewTime, selectedClip.start, selectedClip.end)
    if (at - selectedClip.start < .12 || selectedClip.end - at < .12) { setError('حرّك مؤشر التشغيل داخل المقطع ثم اضغط Split.'); return }
    const left = { ...selectedClip, id: uid(), end: at }
    const right = { ...selectedClip, id: uid(), start: at }
    commit(p => ({ ...p, clips: p.clips.flatMap(c => c.id === selectedClip.id ? [left, right] : [c]) }))
    setSelection({ kind: 'clip', id: right.id }); setError(null)
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video || !selectedClip || !selectedVideo) return
    video.pause(); setPlaying(false)
    const seek = () => { try { video.currentTime = selectedClip.start; video.playbackRate = selectedClip.speed; video.volume = clamp(selectedClip.volume, 0, 1); setPreviewTime(selectedClip.start) } catch {} }
    if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true })
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [selection?.id, selectedVideo?.url])

  const timeUpdate = () => {
    const video = videoRef.current; if (!video || !selectedClip || selectedClipIndex < 0) return
    const t = video.currentTime; setPreviewTime(t)
    setProjectTime((clipOffsets[selectedClipIndex]?.start || 0) + Math.max(0, (t - selectedClip.start) / selectedClip.speed))
    if (t >= selectedClip.end - .015) { video.pause(); video.currentTime = selectedClip.start }
  }
  const togglePlay = async () => {
    const video = videoRef.current; if (!video || !selectedClip) return
    if (video.paused) { if (video.currentTime < selectedClip.start || video.currentTime >= selectedClip.end) video.currentTime = selectedClip.start; video.playbackRate = selectedClip.speed; await video.play().catch(() => undefined) } else video.pause()
  }

  const activeTexts = project.textTracks.filter(t => projectTime >= t.startAt && projectTime <= t.endAt)
  const activeImages = project.imageTracks.filter(t => projectTime >= t.startAt && projectTime <= t.endAt)
  const timelineWidth = Math.max(720, projectDuration * zoom + 80)

  const exportProject = async () => {
    if (!project.clips.length) return
    setBusy(true); setError(null); if (resultUrl) URL.revokeObjectURL(resultUrl); setResultUrl(null)
    try {
      const blob = await renderVideoProjectV2(
        videos.map(v => v.file), audios.map(a => a.file), images.map(i => i.file),
        {
          clips: project.clips.map(({ id: _id, ...clip }) => clip),
          textTracks: project.textTracks.map(({ id: _id, ...track }) => track),
          audioTracks: project.audioTracks.map(({ id: _id, ...track }) => track),
          imageTracks: project.imageTracks.map(({ id: _id, ...track }) => track),
          transition: project.transition, transitionDuration: project.transitionDuration,
        }, outputSize, quality,
      )
      setResultUrl(URL.createObjectURL(blob))
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر Render المشروع.') }
    finally { setBusy(false) }
  }

  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#050811]"><Activity className="h-7 w-7 animate-spin text-cyan-300" /></div>
  if (!authorized) return <div className="grid min-h-screen place-items-center bg-[#050811] text-white"><a href="#" className="rounded-2xl bg-white px-6 py-3 font-black text-black">العودة لتسجيل الدخول</a></div>

  const selectedText = selection?.kind === 'text' ? project.textTracks.find(x => x.id === selection.id) : null
  const selectedAudio = selection?.kind === 'audio' ? project.audioTracks.find(x => x.id === selection.id) : null
  const selectedImage = selection?.kind === 'image' ? project.imageTracks.find(x => x.id === selection.id) : null
  const aspect = outputSize === 'portrait' ? '9 / 16' : outputSize === 'square' ? '1 / 1' : '16 / 9'

  return (
    <main className="min-h-screen bg-[#050811] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_80%_0%,rgba(124,58,237,.18),transparent_32%),radial-gradient(circle_at_0%_90%,rgba(6,182,212,.10),transparent_30%)]" />
      <div className="relative mx-auto max-w-[1800px] px-4 py-4 md:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
          <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-violet-500/15"><Film className="h-5 w-5 text-violet-200" /></div><div><div className="flex items-center gap-2"><h1 className="text-lg font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-violet-300/20 bg-violet-300/[.06] px-2 py-1 text-[9px] font-black text-violet-200">PRO V2</span></div><p className="mt-1 text-[10px] text-slate-600">Multi‑Track Timeline · Layered Render Engine</p></div></div>
          <div className="flex flex-wrap items-center gap-2"><button onClick={undo} disabled={!history.past.length} className="rounded-xl border border-white/10 p-2.5 text-slate-300 disabled:opacity-25" title="Undo Ctrl+Z"><Undo2 className="h-4 w-4" /></button><button onClick={redo} disabled={!history.future.length} className="rounded-xl border border-white/10 p-2.5 text-slate-300 disabled:opacity-25" title="Redo"><Redo2 className="h-4 w-4" /></button><a href="#video-basic" className="rounded-xl border border-white/10 px-3 py-2.5 text-xs text-slate-400">V1</a><a href="#" className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-xs text-slate-400"><ArrowLeft className="h-4 w-4" /> الرئيسية</a></div>
        </header>

        <section className="mt-4 grid gap-4 xl:grid-cols-[250px_minmax(0,1fr)_320px]">
          <aside className="rounded-3xl border border-white/10 bg-[#090f1a]/95 p-4">
            <p className="text-xs font-black">MEDIA & LAYERS</p><p className="mt-1 text-[10px] text-slate-600">أضف وسائط وطبقات إلى المشروع</p>
            <div className="mt-4 grid gap-2">
              <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[.035] p-3 text-xs font-bold"><Video className="h-4 w-4 text-cyan-300" /> فيديو<input className="hidden" type="file" multiple accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi" onChange={addVideos} /></label>
              <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-fuchsia-300/15 bg-fuchsia-300/[.035] p-3 text-xs font-bold"><Music2 className="h-4 w-4 text-fuchsia-300" /> موسيقى / صوت<input className="hidden" type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg" onChange={addAudio} /></label>
              <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-amber-300/15 bg-amber-300/[.035] p-3 text-xs font-bold"><ImageIcon className="h-4 w-4 text-amber-300" /> صورة / شعار<input className="hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={addImage} /></label>
              <button onClick={addText} className="flex items-center gap-3 rounded-2xl border border-emerald-300/15 bg-emerald-300/[.035] p-3 text-xs font-bold"><Type className="h-4 w-4 text-emerald-300" /> طبقة نص</button>
            </div>
            <div className="mt-5 space-y-2">{videos.map((v, i) => <button key={i} onClick={() => { const c = project.clips.find(x => x.fileIndex === i); if (c) setSelection({ kind: 'clip', id: c.id }) }} className="flex w-full items-center gap-2 rounded-xl border border-white/7 bg-white/[.02] p-2.5 text-right"><Video className="h-4 w-4 text-slate-500" /><div className="min-w-0"><p className="truncate text-[11px] font-bold">{v.file.name}</p><p className="text-[9px] text-slate-600">{fmt(v.duration)}</p></div></button>)}</div>
          </aside>

          <div className="min-w-0 space-y-4">
            <div className="rounded-3xl border border-white/10 bg-[#080d16] p-4">
              <div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-black">PROGRAM MONITOR</p><p className="mt-1 text-[10px] text-slate-600">Preview · {fmt(projectTime)} / {fmt(projectDuration)}</p></div><span className="rounded-lg bg-black/30 px-2 py-1 text-[10px] text-cyan-200">{outputSize}</span></div>
              <div className="relative mx-auto flex max-h-[62vh] w-full items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-black" style={{ aspectRatio: aspect }}>
                {selectedClip && selectedVideo ? <>
                  <video ref={videoRef} src={selectedVideo.url} playsInline className={`h-full w-full ${selectedClip.fit === 'cover' ? 'object-cover' : 'object-contain'}`} style={{ filter: previewFilter(selectedClip.filter), transform: `rotate(${selectedClip.rotation || 0}deg)` }} onTimeUpdate={timeUpdate} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
                  {activeTexts.map(t => <div key={t.id} className={`pointer-events-none absolute left-5 right-5 text-center font-black text-white drop-shadow-lg ${t.position === 'top' ? 'top-[8%]' : t.position === 'center' ? 'top-1/2 -translate-y-1/2' : 'bottom-[8%]'}`} style={{ fontSize: clamp(t.size / 2, 14, 56) }}><span className="rounded bg-black/45 px-3 py-1">{t.text}</span></div>)}
                  {activeImages.map(t => { const img = images[t.fileIndex]; if (!img) return null; const pos = t.position; const cls = pos === 'top-left' ? 'left-6 top-6' : pos === 'top-right' ? 'right-6 top-6' : pos === 'bottom-left' ? 'left-6 bottom-6' : pos === 'center' ? 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2' : 'right-6 bottom-6'; return <img key={t.id} src={img.url} className={`absolute ${cls}`} style={{ width: `${t.scale * 100}%`, opacity: t.opacity }} /> })}
                </> : <div className="text-center"><Film className="mx-auto h-12 w-12 text-slate-800" /><p className="mt-3 text-sm font-bold text-slate-600">أضف فيديو وحدد Clip</p></div>}
              </div>
              <div className="mt-3 flex flex-wrap justify-center gap-2"><button onClick={togglePlay} disabled={!selectedClip} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-xs font-black text-black disabled:opacity-30">{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}{playing ? 'إيقاف' : 'تشغيل'}</button><button onClick={splitClip} disabled={!selectedClip} className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] px-4 py-2.5 text-xs font-black text-cyan-100 disabled:opacity-30"><Scissors className="h-4 w-4" /> Split</button><button onClick={deleteSelection} disabled={!selection} className="inline-flex items-center gap-2 rounded-xl border border-rose-300/15 px-4 py-2.5 text-xs font-bold text-rose-200 disabled:opacity-30"><Trash2 className="h-4 w-4" /> حذف</button></div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-[#080d16] p-4">
              <div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-xs font-black">MULTI‑TRACK TIMELINE</p><p className="mt-1 text-[10px] text-slate-600">VIDEO · TEXT · MUSIC · OVERLAY</p></div><div className="flex items-center gap-2"><ZoomOut className="h-3.5 w-3.5 text-slate-600" /><input type="range" min="3" max="18" step="1" value={zoom} onChange={e => setZoom(Number(e.target.value))} className="w-28 accent-cyan-300" /><ZoomIn className="h-3.5 w-3.5 text-slate-600" /></div></div>
              <div className="overflow-x-auto rounded-2xl border border-white/8 bg-black/20">
                <div className="relative" style={{ width: timelineWidth }}>
                  <div className="absolute inset-y-0 z-20 w-px bg-white/60" style={{ left: Math.min(timelineWidth, projectTime * zoom) }} />
                  <LaneLabel text="VIDEO" color="text-cyan-300" />
                  <div className="relative ml-20 flex h-20 items-center gap-1 border-b border-white/5 px-1">{project.clips.map((c, i) => <button key={c.id} onClick={() => setSelection({ kind: 'clip', id: c.id })} className={`h-14 shrink-0 rounded-xl border px-3 text-left ${selection?.id === c.id ? 'border-cyan-300/50 bg-cyan-300/[.12]' : 'border-white/10 bg-cyan-300/[.04]'}`} style={{ width: Math.max(80, (clipOffsets[i]?.duration || 1) * zoom) }}><p className="truncate text-[10px] font-black">Clip {i + 1}</p><p className="mt-1 text-[9px] text-slate-600">{fmt(clipOffsets[i]?.duration || 0)}</p></button>)}</div>
                  <TrackLane label="TEXT" color="bg-emerald-400/15" items={project.textTracks.map(t => ({ id: t.id, start: t.startAt, end: t.endAt, title: t.text }))} zoom={zoom} onSelect={id => setSelection({ kind: 'text', id })} selected={selection?.kind === 'text' ? selection.id : ''} />
                  <TrackLane label="MUSIC" color="bg-fuchsia-400/15" items={project.audioTracks.map((t, i) => ({ id: t.id, start: t.startAt, end: t.startAt + (t.sourceEnd - t.sourceStart), title: audios[t.fileIndex]?.file.name || `Audio ${i + 1}` }))} zoom={zoom} onSelect={id => setSelection({ kind: 'audio', id })} selected={selection?.kind === 'audio' ? selection.id : ''} />
                  <TrackLane label="OVERLAY" color="bg-amber-400/15" items={project.imageTracks.map((t, i) => ({ id: t.id, start: t.startAt, end: t.endAt, title: images[t.fileIndex]?.file.name || `Image ${i + 1}` }))} zoom={zoom} onSelect={id => setSelection({ kind: 'image', id })} selected={selection?.kind === 'image' ? selection.id : ''} />
                </div>
              </div>
            </div>

            {resultUrl && <div className="rounded-3xl border border-emerald-300/15 bg-emerald-300/[.035] p-4"><p className="text-sm font-black text-emerald-100">اكتمل Render الاحترافي</p><video controls src={resultUrl} className="mt-3 max-h-[480px] w-full rounded-2xl bg-black" /><a href={resultUrl} download="MAGHRABI-video-pro.mp4" className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-black text-black"><Download className="h-4 w-4" /> تنزيل الفيديو</a></div>}
          </div>

          <aside className="rounded-3xl border border-white/10 bg-[#090f1a]/95 p-4">
            <div className="flex items-center justify-between"><div><p className="text-xs font-black">PRO INSPECTOR</p><p className="mt-1 text-[10px] text-slate-600">خصائص الطبقة المحددة</p></div><Sparkles className="h-4 w-4 text-violet-300" /></div>
            <div className="mt-5 space-y-4">
              {selectedClip && <ClipInspector clip={selectedClip} duration={selectedVideo?.duration || selectedClip.end} update={changes => updateClip(selectedClip.id, changes)} />}
              {selectedText && <TextInspector track={selectedText} update={changes => updateText(selectedText.id, changes)} />}
              {selectedAudio && <AudioInspector track={selectedAudio} duration={audios[selectedAudio.fileIndex]?.duration || selectedAudio.sourceEnd} update={changes => updateAudio(selectedAudio.id, changes)} />}
              {selectedImage && <ImageInspector track={selectedImage} update={changes => updateImage(selectedImage.id, changes)} />}
              {!selection && <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-xs leading-6 text-slate-600">حدد Clip أو طبقة من Timeline لتعديل خصائصها.</div>}
              <div className="border-t border-white/10 pt-4"><p className="text-[10px] font-black text-slate-500">PROJECT</p><div className="mt-3 grid grid-cols-2 gap-2"><select value={project.transition} onChange={e => commit(p => ({ ...p, transition: e.target.value as 'none' | 'fade' }))} className="rounded-xl border border-white/10 bg-[#0b1120] p-2.5 text-xs"><option value="fade">Fade</option><option value="none">Cut</option></select><input type="number" min=".1" max="1.5" step=".05" value={project.transitionDuration} onChange={e => commit(p => ({ ...p, transitionDuration: clamp(Number(e.target.value), .1, 1.5) }))} className="rounded-xl border border-white/10 bg-black/20 p-2.5 text-xs" /></div><div className="mt-2 grid grid-cols-2 gap-2"><select value={outputSize} onChange={e => setOutputSize(e.target.value as OutputSize)} className="rounded-xl border border-white/10 bg-[#0b1120] p-2.5 text-xs"><option value="720p">720p</option><option value="1080p">1080p</option><option value="portrait">9:16</option><option value="square">1:1</option></select><select value={quality} onChange={e => setQuality(e.target.value as RenderQuality)} className="rounded-xl border border-white/10 bg-[#0b1120] p-2.5 text-xs"><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select></div></div>
              {error && <div className="rounded-xl border border-rose-300/15 bg-rose-400/[.05] p-3 text-xs leading-6 text-rose-200">{error}</div>}
              <button onClick={exportProject} disabled={busy || !project.clips.length} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-l from-violet-600 to-cyan-500 px-4 py-4 text-sm font-black disabled:opacity-35">{busy ? <Activity className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}{busy ? 'جاري Render...' : 'Export Project'}</button>
            </div>
          </aside>
        </section>
      </div>
    </main>
  )
}

function LaneLabel({ text, color }: { text: string; color: string }) { return <div className={`absolute left-0 flex h-20 w-20 items-center justify-center border-r border-white/5 text-[9px] font-black ${color}`}>{text}</div> }
function TrackLane({ label, color, items, zoom, onSelect, selected }: { label: string; color: string; items: Array<{ id: string; start: number; end: number; title: string }>; zoom: number; onSelect: (id: string) => void; selected: string }) {
  return <div className="relative h-14 border-b border-white/5"><div className="absolute left-0 grid h-full w-20 place-items-center border-r border-white/5 text-[9px] font-black text-slate-500">{label}</div><div className="absolute inset-y-0 left-20 right-0">{items.map(item => <button key={item.id} onClick={() => onSelect(item.id)} className={`absolute top-2 h-10 overflow-hidden rounded-lg border px-2 text-left text-[9px] font-bold ${color} ${selected === item.id ? 'border-white/50 text-white' : 'border-white/10 text-slate-400'}`} style={{ left: item.start * zoom, width: Math.max(50, (item.end - item.start) * zoom) }}><span className="block truncate">{item.title}</span><span className="text-[8px] opacity-50">{fmt(item.start)} → {fmt(item.end)}</span></button>)}</div></div>
}

function Field({ label, value, onChange, min = 0, max = 9999, step = .1 }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) { return <label className="block text-[10px] text-slate-600">{label}<input type="number" min={min} max={max} step={step} value={Number(value.toFixed(3))} onChange={e => onChange(Number(e.target.value))} className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 p-2.5 text-xs text-white" /></label> }

function ClipInspector({ clip, duration, update }: { clip: Clip; duration: number; update: (c: Partial<Clip>) => void }) { return <div className="space-y-3"><div className="flex items-center gap-2 text-xs font-black"><Video className="h-4 w-4 text-cyan-300" /> Video Clip</div><div className="grid grid-cols-2 gap-2"><Field label="START" value={clip.start} max={clip.end - .05} onChange={v => update({ start: clamp(v, 0, clip.end - .05) })} /><Field label="END" value={clip.end} min={clip.start + .05} max={duration} onChange={v => update({ end: clamp(v, clip.start + .05, duration) })} /></div><div className="grid grid-cols-2 gap-2"><Field label="SPEED" value={clip.speed} min={.25} max={4} step={.05} onChange={v => update({ speed: clamp(v, .25, 4) })} /><Field label="VOLUME" value={clip.volume} min={0} max={2} step={.05} onChange={v => update({ volume: clamp(v, 0, 2) })} /></div><select value={clip.filter} onChange={e => update({ filter: e.target.value as VideoFilter })} className="w-full rounded-xl border border-white/10 bg-[#0b1120] p-2.5 text-xs">{filters.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}</select><div className="grid grid-cols-2 gap-2"><button onClick={() => update({ rotation: (((clip.rotation || 0) + 90) % 360) as 0 | 90 | 180 | 270 })} className="flex items-center justify-center gap-2 rounded-xl border border-white/10 p-2.5 text-xs"><RotateCw className="h-4 w-4" /> {clip.rotation || 0}°</button><select value={clip.fit || 'contain'} onChange={e => update({ fit: e.target.value as 'contain' | 'cover' })} className="rounded-xl border border-white/10 bg-[#0b1120] p-2.5 text-xs"><option value="contain">Contain</option><option value="cover">Cover</option></select></div></div> }
function TextInspector({ track, update }: { track: TextTrack; update: (c: Partial<TextTrack>) => void }) { return <div className="space-y-3"><div className="flex items-center gap-2 text-xs font-black"><Type className="h-4 w-4 text-emerald-300" /> Text Layer</div><textarea value={track.text} onChange={e => update({ text: e.target.value })} className="min-h-20 w-full rounded-xl border border-white/10 bg-black/20 p-3 text-xs" /><div className="grid grid-cols-2 gap-2"><Field label="START" value={track.startAt} onChange={v => update({ startAt: Math.max(0, v) })} /><Field label="END" value={track.endAt} min={track.startAt + .05} onChange={v => update({ endAt: Math.max(track.startAt + .05, v) })} /></div><Field label="SIZE" value={track.size} min={20} max={120} step={1} onChange={v => update({ size: clamp(v, 20, 120) })} /><select value={track.position} onChange={e => update({ position: e.target.value as TextTrack['position'] })} className="w-full rounded-xl border border-white/10 bg-[#0b1120] p-2.5 text-xs"><option value="top">أعلى</option><option value="center">وسط</option><option value="bottom">أسفل</option></select></div> }
function AudioInspector({ track, duration, update }: { track: AudioTrack; duration: number; update: (c: Partial<AudioTrack>) => void }) { return <div className="space-y-3"><div className="flex items-center gap-2 text-xs font-black"><Music2 className="h-4 w-4 text-fuchsia-300" /> Music Track</div><Field label="TIMELINE START" value={track.startAt} onChange={v => update({ startAt: Math.max(0, v) })} /><div className="grid grid-cols-2 gap-2"><Field label="SOURCE START" value={track.sourceStart} max={track.sourceEnd - .05} onChange={v => update({ sourceStart: clamp(v, 0, track.sourceEnd - .05) })} /><Field label="SOURCE END" value={track.sourceEnd} min={track.sourceStart + .05} max={duration} onChange={v => update({ sourceEnd: clamp(v, track.sourceStart + .05, duration) })} /></div><Field label="VOLUME" value={track.volume} min={0} max={2} step={.05} onChange={v => update({ volume: clamp(v, 0, 2) })} /><div className="grid grid-cols-2 gap-2"><Field label="FADE IN" value={track.fadeIn} max={10} onChange={v => update({ fadeIn: clamp(v, 0, 10) })} /><Field label="FADE OUT" value={track.fadeOut} max={10} onChange={v => update({ fadeOut: clamp(v, 0, 10) })} /></div></div> }
function ImageInspector({ track, update }: { track: ImageTrack; update: (c: Partial<ImageTrack>) => void }) { return <div className="space-y-3"><div className="flex items-center gap-2 text-xs font-black"><ImageIcon className="h-4 w-4 text-amber-300" /> Image Overlay</div><div className="grid grid-cols-2 gap-2"><Field label="START" value={track.startAt} onChange={v => update({ startAt: Math.max(0, v) })} /><Field label="END" value={track.endAt} min={track.startAt + .05} onChange={v => update({ endAt: Math.max(track.startAt + .05, v) })} /></div><Field label="SCALE" value={track.scale} min={.05} max={1} step={.01} onChange={v => update({ scale: clamp(v, .05, 1) })} /><Field label="OPACITY" value={track.opacity} min={0} max={1} step={.05} onChange={v => update({ opacity: clamp(v, 0, 1) })} /><select value={track.position} onChange={e => update({ position: e.target.value as ImageTrack['position'] })} className="w-full rounded-xl border border-white/10 bg-[#0b1120] p-2.5 text-xs"><option value="top-left">أعلى يسار</option><option value="top-right">أعلى يمين</option><option value="center">الوسط</option><option value="bottom-left">أسفل يسار</option><option value="bottom-right">أسفل يمين</option></select></div> }
