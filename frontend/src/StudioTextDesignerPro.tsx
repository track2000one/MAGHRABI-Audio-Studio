import { useEffect, useMemo, useState } from 'react'
import { AlignCenter, AlignLeft, AlignRight, Captions, Plus, Sparkles, Trash2, Type, X } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import {
  loadCreativeSettings,
  saveCreativeSettings,
  type CreativeFontPreset,
  type CreativeProjectSettings,
  type CreativeTextAlign,
  type CreativeTextAnimation,
  type CreativeTitle,
} from './lib/creativeProjectSettings'

const FONT_OPTIONS: Array<{ value: CreativeFontPreset; label: string }> = [
  { value: 'sans', label: 'Sans Regular' },
  { value: 'sans-bold', label: 'Sans Bold' },
  { value: 'serif', label: 'Serif' },
  { value: 'serif-bold', label: 'Serif Bold' },
  { value: 'mono', label: 'Mono' },
  { value: 'mono-bold', label: 'Mono Bold' },
]

const ANIMATIONS: Array<{ value: CreativeTextAnimation; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide-up', label: 'Slide Up' },
  { value: 'slide-left', label: 'Slide Left' },
  { value: 'slide-right', label: 'Slide Right' },
  { value: 'pop', label: 'Pop' },
]

