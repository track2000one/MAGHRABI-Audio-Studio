import { useEffect } from 'react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject } from './lib/projectStore'

const ROOT = '.maghrabi-studio-pro main'
const HEADER_WIDTH = 122
const MIN_DURATION = .08
const MAX_DURATION = 1.5
const CUT_TOLERANCE = .35

const TRANSITIONS = new Set([
  'fade',
  'fadeblack',
  'fadewhite',
  'dissolve',
  'wipeleft',
  'wiperight',
  'slideleft',
  'slideright',
  'smoothleft',
  'smoothright',
  'circleopen',
  'circleclose',
  'pixelize',
])

type TransitionOut = {
  type?: string
  duration?: number
  rightFileIndex?: number
  rightSourceStart?: number
}

type PreviewClip = {
  id: string
  lane?: string
  fileIndex: number
  startAt: number
  start: number
  end: number
  speed: number
  freezeFrame?: boolean
  freezeDuration?: number
  transitionOut?: TransitionOut | null
}

type ProjectShape = {
  clips?: PreviewClip[]
  transition?: string
  transitionDuration?: number
  [key: string]: unknown
}

type TransitionSpec = {
  type: string
  duration: number
}

type SkipPlan = {
  type: string
  rightFileIndex: number
  rightTimelineStart: number
  rightSourceStart: number
  sourceSkip: number
  timelineSkip: number
  expiresAt: number
}

type PreviewLayer = {
  host: HTMLElement
  root: HTMLDivElement
  video: HTMLVideoElement
  flash: HTMLDivElement
  hud: HTMLDivElement
  progress: HTMLDivElement
  label: HTMLSpanElement
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function parseClock(value: string) {
  const match = value.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/)
  if (!match) return Number.NaN
  return Number(match[1]) * 60 + Number(match[2])
}

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))
  for (const span of spans) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function programPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
}

function programSurface() {
  return programPanel()?.querySelector<HTMLElement>('.aspect-video') || null
}

function programVideo() {
  return programSurface()?.querySelector<HTMLVideoElement>(':scope > video:not([controls])') || null
}

