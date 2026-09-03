import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, Archive, BarChart3, Bell, CheckCircle2, Clock3, Cpu,
  Database, DatabaseBackup, Download, Gauge, HardDrive, History, PlayCircle,
  RefreshCw, Server, Settings, ShieldCheck, Terminal, Trash2, Wrench, XCircle,
} from 'lucide-react'
import {
  acknowledgeAlertV25, applySchemaV25, createBackupV25, deleteBackupV25,
  downloadBackupV25, getEventsV25, getOverviewV25, getRetentionPreviewV25,
  restoreBackupV25, runDiagnosticsV25, runRetentionV25, updateSettingsV25,
  type V25Event, type V25Overview,
} from './lib/operationsApiV25'

function bytes(value?: number | null) {
  const n = Number(value || 0)
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const power = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** power).toFixed(power >= 3 ? 2 : 1)} ${units[power]}`
}

function seconds(value?: number | null) {
  const n = Math.max(0, Number(value || 0))
  if (n < 60) return `${Math.round(n)}s`
  if (n < 3600) return `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`
  return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`
}

function date(value?: string | null) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('ar-SA')
}

function pct(value?: number | null) {
  return value == null ? '—' : `${Number(value).toFixed(1)}%`
}

function cardClass(ok = true) {
  return `rounded-2xl border p-4 ${ok ? 'border-white/10 bg-white/[0.035]' : 'border-rose-400/30 bg-rose-500/10'}`
}

function MetricSparkline({ history }: { history: V25Overview['metricHistory'] }) {
  const ordered = [...history].reverse().slice(-36)
  const values = ordered.map(item => Number(item.payload.diskUsedPercent || 0))
  if (values.length < 2) return <div className="flex h-28 items-center justify-center text-xs text-slate-500">سيظهر الرسم بعد تسجيل أكثر من Snapshot.</div>
  const width = 500; const height = 100
  const min = Math.min(...values); const max = Math.max(...values); const spread = Math.max(1, max - min)
  const points = values.map((value, index) => `${(index / (values.length - 1)) * width},${height - ((value - min) / spread) * (height - 16) - 8}`).join(' ')
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-28 w-full overflow-visible">
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="3" className="text-cyan-300" />
      </svg>
      <div className="flex justify-between text-[10px] text-slate-500"><span>{min.toFixed(1)}%</span><span>Disk usage history</span><span>{max.toFixed(1)}%</span></div>
    </div>
  )
}

