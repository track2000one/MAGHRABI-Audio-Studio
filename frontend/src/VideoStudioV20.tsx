import { ChangeEvent, useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  Clock3,
  Download,
  FileJson,
  Film,
  Loader2,
  Play,
  RefreshCcw,
  RotateCcw,
  Sparkles,
  Subtitles,
  Trash2,
  UploadCloud,
  WandSparkles,
  Workflow,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import { getVideoRenderResultV12, listVideoRenderJobsV12 } from './lib/videoApi'
import {
  deletePipelineJobV20,
  getPipelineCaptionsV20,
  getPipelineInfoV20,
  getPipelineReportV20,
  getPipelineResultV20,
  listPipelineJobsV20,
  PipelineInfoV20,
  PipelineJobV20,
  PipelinePresetV20,
  queuePipelineV20,
  retryPipelineJobV20,
} from './lib/productionPipelineApi'

function pct(value: number) { return `${Math.max(0, Math.min(100, Math.round(value)))}%` }
function fmtDate(value?: string | null) {
  if (!value) return '—'
  try { return new Date(value).toLocaleString('ar-SA') } catch { return value }
}
function fmtBytes(value: unknown) {
  const bytes = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1200)
}

const statusClass: Record<string, string> = {
  queued: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
  processing: 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200',
  done: 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200',
  failed: 'border-rose-300/30 bg-rose-300/10 text-rose-200',
}
const stepClass: Record<string, string> = {
  pending: 'bg-white/5 text-slate-600',
  running: 'bg-cyan-300/10 text-cyan-200 border-cyan-300/25',
  done: 'bg-emerald-300/10 text-emerald-200 border-emerald-300/20',
  skipped: 'bg-slate-500/10 text-slate-500 border-white/5',
  warning: 'bg-amber-300/10 text-amber-200 border-amber-300/20',
  failed: 'bg-rose-300/10 text-rose-200 border-rose-300/20',
}

