import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, type StoredVideoProject } from './lib/projectStore'

const ROOT = '.maghrabi-studio-pro main'
const HARD_DRIFT_SECONDS = .12
const SOFT_DRIFT_SECONDS = .025
const MAX_RATE_NUDGE = .03

type AutomationPoint = { time: number; gain: number }
type AudioTrack = {
  id?: string
  lane?: 'A1' | 'A2' | 'A3'
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  volume: number
  fadeIn: number
  fadeOut: number
  automation?: AutomationPoint[]
  linkedClipId?: string | null
}
type VideoClip = {
  id?: string
  lane?: 'V1' | 'V2' | 'V3'
  fileIndex: number
  startAt: number
  start: number
  end: number
  speed: number
  freezeFrame?: boolean
  freezeDuration?: number
}
type Mixer = { video?: number; music?: number; pip?: number; master?: number }
type ProjectShape = { clips?: VideoClip[]; audioTracks?: AudioTrack[]; mixer?: Mixer }
type FrameClockDetail = { time?: number; playing?: boolean; source?: string }
type AudioNode = { element: HTMLAudioElement; url: string; trackKey: string; fileIndex: number }
type SyncStatus = { activeAudio: number; activeOverlays: number; maxDriftMs: number; mode: string; warning: string }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function programPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
}

function overlayVideos() {
  const panel = programPanel()
  if (!panel) return [] as HTMLVideoElement[]
  return Array.from(panel.querySelectorAll<HTMLVideoElement>('.aspect-video > video.absolute'))
}

function trackKey(track: AudioTrack, index: number) {
  return track.id || `${track.lane || 'A'}:${track.fileIndex}:${track.startAt.toFixed(4)}:${index}`
}

function audioTrackDuration(track: AudioTrack) {
  return Math.max(.02, Number(track.sourceEnd) - Number(track.sourceStart))
}

function videoClipDuration(clip: VideoClip) {
  if (clip.freezeFrame) return Math.max(.2, Number(clip.freezeDuration) || 2)
  return Math.max(.02, (Number(clip.end) - Number(clip.start)) / Math.max(.25, Number(clip.speed) || 1))
}

function automationGain(points: AutomationPoint[] | undefined, localTime: number) {
  if (!points?.length) return 1
  if (points.length === 1) return clamp(Number(points[0].gain), 0, 2)
  const sorted = points
  if (localTime <= sorted[0].time) return clamp(Number(sorted[0].gain), 0, 2)
  const last = sorted[sorted.length - 1]
  if (localTime >= last.time) return clamp(Number(last.gain), 0, 2)
  for (let index = 1; index < sorted.length; index += 1) {
    const right = sorted[index]
    if (localTime > right.time) continue
    const left = sorted[index - 1]
    const span = Math.max(.0001, Number(right.time) - Number(left.time))
    const mix = clamp((localTime - Number(left.time)) / span, 0, 1)
    return clamp(Number(left.gain) + (Number(right.gain) - Number(left.gain)) * mix, 0, 2)
  }
  return 1
}

function fadeGain(track: AudioTrack, localTime: number, duration: number) {
  let gain = 1
  const fadeIn = Math.max(0, Number(track.fadeIn) || 0)
  const fadeOut = Math.max(0, Number(track.fadeOut) || 0)
  if (fadeIn > .001) gain *= clamp(localTime / fadeIn, 0, 1)
  if (fadeOut > .001) gain *= clamp((duration - localTime) / fadeOut, 0, 1)
  return gain
}

function liveAudioClipCount() {
  const timeline = document.querySelector('.maghrabi-time-ruler')?.parentElement
  if (!timeline) return 0
  return Array.from(timeline.querySelectorAll<HTMLButtonElement>('button.maghrabi-pro-clip, button[style*="left"][style*="width"]'))
    .filter((button) => /^A[123]\s*·/i.test((button.textContent || '').trim())).length
}

function setMediaTime(media: HTMLMediaElement, requested: number) {
  const upper = Number.isFinite(media.duration) && media.duration > .02 ? Math.max(0, media.duration - .01) : requested
  const target = clamp(requested, 0, upper)
  try { media.currentTime = target } catch {}
  return target
}

