import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  BarChart3,
  Download,
  Film,
  Gauge,
  Grid3X3,
  Headphones,
  Loader2,
  MonitorUp,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  UploadCloud,
  WandSparkles,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import { getVideoRenderResultV12, listVideoRenderJobsV12 } from './lib/videoApi'
import {
  analyzeAudioV14,
  AudioMasterSettingsV14,
  CurveBand,
  ExportPresetV14,
  GradeSettingsV14,
  LoudnessAnalysisV14,
  masterVideoV14,
  RGBBalance,
} from './lib/finishingApi'

type SafeOverlay = { action: boolean; title: boolean; guides: boolean }

type PresetInfo = {
  id: ExportPresetV14
  label: string
  format: string
  fps: string
  lufs: number
  note: string
}

const presetOptions: PresetInfo[] = [
  { id: 'youtube_1080', label: 'YouTube 1080p', format: '1920×1080', fps: '30 fps', lufs: -14, note: 'H.264 High · AAC 192k' },
  { id: 'tiktok', label: 'TikTok', format: '1080×1920', fps: '30 fps', lufs: -14, note: 'Vertical 9:16' },
  { id: 'instagram_reel', label: 'Instagram Reels', format: '1080×1920', fps: '30 fps', lufs: -14, note: 'Vertical 9:16' },
  { id: 'instagram_square', label: 'Instagram Square', format: '1080×1080', fps: '30 fps', lufs: -14, note: 'Square 1:1' },
  { id: 'broadcast_1080p25', label: 'Broadcast 1080p25', format: '1920×1080', fps: '25 fps', lufs: -23, note: 'Generic broadcast master' },
  { id: 'master_1080', label: 'Master 1080p', format: '1920×1080', fps: '30 fps', lufs: -14, note: 'High-quality archive master' },
]

