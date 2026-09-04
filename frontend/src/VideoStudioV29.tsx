import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, BarChart3, CheckCircle2, Clock3, Cpu, Database, DollarSign,
  Gauge, HardDrive, RefreshCw, Rocket, Server, Settings2, ShieldCheck, TestTube2,
  TimerReset, TrendingUp, Zap,
} from 'lucide-react'
import {
  captureCapacityV29, getOverviewV29, runLoadTestV29, runReleaseGateV29, saveSettingsV29,
  type V29Gate, type V29Overview,
} from './lib/capacityApiV29'

function num(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits)
}

function secs(value: number | null | undefined) {
  if (value == null) return '—'
  if (value < 60) return `${num(value, 1)}s`
  return `${num(value / 60, 1)}m`
}

function ms(value: number | null | undefined) {
  if (value == null) return '—'
  return value >= 1000 ? `${num(value / 1000, 2)}s` : `${num(value, 0)}ms`
}

function when(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ar-SA')
}

function card(ok = true) {
  return `rounded-2xl border p-4 ${ok ? 'border-white/10 bg-white/[0.035]' : 'border-amber-400/25 bg-amber-500/10'}`
}

function gateTone(state: string) {
  if (state === 'pass') return 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'
  if (state === 'block') return 'border-rose-400/30 bg-rose-500/10 text-rose-100'
  return 'border-amber-400/25 bg-amber-500/10 text-amber-100'
}

function GateBadge({ gate }: { gate: V29Gate }) {
  return <span className={`rounded-full border px-3 py-1 text-[10px] font-black ${gateTone(gate.state)}`}>{gate.state.toUpperCase()} · {gate.score}/100</span>
}

const settingKeys = [
  'availability.targetPct', 'jobs.successTargetPct', 'jobs.renderP95Seconds', 'jobs.queueP95Seconds',
  'api.p95Ms', 'rto.targetMs', 'burn.fastThreshold', 'burn.slowThreshold',
  'capacity.warnSaturationPct', 'capacity.blockSaturationPct', 'samples.minJobs', 'samples.minApi',
]

