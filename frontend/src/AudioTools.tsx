import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  AudioLines,
  CheckCircle2,
  Download,
  FileAudio,
  Layers3,
  Scissors,
  Sparkles,
  UploadCloud,
} from 'lucide-react'
import { getAuthStatus } from './lib/api'
import {
  convertAudio,
  EnhanceProfile,
  enhanceAudio,
  mergeAudio,
  OutputFormat,
  trimAudio,
} from './lib/toolsApi'

type Tool = 'trim' | 'merge' | 'enhance' | 'convert'

type ResultFile = {
  url: string
  name: string
}

const toolCards: Array<{ id: Tool; title: string; subtitle: string; icon: typeof Scissors }> = [
  { id: 'trim', title: 'قص الصوت', subtitle: 'حدد البداية والنهاية مع Fade احترافي', icon: Scissors },
  { id: 'merge', title: 'دمج الملفات', subtitle: 'ادمج عدة مقاطع بالترتيب في ملف واحد', icon: Layers3 },
  { id: 'enhance', title: 'تحسين الصوت', subtitle: 'تنقية، ضغط ديناميكي وNormalize', icon: Sparkles },
  { id: 'convert', title: 'تحويل الصيغة', subtitle: 'MP3 · WAV · M4A · FLAC', icon: FileAudio },
]

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function NumberField({ label, value, onChange, min = 0, step = 0.1 }: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  step?: number
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-bold text-slate-400">{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-300/35"
      />
    </label>
  )
}

function FormatField({ value, onChange }: { value: OutputFormat; onChange: (format: OutputFormat) => void }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-bold text-slate-400">صيغة الإخراج</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as OutputFormat)}
        className="w-full rounded-2xl border border-white/10 bg-[#0b1120] px-4 py-3 text-sm text-white outline-none focus:border-cyan-300/35"
      >
        <option value="mp3">MP3 · 320 kbps</option>
        <option value="wav">WAV · PCM</option>
        <option value="m4a">M4A · AAC</option>
        <option value="flac">FLAC · Lossless</option>
      </select>
    </label>
  )
}

function FilePicker({ multiple = false, files, onChange }: {
  multiple?: boolean
  files: File[]
  onChange: (files: File[]) => void
}) {
  const change = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(Array.from(event.target.files || []))
  }
  return (
    <label className="block cursor-pointer rounded-3xl border border-dashed border-white/15 bg-white/[.025] p-5 transition hover:border-cyan-300/35 hover:bg-cyan-300/[.03]">
      <input className="hidden" type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg" multiple={multiple} onChange={change} />
      <div className="flex items-center gap-4">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-cyan-300/[.08] text-cyan-200">
          <UploadCloud className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-black">{files.length ? `${files.length} ملف محدد` : multiple ? 'اختر ملفات صوتية' : 'اختر ملفًا صوتيًا'}</p>
          <p className="mt-1 truncate text-xs text-slate-500">
            {files.length ? files.map((file) => file.name).join(' · ') : 'MP3 · WAV · FLAC · M4A · AAC · OGG'}
          </p>
        </div>
      </div>
      {files.length > 0 && (
        <div className="mt-4 space-y-2">
          {files.slice(0, 8).map((file, index) => (
            <div key={`${file.name}-${index}`} className="flex items-center justify-between rounded-xl bg-black/20 px-3 py-2 text-xs">
              <span className="truncate text-slate-300">{index + 1}. {file.name}</span>
              <span className="shrink-0 text-slate-600">{formatSize(file.size)}</span>
            </div>
          ))}
        </div>
      )}
    </label>
  )
}

