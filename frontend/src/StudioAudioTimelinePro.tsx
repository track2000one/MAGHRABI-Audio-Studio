import { useEffect, useState } from 'react'
import { loadCreativeSettings } from './lib/creativeProjectSettings'
import { getActiveStudioProjectId } from './lib/projectHubStore'
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
type ProjectShape = {
  audioTracks?: AudioTrack[]
  trackStates?: Partial<Record<LaneKey, { locked?: boolean }>>
  [key: string]: unknown
}
type AudioRef = { lane: AudioLane; startAt: number; duration: number; name: string; button: HTMLButtonElement; trackId?: string }

const ROOT = '.maghrabi-studio-pro main'
const MIN_DURATION = .02
const MAX_GAIN = 2
const PEAK_BARS = 720

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

function firstLabel(button: HTMLButtonElement) {
  return (button.querySelector('span')?.textContent || '').trim()
}

function parseClock(value: string) {
  const match = value.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/)
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN
}

function toAudioRef(button: HTMLButtonElement): AudioRef | null {
  const label = firstLabel(button)
  const match = label.match(/^(A[123])\s*·\s*(.*)$/)
  if (!match) return null
  const zoom = parseZoom()
  let duration = Math.max(MIN_DURATION, (Number.parseFloat(button.style.width || '0') || button.getBoundingClientRect().width || 0) / zoom)
  for (const span of Array.from(button.querySelectorAll<HTMLSpanElement>('span'))) {
    const timing = (span.textContent || '').match(/(\d+:\d+(?:\.\d+)?)\s*·\s*(\d+:\d+(?:\.\d+)?)/)
    if (!timing) continue
    const parsed = parseClock(timing[2])
    if (Number.isFinite(parsed) && parsed > 0) duration = parsed
  }
  return {
    lane: match[1] as AudioLane,
    startAt: Math.max(0, (Number.parseFloat(button.style.left || '0') || 0) / zoom),
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

async function mutateTrack(ref: AudioRef, mutate: (track: AudioTrack, snapshot: StoredVideoProject<ProjectShape>) => boolean) {
  const projectId = getActiveStudioProjectId()
  if (!projectId) return false
  const snapshot = await flushEditorSave(projectId)
  if (!snapshot) return false
  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  project.audioTracks = Array.isArray(project.audioTracks) ? project.audioTracks : []
  const track = findTrack(project, ref)
  if (!track || project.trackStates?.[track.lane]?.locked) return false
  if (!mutate(track, snapshot)) return false
  await saveStoredVideoProject({ ...snapshot, project, savedAt: new Date().toISOString() }, projectId)
  window.setTimeout(clickRestore, 80)
  return true
}

function fileKey(file: Blob, index: number) {
  const candidate = file as File
  return `${index}:${candidate.name || 'audio'}:${file.size}:${candidate.lastModified || 0}:${file.type}`
}

async function decodePeaks(file: Blob) {
  const context = new AudioContext()
  try {
    const buffer = await context.decodeAudioData((await file.arrayBuffer()).slice(0))
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
    const peaks = new Array<number>(PEAK_BARS).fill(0)
    for (let bar = 0; bar < PEAK_BARS; bar += 1) {
      const from = Math.floor((bar / PEAK_BARS) * buffer.length)
      const to = Math.max(from + 1, Math.floor(((bar + 1) / PEAK_BARS) * buffer.length))
      const stride = Math.max(1, Math.floor((to - from) / 48))
      let peak = 0
      for (let sample = from; sample < to; sample += stride) {
        for (const channel of channels) peak = Math.max(peak, Math.abs(channel[sample] || 0))
      }
      peaks[bar] = peak
    }
    const max = Math.max(.0001, ...peaks)
    return peaks.map((peak) => clamp(peak / max, 0, 1))
  } finally {
    void context.close().catch(() => undefined)
  }
}

function gainY(gain: number) {
  return clamp(1 - clamp(gain, 0, MAX_GAIN) / MAX_GAIN, .05, .95) * 100
}

function gainFromPointer(button: HTMLButtonElement, clientY: number) {
  const rect = button.getBoundingClientRect()
  return rect.height ? clamp(((rect.bottom - clientY) / rect.height) * MAX_GAIN, 0, MAX_GAIN) : 1
}

function ensureCanvas(button: HTMLButtonElement) {
  let canvas = button.querySelector<HTMLCanvasElement>('.maghrabi-audio-waveform')
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.className = 'maghrabi-audio-waveform'
    canvas.setAttribute('aria-hidden', 'true')
    button.appendChild(canvas)
  }
  return canvas
}

function drawWaveform(canvas: HTMLCanvasElement, peaks: number[], track: AudioTrack, mediaDuration: number) {
  const button = canvas.parentElement as HTMLButtonElement | null
  if (!button || !peaks.length) return
  const width = Math.max(1, Math.round(button.clientWidth))
  const height = Math.max(1, Math.round(button.clientHeight))
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2)
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.strokeStyle = 'rgba(103,232,249,.46)'
  ctx.lineWidth = 1
  ctx.beginPath()
  const total = Math.max(MIN_DURATION, mediaDuration || track.sourceEnd)
  const from = Math.floor(clamp(track.sourceStart / total, 0, 1) * (peaks.length - 1))
  const to = Math.max(from + 1, Math.ceil(clamp(track.sourceEnd / total, 0, 1) * (peaks.length - 1)))
  const columns = Math.max(8, Math.min(width, 420))
  const center = height / 2
  for (let column = 0; column < columns; column += 1) {
    const index = clamp(Math.floor(from + (column / Math.max(1, columns - 1)) * Math.max(1, to - from)), 0, peaks.length - 1)
    const amp = (peaks[index] || 0) * height * .34
    const x = column / Math.max(1, columns - 1) * width
    ctx.moveTo(x, center - amp)
    ctx.lineTo(x, center + amp)
  }
  ctx.stroke()
  ctx.restore()
}

