import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Download,
  Film,
  Gauge,
  Loader2,
  Mic2,
  Printer,
  ScanSearch,
  Sparkles,
  UploadCloud,
  WandSparkles,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import { analyzeAudioV14, AudioMasterSettingsV14, ExportPresetV14, GradeSettingsV14, LoudnessAnalysisV14 } from './lib/finishingApi'
import {
  AudioRepairV15,
  inspectSourceV15,
  masterVideoV15,
  PowerWindowV15,
  QCResultV15,
  runQCV15,
  SecondaryColorV15,
  SourceInspectionV15,
} from './lib/advancedFinishingApi'
import { getVideoRenderResultV12, listVideoRenderJobsV12 } from './lib/videoApi'
import {
  analyzeShotsV16,
  AutoColorResultV16,
  autoColorV16,
  cleanDialogueV16,
  detectScenesV16,
  SceneDetectionV16,
  ShotAnalysisV16,
  smartReframeV16,
} from './lib/smartAssistApi'

type RGB = { r: number; g: number; b: number }
type CurveBand = { shadows: number; mids: number; highlights: number }

const neutralRgb: RGB = { r: 0, g: 0, b: 0 }
const neutralBand: CurveBand = { shadows: 0, mids: 0, highlights: 0 }
const defaultGrade: GradeSettingsV14 = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  gamma: 0,
  lift: { ...neutralRgb },
  gammaWheel: { ...neutralRgb },
  gain: { ...neutralRgb },
  curves: { r: { ...neutralBand }, g: { ...neutralBand }, b: { ...neutralBand } },
}
const defaultAudio: AudioMasterSettingsV14 = {
  low: 0,
  mid: 0,
  high: 0,
  compressor: true,
  thresholdDb: -18,
  ratio: 3,
  attack: 20,
  release: 250,
  limiter: true,
  ceilingDb: -1,
  normalize: true,
  targetLufs: -14,
}
const secondaryOff: SecondaryColorV15 = { enabled: false, family: 'reds', cyan: 0, magenta: 0, yellow: 0, black: 0 }
const windowOff: PowerWindowV15 = { enabled: false, x: .2, y: .2, width: .5, height: .5, brightness: 0, contrast: 1, saturation: 1 }
const repairOff: AudioRepairV15 = { noiseReduction: false, noiseStrength: .35, deesser: false, deesserIntensity: .35, stereoWidth: 1 }

const presets: Array<{ id: ExportPresetV14; label: string }> = [
  { id: 'youtube_1080', label: 'YouTube 1080p' },
  { id: 'tiktok', label: 'TikTok 9:16' },
  { id: 'instagram_reel', label: 'Instagram Reels' },
  { id: 'instagram_square', label: 'Instagram Square' },
  { id: 'broadcast_1080p25', label: 'Broadcast 1080p25' },
  { id: 'master_1080', label: 'Master 1080p' },
]

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)) }
function fmt(value: number | null | undefined, digits = 1) { return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits) }
function timecode(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const mins = Math.floor(safe / 60)
  return `${String(mins).padStart(2, '0')}:${(safe - mins * 60).toFixed(1).padStart(4, '0')}`
}
function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] || character))
}

