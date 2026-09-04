import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, CheckCircle2, Clock3, Database, Download, FileText,
  GitBranch, GitCommit, Play, Plus, RefreshCw, Rocket, RotateCcw, Server,
  ShieldCheck, Tag, Trash2, XCircle,
} from 'lucide-react'
import {
  approveReleaseV31, createFreezeV31, createReleaseV31, deleteFreezeV31, evidenceUrlV31,
  getOverviewV31, prepareReleaseV31, promoteReleaseV31, rollbackReleaseV31,
  type V31Overview,
} from './lib/gitopsApiV31'

function shortSha(value?: string | null) {
  return value ? value.slice(0, 10) : '—'
}

function when(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ar-SA')
}

function tone(state: string) {
  if (['promoted', 'production'].includes(state)) return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
  if (['rolled_back', 'failed', 'blocked'].includes(state)) return 'border-rose-400/30 bg-rose-500/10 text-rose-100'
  if (['dev', 'staging', 'production_canary', 'prepared'].includes(state)) return 'border-cyan-400/30 bg-cyan-500/10 text-cyan-100'
  return 'border-amber-400/25 bg-amber-500/10 text-amber-100'
}

function card(ok = true) {
  return `rounded-2xl border p-4 ${ok ? 'border-white/10 bg-white/[0.035]' : 'border-amber-400/25 bg-amber-500/10'}`
}

const ENVIRONMENTS = ['dev', 'staging', 'production'] as const

