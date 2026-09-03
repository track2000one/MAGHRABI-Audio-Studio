import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera,
  ChevronLeft,
  ClipboardPaste,
  Copy,
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
  ImageTrackManifest,
  OutputSize,
  RenderQuality,
  renderVideoProjectV10,
  SubtitleTrackManifest,
  TextTrackManifest,
  VideoClipManifest,
  VideoFilter,
  VideoOverlayTrackManifest,
} from './lib/videoApi'
import { loadStoredVideoProject, saveStoredVideoProject } from './lib/projectStore'

type VideoAsset = { file: File; url: string; duration: number }
type AudioAsset = { file: File; duration: number }
type Clip = VideoClipManifest & { id: string; sequenceSourceId?: string | null }
type Sequence = { id: string; name: string; clips: Clip[] }
type AdjustmentLayer = {
  id: string
  name: string
  startAt: number
  endAt: number
  brightness: number
  contrast: number
  saturation: number
  temperature: number
  vignette: number
}
type Mixer = { video: number; music: number; pip: number; master: number }
type MulticamCut = { time: number; cameraIndex: number }
type MulticamState = { cameraIndices: number[]; offsets: Record<number, number>; cuts: MulticamCut[]; duration: number }
type ClipboardAttributes = Partial<VideoClipManifest> | null

type V10StoredProject = {
  clips: Clip[]
  textTracks: TextTrackManifest[]
  subtitleTracks: SubtitleTrackManifest[]
  audioTracks: AudioTrackManifest[]
  imageTracks: ImageTrackManifest[]
  videoOverlays: VideoOverlayTrackManifest[]
  sequences: Sequence[]
  adjustmentLayers: AdjustmentLayer[]
  mixer: Mixer
  multicam: MulticamState
}

const emptyMixer: Mixer = { video: 1, music: 1, pip: 1, master: 1 }
const emptyMulticam: MulticamState = { cameraIndices: [], offsets: {}, cuts: [], duration: 0 }
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
    element.onloadedmetadata = () => { const duration = Number.isFinite(element.duration) ? element.duration : 0; URL.revokeObjectURL(url); resolve(duration) }
    element.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`تعذر قراءة ${file.name}`)) }
    element.src = url
  })
}
function makeClip(fileIndex: number, start: number, end: number): Clip {
  return {
    id: uid(), fileIndex, start, end, speed: 1, volume: 1, filter: 'none', text: '', textSize: 48,
    textPosition: 'bottom', rotation: 0, fit: 'contain', zoomStart: 1, zoomEnd: 1,
    panXStart: 0, panXEnd: 0, panYStart: 0, panYEnd: 0, chromaEnabled: false,
    chromaColor: '#00ff00', chromaBackground: '#101010', chromaSimilarity: .18, chromaBlend: .06,
    brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0, speedRamp: 'off',
    reverse: false, freezeFrame: false, freezeDuration: 2, privacyEffect: 'none', privacyX: .35,
    privacyY: .3, privacyWidth: .3, privacyHeight: .22, privacyIntensity: .55, transformKeyframes: [],
    audioLead: 0, audioTail: 0, audioFadeIn: 0, audioFadeOut: 0, audioAutomation: [], groupId: null,
  }
}
function clipDuration(clip: Clip) { return Math.max(.01, (clip.end - clip.start) / Math.max(.25, clip.speed)) }
function cloneClip(clip: Clip, sequenceSourceId?: string): Clip { return { ...clip, id: uid(), groupId: sequenceSourceId || clip.groupId || null, sequenceSourceId: sequenceSourceId || null, transformKeyframes: [...(clip.transformKeyframes || [])], audioAutomation: [...(clip.audioAutomation || [])] } }

