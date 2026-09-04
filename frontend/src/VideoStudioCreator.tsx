import { useEffect, useMemo, useState } from 'react'
import {
  Bot,
  CheckCircle2,
  Clapperboard,
  Clock3,
  Film,
  FolderOpen,
  FolderPlus,
  Palette,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  UsersRound,
  Waves,
  X,
} from 'lucide-react'
import VideoStudioV12 from './VideoStudioV12'
import { clearStoredVideoProject, hasStoredVideoProject } from './lib/projectStore'
import {
  createStudioProject,
  deleteStudioProjectMeta,
  getActiveStudioProjectId,
  listStudioProjects,
  setActiveStudioProjectId,
  type StudioProjectMeta,
  type StudioProjectTemplate,
  templateLabel,
  touchStudioProject,
} from './lib/projectHubStore'

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

const templates: Array<{ value: StudioProjectTemplate; title: string; detail: string }> = [
  { value: 'blank', title: 'Blank', detail: 'مشروع فارغ كامل الحرية' },
  { value: 'youtube', title: 'YouTube', detail: 'تحرير 16:9 للمحتوى الطويل' },
  { value: 'reel', title: 'Reel', detail: 'محتوى رأسي 9:16' },
  { value: 'podcast', title: 'Podcast', detail: 'حوار وصوت وتسليم طويل' },
  { value: 'cinematic', title: 'Cinematic', detail: 'مونتاج وتلوين سينمائي' },
]

function projectTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export default function VideoStudioCreator() {
  const [projects, setProjects] = useState<StudioProjectMeta[]>(() => listStudioProjects())
  const [activeId, setActiveId] = useState<string | null>(() => getActiveStudioProjectId())
  const [hubOpen, setHubOpen] = useState(() => !getActiveStudioProjectId())
  const [projectName, setProjectName] = useState('')
  const [template, setTemplate] = useState<StudioProjectTemplate>('blank')
  const [stored, setStored] = useState<Record<string, boolean>>({})
  const [editorRevision, setEditorRevision] = useState(0)
  const [restoreHint, setRestoreHint] = useState(false)

  const activeProject = useMemo(() => projects.find((project) => project.id === activeId) || null, [projects, activeId])

  const refreshProjects = () => {
    setProjects(listStudioProjects())
    setActiveId(getActiveStudioProjectId())
  }

  useEffect(() => {
    const refresh = () => refreshProjects()
    window.addEventListener('maghrabi-project-index-changed', refresh)
    window.addEventListener('maghrabi-active-project-changed', refresh)
    return () => {
      window.removeEventListener('maghrabi-project-index-changed', refresh)
      window.removeEventListener('maghrabi-active-project-changed', refresh)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all(projects.map(async (project) => [project.id, await hasStoredVideoProject(project.id)] as const))
      .then((pairs) => {
        if (!cancelled) setStored(Object.fromEntries(pairs))
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [projects])

  useEffect(() => {
    if (activeId && !projects.some((project) => project.id === activeId)) {
      setActiveStudioProjectId(null)
      setActiveId(null)
      setHubOpen(true)
    }
  }, [activeId, projects])

  const createProject = () => {
    const project = createStudioProject(projectName, template)
    setProjects(listStudioProjects())
    setActiveId(project.id)
    setProjectName('')
    setEditorRevision((value) => value + 1)
    setRestoreHint(false)
    setHubOpen(false)
  }

  const openProject = (project: StudioProjectMeta) => {
    setActiveStudioProjectId(project.id)
    touchStudioProject(project.id)
    setProjects(listStudioProjects())
    setActiveId(project.id)
    setEditorRevision((value) => value + 1)
    setRestoreHint(Boolean(stored[project.id]))
    setHubOpen(false)
  }

  const deleteProject = async (project: StudioProjectMeta) => {
    if (!window.confirm(`حذف مشروع «${project.name}» ونسخته المحلية المحفوظة؟`)) return
    await clearStoredVideoProject(project.id).catch(() => undefined)
    deleteStudioProjectMeta(project.id)
    const next = listStudioProjects()
    setProjects(next)
    if (activeId === project.id) {
      setActiveId(null)
      setRestoreHint(false)
      setHubOpen(true)
    }
  }

  return (
    <div className="relative min-h-screen bg-[#050911]">
      {activeProject ? (
        <VideoStudioV12 key={`${activeProject.id}-${editorRevision}`} />
      ) : (
        <div className="grid min-h-screen place-items-center bg-[#050911] text-slate-100">
          <div className="text-center">
            <Clapperboard className="mx-auto h-12 w-12 text-cyan-300/60" />
            <h1 className="mt-4 text-2xl font-black">MAGHRABI Studio Pro</h1>
            <p className="mt-2 text-sm text-slate-500">أنشئ مشروعًا أو افتح مشروعًا سابقًا للبدء.</p>
            <button onClick={() => setHubOpen(true)} className="mt-5 rounded-2xl bg-cyan-300 px-5 py-3 text-xs font-black text-slate-950">فتح Project Hub</button>
          </div>
        </div>
      )}

      {restoreHint && activeProject && (
        <div className="fixed left-1/2 top-4 z-[95] -translate-x-1/2 rounded-2xl border border-amber-300/25 bg-[#171208]/95 px-4 py-3 text-center text-[11px] font-bold text-amber-100 shadow-2xl shadow-black/50 backdrop-blur-xl" dir="rtl">
          <button onClick={() => setRestoreHint(false)} className="ml-3 align-middle text-amber-300"><X className="inline h-3.5 w-3.5" /></button>
          توجد نسخة محفوظة لهذا المشروع. استخدم زر «استعادة» في شريط المحرر لتحميل آخر Snapshot.
        </div>
      )}

      <details className="group fixed bottom-5 right-5 z-[90]" dir="rtl">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-2xl border border-cyan-300/30 bg-[#08111f]/95 px-4 py-3 text-xs font-black text-cyan-100 shadow-2xl shadow-black/60 backdrop-blur-xl transition hover:border-cyan-300/60 hover:bg-[#0c1929]">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-cyan-300/10 text-cyan-300">
            <Clapperboard className="h-4 w-4" />
          </span>
          <span className="max-w-[180px] text-right leading-tight">
            <span className="block tracking-[.18em]">STUDIO PRO</span>
            <span className="mt-0.5 block truncate text-[10px] font-semibold tracking-normal text-slate-400">{activeProject?.name || 'Project Hub'}</span>
          </span>
          <Sparkles className="h-4 w-4 text-cyan-300/80" />
        </summary>

        <div className="absolute bottom-[calc(100%+10px)] right-0 w-[350px] overflow-hidden rounded-3xl border border-white/10 bg-[#08111f]/98 p-3 shadow-2xl shadow-black/70 backdrop-blur-2xl">
          <button onClick={() => setHubOpen(true)} className="mb-3 flex w-full items-center justify-between rounded-2xl border border-violet-300/15 bg-violet-300/5 px-3 py-2.5 text-right transition hover:border-violet-300/35">
            <div>
              <div className="text-[10px] font-black tracking-[.18em] text-violet-300">PROJECT HUB</div>
              <div className="mt-1 max-w-[230px] truncate text-xs font-semibold text-slate-300">{activeProject?.name || 'إدارة المشاريع'}</div>
            </div>
            <FolderOpen className="h-5 w-5 text-violet-300" />
          </button>

          <div className="mb-3 flex items-center justify-between rounded-2xl border border-emerald-300/15 bg-emerald-300/5 px-3 py-2.5">
            <div>
              <div className="text-[10px] font-black tracking-[.18em] text-emerald-300">MAGHRABI MEDIA STUDIO</div>
              <div className="mt-1 text-xs font-semibold text-slate-300">Professional Creator Workspace</div>
            </div>
            <CheckCircle2 className="h-5 w-5 text-emerald-300" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            {workspaces.map(({ href, label, detail, icon: Icon }) => (
              <a key={href + label} href={href} className="group/item rounded-2xl border border-white/8 bg-white/[.035] p-3 transition hover:border-cyan-300/30 hover:bg-cyan-300/[.06]">
                <div className="flex items-center justify-between">
                  <Icon className="h-4 w-4 text-cyan-300" />
                  <span className="text-[10px] font-black tracking-[.14em] text-slate-200">{label}</span>
                </div>
                <div className="mt-2 text-[10px] font-medium text-slate-500 transition group-hover/item:text-slate-400">{detail}</div>
              </a>
            ))}
          </div>
        </div>
      </details>

      {hubOpen && (
        <div className="fixed inset-0 z-[120] overflow-auto bg-[#02050b]/96 p-4 backdrop-blur-2xl md:p-8" dir="rtl">
          <div className="mx-auto max-w-6xl">
            <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
              <div>
                <div className="flex items-center gap-3">
                  <span className="grid h-11 w-11 place-items-center rounded-2xl bg-cyan-300/10 text-cyan-300"><Clapperboard className="h-5 w-5" /></span>
                  <div>
                    <h2 className="text-2xl font-black text-white">Project Hub</h2>
                    <p className="mt-1 text-xs text-slate-500">إدارة مشاريع MAGHRABI Studio Pro المحلية</p>
                  </div>
                </div>
              </div>
              {activeProject && <button onClick={() => setHubOpen(false)} className="rounded-2xl border border-white/10 px-4 py-2.5 text-xs font-black text-slate-300">العودة للمحرر</button>}
            </header>

            <div className="mt-6 grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
              <section className="rounded-3xl border border-white/10 bg-[#08101c] p-5">
                <div className="flex items-center gap-2 text-cyan-200"><FolderPlus className="h-4 w-4" /><h3 className="text-sm font-black">مشروع جديد</h3></div>
                <label className="mt-5 block text-[10px] font-black tracking-widest text-slate-500">PROJECT NAME</label>
                <input value={projectName} onChange={(event) => setProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') createProject() }} placeholder="مثال: إعلان اليوم الوطني" className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-300/35" />

                <p className="mt-5 text-[10px] font-black tracking-widest text-slate-500">TEMPLATE</p>
                <div className="mt-2 space-y-2">
                  {templates.map((item) => (
                    <button key={item.value} onClick={() => setTemplate(item.value)} className={`w-full rounded-2xl border p-3 text-right transition ${template === item.value ? 'border-cyan-300/35 bg-cyan-300/[.07]' : 'border-white/8 bg-white/[.02] hover:border-white/15'}`}>
                      <span className="block text-xs font-black text-slate-200">{item.title}</span>
                      <span className="mt-1 block text-[10px] text-slate-500">{item.detail}</span>
                    </button>
                  ))}
                </div>
                <button onClick={createProject} className="mt-5 w-full rounded-2xl bg-gradient-to-r from-violet-500 to-cyan-400 px-4 py-3 text-xs font-black text-white shadow-lg shadow-cyan-950/20">CREATE PROJECT</button>
              </section>

              <section className="rounded-3xl border border-white/10 bg-[#08101c] p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-black text-white">Recent Projects</h3>
                    <p className="mt-1 text-[10px] text-slate-500">كل مشروع يستخدم Snapshot مستقلة في IndexedDB.</p>
                  </div>
                  <span className="rounded-full border border-white/10 px-3 py-1 text-[10px] font-black text-slate-400">{projects.length} PROJECTS</span>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {projects.map((project) => (
                    <article key={project.id} className={`rounded-3xl border p-4 ${project.id === activeId ? 'border-cyan-300/30 bg-cyan-300/[.05]' : 'border-white/8 bg-black/15'}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-black text-white">{project.name}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[9px] text-slate-500">
                            <span>{templateLabel(project.template)}</span>
                            <span>•</span>
                            <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{projectTime(project.updatedAt)}</span>
                          </div>
                        </div>
                        {stored[project.id] && <span className="rounded-full border border-emerald-300/20 bg-emerald-300/[.06] px-2 py-1 text-[8px] font-black text-emerald-300">SAVED</span>}
                      </div>
                      <div className="mt-4 flex gap-2">
                        <button onClick={() => openProject(project)} className="flex-1 rounded-xl bg-white px-3 py-2 text-[10px] font-black text-black">OPEN</button>
                        <button onClick={() => deleteProject(project)} className="grid h-9 w-9 place-items-center rounded-xl border border-rose-300/15 text-rose-300 transition hover:bg-rose-300/10" title="حذف المشروع"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </article>
                  ))}
                  {!projects.length && (
                    <div className="col-span-full grid min-h-56 place-items-center rounded-3xl border border-dashed border-white/10 bg-black/10 text-center">
                      <div>
                        <FolderOpen className="mx-auto h-9 w-9 text-slate-700" />
                        <p className="mt-3 text-sm font-black text-slate-400">لا توجد مشاريع بعد</p>
                        <p className="mt-1 text-[10px] text-slate-600">أنشئ أول مشروع من اللوحة الجانبية.</p>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
