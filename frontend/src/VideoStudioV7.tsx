import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Captions,
  Download,
  Film,
  Image as ImageIcon,
  Layers3,
  Magnet,
  Move,
  Music2,
  Pause,
  Play,
  Plus,
  Save,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  UploadCloud,
  Video,
  Volume2,
  WandSparkles,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import {
  AudioTrackManifest,
  createVideoProxy,
  ImageTrackManifest,
  OutputSize,
  PrivacyEffect,
  RenderQuality,
  renderVideoProjectV7,
  SpeedRampPreset,
  SubtitleTrackManifest,
  TextTrackManifest,
  TransformKeyframe,
  VideoClipManifest,
  VideoFilter,
  VideoOverlayTrackManifest,
  VideoTransition,
} from './lib/videoApi'
import { loadStoredVideoProject, saveStoredVideoProject } from './lib/projectStore'

type VideoAsset = { file: File; url: string; duration: number; proxyUrl?: string }
type AudioAsset = { file: File; duration: number; waveform: number[] }
type ImageAsset = { file: File; url: string }
type Clip = VideoClipManifest & { id: string }
type TitleTrack = TextTrackManifest & { id: string }
type SubtitleTrack = SubtitleTrackManifest & { id: string }
type AudioTrack = AudioTrackManifest & { id: string }
type ImageTrack = ImageTrackManifest & { id: string }
type PipTrack = VideoOverlayTrackManifest & { id: string }
type Selection = { kind: 'clip' | 'title' | 'subtitle' | 'audio' | 'image' | 'pip'; id: string } | null
type Panel = 'media' | 'transitions' | 'color' | 'audio' | 'motion' | 'tools'
type DragKind = 'title' | 'subtitle' | 'audio' | 'image' | 'pip'

type ProjectState = {
  clips: Clip[]
  textTracks: TitleTrack[]
  subtitleTracks: SubtitleTrack[]
  audioTracks: AudioTrack[]
  imageTracks: ImageTrack[]
  videoOverlays: PipTrack[]
  transition: VideoTransition
  transitionDuration: number
  audioDuckingEnabled: boolean
  duckingStrength: number
  magneticSnap: boolean
}

const initialProject: ProjectState = {
  clips: [],
  textTracks: [],
  subtitleTracks: [],
  audioTracks: [],
  imageTracks: [],
  videoOverlays: [],
  transition: 'fade',
  transitionDuration: .45,
  audioDuckingEnabled: false,
  duckingStrength: .65,
  magneticSnap: true,
}

const filters: Array<{ value: VideoFilter; label: string }> = [
  { value: 'none', label: 'Normal' }, { value: 'warm', label: 'Warm' }, { value: 'cool', label: 'Cool' },
  { value: 'cinematic', label: 'Cinematic' }, { value: 'vivid', label: 'Vivid' }, { value: 'mono', label: 'Mono' },
]
const transitions: Array<{ value: VideoTransition; label: string }> = [
  { value: 'none', label: 'Cut' }, { value: 'fade', label: 'Fade' }, { value: 'dissolve', label: 'Dissolve' },
  { value: 'fadeblack', label: 'Fade Black' }, { value: 'fadewhite', label: 'Fade White' },
  { value: 'wipeleft', label: 'Wipe Left' }, { value: 'wiperight', label: 'Wipe Right' },
  { value: 'slideleft', label: 'Slide Left' }, { value: 'slideright', label: 'Slide Right' },
  { value: 'smoothleft', label: 'Smooth Left' }, { value: 'smoothright', label: 'Smooth Right' },
  { value: 'circleopen', label: 'Circle Open' }, { value: 'circleclose', label: 'Circle Close' }, { value: 'pixelize', label: 'Pixelize' },
]
const speedRamps: Array<{ value: SpeedRampPreset; label: string }> = [
  { value: 'off', label: 'Normal' }, { value: 'montage', label: 'Montage' }, { value: 'hero', label: 'Hero' },
  { value: 'bullet', label: 'Bullet' }, { value: 'flash', label: 'Flash' },
]

