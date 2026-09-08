import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Circle, Crosshair, Eye, EyeOff, Move, RotateCcw, Save, Sparkles, Square, Trash2, WandSparkles } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import './studioEffectsMasksPro.css'

const ROOT = '.maghrabi-studio-pro main'
const MAX_TRACK_POINTS = 24

type VideoLane = 'V1' | 'V2' | 'V3'
type MaskEffect = 'none' | 'blur' | 'mosaic' | 'spotlight' | 'background-blur'
type MaskShape = 'rect' | 'ellipse'
type TrackEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold'

type TrackingPoint = {
  time: number
  x: number
  y: number
  width: number
  height: number
  easing: TrackEasing
}

type VideoClip = {
  id: string
  lane: VideoLane
  fileIndex: number
  startAt: number
  start: number
  end: number
  speed: number
  privacyEffect?: MaskEffect
  privacyMaskShape?: MaskShape
  privacyX?: number
  privacyY?: number
  privacyWidth?: number
  privacyHeight?: number
  privacyIntensity?: number
  privacyFeather?: number
  privacyTrackingEnabled?: boolean
  privacyTrackingPoints?: TrackingPoint[]
  chromaEnabled?: boolean
  chromaColor?: string
  chromaBackground?: string
  chromaSimilarity?: number
  chromaBlend?: number
  [key: string]: unknown
}

type ProjectShape = { clips?: VideoClip[]; [key: string]: unknown }
type ClipRef = { lane: VideoLane; fileIndex: number; startAt: number; signature: string }
type ClipMeta = ClipRef & { id: string; sourceStart: number; sourceEnd: number; speed: number; duration: number }

type MaskDraft = {
  effect: MaskEffect
  shape: MaskShape
  x: number
  y: number
  width: number
  height: number
  intensity: number
  feather: number
  trackingEnabled: boolean
  easing: TrackEasing
  points: TrackingPoint[]
  chromaEnabled: boolean
  chromaColor: string
  chromaBackground: string
  chromaSimilarity: number
  chromaBlend: number
}

type Geometry = Pick<MaskDraft, 'x' | 'y' | 'width' | 'height'>

const EFFECTS: Array<{ value: MaskEffect; label: string; detail: string }> = [
  { value: 'none', label: 'OFF', detail: 'بدون Mask' },
  { value: 'blur', label: 'BLUR', detail: 'طمس داخل التحديد' },
  { value: 'mosaic', label: 'MOSAIC', detail: 'Pixel privacy' },
  { value: 'spotlight', label: 'SPOTLIGHT', detail: 'عزل بصري للعنصر' },
  { value: 'background-blur', label: 'BG DEFOCUS', detail: 'تمويه ما خارج العنصر' },
]

const DEFAULT_DRAFT: MaskDraft = {
  effect: 'none', shape: 'rect', x: .34, y: .28, width: .30, height: .24,
  intensity: .58, feather: .018, trackingEnabled: false, easing: 'ease-in-out', points: [],
  chromaEnabled: false, chromaColor: '#00ff00', chromaBackground: '#101010', chromaSimilarity: .18, chromaBlend: .06,
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function parseClock(value: string) {
  const parts = value.trim().split(':').map(Number)
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return Number.NaN
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0]
}

function parseZoom() {
  for (const span of Array.from(document.querySelectorAll<HTMLSpanElement>(`${ROOT} span`))) {
    const match = (span.textContent || '').match(/([\d.]+)\s*px\/s/i)
    if (match) return Math.max(1, Number(match[1]) || 12)
  }
  return 12
}

function selectedVideoButton() {
  const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>(`${ROOT} button[style*="left"][style*="width"]`))
    .filter((button) => /^V[123]\s*·\s*V\d+/i.test((button.textContent || '').trim()))
  return candidates.find((button) => button.className.includes('border-violet-100'))
    || candidates.find((button) => button.classList.contains('maghrabi-multi-selected'))
    || null
}