export default function StudioAVSyncPro() {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [status, setStatus] = useState<SyncStatus>({ activeAudio: 0, activeOverlays: 0, maxDriftMs: 0, mode: 'IDLE', warning: '' })

  useEffect(() => {
    let disposed = false
    let portalTarget: HTMLElement | null = null
    let snapshot: StoredVideoProject<ProjectShape> | null = null
    let project: ProjectShape = {}
    let audioNodes = new Map<string, AudioNode>()
    let loadGeneration = 0
    let lastStatusAt = 0

    const updatePortalTarget = () => {
      const next = programPanel()
      if (next !== portalTarget) {
        portalTarget = next
        setTarget(next)
      }
    }

    const destroyAudioNodes = () => {
      audioNodes.forEach(({ element, url }) => {
        element.pause()
        element.removeAttribute('src')
        element.load()
        URL.revokeObjectURL(url)
      })
      audioNodes = new Map()
    }

    const loadSnapshot = async () => {
      const generation = ++loadGeneration
      const projectId = getActiveStudioProjectId()
      if (!projectId) {
        snapshot = null
        project = {}
        destroyAudioNodes()
        return
      }
      const next = await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null)
      if (disposed || generation !== loadGeneration) return
      snapshot = next
      project = next?.project || {}
      if (Array.isArray(project.audioTracks)) {
        project.audioTracks.forEach((track) => track.automation?.sort((a, b) => Number(a.time) - Number(b.time)))
      }
      destroyAudioNodes()
      if (!next) return
      const tracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
      tracks.forEach((track, index) => {
        const file = next.audios?.[track.fileIndex]
        if (!(file instanceof Blob)) return
        const url = URL.createObjectURL(file)
        const element = document.createElement('audio')
        element.preload = 'auto'
        element.src = url
        element.dataset.maghrabiSyncAudio = trackKey(track, index)
        element.volume = 0
        element.setAttribute('aria-hidden', 'true')
        audioNodes.set(trackKey(track, index), { element, url, trackKey: trackKey(track, index), fileIndex: track.fileIndex })
      })
    }

    const syncAudio = (time: number, playing: boolean, source: string) => {
      const tracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
      const mixer = project.mixer || {}
      const masterGain = clamp(Number(mixer.master ?? 1), 0, 2)
      let active = 0
      let maxDrift = 0

      tracks.forEach((track, index) => {
        const node = audioNodes.get(trackKey(track, index))
        if (!node) return
        const duration = audioTrackDuration(track)
        const local = time - Number(track.startAt)
        const isActive = local >= -.001 && local < duration - .001
        if (!isActive) {
          node.element.pause()
          node.element.playbackRate = 1
          return
        }

        active += 1
        const targetTime = Number(track.sourceStart) + clamp(local, 0, duration)
        const drift = Number.isFinite(node.element.currentTime) ? node.element.currentTime - targetTime : 0
        maxDrift = Math.max(maxDrift, Math.abs(drift))
        const busGain = track.linkedClipId ? clamp(Number(mixer.video ?? 1), 0, 2) : clamp(Number(mixer.music ?? 1), 0, 2)
        const gain = clamp(Number(track.volume) || 0, 0, 2)
          * fadeGain(track, clamp(local, 0, duration), duration)
          * automationGain(track.automation, clamp(local, 0, duration))
          * busGain
          * masterGain
        node.element.volume = clamp(gain, 0, 1)

        const exactSeek = !playing || source === 'SCRUB' || source === 'SEEK' || source === 'XFADE'
        if (exactSeek || Math.abs(drift) >= HARD_DRIFT_SECONDS) {
          setMediaTime(node.element, targetTime)
          node.element.playbackRate = 1
        } else if (Math.abs(drift) >= SOFT_DRIFT_SECONDS) {
          node.element.playbackRate = clamp(1 - drift * .35, 1 - MAX_RATE_NUDGE, 1 + MAX_RATE_NUDGE)
        } else {
          node.element.playbackRate = 1
        }

        if (playing) {
          if (node.element.paused) void node.element.play().catch(() => undefined)
        } else {
          node.element.pause()
        }
      })

      return { active, maxDrift }
    }

    const syncOverlays = (time: number, playing: boolean, source: string) => {
      const clips = Array.isArray(project.clips) ? project.clips : []
      const activeClips = clips.filter((clip) => {
        if (clip.lane !== 'V2' && clip.lane !== 'V3') return false
        const local = time - Number(clip.startAt)
        return local >= -.001 && local < videoClipDuration(clip) - .001
      })
      const videos = overlayVideos()
      let maxDrift = 0

      videos.forEach((video, index) => {
        const clip = activeClips[index]
        if (!clip) {
          video.pause()
          return
        }
        const local = clamp(time - Number(clip.startAt), 0, videoClipDuration(clip))
        const rate = Math.max(.25, Number(clip.speed) || 1)
        const targetTime = Number(clip.start) + local * rate
        const drift = Number.isFinite(video.currentTime) ? video.currentTime - targetTime : 0
        maxDrift = Math.max(maxDrift, Math.abs(drift))

        if (clip.freezeFrame) {
          video.pause()
          video.playbackRate = 1
          setMediaTime(video, Number(clip.start))
          return
        }

        video.playbackRate = rate
        const exactSeek = !playing || source === 'SCRUB' || source === 'SEEK' || source === 'XFADE'
        if (exactSeek || Math.abs(drift) >= HARD_DRIFT_SECONDS) setMediaTime(video, targetTime)
        if (playing) {
          if (video.paused) void video.play().catch(() => undefined)
        } else video.pause()
      })

      return { active: Math.min(videos.length, activeClips.length), maxDrift }
    }

    const onFrameClock = (event: Event) => {
      const detail = (event as CustomEvent<FrameClockDetail>).detail || {}
      const time = Math.max(0, Number(detail.time) || 0)
      const playing = Boolean(detail.playing)
      const source = String(detail.source || 'CLOCK')
      const audio = syncAudio(time, playing, source)
      const overlays = syncOverlays(time, playing, source)
      const now = performance.now()
      if (now - lastStatusAt < 180) return
      lastStatusAt = now
      const storedTracks = Array.isArray(project.audioTracks) ? project.audioTracks.length : 0
      const liveTracks = liveAudioClipCount()
      const warning = liveTracks > storedTracks ? 'SAVE REQUIRED FOR NEW AUDIO' : ''
      setStatus({
        activeAudio: audio.active,
        activeOverlays: overlays.active,
        maxDriftMs: Math.round(Math.max(audio.maxDrift, overlays.maxDrift) * 1000),
        mode: playing ? source : 'PAUSED',
        warning,
      })
    }

    const onSnapshotChanged = () => { void loadSnapshot() }
    const onActiveProjectChanged = () => { void loadSnapshot() }
    const observer = new MutationObserver(() => updatePortalTarget())
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('maghrabi-frame-clock', onFrameClock as EventListener)
    window.addEventListener('maghrabi-project-snapshot-changed', onSnapshotChanged as EventListener)
    window.addEventListener('maghrabi-active-project-changed', onActiveProjectChanged as EventListener)

    updatePortalTarget()
    void loadSnapshot()

    return () => {
      disposed = true
      loadGeneration += 1
      observer.disconnect()
      window.removeEventListener('maghrabi-frame-clock', onFrameClock as EventListener)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSnapshotChanged as EventListener)
      window.removeEventListener('maghrabi-active-project-changed', onActiveProjectChanged as EventListener)
      destroyAudioNodes()
      snapshot = null
    }
  }, [])

  if (!target) return null

  return createPortal(
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-300/10 bg-emerald-300/[.035] px-3 py-2" dir="ltr" aria-label="Unified audio video sync engine">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,.65)]" />
        <span className="text-[8px] font-black tracking-[.12em] text-emerald-200">A/V SYNC LOCK</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 font-mono text-[8px] text-slate-500">
        <span>A {status.activeAudio}</span>
        <span>OVR {status.activeOverlays}</span>
        <span>DRIFT {status.maxDriftMs}ms</span>
        <span>{status.mode}</span>
        {status.warning && <span className="rounded-md border border-amber-300/20 bg-amber-300/[.06] px-1.5 py-0.5 font-sans font-black text-amber-200">{status.warning}</span>}
      </div>
    </div>,
    target,
  )
}
