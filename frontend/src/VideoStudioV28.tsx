import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, CheckCircle2, Clock3, CopyCheck, Database, Download,
  Network, RefreshCw, Server, ShieldCheck, Skull, TimerReset, Wrench, Zap,
} from 'lucide-react'
import {
  getOverviewV28, runDrainSimulationV28, runDuplicateContestV28, runWorkerKillV28,
  type V28Drill, type V28Overview,
} from './lib/reliabilityApiV28'

function when(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ar-SA')
}

function duration(ms?: number | null) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
}

function card(good = true) {
  return `rounded-2xl border p-4 ${good ? 'border-white/10 bg-white/[0.035]' : 'border-amber-400/25 bg-amber-500/10'}`
}

function Badge({ children, good = true }: { children: React.ReactNode; good?: boolean }) {
  return <span className={`rounded-full border px-2 py-1 text-[10px] font-black ${good ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200' : 'border-amber-400/25 bg-amber-500/10 text-amber-100'}`}>{children}</span>
}

function drillGood(drill: V28Drill) {
  return drill.state === 'passed'
}

export default function VideoStudioV28() {
  const [overview, setOverview] = useState<V28Overview | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await getOverviewV28()
      setOverview(data)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل Creator V28.')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5000)
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

  const activeDrill = useMemo(() => overview?.drills.find(item => !['passed', 'failed', 'interrupted'].includes(item.state)), [overview])
  const lastKill = useMemo(() => overview?.drills.find(item => item.kind === 'worker-kill'), [overview])
  const lastDuplicate = useMemo(() => overview?.drills.find(item => item.kind === 'duplicate-contest'), [overview])

  if (!overview) {
    return (
      <main className="min-h-screen bg-[#050911] p-8 text-slate-100" dir="rtl">
        <div className="mx-auto max-w-xl rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
          <Activity className="mx-auto mb-4 h-10 w-10 animate-pulse text-cyan-300" />
          <h1 className="text-xl font-black">Creator V28 Chaos Engineering</h1>
          <p className="mt-2 text-sm text-slate-400">{error || 'جاري تحميل Chaos Control Room...'}</p>
          {error && <button onClick={() => void load()} className="mt-5 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950">RETRY</button>}
        </div>
      </main>
    )
  }

  const targetOk = overview.lastRtoMs == null || overview.lastRtoMs <= overview.targets.rtoMs

  return (
    <main className="min-h-screen bg-[#050911] text-slate-100" dir="rtl">
      <header className="border-b border-white/10 bg-[#070d17]/95 px-5 py-4 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1780px] flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-black tracking-[.18em] text-cyan-300"><Skull className="h-4 w-4" /> REAL CHAOS · MULTI-REPLICA VALIDATION</div>
            <h1 className="mt-1 text-2xl font-black">MAGHRABI Video Studio · Creator V28</h1>
            <p className="mt-1 text-xs text-slate-500">SIGKILL Worker · Lease Takeover · RTO · Duplicate Prevention · Leader Election · Drain Validation</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="#video-v27" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V27 WORKERS</a>
            <a href="#video-v26" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V26 RELIABILITY</a>
            <a href="#video-v25" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V25 OPS</a>
            <button onClick={() => void load()} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950"><RefreshCw className="h-4 w-4" /> REFRESH</button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1780px] space-y-5 p-5">
        {(error || message) && <div className={`rounded-2xl border px-4 py-3 text-sm ${error ? 'border-rose-400/30 bg-rose-500/10 text-rose-200' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'}`}>{error || message}</div>}
        {activeDrill && <div className="rounded-2xl border border-cyan-400/25 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">Chaos Drill قيد التنفيذ: <b>{activeDrill.kind}</b> · {activeDrill.state}. التحديث تلقائي كل 5 ثوانٍ.</div>}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
          <div className={card(overview.ready)}><ShieldCheck className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">V28 READINESS</div><div className="mt-1 text-xl font-black">{overview.ready ? 'READY' : 'NOT READY'}</div></div>
          <div className={card(overview.distributedSafe)}><Database className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">DISTRIBUTED STATE</div><div className="mt-1 text-xl font-black">{overview.distributedSafe ? 'POSTGRES' : 'LOCAL ONLY'}</div></div>
          <div className={card(overview.multiReplicaObserved)}><Network className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">LIVE REPLICAS</div><div className="mt-1 text-xl font-black">{overview.replicaCount}</div><div className="text-xs text-slate-400">{overview.multiReplicaObserved ? 'Multi-replica observed' : 'Single replica observed'}</div></div>
          <div className={card(Boolean(overview.leader.nodeId))}><Server className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">LEADER EPOCH</div><div className="mt-1 text-xl font-black">{overview.leader.epoch}</div><div className="truncate text-xs text-slate-400">{overview.leader.nodeId || 'No leader'}</div></div>
          <div className={card(targetOk)}><TimerReset className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">LAST RTO</div><div className="mt-1 text-xl font-black">{duration(overview.lastRtoMs)}</div><div className="text-xs text-slate-400">Target ≤ {duration(overview.targets.rtoMs)}</div></div>
          <div className={card(!lastDuplicate || drillGood(lastDuplicate))}><CopyCheck className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">DUPLICATE COMMIT</div><div className="mt-1 text-xl font-black">{lastDuplicate?.duplicateCount ?? 0}</div><div className="text-xs text-slate-400">Target = 0</div></div>
          <div className={card(Boolean(overview.v27.managedReady))}><Zap className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">V27 MANAGED</div><div className="mt-1 text-xl font-black">{overview.v27.managedReady ? 'READY' : 'CHECK'}</div><div className="text-xs text-slate-400">{overview.v27.coverage?.coveragePercent ?? 0}% coverage</div></div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><Skull className="h-5 w-5 text-rose-300" /> REAL WORKER KILL / TAKEOVER</h2>
            <p className="mt-2 text-xs leading-5 text-slate-400">يشغل subprocess مستقلة، ينتظر Heartbeat حقيقية، يرسل SIGKILL للعملية فقط، ينتظر انتهاء Lease، ثم يشغّل Replacement Worker ويقيس RTO. خدمة FastAPI نفسها لا تُقتل.</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <button disabled={!!busy || !!activeDrill} onClick={() => void run('real-kill', () => runWorkerKillV28(false), 'بدأ Real Policy Worker Kill Drill. سيستغرق TTL + Retry Backoff الفعلي.') } className="rounded-2xl bg-rose-400 px-4 py-3 text-xs font-black text-slate-950 disabled:opacity-40">REAL POLICY SIGKILL DRILL</button>
              <button disabled={!!busy || !!activeDrill} onClick={() => void run('fast-kill', () => runWorkerKillV28(true), 'بدأ Fast Lab Worker Kill Drill. SIGKILL حقيقي مع Backoff مختصر للاختبار.') } className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-xs font-black text-rose-100 disabled:opacity-40">FAST LAB SIGKILL DRILL</button>
            </div>
            {lastKill && <div className="mt-4 grid gap-2 sm:grid-cols-4">
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">STATE</div><div className="font-black">{lastKill.state}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">RTO</div><div className="font-black">{duration(lastKill.rtoMs)}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">FULL RECOVERY</div><div className="font-black">{duration(lastKill.recoveryMs)}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">ATTEMPT</div><div className="font-black">{lastKill.leaseAttempt}</div></div>
            </div>}
          </div>

          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><CopyCheck className="h-5 w-5 text-violet-300" /> DUPLICATE EXECUTION CONTEST</h2>
            <p className="mt-2 text-xs leading-5 text-slate-400">أربع subprocesses تبدأ في اللحظة نفسها وتحاول الاستحواذ على نفس jobKey. النجاح = Lease winner واحد فقط وCommit واحد فقط.</p>
            <button disabled={!!busy || !!activeDrill} onClick={() => void run('duplicate', () => runDuplicateContestV28(4), 'بدأ Duplicate Execution Contest بأربع عمليات مستقلة.') } className="mt-4 w-full rounded-2xl bg-violet-300 px-4 py-3 text-xs font-black text-slate-950 disabled:opacity-40">RUN 4-PROCESS CONTEST</button>
            {lastDuplicate && <div className="mt-4 rounded-xl bg-black/20 p-3 text-xs"><div className="flex justify-between"><span className="text-slate-500">State</span><b>{lastDuplicate.state}</b></div><div className="mt-2 flex justify-between"><span className="text-slate-500">Winners</span><b>{String(lastDuplicate.details.winners ?? '—')}</b></div><div className="mt-2 flex justify-between"><span className="text-slate-500">Commits</span><b>{String(lastDuplicate.details.commitCount ?? '—')}</b></div></div>}
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1fr_1fr]">
          <div className={card(overview.replicaCount >= 2)}>
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 font-black"><Network className="h-5 w-5 text-cyan-300" /> MULTI-REPLICA / LEADER ELECTION</h2><p className="text-xs text-slate-500">Leader TTL = {overview.targets.leaderTtlSeconds}s · Epoch {overview.leader.epoch}</p></div><Badge good={overview.multiReplicaObserved}>{overview.multiReplicaObserved ? 'MULTI-REPLICA' : 'ONE REPLICA'}</Badge></div>
            <div className="mt-4 overflow-auto"><table className="w-full min-w-[650px] text-right text-xs"><thead className="text-slate-500"><tr><th className="p-2">NODE</th><th className="p-2">STATE</th><th className="p-2">DEPLOYMENT</th><th className="p-2">HEARTBEAT</th></tr></thead><tbody>{overview.nodes.map(node => <tr key={node.id} className="border-t border-white/5"><td className="p-2 font-mono">{node.id}</td><td className="p-2"><Badge good={node.state === 'ready'}>{node.state}</Badge></td><td className="p-2 font-mono text-slate-400">{node.deploymentId || '—'}</td><td className="p-2">{when(node.heartbeatAt)}</td></tr>)}</tbody></table></div>
          </div>

          <div className={card(overview.capabilities.drainSimulation)}>
            <h2 className="flex items-center gap-2 font-black"><Wrench className="h-5 w-5 text-amber-300" /> DEPLOYMENT DRAIN VALIDATION</h2>
            <p className="mt-2 text-xs leading-5 text-slate-400">متاحة فقط عند PostgreSQL + Replica ثانية حية. تجعل هذه Replica Draining مؤقتًا وتنتظر Leases الحالية ثم تعيدها Ready.</p>
            <button disabled={!!busy || !overview.capabilities.drainSimulation} onClick={() => void run('drain', () => runDrainSimulationV28(10), 'اكتمل Drain Simulation. راجع النتيجة أدناه.') } className="mt-4 w-full rounded-2xl bg-amber-300 px-4 py-3 text-xs font-black text-slate-950 disabled:opacity-40">SIMULATE 10s DRAIN</button>
            <div className="mt-4 space-y-2">{overview.drainChecks.slice(0, 4).map(item => <div key={item.id} className="rounded-xl bg-black/20 p-3 text-xs"><div className="flex justify-between gap-3"><b>{item.state}</b><span>{duration(item.durationMs)}</span></div><div className="mt-1 text-slate-500">Active: {item.activeBefore} → {item.activeAfter ?? '—'} · {when(item.startedAt)}</div></div>)}</div>
          </div>
        </section>

        <section className={card()}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 font-black"><Clock3 className="h-5 w-5 text-cyan-300" /> VALIDATION HISTORY</h2><p className="text-xs text-slate-500">آخر 30 Chaos/Concurrency drill محفوظة في قاعدة الهوية.</p></div><a href="/api/video/v28/admin/runbook" className="flex items-center gap-2 rounded-xl border border-cyan-300/30 bg-cyan-500/10 px-3 py-2 text-xs font-black text-cyan-100"><Download className="h-4 w-4" /> DR RUNBOOK</a></div>
          <div className="overflow-auto"><table className="w-full min-w-[1050px] text-right text-xs"><thead className="text-slate-500"><tr><th className="p-2">TYPE</th><th className="p-2">STATE</th><th className="p-2">START</th><th className="p-2">RTO</th><th className="p-2">RECOVERY</th><th className="p-2">DUPLICATES</th><th className="p-2">ATTEMPT</th><th className="p-2">ERROR</th></tr></thead><tbody>{overview.drills.map(item => <tr key={item.id} className="border-t border-white/5"><td className="p-2 font-bold">{item.kind}</td><td className="p-2">{item.state === 'passed' ? <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> passed</span> : item.state === 'failed' ? <span className="inline-flex items-center gap-1 text-rose-300"><AlertTriangle className="h-3.5 w-3.5" /> failed</span> : <span className="text-cyan-200">{item.state}</span>}</td><td className="p-2">{when(item.startedAt)}</td><td className="p-2">{duration(item.rtoMs)}</td><td className="p-2">{duration(item.recoveryMs)}</td><td className="p-2">{item.duplicateCount}</td><td className="p-2">{item.leaseAttempt || '—'}</td><td className="max-w-[320px] truncate p-2 text-rose-200" title={item.error || ''}>{item.error || '—'}</td></tr>)}</tbody></table></div>
        </section>
      </div>
    </main>
  )
}