function selectedVideoRef(): ClipRef | null {
  const button = selectedVideoButton()
  if (!button) return null
  const label = (button.querySelector('span')?.textContent || '').trim()
  const match = label.match(/^(V[123])\s*·\s*V(\d+)/i)
  if (!match) return null
  const lane = match[1].toUpperCase() as VideoLane
  const fileIndex = Math.max(0, Number(match[2]) - 1)
  let startAt = Number.NaN
  for (const span of Array.from(button.querySelectorAll<HTMLSpanElement>('span'))) {
    const timing = (span.textContent || '').match(/(\d+:\d+(?:\.\d+)?)\s*·\s*(\d+:\d+(?:\.\d+)?)/)
    if (!timing) continue
    startAt = parseClock(timing[1])
    if (Number.isFinite(startAt)) break
  }
  if (!Number.isFinite(startAt)) startAt = Math.max(0, (Number.parseFloat(button.style.left || '0') || 0) / parseZoom())
  return { lane, fileIndex, startAt, signature: `${lane}:${fileIndex}:${startAt.toFixed(3)}` }
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

function findClip(project: ProjectShape, ref: ClipRef) {
  const clips = Array.isArray(project.clips) ? project.clips : []
  const sameLane = clips.filter((clip) => clip.lane === ref.lane)
  const sameFile = sameLane.filter((clip) => clip.fileIndex === ref.fileIndex)
  const candidates = sameFile.length ? sameFile : sameLane
  return candidates.sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

function sanitizePoint(point: Partial<TrackingPoint>, fallback: Geometry): TrackingPoint {
  const width = clamp(Number(point.width ?? fallback.width), .03, 1)
  const height = clamp(Number(point.height ?? fallback.height), .03, 1)
  return {
    time: clamp(Number(point.time ?? 0), 0, 1),
    x: clamp(Number(point.x ?? fallback.x), 0, 1 - width),
    y: clamp(Number(point.y ?? fallback.y), 0, 1 - height),
    width,
    height,
    easing: ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'].includes(String(point.easing)) ? point.easing as TrackEasing : 'ease-in-out',
  }
}

function draftFromClip(clip: VideoClip | null): MaskDraft {
  if (!clip) return { ...DEFAULT_DRAFT, points: [] }
  const width = clamp(Number(clip.privacyWidth ?? .30), .03, 1)
  const height = clamp(Number(clip.privacyHeight ?? .24), .03, 1)
  const base: Geometry = {
    x: clamp(Number(clip.privacyX ?? .34), 0, 1 - width),
    y: clamp(Number(clip.privacyY ?? .28), 0, 1 - height),
    width,
    height,
  }
  const points = Array.isArray(clip.privacyTrackingPoints)
    ? clip.privacyTrackingPoints.slice(0, MAX_TRACK_POINTS).map((point) => sanitizePoint(point, base)).sort((a, b) => a.time - b.time)
    : []
  const effect = ['none', 'blur', 'mosaic', 'spotlight', 'background-blur'].includes(String(clip.privacyEffect)) ? clip.privacyEffect as MaskEffect : 'none'
  return {
    effect,
    shape: clip.privacyMaskShape === 'ellipse' ? 'ellipse' : 'rect',
    ...base,
    intensity: clamp(Number(clip.privacyIntensity ?? .58), .05, 1),
    feather: clamp(Number(clip.privacyFeather ?? .018), 0, .12),
    trackingEnabled: Boolean(clip.privacyTrackingEnabled),
    easing: points[0]?.easing || 'ease-in-out',
    points,
    chromaEnabled: Boolean(clip.chromaEnabled),
    chromaColor: String(clip.chromaColor || '#00ff00'),
    chromaBackground: String(clip.chromaBackground || '#101010'),
    chromaSimilarity: clamp(Number(clip.chromaSimilarity ?? .18), .01, 1),
    chromaBlend: clamp(Number(clip.chromaBlend ?? .06), 0, 1),
  }
}

function ease(kind: TrackEasing, value: number) {
  const t = clamp(value, 0, 1)
  if (kind === 'ease-in') return t * t
  if (kind === 'ease-out') return 1 - (1 - t) * (1 - t)
  if (kind === 'ease-in-out') return t < .5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2
  if (kind === 'hold') return 0
  return t
}

function geometryAt(draft: MaskDraft, time: number): Geometry {
  const base = { x: draft.x, y: draft.y, width: draft.width, height: draft.height }
  if (!draft.trackingEnabled || !draft.points.length) return base
  const points = draft.points
  if (time <= points[0].time) return points[0]
  if (time >= points[points.length - 1].time) return points[points.length - 1]
  const index = points.findIndex((point) => point.time >= time)
  const right = points[Math.max(1, index)]
  const left = points[Math.max(0, index - 1)]
  const span = Math.max(.0001, right.time - left.time)
  const p = ease(left.easing, (time - left.time) / span)
  return {
    x: left.x + (right.x - left.x) * p,
    y: left.y + (right.y - left.y) * p,
    width: left.width + (right.width - left.width) * p,
    height: left.height + (right.height - left.height) * p,
  }
}

function timelineTime() {
  const raw = Number(document.documentElement.dataset.maghrabiFrameClockTime)
  return Number.isFinite(raw) ? raw : 0
}

function normalizedPlayhead(meta: ClipMeta | null) {
  if (!meta) return 0
  return clamp((timelineTime() - meta.startAt) / Math.max(.01, meta.duration), 0, 1)
}

function programSurface() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]')?.querySelector<HTMLElement>('.aspect-video') || null
}

