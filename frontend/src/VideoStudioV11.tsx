import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera,
  Download,
  Film,
  FolderOpen,
  Gauge,
  Layers3,
  ListVideo,
  Music2,
  Pause,
  Play,
  Plus,
  Save,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UploadCloud,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import {
  AudioTrackManifest,
  extractVideoAudio,
  OutputSize,
  RenderQuality,
  renderVideoProjectV11,
  VideoClipManifest,
  VideoFilter,
  VideoOverlayTrackManifest,
  VideoProjectManifestV11,
} from './lib/videoApi'
import { loadStoredVideoProject, saveStoredVideoProject } from './lib/projectStore'

type VideoLane = 'V1' | 'V2' | 'V3'
type AudioLane = 'A1' | 'A2' | 'A3'
type VideoAsset = { file: File; url: string; duration: number; bin: string }
type AudioAsset = { file: File; duration: number; bin: string }
type TimelineClip = VideoClipManifest & {
  id: string
  lane: VideoLane
  startAt: number
  linkedAudio: boolean
  detachedTrackId?: string | null
}
type TimelineAudio = AudioTrackManifest & {
  id: string
  lane: AudioLane
  name: string
  linkedClipId?: string | null
}
type AdjustmentLayer = {
  id: string
  name: string
  startAt: number
  endAt: number
  brightness: number
  contrast: number
  saturation: number
  blur: number
}
type Mixer = { video: number; music: number; pip: number; master: number }
type MulticamCut = { time: number; cameraIndex: number }
type MulticamState = {
  cameras: number[]
  offsets: Record<number, number>
  cuts: MulticamCut[]
  duration: number
}
type RenderJob = {
  id: string
  name: string
  size: OutputSize
  quality: RenderQuality
  status: 'queued' | 'rendering' | 'done' | 'failed'
  manifest: VideoProjectManifestV11
  url?: string
  error?: string
}
type V11StoredProject = {
  clips: TimelineClip[]
  audioTracks: TimelineAudio[]
  videoBins: string[]
  audioBins: string[]
  bins: string[]
  adjustments: AdjustmentLayer[]
  mixer: Mixer
  multicam: MulticamState
}

const baseBins = ['Footage', 'Audio', 'Graphics']
const defaultMixer: Mixer = { video: 1, music: 1, pip: 1, master: 1 }
const emptyMulticam: MulticamState = { cameras: [], offsets: {}, cuts: [], duration: 0 }
const filters: Array<{ value: VideoFilter; label: string }> = [
  { value: 'none', label: 'Normal' },
  { value: 'warm', label: 'Warm' },
  { value: 'cool', label: 'Cool' },
  { value: 'cinematic', label: 'Cinematic' },
  { value: 'vivid', label: 'Vivid' },
  { value: 'mono', label: 'Mono' },
]

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
function makeClip(fileIndex: number, sourceStart: number, sourceEnd: number, lane: VideoLane, startAt: number): TimelineClip {
  return {
    id: uid(), fileIndex, lane, startAt, start: sourceStart, end: sourceEnd, speed: 1, volume: 1,
    filter: 'none', text: '', textSize: 48, textPosition: 'bottom', rotation: 0, fit: 'contain',
    zoomStart: 1, zoomEnd: 1, panXStart: 0, panXEnd: 0, panYStart: 0, panYEnd: 0,
    chromaEnabled: false, chromaColor: '#00ff00', chromaBackground: '#101010', chromaSimilarity: .18,
    chromaBlend: .06, brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0,
    speedRamp: 'off', reverse: false, freezeFrame: false, freezeDuration: 2, privacyEffect: 'none',
    privacyX: .35, privacyY: .3, privacyWidth: .3, privacyHeight: .22, privacyIntensity: .55,
    transformKeyframes: [], audioLead: 0, audioTail: 0, audioFadeIn: 0, audioFadeOut: 0,
    audioAutomation: [], groupId: null, linkedAudio: true, detachedTrackId: null,
  }
}
function clipDuration(clip: TimelineClip) { return Math.max(.02, (clip.end - clip.start) / Math.max(.25, clip.speed)) }
function laneEnd(clips: TimelineClip[], lane: VideoLane) {
  return clips.filter((clip) => clip.lane === lane).reduce((max, clip) => Math.max(max, clip.startAt + clipDuration(clip)), 0)
}