export default function VideoStudioV29() {
  const [overview, setOverview] = useState<V29Overview | null>(null)
  const [draft, setDraft] = useState<Record<string, any>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await getOverviewV29()
      setOverview(data)
      setDraft(current => Object.keys(current).length ? current : { ...data.settings })
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل Creator V29.')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 8000)
    return () => window.clearInterval(timer)
  }, [load])

  const act = async (name: string, fn: () => Promise<any>, success: string) => {
    setBusy(name); setError(''); setMessage('')
    try {
      await fn()
      setMessage(success)
      setDraft({})
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : `فشلت عملية ${name}.`)
    } finally {
      setBusy('')
    }
  }

  const activeLoad = useMemo(() => overview?.loadTests.find(item => item.state === 'running'), [overview])

  if (!overview) {
    return <main className="min-h-screen bg-[#050911] p-8 text-slate-100" dir="rtl"><div className="mx-auto max-w-xl rounded-3xl border border-white/10 bg-white/5 p-8 text-center"><Activity className="mx-auto mb-4 h-10 w-10 animate-pulse text-cyan-300" /><h1 className="text-xl font-black">Creator V29 SLO & Capacity Engineering</h1><p className="mt-2 text-sm text-slate-400">{error || 'جاري تحميل SLO Control Room...'}</p>{error && <button onClick={() => void load()} className="mt-5 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950">RETRY</button>}</div></main>
  }

  const gate = overview.releaseGate
  const api = overview.errorBudget.window
  const satWarn = Number(overview.settings['capacity.warnSaturationPct'] ?? 85)
  const jobTarget = Number(overview.settings['jobs.successTargetPct'] ?? 98)
  const apiTarget = Number(overview.settings['availability.targetPct'] ?? 99.5)
  const renderTarget = Number(overview.settings['jobs.renderP95Seconds'] ?? 900)
  const queueTarget = Number(overview.settings['jobs.queueP95Seconds'] ?? 120)
  const apiP95Target = Number(overview.settings['api.p95Ms'] ?? 2500)

  return (
    <main className="min-h-screen bg-[#050911] text-slate-100" dir="rtl">
      <header className="border-b border-white/10 bg-[#070d17]/95 px-5 py-4 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-black tracking-[.18em] text-cyan-300"><Gauge className="h-4 w-4" /> SLO · CAPACITY · ERROR BUDGET · RELEASE GATE</div>
            <h1 className="mt-1 text-2xl font-black">MAGHRABI Video Studio · Creator V29</h1>
            <p className="mt-1 text-xs text-slate-500">P50/P95/P99 · Burn Rate · Saturation · Forecast · Cost/RTF · Safe Load Tests · Deployment Gate</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="#video-v28" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V28 CHAOS</a>
            <a href="#video-v27" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V27 WORKERS</a>
            <a href="#video-v25" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V25 OPS</a>
            <button onClick={() => void load()} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950"><RefreshCw className="h-4 w-4" /> REFRESH</button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1800px] space-y-5 p-5">
        {(error || message) && <div className={`rounded-2xl border px-4 py-3 text-sm ${error ? 'border-rose-400/30 bg-rose-500/10 text-rose-200' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'}`}>{error || message}</div>}
        {activeLoad && <div className="rounded-2xl border border-cyan-400/25 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">Synthetic {activeLoad.kind.toUpperCase()} test قيد التنفيذ: {activeLoad.durationSeconds}s · concurrency {activeLoad.concurrency}. لا يتم تشغيل FFmpeg في هذا الاختبار.</div>}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <div className={card(gate.state !== 'block')}><Rocket className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">RELEASE GATE</div><div className="mt-1 text-xl font-black">{gate.state.toUpperCase()}</div><div className="text-xs text-slate-400">Score {gate.score}/100</div></div>
          <div className={card(api.availabilityPct == null || api.availabilityPct >= apiTarget)}><ShieldCheck className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">API AVAILABILITY</div><div className="mt-1 text-xl font-black">{api.availabilityPct == null ? '—' : `${num(api.availabilityPct, 3)}%`}</div><div className="text-xs text-slate-400">SLO ≥ {apiTarget}%</div></div>
          <div className={card(api.p95Ms == null || api.p95Ms <= apiP95Target)}><Clock3 className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">API P95</div><div className="mt-1 text-xl font-black">{ms(api.p95Ms)}</div><div className="text-xs text-slate-400">Target ≤ {ms(apiP95Target)}</div></div>
          <div className={card(overview.jobs.successPct == null || overview.jobs.successPct >= jobTarget)}><CheckCircle2 className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">JOB SUCCESS</div><div className="mt-1 text-xl font-black">{overview.jobs.successPct == null ? '—' : `${num(overview.jobs.successPct, 2)}%`}</div><div className="text-xs text-slate-400">Target ≥ {jobTarget}%</div></div>
          <div className={card(overview.jobs.renderP95Seconds == null || overview.jobs.renderP95Seconds <= renderTarget)}><TimerReset className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">RENDER P95</div><div className="mt-1 text-xl font-black">{secs(overview.jobs.renderP95Seconds)}</div><div className="text-xs text-slate-400">Target ≤ {secs(renderTarget)}</div></div>
          <div className={card(overview.jobs.queue.p95Seconds == null || overview.jobs.queue.p95Seconds <= queueTarget)}><BarChart3 className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">QUEUE P95</div><div className="mt-1 text-xl font-black">{secs(overview.jobs.queue.p95Seconds)}</div><div className="text-xs text-slate-400">Target ≤ {secs(queueTarget)}</div></div>
          <div className={card(overview.capacity.saturationPercent < satWarn)}><Cpu className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">SATURATION</div><div className="mt-1 text-xl font-black">{num(overview.capacity.saturationPercent, 1)}%</div><div className="text-xs text-slate-400">Warn ≥ {satWarn}%</div></div>
          <div className={card((overview.errorBudget.remainingBudgetPct ?? 100) >= 0)}><Zap className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">ERROR BUDGET</div><div className="mt-1 text-xl font-black">{overview.errorBudget.remainingBudgetPct == null ? '—' : `${num(overview.errorBudget.remainingBudgetPct, 1)}%`}</div><div className="text-xs text-slate-400">remaining</div></div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
          <div className={`${card(gate.state !== 'block')} ${gateTone(gate.state)}`}>
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-black"><Rocket className="h-5 w-5" /> RELEASE QUALITY GATE</h2><p className="mt-1 text-xs opacity-70">يمكن ربط `/api/video/v29/release/ready` بـRailway Health Check؛ حالة BLOCK ترجع HTTP 503.</p></div><GateBadge gate={gate} /></div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div><div className="mb-2 text-[10px] font-black opacity-60">BLOCKERS</div>{gate.blockers.length ? gate.blockers.map((item, index) => <div key={index} className="mb-2 flex gap-2 rounded-xl bg-black/15 p-3 text-xs"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{item}</div>) : <div className="rounded-xl bg-black/15 p-3 text-xs">لا توجد Blockers.</div>}</div>
              <div><div className="mb-2 text-[10px] font-black opacity-60">WARNINGS</div>{gate.warnings.length ? gate.warnings.map((item, index) => <div key={index} className="mb-2 rounded-xl bg-black/15 p-3 text-xs">{item}</div>) : <div className="rounded-xl bg-black/15 p-3 text-xs">لا توجد Warnings.</div>}</div>
            </div>
            <button disabled={!!busy} onClick={() => void act('gate', () => runReleaseGateV29('Creator V29'), 'تم تسجيل Release Gate جديدة في السجل.')} className="mt-4 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950 disabled:opacity-40">RUN & RECORD RELEASE GATE</button>
          </div>

          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><Zap className="h-5 w-5 text-amber-300" /> ERROR BUDGET / BURN RATE</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">1H BURN</div><div className="text-xl font-black">{overview.errorBudget.burnRate1h == null ? '—' : `${num(overview.errorBudget.burnRate1h, 2)}x`}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">6H BURN</div><div className="text-xl font-black">{overview.errorBudget.burnRate6h == null ? '—' : `${num(overview.errorBudget.burnRate6h, 2)}x`}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">5XX</div><div className="text-xl font-black">{api.errors5xx}</div><div className="text-xs text-slate-500">من {api.samples} samples</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">ALLOWANCE</div><div className="text-xl font-black">{num(overview.errorBudget.allowedErrorsEquivalent, 2)}</div><div className="text-xs text-slate-500">equivalent errors</div></div>
            </div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-2">
          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><BarChart3 className="h-5 w-5 text-cyan-300" /> LATENCY DISTRIBUTION</h2>
            <div className="mt-4 overflow-auto"><table className="w-full min-w-[620px] text-right text-xs"><thead className="text-slate-500"><tr><th className="p-2">METRIC</th><th className="p-2">SAMPLES</th><th className="p-2">P50</th><th className="p-2">P95</th><th className="p-2">P99</th></tr></thead><tbody>
              <tr className="border-t border-white/5"><td className="p-2 font-bold">API</td><td className="p-2">{api.samples}</td><td className="p-2">{ms(api.p50Ms)}</td><td className="p-2">{ms(api.p95Ms)}</td><td className="p-2">{ms(api.p99Ms)}</td></tr>
              <tr className="border-t border-white/5"><td className="p-2 font-bold">Queue Wait</td><td className="p-2">{overview.jobs.queue.samples}</td><td className="p-2">{secs(overview.jobs.queue.p50Seconds)}</td><td className="p-2">{secs(overview.jobs.queue.p95Seconds)}</td><td className="p-2">{secs(overview.jobs.queue.p99Seconds)}</td></tr>
              <tr className="border-t border-white/5"><td className="p-2 font-bold">Execution</td><td className="p-2">{overview.jobs.execution.samples}</td><td className="p-2">{secs(overview.jobs.execution.p50Seconds)}</td><td className="p-2">{secs(overview.jobs.execution.p95Seconds)}</td><td className="p-2">{secs(overview.jobs.execution.p99Seconds)}</td></tr>
            </tbody></table></div>
          </div>

          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><TrendingUp className="h-5 w-5 text-emerald-300" /> CAPACITY FORECAST</h2>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">ARRIVALS / H</div><div className="text-xl font-black">{num(overview.capacityForecast.arrivalPerHour, 2)}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">COMPLETIONS / H</div><div className="text-xl font-black">{num(overview.capacityForecast.completionPerHour, 2)}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">BACKLOG +1H</div><div className="text-xl font-black">{num(overview.capacityForecast.forecastBacklog1h, 1)}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">RECOMMENDED</div><div className="text-xl font-black">{overview.capacityForecast.recommendedReplicas}</div><div className="text-xs text-slate-500">replicas</div></div>
            </div>
            <div className="mt-3 rounded-xl border border-white/10 p-3 text-xs text-slate-400">Recommendation: <b className="text-slate-200">{overview.capacityForecast.recommendation}</b>. {overview.capacityForecast.note}</div>
            <button disabled={!!busy} onClick={() => void act('snapshot', captureCapacityV29, 'تم حفظ Capacity Snapshot جديدة.')} className="mt-3 rounded-xl border border-white/10 px-4 py-2 text-xs font-black hover:bg-white/5 disabled:opacity-40">CAPTURE SNAPSHOT</button>
          </div>
        </section>

        <section className={card()}>
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 font-black"><DollarSign className="h-5 w-5 text-emerald-300" /> PER-PRESET COMPUTE / COST</h2><p className="text-xs text-slate-500">RTF = compute time ÷ source duration. Estimated USD يظهر فقط إذا تم إعداد V29_COMPUTE_USD_PER_HOUR.</p></div><span className="rounded-full border border-white/10 px-3 py-1 text-[10px] font-black">RATE {overview.costModel.rateUsdPerComputeHour == null ? 'NOT CONFIGURED' : `$${overview.costModel.rateUsdPerComputeHour}/h`}</span></div>
          <div className="mt-4 overflow-auto"><table className="w-full min-w-[900px] text-right text-xs"><thead className="text-slate-500"><tr><th className="p-2">PRESET</th><th className="p-2">TYPE</th><th className="p-2">SAMPLES</th><th className="p-2">COMPUTE</th><th className="p-2">P50</th><th className="p-2">P95</th><th className="p-2">RTF</th><th className="p-2">EST. COST</th></tr></thead><tbody>{overview.jobs.perPreset.length ? overview.jobs.perPreset.map((item, index) => <tr key={`${item.category}-${item.preset}-${index}`} className="border-t border-white/5"><td className="p-2 font-bold">{item.preset}</td><td className="p-2 text-slate-400">{item.category}</td><td className="p-2">{item.samples}</td><td className="p-2">{secs(item.computeSeconds)}</td><td className="p-2">{secs(item.p50Seconds)}</td><td className="p-2">{secs(item.p95Seconds)}</td><td className="p-2">{item.realTimeFactor == null ? '—' : `${num(item.realTimeFactor, 2)}x`}</td><td className="p-2">{item.estimatedUsd == null ? '—' : `$${num(item.estimatedUsd, 4)}`}</td></tr>) : <tr><td colSpan={8} className="p-6 text-center text-slate-500">لا توجد Job samples مكتملة بعد.</td></tr>}</tbody></table></div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[.8fr_1.2fr]">
          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><TestTube2 className="h-5 w-5 text-violet-300" /> SAFE LOAD / SOAK TEST</h2>
            <p className="mt-2 text-xs leading-5 text-slate-400">اختبار Control-Plane فقط: DB probe + V29 advisory-lock contention. لا يشغّل FFmpeg ولا ينشئ Media Jobs.</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2"><button disabled={!!busy || !!activeLoad} onClick={() => void act('load', () => runLoadTestV29('load', 15, 4), 'بدأ Synthetic Load Test لمدة 15 ثانية.')} className="rounded-xl bg-violet-300 px-4 py-3 text-xs font-black text-slate-950 disabled:opacity-40">LOAD · 15s · C4</button><button disabled={!!busy || !!activeLoad} onClick={() => void act('soak', () => runLoadTestV29('soak', 60, 2), 'بدأ Synthetic Soak Test لمدة 60 ثانية.')} className="rounded-xl border border-violet-400/30 bg-violet-500/10 px-4 py-3 text-xs font-black text-violet-100 disabled:opacity-40">SOAK · 60s · C2</button></div>
          </div>

          <div className={card()}>
            <h2 className="font-black">CAPACITY TEST HISTORY</h2>
            <div className="mt-3 overflow-auto"><table className="w-full min-w-[760px] text-right text-xs"><thead className="text-slate-500"><tr><th className="p-2">TYPE</th><th className="p-2">STATE</th><th className="p-2">STARTED</th><th className="p-2">OPS</th><th className="p-2">OPS/S</th><th className="p-2">P95</th><th className="p-2">ERRORS</th></tr></thead><tbody>{overview.loadTests.slice(0, 10).map(test => <tr key={test.id} className="border-t border-white/5"><td className="p-2 font-bold">{test.kind}</td><td className="p-2">{test.state}</td><td className="p-2">{when(test.startedAt)}</td><td className="p-2">{test.operations}</td><td className="p-2">{num(test.opsPerSecond, 2)}</td><td className="p-2">{ms(test.p95Ms)}</td><td className="p-2">{test.errors}</td></tr>)}</tbody></table></div>
          </div>
        </section>

        <section className={card()}>
          <h2 className="flex items-center gap-2 font-black"><Settings2 className="h-5 w-5 text-cyan-300" /> SLO / RELEASE POLICY</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-4">{settingKeys.map(key => <label key={key} className="rounded-xl border border-white/10 bg-black/10 p-3"><span className="block text-[10px] font-black text-slate-500">{key}</span><input type="number" step="0.1" value={draft[key] ?? overview.settings[key] ?? ''} onChange={event => setDraft(value => ({ ...value, [key]: Number(event.target.value) }))} className="mt-2 w-full rounded-lg border border-white/10 bg-[#070d17] px-3 py-2 text-sm outline-none focus:border-cyan-300/50" /></label>)}</div>
          <div className="mt-4 flex flex-wrap gap-4 text-xs"><label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(draft['release.requireDistributedSafe'] ?? overview.settings['release.requireDistributedSafe'])} onChange={event => setDraft(value => ({ ...value, 'release.requireDistributedSafe': event.target.checked }))} /> Require PostgreSQL distributed state</label><label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(draft['release.requireMultiReplica'] ?? overview.settings['release.requireMultiReplica'])} onChange={event => setDraft(value => ({ ...value, 'release.requireMultiReplica': event.target.checked }))} /> Require ≥2 live replicas</label></div>
          <button disabled={!!busy} onClick={() => void act('settings', () => saveSettingsV29(draft), 'تم حفظ SLO/Release Policy وإعادة تقييم Gate.')} className="mt-4 rounded-xl bg-cyan-300 px-5 py-2.5 text-xs font-black text-slate-950 disabled:opacity-40">SAVE SLO POLICY</button>
        </section>

        <section className="grid gap-5 xl:grid-cols-2">
          <div className={card()}><h2 className="flex items-center gap-2 font-black"><Server className="h-5 w-5 text-cyan-300" /> LIVE CAPACITY</h2><div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4"><div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">REPLICAS</div><div className="text-xl font-black">{overview.capacity.replicaCount}</div></div><div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">FFMPEG</div><div className="text-xl font-black">{overview.capacity.ffmpegActive}</div></div><div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">ACTIVE LEASES</div><div className="text-xl font-black">{overview.capacity.activeLeases}</div></div><div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">QUEUED</div><div className="text-xl font-black">{overview.capacity.queuedJobs}</div></div></div><div className="mt-3 grid gap-2 text-xs sm:grid-cols-3"><div className="flex items-center gap-2 rounded-xl border border-white/10 p-3"><Cpu className="h-4 w-4 text-slate-400" />Load 1m: {num(overview.capacity.load1, 2)} / {overview.capacity.cpuCount} CPU</div><div className="flex items-center gap-2 rounded-xl border border-white/10 p-3"><Activity className="h-4 w-4 text-slate-400" />Memory: {num(overview.capacity.memoryPercent, 1)}%</div><div className="flex items-center gap-2 rounded-xl border border-white/10 p-3"><HardDrive className="h-4 w-4 text-slate-400" />Disk: {num(overview.capacity.diskPercent, 1)}%</div></div></div>
          <div className={card()}><h2 className="flex items-center gap-2 font-black"><Database className="h-5 w-5 text-cyan-300" /> PLATFORM READINESS CONTEXT</h2><div className="mt-4 space-y-2 text-xs"><div className="flex justify-between rounded-xl bg-black/20 p-3"><span className="text-slate-500">V29 Schema</span><b>{overview.schema.current}/{overview.schema.latest}</b></div><div className="flex justify-between rounded-xl bg-black/20 p-3"><span className="text-slate-500">Identity DB</span><b>{overview.schema.databaseMode.toUpperCase()}</b></div><div className="flex justify-between rounded-xl bg-black/20 p-3"><span className="text-slate-500">V28 Ready</span><b>{overview.v28.ready ? 'YES' : 'NO'}</b></div><div className="flex justify-between rounded-xl bg-black/20 p-3"><span className="text-slate-500">Distributed Safe</span><b>{overview.v28.distributedSafe ? 'YES' : 'NO'}</b></div><div className="flex justify-between rounded-xl bg-black/20 p-3"><span className="text-slate-500">Observed Replicas</span><b>{overview.v28.replicaCount}</b></div></div></div>
        </section>

        <section className={card()}>
          <h2 className="font-black">RELEASE GATE HISTORY</h2>
          <div className="mt-3 overflow-auto"><table className="w-full min-w-[760px] text-right text-xs"><thead className="text-slate-500"><tr><th className="p-2">TIME</th><th className="p-2">VERSION</th><th className="p-2">STATE</th><th className="p-2">SCORE</th><th className="p-2">BLOCKERS</th><th className="p-2">WARNINGS</th></tr></thead><tbody>{overview.releaseHistory.map(item => <tr key={item.id || item.createdAt} className="border-t border-white/5"><td className="p-2">{when(item.createdAt)}</td><td className="p-2 font-bold">{item.versionLabel}</td><td className="p-2"><span className={`rounded-full border px-2 py-1 text-[10px] font-black ${gateTone(item.state)}`}>{item.state.toUpperCase()}</span></td><td className="p-2">{item.score}</td><td className="p-2">{item.blockers.length}</td><td className="p-2">{item.warnings.length}</td></tr>)}</tbody></table></div>
        </section>
      </div>
    </main>
  )
}
