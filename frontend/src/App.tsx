import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AudioLines,
  CheckCircle2,
  Download,
  FileAudio,
  Headphones,
  Layers3,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  UploadCloud,
  Volume2,
  Waves,
} from 'lucide-react'
import { createSeparationJob, getJob, JobResponse, StemName } from './lib/api'

const stemMeta: Record<StemName, { label: string; icon: string }> = {
  vocals: { label: 'الصوت البشري', icon: '🎤' },
  drums: { label: 'الطبول', icon: '🥁' },
  bass: { label: 'البيس', icon: '🎸' },
  other: { label: 'بقية الموسيقى', icon: '🎼' },
  instrumental: { label: 'الموسيقى فقط', icon: '🎧' },
}

const previewStems = [
  ['🎤', 'Vocals'],
  ['🥁', 'Drums'],
  ['🎸', 'Bass'],
  ['🎼', 'Other'],
] as const

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(totalSeconds = 0) {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function stageLabel(stage?: string) {
  switch (stage) {
    case 'queued':
      return 'في قائمة المعالجة'
    case 'loading_model':
      return 'تجهيز نموذج الذكاء الاصطناعي'
    case 'separating':
      return 'فصل وتحليل المسارات'
    case 'finalizing':
      return 'تجهيز الملفات النهائية'
    case 'completed':
      return 'اكتمل الفصل'
    case 'failed':
      return 'توقفت المعالجة'
    default:
      return 'جاري المعالجة'
  }
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [mode, setMode] = useState<'2stems' | '4stems'>('4stems')
  const [job, setJob] = useState<JobResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const isProcessing = job?.status === 'queued' || job?.status === 'processing'

  useEffect(() => {
    if (!job || !isProcessing) return

    const timer = window.setInterval(async () => {
      try {
        const next = await getJob(job.id)
        setJob(next)
        if (next.status === 'failed') setError(next.error || 'فشلت معالجة الملف.')
      } catch (pollError) {
        console.error(pollError)
      }
    }, 1500)

    return () => window.clearInterval(timer)
  }, [job?.id, isProcessing])

  const stems = useMemo(() => {
    if (!job?.stems) return []
    return Object.entries(job.stems).filter(
      (entry): entry is [StemName, string] => Boolean(entry[1]),
    )
  }, [job])

  const acceptFile = (candidate?: File) => {
    if (!candidate) return
    const extensionOk = /\.(mp3|wav|flac|m4a|aac|ogg)$/i.test(candidate.name)
    if (!candidate.type.startsWith('audio/') && !extensionOk) {
      setError('الصيغة غير مدعومة. استخدم MP3 أو WAV أو FLAC أو M4A أو AAC أو OGG.')
      return
    }
    setError(null)
    setFile(candidate)
    setJob(null)
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    acceptFile(event.target.files?.[0])
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    acceptFile(event.dataTransfer.files?.[0])
  }

  const start = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      setJob(await createSeparationJob(file, mode))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'تعذر بدء المعالجة.')
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    setFile(null)
    setJob(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#070b14] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_right,rgba(91,79,255,.18),transparent_34%),radial-gradient(circle_at_20%_80%,rgba(0,214,201,.12),transparent_32%)]" />
      <div className="relative mx-auto max-w-7xl px-5 py-6 md:px-8 lg:py-8">
        <header className="flex flex-col gap-5 border-b border-white/10 pb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl border border-cyan-300/20 bg-gradient-to-br from-indigo-500/30 to-cyan-400/20 shadow-[0_0_35px_rgba(79,70,229,.2)]">
              <AudioLines className="h-6 w-6 text-cyan-200" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-black tracking-tight sm:text-xl">MAGHRABI Audio Studio</h1>
                <span className="rounded-full border border-indigo-300/20 bg-indigo-400/10 px-2 py-0.5 text-[10px] font-bold text-indigo-200">AI</span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">افصل الصوت والموسيقى إلى مسارات مستقلة</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,.8)]" />
            Engine ready
          </div>
        </header>

        <section className="grid gap-8 py-10 lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:py-16">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[.035] px-3 py-1.5 text-xs text-slate-300">
              <Sparkles className="h-3.5 w-3.5 text-cyan-300" /> AI Stem Separation
            </div>
            <h2 className="max-w-3xl text-4xl font-black leading-[1.15] tracking-tight sm:text-5xl lg:text-6xl">
              حوّل أي أغنية إلى
              <span className="block bg-gradient-to-l from-cyan-300 via-sky-300 to-indigo-400 bg-clip-text text-transparent">
                استوديو متعدد المسارات.
              </span>
            </h2>
            <p className="mt-5 max-w-2xl text-base leading-8 text-slate-400 sm:text-lg">
              ارفع الملف، اختر نوع الفصل، ثم استمع لكل مسار وحمّله بشكل مستقل. النسخة الأولى تدعم فصل الصوت البشري والطبول والبيس وبقية الموسيقى.
            </p>
            <div className="mt-7 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
              {previewStems.map(([icon, label]) => (
                <div key={label} className="rounded-2xl border border-white/10 bg-white/[.025] p-3.5">
                  <div className="text-xl">{icon}</div>
                  <div className="mt-2 text-sm font-bold text-slate-200">{label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[28px] border border-white/10 bg-white/[.04] p-3 shadow-2xl shadow-black/30 backdrop-blur-xl">
            <div
              onDragOver={(event) => event.preventDefault()}
              onDrop={onDrop}
              onClick={() => !file && inputRef.current?.click()}
              className={`relative min-h-[390px] rounded-[22px] border border-dashed p-6 transition sm:p-8 ${
                file
                  ? 'border-indigo-300/25 bg-[#0b1120]'
                  : 'cursor-pointer border-white/15 bg-[#0a0f1b] hover:border-cyan-300/40 hover:bg-[#0b1220]'
              }`}
            >
              <input
                ref={inputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg"
                className="hidden"
                onChange={onFileChange}
              />

              {!file ? (
                <div className="flex min-h-[330px] flex-col items-center justify-center text-center">
                  <div className="grid h-20 w-20 place-items-center rounded-3xl border border-cyan-300/15 bg-cyan-300/[.06]">
                    <UploadCloud className="h-9 w-9 text-cyan-300" />
                  </div>
                  <h3 className="mt-6 text-xl font-black">اسحب الملف الصوتي هنا</h3>
                  <p className="mt-2 text-sm text-slate-500">أو اضغط لاختيار ملف من جهازك</p>
                  <button className="mt-6 rounded-xl bg-white px-5 py-3 text-sm font-black text-slate-950 transition hover:bg-cyan-100">
                    اختيار ملف صوتي
                  </button>
                  <p className="mt-5 text-[11px] uppercase tracking-[.16em] text-slate-600">MP3 · WAV · FLAC · M4A · AAC · OGG</p>
                </div>
              ) : (
                <div>
                  <div className="flex items-start justify-between gap-4 rounded-2xl border border-white/10 bg-white/[.03] p-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-indigo-400/10 text-indigo-200">
                        <FileAudio />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black text-white">{file.name}</p>
                        <p className="mt-1 text-xs text-slate-500">{formatSize(file.size)}</p>
                      </div>
                    </div>
                    <button
                      onClick={(event) => {
                        event.stopPropagation()
                        reset()
                      }}
                      className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-white"
                      title="ملف جديد"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </button>
                  </div>

                  {!job && (
                    <>
                      <div className="mt-5">
                        <p className="mb-3 text-xs font-bold text-slate-400">نوع الفصل</p>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <button
                            onClick={() => setMode('2stems')}
                            className={`rounded-2xl border p-4 text-right transition ${
                              mode === '2stems'
                                ? 'border-cyan-300/35 bg-cyan-300/[.07]'
                                : 'border-white/10 bg-white/[.02] hover:border-white/20'
                            }`}
                          >
                            <div className="flex items-center gap-2 font-black"><Headphones className="h-4 w-4" /> Vocal + Music</div>
                            <p className="mt-2 text-xs leading-5 text-slate-500">للكاريوكي وعزل صوت المغني بسرعة.</p>
                          </button>
                          <button
                            onClick={() => setMode('4stems')}
                            className={`rounded-2xl border p-4 text-right transition ${
                              mode === '4stems'
                                ? 'border-indigo-300/35 bg-indigo-300/[.07]'
                                : 'border-white/10 bg-white/[.02] hover:border-white/20'
                            }`}
                          >
                            <div className="flex items-center gap-2 font-black"><Layers3 className="h-4 w-4" /> 4 Stems</div>
                            <p className="mt-2 text-xs leading-5 text-slate-500">Vocals, Drums, Bass, Other.</p>
                          </button>
                        </div>
                      </div>
                      <button
                        disabled={busy}
                        onClick={start}
                        className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-l from-indigo-500 to-cyan-500 px-5 py-4 text-sm font-black text-white shadow-lg shadow-indigo-950/50 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Sparkles className="h-4 w-4" />
                        {busy ? 'جاري رفع الملف...' : 'بدء الفصل بالذكاء الاصطناعي'}
                      </button>
                    </>
                  )}

                  {job && job.status !== 'completed' && (
                    <div className="mt-6 rounded-2xl border border-white/10 bg-black/15 p-5" aria-live="polite">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm font-black">
                            <Activity className="h-4 w-4 shrink-0 animate-pulse text-cyan-300" />
                            <span>{stageLabel(job.stage)}</span>
                          </div>
                          <p className="mt-2 text-xs leading-5 text-slate-400">{job.message}</p>
                        </div>
                        <span className="shrink-0 text-sm font-black tabular-nums text-cyan-300">{job.progress}%</span>
                      </div>

                      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/5">
                        <div
                          className="h-full rounded-full bg-gradient-to-l from-indigo-500 to-cyan-400 transition-all duration-700"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>

                      <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="rounded-full border border-white/10 bg-white/[.035] px-3 py-1.5 text-slate-400">
                          الوقت المنقضي <b className="mr-1 tabular-nums text-slate-200">{formatDuration(job.elapsed_seconds)}</b>
                        </span>
                        <span className="rounded-full border border-cyan-300/10 bg-cyan-300/[.04] px-3 py-1.5 text-cyan-200/80">
                          المعالجة مستمرة على CPU
                        </span>
                      </div>

                      <p className="mt-3 text-[11px] leading-5 text-slate-600">
                        النسبة تُحدّث من تقدم محرك Demucs أثناء تحليل الملف، وقد تختلف السرعة حسب مدة الصوت وحجم موارد Railway.
                      </p>
                    </div>
                  )}

                  {job?.status === 'completed' && (
                    <div className="mt-6 rounded-2xl border border-emerald-300/15 bg-emerald-300/[.05] p-4 text-sm font-bold text-emerald-200">
                      <div className="flex items-center gap-3">
                        <CheckCircle2 className="h-5 w-5" />
                        <span>اكتملت عملية الفصل. المسارات جاهزة بالأسفل.</span>
                      </div>
                      <p className="mt-2 pr-8 text-xs font-normal text-emerald-200/60">
                        زمن المعالجة: {formatDuration(job.elapsed_seconds)}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        {error && (
          <div className="mb-8 rounded-2xl border border-rose-300/15 bg-rose-400/[.06] px-5 py-4 text-sm text-rose-200">
            {error}
          </div>
        )}

        {job?.status === 'completed' && stems.length > 0 && (
          <section className="pb-14">
            <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[.18em] text-cyan-300">Separated stems</p>
                <h3 className="mt-2 text-2xl font-black">المسارات الصوتية</h3>
              </div>
              <p className="text-xs text-slate-500">استمع لكل مسار أو قم بتنزيله بصيغة WAV</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {stems.map(([stem, url]) => <StemCard key={stem} stem={stem} url={url} />)}
            </div>
          </section>
        )}

        <footer className="flex flex-col gap-3 border-t border-white/10 py-7 text-xs text-slate-600 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2"><Waves className="h-4 w-4" /> MAGHRABI Audio Studio</div>
          <div>React · FastAPI · Demucs · Railway</div>
        </footer>
      </div>
    </main>
  )
}

function StemCard({ stem, url }: { stem: StemName; url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(1)
  const meta = stemMeta[stem]

  const toggle = async () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      await audio.play()
      setPlaying(true)
    } else {
      audio.pause()
      setPlaying(false)
    }
  }

  return (
    <article className="rounded-3xl border border-white/10 bg-white/[.035] p-5">
      <audio ref={audioRef} src={url} preload="metadata" onEnded={() => setPlaying(false)} />
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-black/20 text-xl">{meta.icon}</div>
          <div>
            <p className="text-sm font-black">{meta.label}</p>
            <p className="mt-1 text-[11px] uppercase tracking-[.14em] text-slate-600">{stem}</p>
          </div>
        </div>
        <a
          href={url}
          download
          className="rounded-xl border border-white/10 p-2.5 text-slate-400 transition hover:border-cyan-300/30 hover:text-cyan-200"
          title="تنزيل"
        >
          <Download className="h-4 w-4" />
        </a>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={toggle}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white text-slate-950 transition hover:bg-cyan-100"
        >
          {playing ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="h-4 w-4" fill="currentColor" />}
        </button>
        <div className="relative h-11 flex-1 overflow-hidden rounded-xl border border-white/10 bg-black/20 px-3">
          <div className="flex h-full items-center gap-[3px] opacity-50">
            {Array.from({ length: 34 }).map((_, i) => (
              <span
                key={i}
                className="w-1 rounded-full bg-gradient-to-t from-indigo-400 to-cyan-300"
                style={{ height: `${20 + ((i * 17) % 65)}%` }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Volume2 className="h-4 w-4 text-slate-500" />
        <input
          aria-label="Volume"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(event) => {
            const next = Number(event.target.value)
            setVolume(next)
            if (audioRef.current) audioRef.current.volume = next
          }}
          className="h-1.5 w-full accent-cyan-300"
        />
        <span className="w-9 text-left text-[11px] tabular-nums text-slate-600">{Math.round(volume * 100)}</span>
      </div>
    </article>
  )
}

export default App
