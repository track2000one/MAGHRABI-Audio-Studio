import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock3,
  Download,
  Film,
  FolderOpen,
  Gauge,
  History,
  Pause,
  Play,
  RefreshCcw,
  Save,
  Scissors,
  SkipBack,
  SkipForward,
  Trash2,
  UploadCloud,
  WandSparkles,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import {
  AudioTrackManifest,
  deleteVideoProxyJobV13,
  deleteVideoRenderJobV12,
  enqueueVideoProjectV12,
  enqueueVideoProxyV13,
  extractVideoAudio,
  getVideoProxyResultV13,
  getVideoRenderResultV12,
  listVideoProxyJobsV13,
  listVideoRenderJobsV12,
  OutputSize,
  PersistentProxyJobV13,
  PersistentRenderJobV12,
  RenderQuality,
  retryVideoProxyJobV13,
  retryVideoRenderJobV12,
  VideoClipManifest,
  VideoFilter,
  VideoOverlayTrackManifest,
  VideoProjectManifestV12,
} from './lib/videoApi'
import { loadStoredVideoProject, saveStoredVideoProject } from './lib/projectStore'
import { deleteProjectVersion, listProjectVersions, ProjectVersion, saveProjectVersion } from './lib/versionStore'

type VideoLane = 'V1' | 'V2' | 'V3'
type AudioLane = 'A1' | 'A2' | 'A3'
type Lane = VideoLane | AudioLane
type PrecisionTool = 'select' | 'ripple' | 'roll' | 'slip' | 'slide' | 'razor'
type VideoAsset = { file: File; url: string; duration: number; proxyUrl?: string | null }
type AudioAsset = { file: File; duration: number }
type TimelineClip = VideoClipManifest & { id: string; lane: VideoLane; startAt: number; detachedAudioId?: string | null }
type TimelineAudio = AudioTrackManifest & { id: string; lane: AudioLane; name: string; linkedClipId?: string | null }
type Selection = { kind: 'video'; id: string } | { kind: 'audio'; id: string } | null

type PrecisionProject = {
  clips: TimelineClip[]
  audioTracks: TimelineAudio[]
  fps: number
  sourceIndex: number | null
  sourceIn: number
  sourceOut: number
  videoTarget: VideoLane
  audioTarget: AudioLane
  patchAudio: boolean
  playhead: number
  rangeIn: number | null
  rangeOut: number | null
  outputSize: OutputSize
  quality: RenderQuality
}

const videoLanes: VideoLane[] = ['V3', 'V2', 'V1']
const audioLanes: AudioLane[] = ['A1', 'A2', 'A3']
const lanes: Lane[] = ['V3', 'V2', 'V1', 'A1', 'A2', 'A3']
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
function isVideoLane(value: Lane): value is VideoLane { return value.startsWith('V') }
function clipDuration(clip: TimelineClip) { return Math.max(.02, (clip.end - clip.start) / Math.max(.25, clip.speed)) }
function audioDuration(track: TimelineAudio) { return Math.max(.02, track.sourceEnd - track.sourceStart) }
function fmt(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const mins = Math.floor(safe / 60)
  return `${String(mins).padStart(2, '0')}:${(safe - mins * 60).toFixed(1).padStart(4, '0')}`
}
function smpte(seconds: number, fps: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const totalFrames = Math.round(safe * fps)
  const frames = totalFrames % fps
  const totalSeconds = Math.floor(totalFrames / fps)
  const secs = totalSeconds % 60
  const mins = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
}
function mediaDuration(file: File, kind: 'video' | 'audio') {
  return new Promise<number>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const element = document.createElement(kind)
    element.preload = 'metadata'
    element.onloadedmetadata = () => { const duration = Number.isFinite(element.duration) ? element.duration : 0; URL.revokeObjectURL(url); resolve(duration) }
    element.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`تعذر قراءة ${file.name}`)) }
    element.src = url
  })
}
function makeClip(fileIndex: number, start: number, end: number, lane: VideoLane, startAt: number): TimelineClip {
  return {
    id: uid(), fileIndex, lane, startAt, start, end, speed: 1, volume: 1, filter: 'none', text: '', textSize: 48,
    textPosition: 'bottom', rotation: 0, fit: 'contain', zoomStart: 1, zoomEnd: 1, panXStart: 0, panXEnd: 0,
    panYStart: 0, panYEnd: 0, chromaEnabled: false, chromaColor: '#00ff00', chromaBackground: '#101010',
    chromaSimilarity: .18, chromaBlend: .06, brightness: 0, contrast: 1, saturation: 1, temperature: 0,
    vignette: 0, speedRamp: 'off', reverse: false, freezeFrame: false, freezeDuration: 2, privacyEffect: 'none',
    privacyX: .35, privacyY: .3, privacyWidth: .3, privacyHeight: .22, privacyIntensity: .55,
    transformKeyframes: [], audioLead: 0, audioTail: 0, audioFadeIn: 0, audioFadeOut: 0, audioAutomation: [],
    groupId: null, detachedAudioId: null,
  }
}

function TrimFrame({ url, time, label }: { url?: string | null; time: number; label: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video || !url) return
    const seek = () => { try { video.currentTime = Math.max(0, time) } catch {} }
    if (video.readyState >= 1) seek()
    else video.addEventListener('loadedmetadata', seek, { once: true })
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [url, time])
  return <div className="overflow-hidden rounded-xl border border-white/10 bg-black"><div className="aspect-video">{url ? <video ref={ref} src={url} muted playsInline className="h-full w-full object-contain"/> : <div className="grid h-full place-items-center text-[8px] text-slate-700">NO FRAME</div>}</div><div className="border-t border-white/8 px-2 py-1 text-[7px] font-black text-slate-500">{label}</div></div>
}

