import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  Captions,
  Download,
  Film,
  FolderOpen,
  Image as ImageIcon,
  KeyRound,
  Music2,
  Pause,
  Play,
  Redo2,
  RotateCw,
  Save,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  UploadCloud,
  Video,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import {
  AudioTrackManifest,
  ImageTrackManifest,
  OutputSize,
  RenderQuality,
  renderVideoProjectV3,
  SubtitleTrackManifest,
  TextTrackManifest,
  VideoClipManifest,
  VideoFilter,
} from './lib/videoApi'
import {
  clearStoredVideoProject,
  loadStoredVideoProject,
  saveStoredVideoProject,
} from './lib/projectStore'

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
  transition: 'none' | 'fade'
  transitionDuration: number
}

type History = { past: ProjectState[]; present: ProjectState; future: ProjectState[] }

const initialProject: ProjectState = {
  clips: [],
  textTracks: [],
  subtitleTracks: [],
  audioTracks: [],
  imageTracks: [],
  transition: 'fade',
  transitionDuration: .45,
}

const filters: Array<{ value: VideoFilter; label: string }> = [
  { value: 'none', label: 'Normal' },
  { value: 'warm', label: 'Warm' },
  { value: 'cool', label: 'Cool' },
  { value: 'cinematic', label: 'Cinematic' },
  { value: 'vivid', label: 'Vivid' },
  { value: 'mono', label: 'Mono' },
]

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function fmt(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const minutes = Math.floor(safe / 60)
  return `${String(minutes).padStart(2, '0')}:${(safe - minutes * 60).toFixed(1).padStart(4, '0')}`
}

function mediaDuration(file: File, kind: 'video' | 'audio') {
  return new Promise<number>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const element = document.createElement(kind)
    element.preload = 'metadata'
    element.onloadedmetadata = () => {
      const duration = Number.isFinite(element.duration) ? element.duration : 0
      URL.revokeObjectURL(url)
      resolve(duration)
    }
    element.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`تعذر قراءة ${file.name}`))
    }
    element.src = url
  })
}

function previewFilter(filter: VideoFilter) {
  if (filter === 'warm') return 'contrast(1.04) brightness(1.02) saturate(1.12) sepia(.10)'
  if (filter === 'cool') return 'contrast(1.03) saturate(1.05) hue-rotate(8deg)'
  if (filter === 'cinematic') return 'contrast(1.12) brightness(.97) saturate(.90)'
  if (filter === 'vivid') return 'contrast(1.07) saturate(1.35)'
  if (filter === 'mono') return 'grayscale(1) contrast(1.08)'
  return 'none'
}

function fieldClass() {
  return 'mt-1 w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-xs text-slate-100 outline-none focus:border-cyan-300/30'
}

