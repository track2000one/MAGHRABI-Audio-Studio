import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Diamond, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'

const ROOT = '.maghrabi-studio-pro main'
const MAX_KEYFRAMES = 20

type Lane = 'V1' | 'V2' | 'V3'
type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold'

type MotionKeyframe = {
  time: number
  zoom: number
  panX: number
  panY: number
  rotation: number
  opacity: number
  easing: Easing
}

type VideoClip = {
  id: string
  lane: Lane
  fileIndex: number
  startAt: number
  start: number
  end: number
  speed: number
  transformKeyframes?: MotionKeyframe[]
  [key: string]: unknown
}

type ProjectShape = { clips?: VideoClip[]; [key: string]: unknown }

type ClipRef = {
  lane: Lane
  fileIndex: number
  startAt: number
  duration: number
  signature: string
}

const EMPTY: MotionKeyframe = { time: 0, zoom: 1, panX: 0, panY: 0, rotation: 0, opacity: 1, easing: 'ease-in-out' }

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
  const text = (button.textContent || '').trim()
  const match = text.match(/^(V[123])\s*·\s*V(\d+)/i)
  if (!match) return null
  const zoom = parseZoom()
  const lane = match[1].toUpperCase() as Lane
  const fileIndex = Math.max(0, Number(match[2]) - 1)
  const startAt = Math.max(0, (Number.parseFloat(button.style.left || '0') || 0) / zoom)
  const dataDuration = Number(button.dataset.maghrabiDuration)
  const duration = Number.isFinite(dataDuration) && dataDuration > .01
    ? dataDuration
    : Math.max(.05, (Number.parseFloat(button.style.width || '0') || button.getBoundingClientRect().width || 1) / zoom)
  return { lane, fileIndex, startAt, duration, signature: `${lane}:${fileIndex}:${startAt.toFixed(3)}:${duration.toFixed(3)}` }
}

function inspectorPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'INSPECTOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
}

function programVideo() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'PROGRAM MONITOR')
  const panel = label?.closest<HTMLElement>('div[class*="rounded-3xl"]')
  return panel?.querySelector<HTMLVideoElement>('.aspect-video > video:not([controls])') || null
}

