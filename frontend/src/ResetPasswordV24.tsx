import { useEffect, useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { completeResetV24, getResetInfoV24 } from './lib/enterpriseSecurityApi'

export default function ResetPasswordV24({ token }: { token: string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => { getResetInfoV24(token).then(data => setEmail(data.email)).catch(e => setError(e instanceof Error ? e.message : 'الرابط غير صالح.')).finally(() => setBusy(false)) }, [token])

  const submit = async () => {
    if (password !== confirm) { setError('تأكيد كلمة المرور غير مطابق.'); return }
    setBusy(true); setError(null)
    try { await completeResetV24(token, password); setDone(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر إعادة تعيين كلمة المرور.') }
    finally { setBusy(false) }
  }

  if (busy && !email) return <div className="grid min-h-screen place-items-center bg-[#05080d]"><Loader2 className="h-8 w-8 animate-spin text-cyan-300"/></div>
  return <main className="grid min-h-screen place-items-center bg-[#05080d] p-5 text-slate-100" dir="rtl"><section className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0a1019] p-6">
    <KeyRound className="h-7 w-7 text-cyan-300"/><p className="mt-3 text-[10px] font-black tracking-[.3em] text-cyan-300">MAGHRABI V24</p><h1 className="mt-1 text-2xl font-black">إعادة تعيين كلمة المرور</h1>
    {email && <p className="mt-2 text-xs text-slate-500">{email}</p>}
    {error && <div className="mt-4 rounded-xl border border-rose-300/20 bg-rose-300/10 p-3 text-xs text-rose-200">{error}</div>}
    {done ? <div className="mt-5"><div className="rounded-xl border border-emerald-300/20 bg-emerald-300/10 p-3 text-xs text-emerald-100">تم تغيير كلمة المرور وإلغاء الجلسات القديمة.</div><a href="#secure" className="mt-3 block rounded-xl bg-cyan-300 p-3 text-center text-xs font-black text-slate-950">SIGN IN</a></div> : <>
      <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="كلمة المرور الجديدة" className="mt-5 w-full rounded-xl bg-black/30 p-3 text-sm"/>
      <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="تأكيد كلمة المرور" className="mt-2 w-full rounded-xl bg-black/30 p-3 text-sm"/>
      <button onClick={submit} disabled={busy || password.length < 10} className="mt-3 w-full rounded-xl bg-cyan-300 p-3 text-xs font-black text-slate-950">{busy ? 'UPDATING…' : 'UPDATE PASSWORD'}</button>
    </>}
  </section></main>
}
