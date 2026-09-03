import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  Film,
  FolderOpen,
  FolderPlus,
  Gauge,
  Layers3,
  Link2,
  ListVideo,
  Lock,
  MousePointer2,
  Pause,
  Play,
  RefreshCcw,
  Save,
  Scissors,
  Target,
  Trash2,
  Unlock,
  UploadCloud,
  WandSparkles,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import {
  AudioTrackManifest,
  deleteVideoRenderJobV12,
  enqueueVideoProjectV12,
  extractVideoAudio,
  getVideoRenderResultV12,
  listVideoRenderJobsV12,
  OutputSize,
  PersistentRenderJobV12,
  RenderQuality,
  retryVideoRenderJobV12,
  VideoClipManifest,
  VideoFilter,
  VideoOverlayTrackManifest,
  VideoProjectManifestV12,
} from './lib/videoApi'
import { loadStoredVideoProject, saveStoredVideoProject } from './lib/projectStore'

type VideoLane = 'V1' | 'V2' | 'V3'
type AudioLane = 'A1' | 'A2' | 'A3'
type LaneKey = VideoLane | AudioLane
type EditMode = 'insert' | 'overwrite'
type ToolMode = 'select' | 'razor'
type Selection = { kind: 'video'; id: string } | { kind: 'audio'; id: string } | null

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
type TrackState = { targeted: boolean; locked: boolean; syncLock: boolean }
type SourcePatch = { videoEnabled: boolean; audioEnabled: boolean; videoLane: VideoLane; audioLane: AudioLane }
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
type DragPayload =
  | { kind: 'video'; id: string }
  | { kind: 'audio'; id: string }
  | { kind: 'video-asset'; index: number }
  | { kind: 'audio-asset'; index: number }

type StoredProject = {
  clips: TimelineClip[]
  audioTracks: TimelineAudio[]
  bins: string[]
  videoBins: string[]
  audioBins: string[]
  trackStates: Record<LaneKey, TrackState>
  sourcePatch: SourcePatch
  editMode: EditMode
  adjustments: AdjustmentLayer[]
  mixer: Mixer
  rangeIn: number | null
  rangeOut: number | null
}

const laneKeys: LaneKey[] = ['V3', 'V2', 'V1', 'A1', 'A2', 'A3']
const videoLanes: VideoLane[] = ['V3', 'V2', 'V1']
const audioLanes: AudioLane[] = ['A1', 'A2', 'A3']
const baseBins = ['Footage', 'Audio', 'Graphics']
const defaultTrackStates: Record<LaneKey, TrackState> = {
  V1: { targeted: true, locked: false, syncLock: true },
  V2: { targeted: false, locked: false, syncLock: true },
  V3: { targeted: false, locked: false, syncLock: true },
  A1: { targeted: true, locked: false, syncLock: true },
  A2: { targeted: false, locked: false, syncLock: true },
  A3: { targeted: false, locked: false, syncLock: true },
}
const defaultPatch: SourcePatch = { videoEnabled: true, audioEnabled: true, videoLane: 'V1', audioLane: 'A1' }
const defaultMixer: Mixer = { video: 1, music: 1, pip: 1, master: 1 }
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
function isVideoLane(lane: LaneKey): lane is VideoLane { return lane.startsWith('V') }
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
function clipDuration(clip: TimelineClip) {
  if (clip.freezeFrame) return Math.max(.2, clip.freezeDuration || 2)
  return Math.max(.02, (clip.end - clip.start) / Math.max(.25, clip.speed))
}
function audioDuration(track: TimelineAudio) { return Math.max(.02, track.sourceEnd - track.sourceStart) }
function makeClip(fileIndex: number, start: number, end: number, lane: VideoLane, startAt: number): TimelineClip {
  return {
    id: uid(), fileIndex, lane, startAt, start, end, speed: 1, volume: 1, filter: 'none', text: '', textSize: 48,
    textPosition: 'bottom', rotation: 0, fit: 'contain', zoomStart: 1, zoomEnd: 1, panXStart: 0, panXEnd: 0,
    panYStart: 0, panYEnd: 0, chromaEnabled: false, chromaColor: '#00ff00', chromaBackground: '#101010',
    chromaSimilarity: .18, chromaBlend: .06, brightness: 0, contrast: 1, saturation: 1, temperature: 0,
    vignette: 0, speedRamp: 'off', reverse: false, freezeFrame: false, freezeDuration: 2, privacyEffect: 'none',
    privacyX: .35, privacyY: .3, privacyWidth: .3, privacyHeight: .22, privacyIntensity: .55,
    transformKeyframes: [], audioLead: 0, audioTail: 0, audioFadeIn: 0, audioFadeOut: 0,
    audioAutomation: [], groupId: null, linkedAudio: true, detachedTrackId: null,
  }
}
function laneEnd(clips: TimelineClip[], lane: VideoLane) {
  return clips.filter((clip) => clip.lane === lane).reduce((max, clip) => Math.max(max, clip.startAt + clipDuration(clip)), 0)
}
function audioLaneEnd(tracks: TimelineAudio[], lane: AudioLane) {
  return tracks.filter((track) => track.lane === lane).reduce((max, track) => Math.max(max, track.startAt + audioDuration(track)), 0)
}
function videoPiecesAfterRemoval(clip: TimelineClip, cutStart: number, cutEnd: number, closeGap: boolean): TimelineClip[] {
  const clipStart = clip.startAt
  const clipEnd = clip.startAt + clipDuration(clip)
  const delta = cutEnd - cutStart
  if (clipEnd <= cutStart || clipStart >= cutEnd) {
    if (closeGap && clipStart >= cutEnd) return [{ ...clip, startAt: clip.startAt - delta }]
    return [clip]
  }
  const result: TimelineClip[] = []
  if (clipStart < cutStart) {
    const sourceEnd = clip.start + (cutStart - clipStart) * Math.max(.25, clip.speed)
    result.push({ ...clip, id: uid(), end: clamp(sourceEnd, clip.start + .02, clip.end), detachedTrackId: null })
  }
  if (clipEnd > cutEnd) {
    const sourceStart = clip.start + (cutEnd - clipStart) * Math.max(.25, clip.speed)
    result.push({ ...clip, id: uid(), start: clamp(sourceStart, clip.start, clip.end - .02), startAt: closeGap ? cutStart : cutEnd, detachedTrackId: null })
  }
  return result
}
function audioPiecesAfterRemoval(track: TimelineAudio, cutStart: number, cutEnd: number, closeGap: boolean): TimelineAudio[] {
  const trackStart = track.startAt
  const trackEnd = track.startAt + audioDuration(track)
  const delta = cutEnd - cutStart
  if (trackEnd <= cutStart || trackStart >= cutEnd) {
    if (closeGap && trackStart >= cutEnd) return [{ ...track, startAt: track.startAt - delta }]
    return [track]
  }
  const result: TimelineAudio[] = []
  if (trackStart < cutStart) {
    const end = track.sourceStart + (cutStart - trackStart)
    result.push({ ...track, id: uid(), sourceEnd: clamp(end, track.sourceStart + .02, track.sourceEnd), linkedClipId: null })
  }
  if (trackEnd > cutEnd) {
    const start = track.sourceStart + (cutEnd - trackStart)
    result.push({ ...track, id: uid(), sourceStart: clamp(start, track.sourceStart, track.sourceEnd - .02), startAt: closeGap ? cutStart : cutEnd, linkedClipId: null })
  }
  return result
}

