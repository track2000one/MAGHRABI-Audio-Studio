import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowUpRight, CheckCircle2, Download, Flag, GitBranch,
  Pause, Play, RefreshCw, RotateCcw, Rocket, ShieldCheck, SlidersHorizontal, Split,
  TimerReset, TrafficCone, TrendingUp, XCircle,
} from 'lucide-react'
import {
  createReleaseV30, deleteFlagV30, evaluateReleaseV30, evidenceUrlV30, getOverviewV30,
  pauseReleaseV30, promoteReleaseV30, resumeReleaseV30, rollbackReleaseV30, saveFlagV30, startReleaseV30,
  type V30Flag, type V30Overview,
} from './lib/progressiveApiV30'

function n(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits)
}

function when(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ar-SA')
}

function card(ok = true) {
  return `rounded-2xl border p-4 ${ok ? 'border-white/10 bg-white/[0.035]' : 'border-amber-400/25 bg-amber-500/10'}`
}

function stateTone(state: string) {
  if (['promoted', 'pass'].includes(state)) return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
  if (['rolled_back', 'block', 'rollback'].includes(state)) return 'border-rose-400/30 bg-rose-500/10 text-rose-100'
  if (['canary', 'promoting'].includes(state)) return 'border-cyan-400/30 bg-cyan-500/10 text-cyan-100'
  return 'border-amber-400/25 bg-amber-500/10 text-amber-100'
}