function clearControls(button: HTMLButtonElement) {
  button.querySelectorAll('.maghrabi-audio-fade-handle, .maghrabi-audio-gain-svg, .maghrabi-audio-gain-point, .maghrabi-audio-base-gain, .maghrabi-audio-duck-badge').forEach((node) => node.remove())
}

function addControls(button: HTMLButtonElement, track: AudioTrack, duration: number, ducking: boolean, duckStrength: number) {
  clearControls(button)
  const fadeIn = clamp(Number(track.fadeIn) || 0, 0, duration)
  const fadeOut = clamp(Number(track.fadeOut) || 0, 0, duration)
  button.style.setProperty('--maghrabi-audio-fade-in', `${fadeIn / duration * 100}%`)
  button.style.setProperty('--maghrabi-audio-fade-out', `${fadeOut / duration * 100}%`)

  for (const [edge, seconds] of [['in', fadeIn], ['out', fadeOut]] as const) {
    const handle = document.createElement('span')
    handle.className = `maghrabi-audio-fade-handle maghrabi-audio-edit-control is-${edge}`
    handle.dataset.edge = edge
    const percent = seconds / duration * 100
    handle.style.left = `${edge === 'in' ? percent : 100 - percent}%`
    handle.title = `${edge === 'in' ? 'Fade In' : 'Fade Out'} · اسحب أفقيًا`
    button.appendChild(handle)
  }

  const points = [...(track.automation || [])].sort((a, b) => Number(a.time) - Number(b.time))
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('maghrabi-audio-gain-svg')
  svg.setAttribute('viewBox', '0 0 100 100')
  svg.setAttribute('preserveAspectRatio', 'none')
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
  const curve = [{ time: 0, gain: points[0]?.gain ?? track.volume }, ...points, { time: duration, gain: points.at(-1)?.gain ?? track.volume }]
  line.setAttribute('points', curve.map((point) => `${clamp(point.time / duration, 0, 1) * 100},${gainY(point.gain)}`).join(' '))
  line.setAttribute('vector-effect', 'non-scaling-stroke')
  svg.appendChild(line)
  button.appendChild(svg)

  points.forEach((point) => {
    const node = document.createElement('span')
    node.className = 'maghrabi-audio-gain-point maghrabi-audio-edit-control'
    node.dataset.time = String(point.time)
    node.dataset.gain = String(point.gain)
    node.style.left = `${clamp(point.time / duration, 0, 1) * 100}%`
    node.style.top = `${gainY(point.gain)}%`
    node.title = `Volume Keyframe · ${point.time.toFixed(2)}s · ${point.gain.toFixed(2)}× · Double-click للحذف`
    button.appendChild(node)
  })

  const base = document.createElement('span')
  base.className = 'maghrabi-audio-base-gain maghrabi-audio-edit-control'
  base.style.top = `${gainY(track.volume)}%`
  base.title = `Clip Gain ${track.volume.toFixed(2)}× · اسحب رأسيًا`
  button.appendChild(base)

  button.classList.toggle('is-audio-ducking', ducking && !track.linkedClipId)
  if (ducking && !track.linkedClipId) {
    const badge = document.createElement('span')
    badge.className = 'maghrabi-audio-duck-badge'
    badge.textContent = `DUCK ${Math.round(clamp(duckStrength, 0, 1) * 100)}%`
    button.appendChild(badge)
  }
}

