import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, Ban, CheckCircle2, CircuitBoard, Clock3, Database,
  DatabaseBackup, FileCheck2, Fingerprint, HardDrive, HeartPulse, LockKeyhole,
  Network, RefreshCw, RotateCcw, Server, ShieldAlert, ShieldCheck, Siren,
  TimerReset, Unplug, Wrench, XCircle,
} from 'lucide-react'
import {
  getEventsV26, getOverviewV26, openCircuitV26, reconcileV26, resetCircuitV26,
  resolveDlqV26, retryDlqV26, scanMediaV26, setMaintenanceV26, updateSettingsV26,
  verifyBackupV26, verifyMediaV26, type V26Event, type V26Overview,
} from './lib/reliabilityApiV26'
import { getOverviewV25, type V25Backup } from './lib/operationsApiV25'

function date(value?: string | null) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('ar-SA')
}

function when(value?: number | null) {
  if (!value) return '—'
  return new Date(value * 1000).toLocaleString('ar-SA')
}

function bytes(value?: number | null) {
  const n = Number(value || 0)
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const p = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** p).toFixed(p >= 3 ? 2 : 1)} ${units[p]}`
}

function card(ok = true) {
  return `rounded-2xl border p-4 ${ok ? 'border-white/10 bg-white/[0.035]' : 'border-rose-400/30 bg-rose-500/10'}`
}

function Badge({ children, good = true }: { children: React.ReactNode; good?: boolean }) {
  return <span className={`rounded-full border px-2 py-1 text-[10px] font-black ${good ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200' : 'border-amber-400/25 bg-amber-500/10 text-amber-200'}`}>{children}</span>
}

