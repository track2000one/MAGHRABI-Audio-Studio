import { useEffect, useState } from 'react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadCreativeSettings } from './lib/creativeProjectSettings'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import './studioAudioTimelinePro.css'

type AudioLane = 'A1' | 'A2' | 'A3'
type LaneKey = 'V1' | 'V2' | 'V3' | AudioLane

type AutomationPoint = { time: number; gain: number }
type AudioTrack = {
  id: string
  lane: AudioLane
  fileIndex: number
  startAt: number
  sourceStart: number
  sourceEnd: number
  volume: number
  fadeIn: number
  fadeOut: number
  automation?: AutomationPoint[]
  name?: string
  linkedClipId?: string | null
}
type TrackState = { locked?: boolean }
type ProjectShape = {
  audioTracks?: AudioTrack[]
  trackStates?: Partial<Record<LaneKey, TrackState>>
  [key: string]: unknown
}
type AudioRef = {
  lane: AudioLane
  startAt: number
  duration: number
  name: string
  button: HTMLButtonElement
  trackId?: string
}

type PeakCacheEntry = Promise<number[]>

const ROOT = '.maghrabi-studio-pro main'
const MIN_DURATION = .02
const MAX_GAIN = 2
const WAVE_BARS = 720

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function parseZoom() {
  const spans = Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))
  for (const span of spans) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function firstClipLabel(button: HTMLButtonElement) {
  return (button.querySelector('span')?.textContent || '').trim()
}

function parseClock(value: string) {
  const match = value.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/)
  if (!match) return Number.NaN
  return Number(match[1]) * 60 + Number(match[2])
}

