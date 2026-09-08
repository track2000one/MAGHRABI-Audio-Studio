import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Check, Clapperboard, Play, Search, Sparkles, Star, TimerReset, X } from 'lucide-react'
import { getActiveStudioProjectId } from './lib/projectHubStore'
import { loadStoredVideoProject, saveStoredVideoProject, type StoredVideoProject } from './lib/projectStore'
import {
  TRANSITION_CATEGORIES,
  TRANSITION_EASINGS,
  TRANSITION_LIBRARY,
  resolveDirectionalTransition,
  supportsDirection,
  transitionDefinition,
  transitionDirection,
  type TransitionCategory,
  type TransitionDirection,
  type TransitionEasing,
  type TransitionType,
} from './lib/transitionLibrary'

const FAVORITES_KEY = 'maghrabi-transition-favorites-v1'
const CUT_TOLERANCE = .18
const MIN_DURATION = .08
const MAX_DURATION = 1.5

type TransitionOut = {
  type: TransitionType
  duration: number
  direction?: TransitionDirection
  easing?: TransitionEasing
  rightFileIndex?: number
  rightSourceStart?: number
}

type VideoClip = {
  id: string
  lane?: 'V1' | 'V2' | 'V3'
  fileIndex: number
  startAt: number
  start: number
  end: number
  speed: number
  freezeFrame?: boolean
  freezeDuration?: number
  transitionOut?: TransitionOut | null
  [key: string]: unknown
}

type ProjectShape = {
  clips?: VideoClip[]
  [key: string]: unknown
}

type Cut = {
  id: string
  index: number
  left: VideoClip
  right: VideoClip
  cutAt: number
}

type OpenTarget = {
  leftStart?: number
  leftFile?: number | null
  rightStart?: number
  rightFile?: number | null
}

type BrowserCategory = 'All' | 'Favorites' | TransitionCategory

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function clipDuration(clip: VideoClip) {
  if (clip.freezeFrame) return Math.max(.2, Number(clip.freezeDuration) || 2)
  return Math.max(.02, (Number(clip.end) - Number(clip.start)) / Math.max(.25, Number(clip.speed) || 1))
}

function cutsFromProject(project: ProjectShape | null): Cut[] {
  const clips = [...(project?.clips || [])]
    .filter((clip) => clip.lane === 'V1' || !clip.lane)
    .sort((a, b) => Number(a.startAt) - Number(b.startAt))
  const cuts: Cut[] = []
  for (let index = 0; index < clips.length - 1; index += 1) {
    const left = clips[index]
    const right = clips[index + 1]
    const cutAt = Number(left.startAt) + clipDuration(left)
    if (Math.abs(Number(right.startAt) - cutAt) > CUT_TOLERANCE) continue
    cuts.push({ id: `${left.id}::${right.id}`, index: cuts.length, left, right, cutAt })
  }
  return cuts
}

function editorButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.maghrabi-studio-pro main button'))
}

function clickRestore() {
  editorButtons().find((button) => (button.textContent || '').includes('استعادة'))?.click()
}

async function flushEditorSave(projectId: string) {
  const saveButton = editorButtons().find((button) => (button.textContent || '').includes('حفظ'))
  if (!saveButton || saveButton.disabled) return loadStoredVideoProject<ProjectShape>(projectId)
  const confirmed = new Promise<void>((resolve) => {
    let timer = 0
    const finish = () => {
      window.clearTimeout(timer)
      window.removeEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
      resolve()
    }
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null }>).detail
      if (detail?.projectId && detail.projectId !== projectId) return
      finish()
    }
    window.addEventListener('maghrabi-project-snapshot-changed', onSaved as EventListener)
    timer = window.setTimeout(finish, 1600)
  })
  saveButton.click()
  await confirmed
  return loadStoredVideoProject<ProjectShape>(projectId)
}

function loadFavorites() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FAVORITES_KEY) || '[]')
    return new Set<string>(Array.isArray(parsed) ? parsed.map(String) : [])
  } catch {
    return new Set<string>()
  }
}

function saveFavorites(favorites: Set<string>) {
  window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]))
}

