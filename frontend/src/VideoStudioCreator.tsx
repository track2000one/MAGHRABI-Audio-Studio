import {
  Bot,
  CheckCircle2,
  Clapperboard,
  Film,
  Palette,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  UsersRound,
  Waves,
} from 'lucide-react'
import VideoStudioV12 from './VideoStudioV12'

const workspaces = [
  { href: '#video', label: 'EDIT', detail: 'Timeline & Editorial', icon: Film },
  { href: '#video-v15', label: 'COLOR', detail: 'Finishing & QC', icon: Palette },
  { href: '#video-v17', label: 'TRACK', detail: 'Motion Tracking', icon: Target },
  { href: '#video-v19', label: 'SMART', detail: 'Production Intelligence', icon: Bot },
  { href: '#tools', label: 'AUDIO', detail: 'Audio Studio', icon: Waves },
  { href: '#video-v20', label: 'DELIVER', detail: 'Automated Pipeline', icon: Send },
  { href: '#video-v22', label: 'REVIEW', detail: 'Review & Approval', icon: UsersRound },
  { href: '#readiness', label: 'READY', detail: 'Production Readiness', icon: ShieldCheck },
]

export default function VideoStudioCreator() {
  return (
    <div className="relative min-h-screen bg-[#050911]">
      <VideoStudioV12 />

      <details className="group fixed bottom-5 right-5 z-[90]" dir="rtl">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-2xl border border-cyan-300/30 bg-[#08111f]/95 px-4 py-3 text-xs font-black text-cyan-100 shadow-2xl shadow-black/60 backdrop-blur-xl transition hover:border-cyan-300/60 hover:bg-[#0c1929]">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-cyan-300/10 text-cyan-300">
            <Clapperboard className="h-4 w-4" />
          </span>
          <span className="text-right leading-tight">
            <span className="block tracking-[.18em]">STUDIO PRO</span>
            <span className="mt-0.5 block text-[10px] font-semibold tracking-normal text-slate-400">Workspace switcher</span>
          </span>
          <Sparkles className="h-4 w-4 text-cyan-300/80" />
        </summary>

        <div className="absolute bottom-[calc(100%+10px)] right-0 w-[330px] overflow-hidden rounded-3xl border border-white/10 bg-[#08111f]/98 p-3 shadow-2xl shadow-black/70 backdrop-blur-2xl">
          <div className="mb-3 flex items-center justify-between rounded-2xl border border-emerald-300/15 bg-emerald-300/5 px-3 py-2.5">
            <div>
              <div className="text-[10px] font-black tracking-[.18em] text-emerald-300">MAGHRABI MEDIA STUDIO</div>
              <div className="mt-1 text-xs font-semibold text-slate-300">Professional Creator Workspace</div>
            </div>
            <CheckCircle2 className="h-5 w-5 text-emerald-300" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            {workspaces.map(({ href, label, detail, icon: Icon }) => (
              <a
                key={href + label}
                href={href}
                className="group/item rounded-2xl border border-white/8 bg-white/[.035] p-3 transition hover:border-cyan-300/30 hover:bg-cyan-300/[.06]"
              >
                <div className="flex items-center justify-between">
                  <Icon className="h-4 w-4 text-cyan-300" />
                  <span className="text-[10px] font-black tracking-[.14em] text-slate-200">{label}</span>
                </div>
                <div className="mt-2 text-[10px] font-medium text-slate-500 transition group-hover/item:text-slate-400">{detail}</div>
              </a>
            ))}
          </div>

          <div className="mt-3 rounded-2xl border border-white/8 bg-black/20 px-3 py-2 text-[10px] leading-5 text-slate-500">
            EDIT هو قلب المشروع. بقية المساحات محركات متخصصة للتلوين، التتبع، الذكاء، التسليم والمراجعة والجاهزية.
          </div>
        </div>
      </details>
    </div>
  )
}
