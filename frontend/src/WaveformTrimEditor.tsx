import { useEffect, useRef, useState } from 'react'
import { Pause, Play, RotateCcw, Search, ZoomIn, ZoomOut } from 'lucide-react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'

type Props = {
  file: File
  start: number
  end: number
  onSelectionChange: (start: number, end: number) => void
}

function formatClock(seconds: number) {
  if (!Number.isFinite(seconds)) return '00:00.0'
  const minutes = Math.floor(seconds / 60)
  const secs = seconds - minutes * 60
  return `${String(minutes).padStart(2, '0')}:${secs.toFixed(1).padStart(4, '0')}`
}

export default function WaveformTrimEditor({ file, start, end, onSelectionChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wavesurferRef = useRef<WaveSurfer | null>(null)
  const regionRef = useRef<any>(null)
  const syncingRef = useRef(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [zoom, setZoom] = useState(45)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!containerRef.current) return

    setLoading(true)
    setDuration(0)
    setCurrentTime(0)
    setPlaying(false)

    const objectUrl = URL.createObjectURL(file)
    const regions = RegionsPlugin.create()
    const wavesurfer = WaveSurfer.create({
      container: containerRef.current,
      height: 126,
      waveColor: '#475569',
      progressColor: '#22d3ee',
      cursorColor: '#f8fafc',
      cursorWidth: 2,
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
      normalize: true,
      dragToSeek: true,
      minPxPerSec: zoom,
      autoScroll: true,
      autoCenter: true,
      plugins: [regions],
    })

    wavesurferRef.current = wavesurfer

    wavesurfer.on('ready', (audioDuration) => {
      const safeDuration = Math.max(0, audioDuration)
      setDuration(safeDuration)
      setLoading(false)

      const safeStart = Math.min(Math.max(0, start), safeDuration)
      let safeEnd = Math.min(Math.max(end, safeStart + 0.05), safeDuration)
      if (safeEnd <= safeStart) safeEnd = safeDuration

      syncingRef.current = true
      const region = regions.addRegion({
        start: safeStart,
        end: safeEnd,
        color: 'rgba(34, 211, 238, 0.16)',
        drag: true,
        resize: true,
      })
      regionRef.current = region
      onSelectionChange(Number(safeStart.toFixed(3)), Number(safeEnd.toFixed(3)))
      queueMicrotask(() => { syncingRef.current = false })
    })

    regions.on('region-updated', (region: any) => {
      if (syncingRef.current) return
      onSelectionChange(Number(region.start.toFixed(3)), Number(region.end.toFixed(3)))
    })

    regions.on('region-clicked', (region: any, event: MouseEvent) => {
      event.stopPropagation()
      region.play()
    })

    wavesurfer.on('timeupdate', (time) => setCurrentTime(time))
    wavesurfer.on('play', () => setPlaying(true))
    wavesurfer.on('pause', () => setPlaying(false))
    wavesurfer.on('finish', () => setPlaying(false))

    wavesurfer.load(objectUrl)

    return () => {
      regionRef.current = null
      wavesurferRef.current = null
      wavesurfer.destroy()
      URL.revokeObjectURL(objectUrl)
    }
  // Intentionally recreate only when the source file changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  useEffect(() => {
    const region = regionRef.current
    if (!region || !duration || syncingRef.current) return
    const safeStart = Math.min(Math.max(0, start), duration)
    const safeEnd = Math.min(Math.max(end, safeStart + 0.05), duration)
    if (Math.abs(region.start - safeStart) < 0.01 && Math.abs(region.end - safeEnd) < 0.01) return
    syncingRef.current = true
    region.setOptions({ start: safeStart, end: safeEnd })
    queueMicrotask(() => { syncingRef.current = false })
  }, [start, end, duration])

  useEffect(() => {
    wavesurferRef.current?.zoom(zoom)
  }, [zoom])

  const playSelection = () => {
    const region = regionRef.current
    const wavesurfer = wavesurferRef.current
    if (!region || !wavesurfer) return
    if (wavesurfer.isPlaying()) wavesurfer.pause()
    else region.play()
  }

  const selectAll = () => {
    if (!duration) return
    onSelectionChange(0, Number(duration.toFixed(3)))
  }

  const selectionDuration = Math.max(0, end - start)

  return (
    <div className="rounded-3xl border border-cyan-300/15 bg-[#07101d] p-4 shadow-inner shadow-black/30 sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-black text-cyan-200"><Search className="h-4 w-4" /> Waveform Editor</div>
          <p className="mt-1 text-[11px] leading-5 text-slate-500">اسحب المنطقة المظللة أو مقابض طرفيها لتحديد الجزء الذي تريد الاحتفاظ به.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] tabular-nums">
          <span className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-slate-400">{formatClock(currentTime)} / {formatClock(duration)}</span>
          <span className="rounded-lg border border-cyan-300/15 bg-cyan-300/[.05] px-2.5 py-1.5 text-cyan-200">المحدد {formatClock(selectionDuration)}</span>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/25 px-2 py-3">
        {loading && <div className="absolute inset-0 z-10 grid place-items-center bg-[#07101d]/80 text-xs font-bold text-slate-400">جاري تحليل الموجة الصوتية...</div>}
        <div ref={containerRef} className="min-h-[126px]" />
      </div>

      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={playSelection} disabled={loading} className="inline-flex items-center gap-2 rounded-xl bg-white px-3.5 py-2.5 text-xs font-black text-slate-950 transition hover:bg-cyan-100 disabled:opacity-40">
            {playing ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="h-4 w-4" fill="currentColor" />}
            {playing ? 'إيقاف' : 'تشغيل التحديد'}
          </button>
          <button type="button" onClick={selectAll} disabled={!duration} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.03] px-3.5 py-2.5 text-xs font-bold text-slate-300 transition hover:border-cyan-300/25 hover:text-white disabled:opacity-40">
            <RotateCcw className="h-4 w-4" /> تحديد كامل الملف
          </button>
        </div>

        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-white/10 bg-black/15 px-3 py-2">
          <ZoomOut className="h-4 w-4 shrink-0 text-slate-500" />
          <input aria-label="Zoom waveform" type="range" min="12" max="180" step="3" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} className="h-1.5 min-w-28 flex-1 accent-cyan-300" />
          <ZoomIn className="h-4 w-4 shrink-0 text-slate-500" />
          <span className="w-10 text-left text-[10px] tabular-nums text-slate-600">{zoom}px</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[11px] tabular-nums">
        <div className="rounded-xl border border-white/10 bg-white/[.025] px-3 py-2"><span className="block text-slate-600">START</span><strong className="mt-1 block text-slate-200">{formatClock(start)}</strong></div>
        <div className="rounded-xl border border-cyan-300/15 bg-cyan-300/[.04] px-3 py-2"><span className="block text-slate-600">DURATION</span><strong className="mt-1 block text-cyan-200">{formatClock(selectionDuration)}</strong></div>
        <div className="rounded-xl border border-white/10 bg-white/[.025] px-3 py-2"><span className="block text-slate-600">END</span><strong className="mt-1 block text-slate-200">{formatClock(end)}</strong></div>
      </div>
    </div>
  )
}
