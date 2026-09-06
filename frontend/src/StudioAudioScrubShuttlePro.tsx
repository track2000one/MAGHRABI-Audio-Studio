import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AudioWaveform, ChevronsLeft, ChevronsRight, CircleStop, PlayCircle } from 'lucide-react'
import { dbToLinear, loadAudioMixerSettings, sanitizeAudioMixerSettings, type AudioMixerLane, type AudioMixerSettings } from './lib/audioMixerSettings'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import './studioAudioScrubShuttlePro.css'

type AutomationPoint = { time: number; gain: number }
type AudioTrack = {
  id: string
  lane: AudioMixerLane
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  volume: number
  fadeIn: number
  fadeOut: number
  automation?: AutomationPoint[]
  name?: string
  [key: string]: unknown
}
type ProjectShape = {
  audioTracks?: AudioTrack[]
  [key: string]: unknown
}
type ShuttleUiState = {
  rate: number
  scrubEnabled: boolean
  previewing: boolean
}
type GrainGraph = {
  context: AudioContext
  limiter: DynamicsCompressorNode
}

type ShuttleCommand = 'j' | 'k' | 'l' | 'preview' | 'toggle-scrub'

const ROOT = '.maghrabi-studio-pro main'
const HEADER_WIDTH = 122
const SCRUB_STORAGE_KEY = 'maghrabi-audio-scrub-enabled-v1'
const SPEEDS = [1, 2, 4, 8] as const
const SCRUB_INTERVAL_MS = 62
const SHUTTLE_INTERVAL_MS = 34
const SHUTTLE_GRAIN_INTERVAL_MS = 92
const GRAIN_OUTPUT_SECONDS = .12
const PRE_ROLL_SECONDS = 3
const POST_ROLL_SECONDS = 2
const LANES: AudioMixerLane[] = ['A1', 'A2', 'A3']

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function parseClock(value: string) {
  const match = value.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/)
  if (!match) return Number.NaN
  return Number(match[1]) * 60 + Number(match[2])
}

function parseZoom() {
  for (const span of Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function timelineRoot() {
  return document.querySelector<HTMLElement>('.maghrabi-time-ruler')?.parentElement || null
}

function playheadTime() {
  const timeline = timelineRoot()
  const playhead = document.querySelector<HTMLElement>('.maghrabi-playhead')
  if (!timeline || !playhead) return 0
  const zoom = parseZoom()
  const timelineRect = timeline.getBoundingClientRect()
  const playheadRect = playhead.getBoundingClientRect()
  return Math.max(0, (playheadRect.left + playheadRect.width / 2 - timelineRect.left - HEADER_WIDTH) / zoom)
}

function findScrubTarget(timeline: HTMLElement) {
  const adjustmentRow = Array.from(timeline.children).find((child) => child instanceof HTMLElement && child.className.includes('h-[52px]')) as HTMLElement | undefined
  return adjustmentRow?.lastElementChild as HTMLElement | null
}

function jumpToTime(time: number) {
  const timeline = timelineRoot()
  if (!timeline) return false
  const target = findScrubTarget(timeline)
  if (!target) return false
  const rect = target.getBoundingClientRect()
  const zoom = parseZoom()
  if (!rect.width) return false
  const x = Math.max(rect.left, Math.min(rect.right - 1, rect.left + Math.max(0, time) * zoom))
  target.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: rect.top + rect.height / 2,
    view: window,
  }))
  return true
}

function clipTiming(button: HTMLButtonElement) {
  for (const span of Array.from(button.querySelectorAll<HTMLSpanElement>('span'))) {
    const match = (span.textContent || '').match(/(\d+:\d+(?:\.\d+)?)\s*·\s*(\d+:\d+(?:\.\d+)?)/)
    if (!match) continue
    const start = parseClock(match[1])
    const duration = parseClock(match[2])
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) return { start, duration }
  }
  return null
}

function sequenceBounds() {
  const timeline = timelineRoot()
  if (!timeline) return { start: 0, end: 0 }
  const zoom = parseZoom()
  const clips = Array.from(timeline.querySelectorAll<HTMLButtonElement>('button[style*="left"][style*="width"]'))
    .filter((button) => /^V1\s*·/i.test((button.textContent || '').trim()))
    .map((button) => {
      const timing = clipTiming(button)
      const start = timing?.start ?? Math.max(0, (Number.parseFloat(button.style.left) || 0) / zoom)
      const duration = timing?.duration ?? Math.max(.02, (Number.parseFloat(button.style.width) || button.getBoundingClientRect().width || 0) / zoom)
      return { start, end: start + duration }
    })
    .sort((a, b) => a.start - b.start)
  if (!clips.length) return { start: 0, end: 0 }
  return { start: clips[0].start, end: Math.max(...clips.map((clip) => clip.end)) }
}

function programPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
}

function programVideo() {
  return programPanel()?.querySelector<HTMLVideoElement>('.aspect-video > video:not([controls])') || null
}

function nativeTransportButton() {
  const panel = programPanel()
  if (!panel) return null
  return Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find((button) => /^(PLAY|PAUSE)/i.test((button.textContent || '').trim())) || null
}

function setNativePlaying(wanted: boolean) {
  const button = nativeTransportButton()
  if (!button || button.disabled) return false
  const text = (button.textContent || '').trim().toUpperCase()
  const playing = /^PAUSE/.test(text)
  if (playing !== wanted) button.click()
  return true
}

function playbackActive() {
  if (document.documentElement.dataset.maghrabiSequencePlaying === '1') return true
  const video = programVideo()
  return Boolean(video && !video.paused && !video.ended)
}

function isTyping(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
}

function automationGain(track: AudioTrack, localTime: number) {
  const points = [...(track.automation || [])]
    .filter((point) => Number.isFinite(Number(point.time)) && Number.isFinite(Number(point.gain)))
    .sort((a, b) => Number(a.time) - Number(b.time))
  if (!points.length) return 1
  if (localTime <= Number(points[0].time)) return clamp(Number(points[0].gain), 0, 2)
  const last = points[points.length - 1]
  if (localTime >= Number(last.time)) return clamp(Number(last.gain), 0, 2)
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]
    if (localTime > Number(right.time)) continue
    const left = points[index - 1]
    const span = Math.max(.001, Number(right.time) - Number(left.time))
    const mix = clamp((localTime - Number(left.time)) / span, 0, 1)
    return clamp(Number(left.gain) + (Number(right.gain) - Number(left.gain)) * mix, 0, 2)
  }
  return 1
}

function fadeGain(track: AudioTrack, localTime: number) {
  const duration = Math.max(.02, Number(track.sourceEnd) - Number(track.sourceStart))
  let gain = 1
  const fadeIn = Math.max(0, Number(track.fadeIn) || 0)
  const fadeOut = Math.max(0, Number(track.fadeOut) || 0)
  if (fadeIn > .001) gain *= clamp(localTime / fadeIn, 0, 1)
  if (fadeOut > .001) gain *= clamp((duration - localTime) / fadeOut, 0, 1)
  return gain
}

function trackGain(track: AudioTrack, timelineTime: number) {
  const localTime = timelineTime - Number(track.startAt)
  return clamp(Number(track.volume ?? 1), 0, 2) * automationGain(track, localTime) * fadeGain(track, localTime)
}

function fileFingerprint(files: File[]) {
  return files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join('|')
}

function reverseSegment(context: AudioContext, source: AudioBuffer, startSeconds: number, endSeconds: number) {
  const startFrame = clamp(Math.floor(startSeconds * source.sampleRate), 0, source.length - 1)
  const endFrame = clamp(Math.ceil(endSeconds * source.sampleRate), startFrame + 1, source.length)
  const length = Math.max(1, endFrame - startFrame)
  const buffer = context.createBuffer(source.numberOfChannels, length, source.sampleRate)
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    const input = source.getChannelData(channel)
    const output = buffer.getChannelData(channel)
    for (let index = 0; index < length; index += 1) output[index] = input[endFrame - 1 - index] || 0
  }
  return buffer
}

function dispatchCommand(command: ShuttleCommand) {
  window.dispatchEvent(new CustomEvent<{ command: ShuttleCommand }>('maghrabi-audio-shuttle-command', { detail: { command } }))
}