const STYLE_PRESETS: Array<{ id: string; label: string; patch: Partial<CreativeTitle> }> = [
  { id: 'cinema', label: 'CINEMATIC', patch: { fontPreset: 'serif-bold', color: '#ffffff', size: 68, x: .5, y: .16, boxColor: '#000000', boxOpacity: .18, boxPadding: 16, borderWidth: 1, borderColor: '#000000', shadowDistance: 5, shadowColor: '#000000', animation: 'fade' } },
  { id: 'lower', label: 'LOWER THIRD', patch: { fontPreset: 'sans-bold', color: '#ffffff', size: 48, x: .08, y: .80, boxColor: '#101827', boxOpacity: .82, boxPadding: 18, borderWidth: 0, shadowDistance: 2, animation: 'slide-right' } },
  { id: 'neon', label: 'NEON', patch: { fontPreset: 'mono-bold', color: '#67e8f9', size: 58, x: .5, y: .50, boxOpacity: 0, borderWidth: 2, borderColor: '#164e63', shadowDistance: 5, shadowColor: '#0891b2', animation: 'pop' } },
  { id: 'clean', label: 'CLEAN', patch: { fontPreset: 'sans-bold', color: '#ffffff', size: 56, x: .5, y: .50, boxOpacity: 0, borderWidth: 0, shadowDistance: 2, shadowColor: '#000000', animation: 'fade' } },
  { id: 'caption', label: 'CAPTION', patch: { fontPreset: 'sans-bold', color: '#ffffff', size: 38, x: .5, y: .90, boxColor: '#000000', boxOpacity: .58, boxPadding: 12, borderWidth: 0, shadowDistance: 1, animation: 'fade' } },
]

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function makeTitle(kind: CreativeTitle['kind']): CreativeTitle {
  const subtitle = kind === 'subtitle'
  return {
    id: `designer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    text: subtitle ? 'اكتب الترجمة هنا' : 'عنوان احترافي جديد',
    startAt: 0,
    endAt: subtitle ? 3 : 4,
    size: subtitle ? 38 : 58,
    position: subtitle ? 'bottom' : 'center',
    color: '#ffffff',
    boxOpacity: subtitle ? .48 : .20,
    fontPreset: 'sans-bold',
    align: 'center',
    x: .5,
    y: subtitle ? .90 : .50,
    boxColor: '#000000',
    boxPadding: subtitle ? 12 : 14,
    borderColor: '#000000',
    borderWidth: subtitle ? 0 : 1,
    shadowColor: '#000000',
    shadowDistance: subtitle ? 2 : 3,
    lineSpacing: 4,
    animation: subtitle ? 'fade' : 'none',
  }
}

function normalizeTitle(title: CreativeTitle): CreativeTitle {
  const position = title.position || 'bottom'
  return {
    ...title,
    fontPreset: title.fontPreset || 'sans-bold',
    align: title.align || 'center',
    x: clamp(Number(title.x ?? .5), 0, 1),
    y: clamp(Number(title.y ?? (position === 'top' ? .08 : position === 'center' ? .5 : .92)), 0, 1),
    boxColor: title.boxColor || '#000000',
    boxPadding: clamp(Number(title.boxPadding ?? 12), 0, 40),
    borderColor: title.borderColor || '#000000',
    borderWidth: clamp(Number(title.borderWidth ?? 0), 0, 10),
    shadowColor: title.shadowColor || '#000000',
    shadowDistance: clamp(Number(title.shadowDistance ?? 2), 0, 14),
    lineSpacing: clamp(Number(title.lineSpacing ?? 4), -10, 40),
    animation: title.animation || 'none',
  }
}

export default function StudioTextDesignerPro() {
  const [projectId, setProjectId] = useState<string | null>(() => getActiveStudioProjectId())
  const [settings, setSettings] = useState<CreativeProjectSettings>(() => loadCreativeSettings(getActiveStudioProjectId()))
  const [selectedId, setSelectedId] = useState<string | null>(() => loadCreativeSettings(getActiveStudioProjectId()).titles[0]?.id || null)
  const [open, setOpen] = useState(false)

  const selected = useMemo(() => settings.titles.find((item) => item.id === selectedId) || null, [settings.titles, selectedId])
  const title = selected ? normalizeTitle(selected) : null

  const persist = (next: CreativeProjectSettings) => {
    setSettings(next)
    saveCreativeSettings(projectId, next)
  }

  const updateTitle = (id: string, patch: Partial<CreativeTitle>) => {
    persist({ ...settings, titles: settings.titles.map((item) => item.id === id ? { ...item, ...patch } : item) })
  }

  const addTitle = (kind: CreativeTitle['kind']) => {
    if (settings.titles.length >= 12) return
    const created = makeTitle(kind)
    persist({ ...settings, titles: [...settings.titles, created] })
    setSelectedId(created.id)
  }

  useEffect(() => {
    const reload = () => {
      const id = getActiveStudioProjectId()
      const next = loadCreativeSettings(id)
      setProjectId(id)
      setSettings(next)
      setSelectedId((current) => next.titles.some((item) => item.id === current) ? current : next.titles[0]?.id || null)
    }
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; settings?: CreativeProjectSettings }>).detail
      if (detail?.projectId && detail.projectId !== getActiveStudioProjectId()) return
      if (detail?.settings) {
        setSettings(detail.settings)
        setSelectedId((current) => detail.settings!.titles.some((item) => item.id === current) ? current : detail.settings!.titles[0]?.id || null)
      } else reload()
    }
    const openDesigner = () => setOpen(true)
    window.addEventListener('maghrabi-active-project-changed', reload)
    window.addEventListener('maghrabi-creative-settings-changed', changed as EventListener)
    window.addEventListener('maghrabi-open-text-designer', openDesigner)
    return () => {
      window.removeEventListener('maghrabi-active-project-changed', reload)
      window.removeEventListener('maghrabi-creative-settings-changed', changed as EventListener)
      window.removeEventListener('maghrabi-open-text-designer', openDesigner)
    }
  }, [])

  return <>
    <button type="button" onClick={() => setOpen(true)} className="fixed bottom-24 left-4 z-[72] inline-flex items-center gap-2 rounded-2xl border border-cyan-300/25 bg-[#07111d]/95 px-3 py-2 text-[9px] font-black tracking-[.12em] text-cyan-100 shadow-2xl backdrop-blur-xl transition hover:border-cyan-300/45" title="Text Designer Pro"><Type className="h-4 w-4" />TEXT DESIGNER</button>

    {open && <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
      <section className="flex h-[min(820px,92vh)] w-[min(1180px,96vw)] overflow-hidden rounded-[28px] border border-cyan-300/20 bg-[#07101b] shadow-2xl" dir="rtl">
        <aside className="w-[290px] shrink-0 border-l border-white/8 bg-black/20 p-4">
          <div className="flex items-start justify-between gap-2"><div><div className="flex items-center gap-2 text-cyan-200"><Type className="h-4 w-4" /><span className="text-[10px] font-black tracking-[.18em]">TEXT DESIGNER PRO</span></div><p className="mt-1 text-[9px] leading-4 text-slate-500">عناوين وترجمة احترافية مرتبطة بالرندر النهائي.</p></div><button onClick={() => setOpen(false)} className="rounded-xl border border-white/10 p-2 text-slate-400 hover:text-white"><X className="h-4 w-4" /></button></div>

          <div className="mt-4 grid grid-cols-2 gap-2"><button onClick={() => addTitle('title')} className="inline-flex items-center justify-center gap-1 rounded-xl border border-cyan-300/20 bg-cyan-300/[.06] px-2 py-2 text-[8px] font-black text-cyan-100"><Plus className="h-3 w-3" />TITLE</button><button onClick={() => addTitle('subtitle')} className="inline-flex items-center justify-center gap-1 rounded-xl border border-violet-300/20 bg-violet-300/[.06] px-2 py-2 text-[8px] font-black text-violet-100"><Plus className="h-3 w-3" />SUBTITLE</button></div>

          <div className="mt-4 max-h-[calc(92vh-180px)] space-y-2 overflow-y-auto pl-1">
            {settings.titles.map((item, index) => <button key={item.id} onClick={() => setSelectedId(item.id)} className={`w-full rounded-2xl border p-3 text-right transition ${item.id === selectedId ? 'border-cyan-300/35 bg-cyan-300/[.08]' : 'border-white/8 bg-white/[.02] hover:border-white/15'}`}><div className="flex items-center justify-between gap-2"><span className="text-[8px] font-black text-slate-500">{item.kind === 'subtitle' ? 'SUBTITLE' : 'TITLE'} {index + 1}</span><span className="text-[7px] text-slate-600">{item.startAt.toFixed(1)}–{item.endAt.toFixed(1)}s</span></div><div className="mt-2 truncate text-[10px] font-bold text-slate-200">{item.text || 'بدون نص'}</div></button>)}
            {!settings.titles.length && <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center"><Captions className="mx-auto h-5 w-5 text-slate-600" /><p className="mt-2 text-[8px] text-slate-600">أضف Title أو Subtitle للبدء.</p></div>}
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto p-5">
          {!title ? <div className="flex h-full items-center justify-center"><div className="text-center text-slate-600"><Type className="mx-auto h-10 w-10" /><p className="mt-3 text-sm font-bold">حدد طبقة نصية أو أنشئ واحدة جديدة.</p></div></div> : <div className="mx-auto max-w-3xl">
            <div className="flex items-center justify-between gap-3"><div><div className="text-[10px] font-black tracking-[.16em] text-cyan-200">{title.kind === 'subtitle' ? 'SUBTITLE DESIGN' : 'TITLE DESIGN'}</div><p className="mt-1 text-[9px] text-slate-500">كل تغيير يُحفظ تلقائيًا ويظهر في Program Monitor.</p></div><button onClick={() => { const next = settings.titles.filter((item) => item.id !== title.id); persist({ ...settings, titles: next }); setSelectedId(next[0]?.id || null) }} className="inline-flex items-center gap-1 rounded-xl border border-rose-300/20 bg-rose-300/[.05] px-3 py-2 text-[8px] font-black text-rose-100"><Trash2 className="h-3 w-3" />DELETE</button></div>

            <div className="mt-5 rounded-3xl border border-white/8 bg-black/15 p-4"><label className="text-[8px] font-black text-slate-500">TEXT<textarea rows={3} value={title.text} onChange={(event) => updateTitle(title.id, { text: event.target.value })} className="mt-2 w-full resize-none rounded-2xl border border-white/10 bg-[#050b13] px-3 py-3 text-sm font-bold text-white outline-none focus:border-cyan-300/35" /></label><div className="mt-3 grid grid-cols-3 gap-2"><label className="text-[8px] font-black text-slate-500">START<input type="number" min="0" step=".1" value={title.startAt} onChange={(event) => updateTitle(title.id, { startAt: Math.max(0, Number(event.target.value) || 0) })} className="mt-1 w-full rounded-xl border border-white/10 bg-[#050b13] px-2 py-2 text-[9px] text-white" /></label><label className="text-[8px] font-black text-slate-500">END<input type="number" min=".1" step=".1" value={title.endAt} onChange={(event) => updateTitle(title.id, { endAt: Math.max(title.startAt + .1, Number(event.target.value) || title.startAt + .1) })} className="mt-1 w-full rounded-xl border border-white/10 bg-[#050b13] px-2 py-2 text-[9px] text-white" /></label><label className="text-[8px] font-black text-slate-500">SIZE<input type="number" min="18" max="140" value={title.size} onChange={(event) => updateTitle(title.id, { size: clamp(Number(event.target.value) || 38, 18, 140) })} className="mt-1 w-full rounded-xl border border-white/10 bg-[#050b13] px-2 py-2 text-[9px] text-white" /></label></div></div>

            <div className="mt-4"><div className="flex items-center gap-2 text-[9px] font-black text-slate-400"><Sparkles className="h-3.5 w-3.5 text-amber-300" />STYLE PRESETS</div><div className="mt-2 grid grid-cols-5 gap-2">{STYLE_PRESETS.map((preset) => <button key={preset.id} onClick={() => updateTitle(title.id, preset.patch)} className="rounded-xl border border-white/8 bg-white/[.025] px-2 py-2 text-[7px] font-black text-slate-300 transition hover:border-amber-300/25 hover:text-amber-100">{preset.label}</button>)}</div></div>

            <div className="mt-4 grid grid-cols-2 gap-4">
              <section className="rounded-3xl border border-white/8 bg-black/15 p-4"><div className="text-[9px] font-black text-cyan-200">TYPOGRAPHY</div><label className="mt-3 block text-[8px] font-black text-slate-500">FONT<select value={title.fontPreset} onChange={(event) => updateTitle(title.id, { fontPreset: event.target.value as CreativeFontPreset })} className="mt-1 w-full rounded-xl border border-white/10 bg-[#050b13] px-2 py-2 text-[9px] text-white">{FONT_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><div className="mt-3 flex gap-2">{(['left', 'center', 'right'] as CreativeTextAlign[]).map((align) => { const Icon = align === 'left' ? AlignLeft : align === 'right' ? AlignRight : AlignCenter; return <button key={align} onClick={() => updateTitle(title.id, { align })} className={`flex-1 rounded-xl border p-2 ${title.align === align ? 'border-cyan-300/35 bg-cyan-300/[.08] text-cyan-100' : 'border-white/8 text-slate-500'}`}><Icon className="mx-auto h-4 w-4" /></button> })}</div><label className="mt-3 block text-[8px] font-black text-slate-500">TEXT COLOR<input type="color" value={title.color} onChange={(event) => updateTitle(title.id, { color: event.target.value })} className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-transparent" /></label><label className="mt-3 block text-[8px] font-black text-slate-500">LINE SPACING · {title.lineSpacing}<input type="range" min="-10" max="40" step="1" value={title.lineSpacing} onChange={(event) => updateTitle(title.id, { lineSpacing: Number(event.target.value) })} className="mt-1 w-full accent-cyan-300" /></label></section>

              <section className="rounded-3xl border border-white/8 bg-black/15 p-4"><div className="text-[9px] font-black text-violet-200">POSITION & MOTION</div><label className="mt-3 block text-[8px] font-black text-slate-500">HORIZONTAL · {Math.round((title.x || 0) * 100)}%<input type="range" min="0" max="1" step=".01" value={title.x} onChange={(event) => updateTitle(title.id, { x: Number(event.target.value) })} className="mt-1 w-full accent-violet-300" /></label><label className="mt-3 block text-[8px] font-black text-slate-500">VERTICAL · {Math.round((title.y || 0) * 100)}%<input type="range" min="0" max="1" step=".01" value={title.y} onChange={(event) => updateTitle(title.id, { y: Number(event.target.value) })} className="mt-1 w-full accent-violet-300" /></label><div className="mt-2 grid grid-cols-3 gap-1.5"><button onClick={() => updateTitle(title.id, { x: .5, y: .08, position: 'top' })} className="rounded-lg border border-white/8 px-2 py-1.5 text-[7px] text-slate-400">TOP</button><button onClick={() => updateTitle(title.id, { x: .5, y: .5, position: 'center' })} className="rounded-lg border border-white/8 px-2 py-1.5 text-[7px] text-slate-400">CENTER</button><button onClick={() => updateTitle(title.id, { x: .5, y: .92, position: 'bottom' })} className="rounded-lg border border-white/8 px-2 py-1.5 text-[7px] text-slate-400">BOTTOM</button></div><label className="mt-3 block text-[8px] font-black text-slate-500">ANIMATION<select value={title.animation} onChange={(event) => updateTitle(title.id, { animation: event.target.value as CreativeTextAnimation })} className="mt-1 w-full rounded-xl border border-white/10 bg-[#050b13] px-2 py-2 text-[9px] text-white">{ANIMATIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></section>

              <section className="rounded-3xl border border-white/8 bg-black/15 p-4"><div className="text-[9px] font-black text-amber-200">BACKGROUND</div><label className="mt-3 block text-[8px] font-black text-slate-500">BOX COLOR<input type="color" value={title.boxColor} onChange={(event) => updateTitle(title.id, { boxColor: event.target.value })} className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-transparent" /></label><label className="mt-3 block text-[8px] font-black text-slate-500">OPACITY · {Math.round(title.boxOpacity * 100)}%<input type="range" min="0" max="1" step=".02" value={title.boxOpacity} onChange={(event) => updateTitle(title.id, { boxOpacity: Number(event.target.value) })} className="mt-1 w-full accent-amber-300" /></label><label className="mt-3 block text-[8px] font-black text-slate-500">PADDING · {title.boxPadding}px<input type="range" min="0" max="40" step="1" value={title.boxPadding} onChange={(event) => updateTitle(title.id, { boxPadding: Number(event.target.value) })} className="mt-1 w-full accent-amber-300" /></label></section>

              <section className="rounded-3xl border border-white/8 bg-black/15 p-4"><div className="text-[9px] font-black text-emerald-200">BORDER & SHADOW</div><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-[8px] font-black text-slate-500">BORDER<input type="color" value={title.borderColor} onChange={(event) => updateTitle(title.id, { borderColor: event.target.value })} className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-transparent" /></label><label className="text-[8px] font-black text-slate-500">SHADOW<input type="color" value={title.shadowColor} onChange={(event) => updateTitle(title.id, { shadowColor: event.target.value })} className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-transparent" /></label></div><label className="mt-3 block text-[8px] font-black text-slate-500">BORDER WIDTH · {title.borderWidth}px<input type="range" min="0" max="10" step="1" value={title.borderWidth} onChange={(event) => updateTitle(title.id, { borderWidth: Number(event.target.value) })} className="mt-1 w-full accent-emerald-300" /></label><label className="mt-3 block text-[8px] font-black text-slate-500">SHADOW DISTANCE · {title.shadowDistance}px<input type="range" min="0" max="14" step="1" value={title.shadowDistance} onChange={(event) => updateTitle(title.id, { shadowDistance: Number(event.target.value) })} className="mt-1 w-full accent-emerald-300" /></label></section>
            </div>
          </div>}
        </main>
      </section>
    </div>}
  </>
}