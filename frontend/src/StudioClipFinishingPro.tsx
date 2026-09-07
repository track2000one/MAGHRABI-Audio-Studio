import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Gauge, RotateCcw, Sparkles, WandSparkles } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import { CREATIVE_LOOKS, loadCreativeSettings, type CreativeLookId } from './lib/creativeProjectSettings'
import type { SpeedRampPreset, VideoFilter } from './lib/videoApi'

const ROOT = '.maghrabi-studio-pro main'

type VideoLane = 'V1' | 'V2' | 'V3'

type VideoClip = {
  id: string
  lane: VideoLane
  fileIndex: number
  startAt: number
  start: number
  end: number
  speed: number
  filter?: VideoFilter
  brightness?: number
  contrast?: number
  saturation?: number
  temperature?: number
  vignette?: number
  speedRamp?: SpeedRampPreset
  clipFinishingLook?: CreativeLookId
  clipFinishingStrength?: number
  [key: string]: unknown
}

type ProjectShape = {
  clips?: VideoClip[]
  [key: string]: unknown
}

type ClipRef = {
  lane: VideoLane
  fileIndex: number
  startAt: number
  signature: string
}

type ClipFinishingState = {
  speed: number
  speedRamp: SpeedRampPreset
  look: CreativeLookId
  strength: number
}

const SPEEDS = [.25, .5, .75, 1, 1.25, 1.5, 2, 4]
const RAMPS: Array<{ value: SpeedRampPreset; label: string; detail: string }> = [
  { value: 'off', label: 'OFF', detail: 'ثابت' },
  { value: 'montage', label: 'MONTAGE', detail: '0.7 → 1.8 → 0.7' },
  { value: 'hero', label: 'HERO', detail: '0.5 → 1 → 2' },
  { value: 'bullet', label: 'BULLET', detail: '1 → 0.35 → 1' },
  { value: 'flash', label: 'FLASH', detail: '2 → 0.5 → 2' },
]

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