export default function VideoStudioV31() {
  const [overview, setOverview] = useState<V31Overview | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [draft, setDraft] = useState({
    name: 'Creator V31 Release', repository: 'track2000one/MAGHRABI-Audio-Studio', candidateRef: 'main', baseSha: '',
    requireCiSuccess: true, productionApprovals: 1, useV30: true,
  })
  const [approvalReason, setApprovalReason] = useState('')
  const [rollbackSha, setRollbackSha] = useState('')
  const [freezeOverrideReason, setFreezeOverrideReason] = useState('')
  const [freezeDraft, setFreezeDraft] = useState({ name: 'Production Freeze', startAt: '', endAt: '', reason: '' })

  const load = useCallback(async () => {
    try {
      const data = await getOverviewV31()
      setOverview(data)
      setDraft(current => ({ ...current, repository: current.repository || data.github.repository }))
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل Creator V31.')
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
      await fn(); setMessage(success); await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : `فشلت عملية ${name}.`)
    } finally { setBusy('') }
  }

  const active = overview?.activeRelease
  const nextEnvironment = useMemo(() => {
    if (!active) return 'dev'
    const current = active.environment
    if (current === 'none') return 'dev'
    if (current === 'dev') return 'staging'
    if (current === 'staging') return 'production'
    return 'production'
  }, [active])

  useEffect(() => {
    if (active?.baseSha && !rollbackSha) setRollbackSha(active.baseSha)
  }, [active?.baseSha, rollbackSha])

  if (!overview) {
    return <main className="min-h-screen bg-[#050911] p-8 text-slate-100" dir="rtl"><div className="mx-auto max-w-xl rounded-3xl border border-white/10 bg-white/5 p-8 text-center"><Activity className="mx-auto mb-4 h-10 w-10 animate-pulse text-cyan-300" /><h1 className="text-xl font-black">Creator V31 GitOps</h1><p className="mt-2 text-sm text-slate-400">{error || 'جاري تحميل GitOps Release Control Room...'}</p>{error && <button onClick={() => void load()} className="mt-5 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950">RETRY</button>}</div></main>
  }

  const workflows = active?.github?.workflows || {}
  const commit = active?.github?.commit || {}
  const gate = active?.goNoGo
  const childV30 = active?.deployment?.v30ReleaseId

  return (
    <main className="min-h-screen bg-[#050911] text-slate-100" dir="rtl">
      <header className="border-b border-white/10 bg-[#070d17]/95 px-5 py-4 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1850px] flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-black tracking-[.18em] text-cyan-300"><GitBranch className="h-4 w-4" /> GITOPS · ENVIRONMENT PROMOTION · SIGNED APPROVALS · ROLLBACK</div>
            <h1 className="mt-1 text-2xl font-black">MAGHRABI Video Studio · Creator V31</h1>
            <p className="mt-1 text-xs text-slate-500">Git SHA Evidence · dev → staging → production · GitHub Actions · Change Freeze · V30 Progressive Production</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="#video-v30" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V30 DELIVERY</a>
            <a href="#video-v29" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V29 SLO</a>
            <button onClick={() => void load()} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950"><RefreshCw className="h-4 w-4" /> REFRESH</button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1850px] space-y-5 p-5">
        {(error || message) && <div className={`rounded-2xl border px-4 py-3 text-sm ${error ? 'border-rose-400/30 bg-rose-500/10 text-rose-200' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'}`}>{error || message}</div>}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className={card(overview.schema.databaseMode === 'postgresql')}><Database className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">RELEASE DATABASE</div><div className="mt-1 text-lg font-black">{overview.schema.databaseMode.toUpperCase()}</div><div className="text-xs text-slate-500">schema {overview.schema.current}/{overview.schema.latest}</div></div>
          <div className={card()}><GitCommit className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">GITHUB MODE</div><div className="mt-1 text-lg font-black">{overview.github.mode.toUpperCase()}</div><div className="truncate text-xs text-slate-500">{overview.github.repository}</div></div>
          <div className={card(overview.deploymentAdapter.configured)}><Server className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">DEPLOYMENT ADAPTER</div><div className="mt-1 text-lg font-black">{overview.deploymentAdapter.configured ? 'EXTERNAL' : 'CONTROL ONLY'}</div><div className="text-xs text-slate-500">{overview.deploymentAdapter.mode}</div></div>
          <div className={card(overview.v30.traffic?.configured)}><Rocket className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">V30 PRODUCTION CANARY</div><div className="mt-1 text-lg font-black">{overview.v30.traffic?.configured ? 'READY' : 'MANUAL'}</div><div className="text-xs text-slate-500">{overview.v30.traffic?.mode || '—'}</div></div>
          <div className={card(!gate || gate.ready)}><ShieldCheck className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">GO / NO-GO</div><div className="mt-1 text-lg font-black">{gate ? (gate.ready ? 'GO' : 'NO-GO') : 'WAITING'}</div><div className="text-xs text-slate-500">next: {gate?.environment || nextEnvironment}</div></div>
          <div className={card(!active?.blockers?.length)}><GitBranch className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">ACTIVE RELEASE</div><div className="mt-1 truncate text-lg font-black">{active?.name || 'NONE'}</div><div className="text-xs text-slate-500">{active?.state?.toUpperCase() || 'No active release'}</div></div>
        </section>

        {active ? <>
          <section className={`${card(!active.blockers?.length)} ${tone(active.state)}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-black">{active.name}</h2>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs opacity-80">
                  <span>{active.repository}</span><span>ref: <b>{active.candidateRef}</b></span><span>candidate: <b className="font-mono">{shortSha(active.candidateSha)}</b></span><span>base: <b className="font-mono">{shortSha(active.baseSha)}</b></span>
                </div>
              </div>
              <span className="rounded-full border border-current/25 px-3 py-1 text-xs font-black">{active.state.toUpperCase()} · {active.environment.toUpperCase()}</span>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-3">
              {ENVIRONMENTS.map((env, index) => {
                const currentIndex = ENVIRONMENTS.indexOf(active.environment as any)
                const done = currentIndex >= index
                const next = nextEnvironment === env && !['promoted','rolled_back'].includes(active.state)
                return <div key={env} className={`rounded-2xl border p-4 ${done ? 'border-emerald-400/25 bg-emerald-500/10' : next ? 'border-cyan-400/30 bg-cyan-500/10' : 'border-white/10 bg-black/15'}`}><div className="text-[10px] font-black opacity-60">ENVIRONMENT {index + 1}</div><div className="mt-1 text-xl font-black">{env.toUpperCase()}</div><div className="mt-1 text-xs opacity-60">{done ? 'promoted' : next ? 'next target' : 'pending'}</div></div>
              })}
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <button disabled={!!busy || ['promoted','rolled_back'].includes(active.state)} onClick={() => void act('prepare', () => prepareReleaseV31(active.id), 'تم تحديث GitHub Actions evidence وRelease Notes.')} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950 disabled:opacity-40"><GitCommit className="h-4 w-4" /> PREPARE / REFRESH EVIDENCE</button>
              {!['promoted','rolled_back'].includes(active.state) && <button disabled={!!busy} onClick={() => void act('approve', () => approveReleaseV31(active.id, nextEnvironment, 'approve', approvalReason), `تم توقيع موافقة ${nextEnvironment}.`)} className="flex items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-2 text-xs font-black text-emerald-100 disabled:opacity-40"><ShieldCheck className="h-4 w-4" /> SIGN APPROVAL · {nextEnvironment.toUpperCase()}</button>}
              {!['promoted','rolled_back'].includes(active.state) && <button disabled={!!busy} onClick={() => void act('reject', () => approveReleaseV31(active.id, nextEnvironment, 'reject', approvalReason || 'Release rejected from V31 UI'), `تم تسجيل Reject على ${nextEnvironment}.`)} className="flex items-center gap-2 rounded-xl border border-rose-400/25 px-4 py-2 text-xs font-black text-rose-100 disabled:opacity-40"><XCircle className="h-4 w-4" /> REJECT</button>}
              {!['promoted','rolled_back'].includes(active.state) && <button disabled={!!busy || !gate?.ready} onClick={() => void act('promote', () => promoteReleaseV31(active.id), `تم تنفيذ Promotion إلى ${nextEnvironment}.`)} className="flex items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-2 text-xs font-black text-emerald-100 disabled:opacity-40"><Play className="h-4 w-4" /> PROMOTE → {nextEnvironment.toUpperCase()}</button>}
              <a href={evidenceUrlV31(active.id)} className="flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-xs font-black"><Download className="h-4 w-4" /> GITOPS EVIDENCE ZIP</a>
            </div>

            {!['promoted','rolled_back'].includes(active.state) && <div className="mt-3 grid gap-2 md:grid-cols-2"><input value={approvalReason} onChange={e => setApprovalReason(e.target.value)} placeholder="Approval / rejection note" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none" />{gate?.activeFreezes?.length ? <div className="flex gap-2"><input value={freezeOverrideReason} onChange={e => setFreezeOverrideReason(e.target.value)} placeholder="Emergency freeze override reason" className="min-w-0 flex-1 rounded-xl border border-amber-400/25 bg-black/20 px-3 py-2 text-xs" /><button disabled={!!busy || !freezeOverrideReason.trim()} onClick={() => void act('freeze-override', () => promoteReleaseV31(active.id, true, freezeOverrideReason), `تم Promotion إلى ${nextEnvironment} مع Freeze Override مسجل.`)} className="rounded-xl border border-amber-400/25 px-3 py-2 text-xs font-black text-amber-100 disabled:opacity-40">OVERRIDE + PROMOTE</button></div> : <div className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-500">لا توجد Change Freeze نشطة على المرحلة الحالية.</div>}</div>}
          </section>

          <section className="grid gap-5 xl:grid-cols-3">
            <div className={card(workflows.success)}>
              <h2 className="flex items-center gap-2 font-black"><GitCommit className="h-5 w-5 text-cyan-300" /> GITHUB EVIDENCE</h2>
              <div className="mt-4 space-y-2 text-xs">
                <div className="rounded-xl bg-black/20 p-3">SHA <b className="float-left font-mono">{shortSha(commit.sha || active.candidateSha)}</b></div>
                <div className="rounded-xl bg-black/20 p-3">CI status <b className={`float-left ${workflows.success ? 'text-emerald-300' : 'text-amber-300'}`}>{workflows.success ? 'SUCCESS' : 'NOT READY'}</b></div>
                <div className="rounded-xl bg-black/20 p-3">Completed workflows <b className="float-left">{workflows.completed ?? 0}</b></div>
                <div className="rounded-xl bg-black/20 p-3">Failures <b className="float-left">{workflows.failures ?? 0}</b></div>
              </div>
              <div className="mt-3 space-y-2">{(workflows.runs || []).slice(0,5).map((run: any) => <div key={run.id} className="rounded-xl border border-white/10 p-3 text-xs"><b>{run.name}</b><span className="float-left">{String(run.conclusion || run.status).toUpperCase()}</span></div>)}</div>
            </div>

            <div className={card(gate?.ready ?? true)}>
              <h2 className="flex items-center gap-2 font-black"><ShieldCheck className="h-5 w-5 text-cyan-300" /> SIGNED APPROVAL GATE</h2>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs"><div className="rounded-xl bg-black/20 p-3"><b className="block text-xl">{gate?.approvals?.required ?? 0}</b>Required</div><div className="rounded-xl bg-black/20 p-3"><b className="block text-xl text-emerald-300">{gate?.approvals?.approved ?? 0}</b>Approved</div><div className="rounded-xl bg-black/20 p-3"><b className="block text-xl text-rose-300">{gate?.approvals?.rejected ?? 0}</b>Rejected</div></div>
              <div className="mt-4 space-y-2">{gate?.blockers?.map((item, i) => <div key={`b-${i}`} className="flex gap-2 rounded-xl border border-rose-400/20 bg-rose-500/10 p-3 text-xs text-rose-100"><AlertTriangle className="h-4 w-4 shrink-0" />{item}</div>)}{gate?.warnings?.map((item, i) => <div key={`w-${i}`} className="rounded-xl border border-amber-400/20 bg-amber-500/10 p-3 text-xs text-amber-100">{item}</div>)}</div>
              <div className="mt-3 space-y-2">{gate?.approvals?.items?.map((item: any) => <div key={item.id} className="rounded-xl border border-white/10 p-3 text-xs"><b>{item.actorName || item.actorId}</b><span className={`float-left ${item.decision === 'approve' ? 'text-emerald-300' : 'text-rose-300'}`}>{item.decision.toUpperCase()} · {item.signatureValid ? 'SIGNED' : 'INVALID'}</span></div>)}</div>
            </div>

            <div className={card(overview.deploymentAdapter.configured)}>
              <h2 className="flex items-center gap-2 font-black"><Server className="h-5 w-5 text-cyan-300" /> DEPLOYMENT / V30</h2>
              <p className="mt-3 text-xs leading-6 text-slate-400">{overview.deploymentAdapter.note}</p>
              <div className="mt-3 rounded-xl bg-black/20 p-3 text-xs">Last environment <b className="float-left">{active.environment.toUpperCase()}</b></div>
              <div className="mt-2 rounded-xl bg-black/20 p-3 text-xs">V30 child <b className="float-left">{childV30 ? String(active.deployment?.v30State || childV30) : 'NONE'}</b></div>
              {childV30 && <div className="mt-2 rounded-xl bg-black/20 p-3 text-xs">Canary traffic <b className="float-left">{active.deployment?.v30TrafficPercent ?? 0}%</b></div>}
              <div className="mt-4 rounded-xl border border-white/10 p-3 font-mono text-[11px] text-slate-400">V31_DEPLOY_WEBHOOK_URL<br />V31_DEPLOY_WEBHOOK_TOKEN<br />V30_TRAFFIC_WEBHOOK_URL</div>
            </div>
          </section>

          <section className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
            <div className={card()}>
              <h2 className="flex items-center gap-2 font-black"><FileText className="h-5 w-5 text-cyan-300" /> AUTO RELEASE NOTES</h2>
              <div className="mt-4 max-h-80 space-y-2 overflow-auto">{(active.notes || []).map((item: any, index: number) => <div key={`${item.sha}-${index}`} className="rounded-xl border border-white/10 p-3 text-xs"><div className="flex items-center justify-between gap-3"><b className="font-mono text-cyan-200">{shortSha(item.sha)}</b><span className="text-slate-500">{item.author || '—'} · {when(item.date)}</span></div><div className="mt-2 text-slate-300">{item.message || 'No message'}</div></div>)}{!active.notes?.length && <div className="text-xs text-slate-500">اضغط PREPARE لجمع Release Notes من GitHub Compare.</div>}</div>
            </div>
            <div className={card()}>
              <h2 className="flex items-center gap-2 font-black"><RotateCcw className="h-5 w-5 text-rose-300" /> SHA ROLLBACK</h2>
              <p className="mt-3 text-xs leading-6 text-slate-400">Rollback يستهدف SHA محددًا. إذا لم يكن Deployment Adapter مهيأ فسيُسجل كـControl-plane operation فقط.</p>
              <input value={rollbackSha} onChange={e => setRollbackSha(e.target.value)} placeholder="Rollback Git SHA" className="mt-4 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs" />
              <button disabled={!!busy || !rollbackSha.trim()} onClick={() => void act('rollback', () => rollbackReleaseV31(active.id, rollbackSha, active.environment || 'production'), `تم Rollback إلى ${shortSha(rollbackSha)}.`)} className="mt-3 flex items-center gap-2 rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-2 text-xs font-black text-rose-100 disabled:opacity-40"><RotateCcw className="h-4 w-4" /> ROLLBACK SHA</button>
            </div>
          </section>
        </> : <section className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><Rocket className="h-5 w-5 text-cyan-300" /> NEW GITOPS RELEASE</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="text-xs"><span className="mb-1 block text-slate-500">Release name</span><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2" /></label>
              <label className="text-xs"><span className="mb-1 block text-slate-500">Repository owner/name</span><input value={draft.repository} onChange={e => setDraft({ ...draft, repository: e.target.value })} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2" /></label>
              <label className="text-xs"><span className="mb-1 block text-slate-500">Candidate ref / tag / SHA</span><input value={draft.candidateRef} onChange={e => setDraft({ ...draft, candidateRef: e.target.value })} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono" /></label>
              <label className="text-xs"><span className="mb-1 block text-slate-500">Base production SHA (optional)</span><input value={draft.baseSha} onChange={e => setDraft({ ...draft, baseSha: e.target.value })} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono" /></label>
              <label className="text-xs"><span className="mb-1 block text-slate-500">Production approvals</span><input type="number" min={0} max={10} value={draft.productionApprovals} onChange={e => setDraft({ ...draft, productionApprovals: Number(e.target.value) })} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2" /></label>
            </div>
            <div className="mt-4 flex flex-wrap gap-5 text-xs"><label><input type="checkbox" checked={draft.requireCiSuccess} onChange={e => setDraft({ ...draft, requireCiSuccess: e.target.checked })} className="ml-2" />Require GitHub CI Success</label><label><input type="checkbox" checked={draft.useV30} onChange={e => setDraft({ ...draft, useV30: e.target.checked })} className="ml-2" />Use V30 for Production Canary when configured</label></div>
            <button disabled={!!busy || !draft.repository.trim() || !draft.candidateRef.trim()} onClick={() => void act('create', () => createReleaseV31({ name:draft.name, repository:draft.repository, candidateRef:draft.candidateRef, baseSha:draft.baseSha || undefined, manifest:{ requireCiSuccess:draft.requireCiSuccess, requiredApprovals:{dev:0,staging:0,production:draft.productionApprovals}, useV30ProgressiveProduction:draft.useV30 } }), 'تم إنشاء GitOps Release. اضغط PREPARE لجمع GitHub Evidence.')} className="mt-5 flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-3 text-xs font-black text-slate-950 disabled:opacity-40"><Plus className="h-4 w-4" /> CREATE RELEASE</button>
          </div>
          <div className={card(overview.deploymentAdapter.configured)}><h2 className="flex items-center gap-2 font-black"><Server className="h-5 w-5 text-amber-300" /> GITOPS ADAPTER STATUS</h2><div className="mt-4 rounded-xl bg-black/20 p-4 text-sm"><b>{overview.deploymentAdapter.mode.toUpperCase()}</b><p className="mt-2 text-xs leading-6 text-slate-400">{overview.deploymentAdapter.note}</p></div><div className="mt-3 rounded-xl border border-white/10 p-3 text-xs"><Tag className="mb-2 h-4 w-4 text-cyan-300" />GitHub token: {overview.github.tokenConfigured ? 'CONFIGURED' : 'PUBLIC API MODE'}</div></div>
        </section>}

        <section className="grid gap-5 xl:grid-cols-[1fr_1fr]">
          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><Clock3 className="h-5 w-5 text-amber-300" /> CHANGE FREEZE WINDOWS</h2>
            <div className="mt-4 grid gap-2 md:grid-cols-4"><input value={freezeDraft.name} onChange={e => setFreezeDraft({ ...freezeDraft, name:e.target.value })} placeholder="Freeze name" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs" /><input type="datetime-local" value={freezeDraft.startAt} onChange={e => setFreezeDraft({ ...freezeDraft, startAt:e.target.value })} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs" /><input type="datetime-local" value={freezeDraft.endAt} onChange={e => setFreezeDraft({ ...freezeDraft, endAt:e.target.value })} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs" /><button disabled={!!busy || !freezeDraft.startAt || !freezeDraft.endAt} onClick={() => void act('freeze', () => createFreezeV31({ name:freezeDraft.name, startAt:new Date(freezeDraft.startAt).toISOString(), endAt:new Date(freezeDraft.endAt).toISOString(), reason:freezeDraft.reason }), 'تم إنشاء Change Freeze Window.')} className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs font-black text-amber-100 disabled:opacity-40">ADD FREEZE</button></div>
            <input value={freezeDraft.reason} onChange={e => setFreezeDraft({ ...freezeDraft, reason:e.target.value })} placeholder="Freeze reason" className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs" />
            <div className="mt-4 space-y-2">{overview.freezes.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 p-3 text-xs"><div><b>{item.name}</b><div className="text-slate-500">{when(item.startAt)} → {when(item.endAt)}</div></div><div className="text-slate-400">{item.reason || 'No reason'}</div><button onClick={() => void act(`delete-freeze-${item.id}`, () => deleteFreezeV31(item.id), 'تم حذف Freeze Window.')} className="rounded-lg border border-rose-400/20 p-2 text-rose-200"><Trash2 className="h-4 w-4" /></button></div>)}{!overview.freezes.length && <div className="text-xs text-slate-500">لا توجد Change Freeze Windows.</div>}</div>
          </div>

          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><FileText className="h-5 w-5 text-cyan-300" /> RELEASE HISTORY</h2>
            <div className="mt-4 space-y-2">{overview.releases.slice(0,12).map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 p-3 text-xs"><div><b>{item.name}</b><div className="font-mono text-slate-500">{shortSha(item.candidateSha)} · {item.environment}</div></div><span className={`rounded-full border px-2 py-1 ${tone(item.state)}`}>{item.state.toUpperCase()}</span><a href={evidenceUrlV31(item.id)} className="rounded-lg border border-white/10 p-2"><Download className="h-4 w-4" /></a></div>)}</div>
          </div>
        </section>
      </div>
    </main>
  )
}