export default function VideoStudioV10() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const multicamRefs = useRef<Record<number, HTMLVideoElement | null>>({})
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [videos, setVideos] = useState<VideoAsset[]>([])
  const [audios, setAudios] = useState<AudioAsset[]>([])
  const [images, setImages] = useState<File[]>([])
  const [mainClips, setMainClips] = useState<Clip[]>([])
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [activeSequenceId, setActiveSequenceId] = useState<string | null>(null)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [textTracks, setTextTracks] = useState<TextTrackManifest[]>([])
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrackManifest[]>([])
  const [audioTracks, setAudioTracks] = useState<AudioTrackManifest[]>([])
  const [imageTracks, setImageTracks] = useState<ImageTrackManifest[]>([])
  const [videoOverlays, setVideoOverlays] = useState<VideoOverlayTrackManifest[]>([])
  const [adjustmentLayers, setAdjustmentLayers] = useState<AdjustmentLayer[]>([])
  const [mixer, setMixer] = useState<Mixer>(emptyMixer)
  const [multicam, setMulticam] = useState<MulticamState>(emptyMulticam)
  const [clipboard, setClipboard] = useState<ClipboardAttributes>(null)
  const [playhead, setPlayhead] = useState(0)
  const [previewTime, setPreviewTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [timelineZoom, setTimelineZoom] = useState(10)
  const [outputSize, setOutputSize] = useState<OutputSize>('720p')
  const [quality, setQuality] = useState<RenderQuality>('standard')
  const [busy, setBusy] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { getAuthStatus().then((status) => setAuthorized(status.authenticated)).catch(() => setAuthorized(false)) }, [])

  const activeSequence = sequences.find((item) => item.id === activeSequenceId) || null
  const clips = activeSequence ? activeSequence.clips : mainClips
  const setClips = (updater: (clips: Clip[]) => Clip[]) => {
    if (activeSequenceId) setSequences((state) => state.map((sequence) => sequence.id === activeSequenceId ? { ...sequence, clips: updater(sequence.clips) } : sequence))
    else setMainClips((state) => updater(state))
  }
  const offsets = useMemo(() => {
    let cursor = 0
    return clips.map((clip) => { const duration = clipDuration(clip), start = cursor; cursor += duration; return { start, end: cursor, duration } })
  }, [clips])
  const duration = offsets.length ? offsets[offsets.length - 1].end : 0
  const selectedIndex = clips.findIndex((clip) => clip.id === selectedClipId)
  const selectedClip = selectedIndex >= 0 ? clips[selectedIndex] : null
  const selectedAsset = selectedClip ? videos[selectedClip.fileIndex] : null

  const addVideoFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).slice(0, Math.max(0, 10 - videos.length))
    if (!files.length) return
    try {
      const durations = await Promise.all(files.map((file) => mediaDuration(file, 'video')))
      const base = videos.length
      const assets = files.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: durations[index] }))
      setVideos((state) => [...state, ...assets])
      const newClips = assets.map((asset, index) => makeClip(base + index, 0, asset.duration))
      setClips((state) => [...state, ...newClips])
      if (newClips[0]) setSelectedClipId(newClips[0].id)
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الفيديو.') }
    event.target.value = ''
  }
  const addAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    try {
      const fileDuration = await mediaDuration(file, 'audio'), fileIndex = audios.length
      setAudios((state) => [...state, { file, duration: fileDuration }])
      setAudioTracks((state) => [...state, { fileIndex, startAt: playhead, sourceStart: 0, sourceEnd: fileDuration, volume: .7, fadeIn: .25, fadeOut: .5, automation: [] }])
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة الصوت.') }
    event.target.value = ''
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video || !selectedClip || !selectedAsset) return
    video.pause(); setPlaying(false)
    const seek = () => { video.currentTime = clamp(previewTime || selectedClip.start, selectedClip.start, selectedClip.end); video.playbackRate = selectedClip.speed; video.volume = clamp(selectedClip.volume * mixer.video * mixer.master, 0, 1) }
    if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true })
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [selectedClipId, selectedAsset?.url])

  const togglePlay = async () => {
    const video = videoRef.current; if (!video || !selectedClip) return
    if (video.paused) { if (video.currentTime < selectedClip.start || video.currentTime >= selectedClip.end) video.currentTime = selectedClip.start; video.playbackRate = selectedClip.speed; await video.play().catch(() => undefined) }
    else video.pause()
  }
  const onTimeUpdate = () => {
    const video = videoRef.current; if (!video || !selectedClip || selectedIndex < 0) return
    setPreviewTime(video.currentTime)
    setPlayhead((offsets[selectedIndex]?.start || 0) + (video.currentTime - selectedClip.start) / Math.max(.25, selectedClip.speed))
    if (video.currentTime >= selectedClip.end - .02) { video.pause(); video.currentTime = selectedClip.start }
  }
  const selectClip = (clip: Clip, index: number) => {
    setSelectedClipId(clip.id); setPreviewTime(clip.start); setPlayhead(offsets[index]?.start || 0)
    if (videoRef.current) videoRef.current.currentTime = clip.start
  }
  const updateSelected = (changes: Partial<Clip>) => { if (!selectedClip) return; setClips((state) => state.map((clip) => clip.id === selectedClip.id ? { ...clip, ...changes } : clip)) }
  const splitSelected = () => {
    if (!selectedClip || selectedIndex < 0) return
    const at = clamp(previewTime, selectedClip.start, selectedClip.end)
    if (at - selectedClip.start < .1 || selectedClip.end - at < .1) { setError('حرّك المؤشر داخل المقطع ثم نفذ Split.'); return }
    const left = cloneClip({ ...selectedClip, end: at }), right = cloneClip({ ...selectedClip, start: at })
    setClips((state) => state.flatMap((clip) => clip.id === selectedClip.id ? [left, right] : [clip]))
    setSelectedClipId(right.id); setPreviewTime(right.start)
  }
  const deleteSelected = () => { if (!selectedClip) return; setClips((state) => state.filter((clip) => clip.id !== selectedClip.id)); setSelectedClipId(null) }

  const copyAttributes = () => {
    if (!selectedClip) return
    const { filter, brightness, contrast, saturation, temperature, vignette, rotation, fit, speed, volume, zoomStart, zoomEnd, panXStart, panXEnd, panYStart, panYEnd, chromaEnabled, chromaColor, chromaSimilarity, chromaBlend, audioFadeIn, audioFadeOut, audioAutomation } = selectedClip
    setClipboard({ filter, brightness, contrast, saturation, temperature, vignette, rotation, fit, speed, volume, zoomStart, zoomEnd, panXStart, panXEnd, panYStart, panYEnd, chromaEnabled, chromaColor, chromaSimilarity, chromaBlend, audioFadeIn, audioFadeOut, audioAutomation: [...(audioAutomation || [])] })
  }
  const pasteAttributes = () => { if (clipboard && selectedClip) updateSelected({ ...clipboard, audioAutomation: [...(clipboard.audioAutomation || [])] }) }

  const createSequenceFromTimeline = () => {
    if (!clips.length) return
    const sequence: Sequence = { id: uid(), name: `Sequence ${sequences.length + 1}`, clips: clips.map((clip) => cloneClip(clip)) }
    setSequences((state) => [...state, sequence]); setActiveSequenceId(sequence.id); setSelectedClipId(sequence.clips[0]?.id || null)
  }
  const newEmptySequence = () => {
    const sequence: Sequence = { id: uid(), name: `Sequence ${sequences.length + 1}`, clips: [] }
    setSequences((state) => [...state, sequence]); setActiveSequenceId(sequence.id); setSelectedClipId(null)
  }
  const insertSequenceIntoMain = (sequence: Sequence) => {
    const clones = sequence.clips.map((clip) => cloneClip(clip, sequence.id))
    setMainClips((state) => [...state, ...clones]); setActiveSequenceId(null); setSelectedClipId(clones[0]?.id || null)
  }
  const deleteSequence = (id: string) => { setSequences((state) => state.filter((sequence) => sequence.id !== id)); if (activeSequenceId === id) { setActiveSequenceId(null); setSelectedClipId(null) } }

  const toggleMulticamCamera = (index: number) => {
    setMulticam((state) => {
      const exists = state.cameraIndices.includes(index)
      const cameraIndices = exists ? state.cameraIndices.filter((item) => item !== index) : [...state.cameraIndices, index].slice(0, 4)
      const minDuration = cameraIndices.length ? Math.min(...cameraIndices.map((camera) => Math.max(0, (videos[camera]?.duration || 0) - (state.offsets[camera] || 0)))) : 0
      const cuts = state.cuts.filter((cut) => cameraIndices.includes(cut.cameraIndex))
      return { ...state, cameraIndices, duration: minDuration, cuts }
    })
  }
  const cutToCamera = (cameraIndex: number) => {
    if (!multicam.cameraIndices.includes(cameraIndex)) return
    const time = clamp(playhead, 0, multicam.duration)
    setMulticam((state) => {
      const cuts = [...state.cuts.filter((cut) => Math.abs(cut.time - time) > .04), { time, cameraIndex }].sort((a, b) => a.time - b.time)
      if (!cuts.some((cut) => cut.time < .02)) cuts.unshift({ time: 0, cameraIndex })
      return { ...state, cuts }
    })
  }
  const bakeMulticam = () => {
    if (!multicam.cameraIndices.length || !multicam.duration) return
    const cuts = multicam.cuts.length ? [...multicam.cuts].sort((a, b) => a.time - b.time) : [{ time: 0, cameraIndex: multicam.cameraIndices[0] }]
    if (cuts[0].time > .01) cuts.unshift({ time: 0, cameraIndex: cuts[0].cameraIndex })
    const result: Clip[] = []
    cuts.forEach((cut, index) => {
      const next = cuts[index + 1]?.time ?? multicam.duration
      if (next <= cut.time + .04) return
      const offset = multicam.offsets[cut.cameraIndex] || 0
      const assetDuration = videos[cut.cameraIndex]?.duration || 0
      const sourceStart = clamp(cut.time + offset, 0, Math.max(0, assetDuration - .05))
      const sourceEnd = clamp(next + offset, sourceStart + .05, assetDuration)
      result.push(makeClip(cut.cameraIndex, sourceStart, sourceEnd))
    })
    setMainClips(result); setActiveSequenceId(null); setSelectedClipId(result[0]?.id || null); setPlayhead(0)
  }

  useEffect(() => {
    multicam.cameraIndices.forEach((cameraIndex) => {
      const video = multicamRefs.current[cameraIndex]; if (!video) return
      const offset = multicam.offsets[cameraIndex] || 0
      const target = clamp(playhead + offset, 0, Math.max(0, (videos[cameraIndex]?.duration || 0) - .02))
      if (Math.abs(video.currentTime - target) > .12) { try { video.currentTime = target } catch {} }
    })
  }, [playhead, multicam.cameraIndices, multicam.offsets])

  const addAdjustmentLayer = () => {
    const end = Math.max(playhead + 3, mainClips.reduce((sum, clip) => sum + clipDuration(clip), 0))
    setAdjustmentLayers((state) => [...state, { id: uid(), name: `Adjustment ${state.length + 1}`, startAt: playhead, endAt: Math.min(end, playhead + 8), brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0 }])
  }
  const updateAdjustment = (id: string, changes: Partial<AdjustmentLayer>) => setAdjustmentLayers((state) => state.map((layer) => layer.id === id ? { ...layer, ...changes } : layer))

  const flattenAdjustments = (source: Clip[]) => {
    const result: Clip[] = []
    let cursor = 0
    for (const clip of source) {
      const d = clipDuration(clip), clipStart = cursor, clipEnd = cursor + d
      const boundaries = [clipStart, clipEnd]
      adjustmentLayers.forEach((layer) => { if (layer.startAt > clipStart && layer.startAt < clipEnd) boundaries.push(layer.startAt); if (layer.endAt > clipStart && layer.endAt < clipEnd) boundaries.push(layer.endAt) })
      const sorted = Array.from(new Set(boundaries)).sort((a, b) => a - b)
      for (let index = 0; index < sorted.length - 1; index++) {
        const segStart = sorted[index], segEnd = sorted[index + 1], localStart = segStart - clipStart, localEnd = segEnd - clipStart
        const mid = (segStart + segEnd) / 2
        const active = adjustmentLayers.filter((layer) => mid >= layer.startAt && mid <= layer.endAt)
        const sourceStart = clip.start + localStart * clip.speed, sourceEnd = clip.start + localEnd * clip.speed
        let brightness = clip.brightness || 0, contrast = clip.contrast || 1, saturation = clip.saturation || 1, temperature = clip.temperature || 0, vignette = clip.vignette || 0
        active.forEach((layer) => { brightness += layer.brightness; contrast *= layer.contrast; saturation *= layer.saturation; temperature += layer.temperature; vignette = Math.max(vignette, layer.vignette) })
        result.push({ ...cloneClip(clip), start: sourceStart, end: sourceEnd, brightness: clamp(brightness, -.6, .6), contrast: clamp(contrast, .5, 2), saturation: clamp(saturation, 0, 3), temperature: clamp(temperature, -1, 1), vignette: clamp(vignette, 0, 1) })
      }
      cursor = clipEnd
    }
    return result
  }

  const exportProject = async () => {
    if (!mainClips.length) return
    setBusy(true); setError(null); if (resultUrl) URL.revokeObjectURL(resultUrl); setResultUrl(null)
    try {
      const flattened = flattenAdjustments(mainClips)
      const master = mixer.master
      const manifest = {
        clips: flattened.map(({ id: _id, sequenceSourceId: _sequenceSourceId, ...clip }) => ({ ...clip, volume: clamp(clip.volume * mixer.video * master, 0, 2) })),
        textTracks,
        subtitleTracks,
        audioTracks: audioTracks.map((track) => ({ ...track, volume: clamp(track.volume * mixer.music * master, 0, 2) })),
        imageTracks,
        videoOverlays: videoOverlays.map((track) => ({ ...track, audioVolume: clamp((track.audioVolume || 0) * mixer.pip * master, 0, 2) })),
        transition: 'none' as const,
        transitionDuration: .1,
        audioDuckingEnabled: false,
        duckingStrength: .65,
        magneticSnap: true,
      }
      const blob = await renderVideoProjectV10(videos.map((item) => item.file), audios.map((item) => item.file), images, manifest, outputSize, quality, null)
      setResultUrl(URL.createObjectURL(blob))
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تصدير V10.') }
    finally { setBusy(false) }
  }

  const saveProject = async () => {
    try {
      const project: V10StoredProject = { clips: mainClips, textTracks, subtitleTracks, audioTracks, imageTracks, videoOverlays, sequences, adjustmentLayers, mixer, multicam }
      await saveStoredVideoProject<V10StoredProject>({ version: 3, savedAt: new Date().toISOString(), project, videos: videos.map((item) => item.file), videoDurations: videos.map((item) => item.duration), audios: audios.map((item) => item.file), audioDurations: audios.map((item) => item.duration), images, outputSize, quality })
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر حفظ مشروع V10.') }
  }
  const restoreProject = async () => {
    try {
      const snapshot = await loadStoredVideoProject<any>(); if (!snapshot) { setError('لا يوجد مشروع محفوظ.'); return }
      setVideos(snapshot.videos.map((file, index) => ({ file, url: URL.createObjectURL(file), duration: snapshot.videoDurations[index] || 0 })))
      setAudios(snapshot.audios.map((file, index) => ({ file, duration: snapshot.audioDurations[index] || 0 }))); setImages(snapshot.images || [])
      const project = snapshot.project || {}
      setMainClips((project.clips || []).map((clip: Clip) => ({ ...clip, id: clip.id || uid() })))
      setTextTracks(project.textTracks || []); setSubtitleTracks(project.subtitleTracks || []); setAudioTracks(project.audioTracks || []); setImageTracks(project.imageTracks || []); setVideoOverlays(project.videoOverlays || [])
      setSequences(project.sequences || []); setAdjustmentLayers(project.adjustmentLayers || []); setMixer(project.mixer || emptyMixer); setMulticam(project.multicam || emptyMulticam)
      setActiveSequenceId(null); setSelectedClipId(project.clips?.[0]?.id || null); setOutputSize(snapshot.outputSize as OutputSize); setQuality(snapshot.quality as RenderQuality); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر استعادة المشروع.') }
  }

  const mainDuration = mainClips.reduce((sum, clip) => sum + clipDuration(clip), 0)
  const timelineWidth = Math.max(1000, duration * timelineZoom + 140)

  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#050710] text-cyan-200">جاري التحقق...</div>
  if (!authorized) return <div className="grid min-h-screen place-items-center bg-[#050710] text-white"><a href="#" className="rounded-2xl bg-white px-6 py-3 font-black text-black">العودة لتسجيل الدخول</a></div>

  return <main className="min-h-screen bg-[#050710] text-slate-100"><div className="mx-auto max-w-[1980px] px-3 py-3 md:px-5">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
      <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-violet-400/10"><Film className="h-5 w-5 text-violet-200"/></div><div><div className="flex items-center gap-2"><h1 className="text-lg font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-violet-300/20 bg-violet-300/[.06] px-2 py-1 text-[9px] font-black text-violet-200">CREATOR V10</span></div><p className="mt-1 text-[10px] text-slate-500">Director Workspace · Nested Sequences · Multi‑Cam · Adjustment Layers · Master Mixer</p></div></div>
      <div className="flex flex-wrap gap-2"><button onClick={saveProject} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black"><Save className="mr-1 inline h-3.5 w-3.5"/>حفظ</button><button onClick={restoreProject} className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black"><FolderOpen className="mr-1 inline h-3.5 w-3.5"/>استعادة</button><a href="#video-v9" className="rounded-xl border border-white/10 px-3 py-2 text-[10px] font-black text-slate-400">V9 Detail Editor</a><select value={outputSize} onChange={e=>setOutputSize(e.target.value as OutputSize)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="720p">720p</option><option value="1080p">1080p</option><option value="portrait">9:16</option><option value="square">1:1</option></select><select value={quality} onChange={e=>setQuality(e.target.value as RenderQuality)} className="rounded-xl border border-white/10 bg-[#0b111d] px-3 text-[10px]"><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select><button onClick={exportProject} disabled={busy || !mainClips.length} className="rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-2 text-xs font-black disabled:opacity-30">{busy?'Rendering V10...':'EXPORT V10'}</button></div>
    </header>

    <section className="mt-3 grid gap-3 2xl:grid-cols-[320px_minmax(0,1fr)_390px]">
      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><p className="text-[10px] font-black tracking-widest text-slate-500">MEDIA / SOURCES</p><div className="mt-3 grid grid-cols-2 gap-2"><label className="cursor-pointer rounded-2xl border border-dashed border-violet-300/20 p-3 text-center text-[9px] font-black"><UploadCloud className="mx-auto mb-2 h-4 w-4"/>VIDEO<input type="file" multiple accept="video/*" className="hidden" onChange={addVideoFiles}/></label><label className="cursor-pointer rounded-2xl border border-dashed border-cyan-300/20 p-3 text-center text-[9px] font-black"><Music2 className="mx-auto mb-2 h-4 w-4"/>AUDIO<input type="file" accept="audio/*" className="hidden" onChange={addAudio}/></label></div><div className="mt-3 max-h-48 space-y-2 overflow-auto">{videos.map((asset,index)=><div key={`${asset.file.name}-${index}`} className="flex items-center gap-2 rounded-xl border border-white/8 p-2"><span className="grid h-7 w-7 place-items-center rounded-lg bg-violet-300/10 text-[9px] font-black">{index+1}</span><div className="min-w-0"><p className="truncate text-[9px] font-bold">{asset.file.name}</p><p className="text-[8px] text-slate-600">{fmt(asset.duration)}</p></div></div>)}</div></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">NESTED SEQUENCES</p><ListVideo className="h-4 w-4 text-violet-300"/></div><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={newEmptySequence} className="rounded-xl border border-violet-300/20 p-2 text-[8px] font-black">+ EMPTY</button><button onClick={createSequenceFromTimeline} disabled={!clips.length} className="rounded-xl border border-violet-300/20 p-2 text-[8px] font-black disabled:opacity-30">FROM TIMELINE</button></div><button onClick={()=>{setActiveSequenceId(null);setSelectedClipId(mainClips[0]?.id||null)}} className={`mt-3 w-full rounded-xl border p-2 text-left text-[9px] font-black ${!activeSequenceId?'border-cyan-300/35 bg-cyan-300/10':'border-white/10'}`}>MAIN SEQUENCE · {mainClips.length} clips</button><div className="mt-2 space-y-2">{sequences.map(sequence=><div key={sequence.id} className={`rounded-xl border p-2 ${activeSequenceId===sequence.id?'border-violet-300/40 bg-violet-300/10':'border-white/10'}`}><div className="flex items-center gap-2"><button onClick={()=>{setActiveSequenceId(sequence.id);setSelectedClipId(sequence.clips[0]?.id||null)}} className="min-w-0 flex-1 text-left"><p className="truncate text-[9px] font-black">{sequence.name}</p><p className="text-[8px] text-slate-600">{sequence.clips.length} clips</p></button><button onClick={()=>deleteSequence(sequence.id)} className="text-rose-300"><Trash2 className="h-3.5 w-3.5"/></button></div><button onClick={()=>insertSequenceIntoMain(sequence)} disabled={!sequence.clips.length} className="mt-2 w-full rounded-lg bg-violet-300/10 p-1.5 text-[8px] font-black text-violet-100 disabled:opacity-30">INSERT INTO MAIN</button></div>)}</div></div>
      </aside>

      <div className="min-w-0 space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-black">PROGRAM MONITOR</p><p className="mt-1 text-[9px] text-slate-600">{activeSequence?activeSequence.name:'MAIN'} · {fmt(playhead)}</p></div>{activeSequenceId&&<button onClick={()=>{setActiveSequenceId(null);setSelectedClipId(mainClips[0]?.id||null)}} className="rounded-xl border border-white/10 px-3 py-2 text-[9px]"><ChevronLeft className="mr-1 inline h-3 w-3"/>MAIN</button>}</div><div className="mx-auto aspect-video overflow-hidden rounded-2xl border border-white/10 bg-black">{selectedAsset&&selectedClip?<video ref={videoRef} src={selectedAsset.url} className="h-full w-full object-contain" onTimeUpdate={onTimeUpdate} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} playsInline/>:<div className="grid h-full place-items-center"><Film className="h-12 w-12 text-slate-800"/></div>}</div><div className="mt-3 flex flex-wrap justify-center gap-2"><button onClick={togglePlay} disabled={!selectedClip} className="rounded-xl bg-white px-4 py-2 text-xs font-black text-black disabled:opacity-30">{playing?<Pause className="mr-1 inline h-4 w-4"/>:<Play className="mr-1 inline h-4 w-4"/>}{playing?'إيقاف':'تشغيل'}</button><button onClick={splitSelected} disabled={!selectedClip} className="rounded-xl border border-cyan-300/20 px-4 py-2 text-xs font-black"><Scissors className="mr-1 inline h-4 w-4"/>Split</button><button onClick={copyAttributes} disabled={!selectedClip} className="rounded-xl border border-amber-300/20 px-3 py-2 text-[9px] font-black"><Copy className="mr-1 inline h-3.5 w-3.5"/>Copy Attr</button><button onClick={pasteAttributes} disabled={!selectedClip||!clipboard} className="rounded-xl border border-amber-300/20 px-3 py-2 text-[9px] font-black disabled:opacity-30"><ClipboardPaste className="mr-1 inline h-3.5 w-3.5"/>Paste Attr</button><button onClick={deleteSelected} disabled={!selectedClip} className="rounded-xl border border-rose-300/20 px-3 py-2 text-rose-200"><Trash2 className="h-4 w-4"/></button></div></div>

        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-black">V10 DIRECTOR TIMELINE</p><p className="mt-1 text-[9px] text-slate-600">Nested Sequence workspace · Adjustment layers · Main sequence flattening</p></div><input type="range" min="4" max="30" value={timelineZoom} onChange={e=>setTimelineZoom(Number(e.target.value))} className="w-32 accent-cyan-300"/></div><div className="overflow-x-auto rounded-2xl border border-white/8 bg-black/20"><div className="relative h-[150px]" style={{width:timelineWidth}}><div className="absolute left-[100px] top-0 h-20">{clips.map((clip,index)=>{const off=offsets[index];return <button key={clip.id} onClick={()=>selectClip(clip,index)} className={`absolute top-3 h-14 overflow-hidden rounded-xl border px-3 text-left ${selectedClipId===clip.id?'border-violet-200 bg-violet-400/20':'border-violet-300/15 bg-violet-400/10'}`} style={{left:off.start*timelineZoom,width:Math.max(82,off.duration*timelineZoom)}}><span className="text-[8px] font-black">CLIP {index+1}</span><span className="mt-1 block truncate text-[8px] text-slate-500">CAM {clip.fileIndex+1}{clip.sequenceSourceId?' · NESTED':''}</span></button>})}</div>{!activeSequenceId&&<div className="absolute left-[100px] top-[82px] h-14">{adjustmentLayers.map(layer=><button key={layer.id} onClick={()=>setPlayhead(layer.startAt)} className="absolute top-1 h-10 rounded-lg border border-amber-300/25 bg-amber-300/10 px-2 text-[8px] font-black text-amber-100" style={{left:layer.startAt*timelineZoom,width:Math.max(70,(layer.endAt-layer.startAt)*timelineZoom)}}>{layer.name}</button>)}</div>}<div className="pointer-events-none absolute bottom-0 top-0 w-px bg-red-400" style={{left:100+playhead*timelineZoom}}/><div className="absolute left-0 top-0 grid h-20 w-[92px] place-items-center bg-[#080d17] text-[8px] font-black text-slate-500">VIDEO</div><div className="absolute left-0 top-[82px] grid h-14 w-[92px] place-items-center bg-[#080d17] text-[8px] font-black text-amber-300">ADJUST</div></div></div></div>

        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="flex items-center justify-between"><div><p className="text-xs font-black">MULTI‑CAM DIRECTOR</p><p className="mt-1 text-[9px] text-slate-600">اختر حتى 4 كاميرات متزامنة، ضع Cuts أثناء التحريك، ثم Bake إلى Main Sequence.</p></div><Camera className="h-5 w-5 text-emerald-300"/></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{videos.slice(0,8).map((asset,index)=>{const active=multicam.cameraIndices.includes(index);return <div key={index} className={`rounded-2xl border p-2 ${active?'border-emerald-300/35 bg-emerald-300/[.05]':'border-white/8'}`}><video ref={node=>{multicamRefs.current[index]=node}} src={asset.url} muted playsInline className="aspect-video w-full rounded-xl bg-black object-contain"/><div className="mt-2 flex items-center gap-2"><button onClick={()=>toggleMulticamCamera(index)} className={`rounded-lg px-2 py-1 text-[8px] font-black ${active?'bg-emerald-300 text-black':'border border-white/10'}`}>CAM {index+1}</button>{active&&<><input type="number" step=".1" value={multicam.offsets[index]||0} onChange={e=>setMulticam(state=>({...state,offsets:{...state.offsets,[index]:Number(e.target.value)||0}}))} className="w-16 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-[8px]" title="Sync offset"/><button onClick={()=>cutToCamera(index)} className="ml-auto rounded-lg bg-violet-300/10 px-2 py-1 text-[8px] font-black text-violet-100">CUT HERE</button></>}</div></div>})}</div><div className="mt-3 flex flex-wrap items-center gap-2"><span className="text-[9px] text-slate-500">Duration {fmt(multicam.duration)} · {multicam.cuts.length} cuts</span><button onClick={bakeMulticam} disabled={!multicam.cameraIndices.length||!multicam.duration} className="ml-auto rounded-xl bg-emerald-300/10 px-4 py-2 text-[9px] font-black text-emerald-100 disabled:opacity-30">BAKE MULTICAM TO MAIN</button></div></div>

        {resultUrl&&<div className="rounded-3xl border border-emerald-300/15 bg-emerald-300/[.035] p-5"><div className="flex items-center justify-between"><p className="text-sm font-black text-emerald-100">اكتمل Render V10</p><Sparkles className="h-5 w-5 text-emerald-300"/></div><video controls src={resultUrl} className="mt-4 max-h-[520px] w-full rounded-2xl bg-black"/><a href={resultUrl} download="MAGHRABI-video-v10.mp4" className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-black text-black"><Download className="h-4 w-4"/>تنزيل الفيديو</a></div>}
      </div>

      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">CLIP INSPECTOR</p><SlidersHorizontal className="h-4 w-4 text-cyan-300"/></div>{selectedClip&&selectedAsset?<div className="mt-4 space-y-3"><p className="truncate text-xs font-black">{selectedAsset.file.name}</p><div className="grid grid-cols-2 gap-2"><label className="text-[8px] text-slate-600">START<input type="number" step=".05" value={selectedClip.start} onChange={e=>updateSelected({start:clamp(Number(e.target.value),0,selectedClip.end-.05)})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 p-2 text-[9px]"/></label><label className="text-[8px] text-slate-600">END<input type="number" step=".05" value={selectedClip.end} onChange={e=>updateSelected({end:clamp(Number(e.target.value),selectedClip.start+.05,selectedAsset.duration)})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 p-2 text-[9px]"/></label></div><label className="block text-[8px] text-slate-600">FILTER<select value={selectedClip.filter} onChange={e=>updateSelected({filter:e.target.value as VideoFilter})} className="mt-1 w-full rounded-xl border border-white/10 bg-[#0b111d] p-2 text-[9px]">{filters.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</select></label><div className="grid grid-cols-2 gap-2"><label className="text-[8px] text-slate-600">SPEED<input type="number" min=".25" max="4" step=".05" value={selectedClip.speed} onChange={e=>updateSelected({speed:clamp(Number(e.target.value),.25,4)})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 p-2 text-[9px]"/></label><label className="text-[8px] text-slate-600">VOLUME<input type="number" min="0" max="2" step=".05" value={selectedClip.volume} onChange={e=>updateSelected({volume:clamp(Number(e.target.value),0,2)})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 p-2 text-[9px]"/></label></div></div>:<p className="mt-4 text-[9px] text-slate-600">حدد Clip.</p>}</div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">ADJUSTMENT LAYERS</p><Layers3 className="h-4 w-4 text-amber-300"/></div><button onClick={addAdjustmentLayer} disabled={!mainClips.length} className="mt-3 w-full rounded-xl border border-amber-300/20 p-2 text-[9px] font-black text-amber-100 disabled:opacity-30"><Plus className="mr-1 inline h-3.5 w-3.5"/>ADD ADJUSTMENT</button><div className="mt-3 max-h-64 space-y-2 overflow-auto">{adjustmentLayers.map(layer=><div key={layer.id} className="rounded-xl border border-amber-300/10 p-3"><div className="flex items-center gap-2"><input value={layer.name} onChange={e=>updateAdjustment(layer.id,{name:e.target.value})} className="min-w-0 flex-1 bg-transparent text-[9px] font-black outline-none"/><button onClick={()=>setAdjustmentLayers(state=>state.filter(item=>item.id!==layer.id))} className="text-rose-300"><Trash2 className="h-3.5 w-3.5"/></button></div><div className="mt-2 grid grid-cols-2 gap-2"><input type="number" step=".1" value={layer.startAt} onChange={e=>updateAdjustment(layer.id,{startAt:Math.max(0,Number(e.target.value)||0)})} className="rounded-lg border border-white/10 bg-black/30 p-1.5 text-[8px]"/><input type="number" step=".1" value={layer.endAt} onChange={e=>updateAdjustment(layer.id,{endAt:Math.max(layer.startAt+.05,Number(e.target.value)||0)})} className="rounded-lg border border-white/10 bg-black/30 p-1.5 text-[8px]"/></div><label className="mt-2 block text-[8px] text-slate-600">Brightness {layer.brightness.toFixed(2)}<input type="range" min="-.4" max=".4" step=".02" value={layer.brightness} onChange={e=>updateAdjustment(layer.id,{brightness:Number(e.target.value)})} className="mt-1 w-full accent-amber-300"/></label><label className="mt-2 block text-[8px] text-slate-600">Contrast {layer.contrast.toFixed(2)}<input type="range" min=".6" max="1.8" step=".02" value={layer.contrast} onChange={e=>updateAdjustment(layer.id,{contrast:Number(e.target.value)})} className="mt-1 w-full accent-amber-300"/></label><label className="mt-2 block text-[8px] text-slate-600">Saturation {layer.saturation.toFixed(2)}<input type="range" min="0" max="2" step=".02" value={layer.saturation} onChange={e=>updateAdjustment(layer.id,{saturation:Number(e.target.value)})} className="mt-1 w-full accent-amber-300"/></label></div>)}</div></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">AUDIO MIXER / BUSES</p><Gauge className="h-4 w-4 text-emerald-300"/></div>{(['video','music','pip','master'] as const).map(key=><div key={key} className="mt-3 rounded-xl border border-white/8 p-3"><div className="flex items-center justify-between"><span className="text-[9px] font-black uppercase">{key}</span><span className="text-[9px] text-slate-500">{Math.round(mixer[key]*100)}%</span></div><input type="range" min="0" max="1.5" step=".01" value={mixer[key]} onChange={e=>setMixer(state=>({...state,[key]:Number(e.target.value)}))} className="mt-2 w-full accent-emerald-300"/><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/40"><div className="h-full bg-emerald-300/70 transition-all" style={{width:`${Math.min(100,mixer[key]/1.5*100)}%`}}/></div></div>)}</div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4 text-[9px] leading-5 text-slate-500"><p className="font-black text-slate-300">PROJECT STATUS</p><p className="mt-2">Main: {mainClips.length} clips · {fmt(mainDuration)}</p><p>Nested: {sequences.length} · Adjustments: {adjustmentLayers.length}</p><p>Multicam: {multicam.cameraIndices.length} cameras · {multicam.cuts.length} cuts</p>{error&&<div className="mt-3 rounded-xl border border-rose-300/20 bg-rose-300/10 p-3 text-rose-200">{error}</div>}</div>
      </aside>
    </section>
  </div></main>
}
