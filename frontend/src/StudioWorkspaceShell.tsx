import type { ReactNode } from 'react'
import { ChevronRight, Clapperboard, Film } from 'lucide-react'
import StudioCommandPalette from './StudioCommandPalette'

const labels: Record<string, { title: string; subtitle: string }> = {
  color: { title: 'COLOR', subtitle: 'Finishing · Grading · QC' },
  track: { title: 'TRACK', subtitle: 'Motion Tracking · Privacy' },
  smart: { title: 'SMART', subtitle: 'Production Intelligence' },
  audio: { title: 'AUDIO', subtitle: 'Audio Studio · Separation' },
  deliver: { title: 'DELIVER', subtitle: 'Pipeline · Export' },
  review: { title: 'REVIEW', subtitle: 'Comments · Approval' },
  operations: { title: 'OPERATIONS', subtitle: 'Health · Runtime' },
  reliability: { title: 'RELIABILITY', subtitle: 'Workers · Recovery' },
  capacity: { title: 'CAPACITY', subtitle: 'SLO · SLA · Performance' },
  release: { title: 'RELEASE', subtitle: 'GitOps · Promotion' },
  readiness: { title: 'READINESS', subtitle: 'Final Production Gate' },
}

export default function StudioWorkspaceShell({ active, children }: { active: string; children: ReactNode }) {
  const meta = labels[active] || { title: active.toUpperCase(), subtitle: 'MAGHRABI Studio Pro' }

  return (
    <div className="relative min-h-screen bg-[#050911]">
      {children}

      <nav className="fixed left-4 top-4 z-[96] flex max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-2xl border border-white/10 bg-[#08111f]/94 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-xl" dir="ltr">
        <a href="#video" className="group flex items-center gap-2 rounded-xl px-2.5 py-2 transition hover:bg-cyan-300/[.07]" title="Back to Edit">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-cyan-300/10 text-cyan-300"><Clapperboard className="h-3.5 w-3.5" /></span>
          <span className="hidden text-left sm:block">
            <span className="block text-[9px] font-black tracking-[.16em] text-cyan-200">STUDIO PRO</span>
            <span className="block text-[8px] text-slate-600">Back to Edit</span>
          </span>
        </a>
        <ChevronRight className="h-3 w-3 text-slate-700" />
        <div className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-1.5">
          <Film className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          <span className="min-w-0">
            <span className="block truncate text-[10px] font-black tracking-[.12em] text-slate-200">{meta.title}</span>
            <span className="hidden truncate text-[8px] text-slate-600 md:block">{meta.subtitle}</span>
          </span>
        </div>
      </nav>

      <StudioCommandPalette />
    </div>
  )
}