const neutralBand: CurveBand = { shadows: 0, mids: 0, highlights: 0 }
const neutralRgb: RGBBalance = { r: 0, g: 0, b: 0 }
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

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)) }
function fmt(value: number | null | undefined, suffix = '') { return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}${suffix}` }

function ColorWheel({ label, value, onChange }: { label: string; value: RGBBalance; onChange: (value: RGBBalance) => void }) {
  const update = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    let x = ((event.clientX - rect.left) / rect.width - .5) * 2
    let y = ((event.clientY - rect.top) / rect.height - .5) * 2
    const length = Math.hypot(x, y)
    if (length > 1) { x /= length; y /= length }
    onChange({ r: clamp(x, -1, 1), g: clamp(-y, -1, 1), b: clamp(-x, -1, 1) })
  }
  return <div className="rounded-2xl border border-white/8 bg-black/20 p-3">
    <div className="flex items-center justify-between"><p className="text-[9px] font-black tracking-widest text-slate-400">{label}</p><button onClick={()=>onChange({ ...neutralRgb })} className="text-slate-600 hover:text-white"><RotateCcw className="h-3 w-3"/></button></div>
    <div onPointerDown={update} onPointerMove={e=>{if(e.buttons)update(e)}} className="relative mx-auto mt-3 aspect-square w-[126px] cursor-crosshair rounded-full border border-white/15 shadow-inner" style={{background:'radial-gradient(circle, rgba(255,255,255,.78) 0%, rgba(255,255,255,0) 52%), conic-gradient(#ff3948,#ffe23f,#48ff76,#35e7ff,#4f5cff,#ed45ff,#ff3948)'}}>
      <div className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-black shadow-lg" style={{left:`${50+value.r*42}%`,top:`${50-value.g*42}%`}}/>
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-px w-[88%] -translate-x-1/2 bg-white/10"/><div className="pointer-events-none absolute left-1/2 top-1/2 h-[88%] w-px -translate-y-1/2 bg-white/10"/>
    </div>
    <div className="mt-3 grid grid-cols-3 gap-1 text-center font-mono text-[7px]"><span className="text-rose-300">R {value.r.toFixed(2)}</span><span className="text-emerald-300">G {value.g.toFixed(2)}</span><span className="text-blue-300">B {value.b.toFixed(2)}</span></div>
  </div>
}

function CurveControl({ channel, value, onChange }: { channel: 'R'|'G'|'B'; value: CurveBand; onChange: (value: CurveBand) => void }) {
  const stroke = channel === 'R' ? '#fb7185' : channel === 'G' ? '#6ee7b7' : '#93c5fd'
  const y = (base: number, offset: number) => 100 - clamp(base + offset * 100, 0, 100)
  const points = `0,100 25,${y(25,value.shadows)} 50,${y(50,value.mids)} 75,${y(75,value.highlights)} 100,0`
  return <div className="rounded-xl border border-white/8 p-2">
    <div className="flex items-center gap-2"><span className="text-[9px] font-black" style={{color:stroke}}>{channel}</span><svg viewBox="0 0 100 100" className="h-16 flex-1 rounded-lg bg-black/30"><path d="M0 100 L100 0" stroke="rgba(255,255,255,.13)" strokeWidth="1"/><polyline points={points} fill="none" stroke={stroke} strokeWidth="2"/></svg></div>
    {(['shadows','mids','highlights'] as const).map(key=><label key={key} className="mt-1 grid grid-cols-[58px_1fr_34px] items-center gap-2 text-[7px] text-slate-600"><span>{key.toUpperCase().slice(0,4)}</span><input type="range" min="-.25" max=".25" step=".01" value={value[key]} onChange={e=>onChange({...value,[key]:Number(e.target.value)})} className="accent-violet-300"/><span className="font-mono text-slate-400">{value[key].toFixed(2)}</span></label>)}
  </div>
}

function Scopes({ video, grade }: { video: HTMLVideoElement | null; grade: GradeSettingsV14 }) {
  const waveformRef = useRef<HTMLCanvasElement>(null)
  const vectorRef = useRef<HTMLCanvasElement>(null)
  const histRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!video) return
    const render = () => {
      if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return
      const sample = document.createElement('canvas'); sample.width = 160; sample.height = 90
      const ctx = sample.getContext('2d', { willReadFrequently: true }); if (!ctx) return
      ctx.drawImage(video, 0, 0, sample.width, sample.height)
      const data = ctx.getImageData(0, 0, sample.width, sample.height).data
      const histogram = [new Array(64).fill(0), new Array(64).fill(0), new Array(64).fill(0)] as number[][]

      const wave = waveformRef.current?.getContext('2d'); const vector = vectorRef.current?.getContext('2d'); const hist = histRef.current?.getContext('2d')
      if (!wave || !vector || !hist) return
      const canvases = [wave, vector, hist]
      canvases.forEach(c=>{c.clearRect(0,0,c.canvas.width,c.canvas.height);c.fillStyle='#03060b';c.fillRect(0,0,c.canvas.width,c.canvas.height);c.strokeStyle='rgba(148,163,184,.12)';c.lineWidth=1;for(let i=1;i<4;i++){c.beginPath();c.moveTo(0,c.canvas.height*i/4);c.lineTo(c.canvas.width,c.canvas.height*i/4);c.stroke()}})

      const gamma = 2 ** (grade.gamma * .5)
      for (let py=0;py<90;py+=2) for (let px=0;px<160;px+=2) {
        const i=(py*160+px)*4
        let r=data[i], g=data[i+1], b=data[i+2]
        const l=.2126*r+.7152*g+.0722*b
        r=l+(r-l)*grade.saturation;g=l+(g-l)*grade.saturation;b=l+(b-l)*grade.saturation
        const apply=(v:number)=>clamp(Math.pow(clamp(((v-128)*grade.contrast+128+grade.brightness*255)/255,0,1),1/gamma)*255,0,255)
        r=apply(r);g=apply(g);b=apply(b)
        histogram[0][Math.min(63,Math.floor(r/4))]++;histogram[1][Math.min(63,Math.floor(g/4))]++;histogram[2][Math.min(63,Math.floor(b/4))]++
        const lum=.2126*r+.7152*g+.0722*b
        wave.fillStyle='rgba(110,231,183,.18)';wave.fillRect(px/160*wave.canvas.width,(1-lum/255)*wave.canvas.height,1.5,1.5)
        const cb=-.168736*r-.331264*g+.5*b+128, cr=.5*r-.418688*g-.081312*b+128
        vector.fillStyle='rgba(103,232,249,.18)';vector.fillRect(cb/255*vector.canvas.width,(1-cr/255)*vector.canvas.height,1.4,1.4)
      }
      const colors=['#fb7185','#6ee7b7','#93c5fd']
      histogram.forEach((bins,index)=>{const max=Math.max(...bins,1);hist.strokeStyle=colors[index];hist.beginPath();bins.forEach((v,i)=>{const x=i/(bins.length-1)*hist.canvas.width,y=hist.canvas.height-(v/max)*hist.canvas.height*.9;if(i===0)hist.moveTo(x,y);else hist.lineTo(x,y)});hist.stroke()})
      vector.strokeStyle='rgba(255,255,255,.18)';vector.beginPath();vector.arc(vector.canvas.width/2,vector.canvas.height/2,Math.min(vector.canvas.width,vector.canvas.height)*.38,0,Math.PI*2);vector.stroke()
    }
    render(); const timer=window.setInterval(render,700); return ()=>window.clearInterval(timer)
  }, [video, grade])

  return <div className="grid gap-2 lg:grid-cols-3">{[[waveformRef,'LUMA WAVEFORM'],[vectorRef,'VECTORSCOPE'],[histRef,'RGB HISTOGRAM']].map(([ref,label])=><div key={label as string} className="rounded-xl border border-white/8 bg-black/30 p-2"><canvas ref={ref as React.RefObject<HTMLCanvasElement>} width={320} height={150} className="h-[118px] w-full rounded-lg"/><p className="mt-1 text-center text-[7px] font-black tracking-widest text-slate-500">{label as string}</p></div>)}</div>
}

export default function VideoStudioV14() {
  const monitorRef = useRef<HTMLVideoElement>(null)
  const afterRef = useRef<HTMLVideoElement>(null)
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [grade, setGrade] = useState<GradeSettingsV14>(defaultGrade)
  const [audio, setAudio] = useState<AudioMasterSettingsV14>(defaultAudio)
  const [preset, setPreset] = useState<ExportPresetV14>('youtube_1080')
  const [safe, setSafe] = useState<SafeOverlay>({action:true,title:true,guides:true})
  const [compare, setCompare] = useState(50)
  const [analysis, setAnalysis] = useState<LoudnessAnalysisV14 | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [mastering, setMastering] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sourceLabel, setSourceLabel] = useState('')

  useEffect(()=>{getAuthStatus().then(s=>setAuthorized(s.authenticated)).catch(()=>setAuthorized(false))},[])
  useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);if(resultUrl)URL.revokeObjectURL(resultUrl)},[url,resultUrl])

  const selectedPreset = useMemo(()=>presetOptions.find(item=>item.id===preset) || presetOptions[0],[preset])
  const previewFilter = useMemo(()=>`brightness(${clamp(1+grade.brightness*.8,.5,1.5)}) contrast(${grade.contrast}) saturate(${grade.saturation})`,[grade.brightness,grade.contrast,grade.saturation])

  const useFile = (next: File, label?: string) => {
    if (url) URL.revokeObjectURL(url)
    const objectUrl=URL.createObjectURL(next);setFile(next);setUrl(objectUrl);setSourceLabel(label||next.name);setAnalysis(null);setResultUrl(null);setError(null)
  }
  const onUpload=(event:ChangeEvent<HTMLInputElement>)=>{const next=event.target.files?.[0];if(next)useFile(next);event.target.value=''}

  const loadLatestEdit=async()=>{
    try{
      setError(null)
      const jobs=await listVideoRenderJobsV12();const job=jobs.find(item=>item.resultReady&&item.status==='done')
      if(!job)throw new Error('لا توجد نتيجة Render مكتملة في Server Queue حتى الآن.')
      const blob=await getVideoRenderResultV12(job.id)
      useFile(new File([blob],`V13-edit-${job.id.slice(0,8)}.mp4`,{type:'video/mp4'}),`Latest Edit · ${job.name}`)
    }catch(e){setError(e instanceof Error?e.message:'تعذر تحميل آخر Render.')}
  }

  const analyze=async()=>{
    if(!file||analyzing)return;setAnalyzing(true);setError(null)
    try{setAnalysis(await analyzeAudioV14(file))}catch(e){setError(e instanceof Error?e.message:'تعذر تحليل LUFS.')}finally{setAnalyzing(false)}
  }
  const master=async()=>{
    if(!file||mastering)return;setMastering(true);setError(null)
    try{
      const blob=await masterVideoV14(file,grade,audio,preset)
      if(resultUrl)URL.revokeObjectURL(resultUrl)
      setResultUrl(URL.createObjectURL(blob))
    }catch(e){setError(e instanceof Error?e.message:'تعذر تنفيذ Mastering.')}finally{setMastering(false)}
  }
  const selectPreset=(id:ExportPresetV14)=>{
    const info=presetOptions.find(item=>item.id===id);setPreset(id);if(info)setAudio(state=>({...state,targetLufs:info.lufs}))
  }
  const resetGrade=()=>setGrade({brightness:0,contrast:1,saturation:1,gamma:0,lift:{...neutralRgb},gammaWheel:{...neutralRgb},gain:{...neutralRgb},curves:{r:{...neutralBand},g:{...neutralBand},b:{...neutralBand}}})

  const syncAfter=()=>{const a=monitorRef.current,b=afterRef.current;if(!a||!b)return;if(Math.abs(b.currentTime-a.currentTime)>.08){try{b.currentTime=a.currentTime}catch{}}if(!a.paused&&b.paused)b.play().catch(()=>undefined);if(a.paused&&!b.paused)b.pause()}

  if(authorized===null)return <div className="grid min-h-screen place-items-center bg-[#050710] text-cyan-200">جاري التحقق...</div>
  if(!authorized)return <div className="grid min-h-screen place-items-center bg-[#050710] text-white"><a href="#" className="rounded-2xl bg-white px-6 py-3 font-black text-black">العودة لتسجيل الدخول</a></div>

  return <main className="min-h-screen bg-[#050710] text-slate-100"><div className="mx-auto max-w-[2100px] px-3 py-3 md:px-5">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
      <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-fuchsia-400/10"><WandSparkles className="h-5 w-5 text-fuchsia-200"/></div><div><div className="flex items-center gap-2"><h1 className="text-lg font-black">MAGHRABI Video Studio</h1><span className="rounded-full border border-fuchsia-300/20 bg-fuchsia-300/[.06] px-2 py-1 text-[9px] font-black text-fuchsia-100">FINISHING V14</span></div><p className="mt-1 text-[10px] text-slate-500">Scopes · Lift/Gamma/Gain · RGB Curves · LUFS · EQ/Compression · Delivery Presets</p></div></div>
      <div className="flex flex-wrap gap-2"><label className="cursor-pointer rounded-xl border border-white/10 px-3 py-2 text-[9px] font-black"><UploadCloud className="mr-1 inline h-3.5 w-3.5"/>OPEN MASTER<input type="file" accept="video/*" className="hidden" onChange={onUpload}/></label><button onClick={loadLatestEdit} className="rounded-xl border border-cyan-300/20 px-3 py-2 text-[9px] font-black text-cyan-100"><MonitorUp className="mr-1 inline h-3.5 w-3.5"/>LOAD LATEST EDIT</button><a href="#video-v13" className="rounded-xl border border-white/10 px-3 py-2 text-[9px] font-black text-slate-400">V13 PRECISION EDITOR</a><button onClick={master} disabled={!file||mastering} className="rounded-xl bg-gradient-to-r from-fuchsia-500 to-violet-500 px-5 py-2 text-[10px] font-black disabled:opacity-30">{mastering?<><Loader2 className="mr-1 inline h-4 w-4 animate-spin"/>MASTERING...</>:<><Sparkles className="mr-1 inline h-4 w-4"/>EXPORT MASTER</>}</button></div>
    </header>

    <section className="mt-3 grid gap-3 2xl:grid-cols-[360px_minmax(0,1fr)_410px]">
      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">PRIMARY GRADE</p><p className="mt-1 max-w-[270px] truncate text-[8px] text-slate-600">{sourceLabel||'لم يتم فتح Master بعد'}</p></div><button onClick={resetGrade} className="text-slate-500 hover:text-white"><RotateCcw className="h-4 w-4"/></button></div>{([['BRIGHTNESS','brightness',-.5,.5,.01],['CONTRAST','contrast',.5,2,.01],['SATURATION','saturation',0,3,.02],['GAMMA','gamma',-1,1,.02]] as const).map(([label,key,min,max,step])=><label key={key} className="mt-3 block text-[8px] font-black text-slate-500">{label} · {grade[key].toFixed(2)}<input type="range" min={min} max={max} step={step} value={grade[key]} onChange={e=>setGrade(s=>({...s,[key]:Number(e.target.value)}))} className="mt-1 w-full accent-fuchsia-300"/></label>)}</div>
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><p className="text-[10px] font-black tracking-widest text-slate-500">COLOR WHEELS</p><div className="mt-3 grid gap-2"><ColorWheel label="LIFT / SHADOWS" value={grade.lift} onChange={value=>setGrade(s=>({...s,lift:value}))}/><ColorWheel label="GAMMA / MIDTONES" value={grade.gammaWheel} onChange={value=>setGrade(s=>({...s,gammaWheel:value}))}/><ColorWheel label="GAIN / HIGHLIGHTS" value={grade.gain} onChange={value=>setGrade(s=>({...s,gain:value}))}/></div></div>
      </aside>

      <div className="min-w-0 space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-black">COMPARISON MONITOR</p><p className="mt-1 text-[9px] text-slate-600">A/B Split · المعاينة تقريبية، FFmpeg هو المرجع النهائي</p></div><div className="flex items-center gap-2"><span className="text-[8px] text-slate-500">BEFORE</span><input type="range" min="0" max="100" value={compare} onChange={e=>setCompare(Number(e.target.value))} className="w-32 accent-fuchsia-300"/><span className="text-[8px] text-slate-500">AFTER</span></div></div><div className="relative aspect-video overflow-hidden rounded-2xl bg-black">{url?<><video ref={monitorRef} src={url} controls className="absolute inset-0 h-full w-full object-contain" onTimeUpdate={syncAfter} onPlay={()=>afterRef.current?.play().catch(()=>undefined)} onPause={()=>afterRef.current?.pause()}/><div className="pointer-events-none absolute inset-y-0 right-0 overflow-hidden" style={{width:`${100-compare}%`}}><video ref={afterRef} src={url} muted playsInline className="absolute right-0 top-0 h-full max-w-none object-contain" style={{width:`${compare===100?100:10000/(100-compare)}%`,filter:previewFilter}}/></div><div className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_12px_white]" style={{left:`${compare}%`}}/>{safe.action&&<div className="pointer-events-none absolute inset-[5%] border border-cyan-300/35"/>}{safe.title&&<div className="pointer-events-none absolute inset-[10%] border border-amber-300/35"/>}{safe.guides&&<><div className="pointer-events-none absolute left-1/2 top-0 h-full w-px bg-white/20"/><div className="pointer-events-none absolute left-0 top-1/2 h-px w-full bg-white/20"/></>}</>:<div className="grid h-full place-items-center text-center text-slate-700"><div><Film className="mx-auto h-12 w-12"/><p className="mt-3 text-[10px]">افتح Master أو حمّل آخر Edit من Server Queue</p></div></div>}</div><div className="mt-3 flex flex-wrap gap-2"><button onClick={()=>setSafe(s=>({...s,action:!s.action}))} className={`rounded-xl border px-3 py-2 text-[8px] font-black ${safe.action?'border-cyan-300/30 text-cyan-100':'border-white/8 text-slate-600'}`}>ACTION SAFE 90%</button><button onClick={()=>setSafe(s=>({...s,title:!s.title}))} className={`rounded-xl border px-3 py-2 text-[8px] font-black ${safe.title?'border-amber-300/30 text-amber-100':'border-white/8 text-slate-600'}`}>TITLE SAFE 80%</button><button onClick={()=>setSafe(s=>({...s,guides:!s.guides}))} className={`rounded-xl border px-3 py-2 text-[8px] font-black ${safe.guides?'border-white/20 text-white':'border-white/8 text-slate-600'}`}><Grid3X3 className="mr-1 inline h-3 w-3"/>GUIDES</button></div></div>

        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-black">VIDEO SCOPES</p><p className="mt-1 text-[9px] text-slate-600">Live browser sampling of the current frame</p></div><Activity className="h-4 w-4 text-emerald-300"/></div><Scopes video={monitorRef.current} grade={grade}/></div>

        <div className="rounded-3xl border border-white/10 bg-[#080d17] p-4"><div className="flex items-center justify-between"><div><p className="text-xs font-black">RGB CURVES</p><p className="mt-1 text-[9px] text-slate-600">Shadows · Midtones · Highlights per channel</p></div><BarChart3 className="h-4 w-4 text-fuchsia-300"/></div><div className="mt-3 grid gap-2 xl:grid-cols-3"><CurveControl channel="R" value={grade.curves.r} onChange={value=>setGrade(s=>({...s,curves:{...s.curves,r:value}}))}/><CurveControl channel="G" value={grade.curves.g} onChange={value=>setGrade(s=>({...s,curves:{...s.curves,g:value}}))}/><CurveControl channel="B" value={grade.curves.b} onChange={value=>setGrade(s=>({...s,curves:{...s.curves,b:value}}))}/></div></div>

        {resultUrl&&<div className="rounded-3xl border border-emerald-300/20 bg-emerald-300/[.04] p-4"><div className="flex items-center justify-between"><div><p className="text-xs font-black text-emerald-100">MASTER COMPLETE</p><p className="mt-1 text-[8px] text-emerald-300/60">{selectedPreset.label}</p></div><a href={resultUrl} download={`MAGHRABI-V14-${preset}.mp4`} className="rounded-xl bg-emerald-300/10 px-4 py-2 text-[9px] font-black text-emerald-100"><Download className="mr-1 inline h-4 w-4"/>DOWNLOAD</a></div><video src={resultUrl} controls className="mt-3 aspect-video w-full rounded-2xl bg-black object-contain"/></div>}
      </div>

      <aside className="space-y-3">
        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">AUDIO LOUDNESS</p><p className="mt-1 text-[8px] text-slate-600">EBU R128 analysis via FFmpeg</p></div><Headphones className="h-4 w-4 text-cyan-300"/></div><button onClick={analyze} disabled={!file||analyzing} className="mt-3 w-full rounded-xl border border-cyan-300/20 p-2 text-[8px] font-black text-cyan-100 disabled:opacity-30">{analyzing?<><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin"/>ANALYZING...</>:'ANALYZE LUFS / TRUE PEAK'}</button><div className="mt-3 grid grid-cols-3 gap-2">{[['I LUFS',fmt(analysis?.integratedLufs,'')],['LRA',fmt(analysis?.lra,' LU')],['TRUE PEAK',fmt(analysis?.truePeakDbfs,' dBFS')]].map(([label,value])=><div key={label} className="rounded-xl border border-white/8 bg-black/20 p-2 text-center"><p className="text-[7px] font-black text-slate-600">{label}</p><p className="mt-1 font-mono text-[11px] font-black text-cyan-100">{value}</p></div>)}</div>{analysis&&<p className={`mt-3 rounded-xl p-2 text-[8px] font-bold ${Math.abs((analysis.integratedLufs??audio.targetLufs)-audio.targetLufs)<=1?'bg-emerald-300/10 text-emerald-100':'bg-amber-300/10 text-amber-100'}`}>Target {audio.targetLufs.toFixed(0)} LUFS · Difference {analysis.integratedLufs===null?'—':`${(analysis.integratedLufs-audio.targetLufs).toFixed(1)} LU`}</p>}</div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-black tracking-widest text-slate-500">AUDIO MASTER</p><SlidersHorizontal className="h-4 w-4 text-cyan-300"/></div>{([['LOW 110 Hz','low'],['MID 1.2 kHz','mid'],['HIGH 8.5 kHz','high']] as const).map(([label,key])=><label key={key} className="mt-3 block text-[8px] font-black text-slate-500">{label} · {audio[key].toFixed(1)} dB<input type="range" min="-12" max="12" step=".5" value={audio[key]} onChange={e=>setAudio(s=>({...s,[key]:Number(e.target.value)}))} className="mt-1 w-full accent-cyan-300"/></label>)}<button onClick={()=>setAudio(s=>({...s,compressor:!s.compressor}))} className={`mt-4 w-full rounded-xl border p-2 text-[8px] font-black ${audio.compressor?'border-violet-300/30 bg-violet-300/10 text-violet-100':'border-white/8 text-slate-600'}`}>COMPRESSOR {audio.compressor?'ON':'OFF'}</button>{audio.compressor&&<div className="mt-2 grid grid-cols-2 gap-2"><label className="text-[7px] text-slate-600">THRESHOLD<input type="number" value={audio.thresholdDb} onChange={e=>setAudio(s=>({...s,thresholdDb:Number(e.target.value)}))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 p-2 text-[8px]"/></label><label className="text-[7px] text-slate-600">RATIO<input type="number" value={audio.ratio} step=".5" onChange={e=>setAudio(s=>({...s,ratio:Number(e.target.value)}))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 p-2 text-[8px]"/></label><label className="text-[7px] text-slate-600">ATTACK ms<input type="number" value={audio.attack} onChange={e=>setAudio(s=>({...s,attack:Number(e.target.value)}))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 p-2 text-[8px]"/></label><label className="text-[7px] text-slate-600">RELEASE ms<input type="number" value={audio.release} onChange={e=>setAudio(s=>({...s,release:Number(e.target.value)}))} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 p-2 text-[8px]"/></label></div>}<button onClick={()=>setAudio(s=>({...s,normalize:!s.normalize}))} className={`mt-3 w-full rounded-xl border p-2 text-[8px] font-black ${audio.normalize?'border-emerald-300/30 bg-emerald-300/10 text-emerald-100':'border-white/8 text-slate-600'}`}>LOUDNESS NORMALIZE {audio.normalize?'ON':'OFF'} · {audio.targetLufs.toFixed(0)} LUFS</button><button onClick={()=>setAudio(s=>({...s,limiter:!s.limiter}))} className={`mt-2 w-full rounded-xl border p-2 text-[8px] font-black ${audio.limiter?'border-amber-300/30 bg-amber-300/10 text-amber-100':'border-white/8 text-slate-600'}`}>TRUE PEAK LIMITER {audio.limiter?'ON':'OFF'} · {audio.ceilingDb.toFixed(1)} dB</button></div>

        <div className="rounded-3xl border border-white/10 bg-[#090e19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black tracking-widest text-slate-500">DELIVERY PRESETS</p><p className="mt-1 text-[8px] text-slate-600">Codec/size/fps/loudness target</p></div><Gauge className="h-4 w-4 text-fuchsia-300"/></div><div className="mt-3 space-y-2">{presetOptions.map(item=><button key={item.id} onClick={()=>selectPreset(item.id)} className={`w-full rounded-xl border p-3 text-left ${preset===item.id?'border-fuchsia-300/35 bg-fuchsia-300/10':'border-white/8 bg-black/10'}`}><div className="flex items-center justify-between"><span className="text-[9px] font-black">{item.label}</span><span className="font-mono text-[7px] text-fuchsia-200">{item.lufs} LUFS</span></div><p className="mt-1 text-[7px] text-slate-600">{item.format} · {item.fps} · {item.note}</p></button>)}</div></div>

        {error&&<div className="rounded-2xl border border-rose-300/20 bg-rose-300/10 p-3 text-[9px] leading-5 text-rose-200">{error}</div>}
      </aside>
    </section>
  </div></main>
}