export default function VideoStudioV20() {
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [info, setInfo] = useState<PipelineInfoV20 | null>(null)
  const [jobs, setJobs] = useState<PipelineJobV20[]>([])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [sourceLabel, setSourceLabel] = useState('')
  const [presetId, setPresetId] = useState('youtube_creator')
  const [jobName, setJobName] = useState('MAGHRABI Automated Production')
  const [language, setLanguage] = useState('ar')
  const [sceneThreshold, setSceneThreshold] = useState(.35)
  const [highlightDuration, setHighlightDuration] = useState(45)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultName, setResultName] = useState('MAGHRABI-v20-result.mp4')

  const refresh = async (silent = false) => {
    if (!silent) setBusy('refresh')
    try {
      const items = await listPipelineJobsV20()
      setJobs(items)
      if (!selectedJobId && items[0]) setSelectedJobId(items[0].id)
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'تعذر تحديث Pipeline Jobs.')
    } finally { if (!silent) setBusy(null) }
  }

  useEffect(() => {
    getAuthStatus().then(status => setAuthorized(status.authenticated)).catch(() => setAuthorized(false))
    getPipelineInfoV20().then(data => {
      setInfo(data)
      if (data.presets[0]) setPresetId(current => data.presets.some(item => item.id === current) ? current : data.presets[0].id)
    }).catch(() => setInfo(null))
    refresh(true).catch(() => undefined)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => refresh(true).catch(() => undefined), 3000)
    return () => window.clearInterval(timer)
  }, [selectedJobId])

  useEffect(() => () => { if (resultUrl) URL.revokeObjectURL(resultUrl) }, [resultUrl])

  const selectedPreset = useMemo<PipelinePresetV20 | undefined>(() => info?.presets.find(item => item.id === presetId), [info, presetId])
  const selectedJob = useMemo(() => jobs.find(item => item.id === selectedJobId) || null, [jobs, selectedJobId])

  const onUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0]
    if (next) {
      setFile(next)
      setSourceLabel(next.name)
      setError(null)
    }
    event.target.value = ''
  }

  const loadLatest = async () => {
    if (busy) return
    setBusy('latest'); setError(null)
    try {
      const renderJobs = await listVideoRenderJobsV12()
      const job = renderJobs.find(item => item.status === 'done' && item.resultReady)
      if (!job) throw new Error('لا توجد نتيجة Render مكتملة في Server Render Queue.')
      const blob = await getVideoRenderResultV12(job.id)
      const next = new File([blob], `Latest-Edit-${job.id.slice(0, 8)}.mp4`, { type: 'video/mp4' })
      setFile(next)
      setSourceLabel(`Latest Edit · ${job.name}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل Latest Edit.') }
    finally { setBusy(null) }
  }

  const submit = async () => {
    if (!file || busy) return
    setBusy('queue'); setError(null)
    try {
      const created = await queuePipelineV20(file, presetId, {
        name: jobName,
        language,
        sceneThreshold,
        highlightDuration,
      })
      setSelectedJobId(created.id)
      await refresh(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر إضافة Production Pipeline.') }
    finally { setBusy(null) }
  }

  const retry = async (job: PipelineJobV20) => {
    if (busy) return
    setBusy(`retry-${job.id}`); setError(null)
    try { await retryPipelineJobV20(job.id); await refresh(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر إعادة المهمة.') }
    finally { setBusy(null) }
  }

  const remove = async (job: PipelineJobV20) => {
    if (busy || job.status === 'processing') return
    setBusy(`delete-${job.id}`); setError(null)
    try {
      await deletePipelineJobV20(job.id)
      if (selectedJobId === job.id) setSelectedJobId(null)
      await refresh(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر حذف المهمة.') }
    finally { setBusy(null) }
  }

  const openResult = async (job: PipelineJobV20) => {
    if (!job.resultReady || busy) return
    setBusy(`result-${job.id}`); setError(null)
    try {
      const blob = await getPipelineResultV20(job.id)
      if (resultUrl) URL.revokeObjectURL(resultUrl)
      setResultUrl(URL.createObjectURL(blob))
      setResultName(`MAGHRABI-v20-${job.preset}-${job.id.slice(0, 8)}.mp4`)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر فتح النتيجة.') }
    finally { setBusy(null) }
  }

  const downloadReport = async (job: PipelineJobV20) => {
    if (!job.reportReady || busy) return
    setBusy(`report-${job.id}`)
    try { downloadBlob(await getPipelineReportV20(job.id), `MAGHRABI-v20-report-${job.id.slice(0, 8)}.json`) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تنزيل التقرير.') }
    finally { setBusy(null) }
  }

  const downloadCaptions = async (job: PipelineJobV20) => {
    if (!job.captionsReady || busy) return
    setBusy(`captions-${job.id}`)
    try { downloadBlob(await getPipelineCaptionsV20(job.id), `MAGHRABI-v20-captions-${job.id.slice(0, 8)}.srt`) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تنزيل Captions.') }
    finally { setBusy(null) }
  }

  if (authorized === false) return <div className="min-h-screen bg-[#05080d] p-10 text-center text-slate-300">سجّل الدخول أولًا لفتح Creator V20.</div>
  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#05080d]"><Loader2 className="h-8 w-8 animate-spin text-cyan-300"/></div>

  return <main className="min-h-screen bg-[#05080d] text-slate-100" dir="rtl">
    <header className="border-b border-white/8 bg-[#080d15] px-5 py-4">
      <div className="mx-auto flex max-w-[1750px] flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-black tracking-[.34em] text-cyan-300">MAGHRABI CREATOR V20</p>
          <h1 className="text-xl font-black">Automated Production Pipeline · Control Room</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="#video-v19" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-black text-slate-300">V19 PRODUCTION INTELLIGENCE</a>
          <label className="cursor-pointer rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950"><UploadCloud className="ml-1 inline h-4 w-4"/>OPEN VIDEO<input type="file" accept="video/*" className="hidden" onChange={onUpload}/></label>
          <button onClick={loadLatest} disabled={!!busy} className="rounded-xl border border-cyan-300/30 px-4 py-2 text-xs font-black text-cyan-200">LOAD LATEST EDIT</button>
        </div>
      </div>
    </header>

    <div className="mx-auto grid max-w-[1750px] gap-4 p-4 xl:grid-cols-[350px_minmax(0,1fr)_390px]">
      <aside className="space-y-4">
        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center gap-2"><Workflow className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">PIPELINE INPUT</h2></div>
          <div className="mt-3 rounded-2xl border border-white/8 bg-black/25 p-3 text-[10px]">
            <div className="flex items-center gap-2"><Film className="h-4 w-4 text-slate-500"/><span className="truncate font-bold text-slate-300">{sourceLabel || 'No source selected'}</span></div>
            {file && <p className="mt-1 text-slate-600">{fmtBytes(file.size)}</p>}
          </div>
          <label className="mt-3 block text-[9px] font-black text-slate-500">JOB NAME<input value={jobName} onChange={e => setJobName(e.target.value)} className="mt-1 w-full rounded-xl border border-white/8 bg-black/30 p-2.5 text-xs text-slate-200"/></label>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[9px]">
            <label>LANGUAGE<input value={language} onChange={e => setLanguage(e.target.value)} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label>
            <label>SCENE THRESHOLD<input type="number" min=".08" max=".85" step=".01" value={sceneThreshold} onChange={e => setSceneThreshold(Number(e.target.value))} className="mt-1 w-full rounded-lg bg-black/30 p-2"/></label>
          </div>
          <label className="mt-3 block text-[9px]">HIGHLIGHT MAX · {Math.round(highlightDuration)}s<input type="range" min="10" max="120" step="5" value={highlightDuration} onChange={e => setHighlightDuration(Number(e.target.value))} className="mt-1 w-full accent-cyan-300"/></label>
          <button disabled={!file || !!busy} onClick={submit} className="mt-4 w-full rounded-2xl bg-cyan-300 px-4 py-3 text-xs font-black text-slate-950 shadow-lg shadow-cyan-950/20">{busy === 'queue' ? <><Loader2 className="ml-1 inline h-4 w-4 animate-spin"/>UPLOADING…</> : <><Play className="ml-1 inline h-4 w-4"/>START AUTOMATED PIPELINE</>}</button>
          <div className={`mt-3 rounded-xl border p-3 text-[9px] ${info?.stt.configured ? 'border-emerald-300/20 bg-emerald-300/5 text-emerald-200' : 'border-amber-300/20 bg-amber-300/5 text-amber-200'}`}>{info?.stt.configured ? 'Speech-to-Text Worker: READY' : 'STT Worker غير مهيأ؛ Pipeline ستتخطى النسخ التلقائي وتكمل بقية المراحل.'}</div>
        </section>

        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-fuchsia-300"/><h2 className="text-xs font-black">PRODUCTION PRESETS</h2></div>
          <div className="mt-3 space-y-2">
            {info?.presets.map(preset => <button key={preset.id} onClick={() => { setPresetId(preset.id); setHighlightDuration(preset.highlightDuration) }} className={`w-full rounded-2xl border p-3 text-right transition ${presetId === preset.id ? 'border-cyan-300/45 bg-cyan-300/10' : 'border-white/7 bg-black/20 hover:border-white/15'}`}>
              <div className="flex items-center justify-between gap-2"><span className="text-[11px] font-black text-slate-200">{preset.label}</span>{presetId === preset.id && <CheckCircle2 className="h-4 w-4 text-cyan-300"/>}</div>
              <p className="mt-1 text-[9px] leading-5 text-slate-500">{preset.description}</p>
              <div className="mt-2 flex flex-wrap gap-1 text-[8px] text-slate-600">{preset.highlight && <span className="rounded bg-white/5 px-1.5 py-1">HIGHLIGHT</span>}{preset.dialogue && <span className="rounded bg-white/5 px-1.5 py-1">DIALOGUE</span>}{preset.transcribe && <span className="rounded bg-white/5 px-1.5 py-1">STT</span>}{preset.burnCaptions && <span className="rounded bg-white/5 px-1.5 py-1">CAPTIONS</span>}{preset.reframe && <span className="rounded bg-white/5 px-1.5 py-1">9:16</span>}</div>
            </button>)}
          </div>
        </section>
      </aside>

      <section className="space-y-4">
        <section className="rounded-3xl border border-white/8 bg-[#070b11] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="text-[10px] font-black text-slate-500">SELECTED PIPELINE</p><h2 className="mt-1 text-lg font-black">{selectedJob?.name || selectedPreset?.label || 'Production Pipeline'}</h2></div>
            {selectedJob && <span className={`rounded-xl border px-3 py-2 text-[10px] font-black ${statusClass[selectedJob.status] || statusClass.queued}`}>{selectedJob.status.toUpperCase()} · {pct(selectedJob.progress)}</span>}
          </div>
          {selectedJob ? <>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/5"><div className="h-full bg-cyan-300 transition-all duration-500" style={{ width: pct(selectedJob.progress) }}/></div>
            <div className="mt-3 flex flex-wrap justify-between gap-2 text-[9px] text-slate-500"><span>{selectedJob.message || selectedJob.stage}</span><span>Created {fmtDate(selectedJob.createdAt)}</span></div>
            {selectedJob.error && <div className="mt-3 rounded-xl border border-rose-300/20 bg-rose-300/5 p-3 text-[10px] leading-5 text-rose-200">{selectedJob.error}</div>}
            <div className="mt-5 grid gap-2 md:grid-cols-2">
              {selectedJob.steps.length ? selectedJob.steps.map((step, index) => <div key={step.id} className={`rounded-2xl border p-3 ${stepClass[step.status] || stepClass.pending}`}>
                <div className="flex items-center justify-between gap-2"><span className="text-[10px] font-black">{String(index + 1).padStart(2, '0')} · {step.label}</span>{step.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : step.status === 'done' ? <CheckCircle2 className="h-3.5 w-3.5"/> : <Clock3 className="h-3.5 w-3.5"/>}</div>
                <p className="mt-1 text-[9px] leading-5 opacity-75">{step.message || step.status}</p>
              </div>) : <div className="col-span-full rounded-2xl border border-dashed border-white/10 p-8 text-center text-xs text-slate-600">المهمة في Queue وتنتظر بدء Worker.</div>}
            </div>
          </> : <div className="grid min-h-[420px] place-items-center text-center text-slate-600"><div><WandSparkles className="mx-auto h-12 w-12"/><p className="mt-3 text-sm font-bold">أضف Pipeline جديدة أو اختر مهمة من القائمة</p></div></div>}
        </section>

        {selectedJob?.status === 'done' && <section className="rounded-3xl border border-emerald-300/15 bg-[#07130f] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] font-black text-emerald-300">DELIVERY READY</p><h3 className="mt-1 text-sm font-black">{selectedJob.presetLabel}</h3></div><div className="flex flex-wrap gap-2"><button onClick={() => openResult(selectedJob)} className="rounded-xl bg-emerald-300 px-3 py-2 text-[10px] font-black text-slate-950"><Film className="ml-1 inline h-3.5 w-3.5"/>OPEN RESULT</button><button disabled={!selectedJob.reportReady} onClick={() => downloadReport(selectedJob)} className="rounded-xl border border-emerald-300/25 px-3 py-2 text-[10px] font-black text-emerald-200"><FileJson className="ml-1 inline h-3.5 w-3.5"/>QC REPORT</button><button disabled={!selectedJob.captionsReady} onClick={() => downloadCaptions(selectedJob)} className="rounded-xl border border-amber-300/25 px-3 py-2 text-[10px] font-black text-amber-200"><Subtitles className="ml-1 inline h-3.5 w-3.5"/>SRT</button></div></div>
          {selectedJob.output && <div className="mt-3 grid grid-cols-2 gap-2 text-[9px] md:grid-cols-4"><div className="rounded-xl bg-black/25 p-2">Duration<br/><b>{Number(selectedJob.output.duration || 0).toFixed(1)}s</b></div><div className="rounded-xl bg-black/25 p-2">Size<br/><b>{fmtBytes(selectedJob.output.sizeBytes)}</b></div><div className="rounded-xl bg-black/25 p-2">Preset<br/><b>{String(selectedJob.output.deliveryPreset || '—')}</b></div><div className="rounded-xl bg-black/25 p-2">QC<br/><b>{JSON.stringify(selectedJob.output.qcSummary || {})}</b></div></div>}
        </section>}

        {resultUrl && <section className="rounded-3xl border border-cyan-300/15 bg-[#071118] p-4"><div className="flex items-center justify-between"><h3 className="text-xs font-black text-cyan-200">FINAL V20 RESULT</h3><a href={resultUrl} download={resultName} className="rounded-xl bg-cyan-300 px-3 py-2 text-[10px] font-black text-slate-950"><Download className="ml-1 inline h-3.5 w-3.5"/>DOWNLOAD VIDEO</a></div><video src={resultUrl} controls className="mt-3 max-h-[520px] w-full rounded-2xl bg-black"/></section>}
      </section>

      <aside className="space-y-4">
        <section className="rounded-3xl border border-white/8 bg-[#0a1019] p-4">
          <div className="flex items-center justify-between"><div className="flex items-center gap-2"><RotateCcw className="h-4 w-4 text-cyan-300"/><h2 className="text-xs font-black">SERVER PIPELINE QUEUE</h2></div><button onClick={() => refresh()} disabled={busy === 'refresh'} className="rounded-lg border border-white/10 p-2 text-slate-400"><RefreshCcw className={`h-3.5 w-3.5 ${busy === 'refresh' ? 'animate-spin' : ''}`}/></button></div>
          <p className="mt-2 text-[9px] leading-5 text-slate-600">الحالة محفوظة على السيرفر. بقاء الملفات عبر إعادة إنشاء Container يعتمد على Railway Volume المربوط بـ /data.</p>
          <div className="mt-3 max-h-[70vh] space-y-2 overflow-y-auto pl-1">
            {jobs.map(job => <div key={job.id} className={`rounded-2xl border p-3 ${selectedJobId === job.id ? 'border-cyan-300/35 bg-cyan-300/5' : 'border-white/7 bg-black/20'}`}>
              <button onClick={() => setSelectedJobId(job.id)} className="w-full text-right"><div className="flex items-center justify-between gap-2"><span className="truncate text-[10px] font-black text-slate-300">{job.name}</span><span className={`rounded border px-1.5 py-1 text-[8px] ${statusClass[job.status] || statusClass.queued}`}>{job.status}</span></div><p className="mt-1 text-[8px] text-slate-600">{job.presetLabel} · {pct(job.progress)}</p><div className="mt-2 h-1 overflow-hidden rounded bg-white/5"><div className="h-full bg-cyan-300" style={{ width: pct(job.progress) }}/></div></button>
              <div className="mt-2 flex gap-1"><button disabled={job.status === 'processing' || !!busy} onClick={() => retry(job)} className="flex-1 rounded-lg border border-white/8 px-2 py-1.5 text-[8px] font-black text-slate-400"><RefreshCcw className="ml-1 inline h-3 w-3"/>RETRY</button><button disabled={job.status === 'processing' || !!busy} onClick={() => remove(job)} className="rounded-lg border border-rose-300/15 px-2 py-1.5 text-[8px] font-black text-rose-300"><Trash2 className="h-3 w-3"/></button></div>
            </div>)}
            {!jobs.length && <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-[10px] text-slate-600">لا توجد Pipeline Jobs حتى الآن.</div>}
          </div>
        </section>
      </aside>
    </div>

    {error && <div className="fixed bottom-5 left-1/2 z-50 max-w-xl -translate-x-1/2 rounded-2xl border border-rose-300/30 bg-[#2a0d14]/95 px-5 py-3 text-xs font-bold text-rose-100 shadow-2xl">{error}</div>}
  </main>
}
