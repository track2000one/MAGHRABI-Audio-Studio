import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, Boxes, CheckCircle2, Database, Download, FileCode2,
  Fingerprint, GitCommit, KeyRound, PackageSearch, RefreshCw, ScanSearch, Server,
  Settings2, ShieldCheck, ShieldX, Scale,
} from 'lucide-react'
import {
  attestArtifactV32, captureBaselineV32, evidenceUrlV32, getOverviewV32,
  runScanV32, savePolicyV32, type V32Gate, type V32Overview,
} from './lib/supplyChainApiV32'

function shortSha(value?: string | null) {
  return value ? value.slice(0, 12) : '—'
}

function when(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ar-SA')
}

function card(ok = true) {
  return `rounded-2xl border p-4 ${ok ? 'border-white/10 bg-white/[0.035]' : 'border-amber-400/25 bg-amber-500/10'}`
}

function gateTone(gate?: V32Gate | null) {
  if (!gate) return 'border-slate-700 bg-slate-900/50 text-slate-300'
  return gate.ready
    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
    : 'border-rose-400/30 bg-rose-500/10 text-rose-100'
}

const ENVS = ['dev', 'staging', 'production'] as const

export default function VideoStudioV32() {
  const [overview, setOverview] = useState<V32Overview | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [policyDraft, setPolicyDraft] = useState<Record<string, any>>({})
  const [artifact, setArtifact] = useState({ environment: 'production' as 'dev' | 'staging' | 'production', name: 'production-image', digestSha256: '' })

  const load = useCallback(async () => {
    try {
      const data = await getOverviewV32()
      setOverview(data)
      setPolicyDraft(data.policy || {})
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل Creator V32.')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 10000)
    return () => window.clearInterval(timer)
  }, [load])

  const act = async (name: string, fn: () => Promise<any>, success: string) => {
    setBusy(name); setError(''); setMessage('')
    try {
      await fn(); setMessage(success); await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : `فشلت عملية ${name}.`)
    } finally {
      setBusy('')
    }
  }

  const release = overview?.activeRelease
  const scan = overview?.latestScan
  const vuln = scan?.vulnerabilities?.summary || {}
  const licenses = scan?.licenses?.summary || {}
  const commit = scan?.signatures?.commit || {}
  const rules = scan?.rules || {}
  const sbomWarnings: string[] = Array.isArray(scan?.sbom?.warnings) ? scan!.sbom.warnings : []
  const prodGate = overview?.gates?.production

  const baselineMap = useMemo(() => {
    const result: Record<string, any> = {}
    for (const item of overview?.baselines || []) result[String(item.environment)] = item
    return result
  }, [overview?.baselines])

  if (!overview) {
    return <main className="min-h-screen bg-[#050911] p-8 text-slate-100" dir="rtl">
      <div className="mx-auto max-w-xl rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
        <Activity className="mx-auto mb-4 h-10 w-10 animate-pulse text-cyan-300" />
        <h1 className="text-xl font-black">Creator V32 Supply Chain Security</h1>
        <p className="mt-2 text-sm text-slate-400">{error || 'جاري تحميل Supply Chain Control Room...'}</p>
        {error && <button onClick={() => void load()} className="mt-5 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950">RETRY</button>}
      </div>
    </main>
  }

  return <main className="min-h-screen bg-[#050911] text-slate-100" dir="rtl">
    <header className="border-b border-white/10 bg-[#070d17]/95 px-5 py-4 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1850px] flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-black tracking-[.17em] text-cyan-300"><ShieldCheck className="h-4 w-4" /> SUPPLY CHAIN · SBOM · POLICY-AS-CODE · ARTIFACT PINNING</div>
          <h1 className="mt-1 text-2xl font-black">MAGHRABI Video Studio · Creator V32</h1>
          <p className="mt-1 text-xs text-slate-500">SBOM · OSV · Commit/Tag Verification · Rulesets · Config Drift · Licenses · Provenance · Promotion Gate</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="#video-v31" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V31 GITOPS</a>
          <a href="#video-v30" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V30 CANARY</a>
          <button onClick={() => void load()} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950"><RefreshCw className="h-4 w-4" /> REFRESH</button>
        </div>
      </div>
    </header>

    <div className="mx-auto max-w-[1850px] space-y-5 p-5">
      {(error || message) && <div className={`rounded-2xl border px-4 py-3 text-sm ${error ? 'border-rose-400/30 bg-rose-500/10 text-rose-200' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'}`}>{error || message}</div>}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className={card(overview.schema.databaseMode === 'postgresql')}><Database className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">SECURITY DATABASE</div><div className="mt-1 text-lg font-black">{overview.schema.databaseMode.toUpperCase()}</div><div className="text-xs text-slate-500">schema {overview.schema.current}/{overview.schema.latest}</div></div>
        <div className={card(Boolean(release))}><GitCommit className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">V31 CANDIDATE</div><div className="mt-1 font-mono text-lg font-black">{shortSha(release?.candidateSha)}</div><div className="truncate text-xs text-slate-500">{release?.name || 'No active release'}</div></div>
        <div className={card(Boolean(scan))}><ScanSearch className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">LATEST SCAN</div><div className="mt-1 text-lg font-black">{scan ? scan.status.toUpperCase() : 'REQUIRED'}</div><div className="text-xs text-slate-500">{scan ? when(scan.createdAt) : 'Run full scan'}</div></div>
        <div className={card(vuln.total === 0 && scan?.vulnerabilities?.available)}><ShieldX className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">KNOWN VULNERABILITIES</div><div className="mt-1 text-lg font-black">{scan?.vulnerabilities?.available ? (vuln.total ?? 0) : 'UNKNOWN'}</div><div className="text-xs text-slate-500">OSV direct-manifest scan</div></div>
        <div className={card(Boolean(commit.verified))}><Fingerprint className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">COMMIT SIGNATURE</div><div className="mt-1 text-lg font-black">{scan ? (commit.verified ? 'VERIFIED' : commit.available ? 'UNVERIFIED' : 'UNKNOWN') : '—'}</div><div className="text-xs text-slate-500">{commit.reason || 'GitHub verification'}</div></div>
        <div className={card(prodGate?.ready ?? false)}><ShieldCheck className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">PRODUCTION GATE</div><div className="mt-1 text-lg font-black">{prodGate ? (prodGate.ready ? 'PASS' : 'BLOCK') : 'SCAN REQUIRED'}</div><div className="text-xs text-slate-500">enforced on V31 promotion</div></div>
      </section>

      {release ? <section className={card(Boolean(scan))}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><h2 className="text-lg font-black">{release.name}</h2><p className="mt-1 text-xs text-slate-500">{release.repository} · <span className="font-mono">{release.candidateSha}</span></p></div>
          <div className="flex flex-wrap gap-2">
            <button disabled={!!busy} onClick={() => void act('scan', () => runScanV32(release.id), 'اكتمل Supply-Chain Scan وتم تحديث Gates.')} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-3 text-xs font-black text-slate-950 disabled:opacity-40"><ScanSearch className="h-4 w-4" /> RUN FULL SUPPLY-CHAIN SCAN</button>
            {scan && <a href={evidenceUrlV32(scan.id)} className="flex items-center gap-2 rounded-xl border border-white/10 px-4 py-3 text-xs font-black"><Download className="h-4 w-4" /> EVIDENCE ZIP</a>}
          </div>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {ENVS.map(env => {
            const gate = overview.gates?.[env]
            return <div key={env} className={`rounded-2xl border p-4 ${gateTone(gate)}`}><div className="text-[10px] font-black opacity-60">{env.toUpperCase()} SUPPLY-CHAIN GATE</div><div className="mt-1 text-2xl font-black">{gate ? (gate.ready ? 'PASS' : 'BLOCK') : 'SCAN REQUIRED'}</div><div className="mt-3 space-y-1 text-xs">{gate?.blockers?.slice(0,4).map((x,i)=><div key={i}>• {x}</div>)}{gate?.warnings?.slice(0,3).map((x,i)=><div key={`w${i}`} className="opacity-70">⚠ {x}</div>)}</div></div>
          })}
        </div>
      </section> : <section className={card(false)}><AlertTriangle className="mb-3 h-6 w-6 text-amber-300" /><h2 className="font-black">لا توجد V31 Release نشطة</h2><p className="mt-2 text-sm text-slate-400">أنشئ Release من V31 أولًا، ثم ارجع إلى V32 لفحص نفس Candidate SHA.</p></section>}

      {scan && <>
        <section className="grid gap-5 xl:grid-cols-3">
          <div className={card((vuln.critical ?? 0) === 0 && (vuln.high ?? 0) === 0)}>
            <h2 className="flex items-center gap-2 font-black"><PackageSearch className="h-5 w-5 text-cyan-300" /> SBOM + VULNERABILITIES</h2>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs"><div className="rounded-xl bg-black/20 p-3"><b className="block text-xl">{scan.sbom?.componentCount ?? 0}</b>Components</div><div className="rounded-xl bg-black/20 p-3"><b className="block text-xl text-rose-300">{vuln.high ?? 0}</b>High</div><div className="rounded-xl bg-black/20 p-3"><b className="block text-xl text-amber-300">{vuln.unknown ?? 0}</b>Unknown</div></div>
            <div className="mt-3 rounded-xl border border-white/10 p-3 text-xs text-slate-400">Coverage: <b>{scan.sbom?.coverage || '—'}</b> · Transitive complete: <b>{scan.sbom?.transitiveComplete ? 'YES' : 'NO'}</b></div>
            <div className="mt-3 max-h-48 space-y-2 overflow-auto">{(scan.vulnerabilities?.items || []).slice(0,20).map((item:any)=><div key={`${item.id}-${item.package}`} className="rounded-xl border border-white/10 p-3 text-xs"><b>{item.id}</b><span className="float-left uppercase">{item.severity}</span><div className="mt-1 text-slate-500">{item.package} {item.version}</div></div>)}{!(scan.vulnerabilities?.items || []).length && <div className="text-xs text-slate-500">{scan.vulnerabilities?.available ? 'لم تُرجع OSV ثغرات معروفة للمكونات المفحوصة.' : 'OSV غير متاحة؛ الحالة غير معروفة.'}</div>}</div>
          </div>

          <div className={card(Boolean(commit.verified))}>
            <h2 className="flex items-center gap-2 font-black"><GitCommit className="h-5 w-5 text-cyan-300" /> SOURCE TRUST</h2>
            <div className="mt-4 space-y-2 text-xs"><div className="rounded-xl bg-black/20 p-3">Commit verification <b className="float-left">{commit.verified ? 'VERIFIED' : commit.available ? 'UNVERIFIED' : 'UNKNOWN'}</b></div><div className="rounded-xl bg-black/20 p-3">Branch protection <b className="float-left">{rules.protection?.protected ? 'PROTECTED' : rules.protection?.available ? 'NOT PROTECTED' : 'UNKNOWN'}</b></div><div className="rounded-xl bg-black/20 p-3">Rulesets <b className="float-left">{rules.rulesets?.available ? rules.rulesets.count : 'UNKNOWN'}</b></div><div className="rounded-xl bg-black/20 p-3">Tag verification <b className="float-left">{scan.signatures?.tag?.available ? (scan.signatures.tag.verified ? 'VERIFIED' : 'UNVERIFIED') : 'N/A / UNKNOWN'}</b></div></div>
            <div className="mt-3 rounded-xl border border-white/10 p-3 text-xs leading-6 text-slate-400">GitHub evidence may require <code>V31_GITHUB_TOKEN</code> for private repositories or protected-branch/ruleset endpoints.</div>
          </div>

          <div className={card((licenses.denied ?? 0) === 0)}>
            <h2 className="flex items-center gap-2 font-black"><Scale className="h-5 w-5 text-cyan-300" /> LICENSE POLICY</h2>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs"><div className="rounded-xl bg-black/20 p-3"><b className="block text-xl">{licenses.total ?? 0}</b>Total</div><div className="rounded-xl bg-black/20 p-3"><b className="block text-xl text-rose-300">{licenses.denied ?? 0}</b>Denied</div><div className="rounded-xl bg-black/20 p-3"><b className="block text-xl text-amber-300">{licenses.unknown ?? 0}</b>Unknown</div></div>
            <div className="mt-3 max-h-52 space-y-2 overflow-auto">{(scan.licenses?.items || []).map((item:any)=><div key={`${item.ecosystem}-${item.name}`} className="rounded-xl border border-white/10 p-3 text-xs"><b>{item.name}</b><span className="float-left text-slate-400">{item.license || 'UNKNOWN'}</span></div>)}</div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-3">
          <div className={card()}>
            <h2 className="flex items-center gap-2 font-black"><KeyRound className="h-5 w-5 text-cyan-300" /> CONFIG DRIFT</h2>
            <div className="mt-4 space-y-2">{ENVS.map(env => { const d=scan.drift?.[env] || {}; return <div key={env} className={`rounded-xl border p-3 text-xs ${d.status === 'drift' ? 'border-rose-400/25 bg-rose-500/10' : d.status === 'clean' ? 'border-emerald-400/20 bg-emerald-500/10' : 'border-white/10'}`}><b>{env.toUpperCase()}</b><span className="float-left">{String(d.status || 'UNKNOWN').toUpperCase()}</span><div className="mt-2 text-slate-500">Changed {d.changed?.length || 0} · Added {d.added?.length || 0} · Missing {d.missing?.length || 0}</div></div> })}</div>
            <div className="mt-3 flex flex-wrap gap-2">{ENVS.map(env => <button key={env} disabled={!!busy} onClick={() => void act(`baseline-${env}`, () => captureBaselineV32(env), `تم حفظ ${env} config baseline بدون تخزين قيم الأسرار.`)} className="rounded-xl border border-white/10 px-3 py-2 text-xs font-black disabled:opacity-40">CAPTURE {env.toUpperCase()}</button>)}</div>
            <div className="mt-3 text-[11px] leading-5 text-slate-500">V32 stores HMAC fingerprints only. Secret values are never returned to the UI or stored in the baseline table.</div>
          </div>

          <div className={card(Boolean(scan.artifact?.latest))}>
            <h2 className="flex items-center gap-2 font-black"><Boxes className="h-5 w-5 text-cyan-300" /> ARTIFACT DIGEST PINNING</h2>
            {scan.artifact?.latest ? <div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-3 text-xs"><b>{scan.artifact.latest.name}</b><div className="mt-2 break-all font-mono text-emerald-200">sha256:{scan.artifact.latest.digestSha256}</div><div className="mt-2 text-slate-400">{scan.artifact.latest.environment} · {when(scan.artifact.latest.createdAt)}</div></div> : <div className="mt-4 text-xs text-slate-500">لا يوجد Artifact Digest مسجل لهذه Release.</div>}
            <div className="mt-4 grid gap-2"><select value={artifact.environment} onChange={e => setArtifact({...artifact,environment:e.target.value as any})} className="rounded-xl border border-white/10 bg-[#0b1220] px-3 py-2 text-xs">{ENVS.map(x=><option key={x} value={x}>{x}</option>)}</select><input value={artifact.name} onChange={e=>setArtifact({...artifact,name:e.target.value})} placeholder="Artifact name" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs" /><input value={artifact.digestSha256} onChange={e=>setArtifact({...artifact,digestSha256:e.target.value})} placeholder="SHA-256 digest (64 hex)" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs" /><button disabled={!!busy || !release || !/^(sha256:)?[0-9a-fA-F]{64}$/.test(artifact.digestSha256.trim())} onClick={() => void act('artifact', () => attestArtifactV32({releaseId:release?.id,environment:artifact.environment,name:artifact.name,digestSha256:artifact.digestSha256,source:'v32-admin-ui'}), 'تم تسجيل Artifact Digest. أعد RUN FULL SCAN لتضمينه في Provenance/Gate.')} className="rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950 disabled:opacity-40">REGISTER DIGEST</button></div>
          </div>

          <div className={card(Boolean(scan.provenance?.signature?.valid))}>
            <h2 className="flex items-center gap-2 font-black"><FileCode2 className="h-5 w-5 text-cyan-300" /> PROVENANCE</h2>
            <div className="mt-4 rounded-xl bg-black/20 p-3 text-xs">Internal signature <b className="float-left">{scan.provenance?.signature?.valid ? 'VALID' : 'UNKNOWN'}</b></div><div className="mt-2 rounded-xl bg-black/20 p-3 text-xs">Scheme <b className="float-left">{scan.provenance?.signature?.scheme || '—'}</b></div><div className="mt-2 rounded-xl bg-black/20 p-3 text-xs">SLSA inspired <b className="float-left">{scan.provenance?.slsaInspired ? 'YES' : 'NO'}</b></div><div className="mt-2 rounded-xl bg-black/20 p-3 text-xs">Formal SLSA conformance <b className="float-left">{scan.provenance?.slsaConformant ? 'YES' : 'NO'}</b></div><p className="mt-3 text-xs leading-6 text-slate-500">{scan.provenance?.note}</p>
          </div>
        </section>

        {sbomWarnings.length > 0 && <section className={card(false)}><h2 className="flex items-center gap-2 font-black"><AlertTriangle className="h-5 w-5 text-amber-300" /> SBOM COVERAGE WARNINGS</h2><div className="mt-3 space-y-2 text-xs text-amber-100">{sbomWarnings.map((x,i)=><div key={i} className="rounded-xl border border-amber-400/20 bg-amber-500/10 p-3">{x}</div>)}</div></section>}
      </>}

      <section className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
        <div className={card()}>
          <h2 className="flex items-center gap-2 font-black"><Settings2 className="h-5 w-5 text-cyan-300" /> POLICY-AS-CODE</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-2 text-xs">
            {[
              ['blockCritical','Block CRITICAL vulnerabilities'],['blockHigh','Block HIGH vulnerabilities'],
              ['requireVerifiedCommitForProduction','Require verified commit for Production'],['requireProtectedBranchForProduction','Require branch protection/ruleset'],
              ['requireArtifactDigestForProduction','Require artifact SHA-256 for Production'],['requireConfigBaselineForProduction','Require Production config baseline'],
              ['blockConfigDriftForProduction','Block Production on config drift'],['warnUnknownVulnerabilitySeverity','Warn on unknown vulnerability severity'],
            ].map(([key,label]) => <label key={key} className="flex items-center justify-between rounded-xl border border-white/10 p-3"><span>{label}</span><input type="checkbox" checked={Boolean(policyDraft[key])} onChange={e=>setPolicyDraft({...policyDraft,[key]:e.target.checked})} /></label>)}
          </div>
          <label className="mt-3 block text-xs"><span className="mb-1 block text-slate-500">Maximum scan age (minutes)</span><input type="number" min={5} max={1440} value={Number(policyDraft.maxScanAgeMinutes || 120)} onChange={e=>setPolicyDraft({...policyDraft,maxScanAgeMinutes:Number(e.target.value)})} className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2" /></label>
          <button disabled={!!busy} onClick={() => void act('policy', () => savePolicyV32(policyDraft), 'تم حفظ V32 Policy. أعد الفحص لتثبيت Snapshot جديدة للسياسة.')} className="mt-4 rounded-xl bg-cyan-300 px-5 py-3 text-xs font-black text-slate-950 disabled:opacity-40">SAVE SECURITY POLICY</button>
          <p className="mt-3 text-[11px] leading-5 text-slate-500">Default denied licenses: {(overview.policy.deniedLicenses || []).join(', ') || 'none'}. License metadata and OSV are external lookups; unavailable data is reported as UNKNOWN, not PASS.</p>
        </div>

        <div className={card()}>
          <h2 className="flex items-center gap-2 font-black"><Server className="h-5 w-5 text-cyan-300" /> CAPABILITIES / BASELINES</h2>
          <div className="mt-4 space-y-2 text-xs"><div className="rounded-xl bg-black/20 p-3">SBOM coverage <b className="float-left">{overview.capabilities.sbomCoverage}</b></div><div className="rounded-xl bg-black/20 p-3">GitHub token <b className="float-left">{overview.capabilities.githubTokenConfigured ? 'CONFIGURED' : 'PUBLIC MODE'}</b></div><div className="rounded-xl bg-black/20 p-3">CI attestation token <b className="float-left">{overview.capabilities.attestationTokenConfigured ? 'CONFIGURED' : 'ADMIN ONLY'}</b></div>{ENVS.map(env=><div key={env} className="rounded-xl bg-black/20 p-3">{env.toUpperCase()} baseline <b className="float-left">{baselineMap[env] ? when(baselineMap[env].updatedAt) : 'NONE'}</b></div>)}</div>
        </div>
      </section>

      <section className={card()}>
        <h2 className="font-black">SCAN HISTORY</h2>
        <div className="mt-4 space-y-2">{overview.scans.slice(0,12).map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 p-3 text-xs"><div><b>{item.id}</b><div className="font-mono text-slate-500">{shortSha(item.candidateSha)} · {when(item.createdAt)}</div></div><span className={`rounded-full border px-2 py-1 ${item.status === 'pass' ? 'border-emerald-400/25 text-emerald-200' : 'border-rose-400/25 text-rose-200'}`}>{item.status.toUpperCase()}</span><a href={evidenceUrlV32(item.id)} className="rounded-lg border border-white/10 p-2"><Download className="h-4 w-4" /></a></div>)}</div>
      </section>
    </div>
  </main>
}
