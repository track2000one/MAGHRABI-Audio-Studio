import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Headphones, Mic, Pause, Play, RotateCcw, Square } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import './studioVoiceoverRecordingPro.css'

type AudioLane = 'A1' | 'A2' | 'A3'
type AudioTrack = {
  id: string
  lane: AudioLane
  name: string
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  volume: number
  fadeIn: number
  fadeOut: number
  automation: Array<{ time: number; gain: number }>
  linkedClipId: null
}
type ProjectShape = {
  audioTracks?: AudioTrack[]
  audioBins?: string[]
  trackStates?: Partial<Record<AudioLane, { locked?: boolean }>>
  [key: string]: unknown
}
type RecorderStatus = 'idle' | 'requesting' | 'count-in' | 'recording' | 'paused' | 'committing'
type LastTake = { trackId: string; fileIndex: number; name: string }

const ROOT = '.maghrabi-studio-pro main'
const HEADER_WIDTH = 122
const LANES: AudioLane[] = ['A1', 'A2', 'A3']

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

function programPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
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

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button`))
}

async function flushEditorSave(projectId: string) {
  const button = editorButtons().find((item) => (item.textContent || '').includes('حفظ'))
  if (!button || button.disabled) return loadStoredVideoProject<ProjectShape>(projectId)
  const done = new Promise<void>((resolve) => {
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
  button.click()
  await done
  return loadStoredVideoProject<ProjectShape>(projectId)
}

function clickRestore() {
  editorButtons().find((item) => (item.textContent || '').includes('استعادة'))?.click()
}

function uid(prefix = 'vo') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function recorderMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || ''
}

function extensionForMime(mime: string) {
  return mime.includes('ogg') ? 'ogg' : 'webm'
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms))
}

function measureDuration(file: File, fallback: number) {
  return new Promise<number>((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = document.createElement('audio')
    let settled = false
    const finish = (value: number) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      audio.removeAttribute('src')
      resolve(clamp(Number.isFinite(value) && value > .02 ? value : fallback, .02, 60 * 60 * 8))
    }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => finish(audio.duration)
    audio.onerror = () => finish(fallback)
    audio.src = url
    window.setTimeout(() => finish(audio.duration), 1600)
  })
}

async function commitTake(
  projectId: string,
  lane: AudioLane,
  startAt: number,
  blob: Blob,
  fallbackDuration: number,
) {
  const snapshot = await flushEditorSave(projectId)
  if (!snapshot) throw new Error('تعذر قراءة المشروع الحالي بعد التسجيل.')
  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  project.audioTracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
  project.audioBins = Array.isArray(project.audioBins) ? project.audioBins : []
  if (project.trackStates?.[lane]?.locked) throw new Error(`المسار ${lane} مقفل. افتحه ثم أعد التسجيل.`)

  const mime = blob.type || recorderMimeType() || 'audio/webm'
  const now = new Date()
  const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, '0')).join('-')
  const name = `Voiceover-${stamp}.${extensionForMime(mime)}`
  const file = new File([blob], name, { type: mime, lastModified: Date.now() })
  const duration = await measureDuration(file, fallbackDuration)
  const fileIndex = snapshot.audios.length
  const trackId = uid()
  const track: AudioTrack = {
    id: trackId,
    lane,
    name: `VO · ${name}`,
    fileIndex,
    startAt: Math.max(0, startAt),
    sourceStart: 0,
    sourceEnd: duration,
    volume: 1,
    fadeIn: Math.min(.035, duration / 4),
    fadeOut: Math.min(.08, duration / 3),
    automation: [],
    linkedClipId: null,
  }
  project.audioTracks.push(track)
  project.audioBins.push('Audio')

  const next: StoredVideoProject<ProjectShape> = {
    ...snapshot,
    project,
    audios: [...snapshot.audios, file],
    audioDurations: [...snapshot.audioDurations, duration],
    savedAt: new Date().toISOString(),
  }
  await saveStoredVideoProject(next, projectId)
  window.setTimeout(clickRestore, 80)
  window.dispatchEvent(new CustomEvent('maghrabi-voiceover-take-added', {
    detail: { projectId, lane, trackId, fileIndex, duration, startAt, name },
  }))
  return { trackId, fileIndex, name, duration }
}

async function removeLastTake(projectId: string, take: LastTake) {
  const snapshot = await flushEditorSave(projectId)
  if (!snapshot) throw new Error('تعذر قراءة المشروع الحالي.')
  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  const tracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
  if (!tracks.some((track) => track.id === take.trackId)) throw new Error('آخر Take لم يعد موجودًا على الـTimeline.')
  project.audioTracks = tracks.filter((track) => track.id !== take.trackId)

  let audios = [...snapshot.audios]
  let durations = [...snapshot.audioDurations]
  project.audioBins = Array.isArray(project.audioBins) ? [...project.audioBins] : []
  const stillReferenced = project.audioTracks.some((track) => track.fileIndex === take.fileIndex)
  if (!stillReferenced && take.fileIndex === audios.length - 1) {
    audios = audios.slice(0, -1)
    durations = durations.slice(0, -1)
    project.audioBins = project.audioBins.slice(0, -1)
  }

  await saveStoredVideoProject({ ...snapshot, project, audios, audioDurations: durations, savedAt: new Date().toISOString() }, projectId)
  window.setTimeout(clickRestore, 80)
}

function isTyping(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
}

export default function StudioVoiceoverRecordingPro() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [lane, setLane] = useState<AudioLane>('A2')
  const [countIn, setCountIn] = useState(3)
  const [countdown, setCountdown] = useState(0)
  const [followPicture, setFollowPicture] = useState(true)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [meter, setMeter] = useState({ peak: 0, rms: 0, clip: false })
  const [message, setMessage] = useState('')
  const [lastTake, setLastTake] = useState<LastTake | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const meterRafRef = useRef(0)
  const countdownGenerationRef = useRef(0)
  const chunksRef = useRef<Blob[]>([])
  const projectIdRef = useRef<string | null>(null)
  const originRef = useRef(0)
  const startedAtRef = useRef(0)
  const pauseStartedAtRef = useRef(0)
  const pausedMsRef = useRef(0)

  const announce = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((current) => current === text ? '' : current), 2600)
  }

  const refreshDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput')
      setDevices(inputs)
      if (!deviceId && inputs[0]?.deviceId) setDeviceId(inputs[0].deviceId)
    } catch {
      setDevices([])
    }
  }

  const stopMeter = () => {
    window.cancelAnimationFrame(meterRafRef.current)
    meterRafRef.current = 0
    void audioContextRef.current?.close().catch(() => undefined)
    audioContextRef.current = null
    setMeter({ peak: 0, rms: 0, clip: false })
  }

  const stopStream = () => {
    stopMeter()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  const startMeter = (stream: MediaStream) => {
    try {
      const context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = .55
      source.connect(analyser)
      audioContextRef.current = context
      const data = new Float32Array(analyser.fftSize)
      let lastUi = 0
      const tick = (clock: number) => {
        analyser.getFloatTimeDomainData(data)
        let peak = 0
        let sum = 0
        for (const sample of data) {
          const abs = Math.abs(sample)
          peak = Math.max(peak, abs)
          sum += sample * sample
        }
        const rms = Math.sqrt(sum / Math.max(1, data.length))
        if (clock - lastUi > 50) {
          setMeter({ peak: clamp(peak, 0, 1), rms: clamp(rms, 0, 1), clip: peak >= .985 })
          lastUi = clock
        }
        meterRafRef.current = window.requestAnimationFrame(tick)
      }
      meterRafRef.current = window.requestAnimationFrame(tick)
      void context.resume().catch(() => undefined)
    } catch {
      setMeter({ peak: 0, rms: 0, clip: false })
    }
  }

  const stopRecording = () => {
    countdownGenerationRef.current += 1
    setCountdown(0)
    if (status === 'count-in' || status === 'requesting') {
      setNativePlaying(false)
      stopStream()
      setStatus('idle')
      return
    }
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop() } catch {}
    }
    setNativePlaying(false)
  }

  const togglePause = () => {
    const recorder = recorderRef.current
    if (!recorder) return
    if (recorder.state === 'recording') {
      try {
        recorder.pause()
        pauseStartedAtRef.current = performance.now()
        setNativePlaying(false)
        setStatus('paused')
      } catch {}
    } else if (recorder.state === 'paused') {
      try {
        recorder.resume()
        if (pauseStartedAtRef.current) pausedMsRef.current += performance.now() - pauseStartedAtRef.current
        pauseStartedAtRef.current = 0
        if (followPicture) setNativePlaying(true)
        setStatus('recording')
      } catch {}
    }
  }

  const startRecording = async () => {
    if (status !== 'idle') return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      announce('المتصفح لا يدعم تسجيل الميكروفون عبر MediaRecorder.')
      return
    }
    const projectId = getActiveStudioProjectId()
    if (!projectId) {
      announce('افتح مشروعًا أولًا قبل تسجيل Voiceover.')
      return
    }

    setStatus('requesting')
    const snapshot = await flushEditorSave(projectId).catch(() => null)
    if (!snapshot) {
      setStatus('idle')
      announce('تعذر حفظ المشروع قبل التسجيل.')
      return
    }
    if (snapshot.project.trackStates?.[lane]?.locked) {
      setStatus('idle')
      announce(`المسار ${lane} مقفل. افتحه أولًا.`)
      return
    }

    const token = ++countdownGenerationRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 48000,
        },
        video: false,
      })
      if (token !== countdownGenerationRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      startMeter(stream)
      await refreshDevices()

      projectIdRef.current = projectId
      originRef.current = playheadTime()
      for (let remaining = countIn; remaining > 0; remaining -= 1) {
        if (token !== countdownGenerationRef.current) return
        setStatus('count-in')
        setCountdown(remaining)
        await wait(1000)
      }
      if (token !== countdownGenerationRef.current) return
      setCountdown(0)

      const mime = recorderMimeType()
      const recorder = new MediaRecorder(stream, mime
        ? { mimeType: mime, audioBitsPerSecond: 160000 }
        : { audioBitsPerSecond: 160000 })
      recorderRef.current = recorder
      chunksRef.current = []
      pausedMsRef.current = 0
      pauseStartedAtRef.current = 0
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onerror = () => announce('حدث خطأ أثناء تسجيل Voiceover.')
      recorder.onstop = async () => {
        setStatus('committing')
        const activeProjectId = projectIdRef.current
        const elapsedMs = Math.max(20, performance.now() - startedAtRef.current - pausedMsRef.current)
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mime || 'audio/webm' })
        recorderRef.current = null
        stopStream()
        try {
          if (!activeProjectId || blob.size < 64) throw new Error('لم يتم التقاط صوت صالح من الميكروفون.')
          const take = await commitTake(activeProjectId, lane, originRef.current, blob, elapsedMs / 1000)
          setLastTake({ trackId: take.trackId, fileIndex: take.fileIndex, name: take.name })
          announce(`تم إدراج Voiceover على ${lane} · ${take.duration.toFixed(2)}s`)
        } catch (error) {
          announce(error instanceof Error ? error.message : 'تعذر حفظ Voiceover.')
        } finally {
          setStatus('idle')
          chunksRef.current = []
        }
      }
      recorder.start(250)
      startedAtRef.current = performance.now()
      if (followPicture) setNativePlaying(true)
      setStatus('recording')
    } catch (error) {
      stopStream()
      setStatus('idle')
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      announce(denied ? 'لم يتم منح إذن استخدام الميكروفون.' : error instanceof Error ? error.message : 'تعذر تشغيل الميكروفون.')
    }
  }

  const undoLastTake = async () => {
    const projectId = getActiveStudioProjectId()
    if (!projectId || !lastTake || status !== 'idle') return
    try {
      await removeLastTake(projectId, lastTake)
      announce('تم التراجع عن آخر Voiceover Take.')
      setLastTake(null)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر التراجع عن آخر Take.')
    }
  }

  useEffect(() => {
    const refreshHost = () => setHost(programPanel())
    const observer = new MutationObserver(refreshHost)
    observer.observe(document.body, { childList: true, subtree: true })
    refreshHost()
    void refreshDevices()
    const onDeviceChange = () => void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
    return () => {
      observer.disconnect()
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.ctrlKey || event.metaKey) return
      if (event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault()
        if (status === 'idle') void startRecording()
        else stopRecording()
      } else if (event.shiftKey && event.key.toLowerCase() === 'p' && (status === 'recording' || status === 'paused')) {
        event.preventDefault()
        togglePause()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [status, lane, deviceId, countIn, followPicture])

  useEffect(() => () => {
    countdownGenerationRef.current += 1
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    } catch {}
    setNativePlaying(false)
    stopStream()
  }, [])

  if (!host) return null
  const busy = status !== 'idle'
  const live = status === 'recording' || status === 'paused'

  return createPortal(
    <div className="maghrabi-voiceover-panel" dir="ltr">
      <div className="maghrabi-voiceover-head">
        <span className="maghrabi-voiceover-title"><Mic className="h-3.5 w-3.5" /> VOICEOVER / ADR</span>
        <span className={`maghrabi-voiceover-state is-${status}`}>{status === 'count-in' ? `COUNT ${countdown}` : status.toUpperCase()}</span>
      </div>

      <div className="maghrabi-voiceover-grid">
        <label className="maghrabi-voiceover-device">
          <span>INPUT</span>
          <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)} disabled={busy}>
            {!devices.length && <option value="">Default microphone</option>}
            {devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
          </select>
        </label>

        <div className="maghrabi-voiceover-lanes" aria-label="Voiceover target audio lane">
          {LANES.map((item) => <button key={item} type="button" disabled={busy} onClick={() => setLane(item)} className={lane === item ? 'is-active' : ''}>{item}</button>)}
        </div>

        <button type="button" disabled={busy} onClick={() => setCountIn((value) => value === 0 ? 3 : value === 3 ? 5 : 0)} className="maghrabi-voiceover-option">COUNT-IN {countIn}s</button>
        <button type="button" disabled={busy} onClick={() => setFollowPicture((value) => !value)} className={`maghrabi-voiceover-option${followPicture ? ' is-on' : ''}`}><Headphones className="h-3 w-3" /> PICTURE {followPicture ? 'ON' : 'OFF'}</button>
      </div>

      <div className="maghrabi-voiceover-meter-row">
        <span>RMS</span><div className="maghrabi-voiceover-meter"><i style={{ width: `${meter.rms * 100}%` }} /></div>
        <span>PEAK</span><div className={`maghrabi-voiceover-meter is-peak${meter.clip ? ' is-clipping' : ''}`}><i style={{ width: `${meter.peak * 100}%` }} /></div>
        <b>{meter.clip ? 'CLIP' : `${Math.round(meter.peak * 100)}%`}</b>
      </div>

      <div className="maghrabi-voiceover-actions">
        {!live && status !== 'count-in' && status !== 'requesting' && status !== 'committing' && <button type="button" onClick={() => void startRecording()} className="maghrabi-voiceover-record"><Mic className="h-3.5 w-3.5" /> REC · Shift+R</button>}
        {(status === 'count-in' || status === 'requesting') && <button type="button" onClick={stopRecording} className="maghrabi-voiceover-stop"><Square className="h-3.5 w-3.5" /> CANCEL</button>}
        {live && <>
          <button type="button" onClick={togglePause} className="maghrabi-voiceover-pause">{status === 'paused' ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}{status === 'paused' ? 'RESUME' : 'PAUSE'} · Shift+P</button>
          <button type="button" onClick={stopRecording} className="maghrabi-voiceover-stop"><Square className="h-3.5 w-3.5" /> STOP</button>
        </>}
        {status === 'committing' && <span className="maghrabi-voiceover-committing">COMMITTING TAKE…</span>}
        <button type="button" disabled={!lastTake || busy} onClick={() => void undoLastTake()} className="maghrabi-voiceover-undo"><RotateCcw className="h-3 w-3" /> UNDO LAST TAKE</button>
      </div>

      {message && <div className="maghrabi-voiceover-message">{message}</div>}
    </div>,
    host,
  )
}