function previewStyle(type: TransitionType, progress: number): CSSProperties {
  const p = clamp(progress, 0, 1)
  const smooth = p * p * (3 - 2 * p)
  const item = transitionDefinition(type)
  const direction = transitionDirection(type)
  const base: CSSProperties = { opacity: p, transform: 'none', clipPath: 'none', filter: 'none' }

  if (type === 'none') return { opacity: p >= .5 ? 1 : 0 }
  if (type === 'fadeblack') return { opacity: p, filter: `brightness(${.28 + p * .72})` }
  if (type === 'fadewhite' || type === 'fadefast') return { opacity: p, filter: `brightness(${1.85 - p * .85})` }
  if (type === 'fadegrays') return { opacity: p, filter: `grayscale(${1 - p})` }
  if (type === 'hblur') return { opacity: p, filter: `blur(${(1 - p) * 8}px)` }
  if (type === 'fadeslow' || type === 'dissolve' || type === 'fade') return { opacity: smooth }
  if (type === 'zoomin') return { opacity: p, transform: `scale(${1.38 - .38 * smooth})` }
  if (type === 'radial' || type === 'circlecrop' || type === 'circleopen') return { opacity: 1, clipPath: `circle(${smooth * 74}% at 50% 50%)` }
  if (type === 'circleclose') return { opacity: p, clipPath: `circle(${Math.max(0, (1 - smooth) * 74)}% at 50% 50%)` }
  if (type === 'rectcrop') return { opacity: 1, clipPath: `inset(${(1 - smooth) * 48}% ${(1 - smooth) * 48}%)` }
  if (type === 'distance') return { opacity: p, transform: `scale(${.72 + .28 * smooth})`, filter: `blur(${(1 - p) * 3}px)` }
  if (type === 'pixelize') return { opacity: p, filter: `blur(${(1 - p) * 6}px) contrast(${1 + (1 - p) * .6})` }
  if (item.family === 'slice') return { opacity: p, transform: direction === 'left' ? `translateX(${(1 - p) * 24}px)` : direction === 'right' ? `translateX(${-(1 - p) * 24}px)` : direction === 'up' ? `translateY(${(1 - p) * 24}px)` : `translateY(${-(1 - p) * 24}px)`, filter: `contrast(${1.35 - .35 * p})` }
  if (item.family === 'squeeze') return { opacity: p, transform: type === 'squeezeh' ? `scaleX(${.12 + .88 * smooth})` : `scaleY(${.12 + .88 * smooth})` }
  if (item.family === 'shape') return { opacity: p, transform: type.startsWith('vert') ? `scaleX(${.08 + .92 * smooth})` : `scaleY(${.08 + .92 * smooth})` }
  if (item.family === 'diagonal') return { opacity: 1, clipPath: type.endsWith('tl') ? `polygon(0 0, ${smooth * 200}% 0, 0 ${smooth * 200}%)` : type.endsWith('tr') ? `polygon(100% 0, ${100 - smooth * 200}% 0, 100% ${smooth * 200}%)` : type.endsWith('bl') ? `polygon(0 100%, 0 ${100 - smooth * 200}%, ${smooth * 200}% 100%)` : `polygon(100% 100%, ${100 - smooth * 200}% 100%, 100% ${100 - smooth * 200}%)` }

  if (item.family === 'wipe') {
    if (direction === 'left') return { opacity: 1, clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` }
    if (direction === 'right') return { opacity: 1, clipPath: `inset(0 0 0 ${(1 - p) * 100}%)` }
    if (direction === 'up') return { opacity: 1, clipPath: `inset(${(1 - p) * 100}% 0 0 0)` }
    return { opacity: 1, clipPath: `inset(0 0 ${(1 - p) * 100}% 0)` }
  }

  if (['slide', 'smooth', 'cover', 'reveal', 'wind'].includes(item.family)) {
    const amount = item.family === 'smooth' ? smooth : p
    if (direction === 'left') return { opacity: 1, transform: `translate3d(${(1 - amount) * 100}%,0,0)` }
    if (direction === 'right') return { opacity: 1, transform: `translate3d(${-(1 - amount) * 100}%,0,0)` }
    if (direction === 'up') return { opacity: 1, transform: `translate3d(0,${(1 - amount) * 100}%,0)` }
    if (direction === 'down') return { opacity: 1, transform: `translate3d(0,${-(1 - amount) * 100}%,0)` }
  }

  return base
}

function PreviewTile({ type, progress, compact = false }: { type: TransitionType; progress: number; compact?: boolean }) {
  return (
    <div className={`relative overflow-hidden bg-[#061522] ${compact ? 'h-[58px]' : 'aspect-video'}`}>
      <div className="absolute inset-0 bg-gradient-to-br from-cyan-950 via-slate-900 to-cyan-700" />
      <div className="absolute inset-0 bg-gradient-to-br from-violet-950 via-indigo-800 to-fuchsia-500" style={previewStyle(type, progress)} />
      <div className="absolute bottom-1.5 left-2 rounded-md bg-black/45 px-1.5 py-0.5 text-[6px] font-black tracking-wider text-white/70">A → B</div>
    </div>
  )
}

export default function StudioTransitionBrowserPro() {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<StoredVideoProject<ProjectShape> | null>(null)
  const [category, setCategory] = useState<BrowserCategory>('All')
  const [search, setSearch] = useState('')
  const [favorites, setFavorites] = useState<Set<string>>(() => loadFavorites())
  const [activeCutId, setActiveCutId] = useState<string | null>(null)
  const [selectedType, setSelectedType] = useState<TransitionType>('dissolve')
  const [duration, setDuration] = useState(.4)
  const [direction, setDirection] = useState<TransitionDirection>('left')
  const [easing, setEasing] = useState<TransitionEasing>('smooth')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState(0)
  const [previewUrls, setPreviewUrls] = useState<{ left: string; right: string }>({ left: '', right: '' })
  const pendingTarget = useRef<OpenTarget | null>(null)

  const cuts = useMemo(() => cutsFromProject(snapshot?.project || null), [snapshot])
  const activeCut = useMemo(() => cuts.find((cut) => cut.id === activeCutId) || cuts[0] || null, [cuts, activeCutId])
  const selectedDefinition = transitionDefinition(selectedType)

  const visibleTransitions = useMemo(() => {
    const query = search.trim().toLowerCase()
    return TRANSITION_LIBRARY.filter((item) => {
      if ('alias' in item && item.alias && category === 'All') return false
      if (category === 'Favorites' && !favorites.has(item.type)) return false
      if (category !== 'All' && category !== 'Favorites' && item.category !== category) return false
      if (!query) return true
      return `${item.name} ${item.category} ${item.description} ${item.type}`.toLowerCase().includes(query)
    })
  }, [category, favorites, search])

  const refresh = async () => {
    const projectId = getActiveStudioProjectId()
    if (!projectId) { setSnapshot(null); return }
    setSnapshot(await loadStoredVideoProject<ProjectShape>(projectId).catch(() => null))
  }

  useEffect(() => {
    const openBrowser = (event: Event) => {
      pendingTarget.current = ((event as CustomEvent<OpenTarget>).detail || null)
      setOpen(true)
      void refresh()
    }
    const projectChanged = () => { if (open) void refresh() }
    window.addEventListener('maghrabi-open-transition-browser', openBrowser as EventListener)
    window.addEventListener('maghrabi-active-project-changed', projectChanged)
    window.addEventListener('maghrabi-transition-changed', projectChanged)
    return () => {
      window.removeEventListener('maghrabi-open-transition-browser', openBrowser as EventListener)
      window.removeEventListener('maghrabi-active-project-changed', projectChanged)
      window.removeEventListener('maghrabi-transition-changed', projectChanged)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const started = performance.now()
    const timer = window.setInterval(() => setProgress(((performance.now() - started) % 1800) / 1800), 55)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!cuts.length) { setActiveCutId(null); return }
    const target = pendingTarget.current
    if (target) {
      const match = cuts.find((cut) => {
        const leftStartMatch = target.leftStart === undefined || Math.abs(cut.left.startAt - target.leftStart) < .35
        const rightStartMatch = target.rightStart === undefined || Math.abs(cut.right.startAt - target.rightStart) < .35
        const leftFileMatch = target.leftFile === undefined || target.leftFile === null || cut.left.fileIndex === target.leftFile
        const rightFileMatch = target.rightFile === undefined || target.rightFile === null || cut.right.fileIndex === target.rightFile
        return leftStartMatch && rightStartMatch && leftFileMatch && rightFileMatch
      })
      if (match) setActiveCutId(match.id)
      pendingTarget.current = null
      return
    }
    if (!activeCutId || !cuts.some((cut) => cut.id === activeCutId)) setActiveCutId(cuts[0].id)
  }, [cuts, activeCutId])

  useEffect(() => {
    if (!activeCut) return
    const spec = activeCut.left.transitionOut
    const type = spec?.type || 'dissolve'
    setSelectedType(type)
    setDuration(clamp(Number(spec?.duration) || .4, MIN_DURATION, MAX_DURATION))
    setDirection(spec?.direction || transitionDirection(type) || 'left')
    setEasing(spec?.easing || 'smooth')
  }, [activeCut?.id])

  useEffect(() => {
    const leftFile = activeCut ? snapshot?.videos?.[activeCut.left.fileIndex] : null
    const rightFile = activeCut ? snapshot?.videos?.[activeCut.right.fileIndex] : null
    const left = leftFile ? URL.createObjectURL(leftFile) : ''
    const right = rightFile ? URL.createObjectURL(rightFile) : ''
    setPreviewUrls({ left, right })
    return () => { if (left) URL.revokeObjectURL(left); if (right) URL.revokeObjectURL(right) }
  }, [activeCut?.id, snapshot])

  const toggleFavorite = (type: TransitionType) => {
    const next = new Set(favorites)
    if (next.has(type)) next.delete(type)
    else next.add(type)
    setFavorites(next)
    saveFavorites(next)
  }

  const selectTransition = (type: TransitionType) => {
    setSelectedType(type)
    setDirection(transitionDirection(type) || direction)
  }

  const persistTransition = async (allCuts: boolean, remove = false) => {
    const projectId = getActiveStudioProjectId()
    if (!projectId || busy) return
    setBusy(true)
    setMessage('')
    try {
      const fresh = await flushEditorSave(projectId)
      if (!fresh) throw new Error('لا يوجد مشروع محفوظ.')
      const project = JSON.parse(JSON.stringify(fresh.project || {})) as ProjectShape
      project.clips = Array.isArray(project.clips) ? project.clips : []
      const freshCuts = cutsFromProject(project)
      const targets = allCuts ? freshCuts : freshCuts.filter((cut) => cut.id === activeCut?.id)
      if (!targets.length) throw new Error('تعذر تحديد نقطة القطع.')

      const resolvedType = resolveDirectionalTransition(selectedType, direction, easing)
      for (const cut of targets) {
        const left = project.clips.find((clip) => clip.id === cut.left.id)
        if (!left) continue
        if (remove || resolvedType === 'none') delete left.transitionOut
        else {
          left.transitionOut = {
            type: resolvedType,
            duration: clamp(duration, MIN_DURATION, MAX_DURATION),
            direction,
            easing,
            rightFileIndex: cut.right.fileIndex,
            rightSourceStart: cut.right.start,
          }
        }
      }

      await saveStoredVideoProject({ ...fresh, project, savedAt: new Date().toISOString() }, projectId)
      window.dispatchEvent(new CustomEvent('maghrabi-transition-changed', { detail: { projectId, browser: true } }))
      window.setTimeout(clickRestore, 70)
      setSnapshot({ ...fresh, project, savedAt: new Date().toISOString() })
      setMessage(remove ? 'تم حذف الانتقال من نقطة القطع.' : allCuts ? `تم تطبيق ${transitionDefinition(resolvedType).name} على جميع نقاط القطع.` : `تم تطبيق ${transitionDefinition(resolvedType).name} على نقطة القطع.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'تعذر حفظ الانتقال.')
    } finally {
      setBusy(false)
      window.setTimeout(() => setMessage(''), 2600)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[132] bg-black/75 p-3 backdrop-blur-md" dir="rtl" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
      <section className="mx-auto flex h-[min(900px,96vh)] w-[min(1500px,98vw)] overflow-hidden rounded-[30px] border border-cyan-300/20 bg-[#06101a] shadow-2xl">
        <aside className="w-[220px] shrink-0 border-l border-white/8 bg-black/20 p-4">
          <div className="flex items-center gap-2 text-cyan-100"><Clapperboard className="h-4 w-4" /><strong className="text-[10px] tracking-[.16em]">TRANSITION BROWSER PRO</strong></div>
          <p className="mt-2 text-[8px] leading-4 text-slate-500">مكتبة Per-Cut مرتبطة مباشرة بـFFmpeg xfade / acrossfade.</p>
          <div className="mt-5 space-y-1">
            {(['All', ...TRANSITION_CATEGORIES, 'Favorites'] as BrowserCategory[]).map((item) => (
              <button key={item} type="button" onClick={() => setCategory(item)} className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-[8px] font-black transition ${category === item ? 'bg-cyan-300/10 text-cyan-100 ring-1 ring-cyan-300/25' : 'text-slate-500 hover:bg-white/[.035] hover:text-slate-300'}`}>
                <span>{item === 'All' ? 'ALL TRANSITIONS' : item === 'Favorites' ? 'FAVORITES' : item.toUpperCase()}</span>
                {item === 'Favorites' ? <Star className="h-3 w-3" /> : <span>{item === 'All' ? TRANSITION_LIBRARY.filter((x) => !('alias' in x && x.alias)).length : TRANSITION_LIBRARY.filter((x) => x.category === item).length}</span>}
              </button>
            ))}
          </div>
          <div className="mt-6 border-t border-white/8 pt-4"><div className="text-[8px] font-black text-slate-500">CUTS · V1</div><div className="mt-2 max-h-64 space-y-1 overflow-y-auto">{cuts.map((cut) => <button key={cut.id} onClick={() => setActiveCutId(cut.id)} className={`w-full rounded-xl border px-2 py-2 text-right text-[8px] ${activeCut?.id === cut.id ? 'border-violet-300/30 bg-violet-300/[.07] text-violet-100' : 'border-white/7 text-slate-500'}`}><span className="font-black">CUT {cut.index + 1}</span><span className="mt-1 block text-[7px]">{cut.cutAt.toFixed(2)}s · V{cut.left.fileIndex + 1} → V{cut.right.fileIndex + 1}</span></button>)}{!cuts.length && <p className="rounded-xl border border-dashed border-white/8 p-3 text-center text-[8px] text-slate-600">أضف مقطعين متجاورين على V1.</p>}</div></div>
        </aside>

        <main className="min-w-0 flex-1 overflow-hidden">
          <header className="flex h-[68px] items-center gap-3 border-b border-white/8 px-5">
            <div className="relative min-w-0 flex-1"><Search className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-600"/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ابحث: dissolve, camera, glitch, cover..." className="w-full rounded-2xl border border-white/8 bg-black/20 py-2.5 pl-3 pr-9 text-[9px] text-white outline-none focus:border-cyan-300/25" /></div>
            <div className="hidden items-center gap-2 text-[8px] text-slate-500 xl:flex"><Play className="h-3.5 w-3.5 text-emerald-300"/>Animated Preview <span>·</span> <Sparkles className="h-3.5 w-3.5 text-amber-300"/>FFmpeg Native</div>
            <button onClick={() => setOpen(false)} className="rounded-xl border border-white/10 p-2 text-slate-400 hover:text-white"><X className="h-4 w-4"/></button>
          </header>

          <div className="grid h-[calc(100%-68px)] grid-cols-[minmax(0,1fr)_330px]">
            <div className="overflow-y-auto p-4">
              <div className="mb-3 flex items-end justify-between gap-3"><div><div className="text-[10px] font-black tracking-[.14em] text-slate-300">{category === 'All' ? 'PROFESSIONAL LIBRARY' : category.toUpperCase()}</div><p className="mt-1 text-[8px] text-slate-600">انقر على أي Transition للمعاينة ثم Apply.</p></div><span className="text-[8px] font-bold text-slate-600">{visibleTransitions.length} ITEMS</span></div>
              <div className="grid grid-cols-2 gap-3 2xl:grid-cols-4 xl:grid-cols-3">
                {visibleTransitions.map((item, index) => {
                  const selected = selectedType === item.type && (!supportsDirection(item.type) || direction === transitionDirection(item.type))
                  return <button key={`${item.category}:${item.type}:${index}`} type="button" onClick={() => selectTransition(item.type)} className={`group overflow-hidden rounded-2xl border text-right transition ${selected ? 'border-cyan-300/40 bg-cyan-300/[.055] ring-1 ring-cyan-300/15' : 'border-white/8 bg-white/[.018] hover:border-white/16'}`}>
                    <div className="relative"><PreviewTile type={item.type} progress={progress}/><span role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); toggleFavorite(item.type) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); toggleFavorite(item.type) } }} className={`absolute left-2 top-2 rounded-lg bg-black/45 p-1 ${favorites.has(item.type) ? 'text-amber-300' : 'text-white/35 group-hover:text-white/65'}`}><Star className="h-3 w-3" fill={favorites.has(item.type) ? 'currentColor' : 'none'}/></span><span className="absolute right-2 top-2 rounded-md bg-black/50 px-1.5 py-1 text-[6px] font-black text-white/60">{item.category}</span></div>
                    <div className="p-3"><div className="flex items-center justify-between gap-2"><strong className="text-[9px] text-slate-200">{item.name}</strong><span className="text-[7px] font-black text-cyan-300/70">{item.short}</span></div><p className="mt-1 line-clamp-2 text-[7px] leading-3 text-slate-600">{item.description}</p></div>
                  </button>
                })}
              </div>
            </div>

            <aside className="overflow-y-auto border-r border-white/8 bg-black/15 p-4">
              <div className="flex items-start justify-between gap-2"><div><div className="text-[9px] font-black tracking-[.13em] text-cyan-200">CUT INSPECTOR</div><p className="mt-1 text-[8px] text-slate-600">{activeCut ? `CUT ${activeCut.index + 1} · ${activeCut.cutAt.toFixed(2)}s` : 'حدد نقطة قطع على V1'}</p></div>{activeCut?.left.transitionOut && <span className="rounded-lg bg-emerald-300/10 px-2 py-1 text-[7px] font-black text-emerald-200">APPLIED</span>}</div>

              <div className="mt-4 overflow-hidden rounded-2xl border border-white/8 bg-black">
                <div className="relative aspect-video overflow-hidden">
                  {previewUrls.left ? <video src={previewUrls.left} muted autoPlay loop playsInline className="absolute inset-0 h-full w-full object-cover"/> : <div className="absolute inset-0 bg-gradient-to-br from-cyan-950 via-slate-900 to-cyan-700"/>}
                  {previewUrls.right ? <video src={previewUrls.right} muted autoPlay loop playsInline className="absolute inset-0 h-full w-full object-cover" style={previewStyle(resolveDirectionalTransition(selectedType, direction, easing), progress)}/> : <div className="absolute inset-0 bg-gradient-to-br from-violet-950 via-indigo-800 to-fuchsia-500" style={previewStyle(resolveDirectionalTransition(selectedType, direction, easing), progress)}/>} 
                  <div className="absolute bottom-2 right-2 rounded-lg bg-black/60 px-2 py-1 text-[7px] font-black text-white/80">LIVE · {transitionDefinition(resolveDirectionalTransition(selectedType, direction, easing)).name}</div>
                </div>
                <div className="h-1 bg-white/5"><div className="h-full bg-cyan-300/70" style={{ width: `${progress * 100}%` }}/></div>
              </div>

              <div className="mt-4 rounded-2xl border border-white/8 p-3"><div className="flex items-start justify-between gap-2"><div><strong className="text-[10px] text-white">{selectedDefinition.name}</strong><p className="mt-1 text-[7px] leading-3 text-slate-600">{selectedDefinition.description}</p></div><span className="rounded-lg bg-white/[.04] px-2 py-1 text-[7px] font-black text-slate-400">{selectedDefinition.category}</span></div></div>

              {supportsDirection(selectedType) && <div className="mt-4"><div className="text-[8px] font-black text-slate-500">DIRECTION</div><div className="mt-2 grid grid-cols-4 gap-1.5">{(['left','right','up','down'] as TransitionDirection[]).map((item) => <button key={item} onClick={() => setDirection(item)} className={`rounded-xl border px-2 py-2 text-[7px] font-black uppercase ${direction === item ? 'border-violet-300/30 bg-violet-300/[.08] text-violet-100' : 'border-white/8 text-slate-500'}`}>{item}</button>)}</div></div>}

              <div className="mt-4"><div className="flex items-center justify-between"><span className="text-[8px] font-black text-slate-500">DURATION</span><span className="font-mono text-[9px] font-black text-cyan-200">{duration.toFixed(2)}s</span></div><input type="range" min={MIN_DURATION} max={MAX_DURATION} step=".01" value={duration} onChange={(event) => setDuration(Number(event.target.value))} className="mt-2 w-full accent-cyan-300"/><div className="mt-2 grid grid-cols-4 gap-1">{[.2,.35,.5,.8].map((value) => <button key={value} onClick={() => setDuration(value)} className="rounded-lg border border-white/7 py-1.5 text-[7px] font-black text-slate-500 hover:text-white">{value.toFixed(2)}</button>)}</div></div>

              <div className="mt-4"><div className="text-[8px] font-black text-slate-500">EASING</div><div className="mt-2 space-y-1.5">{TRANSITION_EASINGS.map((item) => <button key={item.value} onClick={() => setEasing(item.value)} className={`w-full rounded-xl border px-3 py-2 text-right ${easing === item.value ? 'border-amber-300/25 bg-amber-300/[.06]' : 'border-white/7'}`}><span className={`text-[8px] font-black ${easing === item.value ? 'text-amber-100' : 'text-slate-400'}`}>{item.label}</span><span className="mt-0.5 block text-[7px] text-slate-600">{item.description}</span></button>)}</div><p className="mt-2 text-[7px] leading-3 text-slate-600">Smooth/Cinematic يستخدم Smooth xfade لعائلة Slide حيث يدعمها المحرك.</p></div>

              <div className="mt-5 grid grid-cols-2 gap-2"><button disabled={!activeCut || busy} onClick={() => void persistTransition(false, true)} className="rounded-xl border border-rose-300/20 py-2.5 text-[8px] font-black text-rose-200 disabled:opacity-30">REMOVE</button><button disabled={!activeCut || busy} onClick={() => void persistTransition(false)} className="rounded-xl bg-cyan-200 py-2.5 text-[8px] font-black text-slate-950 disabled:opacity-30">{busy ? 'SAVING...' : 'APPLY TO CUT'}</button></div>
              <button disabled={!cuts.length || busy || selectedType === 'none'} onClick={() => void persistTransition(true)} className="mt-2 w-full rounded-xl border border-violet-300/20 bg-violet-300/[.04] py-2.5 text-[8px] font-black text-violet-100 disabled:opacity-30"><Check className="ml-1 inline h-3 w-3"/>APPLY TO ALL CUTS</button>
              <button onClick={() => { setSelectedType('dissolve'); setDuration(.4); setDirection('left'); setEasing('smooth') }} className="mt-2 w-full rounded-xl border border-white/7 py-2 text-[7px] font-black text-slate-500"><TimerReset className="ml-1 inline h-3 w-3"/>RESET BROWSER SETTINGS</button>
              {message && <div className="mt-3 rounded-xl border border-emerald-300/15 bg-emerald-300/[.045] p-2 text-[8px] font-bold text-emerald-100">{message}</div>}
            </aside>
          </div>
        </main>
      </section>
    </div>
  )
}
