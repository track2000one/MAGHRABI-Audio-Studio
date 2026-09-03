import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Captions,
  Download,
  Film,
  Image as ImageIcon,
  Layers3,
  Lock,
  Magnet,
  MapPin,
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
  Unlock,
  UploadCloud,
  Video,
  Volume2,
  VolumeX,
  WandSparkles,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import {
  AudioTrackManifest,
  createVideoProxy,
  getVideoWaveform,
  ImageTrackManifest,
  OutputSize,
  PrivacyEffect,
  RenderQuality,
  renderVideoProjectV8,
  SpeedRampPreset,
  SubtitleTrackManifest,
  TextTrackManifest,
  TransformEasing,
  TransformKeyframe,
  VideoClipManifest,
  VideoFilter,
  VideoOverlayTrackManifest,
  VideoTransition,
} from './lib/videoApi'
import { loadStoredVideoProject, saveStoredVideoProject } from './lib/projectStore'

type VideoAsset = { file: File; url: string; duration: number; waveform: number[]; waveformBusy?: boolean; proxyUrl?: string }
type AudioAsset = { file: File; duration: number; waveform: number[] }
type ImageAsset = { file: File; url: string }
type Clip = VideoClipManifest & { id: string }
type TitleTrack = TextTrackManifest & { id: string }
type SubtitleTrack = SubtitleTrackManifest & { id: string }
type AudioTrack = AudioTrackManifest & { id: string }
type ImageTrack = ImageTrackManifest & { id: string }
type PipTrack = VideoOverlayTrackManifest & { id: string }
type Selection = { kind: 'clip' | 'title' | 'subtitle' | 'audio' | 'image' | 'pip'; id: string } | null
type Panel = 'media' | 'edit' | 'motion' | 'audio' | 'color' | 'markers'
type DragKind = 'title' | 'subtitle' | 'audio' | 'image' | 'pip'
type TrackKey = 'video' | 'pip' | 'title' | 'subtitle' | 'music' | 'image'
type EditMode = 'ripple' | 'roll'
type Marker = { id: string; time: number; label: string }
type TrackControl = { locked: boolean; muted: boolean; solo: boolean }

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
  editMode: EditMode
  markers: Marker[]
  trackControls: Record<TrackKey, TrackControl>
}

const defaultTrackControls: Record<TrackKey, TrackControl> = {
  video: { locked: false, muted: false, solo: false },
  pip: { locked: false, muted: false, solo: false },
  title: { locked: false, muted: false, solo: false },
  subtitle: { locked: false, muted: false, solo: false },
  music: { locked: false, muted: false, solo: false },
  image: { locked: false, muted: false, solo: false },
}
const initialProject: ProjectState = {
  clips: [], textTracks: [], subtitleTracks: [], audioTracks: [], imageTracks: [], videoOverlays: [],
  transition: 'fade', transitionDuration: .45, audioDuckingEnabled: false, duckingStrength: .65, magneticSnap: true,
  editMode: 'ripple', markers: [], trackControls: defaultTrackControls,
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
const easings: Array<{ value: TransformEasing; label: string }> = [
  { value: 'linear', label: 'Linear' }, { value: 'ease-in', label: 'Ease In' }, { value: 'ease-out', label: 'Ease Out' },
  { value: 'ease-in-out', label: 'Ease In-Out' }, { value: 'hold', label: 'Hold / Step' },
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
    element.onloadedmetadata = () => { const d = Number.isFinite(element.duration) ? element.duration : 0; URL.revokeObjectURL(url); resolve(d) }
    element.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`تعذر قراءة ${file.name}`)) }
    element.src = url
  })
}
async function audioWaveform(file: File, bars = 140) {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return []
    const context = new Ctx()
    const buffer = await context.decodeAudioData((await file.arrayBuffer()).slice(0))
    const channel = buffer.getChannelData(0)
    const size = Math.max(1, Math.floor(channel.length / bars))
    const values = Array.from({ length: bars }, (_, index) => {
      let peak = 0
      const start = index * size, end = Math.min(channel.length, start + size)
      for (let i = start; i < end; i += Math.max(1, Math.floor(size / 80))) peak = Math.max(peak, Math.abs(channel[i]))
      return peak
    })
    await context.close()
    const maximum = Math.max(.001, ...values)
    return values.map((value) => value / maximum)
  } catch { return [] }
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
function easeValue(kind: TransformEasing | undefined, value: number) {
  const t = clamp(value, 0, 1)
  if (kind === 'ease-in') return t * t
  if (kind === 'ease-out') return 1 - (1 - t) * (1 - t)
  if (kind === 'ease-in-out') return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
  if (kind === 'hold') return 0
  return t
}
function syntheticKeyframes(clip: Clip): TransformKeyframe[] {
  const list = [...(clip.transformKeyframes || [])].sort((a, b) => a.time - b.time)
  if (!list.length) return [
    { time: 0, zoom: clip.zoomStart || 1, panX: clip.panXStart || 0, panY: clip.panYStart || 0, easing: 'linear' },
    { time: 1, zoom: clip.zoomEnd || 1, panX: clip.panXEnd || 0, panY: clip.panYEnd || 0, easing: 'linear' },
  ]
  if (list[0].time > .0005) list.unshift({ time: 0, zoom: clip.zoomStart || 1, panX: clip.panXStart || 0, panY: clip.panYStart || 0, easing: 'linear' })
  if (list[list.length - 1].time < .9995) list.push({ time: 1, zoom: clip.zoomEnd || 1, panX: clip.panXEnd || 0, panY: clip.panYEnd || 0, easing: 'linear' })
  return list
}
function transformAt(clip: Clip, progress: number) {
  const points = syntheticKeyframes(clip), p = clamp(progress, 0, 1)
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index], b = points[index + 1]
    if (p <= b.time || index === points.length - 2) {
      const span = Math.max(.0001, b.time - a.time)
      const t = easeValue(a.easing, clamp((p - a.time) / span, 0, 1))
      return { zoom: a.zoom + (b.zoom - a.zoom) * t, panX: a.panX + (b.panX - a.panX) * t, panY: a.panY + (b.panY - a.panY) * t }
    }
  }
  return points[points.length - 1]
}

