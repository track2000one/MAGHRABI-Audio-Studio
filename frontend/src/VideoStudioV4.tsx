import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Captions,
  CircleStop,
  Download,
  Film,
  Image as ImageIcon,
  Mic2,
  MonitorUp,
  Music2,
  Pause,
  Play,
  Save,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  UploadCloud,
  Video,
  WandSparkles,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import {
  AudioTrackManifest,
  detectVideoSilence,
  ImageTrackManifest,
  OutputSize,
  RenderQuality,
  renderVideoProjectV4,
  SilenceDetectionResult,
  SpeedRampPreset,
  SubtitleTrackManifest,
  TextTrackManifest,
  VideoClipManifest,
  VideoFilter,
  VideoTransition,
} from './lib/videoApi'
import { loadStoredVideoProject, saveStoredVideoProject } from './lib/projectStore'

type VideoAsset = { file: File; url: string; duration: number }
type AudioAsset = { file: File; duration: number }
type ImageAsset = { file: File; url: string }
type Clip = VideoClipManifest & { id: string }
type TitleTrack = TextTrackManifest & { id: string }
type SubtitleTrack = SubtitleTrackManifest & { id: string }
type AudioTrack = AudioTrackManifest & { id: string }
type ImageTrack = ImageTrackManifest & { id: string }
type Selection = { kind: 'clip' | 'title' | 'subtitle' | 'audio' | 'image'; id: string } | null

type ProjectState = {
  clips: Clip[]
  textTracks: TitleTrack[]
  subtitleTracks: SubtitleTrack[]
  audioTracks: AudioTrack[]
  imageTracks: ImageTrack[]
  transition: VideoTransition
  transitionDuration: number
}

type Panel = 'media' | 'transitions' | 'effects' | 'tools'

const transitions: Array<{ value: VideoTransition; label: string }> = [
  { value: 'none', label: 'Cut' },
  { value: 'fade', label: 'Fade' },
  { value: 'dissolve', label: 'Dissolve' },
  { value: 'fadeblack', label: 'Fade Black' },
  { value: 'fadewhite', label: 'Fade White' },
  { value: 'wipeleft', label: 'Wipe Left' },
  { value: 'wiperight', label: 'Wipe Right' },
  { value: 'slideleft', label: 'Slide Left' },
  { value: 'slideright', label: 'Slide Right' },
  { value: 'smoothleft', label: 'Smooth Left' },
  { value: 'smoothright', label: 'Smooth Right' },
  { value: 'circleopen', label: 'Circle Open' },
  { value: 'circleclose', label: 'Circle Close' },
  { value: 'pixelize', label: 'Pixelize' },
]

const speedRamps: Array<{ value: SpeedRampPreset; label: string; description: string }> = [
  { value: 'off', label: 'Normal', description: 'سرعة ثابتة' },
  { value: 'montage', label: 'Montage', description: 'بطيء ← سريع ← بطيء' },
  { value: 'hero', label: 'Hero', description: 'Slow intro ثم تسارع' },
  { value: 'bullet', label: 'Bullet', description: 'تباطؤ قوي في المنتصف' },
  { value: 'flash', label: 'Flash', description: 'سريع ← بطيء ← سريع' },
]

const filters: Array<{ value: VideoFilter; label: string }> = [
  { value: 'none', label: 'Normal' }, { value: 'warm', label: 'Warm' }, { value: 'cool', label: 'Cool' },
  { value: 'cinematic', label: 'Cinematic' }, { value: 'vivid', label: 'Vivid' }, { value: 'mono', label: 'Mono' },
]

const initialProject: ProjectState = {
  clips: [], textTracks: [], subtitleTracks: [], audioTracks: [], imageTracks: [], transition: 'fade', transitionDuration: .45,
}

