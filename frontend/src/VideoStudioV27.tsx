import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Activity, AlertTriangle, CheckCircle2, CircuitBoard, CloudCog, Gauge, HeartPulse,
  RefreshCw, RotateCcw, ServerCog, ShieldCheck, Siren, TimerReset, Workflow, XCircle,
} from 'lucide-react'
import { chaosDrillV27, getOverviewV27, reconcileV27, type V27Overview } from './lib/reliabilityApiV27'

function card(ok = true) {
  return `rounded-2xl border p-4 ${ok ? 'border-white/10 bg-white/[0.035]' : 'border-amber-400/30 bg-amber-500/10'}`
}

function Badge({ children, good = true }: { children: ReactNode; good?: boolean }) {
  return <span className={`rounded-full border px-2 py-1 text-[10px] font-black ${good ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200' : 'border-amber-400/25 bg-amber-500/10 text-amber-100'}`}>{children}</span>
}

function date(value?: string | null) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('ar-SA')
}

export default function VideoStudioV27() {
  const [overview, setOverview] = useState<V27Overview | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await getOverviewV27()
      setOverview(data)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل Creator V27.')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 8000)
    return () => window.clearInterval(timer)
  }, [load])

  const run = async (name: string, action: () => Promise<any>, success: string) => {
    setBusy(name); setError(''); setMessage('')
    try {
      await action()
      setMessage(success)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : `فشلت عملية ${name}.`)
    } finally {
      setBusy('')
    }
  }

  const dlqCount = useMemo(() => {
    if (!overview) return 0
    return Object.values(overview.managedLeaseCounts).reduce((sum, states) => sum + Number(states.dlq || 0), 0)
  }, [overview])

  const retryCount = useMemo(() => {
    if (!overview) return 0
    return Object.values(overview.managedLeaseCounts).reduce((sum, states) => sum + Number(states.retry_wait || 0), 0)
  }, [overview])

  if (!overview) {
    return (
      <main className="min-h-screen bg-[#050911] p-8 text-slate-100" dir="rtl">
        <div className="mx-auto max-w-xl rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
          <Workflow className="mx-auto mb-4 h-10 w-10 animate-pulse text-cyan-300" />
          <h1 className="text-xl font-black">Creator V27 Managed Workers</h1>
          <p className="mt-2 text-sm text-slate-400">{error || 'جاري تحميل Managed Worker Control Plane...'}</p>
          {error && <button onClick={() => void load()} className="mt-5 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950">RETRY</button>}
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#050911] text-slate-100" dir="rtl">
      <header className="border-b border-white/10 bg-[#070d17]/95 px-5 py-4 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1700px] flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-black tracking-[.18em] text-cyan-300"><CloudCog className="h-4 w-4" /> MANAGED WORKERS & DEPLOYMENT HARDENING</div>
            <h1 className="mt-1 text-2xl font-black">MAGHRABI Video Studio · Creator V27</h1>
            <p className="mt-1 text-xs text-slate-500">V12 Render · V13 Proxy · V20 Pipeline · V21 Orchestrator → V26 Lease Contract</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="#video-v26" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V26 RELIABILITY</a>
            <a href="#video-v21" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V21 ORCHESTRATOR</a>
            <button onClick={() => void load()} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950"><RefreshCw className="h-4 w-4" /> REFRESH</button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1700px] space-y-5 p-5">
        {(error || message) && <div className={`rounded-2xl border px-4 py-3 text-sm ${error ? 'border-rose-400/30 bg-rose-500/10 text-rose-200' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'}`}>{error || message}</div>}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className={card(overview.managedReady)}><HeartPulse className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">MANAGED READINESS</div><div className="mt-1 text-xl font-black">{overview.managedReady ? 'READY' : 'NOT READY'}</div><div className="text-xs text-slate-400">V26 + worker coverage</div></div>
          <div className={card(overview.v26Readiness.distributedSafe)}><ShieldCheck className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">DISTRIBUTED SAFE</div><div className="mt-1 text-xl font-black">{overview.v26Readiness.distributedSafe ? 'YES' : 'NO'}</div><div className="text-xs text-slate-400">{overview.v26Readiness.database.mode.toUpperCase()}</div></div>
          <div className={card(overview.coverage.activeUnmanaged === 0)}><Gauge className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">LEASE COVERAGE</div><div className="mt-1 text-xl font-black">{overview.coverage.coveragePercent}%</div><div className="text-xs text-slate-400">{overview.coverage.managedJobs}/{overview.coverage.totalJobs} historical+current</div></div>
          <div className={card(overview.coverage.activeUnmanaged === 0)}><AlertTriangle className="mb-3 h-5 w-5 text-amber-300" /><div className="text-[10px] font-black text-slate-500">ACTIVE UNMANAGED</div><div className="mt-1 text-xl font-black">{overview.coverage.activeUnmanaged}</div><div className="text-xs text-slate-400">should be zero</div></div>
          <div className={card(retryCount === 0)}><TimerReset className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">RETRY WAIT</div><div className="mt-1 text-xl font-black">{retryCount}</div><div className="text-xs text-slate-400">exponential backoff</div></div>
          <div className={card(dlqCount === 0)}><Siren className="mb-3 h-5 w-5 text-rose-300" /><div className="text-[10px] font-black text-slate-500">DLQ</div><div className="mt-1 text-xl font-black">{dlqCount}</div><div className="text-xs text-slate-400">managed worker dead letters</div></div>
        </section>

        <section className={card()}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="flex items-center gap-2 font-black"><ServerCog className="h-5 w-5 text-cyan-300" /> MANAGED WORKER COVERAGE</h2><p className="mt-1 text-xs text-slate-500">ActiveUnmanaged counts only queued/processing jobs that currently have no V27 lease record.</p></div>
            <button disabled={!!busy} onClick={() => void run('reconcile', reconcileV27, 'تم تنفيذ Reconcile لجميع Managed Workers.')} className="flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs font-black hover:bg-white/5"><RotateCcw className="h-4 w-4" /> RECONCILE NOW</button>
          </div>
          <div className="overflow-auto">
            <table className="w-full min-w-[850px] text-right text-xs">
              <thead className="text-slate-500"><tr><th className="p-2">WORKER</th><th className="p-2">TOTAL</th><th className="p-2">MANAGED</th><th className="p-2">ACTIVE UNMANAGED</th><th className="p-2">STATES</th><th className="p-2">STATUS</th></tr></thead>
              <tbody>{overview.coverage.integrations.map(item => <tr key={item.id} className="border-t border-white/5"><td className="p-2 font-bold">{item.label}</td><td className="p-2">{item.total}</td><td className="p-2">{item.managed}</td><td className="p-2">{item.activeUnmanaged}</td><td className="p-2 font-mono text-[11px] text-slate-400">{Object.entries(item.states).map(([k, v]) => `${k}:${v}`).join(' · ') || '—'}</td><td className="p-2"><Badge good={item.activeUnmanaged === 0}>{item.activeUnmanaged === 0 ? 'MANAGED' : 'MIGRATING'}</Badge></td></tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-2">
          <div className={card()}>
            <h2 className="mb-4 flex items-center gap-2 font-black"><CircuitBoard className="h-5 w-5 text-cyan-300" /> CIRCUIT BREAKERS</h2>
            <div className="space-y-2">{overview.circuits.map(item => <div key={item.name} className="rounded-xl border border-white/5 bg-black/20 p-3"><div className="flex items-center justify-between gap-3"><div><div className="font-mono text-xs font-bold">{item.name}</div><div className="mt-1 text-[11px] text-slate-500">failures {item.failureCount} · successes {item.successCount}</div></div><Badge good={item.state === 'closed'}>{item.state.toUpperCase()}</Badge></div>{item.lastFailure && <div className="mt-2 text-xs text-rose-200">{item.lastFailure}</div>}</div>)}</div>
          </div>

          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><Activity className="h-5 w-5 text-amber-300" /> CHAOS RECOVERY DRILL</h2>
            <p className="mt-2 text-xs leading-5 text-slate-400">اختبار Synthetic فقط: يوقف Heartbeat لLease اختبارية ويجبر انتهاءها، ثم يتحقق من Retry أو DLQ. لا يقتل FFmpeg ولا Railway service.</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <button disabled={!!busy} onClick={() => void run('chaos-retry', () => chaosDrillV27('retry'), 'نجح Chaos Retry Drill وتم تسجيل النتيجة.')} className="rounded-xl bg-amber-400 px-3 py-3 text-xs font-black text-slate-950">CHAOS → RETRY</button>
              <button disabled={!!busy} onClick={() => void run('chaos-dlq', () => chaosDrillV27('dlq'), 'نجح Chaos DLQ Drill وتم تسجيل النتيجة.')} className="rounded-xl bg-rose-500 px-3 py-3 text-xs font-black text-white">CHAOS → DLQ</button>
            </div>
            <div className="mt-4 space-y-2">{overview.chaosHistory.slice(0, 5).map(item => <div key={item.id} className="rounded-xl border border-white/5 bg-black/20 p-3 text-xs"><div className="flex items-center justify-between"><span>{date(item.createdAt)}</span><Badge good={item.details.finalState === 'retry_wait'}>{String(item.details.finalState || 'unknown').toUpperCase()}</Badge></div><div className="mt-1 font-mono text-[10px] text-slate-500">{String(item.details.jobKey || '')}</div></div>)}</div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
          <div className={card()}>
            <h2 className="mb-4 flex items-center gap-2 font-black"><Workflow className="h-5 w-5 text-cyan-300" /> WORKER CONTRACT</h2>
            <div className="grid gap-3 sm:grid-cols-5">{['ACQUIRE', 'HEARTBEAT', 'COMPLETE / FAIL', 'BACKOFF', 'RETRY / DLQ'].map((label, index) => <div key={label} className="rounded-xl border border-white/5 bg-black/20 p-3 text-center"><div className="text-[10px] font-black text-cyan-300">0{index + 1}</div><div className="mt-1 text-xs font-black">{label}</div></div>)}</div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(overview.semantics).map(([key, value]) => <div key={key} className="rounded-xl bg-white/[0.025] p-3"><div className="text-[10px] font-black uppercase text-slate-500">{key}</div><div className="mt-1 text-xs text-slate-300">{value}</div></div>)}</div>
          </div>

          <div className={card(overview.managedReady)}>
            <h2 className="flex items-center gap-2 font-black">{overview.managedReady ? <CheckCircle2 className="h-5 w-5 text-emerald-300" /> : <XCircle className="h-5 w-5 text-rose-300" />} DEPLOYMENT GATE</h2>
            <div className="mt-4 space-y-2 text-xs">
              <div className="flex justify-between rounded-xl bg-black/20 p-3"><span>V26 Ready</span><strong>{overview.v26Readiness.ready ? 'YES' : 'NO'}</strong></div>
              <div className="flex justify-between rounded-xl bg-black/20 p-3"><span>Database</span><strong>{overview.v26Readiness.database.mode.toUpperCase()}</strong></div>
              <div className="flex justify-between rounded-xl bg-black/20 p-3"><span>Distributed Safe</span><strong>{overview.v26Readiness.distributedSafe ? 'YES' : 'NO'}</strong></div>
              <div className="flex justify-between rounded-xl bg-black/20 p-3"><span>Active Unmanaged</span><strong>{overview.coverage.activeUnmanaged}</strong></div>
              <div className="flex justify-between rounded-xl bg-black/20 p-3"><span>Maintenance</span><strong>{overview.v26Readiness.maintenance.enabled ? 'ON' : 'OFF'}</strong></div>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
