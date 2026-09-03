import { useEffect, useState } from 'react'
import { CheckCircle2, KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { acceptInviteV23, inviteInfoV23, V23Role } from './lib/enterpriseIdentityApi'

export default function InviteAcceptV23({ token }: { token: string }) {
  const [info, setInfo] = useState<{name:string;email:string;role:V23Role;expiresAt:number}|null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(true)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string|null>(null)

  useEffect(() => {
    inviteInfoV23(token).then(setInfo).catch(e => setError(e instanceof Error ? e.message : 'تعذر قراءة الدعوة.')).finally(() => setBusy(false))
  }, [token])

  const submit = async () => {
    if (password !== confirm) return setError('تأكيد كلمة المرور غير مطابق.')
    setBusy(true); setError(null)
    try { await acceptInviteV23(token, password); setDone(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تفعيل الحساب.') }
    finally { setBusy(false) }
  }

  return <main className="grid min-h-screen place-items-center bg-[#05080d] p-5 text-slate-100" dir="rtl">
    <section className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#0a1019] p-6 shadow-2xl">
      <div className="flex items-center gap-3"><div className="rounded-2xl bg-cyan-300/10 p-3"><ShieldCheck className="h-6 w-6 text-cyan-300"/></div><div><p className="text-[10px] font-black tracking-[.3em] text-cyan-300">MAGHRABI CREATOR V23</p><h1 className="text-xl font-black">قبول دعوة الفريق</h1></div></div>
      {busy && !info ? <div className="grid h-48 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-cyan-300"/></div> : done ? <div className="mt-8 rounded-2xl border border-emerald-300/20 bg-emerald-300/5 p-5 text-center"><CheckCircle2 className="mx-auto h-10 w-10 text-emerald-300"/><h2 className="mt-3 font-black">تم تفعيل الحساب</h2><p className="mt-2 text-sm text-slate-400">يمكنك الآن تسجيل الدخول إلى مساحة الفريق.</p><a href="#team" className="mt-5 inline-block rounded-xl bg-cyan-300 px-5 py-3 text-xs font-black text-slate-950">فتح TEAM WORKSPACE</a></div> : info ? <>
        <div className="mt-6 rounded-2xl border border-white/8 bg-black/20 p-4 text-sm"><p className="font-black">{info.name}</p><p className="mt-1 text-slate-400">{info.email}</p><p className="mt-2 text-xs text-cyan-300">ROLE · {info.role.toUpperCase()}</p></div>
        <label className="mt-5 block text-xs font-black text-slate-400">كلمة المرور الجديدة<input type="password" value={password} onChange={e=>setPassword(e.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 p-3 text-slate-100" placeholder="10 أحرف على الأقل"/></label>
        <label className="mt-3 block text-xs font-black text-slate-400">تأكيد كلمة المرور<input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 p-3 text-slate-100"/></label>
        <button disabled={busy || password.length < 10 || confirm.length < 10} onClick={submit} className="mt-5 w-full rounded-xl bg-cyan-300 px-4 py-3 text-xs font-black text-slate-950 disabled:opacity-40">{busy ? <><Loader2 className="ml-1 inline h-4 w-4 animate-spin"/>جاري التفعيل…</> : <><KeyRound className="ml-1 inline h-4 w-4"/>تفعيل الحساب</>}</button>
      </> : null}
      {error && <div className="mt-4 rounded-xl border border-rose-300/20 bg-rose-300/5 p-3 text-xs text-rose-200">{error}</div>}
    </section>
  </main>
}