export default function VideoStudioV3() {
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
  const [timelineZoom, setTimelineZoom] = useState(7)
  const [outputSize, setOutputSize] = useState<OutputSize>('720p')
  const [quality, setQuality] = useState<RenderQuality>('standard')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)

  const project = history.present
  const commit = (updater: (state: ProjectState) => ProjectState) => {
    setHistory((current) => ({
      past: [...current.past, current.present].slice(-80),
      present: updater(current.present),
      future: [],
    }))
  }
  const undo = () => setHistory((current) => current.past.length ? {
    past: current.past.slice(0, -1),
    present: current.past[current.past.length - 1],
    future: [current.present, ...current.future],
  } : current)
  const redo = () => setHistory((current) => current.future.length ? {
    past: [...current.past, current.present].slice(-80),
    present: current.future[0],
    future: current.future.slice(1),
  } : current)

  useEffect(() => {
    getAuthStatus().then((status) => setAuthorized(status.authenticated)).catch(() => setAuthorized(false))
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault()
        event.shiftKey ? redo() : undo()
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveProject()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => () => {
    videos.forEach((asset) => URL.revokeObjectURL(asset.url))
    images.forEach((asset) => URL.revokeObjectURL(asset.url))
    if (resultUrl) URL.revokeObjectURL(resultUrl)
  }, [])

  const clipOffsets = useMemo(() => {
    let cursor = 0
    return project.clips.map((clip, index) => {
      const duration = (clip.end - clip.start) / clip.speed
      const start = cursor
      cursor += duration
      if (project.transition === 'fade' && index < project.clips.length - 1) {
        cursor -= Math.min(project.transitionDuration, duration / 3)
      }
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

  const addVideos = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).slice(0, Math.max(0, 10 - videos.length))
    if (!files.length) return
    setError(null)
    try {
      const durations = await Promise.all(files.map((file) => mediaDuration(file, 'video')))
      const base = videos.length
      const assets = files.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: durations[index] }))
      const clips: Clip[] = assets.map((asset, index) => ({
        id: uid(),
        fileIndex: base + index,
        start: 0,
        end: asset.duration,
        speed: 1,
        volume: 1,
        filter: 'none',
        text: '',
        textSize: 48,
        textPosition: 'bottom',
        rotation: 0,
        fit: 'contain',
        zoomStart: 1,
        zoomEnd: 1,
        panXStart: 0,
        panXEnd: 0,
        panYStart: 0,
        panYEnd: 0,
        chromaEnabled: false,
        chromaColor: '#00ff00',
        chromaBackground: '#101010',
        chromaSimilarity: .18,
        chromaBlend: .06,
      }))
      setVideos((current) => [...current, ...assets])
      commit((state) => ({ ...state, clips: [...state.clips, ...clips] }))
      if (clips[0]) setSelection({ kind: 'clip', id: clips[0].id })
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'تعذر إضافة الفيديو.')
    }
    event.target.value = ''
  }

  const addAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const duration = await mediaDuration(file, 'audio')
      const fileIndex = audios.length
      setAudios((current) => [...current, { file, duration }])
      const track: AudioTrack = {
        id: uid(), fileIndex, startAt: 0, sourceStart: 0, sourceEnd: duration, volume: .65, fadeIn: .25, fadeOut: .45,
      }
      commit((state) => ({ ...state, audioTracks: [...state.audioTracks, track] }))
      setSelection({ kind: 'audio', id: track.id })
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'تعذر إضافة الصوت.')
    }
    event.target.value = ''
  }

  const addImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const fileIndex = images.length
    setImages((current) => [...current, { file, url: URL.createObjectURL(file) }])
    const track: ImageTrack = {
      id: uid(), fileIndex, startAt: projectTime, endAt: Math.max(projectTime + 3, projectDuration || projectTime + 5),
      scale: .22, opacity: 1, position: 'bottom-right', startX: .76, startY: .76, endX: .76, endY: .76,
      scaleStart: .22, scaleEnd: .22,
    }
    commit((state) => ({ ...state, imageTracks: [...state.imageTracks, track] }))
    setSelection({ kind: 'image', id: track.id })
    event.target.value = ''
  }

  const addTitle = () => {
    const track: TitleTrack = {
      id: uid(), text: 'عنوان جديد', startAt: projectTime, endAt: projectTime + 4, size: 56, position: 'center',
    }
    commit((state) => ({ ...state, textTracks: [...state.textTracks, track] }))
    setSelection({ kind: 'title', id: track.id })
  }

  const addSubtitle = () => {
    const track: SubtitleTrack = {
      id: uid(), text: 'اكتب الترجمة هنا', startAt: projectTime, endAt: projectTime + 2.5,
      size: 38, position: 'bottom', color: '#ffffff', boxOpacity: .48,
    }
    commit((state) => ({ ...state, subtitleTracks: [...state.subtitleTracks, track] }))
    setSelection({ kind: 'subtitle', id: track.id })
  }

  const updateClip = (id: string, changes: Partial<Clip>) => commit((state) => ({
    ...state, clips: state.clips.map((clip) => clip.id === id ? { ...clip, ...changes } : clip),
  }))
  const updateTitle = (id: string, changes: Partial<TitleTrack>) => commit((state) => ({
    ...state, textTracks: state.textTracks.map((track) => track.id === id ? { ...track, ...changes } : track),
  }))
  const updateSubtitle = (id: string, changes: Partial<SubtitleTrack>) => commit((state) => ({
    ...state, subtitleTracks: state.subtitleTracks.map((track) => track.id === id ? { ...track, ...changes } : track),
  }))
  const updateAudio = (id: string, changes: Partial<AudioTrack>) => commit((state) => ({
    ...state, audioTracks: state.audioTracks.map((track) => track.id === id ? { ...track, ...changes } : track),
  }))
  const updateImage = (id: string, changes: Partial<ImageTrack>) => commit((state) => ({
    ...state, imageTracks: state.imageTracks.map((track) => track.id === id ? { ...track, ...changes } : track),
  }))

  const deleteSelection = () => {
    if (!selection) return
    commit((state) => ({
      ...state,
      clips: selection.kind === 'clip' ? state.clips.filter((item) => item.id !== selection.id) : state.clips,
      textTracks: selection.kind === 'title' ? state.textTracks.filter((item) => item.id !== selection.id) : state.textTracks,
      subtitleTracks: selection.kind === 'subtitle' ? state.subtitleTracks.filter((item) => item.id !== selection.id) : state.subtitleTracks,
      audioTracks: selection.kind === 'audio' ? state.audioTracks.filter((item) => item.id !== selection.id) : state.audioTracks,
      imageTracks: selection.kind === 'image' ? state.imageTracks.filter((item) => item.id !== selection.id) : state.imageTracks,
    }))
    setSelection(null)
  }

  const splitClip = () => {
    if (!selectedClip) return
    const splitAt = clamp(previewTime, selectedClip.start, selectedClip.end)
    if (splitAt - selectedClip.start < .12 || selectedClip.end - splitAt < .12) {
      setError('حرّك مؤشر التشغيل داخل المقطع قبل تنفيذ Split.')
      return
    }
    const left: Clip = { ...selectedClip, id: uid(), end: splitAt }
    const right: Clip = { ...selectedClip, id: uid(), start: splitAt }
    commit((state) => ({ ...state, clips: state.clips.flatMap((clip) => clip.id === selectedClip.id ? [left, right] : [clip]) }))
    setSelection({ kind: 'clip', id: right.id })
    setError(null)
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video || !selectedClip || !selectedVideo) return
    video.pause()
    setPlaying(false)
    const seek = () => {
      try {
        video.currentTime = selectedClip.start
        video.playbackRate = selectedClip.speed
        video.volume = clamp(selectedClip.volume, 0, 1)
        setPreviewTime(selectedClip.start)
        setProjectTime(clipOffsets[selectedClipIndex]?.start || 0)
      } catch {
        // Browser may wait for metadata.
      }
    }
    if (video.readyState >= 1) seek()
    else video.addEventListener('loadedmetadata', seek, { once: true })
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [selection?.id, selectedVideo?.url])

  const togglePlay = async () => {
    const video = videoRef.current
    if (!video || !selectedClip) return
    if (video.paused) {
      if (video.currentTime < selectedClip.start || video.currentTime >= selectedClip.end) video.currentTime = selectedClip.start
      video.playbackRate = selectedClip.speed
      await video.play().catch(() => undefined)
    } else video.pause()
  }

  const onTimeUpdate = () => {
    const video = videoRef.current
    if (!video || !selectedClip || selectedClipIndex < 0) return
    const sourceTime = video.currentTime
    setPreviewTime(sourceTime)
    const local = Math.max(0, (sourceTime - selectedClip.start) / selectedClip.speed)
    setProjectTime((clipOffsets[selectedClipIndex]?.start || 0) + local)
    if (sourceTime >= selectedClip.end - .015) {
      video.pause()
      video.currentTime = selectedClip.start
    }
  }

  const saveProject = async () => {
    setSaving(true)
    setError(null)
    try {
      await saveStoredVideoProject<ProjectState>({
        version: 3,
        savedAt: new Date().toISOString(),
        project,
        videos: videos.map((asset) => asset.file),
        videoDurations: videos.map((asset) => asset.duration),
        audios: audios.map((asset) => asset.file),
        audioDurations: audios.map((asset) => asset.duration),
        images: images.map((asset) => asset.file),
        outputSize,
        quality,
      })
      setSavedAt(new Date().toLocaleTimeString('ar-SA'))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'تعذر حفظ المشروع. قد تكون مساحة المتصفح غير كافية.')
    } finally {
      setSaving(false)
    }
  }

  const restoreProject = async () => {
    setError(null)
    try {
      const snapshot = await loadStoredVideoProject<ProjectState>()
      if (!snapshot) {
        setError('لا يوجد مشروع V3 محفوظ في هذا المتصفح.')
        return
      }
      videos.forEach((asset) => URL.revokeObjectURL(asset.url))
      images.forEach((asset) => URL.revokeObjectURL(asset.url))
      const restoredVideos = snapshot.videos.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: snapshot.videoDurations[index] || 0 }))
      const restoredAudios = snapshot.audios.map((file, index) => ({ file, duration: snapshot.audioDurations[index] || 0 }))
      const restoredImages = snapshot.images.map((file) => ({ file, url: URL.createObjectURL(file) }))
      setVideos(restoredVideos)
      setAudios(restoredAudios)
      setImages(restoredImages)
      setHistory({ past: [], present: snapshot.project, future: [] })
      setOutputSize(snapshot.outputSize as OutputSize)
      setQuality(snapshot.quality as RenderQuality)
      setSavedAt(new Date(snapshot.savedAt).toLocaleTimeString('ar-SA'))
      setSelection(snapshot.project.clips[0] ? { kind: 'clip', id: snapshot.project.clips[0].id } : null)
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : 'تعذر استعادة المشروع.')
    }
  }

  const clearSavedProject = async () => {
    await clearStoredVideoProject().catch(() => undefined)
    setSavedAt(null)
  }

  const exportProject = async () => {
    if (!project.clips.length) return
    setBusy(true)
    setError(null)
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    setResultUrl(null)
    try {
      const blob = await renderVideoProjectV3(
        videos.map((asset) => asset.file),
        audios.map((asset) => asset.file),
        images.map((asset) => asset.file),
        {
          clips: project.clips.map(({ id: _id, ...clip }) => clip),
          textTracks: project.textTracks.map(({ id: _id, ...track }) => track),
          subtitleTracks: project.subtitleTracks.map(({ id: _id, ...track }) => track),
          audioTracks: project.audioTracks.map(({ id: _id, ...track }) => track),
          imageTracks: project.imageTracks.map(({ id: _id, ...track }) => track),
          transition: project.transition,
          transitionDuration: project.transitionDuration,
        },
        outputSize,
        quality,
      )
      setResultUrl(URL.createObjectURL(blob))
    } catch (renderError) {
      setError(renderError instanceof Error ? renderError.message : 'تعذر تصدير مشروع V3.')
    } finally {
      setBusy(false)
    }
  }

  const activeTitles = project.textTracks.filter((item) => projectTime >= item.startAt && projectTime <= item.endAt)
  const activeSubtitles = project.subtitleTracks.filter((item) => projectTime >= item.startAt && projectTime <= item.endAt)
  const activeImages = project.imageTracks.filter((item) => projectTime >= item.startAt && projectTime <= item.endAt)

  const clipProgress = selectedClip ? clamp((previewTime - selectedClip.start) / Math.max(.001, selectedClip.end - selectedClip.start), 0, 1) : 0
  const currentZoom = selectedClip ? (selectedClip.zoomStart || 1) + ((selectedClip.zoomEnd || selectedClip.zoomStart || 1) - (selectedClip.zoomStart || 1)) * clipProgress : 1
  const currentPanX = selectedClip ? (selectedClip.panXStart || 0) + ((selectedClip.panXEnd || selectedClip.panXStart || 0) - (selectedClip.panXStart || 0)) * clipProgress : 0
  const currentPanY = selectedClip ? (selectedClip.panYStart || 0) + ((selectedClip.panYEnd || selectedClip.panYStart || 0) - (selectedClip.panYStart || 0)) * clipProgress : 0
  const timelineWidth = Math.max(840, projectDuration * timelineZoom + 120)

  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#050710]"><Activity className="h-7 w-7 animate-spin text-cyan-300" /></div>
  if (!authorized) return <div className="grid min-h-screen place-items-center bg-[#050710] text-white"><a href="#" className="rounded-2xl bg-white px-6 py-3 font-black text-black">العودة لتسجيل الدخول</a></div>

  return (
    <main className="min-h-screen bg-[#050710] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_80%_0%,rgba(124,58,237,.20),transparent_28%),radial-gradient(circle_at_8%_90%,rgba(6,182,212,.10),transparent_30%)]" />
      <div className="relative mx-auto max-w-[1900px] px-3 py-4 md:px-5">
        <header className="flex flex-col gap-3 border-b border-white/10 pb-4 2xl:flex-row 2xl:items-center 2xl:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl border border-violet-300/20 bg-violet-400/10"><Film className="h-6 w-6 text-violet-200" /></div>
            <div><div className="flex items-center gap-2"><h1 className="text-xl font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-violet-300/20 bg-violet-300/[.06] px-2 py-1 text-[9px] font-black text-violet-200">PRO V3</span></div><p className="mt-1 text-xs text-slate-500">Keyframes · Chroma Key · Subtitles · Project Save</p></div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={undo} disabled={!history.past.length} className="rounded-xl border border-white/10 p-2.5 text-slate-400 disabled:opacity-25" title="Undo"><Undo2 className="h-4 w-4" /></button>
            <button onClick={redo} disabled={!history.future.length} className="rounded-xl border border-white/10 p-2.5 text-slate-400 disabled:opacity-25" title="Redo"><Redo2 className="h-4 w-4" /></button>
            <button onClick={() => void saveProject()} disabled={saving} className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/15 bg-cyan-300/[.05] px-3.5 py-2.5 text-xs font-black text-cyan-100"><Save className="h-4 w-4" /> {saving ? 'حفظ...' : 'حفظ المشروع'}</button>
            <button onClick={() => void restoreProject()} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.03] px-3.5 py-2.5 text-xs font-bold text-slate-300"><FolderOpen className="h-4 w-4" /> استعادة</button>
            <a href="#video-v2" className="rounded-xl border border-white/10 bg-white/[.03] px-3.5 py-2.5 text-xs font-bold text-slate-400">V2</a>
            <a href="#" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.03] px-3.5 py-2.5 text-xs font-bold text-slate-300"><ArrowLeft className="h-4 w-4" /> الرئيسية</a>
          </div>
        </header>

        {savedAt && <div className="mt-3 flex items-center justify-between rounded-xl border border-emerald-300/10 bg-emerald-300/[.035] px-4 py-2 text-[10px] text-emerald-200"><span>آخر حفظ محلي: {savedAt}</span><button onClick={() => void clearSavedProject()} className="text-slate-500 hover:text-rose-300">حذف النسخة المحفوظة</button></div>}
        {error && <div className="mt-3 rounded-xl border border-rose-300/15 bg-rose-400/[.06] px-4 py-3 text-xs leading-6 text-rose-200">{error}</div>}

        <section className="mt-4 grid gap-4 2xl:grid-cols-[260px_minmax(0,1fr)_330px]">
          <aside className="rounded-3xl border border-white/10 bg-[#090e19]/95 p-4">
            <p className="text-[10px] font-black tracking-[.18em] text-slate-500">MEDIA BIN</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <label className="cursor-pointer rounded-2xl border border-dashed border-violet-300/20 bg-violet-300/[.04] p-3 text-center text-[10px] font-black text-violet-100"><Video className="mx-auto mb-2 h-4 w-4" />VIDEO<input type="file" multiple accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi" className="hidden" onChange={addVideos} /></label>
              <label className="cursor-pointer rounded-2xl border border-dashed border-cyan-300/20 bg-cyan-300/[.04] p-3 text-center text-[10px] font-black text-cyan-100"><Music2 className="mx-auto mb-2 h-4 w-4" />AUDIO<input type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg" className="hidden" onChange={addAudio} /></label>
              <label className="cursor-pointer rounded-2xl border border-dashed border-fuchsia-300/20 bg-fuchsia-300/[.04] p-3 text-center text-[10px] font-black text-fuchsia-100"><ImageIcon className="mx-auto mb-2 h-4 w-4" />OVERLAY<input type="file" accept="image/*,.png,.jpg,.jpeg,.webp" className="hidden" onChange={addImage} /></label>
              <button onClick={addSubtitle} className="rounded-2xl border border-dashed border-amber-300/20 bg-amber-300/[.04] p-3 text-center text-[10px] font-black text-amber-100"><Captions className="mx-auto mb-2 h-4 w-4" />SUBTITLE</button>
            </div>
            <button onClick={addTitle} className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[.03] px-3 py-2.5 text-[10px] font-black text-slate-300"><Type className="h-3.5 w-3.5" /> إضافة عنوان حر</button>
            <div className="mt-5 space-y-2">
              {videos.map((asset, index) => <div key={`${asset.file.name}-${index}`} className="rounded-xl border border-white/8 bg-white/[.025] p-3"><p className="truncate text-[11px] font-bold text-slate-300">{asset.file.name}</p><p className="mt-1 text-[9px] text-slate-600">{fmt(asset.duration)} · {(asset.file.size / 1048576).toFixed(1)} MB</p></div>)}
              {!videos.length && <div className="rounded-xl border border-dashed border-white/8 p-4 text-center text-[10px] leading-5 text-slate-700">ابدأ بإضافة فيديو واحد أو أكثر.</div>}
            </div>
          </aside>

          <div className="min-w-0 space-y-4">
            <div className="rounded-3xl border border-white/10 bg-[#080d17]/95 p-4">
              <div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-black">PROGRAM MONITOR</p><p className="mt-1 text-[10px] text-slate-600">معاينة التحويلات والطبقات عند {fmt(projectTime)}</p></div>{selectedClip?.chromaEnabled && <span className="rounded-lg border border-emerald-300/15 bg-emerald-300/[.05] px-2.5 py-1.5 text-[9px] font-black text-emerald-200">CHROMA ON · يظهر بالكامل بعد Render</span>}</div>
              <div className="relative mx-auto aspect-video max-h-[62vh] overflow-hidden rounded-2xl border border-white/10 bg-black">
                {selectedVideo && selectedClip ? <>
                  <video ref={videoRef} src={selectedVideo.url} className="h-full w-full object-contain transition-transform" style={{ filter: previewFilter(selectedClip.filter), transform: `scale(${currentZoom}) translate(${currentPanX * 18}%, ${currentPanY * 18}%)`, transformOrigin: 'center' }} onTimeUpdate={onTimeUpdate} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} playsInline />
                  {activeImages.map((track) => {
                    const asset = images[track.fileIndex]
                    if (!asset) return null
                    const p = clamp((projectTime - track.startAt) / Math.max(.001, track.endAt - track.startAt), 0, 1)
                    const x = (track.startX ?? .76) + ((track.endX ?? track.startX ?? .76) - (track.startX ?? .76)) * p
                    const y = (track.startY ?? .76) + ((track.endY ?? track.startY ?? .76) - (track.startY ?? .76)) * p
                    const scale = (track.scaleStart ?? track.scale) + ((track.scaleEnd ?? track.scaleStart ?? track.scale) - (track.scaleStart ?? track.scale)) * p
                    return <img key={track.id} src={asset.url} className="pointer-events-none absolute object-contain" style={{ width: `${scale * 100}%`, left: `${x * Math.max(0, 100 - scale * 100)}%`, top: `${y * Math.max(0, 100 - scale * 100)}%`, opacity: track.opacity }} />
                  })}
                  {activeTitles.map((track) => <div key={track.id} className={`pointer-events-none absolute left-6 right-6 text-center font-black text-white drop-shadow-[0_2px_8px_rgba(0,0,0,.9)] ${track.position === 'top' ? 'top-[8%]' : track.position === 'center' ? 'top-1/2 -translate-y-1/2' : 'bottom-[12%]'}`} style={{ fontSize: `${clamp(track.size / 2, 16, 56)}px` }}><span className="rounded-lg bg-black/45 px-3 py-1.5">{track.text}</span></div>)}
                  {activeSubtitles.map((track) => <div key={track.id} className={`pointer-events-none absolute left-8 right-8 text-center font-bold drop-shadow-[0_2px_8px_rgba(0,0,0,.9)] ${track.position === 'top' ? 'top-[8%]' : track.position === 'center' ? 'top-1/2 -translate-y-1/2' : 'bottom-[6%]'}`} style={{ fontSize: `${clamp(track.size / 2, 14, 42)}px`, color: track.color }}><span className="rounded-md px-3 py-1.5" style={{ background: `rgba(0,0,0,${track.boxOpacity})` }}>{track.text}</span></div>)}
                </> : <div className="grid h-full place-items-center text-center"><div><Film className="mx-auto h-12 w-12 text-slate-800" /><p className="mt-4 text-sm font-bold text-slate-600">أضف فيديو وحدد Clip للمعاينة</p></div></div>}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <button onClick={togglePlay} disabled={!selectedClip} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-xs font-black text-black disabled:opacity-30">{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}{playing ? 'إيقاف' : 'تشغيل'}</button>
                <button onClick={splitClip} disabled={!selectedClip} className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] px-4 py-2.5 text-xs font-black text-cyan-100 disabled:opacity-30"><Scissors className="h-4 w-4" /> Split</button>
                <span className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[10px] tabular-nums text-slate-400">SOURCE {fmt(previewTime)} · PROJECT {fmt(projectTime)}</span>
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-[#080d17]/95 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-black">MULTI-TRACK TIMELINE</p><p className="mt-1 text-[10px] text-slate-600">Video · Titles · Subtitles · Music · Overlay</p></div><div className="flex items-center gap-2"><ZoomOut className="h-4 w-4 text-slate-600" /><input type="range" min="3" max="22" value={timelineZoom} onChange={(event) => setTimelineZoom(Number(event.target.value))} className="w-28 accent-cyan-300" /><ZoomIn className="h-4 w-4 text-slate-600" /></div></div>
              <div className="overflow-x-auto rounded-2xl border border-white/8 bg-black/20">
                <div className="relative" style={{ width: timelineWidth }}>
                  <div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-red-400/80" style={{ left: 70 + projectTime * timelineZoom }} />
                  {[
                    ['VIDEO', 'violet'], ['TITLE', 'sky'], ['SUBTITLE', 'amber'], ['MUSIC', 'cyan'], ['OVERLAY', 'fuchsia'],
                  ].map(([label]) => <div key={label} className="h-16 border-b border-white/5"><div className="sticky left-0 z-30 flex h-full w-[70px] items-center bg-[#080d17] px-2 text-[9px] font-black text-slate-600">{label}</div></div>)}
                  <div className="absolute left-[70px] top-0 h-16">
                    {project.clips.map((clip, index) => { const offset = clipOffsets[index]; if (!offset) return null; return <button key={clip.id} onClick={() => { setSelection({ kind: 'clip', id: clip.id }); setProjectTime(offset.start) }} className={`absolute top-2 h-12 overflow-hidden rounded-xl border px-3 text-left ${selection?.kind === 'clip' && selection.id === clip.id ? 'border-violet-200 bg-violet-400/20' : 'border-violet-300/15 bg-violet-400/10'}`} style={{ left: offset.start * timelineZoom, width: Math.max(70, offset.duration * timelineZoom) }}><span className="block truncate text-[9px] font-black text-violet-100">CLIP {index + 1}</span><span className="mt-1 block text-[8px] text-violet-300/50">{fmt(offset.duration)}</span></button> })}
                  </div>
                  <div className="absolute left-[70px] top-16 h-16">{project.textTracks.map((track) => <button key={track.id} onClick={() => setSelection({ kind: 'title', id: track.id })} className="absolute top-2 h-12 rounded-xl border border-sky-300/15 bg-sky-400/10 px-3 text-[9px] font-black text-sky-100" style={{ left: track.startAt * timelineZoom, width: Math.max(70, (track.endAt - track.startAt) * timelineZoom) }}>{track.text}</button>)}</div>
                  <div className="absolute left-[70px] top-32 h-16">{project.subtitleTracks.map((track) => <button key={track.id} onClick={() => setSelection({ kind: 'subtitle', id: track.id })} className="absolute top-2 h-12 overflow-hidden rounded-xl border border-amber-300/15 bg-amber-400/10 px-3 text-[9px] font-black text-amber-100" style={{ left: track.startAt * timelineZoom, width: Math.max(70, (track.endAt - track.startAt) * timelineZoom) }}>{track.text}</button>)}</div>
                  <div className="absolute left-[70px] top-48 h-16">{project.audioTracks.map((track) => <button key={track.id} onClick={() => setSelection({ kind: 'audio', id: track.id })} className="absolute top-2 h-12 rounded-xl border border-cyan-300/15 bg-cyan-400/10 px-3 text-[9px] font-black text-cyan-100" style={{ left: track.startAt * timelineZoom, width: Math.max(70, (track.sourceEnd - track.sourceStart) * timelineZoom) }}>MUSIC</button>)}</div>
                  <div className="absolute left-[70px] top-64 h-16">{project.imageTracks.map((track) => <button key={track.id} onClick={() => setSelection({ kind: 'image', id: track.id })} className="absolute top-2 h-12 rounded-xl border border-fuchsia-300/15 bg-fuchsia-400/10 px-3 text-[9px] font-black text-fuchsia-100" style={{ left: track.startAt * timelineZoom, width: Math.max(70, (track.endAt - track.startAt) * timelineZoom) }}>OVERLAY</button>)}</div>
                </div>
              </div>
            </div>

            {resultUrl && <div className="rounded-3xl border border-emerald-300/15 bg-emerald-300/[.035] p-5"><div className="flex items-center justify-between"><div><p className="text-sm font-black text-emerald-100">اكتمل Render V3</p><p className="mt-1 text-xs text-slate-500">MAGHRABI-video-v3.mp4</p></div><Sparkles className="h-5 w-5 text-emerald-300" /></div><video controls src={resultUrl} className="mt-4 max-h-[520px] w-full rounded-2xl bg-black" /><a href={resultUrl} download="MAGHRABI-video-v3.mp4" className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-5 py-3.5 text-sm font-black text-black"><Download className="h-4 w-4" /> تنزيل الفيديو</a></div>}
          </div>

          <aside className="rounded-3xl border border-white/10 bg-[#090e19]/95 p-4">
            <div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-[.18em] text-slate-500">INSPECTOR</p><p className="mt-1 text-xs font-black text-slate-200">{selection ? selection.kind.toUpperCase() : 'PROJECT'}</p></div><WandSparkles className="h-4 w-4 text-violet-300" /></div>

            {selectedClip && selectedVideo && <div className="mt-5 space-y-5">
              <div><p className="text-[10px] font-black text-slate-500">SOURCE / TRIM</p><div className="mt-2 grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">START<input className={fieldClass()} type="number" step=".05" min="0" value={Number(selectedClip.start.toFixed(2))} onChange={(event) => updateClip(selectedClip.id, { start: clamp(Number(event.target.value), 0, selectedClip.end - .05) })} /></label><label className="text-[9px] text-slate-600">END<input className={fieldClass()} type="number" step=".05" max={selectedVideo.duration} value={Number(selectedClip.end.toFixed(2))} onChange={(event) => updateClip(selectedClip.id, { end: clamp(Number(event.target.value), selectedClip.start + .05, selectedVideo.duration) })} /></label></div></div>
              <div><p className="text-[10px] font-black text-slate-500">BASIC</p><div className="mt-2 grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">SPEED<input className={fieldClass()} type="number" min=".25" max="4" step=".05" value={selectedClip.speed} onChange={(event) => updateClip(selectedClip.id, { speed: clamp(Number(event.target.value), .25, 4) })} /></label><label className="text-[9px] text-slate-600">VOLUME<input className={fieldClass()} type="number" min="0" max="2" step=".05" value={selectedClip.volume} onChange={(event) => updateClip(selectedClip.id, { volume: clamp(Number(event.target.value), 0, 2) })} /></label><label className="text-[9px] text-slate-600">FILTER<select className={fieldClass()} value={selectedClip.filter} onChange={(event) => updateClip(selectedClip.id, { filter: event.target.value as VideoFilter })}>{filters.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="text-[9px] text-slate-600">ROTATE<select className={fieldClass()} value={selectedClip.rotation || 0} onChange={(event) => updateClip(selectedClip.id, { rotation: Number(event.target.value) as 0 | 90 | 180 | 270 })}><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label></div></div>
              <div className="rounded-2xl border border-violet-300/12 bg-violet-300/[.035] p-3"><div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-violet-300" /><p className="text-[10px] font-black text-violet-100">MOTION KEYFRAMES</p></div><p className="mt-1 text-[9px] leading-5 text-slate-600">Start → End للتكبير والتحريك أثناء المقطع.</p><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">ZOOM START<input className={fieldClass()} type="number" min="1" max="4" step=".05" value={selectedClip.zoomStart || 1} onChange={(event) => updateClip(selectedClip.id, { zoomStart: clamp(Number(event.target.value), 1, 4) })} /></label><label className="text-[9px] text-slate-600">ZOOM END<input className={fieldClass()} type="number" min="1" max="4" step=".05" value={selectedClip.zoomEnd || 1} onChange={(event) => updateClip(selectedClip.id, { zoomEnd: clamp(Number(event.target.value), 1, 4) })} /></label><label className="text-[9px] text-slate-600">PAN X START<input className={fieldClass()} type="number" min="-1" max="1" step=".05" value={selectedClip.panXStart || 0} onChange={(event) => updateClip(selectedClip.id, { panXStart: clamp(Number(event.target.value), -1, 1) })} /></label><label className="text-[9px] text-slate-600">PAN X END<input className={fieldClass()} type="number" min="-1" max="1" step=".05" value={selectedClip.panXEnd || 0} onChange={(event) => updateClip(selectedClip.id, { panXEnd: clamp(Number(event.target.value), -1, 1) })} /></label><label className="text-[9px] text-slate-600">PAN Y START<input className={fieldClass()} type="number" min="-1" max="1" step=".05" value={selectedClip.panYStart || 0} onChange={(event) => updateClip(selectedClip.id, { panYStart: clamp(Number(event.target.value), -1, 1) })} /></label><label className="text-[9px] text-slate-600">PAN Y END<input className={fieldClass()} type="number" min="-1" max="1" step=".05" value={selectedClip.panYEnd || 0} onChange={(event) => updateClip(selectedClip.id, { panYEnd: clamp(Number(event.target.value), -1, 1) })} /></label></div></div>
              <div className="rounded-2xl border border-emerald-300/12 bg-emerald-300/[.035] p-3"><label className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-black text-emerald-100">CHROMA KEY</p><p className="mt-1 text-[9px] text-slate-600">إزالة الخلفية الخضراء عند Render.</p></div><input type="checkbox" checked={!!selectedClip.chromaEnabled} onChange={(event) => updateClip(selectedClip.id, { chromaEnabled: event.target.checked })} className="h-4 w-4 accent-emerald-300" /></label>{selectedClip.chromaEnabled && <div className="mt-3 grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">KEY COLOR<input className={`${fieldClass()} h-9 p-1`} type="color" value={selectedClip.chromaColor || '#00ff00'} onChange={(event) => updateClip(selectedClip.id, { chromaColor: event.target.value })} /></label><label className="text-[9px] text-slate-600">BACKGROUND<input className={`${fieldClass()} h-9 p-1`} type="color" value={selectedClip.chromaBackground || '#101010'} onChange={(event) => updateClip(selectedClip.id, { chromaBackground: event.target.value })} /></label><label className="text-[9px] text-slate-600">SIMILARITY<input className={fieldClass()} type="number" min=".01" max="1" step=".01" value={selectedClip.chromaSimilarity || .18} onChange={(event) => updateClip(selectedClip.id, { chromaSimilarity: clamp(Number(event.target.value), .01, 1) })} /></label><label className="text-[9px] text-slate-600">BLEND<input className={fieldClass()} type="number" min="0" max="1" step=".01" value={selectedClip.chromaBlend || .06} onChange={(event) => updateClip(selectedClip.id, { chromaBlend: clamp(Number(event.target.value), 0, 1) })} /></label></div>}</div>
            </div>}

            {selectedSubtitle && <div className="mt-5 space-y-3"><label className="text-[9px] text-slate-600">SUBTITLE<textarea className={`${fieldClass()} min-h-24 resize-y`} value={selectedSubtitle.text} onChange={(event) => updateSubtitle(selectedSubtitle.id, { text: event.target.value })} /></label><div className="grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">START<input className={fieldClass()} type="number" step=".05" value={selectedSubtitle.startAt} onChange={(event) => updateSubtitle(selectedSubtitle.id, { startAt: Math.max(0, Number(event.target.value)) })} /></label><label className="text-[9px] text-slate-600">END<input className={fieldClass()} type="number" step=".05" value={selectedSubtitle.endAt} onChange={(event) => updateSubtitle(selectedSubtitle.id, { endAt: Math.max(selectedSubtitle.startAt + .05, Number(event.target.value)) })} /></label><label className="text-[9px] text-slate-600">SIZE<input className={fieldClass()} type="number" min="18" max="84" value={selectedSubtitle.size} onChange={(event) => updateSubtitle(selectedSubtitle.id, { size: clamp(Number(event.target.value), 18, 84) })} /></label><label className="text-[9px] text-slate-600">COLOR<input className={`${fieldClass()} h-9 p-1`} type="color" value={selectedSubtitle.color} onChange={(event) => updateSubtitle(selectedSubtitle.id, { color: event.target.value })} /></label></div></div>}

            {selectedTitle && <div className="mt-5 space-y-3"><label className="text-[9px] text-slate-600">TITLE<textarea className={`${fieldClass()} min-h-24 resize-y`} value={selectedTitle.text} onChange={(event) => updateTitle(selectedTitle.id, { text: event.target.value })} /></label><div className="grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">START<input className={fieldClass()} type="number" value={selectedTitle.startAt} onChange={(event) => updateTitle(selectedTitle.id, { startAt: Math.max(0, Number(event.target.value)) })} /></label><label className="text-[9px] text-slate-600">END<input className={fieldClass()} type="number" value={selectedTitle.endAt} onChange={(event) => updateTitle(selectedTitle.id, { endAt: Math.max(selectedTitle.startAt + .05, Number(event.target.value)) })} /></label></div></div>}

            {selectedAudio && <div className="mt-5 space-y-3"><p className="text-[10px] font-black text-cyan-100">MUSIC TRACK</p><div className="grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">START AT<input className={fieldClass()} type="number" step=".05" value={selectedAudio.startAt} onChange={(event) => updateAudio(selectedAudio.id, { startAt: Math.max(0, Number(event.target.value)) })} /></label><label className="text-[9px] text-slate-600">VOLUME<input className={fieldClass()} type="number" min="0" max="2" step=".05" value={selectedAudio.volume} onChange={(event) => updateAudio(selectedAudio.id, { volume: clamp(Number(event.target.value), 0, 2) })} /></label><label className="text-[9px] text-slate-600">FADE IN<input className={fieldClass()} type="number" min="0" max="10" step=".1" value={selectedAudio.fadeIn} onChange={(event) => updateAudio(selectedAudio.id, { fadeIn: clamp(Number(event.target.value), 0, 10) })} /></label><label className="text-[9px] text-slate-600">FADE OUT<input className={fieldClass()} type="number" min="0" max="10" step=".1" value={selectedAudio.fadeOut} onChange={(event) => updateAudio(selectedAudio.id, { fadeOut: clamp(Number(event.target.value), 0, 10) })} /></label></div></div>}

            {selectedImage && <div className="mt-5 space-y-4"><div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-fuchsia-300" /><p className="text-[10px] font-black text-fuchsia-100">OVERLAY MOTION KEYFRAMES</p></div><div className="grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">START<input className={fieldClass()} type="number" step=".05" value={selectedImage.startAt} onChange={(event) => updateImage(selectedImage.id, { startAt: Math.max(0, Number(event.target.value)) })} /></label><label className="text-[9px] text-slate-600">END<input className={fieldClass()} type="number" step=".05" value={selectedImage.endAt} onChange={(event) => updateImage(selectedImage.id, { endAt: Math.max(selectedImage.startAt + .05, Number(event.target.value)) })} /></label><label className="text-[9px] text-slate-600">X START<input className={fieldClass()} type="number" min="0" max="1" step=".05" value={selectedImage.startX ?? .76} onChange={(event) => updateImage(selectedImage.id, { startX: clamp(Number(event.target.value), 0, 1) })} /></label><label className="text-[9px] text-slate-600">X END<input className={fieldClass()} type="number" min="0" max="1" step=".05" value={selectedImage.endX ?? .76} onChange={(event) => updateImage(selectedImage.id, { endX: clamp(Number(event.target.value), 0, 1) })} /></label><label className="text-[9px] text-slate-600">Y START<input className={fieldClass()} type="number" min="0" max="1" step=".05" value={selectedImage.startY ?? .76} onChange={(event) => updateImage(selectedImage.id, { startY: clamp(Number(event.target.value), 0, 1) })} /></label><label className="text-[9px] text-slate-600">Y END<input className={fieldClass()} type="number" min="0" max="1" step=".05" value={selectedImage.endY ?? .76} onChange={(event) => updateImage(selectedImage.id, { endY: clamp(Number(event.target.value), 0, 1) })} /></label><label className="text-[9px] text-slate-600">SCALE START<input className={fieldClass()} type="number" min=".05" max="1" step=".02" value={selectedImage.scaleStart ?? selectedImage.scale} onChange={(event) => updateImage(selectedImage.id, { scaleStart: clamp(Number(event.target.value), .05, 1) })} /></label><label className="text-[9px] text-slate-600">SCALE END<input className={fieldClass()} type="number" min=".05" max="1" step=".02" value={selectedImage.scaleEnd ?? selectedImage.scale} onChange={(event) => updateImage(selectedImage.id, { scaleEnd: clamp(Number(event.target.value), .05, 1) })} /></label></div></div>}

            {!selection && <div className="mt-5 space-y-4"><div><p className="text-[10px] font-black text-slate-500">PROJECT</p><div className="mt-2 grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">SIZE<select className={fieldClass()} value={outputSize} onChange={(event) => setOutputSize(event.target.value as OutputSize)}><option value="720p">720p 16:9</option><option value="1080p">1080p 16:9</option><option value="portrait">9:16</option><option value="square">1:1</option></select></label><label className="text-[9px] text-slate-600">QUALITY<select className={fieldClass()} value={quality} onChange={(event) => setQuality(event.target.value as RenderQuality)}><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select></label></div></div></div>}

            {selection && <button onClick={deleteSelection} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-rose-300/15 bg-rose-400/[.05] px-4 py-3 text-xs font-black text-rose-200"><Trash2 className="h-4 w-4" /> حذف العنصر المحدد</button>}
            <button onClick={() => setSelection(null)} className="mt-2 w-full rounded-xl border border-white/10 bg-white/[.025] px-4 py-2.5 text-[10px] font-bold text-slate-500">إعدادات المشروع</button>

            <div className="mt-6 border-t border-white/10 pt-5"><div className="grid grid-cols-2 gap-2"><select className="rounded-xl border border-white/10 bg-[#0b1120] px-3 py-2.5 text-[10px]" value={outputSize} onChange={(event) => setOutputSize(event.target.value as OutputSize)}><option value="720p">720p</option><option value="1080p">1080p</option><option value="portrait">9:16</option><option value="square">1:1</option></select><select className="rounded-xl border border-white/10 bg-[#0b1120] px-3 py-2.5 text-[10px]" value={quality} onChange={(event) => setQuality(event.target.value as RenderQuality)}><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select></div><button onClick={() => void exportProject()} disabled={busy || !project.clips.length} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-l from-violet-500 to-cyan-500 px-5 py-4 text-sm font-black shadow-lg shadow-violet-950/30 disabled:opacity-35">{busy ? <Activity className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{busy ? 'جاري Render V3...' : 'Export V3'}</button><p className="mt-2 text-center text-[9px] leading-5 text-slate-700">المؤثرات المتقدمة تُنفذ فعليًا بواسطة FFmpeg على Railway.</p></div>
          </aside>
        </section>
      </div>
    </main>
  )
}