function mutationTouchesTimelineButtons(mutation: MutationRecord) {
  const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)]
  return nodes.some((node) => {
    if (!(node instanceof HTMLElement)) return false
    if (node.matches('button[style*="left"][style*="width"]')) return true
    return Boolean(node.querySelector('button[style*="left"][style*="width"]'))
  })
}

export default function StudioAudioTimelinePro() {
  const [message, setMessage] = useState('')

  useEffect(() => {
    let disposed = false
    let snapshot: StoredVideoProject<ProjectShape> | null = null
    let decorateFrame = 0
    let generation = 0
    let activeCleanup: (() => void) | null = null
    const peakCache = new Map<string, Promise<number[]>>()

    const announce = (text: string) => {
      setMessage(text)
      window.setTimeout(() => setMessage((current) => current === text ? '' : current), 2200)
    }

    const scheduleDecorate = () => {
      window.cancelAnimationFrame(decorateFrame)
      decorateFrame = window.requestAnimationFrame(() => void decorate())
    }

    const loadSnapshot = async () => {
      const localGeneration = ++generation
      const projectId = getActiveStudioProjectId()
      const next = projectId ? await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null) : null
      if (disposed || localGeneration !== generation) return
      snapshot = next
      scheduleDecorate()
    }

    const peaksFor = (file: Blob, index: number) => {
      const key = fileKey(file, index)
      const cached = peakCache.get(key)
      if (cached) return cached
      const promise = decodePeaks(file).catch(() => [])
      peakCache.set(key, promise)
      return promise
    }

    const decorate = async () => {
      const current = snapshot
      if (!current) return
      const creative = loadCreativeSettings(getActiveStudioProjectId())
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button.maghrabi-pro-clip, ${ROOT} button[style*="left"][style*="width"]`))
        .filter((button) => /^A[123]\s*·/i.test(firstLabel(button)))
      await Promise.all(buttons.map(async (button) => {
        const ref = toAudioRef(button)
        if (!ref) return
        const track = findTrack(current.project || {}, ref)
        if (!track) return
        button.dataset.maghrabiAudioTrackId = track.id
        button.classList.add('maghrabi-audio-pro-clip')
        button.querySelectorAll(':scope > span').forEach((span) => {
          const element = span as HTMLElement
          if (!element.classList.contains('maghrabi-audio-edit-control') && !element.classList.contains('maghrabi-audio-duck-badge')) element.classList.add('maghrabi-audio-clip-label')
        })
        button.querySelectorAll<HTMLElement>('.maghrabi-trim-handle').forEach((handle) => {
          handle.title = `${handle.classList.contains('is-in') ? 'Audio Trim In' : 'Audio Trim Out'} · Shift=Ripple · Alt=Rolling`
        })
        addControls(button, track, Math.max(MIN_DURATION, track.sourceEnd - track.sourceStart), creative.audioDuckingEnabled, creative.duckingStrength)
        const file = current.audios?.[track.fileIndex]
        if (!(file instanceof Blob)) return
        const peaks = await peaksFor(file, track.fileIndex)
        if (disposed || !button.isConnected) return
        drawWaveform(ensureCanvas(button), peaks, track, current.audioDurations?.[track.fileIndex] || track.sourceEnd)
      }))
    }

    const startManagedDrag = (event: PointerEvent, onMove: (move: PointerEvent) => void, onDone: () => void) => {
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
        onDone()
      }
      activeCleanup?.()
      activeCleanup = finish
      document.addEventListener('pointermove', onMove, true)
      document.addEventListener('pointerup', finish, { capture: true, once: true })
      document.addEventListener('pointercancel', finish, { capture: true, once: true })
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof HTMLElement)) return
      const target = event.target
      const button = target.closest<HTMLButtonElement>('button.maghrabi-audio-pro-clip')
      if (!button) return
      const ref = toAudioRef(button)
      const current = snapshot
      if (!ref || !current) return
      const track = findTrack(current.project || {}, ref)
      if (!track || current.project.trackStates?.[track.lane]?.locked) return
      const duration = Math.max(MIN_DURATION, track.sourceEnd - track.sourceStart)

      const fade = target.closest<HTMLElement>('.maghrabi-audio-fade-handle')
      if (fade) {
        const edge = fade.dataset.edge === 'out' ? 'out' : 'in'
        const initial = edge === 'in' ? Math.max(0, track.fadeIn || 0) : Math.max(0, track.fadeOut || 0)
        const other = edge === 'in' ? Math.max(0, track.fadeOut || 0) : Math.max(0, track.fadeIn || 0)
        const startX = event.clientX
        let value = initial
        startManagedDrag(event, (move) => {
          move.preventDefault()
          const delta = (move.clientX - startX) / parseZoom() * (edge === 'in' ? 1 : -1)
          value = clamp(initial + delta, 0, Math.max(0, duration - other))
          const percent = value / duration * 100
          fade.style.left = `${edge === 'in' ? percent : 100 - percent}%`
          button.dataset.maghrabiAudioEdit = `${edge === 'in' ? 'FADE IN' : 'FADE OUT'} ${value.toFixed(2)}s`
        }, () => {
          delete button.dataset.maghrabiAudioEdit
          void mutateTrack(ref, (next) => { if (edge === 'in') next.fadeIn = value; else next.fadeOut = value; return true })
            .then((ok) => { if (ok) announce(`${edge === 'in' ? 'Fade In' : 'Fade Out'} · ${value.toFixed(2)}s`) })
        })
        return
      }

      const point = target.closest<HTMLElement>('.maghrabi-audio-gain-point')
      if (point) {
        const originalTime = Number(point.dataset.time) || 0
        const startX = event.clientX
        let nextTime = originalTime
        let nextGain = Number(point.dataset.gain) || 1
        startManagedDrag(event, (move) => {
          move.preventDefault()
          nextTime = clamp(originalTime + (move.clientX - startX) / parseZoom(), 0, duration)
          nextGain = gainFromPointer(button, move.clientY)
          point.style.left = `${nextTime / duration * 100}%`
          point.style.top = `${gainY(nextGain)}%`
          button.dataset.maghrabiAudioEdit = `KEY ${nextTime.toFixed(2)}s · ${nextGain.toFixed(2)}×`
        }, () => {
          delete button.dataset.maghrabiAudioEdit
          void mutateTrack(ref, (next) => {
            const points = [...(next.automation || [])]
            if (!points.length) return false
            let index = 0
            let best = Number.POSITIVE_INFINITY
            points.forEach((candidate, candidateIndex) => {
              const distance = Math.abs(candidate.time - originalTime)
              if (distance < best) { best = distance; index = candidateIndex }
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
        let nextGain = clamp(track.volume || 0, 0, MAX_GAIN)
        startManagedDrag(event, (move) => {
          move.preventDefault()
          nextGain = gainFromPointer(button, move.clientY)
          base.style.top = `${gainY(nextGain)}%`
          button.dataset.maghrabiAudioEdit = `GAIN ${nextGain.toFixed(2)}×`
        }, () => {
          delete button.dataset.maghrabiAudioEdit
          void mutateTrack(ref, (next) => { next.volume = nextGain; return true })
            .then((ok) => { if (ok) announce(`Clip Gain · ${nextGain.toFixed(2)}×`) })
        })
        return
      }

      if (event.altKey && event.shiftKey && !target.closest('.maghrabi-trim-handle')) {
        const mediaDuration = Math.max(track.sourceEnd, current.audioDurations?.[track.fileIndex] || track.sourceEnd)
        const maxStart = Math.max(0, mediaDuration - duration)
        const initial = track.sourceStart
        const startX = event.clientX
        let nextStart = initial
        startManagedDrag(event, (move) => {
          move.preventDefault()
          nextStart = clamp(initial + (move.clientX - startX) / parseZoom(), 0, maxStart)
          button.classList.add('is-audio-slipping')
          button.dataset.maghrabiAudioEdit = `SLIP ${(nextStart - initial >= 0 ? '+' : '')}${(nextStart - initial).toFixed(2)}s`
        }, () => {
          delete button.dataset.maghrabiAudioEdit
          button.classList.remove('is-audio-slipping')
          void mutateTrack(ref, (next) => {
            const length = next.sourceEnd - next.sourceStart
            next.sourceStart = nextStart
            next.sourceEnd = nextStart + length
            return true
          }).then((ok) => { if (ok) announce(`Audio Slip · ${nextStart.toFixed(2)}s source`) })
        })
      }
    }

    const onDoubleClick = (event: MouseEvent) => {
      if (!(event.target instanceof HTMLElement)) return
      const target = event.target
      const button = target.closest<HTMLButtonElement>('button.maghrabi-audio-pro-clip')
      if (!button) return
      const ref = toAudioRef(button)
      if (!ref) return
      const point = target.closest<HTMLElement>('.maghrabi-audio-gain-point')
      if (point) {
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
        const time = Number(point.dataset.time) || 0
        void mutateTrack(ref, (track) => {
          const points = [...(track.automation || [])]
          if (!points.length) return false
          let index = 0
          let best = Number.POSITIVE_INFINITY
          points.forEach((candidate, candidateIndex) => {
            const distance = Math.abs(candidate.time - time)
            if (distance < best) { best = distance; index = candidateIndex }
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
      void mutateTrack(ref, (track) => {
        track.automation = [...(track.automation || []), { time: localTime, gain }].sort((a, b) => a.time - b.time)
        return true
      }).then((ok) => { if (ok) announce(`Volume Keyframe · ${localTime.toFixed(2)}s · ${gain.toFixed(2)}×`) })
    }

    const onProjectChanged = () => { void loadSnapshot() }
    const observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesTimelineButtons)) scheduleDecorate()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('dblclick', onDoubleClick, true)
    window.addEventListener('maghrabi-project-snapshot-changed', onProjectChanged as EventListener)
    window.addEventListener('maghrabi-active-project-changed', onProjectChanged as EventListener)
    window.addEventListener('maghrabi-creative-settings-changed', scheduleDecorate as EventListener)
    window.addEventListener('resize', scheduleDecorate)
    const zoom = document.querySelector<HTMLInputElement>('.maghrabi-studio-pro input[type="range"][min="5"][max="30"]')
    zoom?.addEventListener('input', scheduleDecorate)
    void loadSnapshot()

    return () => {
      disposed = true
      generation += 1
      activeCleanup?.()
      observer.disconnect()
      window.cancelAnimationFrame(decorateFrame)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('dblclick', onDoubleClick, true)
      window.removeEventListener('maghrabi-project-snapshot-changed', onProjectChanged as EventListener)
      window.removeEventListener('maghrabi-active-project-changed', onProjectChanged as EventListener)
      window.removeEventListener('maghrabi-creative-settings-changed', scheduleDecorate as EventListener)
      window.removeEventListener('resize', scheduleDecorate)
      zoom?.removeEventListener('input', scheduleDecorate)
    }
  }, [])

  return <div className={`maghrabi-audio-pro-toast${message ? ' is-visible' : ''}`} aria-live="polite">{message}</div>
}