function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}` }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)) }
function fmt(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const mins = Math.floor(safe / 60)
  return `${String(mins).padStart(2, '0')}:${(safe - mins * 60).toFixed(1).padStart(4, '0')}`
}
function mediaDuration(file: File, kind: 'video' | 'audio') {
  return new Promise<number>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const element = document.createElement(kind)
    element.preload = 'metadata'
    element.onloadedmetadata = () => { const d = Number.isFinite(element.duration) ? element.duration : 0; URL.revokeObjectURL(url); resolve(d) }
    element.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`تعذر قراءة ${file.name}`)) }
    element.src = url
  })
}
function rampSpeeds(preset: SpeedRampPreset, base: number) {
  const map: Record<SpeedRampPreset, number[]> = {
    off: [1], montage: [.7, 1.8, .7], hero: [.5, 1, 2], bullet: [1, .35, 1], flash: [2, .5, 2],
  }
  return map[preset].map((value) => clamp(value * base, .25, 4))
}
function clipDuration(clip: Clip) {
  const speeds = rampSpeeds(clip.speedRamp || 'off', clip.speed)
  const part = (clip.end - clip.start) / speeds.length
  return speeds.reduce((sum, speed) => sum + part / speed, 0)
}
function fieldClass() { return 'mt-1 w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-xs text-slate-100 outline-none focus:border-cyan-300/35' }

export default function VideoStudioV4() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [videos, setVideos] = useState<VideoAsset[]>([])
  const [audios, setAudios] = useState<AudioAsset[]>([])
  const [images, setImages] = useState<ImageAsset[]>([])
  const [project, setProject] = useState<ProjectState>(initialProject)
  const [selection, setSelection] = useState<Selection>(null)
  const [panel, setPanel] = useState<Panel>('media')
  const [previewTime, setPreviewTime] = useState(0)
  const [projectTime, setProjectTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [timelineZoom, setTimelineZoom] = useState(8)
  const [recording, setRecording] = useState(false)
  const [silence, setSilence] = useState<SilenceDetectionResult | null>(null)
  const [silenceBusy, setSilenceBusy] = useState(false)
  const [outputSize, setOutputSize] = useState<OutputSize>('720p')
  const [quality, setQuality] = useState<RenderQuality>('standard')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)

  useEffect(() => { getAuthStatus().then((status) => setAuthorized(status.authenticated)).catch(() => setAuthorized(false)) }, [])
  useEffect(() => () => {
    videos.forEach((item) => URL.revokeObjectURL(item.url))
    images.forEach((item) => URL.revokeObjectURL(item.url))
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    streamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  const clipOffsets = useMemo(() => {
    let cursor = 0
    return project.clips.map((clip, index) => {
      const duration = clipDuration(clip)
      const start = cursor
      cursor += duration
      if (project.transition !== 'none' && index < project.clips.length - 1) cursor -= Math.min(project.transitionDuration, duration / 3)
      return { start, end: start + duration, duration }
    })
  }, [project.clips, project.transition, project.transitionDuration])
  const projectDuration = clipOffsets.length ? clipOffsets[clipOffsets.length - 1].end : 0
  const selectedClipIndex = selection?.kind === 'clip' ? project.clips.findIndex((clip) => clip.id === selection.id) : -1
  const selectedClip = selectedClipIndex >= 0 ? project.clips[selectedClipIndex] : null
  const selectedVideo = selectedClip ? videos[selectedClip.fileIndex] : null
  const selectedTitle = selection?.kind === 'title' ? project.textTracks.find((item) => item.id === selection.id) || null : null
  const selectedSubtitle = selection?.kind === 'subtitle' ? project.subtitleTracks.find((item) => item.id === selection.id) || null : null
  const selectedAudio = selection?.kind === 'audio' ? project.audioTracks.find((item) => item.id === selection.id) || null : null
  const selectedImage = selection?.kind === 'image' ? project.imageTracks.find((item) => item.id === selection.id) || null : null

  const updateClip = (id: string, changes: Partial<Clip>) => setProject((state) => ({ ...state, clips: state.clips.map((clip) => clip.id === id ? { ...clip, ...changes } : clip) }))
  const updateTitle = (id: string, changes: Partial<TitleTrack>) => setProject((state) => ({ ...state, textTracks: state.textTracks.map((item) => item.id === id ? { ...item, ...changes } : item) }))
  const updateSubtitle = (id: string, changes: Partial<SubtitleTrack>) => setProject((state) => ({ ...state, subtitleTracks: state.subtitleTracks.map((item) => item.id === id ? { ...item, ...changes } : item) }))
  const updateAudio = (id: string, changes: Partial<AudioTrack>) => setProject((state) => ({ ...state, audioTracks: state.audioTracks.map((item) => item.id === id ? { ...item, ...changes } : item) }))
  const updateImage = (id: string, changes: Partial<ImageTrack>) => setProject((state) => ({ ...state, imageTracks: state.imageTracks.map((item) => item.id === id ? { ...item, ...changes } : item) }))

  const addVideoFiles = async (files: File[]) => {
    if (!files.length) return
    const limited = files.slice(0, Math.max(0, 10 - videos.length))
    const durations = await Promise.all(limited.map((file) => mediaDuration(file, 'video')))
    const base = videos.length
    const assets = limited.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: durations[index] }))
    const clips: Clip[] = assets.map((asset, index) => ({
      id: uid(), fileIndex: base + index, start: 0, end: asset.duration, speed: 1, volume: 1, filter: 'none', text: '',
      textSize: 48, textPosition: 'bottom', rotation: 0, fit: 'contain', zoomStart: 1, zoomEnd: 1,
      panXStart: 0, panXEnd: 0, panYStart: 0, panYEnd: 0, chromaEnabled: false, chromaColor: '#00ff00',
      chromaBackground: '#101010', chromaSimilarity: .18, chromaBlend: .06, brightness: 0, contrast: 1,
      saturation: 1, temperature: 0, vignette: 0, speedRamp: 'off',
    }))
    setVideos((state) => [...state, ...assets])
    setProject((state) => ({ ...state, clips: [...state.clips, ...clips] }))
    if (clips[0]) setSelection({ kind: 'clip', id: clips[0].id })
  }
  const onVideoInput = async (event: ChangeEvent<HTMLInputElement>) => {
    try { await addVideoFiles(Array.from(event.target.files || [])); setError(null) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الفيديو.') }
    event.target.value = ''
  }
  const addAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    try {
      const duration = await mediaDuration(file, 'audio')
      const fileIndex = audios.length
      setAudios((state) => [...state, { file, duration }])
      const track: AudioTrack = { id: uid(), fileIndex, startAt: projectTime, sourceStart: 0, sourceEnd: duration, volume: .65, fadeIn: .25, fadeOut: .45 }
      setProject((state) => ({ ...state, audioTracks: [...state.audioTracks, track] })); setSelection({ kind: 'audio', id: track.id })
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الصوت.') }
    event.target.value = ''
  }
  const addImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    const fileIndex = images.length
    setImages((state) => [...state, { file, url: URL.createObjectURL(file) }])
    const track: ImageTrack = { id: uid(), fileIndex, startAt: projectTime, endAt: projectTime + 5, scale: .22, opacity: 1, position: 'bottom-right', startX: .76, startY: .76, endX: .76, endY: .76, scaleStart: .22, scaleEnd: .22 }
    setProject((state) => ({ ...state, imageTracks: [...state.imageTracks, track] })); setSelection({ kind: 'image', id: track.id }); event.target.value = ''
  }
  const addTitle = () => {
    const track: TitleTrack = { id: uid(), text: 'عنوان جديد', startAt: projectTime, endAt: projectTime + 4, size: 56, position: 'center' }
    setProject((state) => ({ ...state, textTracks: [...state.textTracks, track] })); setSelection({ kind: 'title', id: track.id })
  }
  const addSubtitle = () => {
    const track: SubtitleTrack = { id: uid(), text: 'اكتب الترجمة هنا', startAt: projectTime, endAt: projectTime + 2.5, size: 38, position: 'bottom', color: '#ffffff', boxOpacity: .48 }
    setProject((state) => ({ ...state, subtitleTracks: [...state.subtitleTracks, track] })); setSelection({ kind: 'subtitle', id: track.id })
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video || !selectedClip || !selectedVideo) return
    video.pause(); setPlaying(false)
    const seek = () => {
      try { video.currentTime = selectedClip.start; video.playbackRate = selectedClip.speed; video.volume = clamp(selectedClip.volume, 0, 1); setPreviewTime(selectedClip.start); setProjectTime(clipOffsets[selectedClipIndex]?.start || 0) } catch {}
    }
    if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true })
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [selection?.id, selectedVideo?.url])

  const togglePlay = async () => {
    const video = videoRef.current; if (!video || !selectedClip) return
    if (video.paused) { if (video.currentTime < selectedClip.start || video.currentTime >= selectedClip.end) video.currentTime = selectedClip.start; video.playbackRate = selectedClip.speed; await video.play().catch(() => undefined) } else video.pause()
  }
  const onTimeUpdate = () => {
    const video = videoRef.current; if (!video || !selectedClip || selectedClipIndex < 0) return
    const sourceTime = video.currentTime; setPreviewTime(sourceTime)
    const local = Math.max(0, (sourceTime - selectedClip.start) / selectedClip.speed)
    setProjectTime((clipOffsets[selectedClipIndex]?.start || 0) + local)
    if (sourceTime >= selectedClip.end - .015) { video.pause(); video.currentTime = selectedClip.start }
  }
  const splitClip = () => {
    if (!selectedClip) return
    const at = clamp(previewTime, selectedClip.start, selectedClip.end)
    if (at - selectedClip.start < .12 || selectedClip.end - at < .12) { setError('حرّك المؤشر داخل المقطع ثم نفذ Split.'); return }
    const left = { ...selectedClip, id: uid(), end: at }; const right = { ...selectedClip, id: uid(), start: at }
    setProject((state) => ({ ...state, clips: state.clips.flatMap((clip) => clip.id === selectedClip.id ? [left, right] : [clip]) }))
    setSelection({ kind: 'clip', id: right.id }); setError(null)
  }
  const deleteSelection = () => {
    if (!selection) return
    setProject((state) => ({ ...state,
      clips: selection.kind === 'clip' ? state.clips.filter((item) => item.id !== selection.id) : state.clips,
      textTracks: selection.kind === 'title' ? state.textTracks.filter((item) => item.id !== selection.id) : state.textTracks,
      subtitleTracks: selection.kind === 'subtitle' ? state.subtitleTracks.filter((item) => item.id !== selection.id) : state.subtitleTracks,
      audioTracks: selection.kind === 'audio' ? state.audioTracks.filter((item) => item.id !== selection.id) : state.audioTracks,
      imageTracks: selection.kind === 'image' ? state.imageTracks.filter((item) => item.id !== selection.id) : state.imageTracks,
    })); setSelection(null)
  }

  const startRecorder = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      streamRef.current = stream; chunksRef.current = []
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm'
      const recorder = new MediaRecorder(stream, { mimeType: mime })
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data) }
      recorder.onstop = async () => {
        setRecording(false)
        const blob = new Blob(chunksRef.current, { type: 'video/webm' })
        const file = new File([blob], `screen-${Date.now()}.webm`, { type: 'video/webm' })
        stream.getTracks().forEach((track) => track.stop()); streamRef.current = null
        if (blob.size > 0) await addVideoFiles([file]).catch((e) => setError(e instanceof Error ? e.message : 'تعذر إضافة تسجيل الشاشة.'))
      }
      stream.getVideoTracks()[0].onended = () => { if (recorder.state !== 'inactive') recorder.stop() }
      recorder.start(500); setRecording(true); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر بدء تسجيل الشاشة.') }
  }
  const stopRecorder = () => { const recorder = recorderRef.current; if (recorder && recorder.state !== 'inactive') recorder.stop() }

  const runSilenceDetection = async () => {
    if (!selectedClip || !selectedVideo) return
    setSilenceBusy(true); setSilence(null); setError(null)
    try { setSilence(await detectVideoSilence(selectedVideo.file, -35, .5)); setPanel('tools') }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحليل الصمت.') }
    finally { setSilenceBusy(false) }
  }
  const removeDetectedSilence = () => {
    if (!selectedClip || !silence) return
    const intervals = silence.intervals
      .map((item) => ({ start: Math.max(item.start, selectedClip.start), end: Math.min(item.end, selectedClip.end) }))
      .filter((item) => item.end > item.start)
      .sort((a, b) => a.start - b.start)
    let cursor = selectedClip.start
    const pieces: Clip[] = []
    for (const interval of intervals) {
      if (interval.start > cursor + .08) pieces.push({ ...selectedClip, id: uid(), start: cursor, end: interval.start })
      cursor = Math.max(cursor, interval.end)
    }
    if (cursor < selectedClip.end - .08) pieces.push({ ...selectedClip, id: uid(), start: cursor, end: selectedClip.end })
    if (!pieces.length) { setError('لم يتبق جزء صوتي صالح بعد إزالة الصمت.'); return }
    setProject((state) => ({ ...state, clips: state.clips.flatMap((clip) => clip.id === selectedClip.id ? pieces : [clip]) }))
    setSelection({ kind: 'clip', id: pieces[0].id }); setSilence(null)
  }

  const saveProject = async () => {
    try {
      await saveStoredVideoProject<ProjectState>({ version: 3, savedAt: new Date().toISOString(), project, videos: videos.map((item) => item.file), videoDurations: videos.map((item) => item.duration), audios: audios.map((item) => item.file), audioDurations: audios.map((item) => item.duration), images: images.map((item) => item.file), outputSize, quality })
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر حفظ المشروع.') }
  }
  const restoreProject = async () => {
    try {
      const snap = await loadStoredVideoProject<ProjectState>(); if (!snap) { setError('لا يوجد مشروع محفوظ.'); return }
      videos.forEach((item) => URL.revokeObjectURL(item.url)); images.forEach((item) => URL.revokeObjectURL(item.url))
      setVideos(snap.videos.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: snap.videoDurations[index] || 0 })))
      setAudios(snap.audios.map((file, index) => ({ file, duration: snap.audioDurations[index] || 0 })))
      setImages(snap.images.map((file) => ({ file, url: URL.createObjectURL(file) })))
      setProject(snap.project); setOutputSize(snap.outputSize as OutputSize); setQuality(snap.quality as RenderQuality)
      setSelection(snap.project.clips[0] ? { kind: 'clip', id: snap.project.clips[0].id } : null); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر استعادة المشروع.') }
  }

  const exportProject = async () => {
    if (!project.clips.length) return
    setBusy(true); setError(null); if (resultUrl) URL.revokeObjectURL(resultUrl); setResultUrl(null)
    try {
      const blob = await renderVideoProjectV4(videos.map((item) => item.file), audios.map((item) => item.file), images.map((item) => item.file), {
        clips: project.clips.map(({ id: _id, ...clip }) => clip), textTracks: project.textTracks.map(({ id: _id, ...track }) => track),
        subtitleTracks: project.subtitleTracks.map(({ id: _id, ...track }) => track), audioTracks: project.audioTracks.map(({ id: _id, ...track }) => track),
        imageTracks: project.imageTracks.map(({ id: _id, ...track }) => track), transition: project.transition, transitionDuration: project.transitionDuration,
      }, outputSize, quality)
      setResultUrl(URL.createObjectURL(blob))
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تصدير V4.') }
    finally { setBusy(false) }
  }

  const previewBase = selectedClip?.filter === 'warm' ? 'sepia(.10)' : selectedClip?.filter === 'cool' ? 'hue-rotate(8deg)' : selectedClip?.filter === 'mono' ? 'grayscale(1)' : ''
  const previewCss = selectedClip ? `${previewBase} brightness(${1 + (selectedClip.brightness || 0)}) contrast(${selectedClip.contrast || 1}) saturate(${selectedClip.saturation || 1})` : 'none'
  const activeTitles = project.textTracks.filter((item) => projectTime >= item.startAt && projectTime <= item.endAt)
  const activeSubs = project.subtitleTracks.filter((item) => projectTime >= item.startAt && projectTime <= item.endAt)
  const activeImages = project.imageTracks.filter((item) => projectTime >= item.startAt && projectTime <= item.endAt)
  const timelineWidth = Math.max(900, projectDuration * timelineZoom + 130)

  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#050710]"><Activity className="h-7 w-7 animate-spin text-cyan-300" /></div>
  if (!authorized) return <div className="grid min-h-screen place-items-center bg-[#050710] text-white"><a href="#" className="rounded-2xl bg-white px-6 py-3 font-black text-black">العودة لتسجيل الدخول</a></div>

  return (
    <main className="min-h-screen bg-[#050710] text-slate-100">
      <div className="relative mx-auto max-w-[1920px] px-3 py-3 md:px-5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
          <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-violet-400/10"><Film className="h-5 w-5 text-violet-200" /></div><div><div className="flex items-center gap-2"><h1 className="text-lg font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-fuchsia-300/20 bg-fuchsia-300/[.06] px-2 py-1 text-[9px] font-black text-fuchsia-200">CREATOR V4</span></div><p className="mt-1 text-[10px] text-slate-500">Transitions · Speed Ramp · Color · Silence · Screen Recorder</p></div></div>
          <div className="flex flex-wrap gap-2"><button onClick={saveProject} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black"><Save className="mr-1 inline h-3.5 w-3.5" />حفظ</button><button onClick={restoreProject} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black">استعادة</button><select value={outputSize} onChange={(e) => setOutputSize(e.target.value as OutputSize)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="720p">720p</option><option value="1080p">1080p</option><option value="portrait">9:16</option><option value="square">1:1</option></select><select value={quality} onChange={(e) => setQuality(e.target.value as RenderQuality)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select><button onClick={exportProject} disabled={busy || !project.clips.length} className="rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-2 text-xs font-black disabled:opacity-30">{busy ? 'Rendering...' : 'EXPORT'}</button></div>
        </header>

        <div className="mt-3 flex gap-1 rounded-2xl border border-white/10 bg-white/[.025] p-1.5">
          {(['media','transitions','effects','tools'] as Panel[]).map((item) => <button key={item} onClick={() => setPanel(item)} className={`rounded-xl px-4 py-2 text-[10px] font-black ${panel === item ? 'bg-white text-black' : 'text-slate-400'}`}>{item === 'media' ? 'MEDIA' : item === 'transitions' ? 'TRANSITIONS' : item === 'effects' ? 'EFFECTS / COLOR' : 'SMART TOOLS'}</button>)}
        </div>

        <section className="mt-3 grid gap-3 2xl:grid-cols-[270px_minmax(0,1fr)_340px]">
          <aside className="rounded-3xl border border-white/10 bg-[#090e19] p-4">
            {panel === 'media' && <><p className="text-[10px] font-black tracking-widest text-slate-500">MEDIA LIBRARY</p><div className="mt-4 grid grid-cols-2 gap-2"><label className="cursor-pointer rounded-2xl border border-dashed border-violet-300/20 p-3 text-center text-[9px] font-black"><UploadCloud className="mx-auto mb-2 h-4 w-4" />VIDEO<input type="file" multiple accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi" className="hidden" onChange={onVideoInput} /></label><label className="cursor-pointer rounded-2xl border border-dashed border-cyan-300/20 p-3 text-center text-[9px] font-black"><Music2 className="mx-auto mb-2 h-4 w-4" />AUDIO<input type="file" accept="audio/*" className="hidden" onChange={addAudio} /></label><label className="cursor-pointer rounded-2xl border border-dashed border-fuchsia-300/20 p-3 text-center text-[9px] font-black"><ImageIcon className="mx-auto mb-2 h-4 w-4" />OVERLAY<input type="file" accept="image/*" className="hidden" onChange={addImage} /></label><button onClick={addTitle} className="rounded-2xl border border-dashed border-sky-300/20 p-3 text-[9px] font-black"><Type className="mx-auto mb-2 h-4 w-4" />TITLE</button><button onClick={addSubtitle} className="rounded-2xl border border-dashed border-amber-300/20 p-3 text-[9px] font-black"><Captions className="mx-auto mb-2 h-4 w-4" />SUBTITLE</button><button onClick={recording ? stopRecorder : startRecorder} className={`rounded-2xl border border-dashed p-3 text-[9px] font-black ${recording ? 'border-rose-300/40 bg-rose-400/10 text-rose-200' : 'border-emerald-300/20'}`}>{recording ? <CircleStop className="mx-auto mb-2 h-4 w-4" /> : <MonitorUp className="mx-auto mb-2 h-4 w-4" />}{recording ? 'STOP RECORD' : 'SCREEN REC'}</button></div><div className="mt-4 space-y-2">{videos.map((asset,index)=><button key={`${asset.file.name}-${index}`} onClick={()=>{const clip=project.clips.find(c=>c.fileIndex===index); if(clip)setSelection({kind:'clip',id:clip.id})}} className="w-full rounded-xl border border-white/8 bg-white/[.025] p-3 text-left"><p className="truncate text-[10px] font-bold">{asset.file.name}</p><p className="mt-1 text-[9px] text-slate-600">{fmt(asset.duration)}</p></button>)}</div></>}
            {panel === 'transitions' && <><p className="text-[10px] font-black tracking-widest text-slate-500">TRANSITION LIBRARY</p><div className="mt-4 grid grid-cols-2 gap-2">{transitions.map((item)=><button key={item.value} onClick={()=>setProject(state=>({...state,transition:item.value}))} className={`rounded-2xl border p-3 text-left text-[10px] font-black ${project.transition===item.value?'border-violet-300/50 bg-violet-400/15':'border-white/10 bg-white/[.02]'}`}><div className="mb-3 h-8 rounded-lg bg-gradient-to-r from-violet-500/40 via-white/10 to-cyan-500/40" />{item.label}</button>)}</div><label className="mt-4 block text-[9px] text-slate-500">TRANSITION DURATION<input className={fieldClass()} type="number" min=".1" max="1.5" step=".05" value={project.transitionDuration} onChange={(e)=>setProject(state=>({...state,transitionDuration:clamp(Number(e.target.value),.1,1.5)}))}/></label></>}
            {panel === 'effects' && <><p className="text-[10px] font-black tracking-widest text-slate-500">EFFECTS & COLOR</p>{selectedClip ? <div className="mt-4 space-y-4"><div className="grid grid-cols-2 gap-2">{filters.map((item)=><button key={item.value} onClick={()=>updateClip(selectedClip.id,{filter:item.value})} className={`rounded-xl border px-3 py-2 text-[9px] font-black ${selectedClip.filter===item.value?'border-cyan-300/40 bg-cyan-300/10':'border-white/10'}`}>{item.label}</button>)}</div><label className="block text-[9px] text-slate-500">BRIGHTNESS<input type="range" min="-.6" max=".6" step=".02" value={selectedClip.brightness||0} onChange={(e)=>updateClip(selectedClip.id,{brightness:Number(e.target.value)})} className="mt-2 w-full accent-cyan-300"/></label><label className="block text-[9px] text-slate-500">CONTRAST<input type="range" min=".5" max="2" step=".02" value={selectedClip.contrast||1} onChange={(e)=>updateClip(selectedClip.id,{contrast:Number(e.target.value)})} className="mt-2 w-full accent-cyan-300"/></label><label className="block text-[9px] text-slate-500">SATURATION<input type="range" min="0" max="3" step=".02" value={selectedClip.saturation||1} onChange={(e)=>updateClip(selectedClip.id,{saturation:Number(e.target.value)})} className="mt-2 w-full accent-cyan-300"/></label><label className="block text-[9px] text-slate-500">TEMPERATURE<input type="range" min="-1" max="1" step=".02" value={selectedClip.temperature||0} onChange={(e)=>updateClip(selectedClip.id,{temperature:Number(e.target.value)})} className="mt-2 w-full accent-cyan-300"/></label><label className="block text-[9px] text-slate-500">VIGNETTE<input type="range" min="0" max="1" step=".02" value={selectedClip.vignette||0} onChange={(e)=>updateClip(selectedClip.id,{vignette:Number(e.target.value)})} className="mt-2 w-full accent-cyan-300"/></label></div> : <p className="mt-4 text-[10px] text-slate-600">حدد Clip لتعديل الألوان.</p>}</>}
            {panel === 'tools' && <><p className="text-[10px] font-black tracking-widest text-slate-500">SMART TOOLS</p><button onClick={runSilenceDetection} disabled={!selectedClip||silenceBusy} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400/10 px-3 py-3 text-[10px] font-black text-cyan-100 disabled:opacity-30"><Mic2 className="h-4 w-4" />{silenceBusy?'تحليل الصمت...':'Silence Detection'}</button>{silence&&<div className="mt-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[.04] p-3"><p className="text-[10px] font-black">تم اكتشاف {silence.intervals.length} مناطق صامتة</p><p className="mt-1 text-[9px] text-slate-500">إجمالي {fmt(silence.totalSilence)} من {fmt(silence.duration)}</p><button onClick={removeDetectedSilence} className="mt-3 w-full rounded-xl bg-white px-3 py-2 text-[10px] font-black text-black">إزالة الصمت تلقائيًا</button></div>}<div className="mt-5"><p className="text-[10px] font-black text-slate-500">SPEED RAMP</p><div className="mt-2 space-y-2">{speedRamps.map((item)=><button key={item.value} disabled={!selectedClip} onClick={()=>selectedClip&&updateClip(selectedClip.id,{speedRamp:item.value})} className={`w-full rounded-xl border p-3 text-left ${selectedClip?.speedRamp===item.value?'border-fuchsia-300/40 bg-fuchsia-300/10':'border-white/10'}`}><p className="text-[10px] font-black">{item.label}</p><p className="mt-1 text-[9px] text-slate-600">{item.description}</p></button>)}</div></div></>}
          </aside>

          <div className="min-w-0 space-y-3">
            <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex justify-between"><div><p className="text-xs font-black">PROGRAM MONITOR</p><p className="mt-1 text-[9px] text-slate-600">Project {fmt(projectTime)}</p></div>{selectedClip?.speedRamp&&selectedClip.speedRamp!=='off'&&<span className="rounded-lg border border-fuchsia-300/20 bg-fuchsia-300/10 px-2 py-1 text-[9px] font-black text-fuchsia-200">SPEED RAMP · يظهر كاملًا بعد Render</span>}</div><div className="relative mx-auto aspect-video overflow-hidden rounded-2xl border border-white/10 bg-black">{selectedVideo&&selectedClip?<><video ref={videoRef} src={selectedVideo.url} className="h-full w-full object-contain" style={{filter:previewCss}} onTimeUpdate={onTimeUpdate} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} playsInline/>{(selectedClip.vignette||0)>0&&<div className="pointer-events-none absolute inset-0" style={{background:`radial-gradient(circle,transparent 45%,rgba(0,0,0,${.7*(selectedClip.vignette||0)}) 100%)`}}/>}{activeImages.map((track)=>{const asset=images[track.fileIndex];return asset?<img key={track.id} src={asset.url} className="pointer-events-none absolute bottom-5 right-5 max-h-[35%] max-w-[35%] object-contain" style={{opacity:track.opacity}}/>:null})}{activeTitles.map((track)=><div key={track.id} className="pointer-events-none absolute inset-x-8 top-1/2 -translate-y-1/2 text-center font-black text-white"><span className="rounded-lg bg-black/45 px-3 py-1.5" style={{fontSize:clamp(track.size/2,16,54)}}>{track.text}</span></div>)}{activeSubs.map((track)=><div key={track.id} className="pointer-events-none absolute inset-x-8 bottom-[6%] text-center font-bold" style={{color:track.color,fontSize:clamp(track.size/2,14,40)}}><span className="rounded-md bg-black/50 px-3 py-1.5">{track.text}</span></div>)}</>:<div className="grid h-full place-items-center"><Film className="h-12 w-12 text-slate-800"/></div>}</div><div className="mt-3 flex flex-wrap items-center justify-center gap-2"><button onClick={togglePlay} disabled={!selectedClip} className="rounded-xl bg-white px-4 py-2 text-xs font-black text-black disabled:opacity-30">{playing?<Pause className="mr-1 inline h-4 w-4"/>:<Play className="mr-1 inline h-4 w-4"/>}{playing?'إيقاف':'تشغيل'}</button><button onClick={splitClip} disabled={!selectedClip} className="rounded-xl border border-cyan-300/20 px-4 py-2 text-xs font-black"><Scissors className="mr-1 inline h-4 w-4"/>Split</button><button onClick={deleteSelection} disabled={!selection} className="rounded-xl border border-rose-300/20 px-3 py-2 text-rose-200 disabled:opacity-30"><Trash2 className="h-4 w-4"/></button></div></div>

            <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-black">MULTI-TRACK TIMELINE</p><p className="mt-1 text-[9px] text-slate-600">Video · Title · Subtitle · Music · Overlay</p></div><div className="flex items-center gap-2"><ZoomOut className="h-4 w-4 text-slate-600"/><input type="range" min="3" max="24" value={timelineZoom} onChange={(e)=>setTimelineZoom(Number(e.target.value))} className="w-28 accent-cyan-300"/><ZoomIn className="h-4 w-4 text-slate-600"/></div></div><div className="overflow-x-auto rounded-2xl border border-white/8 bg-black/20"><div className="relative" style={{width:timelineWidth}}><div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-red-400" style={{left:80+projectTime*timelineZoom}}/>{['VIDEO','TITLE','SUBTITLE','MUSIC','OVERLAY'].map((label)=><div key={label} className="h-16 border-b border-white/5"><div className="sticky left-0 z-30 flex h-full w-20 items-center bg-[#080d17] px-2 text-[9px] font-black text-slate-600">{label}</div></div>)}<div className="absolute left-20 top-0 h-16">{project.clips.map((clip,index)=>{const off=clipOffsets[index];if(!off)return null;return <button key={clip.id} onClick={()=>{setSelection({kind:'clip',id:clip.id});setProjectTime(off.start)}} className={`absolute top-2 h-12 rounded-xl border px-3 text-left ${selection?.kind==='clip'&&selection.id===clip.id?'border-violet-200 bg-violet-400/20':'border-violet-300/15 bg-violet-400/10'}`} style={{left:off.start*timelineZoom,width:Math.max(75,off.duration*timelineZoom)}}><span className="text-[9px] font-black">CLIP {index+1}</span>{clip.speedRamp&&clip.speedRamp!=='off'&&<span className="ml-2 text-[8px] text-fuchsia-300">⚡</span>}</button>})}</div><div className="absolute left-20 top-16 h-16">{project.textTracks.map((track)=><button key={track.id} onClick={()=>setSelection({kind:'title',id:track.id})} className="absolute top-2 h-12 rounded-xl border border-sky-300/15 bg-sky-400/10 px-3 text-[9px]" style={{left:track.startAt*timelineZoom,width:Math.max(70,(track.endAt-track.startAt)*timelineZoom)}}>{track.text}</button>)}</div><div className="absolute left-20 top-32 h-16">{project.subtitleTracks.map((track)=><button key={track.id} onClick={()=>setSelection({kind:'subtitle',id:track.id})} className="absolute top-2 h-12 rounded-xl border border-amber-300/15 bg-amber-400/10 px-3 text-[9px]" style={{left:track.startAt*timelineZoom,width:Math.max(70,(track.endAt-track.startAt)*timelineZoom)}}>{track.text}</button>)}</div><div className="absolute left-20 top-48 h-16">{project.audioTracks.map((track)=><button key={track.id} onClick={()=>setSelection({kind:'audio',id:track.id})} className="absolute top-2 h-12 rounded-xl border border-cyan-300/15 bg-cyan-400/10 px-3 text-[9px]" style={{left:track.startAt*timelineZoom,width:Math.max(70,(track.sourceEnd-track.sourceStart)*timelineZoom)}}>MUSIC</button>)}</div><div className="absolute left-20 top-64 h-16">{project.imageTracks.map((track)=><button key={track.id} onClick={()=>setSelection({kind:'image',id:track.id})} className="absolute top-2 h-12 rounded-xl border border-fuchsia-300/15 bg-fuchsia-400/10 px-3 text-[9px]" style={{left:track.startAt*timelineZoom,width:Math.max(70,(track.endAt-track.startAt)*timelineZoom)}}>OVERLAY</button>)}</div></div></div></div>

            {resultUrl&&<div className="rounded-3xl border border-emerald-300/15 bg-emerald-300/[.035] p-5"><div className="flex items-center justify-between"><p className="text-sm font-black text-emerald-100">اكتمل Render V4</p><Sparkles className="h-5 w-5 text-emerald-300"/></div><video controls src={resultUrl} className="mt-4 max-h-[520px] w-full rounded-2xl bg-black"/><a href={resultUrl} download="MAGHRABI-video-v4.mp4" className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-black text-black"><Download className="h-4 w-4"/>تنزيل الفيديو</a></div>}
          </div>

          <aside className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">INSPECTOR</p><p className="mt-1 text-xs font-black">{selection?.kind.toUpperCase()||'PROJECT'}</p></div><WandSparkles className="h-4 w-4 text-violet-300"/></div>{selectedClip&&selectedVideo&&<div className="mt-5 space-y-4"><div className="grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">START<input className={fieldClass()} type="number" step=".05" value={selectedClip.start} onChange={(e)=>updateClip(selectedClip.id,{start:clamp(Number(e.target.value),0,selectedClip.end-.05)})}/></label><label className="text-[9px] text-slate-600">END<input className={fieldClass()} type="number" step=".05" value={selectedClip.end} onChange={(e)=>updateClip(selectedClip.id,{end:clamp(Number(e.target.value),selectedClip.start+.05,selectedVideo.duration)})}/></label></div><div className="grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">BASE SPEED<input className={fieldClass()} type="number" min=".25" max="4" step=".05" value={selectedClip.speed} onChange={(e)=>updateClip(selectedClip.id,{speed:clamp(Number(e.target.value),.25,4)})}/></label><label className="text-[9px] text-slate-600">VOLUME<input className={fieldClass()} type="number" min="0" max="2" step=".05" value={selectedClip.volume} onChange={(e)=>updateClip(selectedClip.id,{volume:clamp(Number(e.target.value),0,2)})}/></label></div><div><p className="text-[9px] font-black text-slate-500">TRANSFORM</p><div className="mt-2 grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">ZOOM START<input className={fieldClass()} type="number" min="1" max="4" step=".05" value={selectedClip.zoomStart||1} onChange={(e)=>updateClip(selectedClip.id,{zoomStart:clamp(Number(e.target.value),1,4)})}/></label><label className="text-[9px] text-slate-600">ZOOM END<input className={fieldClass()} type="number" min="1" max="4" step=".05" value={selectedClip.zoomEnd||1} onChange={(e)=>updateClip(selectedClip.id,{zoomEnd:clamp(Number(e.target.value),1,4)})}/></label></div></div><label className="flex items-center justify-between rounded-xl border border-white/10 px-3 py-2 text-[10px]"><span>Green Screen / Chroma</span><input type="checkbox" checked={!!selectedClip.chromaEnabled} onChange={(e)=>updateClip(selectedClip.id,{chromaEnabled:e.target.checked})}/></label>{selectedClip.chromaEnabled&&<div className="grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">KEY COLOR<input className={fieldClass()} type="color" value={selectedClip.chromaColor||'#00ff00'} onChange={(e)=>updateClip(selectedClip.id,{chromaColor:e.target.value})}/></label><label className="text-[9px] text-slate-600">SIMILARITY<input className={fieldClass()} type="number" min=".01" max="1" step=".01" value={selectedClip.chromaSimilarity||.18} onChange={(e)=>updateClip(selectedClip.id,{chromaSimilarity:clamp(Number(e.target.value),.01,1)})}/></label></div>}</div>}{selectedTitle&&<div className="mt-5 space-y-3"><label className="text-[9px] text-slate-600">TEXT<input className={fieldClass()} value={selectedTitle.text} onChange={(e)=>updateTitle(selectedTitle.id,{text:e.target.value})}/></label><div className="grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">START<input className={fieldClass()} type="number" value={selectedTitle.startAt} onChange={(e)=>updateTitle(selectedTitle.id,{startAt:Math.max(0,Number(e.target.value))})}/></label><label className="text-[9px] text-slate-600">END<input className={fieldClass()} type="number" value={selectedTitle.endAt} onChange={(e)=>updateTitle(selectedTitle.id,{endAt:Number(e.target.value)})}/></label></div></div>}{selectedSubtitle&&<div className="mt-5 space-y-3"><label className="text-[9px] text-slate-600">SUBTITLE<input className={fieldClass()} value={selectedSubtitle.text} onChange={(e)=>updateSubtitle(selectedSubtitle.id,{text:e.target.value})}/></label></div>}{selectedAudio&&<div className="mt-5 space-y-3"><label className="text-[9px] text-slate-600">MUSIC VOLUME<input className={fieldClass()} type="number" min="0" max="2" step=".05" value={selectedAudio.volume} onChange={(e)=>updateAudio(selectedAudio.id,{volume:clamp(Number(e.target.value),0,2)})}/></label></div>}{selectedImage&&<div className="mt-5 space-y-3"><label className="text-[9px] text-slate-600">OVERLAY OPACITY<input className={fieldClass()} type="number" min="0" max="1" step=".05" value={selectedImage.opacity} onChange={(e)=>updateImage(selectedImage.id,{opacity:clamp(Number(e.target.value),0,1)})}/></label></div>}{error&&<div className="mt-5 rounded-xl border border-rose-300/20 bg-rose-400/10 p-3 text-[10px] leading-5 text-rose-200">{error}</div>}</aside>
        </section>
      </div>
    </main>
  )
}