export default function VideoStudioV13() {
  const sourceRef = useRef<HTMLVideoElement>(null)
  const programRef = useRef<HTMLVideoElement>(null)
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [videos, setVideos] = useState<VideoAsset[]>([])
  const [audios, setAudios] = useState<AudioAsset[]>([])
  const [clips, setClips] = useState<TimelineClip[]>([])
  const [audioTracks, setAudioTracks] = useState<TimelineAudio[]>([])
  const [selection, setSelection] = useState<Selection>(null)
  const [sourceIndex, setSourceIndex] = useState<number | null>(null)
  const [sourceIn, setSourceIn] = useState(0)
  const [sourceOut, setSourceOut] = useState(0)
  const [videoTarget, setVideoTarget] = useState<VideoLane>('V1')
  const [audioTarget, setAudioTarget] = useState<AudioLane>('A1')
  const [patchAudio, setPatchAudio] = useState(true)
  const [playhead, setPlayhead] = useState(0)
  const [programPlaying, setProgramPlaying] = useState(false)
  const [tool, setTool] = useState<PrecisionTool>('select')
  const [fps, setFps] = useState(30)
  const [timelineZoom, setTimelineZoom] = useState(18)
  const [rangeIn, setRangeIn] = useState<number | null>(null)
  const [rangeOut, setRangeOut] = useState<number | null>(null)
  const [outputSize, setOutputSize] = useState<OutputSize>('720p')
  const [quality, setQuality] = useState<RenderQuality>('standard')
  const [renderJobs, setRenderJobs] = useState<PersistentRenderJobV12[]>([])
  const [proxyJobs, setProxyJobs] = useState<PersistentProxyJobV13[]>([])
  const [versions, setVersions] = useState<ProjectVersion<PrecisionProject>[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirtyTick, setDirtyTick] = useState(0)

  useEffect(() => { getAuthStatus().then((status) => setAuthorized(status.authenticated)).catch(() => setAuthorized(false)) }, [])
  useEffect(() => {
    if (!authorized) return
    const refresh = () => {
      listVideoRenderJobsV12().then(setRenderJobs).catch(() => undefined)
      listVideoProxyJobsV13().then(setProxyJobs).catch(() => undefined)
    }
    refresh()
    const timer = window.setInterval(refresh, 2500)
    return () => window.clearInterval(timer)
  }, [authorized])
  useEffect(() => { if (authorized) listProjectVersions<PrecisionProject>().then(setVersions).catch(() => undefined) }, [authorized])

  const selectedClip = selection?.kind === 'video' ? clips.find((clip) => clip.id === selection.id) || null : null
  const selectedAudio = selection?.kind === 'audio' ? audioTracks.find((track) => track.id === selection.id) || null : null
  const sourceAsset = sourceIndex !== null ? videos[sourceIndex] : null
  const v1 = useMemo(() => [...clips.filter((clip) => clip.lane === 'V1')].sort((a, b) => a.startAt - b.startAt), [clips])
  const projectDuration = Math.max(
    ...clips.map((clip) => clip.startAt + clipDuration(clip)),
    ...audioTracks.map((track) => track.startAt + audioDuration(track)),
    0,
  )
  const programClip = v1.find((clip) => playhead >= clip.startAt && playhead < clip.startAt + clipDuration(clip)) || null
  const programAsset = programClip ? videos[programClip.fileIndex] : null
  const activeOverlays = clips.filter((clip) => clip.lane !== 'V1' && playhead >= clip.startAt && playhead < clip.startAt + clipDuration(clip))
  const timelineWidth = Math.max(1280, projectDuration * timelineZoom + 150)

  const sameLaneSorted = selectedClip ? [...clips.filter((clip) => clip.lane === selectedClip.lane)].sort((a, b) => a.startAt - b.startAt) : []
  const selectedLaneIndex = selectedClip ? sameLaneSorted.findIndex((clip) => clip.id === selectedClip.id) : -1
  const previousClip = selectedLaneIndex > 0 ? sameLaneSorted[selectedLaneIndex - 1] : null
  const nextClip = selectedLaneIndex >= 0 ? sameLaneSorted[selectedLaneIndex + 1] || null : null
  const frame = 1 / fps
  const prevAsset = previousClip ? videos[previousClip.fileIndex] : null
  const nextAsset = selectedClip ? videos[selectedClip.fileIndex] : null

  const markDirty = () => setDirtyTick((value) => value + 1)
  const updateClip = (id: string, changes: Partial<TimelineClip>) => { setClips((state) => state.map((clip) => clip.id === id ? { ...clip, ...changes } : clip)); markDirty() }
  const updateAudio = (id: string, changes: Partial<TimelineAudio>) => { setAudioTracks((state) => state.map((track) => track.id === id ? { ...track, ...changes } : track)); markDirty() }

  const currentProject = (): PrecisionProject => ({
    clips, audioTracks, fps, sourceIndex, sourceIn, sourceOut, videoTarget, audioTarget, patchAudio, playhead, rangeIn, rangeOut, outputSize, quality,
  })

  const saveSnapshot = async (automatic: boolean) => {
    if (!videos.length) return
    const project = currentProject()
    await saveStoredVideoProject<PrecisionProject>({
      version: 3,
      savedAt: new Date().toISOString(),
      project,
      videos: videos.map((item) => item.file),
      videoDurations: videos.map((item) => item.duration),
      audios: audios.map((item) => item.file),
      audioDurations: audios.map((item) => item.duration),
      images: [],
      outputSize,
      quality,
    })
    const savedAt = new Date().toISOString()
    await saveProjectVersion<PrecisionProject>({
      id: `${automatic ? 'auto' : 'manual'}-${Date.now()}`,
      savedAt,
      label: automatic ? `Autosave · ${new Date().toLocaleTimeString('ar-SA')}` : `Manual · ${new Date().toLocaleTimeString('ar-SA')}`,
      automatic,
      project,
      outputSize,
      quality,
      fps,
    })
    setVersions(await listProjectVersions<PrecisionProject>())
  }

  useEffect(() => {
    if (!authorized || !videos.length || dirtyTick === 0) return
    const timer = window.setTimeout(() => saveSnapshot(true).catch(() => undefined), 60000)
    return () => window.clearTimeout(timer)
  }, [authorized, dirtyTick, videos.length])

  const restoreProjectState = (project: PrecisionProject) => {
    setClips((project.clips || []).map((clip) => ({ ...clip, id: clip.id || uid() })))
    setAudioTracks((project.audioTracks || []).map((track) => ({ ...track, id: track.id || uid() })))
    setFps(project.fps || 30)
    setSourceIndex(project.sourceIndex ?? null)
    setSourceIn(project.sourceIn || 0)
    setSourceOut(project.sourceOut || 0)
    setVideoTarget(project.videoTarget || 'V1')
    setAudioTarget(project.audioTarget || 'A1')
    setPatchAudio(project.patchAudio !== false)
    setPlayhead(project.playhead || 0)
    setRangeIn(project.rangeIn ?? null)
    setRangeOut(project.rangeOut ?? null)
    setOutputSize(project.outputSize || '720p')
    setQuality(project.quality || 'standard')
    setSelection(null)
  }

  const restoreLatestMedia = async () => {
    const snapshot = await loadStoredVideoProject<PrecisionProject>()
    if (!snapshot) throw new Error('لا يوجد Media Snapshot محفوظ للمشروع.')
    setVideos(snapshot.videos.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: snapshot.videoDurations[index] || 0, proxyUrl: null })))
    setAudios(snapshot.audios.map((file, index) => ({ file, duration: snapshot.audioDurations[index] || 0 })))
    return snapshot
  }

  const restoreVersion = async (version: ProjectVersion<PrecisionProject>) => {
    try {
      await restoreLatestMedia()
      restoreProjectState(version.project)
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر استعادة النسخة.') }
  }

  const restoreCurrent = async () => {
    try {
      const snapshot = await restoreLatestMedia()
      restoreProjectState(snapshot.project)
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر استعادة المشروع.') }
  }

  const addVideos = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).slice(0, Math.max(0, 16 - videos.length))
    if (!files.length) return
    try {
      const durations = await Promise.all(files.map((file) => mediaDuration(file, 'video')))
      const base = videos.length
      const assets = files.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: durations[index], proxyUrl: null }))
      setVideos((state) => [...state, ...assets])
      if (sourceIndex === null) { setSourceIndex(base); setSourceIn(0); setSourceOut(assets[0]?.duration || 0) }
      markDirty(); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الفيديو.') }
    event.target.value = ''
  }

  const addAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const duration = await mediaDuration(file, 'audio')
      const fileIndex = audios.length
      setAudios((state) => [...state, { file, duration }])
      const track: TimelineAudio = { id: uid(), lane: audioTarget, name: file.name, fileIndex, startAt: playhead, sourceStart: 0, sourceEnd: duration, volume: .75, fadeIn: .2, fadeOut: .4, automation: [], linkedClipId: null }
      setAudioTracks((state) => [...state, track]); setSelection({ kind: 'audio', id: track.id }); markDirty()
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الصوت.') }
    event.target.value = ''
  }

  const chooseSource = (index: number) => {
    setSourceIndex(index); setSourceIn(0); setSourceOut(videos[index]?.duration || 0)
    window.setTimeout(() => { if (sourceRef.current) sourceRef.current.currentTime = 0 }, 0)
  }

  const insertSource = async (mode: 'insert' | 'overwrite') => {
    if (sourceIndex === null || !sourceAsset) return
    const start = clamp(sourceIn, 0, Math.max(0, sourceAsset.duration - .05))
    const end = clamp(sourceOut || sourceAsset.duration, start + .05, sourceAsset.duration)
    const duration = end - start
    if (mode === 'insert') {
      setClips((state) => state.map((clip) => clip.startAt >= playhead ? { ...clip, startAt: clip.startAt + duration } : clip))
      setAudioTracks((state) => state.map((track) => track.startAt >= playhead ? { ...track, startAt: track.startAt + duration } : track))
    } else {
      setClips((state) => state.filter((clip) => clip.lane !== videoTarget || clip.startAt + clipDuration(clip) <= playhead || clip.startAt >= playhead + duration))
      setAudioTracks((state) => state.filter((track) => !patchAudio || track.lane !== audioTarget || track.startAt + audioDuration(track) <= playhead || track.startAt >= playhead + duration))
    }
    const clip = makeClip(sourceIndex, start, end, videoTarget, playhead)
    setClips((state) => [...state, clip]); setSelection({ kind: 'video', id: clip.id })
    if (patchAudio) {
      try {
        const blob = await extractVideoAudio(sourceAsset.file)
        const file = new File([blob], `${sourceAsset.file.name.replace(/\.[^.]+$/, '')}-v13.wav`, { type: 'audio/wav' })
        const fileIndex = audios.length
        const d = await mediaDuration(file, 'audio')
        setAudios((state) => [...state, { file, duration: d }])
        const track: TimelineAudio = { id: uid(), lane: audioTarget, name: `Linked · ${sourceAsset.file.name}`, fileIndex, startAt: playhead, sourceStart: start, sourceEnd: end, volume: 1, fadeIn: 0, fadeOut: 0, automation: [], linkedClipId: clip.id }
        setAudioTracks((state) => [...state, track])
        updateClip(clip.id, { volume: 0, detachedAudioId: track.id })
      } catch (e) { setError(e instanceof Error ? `تم إدراج الفيديو لكن تعذر Patch الصوت: ${e.message}` : 'تعذر Patch الصوت.') }
    }
    setPlayhead(playhead + duration); markDirty()
  }

  useEffect(() => {
    const video = programRef.current
    if (!video || !programClip || !programAsset) return
    const local = clamp(playhead - programClip.startAt, 0, clipDuration(programClip))
    const sourceTime = clamp(programClip.start + local * Math.max(.25, programClip.speed), programClip.start, programClip.end)
    if (Math.abs(video.currentTime - sourceTime) > .12) { try { video.currentTime = sourceTime } catch {} }
    video.playbackRate = programClip.speed
  }, [playhead, programClip?.id, programAsset?.url, programAsset?.proxyUrl])

  const toggleProgram = async () => {
    const video = programRef.current
    if (!video || !programClip) return
    if (video.paused) { await video.play().catch(() => undefined); setProgramPlaying(true) }
    else { video.pause(); setProgramPlaying(false) }
  }

  const onProgramTime = () => {
    const video = programRef.current
    if (!video || !programClip) return
    const next = programClip.startAt + Math.max(0, (video.currentTime - programClip.start) / Math.max(.25, programClip.speed))
    setPlayhead(next)
    if (video.currentTime >= programClip.end - .02) { video.pause(); setProgramPlaying(false) }
  }

  const nudgePlayhead = (frames: number) => setPlayhead((value) => clamp(value + frames / fps, 0, Math.max(projectDuration, 0)))

  const precisionEdit = (direction: -1 | 1) => {
    if (!selectedClip) return
    const step = direction / fps
    const laneClips = [...clips.filter((clip) => clip.lane === selectedClip.lane)].sort((a, b) => a.startAt - b.startAt)
    const index = laneClips.findIndex((clip) => clip.id === selectedClip.id)
    const prev = index > 0 ? laneClips[index - 1] : null
    const next = laneClips[index + 1] || null
    const asset = videos[selectedClip.fileIndex]
    if (!asset) return

    if (tool === 'ripple') {
      const newEnd = clamp(selectedClip.end + step * selectedClip.speed, selectedClip.start + .04, asset.duration)
      const timelineDelta = (newEnd - selectedClip.end) / Math.max(.25, selectedClip.speed)
      setClips((state) => state.map((clip) => {
        if (clip.id === selectedClip.id) return { ...clip, end: newEnd }
        if (clip.startAt >= selectedClip.startAt + clipDuration(selectedClip) - .001) return { ...clip, startAt: Math.max(0, clip.startAt + timelineDelta) }
        return clip
      }))
      setAudioTracks((state) => state.map((track) => track.startAt >= selectedClip.startAt + clipDuration(selectedClip) - .001 ? { ...track, startAt: Math.max(0, track.startAt + timelineDelta) } : track))
    } else if (tool === 'roll' && next) {
      const nextAsset = videos[next.fileIndex]
      if (!nextAsset) return
      const newEnd = clamp(selectedClip.end + step * selectedClip.speed, selectedClip.start + .04, asset.duration)
      const delta = (newEnd - selectedClip.end) / Math.max(.25, selectedClip.speed)
      const newNextStart = clamp(next.start + delta * next.speed, 0, next.end - .04)
      setClips((state) => state.map((clip) => clip.id === selectedClip.id ? { ...clip, end: newEnd } : clip.id === next.id ? { ...clip, start: newNextStart, startAt: Math.max(0, next.startAt + delta) } : clip))
    } else if (tool === 'slip') {
      const sourceDelta = step * selectedClip.speed
      const span = selectedClip.end - selectedClip.start
      let start = selectedClip.start + sourceDelta
      start = clamp(start, 0, Math.max(0, asset.duration - span))
      updateClip(selectedClip.id, { start, end: start + span })
    } else if (tool === 'slide') {
      const newStartAt = Math.max(0, selectedClip.startAt + step)
      const delta = newStartAt - selectedClip.startAt
      const changes = new Map<string, Partial<TimelineClip>>()
      changes.set(selectedClip.id, { startAt: newStartAt })
      if (prev) {
        const prevAsset = videos[prev.fileIndex]
        if (prevAsset) changes.set(prev.id, { end: clamp(prev.end + delta * prev.speed, prev.start + .04, prevAsset.duration) })
      }
      if (next) changes.set(next.id, { start: clamp(next.start + delta * next.speed, 0, next.end - .04), startAt: Math.max(0, next.startAt + delta) })
      setClips((state) => state.map((clip) => changes.has(clip.id) ? { ...clip, ...changes.get(clip.id) } : clip))
    }
    markDirty()
  }

  const razorAtPlayhead = () => {
    const targets = selection?.kind === 'video' ? clips.filter((clip) => clip.id === selection.id) : clips.filter((clip) => playhead > clip.startAt && playhead < clip.startAt + clipDuration(clip))
    if (!targets.length) return
    const ids = new Set(targets.map((clip) => clip.id))
    setClips((state) => state.flatMap((clip) => {
      if (!ids.has(clip.id)) return [clip]
      const local = playhead - clip.startAt
      const sourceAt = clip.start + local * clip.speed
      if (sourceAt <= clip.start + .03 || sourceAt >= clip.end - .03) return [clip]
      return [
        { ...clip, id: uid(), end: sourceAt },
        { ...clip, id: uid(), start: sourceAt, startAt: playhead },
      ]
    }))
    setSelection(null); markDirty()
  }

  const deleteSelection = () => {
    if (selectedClip) setClips((state) => state.filter((clip) => clip.id !== selectedClip.id))
    if (selectedAudio) setAudioTracks((state) => state.filter((track) => track.id !== selectedAudio.id))
    setSelection(null); markDirty()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'ArrowLeft') { event.preventDefault(); nudgePlayhead(event.shiftKey ? -5 : -1) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); nudgePlayhead(event.shiftKey ? 5 : 1) }
      else if (event.key.toLowerCase() === 'k') { event.preventDefault(); programRef.current?.pause(); setProgramPlaying(false) }
      else if (event.key.toLowerCase() === 'l') { event.preventDefault(); toggleProgram().catch(() => undefined) }
      else if (event.key.toLowerCase() === 'j') { event.preventDefault(); nudgePlayhead(-5) }
      else if (event.key.toLowerCase() === 'i') { event.preventDefault(); if (sourceRef.current && sourceAsset) setSourceIn(sourceRef.current.currentTime); else setRangeIn(playhead) }
      else if (event.key.toLowerCase() === 'o') { event.preventDefault(); if (sourceRef.current && sourceAsset) setSourceOut(sourceRef.current.currentTime); else setRangeOut(playhead) }
      else if (event.key === ',') { event.preventDefault(); insertSource('insert').catch(() => undefined) }
      else if (event.key === '.') { event.preventDefault(); insertSource('overwrite').catch(() => undefined) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const dropOnLane = (event: DragEvent<HTMLDivElement>, lane: Lane) => {
    event.preventDefault()
    const raw = event.dataTransfer.getData('application/x-maghrabi-v13')
    if (!raw) return
    try {
      const payload = JSON.parse(raw) as { kind: 'video' | 'audio'; id: string }
      const rect = event.currentTarget.getBoundingClientRect()
      const startAt = Math.max(0, (event.clientX - rect.left) / timelineZoom)
      if (payload.kind === 'video' && isVideoLane(lane)) updateClip(payload.id, { lane, startAt })
      if (payload.kind === 'audio' && !isVideoLane(lane)) updateAudio(payload.id, { lane, startAt })
    } catch {}
  }

  const buildManifest = (): VideoProjectManifestV12 => {
    const main = [...clips.filter((clip) => clip.lane === 'V1')].sort((a, b) => a.startAt - b.startAt).map(({ id: _id, lane: _lane, startAt, detachedAudioId: _detachedAudioId, ...clip }) => ({ ...clip, timelineStartAt: startAt }))
    const overlays: VideoOverlayTrackManifest[] = clips.filter((clip) => clip.lane !== 'V1').map((clip) => ({
      fileIndex: clip.fileIndex,
      startAt: clip.startAt,
      endAt: clip.startAt + clipDuration(clip),
      sourceStart: clip.start,
      sourceEnd: clip.end,
      scale: clip.lane === 'V2' ? .42 : .3,
      opacity: 1,
      x: clip.lane === 'V2' ? .55 : .05,
      y: clip.lane === 'V2' ? .53 : .06,
      borderRadius: .03,
      audioEnabled: clip.volume > 0,
      audioVolume: clip.volume,
    }))
    const manifest = {
      clips: main,
      textTracks: [], subtitleTracks: [], imageTracks: [], videoOverlays: overlays,
      audioTracks: audioTracks.map(({ id: _id, lane: _lane, name: _name, linkedClipId: _linkedClipId, ...track }) => track),
      transition: 'none' as const,
      transitionDuration: .1,
      audioDuckingEnabled: false,
      duckingStrength: .65,
      magneticSnap: true,
    }
    return manifest as unknown as VideoProjectManifestV12
  }

  const enqueueRender = async () => {
    if (!v1.length || busy) { if (!v1.length) setError('V1 لا يحتوي على فيديو للتصدير.'); return }
    setBusy(true); setError(null)
    try {
      await enqueueVideoProjectV12(videos.map((item) => item.file), audios.map((item) => item.file), [], buildManifest(), outputSize, quality, `V13 ${outputSize} ${quality} · ${new Date().toLocaleTimeString('ar-SA')}`)
      setRenderJobs(await listVideoRenderJobsV12())
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة Render.') }
    finally { setBusy(false) }
  }

  const createProxy = async (index: number, profile: '540p' | '720p') => {
    try {
      await enqueueVideoProxyV13(videos[index].file, profile)
      setProxyJobs(await listVideoProxyJobsV13())
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إنشاء Proxy.') }
  }

  const useProxy = async (job: PersistentProxyJobV13) => {
    try {
      const blob = await getVideoProxyResultV13(job.id)
      const url = URL.createObjectURL(blob)
      const index = videos.findIndex((item) => item.file.name === job.sourceName)
      if (index < 0) throw new Error('لم أجد الملف الأصلي المطابق داخل المشروع الحالي.')
      setVideos((state) => state.map((item, i) => i === index ? { ...item, proxyUrl: url } : item))
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر استخدام Proxy.') }
  }

  const downloadRender = async (job: PersistentRenderJobV12) => {
    try {
      const blob = await getVideoRenderResultV12(job.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `MAGHRABI-v13-${job.id.slice(0, 8)}.mp4`; a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تنزيل Render.') }
  }

  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#050710] text-cyan-200">جاري التحقق...</div>
  if (!authorized) return <div className="grid min-h-screen place-items-center bg-[#050710] text-white"><a href="#" className="rounded-2xl bg-white px-6 py-3 font-black text-black">العودة لتسجيل الدخول</a></div>

  return <main className="min-h-screen bg-[#050710] text-slate-100"><div className="mx-auto max-w-[2040px] px-3 py-3 md:px-5">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
      <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-violet-400/10"><Clock3 className="h-5 w-5 text-violet-200"/></div><div><div className="flex items-center gap-2"><h1 className="text-lg font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-violet-300/20 bg-violet-300/[.06] px-2 py-1 text-[9px] font-black text-violet-100">PRECISION V13</span></div><p className="mt-1 text-[10px] text-slate-500">SMPTE · Frame Nudge · Ripple/Roll/Slip/Slide · Trim Monitor · Autosave Recovery · Proxy Queue</p></div></div>
      <div className="flex flex-wrap items-center gap-2"><div className="rounded-xl border border-white/10 bg-black/30 px-4 py-2 font-mono text-sm font-black text-emerald-200">{smpte(playhead, fps)}</div><select value={fps} onChange={e=>setFps(Number(e.target.value))} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 py-2 text-[10px]"><option value={24}>24 fps</option><option value={25}>25 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option></select><button onClick={()=>saveSnapshot(false).catch(e=>setError(e instanceof Error?e.message:'تعذر الحفظ'))} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black"><Save className="mr-1 inline h-3.5 w-3.5"/>SAVE VERSION</button><button onClick={restoreCurrent} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black"><FolderOpen className="mr-1 inline h-3.5 w-3.5"/>RESTORE</button><a href="#video-v12" className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black text-slate-400">V12 Editorial</a><select value={outputSize} onChange={e=>setOutputSize(e.target.value as OutputSize)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="720p">720p</option><option value="1080p">1080p</option><option value="portrait">9:16</option><option value="square">1:1</option></select><select value={quality} onChange={e=>setQuality(e.target.value as RenderQuality)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select><button onClick={enqueueRender} disabled={busy || !v1.length} className="rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-2 text-xs font-black disabled:opacity-30">{busy?'UPLOADING...':'SERVER RENDER'}</button></div>
    </header>

    <section className="mt-3 grid gap-3 2xl:grid-cols-[330px_minmax(0,1fr)_390px]">
      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><p className="text-[10px] font-black tracking-widest text-slate-500">MEDIA / SOURCE</p><div className="mt-3 grid grid-cols-2 gap-2"><label className="cursor-pointer rounded-xl border border-dashed border-violet-300/20 p-3 text-center text-[9px] font-black"><UploadCloud className="mx-auto mb-1 h-4 w-4"/>VIDEO<input type="file" multiple accept="video/*" className="hidden" onChange={addVideos}/></label><label className="cursor-pointer rounded-xl border border-dashed border-cyan-300/20 p-3 text-center text-[9px] font-black"><UploadCloud className="mx-auto mb-1 h-4 w-4"/>AUDIO<input type="file" accept="audio/*" className="hidden" onChange={addAudio}/></label></div><div className="mt-3 max-h-72 space-y-2 overflow-auto">{videos.map((asset,index)=><div key={`${asset.file.name}-${index}`} className={`rounded-xl border p-2 ${sourceIndex===index?'border-violet-300/35 bg-violet-300/10':'border-white/8'}`}><button onClick={()=>chooseSource(index)} className="w-full text-left"><p className="truncate text-[9px] font-black">V{index+1} · {asset.file.name}</p><p className="mt-1 text-[8px] text-slate-600">{fmt(asset.duration)}{asset.proxyUrl?' · PROXY ACTIVE':''}</p></button><div className="mt-2 flex gap-1"><button onClick={()=>createProxy(index,'540p')} className="rounded-lg border border-cyan-300/15 px-2 py-1 text-[7px] font-black text-cyan-100">PROXY 540</button><button onClick={()=>createProxy(index,'720p')} className="rounded-lg border border-cyan-300/15 px-2 py-1 text-[7px] font-black text-cyan-100">PROXY 720</button></div></div>)}</div></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><p className="text-[10px] font-black tracking-widest text-slate-500">SOURCE PATCH</p><div className="mt-3 flex gap-1">{videoLanes.slice().reverse().map(lane=><button key={lane} onClick={()=>setVideoTarget(lane)} className={`flex-1 rounded-lg border py-2 text-[8px] font-black ${videoTarget===lane?'border-violet-300/50 bg-violet-300/10':'border-white/8'}`}>{lane}</button>)}</div><div className="mt-2 flex gap-1">{audioLanes.map(lane=><button key={lane} onClick={()=>setAudioTarget(lane)} className={`flex-1 rounded-lg border py-2 text-[8px] font-black ${audioTarget===lane?'border-cyan-300/50 bg-cyan-300/10':'border-white/8'}`}>{lane}</button>)}</div><button onClick={()=>setPatchAudio(v=>!v)} className={`mt-2 w-full rounded-lg border py-2 text-[8px] font-black ${patchAudio?'border-emerald-300/35 bg-emerald-300/10 text-emerald-100':'border-white/8 text-slate-600'}`}>AUDIO PATCH {patchAudio?'ON':'OFF'}</button></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">PROJECT RECOVERY</p><History className="h-4 w-4 text-amber-300"/></div><p className="mt-2 text-[8px] leading-4 text-slate-600">Autosave كل 60 ثانية عند وجود تغييرات. يحتفظ بآخر 12 نسخة تحريرية.</p><div className="mt-3 max-h-64 space-y-2 overflow-auto">{versions.map(version=><div key={version.id} className="rounded-xl border border-white/8 p-2"><p className="text-[8px] font-black">{version.label}</p><p className="mt-1 text-[7px] text-slate-600">{new Date(version.savedAt).toLocaleString('ar-SA')} · {version.fps} fps</p><div className="mt-2 flex gap-1"><button onClick={()=>restoreVersion(version)} className="flex-1 rounded-lg bg-amber-300/10 p-1.5 text-[7px] font-black text-amber-100">RECOVER</button><button onClick={()=>deleteProjectVersion(version.id).then(()=>listProjectVersions<PrecisionProject>().then(setVersions)).catch(()=>undefined)} className="rounded-lg border border-rose-300/15 px-2 text-rose-300"><Trash2 className="h-3 w-3"/></button></div></div>)}</div></div>
      </aside>

      <div className="min-w-0 space-y-3">
        <div className="grid gap-3 xl:grid-cols-2"><div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-2 flex items-center justify-between"><div><p className="text-xs font-black">SOURCE MONITOR</p><p className="mt-1 max-w-[320px] truncate text-[9px] text-slate-600">{sourceAsset?.file.name||'اختر Media'}</p></div><span className="font-mono text-[9px] text-violet-200">{sourceAsset?smpte(sourceRef.current?.currentTime||0,fps):'--:--:--:--'}</span></div><div className="aspect-video overflow-hidden rounded-2xl bg-black">{sourceAsset?<video ref={sourceRef} src={sourceAsset.proxyUrl||sourceAsset.url} controls className="h-full w-full object-contain"/>:<div className="grid h-full place-items-center"><Film className="h-10 w-10 text-slate-800"/></div>}</div><div className="mt-3 flex flex-wrap gap-2"><button onClick={()=>setSourceIn(sourceRef.current?.currentTime||0)} className="rounded-xl border border-violet-300/20 px-3 py-2 text-[8px] font-black">I · MARK IN</button><button onClick={()=>setSourceOut(sourceRef.current?.currentTime||sourceAsset?.duration||0)} className="rounded-xl border border-violet-300/20 px-3 py-2 text-[8px] font-black">O · MARK OUT</button><button onClick={()=>insertSource('insert')} className="ml-auto rounded-xl bg-emerald-300/10 px-3 py-2 text-[8px] font-black text-emerald-100">, INSERT</button><button onClick={()=>insertSource('overwrite')} className="rounded-xl bg-rose-300/10 px-3 py-2 text-[8px] font-black text-rose-100">. OVERWRITE</button></div><p className="mt-2 text-[8px] text-slate-600">IN {smpte(sourceIn,fps)} · OUT {smpte(sourceOut,fps)}</p></div>
          <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-2 flex items-center justify-between"><div><p className="text-xs font-black">PROGRAM MONITOR</p><p className="mt-1 text-[9px] text-slate-600">J/K/L · ←/→ = 1 frame · Shift = 5 frames</p></div><span className="font-mono text-[10px] font-black text-emerald-200">{smpte(playhead,fps)}</span></div><div className="relative aspect-video overflow-hidden rounded-2xl bg-black">{programAsset&&programClip?<video key={programClip.id} ref={programRef} src={programAsset.proxyUrl||programAsset.url} className="h-full w-full object-contain" onTimeUpdate={onProgramTime} onPlay={()=>setProgramPlaying(true)} onPause={()=>setProgramPlaying(false)} playsInline/>:<div className="grid h-full place-items-center text-[9px] text-slate-700">BLACK / GAP</div>}{activeOverlays.map(clip=>{const asset=videos[clip.fileIndex];return asset?<video key={clip.id} src={asset.proxyUrl||asset.url} muted autoPlay={programPlaying} loop playsInline className={`absolute object-cover shadow-xl ${clip.lane==='V2'?'bottom-4 right-4 w-[38%]':'left-4 top-4 w-[28%]'}`}/>:null})}</div><div className="mt-3 flex flex-wrap items-center gap-2"><button onClick={()=>nudgePlayhead(-1)} className="rounded-xl border border-white/10 p-2"><SkipBack className="h-4 w-4"/></button><button onClick={toggleProgram} className="rounded-xl bg-white px-4 py-2 text-[9px] font-black text-black">{programPlaying?<Pause className="mr-1 inline h-4 w-4"/>:<Play className="mr-1 inline h-4 w-4"/>}{programPlaying?'K PAUSE':'L PLAY'}</button><button onClick={()=>nudgePlayhead(1)} className="rounded-xl border border-white/10 p-2"><SkipForward className="h-4 w-4"/></button><button onClick={()=>setRangeIn(playhead)} className="rounded-xl border border-amber-300/20 px-3 py-2 text-[8px] font-black">TIMELINE IN</button><button onClick={()=>setRangeOut(playhead)} className="rounded-xl border border-amber-300/20 px-3 py-2 text-[8px] font-black">TIMELINE OUT</button></div></div></div>

        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-black">FOUR-UP TRIM MONITOR</p><p className="mt-1 text-[9px] text-slate-600">Outgoing -2f / -1f · Incoming +0f / +1f</p></div><span className="font-mono text-[9px] text-amber-200">{selectedClip?smpte(selectedClip.startAt,fps):'SELECT CLIP'}</span></div><div className="grid grid-cols-2 gap-2 md:grid-cols-4"><TrimFrame url={prevAsset?.proxyUrl||prevAsset?.url} time={previousClip?Math.max(previousClip.start,previousClip.end-2*frame):0} label="OUT -2f"/><TrimFrame url={prevAsset?.proxyUrl||prevAsset?.url} time={previousClip?Math.max(previousClip.start,previousClip.end-frame):0} label="OUT -1f"/><TrimFrame url={nextAsset?.proxyUrl||nextAsset?.url} time={selectedClip?.start||0} label="IN +0f"/><TrimFrame url={nextAsset?.proxyUrl||nextAsset?.url} time={(selectedClip?.start||0)+frame} label="IN +1f"/></div></div>

        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex flex-wrap items-center gap-2">{(['select','ripple','roll','slip','slide','razor'] as PrecisionTool[]).map(item=><button key={item} onClick={()=>setTool(item)} className={`rounded-xl border px-3 py-2 text-[8px] font-black uppercase ${tool===item?'border-cyan-300/45 bg-cyan-300/10 text-cyan-100':'border-white/10 text-slate-500'}`}>{item}</button>)}<button onClick={()=>precisionEdit(-1)} disabled={!selectedClip||!['ripple','roll','slip','slide'].includes(tool)} className="ml-auto rounded-xl border border-violet-300/20 px-3 py-2 text-[8px] font-black disabled:opacity-30">-1 FRAME</button><button onClick={()=>precisionEdit(1)} disabled={!selectedClip||!['ripple','roll','slip','slide'].includes(tool)} className="rounded-xl border border-violet-300/20 px-3 py-2 text-[8px] font-black disabled:opacity-30">+1 FRAME</button><button onClick={razorAtPlayhead} className="rounded-xl border border-rose-300/20 px-3 py-2 text-[8px] font-black text-rose-100"><Scissors className="mr-1 inline h-3 w-3"/>RAZOR</button><input type="range" min="8" max="40" value={timelineZoom} onChange={e=>setTimelineZoom(Number(e.target.value))} className="w-28 accent-cyan-300"/></div><div className="overflow-x-auto rounded-2xl border border-white/8 bg-black/20"><div className="relative" style={{width:timelineWidth}}><div className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-red-400" style={{left:118+playhead*timelineZoom}}/>{rangeIn!==null&&<div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-amber-300/70" style={{left:118+rangeIn*timelineZoom}}/>}{rangeOut!==null&&<div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-amber-300/70" style={{left:118+rangeOut*timelineZoom}}/>}{lanes.map(lane=><div key={lane} className="flex h-[66px] border-b border-white/5"><div className={`grid w-[118px] shrink-0 place-items-center border-r border-white/8 bg-[#080d17] text-[9px] font-black ${isVideoLane(lane)?'text-violet-300':'text-cyan-300'}`}>{lane}</div><div className="relative flex-1" onDragOver={e=>e.preventDefault()} onDrop={e=>dropOnLane(e,lane)} onClick={e=>{const rect=e.currentTarget.getBoundingClientRect();const t=Math.max(0,(e.clientX-rect.left)/timelineZoom);setPlayhead(t);if(tool==='razor')razorAtPlayhead()}}>{isVideoLane(lane)?clips.filter(clip=>clip.lane===lane).map(clip=><button key={clip.id} draggable onDragStart={e=>e.dataTransfer.setData('application/x-maghrabi-v13',JSON.stringify({kind:'video',id:clip.id}))} onClick={e=>{e.stopPropagation();setSelection({kind:'video',id:clip.id});setPlayhead(clip.startAt)}} className={`absolute top-2 h-12 overflow-hidden rounded-xl border px-2 text-left ${selection?.kind==='video'&&selection.id===clip.id?'border-violet-100 bg-violet-400/25':'border-violet-300/20 bg-violet-400/10'}`} style={{left:clip.startAt*timelineZoom,width:Math.max(62,clipDuration(clip)*timelineZoom)}}><span className="block truncate text-[8px] font-black">{lane} · V{clip.fileIndex+1}</span><span className="mt-1 block font-mono text-[7px] text-slate-500">{smpte(clip.startAt,fps)}</span></button>):audioTracks.filter(track=>track.lane===lane).map(track=><button key={track.id} draggable onDragStart={e=>e.dataTransfer.setData('application/x-maghrabi-v13',JSON.stringify({kind:'audio',id:track.id}))} onClick={e=>{e.stopPropagation();setSelection({kind:'audio',id:track.id});setPlayhead(track.startAt)}} className={`absolute top-2 h-12 overflow-hidden rounded-xl border px-2 text-left ${selection?.kind==='audio'&&selection.id===track.id?'border-cyan-100 bg-cyan-400/25':'border-cyan-300/20 bg-cyan-400/10'}`} style={{left:track.startAt*timelineZoom,width:Math.max(62,audioDuration(track)*timelineZoom)}}><span className="block truncate text-[8px] font-black">{lane} · {track.name}</span><span className="mt-1 block font-mono text-[7px] text-slate-500">{smpte(track.startAt,fps)}</span></button>)}</div></div>)}</div></div></div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">PRECISION INSPECTOR</p><Gauge className="h-4 w-4 text-violet-300"/></div>{selectedClip?<div className="mt-4 space-y-3"><p className="truncate text-xs font-black">{selectedClip.lane} · {videos[selectedClip.fileIndex]?.file.name}</p><div className="grid grid-cols-2 gap-2"><label className="text-[8px] text-slate-600">START AT<input type="number" step={1/fps} value={selectedClip.startAt} onChange={e=>updateClip(selectedClip.id,{startAt:Math.max(0,Number(e.target.value)||0)})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 p-2 text-[9px]"/></label><label className="text-[8px] text-slate-600">LANE<select value={selectedClip.lane} onChange={e=>updateClip(selectedClip.id,{lane:e.target.value as VideoLane})} className="mt-1 w-full rounded-xl border border-white/10 bg-[#0b111d] p-2 text-[9px]">{videoLanes.map(lane=><option key={lane}>{lane}</option>)}</select></label></div><label className="block text-[8px] text-slate-600">FILTER<select value={selectedClip.filter} onChange={e=>updateClip(selectedClip.id,{filter:e.target.value as VideoFilter})} className="mt-1 w-full rounded-xl border border-white/10 bg-[#0b111d] p-2 text-[9px]">{filters.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="block text-[8px] text-slate-600">VOLUME {selectedClip.volume.toFixed(2)}<input type="range" min="0" max="2" step=".02" value={selectedClip.volume} onChange={e=>updateClip(selectedClip.id,{volume:Number(e.target.value)})} className="mt-1 w-full accent-violet-300"/></label><button onClick={deleteSelection} className="w-full rounded-xl border border-rose-300/20 p-2 text-[8px] font-black text-rose-200"><Trash2 className="mr-1 inline h-3 w-3"/>DELETE CLIP</button></div>:selectedAudio?<div className="mt-4 space-y-3"><p className="truncate text-xs font-black">{selectedAudio.lane} · {selectedAudio.name}</p><label className="block text-[8px] text-slate-600">START AT<input type="number" step={1/fps} value={selectedAudio.startAt} onChange={e=>updateAudio(selectedAudio.id,{startAt:Math.max(0,Number(e.target.value)||0)})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 p-2 text-[9px]"/></label><label className="block text-[8px] text-slate-600">VOLUME {selectedAudio.volume.toFixed(2)}<input type="range" min="0" max="2" step=".02" value={selectedAudio.volume} onChange={e=>updateAudio(selectedAudio.id,{volume:Number(e.target.value)})} className="mt-1 w-full accent-cyan-300"/></label><button onClick={deleteSelection} className="w-full rounded-xl border border-rose-300/20 p-2 text-[8px] font-black text-rose-200">DELETE AUDIO</button></div>:<p className="mt-4 text-[9px] text-slate-600">حدد Clip أو Audio من Timeline.</p>}</div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">BACKGROUND PROXY / CONFORM</p><p className="mt-1 text-[8px] text-slate-600">المعاينة تستخدم Proxy؛ Render يستخدم الأصل.</p></div><RefreshCcw className="h-4 w-4 text-cyan-300"/></div><div className="mt-3 max-h-64 space-y-2 overflow-auto">{proxyJobs.map(job=><div key={job.id} className="rounded-xl border border-white/8 p-3"><p className="truncate text-[8px] font-black">{job.sourceName}</p><p className={`mt-1 text-[7px] font-black ${job.status==='done'?'text-emerald-300':job.status==='failed'?'text-rose-300':'text-cyan-300'}`}>{job.status.toUpperCase()} · {job.profile}</p><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-cyan-300/70" style={{width:`${job.status==='processing'?50:job.progress}%`}}/></div><div className="mt-2 flex gap-1">{job.resultReady&&<button onClick={()=>useProxy(job)} className="flex-1 rounded-lg bg-emerald-300/10 p-1.5 text-[7px] font-black text-emerald-100">USE PROXY</button>}{job.status==='failed'&&<button onClick={()=>retryVideoProxyJobV13(job.id).then(()=>listVideoProxyJobsV13().then(setProxyJobs)).catch(()=>undefined)} className="flex-1 rounded-lg bg-amber-300/10 p-1.5 text-[7px] font-black">RETRY</button>}{job.status!=='processing'&&<button onClick={()=>deleteVideoProxyJobV13(job.id).then(()=>listVideoProxyJobsV13().then(setProxyJobs)).catch(()=>undefined)} className="rounded-lg border border-rose-300/15 px-2 text-rose-300"><Trash2 className="h-3 w-3"/></button>}</div></div>)}</div></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">SERVER RENDER QUEUE</p><p className="mt-1 text-[8px] text-slate-600">Persistent على /data.</p></div><WandSparkles className="h-4 w-4 text-emerald-300"/></div><div className="mt-3 max-h-72 space-y-2 overflow-auto">{renderJobs.map(job=><div key={job.id} className="rounded-xl border border-white/8 p-3"><p className="truncate text-[8px] font-black">{job.name}</p><p className={`mt-1 text-[7px] font-black ${job.status==='done'?'text-emerald-300':job.status==='failed'?'text-rose-300':job.status==='rendering'?'text-cyan-300':'text-amber-300'}`}>{job.status.toUpperCase()} · {job.outputSize} · {job.quality}</p><div className="mt-2 flex gap-1">{job.resultReady&&<button onClick={()=>downloadRender(job)} className="flex-1 rounded-lg bg-emerald-300/10 p-1.5 text-[7px] font-black text-emerald-100"><Download className="mr-1 inline h-3 w-3"/>DOWNLOAD</button>}{job.status==='failed'&&<button onClick={()=>retryVideoRenderJobV12(job.id).then(()=>listVideoRenderJobsV12().then(setRenderJobs)).catch(()=>undefined)} className="flex-1 rounded-lg bg-amber-300/10 p-1.5 text-[7px] font-black">RETRY</button>}{job.status!=='rendering'&&<button onClick={()=>deleteVideoRenderJobV12(job.id).then(()=>listVideoRenderJobsV12().then(setRenderJobs)).catch(()=>undefined)} className="rounded-lg border border-rose-300/15 px-2 text-rose-300"><Trash2 className="h-3 w-3"/></button>}</div></div>)}</div></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4 text-[8px] leading-5 text-slate-500"><p className="font-black text-slate-300">KEYBOARD MAP</p><p className="mt-2">J = -5 frames · K = Pause · L = Play</p><p>← / → = ±1 frame · Shift = ±5 frames</p><p>I / O = Source In / Out</p><p>, = Insert · . = Overwrite</p><p>Timeline Range: {rangeIn!==null?smpte(rangeIn,fps):'--'} → {rangeOut!==null?smpte(rangeOut,fps):'--'}</p>{error&&<div className="mt-3 rounded-xl border border-rose-300/20 bg-rose-300/10 p-3 text-rose-200">{error}</div>}</div>
      </aside>
    </section>
  </div></main>
}
