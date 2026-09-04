import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CloudCog,
  DatabaseBackup,
  ExternalLink,
  Fingerprint,
  Gauge,
  GitBranch,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  TestTube2,
} from 'lucide-react'
import { getOverviewV40, type V40Overview } from './lib/productionApiV40'

const short = (value?: string | null, size = 12) => (value ? value.slice(0, size) : '—')
const when = (value?: string | null) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ar-SA')
}

const stageIcons: Record<string, typeof ShieldCheck> = {
  'v35-oci': PackageCheck,
  'v36-runtime': TestTube2,
  'v37-dr': DatabaseBackup,
  'v38-security': ShieldCheck,
  'v39-quality': Gauge,
  'v40-final': CloudCog,
}

function stageTone(conclusion?: string | null) {
  if (conclusion === 'success') return 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200'
  if (conclusion === 'failure' || conclusion === 'cancelled') return 'border-rose-400/25 bg-rose-500/10 text-rose-200'
  return 'border-amber-400/20 bg-amber-500/10 text-amber-200'
}

export default function VideoStudioV40() {
  const [overview, setOverview] = useState<V40Overview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getOverviewV40()
      setOverview(data)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل V40.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 10000)
    return () => window.clearInterval(timer)
  }, [load])

  const readiness = overview?.readiness
  const pipeline = readiness?.pipeline
  const release = overview?.activeRelease
  const stageEntries = useMemo(() => Object.entries(overview?.stages || {}), [overview?.stages])

  if (!overview) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#050911] p-6 text-slate-100" dir="rtl">
        <div className="w-full max-w-xl rounded-3xl border border-white/10 bg-white/[0.04] p-8 text-center">
          <CloudCog className="mx-auto mb-4 h-10 w-10 animate-pulse text-cyan-300" />
          <h1 className="text-xl font-black">Creator V40 · Final Production Readiness</h1>
          <p className="mt-2 text-sm text-slate-400">{error || 'جاري قراءة سلسلة الأدلة النهائية...'}</p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#050911] text-slate-100" dir="rtl">
      <header className="border-b border-white/10 bg-[#070d17]/95 px-5 py-4 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1850px] flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-black tracking-[.14em] text-cyan-300">
              <ShieldCheck className="h-4 w-4" /> FINAL · IMMUTABLE · SIGNED · TESTED · RECOVERABLE · NON-WAIVABLE
            </div>
            <h1 className="mt-1 text-2xl font-black">MAGHRABI Studio · Creator V40</h1>
            <p className="mt-1 text-xs text-slate-500">Final Production Readiness Control Room</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="#video-v34" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-black text-slate-300">V34 EVIDENCE</a>
            {pipeline?.runUrl && (
              <a href={pipeline.runUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl border border-cyan-300/20 px-3 py-2 text-xs font-black text-cyan-300">
                <ExternalLink className="h-4 w-4" /> GITHUB PIPELINE
              </a>
            )}
            <button onClick={() => void load()} disabled={loading} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950 disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> REFRESH
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1850px] space-y-5 p-5">
        {error && <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>}

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
            <GitBranch className="mb-2 h-5 w-5 text-cyan-300" />
            <div className="text-[10px] font-bold text-slate-500">CANDIDATE SHA</div>
            <div className="mt-1 font-mono text-sm font-black">{short(release?.candidateSha)}</div>
          </div>
          <div className={`rounded-2xl border p-4 ${pipeline?.success ? 'border-emerald-400/25 bg-emerald-500/10' : 'border-amber-400/25 bg-amber-500/10'}`}>
            <CloudCog className="mb-2 h-5 w-5 text-cyan-300" />
            <div className="text-[10px] font-bold text-slate-500">FINAL PIPELINE</div>
            <div className="mt-1 text-sm font-black">{pipeline?.success ? 'PASS' : pipeline?.available ? String(pipeline.status || 'RUNNING').toUpperCase() : 'NOT RUN'}</div>
          </div>
          <div className={`rounded-2xl border p-4 ${pipeline?.imageDigestSha256 ? 'border-emerald-400/25 bg-emerald-500/10' : 'border-amber-400/25 bg-amber-500/10'}`}>
            <Fingerprint className="mb-2 h-5 w-5 text-cyan-300" />
            <div className="text-[10px] font-bold text-slate-500">OCI DIGEST</div>
            <div className="mt-1 font-mono text-sm font-black">{short(pipeline?.imageDigestSha256, 16)}</div>
          </div>
          <div className={`rounded-2xl border p-4 ${readiness?.attestation.present ? 'border-emerald-400/25 bg-emerald-500/10' : 'border-amber-400/25 bg-amber-500/10'}`}>
            <PackageCheck className="mb-2 h-5 w-5 text-cyan-300" />
            <div className="text-[10px] font-bold text-slate-500">ATTESTATION API</div>
            <div className="mt-1 text-sm font-black">{readiness?.attestation.present ? 'CONFIRMED' : readiness?.attestation.available ? 'NOT FOUND' : 'UNKNOWN'}</div>
          </div>
          <div className={`rounded-2xl border p-4 ${readiness?.ready ? 'border-emerald-400/30 bg-emerald-500/10' : 'border-rose-400/30 bg-rose-500/10'}`}>
            {readiness?.ready ? <CheckCircle2 className="mb-2 h-5 w-5 text-emerald-300" /> : <ShieldX className="mb-2 h-5 w-5 text-rose-300" />}
            <div className="text-[10px] font-bold text-slate-500">PRODUCTION</div>
            <div className={`mt-1 text-sm font-black ${readiness?.ready ? 'text-emerald-200' : 'text-rose-200'}`}>{readiness?.ready ? 'READY' : 'BLOCKED'}</div>
          </div>
        </section>

        {!release ? (
          <section className="rounded-3xl border border-amber-400/25 bg-amber-500/10 p-6">
            <AlertTriangle className="mb-3 h-6 w-6 text-amber-300" />
            <h2 className="font-black">لا توجد V31 Release نشطة.</h2>
            <p className="mt-2 text-sm text-amber-100/80">أنشئ Release مرتبطة بآخر main حتى يرتبط Final Pipeline بنفس Candidate SHA.</p>
          </section>
        ) : (
          <section className="rounded-3xl border border-white/10 bg-white/[0.035] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-black">{release.name}</h2>
                <p className="mt-1 text-xs text-slate-500">{release.repository} · <span className="font-mono">{release.candidateSha}</span></p>
              </div>
              <div className="text-left text-xs text-slate-500">آخر تقييم<br /><b className="text-slate-300">{when(readiness?.evaluatedAt)}</b></div>
            </div>
            {pipeline?.immutableImage && (
              <div className="mt-4 rounded-2xl border border-cyan-300/15 bg-black/20 p-4">
                <div className="text-[10px] font-black tracking-widest text-cyan-300">IMMUTABLE PRODUCTION IMAGE</div>
                <div className="mt-2 break-all font-mono text-xs text-slate-300">{pipeline.immutableImage}</div>
              </div>
            )}
          </section>
        )}

        <section className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {stageEntries.map(([key, label]) => {
            const job = pipeline?.jobs?.[key]
            const Icon = stageIcons[key] || ShieldCheck
            return (
              <article key={key} className={`rounded-3xl border p-5 ${stageTone(job?.conclusion)}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-[10px] font-black tracking-wider opacity-80"><Icon className="h-4 w-4" /> {key.toUpperCase()}</div>
                    <h3 className="mt-2 font-black text-slate-100">{label}</h3>
                  </div>
                  <div className="rounded-lg bg-black/20 px-2 py-1 text-[10px] font-black">{job?.conclusion?.toUpperCase() || job?.status?.toUpperCase() || 'PENDING'}</div>
                </div>
                <div className="mt-4 space-y-2">
                  {(job?.steps || []).filter(step => step.name && step.name !== 'Set up job' && step.name !== 'Complete job').map((step, index) => (
                    <div key={`${step.number}-${index}`} className="flex items-center justify-between gap-3 rounded-xl bg-black/20 px-3 py-2 text-[11px] text-slate-300">
                      <span className="truncate">{step.name}</span>
                      <b className={step.conclusion === 'success' ? 'text-emerald-300' : step.conclusion === 'failure' ? 'text-rose-300' : 'text-amber-300'}>{step.conclusion?.toUpperCase() || step.status?.toUpperCase() || '—'}</b>
                    </div>
                  ))}
                  {!job && <div className="rounded-xl bg-black/20 p-3 text-xs opacity-70">لا توجد نتيجة لهذه المرحلة على Candidate SHA الحالية.</div>}
                </div>
              </article>
            )
          })}
        </section>

        {(readiness?.blockers.length || readiness?.warnings.length) ? (
          <section className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-3xl border border-rose-400/20 bg-rose-500/[0.07] p-5">
              <h2 className="flex items-center gap-2 font-black text-rose-200"><ShieldX className="h-5 w-5" /> FINAL BLOCKERS</h2>
              <div className="mt-4 space-y-2">
                {readiness?.blockers.length ? readiness.blockers.map(blocker => (
                  <div key={blocker.code} className="rounded-xl bg-black/20 p-3 text-xs text-rose-100"><b>{blocker.code}</b><div className="mt-1 text-rose-100/75">{blocker.message}</div></div>
                )) : <div className="text-xs text-slate-500">لا توجد Blockers.</div>}
              </div>
            </div>
            <div className="rounded-3xl border border-amber-400/20 bg-amber-500/[0.07] p-5">
              <h2 className="flex items-center gap-2 font-black text-amber-200"><AlertTriangle className="h-5 w-5" /> WARNINGS</h2>
              <div className="mt-4 space-y-2">
                {readiness?.warnings.length ? readiness.warnings.map((warning, index) => <div key={index} className="rounded-xl bg-black/20 p-3 text-xs text-amber-100">{warning}</div>) : <div className="text-xs text-slate-500">لا توجد تحذيرات.</div>}
              </div>
            </div>
          </section>
        ) : null}

        <section className="rounded-3xl border border-white/10 bg-white/[0.035] p-5">
          <h2 className="font-black">FINAL POLICY</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl bg-black/20 p-3 text-xs">Waivers <b className="float-left text-emerald-300">DISABLED</b></div>
            <div className="rounded-xl bg-black/20 p-3 text-xs">Immutable OCI <b className="float-left text-emerald-300">REQUIRED</b></div>
            <div className="rounded-xl bg-black/20 p-3 text-xs">All stages <b className="float-left text-emerald-300">REQUIRED</b></div>
            <div className="rounded-xl bg-black/20 p-3 text-xs">Promotion on failure <b className="float-left text-rose-300">BLOCKED</b></div>
          </div>
          {pipeline?.finalArtifact && <div className="mt-4 break-all rounded-xl border border-white/10 p-3 font-mono text-[10px] text-slate-500">Evidence: {pipeline.finalArtifact.name} · archive {pipeline.finalArtifact.archiveDigest || '—'}</div>}
        </section>
      </div>
    </main>
  )
}