export default function VideoStudioV25() {
  const [overview, setOverview] = useState<V25Overview | null>(null)
  const [events, setEvents] = useState<V25Event[]>([])
  const [retention, setRetention] = useState<any>(null)
  const [diagnostics, setDiagnostics] = useState<any>(null)
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string | number | boolean>>({})
  const [eventLevel, setEventLevel] = useState('')
  const [backupLabel, setBackupLabel] = useState('Manual Control Plane Backup')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const loadOverview = useCallback(async () => {
    try {
      const data = await getOverviewV25()
      setOverview(data)
      setSettingsDraft(data.settings)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل Operations Dashboard.')
    }
  }, [])

  const loadEvents = useCallback(async () => {
    try {
      const data = await getEventsV25({ level: eventLevel || undefined, limit: 250 })
      setEvents(data.events)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل Structured Events.')
    }
  }, [eventLevel])

  useEffect(() => {
    void loadOverview(); void loadEvents()
    const timer = window.setInterval(() => void loadOverview(), 15000)
    return () => window.clearInterval(timer)
  }, [loadOverview, loadEvents])

  useEffect(() => { void loadEvents() }, [loadEvents])

  const jobs = useMemo(() => {
    if (!overview) return []
    const rows: Array<{ category: string; status: string; count: number }> = []
    Object.entries(overview.jobs.counts).forEach(([category, statuses]) => {
      Object.entries(statuses).forEach(([status, count]) => rows.push({ category, status, count }))
    })
    return rows.sort((a, b) => a.category.localeCompare(b.category) || a.status.localeCompare(b.status))
  }, [overview])

  const run = async (name: string, action: () => Promise<any>, success?: string) => {
    setBusy(name); setError(''); setMessage('')
    try {
      const result = await action()
      if (success) setMessage(success)
      await loadOverview(); await loadEvents()
      return result
    } catch (err) {
      setError(err instanceof Error ? err.message : `فشلت عملية ${name}.`)
      return null
    } finally {
      setBusy('')
    }
  }

  const previewRetention = async () => {
    setBusy('retention-preview')
    try { setRetention(await getRetentionPreviewV25()); setError('') }
    catch (err) { setError(err instanceof Error ? err.message : 'تعذر حساب Retention Preview.') }
    finally { setBusy('') }
  }

  const createBackup = async () => {
    await run('backup', () => createBackupV25(backupLabel), 'تم إنشاء Backup مشفّر للـControl Plane.')
  }

  const downloadBackup = async (id: string) => {
    const blob = await run(`download-${id}`, () => downloadBackupV25(id))
    if (!(blob instanceof Blob)) return
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a'); link.href = url; link.download = `MAGHRABI-v25-${id}.mgbackup`; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const restoreBackup = async (id: string) => {
    const confirmText = window.prompt('الاستعادة ستستبدل بيانات الهوية والسياسات وتلغي Sessions الحالية. اكتب RESTORE للمتابعة:')
    if (confirmText !== 'RESTORE') return
    await run(`restore-${id}`, () => restoreBackupV25(id), 'اكتملت الاستعادة. إذا كنت تستخدم حساب V24 فستحتاج إلى تسجيل الدخول مجددًا.')
  }

  const removeBackup = async (id: string) => {
    if (!window.confirm('حذف ملف Backup نهائيًا؟')) return
    await run(`delete-${id}`, () => deleteBackupV25(id), 'تم حذف Backup.')
  }

  const saveSettings = async () => {
    await run('settings', () => updateSettingsV25(settingsDraft), 'تم تحديث سياسات التشغيل.')
  }

  const setSetting = (key: string, value: string | number | boolean) => setSettingsDraft(old => ({ ...old, [key]: value }))

  if (!overview) {
    return (
      <main className="min-h-screen bg-[#060a12] p-8 text-slate-100">
        <div className="mx-auto max-w-xl rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
          <Activity className="mx-auto mb-4 h-10 w-10 animate-pulse text-cyan-300" />
          <h1 className="text-xl font-black">Creator V25 Operations</h1>
          <p className="mt-2 text-sm text-slate-400">{error || 'جاري تحميل حالة النظام...'}</p>
          {error && <button onClick={() => void loadOverview()} className="mt-5 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950">RETRY</button>}
        </div>
      </main>
    )
  }

  const activeAlerts = overview.alerts.filter(item => !item.acknowledged)

  return (
    <main className="min-h-screen bg-[#060a12] text-slate-100" dir="rtl">
      <header className="border-b border-white/10 bg-[#080e18]/95 px-5 py-4 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1700px] flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-black tracking-[.22em] text-cyan-300"><ShieldCheck className="h-4 w-4" /> ENTERPRISE OPERATIONS & OBSERVABILITY</div>
            <h1 className="mt-1 text-2xl font-black">MAGHRABI Video Studio · Creator V25</h1>
            <p className="mt-1 text-xs text-slate-500">Control Plane · Health · Backup · Retention · Diagnostics · Telemetry</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="#video-v24" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">V24 SECURITY</a>
            <a href="#secure" className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5">SECURE PORTAL</a>
            <button onClick={() => { void loadOverview(); void loadEvents() }} className="flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950"><RefreshCw className="h-4 w-4" /> REFRESH</button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1700px] space-y-5 p-5">
        {(error || message) && <div className={`rounded-2xl border px-4 py-3 text-sm ${error ? 'border-rose-400/30 bg-rose-500/10 text-rose-200' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'}`}>{error || message}</div>}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className={cardClass(overview.database.ok)}><Database className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">DATABASE</div><div className="mt-1 text-xl font-black uppercase">{overview.database.mode}</div><div className="text-xs text-slate-400">{overview.database.latencyMs} ms</div></div>
          <div className={cardClass(overview.schema.pending === 0)}><History className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">SCHEMA</div><div className="mt-1 text-xl font-black">{overview.schema.current}/{overview.schema.latest}</div><div className="text-xs text-slate-400">{overview.schema.pending ? `${overview.schema.pending} pending` : 'Current'}</div></div>
          <div className={cardClass(overview.storage.disk.usedPercent < Number(overview.settings['storage.criticalPercent'] || 90))}><HardDrive className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">/DATA STORAGE</div><div className="mt-1 text-xl font-black">{pct(overview.storage.disk.usedPercent)}</div><div className="text-xs text-slate-400">{bytes(overview.storage.disk.freeBytes)} free</div></div>
          <div className={cardClass((overview.memory.usedPercent || 0) < 90)}><Cpu className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">MEMORY</div><div className="mt-1 text-xl font-black">{pct(overview.memory.usedPercent)}</div><div className="text-xs text-slate-400">{bytes(overview.memory.availableBytes)} available</div></div>
          <div className={cardClass(overview.ffmpeg.active <= 1)}><Gauge className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">FFMPEG ACTIVE</div><div className="mt-1 text-xl font-black">{overview.ffmpeg.active}</div><div className="text-xs text-slate-400">live process telemetry</div></div>
          <div className={cardClass(activeAlerts.every(item => item.severity !== 'critical'))}><Bell className="mb-3 h-5 w-5 text-cyan-300" /><div className="text-[10px] font-black text-slate-500">ACTIVE ALERTS</div><div className="mt-1 text-xl font-black">{activeAlerts.length}</div><div className="text-xs text-slate-400">{activeAlerts.filter(item => item.severity === 'critical').length} critical</div></div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
          <div className={cardClass()}>
            <div className="mb-4 flex items-center justify-between"><h2 className="flex items-center gap-2 font-black"><BarChart3 className="h-5 w-5 text-cyan-300" /> HEALTH HISTORY</h2><span className="text-xs text-slate-500">Service uptime {seconds(overview.serviceUptimeSeconds)}</span></div>
            <MetricSparkline history={overview.metricHistory} />
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">LOAD AVG</div><div className="font-mono text-sm">{overview.loadAverage.map(value => value.toFixed(2)).join(' / ') || '—'}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">PYTHON</div><div className="font-mono text-sm">{overview.python}</div></div>
              <div className="rounded-xl bg-black/20 p-3"><div className="text-[10px] text-slate-500">DATA VOLUME</div><div className="text-sm font-bold">{overview.storage.mount.dedicatedMount ? 'Dedicated mount detected' : 'Not verified'}</div></div>
            </div>
          </div>

          <div className={cardClass()}>
            <div className="mb-4 flex items-center justify-between"><h2 className="flex items-center gap-2 font-black"><AlertTriangle className="h-5 w-5 text-amber-300" /> ADMIN ALERTS</h2><span className="text-xs text-slate-500">{overview.alerts.length} condition(s)</span></div>
            <div className="max-h-72 space-y-2 overflow-auto">
              {overview.alerts.length === 0 && <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">لا توجد Alerts حالية.</div>}
              {overview.alerts.map(alert => (
                <div key={alert.key} className={`rounded-xl border p-3 ${alert.severity === 'critical' ? 'border-rose-400/30 bg-rose-500/10' : 'border-amber-400/20 bg-amber-500/10'} ${alert.acknowledged ? 'opacity-50' : ''}`}>
                  <div className="flex items-start justify-between gap-3"><div><div className="text-xs font-black uppercase">{alert.severity} · {alert.title}</div><div className="mt-1 text-xs text-slate-300">{alert.message}</div></div><button onClick={() => void run(`ack-${alert.key}`, () => acknowledgeAlertV25(alert.key, !alert.acknowledged))} className="rounded-lg border border-white/10 px-2 py-1 text-[10px] font-black">{alert.acknowledged ? 'UNACK' : 'ACK'}</button></div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-2">
          <div className={cardClass()}>
            <h2 className="mb-4 flex items-center gap-2 font-black"><Archive className="h-5 w-5 text-cyan-300" /> STORAGE & QUOTAS</h2>
            <div className="space-y-2">
              {overview.storage.categories.map(item => (
                <div key={item.name} className="rounded-xl bg-black/20 p-3">
                  <div className="flex items-center justify-between"><span className="text-xs font-black uppercase">{item.name}</span><span className="text-xs font-mono">{bytes(item.bytes)}</span></div>
                  {item.quotaBytes ? <div className="mt-1 text-[10px] text-slate-500">Quota {bytes(item.quotaBytes)} · {pct(item.quotaPercent)}</div> : <div className="mt-1 text-[10px] text-slate-600">No category quota</div>}
                </div>
              ))}
            </div>
          </div>

          <div className={cardClass()}>
            <h2 className="mb-4 flex items-center gap-2 font-black"><Activity className="h-5 w-5 text-cyan-300" /> JOB METRICS</h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {jobs.map(row => <div key={`${row.category}-${row.status}`} className="rounded-xl bg-black/20 p-3"><div className="text-[10px] font-black uppercase text-slate-500">{row.category}</div><div className="mt-1 flex items-end justify-between"><span className="text-xs font-bold uppercase">{row.status}</span><span className="text-xl font-black">{row.count}</span></div></div>)}
              {jobs.length === 0 && <div className="text-xs text-slate-500">لا توجد Job states مسجلة.</div>}
            </div>
            <div className="mt-3 text-xs text-slate-500">Average recorded duration: {overview.jobs.averageRecordedDurationSeconds == null ? '—' : seconds(overview.jobs.averageRecordedDurationSeconds)} · samples {overview.jobs.recordedDurationSamples}</div>
          </div>
        </section>

        <section className={cardClass()}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 font-black"><Terminal className="h-5 w-5 text-cyan-300" /> FFMPEG TELEMETRY</h2><span className="text-xs text-slate-500">Active processes from /proc</span></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[800px] text-right text-xs"><thead className="text-slate-500"><tr><th className="p-2">PID</th><th className="p-2">TYPE</th><th className="p-2">ELAPSED</th><th className="p-2">CPU TIME</th><th className="p-2">RSS</th><th className="p-2">COMMAND</th></tr></thead><tbody>{overview.ffmpeg.processes.map(item => <tr key={item.pid} className="border-t border-white/5"><td className="p-2 font-mono">{item.pid}</td><td className="p-2 uppercase">{item.kind}</td><td className="p-2">{seconds(item.elapsedSeconds)}</td><td className="p-2">{seconds(item.cpuSeconds)}</td><td className="p-2">{bytes(item.rssBytes)}</td><td className="max-w-xl truncate p-2 font-mono text-[10px] text-slate-500" dir="ltr">{item.command}</td></tr>)}{overview.ffmpeg.processes.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-500">لا توجد FFmpeg processes نشطة حاليًا.</td></tr>}</tbody></table></div>
        </section>

        <section className="grid gap-5 xl:grid-cols-2">
          <div className={cardClass()}>
            <div className="mb-4 flex items-center justify-between"><h2 className="flex items-center gap-2 font-black"><Settings className="h-5 w-5 text-cyan-300" /> OPERATIONS POLICIES</h2><button onClick={() => void saveSettings()} disabled={busy === 'settings'} className="rounded-xl bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950">SAVE POLICIES</button></div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ['storage.warnPercent', 'Storage warning %'], ['storage.criticalPercent', 'Storage critical %'],
                ['retention.audioJobsDays', 'Audio jobs retention days'], ['retention.renderQueueDays', 'Render queue retention days'],
                ['retention.proxyQueueDays', 'Proxy retention days'], ['retention.pipelineQueueDays', 'Pipeline retention days'],
                ['observability.slowRequestMs', 'Slow request threshold ms'], ['observability.eventRetentionDays', 'Event retention days'],
                ['backup.keepCount', 'Backup keep count'], ['backup.intervalHours', 'Auto backup interval hours'],
              ].map(([key, label]) => <label key={key} className="text-xs"><span className="mb-1 block text-slate-500">{label}</span><input type="number" value={Number(settingsDraft[key] ?? 0)} onChange={event => setSetting(key, Number(event.target.value))} className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 outline-none focus:border-cyan-300/50" /></label>)}
              {[
                ['retention.autoEnabled', 'Automatic retention'], ['backup.autoEnabled', 'Automatic control-plane backup'],
              ].map(([key, label]) => <label key={key} className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs"><span>{label}</span><input type="checkbox" checked={Boolean(settingsDraft[key])} onChange={event => setSetting(key, event.target.checked)} /></label>)}
            </div>
          </div>

          <div className={cardClass()}>
            <div className="mb-4 flex items-center justify-between"><h2 className="flex items-center gap-2 font-black"><Clock3 className="h-5 w-5 text-cyan-300" /> RETENTION</h2><div className="flex gap-2"><button onClick={() => void previewRetention()} className="rounded-xl border border-white/10 px-3 py-2 text-xs font-black">PREVIEW</button><button onClick={() => void run('retention-run', runRetentionV25, 'تم تنفيذ Retention على Jobs المنتهية فقط.')} className="rounded-xl bg-amber-300 px-3 py-2 text-xs font-black text-slate-950">RUN CLEANUP</button></div></div>
            {!retention && <p className="text-xs text-slate-500">Preview يحسب الملفات القابلة للحذف بدون حذفها.</p>}
            {retention && <div className="space-y-2">{Object.entries(retention.groups || {}).map(([name, value]: [string, any]) => <div key={name} className="flex items-center justify-between rounded-xl bg-black/20 p-3 text-xs"><span className="font-black uppercase">{name}</span><span>{value.count} jobs · {bytes(value.bytes)} · older than {value.days}d</span></div>)}</div>}
          </div>
        </section>

        <section className={cardClass()}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 font-black"><DatabaseBackup className="h-5 w-5 text-cyan-300" /> ENCRYPTED CONTROL-PLANE BACKUPS</h2><p className="mt-1 text-[11px] text-amber-200">لا تشمل ملفات الفيديو. تشمل الهوية وTeams وACL والسياسات والسجل الإداري، ومشفرة بمفتاح مشتق من AUTH_SECRET.</p></div><div className="flex gap-2"><input value={backupLabel} onChange={event => setBackupLabel(event.target.value)} className="min-w-64 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs" /><button onClick={() => void createBackup()} className="rounded-xl bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950">CREATE BACKUP</button></div></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[800px] text-right text-xs"><thead className="text-slate-500"><tr><th className="p-2">LABEL</th><th className="p-2">CREATED</th><th className="p-2">SIZE</th><th className="p-2">ACTOR</th><th className="p-2">ACTIONS</th></tr></thead><tbody>{overview.backups.map(item => <tr key={item.id} className="border-t border-white/5"><td className="p-2 font-bold">{item.label}</td><td className="p-2">{date(item.createdAt)}</td><td className="p-2">{bytes(item.sizeBytes)}</td><td className="p-2">{item.actorName || 'system'}</td><td className="p-2"><div className="flex gap-1"><button onClick={() => void downloadBackup(item.id)} className="rounded-lg border border-white/10 p-2" title="Download"><Download className="h-3.5 w-3.5" /></button><button onClick={() => void restoreBackup(item.id)} className="rounded-lg border border-amber-400/30 p-2 text-amber-200" title="Restore"><History className="h-3.5 w-3.5" /></button><button onClick={() => void removeBackup(item.id)} className="rounded-lg border border-rose-400/30 p-2 text-rose-200" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button></div></td></tr>)}{overview.backups.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-slate-500">لا توجد Backups حتى الآن.</td></tr>}</tbody></table></div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[.8fr_1.2fr]">
          <div className={cardClass()}>
            <div className="mb-4 flex items-center justify-between"><h2 className="flex items-center gap-2 font-black"><Wrench className="h-5 w-5 text-cyan-300" /> SYSTEM DIAGNOSTICS</h2><button onClick={async () => { const result = await run('diagnostics', runDiagnosticsV25); if (result) setDiagnostics(result) }} className="rounded-xl bg-cyan-300 px-3 py-2 text-xs font-black text-slate-950">RUN DIAGNOSTICS</button></div>
            {!diagnostics && <p className="text-xs text-slate-500">يفحص Database، /data write، FFmpeg/FFprobe، الفلاتر، Storage Volume وAUTH_SECRET.</p>}
            {diagnostics && <div className="max-h-[420px] space-y-2 overflow-auto">{diagnostics.checks.map((item: any) => <div key={item.name} className={`rounded-xl border p-3 text-xs ${item.ok ? 'border-emerald-400/20 bg-emerald-500/5' : item.severity === 'warning' ? 'border-amber-400/20 bg-amber-500/5' : 'border-rose-400/30 bg-rose-500/10'}`}><div className="flex items-center gap-2 font-black">{item.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <XCircle className="h-4 w-4 text-rose-300" />}{item.name}</div><div className="mt-1 text-slate-400">{item.message}</div></div>)}</div>}
            <div className="mt-4 flex gap-2"><button onClick={() => void run('schema', applySchemaV25, 'تم التحقق من Schema Migrations.')} className="rounded-xl border border-white/10 px-3 py-2 text-xs font-black">APPLY SCHEMA MIGRATIONS</button></div>
          </div>

          <div className={cardClass()}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 font-black"><Server className="h-5 w-5 text-cyan-300" /> STRUCTURED EVENTS</h2><select value={eventLevel} onChange={event => setEventLevel(event.target.value)} className="rounded-xl border border-white/10 bg-[#0b1220] px-3 py-2 text-xs"><option value="">ALL LEVELS</option><option value="error">ERROR</option><option value="warning">WARNING</option><option value="info">INFO</option></select></div>
            <div className="max-h-[520px] overflow-auto rounded-xl border border-white/5 bg-black/20"><table className="w-full min-w-[900px] text-right text-[11px]"><thead className="sticky top-0 bg-[#0b1220] text-slate-500"><tr><th className="p-2">TIME</th><th className="p-2">LEVEL</th><th className="p-2">CATEGORY</th><th className="p-2">MESSAGE</th><th className="p-2">ROUTE</th><th className="p-2">STATUS</th><th className="p-2">MS</th><th className="p-2">REQUEST ID</th></tr></thead><tbody>{events.map(item => <tr key={item.id} className="border-t border-white/5"><td className="whitespace-nowrap p-2">{date(item.createdAt)}</td><td className={`p-2 font-black uppercase ${item.level === 'error' ? 'text-rose-300' : item.level === 'warning' ? 'text-amber-300' : 'text-cyan-300'}`}>{item.level}</td><td className="p-2">{item.category}</td><td className="max-w-sm truncate p-2">{item.message}</td><td className="max-w-xs truncate p-2 font-mono text-[10px]" dir="ltr">{item.route || '—'}</td><td className="p-2">{item.statusCode ?? '—'}</td><td className="p-2">{item.durationMs ?? '—'}</td><td className="p-2 font-mono text-[9px]">{item.requestId || '—'}</td></tr>)}{events.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-slate-500">لا توجد Events مطابقة للفِلتر.</td></tr>}</tbody></table></div>
          </div>
        </section>

        <footer className="pb-6 text-center text-[10px] text-slate-600">Creator V25 observes and manages the control plane. Runtime behavior still depends on Railway Volume, PostgreSQL and available FFmpeg filters.</footer>
      </div>
    </main>
  )
}