export default function VideoStudioV30() {
  const [overview, setOverview] = useState<V30Overview | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [draft, setDraft] = useState({
    name: 'Creator V30 Canary', currentVersion: 'production-current', candidateVersion: 'creator-v30',
    autoPromote: false, autoRollback: true, holdSeconds: 120, minSamplesPerCohort: 10,
    maxP95RegressionPct: 20, max5xxDeltaPct: 1,
  })
  const [flagDraft, setFlagDraft] = useState({ key: 'new-video-workflow', name: 'New Video Workflow', rolloutPercent: 10, enabled: false })

  const load = useCallback(async () => {
    try {
      const data = await getOverviewV30()
      setOverview(data); setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل Creator V30.')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 7000)
    return () => window.clearInterval(timer)
  }, [load])

  const act = async (name: string, fn: () => Promise<any>, success: string) => {
    setBusy(name); setError(''); setMessage('')
    try {
      await fn(); setMessage(success); await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : `فشلت عملية ${name}.`)
    } finally { setBusy('') }
  }

  const active = overview?.activeRelease
  const evaluation = active?.evaluation
  const cohorts = evaluation?.metrics.cohorts
  const stages: number[] = useMemo(() => {
    const raw = active?.manifest?.stages
    return Array.isArray(raw) ? raw.map(Number) : [5, 25, 50, 100]
  }, [active])

  if (!overview) {
    return <main className="min-h-screen bg-[#050911] p-8 text-slate-100" dir="rtl"><div className="mx-auto max-w-xl rounded-3xl border border-white/10 bg-white/5 p-8 text-center"><Activity className="mx-auto mb-4 h-10 w-10 animate-pulse text-cyan-300" /><h1 className="text-xl font-black">Creator V30 Progressive Delivery</h1><p className="mt-2 text-sm text-slate-400">{error || 'جاري تحميل Release Control Room...'}</p>{error && <button onClick={() => void load()} className="mt-5 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950">RETRY</button>}</div></main>
  }

  return (
    <main className="min-h-screen bg-[#050911] text-slate-100" dir="rtl">
      <header className="border-b border-white/10 bg-[#070d17]/95 px-5 py-4 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-black tracking-[.18em] text-cyan-300"><GitBranch className="h-4 w-4" /> PROGRESSIVE DELIVERY · CANARY · AUTO ROLLBACK</div>
            <h1 className="mt-1 text-2xl font-black">MAGHRABI Video Studio · Creator V30</h1>
            <p className="mt-1 text-xs text-slate-500">Release Manifest · 5→25→50→100 · Current vs Canary SLO · Feature Flags · Evidence Bundle · Go/No-Go</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="#video-v29" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V29 SLO</a>
            <a href="#video-v28" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V28 CHAOS</a>
            <button onClick={() => void load()} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950"><RefreshCw className="h-4 w-4" /> REFRESH</button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1800px] space-y-5 p-5">
        {(error || message) && <div className={`rounded-2xl border px-4 py-3 text-sm ${error ? 'border-rose-400/30 bg-rose-500/10 text-rose-200' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'}`}>{error || message}</div>}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className={card(overview.v29.releaseGate.state !== 'block')}><ShieldCheck className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">V29 BASELINE GATE</div><div className="mt-1 text-xl font-black">{overview.v29.releaseGate.state.toUpperCase()}</div><div className="text-xs text-slate-400">Score {overview.v29.releaseGate.score}/100</div></div>
          <div className={card(overview.traffic.configured)}><TrafficCone className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">TRAFFIC MODE</div><div className="mt-1 text-lg font-black">{overview.traffic.configured ? 'EXTERNAL WEBHOOK' : 'INTERNAL COHORT'}</div><div className="text-xs text-slate-400">{overview.traffic.configured ? 'Routing adapter configured' : 'No Railway traffic shift'}</div></div>
          <div className={card(!active || active.state !== 'rolled_back')}><Rocket className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">ACTIVE RELEASE</div><div className="mt-1 truncate text-lg font-black">{active?.name || 'NONE'}</div><div className="text-xs text-slate-400">{active?.state?.toUpperCase() || 'No active canary'}</div></div>
          <div className={card()}><Split className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">CANDIDATE TRAFFIC</div><div className="mt-1 text-xl font-black">{active?.appliedPercent ?? 0}%</div><div className="text-xs text-slate-400">desired {active?.desiredPercent ?? 0}%</div></div>
          <div className={card(evaluation?.decision !== 'rollback')}><TrendingUp className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">GO / NO-GO</div><div className="mt-1 text-xl font-black">{evaluation?.decision?.toUpperCase() || 'WAITING'}</div><div className="text-xs text-slate-400">{evaluation?.metrics.holdRemainingSeconds ?? 0}s hold remaining</div></div>
        </section>

        {active ? <>
          <section className={`${card(evaluation?.decision !== 'rollback')} ${stateTone(evaluation?.decision || active.state)}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h2 className="text-lg font-black">{active.name}</h2><p className="mt-1 text-xs opacity-70">{active.currentVersion} → {active.candidateVersion} · started {when(active.startedAt)}</p></div>
              <span className="rounded-full border border-current/25 px-3 py-1 text-xs font-black">{active.state.toUpperCase()}</span>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-4">
              {stages.map((stage, index) => {
                const done = active.appliedPercent >= stage
                const current = active.stageIndex === index && !['promoted', 'rolled_back'].includes(active.state)
                return <div key={stage} className={`rounded-2xl border p-4 ${done ? 'border-emerald-400/25 bg-emerald-500/10' : current ? 'border-cyan-400/30 bg-cyan-500/10' : 'border-white/10 bg-black/15'}`}><div className="text-[10px] font-black opacity-60">STAGE {index + 1}</div><div className="mt-1 text-2xl font-black">{stage}%</div><div className="text-xs opacity-60">{done ? 'applied' : current ? 'current' : 'pending'}</div></div>
              })}
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <button disabled={!!busy} onClick={() => void act('evaluate', () => evaluateReleaseV30(active.id), 'تم تقييم Current/Canary SLO.')} className="rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950 disabled:opacity-40">EVALUATE NOW</button>
              <button disabled={!!busy || active.state === 'paused' || !!evaluation?.blockers?.length} onClick={() => void act('promote', () => promoteReleaseV30(active.id), 'تم الانتقال إلى Canary Stage التالية.')} className="flex items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-2 text-xs font-black text-emerald-100 disabled:opacity-40"><ArrowUpRight className="h-4 w-4" /> PROMOTE</button>
              {active.state === 'paused' ? <button disabled={!!busy} onClick={() => void act('resume', () => resumeReleaseV30(active.id), 'تم استئناف Auto Controller مع الحفاظ على نسبة Canary الحالية.')} className="flex items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-2 text-xs font-black text-emerald-100 disabled:opacity-40"><Play className="h-4 w-4" /> RESUME</button> : <button disabled={!!busy} onClick={() => void act('pause', () => pauseReleaseV30(active.id), 'تم إيقاف Auto Controller مؤقتًا.')} className="flex items-center gap-2 rounded-xl border border-amber-400/25 px-4 py-2 text-xs font-black text-amber-100 disabled:opacity-40"><Pause className="h-4 w-4" /> PAUSE</button>}
              <button disabled={!!busy} onClick={() => void act('rollback', () => rollbackReleaseV30(active.id, 'Manual operator rollback'), 'تم Rollback إلى 0%.')} className="flex items-center gap-2 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-2 text-xs font-black text-rose-100 disabled:opacity-40"><RotateCcw className="h-4 w-4" /> ROLLBACK</button>
              <a href={evidenceUrlV30(active.id)} className="flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-xs font-black"><Download className="h-4 w-4" /> EVIDENCE ZIP</a>
            </div>
          </section>

          <section className="grid gap-5 xl:grid-cols-[1fr_1fr]">
            <div className={card()}>
              <h2 className="flex items-center gap-2 font-black"><SlidersHorizontal className="h-5 w-5 text-cyan-300" /> CURRENT vs CANDIDATE</h2>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-black/20 p-4"><div className="text-[10px] font-black text-slate-500">CURRENT</div><div className="mt-3 text-sm">Samples <b className="float-left">{cohorts?.current.samples ?? 0}</b></div><div className="mt-2 text-sm">P95 <b className="float-left">{n(cohorts?.current.p95Ms, 0)} ms</b></div><div className="mt-2 text-sm">5xx <b className="float-left">{n(cohorts?.current.error5xxPct, 3)}%</b></div></div>
                <div className="rounded-xl bg-black/20 p-4"><div className="text-[10px] font-black text-slate-500">CANDIDATE</div><div className="mt-3 text-sm">Samples <b className="float-left">{cohorts?.candidate.samples ?? 0}</b></div><div className="mt-2 text-sm">P95 <b className="float-left">{n(cohorts?.candidate.p95Ms, 0)} ms</b></div><div className="mt-2 text-sm">5xx <b className="float-left">{n(cohorts?.candidate.error5xxPct, 3)}%</b></div></div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs"><div className="rounded-xl border border-white/10 p-3">P95 Regression <b className="float-left">{n(cohorts?.p95RegressionPct, 2)}%</b></div><div className="rounded-xl border border-white/10 p-3">5xx Delta <b className="float-left">{n(cohorts?.error5xxDeltaPct, 3)}%</b></div></div>
            </div>
            <div className={card(evaluation?.decision !== 'rollback')}>
              <h2 className="flex items-center gap-2 font-black">{evaluation?.decision === 'rollback' ? <XCircle className="h-5 w-5 text-rose-300" /> : <CheckCircle2 className="h-5 w-5 text-emerald-300" />} CANARY DECISION</h2>
              <div className={`mt-4 rounded-xl border p-4 ${stateTone(evaluation?.decision || 'hold')}`}><div className="text-2xl font-black">{evaluation?.decision?.toUpperCase() || 'HOLD'}</div><div className="mt-1 text-xs opacity-70">Auto Promote: {active.autoPromote ? 'ON' : 'OFF'} · Auto Rollback: {active.autoRollback ? 'ON' : 'OFF'}</div></div>
              <div className="mt-4 space-y-2">{evaluation?.blockers?.map((item, index) => <div key={`b-${index}`} className="flex gap-2 rounded-xl border border-rose-400/20 bg-rose-500/10 p-3 text-xs text-rose-100"><AlertTriangle className="h-4 w-4 shrink-0" />{item}</div>)}{evaluation?.warnings?.map((item, index) => <div key={`w-${index}`} className="rounded-xl border border-amber-400/20 bg-amber-500/10 p-3 text-xs text-amber-100">{item}</div>)}</div>
            </div>
          </section>
        </> : <section className="grid gap-5 xl:grid-cols-[1fr_.8fr]">
          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><Rocket className="h-5 w-5 text-cyan-300" /> NEW RELEASE MANIFEST</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {(['name', 'currentVersion', 'candidateVersion'] as const).map(key => <label key={key} className="text-xs"><span className="mb-1 block text-slate-500">{key}</span><input value={String(draft[key])} onChange={e => setDraft({ ...draft, [key]: e.target.value })} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 outline-none" /></label>)}
              <label className="text-xs"><span className="mb-1 block text-slate-500">Hold seconds / stage</span><input type="number" value={draft.holdSeconds} onChange={e => setDraft({ ...draft, holdSeconds: Number(e.target.value) })} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2" /></label>
              <label className="text-xs"><span className="mb-1 block text-slate-500">Min samples / cohort</span><input type="number" value={draft.minSamplesPerCohort} onChange={e => setDraft({ ...draft, minSamplesPerCohort: Number(e.target.value) })} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2" /></label>
              <label className="text-xs"><span className="mb-1 block text-slate-500">Max P95 regression %</span><input type="number" value={draft.maxP95RegressionPct} onChange={e => setDraft({ ...draft, maxP95RegressionPct: Number(e.target.value) })} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2" /></label>
              <label className="text-xs"><span className="mb-1 block text-slate-500">Max 5xx delta %</span><input type="number" value={draft.max5xxDeltaPct} onChange={e => setDraft({ ...draft, max5xxDeltaPct: Number(e.target.value) })} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2" /></label>
            </div>
            <div className="mt-4 flex flex-wrap gap-4 text-xs"><label><input type="checkbox" checked={draft.autoPromote} onChange={e => setDraft({ ...draft, autoPromote: e.target.checked })} className="ml-2" />Auto Promote</label><label><input type="checkbox" checked={draft.autoRollback} onChange={e => setDraft({ ...draft, autoRollback: e.target.checked })} className="ml-2" />Auto Rollback</label></div>
            <button disabled={!!busy || overview.v29.releaseGate.state === 'block'} onClick={() => void act('create', async () => {
              const release = await createReleaseV30({ name: draft.name, currentVersion: draft.currentVersion, candidateVersion: draft.candidateVersion, autoPromote: draft.autoPromote, autoRollback: draft.autoRollback, manifest: { stages: [5, 25, 50, 100], holdSeconds: draft.holdSeconds, minSamplesPerCohort: draft.minSamplesPerCohort, maxP95RegressionPct: draft.maxP95RegressionPct, max5xxDeltaPct: draft.max5xxDeltaPct } })
              await startReleaseV30(release.id)
            }, 'تم إنشاء Release وبدء Canary Stage الأولى.')} className="mt-5 flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-3 text-xs font-black text-slate-950 disabled:opacity-40"><Play className="h-4 w-4" /> CREATE + START 5%</button>
          </div>
          <div className={card(overview.traffic.configured)}><h2 className="flex items-center gap-2 font-black"><TrafficCone className="h-5 w-5 text-amber-300" /> TRAFFIC ADAPTER</h2><p className="mt-3 text-xs leading-6 text-slate-400">{overview.traffic.note}</p><div className="mt-4 rounded-xl bg-black/20 p-4 font-mono text-xs">V30_TRAFFIC_WEBHOOK_URL<br />V30_TRAFFIC_WEBHOOK_TOKEN</div><p className="mt-3 text-[11px] text-slate-500">بدون Webhook، Canary percentages تستخدم فقط لتقسيم Cohorts داخل نفس التطبيق وقياسها؛ لا تغيّر Railway routing بين Deployments.</p></div>
        </section>}

        <section className="grid gap-5 xl:grid-cols-[1fr_1fr]">
          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><Flag className="h-5 w-5 text-violet-300" /> FEATURE FLAGS</h2>
            <div className="mt-4 grid gap-2 md:grid-cols-4"><input value={flagDraft.key} onChange={e => setFlagDraft({ ...flagDraft, key: e.target.value })} placeholder="flag-key" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs" /><input value={flagDraft.name} onChange={e => setFlagDraft({ ...flagDraft, name: e.target.value })} placeholder="Name" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs" /><input type="number" min={0} max={100} value={flagDraft.rolloutPercent} onChange={e => setFlagDraft({ ...flagDraft, rolloutPercent: Number(e.target.value) })} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs" /><button disabled={!!busy} onClick={() => void act('flag', () => saveFlagV30({ ...flagDraft, description: '', variantOn: 'on', variantOff: 'off' }), 'تم حفظ Feature Flag.')} className="rounded-xl bg-violet-300 px-3 py-2 text-xs font-black text-slate-950">SAVE FLAG</button></div>
            <div className="mt-4 space-y-2">{overview.flags.map((flag: V30Flag) => <div key={flag.key} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 p-3 text-xs"><div><b>{flag.name}</b><div className="font-mono text-slate-500">{flag.key}</div></div><div>{flag.enabled ? 'ON' : 'OFF'} · {flag.rolloutPercent}%</div><div className="flex gap-2"><button onClick={() => void act(`toggle-${flag.key}`, () => saveFlagV30({ ...flag, enabled: !flag.enabled }), 'تم تحديث Feature Flag.')} className="rounded-lg border border-white/10 px-2 py-1">TOGGLE</button><button onClick={() => void act(`delete-${flag.key}`, () => deleteFlagV30(flag.key), 'تم حذف Feature Flag.')} className="rounded-lg border border-rose-400/20 px-2 py-1 text-rose-200">DELETE</button></div></div>)}{!overview.flags.length && <div className="text-xs text-slate-500">لا توجد Feature Flags بعد.</div>}</div>
          </div>

          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><TimerReset className="h-5 w-5 text-cyan-300" /> RELEASE HISTORY</h2>
            <div className="mt-4 space-y-2">{overview.releases.slice(0, 12).map(item => <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 p-3 text-xs"><div><b>{item.name}</b><div className="text-slate-500">{item.currentVersion} → {item.candidateVersion}</div></div><div className={`rounded-full border px-2 py-1 ${stateTone(item.state)}`}>{item.state.toUpperCase()} · {item.appliedPercent}%</div><a href={evidenceUrlV30(item.id)} className="rounded-lg border border-white/10 p-2"><Download className="h-4 w-4" /></a></div>)}</div>
          </div>
        </section>
      </div>
    </main>
  )
}