function programVideo() {
  return programSurface()?.querySelector<HTMLVideoElement>(':scope > video:not([controls])') || null
}

function maskPath(ctx: CanvasRenderingContext2D, geom: Geometry, width: number, height: number, shape: MaskShape) {
  const x = geom.x * width
  const y = geom.y * height
  const w = geom.width * width
  const h = geom.height * height
  ctx.beginPath()
  if (shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
  else ctx.rect(x, y, w, h)
}

function patchSignature(data: ImageData, x: number, y: number, width: number, height: number) {
  const cols = 16
  const rows = 12
  const out = new Uint8Array(cols * rows)
  const left = Math.round(x * data.width)
  const top = Math.round(y * data.height)
  const boxW = Math.max(2, Math.round(width * data.width))
  const boxH = Math.max(2, Math.round(height * data.height))
  let cursor = 0
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const px = clamp(Math.round(left + (col + .5) / cols * boxW), 0, data.width - 1)
      const py = clamp(Math.round(top + (row + .5) / rows * boxH), 0, data.height - 1)
      const offset = (py * data.width + px) * 4
      out[cursor++] = Math.round(data.data[offset] * .299 + data.data[offset + 1] * .587 + data.data[offset + 2] * .114)
    }
  }
  return out
}

function signatureScore(a: Uint8Array, b: Uint8Array) {
  let sum = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) sum += Math.abs(a[i] - b[i])
  return sum / Math.max(1, length)
}

async function seekVideo(video: HTMLVideoElement, time: number) {
  if (video.readyState >= 2 && Math.abs(video.currentTime - time) < .012) return
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('تعذر قراءة إطار أثناء التتبع.')) }, 3500)
    const cleanup = () => {
      window.clearTimeout(timer)
      video.removeEventListener('seeked', done)
      video.removeEventListener('error', failed)
    }
    const done = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error('تعذر قراءة الفيديو للتتبع.')) }
    video.addEventListener('seeked', done, { once: true })
    video.addEventListener('error', failed, { once: true })
    video.currentTime = clamp(time, 0, Math.max(0, video.duration - .01))
  })
}

async function autoTrackFile(file: File, clip: VideoClip, draft: MaskDraft) {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('انتهت مهلة تحميل الفيديو للتتبع.')), 5000)
      video.onloadeddata = () => { window.clearTimeout(timer); resolve() }
      video.onerror = () => { window.clearTimeout(timer); reject(new Error('تعذر تحميل الفيديو للتتبع.')) }
      video.load()
    })
    const canvas = document.createElement('canvas')
    canvas.width = 192
    canvas.height = 108
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas غير متاح للتتبع.')
    const sourceDuration = Math.max(.05, clip.end - clip.start)
    const steps = 14
    const points: TrackingPoint[] = []
    let x = draft.x
    let y = draft.y
    let template: Uint8Array | null = null

    for (let index = 0; index < steps; index += 1) {
      const t = index / (steps - 1)
      await seekVideo(video, clip.start + sourceDuration * t)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
      if (!template) {
        template = patchSignature(frame, x, y, draft.width, draft.height)
      } else {
        let bestX = x
        let bestY = y
        let bestScore = Number.POSITIVE_INFINITY
        const radius = .075
        for (let row = -4; row <= 4; row += 1) {
          for (let col = -4; col <= 4; col += 1) {
            const candidateX = clamp(x + col * radius / 4, 0, 1 - draft.width)
            const candidateY = clamp(y + row * radius / 4, 0, 1 - draft.height)
            const candidate = patchSignature(frame, candidateX, candidateY, draft.width, draft.height)
            const score = signatureScore(template, candidate)
            if (score < bestScore) {
              bestScore = score
              bestX = candidateX
              bestY = candidateY
            }
          }
        }
        x = bestX
        y = bestY
        template = patchSignature(frame, x, y, draft.width, draft.height)
      }
      points.push({ time: t, x, y, width: draft.width, height: draft.height, easing: 'ease-in-out' })
    }
    return points
  } finally {
    video.pause()
    video.removeAttribute('src')
    URL.revokeObjectURL(url)
  }
}