export default function AudioTools() {
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [tool, setTool] = useState<Tool>('trim')
  const [files, setFiles] = useState<File[]>([])
  const [format, setFormat] = useState<OutputFormat>('mp3')
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(30)
  const [fadeIn, setFadeIn] = useState(0)
  const [fadeOut, setFadeOut] = useState(0)
  const [profile, setProfile] = useState<EnhanceProfile>('voice')
  const [normalize, setNormalize] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ResultFile | null>(null)

  useEffect(() => {
    getAuthStatus()
      .then((status) => setAuthorized(status.authenticated))
      .catch(() => setAuthorized(false))
  }, [])

  useEffect(() => () => {
    if (result?.url) URL.revokeObjectURL(result.url)
  }, [result?.url])

  const current = useMemo(() => toolCards.find((item) => item.id === tool)!, [tool])

  const chooseTool = (next: Tool) => {
    setTool(next)
    setFiles([])
    setError(null)
    if (result?.url) URL.revokeObjectURL(result.url)
    setResult(null)
  }

  const run = async (event: FormEvent) => {
    event.preventDefault()
    if (!files.length) {
      setError('اختر الملف الصوتي أولًا.')
      return
    }
    setBusy(true)
    setError(null)
    if (result?.url) URL.revokeObjectURL(result.url)
    setResult(null)

    try {
      let blob: Blob
      let name: string
      if (tool === 'trim') {
        blob = await trimAudio({ file: files[0], startSeconds: start, endSeconds: end, fadeIn, fadeOut, outputFormat: format })
        name = `MAGHRABI-trimmed.${format}`
      } else if (tool === 'merge') {
        blob = await mergeAudio(files, format)
        name = `MAGHRABI-merged.${format}`
      } else if (tool === 'enhance') {
        blob = await enhanceAudio({ file: files[0], profile, normalize, fadeIn, fadeOut, outputFormat: format })
        name = `MAGHRABI-enhanced-${profile}.${format}`
      } else {
        blob = await convertAudio(files[0], format)
        name = `MAGHRABI-converted.${format}`
      }
      setResult({ url: URL.createObjectURL(blob), name })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'تعذر تنفيذ العملية.')
    } finally {
      setBusy(false)
    }
  }

  if (authorized === null) {
    return <div className="grid min-h-screen place-items-center bg-[#070b14] text-slate-400"><Activity className="h-6 w-6 animate-spin text-cyan-300" /></div>
  }

  if (!authorized) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#070b14] px-5 text-slate-100">
        <div className="max-w-md rounded-3xl border border-white/10 bg-white/[.035] p-7 text-center">
          <AudioLines className="mx-auto h-9 w-9 text-cyan-300" />
          <h1 className="mt-5 text-xl font-black">يلزم تسجيل الدخول</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">أدوات الصوت محمية بنفس جلسة MAGHRABI Audio Studio.</p>
          <a href="#" className="mt-6 inline-flex rounded-xl bg-white px-5 py-3 text-sm font-black text-slate-950">العودة لتسجيل الدخول</a>
        </div>
      </div>
    )
  }

  const Icon = current.icon
  return (
    <main className="min-h-screen bg-[#070b14] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_right,rgba(91,79,255,.18),transparent_34%),radial-gradient(circle_at_15%_85%,rgba(0,214,201,.10),transparent_30%)]" />
      <div className="relative mx-auto max-w-7xl px-5 py-6 md:px-8 lg:py-8">
        <header className="flex flex-col gap-4 border-b border-white/10 pb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl border border-cyan-300/20 bg-gradient-to-br from-indigo-500/30 to-cyan-400/20"><AudioLines className="h-6 w-6 text-cyan-200" /></div>
            <div><h1 className="text-xl font-black">MAGHRABI Audio Tools</h1><p className="mt-1 text-xs text-slate-500">تحرير ومعالجة سريعة عبر FFmpeg</p></div>
          </div>
          <a href="#" className="inline-flex items-center gap-2 self-start rounded-xl border border-white/10 bg-white/[.03] px-4 py-2.5 text-xs font-bold text-slate-300 transition hover:border-cyan-300/30 hover:text-white"><ArrowLeft className="h-4 w-4" /> العودة للاستوديو</a>
        </header>

        <section className="py-8">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {toolCards.map((item) => {
              const CardIcon = item.icon
              const active = tool === item.id
              return (
                <button key={item.id} onClick={() => chooseTool(item.id)} className={`rounded-3xl border p-5 text-right transition ${active ? 'border-cyan-300/35 bg-cyan-300/[.07]' : 'border-white/10 bg-white/[.025] hover:border-white/20'}`}>
                  <CardIcon className={`h-6 w-6 ${active ? 'text-cyan-300' : 'text-slate-500'}`} />
                  <p className="mt-4 text-sm font-black">{item.title}</p>
                  <p className="mt-2 text-xs leading-5 text-slate-500">{item.subtitle}</p>
                </button>
              )
            })}
          </div>
        </section>

        <section className="grid gap-6 pb-12 lg:grid-cols-[.9fr_1.1fr]">
          <div className="rounded-[28px] border border-white/10 bg-white/[.035] p-5 sm:p-6">
            <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-indigo-400/10 text-indigo-200"><Icon className="h-5 w-5" /></div><div><h2 className="font-black">{current.title}</h2><p className="mt-1 text-xs text-slate-500">{current.subtitle}</p></div></div>

            <form onSubmit={run} className="mt-6 space-y-5">
              <FilePicker multiple={tool === 'merge'} files={files} onChange={setFiles} />

              {tool === 'trim' && (
                <div className="grid grid-cols-2 gap-3">
                  <NumberField label="البداية بالثواني" value={start} onChange={setStart} />
                  <NumberField label="النهاية بالثواني" value={end} onChange={setEnd} />
                  <NumberField label="Fade In" value={fadeIn} onChange={setFadeIn} />
                  <NumberField label="Fade Out" value={fadeOut} onChange={setFadeOut} />
                </div>
              )}

              {tool === 'enhance' && (
                <>
                  <label className="block"><span className="mb-2 block text-xs font-bold text-slate-400">نمط التحسين</span><select value={profile} onChange={(event) => setProfile(event.target.value as EnhanceProfile)} className="w-full rounded-2xl border border-white/10 bg-[#0b1120] px-4 py-3 text-sm outline-none"><option value="voice">Voice · كلام وغناء</option><option value="music">Music · موسيقى</option><option value="clean">Clean · إزالة ضوضاء</option></select></label>
                  <div className="grid grid-cols-2 gap-3"><NumberField label="Fade In" value={fadeIn} onChange={setFadeIn} /><NumberField label="Fade Out" value={fadeOut} onChange={setFadeOut} /></div>
                  <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-white/10 bg-black/15 px-4 py-3"><div><p className="text-sm font-bold">Normalize / Loudness</p><p className="mt-1 text-xs text-slate-500">توحيد مستوى الصوت للوصول إلى نتيجة متوازنة</p></div><input type="checkbox" checked={normalize} onChange={(event) => setNormalize(event.target.checked)} className="h-4 w-4 accent-cyan-300" /></label>
                </>
              )}

              {tool === 'merge' && <p className="rounded-2xl border border-indigo-300/10 bg-indigo-300/[.04] px-4 py-3 text-xs leading-6 text-slate-400">سيتم الدمج حسب ترتيب اختيار الملفات. يمكن دمج حتى 12 ملفًا في العملية الواحدة.</p>}

              <FormatField value={format} onChange={setFormat} />

              {error && <div className="rounded-2xl border border-rose-300/15 bg-rose-400/[.06] px-4 py-3 text-xs leading-6 text-rose-200">{error}</div>}

              <button disabled={busy || !files.length || (tool === 'merge' && files.length < 2)} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-l from-indigo-500 to-cyan-500 px-5 py-4 text-sm font-black shadow-lg shadow-indigo-950/40 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
                {busy ? <Activity className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {busy ? 'جاري المعالجة...' : 'تنفيذ العملية'}
              </button>
            </form>
          </div>

          <div className="rounded-[28px] border border-white/10 bg-[#0a101c] p-5 sm:p-6">
            <div className="flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-cyan-300">OUTPUT</p><h3 className="mt-2 text-xl font-black">المعاينة والنتيجة</h3></div>{result && <CheckCircle2 className="h-6 w-6 text-emerald-300" />}</div>

            {!result ? (
              <div className="mt-8 grid min-h-[330px] place-items-center rounded-3xl border border-dashed border-white/10 bg-black/10 text-center"><div><FileAudio className="mx-auto h-10 w-10 text-slate-700" /><p className="mt-4 text-sm font-bold text-slate-500">ستظهر النتيجة هنا بعد المعالجة</p><p className="mt-2 text-xs text-slate-700">يمكنك الاستماع ثم تنزيل الملف مباشرة</p></div></div>
            ) : (
              <div className="mt-8 rounded-3xl border border-emerald-300/15 bg-emerald-300/[.035] p-5">
                <div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-300/[.08] text-emerald-200"><FileAudio className="h-5 w-5" /></div><div><p className="text-sm font-black">تمت المعالجة بنجاح</p><p className="mt-1 text-xs text-slate-500">{result.name}</p></div></div>
                <audio className="mt-6 w-full" controls src={result.url} />
                <a href={result.url} download={result.name} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-5 py-3.5 text-sm font-black text-slate-950 transition hover:bg-cyan-100"><Download className="h-4 w-4" /> تنزيل الملف الناتج</a>
              </div>
            )}

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/[.02] p-4"><p className="text-xs font-black">Fast Processing</p><p className="mt-2 text-[11px] leading-5 text-slate-600">لا يحتاج GPU ولا ينتظر محرك الفصل.</p></div>
              <div className="rounded-2xl border border-white/10 bg-white/[.02] p-4"><p className="text-xs font-black">Lossless Option</p><p className="mt-2 text-[11px] leading-5 text-slate-600">WAV وFLAC للجودة العالية.</p></div>
              <div className="rounded-2xl border border-white/10 bg-white/[.02] p-4"><p className="text-xs font-black">Private Session</p><p className="mt-2 text-[11px] leading-5 text-slate-600">الأدوات محمية بجلسة الدخول نفسها.</p></div>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