function frameClockTime() {
  const value = Number(document.documentElement.dataset.maghrabiFrameClockTime)
  return Number.isFinite(value) ? Math.max(0, value) : 0
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
    timer = window.setTimeout(finish, 1600)
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

function sanitizePoint(raw: Partial<MotionKeyframe>): MotionKeyframe {
  const easing = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'].includes(String(raw.easing)) ? raw.easing as Easing : 'linear'
  return {
    time: clamp(Number(raw.time ?? 0), 0, 1),
    zoom: clamp(Number(raw.zoom ?? 1), 1, 4),
    panX: clamp(Number(raw.panX ?? 0), -1, 1),
    panY: clamp(Number(raw.panY ?? 0), -1, 1),
    rotation: clamp(Number(raw.rotation ?? 0), -360, 360),
    opacity: clamp(Number(raw.opacity ?? 1), 0, 1),
    easing,
  }
}

function ease(kind: Easing, t: number) {
  const p = clamp(t, 0, 1)
  if (kind === 'ease-in') return p * p
  if (kind === 'ease-out') return 1 - (1 - p) * (1 - p)
  if (kind === 'ease-in-out') return p < .5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2
  if (kind === 'hold') return 0
  return p
}

function interpolate(points: MotionKeyframe[], time: number): MotionKeyframe {
  if (!points.length) return { ...EMPTY, time }
  const sorted = points.slice().sort((a, b) => a.time - b.time)
  if (time <= sorted[0].time) return { ...sorted[0], time }
  if (time >= sorted[sorted.length - 1].time) return { ...sorted[sorted.length - 1], time }
  const index = sorted.findIndex((point) => point.time >= time)
  const a = sorted[index - 1]
  const b = sorted[index]
  const p = ease(a.easing, (time - a.time) / Math.max(.0001, b.time - a.time))
  return {
    time,
    zoom: a.zoom + (b.zoom - a.zoom) * p,
    panX: a.panX + (b.panX - a.panX) * p,
    panY: a.panY + (b.panY - a.panY) * p,
    rotation: a.rotation + (b.rotation - a.rotation) * p,
    opacity: a.opacity + (b.opacity - a.opacity) * p,
    easing: a.easing,
  }
}

async function savePoints(ref: ClipRef, points: MotionKeyframe[]) {
  const projectId = getActiveStudioProjectId()
  if (!projectId) return false
  const snapshot = await flushEditorSave(projectId)
  if (!snapshot) return false
  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  project.clips = Array.isArray(project.clips) ? project.clips : []
  const clip = findClip(project, ref)
  if (!clip || Math.abs(clip.startAt - ref.startAt) > .75) return false
  clip.transformKeyframes = points.slice(0, MAX_KEYFRAMES).map(sanitizePoint).sort((a, b) => a.time - b.time)
  const next: StoredVideoProject<ProjectShape> = { ...snapshot, project, savedAt: new Date().toISOString() }
  await saveStoredVideoProject(next, projectId)
  window.dispatchEvent(new CustomEvent('maghrabi-motion-keyframes-changed', { detail: { projectId, clipId: clip.id } }))
  window.setTimeout(clickRestore, 60)
  return true
}

const PRESETS: Array<{ id: string; label: string; points: MotionKeyframe[] }> = [
  { id: 'push', label: 'CINEMATIC PUSH', points: [{ ...EMPTY, time: 0, zoom: 1 }, { ...EMPTY, time: 1, zoom: 1.28, easing: 'ease-in-out' }] },
  { id: 'ken', label: 'KEN BURNS', points: [{ ...EMPTY, time: 0, zoom: 1.05, panX: -.35, panY: -.12 }, { ...EMPTY, time: 1, zoom: 1.35, panX: .32, panY: .15, easing: 'ease-in-out' }] },
  { id: 'impact', label: 'IMPACT', points: [{ ...EMPTY, time: 0, zoom: 1 }, { ...EMPTY, time: .45, zoom: 1.6, rotation: -2, easing: 'ease-out' }, { ...EMPTY, time: 1, zoom: 1.1, rotation: 0, easing: 'ease-in-out' }] },
  { id: 'fade', label: 'FADE MOTION', points: [{ ...EMPTY, time: 0, opacity: 0, zoom: 1.08, panY: .18 }, { ...EMPTY, time: .18, opacity: 1, zoom: 1, panY: 0, easing: 'ease-out' }, { ...EMPTY, time: .82, opacity: 1 }, { ...EMPTY, time: 1, opacity: 0, panY: -.12, easing: 'ease-in' }] },
]

export default function StudioKeyframeEditorPro() {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [selected, setSelected] = useState<ClipRef | null>(null)
  const [points, setPoints] = useState<MotionKeyframe[]>([])
  const [draft, setDraft] = useState<MotionKeyframe>({ ...EMPTY })
  const [playhead, setPlayhead] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const normalizedTime = selected ? clamp((playhead - selected.startAt) / Math.max(.05, selected.duration), 0, 1) : 0
  const nearestIndex = useMemo(() => {
    if (!points.length) return -1
    let best = -1
    let distance = Number.POSITIVE_INFINITY
    points.forEach((point, index) => {
      const d = Math.abs(point.time - normalizedTime)
      if (d < distance) { distance = d; best = index }
    })
    return distance <= .02 ? best : -1
  }, [points, normalizedTime])

  const announce = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((value) => value === text ? '' : value), 2200)
  }

  const loadClip = async (ref: ClipRef | null) => {
    if (!ref) { setPoints([]); return }
    const projectId = getActiveStudioProjectId()
    if (!projectId) return
    const snapshot = await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null)
    const clip = snapshot ? findClip(snapshot.project || {}, ref) : null
    const nextPoints = Array.isArray(clip?.transformKeyframes) ? clip!.transformKeyframes!.map(sanitizePoint).sort((a, b) => a.time - b.time) : []
    setPoints(nextPoints)
    setDraft(interpolate(nextPoints, clamp((frameClockTime() - ref.startAt) / Math.max(.05, ref.duration), 0, 1)))
  }

  useEffect(() => {
    let signature = ''
    const refresh = () => {
      setTarget(inspectorPanel())
      const ref = selectedVideoRef()
      const nextSignature = ref?.signature || ''
      if (nextSignature !== signature) {
        signature = nextSignature
        setSelected(ref)
        void loadClip(ref)
      }
      setPlayhead(frameClockTime())
    }
    const timer = window.setInterval(refresh, 100)
    const observer = new MutationObserver(refresh)
    observer.observe(document.body, { childList: true, subtree: true })
    refresh()
    return () => { window.clearInterval(timer); observer.disconnect() }
  }, [])

  useEffect(() => {
    const point = nearestIndex >= 0 ? points[nearestIndex] : interpolate(points, normalizedTime)
    setDraft((current) => ({ ...point, time: normalizedTime, easing: nearestIndex >= 0 ? point.easing : current.easing }))
  }, [normalizedTime, nearestIndex, points])

  useEffect(() => {
    const video = programVideo()
    if (!video || !selected || playhead < selected.startAt || playhead > selected.startAt + selected.duration) {
      if (video) { video.style.transform = ''; video.style.opacity = '' }
      return
    }
    const motion = interpolate(points, normalizedTime)
    video.style.transformOrigin = '50% 50%'
    video.style.transition = 'transform 70ms linear, opacity 70ms linear'
    video.style.transform = `translate(${motion.panX * 18}%, ${motion.panY * 18}%) scale(${motion.zoom}) rotate(${motion.rotation}deg)`
    video.style.opacity = String(clamp(motion.opacity, 0, 1))
    return () => { video.style.transform = ''; video.style.opacity = '' }
  }, [points, normalizedTime, selected, playhead])

  const commit = async (next: MotionKeyframe[], success: string) => {
    if (!selected || busy) return
    setBusy(true)
    try {
      const ok = await savePoints(selected, next)
      if (!ok) throw new Error('تعذر مطابقة Clip المحدد مع المشروع المحفوظ.')
      setPoints(next.slice().sort((a, b) => a.time - b.time))
      announce(success)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر حفظ Keyframes.')
    } finally {
      setBusy(false)
    }
  }

  const addOrUpdate = () => {
    const point = sanitizePoint({ ...draft, time: normalizedTime })
    const next = points.slice()
    const existing = next.findIndex((item) => Math.abs(item.time - normalizedTime) <= .02)
    if (existing >= 0) next[existing] = point
    else if (next.length < MAX_KEYFRAMES) next.push(point)
    else return announce(`الحد الأعلى ${MAX_KEYFRAMES} Keyframes لكل Clip`)
    void commit(next, existing >= 0 ? 'تم تحديث Keyframe عند موضع التشغيل' : 'تمت إضافة Keyframe عند موضع التشغيل')
  }

  const removeNearest = () => {
    if (nearestIndex < 0) return announce('حرّك Playhead بالقرب من Keyframe لحذفه')
    const next = points.filter((_, index) => index !== nearestIndex)
    void commit(next, 'تم حذف Keyframe')
  }

  const applyPreset = (preset: typeof PRESETS[number]) => {
    void commit(preset.points.map((point) => ({ ...point })), `${preset.label} مطبق على Clip`)
  }

  if (!target) return null

  return createPortal(
    <div className="mt-4 rounded-2xl border border-violet-300/15 bg-violet-300/[.025] p-3" dir="rtl">
      <div className="flex items-start justify-between gap-2">
        <div><div className="flex items-center gap-2 text-violet-200"><Diamond className="h-3.5 w-3.5" /><span className="text-[9px] font-black tracking-[.18em]">MOTION KEYFRAMES PRO</span></div><p className="mt-1 text-[8px] leading-4 text-slate-500">Zoom · Pan · Rotation · Opacity · Easing مع Live Preview.</p></div>
        <span className="rounded-lg border border-violet-300/15 px-2 py-1 text-[8px] font-black text-violet-100">{points.length}/{MAX_KEYFRAMES}</span>
      </div>

      {!selected ? <div className="mt-3 rounded-xl border border-white/8 bg-black/15 p-3 text-center text-[8px] text-slate-500">حدد Video Clip من Timeline لبدء التحريك.</div> : <>
        <div className="mt-3 rounded-xl border border-white/8 bg-black/15 p-2">
          <div className="flex items-center justify-between text-[8px]"><span className="font-black text-slate-400">PLAYHEAD داخل Clip</span><span className="font-black text-violet-200">{Math.round(normalizedTime * 100)}%</span></div>
          <div className="relative mt-2 h-3 rounded-full bg-white/5">
            {points.map((point, index) => <span key={`${point.time}-${index}`} className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border ${index === nearestIndex ? 'border-amber-200 bg-amber-300' : 'border-violet-200/60 bg-violet-400'}`} style={{ left: `${point.time * 100}%` }} title={`${Math.round(point.time * 100)}%`} />)}
            <span className="absolute top-0 h-3 w-px bg-cyan-300" style={{ left: `${normalizedTime * 100}%` }} />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-[8px] font-black text-slate-500">ZOOM · {draft.zoom.toFixed(2)}x<input type="range" min="1" max="4" step=".02" value={draft.zoom} onChange={(event) => setDraft({ ...draft, zoom: Number(event.target.value) })} className="mt-1 w-full accent-violet-300" /></label>
          <label className="text-[8px] font-black text-slate-500">OPACITY · {Math.round(draft.opacity * 100)}%<input type="range" min="0" max="1" step=".02" value={draft.opacity} onChange={(event) => setDraft({ ...draft, opacity: Number(event.target.value) })} className="mt-1 w-full accent-violet-300" /></label>
          <label className="text-[8px] font-black text-slate-500">PAN X · {draft.panX.toFixed(2)}<input type="range" min="-1" max="1" step=".02" value={draft.panX} onChange={(event) => setDraft({ ...draft, panX: Number(event.target.value) })} className="mt-1 w-full accent-cyan-300" /></label>
          <label className="text-[8px] font-black text-slate-500">PAN Y · {draft.panY.toFixed(2)}<input type="range" min="-1" max="1" step=".02" value={draft.panY} onChange={(event) => setDraft({ ...draft, panY: Number(event.target.value) })} className="mt-1 w-full accent-cyan-300" /></label>
        </div>
        <label className="mt-2 block text-[8px] font-black text-slate-500">ROTATION · {draft.rotation.toFixed(1)}°<input type="range" min="-180" max="180" step="1" value={draft.rotation} onChange={(event) => setDraft({ ...draft, rotation: Number(event.target.value) })} className="mt-1 w-full accent-amber-300" /></label>
        <label className="mt-2 block text-[8px] font-black text-slate-500">EASING<select value={draft.easing} onChange={(event) => setDraft({ ...draft, easing: event.target.value as Easing })} className="mt-1 w-full rounded-xl border border-white/10 bg-[#07101c] px-2 py-2 text-[8px] text-slate-200 outline-none"><option value="linear">Linear</option><option value="ease-in">Ease In</option><option value="ease-out">Ease Out</option><option value="ease-in-out">Ease In Out</option><option value="hold">Hold</option></select></label>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button disabled={busy} onClick={addOrUpdate} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-violet-300/30 bg-violet-300/10 px-2 py-2 text-[8px] font-black text-violet-100 disabled:opacity-40"><Plus className="h-3 w-3" />{nearestIndex >= 0 ? 'UPDATE KEYFRAME' : 'ADD KEYFRAME'}</button>
          <button disabled={busy || nearestIndex < 0} onClick={removeNearest} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-rose-300/20 bg-rose-300/[.06] px-2 py-2 text-[8px] font-black text-rose-100 disabled:opacity-30"><Trash2 className="h-3 w-3" />DELETE</button>
        </div>

        <div className="mt-3 border-t border-white/8 pt-3"><div className="flex items-center gap-1.5 text-[8px] font-black text-slate-500"><Sparkles className="h-3 w-3" />MOTION PRESETS</div><div className="mt-2 grid grid-cols-2 gap-1.5">{PRESETS.map((preset) => <button key={preset.id} disabled={busy} onClick={() => applyPreset(preset)} className="rounded-xl border border-white/8 bg-black/15 px-2 py-2 text-[7px] font-black text-slate-300 hover:border-violet-300/25 disabled:opacity-40">{preset.label}</button>)}</div></div>
        <button disabled={busy || !points.length} onClick={() => void commit([], 'تمت إزالة جميع Motion Keyframes')} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/8 px-2 py-2 text-[8px] font-black text-slate-500 hover:text-slate-200 disabled:opacity-30"><RotateCcw className="h-3 w-3" />RESET MOTION</button>
        {message && <div className="mt-3 rounded-xl border border-emerald-300/15 bg-emerald-300/[.05] px-3 py-2 text-[8px] font-bold text-emerald-100">{message}</div>}
      </>}
    </div>, target,
  )
}