function programClock() {
  const panel = programPanel()
  if (!panel) return 0
  for (const item of Array.from(panel.querySelectorAll<HTMLElement>('p'))) {
    const match = (item.textContent || '').match(/(\d+:\d+(?:\.\d+)?)\s*·\s*V1\s*Program/i)
    if (!match) continue
    const parsed = parseClock(match[1])
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function playheadTime() {
  const timeline = document.querySelector<HTMLElement>('.maghrabi-time-ruler')?.parentElement || null
  const playhead = document.querySelector<HTMLElement>('.maghrabi-playhead')
  if (!timeline || !playhead) return programClock()
  const zoom = parseZoom()
  const timelineRect = timeline.getBoundingClientRect()
  const playheadRect = playhead.getBoundingClientRect()
  return Math.max(0, (playheadRect.left + playheadRect.width / 2 - timelineRect.left - HEADER_WIDTH) / zoom)
}

function clipDuration(clip: PreviewClip) {
  if (clip.freezeFrame) return Math.max(.2, Number(clip.freezeDuration) || 2)
  return Math.max(.02, (Number(clip.end) - Number(clip.start)) / Math.max(.25, Number(clip.speed) || 1))
}

function v1Clips(project: ProjectShape | null) {
  return [...(project?.clips || [])]
    .filter((clip) => clip.lane === 'V1' || !clip.lane)
    .sort((a, b) => Number(a.startAt) - Number(b.startAt))
}

function transitionForCut(project: ProjectShape, left: PreviewClip, right: PreviewClip): TransitionSpec | null {
  const spec = left.transitionOut
  if (spec && typeof spec === 'object') {
    const type = String(spec.type || 'none').toLowerCase()
    if (!TRANSITIONS.has(type)) return null
    if (spec.rightFileIndex !== undefined && Number(spec.rightFileIndex) !== Number(right.fileIndex)) return null
    if (spec.rightSourceStart !== undefined && Math.abs(Number(spec.rightSourceStart) - Number(right.start)) > .5) return null
    return {
      type,
      duration: clamp(Number(spec.duration) || .4, MIN_DURATION, MAX_DURATION),
    }
  }

  const fallback = String(project.transition || 'none').toLowerCase()
  if (!TRANSITIONS.has(fallback)) return null
  return {
    type: fallback,
    duration: clamp(Number(project.transitionDuration) || .45, MIN_DURATION, MAX_DURATION),
  }
}

function effectiveFade(project: ProjectShape, clips: PreviewClip[], leftIndex: number, requested: number) {
  if (!clips.length || leftIndex < 0 || leftIndex >= clips.length - 1) return 0
  let timelineDuration = clipDuration(clips[0])

  for (let index = 1; index <= leftIndex + 1; index += 1) {
    const right = clips[index]
    const spec = transitionForCut(project, clips[index - 1], right)
    if (!spec) {
      if (index === leftIndex + 1) return 0
      timelineDuration += clipDuration(right)
      continue
    }
    const fade = Math.min(
      index === leftIndex + 1 ? requested : spec.duration,
      Math.max(.05, clipDuration(right) / 3),
      Math.max(.05, timelineDuration / 3),
    )
    if (index === leftIndex + 1) return clamp(fade, .05, MAX_DURATION)
    timelineDuration += clipDuration(right) - fade
  }
  return 0
}

function resetVideoStyle(video: HTMLVideoElement) {
  video.style.opacity = '0'
  video.style.transform = 'none'
  video.style.clipPath = 'none'
  video.style.filter = 'none'
  video.style.imageRendering = 'auto'
  video.style.removeProperty('mask-image')
  video.style.removeProperty('-webkit-mask-image')
}

function applyVisual(video: HTMLVideoElement, flash: HTMLDivElement, type: string, progress: number) {
  const p = clamp(progress, 0, 1)
  const smooth = p * p * (3 - 2 * p)
  resetVideoStyle(video)
  flash.style.opacity = '0'
  flash.style.background = 'transparent'

  if (type === 'fadeblack' || type === 'fadewhite') {
    const firstHalf = p < .5
    video.style.opacity = firstHalf ? '0' : String(clamp((p - .5) * 2, 0, 1))
    flash.style.background = type === 'fadeblack' ? '#000' : '#fff'
    flash.style.opacity = String(1 - Math.abs(p * 2 - 1))
    return
  }

  if (type === 'wipeleft') {
    video.style.opacity = '1'
    video.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`
    return
  }
  if (type === 'wiperight') {
    video.style.opacity = '1'
    video.style.clipPath = `inset(0 0 0 ${(1 - p) * 100}%)`
    return
  }
  if (type === 'slideleft' || type === 'smoothleft') {
    const amount = type === 'smoothleft' ? smooth : p
    video.style.opacity = '1'
    video.style.transform = `translate3d(${(1 - amount) * 100}%,0,0)`
    return
  }
  if (type === 'slideright' || type === 'smoothright') {
    const amount = type === 'smoothright' ? smooth : p
    video.style.opacity = '1'
    video.style.transform = `translate3d(${-(1 - amount) * 100}%,0,0)`
    return
  }
  if (type === 'circleopen') {
    video.style.opacity = '1'
    video.style.clipPath = `circle(${smooth * 72}% at 50% 50%)`
    return
  }
  if (type === 'circleclose') {
    const radius = (1 - smooth) * 72
    video.style.opacity = String(clamp(p * 1.8, 0, 1))
    const mask = `radial-gradient(circle at 50% 50%, transparent 0 ${radius}%, #000 ${Math.min(100, radius + 2)}% 100%)`
    video.style.setProperty('mask-image', mask)
    video.style.setProperty('-webkit-mask-image', mask)
    return
  }
  if (type === 'pixelize') {
    video.style.opacity = String(p)
    video.style.filter = `blur(${(1 - p) * 7}px) contrast(${1 + (1 - p) * .45})`
    video.style.imageRendering = 'pixelated'
    return
  }

  video.style.opacity = String(p)
}

function makeLayer(host: HTMLElement): PreviewLayer {
  const root = document.createElement('div')
  root.className = 'maghrabi-transition-preview-layer'

  const video = document.createElement('video')
  video.className = 'maghrabi-transition-preview-video'
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'

  const flash = document.createElement('div')
  flash.className = 'maghrabi-transition-preview-flash'

  const hud = document.createElement('div')
  hud.className = 'maghrabi-transition-preview-hud'
  const label = document.createElement('span')
  const progressTrack = document.createElement('span')
  progressTrack.className = 'maghrabi-transition-preview-progress-track'
  const progress = document.createElement('span')
  progress.className = 'maghrabi-transition-preview-progress'
  progressTrack.appendChild(progress)
  hud.append(label, progressTrack)

  root.append(video, flash, hud)
  host.appendChild(root)
  return { host, root, video, flash, hud, progress, label }
}

function hideLayer(layer: PreviewLayer | null) {
  if (!layer) return
  layer.root.classList.remove('is-active')
  layer.video.pause()
  resetVideoStyle(layer.video)
  layer.flash.style.opacity = '0'
  layer.progress.style.width = '0%'
}

function setOverlaySource(video: HTMLVideoElement, url: string) {
  if (!url || video.src === url || video.currentSrc === url) return
  video.pause()
  video.src = url
  video.load()
}

function syncOverlay(video: HTMLVideoElement, target: number, rate: number, playing: boolean) {
  const safeTarget = Math.max(0, target)
  video.playbackRate = clamp(rate || 1, .25, 4)
  if (video.readyState >= 1 && Math.abs(video.currentTime - safeTarget) > .14) {
    try { video.currentTime = safeTarget } catch {}
  }
  if (playing) {
    if (video.paused) void video.play().catch(() => undefined)
  } else if (!video.paused) {
    video.pause()
  }
}

export default function StudioTransitionPreviewPro() {
  useEffect(() => {
    let disposed = false
    let project: ProjectShape | null = null
    let videoUrls: string[] = []
    let layer: PreviewLayer | null = null
    let frame = 0
    let armedPlan: SkipPlan | null = null
    let refreshToken = 0

    const revokeUrls = () => {
      for (const url of videoUrls) URL.revokeObjectURL(url)
      videoUrls = []
    }

    const refresh = async () => {
      const token = ++refreshToken
      const projectId = getActiveStudioProjectId()
      if (!projectId) {
        project = null
        revokeUrls()
        return
      }
      const snapshot = await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null)
      if (disposed || token !== refreshToken) return
      const nextUrls = (snapshot?.videos || []).map((file) => URL.createObjectURL(file))
      revokeUrls()
      videoUrls = nextUrls
      project = snapshot?.project || null
    }

    const ensureLayer = () => {
      const host = programSurface()
      if (!host) return null
      if (layer && layer.host === host && layer.root.isConnected) return layer
      layer?.root.remove()
      layer = makeLayer(host)
      return layer
    }

    const clearArmedPlan = () => {
      armedPlan = null
      delete document.documentElement.dataset.maghrabiTransitionSkip
    }

    const onSkipConsumed = () => {
      armedPlan = null
      hideLayer(layer)
    }

    const tick = () => {
      if (disposed) return
      const activeLayer = ensureLayer()
      const clips = v1Clips(project)
      const baseVideo = programVideo()
      let timelineTime = playheadTime()
      let currentIndex = clips.findIndex((clip) => timelineTime >= clip.startAt - .03 && timelineTime < clip.startAt + clipDuration(clip) + .03)

      if (currentIndex >= 0 && baseVideo && !baseVideo.paused) {
        const current = clips[currentIndex]
        const sourceElapsed = (baseVideo.currentTime - current.start) / Math.max(.25, current.speed || 1)
        if (Number.isFinite(sourceElapsed)) {
          timelineTime = clamp(current.startAt + sourceElapsed, current.startAt, current.startAt + clipDuration(current))
        }
      }
      currentIndex = clips.findIndex((clip) => timelineTime >= clip.startAt - .03 && timelineTime < clip.startAt + clipDuration(clip) + .03)

      let rendered = false
      if (project && activeLayer && currentIndex >= 0 && currentIndex < clips.length - 1) {
        const left = clips[currentIndex]
        const right = clips[currentIndex + 1]
        const cutAt = left.startAt + clipDuration(left)
        const gap = Math.abs(right.startAt - cutAt)
        const spec = gap <= CUT_TOLERANCE ? transitionForCut(project, left, right) : null
        const fade = spec ? effectiveFade(project, clips, currentIndex, spec.duration) : 0
        const startAt = cutAt - fade

        if (spec && fade > 0 && timelineTime >= startAt - .025 && timelineTime <= cutAt + .015) {
          const progress = clamp((timelineTime - startAt) / fade, 0, 1)
          const url = videoUrls[right.fileIndex] || ''
          if (url) {
            activeLayer.root.classList.add('is-active')
            setOverlaySource(activeLayer.video, url)
            const target = right.start + progress * fade * Math.max(.25, right.speed || 1)
            syncOverlay(activeLayer.video, target, right.speed, Boolean(baseVideo && !baseVideo.paused))
            applyVisual(activeLayer.video, activeLayer.flash, spec.type, progress)
            activeLayer.label.textContent = `TRANSITION PREVIEW · ${spec.type.toUpperCase()} · ${fade.toFixed(2)}s`
            activeLayer.progress.style.width = `${progress * 100}%`
            rendered = true

            if (document.documentElement.dataset.maghrabiSequencePlaying === '1' && baseVideo && !baseVideo.paused) {
              armedPlan = {
                type: spec.type,
                rightFileIndex: right.fileIndex,
                rightTimelineStart: right.startAt,
                rightSourceStart: right.start,
                sourceSkip: fade * Math.max(.25, right.speed || 1),
                timelineSkip: fade,
                expiresAt: Date.now() + 2500,
              }
              document.documentElement.dataset.maghrabiTransitionSkip = JSON.stringify(armedPlan)
            }
          }
        }
      }

      if (!rendered && activeLayer) {
        const sequenceRunning = document.documentElement.dataset.maghrabiSequencePlaying === '1'
        if (armedPlan && sequenceRunning && Date.now() <= armedPlan.expiresAt) {
          const url = videoUrls[armedPlan.rightFileIndex] || ''
          if (url) {
            activeLayer.root.classList.add('is-active')
            setOverlaySource(activeLayer.video, url)
            syncOverlay(
              activeLayer.video,
              armedPlan.rightSourceStart + armedPlan.sourceSkip,
              1,
              false,
            )
            applyVisual(activeLayer.video, activeLayer.flash, armedPlan.type, 1)
            activeLayer.label.textContent = `TRANSITION PREVIEW · ${armedPlan.type.toUpperCase()} · READY`
            activeLayer.progress.style.width = '100%'
            rendered = true
          }
        } else {
          if (armedPlan && (!sequenceRunning || Date.now() > armedPlan.expiresAt)) clearArmedPlan()
          hideLayer(activeLayer)
        }
      }

      frame = window.requestAnimationFrame(tick)
    }

    const refreshEvents = [
      'maghrabi-project-snapshot-changed',
      'maghrabi-transition-changed',
      'maghrabi-active-project-changed',
    ]
    for (const eventName of refreshEvents) window.addEventListener(eventName, refresh)
    window.addEventListener('maghrabi-transition-skip-consumed', onSkipConsumed)

    void refresh()
    frame = window.requestAnimationFrame(tick)

    return () => {
      disposed = true
      refreshToken += 1
      window.cancelAnimationFrame(frame)
      for (const eventName of refreshEvents) window.removeEventListener(eventName, refresh)
      window.removeEventListener('maghrabi-transition-skip-consumed', onSkipConsumed)
      clearArmedPlan()
      revokeUrls()
      layer?.root.remove()
      layer = null
    }
  }, [])

  return null
}