export default function StudioAudioScrubShuttlePro() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [ui, setUi] = useState<ShuttleUiState>(() => ({
    rate: 0,
    scrubEnabled: typeof window === 'undefined' ? true : window.localStorage.getItem(SCRUB_STORAGE_KEY) !== '0',
    previewing: false,
  }))

  useEffect(() => {
    let disposed = false
    let graph: GrainGraph | null = null
    let snapshot: StoredVideoProject<ProjectShape> | null = null
    let settings: AudioMixerSettings = loadAudioMixerSettings(getActiveStudioProjectId())
    let projectId = getActiveStudioProjectId()
    let buffersFingerprint = ''
    let decodeGeneration = 0
    let currentRate = 0
    let scrubEnabled = window.localStorage.getItem(SCRUB_STORAGE_KEY) !== '0'
    let previewing = false
    let previewTimer = 0
    let previewOrigin = 0
    let previewEnd = 0
    let manualRaf = 0
    let manualTime = 0
    let lastManualTick = 0
    let lastManualSeek = 0
    let lastShuttleGrain = 0
    let lastScrubTime = playheadTime()
    let lastScrubClock = performance.now()
    let lastScrubGrain = 0
    const buffers = new Map<number, AudioBuffer>()
    const activeGrains = new Set<AudioBufferSourceNode>()

    const publishUi = () => {
      if (disposed) return
      setUi({ rate: currentRate, scrubEnabled, previewing })
      document.documentElement.dataset.maghrabiShuttleRate = String(currentRate)
      document.documentElement.dataset.maghrabiAudioScrub = scrubEnabled ? 'on' : 'off'
      document.documentElement.dataset.maghrabiPrePostPreview = previewing ? '1' : '0'
      window.dispatchEvent(new CustomEvent('maghrabi-shuttle-state', {
        detail: { rate: currentRate, scrubEnabled, previewing, projectId },
      }))
    }

    const ensureGraph = () => {
      if (graph) return graph
      const context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
      const limiter = context.createDynamicsCompressor()
      limiter.connect(context.destination)
      graph = { context, limiter }
      return graph
    }

    const applyLimiter = () => {
      const engine = ensureGraph()
      const now = engine.context.currentTime
      if (settings.master.limiterEnabled) {
        engine.limiter.threshold.setTargetAtTime(settings.master.limiterCeilingDb, now, .01)
        engine.limiter.knee.setTargetAtTime(0, now, .01)
        engine.limiter.ratio.setTargetAtTime(20, now, .01)
        engine.limiter.attack.setTargetAtTime(.003, now, .01)
        engine.limiter.release.setTargetAtTime(.08, now, .01)
      } else {
        engine.limiter.threshold.setTargetAtTime(0, now, .01)
        engine.limiter.knee.setTargetAtTime(0, now, .01)
        engine.limiter.ratio.setTargetAtTime(1, now, .01)
      }
    }

    const stopGrains = () => {
      for (const source of Array.from(activeGrains)) {
        try { source.stop() } catch {}
        try { source.disconnect() } catch {}
      }
      activeGrains.clear()
    }

    const decodeAudioFiles = async (files: File[]) => {
      const fingerprint = fileFingerprint(files)
      if (fingerprint === buffersFingerprint && buffers.size === files.length) return
      buffersFingerprint = fingerprint
      const generation = ++decodeGeneration
      buffers.clear()
      if (!files.length) return
      const engine = ensureGraph()
      await Promise.all(files.map(async (file, index) => {
        try {
          const data = (await file.arrayBuffer()).slice(0)
          const buffer = await engine.context.decodeAudioData(data)
          if (!disposed && generation === decodeGeneration) buffers.set(index, buffer)
        } catch (error) {
          console.warn(`[MAGHRABI Audio Scrub] Could not decode ${file.name}:`, error)
        }
      }))
    }

    const reloadProject = async () => {
      const nextId = getActiveStudioProjectId()
      const changed = nextId !== projectId
      projectId = nextId
      settings = loadAudioMixerSettings(nextId)
      if (graph) applyLimiter()
      const next = nextId ? await loadStoredVideoProject<ProjectShape>(nextId).catch(() => null) : null
      if (disposed) return
      snapshot = next
      if (changed) {
        buffersFingerprint = ''
        buffers.clear()
        stopGrains()
      }
      if (graph) await decodeAudioFiles(next?.audios || [])
    }

    const prepareAudio = () => {
      const engine = ensureGraph()
      applyLimiter()
      void engine.context.resume().catch(() => undefined)
      if (snapshot) void decodeAudioFiles(snapshot.audios || [])
      else void reloadProject()
    }

    const playGrain = (timelineTime: number, direction: 1 | -1, speed: number) => {
      const engine = graph
      const project = snapshot?.project
      if (!engine || engine.context.state !== 'running' || !project) return
      const tracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
      if (!tracks.length || !buffers.size) return

      stopGrains()
      const anySolo = LANES.some((lane) => settings.channels[lane].solo)
      const rate = clamp(Math.abs(speed), .5, 4)
      const requestedSourceSpan = GRAIN_OUTPUT_SECONDS * rate
      const masterGain = dbToLinear(settings.master.gainDb)
      const now = engine.context.currentTime

      for (const track of tracks) {
        if (!LANES.includes(track.lane)) continue
        const channel = settings.channels[track.lane]
        if (channel.muted || (anySolo && !channel.solo)) continue
        const timelineDuration = Math.max(.02, Number(track.sourceEnd) - Number(track.sourceStart))
        const localTime = timelineTime - Number(track.startAt)
        if (localTime < 0 || localTime >= timelineDuration) continue
        const buffer = buffers.get(Number(track.fileIndex))
        if (!buffer) continue

        const sourcePosition = clamp(Number(track.sourceStart) + localTime, 0, buffer.duration)
        const clipGain = trackGain(track, timelineTime)
        const totalGain = clamp(clipGain * dbToLinear(channel.gainDb) * masterGain, 0, 4)
        if (totalGain <= .00001) continue

        const source = engine.context.createBufferSource()
        const gain = engine.context.createGain()
        const panner = engine.context.createStereoPanner()
        source.playbackRate.value = rate
        panner.pan.value = clamp(channel.pan, -1, 1)
        gain.gain.setValueAtTime(0, now)
        gain.gain.linearRampToValueAtTime(totalGain, now + .008)
        gain.gain.setValueAtTime(totalGain, now + Math.max(.012, GRAIN_OUTPUT_SECONDS - .018))
        gain.gain.linearRampToValueAtTime(0, now + GRAIN_OUTPUT_SECONDS)
        source.connect(gain)
        gain.connect(panner)
        panner.connect(engine.limiter)

        if (direction > 0) {
          const available = Math.min(Number(track.sourceEnd), buffer.duration) - sourcePosition
          const span = Math.min(requestedSourceSpan, available)
          if (span <= .008) continue
          source.buffer = buffer
          try { source.start(now, sourcePosition, span) } catch { continue }
        } else {
          const lowerBound = Math.max(0, Number(track.sourceStart))
          const span = Math.min(requestedSourceSpan, sourcePosition - lowerBound)
          if (span <= .008) continue
          source.buffer = reverseSegment(engine.context, buffer, sourcePosition - span, sourcePosition)
          try { source.start(now) } catch { continue }
        }

        activeGrains.add(source)
        source.onended = () => {
          activeGrains.delete(source)
          try { source.disconnect() } catch {}
          try { gain.disconnect() } catch {}
          try { panner.disconnect() } catch {}
        }
      }
    }

    const setRate = (rate: number) => {
      currentRate = rate
      publishUi()
    }

    const cancelPreview = (restore = false) => {
      if (!previewing) return
      window.clearInterval(previewTimer)
      previewTimer = 0
      previewing = false
      setNativePlaying(false)
      if (restore) jumpToTime(previewOrigin)
      publishUi()
    }

    const cancelManual = () => {
      window.cancelAnimationFrame(manualRaf)
      manualRaf = 0
      lastManualTick = 0
      lastManualSeek = 0
      lastShuttleGrain = 0
      stopGrains()
    }

    const stopEverything = (restorePreview = false) => {
      cancelManual()
      cancelPreview(restorePreview)
      setNativePlaying(false)
      setRate(0)
    }

    const manualStep = (clock: number) => {
      if (disposed || currentRate === 0 || currentRate === 1) return
      if (!lastManualTick) lastManualTick = clock
      const delta = Math.min(.12, Math.max(0, (clock - lastManualTick) / 1000))
      lastManualTick = clock
      manualTime += currentRate * delta
      const bounds = sequenceBounds()
      if (bounds.end <= bounds.start + .02) {
        stopEverything()
        return
      }
      manualTime = clamp(manualTime, bounds.start, bounds.end)

      if (clock - lastManualSeek >= SHUTTLE_INTERVAL_MS) {
        jumpToTime(manualTime)
        lastManualSeek = clock
      }
      if (scrubEnabled && clock - lastShuttleGrain >= SHUTTLE_GRAIN_INTERVAL_MS) {
        playGrain(manualTime, currentRate < 0 ? -1 : 1, Math.abs(currentRate))
        lastShuttleGrain = clock
      }
      if (manualTime <= bounds.start + .001 || manualTime >= bounds.end - .001) {
        stopEverything()
        return
      }
      manualRaf = window.requestAnimationFrame(manualStep)
    }

    const startManual = (rate: number) => {
      cancelPreview(false)
      cancelManual()
      setNativePlaying(false)
      prepareAudio()
      manualTime = playheadTime()
      setRate(rate)
      manualRaf = window.requestAnimationFrame(manualStep)
    }

    const nextDirectionalRate = (direction: 1 | -1) => {
      const sameDirection = Math.sign(currentRate) === direction
      if (!sameDirection || currentRate === 0) return direction
      const currentAbs = Math.abs(currentRate)
      const index = SPEEDS.findIndex((speed) => speed >= currentAbs)
      return direction * SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, index + 1))]
    }

    const shuttle = (direction: 1 | -1) => {
      const next = nextDirectionalRate(direction)
      cancelPreview(false)
      if (next === 1) {
        cancelManual()
        prepareAudio()
        setRate(1)
        setNativePlaying(true)
      } else {
        startManual(next)
      }
    }

    const previewAroundPlayhead = () => {
      const bounds = sequenceBounds()
      if (bounds.end <= bounds.start + .02) return
      stopEverything(false)
      previewOrigin = playheadTime()
      const start = Math.max(bounds.start, previewOrigin - PRE_ROLL_SECONDS)
      previewEnd = Math.min(bounds.end, previewOrigin + POST_ROLL_SECONDS)
      if (previewEnd <= start + .04) return
      previewing = true
      publishUi()
      jumpToTime(start)
      window.setTimeout(() => {
        if (!previewing || disposed) return
        prepareAudio()
        setNativePlaying(true)
      }, 70)
      previewTimer = window.setInterval(() => {
        if (!previewing) return
        const time = playheadTime()
        if (time >= previewEnd - .035 || (!playbackActive() && time > start + .08)) cancelPreview(true)
      }, 32)
    }

    const toggleScrub = () => {
      scrubEnabled = !scrubEnabled
      window.localStorage.setItem(SCRUB_STORAGE_KEY, scrubEnabled ? '1' : '0')
      if (!scrubEnabled) stopGrains()
      publishUi()
    }

    const runCommand = (command: ShuttleCommand) => {
      if (command === 'j') shuttle(-1)
      else if (command === 'k') stopEverything(false)
      else if (command === 'l') shuttle(1)
      else if (command === 'preview') previewAroundPlayhead()
      else if (command === 'toggle-scrub') toggleScrub()
    }

    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (event.shiftKey && event.code === 'Space') {
        event.preventDefault()
        event.stopImmediatePropagation()
        previewAroundPlayhead()
        return
      }
      if (event.repeat || !['j', 'k', 'l'].includes(key)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      runCommand(key as 'j' | 'k' | 'l')
    }

    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<{ command?: ShuttleCommand }>).detail?.command
      if (command) runCommand(command)
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest('.maghrabi-playhead, .maghrabi-time-ruler')) return
      if (currentRate !== 0 || previewing) stopEverything(false)
      if (scrubEnabled) prepareAudio()
      lastScrubTime = playheadTime()
      lastScrubClock = performance.now()
      lastScrubGrain = 0
    }

    const onNativeClick = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(`${ROOT} button`) : null
      if (!button || button.closest('.maghrabi-audio-shuttle-panel')) return
      const text = (button.textContent || '').trim().toUpperCase()
      if (/^PLAY/.test(text)) {
        cancelManual()
        cancelPreview(false)
        setRate(1)
      } else if (/^PAUSE/.test(text)) {
        cancelManual()
        if (!previewing) setRate(0)
      }
    }

    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; settings?: AudioMixerSettings }>).detail
      if (detail?.projectId && projectId && detail.projectId !== projectId) return
      settings = detail?.settings ? sanitizeAudioMixerSettings(detail.settings) : loadAudioMixerSettings(projectId)
      if (graph) applyLimiter()
    }

    const onProject = () => {
      stopEverything(false)
      void reloadProject()
    }

    const onSnapshot = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null }>).detail
      if (detail?.projectId && projectId && detail.projectId !== projectId) return
      void reloadProject()
    }

    const scrubTimer = window.setInterval(() => {
      if (!scrubEnabled || !document.body.classList.contains('maghrabi-scrubbing')) return
      const now = performance.now()
      const time = playheadTime()
      const deltaTime = time - lastScrubTime
      const deltaClock = Math.max(.01, (now - lastScrubClock) / 1000)
      if (Math.abs(deltaTime) >= .008 && now - lastScrubGrain >= SCRUB_INTERVAL_MS) {
        const direction: 1 | -1 = deltaTime < 0 ? -1 : 1
        const velocity = clamp(Math.abs(deltaTime / deltaClock), .5, 4)
        playGrain(time, direction, velocity)
        lastScrubGrain = now
      }
      lastScrubTime = time
      lastScrubClock = now
    }, 28)

    const observer = new MutationObserver(() => {
      const next = programPanel()
      setHost((current) => current === next ? current : next)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    setHost(programPanel())

    window.addEventListener('keydown', onKey, true)
    window.addEventListener('maghrabi-audio-shuttle-command', onCommand as EventListener)
    window.addEventListener('maghrabi-audio-mixer-settings-changed', onSettings as EventListener)
    window.addEventListener('maghrabi-active-project-changed', onProject)
    window.addEventListener('maghrabi-project-snapshot-changed', onSnapshot as EventListener)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('click', onNativeClick, true)

    void reloadProject()
    publishUi()

    return () => {
      disposed = true
      observer.disconnect()
      window.clearInterval(scrubTimer)
      window.clearInterval(previewTimer)
      window.cancelAnimationFrame(manualRaf)
      stopGrains()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('maghrabi-audio-shuttle-command', onCommand as EventListener)
      window.removeEventListener('maghrabi-audio-mixer-settings-changed', onSettings as EventListener)
      window.removeEventListener('maghrabi-active-project-changed', onProject)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSnapshot as EventListener)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('click', onNativeClick, true)
      delete document.documentElement.dataset.maghrabiShuttleRate
      delete document.documentElement.dataset.maghrabiAudioScrub
      delete document.documentElement.dataset.maghrabiPrePostPreview
      if (graph) void graph.context.close().catch(() => undefined)
    }
  }, [])

  if (!host) return null

  const direction = ui.rate < 0 ? 'REV' : ui.rate > 0 ? 'FWD' : 'STOP'
  const speed = ui.rate === 0 ? '0×' : `${Math.abs(ui.rate)}×`

  return createPortal(
    <div className="maghrabi-audio-shuttle-panel" dir="ltr" aria-label="Professional audio scrub and shuttle controls">
      <div className="maghrabi-audio-shuttle-head">
        <span className="maghrabi-audio-shuttle-title"><AudioWaveform size={13} /> AUDIO SCRUB / SHUTTLE</span>
        <button type="button" className={`maghrabi-audio-scrub-toggle${ui.scrubEnabled ? ' is-on' : ''}`} onClick={() => dispatchCommand('toggle-scrub')} title="تشغيل/إيقاف سماع الصوت أثناء سحب الـPlayhead">
          SCRUB {ui.scrubEnabled ? 'ON' : 'OFF'}
        </button>
      </div>
      <div className="maghrabi-audio-shuttle-controls">
        <button type="button" onClick={() => dispatchCommand('j')} title="J · تشغيل عكسي، والضغط المتكرر: 1× / 2× / 4× / 8×"><ChevronsLeft size={14} /><span>J</span></button>
        <button type="button" className="is-stop" onClick={() => dispatchCommand('k')} title="K · إيقاف Shuttle"><CircleStop size={13} /><span>K</span></button>
        <button type="button" onClick={() => dispatchCommand('l')} title="L · تشغيل أمامي، والضغط المتكرر: 1× / 2× / 4× / 8×"><ChevronsRight size={14} /><span>L</span></button>
        <span className={`maghrabi-audio-shuttle-speed${ui.rate !== 0 ? ' is-active' : ''}${ui.rate < 0 ? ' is-reverse' : ''}`}><strong>{speed}</strong><small>{direction}</small></span>
        <button type="button" className={`maghrabi-audio-preview-edit${ui.previewing ? ' is-live' : ''}`} onClick={() => dispatchCommand('preview')} title="Shift+Space · معاينة 3 ثوانٍ قبل المؤشر وثانيتين بعده">
          <PlayCircle size={13} /><span>{ui.previewing ? 'PREVIEWING' : 'PREVIEW EDIT'}</span><small>-3s / +2s</small>
        </button>
      </div>
      <div className="maghrabi-audio-shuttle-foot">J/K/L SHUTTLE · SHIFT+SPACE PRE/POST · 120ms GRAIN AUDITION · MIXER-AWARE</div>
    </div>,
    host,
  )
}