export default function StudioEffectsMasksPro() {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<ClipRef | null>(null)
  const [meta, setMeta] = useState<ClipMeta | null>(null)
  const [draft, setDraft] = useState<MaskDraft>(() => ({ ...DEFAULT_DRAFT, points: [] }))
  const [programTarget, setProgramTarget] = useState<HTMLElement | null>(null)
  const [previewGeometry, setPreviewGeometry] = useState<Geometry>(DEFAULT_DRAFT)
  const [busy, setBusy] = useState(false)
  const [trackingBusy, setTrackingBusy] = useState(false)
  const [message, setMessage] = useState('')
  const draftRef = useRef(draft)
  const metaRef = useRef(meta)

  useEffect(() => { draftRef.current = draft }, [draft])
  useEffect(() => { metaRef.current = meta }, [meta])

  const announce = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((value) => value === text ? '' : value), 2600)
  }

  const refreshFromProject = async (ref: ClipRef | null) => {
    if (!ref) {
      setMeta(null)
      setDraft({ ...DEFAULT_DRAFT, points: [] })
      return
    }
    const projectId = getActiveStudioProjectId()
    if (!projectId) return
    const snapshot = await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null)
    const clip = snapshot ? findClip(snapshot.project || {}, ref) : null
    if (!clip) return
    const duration = Math.max(.02, (clip.end - clip.start) / Math.max(.25, Number(clip.speed) || 1))
    setMeta({ ...ref, id: clip.id, sourceStart: clip.start, sourceEnd: clip.end, speed: clip.speed, duration })
    setDraft(draftFromClip(clip))
  }

  useEffect(() => {
    let lastSignature = ''
    const refresh = () => {
      setProgramTarget(programSurface())
      const next = selectedVideoRef()
      const signature = next?.signature || ''
      if (signature === lastSignature) return
      lastSignature = signature
      setSelected(next)
      void refreshFromProject(next)
    }
    const timer = window.setInterval(refresh, 180)
    const observer = new MutationObserver(refresh)
    observer.observe(document.body, { childList: true, subtree: true })
    refresh()
    return () => { window.clearInterval(timer); observer.disconnect() }
  }, [])

  useEffect(() => {
    const onOpen = () => {
      const next = selectedVideoRef()
      setSelected(next)
      void refreshFromProject(next)
      setOpen(true)
    }
    window.addEventListener('maghrabi-open-mask-suite', onOpen)
    return () => window.removeEventListener('maghrabi-open-mask-suite', onOpen)
  }, [])

  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => {
      const current = draftRef.current
      const currentMeta = metaRef.current
      setPreviewGeometry(geometryAt(current, normalizedPlayhead(currentMeta)))
    }, 70)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open || !programTarget || draft.effect === 'none') return
    const canvas = document.createElement('canvas')
    canvas.className = 'maghrabi-mask-preview-canvas'
    programTarget.appendChild(canvas)
    let frame = 0
    let disposed = false
    const pixel = document.createElement('canvas')
    const pixelCtx = pixel.getContext('2d')

    const tick = () => {
      if (disposed) return
      const video = programVideo()
      const current = draftRef.current
      const currentMeta = metaRef.current
      const rect = programTarget.getBoundingClientRect()
      const width = Math.max(2, Math.round(rect.width))
      const height = Math.max(2, Math.round(rect.height))
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.clearRect(0, 0, width, height)
        if (video && video.readyState >= 2 && current.effect !== 'none') {
          const geom = geometryAt(current, normalizedPlayhead(currentMeta))
          if (current.effect === 'spotlight') {
            ctx.fillStyle = `rgba(0,0,0,${.28 + current.intensity * .46})`
            ctx.fillRect(0, 0, width, height)
            ctx.save()
            ctx.globalCompositeOperation = 'destination-out'
            maskPath(ctx, geom, width, height, current.shape)
            ctx.fill()
            ctx.restore()
          } else if (current.effect === 'background-blur') {
            ctx.save()
            ctx.filter = `blur(${Math.round(4 + current.intensity * 22)}px)`
            ctx.drawImage(video, 0, 0, width, height)
            ctx.restore()
            ctx.save()
            ctx.globalCompositeOperation = 'destination-out'
            maskPath(ctx, geom, width, height, current.shape)
            ctx.fill()
            ctx.restore()
          } else {
            ctx.save()
            maskPath(ctx, geom, width, height, current.shape)
            ctx.clip()
            if (current.effect === 'blur') {
              ctx.filter = `blur(${Math.round(3 + current.intensity * 18)}px)`
              ctx.drawImage(video, 0, 0, width, height)
            } else if (pixelCtx) {
              const divisor = Math.max(8, Math.round(10 + current.intensity * 24))
              pixel.width = Math.max(2, Math.round(width / divisor))
              pixel.height = Math.max(2, Math.round(height / divisor))
              pixelCtx.imageSmoothingEnabled = false
              pixelCtx.drawImage(video, 0, 0, pixel.width, pixel.height)
              ctx.imageSmoothingEnabled = false
              ctx.drawImage(pixel, 0, 0, pixel.width, pixel.height, 0, 0, width, height)
            }
            ctx.restore()
          }
        }
      }
      frame = window.requestAnimationFrame(tick)
    }
    tick()
    return () => { disposed = true; window.cancelAnimationFrame(frame); canvas.remove() }
  }, [open, programTarget, draft.effect])

  const persist = async (reset = false) => {
    if (!selected || busy) return
    const projectId = getActiveStudioProjectId()
    if (!projectId) return
    setBusy(true)
    try {
      const snapshot = await flushEditorSave(projectId)
      if (!snapshot) throw new Error('لا يوجد مشروع محفوظ للتحديث.')
      const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
      project.clips = Array.isArray(project.clips) ? project.clips : []
      const clip = findClip(project, selected)
      if (!clip || Math.abs(clip.startAt - selected.startAt) > .75) throw new Error('تعذر مطابقة Clip المحدد.')
      if (reset) {
        clip.privacyEffect = 'none'
        clip.privacyTrackingEnabled = false
        clip.privacyTrackingPoints = []
        clip.privacyMaskShape = 'rect'
        clip.privacyFeather = 0
      } else {
        clip.privacyEffect = draft.effect
        clip.privacyMaskShape = draft.shape
        clip.privacyX = clamp(draft.x, 0, 1 - draft.width)
        clip.privacyY = clamp(draft.y, 0, 1 - draft.height)
        clip.privacyWidth = clamp(draft.width, .03, 1)
        clip.privacyHeight = clamp(draft.height, .03, 1)
        clip.privacyIntensity = clamp(draft.intensity, .05, 1)
        clip.privacyFeather = clamp(draft.feather, 0, .12)
        clip.privacyTrackingEnabled = draft.trackingEnabled
        clip.privacyTrackingPoints = draft.points.slice(0, MAX_TRACK_POINTS)
        clip.chromaEnabled = draft.chromaEnabled
        clip.chromaColor = draft.chromaColor
        clip.chromaBackground = draft.chromaBackground
        clip.chromaSimilarity = clamp(draft.chromaSimilarity, .01, 1)
        clip.chromaBlend = clamp(draft.chromaBlend, 0, 1)
      }
      const next: StoredVideoProject<ProjectShape> = { ...snapshot, project, savedAt: new Date().toISOString() }
      await saveStoredVideoProject(next, projectId)
      window.dispatchEvent(new CustomEvent('maghrabi-mask-tracking-changed', { detail: { projectId, clipId: clip.id } }))
      window.setTimeout(clickRestore, 70)
      announce(reset ? 'تمت إزالة Mask وTracking من Clip المحدد' : 'تم حفظ Mask / Tracking / Chroma في المشروع')
      if (reset) setDraft({ ...DEFAULT_DRAFT, points: [] })
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر حفظ إعدادات Mask.')
    } finally {
      setBusy(false)
    }
  }

  const updateGeometryAtCurrentTime = (geometry: Geometry) => {
    setDraft((current) => {
      const safe = {
        width: clamp(geometry.width, .03, 1),
        height: clamp(geometry.height, .03, 1),
        x: 0,
        y: 0,
      }
      safe.x = clamp(geometry.x, 0, 1 - safe.width)
      safe.y = clamp(geometry.y, 0, 1 - safe.height)
      if (!current.trackingEnabled) return { ...current, ...safe }
      const time = normalizedPlayhead(metaRef.current)
      const nextPoint: TrackingPoint = { time, ...safe, easing: current.easing }
      const points = [...current.points]
      const nearest = points.findIndex((point) => Math.abs(point.time - time) < .035)
      if (nearest >= 0) points[nearest] = nextPoint
      else points.push(nextPoint)
      points.sort((a, b) => a.time - b.time)
      return { ...current, ...safe, points: points.slice(0, MAX_TRACK_POINTS) }
    })
  }

  const startBoxGesture = (mode: 'move' | 'resize', event: ReactPointerEvent<HTMLElement>) => {
    if (!programTarget) return
    event.preventDefault()
    event.stopPropagation()
    const rect = programTarget.getBoundingClientRect()
    const initial = previewGeometry
    const startX = event.clientX
    const startY = event.clientY
    const onMove = (move: PointerEvent) => {
      const dx = (move.clientX - startX) / Math.max(1, rect.width)
      const dy = (move.clientY - startY) / Math.max(1, rect.height)
      if (mode === 'move') updateGeometryAtCurrentTime({ ...initial, x: initial.x + dx, y: initial.y + dy })
      else updateGeometryAtCurrentTime({ ...initial, width: initial.width + dx, height: initial.height + dy })
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  const addKeyframe = () => {
    if (!meta) return
    const time = normalizedPlayhead(meta)
    setDraft((current) => {
      const point: TrackingPoint = { time, x: current.x, y: current.y, width: current.width, height: current.height, easing: current.easing }
      const points = [...current.points]
      const nearest = points.findIndex((item) => Math.abs(item.time - time) < .025)
      if (nearest >= 0) points[nearest] = point
      else points.push(point)
      points.sort((a, b) => a.time - b.time)
      return { ...current, trackingEnabled: true, points: points.slice(0, MAX_TRACK_POINTS) }
    })
    announce('تمت إضافة/تحديث Tracking Point عند Playhead الحالي')
  }

  const removeNearestPoint = () => {
    const time = normalizedPlayhead(meta)
    setDraft((current) => {
      if (!current.points.length) return current
      let nearest = 0
      for (let i = 1; i < current.points.length; i += 1) if (Math.abs(current.points[i].time - time) < Math.abs(current.points[nearest].time - time)) nearest = i
      return { ...current, points: current.points.filter((_, index) => index !== nearest) }
    })
  }

  const autoTrack = async () => {
    if (!selected || trackingBusy) return
    const projectId = getActiveStudioProjectId()
    if (!projectId) return
    setTrackingBusy(true)
    announce('يتم تحليل حركة العنصر محليًا داخل المتصفح...')
    try {
      const snapshot = await loadStoredVideoProject<ProjectShape>(projectId)
      const clip = snapshot ? findClip(snapshot.project || {}, selected) : null
      if (!snapshot || !clip) throw new Error('تعذر الوصول إلى Clip المحدد.')
      const file = snapshot.videos?.[clip.fileIndex]
      if (!file) throw new Error('ملف الفيديو الأصلي غير متاح للتتبع.')
      const points = await autoTrackFile(file, clip, draftRef.current)
      setDraft((current) => ({ ...current, trackingEnabled: true, points }))
      announce(`Auto Track اكتمل · ${points.length} Tracking Points قابلة للتصحيح يدويًا`)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر تنفيذ Auto Track.')
    } finally {
      setTrackingBusy(false)
    }
  }

  const selectedLabel = useMemo(() => selected ? `${selected.lane} · V${selected.fileIndex + 1}` : 'NO CLIP', [selected])

  const editorOverlay = open && programTarget && selected && draft.effect !== 'none' ? createPortal(
    <div className="maghrabi-mask-editor-layer">
      <div
        className={`maghrabi-mask-editor-box is-${draft.shape}`}
        style={{ left: `${previewGeometry.x * 100}%`, top: `${previewGeometry.y * 100}%`, width: `${previewGeometry.width * 100}%`, height: `${previewGeometry.height * 100}%` }}
        onPointerDown={(event) => startBoxGesture('move', event)}
      >
        <span className="maghrabi-mask-editor-label"><Crosshair size={11} /> {draft.trackingEnabled ? 'TRACKED MASK' : 'MASK'}</span>
        <button type="button" aria-label="Resize mask" className="maghrabi-mask-editor-resize" onPointerDown={(event) => startBoxGesture('resize', event)} />
      </div>
      {draft.trackingEnabled && draft.points.map((point, index) => (
        <span key={`${point.time}-${index}`} className="maghrabi-mask-path-dot" style={{ left: `${(point.x + point.width / 2) * 100}%`, top: `${(point.y + point.height / 2) * 100}%` }} title={`${Math.round(point.time * 100)}%`} />
      ))}
    </div>, programTarget
  ) : null

  return (
    <>
      {editorOverlay}
      <button type="button" className="maghrabi-mask-launcher" onClick={() => { const next = selectedVideoRef(); setSelected(next); void refreshFromProject(next); setOpen(true) }}>
        <Crosshair size={14} /> MASKS / TRACKING
      </button>

      {open && createPortal(
        <div className="maghrabi-mask-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
          <section className="maghrabi-mask-workspace" dir="rtl">
            <header className="maghrabi-mask-head">
              <div>
                <span className="maghrabi-mask-kicker"><WandSparkles size={14} /> EFFECTS / MASKS / TRACKING PRO</span>
                <h2>Mask Compositing & Motion Tracking</h2>
                <p>Rect / Ellipse · Blur · Mosaic · Spotlight · Background Defocus · Local Block Tracking · Chroma Key</p>
              </div>
              <div className="maghrabi-mask-head-actions">
                <span>{selectedLabel}</span>
                <button type="button" onClick={() => setOpen(false)}>×</button>
              </div>
            </header>

            {!selected ? (
              <div className="maghrabi-mask-empty">حدد Video Clip من V1 / V2 / V3 ثم افتح Masks / Tracking.</div>
            ) : (
              <div className="maghrabi-mask-layout">
                <div className="maghrabi-mask-main">
                  <section className="maghrabi-mask-section">
                    <div className="maghrabi-mask-section-title"><Sparkles size={14} /><span>MASK EFFECT</span></div>
                    <div className="maghrabi-mask-effects-grid">
                      {EFFECTS.map((effect) => (
                        <button key={effect.value} type="button" className={draft.effect === effect.value ? 'is-active' : ''} onClick={() => setDraft((current) => ({ ...current, effect: effect.value }))}>
                          <strong>{effect.label}</strong><span>{effect.detail}</span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="maghrabi-mask-section">
                    <div className="maghrabi-mask-section-title"><Move size={14} /><span>GEOMETRY / LIVE PROGRAM EDIT</span></div>
                    <div className="maghrabi-mask-shapes">
                      <button type="button" className={draft.shape === 'rect' ? 'is-active' : ''} onClick={() => setDraft((current) => ({ ...current, shape: 'rect' }))}><Square size={13} /> RECTANGLE</button>
                      <button type="button" className={draft.shape === 'ellipse' ? 'is-active' : ''} onClick={() => setDraft((current) => ({ ...current, shape: 'ellipse' }))}><Circle size={13} /> ELLIPSE</button>
                    </div>
                    <div className="maghrabi-mask-slider-grid">
                      {([
                        ['X', 'x', 0, Math.max(0, 1 - draft.width), .005],
                        ['Y', 'y', 0, Math.max(0, 1 - draft.height), .005],
                        ['WIDTH', 'width', .03, 1, .005],
                        ['HEIGHT', 'height', .03, 1, .005],
                      ] as const).map(([label, key, min, max, step]) => (
                        <label key={key}><span>{label}<b>{Math.round(draft[key] * 100)}%</b></span><input type="range" min={min} max={max} step={step} value={draft[key]} onChange={(event) => updateGeometryAtCurrentTime({ x: draft.x, y: draft.y, width: draft.width, height: draft.height, [key]: Number(event.target.value) })} /></label>
                      ))}
                      <label><span>INTENSITY<b>{Math.round(draft.intensity * 100)}%</b></span><input type="range" min=".05" max="1" step=".01" value={draft.intensity} onChange={(event) => setDraft((current) => ({ ...current, intensity: Number(event.target.value) }))} /></label>
                      <label><span>FEATHER<b>{Math.round(draft.feather * 1000) / 10}%</b></span><input type="range" min="0" max=".12" step=".002" value={draft.feather} onChange={(event) => setDraft((current) => ({ ...current, feather: Number(event.target.value) }))} /></label>
                    </div>
                    <p className="maghrabi-mask-tip">يمكنك سحب الإطار وتغيير حجمه مباشرة فوق Program Monitor. عند تفعيل Tracking يصبح السحب تصحيحًا لمسار الحركة عند Playhead الحالي.</p>
                  </section>

                  <section className="maghrabi-mask-section">
                    <div className="maghrabi-mask-section-title"><Crosshair size={14} /><span>MOTION TRACKING</span></div>
                    <div className="maghrabi-mask-tracking-toolbar">
                      <button type="button" className={draft.trackingEnabled ? 'is-active' : ''} onClick={() => setDraft((current) => ({ ...current, trackingEnabled: !current.trackingEnabled }))}>{draft.trackingEnabled ? <Eye size={13} /> : <EyeOff size={13} />} TRACKING {draft.trackingEnabled ? 'ON' : 'OFF'}</button>
                      <button type="button" disabled={trackingBusy} onClick={() => void autoTrack()}><WandSparkles size={13} /> {trackingBusy ? 'ANALYZING...' : 'AUTO TRACK · BLOCK MATCH'}</button>
                      <button type="button" onClick={addKeyframe}>+ TRACK POINT</button>
                      <button type="button" disabled={!draft.points.length} onClick={removeNearestPoint}><Trash2 size={13} /> NEAREST</button>
                    </div>
                    <div className="maghrabi-mask-easing-row">
                      <span>EASING</span>
                      {(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'] as TrackEasing[]).map((value) => <button key={value} type="button" className={draft.easing === value ? 'is-active' : ''} onClick={() => setDraft((current) => ({ ...current, easing: value }))}>{value}</button>)}
                    </div>
                    <div className="maghrabi-mask-trackline">
                      <span className="maghrabi-mask-playhead-mark" style={{ left: `${normalizedPlayhead(meta) * 100}%` }} />
                      {draft.points.map((point, index) => <button key={`${point.time}-${index}`} type="button" style={{ left: `${point.time * 100}%` }} title={`${Math.round(point.time * 100)}%`} onClick={() => setDraft((current) => ({ ...current, x: point.x, y: point.y, width: point.width, height: point.height }))} />)}
                    </div>
                    <div className="maghrabi-mask-track-meta"><span>{draft.points.length} / {MAX_TRACK_POINTS} points</span><span>Auto Track يعمل محليًا على ملف الفيديو ولا يرفع الإطارات لخدمة خارجية.</span></div>
                  </section>
                </div>

                <aside className="maghrabi-mask-side">
                  <section className="maghrabi-mask-section">
                    <div className="maghrabi-mask-section-title"><Sparkles size={14} /><span>CHROMA KEY / SCREEN</span></div>
                    <button type="button" className={`maghrabi-mask-chroma-toggle ${draft.chromaEnabled ? 'is-active' : ''}`} onClick={() => setDraft((current) => ({ ...current, chromaEnabled: !current.chromaEnabled }))}>{draft.chromaEnabled ? 'CHROMA ENABLED' : 'ENABLE CHROMA'}</button>
                    <label className="maghrabi-mask-color"><span>KEY COLOR</span><input type="color" value={draft.chromaColor} onChange={(event) => setDraft((current) => ({ ...current, chromaColor: event.target.value }))} /></label>
                    <label className="maghrabi-mask-color"><span>BACKGROUND</span><input type="color" value={draft.chromaBackground} onChange={(event) => setDraft((current) => ({ ...current, chromaBackground: event.target.value }))} /></label>
                    <label className="maghrabi-mask-side-slider"><span>SIMILARITY <b>{draft.chromaSimilarity.toFixed(2)}</b></span><input type="range" min=".01" max="1" step=".01" value={draft.chromaSimilarity} onChange={(event) => setDraft((current) => ({ ...current, chromaSimilarity: Number(event.target.value) }))} /></label>
                    <label className="maghrabi-mask-side-slider"><span>EDGE BLEND <b>{draft.chromaBlend.toFixed(2)}</b></span><input type="range" min="0" max="1" step=".01" value={draft.chromaBlend} onChange={(event) => setDraft((current) => ({ ...current, chromaBlend: Number(event.target.value) }))} /></label>
                  </section>

                  <section className="maghrabi-mask-section maghrabi-mask-status">
                    <strong>RENDER PIPELINE</strong>
                    <span>Clip Source</span><i>↓</i><span>Mask / Tracking / Chroma</span><i>↓</i><span>Motion Keyframes</span><i>↓</i><span>Transitions / PIP</span><i>↓</i><span>Color / LUT</span><i>↓</i><span>Titles</span>
                  </section>

                  <div className="maghrabi-mask-actions">
                    <button type="button" className="is-reset" disabled={busy} onClick={() => void persist(true)}><RotateCcw size={14} /> RESET MASK</button>
                    <button type="button" className="is-save" disabled={busy} onClick={() => void persist(false)}><Save size={14} /> {busy ? 'SAVING...' : 'APPLY TO CLIP'}</button>
                  </div>
                </aside>
              </div>
            )}
          </section>
        </div>, document.body
      )}

      {message && <div className="maghrabi-mask-toast" dir="rtl">{message}</div>}
    </>
  )
}