export default function VideoStudioV26() {
  const [overview, setOverview] = useState<V26Overview | null>(null)
  const [events, setEvents] = useState<V26Event[]>([])
  const [backups, setBackups] = useState<V25Backup[]>([])
  const [settings, setSettings] = useState<Record<string, string | number | boolean>>({})
  const [maintenanceReason, setMaintenanceReason] = useState('Scheduled maintenance')
  const [mediaScope, setMediaScope] = useState('renderQueue')
  const [eventSeverity, setEventSeverity] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    try {
      const [v26, v25, relEvents] = await Promise.all([
        getOverviewV26(),
        getOverviewV25(),
        getEventsV26(eventSeverity, 250),
      ])
      setOverview(v26)
      setSettings(v26.settings)
      setBackups(v25.backups || [])
      setEvents(relEvents.events)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل V26 Reliability Console.')
    }
  }, [eventSeverity])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 12000)
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

  const legacyTotal = useMemo(() => {
    if (!overview) return 0
    return Object.values(overview.legacy.counts).reduce((sum, row) => sum + Number(row.legacy || 0), 0)
  }, [overview])

  const activeLeases = useMemo(() => overview?.leases.filter(item => item.state === 'active').length || 0, [overview])
  const openDlq = useMemo(() => overview?.deadLetters.filter(item => !item.resolvedAt).length || 0, [overview])
  const staleNodes = useMemo(() => overview?.nodes.filter(item => item.state === 'stale').length || 0, [overview])

  if (!overview) {
    return (
      <main className="min-h-screen bg-[#050911] p-8 text-slate-100" dir="rtl">
        <div className="mx-auto max-w-xl rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
          <HeartPulse className="mx-auto mb-4 h-10 w-10 animate-pulse text-cyan-300" />
          <h1 className="text-xl font-black">Creator V26 Reliability</h1>
          <p className="mt-2 text-sm text-slate-400">{error || 'جاري تحميل Reliability Control Plane...'}</p>
          {error && <button onClick={() => void load()} className="mt-5 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950">RETRY</button>}
        </div>
      </main>
    )
  }

  const readiness = overview.readiness
  const pitr = overview.pitr

  return (
    <main className="min-h-screen bg-[#050911] text-slate-100" dir="rtl">
      <header className="border-b border-white/10 bg-[#070d17]/95 px-5 py-4 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1750px] flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-black tracking-[.2em] text-cyan-300"><ShieldCheck className="h-4 w-4" /> RELIABILITY & DISASTER RECOVERY</div>
            <h1 className="mt-1 text-2xl font-black">MAGHRABI Video Studio · Creator V26</h1>
            <p className="mt-1 text-xs text-slate-500">Leases · Heartbeats · DLQ · Circuit Breakers · Integrity · Readiness · Recovery</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="#video-v25" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V25 OPERATIONS</a>
            <a href="#video-v24" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V24 SECURITY</a>
            <button onClick={() => void load()} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950"><RefreshCw className="h-4 w-4" /> REFRESH</button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1750px] space-y-5 p-5">
        {(error || message) && <div className={`rounded-2xl border px-4 py-3 text-sm ${error ? 'border-rose-400/30 bg-rose-500/10 text-rose-200' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'}`}>{error || message}</div>}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
          <div className={card(readiness.ready)}><HeartPulse className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">READINESS</div><div className="mt-1 text-xl font-black">{readiness.ready ? 'READY' : 'NOT READY'}</div><div className="text-xs text-slate-400">Node {overview.nodeId.slice(0, 16)}</div></div>
          <div className={card(readiness.distributedSafe)}><LockKeyhole className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">DISTRIBUTED LOCKS</div><div className="mt-1 text-xl font-black">{readiness.distributedSafe ? 'POSTGRES' : 'LOCAL ONLY'}</div><div className="text-xs text-slate-400">Advisory locking</div></div>
          <div className={card(!overview.maintenance.enabled)}><Wrench className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">MAINTENANCE</div><div className="mt-1 text-xl font-black">{overview.maintenance.enabled ? 'ON' : 'OFF'}</div><div className="text-xs text-slate-400">{overview.maintenance.draining ? 'Draining' : 'Traffic gate'}</div></div>
          <div className={card(staleNodes === 0)}><Server className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">NODES</div><div className="mt-1 text-xl font-black">{overview.nodes.length}</div><div className="text-xs text-slate-400">{staleNodes} stale</div></div>
          <div className={card()}><Clock3 className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">ACTIVE LEASES</div><div className="mt-1 text-xl font-black">{activeLeases}</div><div className="text-xs text-slate-400">{overview.leases.length} tracked</div></div>
          <div className={card(openDlq === 0)}><Siren className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">DEAD LETTERS</div><div className="mt-1 text-xl font-black">{openDlq}</div><div className="text-xs text-slate-400">unresolved</div></div>
          <div className={card(legacyTotal === 0)}><Unplug className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">LEGACY JOBS</div><div className="mt-1 text-xl font-black">{legacyTotal}</div><div className="text-xs text-slate-400">not lease-managed</div></div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
          <div className={card()}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div><h2 className="flex items-center gap-2 font-black"><Network className="h-5 w-5 text-cyan-300" /> ZERO-DOWNTIME READINESS</h2><p className="mt-1 text-xs text-slate-500">Public endpoint: /api/video/v26/health/ready</p></div>
              <Badge good={readiness.database.ok}>{readiness.database.mode.toUpperCase()}</Badge>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">DB</div><div className="font-bold">{readiness.database.ok ? 'Healthy' : 'Failed'}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">DATA WRITE</div><div className="font-bold">{readiness.dataWritable ? 'Writable' : 'Failed'}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">SCHEMA</div><div className="font-bold">{readiness.schema.current}/{readiness.schema.latest}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">WORKER TOKEN</div><div className="font-bold">{overview.workerTokenConfigured ? 'Configured' : 'Not configured'}</div></div>
            </div>
            {!readiness.distributedSafe && <div className="mt-3 rounded-xl border border-amber-400/25 bg-amber-500/10 p-3 text-xs text-amber-100">SQLite fallback يعمل، لكن Lease locks ليست موزعة بين Replicas. فعّل PostgreSQL قبل Horizontal Scaling.</div>}
          </div>

          <div className={card(!overview.maintenance.enabled)}>
            <h2 className="flex items-center gap-2 font-black"><ShieldAlert className="h-5 w-5 text-amber-300" /> MAINTENANCE / DRAIN</h2>
            <p className="mt-2 text-xs leading-5 text-slate-400">Maintenance يوقف عمليات الإنتاج الثقيلة القديمة V1–V21 ويجعل Readiness = 503، بينما تبقى Security/Review/Operations متاحة.</p>
            <input value={maintenanceReason} onChange={e => setMaintenanceReason(e.target.value)} className="mt-4 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none" placeholder="Reason" />
            <div className="mt-3 flex gap-2">
              <button disabled={!!busy} onClick={() => void run('maintenance-on', () => setMaintenanceV26(true, maintenanceReason), 'تم تفعيل Maintenance Mode.')} className="flex-1 rounded-xl bg-amber-400 px-3 py-2 text-xs font-black text-slate-950">ENABLE</button>
              <button disabled={!!busy} onClick={() => void run('maintenance-off', () => setMaintenanceV26(false, ''), 'تم إنهاء Maintenance Mode.')} className="flex-1 rounded-xl border border-white/10 px-3 py-2 text-xs font-black">DISABLE</button>
            </div>
          </div>
        </section>

        <section className={card()}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 font-black"><Server className="h-5 w-5 text-cyan-300" /> NODE HEARTBEATS</h2><p className="text-xs text-slate-500">Graceful shutdown marks the replica draining before stop.</p></div><button onClick={() => void run('reconcile', reconcileV26, 'تم Reconcile للـLeases وNodes.')} className="rounded-xl border border-white/10 px-3 py-2 text-xs font-black"><RotateCcw className="ml-1 inline h-4 w-4" /> RECONCILE</button></div>
          <div className="overflow-auto"><table className="w-full min-w-[850px] text-right text-xs"><thead className="text-slate-500"><tr><th className="p-2">NODE</th><th className="p-2">STATE</th><th className="p-2">DEPLOYMENT</th><th className="p-2">HEARTBEAT</th><th className="p-2">STARTED</th><th className="p-2">REGION/SERVICE</th></tr></thead><tbody>{overview.nodes.map(node => <tr key={node.id} className="border-t border-white/5"><td className="p-2 font-mono">{node.id}</td><td className="p-2"><Badge good={node.state === 'ready'}>{node.state}</Badge></td><td className="p-2 font-mono text-slate-400">{node.deploymentId || '—'}</td><td className="p-2">{date(node.heartbeatAt)}</td><td className="p-2">{date(node.startedAt)}</td><td className="p-2 text-slate-400">{String(node.metadata.railwayRegion || node.metadata.railwayService || '—')}</td></tr>)}</tbody></table></div>
        </section>

        <section className="grid gap-5 xl:grid-cols-2">
          <div className={card()}>
            <h2 className="mb-4 flex items-center gap-2 font-black"><TimerReset className="h-5 w-5 text-cyan-300" /> MANAGED LEASES</h2>
            <div className="max-h-[420px] overflow-auto"><table className="w-full min-w-[750px] text-right text-xs"><thead className="text-slate-500"><tr><th className="p-2">JOB</th><th className="p-2">STATE</th><th className="p-2">ATTEMPT</th><th className="p-2">OWNER</th><th className="p-2">EXPIRES / RETRY</th></tr></thead><tbody>{overview.leases.slice(0, 100).map(item => <tr key={item.jobKey} className="border-t border-white/5"><td className="p-2"><div className="font-mono">{item.jobKey}</div><div className="text-[10px] text-slate-500">{item.category}</div></td><td className="p-2"><Badge good={['completed','active'].includes(item.state)}>{item.state}</Badge></td><td className="p-2">{item.attempt}/{item.maxAttempts}</td><td className="p-2 font-mono text-[10px]">{item.ownerNodeId || '—'}</td><td className="p-2 text-slate-400">{item.nextRetryAt ? when(item.nextRetryAt) : when(item.expiresAt)}</td></tr>)}</tbody></table>{!overview.leases.length && <div className="p-6 text-center text-xs text-slate-500">لا توجد Managed Leases بعد.</div>}</div>
          </div>

          <div className={card(openDlq === 0)}>
            <h2 className="mb-4 flex items-center gap-2 font-black"><Siren className="h-5 w-5 text-rose-300" /> DEAD LETTER QUEUE</h2>
            <div className="max-h-[420px] space-y-2 overflow-auto">{overview.deadLetters.filter(item => !item.resolvedAt).map(item => <div key={item.id} className="rounded-xl border border-rose-400/15 bg-rose-500/5 p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="font-mono text-xs">{item.jobKey}</div><div className="mt-1 text-[11px] text-rose-200">{item.error}</div><div className="mt-1 text-[10px] text-slate-500">Attempts {item.attempts} · {date(item.lastFailedAt)}</div></div><div className="flex gap-1"><button onClick={() => void run(`retry-${item.id}`, () => retryDlqV26(item.id), 'تمت إعادة DLQ item إلى Retry Queue.')} className="rounded-lg bg-cyan-300 px-2 py-1 text-[10px] font-black text-slate-950">RETRY</button><button onClick={() => void run(`resolve-${item.id}`, () => resolveDlqV26(item.id), 'تم إغلاق DLQ item.')} className="rounded-lg border border-white/10 px-2 py-1 text-[10px] font-black">RESOLVE</button></div></div></div>)}{!openDlq && <div className="p-6 text-center text-xs text-slate-500"><CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-emerald-300" />لا توجد Dead Letters مفتوحة.</div>}</div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[.8fr_1.2fr]">
          <div className={card()}>
            <h2 className="mb-4 flex items-center gap-2 font-black"><CircuitBoard className="h-5 w-5 text-cyan-300" /> CIRCUIT BREAKERS</h2>
            <div className="space-y-2">{overview.circuits.map(item => <div key={item.name} className="rounded-xl bg-black/20 p-3"><div className="flex items-center justify-between gap-2"><div><div className="font-bold">{item.name}</div><div className="text-[10px] text-slate-500">fail {item.failureCount} · success {item.successCount}</div></div><Badge good={item.state === 'closed'}>{item.state}</Badge></div><div className="mt-2 flex gap-1"><button onClick={() => void run(`reset-${item.name}`, () => resetCircuitV26(item.name), `تم Reset لـ${item.name}.`)} className="flex-1 rounded-lg border border-white/10 py-1 text-[10px] font-black">RESET</button><button onClick={() => void run(`open-${item.name}`, () => openCircuitV26(item.name, 120), `تم فتح ${item.name} لمدة مؤقتة.`)} className="flex-1 rounded-lg border border-amber-400/20 bg-amber-500/10 py-1 text-[10px] font-black text-amber-100">OPEN 120s</button></div></div>)}{!overview.circuits.length && <div className="text-xs text-slate-500">ستظهر Circuits عند تسجيل أول نجاح/فشل أو عند فتحها يدويًا.</div>}</div>
          </div>

          <div className={card()}>
            <h2 className="mb-4 flex items-center gap-2 font-black"><Fingerprint className="h-5 w-5 text-cyan-300" /> MEDIA INTEGRITY · SHA-256</h2>
            <div className="flex flex-wrap gap-2"><select value={mediaScope} onChange={e => setMediaScope(e.target.value)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs"><option value="audioJobs">Audio Jobs</option><option value="renderQueue">Render Queue</option><option value="proxyQueue">Proxy Queue</option><option value="pipelineQueue">Pipeline Queue</option><option value="orchestrator">Orchestrator</option><option value="reviews">Reviews</option></select><button onClick={() => void run('media-scan', () => scanMediaV26(mediaScope, 25), 'تم إنشاء/تحديث SHA-256 index للملفات.')} className="rounded-xl bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950">SCAN 25 FILES</button></div>
            <div className="mt-4 max-h-72 space-y-2 overflow-auto">{overview.checksums.map(item => <div key={item.id} className="rounded-xl bg-black/20 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><div className="truncate text-xs font-bold">{item.path}</div><div className="mt-1 truncate font-mono text-[9px] text-slate-500">{item.sha256}</div><div className="text-[10px] text-slate-500">{bytes(item.sizeBytes)} · {item.status}</div></div><button onClick={() => void run(`verify-media-${item.id}`, () => verifyMediaV26(item.id), 'اكتمل فحص سلامة الملف.')} className="rounded-lg border border-white/10 px-2 py-1 text-[10px] font-black">VERIFY</button></div></div>)}{!overview.checksums.length && <div className="text-xs text-slate-500">ابدأ بـSCAN لإنشاء Baseline checksums.</div>}</div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-2">
          <div className={card()}>
            <h2 className="mb-4 flex items-center gap-2 font-black"><DatabaseBackup className="h-5 w-5 text-cyan-300" /> BACKUP VERIFICATION</h2>
            <div className="space-y-2">{backups.slice(0, 10).map(backup => { const last = overview.backupVerifications.find(item => item.backupId === backup.id); return <div key={backup.id} className="rounded-xl bg-black/20 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-xs font-bold">{backup.label}</div><div className="text-[10px] text-slate-500">{date(backup.createdAt)} · {bytes(backup.sizeBytes)}</div><div className="mt-1 text-[10px]">{last ? <Badge good={last.ok}>{last.ok ? 'VERIFIED' : 'FAILED'}</Badge> : <Badge good={false}>NOT VERIFIED</Badge>}</div></div><button disabled={!backup.fileExists} onClick={() => void run(`verify-backup-${backup.id}`, () => verifyBackupV26(backup.id), 'اكتمل فك التشفير وفحص Manifest للـBackup.')} className="rounded-lg border border-white/10 px-3 py-2 text-[10px] font-black disabled:opacity-40"><FileCheck2 className="ml-1 inline h-4 w-4" /> VERIFY</button></div></div>})}{!backups.length && <div className="text-xs text-slate-500">أنشئ Backup أولًا من V25 Operations.</div>}</div>
          </div>

          <div className={card(Boolean(pitr.eligible && pitr.verified))}>
            <h2 className="mb-4 flex items-center gap-2 font-black"><Database className="h-5 w-5 text-cyan-300" /> PITR READINESS</h2>
            <div className="grid gap-2 sm:grid-cols-2"><div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">DATABASE</div><div className="font-black uppercase">{String(pitr.databaseMode || 'unknown')}</div></div><div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">DB PREREQUISITES</div><div className="font-black">{pitr.verified ? 'INSPECTED' : 'NOT VERIFIED'}</div></div><div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">WAL LEVEL</div><div className="font-mono">{String(pitr.walLevel || '—')}</div></div><div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">ARCHIVE MODE</div><div className="font-mono">{String(pitr.archiveMode ?? '—')}</div></div></div><p className="mt-3 text-xs leading-5 text-slate-400">{String(pitr.note || '')}</p>
          </div>
        </section>

        <section className={card()}>
          <div className="mb-4 flex items-center justify-between"><div><h2 className="flex items-center gap-2 font-black"><Wrench className="h-5 w-5 text-cyan-300" /> RELIABILITY POLICIES</h2><p className="text-xs text-slate-500">القيم تستخدمها Lease/Retry/Shutdown/Circuit engines.</p></div><button onClick={() => void run('settings', () => updateSettingsV26(settings), 'تم حفظ Reliability Policies.')} className="rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950">SAVE POLICIES</button></div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
            ['lease.ttlSeconds','Lease TTL seconds',15,600], ['lease.heartbeatSeconds','Heartbeat seconds',5,120],
            ['retry.maxAttempts','Max attempts',1,20], ['retry.baseSeconds','Retry base seconds',1,600],
            ['retry.maxSeconds','Retry max seconds',10,3600], ['circuit.failureThreshold','Circuit failures',1,50],
            ['circuit.cooldownSeconds','Circuit cooldown',10,3600], ['shutdown.drainSeconds','Shutdown drain seconds',0,120],
          ].map(([key,label,min,max]) => <label key={String(key)} className="rounded-xl bg-black/20 p-3 text-xs"><span className="text-slate-400">{label}</span><input type="number" min={Number(min)} max={Number(max)} value={Number(settings[String(key)] || 0)} onChange={e => setSettings(old => ({ ...old, [String(key)]: Number(e.target.value) }))} className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-2 py-2 font-mono" /></label>)}
            <label className="flex items-center justify-between rounded-xl bg-black/20 p-3 text-xs"><span><b>Require PostgreSQL for Ready</b><span className="mt-1 block text-[10px] text-slate-500">مناسب للإنتاج متعدد Replicas</span></span><input type="checkbox" checked={Boolean(settings['deployment.requirePostgresForReady'])} onChange={e => setSettings(old => ({ ...old, 'deployment.requirePostgresForReady': e.target.checked }))} /></label>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[.9fr_1.1fr]">
          <div className={card(legacyTotal === 0)}>
            <h2 className="mb-4 flex items-center gap-2 font-black"><Unplug className="h-5 w-5 text-amber-300" /> LEGACY RECONCILIATION</h2>
            <div className="space-y-2">{Object.entries(overview.legacy.counts).map(([name,row]) => <div key={name} className="flex items-center justify-between rounded-xl bg-black/20 p-3 text-xs"><span className="font-bold">{name}</span><span className="text-slate-400">total {row.total} · managed {row.managed} · <b className={row.legacy ? 'text-amber-200' : 'text-emerald-200'}>legacy {row.legacy}</b></span></div>)}{!Object.keys(overview.legacy.counts).length && <div className="text-xs text-slate-500">لا توجد Jobs مسجلة حاليًا.</div>}</div>
            <p className="mt-3 text-[11px] leading-5 text-slate-500">V26 لا تدّعي أن Worker قديم أصبح Distributed لمجرد ظهوره هنا. Managed Lease يبدأ فقط عندما يستخدم Worker عقد V26 acquire/heartbeat/complete/fail.</p>
          </div>

          <div className={card()}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="flex items-center gap-2 font-black"><Activity className="h-5 w-5 text-cyan-300" /> RELIABILITY EVENTS</h2><select value={eventSeverity} onChange={e => setEventSeverity(e.target.value)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs"><option value="">ALL</option><option value="error">ERROR</option><option value="warning">WARNING</option><option value="info">INFO</option></select></div>
            <div className="max-h-96 space-y-2 overflow-auto">{events.map(item => <div key={item.id} className="rounded-xl bg-black/20 p-3 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-bold">{item.eventType}</span><span className={`text-[10px] font-black ${item.severity === 'error' ? 'text-rose-300' : item.severity === 'warning' ? 'text-amber-300' : 'text-cyan-300'}`}>{item.severity}</span></div><div className="mt-1 text-[10px] text-slate-500">{date(item.createdAt)} · {item.jobKey || item.nodeId || 'system'}</div></div>)}{!events.length && <div className="text-xs text-slate-500">لا توجد Reliability Events بعد.</div>}</div>
          </div>
        </section>

        <div className="rounded-2xl border border-cyan-400/15 bg-cyan-500/5 p-4 text-xs leading-6 text-slate-400">
          <b className="text-cyan-200">V26 contract:</b> PostgreSQL advisory locks + Lease heartbeat تمنع تملك المهمة نفسها من أكثر من Worker عندما يستخدم الـWorker واجهة V26. Maintenance وReadiness وGraceful Drain فعالة على مستوى الخدمة. أما Legacy Workers القديمة فتبقى ظاهرة بوضوح كـLegacy حتى يتم دمج Lease contract داخلها.
        </div>
      </div>
    </main>
  )
}
