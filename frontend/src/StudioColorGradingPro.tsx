import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Eye, EyeOff, Palette, RefreshCcw, SlidersHorizontal, Sparkles, Upload, X } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import {
  CREATIVE_LOOKS,
  DEFAULT_COLOR_GRADE,
  loadCreativeSettings,
  sanitizeColorGrade,
  saveCreativeSettings,
  type CreativeColorGrade,
  type CreativeProjectSettings,
} from './lib/creativeProjectSettings'

const PRESETS: Array<{ id: string; name: string; description: string; patch: Partial<CreativeColorGrade> }> = [
  { id: 'clean', name: 'CLEAN MASTER', description: 'توازن نظيف مع حدة خفيفة', patch: { enabled: true, exposure: .08, contrast: 1.06, highlights: -.08, shadows: .08, whites: .03, blacks: -.03, saturation: 1.02, vibrance: .08, sharpen: .15 } },
  { id: 'filmic', name: 'FILMIC S-CURVE', description: 'تباين سينمائي مع Roll-off أنعم', patch: { enabled: true, exposure: -.05, contrast: 1.10, highlights: -.18, shadows: .10, whites: -.04, blacks: -.08, saturation: .94, vibrance: .10, curveShadows: -.12, curveMidtones: .04, curveHighlights: .10, vignette: .15 } },
  { id: 'skin', name: 'WARM SKIN', description: 'دفء خفيف للبشرة مع حماية Highlights', patch: { enabled: true, exposure: .10, contrast: 1.03, highlights: -.12, shadows: .06, temperature: .16, tint: .04, saturation: .98, vibrance: .10, gamma: 1.02 } },
  { id: 'night', name: 'NIGHT CONTROL', description: 'ضغط Highlights ورفع الظلال للمشاهد الليلية', patch: { enabled: true, exposure: -.10, contrast: 1.14, highlights: -.25, shadows: .16, blacks: -.10, temperature: -.10, saturation: .92, vibrance: .12, curveShadows: -.08, vignette: .22 } },
  { id: 'commercial', name: 'COMMERCIAL', description: 'وضوح وتباين مناسب للمحتوى الإعلاني', patch: { enabled: true, exposure: .08, contrast: 1.12, highlights: -.06, shadows: .03, whites: .08, blacks: -.05, saturation: 1.06, vibrance: .18, sharpen: .30 } },
]

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function previewFilter(settings: CreativeProjectSettings, bypass = false) {
  if (bypass) return 'none'
  const strength = clamp(settings.lookStrength, 0, 1)
  const look = CREATIVE_LOOKS.find((item) => item.id === settings.look) || CREATIVE_LOOKS[0]
  const grade = sanitizeColorGrade(settings.colorGrade)
  const gradeOn = grade.enabled
  const exposure = gradeOn ? grade.exposure : 0
  const contrastGrade = gradeOn ? grade.contrast : 1
  const saturationGrade = gradeOn ? grade.saturation * (1 + grade.vibrance * .22) : 1
  const hueGrade = gradeOn ? grade.hue : 0
  const temp = (look.temperature * strength) + (gradeOn ? grade.temperature : 0)
  const tint = gradeOn ? grade.tint : 0
  const brightness = Math.max(.25, 1 + look.brightness * strength + exposure * .12 + (gradeOn ? (grade.shadows + grade.whites) * .025 : 0))
  const contrast = Math.max(.35, (1 + (look.contrast - 1) * strength) * contrastGrade)
  const saturation = Math.max(0, (1 + (look.saturation - 1) * strength) * saturationGrade)
  const sepia = Math.min(.32, Math.max(0, temp) * .24 + Math.abs(tint) * .04)
  const hue = hueGrade - temp * 8 + tint * 4
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturation}) sepia(${sepia}) hue-rotate(${hue}deg)`
}

function programVideo() {
  return Array.from(document.querySelectorAll<HTMLVideoElement>('.maghrabi-studio-pro video:not([controls])'))
    .find((video) => !video.classList.contains('absolute') && video.readyState >= 2) || null
}

function applyPreview(settings: CreativeProjectSettings, bypass = false) {
  const value = previewFilter(settings, bypass)
  document.querySelectorAll<HTMLVideoElement>('.maghrabi-studio-pro video:not([controls])').forEach((video) => {
    video.style.filter = value
    video.style.transition = 'filter 120ms ease'
  })
}

function openMasterLutPicker() {
  const input = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
    .find((item) => (item.accept || '').toLowerCase().includes('.cube'))
  input?.click()
}

function ScopeCanvas({ settings, mode }: { settings: CreativeProjectSettings; mode: 'waveform' | 'vectorscope' }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    const sample = document.createElement('canvas')
    sample.width = 128
    sample.height = 72
    const sctx = sample.getContext('2d', { willReadFrequently: true })
    if (!sctx) return

    const draw = () => {
      const video = programVideo()
      ctx.fillStyle = '#03070c'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      if (!video) {
        ctx.fillStyle = '#475569'
        ctx.font = '10px sans-serif'
        ctx.fillText('NO PROGRAM FRAME', 12, 18)
        return
      }
      try {
        sctx.save()
        sctx.filter = previewFilter(settings)
        sctx.drawImage(video, 0, 0, sample.width, sample.height)
        sctx.restore()
        const pixels = sctx.getImageData(0, 0, sample.width, sample.height).data
        ctx.strokeStyle = 'rgba(148,163,184,.16)'
        ctx.lineWidth = 1
        for (let i = 1; i < 4; i += 1) {
          const y = (canvas.height * i) / 4
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke()
        }

        if (mode === 'waveform') {
          ctx.fillStyle = 'rgba(103,232,249,.20)'
          const columns = new Uint16Array(sample.width * 64)
          for (let y = 0; y < sample.height; y += 1) for (let x = 0; x < sample.width; x += 1) {
            const i = (y * sample.width + x) * 4
            const luma = clamp(Math.round((pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722) / 4), 0, 63)
            columns[x * 64 + luma] += 1
          }
          for (let x = 0; x < sample.width; x += 1) for (let l = 0; l < 64; l += 1) {
            const count = columns[x * 64 + l]
            if (!count) continue
            ctx.globalAlpha = Math.min(.95, .12 + count * .07)
            ctx.fillRect((x / sample.width) * canvas.width, canvas.height - (l / 63) * canvas.height, Math.max(1, canvas.width / sample.width), 1.4)
          }
          ctx.globalAlpha = 1
        } else {
          const cx = canvas.width / 2
          const cy = canvas.height / 2
          const radius = Math.min(canvas.width, canvas.height) * .42
          ctx.strokeStyle = 'rgba(148,163,184,.22)'
          ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke()
          ctx.fillStyle = 'rgba(196,181,253,.20)'
          for (let i = 0; i < pixels.length; i += 16) {
            const r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255
            const u = -.14713 * r - .28886 * g + .436 * b
            const v = .615 * r - .51499 * g - .10001 * b
            ctx.fillRect(cx + u * radius * 2.1, cy - v * radius * 2.1, 1.3, 1.3)
          }
        }
      } catch {
        // The editor uses local object URLs. If a future source becomes tainted,
        // scopes degrade silently instead of interrupting editing or render.
      }
    }

    draw()
    const timer = window.setInterval(draw, 260)
    return () => window.clearInterval(timer)
  }, [settings, mode])

  return <canvas ref={ref} width={300} height={150} className="h-[150px] w-full rounded-2xl border border-white/8 bg-black" />
}

function Slider({ label, value, min, max, step, onChange, suffix = '' }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; suffix?: string }) {
  return <label className="block rounded-2xl border border-white/8 bg-white/[.018] p-3">
    <div className="flex items-center justify-between gap-3"><span className="text-[8px] font-black tracking-[.08em] text-slate-500">{label}</span><span className="font-mono text-[8px] text-cyan-100">{value.toFixed(step < .1 ? 2 : 1)}{suffix}</span></div>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="mt-2 w-full accent-cyan-300" />
  </label>
}

export default function StudioColorGradingPro() {
  const [projectId, setProjectId] = useState<string | null>(() => getActiveStudioProjectId())
  const [settings, setSettings] = useState<CreativeProjectSettings>(() => loadCreativeSettings(getActiveStudioProjectId()))
  const [open, setOpen] = useState(false)
  const [bypass, setBypass] = useState(false)
  const grade = useMemo(() => sanitizeColorGrade(settings.colorGrade), [settings.colorGrade])

  const persistGrade = (patch: Partial<CreativeColorGrade>) => {
    const next: CreativeProjectSettings = { ...settings, colorGrade: sanitizeColorGrade({ ...grade, ...patch }) }
    setSettings(next)
    saveCreativeSettings(projectId, next)
    applyPreview(next, bypass)
  }

  const reset = () => persistGrade({ ...DEFAULT_COLOR_GRADE })

  useEffect(() => {
    const reload = () => {
      const id = getActiveStudioProjectId()
      const next = loadCreativeSettings(id)
      setProjectId(id)
      setSettings(next)
      window.setTimeout(() => applyPreview(next, bypass), 0)
    }
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; settings?: CreativeProjectSettings }>).detail
      if (detail?.projectId && detail.projectId !== getActiveStudioProjectId()) return
      const next = detail?.settings || loadCreativeSettings(getActiveStudioProjectId())
      setSettings(next)
      window.setTimeout(() => applyPreview(next, bypass), 0)
    }
    const openPanel = () => setOpen(true)
    window.addEventListener('maghrabi-active-project-changed', reload)
    window.addEventListener('maghrabi-creative-settings-changed', changed as EventListener)
    window.addEventListener('maghrabi-open-color-grading', openPanel)
    return () => {
      window.removeEventListener('maghrabi-active-project-changed', reload)
      window.removeEventListener('maghrabi-creative-settings-changed', changed as EventListener)
      window.removeEventListener('maghrabi-open-color-grading', openPanel)
    }
  }, [bypass])

  useEffect(() => { applyPreview(settings, bypass) }, [bypass, settings])

  return <>
    <button type="button" onClick={() => setOpen(true)} className="fixed bottom-36 left-4 z-[72] inline-flex items-center gap-2 rounded-2xl border border-violet-300/25 bg-[#07111d]/95 px-3 py-2 text-[9px] font-black tracking-[.12em] text-violet-100 shadow-2xl backdrop-blur-xl transition hover:border-violet-300/45" title="Color Grading Pro"><Palette className="h-4 w-4" />COLOR GRADE</button>

    {open && <div className="fixed inset-0 z-[122] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
      <section className="flex h-[min(900px,94vh)] w-[min(1380px,97vw)] overflow-hidden rounded-[30px] border border-violet-300/20 bg-[#07101a] shadow-2xl" dir="rtl">
        <aside className="w-[315px] shrink-0 overflow-y-auto border-l border-white/8 bg-black/20 p-4">
          <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-violet-200"><SlidersHorizontal className="h-4 w-4" /><span className="text-[10px] font-black tracking-[.16em]">COLOR GRADING PRO</span></div><p className="mt-1 text-[8px] leading-4 text-slate-500">Master grading · LUT · Curves · Scopes · FFmpeg</p></div><button onClick={() => setOpen(false)} className="rounded-xl border border-white/10 p-2 text-slate-400 hover:text-white"><X className="h-4 w-4" /></button></div>

          <div className="mt-4 grid grid-cols-2 gap-2"><button onClick={() => persistGrade({ enabled: !grade.enabled })} className={`rounded-xl border px-3 py-2 text-[8px] font-black ${grade.enabled ? 'border-emerald-300/30 bg-emerald-300/[.08] text-emerald-100' : 'border-white/10 text-slate-400'}`}>{grade.enabled ? 'GRADE ENABLED' : 'GRADE OFF'}</button><button onClick={() => { const next = !bypass; setBypass(next); applyPreview(settings, next) }} className={`inline-flex items-center justify-center gap-1 rounded-xl border px-3 py-2 text-[8px] font-black ${bypass ? 'border-amber-300/30 bg-amber-300/[.08] text-amber-100' : 'border-white/10 text-slate-300'}`}>{bypass ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}{bypass ? 'BEFORE' : 'AFTER'}</button></div>

          <button onClick={openMasterLutPicker} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-violet-300/20 bg-violet-300/[.035] p-3 text-[8px] font-black text-violet-100"><Upload className="h-3.5 w-3.5" />LOAD MASTER LUT · .CUBE</button>

          <div className="mt-5 flex items-center gap-2 text-[8px] font-black text-slate-500"><Sparkles className="h-3.5 w-3.5 text-amber-300" />MASTER PRESETS</div>
          <div className="mt-2 space-y-2">{PRESETS.map((preset) => <button key={preset.id} onClick={() => persistGrade(preset.patch)} className="w-full rounded-2xl border border-white/8 bg-white/[.02] p-3 text-right transition hover:border-violet-300/25"><strong className="block text-[8px] text-slate-200">{preset.name}</strong><small className="mt-1 block text-[7px] leading-3 text-slate-600">{preset.description}</small></button>)}</div>

          <button onClick={reset} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-rose-300/15 px-3 py-2 text-[8px] font-black text-rose-200"><RefreshCcw className="h-3 w-3" />RESET MASTER GRADE</button>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto p-5">
          <div className="grid gap-4 2xl:grid-cols-[1fr_390px]">
            <div className="space-y-4">
              <section className="rounded-3xl border border-white/8 bg-black/15 p-4"><div className="mb-3 flex items-center justify-between"><div><strong className="text-[10px] tracking-[.12em] text-cyan-100">PRIMARY CORRECTION</strong><p className="mt-1 text-[8px] text-slate-600">Exposure · tonal range · white balance</p></div><span className="rounded-lg border border-white/8 px-2 py-1 text-[7px] text-slate-500">MASTER</span></div><div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                <Slider label="EXPOSURE" value={grade.exposure} min={-3} max={3} step={.05} onChange={(value) => persistGrade({ exposure: value, enabled: true })} suffix=" EV" />
                <Slider label="CONTRAST" value={grade.contrast} min={.5} max={2} step={.01} onChange={(value) => persistGrade({ contrast: value, enabled: true })} />
                <Slider label="HIGHLIGHTS" value={grade.highlights} min={-1} max={1} step={.01} onChange={(value) => persistGrade({ highlights: value, enabled: true })} />
                <Slider label="SHADOWS" value={grade.shadows} min={-1} max={1} step={.01} onChange={(value) => persistGrade({ shadows: value, enabled: true })} />
                <Slider label="WHITES" value={grade.whites} min={-1} max={1} step={.01} onChange={(value) => persistGrade({ whites: value, enabled: true })} />
                <Slider label="BLACKS" value={grade.blacks} min={-1} max={1} step={.01} onChange={(value) => persistGrade({ blacks: value, enabled: true })} />
                <Slider label="TEMPERATURE" value={grade.temperature} min={-1} max={1} step={.01} onChange={(value) => persistGrade({ temperature: value, enabled: true })} />
                <Slider label="TINT" value={grade.tint} min={-1} max={1} step={.01} onChange={(value) => persistGrade({ tint: value, enabled: true })} />
                <Slider label="GAMMA" value={grade.gamma} min={.5} max={2} step={.01} onChange={(value) => persistGrade({ gamma: value, enabled: true })} />
              </div></section>

              <section className="rounded-3xl border border-white/8 bg-black/15 p-4"><div className="mb-3"><strong className="text-[10px] tracking-[.12em] text-violet-100">HSL / COLOR INTENSITY</strong><p className="mt-1 text-[8px] text-slate-600">Global hue, saturation and vibrance control</p></div><div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                <Slider label="HUE" value={grade.hue} min={-180} max={180} step={1} onChange={(value) => persistGrade({ hue: value, enabled: true })} suffix="°" />
                <Slider label="SATURATION" value={grade.saturation} min={0} max={2} step={.01} onChange={(value) => persistGrade({ saturation: value, enabled: true })} />
                <Slider label="VIBRANCE" value={grade.vibrance} min={-1} max={1} step={.01} onChange={(value) => persistGrade({ vibrance: value, enabled: true })} />
              </div></section>

              <section className="rounded-3xl border border-white/8 bg-black/15 p-4"><div className="mb-3"><strong className="text-[10px] tracking-[.12em] text-amber-100">LUMA CURVE</strong><p className="mt-1 text-[8px] text-slate-600">Three-zone curve shaping for shadows, midtones and highlights</p></div><div className="grid gap-2 md:grid-cols-3">
                <Slider label="CURVE · SHADOWS" value={grade.curveShadows} min={-1} max={1} step={.01} onChange={(value) => persistGrade({ curveShadows: value, enabled: true })} />
                <Slider label="CURVE · MIDTONES" value={grade.curveMidtones} min={-1} max={1} step={.01} onChange={(value) => persistGrade({ curveMidtones: value, enabled: true })} />
                <Slider label="CURVE · HIGHLIGHTS" value={grade.curveHighlights} min={-1} max={1} step={.01} onChange={(value) => persistGrade({ curveHighlights: value, enabled: true })} />
              </div><div className="mt-3 h-28 rounded-2xl border border-white/8 bg-[linear-gradient(rgba(148,163,184,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,.08)_1px,transparent_1px)] bg-[size:25%_25%] p-3"><svg viewBox="0 0 100 100" className="h-full w-full overflow-visible"><path d={`M 0 ${100-clamp(grade.blacks*8,0,18)} C 18 ${78-grade.curveShadows*14-grade.shadows*8}, 38 ${62-grade.curveMidtones*12}, 50 ${50-grade.curveMidtones*12} S 82 ${22-grade.curveHighlights*14-grade.highlights*8}, 100 ${clamp(-grade.whites*8,0,18)}`} fill="none" stroke="currentColor" strokeWidth="2" className="text-cyan-300" /></svg></div></section>

              <section className="rounded-3xl border border-white/8 bg-black/15 p-4"><div className="mb-3"><strong className="text-[10px] tracking-[.12em] text-emerald-100">FINISHING</strong><p className="mt-1 text-[8px] text-slate-600">Vignette and edge definition after tonal correction</p></div><div className="grid gap-2 md:grid-cols-2">
                <Slider label="VIGNETTE" value={grade.vignette} min={0} max={1} step={.01} onChange={(value) => persistGrade({ vignette: value, enabled: true })} />
                <Slider label="SHARPEN" value={grade.sharpen} min={0} max={1} step={.01} onChange={(value) => persistGrade({ sharpen: value, enabled: true })} />
              </div></section>
            </div>

            <aside className="space-y-4">
              <section className="rounded-3xl border border-cyan-300/10 bg-black/20 p-4"><div className="mb-2 flex items-center gap-2"><Activity className="h-3.5 w-3.5 text-cyan-300" /><strong className="text-[9px] tracking-[.12em] text-slate-300">LUMA WAVEFORM</strong></div><ScopeCanvas settings={settings} mode="waveform" /><div className="mt-2 flex justify-between font-mono text-[7px] text-slate-600"><span>0 IRE</span><span>50</span><span>100 IRE</span></div></section>
              <section className="rounded-3xl border border-violet-300/10 bg-black/20 p-4"><div className="mb-2 flex items-center gap-2"><Activity className="h-3.5 w-3.5 text-violet-300" /><strong className="text-[9px] tracking-[.12em] text-slate-300">VECTORSCOPE</strong></div><ScopeCanvas settings={settings} mode="vectorscope" /><div className="mt-2 text-[7px] leading-4 text-slate-600">Live chroma distribution from the Program Monitor. Scopes sample the current frame without modifying source media.</div></section>
              <section className="rounded-3xl border border-white/8 bg-white/[.02] p-4"><div className="flex items-center gap-2"><Palette className="h-3.5 w-3.5 text-amber-300" /><strong className="text-[9px] text-slate-300">PIPELINE</strong></div><div className="mt-3 space-y-2 text-[7px] font-bold text-slate-500"><div className="rounded-xl border border-white/8 p-2">TIMELINE · TRANSITIONS · PIP</div><div className="text-center text-slate-700">↓</div><div className="rounded-xl border border-violet-300/15 p-2 text-violet-200">MASTER LUT</div><div className="text-center text-slate-700">↓</div><div className="rounded-xl border border-cyan-300/15 p-2 text-cyan-200">COLOR GRADING PRO</div><div className="text-center text-slate-700">↓</div><div className="rounded-xl border border-emerald-300/15 p-2 text-emerald-200">TITLES · SUBTITLES</div></div></section>
            </aside>
          </div>
        </main>
      </section>
    </div>}
  </>
}