function audioRef(button: HTMLButtonElement): AudioRef | null {
  const label = firstClipLabel(button)
  const match = label.match(/^(A[123])\s*·\s*(.*)$/)
  if (!match) return null
  const lane = match[1] as AudioLane
  const zoom = parseZoom()
  const startAt = Math.max(0, (Number.parseFloat(button.style.left || '0') || 0) / zoom)
  let duration = Math.max(MIN_DURATION, (Number.parseFloat(button.style.width || '0') || button.getBoundingClientRect().width || 0) / zoom)
  for (const span of Array.from(button.querySelectorAll<HTMLSpanElement>('span'))) {
    const timing = (span.textContent || '').match(/(\d+:\d+(?:\.\d+)?)\s*·\s*(\d+:\d+(?:\.\d+)?)/)
    if (!timing) continue
    const parsed = parseClock(timing[2])
    if (Number.isFinite(parsed) && parsed > 0) duration = parsed
  }
  return {
    lane,
    startAt,
    duration,
    name: match[2].trim(),
    button,
    trackId: button.dataset.maghrabiAudioTrackId,
  }
}

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button`))
}

function clickRestore() {
  editorButtons().find((button) => (button.textContent || '').includes('استعادة'))?.click()
}

async function flushEditorSave(projectId: string) {
  const saveButton = editorButtons().find((button) => (button.textContent || '').includes('حفظ'))
  if (!saveButton || saveButton.disabled) return loadStoredVideoProject<ProjectShape>(projectId)

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

  saveButton.click()
  await confirmed
  return loadStoredVideoProject<ProjectShape>(projectId)
}

function findTrack(project: ProjectShape, ref: AudioRef) {
  const tracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
  if (ref.trackId) {
    const exact = tracks.find((track) => track.id === ref.trackId)
    if (exact) return exact
  }
  const lane = tracks.filter((track) => track.lane === ref.lane)
  const named = lane.filter((track) => !ref.name || !track.name || ref.name.includes(track.name))
  return (named.length ? named : lane)
    .sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

async function mutateAudioTrack(ref: AudioRef, mutator: (track: AudioTrack, snapshot: StoredVideoProject<ProjectShape>) => boolean) {
  const projectId = getActiveStudioProjectId()
  if (!projectId) return false
  const snapshot = await flushEditorSave(projectId)
  if (!snapshot) return false
  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  project.audioTracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
  const track = findTrack(project, ref)
  if (!track || project.trackStates?.[track.lane]?.locked) return false
  if (!mutator(track, snapshot)) return false
  await saveStoredVideoProject({ ...snapshot, project, savedAt: new Date().toISOString() }, projectId)
  window.setTimeout(clickRestore, 80)
  return true
}

function fileSignature(file: Blob, index: number) {
  const candidate = file as File
  return `${index}:${candidate.name || 'audio'}:${file.size}:${candidate.lastModified || 0}:${file.type}`
}

async function decodePeaks(file: Blob, bars = WAVE_BARS) {
  const Context = window.AudioContext
  if (!Context) return []
  const context = new Context()
  try {
    const bytes = await file.arrayBuffer()
    const buffer = await context.decodeAudioData(bytes.slice(0))
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
    const length = buffer.length
    const peaks = new Array<number>(bars).fill(0)
    for (let bar = 0; bar < bars; bar += 1) {
      const from = Math.floor((bar / bars) * length)
      const to = Math.max(from + 1, Math.floor(((bar + 1) / bars) * length))
      const stride = Math.max(1, Math.floor((to - from) / 48))
      let peak = 0
      for (let sample = from; sample < to; sample += stride) {
        for (const channel of channels) peak = Math.max(peak, Math.abs(channel[sample] || 0))
      }
      peaks[bar] = peak
    }
    const max = Math.max(.0001, ...peaks)
    return peaks.map((value) => clamp(value / max, 0, 1))
  } finally {
    void context.close().catch(() => undefined)
  }
}

function gainY(gain: number) {
  return clamp(1 - clamp(gain, 0, MAX_GAIN) / MAX_GAIN, .05, .95) * 100
}

function gainFromPointer(button: HTMLButtonElement, clientY: number) {
  const rect = button.getBoundingClientRect()
  if (!rect.height) return 1
  return clamp(((rect.bottom - clientY) / rect.height) * MAX_GAIN, 0, MAX_GAIN)
}

function automationValue(track: AudioTrack, localTime: number) {
  const points = [...(track.automation || [])].sort((a, b) => Number(a.time) - Number(b.time))
  if (!points.length) return clamp(track.volume, 0, MAX_GAIN)
  if (localTime <= points[0].time) return clamp(points[0].gain, 0, MAX_GAIN)
  const last = points[points.length - 1]
  if (localTime >= last.time) return clamp(last.gain, 0, MAX_GAIN)
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]
    if (localTime > right.time) continue
    const left = points[index - 1]
    const span = Math.max(.001, right.time - left.time)
    const mix = clamp((localTime - left.time) / span, 0, 1)
    return clamp(left.gain + (right.gain - left.gain) * mix, 0, MAX_GAIN)
  }
  return clamp(track.volume, 0, MAX_GAIN)
}

function waveformCanvas(button: HTMLButtonElement) {
  let canvas = button.querySelector<HTMLCanvasElement>('.maghrabi-audio-waveform')
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.className = 'maghrabi-audio-waveform'
    canvas.setAttribute('aria-hidden', 'true')
    button.appendChild(canvas)
  }
  return canvas
}

function renderWaveform(canvas: HTMLCanvasElement, peaks: number[], track: AudioTrack, mediaDuration: number) {
  const button = canvas.parentElement as HTMLButtonElement | null
  if (!button || !peaks.length) return
  const width = Math.max(1, Math.round(button.clientWidth))
  const height = Math.max(1, Math.round(button.clientHeight))
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2)
  const pixelWidth = Math.round(width * dpr)
  const pixelHeight = Math.round(height * dpr)
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, pixelWidth, pixelHeight)
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.strokeStyle = 'rgba(103, 232, 249, .44)'
  ctx.lineWidth = 1
  ctx.beginPath()
  const safeDuration = Math.max(MIN_DURATION, mediaDuration || track.sourceEnd)
  const startFraction = clamp(track.sourceStart / safeDuration, 0, 1)
  const endFraction = clamp(track.sourceEnd / safeDuration, startFraction, 1)
  const from = Math.floor(startFraction * (peaks.length - 1))
  const to = Math.max(from + 1, Math.ceil(endFraction * (peaks.length - 1)))
  const visible = Math.max(1, to - from)
  const columns = Math.max(8, Math.min(width, 420))
  const center = height / 2
  const amplitude = Math.max(2, height * .34)
  for (let column = 0; column < columns; column += 1) {
    const index = clamp(Math.floor(from + (column / Math.max(1, columns - 1)) * visible), 0, peaks.length - 1)
    const peak = peaks[index] || 0
    const x = (column / Math.max(1, columns - 1)) * width
    ctx.moveTo(x, center - peak * amplitude)
    ctx.lineTo(x, center + peak * amplitude)
  }
  ctx.stroke()
  ctx.restore()
}

function removeDecorations(button: HTMLButtonElement) {
  button.querySelectorAll('.maghrabi-audio-fade-handle, .maghrabi-audio-gain-svg, .maghrabi-audio-gain-point, .maghrabi-audio-base-gain, .maghrabi-audio-duck-badge').forEach((item) => item.remove())
}

function addFadeHandle(button: HTMLButtonElement, edge: 'in' | 'out', seconds: number, duration: number) {
  const handle = document.createElement('span')
  handle.className = `maghrabi-audio-fade-handle maghrabi-audio-edit-control is-${edge}`
  handle.dataset.edge = edge
  handle.dataset.seconds = String(seconds)
  const percent = clamp(seconds / Math.max(MIN_DURATION, duration), 0, 1) * 100
  if (edge === 'in') handle.style.left = `${percent}%`
  else handle.style.left = `${100 - percent}%`
  handle.title = `${edge === 'in' ? 'Fade In' : 'Fade Out'} · اسحب أفقيًا`
  button.appendChild(handle)
}

function addGainCurve(button: HTMLButtonElement, track: AudioTrack, duration: number) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('maghrabi-audio-gain-svg')
  svg.setAttribute('viewBox', '0 0 100 100')
  svg.setAttribute('preserveAspectRatio', 'none')
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
  const points = [...(track.automation || [])].sort((a, b) => Number(a.time) - Number(b.time))
  const curve = [
    { time: 0, gain: automationValue(track, 0) },
    ...points,
    { time: duration, gain: automationValue(track, duration) },
  ]
  polyline.setAttribute('points', curve.map((point) => `${clamp(point.time / duration, 0, 1) * 100},${gainY(point.gain)}`).join(' '))
  polyline.setAttribute('vector-effect', 'non-scaling-stroke')
  svg.appendChild(polyline)
  button.appendChild(svg)

  points.forEach((point) => {
    const dot = document.createElement('span')
    dot.className = 'maghrabi-audio-gain-point maghrabi-audio-edit-control'
    dot.dataset.time = String(point.time)
    dot.dataset.gain = String(point.gain)
    dot.style.left = `${clamp(point.time / duration, 0, 1) * 100}%`
    dot.style.top = `${gainY(point.gain)}%`
    dot.title = `Volume Keyframe · ${point.time.toFixed(2)}s · ${point.gain.toFixed(2)}× · Double-click للحذف`
    button.appendChild(dot)
  })

  const base = document.createElement('span')
  base.className = 'maghrabi-audio-base-gain maghrabi-audio-edit-control'
  base.dataset.gain = String(track.volume)
  base.style.top = `${gainY(track.volume)}%`
  base.title = `Clip Gain ${track.volume.toFixed(2)}× · اسحب رأسيًا`
  button.appendChild(base)
}

function addDuckBadge(button: HTMLButtonElement, strength: number) {
  const badge = document.createElement('span')
  badge.className = 'maghrabi-audio-duck-badge'
  badge.textContent = `DUCK ${Math.round(clamp(strength, 0, 1) * 100)}%`
  badge.title = 'Audio Ducking مفعّل لهذا المسار الموسيقي أثناء وجود صوت الفيديو'
  button.appendChild(badge)
}

export default function StudioAudioTimelinePro() {
  const [message, setMessage] = useState('')

  useEffect(() => {
    let disposed = false
    let snapshot: StoredVideoProject<ProjectShape> | null = null
    let decorateFrame = 0
    let loadingGeneration = 0
    let activeCleanup: (() => void) | null = null
    const peakCache = new Map<string, PeakCacheEntry>()

    const announce = (text: string) => {
      setMessage(text)
      window.setTimeout(() => setMessage((current) => current === text ? '' : current), 2400)
    }

    const loadSnapshot = async () => {
      const generation = ++loadingGeneration
      const projectId = getActiveStudioProjectId()
      const next = projectId ? await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null) : null
      if (disposed || generation !== loadingGeneration) return
      snapshot = next
      scheduleDecorate()
    }

    const getPeaks = (file: Blob, index: number) => {
      const key = fileSignature(file, index)
      const existing = peakCache.get(key)
      if (existing) return existing
      const promise = decodePeaks(file).catch(() => [])
      peakCache.set(key, promise)
      return promise
    }

    const decorateButton = async (button: HTMLButtonElement, ref: AudioRef) => {
      const current = snapshot
      if (!current) return
      const project = current.project || {}
      const track = findTrack(project, ref)
      if (!track) return
      button.dataset.maghrabiAudioTrackId = track.id
      button.classList.add('maghrabi-audio-pro-clip')
      button.style.setProperty('--maghrabi-audio-fade-in', `${clamp(track.fadeIn / Math.max(MIN_DURATION, ref.duration), 0, 1) * 100}%`)
      button.style.setProperty('--maghrabi-audio-fade-out', `${clamp(track.fadeOut / Math.max(MIN_DURATION, ref.duration), 0, 1) * 100}%`)
      button.querySelectorAll(':scope > span').forEach((span) => {
        const element = span as HTMLElement
        if (!element.classList.contains('maghrabi-audio-edit-control') && !element.classList.contains('maghrabi-audio-duck-badge')) element.classList.add('maghrabi-audio-clip-label')
      })
      button.querySelectorAll<HTMLElement>('.maghrabi-trim-handle').forEach((handle) => {
        handle.title = `${handle.classList.contains('is-in') ? 'Audio Trim In' : 'Audio Trim Out'} · Shift=Ripple · Alt=Rolling`
      })

      removeDecorations(button)
      addFadeHandle(button, 'in', Math.max(0, Number(track.fadeIn) || 0), ref.duration)
      addFadeHandle(button, 'out', Math.max(0, Number(track.fadeOut) || 0), ref.duration)
      addGainCurve(button, track, ref.duration)

      const creative = loadCreativeSettings(getActiveStudioProjectId())
      button.classList.toggle('is-audio-ducking', creative.audioDuckingEnabled && !track.linkedClipId)
      if (creative.audioDuckingEnabled && !track.linkedClipId) addDuckBadge(button, creative.duckingStrength)

      const file = current.audios?.[track.fileIndex]
      if (!(file instanceof Blob)) return
      const canvas = waveformCanvas(button)
      const peaks = await getPeaks(file, track.fileIndex)
      if (disposed || !button.isConnected) return
      renderWaveform(canvas, peaks, track, current.audioDurations?.[track.fileIndex] || track.sourceEnd)
    }

    const decorate = () => {
      window.cancelAnimationFrame(decorateFrame)
      decorateFrame = window.requestAnimationFrame(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button.maghrabi-pro-clip, ${ROOT} button[style*="left"][style*="width"]`))
          .filter((button) => /^A[123]\s*·/i.test(firstClipLabel(button)))
        buttons.forEach((button) => {
          const ref = audioRef(button)
          if (ref) void decorateButton(button, ref)
        })
      })
    }

    function scheduleDecorate() {
      decorate()
    }

    const startDrag = (event: PointerEvent, onMove: (move: PointerEvent) => void, onFinish: () => void) => {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      document.body.classList.add('maghrabi-audio-editing')
      const finish = () => {
        document.removeEventListener('pointermove', onMove, true)
        document.removeEventListener('pointerup', finish, true)
        document.removeEventListener('pointercancel', finish, true)
        document.body.classList.remove('maghrabi-audio-editing')
        activeCleanup = null
        onFinish()
      }
      activeCleanup?.()
      activeCleanup = finish
      document.addEventListener('pointermove', onMove, true)
      document.addEventListener('pointerup', finish, { capture: true, once: true })
      document.addEventListener('pointercancel', finish, { capture: true, once: true })
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const target = event.target instanceof HTMLElement ? event.target : null
      const button = target?.closest<HTMLButtonElement>('button.maghrabi-audio-pro-clip')
      if (!button) return
      const ref = audioRef(button)
      const current = snapshot
      const track = ref && current ? findTrack(current.project || {}, ref) : null
      if (!ref || !track || current?.project.trackStates?.[track.lane]?.locked) return

      const fade = target.closest<HTMLElement>('.maghrabi-audio-fade-handle')
      if (fade) {
        const edge = fade.dataset.edge === 'out' ? 'out' : 'in'
        const startX = event.clientX
        const duration = Math.max(MIN_DURATION, track.sourceEnd - track.sourceStart)
        const other = edge === 'in' ? Math.max(0, Number(track.fadeOut) || 0) : Math.max(0, Number(track.fadeIn) || 0)
        const initial = edge === 'in' ? Math.max(0, Number(track.fadeIn) || 0) : Math.max(0, Number(track.fadeOut) || 0)
        let nextValue = initial
        const onMove = (move: PointerEvent) => {
          move.preventDefault()
          const delta = (move.clientX - startX) / parseZoom() * (edge === 'in' ? 1 : -1)
          nextValue = clamp(initial + delta, 0, Math.max(0, duration - other))
          const percent = clamp(nextValue / duration, 0, 1) * 100
          fade.style.left = `${edge === 'in' ? percent : 100 - percent}%`
          fade.dataset.seconds = nextValue.toFixed(3)
          button.dataset.maghrabiAudioEdit = `${edge === 'in' ? 'FADE IN' : 'FADE OUT'} ${nextValue.toFixed(2)}s`
        }
        startDrag(event, onMove, () => {
          delete button.dataset.maghrabiAudioEdit
          void mutateAudioTrack(ref, (next) => {
            if (edge === 'in') next.fadeIn = nextValue
            else next.fadeOut = nextValue
            return true
          }).then((ok) => { if (ok) announce(`${edge === 'in' ? 'Fade In' : 'Fade Out'} · ${nextValue.toFixed(2)}s`) })
        })
        return
      }

      const point = target.closest<HTMLElement>('.maghrabi-audio-gain-point')
      if (point) {
        const originalTime = Number(point.dataset.time) || 0
        const startX = event.clientX
        let nextTime = originalTime
        let nextGain = Number(point.dataset.gain) || 1
        const duration = Math.max(MIN_DURATION, track.sourceEnd - track.sourceStart)
        const onMove = (move: PointerEvent) => {
          move.preventDefault()
          nextTime = clamp(originalTime + (move.clientX - startX) / parseZoom(), 0, duration)
          nextGain = gainFromPointer(button, move.clientY)
          point.style.left = `${nextTime / duration * 100}%`
          point.style.top = `${gainY(nextGain)}%`
          button.dataset.maghrabiAudioEdit = `KEY ${nextTime.toFixed(2)}s · ${nextGain.toFixed(2)}×`
        }
        startDrag(event, onMove, () => {
          delete button.dataset.maghrabiAudioEdit
          void mutateAudioTrack(ref, (next) => {
            const points = [...(next.automation || [])]
            if (!points.length) return false
            let index = 0
            let distance = Number.POSITIVE_INFINITY
            points.forEach((candidate, candidateIndex) => {
              const nextDistance = Math.abs(Number(candidate.time) - originalTime)
              if (nextDistance < distance) { distance = nextDistance; index = candidateIndex }
            })
            points[index] = { time: nextTime, gain: nextGain }
            next.automation = points.sort((a, b) => a.time - b.time)
            return true
          }).then((ok) => { if (ok) announce(`Volume Keyframe · ${nextGain.toFixed(2)}×`) })
        })
        return
      }

      const base = target.closest<HTMLElement>('.maghrabi-audio-base-gain')
      if (base) {
        let nextGain = clamp(Number(track.volume) || 0, 0, MAX_GAIN)
        const onMove = (move: PointerEvent) => {
          move.preventDefault()
          nextGain = gainFromPointer(button, move.clientY)
          base.style.top = `${gainY(nextGain)}%`
          button.dataset.maghrabiAudioEdit = `GAIN ${nextGain.toFixed(2)}×`
        }
        startDrag(event, onMove, () => {
          delete button.dataset.maghrabiAudioEdit
          void mutateAudioTrack(ref, (next) => { next.volume = nextGain; return true })
            .then((ok) => { if (ok) announce(`Clip Gain · ${nextGain.toFixed(2)}×`) })
        })
        return
      }

      if (event.altKey && event.shiftKey && !target.closest('.maghrabi-trim-handle')) {
        const mediaDuration = Math.max(track.sourceEnd, current.audioDurations?.[track.fileIndex] || track.sourceEnd)
        const clipDuration = Math.max(MIN_DURATION, track.sourceEnd - track.sourceStart)
        const maxStart = Math.max(0, mediaDuration - clipDuration)
        const initialStart = track.sourceStart
        const startX = event.clientX
        let nextStart = initialStart
        const onMove = (move: PointerEvent) => {
          move.preventDefault()
          nextStart = clamp(initialStart + (move.clientX - startX) / parseZoom(), 0, maxStart)
          button.dataset.maghrabiAudioEdit = `SLIP ${(nextStart - initialStart >= 0 ? '+' : '')}${(nextStart - initialStart).toFixed(2)}s`
          button.classList.add('is-audio-slipping')
        }
        startDrag(event, onMove, () => {
          delete button.dataset.maghrabiAudioEdit
          button.classList.remove('is-audio-slipping')
          void mutateAudioTrack(ref, (next) => {
            const length = next.sourceEnd - next.sourceStart
            next.sourceStart = nextStart
            next.sourceEnd = nextStart + length
            return true
          }).then((ok) => { if (ok) announce(`Audio Slip · ${nextStart.toFixed(2)}s source`) })
        })
      }
    }

    const onDoubleClick = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const button = target?.closest<HTMLButtonElement>('button.maghrabi-audio-pro-clip')
      if (!button) return
      const ref = audioRef(button)
      if (!ref) return

      const point = target.closest<HTMLElement>('.maghrabi-audio-gain-point')
      if (point) {
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
        const time = Number(point.dataset.time) || 0
        void mutateAudioTrack(ref, (track) => {
          const points = [...(track.automation || [])]
          if (!points.length) return false
          let index = 0
          let distance = Number.POSITIVE_INFINITY
          points.forEach((candidate, candidateIndex) => {
            const nextDistance = Math.abs(candidate.time - time)
            if (nextDistance < distance) { distance = nextDistance; index = candidateIndex }
          })
          points.splice(index, 1)
          track.automation = points
          return true
        }).then((ok) => { if (ok) announce('Volume Keyframe deleted') })
        return
      }

      if (!event.shiftKey) return
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
      const rect = button.getBoundingClientRect()
      const localTime = clamp((event.clientX - rect.left) / Math.max(1, rect.width) * ref.duration, 0, ref.duration)
      const gain = gainFromPointer(button, event.clientY)
      void mutateAudioTrack(ref, (track) => {
        const points = [...(track.automation || []), { time: localTime, gain }]
          .sort((a, b) => a.time - b.time)
        track.automation = points
        return true
      }).then((ok) => { if (ok) announce(`Volume Keyframe · ${localTime.toFixed(2)}s · ${gain.toFixed(2)}×`) })
    }

    const onProjectChanged = () => { void loadSnapshot() }
    const onCreativeChanged = () => scheduleDecorate()
    const observer = new MutationObserver(() => scheduleDecorate())
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('dblclick', onDoubleClick, true)
    window.addEventListener('maghrabi-project-snapshot-changed', onProjectChanged as EventListener)
    window.addEventListener('maghrabi-active-project-changed', onProjectChanged as EventListener)
    window.addEventListener('maghrabi-creative-settings-changed', onCreativeChanged as EventListener)
    window.addEventListener('resize', scheduleDecorate)
    document.querySelector<HTMLInputElement>('.maghrabi-studio-pro input[type="range"][min="5"][max="30"]')?.addEventListener('input', scheduleDecorate)

    void loadSnapshot()

    return () => {
      disposed = true
      loadingGeneration += 1
      activeCleanup?.()
      window.cancelAnimationFrame(decorateFrame)
      observer.disconnect()
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('dblclick', onDoubleClick, true)
      window.removeEventListener('maghrabi-project-snapshot-changed', onProjectChanged as EventListener)
      window.removeEventListener('maghrabi-active-project-changed', onProjectChanged as EventListener)
      window.removeEventListener('maghrabi-creative-settings-changed', onCreativeChanged as EventListener)
      window.removeEventListener('resize', scheduleDecorate)
      document.querySelector<HTMLInputElement>('.maghrabi-studio-pro input[type="range"][min="5"][max="30"]')?.removeEventListener('input', scheduleDecorate)
    }
  }, [])

  return <div className={`maghrabi-audio-pro-toast${message ? ' is-visible' : ''}`} aria-live="polite">{message}</div>
}
