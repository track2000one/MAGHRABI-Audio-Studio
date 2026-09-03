import { useEffect, useState } from 'react'
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { acceptInviteV24, getInviteInfoV24, V24Role } from './lib/enterpriseSecurityApi'

export default function InviteAcceptV24({ token }: { token: string }) {
  const [info, setInfo] = useState<{ name: string; email: string; role: V24Role; expiresAt: number } | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => { getInviteInfoV24(token).then(setInfo).catch(e => setError(e instanceof Error ? e.message : 'تعذر قراءة الدعوة.')).finally(() => setBusy(false)) }, [token])

  const accept = async () => {
    if (password !== confirm) { setError('تأكيد كلمة المرور غير مطابق.'); return }
    setBusy(true); setError(null)
    try { await acceptInviteV24(token, password); setDone(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تفعيل الحساب.') }
    finally { setBusy(false) }
  }

  if (busy && !info) return <div className="grid min-h-screen place-items-center bg-[#05080d]"><Loader2 className="h-8 w-8 animate-spin text-cyan-300"/></div>
  return <main className="grid min-h-screen place-items-center bg-[#05080d] p-5 text-slate-100" dir="rtl"><section className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0a1019] p-6">
    <ShieldCheck className="h-7 w-7 text-cyan-300"/><p className="mt-3 text-[10px] font-black tracking-[.3em] text-cyan-300">MAGHRABI V24</p><h1 className="mt-1 text-2xl font-black">تفعيل حساب الفريق</h1>
    {error && <div className="mt-4 rounded-xl border border-rose-300/20 bg-rose-300/10 p-3 text-xs text-rose-200">{error}</div>}
    {done ? <div className="mt-5"><div className="rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4 text-sm text-emerald-100">تم تفعيل الحساب بنجاح.</div><a href="#secure" className="mt-3 block rounded-xl bg-cyan-300 p-3 text-center text-xs font-black text-slate-950">الدخول إلى Secure Portal</a></div> : info && <>
      <div className="mt-5 rounded-2xl border border-white/7 bg-black/20 p-3 text-xs"><b>{info.name}</b><p className="mt-1 text-slate-500">{info.email}</p><p className="mt-1 text-cyan-300">Role: {info.role.toUpperCase()}</p></div>
      <div className="mt-4 flex items-center gap-2 text-[10px] text-slate-500"><KeyRound className="h-4 w-4"/>كلمة المرور لا تقل عن 10 أحرف.</div>
      <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="كلمة المرور الجديدة" className="mt-2 w-full rounded-xl bg-black/30 p-3 text-sm"/>
      <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="تأكيد كلمة المرور" className="mt-2 w-full rounded-xl bg-black/30 p-3 text-sm"/>
      <button onClick={accept} disabled={busy || password.length < 10} className="mt-3 w-full rounded-xl bg-cyan-300 p-3 text-xs font-black text-slate-950">{busy ? 'ACTIVATING…' : 'ACTIVATE ACCOUNT'}</button>
    </>}
  </section></main>
}
