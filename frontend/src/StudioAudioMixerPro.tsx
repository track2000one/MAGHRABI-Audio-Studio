import { useEffect, useRef, useState } from 'react'
import { Activity, RotateCcw, SlidersHorizontal, Volume2, X } from 'lucide-react'
import {
  applyAudioMixerMasterToManifest,
  dbToLinear,
  DEFAULT_AUDIO_MIXER_SETTINGS,
  loadAudioMixerSettings,
  saveAudioMixerSettings,
  sanitizeAudioMixerSettings,
  type AudioMixerChannelSettings,
  type AudioMixerLane,
  type AudioMixerSettings,
} from './lib/audioMixerSettings'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import type { VideoProjectManifestV12 } from './lib/videoApi'
import './studioAudioMixerPro.css'

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
  mixerGain?: number
  pan?: number
  muted?: boolean
  solo?: boolean
  [key: string]: unknown
}
type ProjectShape = {
  audioTracks?: AudioTrack[]
  [key: string]: unknown
}
type MeterState = { peakDb: number; rmsDb: number; lufs: number }
type MeterMap = Record<AudioMixerLane | 'MASTER', MeterState>

const ROOT = '.maghrabi-studio-pro main'
const LANES: AudioMixerLane[] = ['A1', 'A2', 'A3']
const SILENCE: MeterState = { peakDb: -60, rmsDb: -60, lufs: -60 }
const EMPTY_METERS: MeterMap = { A1: SILENCE, A2: SILENCE, A3: SILENCE, MASTER: SILENCE }
const HEADER_WIDTH = 122

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function linearToDb(value: number) {
  return value <= .000001 ? -60 : clamp(20 * Math.log10(value), -60, 6)
}