export default function VideoStudioV12() {
  const sourceRef = useRef<HTMLVideoElement>(null)
  const programRef = useRef<HTMLVideoElement>(null)
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
  const [selection, setSelection] = useState<Selection>(null)
  const [trackStates, setTrackStates] = useState<Record<LaneKey, TrackState>>(defaultTrackStates)
  const [sourcePatch, setSourcePatch] = useState<SourcePatch>(defaultPatch)
  const [editMode, setEditMode] = useState<EditMode>('insert')
  const [tool, setTool] = useState<ToolMode>('select')
  const [playhead, setPlayhead] = useState(0)
  const [programPlaying, setProgramPlaying] = useState(false)
  const [timelineZoom, setTimelineZoom] = useState(12)
  const [rangeIn, setRangeIn] = useState<number | null>(null)
  const [rangeOut, setRangeOut] = useState<number | null>(null)
  const [adjustments, setAdjustments] = useState<AdjustmentLayer[]>([])
  const [mixer, setMixer] = useState<Mixer>(defaultMixer)
  const [masterLut, setMasterLut] = useState<File | null>(null)
  const [outputSize, setOutputSize] = useState<OutputSize>('720p')
  const [quality, setQuality] = useState<RenderQuality>('standard')
  const [jobs, setJobs] = useState<PersistentRenderJobV12[]>([])
  const [queueBusy, setQueueBusy] = useState(false)
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { getAuthStatus().then((status) => setAuthorized(status.authenticated)).catch(() => setAuthorized(false)) }, [])
  useEffect(() => {
    if (!authorized) return
    const refresh = () => listVideoRenderJobsV12().then(setJobs).catch(() => undefined)
    refresh()
    const timer = window.setInterval(refresh, 2500)
    return () => window.clearInterval(timer)
  }, [authorized])

  const v1 = useMemo(() => [...clips.filter((clip) => clip.lane === 'V1')].sort((a, b) => a.startAt - b.startAt), [clips])
  const selectedClip = selection?.kind === 'video' ? clips.find((clip) => clip.id === selection.id) || null : null
  const selectedAudio = selection?.kind === 'audio' ? audioTracks.find((track) => track.id === selection.id) || null : null
  const sourceAsset = sourceIndex !== null ? videos[sourceIndex] : null
  const programClip = v1.find((clip) => playhead >= clip.startAt && playhead < clip.startAt + clipDuration(clip)) || null
  const programAsset = programClip ? videos[programClip.fileIndex] : null
  const activeOverlays = clips.filter((clip) => clip.lane !== 'V1' && playhead >= clip.startAt && playhead < clip.startAt + clipDuration(clip))
  const projectDuration = Math.max(
    ...videoLanes.map((lane) => laneEnd(clips, lane)),
    ...audioLanes.map((lane) => audioLaneEnd(audioTracks, lane)),
    ...adjustments.map((layer) => layer.endAt),
    0,
  )
  const timelineWidth = Math.max(1250, projectDuration * timelineZoom + 160)
  const targetedVideo = videoLanes.filter((lane) => trackStates[lane].targeted)
  const targetedAudio = audioLanes.filter((lane) => trackStates[lane].targeted)

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

  const addVideos = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).slice(0, Math.max(0, 16 - videos.length))
    if (!files.length) return
    try {
      const durations = await Promise.all(files.map((file) => mediaDuration(file, 'video')))
      const targetBin = activeBin === 'All Media' ? 'Footage' : activeBin
      const base = videos.length
      const assets = files.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: durations[index], bin: targetBin }))
      setVideos((state) => [...state, ...assets])
      if (sourceIndex === null) { setSourceIndex(base); setSourceIn(0); setSourceOut(assets[0]?.duration || 0) }
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الفيديو.') }
    event.target.value = ''
  }
  const addAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    try {
      const duration = await mediaDuration(file, 'audio'), fileIndex = audios.length
      const targetBin = activeBin === 'All Media' ? 'Audio' : activeBin
      setAudios((state) => [...state, { file, duration, bin: targetBin }])
      const lane = sourcePatch.audioLane
      const track: TimelineAudio = { id: uid(), lane, name: file.name, fileIndex, startAt: playhead, sourceStart: 0, sourceEnd: duration, volume: .75, fadeIn: .2, fadeOut: .4, automation: [], linkedClipId: null }
      setAudioTracks((state) => [...state, track]); setSelection({ kind: 'audio', id: track.id })
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الصوت.') }
    event.target.value = ''
  }
  const chooseSource = (index: number) => {
    setSourceIndex(index); setSourceIn(0); setSourceOut(videos[index]?.duration || 0)
    window.setTimeout(() => { if (sourceRef.current) sourceRef.current.currentTime = 0 }, 0)
  }
  const createBin = () => {
    const name = window.prompt('اسم Bin الجديد')?.trim()
    if (!name || bins.includes(name)) return
    setBins((state) => [...state, name]); setActiveBin(name)
  }

  const updateTrackState = (lane: LaneKey, changes: Partial<TrackState>) => setTrackStates((state) => ({ ...state, [lane]: { ...state[lane], ...changes } }))
  const updateClip = (id: string, changes: Partial<TimelineClip>) => setClips((state) => state.map((clip) => clip.id === id ? { ...clip, ...changes } : clip))
  const updateAudio = (id: string, changes: Partial<TimelineAudio>) => setAudioTracks((state) => state.map((track) => track.id === id ? { ...track, ...changes } : track))

  const insertSpace = (at: number, duration: number) => {
    setClips((state) => state.flatMap((clip) => {
      if (!trackStates[clip.lane].syncLock) return [clip]
      const end = clip.startAt + clipDuration(clip)
      if (clip.startAt >= at) return [{ ...clip, startAt: clip.startAt + duration }]
      if (clip.startAt < at && end > at) {
        const sourceAt = clip.start + (at - clip.startAt) * Math.max(.25, clip.speed)
        return [
          { ...clip, id: uid(), end: sourceAt, detachedTrackId: null },
          { ...clip, id: uid(), start: sourceAt, startAt: at + duration, detachedTrackId: null },
        ]
      }
      return [clip]
    }))
    setAudioTracks((state) => state.flatMap((track) => {
      if (!trackStates[track.lane].syncLock) return [track]
      const end = track.startAt + audioDuration(track)
      if (track.startAt >= at) return [{ ...track, startAt: track.startAt + duration }]
      if (track.startAt < at && end > at) {
        const sourceAt = track.sourceStart + (at - track.startAt)
        return [
          { ...track, id: uid(), sourceEnd: sourceAt, linkedClipId: null },
          { ...track, id: uid(), sourceStart: sourceAt, startAt: at + duration, linkedClipId: null },
        ]
      }
      return [track]
    }))
    setAdjustments((state) => state.map((layer) => layer.startAt >= at ? { ...layer, startAt: layer.startAt + duration, endAt: layer.endAt + duration } : layer.endAt > at ? { ...layer, endAt: layer.endAt + duration } : layer))
  }

  const overwriteVideoRange = (lane: VideoLane, start: number, end: number) => {
    if (trackStates[lane].locked) return
    setClips((state) => state.flatMap((clip) => clip.lane === lane ? videoPiecesAfterRemoval(clip, start, end, false) : [clip]))
  }
  const overwriteAudioRange = (lane: AudioLane, start: number, end: number) => {
    if (trackStates[lane].locked) return
    setAudioTracks((state) => state.flatMap((track) => track.lane === lane ? audioPiecesAfterRemoval(track, start, end, false) : [track]))
  }

  const insertSource = async () => {
    if (sourceIndex === null || !sourceAsset || (!sourcePatch.videoEnabled && !sourcePatch.audioEnabled)) return
    const sourceStart = clamp(sourceIn, 0, Math.max(0, sourceAsset.duration - .05))
    const sourceEnd = clamp(sourceOut || sourceAsset.duration, sourceStart + .05, sourceAsset.duration)
    const duration = sourceEnd - sourceStart
    if (editMode === 'insert') insertSpace(playhead, duration)
    else {
      if (sourcePatch.videoEnabled) overwriteVideoRange(sourcePatch.videoLane, playhead, playhead + duration)
      if (sourcePatch.audioEnabled) overwriteAudioRange(sourcePatch.audioLane, playhead, playhead + duration)
    }

    let newClip: TimelineClip | null = null
    if (sourcePatch.videoEnabled && !trackStates[sourcePatch.videoLane].locked) {
      newClip = makeClip(sourceIndex, sourceStart, sourceEnd, sourcePatch.videoLane, playhead)
      setClips((state) => [...state, newClip as TimelineClip])
      setSelection({ kind: 'video', id: newClip.id })
    }

    if (sourcePatch.audioEnabled && !trackStates[sourcePatch.audioLane].locked) {
      try {
        const blob = await extractVideoAudio(sourceAsset.file)
        const file = new File([blob], `${sourceAsset.file.name.replace(/\.[^.]+$/, '')}-patch.wav`, { type: 'audio/wav' })
        const audioFileDuration = await mediaDuration(file, 'audio'), fileIndex = audios.length, id = uid()
        setAudios((state) => [...state, { file, duration: audioFileDuration, bin: 'Audio' }])
        const track: TimelineAudio = {
          id, lane: sourcePatch.audioLane, name: `Patched · ${sourceAsset.file.name}`, fileIndex, startAt: playhead,
          sourceStart, sourceEnd, volume: 1, fadeIn: 0, fadeOut: 0, automation: [], linkedClipId: newClip?.id || null,
        }
        setAudioTracks((state) => [...state, track])
        if (newClip) updateClip(newClip.id, { linkedAudio: false, detachedTrackId: id, volume: 0 })
      } catch (e) {
        setError(e instanceof Error ? `تم إدراج الفيديو لكن تعذر Source Patch للصوت: ${e.message}` : 'تعذر Source Patch للصوت.')
      }
    }
  }

  useEffect(() => {
    const video = programRef.current
    if (!video || !programClip || !programAsset) return
    const local = clamp(playhead - programClip.startAt, 0, clipDuration(programClip))
    const sourceTime = clamp(programClip.start + local * Math.max(.25, programClip.speed), programClip.start, programClip.end)
    if (Math.abs(video.currentTime - sourceTime) > .16) { try { video.currentTime = sourceTime } catch {} }
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
    setPlayhead(programClip.startAt + Math.max(0, (video.currentTime - programClip.start) / Math.max(.25, programClip.speed)))
    if (video.currentTime >= programClip.end - .025) { video.pause(); setProgramPlaying(false) }
  }

  const razorAt = (time: number, allTracks = false) => {
    const videoTargets = allTracks ? videoLanes : targetedVideo
    const audioTargets = allTracks ? audioLanes : targetedAudio
    setClips((state) => state.flatMap((clip) => {
      if (!videoTargets.includes(clip.lane) || trackStates[clip.lane].locked) return [clip]
      const end = clip.startAt + clipDuration(clip)
      if (!(time > clip.startAt + .03 && time < end - .03)) return [clip]
      const sourceAt = clip.start + (time - clip.startAt) * Math.max(.25, clip.speed)
      return [
        { ...clip, id: uid(), end: sourceAt, detachedTrackId: null },
        { ...clip, id: uid(), start: sourceAt, startAt: time, detachedTrackId: null },
      ]
    }))
    setAudioTracks((state) => state.flatMap((track) => {
      if (!audioTargets.includes(track.lane) || trackStates[track.lane].locked) return [track]
      const end = track.startAt + audioDuration(track)
      if (!(time > track.startAt + .03 && time < end - .03)) return [track]
      const sourceAt = track.sourceStart + (time - track.startAt)
      return [
        { ...track, id: uid(), sourceEnd: sourceAt, linkedClipId: null },
        { ...track, id: uid(), sourceStart: sourceAt, startAt: time, linkedClipId: null },
      ]
    }))
    setSelection(null)
  }

  const editRange = () => {
    if (rangeIn !== null && rangeOut !== null && Math.abs(rangeOut - rangeIn) > .04) return [Math.min(rangeIn, rangeOut), Math.max(rangeIn, rangeOut)] as const
    if (selectedClip) return [selectedClip.startAt, selectedClip.startAt + clipDuration(selectedClip)] as const
    if (selectedAudio) return [selectedAudio.startAt, selectedAudio.startAt + audioDuration(selectedAudio)] as const
    return null
  }
  const liftOrExtract = (extract: boolean) => {
    const range = editRange(); if (!range) { setError('حدد Timeline In/Out أو Clip قبل تنفيذ العملية.'); return }
    const [start, end] = range
    setClips((state) => state.flatMap((clip) => {
      if (targetedVideo.includes(clip.lane) && !trackStates[clip.lane].locked) return videoPiecesAfterRemoval(clip, start, end, extract)
      if (extract && trackStates[clip.lane].syncLock && clip.startAt >= end) return [{ ...clip, startAt: clip.startAt - (end - start) }]
      return [clip]
    }))
    setAudioTracks((state) => state.flatMap((track) => {
      if (targetedAudio.includes(track.lane) && !trackStates[track.lane].locked) return audioPiecesAfterRemoval(track, start, end, extract)
      if (extract && trackStates[track.lane].syncLock && track.startAt >= end) return [{ ...track, startAt: track.startAt - (end - start) }]
      return [track]
    }))
    if (extract) setAdjustments((state) => state.map((layer) => layer.startAt >= end ? { ...layer, startAt: layer.startAt - (end - start), endAt: layer.endAt - (end - start) } : layer))
    setPlayhead(start); setSelection(null); setRangeIn(null); setRangeOut(null)
  }

  const deleteSelection = () => {
    if (selectedClip && !trackStates[selectedClip.lane].locked) { setClips((state) => state.filter((clip) => clip.id !== selectedClip.id)); setSelection(null) }
    if (selectedAudio && !trackStates[selectedAudio.lane].locked) { setAudioTracks((state) => state.filter((track) => track.id !== selectedAudio.id)); setSelection(null) }
  }

  const dropOnLane = (event: DragEvent<HTMLDivElement>, lane: LaneKey) => {
    event.preventDefault()
    if (!dragPayload || trackStates[lane].locked) return
    const rect = event.currentTarget.getBoundingClientRect()
    const startAt = Math.max(0, (event.clientX - rect.left) / timelineZoom)
    if (dragPayload.kind === 'video' && isVideoLane(lane)) {
      const clip = clips.find((item) => item.id === dragPayload.id); if (!clip) return
      const delta = startAt - clip.startAt
      updateClip(clip.id, { lane, startAt })
      if (clip.detachedTrackId && trackStates[clip.lane].syncLock) {
        const linked = audioTracks.find((track) => track.id === clip.detachedTrackId)
        if (linked && trackStates[linked.lane].syncLock) updateAudio(linked.id, { startAt: Math.max(0, linked.startAt + delta) })
      }
      setSelection({ kind: 'video', id: clip.id })
    } else if (dragPayload.kind === 'audio' && !isVideoLane(lane)) {
      const track = audioTracks.find((item) => item.id === dragPayload.id); if (!track) return
      const delta = startAt - track.startAt
      updateAudio(track.id, { lane, startAt })
      if (track.linkedClipId && trackStates[track.lane].syncLock) {
        const linked = clips.find((clip) => clip.id === track.linkedClipId)
        if (linked && trackStates[linked.lane].syncLock) updateClip(linked.id, { startAt: Math.max(0, linked.startAt + delta) })
      }
      setSelection({ kind: 'audio', id: track.id })
    } else if (dragPayload.kind === 'video-asset' && isVideoLane(lane)) {
      const asset = videos[dragPayload.index]; if (!asset) return
      const clip = makeClip(dragPayload.index, 0, asset.duration, lane, startAt)
      setClips((state) => [...state, clip]); setSelection({ kind: 'video', id: clip.id })
    } else if (dragPayload.kind === 'audio-asset' && !isVideoLane(lane)) {
      const asset = audios[dragPayload.index]; if (!asset) return
      const track: TimelineAudio = { id: uid(), lane, name: asset.file.name, fileIndex: dragPayload.index, startAt, sourceStart: 0, sourceEnd: asset.duration, volume: .75, fadeIn: 0, fadeOut: 0, automation: [], linkedClipId: null }
      setAudioTracks((state) => [...state, track]); setSelection({ kind: 'audio', id: track.id })
    }
    setDragPayload(null)
  }
  const timelineClick = (event: React.MouseEvent<HTMLDivElement>, lane: LaneKey) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const time = Math.max(0, (event.clientX - rect.left) / timelineZoom)
    setPlayhead(time)
    if (tool === 'razor' && !trackStates[lane].locked) razorAt(time, false)
  }

  const addAdjustment = () => {
    const endAt = Math.max(playhead + 3, Math.min(projectDuration || playhead + 6, playhead + 8))
    setAdjustments((state) => [...state, { id: uid(), name: `Adjustment ${state.length + 1}`, startAt: playhead, endAt, brightness: 0, contrast: 1, saturation: 1, blur: 0 }])
  }
  const updateAdjustment = (id: string, changes: Partial<AdjustmentLayer>) => setAdjustments((state) => state.map((layer) => layer.id === id ? { ...layer, ...changes } : layer))

  const flattenMain = () => {
    const result: TimelineClip[] = []
    for (const clip of v1) {
      const clipStart = clip.startAt, clipEnd = clip.startAt + clipDuration(clip)
      const boundaries = [clipStart, clipEnd]
      adjustments.forEach((layer) => {
        if (layer.startAt > clipStart && layer.startAt < clipEnd) boundaries.push(layer.startAt)
        if (layer.endAt > clipStart && layer.endAt < clipEnd) boundaries.push(layer.endAt)
      })
      const sorted = Array.from(new Set(boundaries)).sort((a, b) => a - b)
      for (let index = 0; index < sorted.length - 1; index++) {
        const segStart = sorted[index], segEnd = sorted[index + 1], mid = (segStart + segEnd) / 2
        const localStart = segStart - clipStart, localEnd = segEnd - clipStart
        const active = adjustments.filter((layer) => mid >= layer.startAt && mid <= layer.endAt)
        let brightness = clip.brightness || 0, contrast = clip.contrast || 1, saturation = clip.saturation || 1, blur = 0
        active.forEach((layer) => { brightness += layer.brightness; contrast *= layer.contrast; saturation *= layer.saturation; blur = Math.max(blur, layer.blur) })
        result.push({
          ...clip, id: uid(), startAt: segStart,
          start: clip.start + localStart * Math.max(.25, clip.speed), end: clip.start + localEnd * Math.max(.25, clip.speed),
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

  const buildManifest = (): VideoProjectManifestV12 => {
    const master = mixer.master
    const main = flattenMain().sort((a, b) => a.startAt - b.startAt).map(({ id: _id, lane: _lane, startAt, linkedAudio: _linkedAudio, detachedTrackId: _detachedTrackId, ...clip }) => ({
      ...clip,
      timelineStartAt: startAt,
      volume: clamp(clip.volume * mixer.video * master, 0, 2),
    }))
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
      borderRadius: .035,
      audioEnabled: clip.linkedAudio,
      audioVolume: clamp(clip.volume * mixer.pip * master, 0, 2),
    }))
    const manifest = {
      clips: main,
      textTracks: [], subtitleTracks: [], imageTracks: [], videoOverlays: overlays,
      audioTracks: audioTracks.map(({ id: _id, lane: _lane, name: _name, linkedClipId: _linkedClipId, ...track }) => ({ ...track, volume: clamp(track.volume * mixer.music * master, 0, 2) })),
      transition: 'none' as const, transitionDuration: .1, audioDuckingEnabled: false, duckingStrength: .65, magneticSnap: true,
    }
    return manifest as unknown as VideoProjectManifestV12
  }

  const enqueueRender = async () => {
    if (!v1.length || queueBusy) { if (!v1.length) setError('V1 لا يحتوي على فيديو للتصدير.'); return }
    setQueueBusy(true); setError(null)
    try {
      await enqueueVideoProjectV12(
        videos.map((asset) => asset.file), audios.map((asset) => asset.file), [], buildManifest(),
        outputSize, quality, `V12 ${outputSize} ${quality} · ${new Date().toLocaleTimeString('ar-SA')}`, masterLut,
      )
      setJobs(await listVideoRenderJobsV12())
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة Render إلى الصف الدائم.') }
    finally { setQueueBusy(false) }
  }
  const downloadJob = async (job: PersistentRenderJobV12) => {
    try {
      const blob = await getVideoRenderResultV12(job.id), url = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = url; link.download = `MAGHRABI-v12-${job.id.slice(0, 8)}.mp4`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تنزيل نتيجة Render.') }
  }
  const retryJob = async (id: string) => { try { await retryVideoRenderJobV12(id); setJobs(await listVideoRenderJobsV12()) } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إعادة المهمة.') } }
  const deleteJob = async (id: string) => { try { await deleteVideoRenderJobV12(id); setJobs(await listVideoRenderJobsV12()) } catch (e) { setError(e instanceof Error ? e.message : 'تعذر حذف المهمة.') } }

  const saveProject = async () => {
    try {
      const project: StoredProject = {
        clips, audioTracks, bins, videoBins: videos.map((asset) => asset.bin), audioBins: audios.map((asset) => asset.bin),
        trackStates, sourcePatch, editMode, adjustments, mixer, rangeIn, rangeOut,
      }
      await saveStoredVideoProject<StoredProject>({
        version: 3, savedAt: new Date().toISOString(), project,
        videos: videos.map((asset) => asset.file), videoDurations: videos.map((asset) => asset.duration),
        audios: audios.map((asset) => asset.file), audioDurations: audios.map((asset) => asset.duration), images: [], outputSize, quality,
      })
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر حفظ مشروع V12.') }
  }
  const restoreProject = async () => {
    try {
      const snapshot = await loadStoredVideoProject<StoredProject>(); if (!snapshot) { setError('لا يوجد مشروع محفوظ.'); return }
      const p = snapshot.project
      setVideos(snapshot.videos.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: snapshot.videoDurations[index] || 0, bin: p.videoBins?.[index] || 'Footage' })))
      setAudios(snapshot.audios.map((file, index) => ({ file, duration: snapshot.audioDurations[index] || 0, bin: p.audioBins?.[index] || 'Audio' })))
      setClips((p.clips || []).map((clip) => ({ ...clip, id: clip.id || uid() }))); setAudioTracks((p.audioTracks || []).map((track) => ({ ...track, id: track.id || uid() })))
      setBins(p.bins || baseBins); setTrackStates({ ...defaultTrackStates, ...(p.trackStates || {}) }); setSourcePatch(p.sourcePatch || defaultPatch); setEditMode(p.editMode || 'insert')
      setAdjustments(p.adjustments || []); setMixer(p.mixer || defaultMixer); setRangeIn(p.rangeIn ?? null); setRangeOut(p.rangeOut ?? null)
      setOutputSize(snapshot.outputSize as OutputSize); setQuality(snapshot.quality as RenderQuality); setSourceIndex(snapshot.videos.length ? 0 : null); setSourceIn(0); setSourceOut(snapshot.videoDurations[0] || 0); setSelection(null); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر استعادة مشروع V12.') }
  }

  const TrackHeader = ({ lane }: { lane: LaneKey }) => {
    const state = trackStates[lane]
    return <div className="flex h-full w-[122px] shrink-0 items-center gap-1 border-r border-white/8 bg-[#080d17] px-2">
      <button onClick={() => updateTrackState(lane, { targeted: !state.targeted })} className={`grid h-7 w-7 place-items-center rounded-lg border text-[8px] font-black ${state.targeted ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-100' : 'border-white/8 text-slate-600'}`} title="Track Target"><Target className="h-3 w-3"/></button>
      <button onClick={() => updateTrackState(lane, { locked: !state.locked })} className={`grid h-7 w-7 place-items-center rounded-lg border ${state.locked ? 'border-amber-300/35 text-amber-200' : 'border-white/8 text-slate-600'}`} title="Lock">{state.locked ? <Lock className="h-3 w-3"/> : <Unlock className="h-3 w-3"/>}</button>
      <button onClick={() => updateTrackState(lane, { syncLock: !state.syncLock })} className={`grid h-7 w-7 place-items-center rounded-lg border ${state.syncLock ? 'border-violet-300/35 text-violet-200' : 'border-white/8 text-slate-700'}`} title="Sync Lock"><Link2 className="h-3 w-3"/></button>
      <span className="ml-auto text-[9px] font-black">{lane}</span>
    </div>
  }

  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#050710] text-cyan-200">جاري التحقق...</div>
  if (!authorized) return <div className="grid min-h-screen place-items-center bg-[#050710] text-white"><a href="#" className="rounded-2xl bg-white px-6 py-3 font-black text-black">العودة لتسجيل الدخول</a></div>

  return <main className="min-h-screen bg-[#050710] text-slate-100"><div className="mx-auto max-w-[2040px] px-3 py-3 md:px-5">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
      <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-cyan-400/10"><Film className="h-5 w-5 text-cyan-200"/></div><div><div className="flex items-center gap-2"><h1 className="text-lg font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-cyan-300/20 bg-cyan-300/[.06] px-2 py-1 text-[9px] font-black text-cyan-100">EDITORIAL V12</span></div><p className="mt-1 text-[10px] text-slate-500">Source Patch · Track Targeting · Insert/Overwrite · Razor · Lift/Extract · Persistent Render Queue</p></div></div>
      <div className="flex flex-wrap gap-2"><button onClick={saveProject} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black"><Save className="mr-1 inline h-3.5 w-3.5"/>حفظ</button><button onClick={restoreProject} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black"><FolderOpen className="mr-1 inline h-3.5 w-3.5"/>استعادة</button><a href="#video-v11" className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black text-slate-400">V11 Director</a><select value={outputSize} onChange={e=>setOutputSize(e.target.value as OutputSize)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="720p">720p</option><option value="1080p">1080p</option><option value="portrait">9:16</option><option value="square">1:1</option></select><select value={quality} onChange={e=>setQuality(e.target.value as RenderQuality)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select><button onClick={enqueueRender} disabled={queueBusy || !v1.length} className="rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-2 text-xs font-black disabled:opacity-30">{queueBusy ? 'UPLOADING JOB...' : 'ADD TO SERVER QUEUE'}</button></div>
    </header>

    <section className="mt-3 grid gap-3 2xl:grid-cols-[330px_minmax(0,1fr)_390px]">
      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">MEDIA BINS</p><button onClick={createBin} className="text-cyan-300"><FolderPlus className="h-4 w-4"/></button></div><div className="mt-3 flex flex-wrap gap-1"><button onClick={()=>setActiveBin('All Media')} className={`rounded-lg px-2 py-1 text-[8px] font-black ${activeBin==='All Media'?'bg-white text-black':'border border-white/8'}`}>ALL</button>{bins.map(bin=><button key={bin} onClick={()=>setActiveBin(bin)} className={`rounded-lg px-2 py-1 text-[8px] font-black ${activeBin===bin?'bg-white text-black':'border border-white/8'}`}>{bin}</button>)}</div><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="بحث في الميديا..." className="mt-3 w-full rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-[9px] outline-none"/><div className="mt-3 grid grid-cols-2 gap-2"><label className="cursor-pointer rounded-xl border border-dashed border-violet-300/20 p-3 text-center text-[9px] font-black"><UploadCloud className="mx-auto mb-1 h-4 w-4"/>VIDEO<input type="file" multiple accept="video/*" className="hidden" onChange={addVideos}/></label><label className="cursor-pointer rounded-xl border border-dashed border-cyan-300/20 p-3 text-center text-[9px] font-black"><UploadCloud className="mx-auto mb-1 h-4 w-4"/>AUDIO<input type="file" accept="audio/*" className="hidden" onChange={addAudio}/></label></div><div className="mt-3 max-h-64 space-y-1.5 overflow-auto">{visibleVideos.map(({asset,index})=><button draggable onDragStart={()=>setDragPayload({kind:'video-asset',index})} key={`v${index}`} onClick={()=>chooseSource(index)} className={`flex w-full items-center gap-2 rounded-xl border p-2 text-left ${sourceIndex===index?'border-violet-300/35 bg-violet-300/10':'border-white/7'}`}><span className="grid h-7 w-7 place-items-center rounded-lg bg-violet-300/10 text-[8px] font-black">V{index+1}</span><span className="min-w-0 flex-1"><span className="block truncate text-[9px] font-bold">{asset.file.name}</span><span className="text-[8px] text-slate-600">{fmt(asset.duration)} · {asset.bin}</span></span></button>)}{visibleAudios.map(({asset,index})=><button draggable onDragStart={()=>setDragPayload({kind:'audio-asset',index})} key={`a${index}`} className="flex w-full items-center gap-2 rounded-xl border border-white/7 p-2 text-left"><span className="grid h-7 w-7 place-items-center rounded-lg bg-cyan-300/10 text-[8px] font-black">A{index+1}</span><span className="min-w-0 flex-1"><span className="block truncate text-[9px] font-bold">{asset.file.name}</span><span className="text-[8px] text-slate-600">{fmt(asset.duration)} · {asset.bin}</span></span></button>)}</div></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><p className="text-[10px] font-black tracking-widest text-slate-500">SOURCE PATCH / TRACK TARGET</p><div className="mt-3 rounded-2xl border border-white/8 p-3"><div className="flex items-center gap-2"><button onClick={()=>setSourcePatch(s=>({...s,videoEnabled:!s.videoEnabled}))} className={`rounded-lg px-2 py-1 text-[8px] font-black ${sourcePatch.videoEnabled?'bg-violet-300 text-black':'border border-white/10'}`}>V PATCH</button>{(['V1','V2','V3'] as VideoLane[]).map(lane=><button key={lane} onClick={()=>setSourcePatch(s=>({...s,videoLane:lane}))} className={`rounded-lg border px-2 py-1 text-[8px] font-black ${sourcePatch.videoLane===lane?'border-violet-300/50 text-violet-100':'border-white/8 text-slate-600'}`}>{lane}</button>)}</div><div className="mt-2 flex items-center gap-2"><button onClick={()=>setSourcePatch(s=>({...s,audioEnabled:!s.audioEnabled}))} className={`rounded-lg px-2 py-1 text-[8px] font-black ${sourcePatch.audioEnabled?'bg-cyan-300 text-black':'border border-white/10'}`}>A PATCH</button>{(['A1','A2','A3'] as AudioLane[]).map(lane=><button key={lane} onClick={()=>setSourcePatch(s=>({...s,audioLane:lane}))} className={`rounded-lg border px-2 py-1 text-[8px] font-black ${sourcePatch.audioLane===lane?'border-cyan-300/50 text-cyan-100':'border-white/8 text-slate-600'}`}>{lane}</button>)}</div></div><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={()=>setEditMode('insert')} className={`rounded-xl border p-2 text-[9px] font-black ${editMode==='insert'?'border-emerald-300/40 bg-emerald-300/10 text-emerald-100':'border-white/10'}`}>INSERT</button><button onClick={()=>setEditMode('overwrite')} className={`rounded-xl border p-2 text-[9px] font-black ${editMode==='overwrite'?'border-rose-300/40 bg-rose-300/10 text-rose-100':'border-white/10'}`}>OVERWRITE</button></div></div>
      </aside>

      <div className="min-w-0 space-y-3">
        <div className="grid gap-3 xl:grid-cols-2">
          <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-2 flex items-center justify-between"><div><p className="text-xs font-black">SOURCE MONITOR</p><p className="mt-1 text-[9px] text-slate-600">{sourceAsset?.file.name || 'اختر ملفًا من Media Bin'}</p></div><span className="text-[9px] text-violet-200">IN {fmt(sourceIn)} · OUT {fmt(sourceOut)}</span></div><div className="aspect-video overflow-hidden rounded-2xl bg-black">{sourceAsset?<video ref={sourceRef} src={sourceAsset.url} controls className="h-full w-full object-contain"/>:<div className="grid h-full place-items-center"><Film className="h-10 w-10 text-slate-800"/></div>}</div><div className="mt-3 flex flex-wrap gap-2"><button onClick={()=>setSourceIn(sourceRef.current?.currentTime||0)} disabled={!sourceAsset} className="rounded-xl border border-violet-300/20 px-3 py-2 text-[9px] font-black">MARK IN</button><button onClick={()=>setSourceOut(sourceRef.current?.currentTime||sourceAsset?.duration||0)} disabled={!sourceAsset} className="rounded-xl border border-violet-300/20 px-3 py-2 text-[9px] font-black">MARK OUT</button><button onClick={insertSource} disabled={!sourceAsset} className="ml-auto rounded-xl bg-white px-4 py-2 text-[9px] font-black text-black">{editMode.toUpperCase()} TO PATCH</button></div></div>
          <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-2 flex items-center justify-between"><div><p className="text-xs font-black">PROGRAM MONITOR</p><p className="mt-1 text-[9px] text-slate-600">{fmt(playhead)} · V1 Program</p></div><span className="text-[9px] text-cyan-200">{programClip?`CAM ${programClip.fileIndex+1}`:'GAP / BLACK'}</span></div><div className="relative aspect-video overflow-hidden rounded-2xl bg-black">{programAsset&&programClip?<video ref={programRef} key={programClip.id} src={programAsset.url} className="h-full w-full object-contain" onTimeUpdate={onProgramTime} onPlay={()=>setProgramPlaying(true)} onPause={()=>setProgramPlaying(false)} playsInline/>:<div className="grid h-full place-items-center text-[10px] text-slate-700">BLACK / GAP</div>}{activeOverlays.map((clip)=>{const asset=videos[clip.fileIndex];return asset?<video key={clip.id} src={asset.url} muted autoPlay={programPlaying} loop playsInline className={`absolute object-cover shadow-xl ${clip.lane==='V2'?'bottom-4 right-4 w-[38%]':'left-4 top-4 w-[28%]'}`}/>:null})}</div><div className="mt-3 flex flex-wrap gap-2"><button onClick={toggleProgram} disabled={!programClip} className="rounded-xl bg-white px-4 py-2 text-[9px] font-black text-black disabled:opacity-30">{programPlaying?<Pause className="mr-1 inline h-3.5 w-3.5"/>:<Play className="mr-1 inline h-3.5 w-3.5"/>}{programPlaying?'PAUSE':'PLAY'}</button><button onClick={()=>setRangeIn(playhead)} className="rounded-xl border border-cyan-300/20 px-3 py-2 text-[9px] font-black">TIMELINE IN</button><button onClick={()=>setRangeOut(playhead)} className="rounded-xl border border-cyan-300/20 px-3 py-2 text-[9px] font-black">TIMELINE OUT</button><span className="ml-auto text-[8px] text-slate-600">{rangeIn!==null?fmt(rangeIn):'--'} → {rangeOut!==null?fmt(rangeOut):'--'}</span></div></div>
        </div>

        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex flex-wrap items-center gap-2"><button onClick={()=>setTool('select')} className={`rounded-xl border px-3 py-2 text-[9px] font-black ${tool==='select'?'border-white bg-white text-black':'border-white/10'}`}><MousePointer2 className="mr-1 inline h-3.5 w-3.5"/>SELECT</button><button onClick={()=>setTool('razor')} className={`rounded-xl border px-3 py-2 text-[9px] font-black ${tool==='razor'?'border-rose-300/40 bg-rose-300/10 text-rose-100':'border-white/10'}`}><Scissors className="mr-1 inline h-3.5 w-3.5"/>RAZOR</button><button onClick={()=>razorAt(playhead,true)} className="rounded-xl border border-rose-300/20 px-3 py-2 text-[9px] font-black text-rose-100">RAZOR ALL</button><button onClick={()=>liftOrExtract(false)} className="rounded-xl border border-amber-300/20 px-3 py-2 text-[9px] font-black text-amber-100">LIFT</button><button onClick={()=>liftOrExtract(true)} className="rounded-xl border border-emerald-300/20 px-3 py-2 text-[9px] font-black text-emerald-100">EXTRACT</button><button onClick={deleteSelection} disabled={!selection} className="rounded-xl border border-rose-300/20 px-3 py-2 text-[9px] text-rose-200 disabled:opacity-30"><Trash2 className="h-3.5 w-3.5"/></button><input type="range" min="5" max="30" value={timelineZoom} onChange={e=>setTimelineZoom(Number(e.target.value))} className="ml-auto w-28 accent-cyan-300"/><span className="text-[8px] text-slate-600">{timelineZoom}px/s</span></div><div className="overflow-x-auto rounded-2xl border border-white/8 bg-black/20"><div className="relative" style={{width:timelineWidth}}><div className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-red-400" style={{left:122+playhead*timelineZoom}}/>{rangeIn!==null&&<div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-amber-300/60" style={{left:122+rangeIn*timelineZoom}}/>}{rangeOut!==null&&<div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-amber-300/60" style={{left:122+rangeOut*timelineZoom}}/>}{laneKeys.map((lane,rowIndex)=><div key={lane} className="flex h-[66px] border-b border-white/5"><TrackHeader lane={lane}/><div className={`relative h-full flex-1 ${trackStates[lane].locked?'bg-amber-300/[.025]':''}`} onDragOver={e=>e.preventDefault()} onDrop={e=>dropOnLane(e,lane)} onClick={e=>timelineClick(e,lane)}>{isVideoLane(lane)?clips.filter(clip=>clip.lane===lane).map(clip=><button draggable={!trackStates[lane].locked} onDragStart={e=>{e.stopPropagation();setDragPayload({kind:'video',id:clip.id})}} onClick={e=>{e.stopPropagation();setSelection({kind:'video',id:clip.id});setPlayhead(clip.startAt)}} key={clip.id} className={`absolute top-2 h-12 overflow-hidden rounded-xl border px-2 text-left ${selection?.kind==='video'&&selection.id===clip.id?'border-violet-100 bg-violet-400/25':'border-violet-300/20 bg-violet-400/10'}`} style={{left:clip.startAt*timelineZoom,width:Math.max(58,clipDuration(clip)*timelineZoom)}}><span className="block truncate text-[8px] font-black">{lane} · V{clip.fileIndex+1}</span><span className="mt-1 block text-[7px] text-slate-500">{fmt(clip.startAt)} · {fmt(clipDuration(clip))}</span></button>):audioTracks.filter(track=>track.lane===lane).map(track=><button draggable={!trackStates[lane].locked} onDragStart={e=>{e.stopPropagation();setDragPayload({kind:'audio',id:track.id})}} onClick={e=>{e.stopPropagation();setSelection({kind:'audio',id:track.id});setPlayhead(track.startAt)}} key={track.id} className={`absolute top-2 h-12 overflow-hidden rounded-xl border px-2 text-left ${selection?.kind==='audio'&&selection.id===track.id?'border-cyan-100 bg-cyan-400/25':'border-cyan-300/20 bg-cyan-400/10'}`} style={{left:track.startAt*timelineZoom,width:Math.max(58,audioDuration(track)*timelineZoom)}}><span className="block truncate text-[8px] font-black">{lane} · {track.name}</span><span className="mt-1 block text-[7px] text-slate-500">{fmt(track.startAt)} · {fmt(audioDuration(track))}</span></button>)}</div></div>)}<div className="flex h-[52px] border-b border-white/5"><div className="grid w-[122px] shrink-0 place-items-center border-r border-white/8 bg-[#080d17] text-[8px] font-black text-amber-300">ADJUST</div><div className="relative flex-1" onClick={e=>{const r=e.currentTarget.getBoundingClientRect();setPlayhead(Math.max(0,(e.clientX-r.left)/timelineZoom))}}>{adjustments.map(layer=><button key={layer.id} className="absolute top-2 h-9 rounded-lg border border-amber-300/25 bg-amber-300/10 px-2 text-[8px] font-black text-amber-100" style={{left:layer.startAt*timelineZoom,width:Math.max(65,(layer.endAt-layer.startAt)*timelineZoom)}}>{layer.name}</button>)}</div></div></div></div></div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">INSPECTOR</p><Layers3 className="h-4 w-4 text-violet-300"/></div>{selectedClip&&<div className="mt-4 space-y-3"><p className="truncate text-xs font-black">VIDEO · {selectedClip.lane} · {videos[selectedClip.fileIndex]?.file.name}</p><div className="grid grid-cols-2 gap-2"><label className="text-[8px] text-slate-600">START AT<input type="number" step=".05" value={selectedClip.startAt} onChange={e=>updateClip(selectedClip.id,{startAt:Math.max(0,Number(e.target.value)||0)})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 p-2 text-[9px]"/></label><label className="text-[8px] text-slate-600">SPEED<input type="number" min=".25" max="4" step=".05" value={selectedClip.speed} onChange={e=>updateClip(selectedClip.id,{speed:clamp(Number(e.target.value),.25,4)})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 p-2 text-[9px]"/></label></div><label className="block text-[8px] text-slate-600">FILTER<select value={selectedClip.filter} onChange={e=>updateClip(selectedClip.id,{filter:e.target.value as VideoFilter})} className="mt-1 w-full rounded-xl border border-white/10 bg-[#0b111d] p-2 text-[9px]">{filters.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="block text-[8px] text-slate-600">VOLUME {selectedClip.volume.toFixed(2)}<input type="range" min="0" max="2" step=".02" value={selectedClip.volume} onChange={e=>updateClip(selectedClip.id,{volume:Number(e.target.value)})} className="mt-1 w-full accent-violet-300"/></label></div>}{selectedAudio&&<div className="mt-4 space-y-3"><p className="truncate text-xs font-black">AUDIO · {selectedAudio.lane} · {selectedAudio.name}</p><label className="block text-[8px] text-slate-600">START AT<input type="number" step=".05" value={selectedAudio.startAt} onChange={e=>updateAudio(selectedAudio.id,{startAt:Math.max(0,Number(e.target.value)||0)})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 p-2 text-[9px]"/></label><label className="block text-[8px] text-slate-600">VOLUME {selectedAudio.volume.toFixed(2)}<input type="range" min="0" max="2" step=".02" value={selectedAudio.volume} onChange={e=>updateAudio(selectedAudio.id,{volume:Number(e.target.value)})} className="mt-1 w-full accent-cyan-300"/></label></div>}{!selection&&<p className="mt-4 text-[9px] text-slate-600">حدد Clip أو Audio من Timeline.</p>}</div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">ADJUSTMENT / MASTER</p><WandSparkles className="h-4 w-4 text-amber-300"/></div><button onClick={addAdjustment} disabled={!v1.length} className="mt-3 w-full rounded-xl border border-amber-300/20 p-2 text-[9px] font-black text-amber-100 disabled:opacity-30">+ ADJUSTMENT LAYER</button><label className="mt-3 block cursor-pointer rounded-xl border border-dashed border-white/10 p-3 text-center text-[8px] font-black text-slate-400">{masterLut?masterLut.name:'MASTER LUT .CUBE'}<input type="file" accept=".cube" className="hidden" onChange={e=>{setMasterLut(e.target.files?.[0]||null);e.target.value=''}}/></label><div className="mt-3 max-h-56 space-y-2 overflow-auto">{adjustments.map(layer=><div key={layer.id} className="rounded-xl border border-amber-300/10 p-3"><div className="flex items-center gap-2"><input value={layer.name} onChange={e=>updateAdjustment(layer.id,{name:e.target.value})} className="min-w-0 flex-1 bg-transparent text-[8px] font-black outline-none"/><button onClick={()=>setAdjustments(s=>s.filter(x=>x.id!==layer.id))} className="text-rose-300"><Trash2 className="h-3 w-3"/></button></div><label className="mt-2 block text-[7px] text-slate-600">BRIGHTNESS<input type="range" min="-.4" max=".4" step=".02" value={layer.brightness} onChange={e=>updateAdjustment(layer.id,{brightness:Number(e.target.value)})} className="w-full accent-amber-300"/></label><label className="mt-1 block text-[7px] text-slate-600">BLUR<input type="range" min="0" max="1" step=".02" value={layer.blur} onChange={e=>updateAdjustment(layer.id,{blur:Number(e.target.value)})} className="w-full accent-amber-300"/></label></div>)}</div></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">MIXER</p><Gauge className="h-4 w-4 text-emerald-300"/></div>{(['video','music','pip','master'] as const).map(key=><label key={key} className="mt-3 block text-[8px] font-black uppercase text-slate-500">{key} · {Math.round(mixer[key]*100)}%<input type="range" min="0" max="1.5" step=".01" value={mixer[key]} onChange={e=>setMixer(s=>({...s,[key]:Number(e.target.value)}))} className="mt-1 w-full accent-emerald-300"/></label>)}</div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">SERVER RENDER QUEUE</p><p className="mt-1 text-[8px] text-slate-600">تستمر بعد إغلاق الصفحة أو إعادة تشغيل الخدمة.</p></div><button onClick={()=>listVideoRenderJobsV12().then(setJobs).catch(()=>undefined)} className="text-cyan-300"><RefreshCcw className="h-4 w-4"/></button></div><div className="mt-3 max-h-[380px] space-y-2 overflow-auto">{jobs.length?jobs.map(job=><div key={job.id} className="rounded-xl border border-white/8 p-3"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="truncate text-[9px] font-black">{job.name}</p><p className={`mt-1 text-[8px] font-bold ${job.status==='done'?'text-emerald-300':job.status==='failed'?'text-rose-300':job.status==='rendering'?'text-cyan-300':'text-amber-300'}`}>{job.status.toUpperCase()} · {job.outputSize} · {job.quality}</p><p className="mt-1 text-[7px] text-slate-600">{job.message}</p></div>{job.status!=='rendering'&&<button onClick={()=>deleteJob(job.id)} className="text-rose-300"><Trash2 className="h-3.5 w-3.5"/></button>}</div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-cyan-300/70" style={{width:`${job.status==='rendering'?55:job.progress||0}%`}}/></div><div className="mt-2 flex gap-2">{job.resultReady&&<button onClick={()=>downloadJob(job)} className="flex-1 rounded-lg bg-emerald-300/10 p-2 text-[8px] font-black text-emerald-100"><Download className="mr-1 inline h-3 w-3"/>DOWNLOAD</button>}{job.status==='failed'&&<button onClick={()=>retryJob(job.id)} className="flex-1 rounded-lg bg-amber-300/10 p-2 text-[8px] font-black text-amber-100">RETRY</button>}</div>{job.error&&<p className="mt-2 line-clamp-3 text-[7px] text-rose-300">{job.error}</p>}</div>):<div className="rounded-xl border border-dashed border-white/8 p-4 text-center text-[8px] text-slate-600"><ListVideo className="mx-auto mb-2 h-5 w-5"/>لا توجد Jobs حتى الآن.</div>}</div></div>

        {error&&<div className="rounded-2xl border border-rose-300/20 bg-rose-300/10 p-3 text-[9px] leading-5 text-rose-200">{error}</div>}
      </aside>
    </section>
  </div></main>
}
