import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, AudioLines } from 'lucide-react'
import {
  dbToLinear,
  loadAudioMixerSettings,
  sanitizeAudioMixerSettings,
  type AudioMixerLane,
  type AudioMixerSettings,
} from './lib/audioMixerSettings'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import './studioAudioMonitoringPro.css'

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
type MeterState = { peakDb: number; rmsDb: number; lufs: number }
type MeterMap = Record<AudioMixerLane | 'MASTER', MeterState>
type LaneGraph = {
  gain: GainNode
  panner: StereoPannerNode
  analyser: AnalyserNode
}
type MonitorGraph = {
  context: AudioContext
  lanes: Record<AudioMixerLane, LaneGraph>
  masterGain: GainNode
  limiter: DynamicsCompressorNode
  masterAnalyser: AnalyserNode
}
type Voice = {
  source: AudioBufferSourceNode
  gain: GainNode
  track: AudioTrack
}
type MonitorState = {
  active: boolean
  voices: number
  sampleRate: number
  latencyMs: number
  driftMs: number
}

type LiveMeterDetail = MonitorState & {
  meters: MeterMap
  projectId: string | null
  source: 'webaudio-live-bus'
}

const ROOT = '.maghrabi-studio-pro main'
const LANES: AudioMixerLane[] = ['A1', 'A2', 'A3']
const HEADER_WIDTH = 122
const SILENCE: MeterState = { peakDb: -60, rmsDb: -60, lufs: -60 }
const EMPTY_METERS: MeterMap = { A1: SILENCE, A2: SILENCE, A3: SILENCE, MASTER: SILENCE }
const RESYNC_THRESHOLD_SECONDS = .42

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function parseZoom() {
  for (const span of Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function currentPlayheadTime() {
  const playhead = document.querySelector<HTMLElement>('.maghrabi-playhead')
  const timeline = playhead?.parentElement
  if (!playhead || !timeline) return 0
  const timelineRect = timeline.getBoundingClientRect()
  const playheadRect = playhead.getBoundingClientRect()
  const center = playheadRect.left + playheadRect.width / 2
  return Math.max(0, (center - timelineRect.left - HEADER_WIDTH) / parseZoom())
}

function programPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
}

function programVideo() {
  return programPanel()?.querySelector<HTMLVideoElement>('.aspect-video > video:not([controls])') || null
}

function playbackActive() {
  if (document.documentElement.dataset.maghrabiSequencePlaying === '1') return true
  const video = programVideo()
  return Boolean(video && !video.paused && !video.ended)
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
  return clamp(Number(track.volume ?? 1), 0, 2)
    * automationGain(track, localTime)
    * fadeGain(track, localTime)
}

function linearToDb(value: number) {
  return value <= .000001 ? -60 : clamp(20 * Math.log10(value), -60, 6)
}

function analyserMeter(analyser: AnalyserNode, scratch: Float32Array) {
  analyser.getFloatTimeDomainData(scratch)
  let peak = 0
  let square = 0
  for (let index = 0; index < scratch.length; index += 1) {
    const sample = scratch[index]
    peak = Math.max(peak, Math.abs(sample))
    square += sample * sample
  }
  const rms = Math.sqrt(square / Math.max(1, scratch.length))
  const peakDb = linearToDb(peak)
  const rmsDb = linearToDb(rms)
  return { peakDb, rmsDb, lufs: clamp(rmsDb - .691, -60, 6) }
}

function meterPercent(db: number) {
  return `${clamp((db + 60) / 66 * 100, 0, 100).toFixed(2)}%`
}

function paintMixerMeters(meters: MeterMap, active: boolean) {
  const strips = Array.from(document.querySelectorAll<HTMLElement>('.maghrabi-audio-strip'))
  for (const strip of strips) {
    const lane = (strip.querySelector('strong')?.textContent || '').trim().toUpperCase() as AudioMixerLane | 'MASTER'
    if (!(lane in meters)) continue
    const meter = meters[lane]
    strip.classList.toggle('is-live-meter', active)
    strip.style.setProperty('--maghrabi-live-peak', meterPercent(meter.peakDb))
    strip.style.setProperty('--maghrabi-live-rms', meterPercent(meter.rmsDb))
    strip.dataset.livePeak = `${meter.peakDb.toFixed(1)} dB`
    strip.dataset.liveRms = `${meter.rmsDb.toFixed(1)} dBFS`
    strip.dataset.liveLufs = `${meter.lufs.toFixed(1)} LUFS-M`

    const value = strip.querySelector<HTMLElement>('.maghrabi-audio-strip-meter-value')
    if (value && active) value.textContent = `${meter.peakDb.toFixed(1)} dB`
    const meterBox = strip.querySelector<HTMLElement>('.maghrabi-audio-meter')
    if (meterBox) meterBox.title = active ? 'Real Web Audio bus · PEAK / RMS' : 'PEAK / RMS preview'

    if (active) {
      for (const label of Array.from(strip.querySelectorAll<HTMLElement>('.maghrabi-audio-field'))) {
        const text = (label.childNodes[0]?.textContent || label.textContent || '').trim().toUpperCase()
        const output = label.querySelector<HTMLElement>('span')
        if (!output) continue
        if (text.startsWith('MASTER RMS') || text === 'RMS') output.textContent = `${meter.rmsDb.toFixed(1)} dBFS`
        if (text.startsWith('LUFS-M')) output.textContent = meter.lufs.toFixed(1)
      }
    }
  }

  const status = document.querySelector<HTMLElement>('.maghrabi-audio-mixer-status')
  if (status && active) status.textContent = 'WEB AUDIO LIVE BUS'
}

function fileFingerprint(files: File[]) {
  return files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join('|')
}

export default function StudioAudioMonitoringPro() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [monitor, setMonitor] = useState<MonitorState>({ active: false, voices: 0, sampleRate: 0, latencyMs: 0, driftMs: 0 })

  useEffect(() => {
    let disposed = false
    let graph: MonitorGraph | null = null
    let snapshot: StoredVideoProject<ProjectShape> | null = null
    let settings: AudioMixerSettings = loadAudioMixerSettings(getActiveStudioProjectId())
    let projectId = getActiveStudioProjectId()
    let decodedFingerprint = ''
    let decodeGeneration = 0
    let lastUiUpdate = 0
    let lastMeterPaint = 0
    let anchorTimeline = 0
    let anchorContext = 0
    let anchored = false
    const voices = new Map<string, Voice>()
    const buffers = new Map<number, AudioBuffer>()
    const scratch = new Float32Array(1024)

    const ensureGraph = () => {
      if (graph) return graph
      const AudioContextCtor = window.AudioContext
      const context = new AudioContextCtor({ latencyHint: 'interactive', sampleRate: 48000 })
      const masterGain = context.createGain()
      const limiter = context.createDynamicsCompressor()
      const masterAnalyser = context.createAnalyser()
      masterAnalyser.fftSize = 1024
      masterAnalyser.smoothingTimeConstant = .42
      masterGain.connect(limiter)
      limiter.connect(masterAnalyser)
      masterAnalyser.connect(context.destination)

      const lanes = {} as Record<AudioMixerLane, LaneGraph>
      for (const lane of LANES) {
        const gain = context.createGain()
        const panner = context.createStereoPanner()
        const analyser = context.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = .38
        gain.connect(panner)
        panner.connect(analyser)
        analyser.connect(masterGain)
        lanes[lane] = { gain, panner, analyser }
      }
      graph = { context, lanes, masterGain, limiter, masterAnalyser }
      return graph
    }

    const applySettings = () => {
      const engine = ensureGraph()
      const now = engine.context.currentTime
      const anySolo = LANES.some((lane) => settings.channels[lane].solo)
      for (const lane of LANES) {
        const channel = settings.channels[lane]
        const audible = !channel.muted && (!anySolo || channel.solo)
        engine.lanes[lane].gain.gain.setTargetAtTime(audible ? dbToLinear(channel.gainDb) : 0, now, .012)
        engine.lanes[lane].panner.pan.setTargetAtTime(clamp(channel.pan, -1, 1), now, .012)
      }
      engine.masterGain.gain.setTargetAtTime(dbToLinear(settings.master.gainDb), now, .015)
      if (settings.master.limiterEnabled) {
        engine.limiter.threshold.setTargetAtTime(settings.master.limiterCeilingDb, now, .015)
        engine.limiter.knee.setTargetAtTime(0, now, .015)
        engine.limiter.ratio.setTargetAtTime(20, now, .015)
        engine.limiter.attack.setTargetAtTime(.003, now, .015)
        engine.limiter.release.setTargetAtTime(.08, now, .015)
      } else {
        engine.limiter.threshold.setTargetAtTime(0, now, .015)
        engine.limiter.knee.setTargetAtTime(0, now, .015)
        engine.limiter.ratio.setTargetAtTime(1, now, .015)
        engine.limiter.attack.setTargetAtTime(0, now, .015)
        engine.limiter.release.setTargetAtTime(.08, now, .015)
      }
    }

    const stopVoice = (id: string) => {
      const voice = voices.get(id)
      if (!voice) return
      voices.delete(id)
      try { voice.source.stop() } catch {}
      try { voice.source.disconnect() } catch {}
      try { voice.gain.disconnect() } catch {}
    }

    const stopAllVoices = () => {
      for (const id of Array.from(voices.keys())) stopVoice(id)
    }

    const decodeAudioFiles = async (files: File[]) => {
      const fingerprint = fileFingerprint(files)
      if (fingerprint === decodedFingerprint && buffers.size === files.length) return
      decodedFingerprint = fingerprint
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
          console.warn(`[MAGHRABI Live Audio] Could not decode ${file.name}:`, error)
        }
      }))
    }

    const reloadProject = async () => {
      const nextId = getActiveStudioProjectId()
      const changedProject = projectId !== nextId
      projectId = nextId
      settings = loadAudioMixerSettings(nextId)
      applySettings()
      const next = nextId ? await loadStoredVideoProject<ProjectShape>(nextId).catch(() => null) : null
      if (disposed) return
      snapshot = next
      if (changedProject) {
        stopAllVoices()
        anchored = false
        decodedFingerprint = ''
        buffers.clear()
      }
      await decodeAudioFiles(next?.audios || [])
    }

    const startVoice = (track: AudioTrack, timelineTime: number) => {
      const engine = ensureGraph()
      const buffer = buffers.get(Number(track.fileIndex))
      if (!buffer || !LANES.includes(track.lane)) return
      const duration = Math.max(.02, Number(track.sourceEnd) - Number(track.sourceStart))
      const localTime = timelineTime - Number(track.startAt)
      if (localTime < -.03 || localTime >= duration) return
      const sourceOffset = Math.max(0, Number(track.sourceStart) + Math.max(0, localTime))
      const remaining = Math.min(duration - Math.max(0, localTime), buffer.duration - sourceOffset)
      if (remaining <= .015 || sourceOffset >= buffer.duration) return

      const source = engine.context.createBufferSource()
      const gain = engine.context.createGain()
      source.buffer = buffer
      gain.gain.value = trackGain(track, timelineTime)
      source.connect(gain)
      gain.connect(engine.lanes[track.lane].gain)
      const voice: Voice = { source, gain, track }
      voices.set(track.id, voice)
      source.onended = () => {
        if (voices.get(track.id)?.source === source) voices.delete(track.id)
      }
      try { source.start(0, sourceOffset, remaining) } catch { voices.delete(track.id) }
    }

    const syncVoices = (timelineTime: number, hard = false) => {
      const tracks = Array.isArray(snapshot?.project?.audioTracks) ? snapshot?.project?.audioTracks || [] : []
      if (hard) stopAllVoices()
      const activeIds = new Set<string>()
      for (const track of tracks) {
        if (!LANES.includes(track.lane)) continue
        const duration = Math.max(.02, Number(track.sourceEnd) - Number(track.sourceStart))
        const localTime = timelineTime - Number(track.startAt)
        if (localTime < 0 || localTime >= duration) continue
        activeIds.add(track.id)
        const existing = voices.get(track.id)
        if (!existing) startVoice(track, timelineTime)
        else {
          existing.track = track
          existing.gain.gain.setTargetAtTime(trackGain(track, timelineTime), ensureGraph().context.currentTime, .008)
        }
      }
      for (const id of Array.from(voices.keys())) {
        if (!activeIds.has(id)) stopVoice(id)
      }
    }

    const readMeters = (): MeterMap => {
      const engine = graph
      if (!engine || engine.context.state !== 'running') return EMPTY_METERS
      return {
        A1: analyserMeter(engine.lanes.A1.analyser, scratch),
        A2: analyserMeter(engine.lanes.A2.analyser, scratch),
        A3: analyserMeter(engine.lanes.A3.analyser, scratch),
        MASTER: analyserMeter(engine.masterAnalyser, scratch),
      }
    }

    const publishMeters = (active: boolean, driftSeconds: number) => {
      const engine = graph
      const meters = active ? readMeters() : EMPTY_METERS
      const detail: LiveMeterDetail = {
        active,
        voices: voices.size,
        sampleRate: engine?.context.sampleRate || 0,
        latencyMs: engine ? Math.round(((engine.context.baseLatency || 0) + (engine.context.outputLatency || 0)) * 1000) : 0,
        driftMs: Math.round(driftSeconds * 1000),
        meters,
        projectId,
        source: 'webaudio-live-bus',
      }
      window.dispatchEvent(new CustomEvent<LiveMeterDetail>('maghrabi-live-audio-meter', { detail }))
      document.documentElement.dataset.maghrabiAudioMonitor = active ? 'live' : 'ready'
      const now = performance.now()
      if (now - lastMeterPaint > 36) {
        paintMixerMeters(meters, active)
        lastMeterPaint = now
      }
      if (now - lastUiUpdate > 180) {
        setMonitor({ active, voices: detail.voices, sampleRate: detail.sampleRate, latencyMs: detail.latencyMs, driftMs: detail.driftMs })
        lastUiUpdate = now
      }
    }

    const tick = () => {
      if (disposed) return
      const active = playbackActive()
      const timelineTime = currentPlayheadTime()
      const engine = graph
      if (!active) {
        if (voices.size) stopAllVoices()
        anchored = false
        publishMeters(false, 0)
        return
      }

      const liveGraph = ensureGraph()
      if (liveGraph.context.state === 'suspended') void liveGraph.context.resume().catch(() => undefined)
      if (!anchored) {
        anchorTimeline = timelineTime
        anchorContext = liveGraph.context.currentTime
        anchored = true
        syncVoices(timelineTime, true)
      }
      const expected = anchorTimeline + (liveGraph.context.currentTime - anchorContext)
      const drift = timelineTime - expected
      if (Math.abs(drift) > RESYNC_THRESHOLD_SECONDS) {
        anchorTimeline = timelineTime
        anchorContext = liveGraph.context.currentTime
        syncVoices(timelineTime, true)
      } else {
        syncVoices(timelineTime)
      }
      publishMeters(liveGraph.context.state === 'running', drift)
      if (engine !== liveGraph) applySettings()
    }

    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; settings?: AudioMixerSettings }>).detail
      if (detail?.projectId && projectId && detail.projectId !== projectId) return
      settings = detail?.settings ? sanitizeAudioMixerSettings(detail.settings) : loadAudioMixerSettings(projectId)
      applySettings()
    }

    const onProject = () => { void reloadProject() }
    const onSnapshot = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null }>).detail
      if (detail?.projectId && projectId && detail.projectId !== projectId) return
      void reloadProject()
    }
    const onClick = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(`${ROOT} button`) : null
      if (!button || button.disabled) return
      const text = (button.textContent || '').trim().toUpperCase()
      if (/^PLAY/.test(text)) {
        const engine = ensureGraph()
        void engine.context.resume().then(() => {
          anchorTimeline = currentPlayheadTime()
          anchorContext = engine.context.currentTime
          anchored = true
          syncVoices(anchorTimeline, true)
        }).catch(() => undefined)
      } else if (/^PAUSE/.test(text)) {
        window.setTimeout(() => {
          if (!playbackActive()) {
            stopAllVoices()
            anchored = false
          }
        }, 24)
      }
    }

    const observer = new MutationObserver(() => {
      const next = programPanel()
      setHost((current) => current === next ? current : next)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    setHost(programPanel())

    window.addEventListener('maghrabi-audio-mixer-settings-changed', onSettings as EventListener)
    window.addEventListener('maghrabi-active-project-changed', onProject)
    window.addEventListener('maghrabi-project-snapshot-changed', onSnapshot as EventListener)
    document.addEventListener('click', onClick, true)

    void reloadProject()
    const timer = window.setInterval(tick, 33)

    return () => {
      disposed = true
      observer.disconnect()
      window.clearInterval(timer)
      stopAllVoices()
      window.removeEventListener('maghrabi-audio-mixer-settings-changed', onSettings as EventListener)
      window.removeEventListener('maghrabi-active-project-changed', onProject)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSnapshot as EventListener)
      document.removeEventListener('click', onClick, true)
      delete document.documentElement.dataset.maghrabiAudioMonitor
      if (graph) void graph.context.close().catch(() => undefined)
    }
  }, [])

  if (!host) return null

  return createPortal(
    <div className={`maghrabi-live-audio-monitor${monitor.active ? ' is-live' : ''}`} dir="ltr" aria-label="Real-time audio monitoring status">
      <span className="maghrabi-live-audio-icon">{monitor.active ? <AudioLines size={13} /> : <Activity size={13} />}</span>
      <span className="maghrabi-live-audio-copy">
        <strong>{monitor.active ? 'AUDIO BUS LIVE' : 'AUDIO BUS READY'}</strong>
        <small>{monitor.active ? `${monitor.voices} VOICE${monitor.voices === 1 ? '' : 'S'} · ${monitor.sampleRate ? `${Math.round(monitor.sampleRate / 100) / 10} kHz` : '48 kHz'} · ${monitor.latencyMs} ms` : 'A1 / A2 / A3 · Web Audio Monitor'}</small>
      </span>
      {monitor.active && <span className={`maghrabi-live-audio-sync${Math.abs(monitor.driftMs) > 120 ? ' is-warning' : ''}`}>{Math.abs(monitor.driftMs) <= 120 ? 'SYNC' : `${monitor.driftMs > 0 ? '+' : ''}${monitor.driftMs} ms`}</span>}
    </div>,
    host,
  )
}