export default function VideoStudioV8() {
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
  const [timelineZoom, setTimelineZoom] = useState(10)
  const [snapGuide, setSnapGuide] = useState<number | null>(null)
  const [dragState, setDragState] = useState<{ kind: DragKind; id: string; x: number; start: number; duration: number } | null>(null)
  const [trimState, setTrimState] = useState<{ id: string; index: number; edge: 'left' | 'right'; x: number; start: number; end: number } | null>(null)
  const [slipState, setSlipState] = useState<{ id: string; x: number; start: number; end: number; fileIndex: number } | null>(null)
  const [slipMode, setSlipMode] = useState(false)
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
      const duration = clipDuration(clip), start = cursor
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
  const updateTrackControl = (key: TrackKey, changes: Partial<TrackControl>) => setProject((state) => ({ ...state, trackControls: { ...state.trackControls, [key]: { ...state.trackControls[key], ...changes } } }))

  const makeClip = (fileIndex: number, duration: number): Clip => ({
    id: uid(), fileIndex, start: 0, end: duration, speed: 1, volume: 1, filter: 'none', text: '', textSize: 48,
    textPosition: 'bottom', rotation: 0, fit: 'contain', zoomStart: 1, zoomEnd: 1, panXStart: 0, panXEnd: 0,
    panYStart: 0, panYEnd: 0, chromaEnabled: false, chromaColor: '#00ff00', chromaBackground: '#101010',
    chromaSimilarity: .18, chromaBlend: .06, brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0,
    speedRamp: 'off', reverse: false, freezeFrame: false, freezeDuration: 2, privacyEffect: 'none', privacyX: .35,
    privacyY: .3, privacyWidth: .3, privacyHeight: .22, privacyIntensity: .55, transformKeyframes: [], audioLead: 0, audioTail: 0,
  })

  const analyzeVideoWaveform = (file: File, fileIndex: number) => {
    setVideos((state) => state.map((item, index) => index === fileIndex ? { ...item, waveformBusy: true } : item))
    getVideoWaveform(file, 180).then((result) => {
      setVideos((state) => state.map((item, index) => index === fileIndex ? { ...item, waveform: result.peaks, waveformBusy: false } : item))
    }).catch(() => setVideos((state) => state.map((item, index) => index === fileIndex ? { ...item, waveformBusy: false } : item)))
  }
  const addVideoFiles = async (files: File[]) => {
    const limited = files.slice(0, Math.max(0, 10 - videos.length)); if (!limited.length) return
    const durations = await Promise.all(limited.map((file) => mediaDuration(file, 'video')))
    const base = videos.length
    const assets = limited.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: durations[index], waveform: [] as number[] }))
    const clips = assets.map((asset, index) => makeClip(base + index, asset.duration))
    setVideos((state) => [...state, ...assets]); setProject((state) => ({ ...state, clips: [...state.clips, ...clips] }))
    limited.forEach((file, index) => window.setTimeout(() => analyzeVideoWaveform(file, base + index), index * 120))
    if (clips[0]) { setSelection({ kind: 'clip', id: clips[0].id }); setActiveKeyframe(null) }
  }
  const onVideoInput = async (event: ChangeEvent<HTMLInputElement>) => {
    try { await addVideoFiles(Array.from(event.target.files || [])); setError(null) } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الفيديو.') }
    event.target.value = ''
  }
  const addAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    try {
      const duration = await mediaDuration(file, 'audio'), waveform = await audioWaveform(file), fileIndex = audios.length
      setAudios((state) => [...state, { file, duration, waveform }])
      const track: AudioTrack = { id: uid(), fileIndex, startAt: projectTime, sourceStart: 0, sourceEnd: duration, volume: .65, fadeIn: .25, fadeOut: .45 }
      setProject((state) => ({ ...state, audioTracks: [...state.audioTracks, track] })); setSelection({ kind: 'audio', id: track.id })
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الصوت.') }
    event.target.value = ''
  }
  const addPip = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    try {
      if (videos.length >= 10) throw new Error('وصلت للحد الأعلى من ملفات الفيديو.')
      const duration = await mediaDuration(file, 'video'), fileIndex = videos.length
      setVideos((state) => [...state, { file, url: URL.createObjectURL(file), duration, waveform: [] }])
      const length = Math.min(duration, 6)
      const track: PipTrack = { id: uid(), fileIndex, startAt: projectTime, endAt: projectTime + length, sourceStart: 0, sourceEnd: length, scale: .3, opacity: 1, x: .68, y: .62, borderRadius: .08, audioEnabled: false, audioVolume: .85 }
      setProject((state) => ({ ...state, videoOverlays: [...state.videoOverlays, track] })); setSelection({ kind: 'pip', id: track.id })
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
  const addTitle = () => { const track: TitleTrack = { id: uid(), text: 'عنوان جديد', startAt: projectTime, endAt: projectTime + 4, size: 56, position: 'center' }; setProject((state) => ({ ...state, textTracks: [...state.textTracks, track] })); setSelection({ kind: 'title', id: track.id }) }
  const addSubtitle = () => { const track: SubtitleTrack = { id: uid(), text: 'اكتب الترجمة هنا', startAt: projectTime, endAt: projectTime + 2.5, size: 38, position: 'bottom', color: '#ffffff', boxOpacity: .48 }; setProject((state) => ({ ...state, subtitleTracks: [...state.subtitleTracks, track] })); setSelection({ kind: 'subtitle', id: track.id }) }

  useEffect(() => {
    const video = videoRef.current
    if (!video || !selectedClip || !selectedVideo) return
    video.pause(); setPlaying(false)
    const seek = () => { try { video.currentTime = clamp(previewTime || selectedClip.start, selectedClip.start, selectedClip.end); video.playbackRate = selectedClip.speed; video.volume = clamp(selectedClip.volume, 0, 1) } catch {} }
    if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true })
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [selection?.id, selectedVideo?.proxyUrl, selectedVideo?.url])

  const togglePlay = async () => {
    const video = videoRef.current; if (!video || !selectedClip) return
    if (video.paused) { if (video.currentTime < selectedClip.start || video.currentTime >= selectedClip.end) video.currentTime = selectedClip.start; video.playbackRate = selectedClip.speed; await video.play().catch(() => undefined) } else video.pause()
  }
  const onTimeUpdate = () => {
    const video = videoRef.current; if (!video || !selectedClip || selectedClipIndex < 0) return
    const sourceTime = video.currentTime; setPreviewTime(sourceTime)
    const local = Math.max(0, (sourceTime - selectedClip.start) / Math.max(.25, selectedClip.speed)); setProjectTime((clipOffsets[selectedClipIndex]?.start || 0) + local)
    if (sourceTime >= selectedClip.end - .015) { video.pause(); video.currentTime = selectedClip.start }
  }
  const splitClip = () => {
    if (!selectedClip || project.trackControls.video.locked) return
    const at = clamp(previewTime, selectedClip.start, selectedClip.end)
    if (at - selectedClip.start < .12 || selectedClip.end - at < .12) { setError('حرّك المؤشر داخل المقطع ثم نفذ Split.'); return }
    const sourceSpan = selectedClip.end - selectedClip.start, splitProgress = (at - selectedClip.start) / sourceSpan
    const leftK = (selectedClip.transformKeyframes || []).filter((kf) => kf.time <= splitProgress).map((kf) => ({ ...kf, time: splitProgress > 0 ? kf.time / splitProgress : 0 }))
    const rightK = (selectedClip.transformKeyframes || []).filter((kf) => kf.time >= splitProgress).map((kf) => ({ ...kf, time: splitProgress < 1 ? (kf.time - splitProgress) / (1 - splitProgress) : 1 }))
    const left: Clip = { ...selectedClip, id: uid(), end: at, transformKeyframes: leftK }, right: Clip = { ...selectedClip, id: uid(), start: at, transformKeyframes: rightK }
    setProject((state) => ({ ...state, clips: state.clips.flatMap((item) => item.id === selectedClip.id ? [left, right] : [item]) }))
    setSelection({ kind: 'clip', id: right.id }); setActiveKeyframe(null); setError(null)
  }
  const deleteSelection = () => {
    if (!selection) return
    const locked = selection.kind === 'clip' ? project.trackControls.video.locked : project.trackControls[selection.kind === 'audio' ? 'music' : selection.kind].locked
    if (locked) return
    setProject((state) => ({ ...state,
      clips: selection.kind === 'clip' ? state.clips.filter((item) => item.id !== selection.id) : state.clips,
      textTracks: selection.kind === 'title' ? state.textTracks.filter((item) => item.id !== selection.id) : state.textTracks,
      subtitleTracks: selection.kind === 'subtitle' ? state.subtitleTracks.filter((item) => item.id !== selection.id) : state.subtitleTracks,
      audioTracks: selection.kind === 'audio' ? state.audioTracks.filter((item) => item.id !== selection.id) : state.audioTracks,
      imageTracks: selection.kind === 'image' ? state.imageTracks.filter((item) => item.id !== selection.id) : state.imageTracks,
      videoOverlays: selection.kind === 'pip' ? state.videoOverlays.filter((item) => item.id !== selection.id) : state.videoOverlays,
    })); setSelection(null); setActiveKeyframe(null)
  }

  const beginTrim = (event: ReactPointerEvent<HTMLSpanElement>, clip: Clip, index: number, edge: 'left' | 'right') => {
    if (project.trackControls.video.locked) return
    event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
    setSelection({ kind: 'clip', id: clip.id }); setTrimState({ id: clip.id, index, edge, x: event.clientX, start: clip.start, end: clip.end })
  }
  const moveTrim = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!trimState) return
    const clip = project.clips[trimState.index]; if (!clip) return
    const deltaTimeline = (event.clientX - trimState.x) / timelineZoom, deltaSource = deltaTimeline * Math.max(.25, clip.speed)
    setProject((state) => {
      const clips = state.clips.map((item) => ({ ...item }))
      const current = clips[trimState.index]; if (!current) return state
      if (trimState.edge === 'right') {
        const duration = videos[current.fileIndex]?.duration || current.end
        const nextEnd = clamp(trimState.end + deltaSource, trimState.start + .08, duration)
        if (state.editMode === 'roll' && clips[trimState.index + 1]) {
          const next = clips[trimState.index + 1], timelineDelta = (nextEnd - trimState.end) / Math.max(.25, current.speed)
          const nextStart = clamp(next.start + timelineDelta * Math.max(.25, next.speed), 0, next.end - .08)
          next.start = nextStart
        }
        current.end = nextEnd
      } else {
        const nextStart = clamp(trimState.start + deltaSource, 0, trimState.end - .08)
        if (state.editMode === 'roll' && clips[trimState.index - 1]) {
          const prev = clips[trimState.index - 1], timelineDelta = (nextStart - trimState.start) / Math.max(.25, current.speed)
          const prevDuration = videos[prev.fileIndex]?.duration || prev.end
          prev.end = clamp(prev.end + timelineDelta * Math.max(.25, prev.speed), prev.start + .08, prevDuration)
        }
        current.start = nextStart
      }
      return { ...state, clips }
    })
  }
  const endTrim = () => setTrimState(null)

  const beginSlip = (event: ReactPointerEvent<HTMLButtonElement>, clip: Clip) => {
    if ((!slipMode && !event.altKey) || project.trackControls.video.locked) return false
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    setSlipState({ id: clip.id, x: event.clientX, start: clip.start, end: clip.end, fileIndex: clip.fileIndex }); setSelection({ kind: 'clip', id: clip.id }); return true
  }
  const moveSlip = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!slipState) return
    const clip = project.clips.find((item) => item.id === slipState.id); if (!clip) return
    const sourceDuration = videos[slipState.fileIndex]?.duration || slipState.end, length = slipState.end - slipState.start
    const delta = ((event.clientX - slipState.x) / timelineZoom) * Math.max(.25, clip.speed)
    const start = clamp(slipState.start + delta, 0, Math.max(0, sourceDuration - length))
    updateClip(slipState.id, { start, end: start + length })
  }
  const endSlip = () => setSlipState(null)

  const addKeyframe = () => {
    if (!selectedClip || project.trackControls.video.locked) return
    const progress = clamp((previewTime - selectedClip.start) / Math.max(.001, selectedClip.end - selectedClip.start), 0, 1), current = transformAt(selectedClip, progress)
    let list = [...(selectedClip.transformKeyframes || [])]
    if (!list.length) list = [
      { time: 0, zoom: selectedClip.zoomStart || 1, panX: selectedClip.panXStart || 0, panY: selectedClip.panYStart || 0, easing: 'linear' },
      { time: 1, zoom: selectedClip.zoomEnd || 1, panX: selectedClip.panXEnd || 0, panY: selectedClip.panYEnd || 0, easing: 'linear' },
    ]
    const existing = list.findIndex((item) => Math.abs(item.time - progress) < .012); if (existing >= 0) { setActiveKeyframe(existing); return }
    if (list.length >= 20) { setError('الحد الأعلى 20 Keyframes داخل المقطع.'); return }
    list.push({ time: progress, zoom: current.zoom, panX: current.panX, panY: current.panY, easing: 'ease-in-out' }); list.sort((a, b) => a.time - b.time)
    updateClip(selectedClip.id, { transformKeyframes: list }); setActiveKeyframe(list.findIndex((item) => Math.abs(item.time - progress) < .0005))
  }
  const updateKeyframe = (index: number, changes: Partial<TransformKeyframe>) => { if (!selectedClip) return; const list = [...(selectedClip.transformKeyframes || [])]; if (!list[index]) return; list[index] = { ...list[index], ...changes }; updateClip(selectedClip.id, { transformKeyframes: list }) }
  const deleteKeyframe = (index: number) => { if (!selectedClip) return; updateClip(selectedClip.id, { transformKeyframes: (selectedClip.transformKeyframes || []).filter((_, i) => i !== index) }); setActiveKeyframe(null) }
  const seekKeyframe = (index: number) => { if (!selectedClip) return; const kf = selectedClip.transformKeyframes?.[index]; if (!kf) return; const source = selectedClip.start + (selectedClip.end - selectedClip.start) * kf.time; setActiveKeyframe(index); setPreviewTime(source); if (videoRef.current) videoRef.current.currentTime = source }

  const beginDirectMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!directMove || !selectedClip || project.trackControls.video.locked) return
    const t = activeKeyframe !== null && selectedClip.transformKeyframes?.[activeKeyframe] ? selectedClip.transformKeyframes[activeKeyframe] : transformAt(selectedClip, clamp((previewTime-selectedClip.start)/Math.max(.001,selectedClip.end-selectedClip.start),0,1))
    event.currentTarget.setPointerCapture(event.pointerId); setMoveStart({ x: event.clientX, y: event.clientY, panX: t.panX, panY: t.panY })
  }
  const moveDirect = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!moveStart || !selectedClip || !monitorRef.current) return
    const rect = monitorRef.current.getBoundingClientRect(), panX = clamp(moveStart.panX + ((event.clientX-moveStart.x)/rect.width)*2,-1,1), panY = clamp(moveStart.panY + ((event.clientY-moveStart.y)/rect.height)*2,-1,1)
    if (activeKeyframe !== null && selectedClip.transformKeyframes?.[activeKeyframe]) updateKeyframe(activeKeyframe,{panX,panY}); else updateClip(selectedClip.id,{panXStart:panX,panXEnd:panX,panYStart:panY,panYEnd:panY})
  }
  const endDirect = () => setMoveStart(null)

  const boundaries = useMemo(() => [0, projectTime, ...project.markers.map((item) => item.time), ...clipOffsets.flatMap((item) => [item.start, item.end])], [clipOffsets, project.markers, projectTime])
  const snapTrackStart = (start: number, duration: number) => {
    if (!project.magneticSnap) return { start: Math.max(0,start), guide: null as number | null }
    const threshold = Math.max(.06, 9/Math.max(3,timelineZoom)); let best = Math.max(0,start), guide: number | null = null, distance = Infinity
    for (const candidate of boundaries) {
      const a = Math.abs(start-candidate); if (a<distance&&a<=threshold){best=candidate;guide=candidate;distance=a}
      const b = Math.abs(start+duration-candidate); if (b<distance&&b<=threshold){best=Math.max(0,candidate-duration);guide=candidate;distance=b}
    }
    return { start: best, guide }
  }
  const trackKeyForKind = (kind: DragKind): TrackKey => kind === 'audio' ? 'music' : kind
  const trackDuration = (kind: DragKind,id:string) => kind==='audio' ? ((project.audioTracks.find(x=>x.id===id)?.sourceEnd||0)-(project.audioTracks.find(x=>x.id===id)?.sourceStart||0)) : kind==='pip' ? ((project.videoOverlays.find(x=>x.id===id)?.endAt||0)-(project.videoOverlays.find(x=>x.id===id)?.startAt||0)) : kind==='title' ? ((project.textTracks.find(x=>x.id===id)?.endAt||0)-(project.textTracks.find(x=>x.id===id)?.startAt||0)) : kind==='subtitle' ? ((project.subtitleTracks.find(x=>x.id===id)?.endAt||0)-(project.subtitleTracks.find(x=>x.id===id)?.startAt||0)) : ((project.imageTracks.find(x=>x.id===id)?.endAt||0)-(project.imageTracks.find(x=>x.id===id)?.startAt||0))
  const trackStart = (kind: DragKind,id:string) => kind==='audio' ? project.audioTracks.find(x=>x.id===id)?.startAt||0 : kind==='pip' ? project.videoOverlays.find(x=>x.id===id)?.startAt||0 : kind==='title' ? project.textTracks.find(x=>x.id===id)?.startAt||0 : kind==='subtitle' ? project.subtitleTracks.find(x=>x.id===id)?.startAt||0 : project.imageTracks.find(x=>x.id===id)?.startAt||0
  const applyTrackStart = (kind:DragKind,id:string,start:number,duration:number) => { if(kind==='audio')updateAudio(id,{startAt:start}); else if(kind==='pip')updatePip(id,{startAt:start,endAt:start+duration}); else if(kind==='title')updateTitle(id,{startAt:start,endAt:start+duration}); else if(kind==='subtitle')updateSubtitle(id,{startAt:start,endAt:start+duration}); else updateImage(id,{startAt:start,endAt:start+duration}) }
  const beginTrackDrag = (event:ReactPointerEvent<HTMLButtonElement>,kind:DragKind,id:string) => { if(project.trackControls[trackKeyForKind(kind)].locked)return; event.currentTarget.setPointerCapture(event.pointerId); setDragState({kind,id,x:event.clientX,start:trackStart(kind,id),duration:trackDuration(kind,id)}); setSelection({kind,id} as Selection) }
  const moveTrack = (event:ReactPointerEvent<HTMLButtonElement>) => { if(!dragState)return; const raw=dragState.start+(event.clientX-dragState.x)/timelineZoom, snapped=snapTrackStart(raw,dragState.duration); applyTrackStart(dragState.kind,dragState.id,snapped.start,dragState.duration); setSnapGuide(snapped.guide) }
  const endTrackDrag = () => { setDragState(null); setSnapGuide(null) }

  const beginPipDrag = (event:ReactPointerEvent<HTMLDivElement>,track:PipTrack) => { if(project.trackControls.pip.locked)return; event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);setPipDrag({id:track.id,x:event.clientX,y:event.clientY,px:track.x,py:track.y,scale:track.scale});setSelection({kind:'pip',id:track.id}) }
  const movePip = (event:ReactPointerEvent<HTMLDivElement>) => { if(!pipDrag||!monitorRef.current)return;const rect=monitorRef.current.getBoundingClientRect();updatePip(pipDrag.id,{x:clamp(pipDrag.px+(event.clientX-pipDrag.x)/Math.max(40,rect.width*(1-pipDrag.scale)),0,1),y:clamp(pipDrag.py+(event.clientY-pipDrag.y)/Math.max(40,rect.height*(1-pipDrag.scale)),0,1)}) }
  const endPip = () => setPipDrag(null)

  const addMarker = () => setProject((state) => ({ ...state, markers: [...state.markers, { id: uid(), time: clamp(projectTime,0,Math.max(projectDuration,projectTime)), label: `Marker ${state.markers.length+1}` }].sort((a,b)=>a.time-b.time) }))
  const updateMarker = (id:string,changes:Partial<Marker>) => setProject((state)=>({...state,markers:state.markers.map((item)=>item.id===id?{...item,...changes}:item).sort((a,b)=>a.time-b.time)}))
  const deleteMarker = (id:string) => setProject((state)=>({...state,markers:state.markers.filter((item)=>item.id!==id)}))

  const createProxyForSelected = async () => { if(!selectedClip||!selectedVideo||selectedVideo.proxyUrl)return;setProxyBusy(true);setError(null);try{const blob=await createVideoProxy(selectedVideo.file),proxyUrl=URL.createObjectURL(blob);setVideos((state)=>state.map((item,index)=>index===selectedClip.fileIndex?{...item,proxyUrl}:item))}catch(e){setError(e instanceof Error?e.message:'تعذر إنشاء Proxy.')}finally{setProxyBusy(false)} }
  const removeProxy = () => { if(!selectedClip||!selectedVideo?.proxyUrl)return;URL.revokeObjectURL(selectedVideo.proxyUrl);setVideos((state)=>state.map((item,index)=>index===selectedClip.fileIndex?{...item,proxyUrl:undefined}:item)) }

  const saveProject = async () => { try { await saveStoredVideoProject<ProjectState>({version:3,savedAt:new Date().toISOString(),project,videos:videos.map(x=>x.file),videoDurations:videos.map(x=>x.duration),audios:audios.map(x=>x.file),audioDurations:audios.map(x=>x.duration),images:images.map(x=>x.file),outputSize,quality});setError(null) } catch(e){setError(e instanceof Error?e.message:'تعذر حفظ المشروع.')} }
  const restoreProject = async () => {
    try {
      const snap=await loadStoredVideoProject<ProjectState>();if(!snap){setError('لا يوجد مشروع محفوظ.');return}
      const videoAssets=snap.videos.map((file,index)=>({file,url:URL.createObjectURL(file),duration:snap.videoDurations[index]||0,waveform:[] as number[]}))
      const audioAssets=await Promise.all(snap.audios.map(async(file,index)=>({file,duration:snap.audioDurations[index]||0,waveform:await audioWaveform(file)})))
      setVideos(videoAssets);setAudios(audioAssets);setImages(snap.images.map(file=>({file,url:URL.createObjectURL(file)})))
      const controls={...defaultTrackControls,...(snap.project.trackControls||{})}
      const restored={...initialProject,...snap.project,trackControls:controls,markers:snap.project.markers||[],editMode:snap.project.editMode||'ripple'}
      setProject(restored);setOutputSize(snap.outputSize as OutputSize);setQuality(snap.quality as RenderQuality);setSelection(restored.clips[0]?{kind:'clip',id:restored.clips[0].id}:null);setActiveKeyframe(null);setLutFile(null);setError(null)
      snap.videos.forEach((file,index)=>window.setTimeout(()=>analyzeVideoWaveform(file,index),index*120))
    } catch(e){setError(e instanceof Error?e.message:'تعذر استعادة المشروع.')}
  }
  const isTrackActive = (key:TrackKey) => { const solo=(Object.keys(project.trackControls) as TrackKey[]).filter(k=>project.trackControls[k].solo); return solo.length ? solo.includes(key) : !project.trackControls[key].muted }
  const exportProject = async () => {
    if(!project.clips.length)return;setBusy(true);setError(null);if(resultUrl)URL.revokeObjectURL(resultUrl);setResultUrl(null)
    try{
      const videoActive=isTrackActive('video')
      const blob=await renderVideoProjectV8(videos.map(x=>x.file),audios.map(x=>x.file),images.map(x=>x.file),{
        clips:project.clips.map(({id:_id,...clip})=>({...clip,volume:videoActive?clip.volume:0,audioLead:videoActive?(clip.audioLead||0):0,audioTail:videoActive?(clip.audioTail||0):0})),
        textTracks:isTrackActive('title')?project.textTracks.map(({id:_id,...x})=>x):[],subtitleTracks:isTrackActive('subtitle')?project.subtitleTracks.map(({id:_id,...x})=>x):[],
        audioTracks:isTrackActive('music')?project.audioTracks.map(({id:_id,...x})=>x):[],imageTracks:isTrackActive('image')?project.imageTracks.map(({id:_id,...x})=>x):[],
        videoOverlays:isTrackActive('pip')?project.videoOverlays.map(({id:_id,...x})=>x):[],transition:project.transition,transitionDuration:project.transitionDuration,
        audioDuckingEnabled:project.audioDuckingEnabled,duckingStrength:project.duckingStrength,magneticSnap:project.magneticSnap,
      },outputSize,quality,lutFile);setResultUrl(URL.createObjectURL(blob))
    }catch(e){setError(e instanceof Error?e.message:'تعذر تصدير V8.')}finally{setBusy(false)}
  }

  const progress=selectedClip?clamp((previewTime-selectedClip.start)/Math.max(.001,selectedClip.end-selectedClip.start),0,1):0, transform=selectedClip?transformAt(selectedClip,progress):{zoom:1,panX:0,panY:0}
  const activeTitles=project.textTracks.filter(x=>isTrackActive('title')&&projectTime>=x.startAt&&projectTime<=x.endAt), activeSubs=project.subtitleTracks.filter(x=>isTrackActive('subtitle')&&projectTime>=x.startAt&&projectTime<=x.endAt), activeImages=project.imageTracks.filter(x=>isTrackActive('image')&&projectTime>=x.startAt&&projectTime<=x.endAt), activePips=project.videoOverlays.filter(x=>isTrackActive('pip')&&projectTime>=x.startAt&&projectTime<=x.endAt)
  const previewBase=selectedClip?.filter==='warm'?'sepia(.10)':selectedClip?.filter==='cool'?'hue-rotate(8deg)':selectedClip?.filter==='mono'?'grayscale(1)':'', previewCss=selectedClip?`${previewBase} brightness(${1+(selectedClip.brightness||0)}) contrast(${selectedClip.contrast||1}) saturate(${selectedClip.saturation||1})`:'none'
  const timelineWidth=Math.max(1150,projectDuration*timelineZoom+165)

  const TrackHeader=({track,label}:{track:TrackKey;label:string}) => {
    const control=project.trackControls[track]
    return <div className="sticky left-0 z-30 flex h-full w-[112px] items-center gap-1 bg-[#080d17] px-2"><span className="mr-auto text-[8px] font-black text-slate-500">{label}</span><button title="Lock" onClick={()=>updateTrackControl(track,{locked:!control.locked})} className={control.locked?'text-amber-300':'text-slate-700'}>{control.locked?<Lock className="h-3 w-3"/>:<Unlock className="h-3 w-3"/>}</button><button title="Mute" onClick={()=>updateTrackControl(track,{muted:!control.muted})} className={control.muted?'text-rose-300':'text-slate-700'}>{control.muted?<VolumeX className="h-3 w-3"/>:<Volume2 className="h-3 w-3"/>}</button><button title="Solo" onClick={()=>updateTrackControl(track,{solo:!control.solo})} className={`text-[8px] font-black ${control.solo?'text-emerald-300':'text-slate-700'}`}>S</button></div>
  }

  if(authorized===null)return <div className="grid min-h-screen place-items-center bg-[#050710]"><Activity className="h-7 w-7 animate-spin text-cyan-300"/></div>
  if(!authorized)return <div className="grid min-h-screen place-items-center bg-[#050710] text-white"><a href="#" className="rounded-2xl bg-white px-6 py-3 font-black text-black">العودة لتسجيل الدخول</a></div>

  return <main className="min-h-screen bg-[#050710] text-slate-100"><div className="mx-auto max-w-[1980px] px-3 py-3 md:px-5">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3"><div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-cyan-400/10"><Film className="h-5 w-5 text-cyan-200"/></div><div><div className="flex items-center gap-2"><h1 className="text-lg font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-cyan-300/20 bg-cyan-300/[.06] px-2 py-1 text-[9px] font-black text-cyan-200">CREATOR V8</span></div><p className="mt-1 text-[10px] text-slate-500">Ripple / Roll · Slip Edit · J/L Cuts · Video Waveforms · Track Controls · Markers · Easing</p></div></div><div className="flex flex-wrap gap-2"><button onClick={saveProject} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black"><Save className="mr-1 inline h-3.5 w-3.5"/>حفظ</button><button onClick={restoreProject} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black">استعادة</button><a href="#video-v7" className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black text-slate-400">V7</a><select value={outputSize} onChange={e=>setOutputSize(e.target.value as OutputSize)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="720p">720p</option><option value="1080p">1080p</option><option value="portrait">9:16</option><option value="square">1:1</option></select><select value={quality} onChange={e=>setQuality(e.target.value as RenderQuality)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select><button onClick={exportProject} disabled={busy||!project.clips.length} className="rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-2 text-xs font-black disabled:opacity-30">{busy?'Rendering V8...':'EXPORT V8'}</button></div></header>

    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/10 bg-white/[.025] p-1.5"><div className="flex flex-wrap gap-1">{(['media','edit','motion','audio','color','markers'] as Panel[]).map(item=><button key={item} onClick={()=>setPanel(item)} className={`rounded-xl px-4 py-2 text-[10px] font-black ${panel===item?'bg-white text-black':'text-slate-400'}`}>{item.toUpperCase()}</button>)}</div><div className="flex gap-1"><button onClick={()=>setProject(s=>({...s,magneticSnap:!s.magneticSnap}))} className={`rounded-xl border px-3 py-2 text-[9px] font-black ${project.magneticSnap?'border-cyan-300/40 bg-cyan-300/10 text-cyan-100':'border-white/10 text-slate-500'}`}><Magnet className="mr-1 inline h-3.5 w-3.5"/>SNAP</button><button onClick={()=>setSlipMode(v=>!v)} className={`rounded-xl border px-3 py-2 text-[9px] font-black ${slipMode?'border-fuchsia-300/40 bg-fuchsia-300/10 text-fuchsia-100':'border-white/10 text-slate-500'}`}>SLIP</button><button onClick={addMarker} className="rounded-xl border border-amber-300/20 px-3 py-2 text-[9px] font-black text-amber-100"><MapPin className="mr-1 inline h-3.5 w-3.5"/>MARKER</button></div></div>

    <section className="mt-3 grid gap-3 2xl:grid-cols-[300px_minmax(0,1fr)_370px]">
      <aside className="rounded-3xl border border-white/10 bg-[#090e19] p-4">
        {panel==='media'&&<><p className="text-[10px] font-black tracking-widest text-slate-500">MEDIA / PROXY</p><div className="mt-4 grid grid-cols-2 gap-2"><label className="cursor-pointer rounded-2xl border border-dashed border-violet-300/20 p-3 text-center text-[9px] font-black"><UploadCloud className="mx-auto mb-2 h-4 w-4"/>VIDEO<input type="file" multiple accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi" className="hidden" onChange={onVideoInput}/></label><label className="cursor-pointer rounded-2xl border border-dashed border-emerald-300/20 p-3 text-center text-[9px] font-black"><Layers3 className="mx-auto mb-2 h-4 w-4"/>PIP<input type="file" accept="video/*" className="hidden" onChange={addPip}/></label><label className="cursor-pointer rounded-2xl border border-dashed border-cyan-300/20 p-3 text-center text-[9px] font-black"><Music2 className="mx-auto mb-2 h-4 w-4"/>AUDIO<input type="file" accept="audio/*" className="hidden" onChange={addAudio}/></label><label className="cursor-pointer rounded-2xl border border-dashed border-fuchsia-300/20 p-3 text-center text-[9px] font-black"><ImageIcon className="mx-auto mb-2 h-4 w-4"/>IMAGE<input type="file" accept="image/*" className="hidden" onChange={addImage}/></label><button onClick={addTitle} className="rounded-2xl border border-dashed border-sky-300/20 p-3 text-[9px] font-black"><Type className="mx-auto mb-2 h-4 w-4"/>TITLE</button><button onClick={addSubtitle} className="rounded-2xl border border-dashed border-amber-300/20 p-3 text-[9px] font-black"><Captions className="mx-auto mb-2 h-4 w-4"/>SUBTITLE</button></div>{selectedClip&&selectedVideo&&<div className="mt-5 rounded-2xl border border-white/10 p-3"><p className="text-[10px] font-black">PROXY</p><p className="mt-1 text-[9px] text-slate-600">المعاينة تستخدم Proxy؛ Export من الأصل.</p>{selectedVideo.proxyUrl?<button onClick={removeProxy} className="mt-3 w-full rounded-xl border border-rose-300/20 px-3 py-2 text-[9px] text-rose-200">إلغاء Proxy</button>:<button onClick={createProxyForSelected} disabled={proxyBusy} className="mt-3 w-full rounded-xl bg-cyan-300/10 px-3 py-2 text-[9px] font-black text-cyan-100">{proxyBusy?'إنشاء Proxy...':'إنشاء Proxy 540p'}</button>}</div>}</>}
        {panel==='edit'&&<><p className="text-[10px] font-black tracking-widest text-slate-500">PRO EDIT MODES</p><div className="mt-4 grid grid-cols-2 gap-2"><button onClick={()=>setProject(s=>({...s,editMode:'ripple'}))} className={`rounded-xl border p-3 text-[9px] font-black ${project.editMode==='ripple'?'border-cyan-300/40 bg-cyan-300/10':'border-white/10'}`}>RIPPLE TRIM</button><button onClick={()=>setProject(s=>({...s,editMode:'roll'}))} className={`rounded-xl border p-3 text-[9px] font-black ${project.editMode==='roll'?'border-violet-300/40 bg-violet-300/10':'border-white/10'}`}>ROLL EDIT</button></div><p className="mt-3 text-[9px] leading-5 text-slate-600">Ripple يحرك المقاطع التالية تلقائيًا. Roll يحرك نقطة القطع بين مقطعين ويحافظ قدر الإمكان على المدة الإجمالية. فعّل SLIP أعلى الصفحة أو استخدم Alt+Drag داخل Clip لتغيير الجزء المصدر بدون تغيير مدته.</p><p className="mt-5 text-[10px] font-black text-slate-500">TRANSITION</p><select className={fieldClass()} value={project.transition} onChange={e=>setProject(s=>({...s,transition:e.target.value as VideoTransition}))}>{transitions.map(x=><option key={x.value} value={x.value}>{x.label}</option>)}</select>{selectedClip&&<><label className="mt-4 block text-[9px] text-slate-600">SPEED RAMP<select className={fieldClass()} value={selectedClip.speedRamp||'off'} onChange={e=>updateClip(selectedClip.id,{speedRamp:e.target.value as SpeedRampPreset})}>{speedRamps.map(x=><option key={x.value} value={x.value}>{x.label}</option>)}</select></label><button onClick={()=>updateClip(selectedClip.id,{reverse:!selectedClip.reverse})} className={`mt-3 w-full rounded-xl border p-3 text-[9px] font-black ${selectedClip.reverse?'border-violet-300/40 bg-violet-300/10':'border-white/10'}`}>REVERSE</button></>}</>}
        {panel==='motion'&&<><p className="text-[10px] font-black tracking-widest text-slate-500">KEYFRAMES + EASING</p>{selectedClip?<><button onClick={addKeyframe} className="mt-4 w-full rounded-xl bg-amber-300/10 px-3 py-3 text-[10px] font-black text-amber-100"><Plus className="mr-1 inline h-4 w-4"/>ADD KEYFRAME</button><div className="mt-3 space-y-2">{(selectedClip.transformKeyframes||[]).map((kf,index)=><button key={`${kf.time}-${index}`} onClick={()=>seekKeyframe(index)} className={`w-full rounded-xl border p-3 text-left ${activeKeyframe===index?'border-amber-300/50 bg-amber-300/10':'border-white/10'}`}><span className="text-[10px] font-black text-amber-200">◆ {Math.round(kf.time*100)}%</span><span className="ml-2 text-[9px] text-slate-500">{kf.easing||'linear'} · Z {kf.zoom.toFixed(2)}</span></button>)}</div>{activeKeyframe!==null&&selectedClip.transformKeyframes?.[activeKeyframe]&&<div className="mt-4 rounded-2xl border border-amber-300/15 p-3"><div className="flex items-center justify-between"><p className="text-[10px] font-black">KEYFRAME {activeKeyframe+1}</p><button onClick={()=>deleteKeyframe(activeKeyframe)} className="text-rose-300"><Trash2 className="h-4 w-4"/></button></div><label className="mt-3 block text-[9px] text-slate-600">EASING<select className={fieldClass()} value={selectedClip.transformKeyframes[activeKeyframe].easing||'linear'} onChange={e=>updateKeyframe(activeKeyframe,{easing:e.target.value as TransformEasing})}>{easings.map(x=><option key={x.value} value={x.value}>{x.label}</option>)}</select></label><label className="mt-3 block text-[9px] text-slate-600">ZOOM<input type="range" min="1" max="4" step=".02" value={selectedClip.transformKeyframes[activeKeyframe].zoom} onChange={e=>updateKeyframe(activeKeyframe,{zoom:Number(e.target.value)})} className="mt-2 w-full accent-amber-300"/></label></div>}</>:<p className="mt-4 text-[10px] text-slate-600">حدد Clip.</p>}</>}
        {panel==='audio'&&<><p className="text-[10px] font-black tracking-widest text-slate-500">AUDIO / J-L CUTS</p><label className="mt-4 flex items-center justify-between rounded-xl border border-white/10 p-3 text-[10px]"><span>Audio Ducking</span><input type="checkbox" checked={project.audioDuckingEnabled} onChange={e=>setProject(s=>({...s,audioDuckingEnabled:e.target.checked}))}/></label>{selectedClip&&<div className="mt-5 rounded-2xl border border-cyan-300/10 p-3"><p className="text-[10px] font-black text-cyan-100">J / L AUDIO OVERLAP</p><p className="mt-1 text-[9px] leading-5 text-slate-600">J Cut يبدأ صوت هذا Clip قبل ظهور صورته. L Cut يستمر صوته بعد انتقال الصورة.</p><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">J LEAD<input className={fieldClass()} type="number" min="0" max="4" step=".1" value={selectedClip.audioLead||0} disabled={selectedClip.reverse||selectedClip.freezeFrame||selectedClip.speedRamp!=='off'} onChange={e=>updateClip(selectedClip.id,{audioLead:clamp(Number(e.target.value),0,4)})}/></label><label className="text-[9px] text-slate-600">L TAIL<input className={fieldClass()} type="number" min="0" max="4" step=".1" value={selectedClip.audioTail||0} disabled={selectedClip.reverse||selectedClip.freezeFrame||selectedClip.speedRamp!=='off'} onChange={e=>updateClip(selectedClip.id,{audioTail:clamp(Number(e.target.value),0,4)})}/></label></div>{(selectedClip.reverse||selectedClip.freezeFrame||selectedClip.speedRamp!=='off')&&<p className="mt-2 text-[8px] text-amber-300">J/L متاح مع السرعة الثابتة والمقطع غير المعكوس.</p>}</div>}{selectedAudio&&<label className="mt-5 block text-[9px] text-slate-600">MUSIC VOLUME<input className={fieldClass()} type="number" min="0" max="2" step=".05" value={selectedAudio.volume} onChange={e=>updateAudio(selectedAudio.id,{volume:clamp(Number(e.target.value),0,2)})}/></label>}</>}
        {panel==='color'&&<><p className="text-[10px] font-black tracking-widest text-slate-500">COLOR / LUT</p><label className="mt-4 block cursor-pointer rounded-2xl border border-dashed border-amber-300/20 p-4 text-center text-[9px] font-black"><WandSparkles className="mx-auto mb-2 h-4 w-4 text-amber-200"/>{lutFile?lutFile.name:'IMPORT .CUBE LUT'}<input type="file" accept=".cube" className="hidden" onChange={e=>{setLutFile(e.target.files?.[0]||null);e.target.value=''}}/></label>{selectedClip&&<div className="mt-5 grid grid-cols-2 gap-2">{filters.map(item=><button key={item.value} onClick={()=>updateClip(selectedClip.id,{filter:item.value})} className={`rounded-xl border px-3 py-2 text-[9px] ${selectedClip.filter===item.value?'border-cyan-300/40 bg-cyan-300/10':'border-white/10'}`}>{item.label}</button>)}</div>}</>}
        {panel==='markers'&&<><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">TIMELINE MARKERS</p><button onClick={addMarker} className="rounded-lg bg-amber-300/10 px-2 py-1 text-[9px] font-black text-amber-200">+ MARKER</button></div><div className="mt-4 space-y-2">{project.markers.map(marker=><div key={marker.id} className="rounded-xl border border-amber-300/10 p-3"><div className="flex gap-2"><button onClick={()=>setProjectTime(marker.time)} className="text-[9px] font-black text-amber-300">{fmt(marker.time)}</button><button onClick={()=>deleteMarker(marker.id)} className="ml-auto text-rose-300"><Trash2 className="h-3.5 w-3.5"/></button></div><input className={fieldClass()} value={marker.label} onChange={e=>updateMarker(marker.id,{label:e.target.value})}/></div>)}{!project.markers.length&&<p className="text-[9px] text-slate-600">أضف Marker عند رأس التشغيل لتحديد ملاحظات أو نقاط مزامنة.</p>}</div></>}
      </aside>

      <div className="min-w-0 space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-black">PROGRAM MONITOR</p><p className="mt-1 text-[9px] text-slate-600">{fmt(projectTime)} {selectedVideo?.proxyUrl?'· PROXY':''}</p></div><button onClick={()=>setDirectMove(v=>!v)} disabled={!selectedClip} className={`rounded-xl border px-3 py-2 text-[9px] font-black ${directMove?'border-amber-300/40 bg-amber-300/10 text-amber-100':'border-white/10 text-slate-500'}`}><Move className="mr-1 inline h-3.5 w-3.5"/>DIRECT MOVE</button></div><div ref={monitorRef} className="relative mx-auto aspect-video overflow-hidden rounded-2xl border border-white/10 bg-black" onPointerDown={beginDirectMove} onPointerMove={moveDirect} onPointerUp={endDirect} onPointerCancel={endDirect}>{selectedVideo&&selectedClip?<><video ref={videoRef} src={selectedVideo.proxyUrl||selectedVideo.url} className="h-full w-full object-contain" style={{filter:previewCss,transform:`scale(${transform.zoom}) translate(${transform.panX*16}%,${transform.panY*16}%)`,transformOrigin:'center'}} onTimeUpdate={onTimeUpdate} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} playsInline/>{activePips.map(track=>{const asset=videos[track.fileIndex];return asset?<div key={track.id} onPointerDown={e=>beginPipDrag(e,track)} onPointerMove={movePip} onPointerUp={endPip} onPointerCancel={endPip} className="absolute cursor-move overflow-hidden border border-emerald-300/50" style={{width:`${track.scale*100}%`,left:`${track.x*(1-track.scale)*100}%`,top:`${track.y*(1-track.scale)*100}%`,opacity:track.opacity}}><video src={asset.proxyUrl||asset.url} muted autoPlay={playing} loop playsInline className="w-full"/></div>:null})}{activeImages.map(track=>{const asset=images[track.fileIndex];return asset?<img key={track.id} src={asset.url} className="pointer-events-none absolute bottom-5 right-5 max-h-[35%] max-w-[35%] object-contain" style={{opacity:track.opacity}}/>:null})}{activeTitles.map(track=><div key={track.id} className="pointer-events-none absolute inset-x-8 top-1/2 -translate-y-1/2 text-center font-black"><span className="rounded-lg bg-black/45 px-3 py-1.5" style={{fontSize:clamp(track.size/2,16,54)}}>{track.text}</span></div>)}{activeSubs.map(track=><div key={track.id} className="pointer-events-none absolute inset-x-8 bottom-[6%] text-center font-bold" style={{color:track.color,fontSize:clamp(track.size/2,14,40)}}><span className="rounded bg-black/55 px-3 py-1.5">{track.text}</span></div>)}</>:<div className="grid h-full place-items-center"><Film className="h-12 w-12 text-slate-800"/></div>}</div><div className="mt-3 flex flex-wrap items-center justify-center gap-2"><button onClick={togglePlay} disabled={!selectedClip} className="rounded-xl bg-white px-4 py-2 text-xs font-black text-black disabled:opacity-30">{playing?<Pause className="mr-1 inline h-4 w-4"/>:<Play className="mr-1 inline h-4 w-4"/>}{playing?'إيقاف':'تشغيل'}</button><button onClick={splitClip} disabled={!selectedClip||project.trackControls.video.locked} className="rounded-xl border border-cyan-300/20 px-4 py-2 text-xs font-black"><Scissors className="mr-1 inline h-4 w-4"/>Split</button><button onClick={addKeyframe} disabled={!selectedClip} className="rounded-xl border border-amber-300/20 px-4 py-2 text-xs font-black text-amber-100"><Zap className="mr-1 inline h-4 w-4"/>Keyframe</button><button onClick={deleteSelection} disabled={!selection} className="rounded-xl border border-rose-300/20 px-3 py-2 text-rose-200"><Trash2 className="h-4 w-4"/></button></div></div>

        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-black">PRO TIMELINE</p><p className="mt-1 text-[9px] text-slate-600">Drag edges = Trim · SLIP/Alt+Drag = Slip · Ripple/Roll · Magnetic Snap · J/L audio extensions</p></div><div className="flex items-center gap-2"><ZoomOut className="h-4 w-4 text-slate-600"/><input type="range" min="4" max="34" value={timelineZoom} onChange={e=>setTimelineZoom(Number(e.target.value))} className="w-28 accent-cyan-300"/><ZoomIn className="h-4 w-4 text-slate-600"/></div></div><div className="overflow-x-auto rounded-2xl border border-white/8 bg-black/20"><div className="relative" style={{width:timelineWidth}}><div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-red-400" style={{left:112+projectTime*timelineZoom}}/>{snapGuide!==null&&<div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-cyan-300" style={{left:112+snapGuide*timelineZoom}}/>}{project.markers.map(marker=><button title={marker.label} key={marker.id} onClick={()=>setProjectTime(marker.time)} className="absolute top-0 z-20 -translate-x-1/2 text-amber-300" style={{left:112+marker.time*timelineZoom}}><MapPin className="h-3.5 w-3.5"/></button>)}{([['video','VIDEO'],['pip','PIP'],['title','TITLE'],['subtitle','SUBTITLE'],['music','MUSIC'],['image','IMAGE']] as Array<[TrackKey,string]>).map(([track,label])=><div key={track} className="h-[72px] border-b border-white/5"><TrackHeader track={track} label={label}/></div>)}
          <div className="absolute left-[112px] top-0 h-[72px]">{project.clips.map((clip,index)=>{const off=clipOffsets[index],asset=videos[clip.fileIndex];if(!off)return null;return <button key={clip.id} onPointerDown={e=>{if(!beginSlip(e,clip)){setSelection({kind:'clip',id:clip.id});setActiveKeyframe(null);setProjectTime(off.start);setPreviewTime(clip.start)}}} onPointerMove={moveSlip} onPointerUp={endSlip} onPointerCancel={endSlip} className={`absolute top-2 h-14 touch-none overflow-visible rounded-xl border text-left ${selection?.kind==='clip'&&selection.id===clip.id?'border-violet-200 bg-violet-400/20':'border-violet-300/15 bg-violet-400/10'} ${project.trackControls.video.locked?'opacity-60':''}`} style={{left:off.start*timelineZoom,width:Math.max(86,off.duration*timelineZoom)}}><span onPointerDown={e=>beginTrim(e,clip,index,'left')} onPointerMove={moveTrim} onPointerUp={endTrim} onPointerCancel={endTrim} className="absolute bottom-0 left-0 top-0 z-30 w-2 cursor-ew-resize rounded-l-xl bg-cyan-300/40"/><span onPointerDown={e=>beginTrim(e,clip,index,'right')} onPointerMove={moveTrim} onPointerUp={endTrim} onPointerCancel={endTrim} className="absolute bottom-0 right-0 top-0 z-30 w-2 cursor-ew-resize rounded-r-xl bg-cyan-300/40"/><span className="absolute left-3 top-1 z-10 text-[8px] font-black">CLIP {index+1}</span>{asset?.waveformBusy&&<span className="absolute right-3 top-1 text-[7px] text-cyan-200">waveform…</span>}<span className="absolute inset-x-2 bottom-2 top-5 flex items-center gap-[1px] overflow-hidden opacity-55">{(asset?.waveform||[]).map((value,i)=><i key={i} className="block min-w-[1px] flex-1 rounded-full bg-violet-200/80" style={{height:`${Math.max(6,value*100)}%`}}/>)}</span>{(clip.audioLead||0)>0&&<span className="absolute right-full top-7 h-3 rounded-l bg-cyan-300/30" style={{width:(clip.audioLead||0)/Math.max(.25,clip.speed)*timelineZoom}}/>}{(clip.audioTail||0)>0&&<span className="absolute left-full top-7 h-3 rounded-r bg-cyan-300/30" style={{width:(clip.audioTail||0)/Math.max(.25,clip.speed)*timelineZoom}}/>}{(clip.transformKeyframes||[]).map((kf,kfIndex)=><span key={`${kf.time}-${kfIndex}`} onClick={e=>{e.stopPropagation();setSelection({kind:'clip',id:clip.id});setTimeout(()=>seekKeyframe(kfIndex),0)}} className="absolute bottom-0 -translate-x-1/2 text-[9px] text-amber-300" style={{left:`${kf.time*100}%`}}>◆</span>)}</button>})}</div>
          <div className="absolute left-[112px] top-[72px] h-[72px]">{project.videoOverlays.map(track=><button key={track.id} onPointerDown={e=>beginTrackDrag(e,'pip',track.id)} onPointerMove={moveTrack} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} className="absolute top-2 h-14 touch-none rounded-xl border border-emerald-300/20 bg-emerald-400/10 px-3 text-[9px]" style={{left:track.startAt*timelineZoom,width:Math.max(78,(track.endAt-track.startAt)*timelineZoom)}}>PIP</button>)}</div>
          <div className="absolute left-[112px] top-[144px] h-[72px]">{project.textTracks.map(track=><button key={track.id} onPointerDown={e=>beginTrackDrag(e,'title',track.id)} onPointerMove={moveTrack} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} className="absolute top-2 h-14 touch-none rounded-xl border border-sky-300/15 bg-sky-400/10 px-3 text-[9px]" style={{left:track.startAt*timelineZoom,width:Math.max(74,(track.endAt-track.startAt)*timelineZoom)}}>{track.text}</button>)}</div>
          <div className="absolute left-[112px] top-[216px] h-[72px]">{project.subtitleTracks.map(track=><button key={track.id} onPointerDown={e=>beginTrackDrag(e,'subtitle',track.id)} onPointerMove={moveTrack} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} className="absolute top-2 h-14 touch-none rounded-xl border border-amber-300/15 bg-amber-400/10 px-3 text-[9px]" style={{left:track.startAt*timelineZoom,width:Math.max(74,(track.endAt-track.startAt)*timelineZoom)}}>{track.text}</button>)}</div>
          <div className="absolute left-[112px] top-[288px] h-[72px]">{project.audioTracks.map(track=>{const asset=audios[track.fileIndex],duration=track.sourceEnd-track.sourceStart;return <button key={track.id} onPointerDown={e=>beginTrackDrag(e,'audio',track.id)} onPointerMove={moveTrack} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} className="absolute top-2 h-14 touch-none overflow-hidden rounded-xl border border-cyan-300/20 bg-cyan-400/10" style={{left:track.startAt*timelineZoom,width:Math.max(90,duration*timelineZoom)}}><span className="absolute inset-x-1 bottom-1 top-1 flex items-center gap-[1px] opacity-75">{(asset?.waveform||[]).map((value,i)=><i key={i} className="block min-w-[1px] flex-1 rounded-full bg-cyan-200/70" style={{height:`${Math.max(8,value*100)}%`}}/>)}</span></button>})}</div>
          <div className="absolute left-[112px] top-[360px] h-[72px]">{project.imageTracks.map(track=><button key={track.id} onPointerDown={e=>beginTrackDrag(e,'image',track.id)} onPointerMove={moveTrack} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag} className="absolute top-2 h-14 touch-none rounded-xl border border-fuchsia-300/15 bg-fuchsia-400/10 px-3 text-[9px]" style={{left:track.startAt*timelineZoom,width:Math.max(74,(track.endAt-track.startAt)*timelineZoom)}}>IMAGE</button>)}</div>
        </div></div></div>

        {resultUrl&&<div className="rounded-3xl border border-emerald-300/15 bg-emerald-300/[.035] p-5"><div className="flex items-center justify-between"><p className="text-sm font-black text-emerald-100">اكتمل Render V8</p><Sparkles className="h-5 w-5 text-emerald-300"/></div><video controls src={resultUrl} className="mt-4 max-h-[520px] w-full rounded-2xl bg-black"/><a href={resultUrl} download="MAGHRABI-video-v8.mp4" className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-black text-black"><Download className="h-4 w-4"/>تنزيل الفيديو</a></div>}
      </div>

      <aside className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">INSPECTOR</p><p className="mt-1 text-xs font-black">{selection?.kind.toUpperCase()||'PROJECT'}</p></div><WandSparkles className="h-4 w-4 text-violet-300"/></div>{selectedClip&&selectedVideo&&<div className="mt-5 space-y-4"><div className="grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">SOURCE START<input className={fieldClass()} type="number" step=".05" value={selectedClip.start} onChange={e=>updateClip(selectedClip.id,{start:clamp(Number(e.target.value),0,selectedClip.end-.05)})}/></label><label className="text-[9px] text-slate-600">SOURCE END<input className={fieldClass()} type="number" step=".05" value={selectedClip.end} onChange={e=>updateClip(selectedClip.id,{end:clamp(Number(e.target.value),selectedClip.start+.05,selectedVideo.duration)})}/></label></div><div className="grid grid-cols-2 gap-2"><label className="text-[9px] text-slate-600">SPEED<input className={fieldClass()} type="number" min=".25" max="4" step=".05" value={selectedClip.speed} onChange={e=>updateClip(selectedClip.id,{speed:clamp(Number(e.target.value),.25,4)})}/></label><label className="text-[9px] text-slate-600">VOLUME<input className={fieldClass()} type="number" min="0" max="2" step=".05" value={selectedClip.volume} onChange={e=>updateClip(selectedClip.id,{volume:clamp(Number(e.target.value),0,2)})}/></label></div><div className="rounded-xl border border-cyan-300/10 p-3"><p className="text-[9px] font-black text-cyan-200">EDIT STATUS</p><p className="mt-2 text-[9px] leading-5 text-slate-500">{project.editMode.toUpperCase()} · {slipMode?'SLIP ON':'Alt+Drag for Slip'} · J {selectedClip.audioLead||0}s · L {selectedClip.audioTail||0}s · {(selectedClip.transformKeyframes||[]).length} keyframes</p></div></div>}{selectedPip&&<div className="mt-5 space-y-3"><label className="text-[9px] text-slate-600">PIP SCALE<input className={fieldClass()} type="number" min=".08" max=".85" step=".02" value={selectedPip.scale} onChange={e=>updatePip(selectedPip.id,{scale:clamp(Number(e.target.value),.08,.85)})}/></label></div>}{selectedTitle&&<label className="mt-5 block text-[9px] text-slate-600">TITLE<input className={fieldClass()} value={selectedTitle.text} onChange={e=>updateTitle(selectedTitle.id,{text:e.target.value})}/></label>}{selectedSubtitle&&<label className="mt-5 block text-[9px] text-slate-600">SUBTITLE<input className={fieldClass()} value={selectedSubtitle.text} onChange={e=>updateSubtitle(selectedSubtitle.id,{text:e.target.value})}/></label>}{selectedImage&&<label className="mt-5 block text-[9px] text-slate-600">IMAGE OPACITY<input className={fieldClass()} type="number" min="0" max="1" step=".05" value={selectedImage.opacity} onChange={e=>updateImage(selectedImage.id,{opacity:clamp(Number(e.target.value),0,1)})}/></label>}{error&&<div className="mt-5 rounded-xl border border-rose-300/20 bg-rose-400/10 p-3 text-[10px] leading-5 text-rose-200">{error}</div>}</aside>
    </section>
  </div></main>
}
