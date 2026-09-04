import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Film,
  Gauge,
  Palette,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Target,
  UsersRound,
  Waves,
  X,
  Zap,
} from 'lucide-react'

type StudioCommand = {
  id: string
  label: string
  description: string
  keywords: string
  href: string
  shortcut?: string
  icon: typeof Film
}

const commands: StudioCommand[] = [
  { id: 'edit', label: 'Edit', description: 'Timeline & Editorial Workspace', keywords: 'edit timeline montage تحرير مونتاج', href: '#video', shortcut: 'E', icon: Film },
  { id: 'color', label: 'Color', description: 'Finishing, Grading & QC', keywords: 'color grade finishing تلوين الوان', href: '#color', shortcut: 'C', icon: Palette },
  { id: 'track', label: 'Tracking', description: 'Motion Tracking & Privacy', keywords: 'track tracking motion blur تتبع', href: '#track', shortcut: 'T', icon: Target },
  { id: 'smart', label: 'Smart Production', description: 'Production Intelligence & Highlights', keywords: 'smart ai production highlights ذكي', href: '#smart', shortcut: 'S', icon: Bot },
  { id: 'audio', label: 'Audio', description: 'Audio Studio & Source Separation', keywords: 'audio sound demucs صوت فصل', href: '#audio', shortcut: 'A', icon: Waves },
  { id: 'deliver', label: 'Deliver', description: 'Automated Pipeline & Export', keywords: 'deliver export render pipeline تصدير', href: '#deliver', shortcut: 'D', icon: Send },
  { id: 'review', label: 'Review', description: 'Review, Comments & Approval', keywords: 'review approve comments مراجعة اعتماد', href: '#review-studio', icon: UsersRound },
  { id: 'operations', label: 'Operations', description: 'Health, Metrics & Runtime Operations', keywords: 'operations metrics health تشغيل', href: '#operations', icon: Settings2 },
  { id: 'capacity', label: 'Capacity', description: 'SLO, SLA & Capacity Engineering', keywords: 'capacity slo sla performance سعة اداء', href: '#capacity', icon: Gauge },
  { id: 'release', label: 'Release', description: 'GitOps Release Automation', keywords: 'release gitops deploy نشر اصدار', href: '#release', icon: Zap },
  { id: 'readiness', label: 'Readiness', description: 'Final Production Readiness', keywords: 'readiness final production جاهزية', href: '#readiness', shortcut: 'R', icon: ShieldCheck },
]

function navigate(href: string) {
  if (window.location.hash === href) {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    window.location.hash = href
  }
}

export default function StudioCommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return commands
    return commands.filter((command) => `${command.label} ${command.description} ${command.keywords}`.toLowerCase().includes(needle))
  }, [query])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((value) => !value)
        return
      }
      if (!open) return
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((value) => Math.min(Math.max(0, visible.length - 1), value + 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((value) => Math.max(0, value - 1))
      } else if (event.key === 'Enter' && visible[activeIndex]) {
        event.preventDefault()
        navigate(visible[activeIndex].href)
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, visible, activeIndex])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    window.setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  useEffect(() => setActiveIndex(0), [query])

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 left-5 z-[88] hidden items-center gap-2 rounded-2xl border border-white/10 bg-[#08111f]/94 px-3 py-2.5 text-[10px] font-black text-slate-300 shadow-2xl shadow-black/50 backdrop-blur-xl transition hover:border-cyan-300/30 hover:text-cyan-100 lg:flex"
        title="Command Palette"
      >
        <Search className="h-3.5 w-3.5 text-cyan-300" />
        COMMANDS
        <kbd className="rounded-lg border border-white/10 bg-black/25 px-1.5 py-0.5 text-[9px] text-slate-500">⌘/Ctrl K</kbd>
      </button>

      {open && (
        <div className="fixed inset-0 z-[200] flex items-start justify-center bg-black/70 px-4 pt-[10vh] backdrop-blur-md" onMouseDown={() => setOpen(false)}>
          <div className="w-full max-w-2xl overflow-hidden rounded-[28px] border border-white/12 bg-[#08111f]/98 shadow-2xl shadow-black/80" onMouseDown={(event) => event.stopPropagation()} dir="rtl">
            <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
              <Search className="h-5 w-5 text-cyan-300" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="ابحث عن مساحة عمل أو أمر..."
                className="min-w-0 flex-1 bg-transparent py-2 text-sm font-semibold text-white outline-none placeholder:text-slate-600"
              />
              <button onClick={() => setOpen(false)} className="grid h-8 w-8 place-items-center rounded-xl border border-white/8 text-slate-500 hover:text-white"><X className="h-4 w-4" /></button>
            </div>

            <div className="max-h-[58vh] overflow-auto p-2">
              {visible.map((command, index) => {
                const Icon = command.icon
                return (
                  <button
                    key={command.id}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => { navigate(command.href); setOpen(false) }}
                    className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-right transition ${index === activeIndex ? 'border-cyan-300/25 bg-cyan-300/[.07]' : 'border-transparent hover:bg-white/[.035]'}`}
                  >
                    <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-2xl ${index === activeIndex ? 'bg-cyan-300/10 text-cyan-300' : 'bg-white/[.04] text-slate-500'}`}><Icon className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-black text-slate-100">{command.label}</span>
                      <span className="mt-1 block truncate text-[10px] text-slate-500">{command.description}</span>
                    </span>
                    {command.shortcut && <kbd className="rounded-lg border border-white/8 bg-black/20 px-2 py-1 text-[9px] font-black text-slate-600">{command.shortcut}</kbd>}
                  </button>
                )
              })}
              {!visible.length && <div className="grid min-h-40 place-items-center text-center text-xs text-slate-600">لا توجد أوامر مطابقة.</div>}
            </div>

            <div className="flex items-center justify-between border-t border-white/8 px-4 py-2.5 text-[9px] text-slate-600" dir="ltr">
              <span>↑ ↓ navigate · Enter open · Esc close</span>
              <span>MAGHRABI Studio Pro</span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