function inspectorPanel() {
  const labels = Array.from(document.querySelectorAll<HTMLElement>(`${ROOT} p`))
  const label = labels.find((item) => (item.textContent || '').trim().toUpperCase() === 'INSPECTOR')
  return label?.closest<HTMLElement>('div[class*="rounded-3xl"]') || null
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
  return {
    lane,
    fileIndex,
    startAt,
    signature: `${lane}:${fileIndex}:${startAt.toFixed(3)}`,
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

function findClip(project: ProjectShape, ref: ClipRef) {
  const clips = Array.isArray(project.clips) ? project.clips : []
  const sameLane = clips.filter((clip) => clip.lane === ref.lane)
  const sameFile = sameLane.filter((clip) => clip.fileIndex === ref.fileIndex)
  const candidates = sameFile.length ? sameFile : sameLane
  return candidates.sort((a, b) => Math.abs(a.startAt - ref.startAt) - Math.abs(b.startAt - ref.startAt))[0] || null
}

async function mutateClip(ref: ClipRef, mutator: (clip: VideoClip) => void) {
  const projectId = getActiveStudioProjectId()
  if (!projectId) return false
  const snapshot = await flushEditorSave(projectId)
  if (!snapshot) return false
  const project = JSON.parse(JSON.stringify(snapshot.project || {})) as ProjectShape
  project.clips = Array.isArray(project.clips) ? project.clips : []
  const clip = findClip(project, ref)
  if (!clip || Math.abs(clip.startAt - ref.startAt) > .75) return false
  mutator(clip)
  const next: StoredVideoProject<ProjectShape> = { ...snapshot, project, savedAt: new Date().toISOString() }
  await saveStoredVideoProject(next, projectId)
  window.dispatchEvent(new CustomEvent('maghrabi-clip-finishing-changed', { detail: { projectId, clipId: clip.id } }))
  window.setTimeout(clickRestore, 70)
  return true
}

function finishingState(clip: VideoClip | null): ClipFinishingState {
  return {
    speed: clamp(Number(clip?.speed ?? 1), .25, 4),
    speedRamp: ['off', 'montage', 'hero', 'bullet', 'flash'].includes(String(clip?.speedRamp)) ? clip?.speedRamp as SpeedRampPreset : 'off',
    look: CREATIVE_LOOKS.some((preset) => preset.id === clip?.clipFinishingLook) ? clip?.clipFinishingLook as CreativeLookId : 'none',
    strength: clamp(Number(clip?.clipFinishingStrength ?? .8), 0, 1),
  }
}

export default function StudioClipFinishingPro() {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [selected, setSelected] = useState<ClipRef | null>(null)
  const [current, setCurrent] = useState<ClipFinishingState>(() => finishingState(null))
  const [look, setLook] = useState<CreativeLookId>('clean-studio')
  const [strength, setStrength] = useState(.8)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [creativeRevision, setCreativeRevision] = useState(0)

  const projectId = getActiveStudioProjectId()
  const globalCreative = useMemo(() => loadCreativeSettings(projectId), [projectId, creativeRevision])
  const globalOverride = globalCreative.look !== 'none' || globalCreative.speedRamp !== 'off'

  const announce = (text: string) => {
    setMessage(text)
    window.setTimeout(() => setMessage((value) => value === text ? '' : value), 2200)
  }

  const refreshCurrent = async (ref: ClipRef | null) => {
    if (!ref) {
      setCurrent(finishingState(null))
      return
    }
    const activeProjectId = getActiveStudioProjectId()
    if (!activeProjectId) return
    const snapshot = await loadStoredVideoProject<ProjectShape>(activeProjectId).catch(() => null)
    const clip = snapshot ? findClip(snapshot.project || {}, ref) : null
    const state = finishingState(clip)
    setCurrent(state)
    setLook(state.look === 'none' ? 'clean-studio' : state.look)
    setStrength(state.strength)
  }

  useEffect(() => {
    let lastSignature = ''
    const refresh = () => {
      setTarget(inspectorPanel())
      const next = selectedVideoRef()
      const signature = next?.signature || ''
      if (signature === lastSignature) return
      lastSignature = signature
      setSelected(next)
      void refreshCurrent(next)
    }
    const timer = window.setInterval(refresh, 180)
    const observer = new MutationObserver(refresh)
    observer.observe(document.body, { childList: true, subtree: true })
    refresh()
    return () => {
      window.clearInterval(timer)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    const refresh = () => setCreativeRevision((value) => value + 1)
    window.addEventListener('maghrabi-creative-settings-changed', refresh)
    window.addEventListener('maghrabi-active-project-changed', refresh)
    return () => {
      window.removeEventListener('maghrabi-creative-settings-changed', refresh)
      window.removeEventListener('maghrabi-active-project-changed', refresh)
    }
  }, [])

  const runMutation = async (mutation: (clip: VideoClip) => void, success: string) => {
    if (!selected || busy) return
    setBusy(true)
    try {
      const ok = await mutateClip(selected, mutation)
      if (!ok) throw new Error('تعذر مطابقة المقطع المحدد مع المشروع المحفوظ.')
      announce(success)
      window.setTimeout(() => void refreshCurrent(selectedVideoRef() || selected), 180)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'تعذر حفظ إعدادات المقطع.')
    } finally {
      setBusy(false)
    }
  }

  const setSpeed = (speed: number) => {
    void runMutation((clip) => { clip.speed = clamp(speed, .25, 4) }, `Speed ${speed}x محفوظ لهذا Clip`)
  }

  const setRamp = (speedRamp: SpeedRampPreset) => {
    void runMutation((clip) => { clip.speedRamp = speedRamp }, speedRamp === 'off' ? 'تم إلغاء Speed Ramp لهذا Clip' : `${speedRamp.toUpperCase()} Ramp محفوظ لهذا Clip`)
  }

  const applyLook = () => {
    const preset = CREATIVE_LOOKS.find((item) => item.id === look) || CREATIVE_LOOKS[0]
    void runMutation((clip) => {
      clip.filter = preset.filter
      clip.brightness = clamp(preset.brightness * strength, -.6, .6)
      clip.contrast = clamp(1 + (preset.contrast - 1) * strength, .5, 2)
      clip.saturation = clamp(1 + (preset.saturation - 1) * strength, 0, 3)
      clip.temperature = clamp(preset.temperature * strength, -1, 1)
      clip.vignette = clamp(preset.vignette * strength, 0, 1)
      clip.clipFinishingLook = preset.id
      clip.clipFinishingStrength = strength
    }, `${preset.name} مطبق على Clip المحدد`)
  }

  const reset = () => {
    void runMutation((clip) => {
      clip.speed = 1
      clip.speedRamp = 'off'
      clip.filter = 'none'
      clip.brightness = 0
      clip.contrast = 1
      clip.saturation = 1
      clip.temperature = 0
      clip.vignette = 0
      clip.clipFinishingLook = 'none'
      clip.clipFinishingStrength = .8
    }, 'تمت إعادة Clip إلى إعدادات Finishing المحايدة')
  }

  if (!target) return null

  return createPortal(
    <div className="mt-4 rounded-2xl border border-cyan-300/15 bg-cyan-300/[.025] p-3" dir="rtl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-cyan-200"><WandSparkles className="h-3.5 w-3.5" /><span className="text-[9px] font-black tracking-[.18em]">CLIP FINISHING PRO</span></div>
          <p className="mt-1 text-[8px] leading-4 text-slate-500">Speed · Ramp · Professional Look لكل مقطع بشكل مستقل.</p>
        </div>
        {selected ? <span className="rounded-lg border border-cyan-300/20 bg-cyan-300/[.06] px-2 py-1 text-[8px] font-black text-cyan-100">{selected.lane} · V{selected.fileIndex + 1}</span> : <span className="text-[8px] text-slate-600">حدد Video Clip</span>}
      </div>

      {selected && (
        <>
          <div className="mt-3 border-t border-white/8 pt-3">
            <div className="flex items-center justify-between"><span className="text-[8px] font-black text-slate-400">BASE SPEED</span><span className="inline-flex items-center gap-1 text-[8px] font-black text-cyan-200"><Gauge className="h-3 w-3" />{current.speed.toFixed(2)}x</span></div>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {SPEEDS.map((speed) => <button key={speed} disabled={busy} onClick={() => setSpeed(speed)} className={`rounded-lg border px-2 py-1.5 text-[8px] font-black transition ${Math.abs(current.speed - speed) < .01 ? 'border-cyan-300/45 bg-cyan-300/12 text-cyan-100' : 'border-white/8 bg-black/15 text-slate-400 hover:border-cyan-300/25'}`}>{speed}x</button>)}
            </div>
          </div>

          <div className="mt-3 border-t border-white/8 pt-3">
            <div className="flex items-center justify-between"><span className="text-[8px] font-black text-slate-400">SPEED RAMP · PER CLIP</span><span className="text-[8px] font-black text-violet-200">{current.speedRamp.toUpperCase()}</span></div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {RAMPS.map((ramp) => <button key={ramp.value} disabled={busy} onClick={() => setRamp(ramp.value)} className={`rounded-xl border p-2 text-right transition ${current.speedRamp === ramp.value ? 'border-violet-300/40 bg-violet-300/10' : 'border-white/8 bg-black/15 hover:border-violet-300/20'}`}><span className="block text-[8px] font-black text-slate-200">{ramp.label}</span><span className="mt-1 block text-[7px] text-slate-600">{ramp.detail}</span></button>)}
            </div>
          </div>

          <div className="mt-3 border-t border-white/8 pt-3">
            <div className="flex items-center gap-2"><Sparkles className="h-3.5 w-3.5 text-amber-300" /><span className="text-[8px] font-black text-slate-400">PROFESSIONAL LOOK · PER CLIP</span></div>
            <select value={look} onChange={(event) => setLook(event.target.value as CreativeLookId)} className="mt-2 w-full rounded-xl border border-white/10 bg-[#07101c] px-3 py-2 text-[9px] font-bold text-slate-200 outline-none">
              {CREATIVE_LOOKS.filter((item) => item.id !== 'none').map((preset) => <option key={preset.id} value={preset.id}>{preset.name} — {preset.description}</option>)}
            </select>
            <label className="mt-2 block text-[8px] font-black text-slate-500">LOOK STRENGTH · {Math.round(strength * 100)}%<input type="range" min="0" max="1" step=".05" value={strength} onChange={(event) => setStrength(Number(event.target.value))} className="mt-1 w-full accent-amber-300" /></label>
            <button disabled={busy} onClick={applyLook} className="mt-2 w-full rounded-xl border border-amber-300/25 bg-amber-300/[.07] px-3 py-2 text-[8px] font-black text-amber-100 transition hover:border-amber-300/40 disabled:opacity-40">APPLY LOOK TO SELECTED CLIP</button>
          </div>

          {globalOverride && <div className="mt-3 rounded-xl border border-amber-300/15 bg-amber-300/[.05] px-3 py-2 text-[7px] leading-4 text-amber-100">ملاحظة: Creative Suite يحتوي إعدادًا عامًا فعالًا. الـGlobal Look أو Global Ramp يظل طبقة نهائية مقصودة فوق إعدادات الـClip؛ اجعله OFF/Original إذا أردت اختلاف كل مقطع.</div>}

          <button disabled={busy} onClick={reset} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/8 px-3 py-2 text-[8px] font-black text-slate-400 transition hover:border-white/15 hover:text-slate-200 disabled:opacity-40"><RotateCcw className="h-3 w-3" />RESET CLIP FINISHING</button>
        </>
      )}

      {message && <div className="mt-3 rounded-xl border border-emerald-300/15 bg-emerald-300/[.05] px-3 py-2 text-[8px] font-bold text-emerald-100">{message}</div>}
    </div>,
    target,
  )
}