function meterPercent(db: number) {
  return clamp((db + 60) / 66 * 100, 0, 100)
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

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button`))
}

function clickRestore() {
  editorButtons().find((button) => (button.textContent || '').includes('استعادة'))?.click()
}

async function flushEditorSave(projectId: string) {
  const save = editorButtons().find((button) => (button.textContent || '').includes('حفظ'))
  if (!save || save.disabled) return loadStoredVideoProject<ProjectShape>(projectId)
  const confirmed = new Promise<void>((resolve) => {
    let timer = 0
    const finish = () => {
      window.clearTimeout(timer)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
      resolve()
    }
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null }>).detail
      if (detail?.projectId && detail.projectId !== projectId) return
      finish()
    }
    window.addEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
    timer = window.setTimeout(finish, 1800)
  })
  save.click()
  await confirmed
  return loadStoredVideoProject<ProjectShape>(projectId)
}

function automationGain(track: AudioTrack, localTime: number) {
  const points = [...(track.automation || [])]
    .filter((point) => Number.isFinite(Number(point.time)) && Number.isFinite(Number(point.gain)))
    .sort((a, b) => Number(a.time) - Number(b.time))
  if (!points.length) return 1
  if (localTime <= points[0].time) return clamp(points[0].gain, 0, 2)
  const last = points[points.length - 1]
  if (localTime >= last.time) return clamp(last.gain, 0, 2)
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]
    if (localTime > right.time) continue
    const left = points[index - 1]
    const span = Math.max(.001, right.time - left.time)
    const mix = clamp((localTime - left.time) / span, 0, 1)
    return clamp(left.gain + (right.gain - left.gain) * mix, 0, 2)
  }
  return 1
}

function fadeGain(track: AudioTrack, localTime: number) {
  const duration = Math.max(.02, track.sourceEnd - track.sourceStart)
  let gain = 1
  const fadeIn = Math.max(0, Number(track.fadeIn) || 0)
  const fadeOut = Math.max(0, Number(track.fadeOut) || 0)
  if (fadeIn > .001) gain *= clamp(localTime / fadeIn, 0, 1)
  if (fadeOut > .001) gain *= clamp((duration - localTime) / fadeOut, 0, 1)
  return gain
}

function sampleBuffer(buffer: AudioBuffer | undefined, sourceTime: number) {
  if (!buffer || sourceTime < 0 || sourceTime > buffer.duration) return { peak: 0, rms: 0 }
  const center = Math.floor(sourceTime * buffer.sampleRate)
  const radius = Math.max(64, Math.floor(buffer.sampleRate * .035))
  const from = Math.max(0, center - radius)
  const to = Math.min(buffer.length, center + radius)
  const span = Math.max(1, to - from)
  const stride = Math.max(1, Math.floor(span / 480))
  let peak = 0
  let sumSquares = 0
  let count = 0
  for (let sample = from; sample < to; sample += stride) {
    let mixed = 0
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      mixed += buffer.getChannelData(channel)[sample] || 0
    }
    mixed /= Math.max(1, buffer.numberOfChannels)
    const absolute = Math.abs(mixed)
    peak = Math.max(peak, absolute)
    sumSquares += mixed * mixed
    count += 1
  }
  return { peak, rms: Math.sqrt(sumSquares / Math.max(1, count)) }
}

function formatPan(value: number) {
  if (Math.abs(value) < .015) return 'C'
  return value < 0 ? `L${Math.round(Math.abs(value) * 100)}` : `R${Math.round(value * 100)}`
}

function dbLabel(value: number) {
  return value <= -59.9 ? '-∞ dB' : `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`
}

export default function StudioAudioMixerPro() {
  const initialProjectId = getActiveStudioProjectId()
  const [projectId, setProjectId] = useState<string | null>(initialProjectId)
  const projectIdRef = useRef(projectId)
  const [settings, setSettings] = useState<AudioMixerSettings>(() => loadAudioMixerSettings(initialProjectId))
  const settingsRef = useRef(settings)
  const [snapshot, setSnapshot] = useState<StoredVideoProject<ProjectShape> | null>(null)
  const snapshotRef = useRef(snapshot)
  const decodedRef = useRef(new Map<number, AudioBuffer>())
  const [meters, setMeters] = useState<MeterMap>(EMPTY_METERS)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const commitBusy = useRef(false)

  const announce = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((current) => current === text ? '' : current), 2400)
  }

  const persistSettings = (next: AudioMixerSettings) => {
    const safe = sanitizeAudioMixerSettings(next)
    settingsRef.current = safe
    setSettings(safe)
    saveAudioMixerSettings(projectIdRef.current, safe)
    return safe
  }

  const reloadSnapshot = async () => {
    const id = getActiveStudioProjectId()
    const next = id ? await loadStoredVideoProject<ProjectShape>(id).catch(() => null) : null
    snapshotRef.current = next
    setSnapshot(next)
  }

  const commitAllChannels = async (targetSettings = settingsRef.current, statusText?: string) => {
    const id = projectIdRef.current
    if (!id || commitBusy.current) return false
    commitBusy.current = true
    try {
      const source = await flushEditorSave(id)
      if (!source) return false
      const project = JSON.parse(JSON.stringify(source.project || {})) as ProjectShape
      project.audioTracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
      for (const track of project.audioTracks) {
        if (!LANES.includes(track.lane)) continue
        const channel = targetSettings.channels[track.lane]
        track.mixerGain = dbToLinear(channel.gainDb)
        track.pan = channel.pan
        track.muted = channel.muted
        track.solo = channel.solo
      }
      const next: StoredVideoProject<ProjectShape> = { ...source, project, savedAt: new Date().toISOString() }
      await saveStoredVideoProject(next, id)
      snapshotRef.current = next
      setSnapshot(next)
      window.setTimeout(clickRestore, 80)
      if (statusText) announce(statusText)
      return true
    } finally {
      commitBusy.current = false
    }
  }

  const commitLane = async (lane: AudioMixerLane, channel = settingsRef.current.channels[lane]) => {
    const current = settingsRef.current
    const next = sanitizeAudioMixerSettings({ ...current, channels: { ...current.channels, [lane]: channel } })
    return commitAllChannels(next, `${lane} mixer committed`)
  }

  const updateChannel = (lane: AudioMixerLane, changes: Partial<AudioMixerChannelSettings>) => {
    const current = settingsRef.current
    return persistSettings({
      ...current,
      channels: { ...current.channels, [lane]: { ...current.channels[lane], ...changes } },
    })
  }

  const updateMaster = (changes: Partial<AudioMixerSettings['master']>) => {
    const current = settingsRef.current
    persistSettings({ ...current, master: { ...current.master, ...changes } })
  }

  const resetMixer = () => {
    const next = persistSettings(DEFAULT_AUDIO_MIXER_SETTINGS)
    void commitAllChannels(next, 'Mixer reset to calibrated defaults')
  }

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  useEffect(() => {
    const onProject = () => {
      const id = getActiveStudioProjectId()
      projectIdRef.current = id
      setProjectId(id)
      const next = loadAudioMixerSettings(id)
      settingsRef.current = next
      setSettings(next)
      void reloadSnapshot()
    }
    const onOpen = () => {
      setOpen(true)
      void reloadSnapshot()
    }
    const onSnapshot = () => { void reloadSnapshot() }
    window.addEventListener('maghrabi-active-project-changed', onProject)
    window.addEventListener('maghrabi-open-audio-mixer', onOpen)
    window.addEventListener('maghrabi-project-snapshot-changed', onSnapshot as EventListener)
    onProject()
    return () => {
      window.removeEventListener('maghrabi-active-project-changed', onProject)
      window.removeEventListener('maghrabi-open-audio-mixer', onOpen)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSnapshot as EventListener)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const files = snapshot?.audios || []
    decodedRef.current.clear()
    if (!files.length) return
    const context = new AudioContext()
    void Promise.all(files.map(async (file, index) => {
      try {
        const buffer = await context.decodeAudioData((await file.arrayBuffer()).slice(0))
        if (!cancelled) decodedRef.current.set(index, buffer)
      } catch {
        // Unsupported browser codec: mixer remains functional, meter stays silent.
      }
    })).finally(() => { void context.close().catch(() => undefined) })
    return () => { cancelled = true }
  }, [snapshot])

  useEffect(() => {
    if (!open) return
    const updateMeters = () => {
      const source = snapshotRef.current
      if (!source) { setMeters(EMPTY_METERS); return }
      const tracks = Array.isArray(source.project?.audioTracks) ? source.project.audioTracks : []
      const activeSettings = settingsRef.current
      const playhead = currentPlayheadTime()
      const anySolo = LANES.some((lane) => activeSettings.channels[lane].solo)
      const next = { ...EMPTY_METERS } as MeterMap
      let masterPeak = 0
      let masterSquare = 0

      for (const lane of LANES) {
        const channel = activeSettings.channels[lane]
        const suppressed = channel.muted || (anySolo && !channel.solo)
        let peak = 0
        let square = 0
        if (!suppressed) {
          for (const track of tracks.filter((item) => item.lane === lane)) {
            const duration = Math.max(.02, track.sourceEnd - track.sourceStart)
            const localTime = playhead - track.startAt
            if (localTime < 0 || localTime > duration) continue
            const level = sampleBuffer(decodedRef.current.get(track.fileIndex), track.sourceStart + localTime)
            const gain = clamp(Number(track.volume ?? 1), 0, 2)
              * dbToLinear(channel.gainDb)
              * automationGain(track, localTime)
              * fadeGain(track, localTime)
            peak = Math.max(peak, level.peak * gain)
            const rms = level.rms * gain
            square += rms * rms
          }
        }
        const rms = Math.sqrt(square)
        const peakDb = linearToDb(peak)
        const rmsDb = linearToDb(rms)
        next[lane] = { peakDb, rmsDb, lufs: clamp(-.691 + rmsDb, -60, 6) }
        masterPeak = Math.max(masterPeak, peak)
        masterSquare += rms * rms
      }

      const masterGain = dbToLinear(activeSettings.master.gainDb)
      masterPeak *= masterGain
      let masterRms = Math.sqrt(masterSquare) * masterGain
      if (activeSettings.master.limiterEnabled) {
        const ceiling = dbToLinear(activeSettings.master.limiterCeilingDb)
        masterPeak = Math.min(masterPeak, ceiling)
        masterRms = Math.min(masterRms, ceiling)
      }
      const masterPeakDb = linearToDb(masterPeak)
      const masterRmsDb = linearToDb(masterRms)
      next.MASTER = {
        peakDb: masterPeakDb,
        rmsDb: masterRmsDb,
        lufs: clamp(-.691 + masterRmsDb, -60, 6),
      }
      setMeters(next)
    }
    updateMeters()
    const timer = window.setInterval(updateMeters, 90)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    const originalFetch = window.fetch
    const wrappedFetch: typeof window.fetch = async (input, init) => {
      try {
        const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString()
        const url = new URL(rawUrl, window.location.href)
        const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
        if (url.pathname === '/api/video/v12/queue' && method === 'POST' && init?.body instanceof FormData) {
          const form = init.body
          const rawManifest = form.get('manifest')
          if (typeof rawManifest === 'string') {
            const parsed = JSON.parse(rawManifest) as VideoProjectManifestV12
            const enhanced = applyAudioMixerMasterToManifest(parsed, settingsRef.current)
            const nextForm = new FormData()
            form.forEach((value, key) => nextForm.append(key, value))
            nextForm.set('manifest', JSON.stringify(enhanced))
            return originalFetch(input, { ...init, body: nextForm })
          }
        }
      } catch (error) {
        console.warn('[MAGHRABI Audio Mixer] Manifest enhancement skipped:', error)
      }
      return originalFetch(input, init)
    }
    window.fetch = wrappedFetch
    return () => { if (window.fetch === wrappedFetch) window.fetch = originalFetch }
  }, [])

  const trackCount = (lane: AudioMixerLane) => snapshot?.project?.audioTracks?.filter((track) => track.lane === lane).length || 0

  return (
    <>
      <button type="button" className="maghrabi-audio-mixer-launcher" onClick={() => setOpen(true)} title="Professional Audio Mixer">
        <SlidersHorizontal size={15} /><span>MIXER</span>
      </button>

      {open && (
        <div className="maghrabi-audio-mixer-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
          <section className="maghrabi-audio-mixer-panel" dir="ltr" aria-label="MAGHRABI Professional Audio Mixer">
            <header className="maghrabi-audio-mixer-head">
              <div className="maghrabi-audio-mixer-title">
                <i><Activity size={17} /></i>
                <span><strong>MAGHRABI PROFESSIONAL AUDIO MIXER</strong><small>A1 / A2 / A3 · Gain · Pan · Mute · Solo · Peak/RMS · LUFS · Master Processing</small></span>
              </div>
              <div className="maghrabi-audio-mixer-head-actions">
                <button type="button" onClick={resetMixer}><RotateCcw size={13} /><span>RESET</span></button>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close mixer"><X size={15} /></button>
              </div>
            </header>

            <div className="maghrabi-audio-console">
              {LANES.map((lane) => {
                const channel = settings.channels[lane]
                const meter = meters[lane]
                return (
                  <article key={lane} className={`maghrabi-audio-strip${channel.solo ? ' is-solo' : ''}${channel.muted ? ' is-muted' : ''}`}>
                    <div className="maghrabi-audio-strip-head">
                      <span><strong>{lane}</strong><small>{trackCount(lane)} TIMELINE CLIP{trackCount(lane) === 1 ? '' : 'S'}</small></span>
                      <span className="maghrabi-audio-strip-meter-value">{meter.peakDb.toFixed(1)} dB</span>
                    </div>
                    <div className="maghrabi-audio-strip-body">
                      <div className="maghrabi-audio-meter" title="PEAK / RMS live estimate">
                        <span className="maghrabi-audio-meter-bar peak"><i style={{ height: `${meterPercent(meter.peakDb)}%` }} /></span>
                        <span className="maghrabi-audio-meter-bar rms"><i style={{ height: `${meterPercent(meter.rmsDb)}%` }} /></span>
                      </div>
                      <div className="maghrabi-audio-channel-controls">
                        <div className="maghrabi-audio-ms">
                          <button type="button" className={channel.muted ? 'is-mute' : ''} onClick={() => { const next = updateChannel(lane, { muted: !channel.muted }); void commitLane(lane, next.channels[lane]) }}>MUTE</button>
                          <button type="button" className={channel.solo ? 'is-solo' : ''} onClick={() => { const next = updateChannel(lane, { solo: !channel.solo }); void commitLane(lane, next.channels[lane]) }}>SOLO</button>
                        </div>
                        <label className="maghrabi-audio-field">PAN <span>{formatPan(channel.pan)}</span>
                          <input type="range" min="-1" max="1" step=".01" value={channel.pan} onChange={(event) => updateChannel(lane, { pan: Number(event.target.value) })} onPointerUp={() => void commitLane(lane)} onKeyUp={() => void commitLane(lane)} />
                        </label>
                        <div className="maghrabi-audio-pan-labels"><span>L</span><span>C</span><span>R</span></div>
                        <label className="maghrabi-audio-field">CHANNEL GAIN <span>{dbLabel(channel.gainDb)}</span>
                          <input type="range" min="-60" max="12" step=".5" value={channel.gainDb} onChange={(event) => updateChannel(lane, { gainDb: Number(event.target.value) })} onPointerUp={() => void commitLane(lane)} onKeyUp={() => void commitLane(lane)} />
                        </label>
                        <div className="maghrabi-audio-db-readout">{dbLabel(channel.gainDb)}</div>
                        <label className="maghrabi-audio-field">RMS <span>{meter.rmsDb.toFixed(1)} dBFS</span></label>
                        <label className="maghrabi-audio-field">LUFS-M EST <span>{meter.lufs.toFixed(1)}</span></label>
                      </div>
                    </div>
                  </article>
                )
              })}

              <article className="maghrabi-audio-strip is-master">
                <div className="maghrabi-audio-strip-head">
                  <span><strong>MASTER</strong><small>A1-A3 BUS · FINAL EXPORT PROCESSING</small></span>
                  <span className="maghrabi-audio-strip-meter-value">{meters.MASTER.peakDb.toFixed(1)} dB</span>
                </div>
                <div className="maghrabi-audio-strip-body">
                  <div className="maghrabi-audio-meter" title="Master PEAK / RMS estimate">
                    <span className="maghrabi-audio-meter-bar peak"><i style={{ height: `${meterPercent(meters.MASTER.peakDb)}%` }} /></span>
                    <span className="maghrabi-audio-meter-bar rms"><i style={{ height: `${meterPercent(meters.MASTER.rmsDb)}%` }} /></span>
                  </div>
                  <div className="maghrabi-audio-channel-controls">
                    <label className="maghrabi-audio-field">MASTER GAIN <span>{dbLabel(settings.master.gainDb)}</span>
                      <input type="range" min="-24" max="12" step=".5" value={settings.master.gainDb} onChange={(event) => updateMaster({ gainDb: Number(event.target.value) })} />
                    </label>
                    <div className="maghrabi-audio-db-readout">{dbLabel(settings.master.gainDb)}</div>
                    <div className="maghrabi-master-options">
                      <label className="maghrabi-master-toggle"><span>TRUE-PEAK LIMITER</span><input type="checkbox" checked={settings.master.limiterEnabled} onChange={(event) => updateMaster({ limiterEnabled: event.target.checked })} /></label>
                      <label className="maghrabi-master-toggle"><span>EBU R128 LOUDNESS NORMALIZE</span><input type="checkbox" checked={settings.master.normalizeEnabled} onChange={(event) => updateMaster({ normalizeEnabled: event.target.checked })} /></label>
                    </div>
                    <div className="maghrabi-master-lufs">
                      <label>TARGET LUFS<input type="number" min="-24" max="-9" step=".5" value={settings.master.targetLufs} onChange={(event) => updateMaster({ targetLufs: Number(event.target.value) })} /></label>
                      <label>CEILING dBTP<input type="number" min="-12" max="-.1" step=".1" value={settings.master.limiterCeilingDb} onChange={(event) => updateMaster({ limiterCeilingDb: Number(event.target.value) })} /></label>
                    </div>
                    <label className="maghrabi-audio-field">MASTER RMS <span>{meters.MASTER.rmsDb.toFixed(1)} dBFS</span></label>
                    <label className="maghrabi-audio-field">LUFS-M EST <span>{meters.MASTER.lufs.toFixed(1)}</span></label>
                  </div>
                </div>
              </article>
            </div>

            <footer className="maghrabi-audio-mixer-foot">
              <Volume2 size={13} /><span><b>Peak/RMS/LUFS-M:</b> معاينة لحظية من ملفات A1-A3 عند Playhead. التصدير النهائي يطبق Gain/Pan/Mute/Solo ثم Master Gain وLoudness Normalization وLimiter على المزيج الكامل.</span>
              <span className="maghrabi-audio-mixer-status">{message || (projectId ? 'MIXER ONLINE' : 'NO ACTIVE PROJECT')}</span>
            </footer>
          </section>
        </div>
      )}
    </>
  )
}