export default function VideoStudioV11() {
  const sourceRef = useRef<HTMLVideoElement>(null)
  const programRef = useRef<HTMLVideoElement>(null)
  const multicamRefs = useRef<Record<number, HTMLVideoElement | null>>({})
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [videos, setVideos] = useState<VideoAsset[]>([])
  const [audios, setAudios] = useState<AudioAsset[]>([])
  const [bins, setBins] = useState<string[]>(baseBins)
  const [activeBin, setActiveBin] = useState('All Media')
  const [search, setSearch] = useState('')
  const [sourceIndex, setSourceIndex] = useState<number | null>(null)
  const [sourceIn, setSourceIn] = useState(0)
  const [sourceOut, setSourceOut] = useState(0)
  const [clips, setClips] = useState<TimelineClip[]>([])
  const [audioTracks, setAudioTracks] = useState<TimelineAudio[]>([])
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [programPlaying, setProgramPlaying] = useState(false)
  const [timelineZoom, setTimelineZoom] = useState(10)
  const [adjustments, setAdjustments] = useState<AdjustmentLayer[]>([])
  const [mixer, setMixer] = useState<Mixer>(defaultMixer)
  const [masterLut, setMasterLut] = useState<File | null>(null)
  const [multicam, setMulticam] = useState<MulticamState>(emptyMulticam)
  const [multicamLive, setMulticamLive] = useState(false)
  const [multicamTime, setMulticamTime] = useState(0)
  const [outputSize, setOutputSize] = useState<OutputSize>('720p')
  const [quality, setQuality] = useState<RenderQuality>('standard')
  const [queue, setQueue] = useState<RenderJob[]>([])
  const [queueRunning, setQueueRunning] = useState(false)
  const [detaching, setDetaching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { getAuthStatus().then((status) => setAuthorized(status.authenticated)).catch(() => setAuthorized(false)) }, [])

  const v1 = useMemo(() => [...clips.filter((clip) => clip.lane === 'V1')].sort((a, b) => a.startAt - b.startAt), [clips])
  const projectDuration = Math.max(
    laneEnd(clips, 'V1'), laneEnd(clips, 'V2'), laneEnd(clips, 'V3'),
    ...audioTracks.map((track) => track.startAt + (track.sourceEnd - track.sourceStart)), 0,
  )
  const selectedClip = clips.find((clip) => clip.id === selectedClipId) || null
  const selectedAudio = audioTracks.find((track) => track.id === selectedAudioId) || null
  const sourceAsset = sourceIndex !== null ? videos[sourceIndex] : null
  const programClip = v1.find((clip) => playhead >= clip.startAt && playhead < clip.startAt + clipDuration(clip)) || v1[0] || null
  const programAsset = programClip ? videos[programClip.fileIndex] : null
  const activeOverlays = clips.filter((clip) => clip.lane !== 'V1' && playhead >= clip.startAt && playhead < clip.startAt + clipDuration(clip))

  const visibleVideos = videos.map((asset, index) => ({ asset, index })).filter(({ asset }) => {
    const binMatch = activeBin === 'All Media' || asset.bin === activeBin
    const searchMatch = !search.trim() || asset.file.name.toLowerCase().includes(search.toLowerCase())
    return binMatch && searchMatch
  })
  const visibleAudios = audios.map((asset, index) => ({ asset, index })).filter(({ asset }) => {
    const binMatch = activeBin === 'All Media' || asset.bin === activeBin
    const searchMatch = !search.trim() || asset.file.name.toLowerCase().includes(search.toLowerCase())
    return binMatch && searchMatch
  })

  const addVideoFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).slice(0, Math.max(0, 14 - videos.length))
    if (!files.length) return
    try {
      const durations = await Promise.all(files.map((file) => mediaDuration(file, 'video')))
      const targetBin = activeBin === 'All Media' ? 'Footage' : activeBin
      const assets = files.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: durations[index], bin: targetBin }))
      const base = videos.length
      setVideos((state) => [...state, ...assets])
      if (sourceIndex === null) { setSourceIndex(base); setSourceIn(0); setSourceOut(assets[0]?.duration || 0) }
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الفيديو.') }
    event.target.value = ''
  }
  const addAudioFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    try {
      const duration = await mediaDuration(file, 'audio')
      const targetBin = activeBin === 'All Media' ? 'Audio' : activeBin
      const fileIndex = audios.length
      setAudios((state) => [...state, { file, duration, bin: targetBin }])
      const track: TimelineAudio = { id: uid(), lane: 'A2', name: file.name, fileIndex, startAt: playhead, sourceStart: 0, sourceEnd: duration, volume: .75, fadeIn: .2, fadeOut: .4, automation: [], linkedClipId: null }
      setAudioTracks((state) => [...state, track]); setSelectedAudioId(track.id); setSelectedClipId(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الصوت.') }
    event.target.value = ''
  }
  const chooseSource = (index: number) => {
    setSourceIndex(index); setSourceIn(0); setSourceOut(videos[index]?.duration || 0)
    window.setTimeout(() => { if (sourceRef.current) sourceRef.current.currentTime = 0 }, 0)
  }
  const createBin = () => {
    const name = window.prompt('اسم المجلد / Bin الجديد')?.trim()
    if (!name || bins.includes(name)) return
    setBins((state) => [...state, name]); setActiveBin(name)
  }
  const moveVideoToBin = (index: number, bin: string) => setVideos((state) => state.map((asset, i) => i === index ? { ...asset, bin } : asset))
  const moveAudioToBin = (index: number, bin: string) => setAudios((state) => state.map((asset, i) => i === index ? { ...asset, bin } : asset))

  const insertSource = (lane: VideoLane) => {
    if (sourceIndex === null || !sourceAsset) return
    const start = clamp(sourceIn, 0, sourceAsset.duration - .05)
    const end = clamp(sourceOut || sourceAsset.duration, start + .05, sourceAsset.duration)
    const startAt = lane === 'V1' ? laneEnd(clips, 'V1') : playhead
    const clip = makeClip(sourceIndex, start, end, lane, startAt)
    setClips((state) => [...state, clip]); setSelectedClipId(clip.id); setSelectedAudioId(null)
  }

  useEffect(() => {
    const video = programRef.current
    if (!video || !programClip || !programAsset) return
    const local = clamp(playhead - programClip.startAt, 0, clipDuration(programClip))
    const sourceTime = clamp(programClip.start + local * programClip.speed, programClip.start, programClip.end)
    if (Math.abs(video.currentTime - sourceTime) > .18) { try { video.currentTime = sourceTime } catch {} }
    video.playbackRate = programClip.speed
    video.volume = clamp(programClip.volume * mixer.video * mixer.master, 0, 1)
  }, [playhead, programClip?.id, programAsset?.url, mixer.video, mixer.master])

  const toggleProgram = async () => {
    const video = programRef.current; if (!video || !programClip) return
    if (video.paused) { await video.play().catch(() => undefined); setProgramPlaying(true) }
    else { video.pause(); setProgramPlaying(false) }
  }
  const onProgramTime = () => {
    const video = programRef.current; if (!video || !programClip) return
    const next = programClip.startAt + Math.max(0, (video.currentTime - programClip.start) / Math.max(.25, programClip.speed))
    setPlayhead(next)
    if (video.currentTime >= programClip.end - .025) {
      video.pause(); setProgramPlaying(false)
      const index = v1.findIndex((clip) => clip.id === programClip.id)
      const nextClip = v1[index + 1]
      if (nextClip) { setPlayhead(nextClip.startAt); window.setTimeout(() => programRef.current?.play().then(() => setProgramPlaying(true)).catch(() => undefined), 20) }
    }
  }

  const updateClip = (id: string, changes: Partial<TimelineClip>) => setClips((state) => state.map((clip) => clip.id === id ? { ...clip, ...changes } : clip))
  const updateAudio = (id: string, changes: Partial<TimelineAudio>) => setAudioTracks((state) => state.map((track) => track.id === id ? { ...track, ...changes } : track))
  const splitSelected = () => {
    if (!selectedClip) return
    const local = playhead - selectedClip.startAt
    const sourceAt = selectedClip.start + local * selectedClip.speed
    if (sourceAt - selectedClip.start < .08 || selectedClip.end - sourceAt < .08) { setError('ضع Playhead داخل المقطع ثم نفذ Split.'); return }
    const left = { ...selectedClip, id: uid(), end: sourceAt }
    const leftDuration = clipDuration(left)
    const right = { ...selectedClip, id: uid(), start: sourceAt, startAt: selectedClip.startAt + leftDuration }
    setClips((state) => state.flatMap((clip) => clip.id === selectedClip.id ? [left, right] : [clip])); setSelectedClipId(right.id)
  }
  const deleteSelected = () => {
    if (selectedClip) { setClips((state) => state.filter((clip) => clip.id !== selectedClip.id)); if (selectedClip.detachedTrackId) setAudioTracks((state) => state.filter((track) => track.id !== selectedClip.detachedTrackId)); setSelectedClipId(null) }
    if (selectedAudio) { setAudioTracks((state) => state.filter((track) => track.id !== selectedAudio.id)); setSelectedAudioId(null) }
  }

  const detachAudio = async () => {
    if (!selectedClip || selectedClip.lane !== 'V1' || !selectedClip.linkedAudio || detaching) return
    const asset = videos[selectedClip.fileIndex]; if (!asset) return
    setDetaching(true); setError(null)
    try {
      const blob = await extractVideoAudio(asset.file)
      const file = new File([blob], `${asset.file.name.replace(/\.[^.]+$/, '')}-detached.wav`, { type: 'audio/wav' })
      const duration = await mediaDuration(file, 'audio'), fileIndex = audios.length, trackId = uid()
      setAudios((state) => [...state, { file, duration, bin: 'Audio' }])
      const track: TimelineAudio = {
        id: trackId, lane: 'A1', name: `Linked · ${asset.file.name}`, fileIndex, startAt: selectedClip.startAt,
        sourceStart: selectedClip.start, sourceEnd: selectedClip.end, volume: selectedClip.volume, fadeIn: selectedClip.audioFadeIn || 0,
        fadeOut: selectedClip.audioFadeOut || 0, automation: [...(selectedClip.audioAutomation || [])], linkedClipId: selectedClip.id,
      }
      setAudioTracks((state) => [...state, track])
      updateClip(selectedClip.id, { linkedAudio: false, detachedTrackId: trackId, volume: 0, audioFadeIn: 0, audioFadeOut: 0, audioAutomation: [] })
      setSelectedAudioId(trackId)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر فصل صوت الفيديو.') }
    finally { setDetaching(false) }
  }
  const relinkAudio = () => {
    if (!selectedClip?.detachedTrackId) return
    const track = audioTracks.find((item) => item.id === selectedClip.detachedTrackId)
    updateClip(selectedClip.id, { linkedAudio: true, detachedTrackId: null, volume: track?.volume ?? 1, audioFadeIn: track?.fadeIn || 0, audioFadeOut: track?.fadeOut || 0, audioAutomation: [...(track?.automation || [])] })
    setAudioTracks((state) => state.filter((item) => item.id !== selectedClip.detachedTrackId)); setSelectedAudioId(null)
  }

  const toggleCamera = (index: number) => {
    setMulticam((state) => {
      const cameras = state.cameras.includes(index) ? state.cameras.filter((item) => item !== index) : [...state.cameras, index].slice(0, 4)
      const duration = cameras.length ? Math.min(...cameras.map((camera) => Math.max(0, (videos[camera]?.duration || 0) - (state.offsets[camera] || 0)))) : 0
      return { ...state, cameras, duration, cuts: state.cuts.filter((cut) => cameras.includes(cut.cameraIndex)) }
    })
  }
  const startMulticamLive = async () => {
    if (!multicam.cameras.length) return
    const first = multicam.cameras[0]
    setMulticam((state) => ({ ...state, cuts: state.cuts.length ? state.cuts : [{ time: 0, cameraIndex: first }] }))
    setMulticamTime(0); setMulticamLive(true)
    multicam.cameras.forEach((index) => {
      const video = multicamRefs.current[index]; if (!video) return
      video.currentTime = clamp(multicam.offsets[index] || 0, 0, Math.max(0, (videos[index]?.duration || 0) - .02))
      video.play().catch(() => undefined)
    })
  }
  const stopMulticamLive = () => { setMulticamLive(false); multicam.cameras.forEach((index) => multicamRefs.current[index]?.pause()) }
  const liveCut = (cameraIndex: number) => {
    if (!multicam.cameras.includes(cameraIndex)) return
    const time = clamp(multicamLive ? multicamTime : playhead, 0, multicam.duration)
    setMulticam((state) => ({ ...state, cuts: [...state.cuts.filter((cut) => Math.abs(cut.time - time) > .035), { time, cameraIndex }].sort((a, b) => a.time - b.time) }))
  }
  const bakeMulticam = () => {
    if (!multicam.cameras.length || !multicam.duration) return
    const cuts = multicam.cuts.length ? [...multicam.cuts].sort((a, b) => a.time - b.time) : [{ time: 0, cameraIndex: multicam.cameras[0] }]
    if (cuts[0].time > .01) cuts.unshift({ time: 0, cameraIndex: cuts[0].cameraIndex })
    const baked: TimelineClip[] = []
    cuts.forEach((cut, index) => {
      const next = cuts[index + 1]?.time ?? multicam.duration
      if (next <= cut.time + .04) return
      const offset = multicam.offsets[cut.cameraIndex] || 0
      const assetDuration = videos[cut.cameraIndex]?.duration || 0
      const sourceStart = clamp(cut.time + offset, 0, Math.max(0, assetDuration - .05))
      const sourceEnd = clamp(next + offset, sourceStart + .05, assetDuration)
      baked.push(makeClip(cut.cameraIndex, sourceStart, sourceEnd, 'V1', cut.time))
    })
    setClips((state) => [...state.filter((clip) => clip.lane !== 'V1'), ...baked]); setPlayhead(0); setSelectedClipId(baked[0]?.id || null)
  }

  const addAdjustment = () => {
    const endAt = Math.max(playhead + 4, Math.min(projectDuration || playhead + 6, playhead + 8))
    setAdjustments((state) => [...state, { id: uid(), name: `Adjustment ${state.length + 1}`, startAt: playhead, endAt, brightness: 0, contrast: 1, saturation: 1, blur: 0 }])
  }
  const updateAdjustment = (id: string, changes: Partial<AdjustmentLayer>) => setAdjustments((state) => state.map((layer) => layer.id === id ? { ...layer, ...changes } : layer))

  const flattenV1 = () => {
    const result: TimelineClip[] = []
    for (const clip of v1) {
      const clipStart = clip.startAt, clipEnd = clip.startAt + clipDuration(clip)
      const boundaries = [clipStart, clipEnd]
      adjustments.forEach((layer) => {
        if (layer.startAt > clipStart && layer.startAt < clipEnd) boundaries.push(layer.startAt)
        if (layer.endAt > clipStart && layer.endAt < clipEnd) boundaries.push(layer.endAt)
      })
      const sorted = Array.from(new Set(boundaries)).sort((a, b) => a - b)
      for (let i = 0; i < sorted.length - 1; i++) {
        const segStart = sorted[i], segEnd = sorted[i + 1], mid = (segStart + segEnd) / 2
        const localStart = segStart - clipStart, localEnd = segEnd - clipStart
        const active = adjustments.filter((layer) => mid >= layer.startAt && mid <= layer.endAt)
        let brightness = clip.brightness || 0, contrast = clip.contrast || 1, saturation = clip.saturation || 1
        let blur = 0
        active.forEach((layer) => { brightness += layer.brightness; contrast *= layer.contrast; saturation *= layer.saturation; blur = Math.max(blur, layer.blur) })
        result.push({
          ...clip, id: uid(), startAt: segStart,
          start: clip.start + localStart * clip.speed, end: clip.start + localEnd * clip.speed,
          brightness: clamp(brightness, -.6, .6), contrast: clamp(contrast, .5, 2), saturation: clamp(saturation, 0, 3),
          privacyEffect: blur > .01 ? 'blur' : clip.privacyEffect,
          privacyX: blur > .01 ? 0 : clip.privacyX, privacyY: blur > .01 ? 0 : clip.privacyY,
          privacyWidth: blur > .01 ? 1 : clip.privacyWidth, privacyHeight: blur > .01 ? 1 : clip.privacyHeight,
          privacyIntensity: blur > .01 ? blur : clip.privacyIntensity,
        })
      }
    }
    return result
  }

  const buildManifest = (): VideoProjectManifestV11 => {
    const master = mixer.master
    const main = flattenV1().map(({ id: _id, lane: _lane, startAt: _startAt, linkedAudio: _linkedAudio, detachedTrackId: _detachedTrackId, ...clip }) => ({ ...clip, volume: clamp(clip.volume * mixer.video * master, 0, 2) }))
    const overlays: VideoOverlayTrackManifest[] = clips.filter((clip) => clip.lane !== 'V1').map((clip) => ({
      fileIndex: clip.fileIndex, startAt: clip.startAt, endAt: clip.startAt + clipDuration(clip), sourceStart: clip.start,
      sourceEnd: clip.end, scale: clip.lane === 'V2' ? .38 : .28, opacity: 1, x: clip.lane === 'V2' ? .58 : .06,
      y: clip.lane === 'V2' ? .56 : .08, borderRadius: .04, audioEnabled: clip.linkedAudio, audioVolume: clamp(clip.volume * mixer.pip * master, 0, 2),
    }))
    return {
      clips: main,
      textTracks: [], subtitleTracks: [], imageTracks: [], videoOverlays: overlays,
      audioTracks: audioTracks.map(({ id: _id, lane: _lane, name: _name, linkedClipId: _linkedClipId, ...track }) => ({ ...track, volume: clamp(track.volume * mixer.music * master, 0, 2) })),
      transition: 'none', transitionDuration: .1, audioDuckingEnabled: false, duckingStrength: .65, magneticSnap: true,
    }
  }

  const queueCurrent = () => {
    if (!v1.length) return
    const job: RenderJob = { id: uid(), name: `V11 ${outputSize} ${quality}`, size: outputSize, quality, status: 'queued', manifest: buildManifest() }
    setQueue((state) => [...state, job])
  }
  const runQueue = async () => {
    if (queueRunning) return
    setQueueRunning(true); setError(null)
    const pending = queue.filter((job) => job.status === 'queued')
    for (const job of pending) {
      setQueue((state) => state.map((item) => item.id === job.id ? { ...item, status: 'rendering', error: undefined } : item))
      try {
        const blob = await renderVideoProjectV11(videos.map((asset) => asset.file), audios.map((asset) => asset.file), [], job.manifest, job.size, job.quality, masterLut)
        const url = URL.createObjectURL(blob)
        setQueue((state) => state.map((item) => item.id === job.id ? { ...item, status: 'done', url } : item))
      } catch (e) {
        const message = e instanceof Error ? e.message : 'فشل Render Queue.'
        setQueue((state) => state.map((item) => item.id === job.id ? { ...item, status: 'failed', error: message } : item))
      }
    }
    setQueueRunning(false)
  }

  const saveProject = async () => {
    try {
      const project: V11StoredProject = {
        clips, audioTracks, bins, adjustments, mixer, multicam,
        videoBins: videos.map((asset) => asset.bin), audioBins: audios.map((asset) => asset.bin),
      }
      await saveStoredVideoProject<V11StoredProject>({
        version: 3, savedAt: new Date().toISOString(), project,
        videos: videos.map((asset) => asset.file), videoDurations: videos.map((asset) => asset.duration),
        audios: audios.map((asset) => asset.file), audioDurations: audios.map((asset) => asset.duration),
        images: [], outputSize, quality,
      })
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر حفظ V11.') }
  }
  const restoreProject = async () => {
    try {
      const snapshot = await loadStoredVideoProject<V11StoredProject>(); if (!snapshot) { setError('لا يوجد مشروع محفوظ.'); return }
      const project = snapshot.project
      setVideos(snapshot.videos.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: snapshot.videoDurations[index] || 0, bin: project.videoBins?.[index] || 'Footage' })))
      setAudios(snapshot.audios.map((file, index) => ({ file, duration: snapshot.audioDurations[index] || 0, bin: project.audioBins?.[index] || 'Audio' })))
      setClips(project.clips || []); setAudioTracks(project.audioTracks || []); setBins(project.bins?.length ? project.bins : baseBins)
      setAdjustments(project.adjustments || []); setMixer(project.mixer || defaultMixer); setMulticam(project.multicam || emptyMulticam)
      setOutputSize(snapshot.outputSize as OutputSize); setQuality(snapshot.quality as RenderQuality)
      setSelectedClipId(project.clips?.[0]?.id || null); setSourceIndex(snapshot.videos.length ? 0 : null); setSourceIn(0); setSourceOut(snapshot.videoDurations[0] || 0); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر استعادة V11.') }
  }

  const timelineWidth = Math.max(1200, projectDuration * timelineZoom + 140)
  const laneTop: Record<VideoLane | AudioLane, number> = { V3: 0, V2: 64, V1: 128, A1: 192, A2: 256, A3: 320 }

  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#050710] text-cyan-200">جاري التحقق...</div>
  if (!authorized) return <div className="grid min-h-screen place-items-center bg-[#050710] text-white"><a href="#" className="rounded-2xl bg-white px-6 py-3 font-black text-black">العودة لتسجيل الدخول</a></div>

  return <main className="min-h-screen bg-[#050710] text-slate-100"><div className="mx-auto max-w-[2040px] px-3 py-3 md:px-5">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
      <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-violet-400/10"><Film className="h-5 w-5 text-violet-200"/></div><div><div className="flex items-center gap-2"><h1 className="text-lg font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-violet-300/20 bg-violet-300/[.06] px-2 py-1 text-[9px] font-black text-violet-200">CREATOR V11</span></div><p className="mt-1 text-[10px] text-slate-500">Source / Program · Bins · V1/V2/V3 · Linked Audio · Live Multi‑Cam · Render Queue</p></div></div>
      <div className="flex flex-wrap gap-2"><button onClick={saveProject} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black"><Save className="mr-1 inline h-3.5 w-3.5"/>حفظ</button><button onClick={restoreProject} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black"><FolderOpen className="mr-1 inline h-3.5 w-3.5"/>استعادة</button><a href="#video-v10" className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black text-slate-400">V10</a><select value={outputSize} onChange={e=>setOutputSize(e.target.value as OutputSize)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="720p">720p</option><option value="1080p">1080p</option><option value="portrait">9:16</option><option value="square">1:1</option></select><select value={quality} onChange={e=>setQuality(e.target.value as RenderQuality)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select><button onClick={queueCurrent} disabled={!v1.length} className="rounded-xl bg-violet-500/20 px-4 py-2 text-xs font-black text-violet-100 disabled:opacity-30">ADD TO QUEUE</button><button onClick={runQueue} disabled={queueRunning || !queue.some(job=>job.status==='queued')} className="rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-2 text-xs font-black disabled:opacity-30">{queueRunning?'QUEUE RUNNING...':'RUN QUEUE'}</button></div>
    </header>

    <section className="mt-3 grid gap-3 2xl:grid-cols-[330px_minmax(0,1fr)_390px]">
      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">MEDIA BINS</p><button onClick={createBin} className="rounded-lg border border-white/10 px-2 py-1 text-[8px] font-black">+ BIN</button></div><div className="mt-3 flex flex-wrap gap-1"><button onClick={()=>setActiveBin('All Media')} className={`rounded-lg px-2 py-1 text-[8px] ${activeBin==='All Media'?'bg-white text-black':'border border-white/10'}`}>All Media</button>{bins.map(bin=><button key={bin} onClick={()=>setActiveBin(bin)} className={`rounded-lg px-2 py-1 text-[8px] ${activeBin===bin?'bg-white text-black':'border border-white/10'}`}>{bin}</button>)}</div><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="بحث في الوسائط..." className="mt-3 w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-[9px] outline-none"/><div className="mt-3 grid grid-cols-2 gap-2"><label className="cursor-pointer rounded-xl border border-dashed border-violet-300/20 p-2 text-center text-[8px] font-black"><UploadCloud className="mx-auto mb-1 h-4 w-4"/>VIDEO<input type="file" multiple accept="video/*" className="hidden" onChange={addVideoFiles}/></label><label className="cursor-pointer rounded-xl border border-dashed border-cyan-300/20 p-2 text-center text-[8px] font-black"><Music2 className="mx-auto mb-1 h-4 w-4"/>AUDIO<input type="file" accept="audio/*" className="hidden" onChange={addAudioFile}/></label></div><div className="mt-3 max-h-72 space-y-2 overflow-auto">{visibleVideos.map(({asset,index})=><button key={`v-${index}`} onClick={()=>chooseSource(index)} className={`w-full rounded-xl border p-2 text-left ${sourceIndex===index?'border-violet-300/40 bg-violet-300/10':'border-white/8'}`}><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg bg-violet-300/10 text-[8px] font-black">V{index+1}</span><div className="min-w-0 flex-1"><p className="truncate text-[9px] font-bold">{asset.file.name}</p><p className="text-[8px] text-slate-600">{fmt(asset.duration)} · {asset.bin}</p></div><select value={asset.bin} onClick={e=>e.stopPropagation()} onChange={e=>moveVideoToBin(index,e.target.value)} className="max-w-20 rounded-lg border border-white/10 bg-[#0b111d] p-1 text-[7px]">{bins.map(bin=><option key={bin}>{bin}</option>)}</select></div></button>)}{visibleAudios.map(({asset,index})=><div key={`a-${index}`} className="rounded-xl border border-cyan-300/10 p-2"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg bg-cyan-300/10 text-[8px] font-black">A{index+1}</span><div className="min-w-0 flex-1"><p className="truncate text-[9px] font-bold">{asset.file.name}</p><p className="text-[8px] text-slate-600">{fmt(asset.duration)}</p></div><select value={asset.bin} onChange={e=>moveAudioToBin(index,e.target.value)} className="max-w-20 rounded-lg border border-white/10 bg-[#0b111d] p-1 text-[7px]">{bins.map(bin=><option key={bin}>{bin}</option>)}</select></div></div>)}</div></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><p className="text-[10px] font-black tracking-widest text-slate-500">SOURCE MONITOR</p><div className="mt-3 aspect-video overflow-hidden rounded-xl bg-black">{sourceAsset?<video ref={sourceRef} src={sourceAsset.url} controls className="h-full w-full object-contain"/>:<div className="grid h-full place-items-center text-[9px] text-slate-700">اختر Media</div>}</div>{sourceAsset&&<><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={()=>setSourceIn(sourceRef.current?.currentTime||0)} className="rounded-lg border border-cyan-300/20 p-2 text-[8px] font-black">MARK IN · {fmt(sourceIn)}</button><button onClick={()=>setSourceOut(sourceRef.current?.currentTime||sourceAsset.duration)} className="rounded-lg border border-amber-300/20 p-2 text-[8px] font-black">MARK OUT · {fmt(sourceOut)}</button></div><div className="mt-2 grid grid-cols-3 gap-1">{(['V1','V2','V3'] as VideoLane[]).map(lane=><button key={lane} onClick={()=>insertSource(lane)} className="rounded-lg bg-violet-300/10 p-2 text-[8px] font-black text-violet-100">INSERT {lane}</button>)}</div></>}</div>
      </aside>

      <div className="min-w-0 space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="flex items-center justify-between"><div><p className="text-xs font-black">PROGRAM MONITOR</p><p className="mt-1 text-[9px] text-slate-600">{fmt(playhead)} · V1 + V2/V3 overlays</p></div><button onClick={toggleProgram} disabled={!programClip} className="rounded-xl bg-white px-4 py-2 text-xs font-black text-black disabled:opacity-30">{programPlaying?<Pause className="mr-1 inline h-4 w-4"/>:<Play className="mr-1 inline h-4 w-4"/>}{programPlaying?'إيقاف':'تشغيل'}</button></div><div className="relative mt-3 aspect-video overflow-hidden rounded-2xl border border-white/10 bg-black">{programAsset&&programClip?<video ref={programRef} src={programAsset.url} className="h-full w-full object-contain" onTimeUpdate={onProgramTime} onPause={()=>setProgramPlaying(false)} onPlay={()=>setProgramPlaying(true)} playsInline/>:<div className="grid h-full place-items-center"><Film className="h-12 w-12 text-slate-800"/></div>}{activeOverlays.map((clip)=>{const asset=videos[clip.fileIndex];if(!asset)return null;const isV2=clip.lane==='V2';return <video key={clip.id} src={asset.url} muted={!clip.linkedAudio} autoPlay={programPlaying} loop playsInline className="absolute rounded-lg border border-white/20 bg-black object-cover" style={{width:isV2?'38%':'28%',right:isV2?'3%':'auto',left:isV2?'auto':'3%',bottom:isV2?'4%':'auto',top:isV2?'auto':'4%'}}/>})}</div><input type="range" min="0" max={Math.max(.1,projectDuration)} step=".02" value={Math.min(playhead,projectDuration)} onChange={e=>setPlayhead(Number(e.target.value))} className="mt-3 w-full accent-red-400"/></div>

        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-black">PRO MULTI‑TRACK TIMELINE</p><p className="mt-1 text-[9px] text-slate-600">V1/V2/V3 · A1/A2/A3 · Detach/Relink audio · Adjustment lane</p></div><input type="range" min="4" max="34" value={timelineZoom} onChange={e=>setTimelineZoom(Number(e.target.value))} className="w-32 accent-cyan-300"/></div><div className="overflow-x-auto rounded-2xl border border-white/8 bg-black/20"><div className="relative h-[430px]" style={{width:timelineWidth}}><div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-red-400" style={{left:110+playhead*timelineZoom}}/>{(['V3','V2','V1','A1','A2','A3'] as Array<VideoLane|AudioLane>).map(lane=><div key={lane} className="absolute left-0 right-0 h-[64px] border-b border-white/5" style={{top:laneTop[lane]}}><div className="sticky left-0 z-30 grid h-full w-[100px] place-items-center bg-[#080d17] text-[9px] font-black text-slate-500">{lane}</div></div>)}<div className="absolute left-0 right-0 top-[384px] h-[46px]"><div className="sticky left-0 z-30 grid h-full w-[100px] place-items-center bg-[#080d17] text-[8px] font-black text-amber-300">ADJUST</div></div>
          {clips.map((clip)=>{const top=laneTop[clip.lane],width=Math.max(78,clipDuration(clip)*timelineZoom);return <button key={clip.id} onClick={()=>{setSelectedClipId(clip.id);setSelectedAudioId(null);setPlayhead(clip.startAt)}} className={`absolute z-10 h-12 overflow-hidden rounded-xl border px-2 text-left ${selectedClipId===clip.id?'border-violet-200 bg-violet-400/25':'border-violet-300/15 bg-violet-400/10'}`} style={{left:110+clip.startAt*timelineZoom,top:top+7,width}}><span className="text-[8px] font-black">{clip.lane} · CAM {clip.fileIndex+1}</span><span className="mt-1 block text-[7px] text-slate-500">{clip.linkedAudio?'🔗 AUDIO':'VIDEO ONLY'}</span></button>})}
          {audioTracks.map((track)=>{const width=Math.max(78,(track.sourceEnd-track.sourceStart)*timelineZoom);return <button key={track.id} onClick={()=>{setSelectedAudioId(track.id);setSelectedClipId(null);setPlayhead(track.startAt)}} className={`absolute z-10 h-12 overflow-hidden rounded-xl border px-2 text-left ${selectedAudioId===track.id?'border-cyan-200 bg-cyan-400/25':'border-cyan-300/15 bg-cyan-400/10'}`} style={{left:110+track.startAt*timelineZoom,top:laneTop[track.lane]+7,width}}><span className="text-[8px] font-black">{track.lane} · {track.linkedClipId?'DETACHED':'AUDIO'}</span><span className="mt-1 block truncate text-[7px] text-slate-500">{track.name}</span></button>})}
          {adjustments.map(layer=><button key={layer.id} onClick={()=>setPlayhead(layer.startAt)} className="absolute z-10 h-8 rounded-lg border border-amber-300/25 bg-amber-300/10 px-2 text-[8px] font-black text-amber-100" style={{left:110+layer.startAt*timelineZoom,top:391,width:Math.max(70,(layer.endAt-layer.startAt)*timelineZoom)}}>{layer.name}</button>)}
        </div></div><div className="mt-3 flex flex-wrap gap-2"><button onClick={splitSelected} disabled={!selectedClip} className="rounded-xl border border-cyan-300/20 px-3 py-2 text-[9px] font-black"><Scissors className="mr-1 inline h-3.5 w-3.5"/>SPLIT</button><button onClick={deleteSelected} disabled={!selectedClip&&!selectedAudio} className="rounded-xl border border-rose-300/20 px-3 py-2 text-[9px] text-rose-200"><Trash2 className="mr-1 inline h-3.5 w-3.5"/>DELETE</button></div></div>

        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="flex items-center justify-between"><div><p className="text-xs font-black">LIVE MULTI‑CAM SWITCHER</p><p className="mt-1 text-[9px] text-slate-600">ابدأ التشغيل ثم اضغط على أي كاميرا أثناء المشاهدة لتسجيل Cut لحظي.</p></div><Camera className="h-5 w-5 text-emerald-300"/></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{videos.slice(0,8).map((asset,index)=>{const active=multicam.cameras.includes(index);return <div key={index} className={`rounded-xl border p-2 ${active?'border-emerald-300/30 bg-emerald-300/[.04]':'border-white/8'}`}><button onClick={()=>active&&liveCut(index)} className="block w-full"><video ref={node=>{multicamRefs.current[index]=node}} src={asset.url} muted playsInline onTimeUpdate={e=>{if(multicamLive&&multicam.cameras[0]===index)setMulticamTime(Math.max(0,e.currentTarget.currentTime-(multicam.offsets[index]||0)))}} className="aspect-video w-full rounded-lg bg-black object-contain"/></button><div className="mt-2 flex items-center gap-2"><button onClick={()=>toggleCamera(index)} className={`rounded-lg px-2 py-1 text-[8px] font-black ${active?'bg-emerald-300 text-black':'border border-white/10'}`}>CAM {index+1}</button>{active&&<input type="number" step=".1" value={multicam.offsets[index]||0} onChange={e=>setMulticam(state=>({...state,offsets:{...state.offsets,[index]:Number(e.target.value)||0}}))} className="w-16 rounded-lg border border-white/10 bg-black/30 p-1 text-[8px]"/>}</div></div>})}</div><div className="mt-3 flex flex-wrap items-center gap-2"><button onClick={multicamLive?stopMulticamLive:startMulticamLive} disabled={!multicam.cameras.length} className={`rounded-xl px-4 py-2 text-[9px] font-black ${multicamLive?'bg-rose-400/20 text-rose-100':'bg-emerald-300/15 text-emerald-100'}`}>{multicamLive?'STOP LIVE':'START LIVE'}</button><span className="text-[9px] text-slate-500">LIVE {fmt(multicamTime)} · {multicam.cuts.length} cuts</span><button onClick={bakeMulticam} disabled={!multicam.cameras.length||!multicam.duration} className="ml-auto rounded-xl bg-violet-300/10 px-4 py-2 text-[9px] font-black text-violet-100 disabled:opacity-30">BAKE TO V1</button></div></div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">INSPECTOR</p><SlidersHorizontal className="h-4 w-4 text-cyan-300"/></div>{selectedClip?<div className="mt-4 space-y-3"><p className="truncate text-xs font-black">{videos[selectedClip.fileIndex]?.file.name}</p><div className="grid grid-cols-2 gap-2"><label className="text-[8px] text-slate-600">LANE<select value={selectedClip.lane} onChange={e=>updateClip(selectedClip.id,{lane:e.target.value as VideoLane})} className="mt-1 w-full rounded-lg border border-white/10 bg-[#0b111d] p-2 text-[9px]"><option>V1</option><option>V2</option><option>V3</option></select></label><label className="text-[8px] text-slate-600">START AT<input type="number" step=".05" value={selectedClip.startAt} onChange={e=>updateClip(selectedClip.id,{startAt:Math.max(0,Number(e.target.value)||0)})} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 p-2 text-[9px]"/></label></div><label className="block text-[8px] text-slate-600">FILTER<select value={selectedClip.filter} onChange={e=>updateClip(selectedClip.id,{filter:e.target.value as VideoFilter})} className="mt-1 w-full rounded-lg border border-white/10 bg-[#0b111d] p-2 text-[9px]">{filters.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</select></label><div className="grid grid-cols-2 gap-2"><label className="text-[8px] text-slate-600">SPEED<input type="number" min=".25" max="4" step=".05" value={selectedClip.speed} onChange={e=>updateClip(selectedClip.id,{speed:clamp(Number(e.target.value),.25,4)})} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 p-2 text-[9px]"/></label><label className="text-[8px] text-slate-600">VOLUME<input type="number" min="0" max="2" step=".05" value={selectedClip.volume} onChange={e=>updateClip(selectedClip.id,{volume:clamp(Number(e.target.value),0,2)})} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 p-2 text-[9px]"/></label></div>{selectedClip.lane==='V1'&&<div className="rounded-xl border border-cyan-300/10 p-3"><p className="text-[9px] font-black text-cyan-100">VIDEO / AUDIO LINK</p><p className="mt-1 text-[8px] text-slate-600">{selectedClip.linkedAudio?'الصوت مرتبط داخل الفيديو.':'الصوت مفصول كـ A1 ويمكن تحريكه مستقلاً.'}</p>{selectedClip.linkedAudio?<button onClick={detachAudio} disabled={detaching} className="mt-2 w-full rounded-lg bg-cyan-300/10 p-2 text-[8px] font-black text-cyan-100">{detaching?'DETACHING...':'DETACH AUDIO → A1'}</button>:<button onClick={relinkAudio} className="mt-2 w-full rounded-lg bg-emerald-300/10 p-2 text-[8px] font-black text-emerald-100">RELINK AUDIO</button>}</div>}</div>:selectedAudio?<div className="mt-4 space-y-3"><p className="truncate text-xs font-black">{selectedAudio.name}</p><div className="grid grid-cols-2 gap-2"><label className="text-[8px] text-slate-600">LANE<select value={selectedAudio.lane} onChange={e=>updateAudio(selectedAudio.id,{lane:e.target.value as AudioLane})} className="mt-1 w-full rounded-lg border border-white/10 bg-[#0b111d] p-2 text-[9px]"><option>A1</option><option>A2</option><option>A3</option></select></label><label className="text-[8px] text-slate-600">START AT<input type="number" step=".05" value={selectedAudio.startAt} onChange={e=>updateAudio(selectedAudio.id,{startAt:Math.max(0,Number(e.target.value)||0)})} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 p-2 text-[9px]"/></label></div><label className="block text-[8px] text-slate-600">VOLUME {selectedAudio.volume.toFixed(2)}<input type="range" min="0" max="2" step=".02" value={selectedAudio.volume} onChange={e=>updateAudio(selectedAudio.id,{volume:Number(e.target.value)})} className="mt-2 w-full accent-cyan-300"/></label></div>:<p className="mt-4 text-[9px] text-slate-600">حدد Clip أو Audio Track.</p>}</div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">ADJUSTMENT / MASTER LUT</p><Layers3 className="h-4 w-4 text-amber-300"/></div><button onClick={addAdjustment} disabled={!v1.length} className="mt-3 w-full rounded-xl border border-amber-300/20 p-2 text-[9px] font-black text-amber-100 disabled:opacity-30"><Plus className="mr-1 inline h-3.5 w-3.5"/>ADD ADJUSTMENT</button><label className="mt-3 block cursor-pointer rounded-xl border border-dashed border-violet-300/20 p-3 text-center text-[8px] font-black">{masterLut?masterLut.name:'MASTER LUT .CUBE'}<input type="file" accept=".cube" className="hidden" onChange={e=>{setMasterLut(e.target.files?.[0]||null);e.target.value=''}}/></label><div className="mt-3 max-h-72 space-y-2 overflow-auto">{adjustments.map(layer=><div key={layer.id} className="rounded-xl border border-amber-300/10 p-3"><div className="flex items-center gap-2"><input value={layer.name} onChange={e=>updateAdjustment(layer.id,{name:e.target.value})} className="min-w-0 flex-1 bg-transparent text-[9px] font-black outline-none"/><button onClick={()=>setAdjustments(state=>state.filter(item=>item.id!==layer.id))} className="text-rose-300"><Trash2 className="h-3.5 w-3.5"/></button></div><div className="mt-2 grid grid-cols-2 gap-2"><input type="number" step=".1" value={layer.startAt} onChange={e=>updateAdjustment(layer.id,{startAt:Math.max(0,Number(e.target.value)||0)})} className="rounded-lg border border-white/10 bg-black/30 p-1.5 text-[8px]"/><input type="number" step=".1" value={layer.endAt} onChange={e=>updateAdjustment(layer.id,{endAt:Math.max(layer.startAt+.05,Number(e.target.value)||0)})} className="rounded-lg border border-white/10 bg-black/30 p-1.5 text-[8px]"/></div><label className="mt-2 block text-[8px] text-slate-600">Brightness {layer.brightness.toFixed(2)}<input type="range" min="-.4" max=".4" step=".02" value={layer.brightness} onChange={e=>updateAdjustment(layer.id,{brightness:Number(e.target.value)})} className="mt-1 w-full accent-amber-300"/></label><label className="mt-2 block text-[8px] text-slate-600">Contrast {layer.contrast.toFixed(2)}<input type="range" min=".6" max="1.8" step=".02" value={layer.contrast} onChange={e=>updateAdjustment(layer.id,{contrast:Number(e.target.value)})} className="mt-1 w-full accent-amber-300"/></label><label className="mt-2 block text-[8px] text-slate-600">Blur {Math.round(layer.blur*100)}%<input type="range" min="0" max="1" step=".05" value={layer.blur} onChange={e=>updateAdjustment(layer.id,{blur:Number(e.target.value)})} className="mt-1 w-full accent-amber-300"/></label></div>)}</div></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">MIXER</p><Gauge className="h-4 w-4 text-emerald-300"/></div>{(['video','music','pip','master'] as const).map(key=><label key={key} className="mt-3 block text-[8px] uppercase text-slate-500">{key} · {Math.round(mixer[key]*100)}%<input type="range" min="0" max="1.5" step=".01" value={mixer[key]} onChange={e=>setMixer(state=>({...state,[key]:Number(e.target.value)}))} className="mt-1 w-full accent-emerald-300"/></label>)}</div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">RENDER QUEUE</p><ListVideo className="h-4 w-4 text-violet-300"/></div><div className="mt-3 space-y-2">{queue.map(job=><div key={job.id} className="rounded-xl border border-white/8 p-3"><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${job.status==='done'?'bg-emerald-300':job.status==='failed'?'bg-rose-300':job.status==='rendering'?'animate-pulse bg-amber-300':'bg-slate-600'}`}/><p className="text-[9px] font-black">{job.name}</p><button onClick={()=>setQueue(state=>state.filter(item=>item.id!==job.id))} disabled={job.status==='rendering'} className="ml-auto text-rose-300 disabled:opacity-30"><Trash2 className="h-3.5 w-3.5"/></button></div><p className="mt-1 text-[8px] text-slate-600">{job.status.toUpperCase()}</p>{job.url&&<a href={job.url} download={`MAGHRABI-${job.name}.mp4`} className="mt-2 flex items-center justify-center gap-1 rounded-lg bg-white p-2 text-[8px] font-black text-black"><Download className="h-3 w-3"/>DOWNLOAD</a>}{job.error&&<p className="mt-2 text-[8px] text-rose-300">{job.error}</p>}</div>)}{!queue.length&&<p className="text-[8px] text-slate-600">أضف أكثر من إعداد تصدير ثم شغّل Queue بالتسلسل.</p>}</div></div>

        {error&&<div className="rounded-2xl border border-rose-300/20 bg-rose-300/10 p-3 text-[9px] leading-5 text-rose-200">{error}</div>}
      </aside>
    </section>
  </div></main>
}