function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}` }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)) }
function fmt(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const mins = Math.floor(safe / 60)
  return `${String(mins).padStart(2, '0')}:${(safe - mins * 60).toFixed(1).padStart(4, '0')}`
}
function fieldClass() { return 'mt-1 w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-xs text-slate-100 outline-none focus:border-cyan-300/35' }
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
    element.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`تعذر قراءة ${file.name}`)) }
    element.src = url
  })
}
async function audioWaveform(file: File, bars = 120) {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return []
    const context = new Ctx()
    const buffer = await context.decodeAudioData((await file.arrayBuffer()).slice(0))
    const channel = buffer.getChannelData(0)
    const size = Math.max(1, Math.floor(channel.length / bars))
    const values = Array.from({ length: bars }, (_, index) => {
      let peak = 0
      const start = index * size
      const end = Math.min(channel.length, start + size)
      for (let i = start; i < end; i += Math.max(1, Math.floor(size / 80))) peak = Math.max(peak, Math.abs(channel[i]))
      return peak
    })
    await context.close()
    const max = Math.max(.001, ...values)
    return values.map((value) => value / max)
  } catch {
    return []
  }
}
function rampSpeeds(preset: SpeedRampPreset, base: number) {
  const map: Record<SpeedRampPreset, number[]> = { off: [1], montage: [.7, 1.8, .7], hero: [.5, 1, 2], bullet: [1, .35, 1], flash: [2, .5, 2] }
  return map[preset].map((value) => clamp(value * base, .25, 4))
}
function clipDuration(clip: Clip) {
  if (clip.freezeFrame) return clip.freezeDuration || 2
  const speeds = rampSpeeds(clip.speedRamp || 'off', clip.speed)
  const part = (clip.end - clip.start) / speeds.length
  return speeds.reduce((sum, speed) => sum + part / speed, 0)
}
function syntheticKeyframes(clip: Clip) {
  const list = [...(clip.transformKeyframes || [])].sort((a, b) => a.time - b.time)
  if (!list.length) return [
    { time: 0, zoom: clip.zoomStart || 1, panX: clip.panXStart || 0, panY: clip.panYStart || 0 },
    { time: 1, zoom: clip.zoomEnd || 1, panX: clip.panXEnd || 0, panY: clip.panYEnd || 0 },
  ]
  if (list[0].time > .0005) list.unshift({ time: 0, zoom: clip.zoomStart || 1, panX: clip.panXStart || 0, panY: clip.panYStart || 0 })
  if (list[list.length - 1].time < .9995) list.push({ time: 1, zoom: clip.zoomEnd || 1, panX: clip.panXEnd || 0, panY: clip.panYEnd || 0 })
  return list
}
function transformAt(clip: Clip, progress: number) {
  const points = syntheticKeyframes(clip)
  const p = clamp(progress, 0, 1)
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index], b = points[index + 1]
    if (p <= b.time || index === points.length - 2) {
      const span = Math.max(.0001, b.time - a.time)
      const t = clamp((p - a.time) / span, 0, 1)
      return {
        zoom: a.zoom + (b.zoom - a.zoom) * t,
        panX: a.panX + (b.panX - a.panX) * t,
        panY: a.panY + (b.panY - a.panY) * t,
      }
    }
  }
  return points[points.length - 1]
}

export default function VideoStudioV7() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const monitorRef = useRef<HTMLDivElement>(null)
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
  const [timelineZoom, setTimelineZoom] = useState(9)
  const [snapGuide, setSnapGuide] = useState<number | null>(null)
  const [dragState, setDragState] = useState<{ kind: DragKind; id: string; x: number; start: number; duration: number } | null>(null)
  const [pipDrag, setPipDrag] = useState<{ id: string; x: number; y: number; px: number; py: number; scale: number } | null>(null)
  const [activeKeyframe, setActiveKeyframe] = useState<number | null>(null)
  const [directMove, setDirectMove] = useState(false)
  const [moveStart, setMoveStart] = useState<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const [lutFile, setLutFile] = useState<File | null>(null)
  const [proxyBusy, setProxyBusy] = useState(false)
  const [outputSize, setOutputSize] = useState<OutputSize>('720p')
  const [quality, setQuality] = useState<RenderQuality>('standard')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)

  useEffect(() => { getAuthStatus().then((status) => setAuthorized(status.authenticated)).catch(() => setAuthorized(false)) }, [])

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
  const selectedClipIndex = selection?.kind === 'clip' ? project.clips.findIndex((item) => item.id === selection.id) : -1
  const selectedClip = selectedClipIndex >= 0 ? project.clips[selectedClipIndex] : null
  const selectedVideo = selectedClip ? videos[selectedClip.fileIndex] : null
  const selectedAudio = selection?.kind === 'audio' ? project.audioTracks.find((item) => item.id === selection.id) || null : null
  const selectedPip = selection?.kind === 'pip' ? project.videoOverlays.find((item) => item.id === selection.id) || null : null
  const selectedTitle = selection?.kind === 'title' ? project.textTracks.find((item) => item.id === selection.id) || null : null
  const selectedSubtitle = selection?.kind === 'subtitle' ? project.subtitleTracks.find((item) => item.id === selection.id) || null : null
  const selectedImage = selection?.kind === 'image' ? project.imageTracks.find((item) => item.id === selection.id) || null : null

  const updateClip = (id: string, changes: Partial<Clip>) => setProject((state) => ({ ...state, clips: state.clips.map((item) => item.id === id ? { ...item, ...changes } : item) }))
  const updateAudio = (id: string, changes: Partial<AudioTrack>) => setProject((state) => ({ ...state, audioTracks: state.audioTracks.map((item) => item.id === id ? { ...item, ...changes } : item) }))
  const updatePip = (id: string, changes: Partial<PipTrack>) => setProject((state) => ({ ...state, videoOverlays: state.videoOverlays.map((item) => item.id === id ? { ...item, ...changes } : item) }))
  const updateTitle = (id: string, changes: Partial<TitleTrack>) => setProject((state) => ({ ...state, textTracks: state.textTracks.map((item) => item.id === id ? { ...item, ...changes } : item) }))
  const updateSubtitle = (id: string, changes: Partial<SubtitleTrack>) => setProject((state) => ({ ...state, subtitleTracks: state.subtitleTracks.map((item) => item.id === id ? { ...item, ...changes } : item) }))
  const updateImage = (id: string, changes: Partial<ImageTrack>) => setProject((state) => ({ ...state, imageTracks: state.imageTracks.map((item) => item.id === id ? { ...item, ...changes } : item) }))

  const makeClip = (fileIndex: number, duration: number): Clip => ({
    id: uid(), fileIndex, start: 0, end: duration, speed: 1, volume: 1, filter: 'none', text: '', textSize: 48,
    textPosition: 'bottom', rotation: 0, fit: 'contain', zoomStart: 1, zoomEnd: 1, panXStart: 0, panXEnd: 0,
    panYStart: 0, panYEnd: 0, chromaEnabled: false, chromaColor: '#00ff00', chromaBackground: '#101010',
    chromaSimilarity: .18, chromaBlend: .06, brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0,
    speedRamp: 'off', reverse: false, freezeFrame: false, freezeDuration: 2, privacyEffect: 'none', privacyX: .35,
    privacyY: .3, privacyWidth: .3, privacyHeight: .22, privacyIntensity: .55, transformKeyframes: [],
  })

  const addVideoFiles = async (files: File[]) => {
    const limited = files.slice(0, Math.max(0, 10 - videos.length))
    if (!limited.length) return
    const durations = await Promise.all(limited.map((file) => mediaDuration(file, 'video')))
    const base = videos.length
    const assets = limited.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: durations[index] }))
    const clips = assets.map((asset, index) => makeClip(base + index, asset.duration))
    setVideos((state) => [...state, ...assets])
    setProject((state) => ({ ...state, clips: [...state.clips, ...clips] }))
    if (clips[0]) { setSelection({ kind: 'clip', id: clips[0].id }); setActiveKeyframe(null) }
  }
  const onVideoInput = async (event: ChangeEvent<HTMLInputElement>) => {
    try { await addVideoFiles(Array.from(event.target.files || [])); setError(null) } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الفيديو.') }
    event.target.value = ''
  }
  const addAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    try {
      const duration = await mediaDuration(file, 'audio')
      const waveform = await audioWaveform(file)
      const fileIndex = audios.length
      setAudios((state) => [...state, { file, duration, waveform }])
      const track: AudioTrack = { id: uid(), fileIndex, startAt: projectTime, sourceStart: 0, sourceEnd: duration, volume: .65, fadeIn: .25, fadeOut: .45 }
      setProject((state) => ({ ...state, audioTracks: [...state.audioTracks, track] }))
      setSelection({ kind: 'audio', id: track.id }); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الصوت.') }
    event.target.value = ''
  }
  const addPip = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    try {
      if (videos.length >= 10) throw new Error('وصلت للحد الأعلى من ملفات الفيديو.')
      const duration = await mediaDuration(file, 'video')
      const fileIndex = videos.length
      setVideos((state) => [...state, { file, url: URL.createObjectURL(file), duration }])
      const length = Math.min(duration, 6)
      const track: PipTrack = { id: uid(), fileIndex, startAt: projectTime, endAt: projectTime + length, sourceStart: 0, sourceEnd: length, scale: .3, opacity: 1, x: .68, y: .62, borderRadius: .08, audioEnabled: false, audioVolume: .85 }
      setProject((state) => ({ ...state, videoOverlays: [...state.videoOverlays, track] }))
      setSelection({ kind: 'pip', id: track.id }); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة PiP.') }
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
      const time = clamp(previewTime || selectedClip.start, selectedClip.start, selectedClip.end)
      try { video.currentTime = time; video.playbackRate = selectedClip.speed; video.volume = clamp(selectedClip.volume, 0, 1) } catch {}
    }
    if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true })
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [selection?.id, selectedVideo?.proxyUrl, selectedVideo?.url])

  const togglePlay = async () => {
    const video = videoRef.current; if (!video || !selectedClip) return
    if (video.paused) {
      if (video.currentTime < selectedClip.start || video.currentTime >= selectedClip.end) video.currentTime = selectedClip.start
      video.playbackRate = selectedClip.speed
      await video.play().catch(() => undefined)
    } else video.pause()
  }
  const onTimeUpdate = () => {
    const video = videoRef.current; if (!video || !selectedClip || selectedClipIndex < 0) return
    const sourceTime = video.currentTime
    setPreviewTime(sourceTime)
    const local = Math.max(0, (sourceTime - selectedClip.start) / Math.max(.25, selectedClip.speed))
    setProjectTime((clipOffsets[selectedClipIndex]?.start || 0) + local)
    if (sourceTime >= selectedClip.end - .015) { video.pause(); video.currentTime = selectedClip.start }
  }
  const splitClip = () => {
    if (!selectedClip) return
    const at = clamp(previewTime, selectedClip.start, selectedClip.end)
    if (at - selectedClip.start < .12 || selectedClip.end - at < .12) { setError('حرّك المؤشر داخل المقطع ثم نفذ Split.'); return }
    const sourceSpan = selectedClip.end - selectedClip.start
    const splitProgress = (at - selectedClip.start) / sourceSpan
    const leftKeyframes = (selectedClip.transformKeyframes || []).filter((kf) => kf.time <= splitProgress).map((kf) => ({ ...kf, time: splitProgress > 0 ? kf.time / splitProgress : 0 }))
    const rightKeyframes = (selectedClip.transformKeyframes || []).filter((kf) => kf.time >= splitProgress).map((kf) => ({ ...kf, time: splitProgress < 1 ? (kf.time - splitProgress) / (1 - splitProgress) : 1 }))
    const left: Clip = { ...selectedClip, id: uid(), end: at, transformKeyframes: leftKeyframes }
    const right: Clip = { ...selectedClip, id: uid(), start: at, transformKeyframes: rightKeyframes }
    setProject((state) => ({ ...state, clips: state.clips.flatMap((item) => item.id === selectedClip.id ? [left, right] : [item]) }))
    setSelection({ kind: 'clip', id: right.id }); setActiveKeyframe(null); setError(null)
  }
  const deleteSelection = () => {
    if (!selection) return
    setProject((state) => ({ ...state,
      clips: selection.kind === 'clip' ? state.clips.filter((item) => item.id !== selection.id) : state.clips,
      textTracks: selection.kind === 'title' ? state.textTracks.filter((item) => item.id !== selection.id) : state.textTracks,
      subtitleTracks: selection.kind === 'subtitle' ? state.subtitleTracks.filter((item) => item.id !== selection.id) : state.subtitleTracks,
      audioTracks: selection.kind === 'audio' ? state.audioTracks.filter((item) => item.id !== selection.id) : state.audioTracks,
      imageTracks: selection.kind === 'image' ? state.imageTracks.filter((item) => item.id !== selection.id) : state.imageTracks,
      videoOverlays: selection.kind === 'pip' ? state.videoOverlays.filter((item) => item.id !== selection.id) : state.videoOverlays,
    }))
    setSelection(null); setActiveKeyframe(null)
  }

  const addKeyframe = () => {
    if (!selectedClip) return
    const progress = clamp((previewTime - selectedClip.start) / Math.max(.001, selectedClip.end - selectedClip.start), 0, 1)
    const current = transformAt(selectedClip, progress)
    let list = [...(selectedClip.transformKeyframes || [])]
    if (!list.length) list = [
      { time: 0, zoom: selectedClip.zoomStart || 1, panX: selectedClip.panXStart || 0, panY: selectedClip.panYStart || 0 },
      { time: 1, zoom: selectedClip.zoomEnd || 1, panX: selectedClip.panXEnd || 0, panY: selectedClip.panYEnd || 0 },
    ]
    const existing = list.findIndex((item) => Math.abs(item.time - progress) < .012)
    if (existing >= 0) { setActiveKeyframe(existing); return }
    if (list.length >= 16) { setError('الحد الأعلى 16 Keyframes داخل المقطع.'); return }
    list.push({ time: progress, zoom: current.zoom, panX: current.panX, panY: current.panY })
    list.sort((a, b) => a.time - b.time)
    updateClip(selectedClip.id, { transformKeyframes: list })
    setActiveKeyframe(list.findIndex((item) => Math.abs(item.time - progress) < .0005)); setError(null)
  }
  const updateKeyframe = (index: number, changes: Partial<TransformKeyframe>) => {
    if (!selectedClip) return
    const list = [...(selectedClip.transformKeyframes || [])]
    if (!list[index]) return
    list[index] = { ...list[index], ...changes }
    updateClip(selectedClip.id, { transformKeyframes: list })
  }
  const deleteKeyframe = (index: number) => {
    if (!selectedClip) return
    const list = (selectedClip.transformKeyframes || []).filter((_, i) => i !== index)
    updateClip(selectedClip.id, { transformKeyframes: list }); setActiveKeyframe(null)
  }
  const seekKeyframe = (index: number) => {
    if (!selectedClip) return
    const kf = selectedClip.transformKeyframes?.[index]; if (!kf) return
    const source = selectedClip.start + (selectedClip.end - selectedClip.start) * kf.time
    setActiveKeyframe(index); setPreviewTime(source)
    if (videoRef.current) videoRef.current.currentTime = source
  }

  const beginDirectMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!directMove || !selectedClip) return
    const transform = activeKeyframe !== null && selectedClip.transformKeyframes?.[activeKeyframe]
      ? selectedClip.transformKeyframes[activeKeyframe]
      : transformAt(selectedClip, clamp((previewTime - selectedClip.start) / Math.max(.001, selectedClip.end - selectedClip.start), 0, 1))
    event.currentTarget.setPointerCapture(event.pointerId)
    setMoveStart({ x: event.clientX, y: event.clientY, panX: transform.panX, panY: transform.panY })
  }
  const moveDirect = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!moveStart || !selectedClip || !monitorRef.current) return
    const rect = monitorRef.current.getBoundingClientRect()
    const panX = clamp(moveStart.panX + ((event.clientX - moveStart.x) / rect.width) * 2, -1, 1)
    const panY = clamp(moveStart.panY + ((event.clientY - moveStart.y) / rect.height) * 2, -1, 1)
    if (activeKeyframe !== null && selectedClip.transformKeyframes?.[activeKeyframe]) updateKeyframe(activeKeyframe, { panX, panY })
    else updateClip(selectedClip.id, { panXStart: panX, panXEnd: panX, panYStart: panY, panYEnd: panY })
  }
  const endDirect = () => setMoveStart(null)

  const auxiliaryBoundaries = useMemo(() => [0, projectTime, ...clipOffsets.flatMap((item) => [item.start, item.end])], [clipOffsets, projectTime])
  const snapTrackStart = (start: number, duration: number) => {
    if (!project.magneticSnap) return { start: Math.max(0, start), guide: null as number | null }
    const threshold = Math.max(.06, 9 / Math.max(3, timelineZoom))
    let bestStart = Math.max(0, start), guide: number | null = null, distance = Infinity
    for (const candidate of auxiliaryBoundaries) {
      const dStart = Math.abs(start - candidate)
      if (dStart < distance && dStart <= threshold) { bestStart = candidate; guide = candidate; distance = dStart }
      const dEnd = Math.abs(start + duration - candidate)
      if (dEnd < distance && dEnd <= threshold) { bestStart = Math.max(0, candidate - duration); guide = candidate; distance = dEnd }
    }
    return { start: bestStart, guide }
  }
  const trackDuration = (kind: DragKind, id: string) => {
    if (kind === 'audio') { const item = project.audioTracks.find((track) => track.id === id); return item ? item.sourceEnd - item.sourceStart : 0 }
    if (kind === 'pip') { const item = project.videoOverlays.find((track) => track.id === id); return item ? item.endAt - item.startAt : 0 }
    if (kind === 'title') { const item = project.textTracks.find((track) => track.id === id); return item ? item.endAt - item.startAt : 0 }
    if (kind === 'subtitle') { const item = project.subtitleTracks.find((track) => track.id === id); return item ? item.endAt - item.startAt : 0 }
    const item = project.imageTracks.find((track) => track.id === id); return item ? item.endAt - item.startAt : 0
  }
  const trackStart = (kind: DragKind, id: string) => {
    if (kind === 'audio') return project.audioTracks.find((track) => track.id === id)?.startAt || 0
    if (kind === 'pip') return project.videoOverlays.find((track) => track.id === id)?.startAt || 0
    if (kind === 'title') return project.textTracks.find((track) => track.id === id)?.startAt || 0
    if (kind === 'subtitle') return project.subtitleTracks.find((track) => track.id === id)?.startAt || 0
    return project.imageTracks.find((track) => track.id === id)?.startAt || 0
  }
  const applyTrackStart = (kind: DragKind, id: string, start: number, duration: number) => {
    if (kind === 'audio') updateAudio(id, { startAt: start })
    else if (kind === 'pip') updatePip(id, { startAt: start, endAt: start + duration })
    else if (kind === 'title') updateTitle(id, { startAt: start, endAt: start + duration })
    else if (kind === 'subtitle') updateSubtitle(id, { startAt: start, endAt: start + duration })
    else updateImage(id, { startAt: start, endAt: start + duration })
  }
  const beginTrackDrag = (event: ReactPointerEvent<HTMLButtonElement>, kind: DragKind, id: string) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragState({ kind, id, x: event.clientX, start: trackStart(kind, id), duration: trackDuration(kind, id) })
    setSelection({ kind, id } as Selection)
  }
  const moveTrack = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragState) return
    const raw = dragState.start + (event.clientX - dragState.x) / timelineZoom
    const snapped = snapTrackStart(raw, dragState.duration)
    applyTrackStart(dragState.kind, dragState.id, snapped.start, dragState.duration); setSnapGuide(snapped.guide)
  }
  const endTrackDrag = () => { setDragState(null); setSnapGuide(null) }

  const beginPipDrag = (event: ReactPointerEvent<HTMLDivElement>, track: PipTrack) => {
    event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
    setPipDrag({ id: track.id, x: event.clientX, y: event.clientY, px: track.x, py: track.y, scale: track.scale }); setSelection({ kind: 'pip', id: track.id })
  }
  const movePip = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pipDrag || !monitorRef.current) return
    const rect = monitorRef.current.getBoundingClientRect()
    updatePip(pipDrag.id, { x: clamp(pipDrag.px + (event.clientX - pipDrag.x) / Math.max(40, rect.width * (1 - pipDrag.scale)), 0, 1), y: clamp(pipDrag.py + (event.clientY - pipDrag.y) / Math.max(40, rect.height * (1 - pipDrag.scale)), 0, 1) })
  }
  const endPip = () => setPipDrag(null)

  const createProxyForSelected = async () => {
    if (!selectedClip || !selectedVideo || selectedVideo.proxyUrl) return
    setProxyBusy(true); setError(null)
    try {
      const blob = await createVideoProxy(selectedVideo.file)
      const proxyUrl = URL.createObjectURL(blob)
      setVideos((state) => state.map((item, index) => index === selectedClip.fileIndex ? { ...item, proxyUrl } : item))
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إنشاء Proxy.') } finally { setProxyBusy(false) }
  }
  const removeProxy = () => {
    if (!selectedClip || !selectedVideo?.proxyUrl) return
    URL.revokeObjectURL(selectedVideo.proxyUrl)
    setVideos((state) => state.map((item, index) => index === selectedClip.fileIndex ? { ...item, proxyUrl: undefined } : item))
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
      const audioAssets = await Promise.all(snap.audios.map(async (file, index) => ({ file, duration: snap.audioDurations[index] || 0, waveform: await audioWaveform(file) })))
      setVideos(snap.videos.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: snap.videoDurations[index] || 0 })))
      setAudios(audioAssets); setImages(snap.images.map((file) => ({ file, url: URL.createObjectURL(file) })))
      const restored = { ...initialProject, ...snap.project, magneticSnap: snap.project.magneticSnap ?? true, videoOverlays: snap.project.videoOverlays || [] }
      setProject(restored); setOutputSize(snap.outputSize as OutputSize); setQuality(snap.quality as RenderQuality)
      setSelection(restored.clips[0] ? { kind: 'clip', id: restored.clips[0].id } : null); setActiveKeyframe(null); setLutFile(null); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر استعادة المشروع.') }
  }
  const exportProject = async () => {
    if (!project.clips.length) return
    setBusy(true); setError(null); if (resultUrl) URL.revokeObjectURL(resultUrl); setResultUrl(null)
    try {
      const blob = await renderVideoProjectV7(videos.map((item) => item.file), audios.map((item) => item.file), images.map((item) => item.file), {
        clips: project.clips.map(({ id: _id, ...clip }) => clip), textTracks: project.textTracks.map(({ id: _id, ...track }) => track),
        subtitleTracks: project.subtitleTracks.map(({ id: _id, ...track }) => track), audioTracks: project.audioTracks.map(({ id: _id, ...track }) => track),
        imageTracks: project.imageTracks.map(({ id: _id, ...track }) => track), videoOverlays: project.videoOverlays.map(({ id: _id, ...track }) => track),
        transition: project.transition, transitionDuration: project.transitionDuration, audioDuckingEnabled: project.audioDuckingEnabled,
        duckingStrength: project.duckingStrength, magneticSnap: project.magneticSnap,
      }, outputSize, quality, lutFile)
      setResultUrl(URL.createObjectURL(blob))
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تصدير V7.') } finally { setBusy(false) }
  }

  const progress = selectedClip ? clamp((previewTime - selectedClip.start) / Math.max(.001, selectedClip.end - selectedClip.start), 0, 1) : 0
  const transform = selectedClip ? transformAt(selectedClip, progress) : { zoom: 1, panX: 0, panY: 0 }
  const activeTitles = project.textTracks.filter((item) => projectTime >= item.startAt && projectTime <= item.endAt)
  const activeSubs = project.subtitleTracks.filter((item) => projectTime >= item.startAt && projectTime <= item.endAt)
  const activeImages = project.imageTracks.filter((item) => projectTime >= item.startAt && projectTime <= item.endAt)
  const activePips = project.videoOverlays.filter((item) => projectTime >= item.startAt && projectTime <= item.endAt)
  const previewBase = selectedClip?.filter === 'warm' ? 'sepia(.10)' : selectedClip?.filter === 'cool' ? 'hue-rotate(8deg)' : selectedClip?.filter === 'mono' ? 'grayscale(1)' : ''
  const previewCss = selectedClip ? `${previewBase} brightness(${1 + (selectedClip.brightness || 0)}) contrast(${selectedClip.contrast || 1}) saturate(${selectedClip.saturation || 1})` : 'none'
  const timelineWidth = Math.max(1100, projectDuration * timelineZoom + 150)

  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#050710]"><Activity className="h-7 w-7 animate-spin text-cyan-300" /></div>
  if (!authorized) return <div className="grid min-h-screen place-items-center bg-[#050710] text-white"><a href="#" className="rounded-2xl bg-white px-6 py-3 font-black text-black">العودة لتسجيل الدخول</a></div>

  return (
    <main className="min-h-screen bg-[#050710] text-slate-100">
      <div className="mx-auto max-w-[1960px] px-3 py-3 md:px-5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
          <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-cyan-400/10"><Film className="h-5 w-5 text-cyan-200" /></div><div><div className="flex items-center gap-2"><h1 className="text-lg font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-cyan-300/20 bg-cyan-300/[.06] px-2 py-1 text-[9px] font-black text-cyan-200">CREATOR V7</span></div><p className="mt-1 text-[10px] text-slate-500">Multi-Keyframes · Waveforms · Magnetic Timeline · LUT · Proxy Workflow</p></div></div>
          <div className="flex flex-wrap gap-2"><button onClick={saveProject} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black"><Save className="mr-1 inline h-3.5 w-3.5"/>حفظ</button><button onClick={restoreProject} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black">استعادة</button><a href="#video-v6" className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black text-slate-400">V6</a><select value={outputSize} onChange={(e)=>setOutputSize(e.target.value as OutputSize)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="720p">720p</option><option value="1080p">1080p</option><option value="portrait">9:16</option><option value="square">1:1</option></select><select value={quality} onChange={(e)=>setQuality(e.target.value as RenderQuality)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select><button onClick={exportProject} disabled={busy||!project.clips.length} className="rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-2 text-xs font-black disabled:opacity-30">{busy?'Rendering V7...':'EXPORT V7'}</button></div>
        </header>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/10 bg-white/[.025] p-1.5"><div className="flex flex-wrap gap-1">{(['media','transitions','color','audio','motion','tools'] as Panel[]).map((item)=><button key={item} onClick={()=>setPanel(item)} className={`rounded-xl px-4 py-2 text-[10px] font-black ${panel===item?'bg-white text-black':'text-slate-400'}`}>{item.toUpperCase()}</button>)}</div><button onClick={()=>setProject(state=>({...state,magneticSnap:!state.magneticSnap}))} className={`rounded-xl border px-3 py-2 text-[10px] font-black ${project.magneticSnap?'border-cyan-300/40 bg-cyan-300/10 text-cyan-100':'border-white/10 text-slate-500'}`}><Magnet className="mr-1 inline h-3.5 w-3.5"/>MAGNETIC SNAP</button></div>

        <section className="mt-3 grid gap-3 2xl:grid-cols-[290px_minmax(0,1fr)_360px]">
          <aside className="rounded-3xl border border-white/10 bg-[#090e19] p-4">
            {panel==='media'&&<><p className="text-[10px] font-black tracking-widest text-slate-500">MEDIA / PROXY</p><div className="mt-4 grid grid-cols-2 gap-2"><label className="cursor-pointer rounded-2xl border border-dashed border-violet-300/20 p-3 text-center text-[9px] font-black"><UploadCloud className="mx-auto mb-2 h-4 w-4"/>VIDEO<input type="file" multiple accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi" className="hidden" onChange={onVideoInput}/></label><label className="cursor-pointer rounded-2xl border border-dashed border-emerald-300/20 p-3 text-center text-[9px] font-black"><Layers3 className="mx-auto mb-2 h-4 w-4"/>PIP<input type="file" accept="video/*" className="hidden" onChange={addPip}/></label><label className="cursor-pointer rounded-2xl border border-dashed border-cyan-300/20 p-3 text-center text-[9px] font-black"><Music2 className="mx-auto mb-2 h-4 w-4"/>AUDIO<input type="file" accept="audio/*" className="hidden" onChange={addAudio}/></label><label className="cursor-pointer rounded-2xl border border-dashed border-fuchsia-300/20 p-3 text-center text-[9px] font-black"><ImageIcon className="mx-auto mb-2 h-4 w-4"/>IMAGE<input type="file" accept="image/*" className="hidden" onChange={addImage}/></label><button onClick={addTitle} className="rounded-2xl border border-dashed border-sky-300/20 p-3 text-[9px] font-black"><Type className="mx-auto mb-2 h-4 w-4"/>TITLE</button><button onClick={addSubtitle} className="rounded-2xl border border-dashed border-amber-300/20 p-3 text-[9px] font-black"><Captions className="mx-auto mb-2 h-4 w-4"/>SUBTITLE</button></div>{selectedClip&&selectedVideo&&<div className="mt-5 rounded-2xl border border-white/10 p-3"><p className="text-[10px] font-black">PROXY WORKFLOW</p><p className="mt-1 text-[9px] leading-5 text-slate-600">Proxy خفيف للمعاينة فقط. Export يستخدم الملف الأصلي.</p>{selectedVideo.proxyUrl?<button onClick={removeProxy} className="mt-3 w-full rounded-xl border border-rose-300/20 px-3 py-2 text-[9px] font-black text-rose-200">إلغاء Proxy</button>:<button onClick={createProxyForSelected} disabled={proxyBusy} className="mt-3 w-full rounded-xl bg-cyan-300/10 px-3 py-2 text-[9px] font-black text-cyan-100 disabled:opacity-40">{proxyBusy?'إنشاء Proxy...':'إنشاء Proxy 540p'}</button>}</div>}</>}
            {panel==='transitions'&&<><p className="text-[10px] font-black tracking-widest text-slate-500">TRANSITIONS</p><div className="mt-4 grid grid-cols-2 gap-2">{transitions.map((item)=><button key={item.value} onClick={()=>setProject(state=>({...state,transition:item.value}))} className={`rounded-xl border p-3 text-[9px] font-black ${project.transition===item.value?'border-violet-300/40 bg-violet-300/10':'border-white/10'}`}>{item.label}</button>)}</div><label className="mt-4 block text-[9px] text-slate-600">DURATION<input className={fieldClass()} type="number" min=".1" max="1.5" step=".05" value={project.transitionDuration} onChange={(e)=>setProject(state=>({...state,transitionDuration:clamp(Number(e.target.value),.1,1.5)}))}/></label></>}
            {panel==='color'&&<><p className="text-[10px] font-black tracking-widest text-slate-500">COLOR / MASTER LUT</p><label className="mt-4 block cursor-pointer rounded-2xl border border-dashed border-amber-300/20 p-4 text-center text-[9px] font-black"><WandSparkles className="mx-auto mb-2 h-4 w-4 text-amber-200"/>{lutFile?lutFile.name:'IMPORT .CUBE LUT'}<input type="file" accept=".cube" className="hidden" onChange={(e)=>{const file=e.target.files?.[0]||null;setLutFile(file);e.target.value=''}}/></label>{lutFile&&<button onClick={()=>setLutFile(null)} className="mt-2 w-full rounded-xl border border-white/10 px-3 py-2 text-[9px]">إزالة Master LUT</button>}{selectedClip&&<div className="mt-5 space-y-4"><div className="grid grid-cols-2 gap-2">{filters.map((item)=><button key={item.value} onClick={()=>updateClip(selectedClip.id,{filter:item.value})} className={`rounded-xl border px-3 py-2 text-[9px] font-black ${selectedClip.filter===item.value?'border-cyan-300/40 bg-cyan-300/10':'border-white/10'}`}>{item.label}</button>)}</div><label className="block text-[9px] text-slate-600">BRIGHTNESS<input type="range" min="-.6" max=".6" step=".02" value={selectedClip.brightness||0} onChange={(e)=>updateClip(selectedClip.id,{brightness:Number(e.target.value)})} className="mt-2 w-full accent-cyan-300"/></label><label className="block text-[9px] text-slate-600">CONTRAST<input type="range" min=".5" max="2" step=".02" value={selectedClip.contrast||1} onChange={(e)=>updateClip(selectedClip.id,{contrast:Number(e.target.value)})} className="mt-2 w-full accent-cyan-300"/></label><label className="block text-[9px] text-slate-600">SATURATION<input type="range" min="0" max="3" step=".02" value={selectedClip.saturation||1} onChange={(e)=>updateClip(selectedClip.id,{saturation:Number(e.target.value)})} className="mt-2 w-full accent-cyan-300"/></label></div>}</>}
            {panel==='audio'&&<><p className="text-[10px] font-black tracking-widest text-slate-500">AUDIO MIXER</p><label className="mt-4 flex items-center justify-between rounded-xl border border-white/10 p-3 text-[10px] font-black"><span><Volume2 className="mr-2 inline h-4 w-4"/>Audio Ducking</span><input type="checkbox" checked={project.audioDuckingEnabled} onChange={(e)=>setProject(state=>({...state,audioDuckingEnabled:e.target.checked}))}/></label><label className="mt-4 block text-[9px] text-slate-600">DUCKING {Math.round(project.duckingStrength*100)}%<input type="range" min="0" max="1" step=".05" value={project.duckingStrength} onChange={(e)=>setProject(state=>({...state,duckingStrength:Number(e.target.value)}))} className="mt-2 w-full accent-cyan-300"/></label>{selectedAudio&&<label className="mt-5 block text-[9px] text-slate-600">MUSIC VOLUME<input className={fieldClass()} type="number" min="0" max="2" step=".05" value={selectedAudio.volume} onChange={(e)=>updateAudio(selectedAudio.id,{volume:clamp(Number(e.target.value),0,2)})}/></label>}{selectedPip&&<div className="mt-5 space-y-3"><label className="flex items-center justify-between rounded-xl border border-white/10 p-3 text-[10px]"><span>PiP Audio</span><input type="checkbox" checked={!!selectedPip.audioEnabled} onChange={(e)=>updatePip(selectedPip.id,{audioEnabled:e.target.checked})}/></label><label className="block text-[9px] text-slate-600">PIP VOLUME<input className={fieldClass()} type="number" min="0" max="2" step=".05" value={selectedPip.audioVolume??.85} onChange={(e)=>updatePip(selectedPip.id,{audioVolume:clamp(Number(e.target.value),0,2)})}/></label></div>}</>}
            {panel==='motion'&&<><p className="text-[10px] font-black tracking-widest text-slate-500">MULTI-KEYFRAME MOTION</p>{selectedClip?<><button onClick={addKeyframe} className="mt-4 w-full rounded-xl bg-amber-300/10 px-3 py-3 text-[10px] font-black text-amber-100"><Plus className="mr-1 inline h-4 w-4"/>ADD KEYFRAME AT PLAYHEAD</button><div className="mt-3 space-y-2">{(selectedClip.transformKeyframes||[]).map((kf,index)=><button key={`${kf.time}-${index}`} onClick={()=>seekKeyframe(index)} className={`w-full rounded-xl border p-3 text-left ${activeKeyframe===index?'border-amber-300/50 bg-amber-300/10':'border-white/10'}`}><span className="text-[10px] font-black text-amber-200">◆ {Math.round(kf.time*100)}%</span><span className="ml-2 text-[9px] text-slate-500">Z {kf.zoom.toFixed(2)} · X {kf.panX.toFixed(2)} · Y {kf.panY.toFixed(2)}</span></button>)}</div>{activeKeyframe!==null&&selectedClip.transformKeyframes?.[activeKeyframe]&&<div className="mt-4 rounded-2xl border border-amber-300/15 p-3"><div className="flex items-center justify-between"><p className="text-[10px] font-black">KEYFRAME {activeKeyframe+1}</p><button onClick={()=>deleteKeyframe(activeKeyframe)} className="text-rose-300"><Trash2 className="h-4 w-4"/></button></div><label className="mt-3 block text-[9px] text-slate-600">ZOOM<input type="range" min="1" max="4" step=".02" value={selectedClip.transformKeyframes[activeKeyframe].zoom} onChange={(e)=>updateKeyframe(activeKeyframe,{zoom:Number(e.target.value)})} className="mt-2 w-full accent-amber-300"/></label><div className="mt-2 grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">PAN X<input className={fieldClass()} type="number" min="-1" max="1" step=".02" value={selectedClip.transformKeyframes[activeKeyframe].panX} onChange={(e)=>updateKeyframe(activeKeyframe,{panX:clamp(Number(e.target.value),-1,1)})}/></label><label className="text-[9px] text-slate-600">PAN Y<input className={fieldClass()} type="number" min="-1" max="1" step=".02" value={selectedClip.transformKeyframes[activeKeyframe].panY} onChange={(e)=>updateKeyframe(activeKeyframe,{panY:clamp(Number(e.target.value),-1,1)})}/></label></div></div>}</>:<p className="mt-4 text-[10px] text-slate-600">حدد Clip لإضافة Keyframes.</p>}</>}
            {panel==='tools'&&<><p className="text-[10px] font-black tracking-widest text-slate-500">CLIP TOOLS</p>{selectedClip&&<div className="mt-4 space-y-3"><button onClick={()=>updateClip(selectedClip.id,{reverse:!selectedClip.reverse})} className={`w-full rounded-xl border p-3 text-[10px] font-black ${selectedClip.reverse?'border-violet-300/40 bg-violet-300/10':'border-white/10'}`}>REVERSE</button><label className="block text-[9px] text-slate-600">SPEED RAMP<select className={fieldClass()} value={selectedClip.speedRamp||'off'} onChange={(e)=>updateClip(selectedClip.id,{speedRamp:e.target.value as SpeedRampPreset})}>{speedRamps.map((item)=><option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="block text-[9px] text-slate-600">PRIVACY<select className={fieldClass()} value={selectedClip.privacyEffect||'none'} onChange={(e)=>updateClip(selectedClip.id,{privacyEffect:e.target.value as PrivacyEffect})}><option value="none">None</option><option value="blur">Blur</option><option value="mosaic">Mosaic</option></select></label><div className="grid grid-cols-3 gap-2"><button onClick={()=>updateClip(selectedClip.id,{fit:'cover',panXStart:-.55,panXEnd:-.55,zoomStart:1.18,zoomEnd:1.18})} className="rounded-xl border border-white/10 p-2 text-[9px]">Reframe L</button><button onClick={()=>updateClip(selectedClip.id,{fit:'cover',panXStart:0,panXEnd:0,zoomStart:1.18,zoomEnd:1.18})} className="rounded-xl border border-white/10 p-2 text-[9px]">Center</button><button onClick={()=>updateClip(selectedClip.id,{fit:'cover',panXStart:.55,panXEnd:.55,zoomStart:1.18,zoomEnd:1.18})} className="rounded-xl border border-white/10 p-2 text-[9px]">Reframe R</button></div></div>}</>}
          </aside>

          <div className="min-w-0 space-y-3">
            <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-black">PROGRAM MONITOR</p><p className="mt-1 text-[9px] text-slate-600">{fmt(projectTime)} {selectedVideo?.proxyUrl?'· PROXY PREVIEW':''}</p></div><button onClick={()=>setDirectMove(value=>!value)} disabled={!selectedClip} className={`rounded-xl border px-3 py-2 text-[9px] font-black disabled:opacity-30 ${directMove?'border-amber-300/40 bg-amber-300/10 text-amber-100':'border-white/10 text-slate-400'}`}><Move className="mr-1 inline h-3.5 w-3.5"/>DIRECT MOVE {activeKeyframe!==null?'◆':''}</button></div><div ref={monitorRef} className="relative mx-auto aspect-video overflow-hidden rounded-2xl border border-white/10 bg-black" onPointerDown={beginDirectMove} onPointerMove={moveDirect} onPointerUp={endDirect} onPointerCancel={endDirect}>{selectedVideo&&selectedClip?<><video ref={videoRef} src={selectedVideo.proxyUrl||selectedVideo.url} className="h-full w-full object-contain" style={{filter:previewCss,transform:`scale(${transform.zoom}) translate(${transform.panX*16}%,${transform.panY*16}%)`,transformOrigin:'center'}} onTimeUpdate={onTimeUpdate} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} playsInline/>{activePips.map((track)=>{const asset=videos[track.fileIndex];if(!asset)return null;return <div key={track.id} onPointerDown={(e)=>beginPipDrag(e,track)} onPointerMove={movePip} onPointerUp={endPip} onPointerCancel={endPip} className={`absolute cursor-move overflow-hidden border ${selection?.kind==='pip'&&selection.id===track.id?'border-emerald-300 ring-2 ring-emerald-300/20':'border-white/30'}`} style={{width:`${track.scale*100}%`,left:`${track.x*(1-track.scale)*100}%`,top:`${track.y*(1-track.scale)*100}%`,opacity:track.opacity,borderRadius:`${(track.borderRadius||0)*100}px`}}><video src={asset.proxyUrl||asset.url} muted={!track.audioEnabled} autoPlay={playing} loop playsInline className="block h-auto w-full"/><span className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1.5 py-1 text-[8px] font-black text-emerald-200">PiP</span></div>})}{activeImages.map((track)=>{const asset=images[track.fileIndex];return asset?<img key={track.id} src={asset.url} className="pointer-events-none absolute bottom-5 right-5 max-h-[35%] max-w-[35%] object-contain" style={{opacity:track.opacity}}/>:null})}{activeTitles.map((track)=><div key={track.id} className="pointer-events-none absolute inset-x-8 top-1/2 -translate-y-1/2 text-center font-black text-white"><span className="rounded-lg bg-black/45 px-3 py-1.5" style={{fontSize:clamp(track.size/2,16,54)}}>{track.text}</span></div>)}{activeSubs.map((track)=><div key={track.id} className="pointer-events-none absolute inset-x-8 bottom-[6%] text-center font-bold" style={{color:track.color,fontSize:clamp(track.size/2,14,40)}}><span className="rounded-md bg-black/55 px-3 py-1.5">{track.text}</span></div>)}</>:<div className="grid h-full place-items-center"><Film className="h-12 w-12 text-slate-800"/></div>}</div><div className="mt-3 flex flex-wrap items-center justify-center gap-2"><button onClick={togglePlay} disabled={!selectedClip} className="rounded-xl bg-white px-4 py-2 text-xs font-black text-black disabled:opacity-30">{playing?<Pause className="mr-1 inline h-4 w-4"/>:<Play className="mr-1 inline h-4 w-4"/>}{playing?'إيقاف':'تشغيل'}</button><button onClick={splitClip} disabled={!selectedClip} className="rounded-xl border border-cyan-300/20 px-4 py-2 text-xs font-black"><Scissors className="mr-1 inline h-4 w-4"/>Split</button><button onClick={addKeyframe} disabled={!selectedClip} className="rounded-xl border border-amber-300/20 px-4 py-2 text-xs font-black text-amber-100"><Zap className="mr-1 inline h-4 w-4"/>Keyframe</button><button onClick={deleteSelection} disabled={!selection} className="rounded-xl border border-rose-300/20 px-3 py-2 text-rose-200 disabled:opacity-30"><Trash2 className="h-4 w-4"/></button></div></div>

            <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-black">MAGNETIC MULTI-TRACK TIMELINE</p><p className="mt-1 text-[9px] text-slate-600">اسحب Music / PiP / Title / Subtitle / Image — يلتقط تلقائيًا حدود المقاطع</p></div><div className="flex items-center gap-2"><ZoomOut className="h-4 w-4 text-slate-600"/><input type="range" min="3" max="30" value={timelineZoom} onChange={(e)=>setTimelineZoom(Number(e.target.value))} className="w-28 accent-cyan-300"/><ZoomIn className="h-4 w-4 text-slate-600"/></div></div><div className="overflow-x-auto rounded-2xl border border-white/8 bg-black/20"><div className="relative" style={{width:timelineWidth}}><div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-red-400" style={{left:88+projectTime*timelineZoom}}/>{snapGuide!==null&&<div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-cyan-300 shadow-[0_0_14px_rgba(103,232,249,.8)]" style={{left:88+snapGuide*timelineZoom}}/>}{['VIDEO','PIP','TITLE','SUBTITLE','MUSIC','IMAGE'].map((label)=><div key={label} className="h-18 border-b border-white/5" style={{height:72}}><div className="sticky left-0 z-30 flex h-full w-[88px] items-center bg-[#080d17] px-2 text-[9px] font-black text-slate-600">{label}</div></div>)}<div className="absolute left-[88px] top-0 h-[72px]">{project.clips.map((clip,index)=>{const off=clipOffsets[index];if(!off)return null;return <button key={clip.id} onClick={()=>{setSelection({kind:'clip',id:clip.id});setActiveKeyframe(null);setProjectTime(off.start);setPreviewTime(clip.start)}} className={`absolute top-2 h-14 rounded-xl border px-3 text-left ${selection?.kind==='clip'&&selection.id===clip.id?'border-violet-200 bg-violet-400/20':'border-violet-300/15 bg-violet-400/10'}`} style={{left:off.start*timelineZoom,width:Math.max(82,off.duration*timelineZoom)}}><span className="text-[9px] font-black">CLIP {index+1}</span>{clip.reverse&&<span className="ml-2 text-[8px] text-violet-200">↔</span>}{(clip.transformKeyframes||[]).map((kf,kfIndex)=><span key={`${kf.time}-${kfIndex}`} onClick={(e)=>{e.stopPropagation();setSelection({kind:'clip',id:clip.id});setTimeout(()=>seekKeyframe(kfIndex),0)}} className="absolute bottom-1 -translate-x-1/2 cursor-pointer text-[10px] text-amber-300" style={{left:`${kf.time*100}%`}}>◆</span>)}</button>})}</div><div className="absolute left-[88px] top-[72px] h-[72px]">{project.videoOverlays.map((track)=><button key={track.id} onPointerDown={(e)=>beginTrackDrag(e,'pip',track.id)} onPointerMove={moveTrack} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} className="absolute top-2 h-14 touch-none rounded-xl border border-emerald-300/20 bg-emerald-400/10 px-3 text-[9px] font-black text-emerald-100" style={{left:track.startAt*timelineZoom,width:Math.max(78,(track.endAt-track.startAt)*timelineZoom)}}>PiP</button>)}</div><div className="absolute left-[88px] top-[144px] h-[72px]">{project.textTracks.map((track)=><button key={track.id} onPointerDown={(e)=>beginTrackDrag(e,'title',track.id)} onPointerMove={moveTrack} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} className="absolute top-2 h-14 touch-none rounded-xl border border-sky-300/15 bg-sky-400/10 px-3 text-[9px]" style={{left:track.startAt*timelineZoom,width:Math.max(74,(track.endAt-track.startAt)*timelineZoom)}}>{track.text}</button>)}</div><div className="absolute left-[88px] top-[216px] h-[72px]">{project.subtitleTracks.map((track)=><button key={track.id} onPointerDown={(e)=>beginTrackDrag(e,'subtitle',track.id)} onPointerMove={moveTrack} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} className="absolute top-2 h-14 touch-none rounded-xl border border-amber-300/15 bg-amber-400/10 px-3 text-[9px]" style={{left:track.startAt*timelineZoom,width:Math.max(74,(track.endAt-track.startAt)*timelineZoom)}}>{track.text}</button>)}</div><div className="absolute left-[88px] top-[288px] h-[72px]">{project.audioTracks.map((track)=>{const asset=audios[track.fileIndex];const duration=track.sourceEnd-track.sourceStart;return <button key={track.id} onPointerDown={(e)=>beginTrackDrag(e,'audio',track.id)} onPointerMove={moveTrack} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} className="absolute top-2 h-14 touch-none overflow-hidden rounded-xl border border-cyan-300/20 bg-cyan-400/10 text-left" style={{left:track.startAt*timelineZoom,width:Math.max(90,duration*timelineZoom)}}><span className="absolute left-2 top-1 z-10 text-[8px] font-black text-cyan-100">MUSIC</span><span className="absolute inset-x-1 bottom-1 top-4 flex items-center gap-[1px] opacity-80">{(asset?.waveform||[]).map((value,index)=><i key={index} className="block min-w-[1px] flex-1 rounded-full bg-cyan-200/70" style={{height:`${Math.max(8,value*100)}%`}}/>)}</span></button>})}</div><div className="absolute left-[88px] top-[360px] h-[72px]">{project.imageTracks.map((track)=><button key={track.id} onPointerDown={(e)=>beginTrackDrag(e,'image',track.id)} onPointerMove={moveTrack} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} className="absolute top-2 h-14 touch-none rounded-xl border border-fuchsia-300/15 bg-fuchsia-400/10 px-3 text-[9px]" style={{left:track.startAt*timelineZoom,width:Math.max(74,(track.endAt-track.startAt)*timelineZoom)}}>IMAGE</button>)}</div></div></div></div>

            {resultUrl&&<div className="rounded-3xl border border-emerald-300/15 bg-emerald-300/[.035] p-5"><div className="flex items-center justify-between"><p className="text-sm font-black text-emerald-100">اكتمل Render V7</p><Sparkles className="h-5 w-5 text-emerald-300"/></div><video controls src={resultUrl} className="mt-4 max-h-[520px] w-full rounded-2xl bg-black"/><a href={resultUrl} download="MAGHRABI-video-v7.mp4" className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-black text-black"><Download className="h-4 w-4"/>تنزيل الفيديو</a></div>}
          </div>

          <aside className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">INSPECTOR</p><p className="mt-1 text-xs font-black">{selection?.kind.toUpperCase()||'PROJECT'}</p></div><WandSparkles className="h-4 w-4 text-violet-300"/></div>{selectedClip&&selectedVideo&&<div className="mt-5 space-y-4"><div className="grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">START<input className={fieldClass()} type="number" step=".05" value={selectedClip.start} onChange={(e)=>updateClip(selectedClip.id,{start:clamp(Number(e.target.value),0,selectedClip.end-.05)})}/></label><label className="text-[9px] text-slate-600">END<input className={fieldClass()} type="number" step=".05" value={selectedClip.end} onChange={(e)=>updateClip(selectedClip.id,{end:clamp(Number(e.target.value),selectedClip.start+.05,selectedVideo.duration)})}/></label></div><div className="grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">SPEED<input className={fieldClass()} type="number" min=".25" max="4" step=".05" value={selectedClip.speed} onChange={(e)=>updateClip(selectedClip.id,{speed:clamp(Number(e.target.value),.25,4)})}/></label><label className="text-[9px] text-slate-600">VOLUME<input className={fieldClass()} type="number" min="0" max="2" step=".05" value={selectedClip.volume} onChange={(e)=>updateClip(selectedClip.id,{volume:clamp(Number(e.target.value),0,2)})}/></label></div><div className="rounded-xl border border-amber-300/10 p-3"><p className="text-[9px] font-black text-amber-200">MOTION STATUS</p><p className="mt-2 text-[9px] text-slate-500">Keyframes: {(selectedClip.transformKeyframes||[]).length} · Current Z {transform.zoom.toFixed(2)} · X {transform.panX.toFixed(2)} · Y {transform.panY.toFixed(2)}</p></div></div>}{selectedPip&&<div className="mt-5 space-y-3"><label className="text-[9px] text-slate-600">PIP SCALE<input className={fieldClass()} type="number" min=".08" max=".85" step=".02" value={selectedPip.scale} onChange={(e)=>updatePip(selectedPip.id,{scale:clamp(Number(e.target.value),.08,.85)})}/></label><label className="text-[9px] text-slate-600">OPACITY<input className={fieldClass()} type="number" min="0" max="1" step=".05" value={selectedPip.opacity} onChange={(e)=>updatePip(selectedPip.id,{opacity:clamp(Number(e.target.value),0,1)})}/></label></div>}{selectedTitle&&<label className="mt-5 block text-[9px] text-slate-600">TITLE<input className={fieldClass()} value={selectedTitle.text} onChange={(e)=>updateTitle(selectedTitle.id,{text:e.target.value})}/></label>}{selectedSubtitle&&<label className="mt-5 block text-[9px] text-slate-600">SUBTITLE<input className={fieldClass()} value={selectedSubtitle.text} onChange={(e)=>updateSubtitle(selectedSubtitle.id,{text:e.target.value})}/></label>}{selectedImage&&<label className="mt-5 block text-[9px] text-slate-600">IMAGE OPACITY<input className={fieldClass()} type="number" min="0" max="1" step=".05" value={selectedImage.opacity} onChange={(e)=>updateImage(selectedImage.id,{opacity:clamp(Number(e.target.value),0,1)})}/></label>}{error&&<div className="mt-5 rounded-xl border border-rose-300/20 bg-rose-400/10 p-3 text-[10px] leading-5 text-rose-200">{error}</div>}</aside>
        </section>
      </div>
    </main>
  )
}
