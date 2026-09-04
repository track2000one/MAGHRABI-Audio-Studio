import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, Boxes, CheckCircle2, Container, Database, Download,
  FileKey2, Fingerprint, GitBranch, GitCommit, PackageCheck, RefreshCw, Scale,
  ScanSearch, ShieldCheck, ShieldX, Workflow,
} from 'lucide-react'
import {
  createAttestationV33, evidenceUrlV33, getOverviewV33, runAssessmentV33,
  savePolicyV33, verifyOciV33, type V33Overview,
} from './lib/supplyChainApiV33'

function shortSha(value?: string | null) { return value ? value.slice(0, 12) : '—' }
function when(value?: string | null) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('ar-SA')
}
function card(ok = true) {
  return `rounded-2xl border p-4 ${ok ? 'border-white/10 bg-white/[0.035]' : 'border-amber-400/25 bg-amber-500/10'}`
}
function statusTone(ok?: boolean | null) {
  if (ok === true) return 'text-emerald-300'
  if (ok === false) return 'text-rose-300'
  return 'text-amber-300'
}

export default function VideoStudioV33() {
  const [overview, setOverview] = useState<V33Overview | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [policyDraft, setPolicyDraft] = useState<Record<string, any>>({})
  const [attestation, setAttestation] = useState({ subjectName: 'production-artifact', digestSha256: '' })
  const [oci, setOci] = useState({ imageRef: '', digestSha256: '' })

  const load = useCallback(async () => {
    try {
      const data = await getOverviewV33()
      setOverview(data)
      setPolicyDraft(data.policy || {})
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل Creator V33.')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 10000)
    return () => window.clearInterval(timer)
  }, [load])

  const act = async (name: string, fn: () => Promise<any>, success: string) => {
    setBusy(name); setError(''); setMessage('')
    try { await fn(); setMessage(success); await load() }
    catch (err) { setError(err instanceof Error ? err.message : `فشلت عملية ${name}.`) }
    finally { setBusy('') }
  }

  const release = overview?.activeRelease
  const assessment = overview?.latestAssessment
  const gate = overview?.productionGate
  const locks = assessment?.locks || {}
  const frontendLock = locks.frontend || {}
  const backendLock = locks.backend || {}
  const build = assessment?.build || {}
  const artifactSbom = assessment?.artifactSbom || {}
  const attItems = overview?.attestations || []
  const externalAtt = attItems.find((x: any) => ['sigstore', 'external', 'github-oidc'].includes(String(x.mode)))
  const ociEvidence = overview?.oci?.latest

  const policyFlags = useMemo(() => [
    ['requireFrontendLock', 'Require source-controlled npm lock'],
    ['requireLockIntegrity', 'Require npm integrity hashes'],
    ['requireExactBackendPins', 'Require exact backend direct pins'],
    ['requireBuildEvidenceForProduction', 'Require GitHub build evidence'],
    ['requireReproducibleBuildForProduction', 'Require reproducible build'],
    ['requireGithubOidcAttestationForProduction', 'Require GitHub OIDC attestation'],
    ['requireExternalAttestationForProduction', 'Require external/Sigstore attestation'],
    ['requireOciDigestForProduction', 'Require verified OCI digest'],
    ['requireOpaAllowForProduction', 'Require policy-as-code allow'],
    ['requireV32ProductionGate', 'Require V32 production gate'],
    ['blockDependencyLockDrift', 'Block dependency lock drift'],
    ['enforceStaging', 'Enforce V33 on staging too'],
  ], [])

  if (!overview) return <main className="min-h-screen bg-[#050911] p-8 text-slate-100" dir="rtl">
    <div className="mx-auto max-w-xl rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
      <Activity className="mx-auto mb-4 h-10 w-10 animate-pulse text-cyan-300" />
      <h1 className="text-xl font-black">Creator V33 Reproducible Builds</h1>
      <p className="mt-2 text-sm text-slate-400">{error || 'جاري تحميل Reproducible Release Control Room...'}</p>
      {error && <button onClick={() => void load()} className="mt-5 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950">RETRY</button>}
    </div>
  </main>

  return <main className="min-h-screen bg-[#050911] text-slate-100" dir="rtl">
    <header className="border-b border-white/10 bg-[#070d17]/95 px-5 py-4 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1850px] flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-black tracking-[.17em] text-cyan-300"><Workflow className="h-4 w-4" /> REPRODUCIBLE BUILD · ATTESTATION · OCI · POLICY-AS-CODE</div>
          <h1 className="mt-1 text-2xl font-black">MAGHRABI Video Studio · Creator V33</h1>
          <p className="mt-1 text-xs text-slate-500">npm Lock · Build Reproducibility · GitHub OIDC · Artifact SBOM · Attestation · OCI Digest · OPA/Rego Gate</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="#video-v32" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V32 SUPPLY CHAIN</a>
          <a href="#video-v31" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V31 GITOPS</a>
          <button onClick={() => void load()} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950"><RefreshCw className="h-4 w-4" /> REFRESH</button>
        </div>
      </div>
    </header>

    <div className="mx-auto max-w-[1850px] space-y-5 p-5">
      {(error || message) && <div className={`rounded-2xl border px-4 py-3 text-sm ${error ? 'border-rose-400/30 bg-rose-500/10 text-rose-200' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'}`}>{error || message}</div>}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <div className={card(overview.schema.databaseMode === 'postgresql')}><Database className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">EVIDENCE DATABASE</div><div className="mt-1 text-lg font-black">{overview.schema.databaseMode.toUpperCase()}</div><div className="text-xs text-slate-500">schema {overview.schema.current}/{overview.schema.latest}</div></div>
        <div className={card(Boolean(release))}><GitCommit className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">CANDIDATE SHA</div><div className="mt-1 font-mono text-lg font-black">{shortSha(release?.candidateSha)}</div><div className="truncate text-xs text-slate-500">{release?.name || 'No active release'}</div></div>
        <div className={card(frontendLock.status === 'locked')}><PackageCheck className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">DEPENDENCY LOCK</div><div className={`mt-1 text-lg font-black ${statusTone(assessment ? frontendLock.status === 'locked' : null)}`}>{assessment ? String(frontendLock.status || 'UNKNOWN').toUpperCase() : 'ASSESS'}</div><div className="text-xs text-slate-500">{frontendLock.packageCount ?? 0} npm packages</div></div>
        <div className={card(Boolean(build.reproducible))}><Workflow className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">REPRO BUILD</div><div className={`mt-1 text-lg font-black ${statusTone(assessment ? Boolean(build.reproducible) : null)}`}>{assessment ? (build.reproducible ? 'MATCH' : build.available ? 'FAILED' : 'UNKNOWN') : 'ASSESS'}</div><div className="text-xs text-slate-500">GitHub Actions double build</div></div>
        <div className={card(build.githubOidcAttestation === 'success')}><Fingerprint className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">GITHUB OIDC</div><div className={`mt-1 text-lg font-black ${statusTone(assessment ? build.githubOidcAttestation === 'success' : null)}`}>{assessment ? String(build.githubOidcAttestation || 'UNKNOWN').toUpperCase() : 'ASSESS'}</div><div className="text-xs text-slate-500">attest-build-provenance step</div></div>
        <div className={card(gate?.ready ?? false)}><ShieldCheck className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">PRODUCTION GATE</div><div className={`mt-1 text-lg font-black ${statusTone(gate ? gate.ready : null)}`}>{gate ? (gate.ready ? 'PASS' : 'BLOCK') : 'ASSESSMENT REQUIRED'}</div><div className="text-xs text-slate-500">enforced over V31 promotion</div></div>
      </section>

      {release ? <section className={card(Boolean(assessment))}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><h2 className="text-lg font-black">{release.name}</h2><p className="mt-1 text-xs text-slate-500">{release.repository} · <span className="font-mono">{release.candidateSha}</span></p></div>
          <div className="flex flex-wrap gap-2">
            <button disabled={!!busy} onClick={() => void act('assess', () => runAssessmentV33(release.id), 'اكتمل V33 reproducibility assessment.')} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-3 text-xs font-black text-slate-950 disabled:opacity-40"><ScanSearch className="h-4 w-4" /> RUN V33 ASSESSMENT</button>
            {assessment && <a href={evidenceUrlV33(assessment.id)} className="flex items-center gap-2 rounded-xl border border-white/10 px-4 py-3 text-xs font-black"><Download className="h-4 w-4" /> EVIDENCE ZIP</a>}
          </div>
        </div>
        {gate && <div className={`mt-5 rounded-2xl border p-4 ${gate.ready ? 'border-emerald-400/30 bg-emerald-500/10' : 'border-rose-400/30 bg-rose-500/10'}`}>
          <div className="flex items-center gap-2 font-black">{gate.ready ? <CheckCircle2 className="h-5 w-5 text-emerald-300" /> : <ShieldX className="h-5 w-5 text-rose-300" />} PRODUCTION {gate.ready ? 'READY' : 'BLOCKED'}</div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">{gate.blockers?.map((x,i)=><div key={i} className="rounded-xl bg-black/20 p-3 text-xs text-rose-200">• {x}</div>)}{gate.warnings?.map((x,i)=><div key={`w${i}`} className="rounded-xl bg-black/20 p-3 text-xs text-amber-200">⚠ {x}</div>)}</div>
        </div>}
      </section> : <section className={card(false)}><AlertTriangle className="mb-3 h-6 w-6 text-amber-300" /><h2 className="font-black">لا توجد V31 Release نشطة</h2><p className="mt-2 text-sm text-slate-400">أنشئ GitOps Release من V31 أولًا ثم ارجع إلى V33.</p></section>}

      {assessment && <>
        <section className="grid gap-5 xl:grid-cols-3">
          <div className={card(frontendLock.status === 'locked' && Number(frontendLock.integrityMissing || 0) === 0)}>
            <h2 className="flex items-center gap-2 font-black"><PackageCheck className="h-5 w-5 text-cyan-300" /> DEPENDENCY LOCK GRAPH</h2>
            <div className="mt-4 space-y-2 text-xs">
              <div className="rounded-xl bg-black/20 p-3">npm lockfile <b className="float-left">{String(frontendLock.status || 'UNKNOWN').toUpperCase()}</b></div>
              <div className="rounded-xl bg-black/20 p-3">lockfileVersion <b className="float-left">{frontendLock.lockfileVersion ?? '—'}</b></div>
              <div className="rounded-xl bg-black/20 p-3">Resolved packages <b className="float-left">{frontendLock.resolvedCount ?? 0}</b></div>
              <div className="rounded-xl bg-black/20 p-3">Missing integrity <b className={`float-left ${Number(frontendLock.integrityMissing || 0) ? 'text-rose-300' : 'text-emerald-300'}`}>{frontendLock.integrityMissing ?? '—'}</b></div>
              <div className="rounded-xl bg-black/20 p-3">Backend direct pins <b className="float-left">{backendLock.exactPins ? 'EXACT' : 'INCOMPLETE'}</b></div>
              <div className="rounded-xl bg-black/20 p-3">Python transitive hash-lock <b className="float-left text-amber-300">{backendLock.transitiveLock ? 'YES' : 'NO'}</b></div>
            </div>
            <div className="mt-3 break-all rounded-xl border border-white/10 p-3 font-mono text-[10px] text-slate-500">Materials SHA-256: {locks.materialsDigestSha256 || '—'}</div>
            {locks.drift?.dependencyMaterialChanged && <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-500/10 p-3 text-xs text-amber-200">Dependency material changed from Base SHA. هذه ليست مشكلة تلقائيًا، لكنها تحتاج مراجعة.</div>}
          </div>

          <div className={card(Boolean(build.reproducible))}>
            <h2 className="flex items-center gap-2 font-black"><Workflow className="h-5 w-5 text-cyan-300" /> REPRODUCIBLE BUILD EVIDENCE</h2>
            <div className="mt-4 space-y-2 text-xs">
              <div className="rounded-xl bg-black/20 p-3">Workflow evidence <b className="float-left">{build.available ? 'FOUND' : 'MISSING'}</b></div>
              <div className="rounded-xl bg-black/20 p-3">Double-build comparison <b className={`float-left ${build.reproducible ? 'text-emerald-300' : 'text-rose-300'}`}>{build.reproducible ? 'MATCH' : 'NOT PROVEN'}</b></div>
              <div className="rounded-xl bg-black/20 p-3">Workflow conclusion <b className="float-left">{String(build.conclusion || 'UNKNOWN').toUpperCase()}</b></div>
              <div className="rounded-xl bg-black/20 p-3">GitHub OIDC provenance <b className={`float-left ${build.githubOidcAttestation === 'success' ? 'text-emerald-300' : 'text-amber-300'}`}>{String(build.githubOidcAttestation || 'UNKNOWN').toUpperCase()}</b></div>
              <div className="rounded-xl bg-black/20 p-3">Evidence artifact <b className="float-left">{build.artifact?.available ? 'AVAILABLE' : 'UNKNOWN'}</b></div>
            </div>
            {build.runUrl && <a href={build.runUrl} target="_blank" rel="noreferrer" className="mt-4 inline-flex rounded-xl border border-white/10 px-3 py-2 text-xs font-black text-cyan-300">OPEN GITHUB RUN</a>}
          </div>

          <div className={card(Boolean(artifactSbom.available))}>
            <h2 className="flex items-center gap-2 font-black"><Boxes className="h-5 w-5 text-cyan-300" /> ARTIFACT-BOUND SBOM</h2>
            <div className="mt-4 grid grid-cols-2 gap-2 text-center text-xs"><div className="rounded-xl bg-black/20 p-3"><b className="block text-xl">{artifactSbom.componentCount ?? 0}</b>Components</div><div className="rounded-xl bg-black/20 p-3"><b className={`block text-xl ${artifactSbom.binaryInspected ? 'text-emerald-300' : 'text-amber-300'}`}>{artifactSbom.binaryInspected ? 'YES' : 'NO'}</b>Binary inspected</div></div>
            <div className="mt-3 rounded-xl border border-white/10 p-3 text-xs leading-6 text-slate-400">{artifactSbom.source || 'No artifact SBOM evidence.'}</div>
            <div className="mt-3 break-all rounded-xl bg-black/20 p-3 font-mono text-[10px] text-slate-500">Artifact SHA-256: {artifactSbom.artifact?.digestSha256 || 'not bound yet'}</div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-2">
          <div className={card(Boolean(externalAtt))}>
            <h2 className="flex items-center gap-2 font-black"><FileKey2 className="h-5 w-5 text-cyan-300" /> CRYPTOGRAPHIC ATTESTATION</h2>
            <p className="mt-2 text-xs text-slate-500">بدون V33_SIGNER_URL يتم إنشاء Internal HMAC attestation فقط، ولا تُسمى Sigstore.</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2"><input value={attestation.subjectName} onChange={e=>setAttestation({...attestation,subjectName:e.target.value})} placeholder="artifact name" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none" /><input value={attestation.digestSha256} onChange={e=>setAttestation({...attestation,digestSha256:e.target.value})} placeholder="SHA-256 (يمكن تركه فارغًا لاستخدام V32 artifact)" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs outline-none" /></div>
            <button disabled={!!busy} onClick={() => void act('attest', () => createAttestationV33({ releaseId: release?.id, environment:'production', subjectName:attestation.subjectName, digestSha256:attestation.digestSha256 || undefined }), 'تم إنشاء Attestation جديدة.')} className="mt-3 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950 disabled:opacity-40">CREATE ATTESTATION</button>
            <div className="mt-4 space-y-2">{attItems.slice(0,8).map((item:any)=><div key={item.id} className="rounded-xl border border-white/10 p-3 text-xs"><b>{String(item.mode).toUpperCase()}</b><span className="float-left text-slate-500">{when(item.createdAt)}</span><div className="mt-1 text-slate-500">{item.issuer || '—'} · {item.identity || '—'}</div><div className="mt-1 break-all font-mono text-[10px]">{item.digestSha256}</div></div>)}{!attItems.length && <div className="text-xs text-slate-500">لا توجد Attestations محفوظة بعد.</div>}</div>
          </div>

          <div className={card(Boolean(ociEvidence?.status === 'verified'))}>
            <h2 className="flex items-center gap-2 font-black"><Container className="h-5 w-5 text-cyan-300" /> OCI / IMAGE DIGEST</h2>
            <p className="mt-2 text-xs text-slate-500">بدون V33_OCI_VERIFY_URL يتم قبول صيغة Digest فقط وتبقى الحالة UNVERIFIED.</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2"><input value={oci.imageRef} onChange={e=>setOci({...oci,imageRef:e.target.value})} placeholder="ghcr.io/org/image:tag" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none" /><input value={oci.digestSha256} onChange={e=>setOci({...oci,digestSha256:e.target.value})} placeholder="sha256 digest" className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs outline-none" /></div>
            <button disabled={!!busy} onClick={() => void act('oci', () => verifyOciV33({ releaseId: release?.id, imageRef:oci.imageRef, digestSha256:oci.digestSha256 }), 'تم تسجيل نتيجة OCI verification.')} className="mt-3 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950 disabled:opacity-40">VERIFY OCI DIGEST</button>
            {ociEvidence && <div className="mt-4 rounded-xl border border-white/10 p-3 text-xs"><div>State <b className={`float-left ${ociEvidence.status === 'verified' ? 'text-emerald-300' : 'text-amber-300'}`}>{String(ociEvidence.status).toUpperCase()}</b></div><div className="mt-2 text-slate-500">{ociEvidence.imageRef}</div><div className="mt-1 break-all font-mono text-[10px]">{ociEvidence.digestSha256}</div><div className="mt-2 text-slate-500">Verifier: {ociEvidence.verifier}</div></div>}
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-3">
          <div className={card(Boolean(gate?.opa?.allow))}>
            <h2 className="flex items-center gap-2 font-black"><Scale className="h-5 w-5 text-cyan-300" /> POLICY-AS-CODE</h2>
            <div className="mt-4 rounded-xl bg-black/20 p-3 text-xs">Engine <b className="float-left">{String(gate?.opa?.engine || 'UNKNOWN').toUpperCase()}</b></div>
            <div className="mt-2 rounded-xl bg-black/20 p-3 text-xs">Decision <b className={`float-left ${gate?.opa?.allow ? 'text-emerald-300' : 'text-rose-300'}`}>{gate?.opa?.allow ? 'ALLOW' : 'DENY'}</b></div>
            <p className="mt-3 text-xs leading-6 text-slate-500">إذا لم يتم ضبط <code>V33_OPA_URL</code> تستخدم المنصة Internal Policy Equivalent وتعرض ذلك صراحة؛ وجود Sample Rego لا يعني أن OPA شغالة.</p>
          </div>

          <div className={card(Boolean(gate?.v32?.ready))}>
            <h2 className="flex items-center gap-2 font-black"><ShieldCheck className="h-5 w-5 text-cyan-300" /> V32 CHAIN OF TRUST</h2>
            <div className="mt-4 rounded-xl bg-black/20 p-3 text-xs">V32 Production Gate <b className={`float-left ${gate?.v32?.ready ? 'text-emerald-300' : 'text-rose-300'}`}>{gate?.v32?.ready ? 'PASS' : 'BLOCK'}</b></div>
            <div className="mt-2 rounded-xl bg-black/20 p-3 text-xs">Scan ID <b className="float-left font-mono">{gate?.v32?.scanId || '—'}</b></div>
            <a href="#video-v32" className="mt-3 inline-flex rounded-xl border border-white/10 px-3 py-2 text-xs font-black">OPEN V32</a>
          </div>

          <div className={card(true)}>
            <h2 className="flex items-center gap-2 font-black"><GitBranch className="h-5 w-5 text-cyan-300" /> CAPABILITIES</h2>
            <div className="mt-4 space-y-2 text-xs"><div className="rounded-xl bg-black/20 p-3">External signer <b className="float-left">{overview.capabilities.signerConfigured ? 'CONNECTED' : 'NOT CONFIGURED'}</b></div><div className="rounded-xl bg-black/20 p-3">OPA endpoint <b className="float-left">{overview.capabilities.opaConfigured ? 'CONNECTED' : 'INTERNAL'}</b></div><div className="rounded-xl bg-black/20 p-3">OCI verifier <b className="float-left">{overview.capabilities.ociVerifierConfigured ? 'CONNECTED' : 'SYNTAX ONLY'}</b></div><div className="rounded-xl bg-black/20 p-3">GitHub token <b className="float-left">{overview.capabilities.githubTokenConfigured ? 'CONFIGURED' : 'PUBLIC API'}</b></div></div>
          </div>
        </section>
      </>}

      <section className={card(true)}>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-black">V33 PRODUCTION POLICY</h2><p className="mt-1 text-xs text-slate-500">Policy changes are evaluated on the next gate; no stale policy snapshot can silently override them.</p></div><button disabled={!!busy} onClick={() => void act('policy', () => savePolicyV33(policyDraft), 'تم حفظ V33 policy.')} className="rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950 disabled:opacity-40">SAVE POLICY</button></div>
        <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{policyFlags.map(([key,label])=><label key={key} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 p-3 text-xs"><span>{label}</span><input type="checkbox" checked={Boolean(policyDraft[key])} onChange={e=>setPolicyDraft({...policyDraft,[key]:e.target.checked})} /></label>)}</div>
        <label className="mt-3 block text-xs text-slate-500">Assessment max age (minutes)<input type="number" min={5} max={1440} value={Number(policyDraft.maxAssessmentAgeMinutes || 120)} onChange={e=>setPolicyDraft({...policyDraft,maxAssessmentAgeMinutes:Number(e.target.value)})} className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-slate-100 outline-none md:w-60" /></label>
      </section>

      <section className={card(true)}>
        <h2 className="font-black">ASSESSMENT HISTORY</h2>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[850px] text-right text-xs"><thead className="text-slate-500"><tr><th className="p-2">Time</th><th>Candidate</th><th>Lock</th><th>Repro</th><th>OIDC</th><th>Stored gate</th></tr></thead><tbody>{overview.assessments.slice(0,20).map(item=><tr key={item.id} className="border-t border-white/5"><td className="p-2">{when(item.createdAt)}</td><td className="font-mono">{shortSha(item.candidateSha)}</td><td>{String(item.locks?.frontend?.status || '—').toUpperCase()}</td><td>{item.build?.reproducible ? 'MATCH' : 'NO'}</td><td>{String(item.build?.githubOidcAttestation || '—').toUpperCase()}</td><td>{item.gate?.ready ? 'PASS' : 'BLOCK'}</td></tr>)}</tbody></table></div>
      </section>
    </div>
  </main>
}
