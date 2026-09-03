import { ChangeEvent, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  CirclePause,
  CirclePlay,
  Clock3,
  Download,
  Eye,
  FileJson,
  Film,
  FolderKanban,
  Gauge,
  Layers3,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  Settings2,
  Sparkles,
  Subtitles,
  Trash2,
  UploadCloud,
  Workflow,
  X,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import {
  captionsItemV21,
  createProjectV21,
  createTemplateV21,
  deleteProjectV21,
  deleteTemplateV21,
  getInfoV21,
  InfoV21,
  ItemV21,
  listProjectsV21,
  OverviewV21,
  pauseProjectV21,
  PresetV21,
  ProjectV21,
  reportItemV21,
  resultItemV21,
  resumeProjectV21,
  retryItemV21,
  setPriorityV21,
  sourceItemV21,
  TemplateV21,
  V21Priority,
} from './lib/productionOrchestratorApi'

const statusTone: Record<string, string> = {
  queued: 'border-slate-500/25 bg-slate-500/10 text-slate-300',
  processing: 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200',
  pausing: 'border-amber-300/30 bg-amber-300/10 text-amber-200',
  paused: 'border-amber-300/30 bg-amber-300/10 text-amber-200',
  done: 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200',
  partial: 'border-orange-300/30 bg-orange-300/10 text-orange-200',
  failed: 'border-rose-300/30 bg-rose-300/10 text-rose-200',
  cancelled: 'border-slate-500/30 bg-slate-500/10 text-slate-400',
}

const priorityTone: Record<V21Priority, string> = {
  low: 'text-slate-400',
  normal: 'text-cyan-200',
  high: 'text-amber-200',
  urgent: 'text-rose-200',
}

function fmtBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024).toFixed(0)} KB`
}
function fmtDate(value?: string | null) {
  if (!value) return '—'
  try { return new Date(value).toLocaleString('ar-SA') } catch { return value }
}
function saveBlob(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(href), 1200)
}

function Metric({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return <div className="rounded-2xl border border-white/7 bg-black/20 p-3">
    <p className="text-[8px] font-black tracking-[.18em] text-slate-600">{label}</p>
    <p className="mt-1 text-xl font-black text-slate-100">{value}</p>
    {note && <p className="mt-1 text-[8px] text-slate-600">{note}</p>}
  </div>
}

function defaultTemplate(preset?: PresetV21) {
  return {
    name: preset ? `${preset.label} Custom` : 'Custom Production Template',
    basePreset: preset?.id || 'youtube_creator',
    description: preset?.description || '',
    delivery: preset?.delivery || 'youtube_1080',
    productionAnalysis: preset?.productionAnalysis ?? true,
    highlight: preset?.highlight ?? false,
    stabilize: preset?.stabilize || 'auto',
    dialogue: preset?.dialogue ?? true,
    transcribe: preset?.transcribe ?? false,
    burnCaptions: preset?.burnCaptions ?? false,
    reframe: preset?.reframe || null,
    highlightDuration: preset?.highlightDuration || 45,
    language: 'ar',
    sceneThreshold: .35,
  }
}

export default function VideoStudioV21() {
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [info, setInfo] = useState<InfoV21 | null>(null)
  const [projects, setProjects] = useState<ProjectV21[]>([])
  const [overview, setOverview] = useState<OverviewV21 | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [projectName, setProjectName] = useState('MAGHRABI Production Batch')
  const [preset, setPreset] = useState('youtube_creator')
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [priority, setPriority] = useState<V21Priority>('normal')
  const [language, setLanguage] = useState('ar')
  const [sceneThreshold, setSceneThreshold] = useState(.35)
  const [highlightDuration, setHighlightDuration] = useState(45)
  const [templateDraft, setTemplateDraft] = useState(() => defaultTemplate())
  const [showTemplate, setShowTemplate] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [compareItemId, setCompareItemId] = useState<string | null>(null)
  const [sourceCompareUrl, setSourceCompareUrl] = useState<string | null>(null)
  const [resultCompareUrl, setResultCompareUrl] = useState<string | null>(null)

  const refresh = async (silent = false) => {
    if (!silent) setBusy('refresh')
    try {
      const [meta, listing] = await Promise.all([getInfoV21(), listProjectsV21()])
      setInfo(meta)
      setProjects(listing.projects)
      setOverview(listing.overview)
      if (!selectedProjectId && listing.projects[0]) setSelectedProjectId(listing.projects[0].id)
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'تعذر تحديث Creator V21.')
    } finally { if (!silent) setBusy(null) }
  }

  useEffect(() => {
    getAuthStatus().then(status => setAuthorized(status.authenticated)).catch(() => setAuthorized(false))
    refresh(true).catch(() => undefined)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => refresh(true).catch(() => undefined), 3000)
    return () => window.clearInterval(timer)
  }, [selectedProjectId])

  useEffect(() => () => {
    if (sourceCompareUrl) URL.revokeObjectURL(sourceCompareUrl)
    if (resultCompareUrl) URL.revokeObjectURL(resultCompareUrl)
  }, [sourceCompareUrl, resultCompareUrl])

  const selectedProject = useMemo(() => projects.find(item => item.id === selectedProjectId) || null, [projects, selectedProjectId])
  const selectedPreset = useMemo(() => info?.presets.find(item => item.id === preset), [info, preset])
  const selectedTemplate = useMemo(() => info?.templates.find(item => item.id === templateId) || null, [info, templateId])

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(event.target.files || []).filter(file => file.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(file.name))
    setFiles(current => [...current, ...incoming].slice(0, 20))
    event.target.value = ''
  }

  const choosePreset = (id: string) => {
    setPreset(id)
    setTemplateId(null)
    const found = info?.presets.find(item => item.id === id)
    if (found) {
      setHighlightDuration(found.highlightDuration)
      setTemplateDraft(defaultTemplate(found))
    }
  }

  const chooseTemplate = (template: TemplateV21) => {
    setTemplateId(template.id)
    setPreset(template.basePreset)
    setLanguage(template.language)
    setSceneThreshold(template.sceneThreshold)
    setHighlightDuration(template.config.highlightDuration)
  }

  const createBatch = async () => {
    if (!files.length || busy) return
    setBusy('create'); setError(null)
    try {
      const created = await createProjectV21(files, {
        projectName,
        preset,
        templateId,
        priority,
        language,
        sceneThreshold,
        highlightDuration,
      })
      setFiles([])
      setSelectedProjectId(created.id)
      await refresh(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إنشاء Batch Project.') }
    finally { setBusy(null) }
  }

  const saveTemplate = async () => {
    if (busy || !templateDraft.name.trim()) return
    setBusy('template'); setError(null)
    try {
      const created = await createTemplateV21(templateDraft)
      const meta = await getInfoV21()
      setInfo(meta)
      setTemplateId(created.id)
      setPreset(created.basePreset)
      setShowTemplate(false)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر حفظ Preset Template.') }
    finally { setBusy(null) }
  }

  const removeTemplate = async (id: string) => {
    if (busy) return
    setBusy(`template-delete-${id}`)
    try {
      await deleteTemplateV21(id)
      if (templateId === id) setTemplateId(null)
      setInfo(await getInfoV21())
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر حذف Template.') }
    finally { setBusy(null) }
  }

  const pause = async (project: ProjectV21) => {
    if (busy) return
    setBusy(`pause-${project.id}`)
    try { await pauseProjectV21(project.id); await refresh(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر إيقاف الدفعة مؤقتًا.') }
    finally { setBusy(null) }
  }

  const resume = async (project: ProjectV21) => {
    if (busy) return
    setBusy(`resume-${project.id}`)
    try { await resumeProjectV21(project.id); await refresh(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر استئناف الدفعة.') }
    finally { setBusy(null) }
  }

  const changePriority = async (project: ProjectV21, value: V21Priority) => {
    if (busy) return
    setBusy(`priority-${project.id}`)
    try { await setPriorityV21(project.id, value); await refresh(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تعديل الأولوية.') }
    finally { setBusy(null) }
  }

  const retryItem = async (project: ProjectV21, item: ItemV21) => {
    if (busy) return
    setBusy(`retry-${item.id}`)
    try { await retryItemV21(project.id, item.id); await refresh(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر إعادة العنصر.') }
    finally { setBusy(null) }
  }

  const removeProject = async (project: ProjectV21) => {
    if (busy) return
    setBusy(`delete-${project.id}`)
    try {
      await deleteProjectV21(project.id)
      if (selectedProjectId === project.id) setSelectedProjectId(null)
      await refresh(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر حذف المشروع.') }
    finally { setBusy(null) }
  }

  const downloadResult = async (project: ProjectV21, item: ItemV21) => {
    setBusy(`download-${item.id}`)
    try { saveBlob(await resultItemV21(project.id, item.id), `MAGHRABI-v21-${item.id}.mp4`) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تنزيل النتيجة.') }
    finally { setBusy(null) }
  }
  const downloadReport = async (project: ProjectV21, item: ItemV21) => {
    setBusy(`report-${item.id}`)
    try { saveBlob(await reportItemV21(project.id, item.id), `MAGHRABI-v21-report-${item.id}.json`) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تنزيل التقرير.') }
    finally { setBusy(null) }
  }
  const downloadCaptions = async (project: ProjectV21, item: ItemV21) => {
    setBusy(`captions-${item.id}`)
    try { saveBlob(await captionsItemV21(project.id, item.id), `MAGHRABI-v21-captions-${item.id}.srt`) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تنزيل Captions.') }
    finally { setBusy(null) }
  }

  const compare = async (project: ProjectV21, item: ItemV21) => {
    if (!item.resultReady || busy) return
    setBusy(`compare-${item.id}`); setError(null)
    try {
      const [source, result] = await Promise.all([sourceItemV21(project.id, item.id), resultItemV21(project.id, item.id)])
      if (sourceCompareUrl) URL.revokeObjectURL(sourceCompareUrl)
      if (resultCompareUrl) URL.revokeObjectURL(resultCompareUrl)
      setSourceCompareUrl(URL.createObjectURL(source))
      setResultCompareUrl(URL.createObjectURL(result))
      setCompareItemId(item.id)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر فتح Before/After.') }
    finally { setBusy(null) }
  }

  if (authorized === false) return <div className="min-h-screen bg-[#05080d] p-10 text-center text-slate-300">سجّل الدخول أولًا لفتح Creator V21.</div>
  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#05080d]"><Loader2 className="h-8 w-8 animate-spin text-cyan-300"/></div>

  return <main className="min-h-screen bg-[#05080d] text-slate-100" dir="rtl">
    <header className="border-b border-white/8 bg-[#080d15] px-5 py-4">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-black tracking-[.34em] text-cyan-300">MAGHRABI CREATOR V21</p>
          <h1 className="text-xl font-black">Production Orchestrator · Project Dashboard</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="#video-v20" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-black text-slate-300">V20 PIPELINE</a>
          <a href="#video-v19" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-black text-slate-300">V19 INTELLIGENCE</a>
          <button onClick={() => refresh()} disabled={!!busy} className="rounded-xl border border-cyan-300/25 px-3 py-2 text-xs font-black text-cyan-200"><RefreshCcw className={`ml-1 inline h-4 w-4 ${busy === 'refresh' ? 'animate-spin' : ''}`}/>REFRESH</button>
        </div>
      </div>
    </header>

    <div className="mx-auto max-w-[1800px] space-y-4 p-4">
      <section className="grid gap-2 md:grid-cols-4 xl:grid-cols-8">
        <Metric label="V21 PROJECTS" value={overview?.projects ?? 0}/>
        <Metric label="QUEUED" value={overview?.queued ?? 0}/>
        <Metric label="PROCESSING" value={overview?.processing ?? 0}/>
        <Metric label="PAUSED" value={overview?.paused ?? 0}/>
        <Metric label="DONE" value={overview?.done ?? 0}/>
        <Metric label="PARTIAL" value={overview?.partial ?? 0}/>
        <Metric label="V20 JOBS" value={overview?.legacy.v20Jobs ?? 0}/>
        <Metric label="V12 RENDERS" value={overview?.legacy.v12RenderJobs ?? 0}/>
      </section>

      {error && <div className="flex items-start gap-2 rounded-2xl border border-rose-300/25 bg-rose-300/8 p-3 text-xs text-rose-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0"/><span>{error}</span><button onClick={() => setError(null)} className="mr-auto"><X className="h-4 w-4"/></button></div>}

      <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)_430px]">
        <aside className="space-y-4">
          <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex items-center justify-between"><div className="flex items-center gap-2"><UploadCloud className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">NEW BATCH PROJECT</h2></div><span className="text-[8px] text-slate-600">MAX 20 FILES</span></div>
            <label className="mt-3 block cursor-pointer rounded-2xl border border-dashed border-cyan-300/25 bg-cyan-300/5 p-5 text-center text-xs font-black text-cyan-200"><UploadCloud className="mx-auto mb-2 h-6 w-6"/>ADD VIDEOS<input type="file" multiple accept="video/*" className="hidden" onChange={upload}/></label>
            <div className="mt-2 max-h-36 space-y-1 overflow-auto">
              {files.map((file, index) => <div key={`${file.name}-${file.size}-${index}`} className="flex items-center gap-2 rounded-xl bg-black/25 px-2 py-2 text-[9px]"><Film className="h-3 w-3 text-slate-500"/><span className="min-w-0 flex-1 truncate">{file.name}</span><span className="text-slate-600">{fmtBytes(file.size)}</span><button onClick={() => setFiles(current => current.filter((_, i) => i !== index))}><X className="h-3 w-3 text-rose-300"/></button></div>)}
            </div>
            <label className="mt-3 block text-[8px] font-black text-slate-500">PROJECT NAME<input value={projectName} onChange={e => setProjectName(e.target.value)} className="mt-1 w-full rounded-xl border border-white/8 bg-black/30 p-2.5 text-xs"/></label>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-[8px] font-black text-slate-500">BASE PRESET<select value={preset} onChange={e => choosePreset(e.target.value)} className="mt-1 w-full rounded-xl bg-black/35 p-2 text-[10px] text-slate-200">{info?.presets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <label className="text-[8px] font-black text-slate-500">PRIORITY<select value={priority} onChange={e => setPriority(e.target.value as V21Priority)} className="mt-1 w-full rounded-xl bg-black/35 p-2 text-[10px] text-slate-200">{info?.priorities.map(item => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select></label>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <label className="text-[8px] text-slate-500">LANG<input value={language} onChange={e => setLanguage(e.target.value)} className="mt-1 w-full rounded-lg bg-black/30 p-2 text-[10px]"/></label>
              <label className="text-[8px] text-slate-500">SCENE<input type="number" min=".08" max=".85" step=".01" value={sceneThreshold} onChange={e => setSceneThreshold(Number(e.target.value))} className="mt-1 w-full rounded-lg bg-black/30 p-2 text-[10px]"/></label>
              <label className="text-[8px] text-slate-500">HIGHLIGHT<input type="number" min="5" max="120" value={highlightDuration} onChange={e => setHighlightDuration(Number(e.target.value))} className="mt-1 w-full rounded-lg bg-black/30 p-2 text-[10px]"/></label>
            </div>
            {selectedTemplate && <div className="mt-3 rounded-xl border border-fuchsia-300/20 bg-fuchsia-300/5 p-2 text-[9px] text-fuchsia-200">TEMPLATE · {selectedTemplate.name}<button onClick={() => setTemplateId(null)} className="mr-2 underline">Use base preset instead</button></div>}
            <button disabled={!files.length || !!busy} onClick={createBatch} className="mt-4 w-full rounded-2xl bg-cyan-300 px-4 py-3 text-xs font-black text-slate-950 disabled:opacity-40">{busy === 'create' ? <Loader2 className="ml-1 inline h-4 w-4 animate-spin"/> : <Play className="ml-1 inline h-4 w-4"/>}START BATCH ORCHESTRATION</button>
            <p className="mt-2 text-[8px] leading-4 text-slate-600">Pause لا يقطع FFmpeg في منتصف الملف؛ يكمل العنصر الجاري ثم يتوقف قبل العنصر التالي. الأولوية تطبق بين عناصر الدفعات.</p>
          </section>

          <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Settings2 className="h-4 w-4 text-fuchsia-300"/><h2 className="text-xs font-black">PRESET TEMPLATES</h2></div><button onClick={() => setShowTemplate(value => !value)} className="rounded-lg border border-fuchsia-300/20 px-2 py-1 text-[9px] font-black text-fuchsia-200"><Plus className="ml-1 inline h-3 w-3"/>CUSTOM</button></div>
            {showTemplate && <div className="mt-3 space-y-2 rounded-2xl border border-fuchsia-300/15 bg-fuchsia-300/5 p-3">
              <input value={templateDraft.name} onChange={e => setTemplateDraft(current => ({ ...current, name: e.target.value }))} placeholder="Template name" className="w-full rounded-xl bg-black/30 p-2 text-[10px]"/>
              <div className="grid grid-cols-2 gap-2 text-[8px]">
                <label>BASE<select value={templateDraft.basePreset} onChange={e => { const found = info?.presets.find(p => p.id === e.target.value); setTemplateDraft(defaultTemplate(found)) }} className="mt-1 w-full rounded-lg bg-black/30 p-2">{info?.presets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <label>DELIVERY<select value={templateDraft.delivery} onChange={e => setTemplateDraft(current => ({ ...current, delivery: e.target.value }))} className="mt-1 w-full rounded-lg bg-black/30 p-2">{info?.deliveries.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
                <label>STABILIZE<select value={templateDraft.stabilize} onChange={e => setTemplateDraft(current => ({ ...current, stabilize: e.target.value as 'auto' | 'off' }))} className="mt-1 w-full rounded-lg bg-black/30 p-2"><option value="auto">AUTO</option><option value="off">OFF</option></select></label>
                <label>REFRAME<select value={templateDraft.reframe || 'none'} onChange={e => setTemplateDraft(current => ({ ...current, reframe: e.target.value === 'none' ? null : e.target.value as 'portrait' | 'square' }))} className="mt-1 w-full rounded-lg bg-black/30 p-2"><option value="none">NONE</option><option value="portrait">9:16</option><option value="square">1:1</option></select></label>
              </div>
              <div className="grid grid-cols-2 gap-1 text-[8px] text-slate-300">
                {([
                  ['productionAnalysis', 'Analysis'], ['highlight', 'Highlights'], ['dialogue', 'Dialogue'], ['transcribe', 'STT'], ['burnCaptions', 'Burn Captions'],
                ] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2 rounded-lg bg-black/20 p-2"><input type="checkbox" checked={Boolean(templateDraft[key])} onChange={e => setTemplateDraft(current => ({ ...current, [key]: e.target.checked }))}/>{label}</label>)}
              </div>
              <button onClick={saveTemplate} disabled={!!busy} className="w-full rounded-xl bg-fuchsia-300 px-3 py-2 text-[9px] font-black text-slate-950">SAVE TEMPLATE</button>
            </div>}
            <div className="mt-3 space-y-2">
              {info?.templates.map(template => <div key={template.id} className={`rounded-2xl border p-3 ${templateId === template.id ? 'border-fuchsia-300/35 bg-fuchsia-300/8' : 'border-white/7 bg-black/20'}`}>
                <button onClick={() => chooseTemplate(template)} className="w-full text-right"><p className="text-[10px] font-black text-slate-200">{template.name}</p><p className="mt-1 text-[8px] text-slate-600">{template.basePreset} · {template.config.delivery}</p></button>
                <button onClick={() => removeTemplate(template.id)} className="mt-2 text-[8px] text-rose-300"><Trash2 className="ml-1 inline h-3 w-3"/>DELETE</button>
              </div>)}
              {!info?.templates.length && <p className="py-3 text-center text-[9px] text-slate-700">لا توجد Templates مخصصة بعد.</p>}
            </div>
          </section>
        </aside>

        <section className="space-y-4">
          <div className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><FolderKanban className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">PROJECT QUEUE</h2></div><p className="text-[8px] text-slate-600">URGENT → HIGH → NORMAL → LOW · between batch items</p></div>
            <div className="mt-3 grid gap-2 lg:grid-cols-2">
              {projects.map(project => <button key={project.id} onClick={() => setSelectedProjectId(project.id)} className={`rounded-2xl border p-3 text-right transition ${selectedProjectId === project.id ? 'border-cyan-300/35 bg-cyan-300/7' : 'border-white/7 bg-black/20 hover:border-white/15'}`}>
                <div className="flex items-center justify-between gap-2"><span className="truncate text-[11px] font-black text-slate-200">{project.name}</span><span className={`rounded-lg border px-2 py-1 text-[8px] font-black ${statusTone[project.status] || statusTone.queued}`}>{project.status.toUpperCase()}</span></div>
                <div className="mt-2 flex items-center gap-3 text-[8px] text-slate-500"><span className={priorityTone[project.priority]}>{project.priority.toUpperCase()}</span><span>{project.presetLabel}</span><span>{project.stats.done}/{project.stats.total}</span></div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5"><div className="h-full bg-cyan-300 transition-all" style={{ width: `${project.stats.progress}%` }}/></div>
              </button>)}
              {!projects.length && <div className="col-span-full rounded-2xl border border-dashed border-white/8 p-10 text-center text-xs text-slate-700">أنشئ أول Batch Project من اللوحة اليمنى.</div>}
            </div>
          </div>

          {selectedProject && <div className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><p className="text-[10px] font-black text-slate-200">{selectedProject.name}</p><p className="mt-1 text-[8px] text-slate-600">{selectedProject.templateName || selectedProject.presetLabel} · {fmtDate(selectedProject.createdAt)}</p></div>
              <div className="flex flex-wrap gap-2">
                {selectedProject.status === 'paused' ? <button onClick={() => resume(selectedProject)} className="rounded-xl bg-emerald-300 px-3 py-2 text-[9px] font-black text-slate-950"><CirclePlay className="ml-1 inline h-4 w-4"/>RESUME</button> : !['done','failed','partial'].includes(selectedProject.status) && <button onClick={() => pause(selectedProject)} className="rounded-xl border border-amber-300/25 px-3 py-2 text-[9px] font-black text-amber-200"><CirclePause className="ml-1 inline h-4 w-4"/>PAUSE</button>}
                <select value={selectedProject.priority} onChange={e => changePriority(selectedProject, e.target.value as V21Priority)} className={`rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[9px] font-black ${priorityTone[selectedProject.priority]}`}>{info?.priorities.map(item => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select>
                {!['processing','pausing'].includes(selectedProject.status) && <button onClick={() => removeProject(selectedProject)} className="rounded-xl border border-rose-300/20 px-3 py-2 text-[9px] font-black text-rose-300"><Trash2 className="ml-1 inline h-4 w-4"/>DELETE</button>}
              </div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-4"><Metric label="TOTAL" value={selectedProject.stats.total}/><Metric label="DONE" value={selectedProject.stats.done}/><Metric label="FAILED" value={selectedProject.stats.failed}/><Metric label="PROGRESS" value={`${selectedProject.stats.progress}%`}/></div>
            <div className="mt-4 space-y-2">
              {selectedProject.items.map((item, index) => <div key={item.id} className="rounded-2xl border border-white/7 bg-black/20 p-3">
                <div className="flex flex-wrap items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-lg bg-white/5 text-[8px] font-black text-slate-500">{index + 1}</span><span className="min-w-0 flex-1 truncate text-[10px] font-bold text-slate-200">{item.sourceName}</span><span className="text-[8px] text-slate-600">{fmtBytes(item.sizeBytes)}</span><span className={`rounded-lg border px-2 py-1 text-[8px] font-black ${statusTone[item.status] || statusTone.queued}`}>{item.status.toUpperCase()}</span></div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5"><div className={`h-full transition-all ${item.status === 'failed' ? 'bg-rose-300' : item.status === 'done' ? 'bg-emerald-300' : 'bg-cyan-300'}`} style={{ width: `${Math.max(0, Math.min(100, item.progress))}%` }}/></div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[8px] text-slate-600"><span>{item.stage || 'queued'}</span><span>·</span><span>{item.message || '—'}</span><span className="mr-auto">TRY {item.attempts}</span></div>
                {item.error && <p className="mt-2 rounded-lg bg-rose-300/8 p-2 text-[8px] text-rose-200">{item.error}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {item.resultReady && <><button onClick={() => compare(selectedProject, item)} className="rounded-lg border border-cyan-300/20 px-2 py-1.5 text-[8px] font-black text-cyan-200"><Eye className="ml-1 inline h-3 w-3"/>COMPARE</button><button onClick={() => downloadResult(selectedProject, item)} className="rounded-lg border border-emerald-300/20 px-2 py-1.5 text-[8px] font-black text-emerald-200"><Download className="ml-1 inline h-3 w-3"/>VIDEO</button></>}
                  {item.reportReady && <button onClick={() => downloadReport(selectedProject, item)} className="rounded-lg border border-fuchsia-300/20 px-2 py-1.5 text-[8px] font-black text-fuchsia-200"><FileJson className="ml-1 inline h-3 w-3"/>QC REPORT</button>}
                  {item.captionsReady && <button onClick={() => downloadCaptions(selectedProject, item)} className="rounded-lg border border-violet-300/20 px-2 py-1.5 text-[8px] font-black text-violet-200"><Subtitles className="ml-1 inline h-3 w-3"/>SRT</button>}
                  {item.status === 'failed' && <button onClick={() => retryItem(selectedProject, item)} className="rounded-lg border border-amber-300/20 px-2 py-1.5 text-[8px] font-black text-amber-200"><RotateCcw className="ml-1 inline h-3 w-3"/>RETRY ITEM</button>}
                </div>
              </div>)}
            </div>
          </div>}
        </section>

        <aside className="space-y-4">
          <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex items-center gap-2"><Layers3 className="h-4 w-4 text-emerald-300"/><h2 className="text-xs font-black">BEFORE / AFTER REVIEW</h2></div>
            {compareItemId && sourceCompareUrl && resultCompareUrl ? <div className="mt-3 space-y-3">
              <div><p className="mb-1 text-[8px] font-black text-slate-500">BEFORE · SOURCE</p><video src={sourceCompareUrl} controls className="w-full rounded-2xl bg-black"/></div>
              <div><p className="mb-1 text-[8px] font-black text-emerald-300">AFTER · PIPELINE RESULT</p><video src={resultCompareUrl} controls className="w-full rounded-2xl bg-black"/></div>
              <button onClick={() => { setCompareItemId(null); setSourceCompareUrl(null); setResultCompareUrl(null) }} className="w-full rounded-xl border border-white/10 py-2 text-[9px] font-black text-slate-400">CLOSE COMPARISON</button>
            </div> : <div className="mt-3 rounded-2xl border border-dashed border-white/8 p-8 text-center"><Eye className="mx-auto h-6 w-6 text-slate-800"/><p className="mt-2 text-[9px] text-slate-700">اضغط COMPARE على أي عنصر مكتمل لعرض المصدر والنتيجة جنبًا إلى جنب.</p></div>}
          </section>

          <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex items-center gap-2"><Workflow className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">UNIFIED PRODUCTION WORKSPACE</h2></div>
            <div className="mt-3 grid gap-2">
              {[
                ['#video-v12','V12 · Editorial + Server Render','Timeline / Insert / Overwrite / Razor'],
                ['#video-v15','V15 · Advanced Finishing','Color / QC / Batch Delivery'],
                ['#video-v17','V17 · Tracking','Motion Tracking / Blur / Reframe'],
                ['#video-v19','V19 · Production Intelligence','Adaptive Tracking / Highlights / Stabilize'],
                ['#video-v20','V20 · Automated Pipeline','Single-file Automated Production'],
              ].map(([href,title,desc]) => <a key={href} href={href} className="group flex items-center gap-3 rounded-2xl border border-white/7 bg-black/20 p-3 hover:border-cyan-300/20"><div className="grid h-8 w-8 place-items-center rounded-xl bg-cyan-300/8"><ChevronLeft className="h-4 w-4 text-cyan-300"/></div><div><p className="text-[9px] font-black text-slate-300">{title}</p><p className="mt-1 text-[8px] text-slate-600">{desc}</p></div></a>)}
            </div>
          </section>

          <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
            <div className="flex items-center gap-2"><Gauge className="h-4 w-4 text-amber-300"/><h2 className="text-xs font-black">ORCHESTRATOR RULES</h2></div>
            <div className="mt-3 space-y-2 text-[9px] leading-5 text-slate-500">
              <p><span className="font-black text-rose-200">URGENT</span> يتقدم على High/Normal/Low بين عناصر الدفعات.</p>
              <p><span className="font-black text-amber-200">PAUSE</span> لا يقتل FFmpeg الجاري؛ يتحول إلى Pausing ثم Paused بعد العنصر الحالي.</p>
              <p><span className="font-black text-cyan-200">CUSTOM TEMPLATE</span> يحدد مراحل V20 وDelivery وReframe وSTT/Captions لكل الدفعة.</p>
              <p><span className="font-black text-emerald-200">PERSISTENCE</span> تحفظ المشاريع تحت `/data/video_orchestrator`؛ الاستمرارية عبر إعادة إنشاء Container تحتاج Railway Volume على `/data`.</p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  </main>
}
