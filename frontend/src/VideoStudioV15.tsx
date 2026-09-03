import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  CheckCircle2,
  Download,
  Eye,
  Film,
  Gauge,
  Layers3,
  Loader2,
  MonitorCheck,
  ScanLine,
  Sparkles,
  UploadCloud,
  WandSparkles,
  Waves,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import { analyzeAudioV14, AudioMasterSettingsV14, ExportPresetV14, GradeSettingsV14, LoudnessAnalysisV14 } from './lib/finishingApi'
import { getVideoRenderResultV12, listVideoRenderJobsV12 } from './lib/videoApi'
import {
  AudioRepairV15,
  batchMasterV15,
  ColorModeV15,
  inspectSourceV15,
  masterVideoV15,
  PowerWindowV15,
  QCResultV15,
  runQCV15,
  SecondaryColorV15,
  SelectiveFamilyV15,
  shotMatchV15,
  ShotMatchResultV15,
  SourceInspectionV15,
} from './lib/advancedFinishingApi'

type RGB = { r: number; g: number; b: number }
type CurveBand = { shadows: number; mids: number; highlights: number }

type PresetInfo = { id: ExportPresetV14; label: string; format: string; lufs: number }
const presets: PresetInfo[] = [
  { id: 'youtube_1080', label: 'YouTube 1080p', format: '1920×1080 / 30', lufs: -14 },
  { id: 'tiktok', label: 'TikTok 9:16', format: '1080×1920 / 30', lufs: -14 },
  { id: 'instagram_reel', label: 'Instagram Reels', format: '1080×1920 / 30', lufs: -14 },
  { id: 'instagram_square', label: 'Instagram Square', format: '1080×1080 / 30', lufs: -14 },
  { id: 'broadcast_1080p25', label: 'Broadcast 1080p25', format: '1920×1080 / 25', lufs: -23 },
  { id: 'master_1080', label: 'Master 1080p', format: '1920×1080 / 30', lufs: -14 },
]
const neutralRgb: RGB = { r: 0, g: 0, b: 0 }
const neutralBand: CurveBand = { shadows: 0, mids: 0, highlights: 0 }
const defaultGrade: GradeSettingsV14 = {
  brightness: 0, contrast: 1, saturation: 1, gamma: 0,
  lift: { ...neutralRgb }, gammaWheel: { ...neutralRgb }, gain: { ...neutralRgb },
  curves: { r: { ...neutralBand }, g: { ...neutralBand }, b: { ...neutralBand } },
}
const defaultAudio: AudioMasterSettingsV14 = {
  low: 0, mid: 0, high: 0, compressor: true, thresholdDb: -18, ratio: 3,
  attack: 20, release: 250, limiter: true, ceilingDb: -1, normalize: true, targetLufs: -14,
}
const defaultSecondary: SecondaryColorV15 = { enabled: false, family: 'reds', cyan: 0, magenta: 0, yellow: 0, black: 0 }
const defaultWindow: PowerWindowV15 = { enabled: false, x: .2, y: .2, width: .5, height: .5, brightness: 0, contrast: 1, saturation: 1 }
const defaultRepair: AudioRepairV15 = { noiseReduction: false, noiseStrength: .35, deesser: false, deesserIntensity: .35, stereoWidth: 1 }
const families: SelectiveFamilyV15[] = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'neutrals']

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)) }
function fmt(value: number | null | undefined, suffix = '') { return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}${suffix}` }

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <label className="block text-[8px] font-black text-slate-500"><span className="flex justify-between"><span>{label}</span><span className="font-mono text-slate-300">{value.toFixed(step < .1 ? 2 : 1)}</span></span><input className="mt-1 w-full accent-fuchsia-300" type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))}/></label>
}

function ColorPad({ label, value, onChange }: { label: string; value: RGB; onChange: (value: RGB) => void }) {
  return <div className="rounded-2xl border border-white/8 bg-black/20 p-3"><div className="flex items-center justify-between"><p className="text-[8px] font-black tracking-widest text-slate-500">{label}</p><button onClick={()=>onChange({...neutralRgb})} className="text-[7px] text-slate-600">RESET</button></div><div className="mt-2 grid grid-cols-3 gap-2">{(['r','g','b'] as const).map(key=><label key={key} className="text-center text-[7px] font-black uppercase text-slate-600"><span className={key==='r'?'text-rose-300':key==='g'?'text-emerald-300':'text-blue-300'}>{key}</span><input type="range" min="-1" max="1" step=".02" value={value[key]} onChange={e=>onChange({...value,[key]:Number(e.target.value)})} className="mt-1 w-full accent-white"/><span className="font-mono text-slate-400">{value[key].toFixed(2)}</span></label>)}</div></div>
}

export default function VideoStudioV15() {
  const monitorRef = useRef<HTMLVideoElement>(null)
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [referenceFile, setReferenceFile] = useState<File | null>(null)
  const [inspection, setInspection] = useState<SourceInspectionV15 | null>(null)
  const [qc, setQc] = useState<QCResultV15 | null>(null)
  const [loudness, setLoudness] = useState<LoudnessAnalysisV14 | null>(null)
  const [shotMatch, setShotMatch] = useState<ShotMatchResultV15 | null>(null)
  const [grade, setGrade] = useState<GradeSettingsV14>(defaultGrade)
  const [audio, setAudio] = useState<AudioMasterSettingsV14>(defaultAudio)
  const [secondary, setSecondary] = useState<SecondaryColorV15>(defaultSecondary)
  const [windowSettings, setWindowSettings] = useState<PowerWindowV15>(defaultWindow)
  const [repair, setRepair] = useState<AudioRepairV15>(defaultRepair)
  const [colorMode, setColorMode] = useState<ColorModeV15>('auto')
  const [preset, setPreset] = useState<ExportPresetV14>('youtube_1080')
  const [batchPresets, setBatchPresets] = useState<ExportPresetV14[]>(['youtube_1080', 'instagram_reel'])
  const [busy, setBusy] = useState<'inspect'|'qc'|'loudness'|'match'|'master'|'batch'|null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [sourceLabel, setSourceLabel] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(()=>{getAuthStatus().then(s=>setAuthorized(s.authenticated)).catch(()=>setAuthorized(false))},[])
  useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);if(resultUrl)URL.revokeObjectURL(resultUrl)},[url,resultUrl])

  const selectedPreset = useMemo(()=>presets.find(item=>item.id===preset) || presets[0],[preset])
  const previewFilter = useMemo(()=>`brightness(${clamp(1+grade.brightness*.8,.5,1.5)}) contrast(${grade.contrast}) saturate(${grade.saturation})`,[grade])

  const useSource = async (next: File, label?: string) => {
    if (url) URL.revokeObjectURL(url)
    setFile(next); setUrl(URL.createObjectURL(next)); setSourceLabel(label || next.name); setInspection(null); setQc(null); setLoudness(null); setShotMatch(null); setResultUrl(null); setError(null)
    setBusy('inspect')
    try { setInspection(await inspectSourceV15(next)) } catch (e) { setError(e instanceof Error ? e.message : 'تعذر فحص المصدر.') } finally { setBusy(null) }
  }
  const onUpload = (event: ChangeEvent<HTMLInputElement>) => { const next=event.target.files?.[0]; if(next)useSource(next).catch(()=>undefined); event.target.value='' }
  const loadLatest = async () => {
    try {
      setError(null); const jobs=await listVideoRenderJobsV12(); const job=jobs.find(item=>item.status==='done'&&item.resultReady)
      if(!job)throw new Error('لا يوجد Render مكتمل في Server Queue.')
      const blob=await getVideoRenderResultV12(job.id)
      await useSource(new File([blob],`V14-edit-${job.id.slice(0,8)}.mp4`,{type:'video/mp4'}),`Latest Edit · ${job.name}`)
    } catch(e){setError(e instanceof Error?e.message:'تعذر تحميل آخر Render.')}
  }

  const analyzeLoudness = async () => {
    if(!file)return; setBusy('loudness'); setError(null)
    try{setLoudness(await analyzeAudioV14(file))}catch(e){setError(e instanceof Error?e.message:'تعذر تحليل الصوت.')}finally{setBusy(null)}
  }
  const runQc = async () => {
    if(!file)return; setBusy('qc'); setError(null)
    try{setQc(await runQCV15(file))}catch(e){setError(e instanceof Error?e.message:'تعذر فحص QC.')}finally{setBusy(null)}
  }
  const matchShot = async () => {
    if(!file||!referenceFile)return; setBusy('match'); setError(null)
    try{
      const result=await shotMatchV15(file,referenceFile,monitorRef.current?.currentTime||0,0); setShotMatch(result)
      setGrade(state=>({...state,brightness:result.suggestion.brightness,saturation:result.suggestion.saturation,gammaWheel:result.suggestion.gammaWheel}))
    }catch(e){setError(e instanceof Error?e.message:'تعذر Shot Match.')}finally{setBusy(null)}
  }
  const exportMaster = async () => {
    if(!file)return; setBusy('master'); setError(null)
    try{
      const blob=await masterVideoV15(file,grade,{...audio,targetLufs:selectedPreset.lufs},secondary,windowSettings,repair,colorMode,preset)
      if(resultUrl)URL.revokeObjectURL(resultUrl); setResultUrl(URL.createObjectURL(blob))
    }catch(e){setError(e instanceof Error?e.message:'تعذر تصدير Master V15.')}finally{setBusy(null)}
  }
  const exportBatch = async () => {
    if(!file||!batchPresets.length)return; setBusy('batch'); setError(null)
    try{
      const blob=await batchMasterV15(file,grade,audio,secondary,windowSettings,repair,colorMode,batchPresets)
      const objectUrl=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=objectUrl; a.download='MAGHRABI-v15-batch-delivery.zip'; a.click(); window.setTimeout(()=>URL.revokeObjectURL(objectUrl),60000)
    }catch(e){setError(e instanceof Error?e.message:'تعذر Batch Delivery.')}finally{setBusy(null)}
  }
  const downloadMaster = () => { if(!resultUrl)return; const a=document.createElement('a');a.href=resultUrl;a.download=`MAGHRABI-v15-${preset}.mp4`;a.click() }
  const toggleBatch=(id:ExportPresetV14)=>setBatchPresets(state=>state.includes(id)?state.filter(item=>item!==id):state.length<6?[...state,id]:state)

  if(authorized===null)return <div className="grid min-h-screen place-items-center bg-[#04060c] text-fuchsia-200">جاري التحقق...</div>
  if(!authorized)return <div className="grid min-h-screen place-items-center bg-[#04060c] text-white"><a href="#" className="rounded-2xl bg-white px-6 py-3 font-black text-black">العودة لتسجيل الدخول</a></div>

  return <main className="min-h-screen bg-[#04060c] text-slate-100"><div className="mx-auto max-w-[2050px] px-3 py-3 md:px-5">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3"><div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-fuchsia-400/10"><Sparkles className="h-5 w-5 text-fuchsia-200"/></div><div><div className="flex items-center gap-2"><h1 className="text-lg font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-fuchsia-300/20 bg-fuchsia-300/[.06] px-2 py-1 text-[9px] font-black text-fuchsia-100">ADVANCED FINISHING V15</span></div><p className="mt-1 text-[10px] text-slate-500">HDR-aware · Selective Color · Power Window · Shot Match · Audio Repair · QC · Batch Delivery</p></div></div><div className="flex flex-wrap gap-2"><button onClick={loadLatest} className="rounded-xl border border-white/10 px-3 py-2 text-[9px] font-black">LOAD LATEST EDIT</button><label className="cursor-pointer rounded-xl border border-fuchsia-300/20 px-3 py-2 text-[9px] font-black"><UploadCloud className="mr-1 inline h-3.5 w-3.5"/>OPEN MASTER<input type="file" accept="video/*" className="hidden" onChange={onUpload}/></label><a href="#video-v14" className="rounded-xl border border-white/10 px-3 py-2 text-[9px] font-black text-slate-500">V14 FINISHING</a></div></header>

    <section className="mt-3 grid gap-3 2xl:grid-cols-[350px_minmax(0,1fr)_410px]">
      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090d16] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">SOURCE / COLOR MANAGEMENT</p><MonitorCheck className="h-4 w-4 text-emerald-300"/></div><p className="mt-3 truncate text-[9px] font-black">{sourceLabel||'لا يوجد Master محمل'}</p>{inspection?<div className="mt-3 grid grid-cols-2 gap-2 text-[8px]"><div className="rounded-xl border border-white/8 p-2"><span className="text-slate-600">FORMAT</span><p className="mt-1 font-mono">{inspection.color.width||'—'}×{inspection.color.height||'—'}</p></div><div className="rounded-xl border border-white/8 p-2"><span className="text-slate-600">HDR</span><p className={`mt-1 font-black ${inspection.color.isHdr?'text-amber-200':'text-emerald-200'}`}>{inspection.color.isHdr?'HDR DETECTED':'SDR'}</p></div><div className="rounded-xl border border-white/8 p-2"><span className="text-slate-600">PRIMARIES</span><p className="mt-1 font-mono">{inspection.color.primaries||'unknown'}</p></div><div className="rounded-xl border border-white/8 p-2"><span className="text-slate-600">TRANSFER</span><p className="mt-1 font-mono">{inspection.color.transfer||'unknown'}</p></div></div>:<p className="mt-3 text-[8px] text-slate-600">ارفع ملفًا لقراءة Color Metadata.</p>}<label className="mt-3 block text-[8px] font-black text-slate-500">COLOR MODE<select value={colorMode} onChange={e=>setColorMode(e.target.value as ColorModeV15)} className="mt-1 w-full rounded-xl border border-white/10 bg-[#0b111d] p-2 text-[9px]"><option value="auto">Auto / Preserve HDR</option><option value="rec709">Force Rec.709 SDR metadata</option><option value="hdr_to_sdr">HDR → SDR Tone Map</option></select></label>{inspection?.color.isHdr&&colorMode==='auto'&&<div className="mt-2 rounded-xl border border-amber-300/20 bg-amber-300/10 p-2 text-[8px] leading-4 text-amber-100">المصدر HDR. Auto يحافظ على المظهر ولا ينفذ Tone Map. اختر HDR→SDR للتسليم SDR.</div>}</div>

        <div className="rounded-3xl border border-white/10 bg-[#090d16] p-4"><p className="text-[10px] font-black tracking-widest text-slate-500">PRIMARY GRADE</p><div className="mt-3 space-y-3"><Slider label="BRIGHTNESS" value={grade.brightness} min={-.5} max={.5} step={.01} onChange={v=>setGrade(s=>({...s,brightness:v}))}/><Slider label="CONTRAST" value={grade.contrast} min={.5} max={2} step={.01} onChange={v=>setGrade(s=>({...s,contrast:v}))}/><Slider label="SATURATION" value={grade.saturation} min={0} max={3} step={.01} onChange={v=>setGrade(s=>({...s,saturation:v}))}/><Slider label="GAMMA" value={grade.gamma} min={-1} max={1} step={.01} onChange={v=>setGrade(s=>({...s,gamma:v}))}/></div><div className="mt-3 space-y-2"><ColorPad label="LIFT" value={grade.lift} onChange={v=>setGrade(s=>({...s,lift:v}))}/><ColorPad label="GAMMA / MID" value={grade.gammaWheel} onChange={v=>setGrade(s=>({...s,gammaWheel:v}))}/><ColorPad label="GAIN" value={grade.gain} onChange={v=>setGrade(s=>({...s,gain:v}))}/></div></div>
      </aside>

      <div className="min-w-0 space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#080c14] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-black">ADVANCED PROGRAM MONITOR</p><p className="mt-1 text-[9px] text-slate-600">Preview تقريبي · FFmpeg هو المرجع النهائي للتصدير</p></div><Eye className="h-4 w-4 text-fuchsia-300"/></div><div className="relative mx-auto aspect-video max-h-[620px] overflow-hidden rounded-2xl bg-black">{url?<video ref={monitorRef} src={url} controls className="h-full w-full object-contain" style={{filter:previewFilter}}/>:<div className="grid h-full place-items-center"><Film className="h-14 w-14 text-slate-800"/></div>}{windowSettings.enabled&&<div className="pointer-events-none absolute border-2 border-amber-300/80 shadow-[0_0_0_9999px_rgba(0,0,0,.08)]" style={{left:`${windowSettings.x*100}%`,top:`${windowSettings.y*100}%`,width:`${Math.min(windowSettings.width,1-windowSettings.x)*100}%`,height:`${Math.min(windowSettings.height,1-windowSettings.y)*100}%`}}><span className="absolute -top-5 left-0 rounded bg-amber-300 px-1.5 py-0.5 text-[7px] font-black text-black">POWER WINDOW</span></div>}<div className="pointer-events-none absolute inset-[5%] border border-white/15"/><div className="pointer-events-none absolute inset-[10%] border border-white/10"/><div className="pointer-events-none absolute left-1/2 top-0 h-full w-px bg-white/8"/><div className="pointer-events-none absolute left-0 top-1/2 h-px w-full bg-white/8"/></div></div>

        <div className="grid gap-3 xl:grid-cols-2"><div className="rounded-3xl border border-white/10 bg-[#090d16] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">SECONDARY / SELECTIVE COLOR</p><ScanLine className="h-4 w-4 text-cyan-300"/></div><button onClick={()=>setSecondary(s=>({...s,enabled:!s.enabled}))} className={`mt-3 w-full rounded-xl border p-2 text-[9px] font-black ${secondary.enabled?'border-cyan-300/35 bg-cyan-300/10 text-cyan-100':'border-white/10 text-slate-600'}`}>SELECTIVE COLOR {secondary.enabled?'ON':'OFF'}</button><select value={secondary.family} onChange={e=>setSecondary(s=>({...s,family:e.target.value as SelectiveFamilyV15}))} className="mt-2 w-full rounded-xl border border-white/10 bg-[#0b111d] p-2 text-[9px]">{families.map(item=><option key={item} value={item}>{item.toUpperCase()}</option>)}</select><div className="mt-3 space-y-2"><Slider label="CYAN" value={secondary.cyan} min={-1} max={1} step={.01} onChange={v=>setSecondary(s=>({...s,cyan:v}))}/><Slider label="MAGENTA" value={secondary.magenta} min={-1} max={1} step={.01} onChange={v=>setSecondary(s=>({...s,magenta:v}))}/><Slider label="YELLOW" value={secondary.yellow} min={-1} max={1} step={.01} onChange={v=>setSecondary(s=>({...s,yellow:v}))}/><Slider label="BLACK" value={secondary.black} min={-1} max={1} step={.01} onChange={v=>setSecondary(s=>({...s,black:v}))}/></div></div>

          <div className="rounded-3xl border border-white/10 bg-[#090d16] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">POWER WINDOW</p><Layers3 className="h-4 w-4 text-amber-300"/></div><button onClick={()=>setWindowSettings(s=>({...s,enabled:!s.enabled}))} className={`mt-3 w-full rounded-xl border p-2 text-[9px] font-black ${windowSettings.enabled?'border-amber-300/35 bg-amber-300/10 text-amber-100':'border-white/10 text-slate-600'}`}>RECTANGLE WINDOW {windowSettings.enabled?'ON':'OFF'}</button><div className="mt-3 grid grid-cols-2 gap-2"><Slider label="X" value={windowSettings.x} min={0} max={.95} step={.01} onChange={v=>setWindowSettings(s=>({...s,x:v}))}/><Slider label="Y" value={windowSettings.y} min={0} max={.95} step={.01} onChange={v=>setWindowSettings(s=>({...s,y:v}))}/><Slider label="WIDTH" value={windowSettings.width} min={.05} max={1} step={.01} onChange={v=>setWindowSettings(s=>({...s,width:v}))}/><Slider label="HEIGHT" value={windowSettings.height} min={.05} max={1} step={.01} onChange={v=>setWindowSettings(s=>({...s,height:v}))}/></div><div className="mt-3 space-y-2"><Slider label="LOCAL BRIGHTNESS" value={windowSettings.brightness} min={-.5} max={.5} step={.01} onChange={v=>setWindowSettings(s=>({...s,brightness:v}))}/><Slider label="LOCAL CONTRAST" value={windowSettings.contrast} min={.5} max={2} step={.01} onChange={v=>setWindowSettings(s=>({...s,contrast:v}))}/><Slider label="LOCAL SATURATION" value={windowSettings.saturation} min={0} max={3} step={.01} onChange={v=>setWindowSettings(s=>({...s,saturation:v}))}/></div><p className="mt-2 text-[7px] leading-4 text-slate-600">V15 ينفذ Rectangular Power Window حقيقية. Feather/Bezier Mask ليست مفعلة بعد.</p></div></div>

        <div className="grid gap-3 xl:grid-cols-2"><div className="rounded-3xl border border-white/10 bg-[#090d16] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">SHOT MATCH ASSIST</p><WandSparkles className="h-4 w-4 text-violet-300"/></div><label className="mt-3 block cursor-pointer rounded-xl border border-dashed border-violet-300/20 p-3 text-center text-[8px] font-black">{referenceFile?referenceFile.name:'REFERENCE SHOT'}<input type="file" accept="video/*" className="hidden" onChange={e=>{setReferenceFile(e.target.files?.[0]||null);e.target.value=''}}/></label><button disabled={!file||!referenceFile||busy==='match'} onClick={matchShot} className="mt-2 w-full rounded-xl bg-violet-300/10 p-2 text-[8px] font-black text-violet-100 disabled:opacity-30">{busy==='match'?'MATCHING...':'MATCH CURRENT FRAME'}</button>{shotMatch&&<div className="mt-3 rounded-xl border border-violet-300/10 p-3 text-[8px] leading-5 text-slate-400"><p>Brightness: {shotMatch.suggestion.brightness.toFixed(3)}</p><p>Saturation: {shotMatch.suggestion.saturation.toFixed(2)}</p><p>Gamma RGB: {shotMatch.suggestion.gammaWheel.r.toFixed(2)} / {shotMatch.suggestion.gammaWheel.g.toFixed(2)} / {shotMatch.suggestion.gammaWheel.b.toFixed(2)}</p><p className="mt-1 text-[7px] text-slate-600">{shotMatch.note}</p></div>}</div>

          <div className="rounded-3xl border border-white/10 bg-[#090d16] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">AUDIO REPAIR</p><Waves className="h-4 w-4 text-cyan-300"/></div><button onClick={()=>setRepair(s=>({...s,noiseReduction:!s.noiseReduction}))} className={`mt-3 w-full rounded-xl border p-2 text-[8px] font-black ${repair.noiseReduction?'border-cyan-300/35 bg-cyan-300/10':'border-white/10'}`}>NOISE REDUCTION {repair.noiseReduction?'ON':'OFF'}</button><Slider label="NOISE STRENGTH" value={repair.noiseStrength} min={.01} max={.95} step={.01} onChange={v=>setRepair(s=>({...s,noiseStrength:v}))}/><button onClick={()=>setRepair(s=>({...s,deesser:!s.deesser}))} className={`mt-3 w-full rounded-xl border p-2 text-[8px] font-black ${repair.deesser?'border-cyan-300/35 bg-cyan-300/10':'border-white/10'}`}>DE-ESSER {repair.deesser?'ON':'OFF'}</button><Slider label="DE-ESSER INTENSITY" value={repair.deesserIntensity} min={0} max={1} step={.01} onChange={v=>setRepair(s=>({...s,deesserIntensity:v}))}/><Slider label="STEREO WIDTH" value={repair.stereoWidth} min={0} max={2.5} step={.01} onChange={v=>setRepair(s=>({...s,stereoWidth:v}))}/><div className="mt-3 grid grid-cols-3 gap-2"><Slider label="LOW EQ" value={audio.low} min={-12} max={12} step={.5} onChange={v=>setAudio(s=>({...s,low:v}))}/><Slider label="MID EQ" value={audio.mid} min={-12} max={12} step={.5} onChange={v=>setAudio(s=>({...s,mid:v}))}/><Slider label="HIGH EQ" value={audio.high} min={-12} max={12} step={.5} onChange={v=>setAudio(s=>({...s,high:v}))}/></div></div></div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090d16] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">QUALITY CONTROL GATE</p><Activity className="h-4 w-4 text-emerald-300"/></div><div className="mt-3 grid grid-cols-2 gap-2"><button disabled={!file||busy==='qc'} onClick={runQc} className="rounded-xl border border-emerald-300/20 p-2 text-[8px] font-black text-emerald-100 disabled:opacity-30">{busy==='qc'?'SCANNING...':'RUN VIDEO QC'}</button><button disabled={!file||busy==='loudness'} onClick={analyzeLoudness} className="rounded-xl border border-cyan-300/20 p-2 text-[8px] font-black text-cyan-100 disabled:opacity-30">{busy==='loudness'?'ANALYZING...':'LUFS / TRUE PEAK'}</button></div>{qc&&<div className="mt-3"><div className="grid grid-cols-3 gap-2 text-center"><div className="rounded-xl border border-white/8 p-2"><p className="text-lg font-black text-amber-200">{qc.summary.black}</p><p className="text-[7px] text-slate-600">BLACK</p></div><div className="rounded-xl border border-white/8 p-2"><p className="text-lg font-black text-violet-200">{qc.summary.freeze}</p><p className="text-[7px] text-slate-600">FREEZE</p></div><div className="rounded-xl border border-white/8 p-2"><p className="text-lg font-black text-cyan-200">{qc.summary.silence}</p><p className="text-[7px] text-slate-600">SILENCE</p></div></div><div className="mt-2 max-h-40 space-y-1 overflow-auto">{qc.issues.slice(0,20).map((issue,index)=><div key={`${issue.type}-${index}`} className="flex justify-between rounded-lg border border-white/7 px-2 py-1.5 text-[7px]"><span className="font-black uppercase">{issue.type}</span><span className="font-mono text-slate-500">{issue.start.toFixed(1)}s → {issue.end.toFixed(1)}s</span></div>)}</div></div>}{loudness&&<div className="mt-3 grid grid-cols-3 gap-2 text-center text-[8px]"><div className="rounded-xl border border-white/8 p-2"><p className="font-mono text-cyan-100">{fmt(loudness.integratedLufs)}</p><p className="text-[7px] text-slate-600">LUFS-I</p></div><div className="rounded-xl border border-white/8 p-2"><p className="font-mono text-cyan-100">{fmt(loudness.lra)}</p><p className="text-[7px] text-slate-600">LRA</p></div><div className="rounded-xl border border-white/8 p-2"><p className="font-mono text-cyan-100">{fmt(loudness.truePeakDbfs,' dB')}</p><p className="text-[7px] text-slate-600">TRUE PEAK</p></div></div>}</div>

        <div className="rounded-3xl border border-white/10 bg-[#090d16] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">DELIVERY MASTER</p><Gauge className="h-4 w-4 text-fuchsia-300"/></div><select value={preset} onChange={e=>setPreset(e.target.value as ExportPresetV14)} className="mt-3 w-full rounded-xl border border-white/10 bg-[#0b111d] p-2 text-[9px]">{presets.map(item=><option key={item.id} value={item.id}>{item.label} · {item.format}</option>)}</select><div className="mt-2 rounded-xl border border-white/8 p-2 text-[8px] text-slate-500">Target loudness: <span className="font-black text-white">{selectedPreset.lufs} LUFS</span></div><button disabled={!file||busy==='master'} onClick={exportMaster} className="mt-3 w-full rounded-xl bg-gradient-to-r from-fuchsia-500 to-violet-500 p-3 text-[9px] font-black disabled:opacity-30">{busy==='master'?<><Loader2 className="mr-1 inline h-4 w-4 animate-spin"/>MASTERING...</>:<>EXPORT V15 MASTER</>}</button>{resultUrl&&<><video src={resultUrl} controls className="mt-3 w-full rounded-xl bg-black"/><button onClick={downloadMaster} className="mt-2 w-full rounded-xl bg-emerald-300/10 p-2 text-[8px] font-black text-emerald-100"><Download className="mr-1 inline h-3 w-3"/>DOWNLOAD MASTER</button></>}</div>

        <div className="rounded-3xl border border-white/10 bg-[#090d16] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">BATCH DELIVERY</p><p className="mt-1 text-[7px] text-slate-600">نفس Grade/Master إلى عدة منصات في ZIP واحد.</p></div><CheckCircle2 className="h-4 w-4 text-emerald-300"/></div><div className="mt-3 space-y-1">{presets.map(item=><button key={item.id} onClick={()=>toggleBatch(item.id)} className={`flex w-full items-center justify-between rounded-lg border p-2 text-[8px] ${batchPresets.includes(item.id)?'border-emerald-300/30 bg-emerald-300/10 text-emerald-100':'border-white/8 text-slate-500'}`}><span className="font-black">{item.label}</span><span>{batchPresets.includes(item.id)?'✓':'+'}</span></button>)}</div><button disabled={!file||!batchPresets.length||busy==='batch'} onClick={exportBatch} className="mt-3 w-full rounded-xl border border-emerald-300/25 bg-emerald-300/10 p-3 text-[9px] font-black text-emerald-100 disabled:opacity-30">{busy==='batch'?'CREATING BATCH...':`BATCH EXPORT · ${batchPresets.length} PRESETS`}</button></div>

        {inspection&&<div className="rounded-3xl border border-white/10 bg-[#090d16] p-4"><p className="text-[10px] font-black tracking-widest text-slate-500">ENGINE CAPABILITIES</p><div className="mt-3 grid grid-cols-2 gap-2">{Object.entries(inspection.filters).map(([name,ok])=><div key={name} className={`rounded-lg border p-2 text-[8px] ${ok?'border-emerald-300/15 text-emerald-200':'border-rose-300/15 text-rose-200'}`}><span className="font-mono">{name}</span><span className="float-right">{ok?'READY':'N/A'}</span></div>)}</div></div>}
        {error&&<div className="rounded-2xl border border-rose-300/20 bg-rose-300/10 p-3 text-[9px] leading-5 text-rose-200">{error}</div>}
      </aside>
    </section>
  </div></main>
}