export default function VideoStudioV16() {
  const monitorRef = useRef<HTMLVideoElement>(null)
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [sourceLabel, setSourceLabel] = useState('')
  const [inspection, setInspection] = useState<SourceInspectionV15 | null>(null)
  const [scenes, setScenes] = useState<SceneDetectionV16 | null>(null)
  const [shotAnalysis, setShotAnalysis] = useState<ShotAnalysisV16 | null>(null)
  const [autoColor, setAutoColor] = useState<AutoColorResultV16 | null>(null)
  const [qc, setQc] = useState<QCResultV15 | null>(null)
  const [loudness, setLoudness] = useState<LoudnessAnalysisV14 | null>(null)
  const [grade, setGrade] = useState<GradeSettingsV14>(defaultGrade)
  const [threshold, setThreshold] = useState(.35)
  const [preset, setPreset] = useState<ExportPresetV14>('youtube_1080')
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { getAuthStatus().then((status) => setAuthorized(status.authenticated)).catch(() => setAuthorized(false)) }, [])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); if (resultUrl) URL.revokeObjectURL(resultUrl) }, [url, resultUrl])

  const previewFilter = useMemo(
    () => `brightness(${clamp(1 + grade.brightness * .8, .55, 1.45)}) contrast(${grade.contrast}) saturate(${grade.saturation})`,
    [grade.brightness, grade.contrast, grade.saturation],
  )

  const useSource = async (next: File, label?: string) => {
    if (url) URL.revokeObjectURL(url)
    const objectUrl = URL.createObjectURL(next)
    setFile(next)
    setUrl(objectUrl)
    setSourceLabel(label || next.name)
    setScenes(null)
    setShotAnalysis(null)
    setAutoColor(null)
    setQc(null)
    setLoudness(null)
    setResultUrl(null)
    setError(null)
    setBusy('inspect')
    try { setInspection(await inspectSourceV15(next)) }
    catch (e) { setInspection(null); setError(e instanceof Error ? e.message : 'تعذر فحص المصدر.') }
    finally { setBusy(null) }
  }

  const onUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0]
    if (next) useSource(next).catch(() => undefined)
    event.target.value = ''
  }

  const loadLatest = async () => {
    setBusy('latest'); setError(null)
    try {
      const jobs = await listVideoRenderJobsV12()
      const job = jobs.find((item) => item.status === 'done' && item.resultReady)
      if (!job) throw new Error('لا توجد نتيجة Render مكتملة في Server Queue.')
      const blob = await getVideoRenderResultV12(job.id)
      await useSource(new File([blob], `V15-edit-${job.id.slice(0, 8)}.mp4`, { type: 'video/mp4' }), `Latest Edit · ${job.name}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تحميل آخر Render.') }
    finally { setBusy(null) }
  }

  const runSmartAnalysis = async () => {
    if (!file || busy) return
    setBusy('analyze'); setError(null)
    try {
      const [sceneResult, colorResult, shotResult, qcResult] = await Promise.all([
        detectScenesV16(file, threshold),
        autoColorV16(file),
        analyzeShotsV16(file, threshold),
        runQCV15(file),
      ])
      setScenes(sceneResult)
      setAutoColor(colorResult)
      setShotAnalysis(shotResult)
      setQc(qcResult)
      if (inspection?.hasAudio) {
        try { setLoudness(await analyzeAudioV14(file)) } catch { setLoudness(null) }
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تشغيل Smart Analysis.') }
    finally { setBusy(null) }
  }

  const applyAutoColor = () => {
    if (!autoColor) return
    setGrade((current) => ({
      ...current,
      brightness: autoColor.suggestion.brightness,
      contrast: autoColor.suggestion.contrast,
      saturation: autoColor.suggestion.saturation,
      gammaWheel: { ...autoColor.suggestion.gammaWheel },
    }))
  }

  const dialogueClean = async () => {
    if (!file || busy) return
    setBusy('dialogue'); setError(null)
    try {
      const blob = await cleanDialogueV16(file)
      await useSource(new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-dialogue-clean.mp4`, { type: 'video/mp4' }), `${sourceLabel || file.name} · Dialogue Clean`)
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تنظيف الحوار.') }
    finally { setBusy(null) }
  }

  const reframe = async (target: 'portrait' | 'square') => {
    if (!file || busy) return
    setBusy(`reframe-${target}`); setError(null)
    try {
      const blob = await smartReframeV16(file, target)
      await useSource(new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-${target}.mp4`, { type: 'video/mp4' }), `${sourceLabel || file.name} · Smart ${target}`)
      setPreset(target === 'portrait' ? 'instagram_reel' : 'instagram_square')
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر Smart Reframe.') }
    finally { setBusy(null) }
  }

  const exportMaster = async () => {
    if (!file || busy) return
    setBusy('master'); setError(null)
    try {
      const targetLufs = preset === 'broadcast_1080p25' ? -23 : -14
      const audio = { ...defaultAudio, targetLufs }
      const blob = await masterVideoV15(file, grade, audio, secondaryOff, windowOff, repairOff, 'auto', preset)
      if (resultUrl) URL.revokeObjectURL(resultUrl)
      setResultUrl(URL.createObjectURL(blob))
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر تصدير Smart Master.') }
    finally { setBusy(null) }
  }

  const printReport = () => {
    if (!file || !inspection) return
    const report = window.open('', '_blank', 'noopener,noreferrer')
    if (!report) { setError('المتصفح منع فتح نافذة تقرير QC. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.'); return }
    const issueRows = (qc?.issues || []).map((item) => `<tr><td>${escapeHtml(item.type)}</td><td>${timecode(item.start)}</td><td>${timecode(item.end)}</td><td>${escapeHtml(item.severity)}</td></tr>`).join('')
    const shotRows = (shotAnalysis?.shots || []).slice(0, 24).map((shot) => `<tr><td>${shot.index}</td><td>${timecode(shot.start)}</td><td>${timecode(shot.end)}</td><td>${fmt(shot.luma)}</td><td>${fmt(shot.brightnessOffset, 3)}</td></tr>`).join('')
    report.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>MAGHRABI V16 QC Report</title><style>body{font-family:Arial,sans-serif;margin:32px;color:#111}h1{margin:0 0 8px}h2{margin-top:28px;border-bottom:1px solid #bbb;padding-bottom:6px}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #ccc;padding:7px;text-align:right;font-size:12px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.box{border:1px solid #ccc;padding:10px}.muted{color:#666;font-size:12px}@media print{button{display:none}}</style></head><body><button onclick="window.print()">طباعة التقرير</button><h1>MAGHRABI Creator V16 — Final QC Report</h1><p class="muted">المصدر: ${escapeHtml(sourceLabel || file.name)}</p><div class="grid"><div class="box">المدة: ${fmt(inspection.duration)} ثانية</div><div class="box">الصوت: ${inspection.hasAudio ? 'موجود' : 'غير موجود'}</div><div class="box">HDR: ${inspection.color.isHdr ? 'نعم' : 'لا'}</div><div class="box">Color: ${escapeHtml(String(inspection.color.primaries || inspection.color.colorSpace || 'غير محدد'))}</div><div class="box">Scenes: ${scenes?.scenes.length ?? '—'}</div><div class="box">Integrated LUFS: ${fmt(loudness?.integratedLufs)}</div><div class="box">True Peak: ${fmt(loudness?.truePeakDbfs)} dBFS</div><div class="box">Auto Color Confidence: ${autoColor ? fmt(autoColor.confidence * 100) + '%' : '—'}</div></div><h2>QC Issues</h2><p>Black: ${qc?.summary.black ?? '—'} · Freeze: ${qc?.summary.freeze ?? '—'} · Silence: ${qc?.summary.silence ?? '—'}</p><table><thead><tr><th>النوع</th><th>البداية</th><th>النهاية</th><th>الدرجة</th></tr></thead><tbody>${issueRows || '<tr><td colspan="4">لا توجد مشكلات مسجلة.</td></tr>'}</tbody></table><h2>Shot Analysis</h2><table><thead><tr><th>#</th><th>Start</th><th>End</th><th>Luma</th><th>Suggested Brightness Offset</th></tr></thead><tbody>${shotRows || '<tr><td colspan="5">لم يتم تشغيل Shot Analysis.</td></tr>'}</tbody></table><h2>Applied Smart Grade</h2><p>Brightness ${grade.brightness.toFixed(3)} · Contrast ${grade.contrast.toFixed(3)} · Saturation ${grade.saturation.toFixed(3)}</p><p class="muted">هذا التقرير يلخص فحوص V16 الآلية. يجب اعتماد النسخة النهائية بعد مراجعة بشرية للصورة والصوت والتوقيت.</p></body></html>`)
    report.document.close()
  }

  const seekScene = (start: number) => {
    const video = monitorRef.current
    if (!video) return
    try { video.currentTime = start } catch { /* ignore seek failures */ }
  }

  if (authorized === null) return <div className="grid min-h-screen place-items-center bg-[#050710] text-fuchsia-200">جاري التحقق...</div>
  if (!authorized) return <div className="grid min-h-screen place-items-center bg-[#050710] text-white"><a href="#" className="rounded-2xl bg-white px-6 py-3 font-black text-black">العودة لتسجيل الدخول</a></div>

  return <main className="min-h-screen bg-[#050710] text-slate-100"><div className="mx-auto max-w-[1900px] px-3 py-4 md:px-5">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
      <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-fuchsia-400/10"><Sparkles className="h-5 w-5 text-fuchsia-200"/></div><div><div className="flex items-center gap-2"><h1 className="text-lg font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-fuchsia-300/20 bg-fuchsia-300/[.06] px-2 py-1 text-[9px] font-black text-fuchsia-100">SMART ASSIST V16</span></div><p className="mt-1 text-[10px] text-slate-500">Scene Intelligence · Auto Color · Shot Analysis · Dialogue Cleanup · Smart Reframe · QC Report</p></div></div>
      <div className="flex flex-wrap gap-2"><label className="cursor-pointer rounded-xl border border-fuchsia-300/20 px-3 py-2 text-[9px] font-black"><UploadCloud className="mr-1 inline h-3.5 w-3.5"/>OPEN MASTER<input type="file" accept="video/*" className="hidden" onChange={onUpload}/></label><button onClick={loadLatest} disabled={!!busy} className="rounded-xl border border-cyan-300/20 px-3 py-2 text-[9px] font-black text-cyan-100 disabled:opacity-40">LOAD LATEST EDIT</button><a href="#video-v15" className="rounded-xl border border-white/10 px-3 py-2 text-[9px] font-black text-slate-400">V15 ADVANCED FINISHING</a></div>
    </header>

    <section className="mt-4 grid gap-4 xl:grid-cols-[330px_minmax(0,1fr)_390px]">
      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">SMART ANALYSIS</p><p className="mt-1 truncate text-[9px] text-slate-600">{sourceLabel || 'لا يوجد مصدر'}</p></div><ScanSearch className="h-4 w-4 text-fuchsia-300"/></div><label className="mt-4 block text-[8px] font-black text-slate-500"><span className="flex justify-between"><span>SCENE SENSITIVITY</span><span>{threshold.toFixed(2)}</span></span><input type="range" min=".12" max=".65" step=".01" value={threshold} onChange={e=>setThreshold(Number(e.target.value))} className="mt-2 w-full accent-fuchsia-300"/></label><button onClick={runSmartAnalysis} disabled={!file || !!busy} className="mt-3 w-full rounded-xl bg-gradient-to-r from-fuchsia-500 to-violet-500 p-3 text-[9px] font-black disabled:opacity-30">{busy==='analyze'?<Loader2 className="mr-1 inline h-4 w-4 animate-spin"/>:<WandSparkles className="mr-1 inline h-4 w-4"/>}RUN SMART ANALYSIS</button></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><p className="text-[10px] font-black tracking-widest text-slate-500">SOURCE INTELLIGENCE</p>{inspection?<div className="mt-3 grid grid-cols-2 gap-2 text-[8px]"><div className="rounded-xl border border-white/8 p-2"><span className="text-slate-600">DURATION</span><p className="mt-1 font-mono text-slate-200">{fmt(inspection.duration)}s</p></div><div className="rounded-xl border border-white/8 p-2"><span className="text-slate-600">AUDIO</span><p className="mt-1 font-black">{inspection.hasAudio?'YES':'NO'}</p></div><div className="rounded-xl border border-white/8 p-2"><span className="text-slate-600">HDR</span><p className={`mt-1 font-black ${inspection.color.isHdr?'text-amber-300':'text-emerald-300'}`}>{inspection.color.isHdr?'HDR':'SDR'}</p></div><div className="rounded-xl border border-white/8 p-2"><span className="text-slate-600">PRIMARIES</span><p className="mt-1 truncate font-mono">{String(inspection.color.primaries || '—')}</p></div></div>:<p className="mt-3 text-[9px] text-slate-600">افتح ملف فيديو لبدء الفحص.</p>}</div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><p className="text-[10px] font-black tracking-widest text-slate-500">SMART REFRAME</p><p className="mt-2 text-[8px] leading-4 text-slate-600">يحلل Active Picture ويختار مركز المحتوى تلقائيًا. لا يدّعي تتبع الأشخاص في هذه النسخة.</p><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={()=>reframe('portrait')} disabled={!file||!!busy} className="rounded-xl border border-violet-300/20 p-2 text-[8px] font-black disabled:opacity-30">9:16 PORTRAIT</button><button onClick={()=>reframe('square')} disabled={!file||!!busy} className="rounded-xl border border-violet-300/20 p-2 text-[8px] font-black disabled:opacity-30">1:1 SQUARE</button></div></div>
      </aside>

      <div className="min-w-0 space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-black">SMART PROGRAM MONITOR</p><p className="mt-1 max-w-[720px] truncate text-[9px] text-slate-600">{sourceLabel || 'OPEN MASTER أو LOAD LATEST EDIT'}</p></div>{busy&&<span className="inline-flex items-center gap-2 text-[8px] font-black text-fuchsia-200"><Loader2 className="h-3.5 w-3.5 animate-spin"/>{busy.toUpperCase()}</span>}</div><div className="aspect-video overflow-hidden rounded-2xl bg-black">{url?<video ref={monitorRef} src={url} controls playsInline className="h-full w-full object-contain" style={{filter:previewFilter}}/>:<div className="grid h-full place-items-center"><Film className="h-12 w-12 text-slate-800"/></div>}</div></div>

        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-black">SCENE MAP</p><p className="mt-1 text-[9px] text-slate-600">اضغط على أي Scene للانتقال إلى بدايتها.</p></div><span className="rounded-full border border-white/10 px-3 py-1 text-[8px] font-black">{scenes?.scenes.length ?? 0} SCENES</span></div><div className="mt-3 flex min-h-20 gap-2 overflow-x-auto pb-2">{scenes?.scenes.map(scene=><button key={scene.index} onClick={()=>seekScene(scene.start)} className="min-w-[105px] rounded-xl border border-violet-300/15 bg-violet-300/[.04] p-3 text-left"><span className="text-[8px] font-black text-violet-200">SHOT {scene.index}</span><span className="mt-2 block font-mono text-[8px] text-slate-500">{timecode(scene.start)}</span><span className="mt-1 block text-[7px] text-slate-700">{fmt(scene.duration)}s</span></button>)}{!scenes&&<div className="grid w-full place-items-center text-[9px] text-slate-700">RUN SMART ANALYSIS</div>}</div></div>

        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="flex items-center justify-between"><div><p className="text-xs font-black">SHOT-BY-SHOT COLOR CONSISTENCY</p><p className="mt-1 text-[9px] text-slate-600">يقارن إضاءة اللقطات مع Median المشروع ويقترح Offset بسيطًا لكل Shot.</p></div><Activity className="h-4 w-4 text-emerald-300"/></div><div className="mt-3 grid max-h-64 gap-2 overflow-auto sm:grid-cols-2 lg:grid-cols-3">{shotAnalysis?.shots.map(shot=><button key={shot.index} onClick={()=>seekScene(shot.start)} className="rounded-xl border border-white/8 p-3 text-left"><div className="flex justify-between"><span className="text-[8px] font-black">SHOT {shot.index}</span><span className={`font-mono text-[8px] ${Math.abs(shot.brightnessOffset)>.08?'text-amber-300':'text-emerald-300'}`}>{shot.brightnessOffset>=0?'+':''}{shot.brightnessOffset.toFixed(3)}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-black"><div className="h-full bg-white/60" style={{width:`${clamp(shot.luma/255*100,2,100)}%`}}/></div><p className="mt-2 text-[7px] text-slate-600">Luma {fmt(shot.luma)} · {timecode(shot.start)}</p></button>)}</div></div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">AUTO COLOR BALANCE</p><p className="mt-1 text-[8px] text-slate-600">اقتراح محافظ قابل للتعديل قبل Master.</p></div><Gauge className="h-4 w-4 text-fuchsia-300"/></div>{autoColor?<><div className="mt-3 grid grid-cols-2 gap-2 text-[8px]"><div className="rounded-xl border border-white/8 p-2">CONFIDENCE<p className="mt-1 font-mono text-emerald-300">{fmt(autoColor.confidence*100)}%</p></div><div className="rounded-xl border border-white/8 p-2">AVG LUMA<p className="mt-1 font-mono">{fmt(autoColor.averageLuma)}</p></div></div><button onClick={applyAutoColor} className="mt-3 w-full rounded-xl bg-fuchsia-300/10 p-2 text-[8px] font-black text-fuchsia-100">APPLY AUTO COLOR</button></>:<p className="mt-3 text-[9px] text-slate-600">شغّل Smart Analysis أولًا.</p>}
          <div className="mt-4 space-y-3">{([['BRIGHTNESS','brightness',-.3,.3,.01],['CONTRAST','contrast',.6,1.6,.01],['SATURATION','saturation',0,2,.01]] as const).map(([label,key,min,max,step])=><label key={key} className="block text-[8px] font-black text-slate-500"><span className="flex justify-between"><span>{label}</span><span>{grade[key].toFixed(2)}</span></span><input type="range" min={min} max={max} step={step} value={grade[key]} onChange={e=>setGrade(current=>({...current,[key]:Number(e.target.value)}))} className="mt-1 w-full accent-fuchsia-300"/></label>)}</div>
        </div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">AUTO DIALOGUE CLEANUP</p><p className="mt-1 text-[8px] text-slate-600">HP/LP + Noise Reduction عند توفره + De-esser عند توفره + Compressor + Loudness.</p></div><Mic2 className="h-4 w-4 text-cyan-300"/></div><button onClick={dialogueClean} disabled={!file||!inspection?.hasAudio||!!busy} className="mt-3 w-full rounded-xl border border-cyan-300/20 p-2 text-[8px] font-black text-cyan-100 disabled:opacity-30">CLEAN DIALOGUE → USE RESULT</button></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><p className="text-[10px] font-black tracking-widest text-slate-500">FINAL QC</p><div className="mt-3 grid grid-cols-3 gap-2 text-center text-[8px]"><div className="rounded-xl border border-white/8 p-2"><span className="text-slate-600">BLACK</span><p className="mt-1 font-black text-amber-300">{qc?.summary.black ?? '—'}</p></div><div className="rounded-xl border border-white/8 p-2"><span className="text-slate-600">FREEZE</span><p className="mt-1 font-black text-amber-300">{qc?.summary.freeze ?? '—'}</p></div><div className="rounded-xl border border-white/8 p-2"><span className="text-slate-600">SILENCE</span><p className="mt-1 font-black text-slate-300">{qc?.summary.silence ?? '—'}</p></div></div><div className="mt-3 grid grid-cols-2 gap-2 text-[8px]"><div className="rounded-xl border border-white/8 p-2">LUFS<p className="mt-1 font-mono">{fmt(loudness?.integratedLufs)}</p></div><div className="rounded-xl border border-white/8 p-2">TRUE PEAK<p className="mt-1 font-mono">{fmt(loudness?.truePeakDbfs)} dBFS</p></div></div><button onClick={printReport} disabled={!inspection} className="mt-3 w-full rounded-xl border border-emerald-300/20 p-2 text-[8px] font-black text-emerald-100 disabled:opacity-30"><Printer className="mr-1 inline h-3.5 w-3.5"/>PRINT FINAL QC REPORT</button></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><p className="text-[10px] font-black tracking-widest text-slate-500">SMART MASTER DELIVERY</p><select value={preset} onChange={e=>setPreset(e.target.value as ExportPresetV14)} className="mt-3 w-full rounded-xl border border-white/10 bg-[#0b111d] p-2 text-[9px]">{presets.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select><button onClick={exportMaster} disabled={!file||!!busy} className="mt-3 w-full rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 p-3 text-[9px] font-black disabled:opacity-30">{busy==='master'?<Loader2 className="mr-1 inline h-4 w-4 animate-spin"/>:<Sparkles className="mr-1 inline h-4 w-4"/>}EXPORT SMART MASTER</button>{resultUrl&&<a href={resultUrl} download={`MAGHRABI-v16-${preset}.mp4`} className="mt-2 block rounded-xl border border-emerald-300/20 p-2 text-center text-[8px] font-black text-emerald-100"><Download className="mr-1 inline h-3.5 w-3.5"/>DOWNLOAD MASTER</a>}</div>

        {error&&<div className="rounded-2xl border border-rose-300/20 bg-rose-300/10 p-3 text-[9px] leading-5 text-rose-100">{error}</div>}
      </aside>
    </section>
  </div></main>
}
